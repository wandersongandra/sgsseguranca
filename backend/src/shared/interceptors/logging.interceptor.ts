import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { RequestContext } from '../middleware/request-context.middleware';
import {
  maskCpf,
  maskEmail,
  maskSensitiveText,
  sanitizeLogUrl,
  sanitizeLogValue,
} from '../logging/log-sanitizer.util';
import { getRequestIp } from '../utils/request-ip.util';

interface RequestWithUser extends Request {
  user?: {
    userId?: string;
    company_id?: string;
  };
  requestId?: string;
  requestStartAt?: number;
  traceId?: string;
  sentryTraceId?: string;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const method = request.method;
    const url = sanitizeLogUrl(request.url);
    const body = request.body as Record<string, unknown> | null;
    const headers = request.headers;
    const ip = getRequestIp(request) || '';
    const userAgent = (headers['user-agent'] as string) || '';
    const requestId =
      request.requestId ||
      (request.headers['x-request-id'] as string) ||
      'unknown';
    const isAuthRoute = typeof url === 'string' && url.startsWith('/auth');
    const traceId = request.traceId || request.sentryTraceId;
    const shouldLogRequestBody =
      process.env.NODE_ENV !== 'production' &&
      /^true$/i.test(process.env.HTTP_LOG_REQUEST_BODY || '');

    // Reforça o mesmo requestId no request para uso em filtros/logs.
    request.requestId = requestId;
    request.requestStartAt = Date.now();
    RequestContext.set('requestId', requestId);
    if (request.user?.userId) {
      RequestContext.set('userId', request.user.userId);
    }
    if (request.user?.company_id) {
      RequestContext.set('companyId', request.user.company_id);
    }

    // Log de entrada
    const baseLog: Record<string, unknown> = {
      type: 'REQUEST',
      requestId,
      method,
      url,
      ip,
      userAgent,
      userId: request.user?.userId,
      companyId: request.user?.company_id,
    };

    if (traceId) {
      baseLog.traceId = traceId;
    }

    // LGPD: corpos de request exigem opt-in fora de produção.
    if (!isAuthRoute && shouldLogRequestBody) {
      baseLog.body = this.sanitizeBody(body);
    }

    this.writeLog('log', baseLog);

    return next.handle().pipe(
      tap({
        next: () => {
          const responseTime = Date.now() - request.requestStartAt!;
          const response = context.switchToHttp().getResponse<Response>();

          const responseLog: Record<string, unknown> = {
            type: 'RESPONSE',
            requestId,
            method,
            url,
            statusCode: response.statusCode,
            responseTimeMs: responseTime,
            userId: request.user?.userId,
            companyId: request.user?.company_id,
          };

          if (traceId) {
            responseLog.traceId = traceId;
          }

          this.writeLog('log', responseLog);
        },
      }),
    );
  }

  private writeLog(
    level: 'log' | 'warn' | 'error',
    payload: Record<string, unknown>,
  ): void {
    if (level === 'error') {
      this.logger.error(payload);
      return;
    }

    if (level === 'warn') {
      this.logger.warn(payload);
      return;
    }

    this.logger.log(payload);
  }

  private sanitizeBody(
    body: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!body) return body;

    return this.sanitizeUnknown(body, 0) as Record<string, unknown>;
  }

  private sanitizeUnknown(value: unknown, depth: number): unknown {
    if (depth > 6) return '***TRUNCATED***';

    if (Array.isArray(value)) {
      return value.map((v) => this.sanitizeUnknown(v, depth + 1));
    }

    if (value && typeof value === 'object') {
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(input)) {
        out[key] = this.sanitizeKeyValue(key, v, depth + 1);
      }
      return out;
    }

    if (typeof value === 'string') return this.maskValue(value);

    return value;
  }

  private sanitizeKeyValue(
    key: string,
    value: unknown,
    depth: number,
  ): unknown {
    const k = key.toLowerCase();

    const redactKeys = new Set([
      'password',
      'senha',
      'token',
      'access_token',
      'refresh_token',
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'x-service-token',
      'x-auth-token',
      'x-csrf-token',
      'x-refresh-csrf',
      'client_secret',
      'api_key',
      'apikey',
      'secret',
      'signature_pin',
      'mfa_secret',
      'totp_secret',
    ]);

    if (redactKeys.has(k)) return '***REDACTED***';

    // Catch-all para qualquer campo cujo nome contenha "token" ou "secret".
    // Ex: 'internal_token', 'session_secret', 'webhook_secret'.
    if (k.includes('secret') || /(^|_|-)token($|_|-)/.test(k)) {
      return '***REDACTED***';
    }

    if (k.includes('cpf')) return sanitizeLogValue(key, value);

    if (k.includes('email')) return sanitizeLogValue(key, value);

    if (typeof value === 'string') return sanitizeLogValue(key, value);

    return this.sanitizeUnknown(value, depth);
  }

  private maskValue(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;

    const atIndex = trimmed.indexOf('@');
    const dotAfterAt = atIndex > 0 ? trimmed.indexOf('.', atIndex + 2) : -1;
    if (
      atIndex > 0 &&
      dotAfterAt > atIndex + 1 &&
      dotAfterAt < trimmed.length - 1 &&
      !trimmed.includes(' ')
    ) {
      return maskEmail(trimmed);
    }

    // CPF heuristic (11 digits with optional punctuation)
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length === 11) {
      return maskCpf(trimmed);
    }

    // Prevent huge payloads in logs
    if (trimmed.length > 200) {
      return `${trimmed.slice(0, 200)}…`;
    }

    return maskSensitiveText(trimmed);
  }
}
