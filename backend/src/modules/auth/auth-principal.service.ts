import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as jwt from 'jsonwebtoken';
import {
  SecurityAuditService,
  SecurityEventType,
  SecuritySeverity,
} from '../../shared/security/security-audit.service';
import {
  NormalizedAccessTokenClaims,
  assertJwtHasExpiration,
  assertJwtTokenType,
  normalizeAccessTokenClaims,
  resolveAccessTokenSecret,
} from './utils/access-token-claims.util';
import {
  getJwtVerifyOptions,
  JWT_ACCESS_TOKEN_TYPE,
} from './auth-security.config';
import { decryptSensitiveValue } from '../../shared/security/field-encryption.util';

export type AuthenticatedPrincipal = {
  id: string;
  userId: string;
  sub: string;
  app_user_id: string;
  jti?: string;
  authUserId?: string;
  auth_user_id?: string;
  cpf?: string;
  company_id?: string;
  companyId?: string;
  site_id?: string;
  siteId?: string;
  siteIds?: string[];
  profile?: { nome: string };
  plan?: string;
  isSuperAdmin: boolean;
  tokenSource: 'local';
};

type UserBridgeRecord = {
  id: string;
  authUserId?: string | null;
  cpf?: string | null;
  companyId?: string | null;
  siteId?: string | null;
  siteIds?: string[];
  profileName?: string | null;
};

type JwtVerifyResult = string | jwt.JwtPayload;

type UserBridgeQueryRow = {
  id: string;
  auth_user_id?: string | null;
  cpf?: string | null;
  cpf_ciphertext?: string | null;
  company_id?: string | null;
  site_id?: string | null;
  site_ids?: string[] | null;
  profile_nome?: string | null;
};

@Injectable()
export class AuthPrincipalService {
  private readonly logger = new Logger(AuthPrincipalService.name);
  private readonly bridgeCache = new Map<
    string,
    { value: UserBridgeRecord; expiresAt: number }
  >();
  private readonly bridgeLookupsInFlight = new Map<
    string,
    Promise<UserBridgeRecord | null>
  >();

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly securityAudit: SecurityAuditService,
  ) {}

  async verifyAndResolveAccessToken(
    token: string,
  ): Promise<AuthenticatedPrincipal> {
    const payload = this.verifyAccessToken(token);
    return this.resolveAccessPrincipal(payload);
  }

  async resolveAccessPrincipal(
    payload: Record<string, unknown>,
  ): Promise<AuthenticatedPrincipal> {
    const normalized = this.normalizeBaseClaims(payload);
    const claimCache = normalized.token_claim_cache;
    const claimedAppUserId =
      claimCache.app_user_id || normalized.app_user_id || normalized.userId;
    const claimedAuthUserId =
      claimCache.auth_user_id || normalized.auth_user_id;

    const bridge = await this.findUserBridge({
      authUserId: claimedAuthUserId,
      appUserId: claimedAppUserId,
    });

    if (!bridge?.id) {
      this.logger.warn({
        event: 'auth_principal_unresolved',
        tokenSource: 'local',
        authUserId: claimedAuthUserId || null,
        appUserId: claimedAppUserId || null,
      });
      throw new UnauthorizedException(
        'Token inválido: usuário da aplicação não resolvido.',
      );
    }

    this.assertTokenClaimsIntegrity({
      bridge,
      claimCache,
      claimedAppUserId,
      claimedAuthUserId,
    });

    const appUserId = bridge.id;
    const authUserId = bridge.authUserId || claimedAuthUserId;
    const cpf = bridge.cpf || normalized.cpf;
    const companyId = bridge.companyId || undefined;
    const siteId = bridge.siteId || undefined;
    const siteIds = bridge.siteIds ?? (siteId ? [siteId] : []);
    const profileName = bridge.profileName || undefined;
    const plan = normalized.plan;
    const isSuperAdmin = isSuperAdminProfileName(profileName);

    return {
      id: appUserId,
      userId: appUserId,
      sub: appUserId,
      app_user_id: appUserId,
      jti: normalized.jti,
      authUserId,
      auth_user_id: authUserId,
      cpf,
      company_id: companyId,
      companyId,
      site_id: siteId,
      siteId,
      siteIds,
      profile: profileName ? { nome: profileName } : undefined,
      plan,
      isSuperAdmin,
      tokenSource: 'local',
    };
  }

  private verifyAccessToken(token: string): Record<string, unknown> {
    const secret = resolveAccessTokenSecret(this.configService);
    const verified = this.verifyJwt(token, secret);
    assertJwtTokenType(verified, JWT_ACCESS_TOKEN_TYPE);
    assertJwtHasExpiration(verified);
    if (verified && typeof verified === 'object' && !Array.isArray(verified)) {
      return verified;
    }
    throw new UnauthorizedException('Token inválido');
  }

  private verifyJwt(token: string, secret: string): JwtVerifyResult | null {
    try {
      return jwt.verify(token, secret, getJwtVerifyOptions(this.configService));
    } catch {
      return null;
    }
  }

  private normalizeBaseClaims(
    payload: Record<string, unknown>,
  ): NormalizedAccessTokenClaims {
    const claims = normalizeAccessTokenClaims(payload);

    return {
      ...claims,
      app_user_id: claims.app_user_id,
    };
  }

  private assertTokenClaimsIntegrity(params: {
    bridge: UserBridgeRecord;
    claimCache: NormalizedAccessTokenClaims['token_claim_cache'];
    claimedAppUserId?: string;
    claimedAuthUserId?: string;
  }): void {
    const { bridge, claimCache, claimedAppUserId, claimedAuthUserId } = params;
    const mismatchMetadata: Record<string, unknown> = {
      tokenSource: 'local',
      userId: bridge.id,
      claimCompanyId: claimCache.company_id ?? null,
      claimSiteId: claimCache.site_id ?? null,
      claimProfileName: claimCache.profile_name ?? null,
      dbCompanyId: bridge.companyId ?? null,
      dbSiteId: bridge.siteId ?? null,
      dbProfileName: bridge.profileName ?? null,
    };

    const hasAppUserMismatch =
      Boolean(claimedAppUserId) && claimedAppUserId !== bridge.id;
    const hasAuthUserMismatch =
      Boolean(claimedAuthUserId) &&
      Boolean(bridge.authUserId) &&
      claimedAuthUserId !== bridge.authUserId;
    const hasCompanyMismatch =
      Boolean(claimCache.company_id) &&
      claimCache.company_id !== bridge.companyId;
    const hasSiteMismatch =
      Boolean(claimCache.site_id) && claimCache.site_id !== bridge.siteId;

    if (hasAppUserMismatch || hasAuthUserMismatch || hasCompanyMismatch) {
      this.securityAudit.emit({
        event: SecurityEventType.CROSS_TENANT_ATTEMPT,
        severity: SecuritySeverity.CRITICAL,
        userId: bridge.id,
        metadata: {
          ...mismatchMetadata,
          mismatchType: {
            appUserId: hasAppUserMismatch,
            authUserId: hasAuthUserMismatch,
            companyId: hasCompanyMismatch,
            siteId: hasSiteMismatch,
          },
        },
      });

      if (hasCompanyMismatch && bridge.companyId && claimCache.company_id) {
        this.securityAudit.tenantMismatch(
          bridge.id,
          bridge.companyId,
          claimCache.company_id,
        );
      }

      this.logger.warn({
        event: 'auth_token_claim_mismatch_blocked',
        ...mismatchMetadata,
      });
      throw new UnauthorizedException(
        'Token inválido: divergência de contexto de acesso.',
      );
    }

    const hasProfileMismatch =
      Boolean(claimCache.profile_name) &&
      Boolean(bridge.profileName) &&
      claimCache.profile_name !== bridge.profileName;
    if (hasProfileMismatch) {
      this.securityAudit.emit({
        event: SecurityEventType.ROLE_CHANGED,
        severity: SecuritySeverity.WARNING,
        userId: bridge.id,
        metadata: {
          ...mismatchMetadata,
          mismatchType: { profileName: true },
          action: 'profile_claim_overridden_by_db',
        },
      });
      this.logger.warn({
        event: 'auth_profile_claim_mismatch_overridden',
        ...mismatchMetadata,
      });
    }

    // Divergência de obra (site): o banco é a fonte da verdade — o bridge
    // (find_user_bridge) é quem alimenta RLS e escopo de obra em todo request.
    // O claim de site no token é apenas um hint congelado no login; quando o
    // admin move o usuário de obra, ele diverge até a sessão ser renovada.
    // Tratamos como override (igual ao profile), nunca como bloqueio — evita o
    // 401 espúrio "divergência de contexto de acesso" e o refresh já re-emite
    // o token com a obra atual do banco.
    if (hasSiteMismatch) {
      this.securityAudit.emit({
        event: SecurityEventType.ROLE_CHANGED,
        severity: SecuritySeverity.WARNING,
        userId: bridge.id,
        metadata: {
          ...mismatchMetadata,
          mismatchType: { siteId: true },
          action: 'site_claim_overridden_by_db',
        },
      });
      this.logger.warn({
        event: 'auth_site_claim_mismatch_overridden',
        ...mismatchMetadata,
      });
    }
  }

  private async findUserBridge(params: {
    authUserId?: string;
    appUserId?: string;
  }): Promise<UserBridgeRecord | null> {
    if (!params.authUserId && !params.appUserId) {
      return null;
    }

    const cacheKeys = this.getBridgeCacheKeys(params);
    for (const cacheKey of cacheKeys) {
      const cached = this.readBridgeCache(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const inflightKey = cacheKeys[0];
    const inFlightLookup = this.bridgeLookupsInFlight.get(inflightKey);
    if (inFlightLookup) {
      return inFlightLookup;
    }

    const lookupPromise = this.lookupUserBridge(params)
      .then((result) => {
        if (result) {
          this.writeBridgeCache(result);
        }
        return result;
      })
      .finally(() => {
        this.bridgeLookupsInFlight.delete(inflightKey);
      });

    this.bridgeLookupsInFlight.set(inflightKey, lookupPromise);
    return lookupPromise;
  }

  /**
   * Invalida o cache em memória do bridge (e lookups em andamento) de um usuário.
   * Deve ser chamado sempre que a obra/empresa/perfil do usuário for alterada
   * administrativamente, para que o próximo request resolva o escopo no banco.
   */
  invalidateBridgeCache(params: {
    authUserId?: string;
    appUserId?: string;
  }): void {
    for (const cacheKey of this.getBridgeCacheKeys(params)) {
      this.bridgeCache.delete(cacheKey);
      this.bridgeLookupsInFlight.delete(cacheKey);
    }
  }

  /**
   * Resolve os dados atuais de contexto do usuário DIRECTAMENTE no banco
   * (sem cache), usado pelo refresh de token para re-emitir claims atualizadas
   * (ex.: obra trocada pelo admin enquanto a sessão estava ativa).
   */
  async resolveCurrentUserContext(params: {
    authUserId?: string;
    appUserId?: string;
  }): Promise<{
    siteId?: string;
    siteIds?: string[];
    companyId?: string;
    profileName?: string;
  } | null> {
    const bridge = await this.lookupUserBridge(params);
    if (!bridge) {
      return null;
    }
    return {
      siteId: bridge.siteId ?? undefined,
      siteIds: bridge.siteIds,
      companyId: bridge.companyId ?? undefined,
      profileName: bridge.profileName ?? undefined,
    };
  }

  private async lookupUserBridge(params: {
    authUserId?: string;
    appUserId?: string;
  }): Promise<UserBridgeRecord | null> {
    const rows = (await this.dataSource.query(
      `SELECT * FROM find_user_bridge($1::uuid, $2::uuid)`,
      [params.appUserId || null, params.authUserId || null],
    )) as unknown;

    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    const user = rows[0] as UserBridgeQueryRow;
    return {
      id: user.id,
      authUserId: user.auth_user_id,
      cpf: user.cpf_ciphertext
        ? decryptSensitiveValue(user.cpf_ciphertext)
        : user.cpf,
      companyId: user.company_id,
      siteId: user.site_id,
      siteIds: this.normalizeBridgeSiteIds(user.site_ids, user.site_id),
      profileName: user.profile_nome || undefined,
    };
  }

  private normalizeBridgeSiteIds(
    siteIds: string[] | null | undefined,
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

  private readBridgeCache(cacheKey: string): UserBridgeRecord | null {
    const cached = this.bridgeCache.get(cacheKey);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.bridgeCache.delete(cacheKey);
      return null;
    }

    return cached.value;
  }

  private writeBridgeCache(record: UserBridgeRecord): void {
    const ttlMs = this.getBridgeCacheTtlMs();
    if (ttlMs <= 0) {
      return;
    }

    const expiresAt = Date.now() + ttlMs;
    for (const cacheKey of this.getBridgeCacheKeys({
      authUserId: record.authUserId || undefined,
      appUserId: record.id,
    })) {
      this.bridgeCache.set(cacheKey, {
        value: record,
        expiresAt,
      });
    }
  }

  private getBridgeCacheKeys(params: {
    authUserId?: string;
    appUserId?: string;
  }): string[] {
    const keys = [
      params.authUserId
        ? `auth-principal:bridge:auth:${params.authUserId}`
        : null,
      params.appUserId ? `auth-principal:bridge:app:${params.appUserId}` : null,
    ].filter((value): value is string => Boolean(value));

    return keys.length > 0 ? keys : ['auth-principal:bridge:unknown'];
  }

  private getBridgeCacheTtlMs(): number {
    const raw = Number(
      process.env.AUTH_PRINCIPAL_BRIDGE_CACHE_TTL_SECONDS || 60,
    );

    if (!Number.isFinite(raw) || raw <= 0) {
      return 0;
    }

    return Math.min(Math.floor(raw), 300) * 1000;
  }
}

export function isSuperAdminProfileName(profileName?: string): boolean {
  const normalized = String(profileName || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');

  // ADMIN_GERAL é administrador do próprio tenant, não plataforma.
  // Somente o papel explícito SUPER_ADMIN pode abrir contexto global.
  return normalized === 'SUPER_ADMIN';
}
