import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// UV_THREADPOOL_SIZE deve ser definido ANTES do primeiro uso do thread pool do libuv.
// O thread pool é criado de forma lazy (primeiro uso de bcrypt/argon2/crypto async).
// Definir aqui, após dotenv.config(), garante que o valor do .env seja respeitado e
// que o fallback '64' seja aplicado caso a variável não esteja no ambiente do processo.
// Valor 64: suporta até 64 operações bcrypt/argon2 paralelas sem fila de espera,
// eliminando os ~1.200ms de queuing que causavam login p95 de 3.6s sob 100 VUs.
// ⚠️  Não mover para dentro do AppModule ou de qualquer decorator NestJS —
//      seria tarde demais (NestFactory.create já disparou operações assíncronas).
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '64';

if (process.env.NEW_RELIC_ENABLED === 'true') {
  // New Relic precisa ser carregado via require síncrono antes de qualquer outro
  // módulo (http, pg, etc) para auto-instrumentação correta.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('newrelic');
}

import * as crypto from 'crypto';
import type {
  Application as ExpressApplication,
  RequestHandler,
  Request,
  Response,
  NextFunction,
} from 'express';
import type { Queue } from 'bullmq';
import { buildStructuredLoggerOptions } from './shared/logging/structured-winston';
import { createStructuredWinstonLogger } from './shared/logging/structured-winston';
import {
  initializeTelemetry,
  type TelemetryRuntime,
} from './shared/observability/opentelemetry.config';
import { initSentry, type SentryInitStatus } from './shared/monitoring/sentry';
import { validateCommonEnvironment } from './shared/config/environment-contract';
import {
  isCorsOriginAllowed,
  resolveAllowedCorsOrigins,
} from './shared/security/cors-origins';
import { ALLOWED_CORS_HEADERS } from './shared/security/cors-headers';
import { constantTimeEquals } from './shared/security/constant-time.util';
import type { VersionValue } from '@nestjs/common/interfaces';

const WEB_SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'sgs-backend';
const WEB_TELEMETRY_PORT = 9464;

const hasDefaultRequestHandlerExport = (
  value: unknown,
): value is { default: (...args: unknown[]) => RequestHandler } =>
  typeof value === 'object' &&
  value !== null &&
  'default' in value &&
  typeof value.default === 'function';

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: crypto.webcrypto || crypto,
    writable: true,
    configurable: true,
  });
}

function logObservabilityStatus(
  logger: ReturnType<typeof createStructuredWinstonLogger>,
  runtime: 'web' | 'worker',
  telemetry: TelemetryRuntime | null,
  sentryStatus: SentryInitStatus,
) {
  logger.info({
    event: 'observability_runtime',
    runtime,
    loggingFormat: 'json',
    telemetryEnabled: telemetry !== null,
    tracingExporter: telemetry ? 'otlp-http' : 'disabled',
    metricsExporter: telemetry ? 'prometheus' : 'disabled',
    otlpEndpoint: telemetry?.otlpEndpoint,
    prometheusPort: telemetry?.prometheusPort,
    tracingSampler: telemetry?.sampler,
    tracingSamplerArg: telemetry?.samplerArg,
    sentry: sentryStatus,
    newRelicEnabled: process.env.NEW_RELIC_ENABLED === 'true',
  });
}

async function bootstrap() {
  validateCommonEnvironment(process.env, { component: 'api' });
  const bootstrapLogger = createStructuredWinstonLogger(WEB_SERVICE_NAME);
  const webPort = Number(process.env.PORT || 8080);
  const requestedPrometheusPort = process.env.PROMETHEUS_PORT
    ? Number(process.env.PROMETHEUS_PORT)
    : WEB_TELEMETRY_PORT;

  const sentryStatus = initSentry('backend-web');
  const telemetry =
    process.env.OTEL_ENABLED === 'true'
      ? await initializeTelemetry({
          serviceName: process.env.OTEL_SERVICE_NAME || WEB_SERVICE_NAME,
          serviceVersion: process.env.OTEL_SERVICE_VERSION || '1.0.0',
          prometheusPort: requestedPrometheusPort,
          avoidPorts: [webPort],
        })
      : null;

  if (telemetry && telemetry.prometheusPort !== requestedPrometheusPort) {
    bootstrapLogger.warn({
      event: 'prometheus_port_adjusted',
      requestedPrometheusPort,
      effectivePrometheusPort: telemetry.prometheusPort,
      reservedPort: webPort,
    });
  }

  const [
    { assertNoPendingMigrationsInProd },
    { NestFactory },
    nestCommon,
    { AppModule },
    expressModule,
    { createBullBoard },
    { BullMQAdapter },
    { ExpressAdapter: BullBoardExpressAdapter },
    { getQueueToken },
    { WinstonModule },
    helmetModule,
    { AllExceptionsFilter },
    { SwaggerModule, DocumentBuilder },
  ] = await Promise.all([
    import('./shared/database/migration-startup.guard'),
    import('@nestjs/core'),
    import('@nestjs/common'),
    import('./app.module'),
    import('express'),
    import('@bull-board/api'),
    import('@bull-board/api/bullMQAdapter'),
    import('@bull-board/express'),
    import('@nestjs/bullmq'),
    import('nest-winston'),
    import('helmet'),
    import('./shared/filters/http-exception.filter'),
    import('@nestjs/swagger'),
  ]);
  const cookieParserImport: unknown = await import('cookie-parser');
  const compressionImport: unknown = await import('compression');

  await assertNoPendingMigrationsInProd();
  logObservabilityStatus(bootstrapLogger, 'web', telemetry, sentryStatus);

  const { BadRequestException, ValidationPipe, VersioningType } = nestCommon;
  const { json, urlencoded } = expressModule;
  const helmet = helmetModule.default ?? helmetModule;
  const cookieParser = hasDefaultRequestHandlerExport(cookieParserImport)
    ? cookieParserImport.default
    : undefined;
  const compression = hasDefaultRequestHandlerExport(compressionImport)
    ? compressionImport.default
    : undefined;
  const isProductionEnv = process.env.NODE_ENV === 'production';

  if (!cookieParser || !compression) {
    throw new Error(
      'Falha ao resolver cookie-parser/compression no bootstrap da API.',
    );
  }

  if (!('DOMMatrix' in globalThis)) {
    Object.defineProperty(globalThis, 'DOMMatrix', {
      value: class DOMMatrix {
        constructor() {
          // Empty constructor for polyfill
        }
      },
      writable: true,
      configurable: true,
    });
  }

  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger(
      buildStructuredLoggerOptions(WEB_SERVICE_NAME),
    ),
  });
  const httpAdapterInstance = app
    .getHttpAdapter()
    .getInstance() as Partial<ExpressApplication>;

  if (process.env.REDIS_DISABLED === 'true') {
    bootstrapLogger.warn({
      event: 'bull_board_disabled',
      reason: 'redis_disabled',
    });
  } else {
    const bullBoardAdapter = new BullBoardExpressAdapter();
    bullBoardAdapter.setBasePath('/admin/queues');
    try {
      createBullBoard({
        queues: [
          new BullMQAdapter(app.get<Queue>(getQueueToken('mail'))),
          new BullMQAdapter(app.get<Queue>(getQueueToken('pdf-generation'))),
          new BullMQAdapter(app.get<Queue>(getQueueToken('document-import'))),
          new BullMQAdapter(app.get<Queue>(getQueueToken('sla-escalation'))),
          // Nome confirmado em tasks/expiry-notifications-worker.module.ts
          new BullMQAdapter(
            app.get<Queue>(getQueueToken('expiry-notifications')),
          ),
          new BullMQAdapter(
            app.get<Queue>(getQueueToken('document-retention')),
          ),
          new BullMQAdapter(
            app.get<Queue>(getQueueToken('document-import-dlq')),
          ),
        ],
        serverAdapter: bullBoardAdapter,
      });
    } catch (error) {
      bootstrapLogger.warn({
        event: 'bull_board_init_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // Network-level IP restriction (localhost-only) must be enforced at the
    // infrastructure layer (nginx/firewall). req.socket.remoteAddress is always
    // the proxy IP behind a reverse proxy, so app-level IP checks provide no
    // protection and must not be relied upon for security.
    const bullBoardAuth: RequestHandler = (req, res, next) => {
      const password = process.env.BULL_BOARD_PASS;
      if (!password) {
        res.status(503).json({
          error: 'Bull Board desabilitado: configure BULL_BOARD_PASS',
        });
        return;
      }

      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
        res.status(401).json({ error: 'Autenticação necessária' });
        return;
      }
      const [user, pass] = Buffer.from(authHeader.slice(6), 'base64')
        .toString('utf-8')
        .split(':');
      const expectedUser = process.env.BULL_BOARD_USER || 'admin';
      if (
        !constantTimeEquals(user, expectedUser) ||
        !constantTimeEquals(pass, password)
      ) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
        res.status(401).json({ error: 'Credenciais inválidas' });
        return;
      }
      next();
    };
    app.use('/admin/queues', bullBoardAuth, bullBoardAdapter.getRouter());
  }

  if (isProductionEnv) {
    httpAdapterInstance.set?.('trust proxy', 1);
  }

  app.use(compression({ threshold: 1024, level: 6 }));
  httpAdapterInstance.disable?.('x-powered-by');

  // Nonce por requisição para o HTML servido pelo próprio backend (hoje apenas
  // a página de redefinição de senha). Sem ele, o CSP abaixo — que não inclui
  // 'unsafe-inline' — bloqueia o <style> e o <script> inline dessa página em
  // produção, deixando o fluxo de recuperação de senha inutilizável. Em
  // desenvolvimento o CSP roda em reportOnly, o que mascarava a falha.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        reportOnly: !isProductionEnv,
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            (_req, res) =>
              `'nonce-${(res as Response).locals.cspNonce as string}'`,
          ],
          styleSrc: [
            "'self'",
            (_req, res) =>
              `'nonce-${(res as Response).locals.cspNonce as string}'`,
          ],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: [],
        },
      },
      crossOriginEmbedderPolicy: true,
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  const securityHeadersMiddleware: RequestHandler = (_req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  };
  app.use(securityHeadersMiddleware);
  app.use(cookieParser());

  // robots.txt explícito para o domínio da API.
  // Evita fallback/404 gerenciado por edge sem headers de hardening e reduz
  // superfície de indexação indevida do subdomínio de API.
  httpAdapterInstance.get?.('/robots.txt', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Cache-Control',
      'public, max-age=86400, stale-while-revalidate=3600',
    );
    res.send('User-agent: *\nDisallow: /\n');
  });

  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: true, limit: '5mb' }));

  // Proteção contra prototype pollution — rejeita body com __proto__/constructor/prototype.
  // Deve rodar APÓS body-parser (que converte JSON string → objeto) e ANTES dos guards.
  const { protoPollutionMiddleware } =
    await import('./shared/middleware/proto-pollution.middleware');
  app.use(protoPollutionMiddleware);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      exceptionFactory: (errors) => {
        const formattedErrors = errors.map((error) => ({
          field: error.property,
          errors: Object.values(error.constraints || {}),
        }));
        const summary = formattedErrors
          .slice(0, 3)
          .map((e) => `${e.field}: ${e.errors[0]}`)
          .join('; ');
        return new BadRequestException({
          message: `Dados inválidos — ${summary}`,
          errors: formattedErrors,
        });
      },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Versionamento de API via URI prefix (/v1/, /v2/...).
  // defaultVersion = [VERSION_NEUTRAL, '1'] faz com que as rotas atendam
  // TANTO em `/aprs` (legado, sem prefixo) QUANTO em `/v1/aprs`, sem breaking
  // changes. Para introduzir uma v2 basta anotar o controller/método com
  // @Version('2') e o Nest roteia automaticamente em `/v2/...`.
  const apiDefaultVersion: VersionValue = [nestCommon.VERSION_NEUTRAL, '1'];
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: apiDefaultVersion,
    prefix: 'v',
  });

  const isProduction = isProductionEnv;
  const allowPrivateNetworkDevOrigins = /^true$/i.test(
    process.env.CORS_ALLOW_PRIVATE_NETWORK_DEV || '',
  );
  const allowedOrigins = resolveAllowedCorsOrigins({
    isProduction,
    configuredOriginsRaw: process.env.CORS_ALLOWED_ORIGINS,
  });

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      const isAllowed = isCorsOriginAllowed({
        origin,
        allowedOrigins,
        isProduction,
        allowPrivateNetworkDevOrigins,
      });
      if (isAllowed) {
        return callback(null, true);
      }
      if (origin && origin !== 'null') {
        bootstrapLogger.warn({
          event: 'cors_origin_blocked',
          origin,
          allowedOrigins,
        });
      }
      callback(null, false);
    },
    credentials: true,
    allowedHeaders: [...ALLOWED_CORS_HEADERS],
    exposedHeaders: ['X-Request-ID'],
  });

  if (process.env.NODE_ENV !== 'production') {
    // In-memory rate limiter for /api/docs — guards Basic Auth from brute force.
    // 30 requests per minute per IP; intentionally simple since Swagger is dev/staging only.
    const swaggerRateLimitBuckets = new Map<
      string,
      { count: number; resetAt: number }
    >();
    const swaggerRateLimitMiddleware: RequestHandler = (req, res, next) => {
      const ip =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.socket?.remoteAddress ||
        'unknown';
      const now = Date.now();
      const windowMs = 60_000;
      const limit = 30;

      // Periodic GC: only when the map grows large
      if (swaggerRateLimitBuckets.size > 500) {
        for (const [k, v] of swaggerRateLimitBuckets.entries()) {
          if (v.resetAt <= now) swaggerRateLimitBuckets.delete(k);
        }
      }

      const bucket = swaggerRateLimitBuckets.get(ip);
      if (!bucket || bucket.resetAt <= now) {
        swaggerRateLimitBuckets.set(ip, { count: 1, resetAt: now + windowMs });
        return next();
      }
      bucket.count += 1;
      if (bucket.count > limit) {
        res.status(429).json({ error: 'Too many requests' });
        return;
      }
      next();
    };
    app.use('/api/docs', swaggerRateLimitMiddleware);
    app.use('/api/docs-json', swaggerRateLimitMiddleware);

    const config = new DocumentBuilder()
      .setTitle('API Sistema Wanderson-Gandra')
      .setDescription(
        'Documentação completa da API.\n\n' +
          '**Versionamento**: todas as rotas atendem simultaneamente em `/<rota>` (legado, ' +
          'mantido para compatibilidade) e em `/v1/<rota>`. Novos clientes devem consumir ' +
          'a forma versionada (`/v1/...`). Futuras versões ficarão em `/v2/...` via ' +
          "`@Version('2')`.",
      )
      .setVersion('2.0')
      .addTag('auth', 'Autenticação e autorização')
      .addTag('users', 'Gestão de usuários')
      .addTag('companies', 'Gestão de empresas')
      .addTag('checklists', 'Gestão de checklists')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token JWT obtido no login (via httpOnly cookie)',
        },
        'access-token',
      )
      .addServer('http://localhost:3001', 'Desenvolvimento')
      .addServer('https://api.example.com', 'Produção')
      .build();

    const document = SwaggerModule.createDocument(app, config);

    // Em staging/homolog (qualquer NODE_ENV != production/development) exigimos
    // Basic Auth para acessar /api/docs. Em development fica aberto (DX).
    // Variáveis: SWAGGER_USER (default "admin"), SWAGGER_PASS (obrigatória fora de dev).
    const nodeEnv = process.env.NODE_ENV ?? 'development';
    const isDev = nodeEnv === 'development' || nodeEnv === 'test';
    const swaggerPass = process.env.SWAGGER_PASS;

    if (!isDev) {
      if (!swaggerPass) {
        bootstrapLogger.warn({
          event: 'swagger_disabled_missing_credentials',
          reason: 'SWAGGER_PASS não configurada em ambiente não-dev',
          nodeEnv,
        });
      } else {
        const swaggerUser = process.env.SWAGGER_USER || 'admin';
        const swaggerAuth: RequestHandler = (req, res, next) => {
          const authHeader = req.headers['authorization'];
          if (!authHeader || !authHeader.startsWith('Basic ')) {
            res.setHeader('WWW-Authenticate', 'Basic realm="API Docs"');
            res.status(401).json({ error: 'Autenticação necessária' });
            return;
          }
          const [user, pass] = Buffer.from(authHeader.slice(6), 'base64')
            .toString('utf-8')
            .split(':');
          if (
            !constantTimeEquals(user, swaggerUser) ||
            !constantTimeEquals(pass, swaggerPass)
          ) {
            res.setHeader('WWW-Authenticate', 'Basic realm="API Docs"');
            res.status(401).json({ error: 'Credenciais inválidas' });
            return;
          }
          next();
        };
        app.use('/api/docs', swaggerAuth);
        app.use('/api/docs-json', swaggerAuth);
      }
    }

    if (isDev || swaggerPass) {
      SwaggerModule.setup('api/docs', app, document, {
        customSiteTitle: 'API Docs',
        customfavIcon: '/favicon.ico',
        customCss: '.swagger-ui .topbar { display: none }',
      });

      bootstrapLogger.info({
        event: 'swagger_enabled',
        docsPath: '/api/docs',
        basicAuthEnforced: !isDev,
        port: process.env.PORT || 3001,
      });
    }
  }

  app.enableShutdownHooks();

  const port = webPort;
  await app.listen(port, '0.0.0.0');

  bootstrapLogger.info({
    event: 'web_booted',
    port: Number(port),
    nodeEnv: process.env.NODE_ENV || 'development',
    healthPath: '/health',
    healthPublicPath: '/health/public',
    uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE,
  });
}

bootstrap().catch((error) => {
  const bootstrapLogger = createStructuredWinstonLogger(WEB_SERVICE_NAME);
  bootstrapLogger.error({
    event: 'bootstrap_failed',
    errorName: error instanceof Error ? error.name : 'BootstrapError',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
