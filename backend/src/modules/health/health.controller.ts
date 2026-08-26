import {
  Controller,
  Get,
  Inject,
  UseGuards,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  HealthCheckService,
  HealthCheck,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { PuppeteerPoolService } from '../../shared/services/puppeteer-pool.service';
import { Public } from '../../shared/decorators/public.decorator';
import { TenantOptional } from '../../shared/decorators/tenant-optional.decorator';
import { HealthService } from './health.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { Authorize } from '../auth/authorize.decorator';
import { PrivilegedDbService } from '../../shared/database/privileged-db.service';
import {
  REDIS_CLIENT_AUTH,
  REDIS_CLIENT_CACHE,
  REDIS_CLIENT_QUEUE,
  REDIS_CLIENT_RATE_LIMIT,
} from '../../shared/redis/redis.constants';

const HEALTH_DEPENDENCY_TIMEOUT_MS = 5_000;
const READINESS_SUCCESS_CACHE_MS = 5_000;
const READINESS_FAILURE_CACHE_MS = 1_000;

type ReadinessCacheEntry = {
  ready: boolean;
  expiresAt: number;
};

@Controller('health')
export class HealthController {
  private readinessCache?: ReadinessCacheEntry;
  private readinessProbe?: Promise<boolean>;

  constructor(
    private health: HealthCheckService,
    private db: TypeOrmHealthIndicator,
    private memory: MemoryHealthIndicator,
    private disk: DiskHealthIndicator,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    @Inject(REDIS_CLIENT_AUTH) private readonly authRedis: Redis,
    @Inject(REDIS_CLIENT_RATE_LIMIT) private readonly rateLimitRedis: Redis,
    @Inject(REDIS_CLIENT_CACHE) private readonly cacheRedis: Redis,
    @Inject(REDIS_CLIENT_QUEUE) private readonly queueRedis: Redis,
    private readonly puppeteerPool: PuppeteerPoolService,
    private readonly healthService: HealthService,
    private readonly privilegedDb: PrivilegedDbService,
    @Optional() @InjectQueue('mail') private readonly mailQueue?: Queue,
    @Optional()
    @InjectQueue('pdf-generation')
    private readonly pdfQueue?: Queue,
  ) {}

  private async checkRedisClient(
    name: string,
    client: Redis,
  ): Promise<HealthIndicatorResult> {
    try {
      await this.assertRedisAvailable(client, name);
      return { [name]: { status: 'up' } };
    } catch (error) {
      return {
        [name]: {
          status: 'down',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async checkDistributedCache(): Promise<HealthIndicatorResult> {
    try {
      await this.assertDistributedCacheAvailable();
      return { redis_cache_store: { status: 'up' } };
    } catch (error) {
      return {
        redis_cache_store: {
          status: 'down',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async assertRedisAvailable(
    client: Redis,
    name: string,
  ): Promise<void> {
    const pong = await this.withDependencyTimeout(client.ping(), name);
    if (pong !== 'PONG') {
      throw new ServiceUnavailableException(`${name} não respondeu PONG.`);
    }
  }

  private async assertDistributedCacheAvailable(): Promise<void> {
    const key = `health:cache:${process.pid}:${randomUUID()}`;
    try {
      await this.withDependencyTimeout(
        this.cacheManager.set(key, 'ok', 1000),
        'redis_cache_store_write',
      );
      const value = await this.withDependencyTimeout(
        this.cacheManager.get<string>(key),
        'redis_cache_store_read',
      );
      if (value !== 'ok') {
        throw new ServiceUnavailableException(
          'Cache distribuído não confirmou leitura após escrita.',
        );
      }
    } finally {
      await this.withDependencyTimeout(
        this.cacheManager.del(key),
        'redis_cache_store_cleanup',
      ).catch(() => undefined);
    }
  }

  private async withDependencyTimeout<T>(
    operation: Promise<T>,
    name: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ServiceUnavailableException(
              `${name} excedeu ${HEALTH_DEPENDENCY_TIMEOUT_MS}ms.`,
            ),
          ),
        HEALTH_DEPENDENCY_TIMEOUT_MS,
      );
      timer.unref();
    });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async checkBullQueue(
    name: string,
    queue: Queue | undefined,
  ): Promise<HealthIndicatorResult> {
    if (!queue) {
      return { [name]: { status: 'up', detail: 'skipped (redis disabled)' } };
    }
    try {
      const [waiting, active, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getFailedCount(),
      ]);
      return {
        [name]: { status: 'up', waiting, active, failed },
      };
    } catch (error) {
      return {
        [name]: {
          status: 'down',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  @Authorize('can_view_system_health')
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.checkRedisClient('redis_auth', this.authRedis),
      () => this.checkRedisClient('redis_rate_limit', this.rateLimitRedis),
      () => this.checkRedisClient('redis_cache', this.cacheRedis),
      () => this.checkRedisClient('redis_queue', this.queueRedis),
      () => this.checkDistributedCache(),
      () => this.memory.checkHeap('memory_heap', 500 * 1024 * 1024),
      () =>
        this.disk.checkStorage('storage', {
          path: '/',
          thresholdPercent: 0.9,
        }),
      () => this.checkBullQueue('queue_mail', this.mailQueue),
      () => this.checkBullQueue('queue_pdf', this.pdfQueue),
    ]);
  }

  @Get('ready')
  @Public()
  @TenantOptional()
  async ready() {
    if (await this.getReadinessStatus()) {
      return { status: 'ready' };
    }

    throw new ServiceUnavailableException(
      'Dependências críticas indisponíveis.',
    );
  }

  private async getReadinessStatus(): Promise<boolean> {
    const now = Date.now();
    if (this.readinessCache && this.readinessCache.expiresAt > now) {
      return this.readinessCache.ready;
    }

    if (!this.readinessProbe) {
      this.readinessProbe = this.probeCriticalDependencies()
        .then(
          () => true,
          () => false,
        )
        .then((ready) => {
          this.readinessCache = {
            ready,
            expiresAt:
              Date.now() +
              (ready ? READINESS_SUCCESS_CACHE_MS : READINESS_FAILURE_CACHE_MS),
          };
          return ready;
        })
        .finally(() => {
          this.readinessProbe = undefined;
        });
    }

    return this.readinessProbe;
  }

  private async probeCriticalDependencies(): Promise<void> {
    await Promise.all([
      this.withDependencyTimeout(this.db.pingCheck('database'), 'database'),
      this.assertRedisAvailable(this.authRedis, 'redis_auth'),
      this.assertRedisAvailable(this.rateLimitRedis, 'redis_rate_limit'),
      this.assertRedisAvailable(this.cacheRedis, 'redis_cache'),
      this.assertRedisAvailable(this.queueRedis, 'redis_queue'),
      this.assertDistributedCacheAvailable(),
    ]);
  }

  @Get('live')
  @Public()
  live() {
    return { status: 'alive' };
  }

  @Get('detailed')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  @Authorize('can_view_system_health')
  async detailed() {
    const dbStatus = await this.healthService.checkDatabase();
    const memoryUsage = this.healthService.getMemoryUsage();
    const privileged = this.privilegedDb.isEnabled();

    return {
      status: dbStatus.healthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      checks: {
        database: dbStatus,
        memory: memoryUsage,
        // Deliberadamente FORA de /health/ready: a ausência da conexão
        // privilegiada não deve tirar a API do balanceador. Login, leitura e
        // escrita de tenant continuam funcionando normalmente; o que fica
        // bloqueado (com 503 e evento `privileged_connection_required`) são as
        // operações cross-tenant — exclusão de empresa, exclusão LGPD,
        // retenção, provisionamento. Ver `admin_operations` abaixo.
        admin_operations: {
          available: privileged,
          role: privileged ? 'sgs_admin' : null,
          detail: privileged
            ? 'Operações cross-tenant privilegiadas habilitadas.'
            : 'DATABASE_ADMIN_URL ausente: operações cross-tenant respondem 503 (fail-closed).',
        },
      },
      version: process.env.npm_package_version || '1.0.0',
    };
  }

  @Get('pool')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  @Authorize('can_view_system_health')
  pool() {
    const stats = this.healthService.getPoolStats();
    if (!stats) {
      return {
        status: 'unknown',
        message:
          'Pool stats indisponíveis: driver não-PostgreSQL ou ainda não inicializado.',
      };
    }
    const status =
      stats.utilization >= 0.8
        ? 'degraded'
        : stats.waiting > 0
          ? 'degraded'
          : 'up';
    return { status, pool: stats };
  }

  @Get('puppeteer')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  @Authorize('can_view_system_health')
  puppeteer() {
    try {
      const stats = this.puppeteerPool.getPoolStats();
      const ready = stats.total > 0 && stats.available > 0 && stats.inUse >= 0;
      return {
        status: ready ? 'up' : 'degraded',
        pool: stats,
      };
    } catch (error) {
      return {
        status: 'down',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
