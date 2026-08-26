import {
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsNull } from 'typeorm';
import { PasswordService } from '../../../shared/services/password.service';
import { SecurityAuditService } from '../../../shared/security/security-audit.service';
import { AuthRedisService } from '../../../shared/redis/redis.service';
import { TenantService } from '../../../shared/tenant/tenant.service';
import { UsersService } from '../../users/users.service';
import { UserMfaCredential } from '../entities/user-mfa-credential.entity';
import { UserMfaRecoveryCode } from '../entities/user-mfa-recovery-code.entity';
import { AuthService } from '../auth.service';
import {
  buildOtpauthUri,
  generateRecoveryCode,
  generateTotpSecret,
  verifyTotpCode,
} from '../utils/totp.util';
import {
  getMfaBootstrapTtlSeconds,
  getMfaIssuer,
  getMfaJwtSecret,
  getMfaLoginChallengeTtlSeconds,
  getMfaMaxChallengeAttempts,
  getMfaStepUpTtlSeconds,
  getMfaTotpEncryptionKey,
  isAdminEmpresaMfaEnforced,
  isAdminEmpresaPasswordFallbackAllowed,
  isAdminGeralMfaEnforced,
  isMfaEnabled,
  normalizePrivilegedRole,
} from '../mfa.config';
import * as crypto from 'crypto';

type SupportedMfaMethod = 'totp' | 'recovery_code' | 'password_fallback';
type ChallengePurpose = 'login' | 'bootstrap';

type ChallengeState = {
  userId: string;
  companyId: string;
  purpose: ChallengePurpose;
  attempts: number;
};

type StepUpState = {
  userId: string;
  companyId?: string | null;
  reason: string;
  accessJti?: string;
  method: SupportedMfaMethod;
};

const MFA_TOTP_SECRET_IV_LENGTH_BYTES = 12;
const MFA_TOTP_SECRET_AUTH_TAG_LENGTH_BYTES = 16;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MfaSessionUser = {
  id: string;
  nome: string;
  cpf: string | null;
  funcao: string | null;
  company_id: string;
  profile?: { nome?: string | null } | null;
  auth_user_id?: string | null;
};

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    @InjectRepository(UserMfaCredential)
    private readonly credentialRepository: Repository<UserMfaCredential>,
    @InjectRepository(UserMfaRecoveryCode)
    private readonly recoveryCodeRepository: Repository<UserMfaRecoveryCode>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly passwordService: PasswordService,
    private readonly securityAudit: SecurityAuditService,
    private readonly redisService: AuthRedisService,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly tenantService: TenantService,
  ) {}

  isEnabled(): boolean {
    return isMfaEnabled(this.configService);
  }

  requiresMfa(profileName?: string | null): boolean {
    const normalized = normalizePrivilegedRole(profileName);
    if (!this.isEnabled()) {
      return false;
    }
    if (normalized === 'SUPER_ADMIN' || normalized === 'ADMIN_GERAL') {
      return isAdminGeralMfaEnforced(this.configService);
    }
    if (normalized === 'ADMIN_EMPRESA') {
      return isAdminEmpresaMfaEnforced(this.configService);
    }
    return false;
  }

  async getStatus(params: {
    userId: string;
    authUserId?: string | null;
    companyId?: string | null;
    profileName?: string | null;
  }): Promise<{
    enabled: boolean;
    required: boolean;
    privilegedRole: string;
    recoveryCodesRemaining: number;
  }> {
    const resolvedUserId = this.resolveMfaSubjectId({
      userId: params.userId,
      authUserId: params.authUserId,
    });
    if (!resolvedUserId) {
      this.logger.warn({
        event: 'mfa_status_invalid_subject',
        userId: params.userId,
        authUserId: params.authUserId ?? null,
      });
      return {
        enabled: false,
        required: this.requiresMfa(params.profileName),
        privilegedRole: normalizePrivilegedRole(params.profileName),
        recoveryCodesRemaining: 0,
      };
    }

    const credential = await this.getActiveCredential(
      resolvedUserId,
      params.companyId,
    );
    const recoveryCodesRemaining = credential
      ? await this.withMfaTenantContext(
          credential.company_id,
          resolvedUserId,
          () =>
            this.recoveryCodeRepository.count({
              where: {
                credential_id: credential.id,
                user_id: resolvedUserId,
                consumed_at: IsNull(),
              },
            }),
        )
      : 0;

    return {
      enabled: Boolean(credential),
      required: this.requiresMfa(params.profileName),
      privilegedRole: normalizePrivilegedRole(params.profileName),
      recoveryCodesRemaining,
    };
  }

  async startEnrollment(params: {
    userId: string;
    companyId: string;
    label: string;
  }): Promise<{
    otpAuthUrl: string;
    manualEntryKey: string;
    recoveryCodes: string[];
  }> {
    let secret = generateTotpSecret();
    let encrypted = this.encryptSecret(secret);

    let credential = await this.withMfaTenantContext(
      params.companyId,
      params.userId,
      () =>
        this.credentialRepository.findOne({
          where: { user_id: params.userId, type: 'totp' },
        }),
    );

    if (!credential) {
      credential = this.credentialRepository.create({
        user_id: params.userId,
        company_id: params.companyId,
        type: 'totp',
        label: params.label,
        secret_ciphertext: encrypted.ciphertext,
        secret_iv: encrypted.iv,
        secret_tag: encrypted.tag,
        is_enabled: false,
        verified_at: null,
        disabled_at: null,
      });
    } else if (!credential.is_enabled) {
      secret = this.decryptSecret(credential);
      credential.company_id = params.companyId;
      credential.label = params.label;
      credential.verified_at = null;
      credential.disabled_at = null;
      credential.last_used_at = null;
    } else {
      secret = generateTotpSecret();
      encrypted = this.encryptSecret(secret);
      credential.company_id = params.companyId;
      credential.label = params.label;
      credential.secret_ciphertext = encrypted.ciphertext;
      credential.secret_iv = encrypted.iv;
      credential.secret_tag = encrypted.tag;
      credential.is_enabled = false;
      credential.verified_at = null;
      credential.disabled_at = null;
      credential.last_used_at = null;
    }

    const credentialToSave = credential;
    credential = await this.withMfaTenantContext(
      params.companyId,
      params.userId,
      () => this.credentialRepository.save(credentialToSave),
    );
    const recoveryCodes = await this.replaceRecoveryCodes(
      credential,
      params.userId,
      params.companyId,
    );
    const issuer = getMfaIssuer(this.configService);

    return {
      otpAuthUrl: buildOtpauthUri({
        issuer,
        label: params.label,
        secret,
      }),
      manualEntryKey: secret,
      recoveryCodes,
    };
  }

  async activateEnrollment(params: {
    userId: string;
    companyId?: string | null;
    code: string;
  }): Promise<void> {
    const credential = await this.requireCredential(
      params.userId,
      true,
      params.companyId,
    );
    const verification = await this.verifyCredentialCode({
      credential,
      userId: params.userId,
      code: params.code,
    });

    if (!verification.valid) {
      this.securityAudit.mfaVerificationFailed(
        params.userId,
        'enrollment_activation',
        credential.company_id,
      );
      throw new UnauthorizedException('Código MFA inválido');
    }

    credential.is_enabled = true;
    credential.verified_at = new Date();
    credential.disabled_at = null;
    credential.last_used_at = new Date();
    await this.withMfaTenantContext(credential.company_id, params.userId, () =>
      this.credentialRepository.save(credential),
    );
    this.securityAudit.mfaActivated(
      params.userId,
      verification.method,
      credential.company_id,
    );
  }

  async disableMfa(params: {
    userId: string;
    companyId?: string | null;
    code: string;
  }): Promise<void> {
    const credential = await this.requireCredential(
      params.userId,
      false,
      params.companyId,
    );
    const verification = await this.verifyCredentialCode({
      credential,
      userId: params.userId,
      code: params.code,
    });

    if (!verification.valid) {
      this.securityAudit.mfaVerificationFailed(
        params.userId,
        'disable',
        credential.company_id,
      );
      throw new UnauthorizedException('Código MFA inválido');
    }

    credential.is_enabled = false;
    credential.disabled_at = new Date();
    await this.withMfaTenantContext(credential.company_id, params.userId, () =>
      this.credentialRepository.save(credential),
    );
    this.securityAudit.mfaDisabled(
      params.userId,
      verification.method,
      credential.company_id,
    );
  }

  async regenerateRecoveryCodes(params: {
    userId: string;
    companyId: string;
  }): Promise<string[]> {
    const credential = await this.requireCredential(
      params.userId,
      false,
      params.companyId,
    );
    const recoveryCodes = await this.replaceRecoveryCodes(
      credential,
      params.userId,
      params.companyId,
    );
    this.securityAudit.mfaRecoveryCodesRegenerated(
      params.userId,
      credential.company_id,
    );
    return recoveryCodes;
  }

  async createLoginChallenge(params: {
    userId: string;
    companyId: string;
  }): Promise<{
    challengeToken: string;
    expiresIn: number;
    methods: string[];
  }> {
    const credential = await this.getActiveCredential(
      params.userId,
      params.companyId,
    );
    if (!credential) {
      throw new ForbiddenException('Usuário sem MFA ativo para login');
    }

    const expiresIn = getMfaLoginChallengeTtlSeconds(this.configService);
    const challengeToken = await this.issueChallengeToken({
      userId: params.userId,
      companyId: params.companyId,
      purpose: 'login',
      expiresIn,
    });

    return {
      challengeToken,
      expiresIn,
      methods: ['totp', 'recovery_code'],
    };
  }

  async createBootstrapEnrollmentResponse(user: MfaSessionUser): Promise<{
    challengeToken: string;
    expiresIn: number;
    otpAuthUrl: string;
    manualEntryKey: string;
    recoveryCodes: string[];
  }> {
    const userId = this.resolveMfaSubjectId({
      userId: user.id,
      authUserId: user.auth_user_id,
    });
    if (!userId) {
      throw new UnauthorizedException('Usuário inválido para MFA');
    }
    const enrollment = await this.startEnrollment({
      userId,
      companyId: user.company_id,
      label: user.cpf || user.nome || userId,
    });
    const expiresIn = getMfaBootstrapTtlSeconds(this.configService);
    const challengeToken = await this.issueChallengeToken({
      userId,
      companyId: user.company_id,
      purpose: 'bootstrap',
      expiresIn,
    });

    return {
      challengeToken,
      expiresIn,
      otpAuthUrl: enrollment.otpAuthUrl,
      manualEntryKey: enrollment.manualEntryKey,
      recoveryCodes: enrollment.recoveryCodes,
    };
  }

  async verifyLoginChallenge(params: {
    challengeToken: string;
    code: string;
  }): Promise<{ userId: string; companyId: string }> {
    const state = await this.consumeChallengeAttempt(params.challengeToken);
    if (state.purpose !== 'login') {
      throw new ForbiddenException('Challenge MFA inválido para login');
    }

    const credential = await this.requireCredential(
      state.userId,
      false,
      state.companyId,
    );
    const verification = await this.verifyCredentialCode({
      credential,
      userId: state.userId,
      code: params.code,
    });

    if (!verification.valid) {
      await this.registerChallengeFailure(params.challengeToken, state);
      this.securityAudit.mfaVerificationFailed(
        state.userId,
        'login',
        state.companyId,
      );
      throw new UnauthorizedException('Código MFA inválido');
    }

    await this.clearChallenge(params.challengeToken);
    this.securityAudit.mfaUsed(
      state.userId,
      verification.method,
      'login',
      state.companyId,
    );
    return { userId: state.userId, companyId: credential.company_id };
  }

  async activateBootstrapChallenge(params: {
    challengeToken: string;
    code: string;
  }): Promise<{ userId: string; companyId: string }> {
    const state = await this.consumeChallengeAttempt(params.challengeToken);
    if (state.purpose !== 'bootstrap') {
      throw new ForbiddenException('Challenge MFA inválido para bootstrap');
    }

    const credential = await this.requireCredential(
      state.userId,
      true,
      state.companyId,
    );
    const verification = await this.verifyCredentialCode({
      credential,
      userId: state.userId,
      code: params.code,
    });

    if (!verification.valid) {
      await this.registerChallengeFailure(params.challengeToken, state);
      this.securityAudit.mfaVerificationFailed(
        state.userId,
        'bootstrap',
        state.companyId,
      );
      throw new UnauthorizedException('Código MFA inválido');
    }

    credential.is_enabled = true;
    credential.verified_at = new Date();
    credential.disabled_at = null;
    credential.last_used_at = new Date();
    await this.withMfaTenantContext(credential.company_id, state.userId, () =>
      this.credentialRepository.save(credential),
    );
    await this.clearChallenge(params.challengeToken);
    this.securityAudit.mfaActivated(
      state.userId,
      verification.method,
      credential.company_id,
    );
    return { userId: state.userId, companyId: credential.company_id };
  }

  async verifyStepUp(params: {
    userId: string;
    companyId?: string | null;
    profileName?: string | null;
    reason: string;
    code?: string;
    password?: string;
    accessJti?: string;
  }): Promise<{ stepUpToken: string; expiresIn: number }> {
    const credential = await this.getActiveCredential(
      params.userId,
      params.companyId,
    );
    let method: SupportedMfaMethod | undefined;

    if (credential) {
      const verification = await this.verifyCredentialCode({
        credential,
        userId: params.userId,
        code: params.code || '',
      });
      if (!verification.valid) {
        this.securityAudit.mfaVerificationFailed(
          params.userId,
          'step_up',
          credential.company_id,
        );
        throw new UnauthorizedException('Código MFA inválido');
      }
      method = verification.method;
    } else if (this.canUsePasswordFallback(params.profileName)) {
      if (!params.password) {
        throw new UnauthorizedException(
          'Senha é obrigatória para reautenticação',
        );
      }
      const isMatch = await this.authService.verifyUserPassword(
        params.userId,
        params.password,
      );
      if (!isMatch) {
        this.securityAudit.stepUpFailed(
          params.userId,
          'wrong_password',
          params.companyId,
        );
        throw new UnauthorizedException('Senha incorreta');
      }
      method = 'password_fallback';
    } else {
      this.securityAudit.stepUpFailed(
        params.userId,
        'mfa_required',
        params.companyId,
      );
      throw new ForbiddenException(
        'Conta privilegiada sem MFA ativo. Conclua o cadastro antes de executar esta operação.',
      );
    }

    const expiresIn = getMfaStepUpTtlSeconds(this.configService);
    const jti = crypto.randomUUID();
    const secret = getMfaJwtSecret(this.configService);
    const payload = {
      sub: params.userId,
      purpose: 'step_up',
      reason: params.reason,
      jti,
      accessJti: params.accessJti,
      method,
    };
    const token = await this.jwtService.signAsync(payload, {
      expiresIn,
      secret,
    });
    await this.redisService.getClient().setex(
      this.getStepUpRedisKey(jti),
      expiresIn,
      JSON.stringify({
        userId: params.userId,
        companyId: params.companyId,
        reason: params.reason,
        accessJti: params.accessJti,
        method,
      } satisfies StepUpState),
    );
    this.securityAudit.stepUpIssued(
      params.userId,
      params.reason,
      method,
      params.companyId,
    );
    return { stepUpToken: token, expiresIn };
  }

  async consumeStepUpToken(params: {
    token: string;
    userId: string;
    reason: string;
    accessJti?: string;
  }): Promise<void> {
    const secret = getMfaJwtSecret(this.configService);
    let payload: {
      sub?: string;
      purpose?: string;
      reason?: string;
      jti?: string;
      accessJti?: string;
    };

    try {
      payload = await this.jwtService.verifyAsync(params.token, { secret });
    } catch {
      this.securityAudit.stepUpFailed(params.userId, 'invalid_token');
      throw new ForbiddenException('Token de step-up inválido ou expirado');
    }

    if (
      payload.sub !== params.userId ||
      payload.purpose !== 'step_up' ||
      !payload.jti
    ) {
      this.securityAudit.stepUpFailed(params.userId, 'invalid_subject');
      throw new ForbiddenException('Token de step-up inválido');
    }

    const stored = await this.atomicGetAndDelete(
      this.getStepUpRedisKey(payload.jti),
    );
    if (!stored) {
      this.securityAudit.stepUpFailed(params.userId, 'replayed_or_expired');
      throw new ForbiddenException('Token de step-up inválido ou já utilizado');
    }

    let state: StepUpState | null;
    try {
      state = JSON.parse(stored) as StepUpState;
    } catch {
      throw new ForbiddenException('Token de step-up corrompido');
    }

    if (
      state.userId !== params.userId ||
      state.reason !== params.reason ||
      (state.accessJti &&
        params.accessJti &&
        state.accessJti !== params.accessJti)
    ) {
      this.securityAudit.stepUpFailed(
        params.userId,
        'reason_mismatch',
        state.companyId,
      );
      throw new ForbiddenException(
        'Token de step-up não corresponde à operação',
      );
    }

    this.securityAudit.stepUpVerified(
      params.userId,
      params.reason,
      state.method,
      state.companyId,
    );
  }

  private async replaceRecoveryCodes(
    credential: UserMfaCredential,
    userId: string,
    companyId: string,
  ): Promise<string[]> {
    await this.withMfaTenantContext(companyId, userId, () =>
      this.recoveryCodeRepository.delete({ credential_id: credential.id }),
    );
    const recoveryCodes = Array.from({ length: 10 }, () =>
      generateRecoveryCode(),
    );
    const entities = await Promise.all(
      recoveryCodes.map(async (code) =>
        this.recoveryCodeRepository.create({
          credential_id: credential.id,
          user_id: userId,
          company_id: companyId,
          code_hash: await this.passwordService.hash(code),
        }),
      ),
    );
    await this.withMfaTenantContext(companyId, userId, () =>
      this.recoveryCodeRepository.save(entities),
    );
    return recoveryCodes;
  }

  private async issueChallengeToken(params: {
    userId: string;
    companyId: string;
    purpose: ChallengePurpose;
    expiresIn: number;
  }): Promise<string> {
    const secret = getMfaJwtSecret(this.configService);
    const jti = crypto.randomUUID();
    const token = await this.jwtService.signAsync(
      {
        sub: params.userId,
        company_id: params.companyId,
        purpose: params.purpose,
        jti,
      },
      {
        expiresIn: params.expiresIn,
        secret,
      },
    );
    await this.redisService.getClient().setex(
      this.getChallengeRedisKey(jti),
      params.expiresIn,
      JSON.stringify({
        userId: params.userId,
        companyId: params.companyId,
        purpose: params.purpose,
        attempts: 0,
      } satisfies ChallengeState),
    );
    return token;
  }

  private async consumeChallengeAttempt(
    challengeToken: string,
  ): Promise<ChallengeState> {
    const payload = await this.verifyChallengeToken(challengeToken);
    const stored = await this.redisService
      .getClient()
      .get(this.getChallengeRedisKey(payload.jti));
    if (!stored) {
      throw new ForbiddenException('Challenge MFA inválido ou expirado');
    }

    const state = JSON.parse(stored) as ChallengeState;
    if (state.attempts >= getMfaMaxChallengeAttempts(this.configService)) {
      await this.clearChallenge(challengeToken);
      throw new ForbiddenException(
        'Challenge MFA excedeu o número máximo de tentativas',
      );
    }
    return state;
  }

  private async registerChallengeFailure(
    challengeToken: string,
    state: ChallengeState,
  ): Promise<void> {
    const payload = await this.verifyChallengeToken(challengeToken);
    const nextState = { ...state, attempts: state.attempts + 1 };
    const expiresIn = Math.max(
      5,
      payload.exp
        ? payload.exp - Math.floor(Date.now() / 1000)
        : getMfaLoginChallengeTtlSeconds(this.configService),
    );

    if (nextState.attempts >= getMfaMaxChallengeAttempts(this.configService)) {
      await this.clearChallenge(challengeToken);
      return;
    }

    await this.redisService
      .getClient()
      .setex(
        this.getChallengeRedisKey(payload.jti),
        expiresIn,
        JSON.stringify(nextState),
      );
  }

  private async clearChallenge(challengeToken: string): Promise<void> {
    const payload = await this.verifyChallengeToken(challengeToken);
    await this.redisService
      .getClient()
      .del(this.getChallengeRedisKey(payload.jti));
  }

  private async verifyChallengeToken(token: string): Promise<{
    sub: string;
    company_id: string;
    purpose: ChallengePurpose;
    jti: string;
    exp?: number;
  }> {
    const secret = getMfaJwtSecret(this.configService);
    try {
      return await this.jwtService.verifyAsync(token, { secret });
    } catch {
      throw new ForbiddenException('Challenge MFA inválido ou expirado');
    }
  }

  private async getActiveCredential(
    userId: string,
    companyId?: string | null,
  ): Promise<UserMfaCredential | null> {
    return this.withMfaTenantContext(companyId, userId, () =>
      this.credentialRepository.findOne({
        where: {
          user_id: userId,
          type: 'totp',
          is_enabled: true,
        },
      }),
    );
  }

  private async requireCredential(
    userId: string,
    allowPending: boolean,
    companyId?: string | null,
  ): Promise<UserMfaCredential> {
    const credential = await this.withMfaTenantContext(companyId, userId, () =>
      this.credentialRepository.findOne({
        where: {
          user_id: userId,
          type: 'totp',
        },
      }),
    );
    if (!credential) {
      throw new ForbiddenException('Usuário sem MFA cadastrado');
    }
    if (!allowPending && !credential.is_enabled) {
      throw new ForbiddenException('MFA ainda não está ativado');
    }
    return credential;
  }

  private async verifyCredentialCode(params: {
    credential: UserMfaCredential;
    userId: string;
    code: string;
  }): Promise<{ valid: boolean; method: SupportedMfaMethod }> {
    const normalizedCode = String(params.code || '').trim();
    const secret = this.decryptSecret(params.credential);
    if (verifyTotpCode({ secret, code: normalizedCode })) {
      params.credential.last_used_at = new Date();
      await this.withMfaTenantContext(
        params.credential.company_id,
        params.userId,
        () => this.credentialRepository.save(params.credential),
      );
      return { valid: true, method: 'totp' };
    }

    const recoveryCodes = await this.withMfaTenantContext(
      params.credential.company_id,
      params.userId,
      () =>
        this.recoveryCodeRepository.find({
          where: {
            credential_id: params.credential.id,
            user_id: params.userId,
            consumed_at: IsNull(),
          },
        }),
    );

    for (const recoveryCode of recoveryCodes) {
      const matches = await this.passwordService.verify(
        normalizedCode,
        recoveryCode.code_hash,
      );
      if (!matches) {
        continue;
      }

      recoveryCode.consumed_at = new Date();
      recoveryCode.last_used_at = new Date();
      await this.withMfaTenantContext(
        params.credential.company_id,
        params.userId,
        () => this.recoveryCodeRepository.save(recoveryCode),
      );
      this.securityAudit.mfaRecoveryCodeUsed(
        params.userId,
        params.credential.company_id,
      );
      return { valid: true, method: 'recovery_code' };
    }

    return { valid: false, method: 'totp' };
  }

  private canUsePasswordFallback(profileName?: string | null): boolean {
    const normalized = normalizePrivilegedRole(profileName);
    if (normalized === 'SUPER_ADMIN' || normalized === 'ADMIN_GERAL') {
      return !isAdminGeralMfaEnforced(this.configService);
    }
    if (normalized === 'ADMIN_EMPRESA') {
      return isAdminEmpresaPasswordFallbackAllowed(this.configService);
    }
    return normalized === 'NON_PRIVILEGED';
  }

  private withMfaTenantContext<T>(
    companyId: string | null | undefined,
    userId: string | null | undefined,
    callback: () => T,
  ): T {
    const normalizedCompanyId = companyId?.trim();
    const currentContext = this.tenantService.getContext();

    if (
      currentContext &&
      (!normalizedCompanyId || currentContext.companyId === normalizedCompanyId)
    ) {
      return callback();
    }

    if (!normalizedCompanyId) {
      return callback();
    }

    return this.tenantService.run(
      {
        companyId: normalizedCompanyId,
        isSuperAdmin: false,
        userId: userId?.trim() || undefined,
        siteScope: 'all',
      },
      callback,
    );
  }

  private isUuid(value: string | null | undefined): value is string {
    return typeof value === 'string' && UUID_REGEX.test(value.trim());
  }

  private resolveMfaSubjectId(params: {
    userId?: string | null;
    authUserId?: string | null;
  }): string | null {
    if (this.isUuid(params.userId)) {
      return params.userId.trim();
    }

    if (this.isUuid(params.authUserId)) {
      return params.authUserId.trim();
    }

    return null;
  }

  private assertMfaSubjectId(
    userId: string | null | undefined,
    context: string,
  ): string {
    const resolved = this.resolveMfaSubjectId({ userId });
    if (!resolved) {
      this.logger.warn({
        event: 'mfa_invalid_subject',
        context,
        userId: userId ?? null,
      });
      throw new UnauthorizedException('Usuário inválido para MFA');
    }
    return resolved;
  }

  private encryptSecret(secret: string): {
    ciphertext: string;
    iv: string;
    tag: string;
  } {
    const key = getMfaTotpEncryptionKey(this.configService);
    const iv = crypto.randomBytes(MFA_TOTP_SECRET_IV_LENGTH_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: MFA_TOTP_SECRET_AUTH_TAG_LENGTH_BYTES,
    });
    const ciphertext = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
    };
  }

  private decryptSecret(credential: UserMfaCredential): string {
    const key = getMfaTotpEncryptionKey(this.configService);
    const iv = Buffer.from(credential.secret_iv, 'hex');
    const authTag = Buffer.from(credential.secret_tag, 'hex');

    if (iv.length !== MFA_TOTP_SECRET_IV_LENGTH_BYTES) {
      throw new UnauthorizedException('Credencial MFA inválida.');
    }

    if (authTag.length !== MFA_TOTP_SECRET_AUTH_TAG_LENGTH_BYTES) {
      throw new UnauthorizedException('Credencial MFA inválida.');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: MFA_TOTP_SECRET_AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(credential.secret_ciphertext, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  private getChallengeRedisKey(jti: string): string {
    return `mfa:challenge:${jti}`;
  }

  private getStepUpRedisKey(jti: string): string {
    return `mfa:step-up:${jti}`;
  }

  private async atomicGetAndDelete(key: string): Promise<string | null> {
    const result = await this.redisService
      .getClient()
      .eval(
        "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value",
        1,
        key,
      );

    return typeof result === 'string' ? result : null;
  }
}
