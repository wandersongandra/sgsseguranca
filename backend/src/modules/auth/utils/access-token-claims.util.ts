import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Role } from '../enums/roles.enum';
import {
  getJwtVerifyOptions,
  JWT_ACCESS_TOKEN_TYPE,
  type JwtTokenType,
} from '../auth-security.config';

type JsonObject = Record<string, unknown>;

export interface AccessTokenClaimCache {
  app_user_id?: string;
  auth_user_id?: string;
  company_id?: string;
  site_id?: string;
  profile_name?: string;
  is_super_admin: boolean;
}

export interface NormalizedAccessTokenClaims {
  id: string;
  userId: string;
  app_user_id: string;
  auth_user_id?: string;
  jti?: string;
  cpf?: string;
  company_id?: string;
  companyId?: string;
  site_id?: string;
  siteId?: string;
  profile?: { nome: string };
  plan?: string;
  isSuperAdmin: boolean;
  // Claim cache/hints extracted from token. Never treat as source of truth.
  token_claim_cache: AccessTokenClaimCache;
}

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function getPathValue(source: JsonObject | undefined, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    const objectValue = asObject(current);
    if (!objectValue || !(segment in objectValue)) {
      return undefined;
    }
    current = objectValue[segment];
  }
  return current;
}

function readString(
  source: JsonObject | undefined,
  ...paths: string[][]
): string | undefined {
  for (const path of paths) {
    const value = getPathValue(source, path);
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function readBoolean(
  source: JsonObject | undefined,
  ...paths: string[][]
): boolean | undefined {
  for (const path of paths) {
    const value = getPathValue(source, path);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
  }
  return undefined;
}

function readProfileName(source: JsonObject | undefined): string | undefined {
  const directProfile = getPathValue(source, ['profile']);
  if (typeof directProfile === 'string' && directProfile.trim()) {
    return directProfile.trim();
  }

  const directProfileObject = asObject(directProfile);
  const directProfileName = readString(directProfileObject, ['nome'], ['name']);
  if (directProfileName) {
    return directProfileName;
  }

  return readString(source, ['profile_name'], ['profileName']);
}

export function resolveAccessTokenSecret(configService: ConfigService): string {
  const secret = configService.get<string>('JWT_SECRET')?.trim();
  if (!secret) {
    throw new Error('JWT_SECRET is required');
  }
  return secret;
}

export function normalizeAccessTokenClaims(
  payload: unknown,
): NormalizedAccessTokenClaims {
  const claims = asObject(payload);
  if (!claims) {
    throw new UnauthorizedException('Token inválido');
  }

  const jwtSub = readString(claims, ['sub']);
  if (!jwtSub) {
    throw new UnauthorizedException('Token inválido');
  }

  const tokenClaimCache = extractAccessTokenClaimCache(claims);
  const appUserId = tokenClaimCache.app_user_id ?? jwtSub;

  const explicitSuperAdmin = tokenClaimCache.is_super_admin;

  const profileName = tokenClaimCache.profile_name;
  const effectiveProfileName =
    profileName || (explicitSuperAdmin ? Role.SUPER_ADMIN : undefined);

  const companyId = tokenClaimCache.company_id;
  const siteId = tokenClaimCache.site_id;

  const authUserId = tokenClaimCache.auth_user_id;

  const cpf = readString(claims, ['cpf']);
  const plan = readString(claims, ['plan']);
  const jti = readString(claims, ['jti']);

  return {
    id: appUserId,
    userId: appUserId,
    app_user_id: appUserId,
    auth_user_id: authUserId,
    jti,
    cpf,
    company_id: companyId,
    companyId,
    site_id: siteId,
    siteId,
    profile: effectiveProfileName ? { nome: effectiveProfileName } : undefined,
    plan,
    isSuperAdmin:
      explicitSuperAdmin || effectiveProfileName === Role.SUPER_ADMIN,
    token_claim_cache: tokenClaimCache,
  };
}

export function assertJwtTokenType(
  payload: unknown,
  expected: JwtTokenType,
): void {
  const claims = asObject(payload);
  if (claims?.token_type !== expected) {
    throw new UnauthorizedException('Tipo de token inválido');
  }
}

export function assertJwtHasExpiration(payload: unknown): void {
  const claims = asObject(payload);
  if (typeof claims?.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new UnauthorizedException('Token sem expiração');
  }
}

export function extractAccessTokenClaimCache(
  payload: unknown,
): AccessTokenClaimCache {
  const claims = asObject(payload);
  if (!claims) {
    throw new UnauthorizedException('Token inválido');
  }

  const appUserId = readString(
    claims,
    ['app_user_id'],
    ['app_userId'],
    ['user_id'],
  );

  const authUserId =
    readString(claims, ['auth_uid'], ['auth_user_id']) ??
    (appUserId !== readString(claims, ['sub'])
      ? readString(claims, ['sub'])
      : undefined);

  const companyId = readString(
    claims,
    ['company_id'],
    ['companyId'],
    ['tenant_id'],
    ['tenantId'],
  );

  const siteId = readString(
    claims,
    ['site_id'],
    ['siteId'],
    ['site', 'id'],
    ['site', 'site_id'],
  );

  const profileName = readProfileName(claims);
  const isSuperAdmin =
    readBoolean(claims, ['is_super_admin'], ['isSuperAdmin']) ?? false;

  return {
    app_user_id: appUserId,
    auth_user_id: authUserId,
    company_id: companyId,
    site_id: siteId,
    profile_name: profileName,
    is_super_admin: isSuperAdmin,
  };
}

export function verifyAccessTokenClaims(
  jwtService: JwtService,
  configService: ConfigService,
  token: string,
): NormalizedAccessTokenClaims {
  const payload = jwtService.verify(token, {
    secret: resolveAccessTokenSecret(configService),
    ...getJwtVerifyOptions(configService),
  }) as unknown;

  assertJwtTokenType(payload, JWT_ACCESS_TOKEN_TYPE);
  assertJwtHasExpiration(payload);

  return normalizeAccessTokenClaims(payload);
}
