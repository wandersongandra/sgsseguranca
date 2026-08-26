import { Controller, Get, UseGuards } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { JwtAuthGuard } from '../../modules/auth/jwt-auth.guard';
import { RolesGuard } from '../../modules/auth/roles.guard';
import { Roles } from '../../modules/auth/roles.decorator';
import { Role } from '../../modules/auth/enums/roles.enum';
import { Authorize } from '../../modules/auth/authorize.decorator';
import { REDIS_CLIENT_RATE_LIMIT } from '../redis/redis.constants';
import { Redis } from 'ioredis';
import { TenantOptional } from '../decorators/tenant-optional.decorator';

/**
 * Endpoint administrativo de monitoramento de rate limits.
 *
 * Acesso restrito a SUPER_ADMIN de plataforma.
 * Retorna snapshot atual dos contadores no Redis.
 */
@Controller('admin/rate-limits')
@TenantOptional()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class RateLimitsAdminController {
  private static readonly MAX_SCAN_ITERATIONS = 20;
  private static readonly MAX_SCANNED_KEYS = 2000;

  constructor(@Inject(REDIS_CLIENT_RATE_LIMIT) private readonly redis: Redis) {}

  /**
   * GET /admin/rate-limits/status
   *
   * Retorna estatísticas agregadas de rate limiting:
   * - Contagem de chaves IP ativas no ThrottlerModule (Redis)
   * - Contagem de chaves de tenant ativos
   * - Top rotas com rate limit por usuário (user_rl:*)
   * - Violações recentes (tenant_rate_limit_exceeded)
   */
  @Get('status')
  @Authorize('can_view_system_health')
  async getStatus() {
    const [ipStats, tenantStats, userAiStats] = await Promise.allSettled([
      this.getIpThrottlerStats(),
      this.getTenantStats(),
      this.getUserAiStats(),
    ]);

    return {
      timestamp: new Date().toISOString(),
      ip_throttler: {
        storage: 'redis',
        ...(ipStats.status === 'fulfilled'
          ? ipStats.value
          : { error: 'Indisponível' }),
      },
      tenants: {
        ...(tenantStats.status === 'fulfilled'
          ? tenantStats.value
          : { error: 'Indisponível' }),
      },
      ai_users: {
        ...(userAiStats.status === 'fulfilled'
          ? userAiStats.value
          : { error: 'Indisponível' }),
      },
    };
  }

  private async getIpThrottlerStats() {
    const [hitStats, blockStats] = await Promise.all([
      this.scanKeysSampled('throttler:hit:*', 200),
      this.scanKeysSampled('throttler:block:*', 200),
    ]);

    return {
      active_ip_windows: hitStats.count,
      currently_blocked_ips: blockStats.count,
      sampled: hitStats.sampled || blockStats.sampled,
    };
  }

  private async getTenantStats() {
    const tenantMinuteKeys = await this.scanKeysSampled('ratelimit:*:minute:*');

    // Extrair tenant IDs únicos
    const tenantIds = new Set(
      tenantMinuteKeys.keys.map((k) => k.split(':')[1]).filter(Boolean),
    );

    return {
      active_tenants_this_minute: tenantIds.size,
      total_active_windows: tenantMinuteKeys.count,
      sampled: tenantMinuteKeys.sampled,
    };
  }

  private async getUserAiStats() {
    const userKeys = await this.scanKeysSampled('user_rl:*');

    // Agregar contadores por rota
    const routeCounts: Record<string, number> = {};
    if (userKeys.keys.length > 0) {
      const values = await Promise.all(
        userKeys.keys.map((key) => this.redis.zcard(key)),
      );
      for (let i = 0; i < userKeys.keys.length; i++) {
        // user_rl:{userId}:{method}:{path}
        const parts = userKeys.keys[i].split(':');
        const route = parts.slice(2).join(':');
        routeCounts[route] = (routeCounts[route] ?? 0) + Number(values[i] ?? 0);
      }
    }

    return {
      active_user_windows: userKeys.count,
      requests_by_route: routeCounts,
      sampled: userKeys.sampled,
    };
  }

  private async scanKeysSampled(
    pattern: string,
    count = 500,
  ): Promise<{
    count: number;
    keys: string[];
    sampled: boolean;
  }> {
    let cursor = '0';
    let iterations = 0;
    const keys: string[] = [];

    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        count,
      );
      cursor = next;
      iterations += 1;
      keys.push(...batch);

      if (
        keys.length >= RateLimitsAdminController.MAX_SCANNED_KEYS ||
        iterations >= RateLimitsAdminController.MAX_SCAN_ITERATIONS
      ) {
        return {
          count: keys.length,
          keys,
          sampled: true,
        };
      }
    } while (cursor !== '0');

    return {
      count: keys.length,
      keys,
      sampled: false,
    };
  }
}
