import type { ConfigService } from '@nestjs/config';
import { Role } from './enums/roles.enum';

export type MfaPrivilegedRole =
  'SUPER_ADMIN' | 'ADMIN_GERAL' | 'ADMIN_EMPRESA' | 'NON_PRIVILEGED';

function readConfigValue(
  configService: Pick<ConfigService, 'get'> | undefined,
  key: string,
): string | undefined {
  const configured = configService?.get<string>(key);
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim();
  }
  return process.env[key]?.trim() || undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function positiveInt(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function getMfaIssuer(
  configService?: Pick<ConfigService, 'get'>,
): string {
  return readConfigValue(configService, 'MFA_ISSUER') || 'SGS Segurança';
}

export function getMfaJwtSecret(
  configService?: Pick<ConfigService, 'get'>,
): string {
  const secret =
    readConfigValue(configService, 'MFA_JWT_SECRET') ||
    readConfigValue(configService, 'STEP_UP_TOKEN_SECRET') ||
    readConfigValue(configService, 'JWT_SECRET');
  if (!secret) {
    throw new Error('MFA_JWT_SECRET or JWT_SECRET is required');
  }
  return secret;
}

export function getMfaTotpEncryptionKey(
  configService?: Pick<ConfigService, 'get'>,
): Buffer {
  const raw = readConfigValue(configService, 'MFA_TOTP_ENCRYPTION_KEY');
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'MFA_TOTP_ENCRYPTION_KEY é obrigatório em produção para proteger segredos TOTP',
      );
    }
    return Buffer.alloc(32, 0);
  }

  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to UTF-8 validation below.
  }

  const utf8 = Buffer.from(raw, 'utf8');
  if (utf8.length === 32) return utf8;

  throw new Error(
    'MFA_TOTP_ENCRYPTION_KEY deve ter 32 bytes em base64, 64 chars hex ou 32 chars UTF-8',
  );
}

export function getMfaLoginChallengeTtlSeconds(
  configService?: Pick<ConfigService, 'get'>,
): number {
  return positiveInt(
    readConfigValue(configService, 'MFA_LOGIN_CHALLENGE_TTL_SECONDS'),
    300,
    900,
  );
}

export function getMfaBootstrapTtlSeconds(
  configService?: Pick<ConfigService, 'get'>,
): number {
  return positiveInt(
    readConfigValue(configService, 'MFA_BOOTSTRAP_TTL_SECONDS'),
    900,
    1800,
  );
}

export function getMfaStepUpTtlSeconds(
  configService?: Pick<ConfigService, 'get'>,
): number {
  return positiveInt(
    readConfigValue(configService, 'MFA_STEP_UP_TTL_SECONDS'),
    300,
    900,
  );
}

export function getMfaMaxChallengeAttempts(
  configService?: Pick<ConfigService, 'get'>,
): number {
  return positiveInt(
    readConfigValue(configService, 'MFA_MAX_CHALLENGE_ATTEMPTS'),
    5,
    10,
  );
}

export function normalizePrivilegedRole(
  profileName?: string | null,
): MfaPrivilegedRole {
  const normalized = String(profileName || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

  if (normalized === 'super_admin' || normalized === 'super admin') {
    return 'SUPER_ADMIN';
  }

  if (
    normalized ===
      String(Role.ADMIN_GERAL)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') ||
    normalized === 'admin_geral' ||
    normalized === 'admin geral' ||
    normalized === 'administrador geral'
  ) {
    return 'ADMIN_GERAL';
  }
  if (
    normalized ===
      String(Role.ADMIN_EMPRESA)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') ||
    normalized === 'admin_empresa' ||
    normalized === 'admin empresa' ||
    normalized === 'administrador da empresa'
  ) {
    return 'ADMIN_EMPRESA';
  }
  return 'NON_PRIVILEGED';
}

export function isAdminEmpresaMfaEnforced(
  configService?: Pick<ConfigService, 'get'>,
  now = new Date(),
): boolean {
  const hardFlag = parseBoolean(
    readConfigValue(configService, 'ADMIN_EMPRESA_MFA_REQUIRED'),
    false,
  );
  if (hardFlag) return true;

  const dateRaw = readConfigValue(
    configService,
    'ADMIN_EMPRESA_MFA_ENFORCEMENT_DATE',
  );
  if (!dateRaw) return false;
  const enforcementDate = new Date(dateRaw);
  return !Number.isNaN(enforcementDate.getTime()) && enforcementDate <= now;
}

export function isAdminGeralMfaEnforced(
  configService?: Pick<ConfigService, 'get'>,
): boolean {
  return parseBoolean(
    readConfigValue(configService, 'ADMIN_GERAL_MFA_REQUIRED'),
    true,
  );
}

export function isAdminEmpresaPasswordFallbackAllowed(
  configService?: Pick<ConfigService, 'get'>,
): boolean {
  if (isAdminEmpresaMfaEnforced(configService)) {
    return false;
  }

  return parseBoolean(
    readConfigValue(
      configService,
      'ADMIN_EMPRESA_STEP_UP_PASSWORD_FALLBACK_ENABLED',
    ),
    true,
  );
}

export function isMfaEnabled(
  configService?: Pick<ConfigService, 'get'>,
): boolean {
  return parseBoolean(readConfigValue(configService, 'MFA_ENABLED'), true);
}
