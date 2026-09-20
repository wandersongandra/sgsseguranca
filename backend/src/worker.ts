import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// UV_THREADPOOL_SIZE deve ser definido antes do primeiro uso do thread pool.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '64';

if (process.env.NEW_RELIC_ENABLED === 'true') {
  // New Relic precisa ser carregado via require síncrono antes de qualquer outro
  // módulo (http, pg, etc) para auto-instrumentação correta.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('newrelic');
}

import { buildStructuredLoggerOptions } from './shared/logging/structured-winston';
import { createStructuredWinstonLogger } from './shared/logging/structured-winston';
import {
  initializeTelemetry,
  type TelemetryRuntime,
} from './shared/observability/opentelemetry.config';
import { initSentry, type SentryInitStatus } from './shared/monitoring/sentry';
import { validateCommonEnvironment } from './shared/config/environment-contract';
import { getRuntimeBuildMetadata } from './shared/observability/runtime-build-metadata';

import {
  getWorkerHealthPort,
  startWorkerHealthServer,
} from './shared/worker/worker-health.server';
import { WorkerReadinessService } from './shared/worker/worker-readiness.service';

const WORKER_SERVICE_NAME = 'wanderson-gandra-worker';
const WORKER_TELEMETRY_PORT = 9465;
const WORKER_HEALTH_PATH = '/health/ready';

function logObservabilityStatus(
  logger: ReturnType<typeof createStructuredWinstonLogger>,
  telemetry: TelemetryRuntime | null,
  sentryStatus: SentryInitStatus,
) {
  logger.info({
    event: 'observability_runtime',
    runtime: 'worker',
    loggingFormat: 'json',
    telemetryEnabled: telemetry !== null,
    tracingExporter: telemetry ? 'otlp-http' : 'disabled',
    metricsExporter: telemetry ? 'prometheus' : 'disabled',
    otlpEndpoint: telemetry?.otlpEndpoint,
    prometheusPort: telemetry?.prometheusPort,
    tracingSampler: telemetry?.sampler,
    tracingSamplerArg: telemetry?.samplerArg,
    sentry: sentryStatus,
  });
}

async function bootstrap() {
  validateCommonEnvironment(process.env, {
    component: 'worker',
    requireQueueRedis: true,
  });
  const bootstrapLogger = createStructuredWinstonLogger(WORKER_SERVICE_NAME);
  const workerPort = getWorkerHealthPort();
  const requestedPrometheusPort = process.env.PROMETHEUS_PORT
    ? Number(process.env.PROMETHEUS_PORT)
    : WORKER_TELEMETRY_PORT;

  const { assertWorkerRedisContract } = await import('./worker-runtime.guard');

  assertWorkerRedisContract(process.env);

  const sentryStatus = initSentry('worker');
  const telemetry =
    process.env.OTEL_ENABLED === 'true'
      ? await initializeTelemetry({
          serviceName: process.env.OTEL_SERVICE_NAME || WORKER_SERVICE_NAME,
          serviceVersion: process.env.OTEL_SERVICE_VERSION || '1.0.0',
          prometheusPort: requestedPrometheusPort,
          avoidPorts: [workerPort],
        })
      : null;

  if (telemetry && telemetry.prometheusPort !== requestedPrometheusPort) {
    bootstrapLogger.warn({
      event: 'prometheus_port_adjusted',
      requestedPrometheusPort,
      effectivePrometheusPort: telemetry.prometheusPort,
      reservedPort: workerPort,
    });
  }

  const [{ NestFactory }, { WinstonModule }, { WorkerModule }] =
    await Promise.all([
      import('@nestjs/core'),
      import('nest-winston'),
      import('./worker.module'),
    ]);

  logObservabilityStatus(bootstrapLogger, telemetry, sentryStatus);

  let checkReadiness: () => Promise<boolean> = () => Promise.resolve(false);
  const healthServer = startWorkerHealthServer(bootstrapLogger, () =>
    checkReadiness(),
  );
  await healthServer.listening;
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: WinstonModule.createLogger(
      buildStructuredLoggerOptions(WORKER_SERVICE_NAME),
    ),
  });
  const readiness = app.get(WorkerReadinessService);
  readiness.markInitialized();
  checkReadiness = () => readiness.check();
  let isShuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    readiness.markShuttingDown();

    bootstrapLogger.info({
      event: 'worker_shutdown_requested',
      signal,
    });

    let exitCode = 0;

    try {
      await Promise.all([app.close(), healthServer.close()]);
    } catch (error) {
      exitCode = 1;
      bootstrapLogger.error({
        event: 'worker_shutdown_failed',
        signal,
        errorName: error instanceof Error ? error.name : 'WorkerShutdownError',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

    process.exit(exitCode);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  bootstrapLogger.info({
    event: 'worker_booted',
    nodeEnv: process.env.NODE_ENV || 'development',
    healthPath: WORKER_HEALTH_PATH,
    healthPort: healthServer.port,
    ...getRuntimeBuildMetadata('worker'),
  });
}

bootstrap().catch((error) => {
  const bootstrapLogger = createStructuredWinstonLogger(WORKER_SERVICE_NAME);
  bootstrapLogger.error({
    event: 'worker_bootstrap_failed',
    errorName: error instanceof Error ? error.name : 'WorkerBootstrapError',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
