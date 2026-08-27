import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { TenantService } from '../tenant/tenant.service';
import {
  normalizeTenantRateLimitPlan,
  TenantRateLimitPlan,
  TenantRateLimitService,
} from '../rate-limit/tenant-rate-limit.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TenantRequest } from '../middleware/tenant.middleware';
import {
  TENANT_THROTTLE_KEY,
  TenantThrottleOptions,
} from '../decorators/tenant-throttle.decorator';
import { sanitizeLogUrl } from '../logging/log-sanitizer.util';
import { getRequestIp } from '../utils/request-ip.util';

type TenantRateLimitRequest = TenantRequest & {
  method?: string;
  baseUrl?: string;
  path?: string;
  route?: { path?: unknown };
  originalUrl?: string;
  url?: string;
  ip?: string;
};

export const getTenantPlan = (
  request: TenantRateLimitRequest,
): TenantRateLimitPlan => {
  return normalizeTenantRateLimitPlan(request.tenant?.plan);
};

const normalizeRequestPath = (rawPath: string | undefined): string => {
  if (!rawPath) {
    return '/';
  }

  const sanitized = sanitizeLogUrl(rawPath);
  const pathOnly = sanitized.split('?')[0]?.trim();
  return pathOnly || '/';
};

export const getTenantRateLimitRoute = (
  request: TenantRateLimitRequest,
): string => {
  const method =
    typeof request.method === 'string' ? request.method.toUpperCase() : 'GET';
  const routeValue = request.route as { path?: unknown } | undefined;
  const routePath =
    typeof routeValue?.path === 'string'
      ? `${request.baseUrl || ''}${routeValue.path}`
      : request.path || request.originalUrl || request.url || '/';
  return `${method}:${normalizeRequestPath(routePath)}`;
};

/**
 * Guard global de rate limiting por tenant (company_id).
 *
 * - Protege o sistema contra abuso de um único tenant
 * - Responde com 429 Too Many Requests + headers informativos
 * - Rotas públicas (@Public()) são ignoradas
 *
 * O plano padrão operacional é configurável por TENANT_RATE_LIMIT_DEFAULT_PLAN
 * e, na ausência de configuração, cai para STARTER. Se no futuro o token carregar
 * um plano explícito, o middleware de tenant já propaga esse valor com segurança.
 */
@Injectable()
export class TenantRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(TenantRateLimitGuard.name);

  constructor(
    private readonly tenantService: TenantService,
    private readonly rateLimitService: TenantRateLimitService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const companyId = this.tenantService.getTenantId();

    // Sem tenant no contexto — deixa TenantGuard tratar
    if (!companyId) return true;

    const request = context.switchToHttp().getRequest<TenantRateLimitRequest>();
    const plan = getTenantPlan(request);
    const sanitizedPath = normalizeRequestPath(
      request.originalUrl || request.url || request.path || '/',
    );

    // Verificar se a rota define limites customizados (@TenantThrottle)
    const routeOverrideRaw = this.reflector.getAllAndOverride<
      TenantThrottleOptions | undefined
    >(TENANT_THROTTLE_KEY, [context.getHandler(), context.getClass()]);
    const routeOverride =
      routeOverrideRaw && typeof routeOverrideRaw === 'object'
        ? routeOverrideRaw
        : undefined;
    const routeKey = routeOverride
      ? getTenantRateLimitRoute(request)
      : undefined;

    let result: Awaited<ReturnType<TenantRateLimitService['checkLimit']>>;
    try {
      result = await this.rateLimitService.checkLimit(
        companyId,
        plan,
        routeOverride,
        routeKey,
      );
    } catch (error) {
      // SECURITY: Never silently allow requests when Redis-backed tenant throttling is unhealthy.
      this.logger.error({
        event: 'tenant_rate_limit_storage_unavailable',
        companyId,
        plan,
        method: request.method,
        path: sanitizedPath,
        ip: getRequestIp(request),
        errorName:
          error instanceof Error ? error.name : 'RateLimitStorageError',
        message: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableException(
        'Proteção de rate limit temporariamente indisponível. Tente novamente em instantes.',
      );
    }

    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('X-RateLimit-Limit', String(result.limit));
    response.setHeader('X-RateLimit-Remaining', String(result.remaining));
    response.setHeader('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      if (result.retryAfter) {
        response.setHeader('Retry-After', String(result.retryAfter));
      }

      this.logger.warn({
        event: 'tenant_rate_limit_exceeded',
        companyId,
        plan,
        method: request.method,
        path: sanitizedPath,
        ip: getRequestIp(request),
        retryAfter: result.retryAfter ?? null,
        remaining: result.remaining,
        resetAt: result.resetAt,
        timestamp: new Date().toISOString(),
      });

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            'Limite de requisições excedido para esta empresa. Tente novamente em breve.',
          retryAfter: result.retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
