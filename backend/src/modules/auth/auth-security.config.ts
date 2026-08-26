import type { SignOptions } from 'jsonwebtoken';
import type { CookieOptions } from 'express';
import type { ConfigService } from '@nestjs/config';

const DEFAULT_ACCESS_TOKEN_TTL = '15m';
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 30;
const DEFAULT_MAX_ACTIVE_SESSIONS_PER_USER = 10;
const REFRESH_TOKEN_COOKIE_PATH = '/';
const LEGACY_REFRESH_TOKEN_COOKIE_PATH = '/auth/refresh';
const LEGACY_REFRESH_CSRF_COOKIE_PATH = '/auth/refresh';
const REFRESH_CSRF_COOKIE_PATH = '/';
export const REFRESH_CSRF_COOKIE_NAME = 'refresh_csrf';
type TokenExpiresIn = NonNullable<SignOptions['expiresIn']>;
type RefreshCookieSameSite = 'strict' | 'lax' | 'none';
const DURATION_WITH_UNIT_REGEX = /^\d+(s|m|h|d)$/i;

export const JWT_ALGORITHM = 'HS256' as const;
export const JWT_ACCESS_TOKEN_TYPE = 'access' as const;
export const JWT_REFRESH_TOKEN_TYPE = 'refresh' as const;
export type JwtTokenType =
  typeof JWT_ACCESS_TOKEN_TYPE | typeof JWT_REFRESH_TOKEN_TYPE;

export type JwtContract = {
  issuer: string;
  audience: string;
  algorithms: [typeof JWT_ALGORITHM];
};

export function isInfiniteTtl(ttl: TokenExpiresIn): boolean {
  const normalized = String(ttl).toLowerCase();
  return (
    normalized === '0' || normalized === 'never' || normalized === 'infinite'
  );
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function durationToMs(duration: string): number | null {
  const normalized = duration.trim().toLowerCase();
  if (/^\d+$/.test(normalized)) {
    return Number(normalized) * 1000;
  }
  const match = normalized.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  const unit = match[2];
  const unitMs: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * unitMs[unit];
}

function durationToDays(duration: string): number | null {
  const ms = durationToMs(duration);
  if (!Number.isFinite(ms) || ms === null || ms <= 0) {
    return null;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil(ms / dayMs));
}

function normalizeDurationWithUnit(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!DURATION_WITH_UNIT_REGEX.test(normalized)) {
    return null;
  }
  return normalized;
}

export function getAccessTokenTtl(): TokenExpiresIn {
  const ttl =
    process.env.ACCESS_TOKEN_TTL?.trim() || process.env.JWT_EXPIRES_IN?.trim();
  return (ttl || DEFAULT_ACCESS_TOKEN_TTL) as TokenExpiresIn;
}

function readConfigValue(
  configService: Pick<ConfigService, 'get'> | undefined,
  key: string,
): string | undefined {
  return configService?.get<string>(key)?.trim() || process.env[key]?.trim();
}

export function getJwtContract(
  configService?: Pick<ConfigService, 'get'>,
): JwtContract {
  const issuer = readConfigValue(configService, 'JWT_ISSUER');
  const audience = readConfigValue(configService, 'JWT_AUDIENCE');

  if (!issuer || !audience) {
    throw new Error('JWT_ISSUER and JWT_AUDIENCE are required');
  }

  return {
    issuer,
    audience,
    algorithms: [JWT_ALGORITHM],
  };
}

export function getJwtSignOptions(
  configService?: Pick<ConfigService, 'get'>,
): Pick<JwtContract, 'issuer' | 'audience'> {
  const { issuer, audience } = getJwtContract(configService);
  return { issuer, audience };
}

export function getJwtVerifyOptions(
  configService?: Pick<ConfigService, 'get'>,
): Pick<JwtContract, 'issuer' | 'audience' | 'algorithms'> {
  return getJwtContract(configService);
}

export function isUnsafeJwtSecret(secret: string | undefined): boolean {
  const normalized = secret?.trim() || '';
  if (normalized.length < 64) {
    return true;
  }

  if (/^(.)\1+$/.test(normalized)) {
    return true;
  }

  return /^(change|replace|placeholder|your|default|test|example)[_-]?.*secret/i.test(
    normalized,
  );
}

export function isFiniteJwtTtl(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0;
  }

  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (isInfiniteTtl(normalized as TokenExpiresIn)) {
    return false;
  }

  return durationToMs(normalized) !== null && durationToMs(normalized)! > 0;
}

export function getAccessTokenSecret(
  configService?: Pick<ConfigService, 'get'>,
): string {
  const secret = readConfigValue(configService, 'JWT_SECRET');
  if (!secret) {
    throw new Error('JWT_SECRET is required');
  }
  return secret;
}

export function getRefreshTokenSecret(
  configService?: Pick<ConfigService, 'get'>,
): string {
  const refreshSecret = readConfigValue(configService, 'JWT_REFRESH_SECRET');

  if (!refreshSecret) {
    throw new Error('JWT_REFRESH_SECRET is required');
  }

  return refreshSecret;
}

export function getAccessTokenCookieMaxAgeMs(): number {
  const ttl = getAccessTokenTtl();
  if (isInfiniteTtl(ttl)) {
    return 100 * 365 * 24 * 60 * 60 * 1000; // 100 anos em ms
  }
  if (typeof ttl === 'number') {
    return ttl * 1000;
  }

  const parsed = durationToMs(ttl);
  return parsed || 15 * 60 * 1000;
}

export function getAccessTokenTtlMs(): number | null {
  const ttl = getAccessTokenTtl();
  if (isInfiniteTtl(ttl)) {
    return null;
  }
  if (typeof ttl === 'number') {
    return ttl * 1000;
  }
  return durationToMs(ttl);
}

export function getRefreshTokenTtlDays(): number {
  const refreshTtl = normalizeDurationWithUnit(
    process.env.REFRESH_TOKEN_TTL?.trim(),
  );
  if (refreshTtl) {
    const refreshTtlDays = durationToDays(refreshTtl);
    if (refreshTtlDays) {
      return Math.min(refreshTtlDays, 3650);
    }
  }

  const rawDays = process.env.REFRESH_TOKEN_TTL_DAYS?.trim();
  if (rawDays === '0' || rawDays === 'never') {
    return DEFAULT_REFRESH_TOKEN_TTL_DAYS;
  }
  if (rawDays) {
    return parsePositiveInt(rawDays, DEFAULT_REFRESH_TOKEN_TTL_DAYS, 3650);
  }

  // Compatibilidade com variáveis legadas em produção:
  // JWT_REFRESH_EXPIRATION=7d (ou 12h, 30m, etc.)
  const legacyTtl = process.env.JWT_REFRESH_EXPIRATION?.trim();
  if (legacyTtl) {
    const legacyDays = durationToDays(legacyTtl);
    if (legacyDays) {
      return Math.min(legacyDays, 3650);
    }
  }

  return DEFAULT_REFRESH_TOKEN_TTL_DAYS;
}

export function getRefreshTokenTtl(): TokenExpiresIn {
  const refreshTtl = normalizeDurationWithUnit(
    process.env.REFRESH_TOKEN_TTL?.trim(),
  );
  if (refreshTtl) {
    return refreshTtl as TokenExpiresIn;
  }
  return `${getRefreshTokenTtlDays()}d` as TokenExpiresIn;
}

export function getRefreshTokenCookieMaxAgeMs(): number {
  return getRefreshTokenTtlDays() * 24 * 60 * 60 * 1000;
}

export function getRefreshTokenCookieSameSite(): RefreshCookieSameSite {
  const raw = (
    process.env.AUTH_COOKIE_SAMESITE ||
    process.env.REFRESH_TOKEN_COOKIE_SAMESITE ||
    ''
  )
    .trim()
    .toLowerCase();

  if (raw === 'none' || raw === 'lax' || raw === 'strict') {
    return raw;
  }

  return process.env.NODE_ENV === 'production' ? 'strict' : 'lax';
}

export function getRefreshTokenCookieSecure(): boolean {
  const raw = (
    process.env.AUTH_COOKIE_SECURE ||
    process.env.REFRESH_TOKEN_COOKIE_SECURE ||
    ''
  )
    .trim()
    .toLowerCase();

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // SameSite=None exige Secure nos navegadores modernos.
  if (getRefreshTokenCookieSameSite() === 'none') {
    return true;
  }

  return process.env.NODE_ENV === 'production';
}

export function getRefreshTokenCookieDomain(): string | undefined {
  const value = (
    process.env.AUTH_COOKIE_DOMAIN ||
    process.env.REFRESH_TOKEN_COOKIE_DOMAIN ||
    ''
  ).trim();
  return value || undefined;
}

export function getRefreshTokenCookieOptions(): CookieOptions {
  const domain = getRefreshTokenCookieDomain();
  return {
    httpOnly: true,
    secure: getRefreshTokenCookieSecure(),
    sameSite: getRefreshTokenCookieSameSite(),
    maxAge: getRefreshTokenCookieMaxAgeMs(),
    path: REFRESH_TOKEN_COOKIE_PATH,
    ...(domain ? { domain } : {}),
  };
}

export function getRefreshTokenClearCookieOptions(): CookieOptions {
  const domain = getRefreshTokenCookieDomain();
  return {
    httpOnly: true,
    secure: getRefreshTokenCookieSecure(),
    sameSite: getRefreshTokenCookieSameSite(),
    path: REFRESH_TOKEN_COOKIE_PATH,
    ...(domain ? { domain } : {}),
  };
}

export function getLegacyRefreshTokenClearCookieOptions(): CookieOptions {
  const domain = getRefreshTokenCookieDomain();
  return {
    httpOnly: true,
    secure: getRefreshTokenCookieSecure(),
    sameSite: getRefreshTokenCookieSameSite(),
    path: LEGACY_REFRESH_TOKEN_COOKIE_PATH,
    ...(domain ? { domain } : {}),
  };
}

export function getRefreshCsrfCookieOptions(): CookieOptions {
  const domain = getRefreshTokenCookieDomain();
  return {
    httpOnly: false,
    secure: getRefreshTokenCookieSecure(),
    sameSite: getRefreshTokenCookieSameSite(),
    maxAge: getRefreshTokenCookieMaxAgeMs(),
    // O frontend SPA precisa ler este cookie em rotas como /dashboard para
    // refletir o valor no header x-refresh-csrf ao chamar /auth/refresh.
    path: REFRESH_CSRF_COOKIE_PATH,
    ...(domain ? { domain } : {}),
  };
}

export function getRequestCsrfCookieOptions(): CookieOptions {
  const domain = getRefreshTokenCookieDomain();
  return {
    httpOnly: false,
    secure: getRefreshTokenCookieSecure(),
    sameSite: getRefreshTokenCookieSameSite(),
    path: '/',
    ...(domain ? { domain } : {}),
  };
}

export function getLegacyRequestCsrfClearCookieOptions(): CookieOptions {
  return {
    path: '/',
  };
}

export function getRefreshCsrfClearCookieOptions(): CookieOptions {
  const domain = getRefreshTokenCookieDomain();
  return {
    httpOnly: false,
    secure: getRefreshTokenCookieSecure(),
    sameSite: getRefreshTokenCookieSameSite(),
    path: REFRESH_CSRF_COOKIE_PATH,
    ...(domain ? { domain } : {}),
  };
}

export function getLegacyRefreshCsrfClearCookieOptions(): CookieOptions {
  const domain = getRefreshTokenCookieDomain();
  return {
    httpOnly: false,
    secure: getRefreshTokenCookieSecure(),
    sameSite: getRefreshTokenCookieSameSite(),
    path: LEGACY_REFRESH_CSRF_COOKIE_PATH,
    ...(domain ? { domain } : {}),
  };
}

export function isRefreshCsrfEnforced(): boolean {
  const raw = (process.env.REFRESH_CSRF_ENFORCED || '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

export function isRefreshCsrfReportOnly(): boolean {
  const raw = (process.env.REFRESH_CSRF_REPORT_ONLY || '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return false;
}

export function getMaxActiveSessionsPerUser(): number {
  return parsePositiveInt(
    process.env.MAX_ACTIVE_SESSIONS_PER_USER,
    DEFAULT_MAX_ACTIVE_SESSIONS_PER_USER,
    100,
  );
}
