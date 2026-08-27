import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
  Logger,
  Inject,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { throwError, from } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import type { Request } from 'express';
import { Redis } from 'ioredis';
import { isIP } from 'node:net';
import { REDIS_CLIENT_RATE_LIMIT } from '../redis/redis.constants';
import { getRequestIp } from '../utils/request-ip.util';
import {
  SecurityAuditService,
  SecuritySeverity,
  SecurityEventType,
} from './security-audit.service';

/** Quantos 401/403 em uma janela antes de bloquear o IP. */
const SPIKE_THRESHOLD = parseInt(
  process.env.FORBIDDEN_SPIKE_THRESHOLD || '15',
  10,
);

/** Janela de observação em segundos. */
const SPIKE_WINDOW_SECONDS = parseInt(
  process.env.FORBIDDEN_SPIKE_WINDOW_SECONDS || '60',
  10,
);

/** Duração do bloqueio do IP em segundos. */
const SPIKE_BLOCK_SECONDS = parseInt(
  process.env.FORBIDDEN_SPIKE_BLOCK_SECONDS || '900',
  10,
);

/**
 * Interceptor global de detecção de "forbidden spike".
 *
 * Monitora respostas 401/403 lançadas pelos handlers e serviços.
 * Quando um IP acumula SPIKE_THRESHOLD erros dentro de SPIKE_WINDOW_SECONDS,
 * o IP é bloqueado por SPIKE_BLOCK_SECONDS e um evento CRITICAL é emitido.
 *
 * Cobre: IDOR probing, credential stuffing com tokens válidos, scanning de
 * endpoints protegidos por permissão.
 *
 * Limitação conhecida: erros lançados por guards (JwtAuthGuard, TenantGuard)
 * não chegam até interceptors — são cobertos pelo IpThrottlerGuard existente.
 */
@Injectable()
export class ForbiddenSpikeInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ForbiddenSpikeInterceptor.name);

  constructor(
    @Inject(REDIS_CLIENT_RATE_LIMIT) private readonly redis: Redis,
    private readonly securityAudit: SecurityAuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: { userId?: string; id?: string } }>();

    const ip = this.extractIp(request);
    if (!ip) {
      return next.handle();
    }

    return from(this.checkBlocked(ip)).pipe(
      mergeMap((blocked) => {
        if (blocked) {
          this.logger.warn({
            event: 'forbidden_spike_ip_blocked_request',
            ip,
            path: request.path,
            method: request.method,
          });
          throw new HttpException(
            {
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
              message:
                'Acesso temporariamente suspenso por atividade suspeita. Tente novamente em alguns minutos.',
              errorCode: 'FORBIDDEN_SPIKE_BLOCKED',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        return next.handle().pipe(
          catchError((err: unknown) => {
            if (
              err instanceof ForbiddenException ||
              err instanceof UnauthorizedException
            ) {
              void this.trackAndMaybeBlock(
                ip,
                request.user?.userId ?? request.user?.id,
                request.path,
              );
            }
            return throwError(() => err);
          }),
        );
      }),
    );
  }

  private async checkBlocked(ip: string): Promise<boolean> {
    try {
      const blocked = await this.redis.get(this.blockKey(ip));
      return Boolean(blocked);
    } catch {
      // fail-open: não bloquear acesso legítimo se Redis falhar
      return false;
    }
  }

  private async trackAndMaybeBlock(
    ip: string,
    userId: string | undefined,
    path: string,
  ): Promise<void> {
    const counterKey = this.counterKey(ip);
    const blockKey = this.blockKey(ip);

    const luaScript = `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then
        redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
      end
      return count
    `;

    let count: number;
    try {
      count = (await this.redis.eval(
        luaScript,
        1,
        counterKey,
        String(SPIKE_WINDOW_SECONDS),
      )) as number;
    } catch (err) {
      this.logger.error({
        event: 'forbidden_spike_redis_error',
        ip,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (count >= SPIKE_THRESHOLD) {
      try {
        await this.redis
          .multi()
          .del(counterKey)
          .set(blockKey, '1', 'EX', SPIKE_BLOCK_SECONDS)
          .exec();
      } catch (err) {
        this.logger.error({
          event: 'forbidden_spike_block_failed',
          ip,
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      this.logger.warn({
        event: SecurityEventType.FORBIDDEN_SPIKE,
        severity: SecuritySeverity.CRITICAL,
        ip,
        userId,
        path,
        threshold: SPIKE_THRESHOLD,
        windowSeconds: SPIKE_WINDOW_SECONDS,
        blockSeconds: SPIKE_BLOCK_SECONDS,
      });

      this.securityAudit.emit({
        event: SecurityEventType.FORBIDDEN_SPIKE,
        severity: SecuritySeverity.CRITICAL,
        userId,
        ip,
        path,
        metadata: {
          threshold: SPIKE_THRESHOLD,
          windowSeconds: SPIKE_WINDOW_SECONDS,
          blockSeconds: SPIKE_BLOCK_SECONDS,
        },
      });
    }
  }

  private extractIp(request: Request): string | null {
    const ip = getRequestIp(request);
    return ip && isIP(ip) !== 0 ? ip : null;
  }

  private counterKey(ip: string): string {
    return `security:forbidden_spike:counter:${ip}`;
  }

  private blockKey(ip: string): string {
    return `security:forbidden_spike:block:${ip}`;
  }
}
