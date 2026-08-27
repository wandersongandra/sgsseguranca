import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request, Response } from 'express';
import { ResilientThrottlerService } from './resilient-throttler.service';
import type { AuthenticatedPrincipal } from '../../modules/auth/auth-principal.service';
import { getRequestIp } from '../utils/request-ip.util';

type AuthenticatedRequest = Request & {
  user?: {
    id?: string;
    userId?: string;
  };
  authPrincipal?: AuthenticatedPrincipal;
  connection?: {
    remoteAddress?: string;
  };
};

/**
 * Interceptor de Rate Limiting Resiliente
 * Pode ser aplicado em rotas específicas:
 *
 * @UseInterceptors(ResilientThrottlerInterceptor)
 * @Post('auth/login')
 * async login() { ... }
 */
@Injectable()
export class ResilientThrottlerInterceptor implements NestInterceptor {
  constructor(private readonly throttlerService: ResilientThrottlerService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!this.throttlerService.shouldThrottle(request)) {
      return next.handle();
    }

    // Extrair identificador do cliente (IP, user ID, etc)
    const identifier = this.getClientIdentifier(request);

    // Verificar se foi rate-limitado
    const result = await this.throttlerService.checkLimit(request, identifier);

    if (result.isBlocked) {
      const response = context.switchToHttp().getResponse<Response>();
      const retryAfter = Math.ceil((result.remainingTime || 60000) / 1000);

      response.setHeader('Retry-After', retryAfter.toString());
      response.setHeader('X-RateLimit-Remaining', '0');

      throw new HttpException(
        {
          statusCode: 429,
          message: 'Too many requests, please try again later',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Requisição OK - prosseguir
    return next.handle();
  }

  /**
   * Extrair identificador do cliente (IP + User ID se autenticado)
   */
  private getClientIdentifier(request: AuthenticatedRequest): string {
    // Usar User ID se autenticado (mais acurado que IP)
    const userId =
      request.user?.id ??
      request.user?.userId ??
      request.authPrincipal?.userId ??
      request.authPrincipal?.id;
    if (userId) {
      return `user:${userId}`;
    }

    // Fallback: IP resolvido pela autoridade de transporte central.
    const ip = getRequestIp(request) || 'unknown';

    return `ip:${ip}`;
  }
}
