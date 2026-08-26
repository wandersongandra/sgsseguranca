import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  HttpException,
  HttpStatus,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, MoreThan, Repository } from 'typeorm';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { Role } from './enums/roles.enum';
import { normalizeRoleName } from './role-normalization.util';
import { CpfUtil } from '../../shared/utils/cpf.util';
import { PasswordService } from '../../shared/services/password.service';
import { AuthRedisService } from '../../shared/redis/redis.service';
import { TokenRevocationService } from './token-revocation.service';
import { MailService } from '../../infra/mail/mail.service';
import * as crypto from 'crypto';
import { UserSession } from './entities/user-session.entity';
import { SecurityAuditService } from '../../shared/security/security-audit.service';
import { LoginAnomalyService } from './services/login-anomaly.service';
import { PwnedPasswordService } from './services/pwned-password.service';
import {
  getRefreshTokenSecret,
  getAccessTokenTtl,
  isInfiniteTtl,
  getRefreshTokenTtl,
  getRefreshTokenTtlDays,
  getMaxActiveSessionsPerUser,
  getJwtSignOptions,
  getJwtVerifyOptions,
  JWT_ACCESS_TOKEN_TYPE,
  JWT_REFRESH_TOKEN_TYPE,
} from './auth-security.config';
import {
  assertJwtHasExpiration,
  resolveAccessTokenSecret,
} from './utils/access-token-claims.util';
import { resolvePasswordResetBaseUrl } from '../../shared/utils/password-reset-url.util';
import {
  decryptSensitiveValue,
  hashSensitiveValue,
} from '../../shared/security/field-encryption.util';
import { TenantService } from '../../shared/tenant/tenant.service';
import {
  AuthPrincipalService,
  isSuperAdminProfileName,
} from './auth-principal.service';
import { isLegacyCpfPlaintextLookupEnabled } from '../privacy/cpf-plaintext-migration.util';

const RESET_TOKEN_TTL_SECONDS = 3600; // 1 hora
const RESET_TOKEN_CONSUMED_TTL_SECONDS = 24 * 3600; // 24h para forense/reuse detection
const RESET_TOKEN_RATE_LIMIT_ATTEMPTS = 8;
const RESET_TOKEN_RATE_LIMIT_WINDOW_SECONDS = 5 * 60; // 5 min
const FORGOT_PASSWORD_MIN_PROCESSING_MS = 450;
const FORGOT_PASSWORD_JITTER_MS = 200;
const FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SECONDS = 5 * 60;
const FORGOT_PASSWORD_RATE_LIMIT_IP_ATTEMPTS = 12;
const FORGOT_PASSWORD_RATE_LIMIT_CPF_ATTEMPTS = 6;

// Tracer de módulo — leve (apenas referência ao SDK, zero overhead se OTel desabilitado).
const authTracer = trace.getTracer('auth-service');

interface JwtPayload {
  sub: string;
  cpf?: string;
  company_id: string;
  site_id?: string | null;
  profile: unknown;
  isAdminGeral?: boolean;
  auth_uid?: string;
  app_user_id?: string;
  jti?: string;
  exp?: number;
  token_type?: typeof JWT_ACCESS_TOKEN_TYPE | typeof JWT_REFRESH_TOKEN_TYPE;
}

type AuthLoginUserRow = {
  id: string;
  nome: string;
  cpf: string | null;
  cpf_ciphertext?: string | null;
  email: string | null;
  funcao: string | null;
  password?: string | null;
  auth_user_id?: string | null;
  company_id: string;
  site_id?: string | null;
  profile_id: string;
  status: boolean;
  must_change_password?: boolean;
  profile_nome?: string | null;
};

type ResetTokenConsumeStatus =
  'CONSUMED' | 'REUSED' | 'RATE_LIMITED' | 'MISSING' | 'EXPIRED' | 'INVALID';

type ResetTokenConsumeResult = {
  status: ResetTokenConsumeStatus;
  attempts: number;
  userId?: string;
  retryAfterSeconds?: number;
  consumedAtMs?: number;
};

type ForgotPasswordContext = {
  ip?: string | null;
};

type ForgotPasswordRateLimitResult = {
  ipAttempts: number;
  cpfAttempts: number;
  limited: boolean;
  retryAfterSeconds: number;
};

@Injectable()
export class AuthService {
  // DUMMY_HASH: usado quando o usuário não é encontrado no banco para evitar user
  // enumeration via timing attack. Mantido em bcrypt durante a migração gradual para
  // argon2id — passwordService.verify() roteia corretamente pelo prefixo.
  //
  // AÇÃO PENDENTE (Fase 3 do plano de segurança):
  // Antes de trocar para argon2id, confirmar com:
  //   SELECT COUNT(*) FROM users WHERE password LIKE '$2%';
  // Se retornar 0, gerar novo hash com:
  //   node -e "const a=require('argon2');a.hash('dummy-placeholder-not-a-real-password').then(h=>console.log(h))"
  // E substituir o valor abaixo pelo hash gerado.
  private readonly DUMMY_HASH: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(UserSession)
    private readonly userSessionRepository: Repository<UserSession>,
    private usersService: UsersService,
    private jwtService: JwtService,
    private passwordService: PasswordService,
    private redisService: AuthRedisService,
    private configService: ConfigService,
    private tokenRevocationService: TokenRevocationService,
    private readonly securityAudit: SecurityAuditService,
    @Inject(forwardRef(() => MailService))
    private readonly mailService: MailService,
    private readonly loginAnomalyService: LoginAnomalyService,
    private readonly pwnedPasswordService: PwnedPasswordService,
    private readonly tenantService: TenantService,
    private readonly authPrincipalService: AuthPrincipalService,
  ) {
    const _envDummyHash = this.configService.get<string>(
      'AUTH_DUMMY_PASSWORD_HASH',
    );
    if (!_envDummyHash && process.env.NODE_ENV === 'production') {
      throw new Error('AUTH_DUMMY_PASSWORD_HASH é obrigatório em produção');
    }
    this.DUMMY_HASH =
      _envDummyHash ??
      '$2b$10$tV1AhMRqCdZTnSEV18aoR.MSJ.1zu7PIewZKDn1GkoTSqvrSNENC2';
  }

  private resolveFromAddress() {
    const fromName =
      this.configService.get<string>('MAIL_FROM_NAME')?.trim() ||
      'SGS - Sistema de Gestão de Segurança';
    const fromEmail =
      this.configService.get<string>('MAIL_FROM_EMAIL')?.trim() ||
      'onboarding@resend.dev';
    return { fromName, fromEmail };
  }

  private resolveReplyToAddress() {
    const { fromName, fromEmail } = this.resolveFromAddress();
    const replyToEmail =
      this.configService.get<string>('MAIL_REPLY_TO_EMAIL')?.trim() ||
      fromEmail;
    const replyToName =
      this.configService.get<string>('MAIL_REPLY_TO_NAME')?.trim() || fromName;

    return { replyToName, replyToEmail };
  }

  private buildOfficialFooter(channelLabel = 'Comunicação oficial') {
    const { fromName } = this.resolveFromAddress();
    const { replyToEmail } = this.resolveReplyToAddress();
    return `${fromName} · ${channelLabel} · Respostas para ${replyToEmail}`;
  }

  private resolvePasswordResetBaseUrl(): string {
    return resolvePasswordResetBaseUrl(this.configService);
  }

  private readonly logger = new Logger(AuthService.name);

  private readPostgresErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return undefined;
    }

    const { code } = error as { code?: unknown };
    return typeof code === 'string' ? code : undefined;
  }

  private async loadLoginUserByCpf(
    normalizedCpf: string,
  ): Promise<AuthLoginUserRow | null> {
    const cpfHash = hashSensitiveValue(normalizedCpf);
    const legacyPlaintextLookupEnabled = isLegacyCpfPlaintextLookupEnabled();
    // Usa função SECURITY DEFINER (migration 359) — roda como owner (BYPASSRLS)
    // sem depender de membership sgs_rls_bypass na conexão runtime.
    const rows = (await this.dataSource.query(
      `SELECT * FROM find_login_user($1, $2)`,
      [cpfHash, legacyPlaintextLookupEnabled ? normalizedCpf : null],
    )) as unknown;

    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    const row = rows[0] as AuthLoginUserRow;
    row.cpf = row.cpf_ciphertext
      ? decryptSensitiveValue(row.cpf_ciphertext)
      : row.cpf;
    // ensure boolean
    if (row && 'must_change_password' in row) {
      row.must_change_password = Boolean(row.must_change_password);
    }
    return row;
  }

  private async verifyPasswordAgainstStoredHash(
    password: string,
    storedHash: string,
  ): Promise<{ isMatch: boolean; needsRehash: boolean }> {
    const isKnownHash =
      this.passwordService.isLegacyHash(storedHash) ||
      storedHash.startsWith('$argon2');

    if (isKnownHash) {
      const algorithm = this.passwordService.isLegacyHash(storedHash)
        ? 'bcrypt'
        : 'argon2id';

      const verifySpan = authTracer.startSpan('auth.password.verify');
      verifySpan.setAttribute('hash.algorithm', algorithm);

      let isMatch = false;
      try {
        isMatch = await this.passwordService.verify(password, storedHash);
      } finally {
        verifySpan.setAttribute('auth.match', isMatch);
        verifySpan.end();
      }

      return {
        isMatch,
        needsRehash: isMatch && algorithm === 'bcrypt',
      };
    }

    return { isMatch: false, needsRehash: false };
  }

  async verifyUserPassword(userId: string, password: string): Promise<boolean> {
    const user = await this.usersService.findOneWithPassword(userId);
    if (!user || !user.password) {
      return false;
    }

    const local = await this.verifyPasswordAgainstStoredHash(
      password,
      user.password,
    );
    if (local.isMatch) {
      if (local.needsRehash) {
        const newHash = await this.passwordService.hash(password);
        await this.dataSource.query(
          `SELECT update_login_user_password_hash($1, $2)`,
          [userId, newHash],
        );
      }
      return true;
    }

    return false;
  }

  async validateUser(cpf: string, pass: string): Promise<Partial<User> | null> {
    if (!cpf || !pass) {
      return null;
    }

    return authTracer.startActiveSpan('auth.validateUser', async (span) => {
      try {
        const normalizedCpf = CpfUtil.normalize(cpf);

        // Modo desenvolvimento: bypass de login APENAS quando explicitamente habilitado.
        const devCpf = (process.env.DEV_ADMIN_CPF || '').replace(/\D/g, '');
        const devPass = process.env.DEV_ADMIN_PASSWORD || '';
        const isDevBypassEnabled =
          process.env.NODE_ENV === 'development' &&
          process.env.DEV_LOGIN_BYPASS === 'true' &&
          process.env.ALLOW_DEV_LOGIN_BYPASS === 'true' &&
          devCpf &&
          devPass;
        if (
          isDevBypassEnabled &&
          normalizedCpf === devCpf &&
          pass === devPass
        ) {
          const devUser = await this.loadLoginUserByCpf(normalizedCpf);

          if (!devUser || devUser.status === false) {
            span.setAttribute('auth.dev_bypass', true);
            span.setAttribute('auth.success', false);
            return null;
          }

          const { profile_nome: _profileName, ...userWithoutProfileName } =
            devUser;
          span.setAttribute('auth.dev_bypass', true);
          span.setAttribute('auth.success', true);
          return {
            ...userWithoutProfileName,
            profile: devUser.profile_nome
              ? ({
                  id: devUser.profile_id,
                  nome: devUser.profile_nome,
                } as User['profile'])
              : null,
          } as Partial<User>;
        }

        const dbSpan = authTracer.startSpan('auth.db.findUser');
        let user: AuthLoginUserRow | null = null;
        try {
          user = await this.loadLoginUserByCpf(normalizedCpf);
          dbSpan.setAttribute('db.user_found', user !== null);
        } finally {
          dbSpan.end();
        }

        let isMatch = false;
        let needsRehash = false;

        if (user) {
          if (user.password) {
            const localVerification =
              await this.verifyPasswordAgainstStoredHash(pass, user.password);
            isMatch = localVerification.isMatch;
            needsRehash = localVerification.needsRehash;
          }
        } else {
          // Usuário não encontrado: verify dummy para evitar user enumeration por timing.
          await this.passwordService.verify(pass, this.DUMMY_HASH);
        }

        span.setAttribute('auth.success', isMatch && !!user);
        span.setAttribute('auth.needs_rehash', needsRehash);
        span.setAttribute('auth.source', isMatch ? 'local' : 'none');

        if (!user || user.status === false || !isMatch) {
          return null;
        }

        // Rehash fire-and-forget: migra bcrypt → argon2id de forma transparente.
        // NÃO bloqueia a resposta — token emitido imediatamente.
        if (needsRehash && user.id) {
          const userId = user.id;
          setImmediate(() => {
            void this.passwordService
              .hash(pass)
              .then(async (newHash) => {
                await this.dataSource.query(
                  `SELECT update_login_user_password_hash($1, $2)`,
                  [userId, newHash],
                );
                this.logger.warn({
                  event: 'password_rehashed_to_argon2id',
                  userId,
                });
              })
              .catch((err: unknown) => {
                this.logger.error(
                  `Falha ao migrar hash de senha para argon2id (userId=${userId}): ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              });
          });
        }

        const { profile_nome: _profileName, ...userWithoutProfileName } = user;
        const result = {
          ...userWithoutProfileName,
          profile: user.profile_nome
            ? ({
                id: user.profile_id,
                nome: user.profile_nome,
              } as User['profile'])
            : undefined,
        } as Partial<User>;
        delete result.password;
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private getResetTokenConsumedKey(tokenHash: string): string {
    return `reset_password_consumed:${tokenHash}`;
  }

  private getResetTokenAttemptsKey(tokenHash: string): string {
    return `reset_password_attempts:${tokenHash}`;
  }

  private getForgotPasswordRateLimitIpKey(ipHash: string): string {
    return `forgot_password:rl:ip:${ipHash}`;
  }

  private getForgotPasswordRateLimitCpfKey(cpfHash: string): string {
    return `forgot_password:rl:cpf:${cpfHash}`;
  }

  private getResetTokenConsumedTtlSeconds(): number {
    const parsed = Number(
      process.env.RESET_TOKEN_CONSUMED_TTL_SECONDS ||
        RESET_TOKEN_CONSUMED_TTL_SECONDS,
    );
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return RESET_TOKEN_CONSUMED_TTL_SECONDS;
    }
    return Math.min(Math.floor(parsed), 7 * 24 * 3600);
  }

  private getResetTokenRateLimitAttempts(): number {
    const parsed = Number(
      process.env.RESET_TOKEN_RATE_LIMIT_ATTEMPTS ||
        RESET_TOKEN_RATE_LIMIT_ATTEMPTS,
    );
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return RESET_TOKEN_RATE_LIMIT_ATTEMPTS;
    }
    return Math.min(Math.floor(parsed), 50);
  }

  private getResetTokenRateLimitWindowSeconds(): number {
    const parsed = Number(
      process.env.RESET_TOKEN_RATE_LIMIT_WINDOW_SECONDS ||
        RESET_TOKEN_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return RESET_TOKEN_RATE_LIMIT_WINDOW_SECONDS;
    }
    return Math.min(Math.floor(parsed), 3600);
  }

  private getForgotPasswordMinProcessingMs(): number {
    const parsed = Number(
      process.env.FORGOT_PASSWORD_MIN_PROCESSING_MS ||
        FORGOT_PASSWORD_MIN_PROCESSING_MS,
    );
    if (!Number.isFinite(parsed)) {
      return FORGOT_PASSWORD_MIN_PROCESSING_MS;
    }
    return Math.min(Math.max(Math.floor(parsed), 100), 5000);
  }

  private getForgotPasswordJitterMs(): number {
    const parsed = Number(
      process.env.FORGOT_PASSWORD_JITTER_MS || FORGOT_PASSWORD_JITTER_MS,
    );
    if (!Number.isFinite(parsed)) {
      return FORGOT_PASSWORD_JITTER_MS;
    }
    return Math.min(Math.max(Math.floor(parsed), 0), 2000);
  }

  private getForgotPasswordRateLimitWindowSeconds(): number {
    const parsed = Number(
      process.env.FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SECONDS ||
        FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SECONDS;
    }
    return Math.min(Math.floor(parsed), 3600);
  }

  private getForgotPasswordRateLimitIpAttempts(): number {
    const parsed = Number(
      process.env.FORGOT_PASSWORD_RATE_LIMIT_IP_ATTEMPTS ||
        FORGOT_PASSWORD_RATE_LIMIT_IP_ATTEMPTS,
    );
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return FORGOT_PASSWORD_RATE_LIMIT_IP_ATTEMPTS;
    }
    return Math.min(Math.floor(parsed), 120);
  }

  private getForgotPasswordRateLimitCpfAttempts(): number {
    const parsed = Number(
      process.env.FORGOT_PASSWORD_RATE_LIMIT_CPF_ATTEMPTS ||
        FORGOT_PASSWORD_RATE_LIMIT_CPF_ATTEMPTS,
    );
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return FORGOT_PASSWORD_RATE_LIMIT_CPF_ATTEMPTS;
    }
    return Math.min(Math.floor(parsed), 60);
  }

  private buildForgotPasswordTargetDurationMs(): number {
    const jitterMax = this.getForgotPasswordJitterMs();
    const jitter =
      jitterMax > 0 ? Math.floor(Math.random() * (jitterMax + 1)) : 0;
    return this.getForgotPasswordMinProcessingMs() + jitter;
  }

  private async ensureMinimumProcessingTime(
    startedAtMs: number,
    targetDurationMs: number,
  ): Promise<void> {
    const elapsedMs = Date.now() - startedAtMs;
    const remainingMs = targetDurationMs - elapsedMs;
    if (remainingMs <= 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }

  private normalizeForgotPasswordIp(ip?: string | null): string {
    const value = String(ip || '').trim();
    return value || 'unknown';
  }

  private parseForgotPasswordRateLimitResult(
    rawResult: unknown,
  ): ForgotPasswordRateLimitResult {
    if (!Array.isArray(rawResult) || rawResult.length < 4) {
      return {
        ipAttempts: 0,
        cpfAttempts: 0,
        limited: true,
        retryAfterSeconds: this.getForgotPasswordRateLimitWindowSeconds(),
      };
    }

    const [rawIpAttempts, rawCpfAttempts, rawLimited, rawRetryAfter] =
      rawResult as unknown[];
    const ipAttempts = Number(rawIpAttempts) || 0;
    const cpfAttempts = Number(rawCpfAttempts) || 0;
    const limited =
      String(rawLimited) === '1' ||
      String(rawLimited).toLowerCase() === 'true' ||
      Number(rawLimited) === 1;
    const retryAfterSeconds = Math.max(0, Number(rawRetryAfter) || 0);

    return { ipAttempts, cpfAttempts, limited, retryAfterSeconds };
  }

  private async consumeForgotPasswordRateLimit(
    sourceIp: string,
    normalizedCpf: string,
  ): Promise<ForgotPasswordRateLimitResult> {
    const ipHash = this.hashContext(sourceIp);
    const cpfHash = this.hashContext(normalizedCpf);
    const ipKey = this.getForgotPasswordRateLimitIpKey(ipHash);
    const cpfKey = this.getForgotPasswordRateLimitCpfKey(cpfHash);

    const script = `
      local windowSeconds = tonumber(ARGV[1])
      local ipLimit = tonumber(ARGV[2])
      local cpfLimit = tonumber(ARGV[3])

      local ipCount = redis.call('INCR', KEYS[1])
      if ipCount == 1 then
        redis.call('EXPIRE', KEYS[1], windowSeconds)
      end

      local cpfCount = redis.call('INCR', KEYS[2])
      if cpfCount == 1 then
        redis.call('EXPIRE', KEYS[2], windowSeconds)
      end

      local limited = 0
      if ipCount > ipLimit or cpfCount > cpfLimit then
        limited = 1
      end

      local retryAfter = 0
      if limited == 1 then
        local ipTtl = redis.call('TTL', KEYS[1])
        local cpfTtl = redis.call('TTL', KEYS[2])
        if ipTtl < 0 then ipTtl = 0 end
        if cpfTtl < 0 then cpfTtl = 0 end
        retryAfter = math.max(ipTtl, cpfTtl)
      end

      return {
        tostring(ipCount),
        tostring(cpfCount),
        tostring(limited),
        tostring(retryAfter)
      }
    `;

    const rawResult = await this.redisService
      .getClient()
      .eval(
        script,
        2,
        ipKey,
        cpfKey,
        String(this.getForgotPasswordRateLimitWindowSeconds()),
        String(this.getForgotPasswordRateLimitIpAttempts()),
        String(this.getForgotPasswordRateLimitCpfAttempts()),
      );

    return this.parseForgotPasswordRateLimitResult(rawResult);
  }

  private parseResetTokenConsumeResult(
    rawResult: unknown,
  ): ResetTokenConsumeResult {
    if (!Array.isArray(rawResult) || rawResult.length === 0) {
      return { status: 'INVALID', attempts: 0 };
    }

    const [rawStatus, rawAttempts, rawThird, rawFourth] =
      rawResult as unknown[];
    const statusText = typeof rawStatus === 'string' ? rawStatus : '';
    const status = statusText.toUpperCase() as ResetTokenConsumeStatus;
    const attempts = Number(rawAttempts) || 0;

    switch (status) {
      case 'CONSUMED':
        return {
          status,
          attempts,
          userId: typeof rawThird === 'string' ? rawThird : undefined,
          consumedAtMs: Number(rawFourth) || undefined,
        };
      case 'RATE_LIMITED':
        return {
          status,
          attempts,
          retryAfterSeconds: Number(rawThird) || undefined,
        };
      case 'REUSED':
      case 'MISSING':
      case 'EXPIRED':
      case 'INVALID':
        return { status, attempts };
      default:
        return { status: 'INVALID', attempts };
    }
  }

  private async consumeResetTokenAtomically(
    token: string,
  ): Promise<ResetTokenConsumeResult> {
    const tokenHash = this.hashToken(token);
    const resetKey = `reset_password:${token}`;
    const consumedKey = this.getResetTokenConsumedKey(tokenHash);
    const attemptsKey = this.getResetTokenAttemptsKey(tokenHash);
    const nowMs = Date.now();

    const script = `
      local now = tonumber(ARGV[1])
      local maxAttempts = tonumber(ARGV[2])
      local attemptsWindow = tonumber(ARGV[3])
      local consumedTtl = tonumber(ARGV[4])

      local attempts = redis.call('INCR', KEYS[3])
      if attempts == 1 then
        redis.call('EXPIRE', KEYS[3], attemptsWindow)
      end

      if attempts > maxAttempts then
        local retryAfter = redis.call('TTL', KEYS[3])
        return { 'RATE_LIMITED', tostring(attempts), tostring(retryAfter) }
      end

      local tokenValue = redis.call('GET', KEYS[1])
      if not tokenValue then
        local consumed = redis.call('GET', KEYS[2])
        if consumed then
          return { 'REUSED', tostring(attempts), consumed }
        end
        return { 'MISSING', tostring(attempts), '' }
      end

      local userId = tokenValue
      local expiresAtMs = 0
      if string.sub(tokenValue, 1, 1) == '{' then
        local ok, decoded = pcall(cjson.decode, tokenValue)
        if ok and decoded then
          if decoded['userId'] then userId = tostring(decoded['userId']) end
          if decoded['user_id'] then userId = tostring(decoded['user_id']) end
          if decoded['expiresAtMs'] then expiresAtMs = tonumber(decoded['expiresAtMs']) or 0 end
          if decoded['expires_at_ms'] then expiresAtMs = tonumber(decoded['expires_at_ms']) or expiresAtMs end
        end
      end

      if userId == nil or userId == '' then
        return { 'INVALID', tostring(attempts), '' }
      end

      if expiresAtMs > 0 and now > expiresAtMs then
        redis.call('DEL', KEYS[1])
        return { 'EXPIRED', tostring(attempts), tostring(expiresAtMs) }
      end

      local consumedPayload = cjson.encode({
        userId = userId,
        consumedAtMs = now,
        attempts = attempts
      })
      local marked = redis.call('SET', KEYS[2], consumedPayload, 'NX', 'EX', consumedTtl)
      if not marked then
        local consumed = redis.call('GET', KEYS[2]) or ''
        return { 'REUSED', tostring(attempts), consumed }
      end

      redis.call('DEL', KEYS[1])
      return { 'CONSUMED', tostring(attempts), userId, tostring(now) }
    `;

    const raw = await this.redisService
      .getClient()
      .eval(
        script,
        3,
        resetKey,
        consumedKey,
        attemptsKey,
        String(nowMs),
        String(this.getResetTokenRateLimitAttempts()),
        String(this.getResetTokenRateLimitWindowSeconds()),
        String(this.getResetTokenConsumedTtlSeconds()),
      );

    return this.parseResetTokenConsumeResult(raw);
  }

  private hashContext(value: string): string {
    // Hash operacional para chaves/cache/auditoria, não para armazenar senha.
    // lgtm[js/insufficient-password-hash]
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  private resolveRefreshExpiryDate(): Date {
    return new Date(
      Date.now() + getRefreshTokenTtlDays() * 24 * 60 * 60 * 1000,
    );
  }

  private normalizeSessionDevice(userAgent?: string): string | null {
    const value = String(userAgent || '').trim();
    return value ? value.slice(0, 255) : null;
  }

  private normalizeSessionIp(ip?: string): string {
    const value = String(ip || '').trim();
    return value || 'unknown';
  }

  private normalizeSessionCompanyId(companyId?: string | null): string {
    const value = String(companyId || '').trim();
    if (!value) {
      throw new UnauthorizedException(
        'Usuário sem empresa vinculada para criar sessão.',
      );
    }
    return value;
  }

  private async persistNewSession(params: {
    userId: string;
    companyId: string;
    tokenHash: string;
    userAgent?: string;
    ip?: string;
  }): Promise<void> {
    await this.withUserSessionTenantContext(params.companyId, (repository) => {
      return repository.insert({
        user_id: params.userId,
        company_id: params.companyId,
        ip: this.normalizeSessionIp(params.ip),
        device: this.normalizeSessionDevice(params.userAgent),
        token_hash: params.tokenHash,
        is_active: true,
        expires_at: this.resolveRefreshExpiryDate(),
        revoked_at: null,
      });
    });
  }

  private async rotatePersistedSession(params: {
    userId: string;
    companyId: string;
    previousTokenHash: string;
    nextTokenHash: string;
    userAgent?: string;
    ip?: string;
    insertIfMissing?: boolean;
  }): Promise<void> {
    const updateResult = await this.withUserSessionTenantContext(
      params.companyId,
      (repository) =>
        repository.update(
          {
            user_id: params.userId,
            token_hash: params.previousTokenHash,
            is_active: true,
          },
          {
            token_hash: params.nextTokenHash,
            last_active: new Date(),
            expires_at: this.resolveRefreshExpiryDate(),
            ip: this.normalizeSessionIp(params.ip),
            device: this.normalizeSessionDevice(params.userAgent),
            revoked_at: null,
            is_active: true,
          },
        ),
    );

    if (!updateResult.affected && params.insertIfMissing !== false) {
      await this.persistNewSession({
        userId: params.userId,
        companyId: params.companyId,
        tokenHash: params.nextTokenHash,
        userAgent: params.userAgent,
        ip: params.ip,
      });
    }
  }

  private async findActivePersistedSession(
    userId: string,
    tokenHash: string,
    companyId: string,
  ): Promise<UserSession | null> {
    return this.withUserSessionTenantContext(companyId, (repository) =>
      repository.findOne({
        where: {
          user_id: userId,
          token_hash: tokenHash,
          is_active: true,
          expires_at: MoreThan(new Date()),
        },
      }),
    );
  }

  private async revokePersistedSessions(
    userId: string,
    companyId: string,
    tokenHashes: string[],
  ): Promise<void> {
    if (!tokenHashes.length) {
      return;
    }

    await this.withUserSessionTenantContext(companyId, async (repository) => {
      await repository.update(
        {
          user_id: userId,
          token_hash: In(tokenHashes),
          is_active: true,
        },
        {
          is_active: false,
          revoked_at: new Date(),
        },
      );
    });
  }

  private async revokePersistedSession(
    userId: string,
    companyId: string,
    tokenHash: string,
  ): Promise<void> {
    await this.withUserSessionTenantContext(companyId, async (repository) => {
      await repository.update(
        {
          user_id: userId,
          token_hash: tokenHash,
          is_active: true,
        },
        {
          is_active: false,
          revoked_at: new Date(),
        },
      );
    });
  }

  private async withUserSessionTenantContext<T>(
    companyId: string,
    operation: (repository: Repository<UserSession>) => Promise<T>,
  ): Promise<T> {
    const normalizedCompanyId = this.normalizeSessionCompanyId(companyId);
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(
        `SELECT set_config('app.current_company_id', $1, true)`,
        [normalizedCompanyId],
      );
      await queryRunner.query(
        `SELECT set_config('app.is_super_admin', $1, true)`,
        ['false'],
      );
      const result = await operation(
        queryRunner.manager.getRepository(UserSession),
      );
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private getRefreshBindingMode(): 'none' | 'ua' {
    const mode = String(process.env.REFRESH_BINDING || 'none').toLowerCase();
    return mode === 'ua' ? 'ua' : 'none';
  }

  private getLocalJwtSignOptions(): ReturnType<typeof getJwtSignOptions> {
    return getJwtSignOptions(this.configService);
  }

  private getLocalJwtVerifyOptions(): ReturnType<typeof getJwtVerifyOptions> {
    return getJwtVerifyOptions(this.configService);
  }

  private buildGraphiteEmailHtml(options: {
    eyebrow: string;
    title: string;
    paragraphs: string[];
    cta?: {
      label: string;
      href: string;
    };
    note?: string;
    footer?: string;
    tone?: 'neutral' | 'warning';
  }) {
    const tone = options.tone ?? 'neutral';
    const eyebrowStyles =
      tone === 'warning'
        ? 'display:inline-block;margin-bottom:16px;padding:6px 10px;border-radius:999px;background-color:#f4ede5;border:1px solid #dfd4c8;color:#9a5a00;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;'
        : 'display:inline-block;margin-bottom:16px;padding:6px 10px;border-radius:999px;background-color:#ece8e3;border:1px solid #d8d2cb;color:#3e3935;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;';
    const shellStyle =
      'font-family: Arial, sans-serif;color:#25221f;max-width:560px;margin:0 auto;padding:28px;background-color:#f6f5f3;border:1px solid #b7aea5;border-radius:18px;';
    const titleStyle = 'margin:0 0 12px;color:#25221f;';
    const bodyStyle = 'margin:0 0 12px;color:#5c5650;line-height:1.6;';
    const noteStyle = 'font-size:13px;color:#5c5650;line-height:1.6;';
    const footerStyle = 'font-size:11px;color:#77706a;';
    const ctaStyle =
      'background-color:#3e3935;color:#f6f5f3;padding:12px 28px;text-decoration:none;border-radius:12px;font-weight:700;display:inline-block;border:1px solid #2c2825;box-shadow:0 10px 20px rgba(44,40,37,0.14);';

    return `
      <div style="${shellStyle}">
        <div style="height:4px;margin-bottom:18px;border-radius:999px;background-color:#3e3935;"></div>
        <div style="${eyebrowStyles}">
          ${options.eyebrow}
        </div>
        <h2 style="${titleStyle}">${options.title}</h2>
        ${options.paragraphs
          .map((paragraph) => `<p style="${bodyStyle}">${paragraph}</p>`)
          .join('')}
        ${
          options.cta
            ? `<div style="margin:28px 0 22px;"><a href="${options.cta.href}" style="${ctaStyle}">${options.cta.label}</a></div>`
            : ''
        }
        ${
          options.note
            ? `<p style="${noteStyle}"><strong>Observação:</strong> ${options.note}</p>`
            : ''
        }
        <hr style="border:none;border-top:1px solid #d8d2cb;margin:24px 0;" />
        <p style="${footerStyle}">
          ${options.footer || this.buildOfficialFooter()}
        </p>
      </div>
    `;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async login(
    user: Pick<
      User,
      | 'id'
      | 'nome'
      | 'cpf'
      | 'funcao'
      | 'company_id'
      | 'site_id'
      | 'profile'
      | 'email'
      | 'must_change_password'
    > & { auth_user_id?: string | null },
    ctx?: { userAgent?: string; ip?: string },
    options?: { isAdminGeral?: boolean },
  ) {
    const companyId = this.normalizeSessionCompanyId(user.company_id);

    // Normaliza profile para { nome } explícito no JWT — elimina o union type
    // string | object que causava ambiguidade no middleware de autorização.
    // Apenas o campo `nome` é necessário; emitir a entidade inteira era excessivo.
    const profileNome =
      typeof user.profile === 'object' && user.profile !== null
        ? ((user.profile as { nome?: string }).nome ?? '')
        : '';
    const isAdminGeral =
      options?.isAdminGeral ?? profileNome === String(Role.ADMIN_GERAL);
    const jti = crypto.randomUUID();
    const payload = {
      sub: user.id,
      app_user_id: user.id,
      auth_uid: user.auth_user_id ?? undefined,
      company_id: companyId,
      site_id: user.site_id ?? undefined,
      profile: { nome: profileNome },
      isAdminGeral,
      jti,
    };
    const accessPayload = {
      ...payload,
      token_type: JWT_ACCESS_TOKEN_TYPE,
    };
    const refreshPayload = {
      ...payload,
      token_type: JWT_REFRESH_TOKEN_TYPE,
    };
    const accessTtl = getAccessTokenTtl();
    const localOpts = this.getLocalJwtSignOptions();

    // If the user must change password, emit a short-lived limited access token
    // that can only be used to call the password-change/reset endpoints. No
    // refresh token or persisted session is created in this case.
    if (user.must_change_password) {
      const forcedTtlSeconds =
        Number(process.env.FORCE_PASSWORD_CHANGE_TOKEN_TTL_SECONDS) || 600; // 10 minutes
      const limitedPayload = {
        ...accessPayload,
        force_password_change: true,
        scope: 'force_change',
      };
      const accessToken = isInfiniteTtl(forcedTtlSeconds)
        ? this.jwtService.sign(limitedPayload, { ...localOpts })
        : this.jwtService.sign(limitedPayload, {
            expiresIn: forcedTtlSeconds,
            ...localOpts,
          });

      return {
        accessToken,
        user: {
          id: user.id,
          nome: user.nome,
          funcao: user.funcao,
          company_id: companyId,
          site_id: user.site_id ?? null,
          profile: user.profile,
          must_change_password: true,
        },
      };
    }

    const refreshSecret = getRefreshTokenSecret(this.configService);
    const accessToken = isInfiniteTtl(accessTtl)
      ? this.jwtService.sign(accessPayload, { ...localOpts })
      : this.jwtService.sign(accessPayload, {
          expiresIn: accessTtl,
          ...localOpts,
        });
    const refreshToken = this.jwtService.sign(refreshPayload, {
      expiresIn: getRefreshTokenTtl(),
      secret: refreshSecret,
      ...localOpts,
    });
    const tokenHash = this.hashToken(refreshToken);
    const ttlSeconds = getRefreshTokenTtlDays() * 24 * 3600;
    const bindingMode = this.getRefreshBindingMode();
    const ua = ctx?.userAgent || '';
    const storedValue =
      bindingMode === 'ua' && ua
        ? JSON.stringify({ v: 1, ua: this.hashContext(ua) })
        : '1';
    try {
      await this.redisService.storeRefreshToken(
        user.id,
        tokenHash,
        ttlSeconds,
        storedValue,
      );

      // Enforce max active sessions per user — evict oldest if exceeded
      const maxSessions = getMaxActiveSessionsPerUser();
      const evicted = await this.redisService.enforceMaxSessions(
        user.id,
        maxSessions,
      );
      if (evicted.length > 0) {
        await this.revokePersistedSessions(user.id, companyId, evicted);
        this.logger.log({
          event: 'sessions_evicted',
          userId: user.id,
          evictedCount: evicted.length,
          maxSessions,
          reason: 'max_active_sessions_exceeded',
        });
      }
      await this.persistNewSession({
        userId: user.id,
        companyId,
        tokenHash,
        userAgent: ctx?.userAgent,
        ip: ctx?.ip,
      });
      // Fire-and-forget: anomaly detection nunca bloqueia o login
      void this.loginAnomalyService.checkAndAlert({
        userId: user.id,
        userName: user.nome,
        userEmail: user.email || '',
        currentIp: ctx?.ip || '',
        userAgent: ctx?.userAgent,
        companyId,
      });
    } catch (err) {
      this.logger.warn(
        `Falha ao registrar refresh token no Redis: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        nome: user.nome,
        funcao: user.funcao,
        company_id: companyId,
        site_id: user.site_id ?? null,
        profile: user.profile,
        must_change_password: user.must_change_password ? true : false,
      },
    };
  }

  async refresh(
    refreshToken: string,
    ctx?: { userAgent?: string; ip?: string },
  ) {
    let payload: JwtPayload;
    const refreshSecret = getRefreshTokenSecret(this.configService);
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: refreshSecret,
        ...this.getLocalJwtVerifyOptions(),
      });
      if (payload.token_type !== JWT_REFRESH_TOKEN_TYPE) {
        throw new UnauthorizedException(
          'Token de access não pode ser usado como refresh',
        );
      }
      assertJwtHasExpiration(payload);
    } catch {
      throw new UnauthorizedException('Refresh token inválido');
    }

    const payloadCompanyId = this.normalizeSessionCompanyId(payload.company_id);
    const currentContext =
      await this.authPrincipalService.resolveCurrentUserContext({
        appUserId: payload.app_user_id ?? payload.sub,
        authUserId: payload.auth_uid,
      });
    if (!currentContext?.companyId) {
      throw new UnauthorizedException(
        'Usuário inativo ou sem empresa vinculada',
      );
    }

    if (currentContext.companyId !== payloadCompanyId) {
      this.logger.warn({
        event: 'refresh_tenant_context_changed',
        userId: payload.sub,
        action: 'refresh_blocked',
      });
      throw new UnauthorizedException(
        'Sessão inválida após alteração de empresa',
      );
    }

    const isCurrentSuperAdmin = isSuperAdminProfileName(
      currentContext.profileName,
    );
    const normalizedCurrentProfile = normalizeRoleName(
      currentContext.profileName,
    );
    const isCompanyWideTenantProfile =
      normalizedCurrentProfile === Role.ADMIN_GERAL ||
      normalizedCurrentProfile === Role.ADMIN_EMPRESA;
    const companyId = this.normalizeSessionCompanyId(currentContext.companyId);
    return this.tenantService.run(
      {
        companyId,
        isSuperAdmin: isCurrentSuperAdmin,
        userId: payload.sub,
        siteId: currentContext.siteId,
        siteScope:
          isCurrentSuperAdmin || isCompanyWideTenantProfile ? 'all' : 'single',
      },
      () =>
        this.refreshInTenantContext(refreshToken, payload, ctx, {
          companyId,
          siteId: currentContext.siteId,
          profileName: currentContext.profileName,
          isSuperAdmin: isCurrentSuperAdmin,
        }),
    );
  }

  private async refreshInTenantContext(
    refreshToken: string,
    payload: JwtPayload,
    ctx?: { userAgent?: string; ip?: string },
    currentContext?: {
      companyId: string;
      siteId?: string;
      profileName?: string;
      isSuperAdmin: boolean;
    },
  ) {
    const refreshSecret = getRefreshTokenSecret(this.configService);
    const oldHash = this.hashToken(refreshToken);

    // Consume atômico: GET + DEL em uma única operação Lua no Redis.
    // Elimina a janela TOCTOU — duas requisições concorrentes com o mesmo token
    // só conseguem consumir o valor uma vez; a segunda recebe null e é rejeitada.
    let stored = await this.redisService.atomicConsumeRefreshToken(
      payload.sub,
      oldHash,
    );
    let recoveredFromPersistedSession = false;
    if (!stored) {
      // Reuse detection: if this token was already consumed (rotated), someone
      // is replaying an old token. This indicates possible session hijacking.
      // Revoke ALL tokens for this user as a defensive measure.
      const wasConsumed = await this.redisService.isTokenConsumed(
        payload.sub,
        oldHash,
      );
      if (wasConsumed) {
        this.logger.error({
          event: 'refresh_token_reuse_detected',
          userId: payload.sub,
          action: 'revoking_all_sessions',
          reason: 'Possible session hijacking — rotated refresh token replayed',
        });
        await this.redisService.clearAllRefreshTokens(payload.sub);
        this.securityAudit.tokenReuseDetected(
          payload.sub,
          ctx?.ip,
          ctx?.userAgent,
        );
      }

      if (!wasConsumed) {
        const persistedSession = await this.findActivePersistedSession(
          payload.sub,
          oldHash,
          this.normalizeSessionCompanyId(payload.company_id),
        );

        if (persistedSession) {
          stored = '1';
          recoveredFromPersistedSession = true;
          this.logger.warn({
            event: 'refresh_token_recovered_from_persisted_session',
            userId: payload.sub,
            reason: 'redis_refresh_token_missing_but_db_session_active',
          });
          // Write consumed tombstone so a concurrent replay of the same old
          // token correctly triggers reuse detection once Redis is reachable.
          // Best-effort: if Redis is still down the catch is silently dropped;
          // DB rotation (below) remains the primary invalidation path.
          try {
            await this.redisService.markRefreshTokenConsumed(
              payload.sub,
              oldHash,
            );
          } catch {
            // Redis unavailable — DB rotation will invalidate the old hash
          }
        }
      }

      if (!stored) {
        throw new UnauthorizedException(
          'Refresh token revogado ou já utilizado',
        );
      }
    }

    const bindingMode = this.getRefreshBindingMode();
    if (bindingMode === 'ua') {
      try {
        const parsed = JSON.parse(stored) as { ua?: string };
        const expectedUaHash = parsed?.ua;
        const actualUa = ctx?.userAgent || '';
        if (expectedUaHash && actualUa) {
          const actualHash = this.hashContext(actualUa);
          if (actualHash !== expectedUaHash) {
            throw new UnauthorizedException(
              'Sessão inválida (contexto divergente)',
            );
          }
        }
      } catch (e) {
        if (e instanceof UnauthorizedException) throw e;
      }
    }

    // Gera e registra o novo par de tokens.
    const companyId = this.normalizeSessionCompanyId(payload.company_id);
    // Re-resolve o contexto atual do usuário no banco (fonte da verdade).
    // Se o admin moveu o usuário para outra obra enquanto a sessão estava ativa
    // (ex.: obra X -> Y), o refresh re-emite o token com a obra NOVA — sem isso,
    // o site_id antigo do payload seria perpetuado por até 30 dias, mantendo o
    // usuário "preso" na obra antiga e gerando 401 por divergência de contexto.
    if (!currentContext) {
      throw new UnauthorizedException(
        'Contexto atual do usuário não resolvido',
      );
    }
    const newPayload = {
      sub: payload.sub,
      app_user_id: payload.app_user_id ?? payload.sub,
      auth_uid: payload.auth_uid,
      company_id: currentContext.companyId,
      site_id: currentContext.siteId ?? undefined,
      profile: currentContext.profileName
        ? { nome: currentContext.profileName }
        : undefined,
      isAdminGeral: currentContext.isSuperAdmin,
      jti: crypto.randomUUID(),
    };
    const newAccessPayload = {
      ...newPayload,
      token_type: JWT_ACCESS_TOKEN_TYPE,
    };
    const newRefreshPayload = {
      ...newPayload,
      token_type: JWT_REFRESH_TOKEN_TYPE,
    };
    const accessTtl = getAccessTokenTtl();
    const localOpts = this.getLocalJwtSignOptions();
    const accessToken = isInfiniteTtl(accessTtl)
      ? this.jwtService.sign(newAccessPayload, { ...localOpts })
      : this.jwtService.sign(newAccessPayload, {
          expiresIn: accessTtl,
          ...localOpts,
        });
    const newRefreshToken = this.jwtService.sign(newRefreshPayload, {
      expiresIn: getRefreshTokenTtl(),
      secret: refreshSecret,
      ...localOpts,
    });
    const newHash = this.hashToken(newRefreshToken);
    const ttlSeconds = getRefreshTokenTtlDays() * 24 * 3600;
    const ua = ctx?.userAgent || '';
    const storedValue =
      bindingMode === 'ua' && ua
        ? JSON.stringify({ v: 1, ua: this.hashContext(ua) })
        : '1';
    await this.redisService.storeRefreshToken(
      payload.sub,
      newHash,
      ttlSeconds,
      storedValue,
    );
    await this.rotatePersistedSession({
      userId: payload.sub,
      companyId,
      previousTokenHash: oldHash,
      nextTokenHash: newHash,
      userAgent: ctx?.userAgent,
      ip: ctx?.ip,
      insertIfMissing: !recoveredFromPersistedSession,
    });
    this.securityAudit.tokenRefresh(payload.sub, ctx?.ip);
    return {
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const validation = this.passwordService.validate(newPassword);
    if (!validation.valid) {
      throw new BadRequestException(
        `A nova senha não atende aos critérios de segurança: ${validation.errors.join(
          ', ',
        )}`,
      );
    }

    await this.pwnedPasswordService.assertNotPwned(newPassword);

    const isMatch = await this.verifyUserPassword(userId, currentPassword);
    if (!isMatch) {
      throw new UnauthorizedException('Senha atual inválida');
    }

    await this.usersService.update(userId, {
      password: newPassword,
      must_change_password: false,
    });

    // Rotation: ao trocar a senha, todos os refresh tokens do usuário são
    // invalidados. O usuário precisará fazer login novamente em todos os
    // dispositivos — comportamento de segurança esperado.
    await this.redisService.clearAllRefreshTokens(userId);
    const userForRevocation =
      await this.usersService.findOneWithPassword(userId);
    if (userForRevocation?.company_id) {
      await this.withUserSessionTenantContext(
        userForRevocation.company_id,
        (repo) =>
          repo.update(
            { user_id: userId, is_active: true },
            { is_active: false, revoked_at: new Date() },
          ),
      );
    } else {
      await this.userSessionRepository.update(
        { user_id: userId, is_active: true },
        { is_active: false, revoked_at: new Date() },
      );
    }
    this.securityAudit.passwordChanged(userId);

    return { message: 'Senha atualizada com sucesso' };
  }

  async logout(refreshToken: string, accessToken?: string) {
    // 1. Revogar o refresh token no Redis.
    const refreshSecret = getRefreshTokenSecret(this.configService);
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        refreshToken,
        {
          secret: refreshSecret,
          ...this.getLocalJwtVerifyOptions(),
        },
      );
      if (payload.token_type !== JWT_REFRESH_TOKEN_TYPE) {
        throw new UnauthorizedException(
          'Token de access não pode ser revogado como refresh',
        );
      }
      assertJwtHasExpiration(payload);
      const tokenHash = this.hashToken(refreshToken);
      await this.redisService.revokeRefreshToken(payload.sub, tokenHash);
      await this.revokePersistedSession(
        payload.sub,
        this.normalizeSessionCompanyId(payload.company_id),
        tokenHash,
      );
    } catch {
      // Refresh token inválido ou expirado — continuar para revogar o access token.
    }

    // 2. Adicionar o access token à blacklist pelo seu jti.
    // TTL = tempo restante do token, para não acumular entradas expiradas no Redis.
    if (accessToken) {
      try {
        const decoded = await this.jwtService.verifyAsync<JwtPayload>(
          accessToken,
          {
            secret: resolveAccessTokenSecret(this.configService),
            ...this.getLocalJwtVerifyOptions(),
          },
        );
        if (decoded?.token_type !== JWT_ACCESS_TOKEN_TYPE) {
          throw new UnauthorizedException(
            'Token de refresh não pode ser usado como access',
          );
        }
        assertJwtHasExpiration(decoded);
        if (decoded?.jti) {
          const remainingTtl = decoded.exp
            ? Math.max(0, decoded.exp - Math.floor(Date.now() / 1000))
            : 900; // fallback: 15min em segundos
          if (remainingTtl > 0) {
            await this.tokenRevocationService.revoke(decoded.jti, remainingTtl);
          }
        }
      } catch {
        // Token malformado — ignorar silenciosamente.
      }
    }

    return { success: true };
  }

  async forgotPassword(
    cpf: string,
    context?: ForgotPasswordContext,
  ): Promise<{ message: string }> {
    const startedAtMs = Date.now();
    const targetDurationMs = this.buildForgotPasswordTargetDurationMs();
    const normalizedCpf = CpfUtil.normalize(cpf);
    const sourceIp = this.normalizeForgotPasswordIp(context?.ip);
    const requestHash = this.hashContext(`${normalizedCpf}:${sourceIp}`).slice(
      0,
      16,
    );
    const successMsg =
      'Se o CPF estiver cadastrado, você receberá um e-mail com instruções para redefinir sua senha.';

    let rateLimited: boolean;
    let retryAfterSeconds = 0;

    try {
      try {
        const rateLimitResult = await this.consumeForgotPasswordRateLimit(
          sourceIp,
          normalizedCpf,
        );
        rateLimited = rateLimitResult.limited;
        retryAfterSeconds = rateLimitResult.retryAfterSeconds;
      } catch (err) {
        // Fail-closed: se o storage de rate-limit falhar, bloqueia o fluxo.
        rateLimited = true;
        this.logger.error({
          event: 'forgot_password_rate_limit_storage_error',
          requestHash,
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      // Busca o usuário sem contexto de tenant (rota pública) através da mesma
      // função SECURITY DEFINER que o login usa.
      //
      // Antes daqui saía uma CTE com `set_config('app.is_super_admin','true')`,
      // que virou letra morta na migration 361 — `is_super_admin()` passou a
      // exigir membership em `sgs_rls_bypass`, e `sgs_app` não tem mais. A RLS
      // de `users` devolvia 0 linhas, `canIssueRealToken` ficava false e o
      // e-mail de redefinição nunca era enviado. Como a resposta ao usuário é
      // genérica por antienumeração, a falha era invisível dos dois lados.
      const cpfHash = hashSensitiveValue(normalizedCpf);
      const legacyPlaintextLookupEnabled = isLegacyCpfPlaintextLookupEnabled();
      const userRows = (await this.dataSource.query(
        `SELECT id, email, nome, status FROM find_login_user($1, $2)`,
        [cpfHash, legacyPlaintextLookupEnabled ? normalizedCpf : null],
      )) as unknown;
      const user =
        Array.isArray(userRows) && userRows.length > 0
          ? (userRows[0] as Pick<User, 'id' | 'email' | 'nome' | 'status'>)
          : null;

      const canIssueRealToken = Boolean(
        user && user.status !== false && user.email && !rateLimited,
      );
      const token = crypto.randomBytes(32).toString('hex');
      const issuedAtMs = Date.now();
      const expiresAtMs = issuedAtMs + RESET_TOKEN_TTL_SECONDS * 1000;
      const syntheticUserId = `suppressed:${this.hashContext(
        `${normalizedCpf}:${issuedAtMs}`,
      ).slice(0, 24)}`;
      const redisKey = canIssueRealToken
        ? `reset_password:${token}`
        : `reset_password_suppressed:${this.hashContext(token).slice(0, 32)}`;
      const redisTtlSeconds = canIssueRealToken ? RESET_TOKEN_TTL_SECONDS : 30;
      await this.redisService.getClient().setex(
        redisKey,
        redisTtlSeconds,
        JSON.stringify({
          userId: canIssueRealToken ? user!.id : syntheticUserId,
          issuedAtMs,
          expiresAtMs,
          v: 1,
          suppressed: canIssueRealToken ? 0 : 1,
        }),
      );

      // Token no hash fragment: nunca chega ao servidor em logs de acesso.
      const resetUrl = `${this.resolvePasswordResetBaseUrl()}/auth/reset-password#token=${token}`;
      const html = this.buildGraphiteEmailHtml({
        eyebrow: 'Ação necessária',
        title: 'Redefinição de senha',
        paragraphs: [
          `Olá, <strong>${this.escapeHtml(user?.nome || 'usuário')}</strong>.`,
          'Recebemos uma solicitação para redefinir a senha da sua conta. Use o botão abaixo para continuar.',
        ],
        cta: {
          label: 'Redefinir senha',
          href: resetUrl,
        },
        note: 'Este link é válido por 1 hora. Caso não tenha solicitado, ignore este e-mail; sua senha permanece inalterada.',
        footer: this.buildOfficialFooter('Central de suporte'),
      });

      if (canIssueRealToken) {
        const targetEmail = String(user!.email);
        void this.mailService
          .sendMailSimple(
            targetEmail,
            'Redefinição de senha — SGS',
            `Acesse o link para redefinir sua senha: ${resetUrl}`,
            { userId: user!.id },
            undefined,
            { html, filename: 'password-reset' },
          )
          .catch((err) => {
            this.logger.warn({
              event: 'forgot_password_email_delivery_error',
              requestHash,
              reason: err instanceof Error ? err.message : String(err),
            });
          });
      } else {
        // Trabalho sintético para manter fluxo uniforme sem disparar e-mail real.
        this.hashContext(`${requestHash}:${resetUrl}`);
      }

      if (rateLimited) {
        this.logger.warn({
          event: 'forgot_password_rate_limited',
          requestHash,
          retryAfterSeconds,
        });
      }
    } finally {
      await this.ensureMinimumProcessingTime(startedAtMs, targetDurationMs);
      this.logger.log({
        event: 'forgot_password_processed',
        requestHash,
        durationMs: Date.now() - startedAtMs,
      });
    }

    if (rateLimited) {
      throw new HttpException(
        'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return { message: successMsg };
  }

  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const tokenHashPrefix = this.hashToken(token).slice(0, 16);
    const consumeResult = await this.consumeResetTokenAtomically(token);

    if (consumeResult.status === 'RATE_LIMITED') {
      this.logger.warn({
        event: 'reset_password_rate_limited',
        tokenHashPrefix,
        attempts: consumeResult.attempts,
        retryAfterSeconds: consumeResult.retryAfterSeconds ?? null,
      });
      throw new HttpException(
        'Muitas tentativas com este token. Aguarde e tente novamente.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (consumeResult.status === 'REUSED') {
      this.logger.warn({
        event: 'reset_password_token_reuse_detected',
        tokenHashPrefix,
        attempts: consumeResult.attempts,
      });
    }

    if (consumeResult.status !== 'CONSUMED' || !consumeResult.userId) {
      throw new BadRequestException(
        'Token inválido ou expirado. Solicite um novo link de redefinição.',
      );
    }
    const userId = consumeResult.userId;

    const validation = this.passwordService.validate(newPassword);
    if (!validation.valid) {
      throw new BadRequestException(
        `A nova senha não atende aos critérios de segurança: ${validation.errors.join(', ')}`,
      );
    }

    await this.pwnedPasswordService.assertNotPwned(newPassword);

    const hashedPassword = await this.passwordService.hash(newPassword);

    // Grava por função SECURITY DEFINER, pela mesma razão do lookup em
    // forgotPassword: esta rota é pública e não tem tenant, e a flag de sessão
    // deixou de conceder bypass na migration 361. O `UPDATE users` que havia
    // aqui era descartado pela RLS com 0 linhas afetadas — sem erro. O fluxo
    // seguia, invalidava os refresh tokens e respondia "senha alterada", com a
    // senha antiga intacta.
    const resetRows = await this.dataSource.query<
      Array<{ user_id: string; company_id: string | null }>
    >(`SELECT user_id, company_id FROM reset_login_user_password($1, $2)`, [
      userId,
      hashedPassword,
    ]);

    // Zero linhas = nada foi atualizado (usuário inexistente ou já excluído).
    // Falhar alto: responder sucesso sem ter trocado a senha é exatamente o
    // defeito que esta mudança corrige.
    if (!resetRows?.length) {
      this.logger.error({
        event: 'reset_password_no_row_updated',
        tokenHashPrefix,
      });
      throw new BadRequestException(
        'Não foi possível redefinir a senha. Solicite um novo link de redefinição.',
      );
    }
    const resetUserCompanyId = resetRows[0].company_id;

    // Token invalidado com marcação NX + timestamp de consumo para bloquear replay concorrente.

    // Invalida todos os refresh tokens — o usuário precisará fazer login novamente
    await this.redisService.clearAllRefreshTokens(userId);
    if (resetUserCompanyId) {
      await this.withUserSessionTenantContext(resetUserCompanyId, (repo) =>
        repo.update(
          { user_id: userId, is_active: true },
          { is_active: false, revoked_at: new Date() },
        ),
      );
    } else {
      await this.userSessionRepository.update(
        { user_id: userId, is_active: true },
        { is_active: false, revoked_at: new Date() },
      );
    }

    this.logger.log({ event: 'password_reset', userId });
    this.securityAudit.passwordReset(userId);
    return {
      message: 'Senha redefinida com sucesso. Faça login com a nova senha.',
    };
  }
}
