import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import {
  randomBytes,
  pbkdf2Sync,
  createHmac,
  randomUUID,
  randomInt,
} from 'crypto';
import { Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, DeepPartial } from 'typeorm';
import { plainToClass } from 'class-transformer';
import { User } from './entities/user.entity';
import { UserSite } from './entities/user-site.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import { PasswordService } from '../../shared/services/password.service';
import { PwnedPasswordService } from '../auth/services/pwned-password.service';
import { MailService } from '../../infra/mail/mail.service';
import { CpfUtil } from '../../shared/utils/cpf.util';
import { USER_WITH_PASSWORD_FIELDS } from './constants/user-fields.constant';
import { UserResponseDto } from './dto/user-response.dto';
import { ExportMyDataResponseDto } from './dto/export-my-data-response.dto';
import { AuditService } from '../audit-trail/audit.service';
import { AuditAction } from '../audit-trail/enums/audit-action.enum';
import { AuditLog } from '../audit-trail/entities/audit-log.entity';
import { RequestContext } from '../../shared/middleware/request-context.middleware';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { Profile } from '../profiles/entities/profile.entity';
import { Site } from '../sites/entities/site.entity';
import { Role } from '../auth/enums/roles.enum';
import { normalizeRoleName } from '../auth/role-normalization.util';
import { RbacService, type RoleScope } from '../rbac/rbac.service';
import { AuthRedisService } from '../../shared/redis/redis.service';
import { AuthPrincipalService } from '../auth/auth-principal.service';
import { resolvePasswordResetBaseUrl } from '../../shared/utils/password-reset-url.util';
import { escapeLikePattern } from '../../shared/utils/sql.util';
import { normalizeOptionalSearchQuery } from '../../shared/utils/query-normalization.util';
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  hashSensitiveValue,
} from '../../shared/security/field-encryption.util';
import { isLegacyCpfPlaintextLookupEnabled } from '../privacy/cpf-plaintext-migration.util';
import {
  UserAccessStatus,
  UserIdentityType,
} from './constants/user-identity.constant';
import {
  normalizeUserModuleAccessKeys,
  USER_MODULE_ACCESS_OPTIONS,
} from './user-module-access.config';

type ExportConsentRow = {
  type: string;
  version_label: string;
  body_hash: string;
  accepted_at: Date | string | null;
  revoked_at: Date | string | null;
  migrated_from_legacy: boolean;
  created_at: Date | string;
};

type ExportCountRow = {
  count: string | number | bigint;
};

type ExportProcessingArea = {
  area: string;
  description: string;
  count: number;
  likelyLegalBasis: string;
  sensitivity: string;
};

type ExportCountQuery = Omit<ExportProcessingArea, 'count'> & {
  sql: string;
  params: string[];
};

type GdprErasureCoverageRow = {
  table_name: string;
  deleted_count: string | number | bigint;
};

const DATA_PORTABILITY_LIMITATIONS = [
  {
    area: 'documentos_sst',
    reason:
      'Documentos de SST podem conter dados de terceiros, dados empresariais e obrigações legais do Cliente controlador; a entrega integral exige validação operacional antes da liberação.',
  },
  {
    area: 'arquivos_e_backups',
    reason:
      'Arquivos em storage e backups não são anexados automaticamente nesta exportação; devem ser tratados por fluxo de requisição autenticada e validação de retenção legal.',
  },
  {
    area: 'logs_de_seguranca',
    reason:
      'Logs podem conter dados de outros usuários, segredos operacionais e evidências de segurança; a exportação automática retorna inventário, não payload bruto.',
  },
] as const;

const ROLE_ADMIN_EMPRESA = Role.ADMIN_EMPRESA as string;
const ROLE_TST = Role.TST as string;
const ROLE_SUPERVISOR = Role.SUPERVISOR as string;
const ROLE_COLABORADOR = Role.COLABORADOR as string;
const ROLE_TRABALHADOR = Role.TRABALHADOR as string;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserSite)
    private userSitesRepository: Repository<UserSite>,
    @InjectRepository(Profile)
    private profilesRepository: Repository<Profile>,
    private tenantService: TenantService,
    private passwordService: PasswordService,
    private pwnedPasswordService: PwnedPasswordService,
    private auditService: AuditService,
    private rbacService: RbacService,
    private redisService: AuthRedisService,
    private configService: ConfigService,
    private readonly authPrincipalService: AuthPrincipalService,
    @Inject(forwardRef(() => MailService))
    private readonly mailService?: MailService,
  ) {}

  private getTenantIdOrThrow(message?: string): string {
    const tenantId = this.tenantService.getTenantId();
    if (!tenantId) {
      throw new UnauthorizedException(
        message ||
          'Contexto de empresa não identificado para operação de usuários.',
      );
    }
    return tenantId;
  }

  private buildCpfSecurityPayload(cpf?: string | null): {
    cpf: string | null;
    cpf_hash: string | null;
    cpf_ciphertext: string | null;
  } {
    if (!cpf) {
      return { cpf: null, cpf_hash: null, cpf_ciphertext: null };
    }

    const normalizedCpf = CpfUtil.normalize(cpf);
    return {
      // Novo write path: não persiste CPF em texto plano.
      cpf: null,
      cpf_hash: hashSensitiveValue(normalizedCpf),
      cpf_ciphertext: encryptSensitiveValue(normalizedCpf),
    };
  }

  private resolveUserCpf(input: {
    cpf?: string | null;
    cpf_ciphertext?: string | null;
  }): string | null {
    if (input.cpf_ciphertext) {
      return decryptSensitiveValue(input.cpf_ciphertext);
    }
    return input.cpf ?? null;
  }

  private toIsoStringOrNull(value: Date | string | null): string | null {
    if (!value) {
      return null;
    }
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  private toCount(value: string | number | bigint | undefined): number {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  private hasCredential(input: {
    password?: string | null;
    authUserId?: string | null;
  }): boolean {
    return Boolean(
      (typeof input.password === 'string' && input.password.trim()) ||
      (typeof input.authUserId === 'string' && input.authUserId.trim()),
    );
  }

  private normalizeIdentityType(value: unknown): UserIdentityType | undefined {
    return value === UserIdentityType.SYSTEM_USER ||
      value === UserIdentityType.EMPLOYEE_SIGNER
      ? value
      : undefined;
  }

  private resolveIdentityType(input: {
    requested?: unknown;
    current?: UserIdentityType | null;
    password?: string | null;
    authUserId?: string | null;
    email?: string | null;
  }): UserIdentityType {
    const requested = this.normalizeIdentityType(input.requested);
    if (requested) {
      return requested;
    }

    if (input.current) {
      return input.current;
    }

    if (
      this.hasCredential(input) ||
      (typeof input.email === 'string' && input.email.trim())
    ) {
      return UserIdentityType.SYSTEM_USER;
    }

    return UserIdentityType.EMPLOYEE_SIGNER;
  }

  private normalizeModuleAccessKeys(input: unknown): string[] {
    return normalizeUserModuleAccessKeys(input);
  }

  private resolveAccessStatus(input: {
    identityType: UserIdentityType;
    password?: string | null;
    authUserId?: string | null;
    email?: string | null;
  }): UserAccessStatus {
    if (this.hasCredential(input)) {
      return UserAccessStatus.CREDENTIALED;
    }

    if (input.identityType === UserIdentityType.EMPLOYEE_SIGNER) {
      return UserAccessStatus.NO_LOGIN;
    }

    return UserAccessStatus.MISSING_CREDENTIALS;
  }

  private assertIdentityCredentialContract(input: {
    identityType: UserIdentityType;
    password?: string | null;
    authUserId?: string | null;
  }): void {
    if (
      input.identityType === UserIdentityType.EMPLOYEE_SIGNER &&
      this.hasCredential(input)
    ) {
      throw new BadRequestException(
        'Funcionário/signatário sem login não pode manter credenciais de acesso. Use um fluxo dedicado para remover credenciais antes de alterar a classificação.',
      );
    }
  }

  private async countDataPortabilityRows(
    sql: string,
    params: string[],
  ): Promise<number> {
    const rows = await this.usersRepository.manager.query<ExportCountRow[]>(
      sql,
      params,
    );
    return this.toCount(rows[0]?.count);
  }

  private async getConsentExportEvents(userId: string, tenantId: string) {
    const rows = await this.usersRepository.manager.query<ExportConsentRow[]>(
      `
        SELECT
          uc.type,
          cv.version_label,
          cv.body_hash,
          uc.accepted_at,
          uc.revoked_at,
          uc.migrated_from_legacy,
          uc.created_at
        FROM user_consents uc
        INNER JOIN consent_versions cv ON cv.id = uc.version_id
        WHERE uc.user_id = $1
          AND uc.company_id = $2
        ORDER BY uc.created_at DESC
      `,
      [userId, tenantId],
    );

    return rows.map((row) => ({
      type: row.type,
      versionLabel: row.version_label,
      bodyHash: row.body_hash,
      acceptedAt: this.toIsoStringOrNull(row.accepted_at),
      revokedAt: this.toIsoStringOrNull(row.revoked_at),
      migratedFromLegacy: Boolean(row.migrated_from_legacy),
      recordedAt:
        this.toIsoStringOrNull(row.created_at) || new Date(0).toISOString(),
    }));
  }

  private buildDataPortabilityCountQueries(
    userId: string,
    tenantId: string,
  ): ExportCountQuery[] {
    return [
      {
        area: 'medical_exams',
        description: 'Exames médicos ocupacionais vinculados ao titular.',
        likelyLegalBasis: 'obrigacao_legal_ou_execucao_contrato',
        sensitivity: 'sensivel_saude_ocupacional',
        sql: 'SELECT COUNT(*)::int AS count FROM medical_exams WHERE user_id = $1 AND company_id = $2',
        params: [userId, tenantId],
      },
      {
        area: 'trainings',
        description: 'Treinamentos e capacitações vinculados ao titular.',
        likelyLegalBasis: 'obrigacao_legal_ou_execucao_contrato',
        sensitivity: 'ocupacional',
        sql: 'SELECT COUNT(*)::int AS count FROM trainings WHERE user_id = $1 AND company_id = $2',
        params: [userId, tenantId],
      },
      {
        area: 'epi_assignments',
        description: 'Fichas e entregas de EPI relacionadas ao titular.',
        likelyLegalBasis: 'obrigacao_legal_ou_execucao_contrato',
        sensitivity: 'ocupacional',
        sql: `
          SELECT COUNT(*)::int AS count
          FROM epi_assignments
          WHERE company_id = $2
            AND (user_id = $1 OR signer_user_id = $1 OR created_by_id = $1)
        `,
        params: [userId, tenantId],
      },
      {
        area: 'cats',
        description: 'Comunicações de acidente vinculadas ao titular.',
        likelyLegalBasis: 'obrigacao_legal',
        sensitivity: 'sensivel_saude_ocupacional',
        sql: 'SELECT COUNT(*)::int AS count FROM cats WHERE worker_id = $1 AND company_id = $2',
        params: [userId, tenantId],
      },
      {
        area: 'signatures',
        description:
          'Assinaturas digitais/eletrônicas realizadas pelo titular.',
        likelyLegalBasis: 'execucao_contrato_ou_obrigacao_legal',
        sensitivity: 'identificador_assinatura',
        sql: 'SELECT COUNT(*)::int AS count FROM signatures WHERE user_id = $1 AND company_id = $2',
        params: [userId, tenantId],
      },
      {
        area: 'ai_interactions',
        description: 'Interações de IA associadas ao titular.',
        likelyLegalBasis: 'consentimento_ou_execucao_contrato',
        sensitivity: 'potencialmente_sensivel',
        sql: 'SELECT COUNT(*)::int AS count FROM ai_interactions WHERE user_id = $1 AND company_id = $2 AND deleted_at IS NULL',
        params: [userId, tenantId],
      },
      {
        area: 'document_registry',
        description:
          'Documentos governados criados ou registrados pelo titular.',
        likelyLegalBasis: 'execucao_contrato_ou_obrigacao_legal',
        sensitivity: 'documental_ocupacional',
        sql: 'SELECT COUNT(*)::int AS count FROM document_registry WHERE created_by = $1 AND company_id = $2 AND deleted_at IS NULL',
        params: [userId, tenantId],
      },
      {
        area: 'apr_participation',
        description:
          'APRs em que o titular consta como participante ou aprovador.',
        likelyLegalBasis: 'obrigacao_legal_ou_execucao_contrato',
        sensitivity: 'ocupacional',
        sql: `
          SELECT COUNT(DISTINCT apr.id)::int AS count
          FROM aprs apr
          LEFT JOIN apr_participants participant ON participant.apr_id = apr.id
          WHERE apr.company_id = $2
            AND (apr.aprovado_por_id = $1 OR participant.user_id = $1)
        `,
        params: [userId, tenantId],
      },
      {
        area: 'pt_participation',
        description:
          'PTs em que o titular consta como responsável, executante ou aprovador.',
        likelyLegalBasis: 'obrigacao_legal_ou_execucao_contrato',
        sensitivity: 'ocupacional',
        sql: `
          SELECT COUNT(DISTINCT pt.id)::int AS count
          FROM pts pt
          LEFT JOIN pt_executantes executante ON executante.pt_id = pt.id
          WHERE pt.company_id = $2
            AND (
              pt.responsavel_id = $1
              OR pt.aprovado_por_id = $1
              OR executante.user_id = $1
            )
        `,
        params: [userId, tenantId],
      },
      {
        area: 'dds_participation',
        description:
          'DDSs em que o titular consta como participante ou emissor.',
        likelyLegalBasis: 'obrigacao_legal_ou_execucao_contrato',
        sensitivity: 'ocupacional',
        sql: `
          SELECT COUNT(DISTINCT dds.id)::int AS count
          FROM dds dds
          LEFT JOIN dds_participants participant ON participant.dds_id = dds.id
          WHERE dds.company_id = $2
            AND (dds.emitted_by_user_id = $1 OR participant.user_id = $1)
        `,
        params: [userId, tenantId],
      },
      {
        area: 'audit_and_security_logs',
        description:
          'Logs de auditoria, segurança e rastreabilidade associados ao titular.',
        likelyLegalBasis: 'legitimo_interesse_ou_obrigacao_legal',
        sensitivity: 'seguranca_operacional',
        sql: `
          SELECT (
            (SELECT COUNT(*) FROM audit_logs WHERE user_id = $1 AND company_id = $2) +
            (SELECT COUNT(*) FROM forensic_trail_events WHERE user_id = $1 AND company_id = $2)
          )::int AS count
        `,
        params: [userId, tenantId],
      },
      {
        area: 'mail_logs',
        description:
          'Registros de e-mails transacionais associados ao titular.',
        likelyLegalBasis: 'execucao_contrato_ou_legitimo_interesse',
        sensitivity: 'contato_comunicacao',
        sql: 'SELECT COUNT(*)::int AS count FROM mail_logs WHERE user_id = $1 AND company_id = $2 AND deleted_at IS NULL',
        params: [userId, tenantId],
      },
      {
        area: 'activities',
        description: 'Atividades operacionais associadas ao titular.',
        likelyLegalBasis: 'execucao_contrato',
        sensitivity: 'operacional',
        sql: 'SELECT COUNT(*)::int AS count FROM activities WHERE user_id = $1 AND company_id = $2 AND deleted_at IS NULL',
        params: [userId, tenantId],
      },
    ];
  }

  private async buildDataPortabilitySummary(
    userId: string,
    tenantId: string,
  ): Promise<ExportProcessingArea[]> {
    const queries = this.buildDataPortabilityCountQueries(userId, tenantId);
    return Promise.all(
      queries.map(async (query) => ({
        area: query.area,
        description: query.description,
        likelyLegalBasis: query.likelyLegalBasis,
        sensitivity: query.sensitivity,
        count: await this.countDataPortabilityRows(query.sql, query.params),
      })),
    );
  }

  private generateTemporaryPassword(): string {
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const specials = '!@#$%^&*()-_=+[]{}<>?';
    const all = upper + lower + digits + specials;
    const passwordChars = [
      upper[randomInt(upper.length)],
      lower[randomInt(lower.length)],
      digits[randomInt(digits.length)],
      specials[randomInt(specials.length)],
    ];

    while (passwordChars.length < 12) {
      passwordChars.push(all[randomInt(all.length)]);
    }

    for (let index = passwordChars.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(index + 1);
      [passwordChars[index], passwordChars[swapIndex]] = [
        passwordChars[swapIndex],
        passwordChars[index],
      ];
    }

    return passwordChars.join('');
  }

  async create(createUserData: DeepPartial<User>): Promise<UserResponseDto> {
    const {
      password,
      identity_type: requestedIdentityType,
      access_status: _ignoredAccessStatus,
      module_access_keys: _ignoredModuleAccessKeys,
      site_ids: requestedSiteIdsRaw,
      ...rest
    } = createUserData as DeepPartial<User> & { site_ids?: string[] };
    const tenantId = this.tenantService.getTenantId();
    const isSuperAdmin = this.tenantService.isSuperAdmin();

    // Defesa em profundidade: não confiar em company_id vindo do body.
    if (
      !isSuperAdmin &&
      rest.company_id &&
      tenantId &&
      rest.company_id !== tenantId
    ) {
      this.logger.warn({
        event: 'cross_tenant_attempt',
        action: 'users.create',
        actorId: RequestContext.getUserId(),
        tenantId,
        requestedCompanyId: rest.company_id,
      });
      throw new ForbiddenException(
        'Não é permitido criar usuário em outra empresa.',
      );
    }

    const companyId = isSuperAdmin ? rest.company_id || tenantId : tenantId;

    if (!companyId) {
      throw new BadRequestException('Empresa é obrigatória');
    }
    let requestedProfileName: string | undefined;
    const requestedSiteIds = this.normalizeUserSiteIds(
      requestedSiteIdsRaw,
      typeof rest.site_id === 'string' ? rest.site_id : undefined,
    );
    await this.assertSitesBelongToCompany(requestedSiteIds, companyId);
    rest.site_id = requestedSiteIds[0] ?? null;

    // Broken Function Level Auth / Privilege Escalation:
    // apenas ADMIN_GERAL pode atribuir perfil "Administrador Geral".
    if (rest.profile_id) {
      const profile = await this.profilesRepository.findOne({
        where: { id: rest.profile_id },
        select: { id: true, nome: true },
      });
      requestedProfileName = profile?.nome;
      if (
        profile &&
        normalizeRoleName(profile.nome) === Role.ADMIN_GERAL &&
        !isSuperAdmin
      ) {
        this.logger.warn({
          event: 'role_change_denied',
          action: 'users.create',
          actorId: RequestContext.getUserId(),
          targetCompanyId: companyId,
          requestedProfile: profile.nome,
        });
        throw new ForbiddenException(
          'Atribuição de perfil Administrador Geral não é permitida.',
        );
      }
      if (!isSuperAdmin && profile) {
        const actorUserId = RequestContext.getUserId();
        if (actorUserId) {
          await this.enforceRoleAssignmentPolicy(actorUserId, profile.nome);
        }
      }
    }
    const normalizedCpf = CpfUtil.normalize(rest.cpf as string);
    const cpfHash = hashSensitiveValue(normalizedCpf);
    const legacyPlaintextLookupEnabled = isLegacyCpfPlaintextLookupEnabled();

    const existingUser = await this.usersRepository.findOne({
      where: legacyPlaintextLookupEnabled
        ? [{ cpf_hash: cpfHash }, { cpf: normalizedCpf }]
        : { cpf_hash: cpfHash },
      select: { id: true },
    });
    if (existingUser) {
      throw new ConflictException('CPF já cadastrado neste sistema.');
    }

    if (typeof rest.email === 'string' && rest.email) {
      const emailConflict = await this.usersRepository.findOne({
        where: { email: rest.email, company_id: companyId },
        select: { id: true },
      });
      if (emailConflict) {
        throw new ConflictException('Email já está em uso nesta empresa.');
      }
    }

    let hashedPassword = '';
    let plainTempPassword: string | undefined = undefined;
    if (password && typeof password === 'string') {
      const validation = this.passwordService.validate(password);
      if (!validation.valid) {
        throw new BadRequestException(
          `A senha não atende aos critérios de segurança: ${validation.errors.join(', ')}`,
        );
      }
      await this.pwnedPasswordService.assertNotPwned(password);
      hashedPassword = await this.passwordService.hash(password);
    } else if (typeof rest.email === 'string' && rest.email.trim()) {
      // Gera senha temporária que atende à política e não está pwned
      let attempts = 0;
      while (!plainTempPassword && attempts < 5) {
        attempts += 1;
        const candidate = this.generateTemporaryPassword();
        const validation = this.passwordService.validate(candidate);
        if (!validation.valid) continue;
        try {
          await this.pwnedPasswordService.assertNotPwned(candidate);
        } catch {
          continue;
        }
        plainTempPassword = candidate;
      }
      if (plainTempPassword) {
        hashedPassword = await this.passwordService.hash(plainTempPassword);
      } else {
        throw new BadRequestException(
          'Não foi possível gerar senha temporária segura para o usuário. Tente novamente.',
        );
      }
    }
    const userId =
      typeof createUserData.id === 'string' && createUserData.id
        ? createUserData.id
        : randomUUID();
    const requestedAuthUserId =
      typeof createUserData.auth_user_id === 'string'
        ? createUserData.auth_user_id
        : undefined;
    const identityType = this.resolveIdentityType({
      requested: requestedIdentityType,
      password: hashedPassword || undefined,
      authUserId: requestedAuthUserId,
      email: typeof rest.email === 'string' ? rest.email : undefined,
    });
    this.assertIdentityCredentialContract({
      identityType,
      password: hashedPassword || undefined,
      authUserId: requestedAuthUserId,
    });
    const accessStatus = this.resolveAccessStatus({
      identityType,
      password: hashedPassword || undefined,
      authUserId: requestedAuthUserId,
      email: typeof rest.email === 'string' ? rest.email : undefined,
    });
    const cpfSecurityPayload = this.buildCpfSecurityPayload(normalizedCpf);
    const user = this.usersRepository.create({
      id: userId,
      ...rest,
      ...cpfSecurityPayload,
      company_id: companyId,
      auth_user_id: requestedAuthUserId || undefined,
      identity_type: identityType,
      access_status: accessStatus,
      module_access_keys: [],
      password: hashedPassword || undefined,
      must_change_password:
        typeof plainTempPassword === 'string' ? true : false,
    } as DeepPartial<User>);
    const saved = await this.usersRepository.save(user);
    await this.syncUserSites(saved.id, companyId, requestedSiteIds);
    await this.syncRbacRoleFromProfile(saved.id, requestedProfileName);
    saved.cpf = this.resolveUserCpf(saved);
    saved.module_access_keys = this.normalizeModuleAccessKeys(
      saved.module_access_keys,
    );
    this.attachUserSiteSummary(saved, requestedSiteIds);
    // Envia e-mail com CPF e senha temporária se foi gerada
    if (
      typeof plainTempPassword === 'string' &&
      plainTempPassword &&
      typeof rest.email === 'string' &&
      rest.email.trim()
    ) {
      try {
        const subject = 'Bem-vindo ao SGS — suas credenciais de acesso';

        // Gera token de redefinição de senha e persiste no Redis para o link
        const LOCAL_RESET_TOKEN_TTL_SECONDS = 3600; // 1 hora
        const token = randomBytes(32).toString('hex');
        const issuedAtMs = Date.now();
        const expiresAtMs = issuedAtMs + LOCAL_RESET_TOKEN_TTL_SECONDS * 1000;
        const redisKey = `reset_password:${token}`;
        try {
          await this.redisService.getClient().setex(
            redisKey,
            LOCAL_RESET_TOKEN_TTL_SECONDS,
            JSON.stringify({
              userId: saved.id,
              issuedAtMs,
              expiresAtMs,
              v: 1,
              suppressed: 0,
            }),
          );
        } catch (err) {
          this.logger.warn({
            event: 'welcome_reset_token_redis_error',
            companyId,
            userId: saved.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // A página /auth/reset-password é servida pelo backend (API), não pelo
        // frontend — token no hash fragment, nunca chega ao servidor em logs.
        const resetHref = `${resolvePasswordResetBaseUrl(this.configService)}/auth/reset-password#token=${token}`;

        const escapeHtmlLocal = (s: string) =>
          String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        const html = this.mailService?.buildGraphiteEmailHtml({
          eyebrow: 'Acesso temporário',
          title: `Olá ${escapeHtmlLocal(saved.nome || '')}`,
          paragraphs: [
            `Seu CPF: ${escapeHtmlLocal(normalizedCpf)}`,
            `Senha temporária: <strong>${escapeHtmlLocal(plainTempPassword)}</strong>`,
            'Por segurança, troque sua senha ao entrar pela primeira vez.',
          ],
          cta: {
            label: 'Trocar minha senha',
            href: resetHref,
          },
          note: 'Caso não tenha solicitado este acesso, contate o administrador da sua empresa.',
        });

        // Texto simples de fallback
        const body = `Olá ${saved.nome || ''},\n\nSuas credenciais de acesso ao SGS:\nCPF: ${normalizedCpf}\nSenha temporária: ${plainTempPassword}\n\nPor segurança, troque sua senha ao entrar pela primeira vez.\n\nAtenciosamente,\nSGS`;

        await this.mailService?.sendMailSimple(
          rest.email,
          subject,
          body,
          { companyId, userId: saved.id },
          undefined,
          { html: html ?? undefined, filename: 'welcome.html' },
        );
      } catch (err) {
        this.logger.warn({
          event: 'user_welcome_email_failed',
          companyId,
          userId: saved.id,
          recipient: rest.email,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await this.invalidateAuthSessionUserCache(saved.id);
    return plainToClass(UserResponseDto, saved);
  }

  listModuleAccessOptions() {
    return USER_MODULE_ACCESS_OPTIONS.map((option) => ({
      ...option,
      permissions: [...option.permissions],
    }));
  }

  async findPaginated(opts?: {
    page?: number;
    limit?: number;
    search?: string;
    siteId?: string;
    identityType?: UserIdentityType;
    accessStatus?: UserAccessStatus;
  }): Promise<OffsetPage<UserResponseDto>> {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'usuarios',
      { allowMissingSiteScope: true },
    );
    const tenantId = scope.companyId;
    const requestedSiteId = opts?.siteId?.trim() || undefined;
    if (
      requestedSiteId &&
      !scope.hasCompanyWideAccess &&
      !scope.siteIds.includes(requestedSiteId)
    ) {
      throw new ForbiddenException('Obra fora do escopo do usuário atual.');
    }
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const qb = this.usersRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.company', 'company')
      .leftJoinAndSelect('user.site', 'site')
      .leftJoinAndSelect('user.site_links', 'siteLinks')
      .leftJoinAndSelect('siteLinks.site', 'linkedSite')
      .leftJoinAndSelect('user.profile', 'profile')
      .addSelect('user.cpf_ciphertext')
      .addSelect('user.cpf_hash')
      .where('user.deleted_at IS NULL')
      .skip(skip)
      .take(limit)
      .orderBy('user.nome', 'ASC');

    if (tenantId) {
      qb.andWhere('user.company_id = :tenantId', { tenantId });
    }

    qb.andWhere('user.deleted_at IS NULL');

    if (scope.hasCompanyWideAccess && requestedSiteId) {
      qb.andWhere(
        '(user.site_id = :siteId OR siteLinks.site_id = :siteId OR user.site_id IS NULL)',
        {
          siteId: requestedSiteId,
        },
      );
    } else if (!scope.hasCompanyWideAccess && requestedSiteId) {
      const ownUserClause = scope.userId ? ' OR user.id = :currentUserId' : '';
      qb.andWhere(
        `(user.site_id = :siteId OR siteLinks.site_id = :siteId${ownUserClause})`,
        {
          siteId: requestedSiteId,
          ...(scope.userId ? { currentUserId: scope.userId } : {}),
        },
      );
    } else if (!scope.hasCompanyWideAccess && scope.siteIds.length > 0) {
      const ownUserClause = scope.userId ? ' OR user.id = :currentUserId' : '';
      qb.andWhere(
        `(user.site_id IN (:...scopeSiteIds) OR siteLinks.site_id IN (:...scopeSiteIds)${ownUserClause})`,
        {
          scopeSiteIds: scope.siteIds,
          ...(scope.userId ? { currentUserId: scope.userId } : {}),
        },
      );
    } else if (!scope.hasCompanyWideAccess) {
      qb.andWhere('1 = 0');
    }
    // No site filter: non-superadmin users without a site assignment see all
    // company users — tenant isolation is guaranteed by the company_id filter above.

    if (opts?.identityType) {
      qb.andWhere('user.identity_type = :identityType', {
        identityType: opts.identityType,
      });
    }

    if (opts?.accessStatus) {
      qb.andWhere('user.access_status = :accessStatus', {
        accessStatus: opts.accessStatus,
      });
    }

    const search = normalizeOptionalSearchQuery(opts?.search);
    if (search) {
      const escapedSearch = `%${escapeLikePattern(search)}%`;
      const normalizedCpfSearch = search.replace(/\D/g, '');
      const hasCpfSearch = normalizedCpfSearch.length === 11;
      const cpfHashSearch = hasCpfSearch
        ? hashSensitiveValue(normalizedCpfSearch)
        : null;
      const clause = hasCpfSearch
        ? "(user.nome ILIKE :search ESCAPE '\\' OR user.cpf_hash = :cpfHashSearch)"
        : "(user.nome ILIKE :search ESCAPE '\\')";
      const hasBaseScope =
        Boolean(
          tenantId ||
          requestedSiteId ||
          (!scope.hasCompanyWideAccess && scope.siteIds.length > 0) ||
          opts?.identityType ||
          opts?.accessStatus,
        ) || !scope.isSuperAdmin;
      if (hasBaseScope) {
        qb.andWhere(clause, {
          search: escapedSearch,
          ...(cpfHashSearch ? { cpfHashSearch } : {}),
        });
      } else {
        qb.where(clause, {
          search: escapedSearch,
          ...(cpfHashSearch ? { cpfHashSearch } : {}),
        });
      }
    }

    const [users, total] = await qb.getManyAndCount();
    users.forEach((user) => {
      user.cpf = this.resolveUserCpf(user);
      user.module_access_keys = this.normalizeModuleAccessKeys(
        user.module_access_keys,
      );
      this.attachUserSiteSummary(
        user,
        this.normalizeUserSiteIds(
          user.site_links?.map((link) => link.site_id),
          user.site_id,
        ),
      );
    });
    const data = users.map((user) => plainToClass(UserResponseDto, user));
    return toOffsetPage(data, total, page, limit);
  }

  async findAll(page = 1, limit = 20): Promise<OffsetPage<UserResponseDto>> {
    return this.findPaginated({ page, limit });
  }

  /**
   * Leitura leve para sessão autenticada.
   *
   * Evita joins de company/site no /auth/me para reduzir latência e
   * não depender de colunas opcionais da tabela companies durante o bootstrap
   * da sessão do usuário.
   */
  async findAuthSessionUser(id: string): Promise<UserResponseDto> {
    const tenantId = this.tenantService.getTenantId();
    const cached = await this.getCachedAuthSessionUser(id, tenantId);
    if (cached) {
      return cached;
    }

    const user = await this.usersRepository.findOne({
      where: tenantId ? { id, company_id: tenantId } : { id },
      relations: { profile: true },
      select: {
        id: true,
        nome: true,
        cpf: true,
        cpf_ciphertext: true,
        email: true,
        funcao: true,
        company_id: true,
        site_id: true,
        profile_id: true,
        identity_type: true,
        access_status: true,
        status: true,
        must_change_password: true,
        module_access_keys: true,
        created_at: true,
        updated_at: true,
        profile: {
          id: true,
          nome: true,
          permissoes: true,
          status: true,
          created_at: true,
          updated_at: true,
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`Usuário com ID ${id} não encontrado`);
    }

    user.cpf = this.resolveUserCpf(user);
    user.module_access_keys = this.normalizeModuleAccessKeys(
      user.module_access_keys,
    );
    this.attachUserSiteSummary(
      user,
      await this.findUserSiteIds(user.id, user.company_id),
    );

    const result = plainToClass(UserResponseDto, user);
    await this.cacheAuthSessionUser(id, tenantId, result);
    return result;
  }

  async findOne(id: string): Promise<UserResponseDto> {
    const tenantId = this.getTenantIdOrThrow();
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'usuarios',
    );
    const qb = this.usersRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.company', 'company')
      .leftJoinAndSelect('user.profile', 'profile')
      .leftJoinAndSelect('user.site', 'site')
      .leftJoinAndSelect('user.site_links', 'siteLinks')
      .leftJoinAndSelect('siteLinks.site', 'linkedSite')
      .addSelect('user.cpf_ciphertext')
      .addSelect('user.must_change_password')
      .where('user.id = :id', { id })
      .andWhere('user.deleted_at IS NULL');

    qb.andWhere('user.company_id = :tenantId', { tenantId });
    if (!scope.hasCompanyWideAccess) {
      if (scope.siteIds.length === 0) {
        qb.andWhere('1 = 0');
      } else {
        const ownUserClause = scope.userId
          ? ' OR user.id = :currentUserId'
          : '';
        qb.andWhere(
          `(user.site_id IN (:...scopeSiteIds) OR siteLinks.site_id IN (:...scopeSiteIds)${ownUserClause})`,
          {
            scopeSiteIds: scope.siteIds,
            ...(scope.userId ? { currentUserId: scope.userId } : {}),
          },
        );
      }
    }

    const user = await qb.getOne();
    if (!user) {
      throw new NotFoundException(`Usuário com ID ${id} não encontrado`);
    }
    user.cpf = this.resolveUserCpf(user);
    user.module_access_keys = this.normalizeModuleAccessKeys(
      user.module_access_keys,
    );
    this.attachUserSiteSummary(
      user,
      this.normalizeUserSiteIds(
        user.site_links?.map((link) => link.site_id),
        user.site_id,
      ),
    );
    return plainToClass(UserResponseDto, user);
  }

  async findOneWithPassword(id: string): Promise<User> {
    const tenantId = this.tenantService.getTenantId();
    const qb = this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.cpf_ciphertext')
      .where('user.id = :id', { id })
      .andWhere('user.deleted_at IS NULL');

    if (tenantId) {
      qb.andWhere('user.company_id = :tenantId', { tenantId });
    }

    USER_WITH_PASSWORD_FIELDS.forEach((field) => {
      qb.addSelect(`user.${field}`);
    });

    const user = await qb.getOne();
    if (!user) {
      throw new NotFoundException(`Usuário com ID ${id} não encontrado`);
    }
    user.cpf = this.resolveUserCpf(user);
    return user;
  }

  async findOneByCpf(cpf: string): Promise<User | null> {
    const normalizedCpf = CpfUtil.normalize(cpf);
    const cpfHash = hashSensitiveValue(normalizedCpf);
    const legacyPlaintextLookupEnabled = isLegacyCpfPlaintextLookupEnabled();

    const qb = this.usersRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.company', 'company')
      .leftJoinAndSelect('user.profile', 'profile')
      .addSelect('user.cpf_ciphertext')
      .where(
        legacyPlaintextLookupEnabled
          ? '(user.cpf_hash = :cpfHash OR user.cpf = :legacyCpf)'
          : 'user.cpf_hash = :cpfHash',
        legacyPlaintextLookupEnabled
          ? { cpfHash, legacyCpf: normalizedCpf }
          : { cpfHash },
      )
      // Defesa em profundidade no login: além da checagem de status=false,
      // nunca autenticar por um registro soft-deletado (remoção ou GDPR).
      .andWhere('user.deleted_at IS NULL')
      .limit(1);

    USER_WITH_PASSWORD_FIELDS.forEach((field) => {
      qb.addSelect(`user.${field}`);
    });

    const user = await qb.getOne();

    if (user && user.status === false) {
      return null;
    }

    if (user) {
      user.cpf = this.resolveUserCpf(user);
    }

    return user;
  }

  async update(
    id: string,
    updateUserData: DeepPartial<User>,
  ): Promise<UserResponseDto> {
    // Busca a entidade original
    const tenantId = this.getTenantIdOrThrow();
    const isSuperAdmin = this.tenantService.isSuperAdmin();
    const user = await this.usersRepository.findOne({
      where: { id, company_id: tenantId },
      select: {
        id: true,
        nome: true,
        cpf: true,
        cpf_ciphertext: true,
        email: true,
        funcao: true,
        status: true,
        company_id: true,
        site_id: true,
        profile_id: true,
        auth_user_id: true,
        identity_type: true,
        access_status: true,
        module_access_keys: true,
        password: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`Usuário com ID ${id} não encontrado`);
    }
    const previousProfileId = user.profile_id;

    const {
      password,
      company_id: attemptedCompanyId,
      cpf: nextCpfRaw,
      identity_type: requestedIdentityType,
      access_status: _ignoredAccessStatus,
      module_access_keys: _ignoredModuleAccessKeys,
      site_ids: requestedSiteIdsRaw,
      ...rest
    } = updateUserData as DeepPartial<User> & { site_ids?: string[] };

    let nextNormalizedCpf: string | undefined;
    if (typeof nextCpfRaw === 'string') {
      nextNormalizedCpf = CpfUtil.normalize(nextCpfRaw);
      const cpfHash = hashSensitiveValue(nextNormalizedCpf);
      const legacyPlaintextLookupEnabled = isLegacyCpfPlaintextLookupEnabled();
      const existingCpfOwner = await this.usersRepository.findOne({
        where: legacyPlaintextLookupEnabled
          ? [{ cpf_hash: cpfHash }, { cpf: nextNormalizedCpf }]
          : { cpf_hash: cpfHash },
        select: { id: true },
      });
      if (existingCpfOwner && existingCpfOwner.id !== user.id) {
        throw new ConflictException('CPF já cadastrado neste sistema.');
      }
    }

    if (typeof rest.email === 'string' && rest.email) {
      const emailConflict = await this.usersRepository.findOne({
        where: { email: rest.email, company_id: user.company_id },
        select: { id: true },
      });
      if (emailConflict && emailConflict.id !== id) {
        throw new ConflictException('Email já está em uso nesta empresa.');
      }
    }

    // Bloqueio de mass assignment: não permitir alteração de company_id via payload.
    // Se for necessário "mover usuário de empresa", crie um endpoint admin dedicado com
    // auditoria e validações adicionais.
    if (attemptedCompanyId) {
      this.logger.warn({
        event: 'mass_assignment_blocked',
        action: 'users.update',
        actorId: RequestContext.getUserId(),
        tenantId,
        targetUserId: id,
        attemptedCompanyId,
      });
      if (!isSuperAdmin) {
        throw new ForbiddenException(
          'Alteração de empresa do usuário não é permitida por este endpoint.',
        );
      }
    }

    // Privilege Escalation: bloquear promoção para ADMIN_GERAL por não-superadmin.
    let nextProfileName: string | undefined;
    if (rest.profile_id) {
      const profile = await this.profilesRepository.findOne({
        where: { id: rest.profile_id },
        select: { id: true, nome: true },
      });
      nextProfileName = profile?.nome;
      if (
        profile &&
        normalizeRoleName(profile.nome) === Role.ADMIN_GERAL &&
        !isSuperAdmin
      ) {
        this.logger.warn({
          event: 'role_change_denied',
          action: 'users.update',
          actorId: RequestContext.getUserId(),
          targetUserId: id,
          requestedProfile: profile.nome,
        });
        throw new ForbiddenException(
          'Atribuição de perfil Administrador Geral não é permitida.',
        );
      }
      if (!isSuperAdmin && profile) {
        const actorUserId = RequestContext.getUserId();
        if (actorUserId) {
          await this.enforceRoleAssignmentPolicy(actorUserId, profile.nome);
        }
      }
    }
    if (!nextProfileName && user.profile_id) {
      const currentProfile = await this.profilesRepository.findOne({
        where: { id: user.profile_id },
        select: { id: true, nome: true },
      });
      nextProfileName = currentProfile?.nome;
    }

    if (rest.profile_id && rest.profile_id !== user.profile_id) {
      this.logger.warn({
        event: 'role_change',
        actorId: RequestContext.getUserId(),
        targetUserId: id,
        fromProfileId: user.profile_id,
        toProfileId: rest.profile_id,
      });
    }

    if (password && typeof password === 'string') {
      const validation = this.passwordService.validate(password);
      if (!validation.valid) {
        throw new BadRequestException(
          `A senha não atende aos critérios de segurança: ${validation.errors.join(', ')}`,
        );
      }
      await this.pwnedPasswordService.assertNotPwned(password);
      user.password = await this.passwordService.hash(password);
    }
    // site_ids só é sincronizado se o payload incluir 'site_ids' ou 'site_id' explicitamente.
    // PATCH parcial sem esses campos mantém os sites anteriores do usuário inalterados.
    const shouldSyncSites =
      Array.isArray(requestedSiteIdsRaw) || 'site_id' in rest;
    const requestedSiteIds = shouldSyncSites
      ? this.normalizeUserSiteIds(
          requestedSiteIdsRaw,
          typeof rest.site_id === 'string' ? rest.site_id : undefined,
        )
      : undefined;
    if (requestedSiteIds) {
      await this.assertSitesBelongToCompany(requestedSiteIds, user.company_id);
      rest.site_id = requestedSiteIds[0] ?? null;
    }

    const nextEmail =
      typeof rest.email === 'string' ? rest.email : user.email || undefined;
    const nextIdentityType = this.resolveIdentityType({
      requested: requestedIdentityType,
      current: user.identity_type,
      password:
        typeof password === 'string' && password ? password : user.password,
      authUserId: user.auth_user_id,
      email: nextEmail,
    });
    this.assertIdentityCredentialContract({
      identityType: nextIdentityType,
      password:
        typeof password === 'string' && password ? password : user.password,
      authUserId: user.auth_user_id,
    });
    user.identity_type = nextIdentityType;
    user.access_status = this.resolveAccessStatus({
      identityType: nextIdentityType,
      password: user.password,
      authUserId: user.auth_user_id,
      email: nextEmail,
    });
    Object.assign(user, rest);
    if (nextNormalizedCpf) {
      Object.assign(user, this.buildCpfSecurityPayload(nextNormalizedCpf));
    }
    const saved = await this.usersRepository.save(user);
    if (requestedSiteIds) {
      await this.syncUserSites(saved.id, saved.company_id, requestedSiteIds);
    }
    saved.cpf = this.resolveUserCpf(saved);
    saved.module_access_keys = this.normalizeModuleAccessKeys(
      saved.module_access_keys,
    );
    this.attachUserSiteSummary(
      saved,
      requestedSiteIds ??
        (await this.findUserSiteIds(saved.id, saved.company_id)),
    );

    if (rest.profile_id && rest.profile_id !== previousProfileId) {
      await this.syncRbacRoleFromProfile(id, nextProfileName);
    }
    await this.invalidateAuthSessionUserCache(id);
    // Invalida o cache em memória do principal (bridge) para que o próximo
    // request re-resolva no banco. Sem isto, mesmo com o banco correto
    // (obra Y), o sistema continuaria enxergando o usuário na obra X por até
    // 60-300s e bloqueando a emissão de documentos em Y (RLS/escopo).
    this.authPrincipalService.invalidateBridgeCache({
      appUserId: saved.id,
      authUserId: saved.auth_user_id ?? undefined,
    });

    return plainToClass(UserResponseDto, saved);
  }

  private async syncRbacRoleFromProfile(
    userId: string,
    profileName?: string,
  ): Promise<void> {
    const rbacService = this.rbacService as RbacService & {
      syncUserRoleFromProfileName?: (
        userId: string,
        profileName?: string | null,
      ) => Promise<void>;
    };

    if (typeof rbacService.syncUserRoleFromProfileName === 'function') {
      await rbacService.syncUserRoleFromProfileName(userId, profileName);
      return;
    }

    await this.rbacService.invalidateUserAccess(userId);
  }

  async updateModuleAccess(
    id: string,
    moduleKeys: string[],
  ): Promise<UserResponseDto> {
    const tenantId = this.getTenantIdOrThrow();
    const user = await this.usersRepository.findOne({
      where: { id, company_id: tenantId },
      select: {
        id: true,
        nome: true,
        cpf: true,
        cpf_ciphertext: true,
        email: true,
        funcao: true,
        status: true,
        company_id: true,
        site_id: true,
        profile_id: true,
        auth_user_id: true,
        identity_type: true,
        access_status: true,
        module_access_keys: true,
        password: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`Usuário com ID ${id} não encontrado`);
    }

    user.module_access_keys = this.normalizeModuleAccessKeys(moduleKeys);
    const saved = await this.usersRepository.save(user);
    saved.cpf = this.resolveUserCpf(saved);
    saved.module_access_keys = this.normalizeModuleAccessKeys(
      saved.module_access_keys,
    );
    this.attachUserSiteSummary(
      saved,
      await this.findUserSiteIds(saved.id, saved.company_id),
    );

    await this.rbacService.invalidateUserAccess(id);
    await this.invalidateAuthSessionUserCache(id);

    return plainToClass(UserResponseDto, saved);
  }

  private async assertSiteBelongsToCompany(
    siteId: string,
    companyId: string,
  ): Promise<void> {
    const site = await this.usersRepository.manager
      .getRepository(Site)
      .findOne({
        where: { id: siteId, company_id: companyId },
        select: ['id'],
      });
    if (!site) {
      throw new BadRequestException(
        'A obra/setor informada não pertence à empresa do usuário.',
      );
    }
  }

  private async assertSitesBelongToCompany(
    siteIds: string[],
    companyId: string,
  ): Promise<void> {
    if (siteIds.length === 0) {
      return;
    }

    if (siteIds.length === 1) {
      await this.assertSiteBelongsToCompany(siteIds[0], companyId);
      return;
    }

    const count = await this.usersRepository.manager.getRepository(Site).count({
      where: { id: In(siteIds), company_id: companyId },
    });
    if (count !== siteIds.length) {
      throw new BadRequestException(
        'Uma ou mais obras informadas não pertencem à empresa do usuário.',
      );
    }
  }

  private normalizeUserSiteIds(
    siteIds?: string[] | null,
    fallbackSiteId?: string | null,
  ): string[] {
    return Array.from(
      new Set(
        [...(siteIds ?? []), fallbackSiteId]
          .map((siteId) => String(siteId || '').trim())
          .filter(Boolean),
      ),
    );
  }

  private async syncUserSites(
    userId: string,
    companyId: string,
    siteIds: string[],
  ): Promise<void> {
    await this.userSitesRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(UserSite);
      await repository.delete({ user_id: userId, company_id: companyId });
      if (siteIds.length === 0) {
        return;
      }

      await repository.save(
        siteIds.map((siteId) =>
          repository.create({
            company_id: companyId,
            user_id: userId,
            site_id: siteId,
          }),
        ),
      );
    });
  }

  private async findUserSiteIds(
    userId: string,
    companyId: string,
  ): Promise<string[]> {
    const links = await this.userSitesRepository.find({
      where: { user_id: userId, company_id: companyId },
      select: { site_id: true },
      order: { created_at: 'ASC' },
    });
    return this.normalizeUserSiteIds(links.map((link) => link.site_id));
  }

  private attachUserSiteSummary(user: User, siteIds: string[]): void {
    const links = user.site_links ?? [];
    const sites = links
      .map((link) => link.site)
      .filter(
        (site): site is Site => Boolean(site?.id) && siteIds.includes(site.id),
      )
      .map((site) => ({ id: site.id, nome: site.nome }));

    Object.assign(user, {
      site_ids: siteIds,
      sites,
    });
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.getTenantIdOrThrow();
    const isSuperAdmin = this.tenantService.isSuperAdmin();
    const actorId = RequestContext.getUserId();

    // Auto-deleção: nenhum usuário pode excluir a si mesmo.
    if (actorId && actorId === id) {
      throw new ForbiddenException(
        'Não é permitido excluir o próprio usuário.',
      );
    }

    const user = await this.usersRepository.findOne({
      where: { id, company_id: tenantId },
      relations: { profile: true },
    });

    if (!user) {
      throw new NotFoundException(`Usuário com ID ${id} não encontrado`);
    }

    // Restrição por role: não-ADMIN_GERAL só pode deletar COLABORADOR/TRABALHADOR.
    if (!isSuperAdmin) {
      const targetProfile = user.profile?.nome;
      const deletableProfiles = [ROLE_COLABORADOR, ROLE_TRABALHADOR];
      if (targetProfile && !deletableProfiles.includes(targetProfile)) {
        throw new ForbiddenException(
          'Você não tem permissão para excluir usuários com este perfil.',
        );
      }
    }

    // Proteção de último admin: não pode excluir o último ADMIN_EMPRESA ativo da empresa.
    if (user.profile?.nome === ROLE_ADMIN_EMPRESA) {
      const adminCount = await this.usersRepository
        .createQueryBuilder('u')
        .innerJoin('u.profile', 'p')
        .where('u.company_id = :companyId', { companyId: tenantId })
        .andWhere('u.deleted_at IS NULL')
        .andWhere('p.nome = :profileName', { profileName: Role.ADMIN_EMPRESA })
        .andWhere('u.status = :status', { status: true })
        .andWhere('u.deleted_at IS NULL')
        .getCount();

      if (adminCount <= 1) {
        throw new ForbiddenException(
          'Não é possível excluir o último administrador da empresa.',
        );
      }
    }

    await this.usersRepository.softRemove(user);
    await this.rbacService.invalidateUserAccess(id);
    await this.invalidateAuthSessionUserCache(id);
  }

  async gdprErasure(id: string): Promise<void> {
    const tenantId = this.getTenantIdOrThrow();
    const user = await this.usersRepository.findOne({
      where: { id, company_id: tenantId },
    });

    if (!user) {
      throw new NotFoundException(`Usuário com ID ${id} não encontrado`);
    }

    const actorId = RequestContext.getUserId() || user.id;
    const companyId = tenantId;
    const ip = (RequestContext.get('ip') as string) || 'unknown';
    const userAgent = (RequestContext.get('userAgent') as string) || 'system';

    await this.usersRepository.manager.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const auditRepo = manager.getRepository(AuditLog);

      await userRepo.update(user.id, {
        email: `deleted_${user.id}@anon.invalid`,
        nome: 'Usuário Removido',
        cpf: null,
        cpf_hash: null,
        cpf_ciphertext: null,
        funcao: null,
        status: false,
        deletedAt: new Date(),
      });

      await userRepo.softDelete(user.id);

      const erasureCoverage = await manager.query<GdprErasureCoverageRow[]>(
        'SELECT table_name, deleted_count FROM gdpr_delete_user_data($1)',
        [user.id],
      );
      const normalizedCoverage = erasureCoverage.map((row) => ({
        tableName: row.table_name,
        affectedRows: this.toCount(row.deleted_count),
      }));

      await auditRepo.save(
        auditRepo.create({
          userId: actorId,
          action: AuditAction.GDPR_ERASURE,
          entity: 'USER',
          entityId: user.id,
          changes: {
            targetUserId: user.id,
            erasureCoverage: normalizedCoverage,
          },
          before: undefined,
          after: { targetUserId: user.id, erasureCoverage: normalizedCoverage },
          ip,
          userAgent,
          companyId,
        }),
      );
    });

    await this.rbacService.invalidateUserAccess(user.id);
    await this.invalidateAuthSessionUserCache(user.id);
  }

  // ---------------------------------------------------------------------------
  // Signature PIN (HMAC-SHA256)
  // ---------------------------------------------------------------------------

  async hasSignaturePin(userId: string): Promise<boolean> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'signature_pin_hash'],
    });
    return Boolean(user?.signature_pin_hash);
  }

  async setSignaturePin(
    userId: string,
    pin: string,
    currentPassword?: string,
  ): Promise<void> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'password', 'signature_pin_hash'],
    });
    if (!user) throw new NotFoundException('Usuário não encontrado.');

    // Ao alterar PIN existente, exige senha atual obrigatoriamente
    if (user.signature_pin_hash) {
      if (!currentPassword) {
        throw new UnauthorizedException(
          'Senha atual obrigatória para alterar o PIN de assinatura.',
        );
      }
      const passwordOk = await this.passwordService.compare(
        currentPassword,
        user.password ?? '',
      );
      if (!passwordOk)
        throw new UnauthorizedException('Senha atual incorreta.');
    }

    const pbkdf2Salt = randomBytes(32).toString('hex');
    const pinBcryptHash = await this.passwordService.hash(pin);

    await this.usersRepository.update(userId, {
      signature_pin_hash: pinBcryptHash,
      signature_pin_salt: pbkdf2Salt,
    });
    await this.invalidateAuthSessionUserCache(userId);
  }

  async verifySignaturePin(userId: string, pin: string): Promise<boolean> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'signature_pin_hash'],
    });
    if (!user?.signature_pin_hash) return false;
    return this.passwordService.compare(pin, user.signature_pin_hash);
  }

  async deriveHmacKey(userId: string, pin: string): Promise<Buffer> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'signature_pin_hash', 'signature_pin_salt'],
    });
    if (!user?.signature_pin_hash || !user.signature_pin_salt) {
      throw new BadRequestException('PIN de assinatura não configurado.');
    }
    const pinOk = await this.passwordService.compare(
      pin,
      user.signature_pin_hash,
    );
    if (!pinOk) throw new UnauthorizedException('PIN inválido.');

    return pbkdf2Sync(pin, user.signature_pin_salt, 100_000, 32, 'sha256');
  }

  computeHmac(key: Buffer, message: string): string {
    return createHmac('sha256', key).update(message).digest('hex');
  }

  // ---------------------------------------------------------------------------
  // AI Consent (LGPD)
  // ---------------------------------------------------------------------------

  /**
   * Atualiza o consentimento do usuário para processamento por IA.
   * Retorna o novo valor do campo.
   */
  async updateAiConsent(
    userId: string,
    consent: boolean,
  ): Promise<{ ai_processing_consent: boolean }> {
    const tenantId = this.getTenantIdOrThrow();
    const user = await this.usersRepository.findOne({
      where: { id: userId, company_id: tenantId },
    });
    if (!user) {
      throw new NotFoundException(`Usuário com ID ${userId} não encontrado`);
    }

    await this.usersRepository.update(userId, {
      ai_processing_consent: consent,
    });
    await this.invalidateAuthSessionUserCache(userId);

    return { ai_processing_consent: consent };
  }

  private getAuthSessionCacheTtlSeconds(): number {
    const parsed = Number(
      process.env.AUTH_SESSION_USER_CACHE_TTL_SECONDS || 60,
    );
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }
    return Math.min(Math.floor(parsed), 300);
  }

  private getAuthSessionCacheKey(userId: string, tenantId?: string): string {
    return `auth:session_user:${userId}:${tenantId || 'global'}`;
  }

  private async getCachedAuthSessionUser(
    userId: string,
    tenantId?: string,
  ): Promise<UserResponseDto | null> {
    const ttl = this.getAuthSessionCacheTtlSeconds();
    if (ttl <= 0) {
      return null;
    }

    try {
      const raw = await this.redisService
        .getClient()
        .get(this.getAuthSessionCacheKey(userId, tenantId));
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as UserResponseDto;
      return plainToClass(UserResponseDto, parsed);
    } catch {
      return null;
    }
  }

  private async cacheAuthSessionUser(
    userId: string,
    tenantId: string | undefined,
    user: UserResponseDto,
  ): Promise<void> {
    const ttl = this.getAuthSessionCacheTtlSeconds();
    if (ttl <= 0) {
      return;
    }

    try {
      await this.redisService
        .getClient()
        .setex(
          this.getAuthSessionCacheKey(userId, tenantId),
          ttl,
          JSON.stringify(user),
        );
    } catch {
      // Melhor esforço: falhas de cache não devem quebrar /auth/me.
    }
  }

  private async invalidateAuthSessionUserCache(userId: string): Promise<void> {
    try {
      let cursor = '0';
      const pattern = `auth:session_user:${userId}:*`;

      do {
        const [nextCursor, keys] = await this.redisService
          .getClient()
          .scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = nextCursor;

        if (keys.length > 0) {
          await this.redisService.getClient().del(...keys);
        }
      } while (cursor !== '0');
    } catch {
      // Melhor esforço: invalidação não deve bloquear fluxo principal.
    }
  }

  /**
   * Aplica a política de atribuição de perfis/roles.
   *
   * Hierarquia de poder:
   * - SUPER_ADMIN: atribui qualquer perfil, inclusive perfis de plataforma
   * - ADMIN_GERAL: administra o próprio tenant, mas não promove para o papel
   *   de administrador do tenant
   * - ADMIN_EMPRESA: não pode criar outro ADMIN_EMPRESA (apenas ADMIN_GERAL pode)
   * - TST: não pode atribuir ADMIN_EMPRESA ou TST
   * - SUPERVISOR: não pode atribuir ADMIN_EMPRESA, TST ou SUPERVISOR
   */
  private async enforceRoleAssignmentPolicy(
    actorId: string,
    targetProfileName: string,
  ): Promise<void> {
    const actorAccess = await this.rbacService.getUserAccess(actorId);
    const actorRoles = actorAccess.roles.map(String);
    const actorScope = this.rbacService.getEffectiveRoleScope(actorRoles);
    const targetScope = this.rbacService.getRoleScope(targetProfileName);

    if (targetScope === 'SUPER_ADMIN') {
      throw new ForbiddenException(
        `Somente o super admin pode atribuir o perfil "${targetProfileName}".`,
      );
    }

    if (!actorScope || !targetScope) {
      throw new ForbiddenException(
        `Perfil "${targetProfileName}" não pode ser atribuído porque o escopo RBAC não foi resolvido.`,
      );
    }

    if (
      this.getRoleScopePriority(targetScope) <=
      this.getRoleScopePriority(actorScope)
    ) {
      throw new ForbiddenException(
        `${this.getRoleScopeLabel(actorScope)} não pode atribuir o perfil "${targetProfileName}".`,
      );
    }

    if (
      actorRoles.includes(ROLE_ADMIN_EMPRESA) &&
      targetProfileName === ROLE_ADMIN_EMPRESA
    ) {
      throw new ForbiddenException(
        'Administradores de empresa não podem atribuir o perfil Administrador de Empresa.',
      );
    }

    if (actorRoles.includes(ROLE_TST)) {
      if (
        targetProfileName === ROLE_ADMIN_EMPRESA ||
        targetProfileName === ROLE_TST
      ) {
        throw new ForbiddenException(
          `TST não pode atribuir o perfil "${targetProfileName}".`,
        );
      }
    }

    if (actorRoles.includes(ROLE_SUPERVISOR)) {
      if (
        targetProfileName === ROLE_ADMIN_EMPRESA ||
        targetProfileName === ROLE_TST ||
        targetProfileName === ROLE_SUPERVISOR
      ) {
        throw new ForbiddenException(
          `Supervisor não pode atribuir o perfil "${targetProfileName}".`,
        );
      }
    }
  }

  private getRoleScopePriority(scope: RoleScope): number {
    const priorities: Record<RoleScope, number> = {
      SUPER_ADMIN: 0,
      ADMIN_EMPRESA: 1,
      GERENTE: 2,
      SUPERVISOR: 3,
      TECNICO: 4,
      VISUALIZADOR: 5,
    };

    return priorities[scope];
  }

  private getRoleScopeLabel(scope: RoleScope): string {
    const labels: Record<RoleScope, string> = {
      SUPER_ADMIN: 'Super admin',
      ADMIN_EMPRESA: 'Administrador da empresa',
      GERENTE: 'Gerente',
      SUPERVISOR: 'Supervisor',
      TECNICO: 'Técnico',
      VISUALIZADOR: 'Visualizador',
    };

    return labels[scope];
  }

  // ---------------------------------------------------------------------------
  // Data Portability (LGPD Art. 20)
  // ---------------------------------------------------------------------------

  /**
   * Exporta os dados pessoais do próprio usuário em formato estruturado.
   * Registra trilha de auditoria com AuditAction.DATA_PORTABILITY.
   * Nunca expõe hash de senha, PIN ou salts.
   */
  async exportMyData(userId: string): Promise<ExportMyDataResponseDto> {
    const tenantId = this.getTenantIdOrThrow();

    const user = await this.usersRepository.findOne({
      where: { id: userId, company_id: tenantId },
      relations: ['profile', 'site'],
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    const ip = (RequestContext.get('ip') as string) || 'unknown';
    const userAgent = (RequestContext.get('userAgent') as string) || 'system';
    const exportedAt = new Date().toISOString();
    const [consents, processingSummary] = await Promise.all([
      this.getConsentExportEvents(userId, tenantId),
      this.buildDataPortabilitySummary(userId, tenantId),
    ]);

    await this.auditService.log({
      userId,
      action: AuditAction.DATA_PORTABILITY,
      entity: 'USER',
      entityId: userId,
      changes: { exportedAt },
      ip,
      userAgent,
      companyId: tenantId || user.company_id,
    });

    return {
      exportedAt,
      dataController: 'SGS — Sistema de Gestão de Segurança',
      legalBasis: 'LGPD Art. 20 — Portabilidade de dados pessoais',
      profile: {
        id: user.id,
        nome: user.nome,
        cpf: this.resolveUserCpf(user),
        email: user.email,
        funcao: user.funcao,
        status: user.status,
        identity_type: user.identity_type,
        access_status: user.access_status,
        ai_processing_consent: user.ai_processing_consent,
        profile: user.profile
          ? { id: user.profile.id, nome: user.profile.nome }
          : null,
        site: user.site ? { id: user.site.id, nome: user.site.nome } : null,
        company_id: user.company_id,
        created_at: user.created_at.toISOString(),
        updated_at: user.updated_at.toISOString(),
      },
      consents,
      processingSummary,
      limitations: [...DATA_PORTABILITY_LIMITATIONS],
    };
  }
}
