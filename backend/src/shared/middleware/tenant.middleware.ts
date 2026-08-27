import {
  Injectable,
  NestMiddleware,
  ForbiddenException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { TenantService } from '../tenant/tenant.service';
import { Role } from '../../modules/auth/enums/roles.enum';
import { normalizeRoleName } from '../../modules/auth/role-normalization.util';
import {
  normalizeTenantRateLimitPlan,
  TenantRateLimitPlan,
} from '../rate-limit/tenant-rate-limit.service';
import { requestContextStorage } from './request-context.middleware';
import { AuthPrincipalService } from '../../modules/auth/auth-principal.service';
import type { AuthenticatedPrincipal } from '../../modules/auth/auth-principal.service';
import { TenantValidationService } from '../tenant/tenant-validation.service';
import { SecurityAuditService } from '../security/security-audit.service';
import { sanitizeLogUrl } from '../logging/log-sanitizer.util';
import { getRequestIp } from '../utils/request-ip.util';

type TenantInfo = {
  companyId?: string;
  isSuperAdmin: boolean;
  plan: TenantRateLimitPlan;
  userId?: string;
  siteId?: string;
  siteIds?: string[];
  siteScope?: 'single' | 'all';
};

export interface TenantRequest extends Request {
  tenant?: TenantInfo;
  authPrincipal?: AuthenticatedPrincipal;
}

const GLOBAL_TENANT_OPTIONAL_PATHS = [
  /^\/admin(?:\/.*)?$/,
  /^\/companies(?:\/[^/]+)?$/,
  /^\/profiles(?:\/[^/]+)?$/,
  /^\/sessions(?:\/[^/]+)?$/,
] as const;

/**
 * Extrai o contexto de tenant do JWT e o armazena na AsyncLocalStorage.
 *
 * Responsabilidades (apenas):
 *  1. Decodificar o JWT (Authorization header).
 *  2. Extrair company_id e isSuperAdmin.
 *  3. Validar que o header x-company-id não diverge do JWT (anti-spoofing).
 *  4. Chamar tenantService.run() para isolar o contexto nesta requisição.
 *
 * O que este middleware NÃO faz mais:
 *  - Abrir queryRunners ou transações (gerava conexão extra por request).
 *  - Chamar SET/RESET no banco (responsabilidade do TenantDbContextService).
 *  - Validar autenticação (responsabilidade do JwtAuthGuard).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantMiddleware.name);

  constructor(
    private readonly tenantService: TenantService,
    private readonly authPrincipalService: AuthPrincipalService,
    private readonly tenantValidationService: TenantValidationService,
    private readonly securityAudit: SecurityAuditService,
  ) {}

  async use(req: TenantRequest, _res: Response, next: NextFunction) {
    const token = this.extractToken(req);
    const requireExplicitForSuperAdmin =
      process.env.REQUIRE_EXPLICIT_TENANT_FOR_SUPER_ADMIN === 'true';
    const sanitizedRequestPath =
      sanitizeLogUrl(req.originalUrl || req.url || req.path || '').split(
        '?',
      )[0] || '/';

    let companyId: string | undefined;
    let isSuperAdmin = false;
    let tenantPlan: TenantRateLimitPlan =
      normalizeTenantRateLimitPlan(undefined);
    let principal: AuthenticatedPrincipal | undefined;

    if (token) {
      try {
        try {
          principal =
            await this.authPrincipalService.verifyAndResolveAccessToken(token);
        } catch {
          principal = undefined;
        }

        if (!principal) {
          companyId = undefined;
          isSuperAdmin = false;
          tenantPlan = normalizeTenantRateLimitPlan(undefined);
          throw new Error('access_token_invalid_or_unsupported');
        }
        req.authPrincipal = principal;
        const requestContext = requestContextStorage.getStore();
        if (requestContext) {
          requestContext.set('userId', principal.userId);
          requestContext.set('authUserId', principal.authUserId);
          requestContext.set('authPrincipal', principal);
          requestContext.set('siteId', principal.siteId ?? principal.site_id);
          requestContext.set('siteIds', principal.siteIds ?? []);
          requestContext.set('profileName', principal.profile?.nome);
        }

        companyId = principal.companyId;
        tenantPlan = normalizeTenantRateLimitPlan(principal.plan);
        // ADMIN_GERAL é administrador do próprio tenant, não plataforma.
        // Somente o principal reconciliado como SUPER_ADMIN pode selecionar
        // outro tenant ou abrir contexto global.
        isSuperAdmin = principal.isSuperAdmin;

        // SECURITY: JWT tem company_id mas header diverge → 403 sem detalhes.
        const headerCompanyId = req.headers['x-company-id'] as
          string | undefined;

        if (isSuperAdmin) {
          if (headerCompanyId) {
            this.logger.log({
              event: 'tenant_switch',
              userId: principal.userId,
              tenantId: headerCompanyId,
              ip: getRequestIp(req),
              path: sanitizedRequestPath,
            });
            // Registra acesso cross-tenant na forensic trail para auditoria
            this.securityAudit.adminAction(
              principal.userId,
              `tenant_switch:${headerCompanyId}`,
              undefined,
              headerCompanyId,
            );
            companyId = headerCompanyId;
          } else {
            if (
              requireExplicitForSuperAdmin &&
              !this.allowsMissingExplicitTenant(req)
            ) {
              this.logger.warn({
                event: 'super_admin_missing_explicit_tenant',
                userId: principal.userId,
                ip: getRequestIp(req),
                path: sanitizedRequestPath,
              });
              throw new UnauthorizedException(
                'Administrador Geral deve informar o tenant via header x-company-id.',
              );
            }

            // Auth self-service (/auth/me, /auth/logout, etc.): usa o companyId
            // do próprio principal para que o RLS encontre o usuário corretamente
            // (SELECT users WHERE id = ? AND company_id = ?).
            // Demais rotas globais opcionais mantêm undefined somente para o
            // principal SUPER_ADMIN explícito.
            companyId = this.isAuthSelfServiceRoute(req)
              ? principal.companyId
              : undefined;
          }
        } else {
          // Usuário comum:
          // - Nunca confiar no header `x-company-id` se divergir do tenant do JWT.
          // - Se header existir, deve ser exatamente o tenant do JWT.
          if (!companyId && headerCompanyId) {
            this.logger.warn({
              event: 'cross_tenant_spoof_attempt',
              severity: 'HIGH',
              userId: principal.userId,
              headerCompanyId,
              tokenCompanyId: null,
              ip: getRequestIp(req),
              method: req.method,
              path: sanitizedRequestPath,
              userAgent: (req.headers['user-agent'] as string)?.slice(0, 200),
              timestamp: new Date().toISOString(),
            });
            throw new ForbiddenException();
          }

          if (companyId && headerCompanyId && headerCompanyId !== companyId) {
            this.logger.warn({
              event: 'cross_tenant_spoof_attempt',
              severity: 'CRITICAL',
              userId: principal.userId,
              tokenCompanyId: companyId,
              headerCompanyId,
              ip: getRequestIp(req),
              method: req.method,
              path: sanitizedRequestPath,
              userAgent: (req.headers['user-agent'] as string)?.slice(0, 200),
              timestamp: new Date().toISOString(),
            });
            throw new ForbiddenException();
          }
        }
      } catch (err) {
        if (
          err instanceof ForbiddenException ||
          err instanceof UnauthorizedException
        ) {
          throw err;
        }
        // Token inválido/expirado → sem contexto. JwtAuthGuard bloqueará rotas protegidas.
        companyId = undefined;
        isSuperAdmin = false;
      }
    }

    // Validação do tenant:
    // - Usuário comum: company_id sempre deve existir e apontar para uma empresa válida/ativa.
    // - Admin geral: valida apenas quando escolhe um tenant (via header x-company-id).
    if (companyId) {
      await this.tenantValidationService.assertTenantIsValid(companyId);
    }

    const siteScope = this.resolveSiteScope(
      principal?.profile?.nome,
      isSuperAdmin,
    );

    // Expor no request (facilita uso em controllers/guards sem depender de req.user).
    req.tenant = {
      companyId,
      isSuperAdmin,
      plan: tenantPlan,
      userId: req.authPrincipal?.userId,
      siteId: req.authPrincipal?.siteId ?? req.authPrincipal?.site_id,
      siteIds: req.authPrincipal?.siteIds ?? [],
      siteScope,
    };
    const requestContext = requestContextStorage.getStore();
    if (requestContext) {
      requestContext.set('companyId', companyId);
      requestContext.set('tenantPlan', tenantPlan);
      requestContext.set('isSuperAdmin', isSuperAdmin);
    }

    // Propaga o contexto para toda a cadeia async desta requisição via Node.js
    // AsyncLocalStorage. O TenantDbContextService lê este contexto no
    // pool.connect() e injeta app.current_company_id/app.is_super_admin.
    this.tenantService.run(
      {
        companyId,
        isSuperAdmin,
        userId: req.authPrincipal?.userId,
        siteId: req.authPrincipal?.siteId ?? req.authPrincipal?.site_id,
        siteIds: req.authPrincipal?.siteIds ?? [],
        siteScope,
      },
      () => next(),
    );
  }

  private extractToken(req: Request): string | undefined {
    const bearer = req.headers['authorization'];
    return bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined;
  }

  private isAuthSelfServiceRoute(req: Request): boolean {
    const method = req.method.toUpperCase();
    const requestUrl = req.originalUrl || req.url || req.path || '';
    const path = requestUrl.split('?')[0].replace(/\/+$/, '') || '/';

    return (
      (method === 'GET' && path === '/auth/csrf') ||
      (method === 'GET' && path === '/auth/me') ||
      (method === 'GET' && path === '/auth/mfa/status') ||
      (method === 'POST' && path === '/auth/logout') ||
      (method === 'POST' && path === '/auth/change-password') ||
      (method === 'POST' && path === '/auth/mfa/enroll') ||
      (method === 'POST' && path === '/auth/mfa/activate') ||
      (method === 'POST' && path === '/auth/mfa/recovery-codes/regenerate') ||
      (method === 'POST' && path === '/auth/mfa/disable') ||
      (method === 'POST' && path === '/auth/confirm-password') ||
      (method === 'POST' && path === '/auth/step-up/verify')
    );
  }

  private allowsMissingExplicitTenant(req: Request): boolean {
    const requestUrl = req.originalUrl || req.url || req.path || '';
    const path = requestUrl.split('?')[0].replace(/\/+$/, '') || '/';

    const isGlobalTenantOptionalPath = GLOBAL_TENANT_OPTIONAL_PATHS.some(
      (pattern) => pattern.test(path),
    );

    return this.isAuthSelfServiceRoute(req) || isGlobalTenantOptionalPath;
  }

  private resolveSiteScope(
    profileName: string | undefined,
    isSuperAdmin: boolean,
  ): 'single' | 'all' {
    if (isSuperAdmin) {
      return 'all';
    }

    const normalizedProfile = normalizeRoleName(profileName);
    if (
      normalizedProfile === Role.ADMIN_GERAL ||
      normalizedProfile === Role.ADMIN_EMPRESA
    ) {
      return 'all';
    }

    return 'single';
  }
}
