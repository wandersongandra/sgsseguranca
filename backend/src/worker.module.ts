import { Module, Logger } from '@nestjs/common';
import { CacheModule, type CacheModuleOptions } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import * as Joi from 'joi';
import { DatabaseLogger } from './shared/logging/database.logger';
import { RedisModule } from './shared/redis/redis.module';
import { REDIS_CLIENT_BULLMQ } from './shared/redis/redis.constants';
import { MailWorkerModule } from './infra/mail/mail.worker.module';
import { DocumentImportWorkerModule } from './modules/document-import/document-import.worker.module';
import { ReportsWorkerModule } from './modules/reports/reports.worker.module';
import { QueueServicesModule } from './infra/queue/queue-services.module';
import { ObservabilityModule } from './shared/observability/observability.module';
import { ObservabilityWorkerModule } from './shared/observability/observability.worker.module';
import { SlaEscalationWorkerModule } from './sla-escalation-worker.module';
import { ExpiryNotificationsWorkerModule } from './modules/tasks/expiry-notifications-worker.module';
import { DocumentRetentionWorkerModule } from './modules/tasks/document-retention-worker.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { SecurityAuditModule } from './shared/security/security-audit.module';
import { WorkerHeartbeatReporterService } from './shared/redis/worker-heartbeat-reporter.service';
import {
  isLocalRedisConnection,
  resolveRedisConnection,
} from './shared/redis/redis-connection.util';
import {
  doesDatabaseUrlRequireSsl,
  isNeonPoolerHost,
  parseBooleanFlag,
  resolveDatabaseHostname,
  resolveDbSslOptions,
} from './shared/database/db-ssl.util';
import { PostgresApplicationNameService } from './shared/database/postgres-application-name.service';
import { DashboardWorkerModule } from './modules/dashboard/dashboard.worker.module';
import { DisasterRecoveryWorkerModule } from './modules/disaster-recovery/disaster-recovery.worker.module';
import { TasksWorkerModule } from './modules/tasks/tasks.worker.module';
import { AiRecoveryWorkerModule } from './modules/ai/sst-agent/ai-recovery.worker.module';
import {
  createRedisKeyvCache,
  DEFAULT_CACHE_TTL_MS,
} from './shared/cache/redis-keyv-cache.util';

function firstNonEmpty(
  values: Array<string | undefined | null>,
): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function resolveDatabaseUrl(config: ConfigService): string | undefined {
  return firstNonEmpty([
    config.get<string>('DATABASE_URL'),
    config.get<string>('DATABASE_PRIVATE_URL'),
    config.get<string>('DATABASE_PUBLIC_URL'),
    config.get<string>('URL_DO_BANCO_DE_DADOS'),
  ]);
}

function normalizeDatabaseUrlForPg(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('sslmode');
    return parsed.toString();
  } catch {
    return url;
  }
}

function describeDatabaseTarget(url?: string): string {
  if (!url) {
    return 'target=unknown';
  }

  try {
    const parsed = new URL(url);
    const databaseName = parsed.pathname.replace(/^\//, '') || '(default)';
    return `host=${parsed.hostname} port=${parsed.port || '5432'} db=${databaseName}`;
  } catch {
    return 'target=invalid-url';
  }
}

function resolveDatabaseHost(config: ConfigService): string | undefined {
  return firstNonEmpty([
    config.get<string>('DATABASE_HOST'),
    config.get<string>('PGHOST'),
    config.get<string>('POSTGRES_HOST'),
  ]);
}

function resolveDatabasePort(config: ConfigService): number {
  const numericCandidates = [
    config.get<number>('DATABASE_PORT'),
    config.get<number>('PGPORT'),
    config.get<number>('POSTGRES_PORT'),
  ];

  for (const candidate of numericCandidates) {
    if (
      typeof candidate === 'number' &&
      Number.isFinite(candidate) &&
      candidate > 0
    ) {
      return candidate;
    }
  }

  const raw = firstNonEmpty([
    config.get<string>('DATABASE_PORT'),
    config.get<string>('PGPORT'),
    config.get<string>('POSTGRES_PORT'),
  ]);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5432;
}

function resolveDatabaseUser(config: ConfigService): string | undefined {
  return firstNonEmpty([
    config.get<string>('DATABASE_USER'),
    config.get<string>('PGUSER'),
    config.get<string>('POSTGRES_USER'),
  ]);
}

function resolveDatabasePassword(config: ConfigService): string | undefined {
  return firstNonEmpty([
    config.get<string>('DATABASE_PASSWORD'),
    config.get<string>('PGPASSWORD'),
    config.get<string>('POSTGRES_PASSWORD'),
  ]);
}

function resolveDatabaseName(config: ConfigService): string | undefined {
  return firstNonEmpty([
    config.get<string>('DATABASE_NAME'),
    config.get<string>('PGDATABASE'),
    config.get<string>('POSTGRES_DB'),
  ]);
}

const IS_PRODUCTION_ENV = process.env.NODE_ENV === 'production';
const REDIS_FAIL_OPEN_REQUESTED = /^true$/i.test(
  process.env.REDIS_FAIL_OPEN || (IS_PRODUCTION_ENV ? 'false' : 'true'),
);
const workerQueueRedisConnection = resolveRedisConnection(process.env, 'queue');

const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test', 'staging')
    .default('development'),
  REDIS_URL: Joi.string().optional().allow(''),
  REDIS_AUTH_URL: Joi.string().optional().allow(''),
  REDIS_AUTH_HOST: Joi.string().optional().allow(''),
  REDIS_AUTH_PORT: Joi.number().optional(),
  REDIS_AUTH_PASSWORD: Joi.string().optional().allow(''),
  REDIS_AUTH_USERNAME: Joi.string().optional().allow(''),
  REDIS_AUTH_TLS: Joi.boolean().default(false),
  REDIS_AUTH_TLS_ALLOW_INSECURE: Joi.boolean().valid(false).default(false),
  REDIS_CACHE_URL: Joi.string().optional().allow(''),
  REDIS_CACHE_HOST: Joi.string().optional().allow(''),
  REDIS_CACHE_PORT: Joi.number().optional(),
  REDIS_CACHE_PASSWORD: Joi.string().optional().allow(''),
  REDIS_CACHE_USERNAME: Joi.string().optional().allow(''),
  REDIS_CACHE_TLS: Joi.boolean().default(false),
  REDIS_CACHE_TLS_ALLOW_INSECURE: Joi.boolean().valid(false).default(false),
  REDIS_RATE_LIMIT_URL: Joi.string().optional().allow(''),
  REDIS_RATE_LIMIT_HOST: Joi.string().optional().allow(''),
  REDIS_RATE_LIMIT_PORT: Joi.number().optional(),
  REDIS_RATE_LIMIT_PASSWORD: Joi.string().optional().allow(''),
  REDIS_RATE_LIMIT_USERNAME: Joi.string().optional().allow(''),
  REDIS_RATE_LIMIT_TLS: Joi.boolean().default(false),
  REDIS_RATE_LIMIT_TLS_ALLOW_INSECURE: Joi.boolean()
    .valid(false)
    .default(false),
  REDIS_QUEUE_URL: Joi.string().optional().allow(''),
  REDIS_QUEUE_HOST: Joi.string().optional().allow(''),
  REDIS_QUEUE_PORT: Joi.number().optional(),
  REDIS_QUEUE_PASSWORD: Joi.string().optional().allow(''),
  REDIS_QUEUE_USERNAME: Joi.string().optional().allow(''),
  REDIS_QUEUE_TLS: Joi.boolean().default(false),
  REDIS_QUEUE_TLS_ALLOW_INSECURE: Joi.boolean().valid(false).default(false),
  URL_REDIS: Joi.string().optional().allow(''),
  REDIS_PUBLIC_URL: Joi.string().optional().allow(''),
  REDIS_DISABLED: Joi.string().valid('true', 'false').optional().allow(''),
  REDIS_HOST: Joi.string().optional(),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().optional().allow(''),
  REDIS_TLS: Joi.boolean().default(false),
  // Dispensa a exigência de TLS quando o Redis está na mesma rede interna do
  // host (ver assertSecureRedisConnection). Só deve ser ligado nesse cenário.
  REDIS_ALLOW_INSECURE_INTERNAL: Joi.boolean().default(false),
  ALERTS_DLQ_COOLDOWN_MS: Joi.number().integer().min(60_000).default(900_000),
  AI_RECOVERY_MAX_AGE_MS: Joi.number()
    .integer()
    .min(60_000)
    .default(86_400_000),
  SECURITY_AUDIT_HMAC_KEY: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string()
      .min(32)
      .default('development-security-audit-hmac-key'),
  }),
  DATABASE_URL: Joi.string().optional(),
  DATABASE_ADMIN_URL: Joi.string().optional(),
  DATABASE_HOST: Joi.string().optional(),
  DATABASE_PORT: Joi.number().default(5432),
  DATABASE_USER: Joi.string().optional(),
  DATABASE_PASSWORD: Joi.string().optional(),
  DATABASE_NAME: Joi.string().optional(),
  DATABASE_SSL: Joi.boolean().default(false),
  // SECURITY: conexões inseguras (rejectUnauthorized=false) não são suportadas.
  // O runtime falha fechado em resolveDbSslOptions.
  DATABASE_SSL_ALLOW_INSECURE: Joi.boolean().valid(false).default(false),
  DATABASE_SSL_ALLOW_INSECURE_FORCE: Joi.boolean().valid(false).default(false),
  DATABASE_SSL_CA: Joi.string().optional(),
  LEGACY_CPF_PLAINTEXT_LOOKUP_ENABLED: Joi.boolean().default(false),
  DB_POOL_MAX: Joi.number().default(5),
  DB_POOL_MIN: Joi.number().default(0),
  DB_IDLE_TIMEOUT_MS: Joi.number().default(30000),
  DB_CONNECTION_TIMEOUT_MS: Joi.number().default(10000),
  DB_PREPARE_THRESHOLD: Joi.number().integer().min(0).max(10).default(0),
  DB_APPLICATION_NAME: Joi.string().optional().allow(''),
  DB_APPLICATION_NAME_WORKER: Joi.string().optional().allow(''),
  DATABASE_POOLER_ALLOW_SESSION_RLS: Joi.boolean().default(false),
  DB_TIMINGS_ENABLED: Joi.boolean().default(false),
  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly')
    .optional()
    .allow(''),
  OTEL_ENABLED: Joi.boolean().default(false),
  OTEL_SERVICE_NAME: Joi.string().optional(),
  OTEL_SERVICE_VERSION: Joi.string().optional(),
  JAEGER_ENDPOINT: Joi.string().optional(),
  PROMETHEUS_PORT: Joi.number().optional(),
  SENTRY_DSN: Joi.string().uri().optional().allow(''),
  SENTRY_ENVIRONMENT: Joi.string().optional().allow(''),
  SENTRY_TRACES_SAMPLE_RATE: Joi.number().min(0).max(1).optional(),
  NEW_RELIC_ENABLED: Joi.boolean().default(false),
  ALERTS_ENABLED: Joi.boolean().default(false),
  ALERTS_MIN_REQUESTS: Joi.number().default(20),
  ALERTS_ERROR_RATE_THRESHOLD: Joi.number().default(0.05),
  ALERTS_HTTP_AVG_LATENCY_MS_THRESHOLD: Joi.number().default(2000),
  ALERTS_POOL_USAGE_THRESHOLD: Joi.number().default(0.8),
  ALERTS_QUEUE_WAITING_THRESHOLD: Joi.number().default(20),

  // Integrações externas (timeout/retry/circuit breaker padrão)
  INTEGRATION_TIMEOUT_MS: Joi.number().default(10000),
  INTEGRATION_RETRY_ATTEMPTS: Joi.number().default(3),
  INTEGRATION_RETRY_BASE_DELAY_MS: Joi.number().default(200),
  INTEGRATION_RETRY_MAX_DELAY_MS: Joi.number().default(2000),
  INTEGRATION_RETRY_JITTER_RATIO: Joi.number().min(0).max(1).default(0.2),
  INTEGRATION_CB_FAILURE_THRESHOLD: Joi.number().default(5),
  INTEGRATION_CB_SUCCESS_THRESHOLD: Joi.number().default(2),
  INTEGRATION_CB_RESET_TIMEOUT_MS: Joi.number().default(30000),

  // S3/AWS timeouts
  S3_SOCKET_TIMEOUT_MS: Joi.number().default(10000),
  S3_CONNECTION_TIMEOUT_MS: Joi.number().default(2000),
  S3_MAX_ATTEMPTS: Joi.number().default(3),
  PDF_GENERATION_CONCURRENCY: Joi.number().integer().min(1).max(4).optional(),
  PDF_BROWSER_POOL_SIZE: Joi.number().integer().min(1).max(4).optional(),
  PDF_PAGE_TIMEOUT_MS: Joi.number().integer().min(15000).max(180000).optional(),
  PDF_BROWSER_ACQUIRE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(5000)
    .max(180000)
    .optional(),
  PDF_BROWSER_MAX_USES: Joi.number().integer().min(5).max(500).optional(),
  PDF_QUEUE_JOB_TIMEOUT_MS: Joi.number()
    .integer()
    .min(60000)
    .max(900000)
    .optional(),
  DOCUMENT_IMPORT_QUEUE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(30000)
    .max(900000)
    .optional(),
  DOCUMENT_IMPORT_QUEUE_ATTEMPTS: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .optional(),
  DOCUMENT_IMPORT_QUEUE_CONCURRENCY: Joi.number()
    .integer()
    .min(1)
    .max(4)
    .optional(),
  INSPECTION_INLINE_EVIDENCE_MAX_BYTES: Joi.number()
    .integer()
    .min(131072)
    .max(10485760)
    .optional(),

  // Worker quota por tenant
  WORKER_TENANT_QUOTA_DELAY_MS: Joi.number().default(10000),
  WORKER_TENANT_QUOTA_TTL_SECONDS: Joi.number().default(120),
  WORKER_TENANT_QUOTA_PDF_MAX_ACTIVE: Joi.number().default(1),
  WORKER_TENANT_QUOTA_MAIL_MAX_ACTIVE: Joi.number().default(3),
  WORKER_TENANT_QUOTA_PDF_DELAY_MS: Joi.number().default(10000),
  WORKER_TENANT_QUOTA_MAIL_DELAY_MS: Joi.number().default(5000),
  WORKER_TENANT_QUOTA_PDF_TTL_SECONDS: Joi.number().default(120),
  WORKER_TENANT_QUOTA_MAIL_TTL_SECONDS: Joi.number().default(60),
  WORKER_TENANT_QUOTA_JITTER_MS: Joi.number().default(2000),
  WORKER_TENANT_QUOTA_PDF_JITTER_MS: Joi.number().default(2000),
  WORKER_TENANT_QUOTA_MAIL_JITTER_MS: Joi.number().default(2000),
  WORKER_HEARTBEAT_ENABLED: Joi.boolean().default(true),
  WORKER_HEARTBEAT_REQUIRED: Joi.boolean().default(true),
  WORKER_HEARTBEAT_KEY: Joi.string().default('worker:heartbeat:queue-runtime'),
  WORKER_HEARTBEAT_TTL_SECONDS: Joi.number().default(90),
});

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema,
      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
    }),
    ScheduleModule.forRoot(),
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('WorkerCacheModule');
        const redisConnection = resolveRedisConnection(config, 'cache');

        if (!redisConnection) {
          throw new Error(
            'Redis CACHE é obrigatório para o cache do worker. Configure REDIS_CACHE_URL ou fallback genérico.',
          );
        }

        if (
          config.get('NODE_ENV') !== 'production' &&
          isLocalRedisConnection(redisConnection)
        ) {
          logger.log(
            '💾 Configurando Memory Cache para worker em desenvolvimento',
          );
          return {
            ttl: DEFAULT_CACHE_TTL_MS,
          };
        }

        logger.log(
          `Configurando Redis Cache do worker (${redisConnection.source})`,
        );

        const redisConfig: CacheModuleOptions = {
          stores: [createRedisKeyvCache(redisConnection)],
          ttl: DEFAULT_CACHE_TTL_MS,
        };

        logger.log(
          `Redis Cache distribuído do worker com TLS=${Boolean(redisConnection.tls)}`,
        );
        return redisConfig;
      },
    }),
    RedisModule,
    ...(workerQueueRedisConnection &&
    (IS_PRODUCTION_ENV ||
      !REDIS_FAIL_OPEN_REQUESTED ||
      !isLocalRedisConnection(workerQueueRedisConnection))
      ? [
          BullModule.forRootAsync({
            imports: [RedisModule],
            inject: [REDIS_CLIENT_BULLMQ],
            useFactory: (bullmqRedisClient: Redis) => ({
              connection: bullmqRedisClient,
            }),
          }),
        ]
      : []),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => {
        const logger = new Logger('WorkerTypeORM');
        const isProduction = config.get('NODE_ENV') === 'production';
        const rawUrl = resolveDatabaseUrl(config);
        const databaseHostname = resolveDatabaseHostname({ url: rawUrl });
        if (
          isProduction &&
          isNeonPoolerHost(databaseHostname) &&
          config.get<boolean>('DATABASE_POOLER_ALLOW_SESSION_RLS', false) !==
            true
        ) {
          throw new Error(
            'DATABASE_URL aponta para Neon -pooler, mas o SGS usa RLS por contexto de sessão. Use endpoint direto Neon ou valide explicitamente DATABASE_POOLER_ALLOW_SESSION_RLS=true.',
          );
        }
        const url = normalizeDatabaseUrlForPg(rawUrl);
        const baseConfig: TypeOrmModuleOptions = {
          type: 'postgres' as const,
          autoLoadEntities: true,
          synchronize: false,
          logger: new DatabaseLogger(),
          logging: isProduction
            ? (['error', 'warn'] as const)
            : (['error', 'warn'] as const),
          maxQueryExecutionTime: 1000,
          extra: {
            max: config.get<number>('DB_POOL_MAX', 5),
            min: config.get<number>('DB_POOL_MIN', 0),
            idleTimeoutMillis: config.get<number>('DB_IDLE_TIMEOUT_MS', 30000),
            connectionTimeoutMillis: config.get<number>(
              'DB_CONNECTION_TIMEOUT_MS',
              10000,
            ),
            application_name: firstNonEmpty([
              config.get<string>('DB_APPLICATION_NAME_WORKER'),
              config.get<string>('DB_APPLICATION_NAME'),
              'api_worker',
            ]),
            // prepareThreshold: 0 para compatibilidade com PgBouncer (transaction mode
            // não suporta prepared statements por sessão). Em conexão direta (sem pooler),
            // configure DB_PREPARE_THRESHOLD=1 para reutilizar planos de execução.
            prepareThreshold: config.get<number>('DB_PREPARE_THRESHOLD', 0),
            // Keepalive previne drop silencioso de conexões ociosas (Neon serverless)
            keepAlive: true,
            keepAliveInitialDelayMillis: 10_000,
          },
        };
        if (url) {
          logger.log(
            `Connecting via DATABASE_URL (${describeDatabaseTarget(rawUrl)})`,
          );
          return {
            ...baseConfig,
            url,
            ssl: WorkerModule.getSSLConfig(config, isProduction, logger),
          };
        }
        return {
          ...baseConfig,
          host: resolveDatabaseHost(config),
          port: resolveDatabasePort(config),
          username: resolveDatabaseUser(config),
          password: resolveDatabasePassword(config),
          database: resolveDatabaseName(config),
          ssl: WorkerModule.getSSLConfig(config, isProduction, logger),
        };
      },
      dataSourceFactory: (options) => {
        const dsLogger = new Logger('WorkerLazyDataSource');
        const dataSource = new DataSource(options!);
        const isProduction = process.env.NODE_ENV === 'production';

        const connectWithRetry = async () => {
          let attempt = 0;
          const maxAttempts = isProduction ? 5 : Number.POSITIVE_INFINITY;

          while (true) {
            try {
              await dataSource.initialize();
              dsLogger.log('✅ Worker PostgreSQL connected');
              return;
            } catch (err: unknown) {
              attempt++;
              const delay = Math.min(
                1_000 * 2 ** Math.min(attempt - 1, 5),
                30_000,
              );
              dsLogger.warn(
                `DB connect attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}) — retrying in ${delay}ms`,
              );
              if (attempt >= maxAttempts) {
                dsLogger.error(
                  `❌ Worker sem banco apos ${attempt} tentativas em producao. Abortando bootstrap.`,
                );
                throw err;
              }
              await new Promise<void>((resolve) => setTimeout(resolve, delay));
            }
          }
        };

        if (isProduction) {
          return connectWithRetry().then(() => dataSource);
        }

        void connectWithRetry();
        return Promise.resolve(dataSource);
      },
    }),
    // Apenas módulos relacionados a filas/processamento
    ObservabilityModule,
    ObservabilityWorkerModule,
    RbacModule,
    SecurityAuditModule,
    MailWorkerModule,
    DocumentImportWorkerModule,
    ReportsWorkerModule,
    QueueServicesModule,
    DashboardWorkerModule,
    DisasterRecoveryWorkerModule,
    SlaEscalationWorkerModule,
    ExpiryNotificationsWorkerModule,
    DocumentRetentionWorkerModule,
    TasksWorkerModule,
    AiRecoveryWorkerModule,
  ],
  providers: [WorkerHeartbeatReporterService, PostgresApplicationNameService],
})
export class WorkerModule {
  private static getSSLConfig(
    config: ConfigService,
    isProduction: boolean,
    logger: Logger,
  ) {
    const legacySslEnabled = parseBooleanFlag(
      config.get<string>('BANCO_DE_DADOS_SSL'),
    );
    const databaseUrlRequiresSsl = doesDatabaseUrlRequireSsl(
      resolveDatabaseUrl(config),
    );
    const sslEnabled =
      Boolean(config.get<boolean>('DATABASE_SSL')) ||
      legacySslEnabled ||
      databaseUrlRequiresSsl;
    const sslCA = config.get<string>('DATABASE_SSL_CA');
    const allowInsecureRequested = parseBooleanFlag(
      config.get<string>('DATABASE_SSL_ALLOW_INSECURE'),
    );
    const allowInsecureForced = parseBooleanFlag(
      config.get<string>('DATABASE_SSL_ALLOW_INSECURE_FORCE'),
    );
    const allowInsecure = allowInsecureRequested || allowInsecureForced;

    if (legacySslEnabled && !config.get<boolean>('DATABASE_SSL')) {
      logger.warn(
        'BANCO_DE_DADOS_SSL=true detectado no worker. Migre para DATABASE_SSL=true.',
      );
    }
    if (databaseUrlRequiresSsl && !config.get<boolean>('DATABASE_SSL')) {
      logger.log(
        'Worker com DATABASE_URL exigindo SSL; habilitando TLS mesmo com DATABASE_SSL=false.',
      );
    }
    if (allowInsecure) {
      logger.warn(
        'DATABASE_SSL_ALLOW_INSECURE foi solicitado no worker, mas não é suportado. O bootstrap falhará fechado; configure DATABASE_SSL_CA e mantenha TLS estrito.',
      );
    }

    if (!isProduction && !sslEnabled && !allowInsecure) {
      return false;
    }

    const sslOptions = resolveDbSslOptions({
      isProduction,
      sslEnabled: !!sslEnabled,
      sslCA,
      allowInsecure,
    });
    if (sslCA) {
      logger.log('Worker com SSL + CA customizado');
    } else if (sslOptions) {
      logger.log('Worker com SSL validado');
    }
    return sslOptions;
  }
}
