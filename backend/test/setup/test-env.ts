import * as dotenv from 'dotenv';
import * as path from 'path';

let bootstrapped = false;

function applyDefault(key: string, value: string) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

function applyForced(key: string, value: string) {
  process.env[key] = value;
}

function buildE2ERedisUrl() {
  return `redis://${process.env.E2E_REDIS_HOST || '127.0.0.1'}:${process.env.E2E_REDIS_PORT || '6379'}`;
}

export function bootstrapBackendTestEnvironment() {
  if (bootstrapped) {
    return;
  }

  dotenv.config({
    path: path.resolve(__dirname, '../.env'),
    override: false,
    quiet: true,
  });

  applyDefault('NODE_ENV', 'test');
  applyDefault('TZ', 'UTC');
  applyDefault('LOG_LEVEL', 'error');
  applyDefault('OTEL_ENABLED', 'false');
  applyDefault('NEW_RELIC_ENABLED', 'false');
  applyForced('SEED_ON_BOOTSTRAP', 'false');
  applyForced('DISABLE_AUTO_CONSENT_SEED', 'true');
  applyForced('API_CRONS_DISABLED', 'true');
  applyForced('CACHE_WARMING_ENABLED', 'false');
  applyForced('TENANT_VALIDATION_WARMUP_ENABLED', 'false');
  applyForced('RBAC_WARMUP_ENABLED', 'false');
  applyForced('DASHBOARD_DOCUMENT_AVAILABILITY_WARMUP_ENABLED', 'false');
  applyForced('WORKER_HEARTBEAT_ENABLED', 'false');
  applyForced(
    'DOCUMENT_DOWNLOAD_TOKEN_SECRET',
    'test-document-download-secret-0123456789',
  );
  applyForced('FIELD_ENCRYPTION_ENABLED', 'true');
  applyForced(
    'FIELD_ENCRYPTION_KEY',
    'test-field-encryption-key-'.padEnd(32, 'x'),
  );
  applyForced(
    'FIELD_ENCRYPTION_HASH_KEY',
    'test-field-encryption-hash-key-0123456789abcdef',
  );
  applyForced('MFA_TOTP_ENCRYPTION_KEY', '0'.repeat(64));
  applyForced('ADMIN_GERAL_MFA_REQUIRED', 'false');

  // E2E: usa autenticação local (password em `users`).
  applyForced('LEGACY_PASSWORD_AUTH_ENABLED', 'true');

  // E2E: usa filesystem local apenas quando S3/MinIO não estiver configurado.
  // Quando o bucket governado está disponível, o teste deve exercitar presign real.
  if (!process.env.AWS_BUCKET_NAME && !process.env.AWS_S3_BUCKET) {
    applyForced(
      'LOCAL_DOCUMENT_STORAGE_DIR',
      process.env.LOCAL_DOCUMENT_STORAGE_DIR ||
        path.resolve(process.cwd(), 'temp', 'e2e-document-storage'),
    );
  } else {
    applyForced('LOCAL_DOCUMENT_STORAGE_DIR', '');
  }

  // JWT — valores de teste, min 64 chars (schema Joi exige 64 em todos os ambientes)
  applyForced(
    'JWT_SECRET',
    'test-jwt-secret-for-e2e-testing-only-0123456789-padded-to-64-chars',
  );
  applyForced(
    'JWT_REFRESH_SECRET',
    'test-refresh-secret-for-e2e-testing-only-0123456789-padded-64chars',
  );
  applyForced('JWT_ISSUER', 'https://jwt.test.sgs.local');
  applyForced('JWT_AUDIENCE', 'sgs-test');

  // bcrypt: 4 rounds = rápido em testes
  applyDefault('BCRYPT_SALT_ROUNDS', '4');

  // Throttle: limites altos para não interferir nos testes
  applyDefault('THROTTLE_LIMIT', '10000');
  applyDefault('THROTTLE_TTL', '60000');
  applyForced('LOGIN_THROTTLE_LIMIT', '10000');
  applyForced('FORGOT_PASSWORD_THROTTLE_LIMIT', '10000');
  applyForced('CHANGE_PASSWORD_THROTTLE_LIMIT', '10000');
  applyDefault('DISABLE_LOGIN_THROTTLE_IN_DEV', 'true');
  applyForced('REDIS_FAIL_OPEN', 'false');
  applyForced('ANTIVIRUS_PROVIDER', '');

  // Força testes e2e/integration a usarem DB host/port explícitos do ambiente de teste,
  // evitando herdar DATABASE_URL de shells locais (ex.: Railway) e conectar em 5432 por engano.
  applyForced('DATABASE_HOST', process.env.E2E_DATABASE_HOST || '127.0.0.1');
  applyForced('DATABASE_PORT', process.env.E2E_DATABASE_PORT || '5433');
  applyForced('DATABASE_USER', process.env.E2E_DATABASE_USER || 'postgres');
  applyForced(
    'DATABASE_PASSWORD',
    process.env.E2E_DATABASE_PASSWORD || 'postgres123',
  );
  applyForced('DATABASE_NAME', process.env.E2E_DATABASE_NAME || 'sst_test');
  applyForced('REDIS_HOST', process.env.E2E_REDIS_HOST || '127.0.0.1');
  applyForced('REDIS_PORT', process.env.E2E_REDIS_PORT || '6379');
  applyForced('CLAMAV_HOST', process.env.E2E_CLAMAV_HOST || '127.0.0.1');
  applyForced('CLAMAV_PORT', process.env.E2E_CLAMAV_PORT || '3310');
  const e2eRedisUrl = buildE2ERedisUrl();
  applyForced('REDIS_AUTH_URL', process.env.E2E_REDIS_AUTH_URL || e2eRedisUrl);
  applyForced(
    'REDIS_CACHE_URL',
    process.env.E2E_REDIS_CACHE_URL || e2eRedisUrl,
  );
  applyForced(
    'REDIS_QUEUE_URL',
    process.env.E2E_REDIS_QUEUE_URL || e2eRedisUrl,
  );

  applyForced('DATABASE_URL', '');
  applyForced('DATABASE_PRIVATE_URL', '');
  applyForced('DATABASE_PUBLIC_URL', '');
  applyForced('DATABASE_DIRECT_URL', '');
  applyForced('URL_DO_BANCO_DE_DADOS', '');
  applyForced('DATABASE_SSL', 'false');
  applyForced('DATABASE_SSL_ALLOW_INSECURE', 'false');
  applyForced('DATABASE_SSL_ALLOW_INSECURE_FORCE', 'false');
  applyForced('BANCO_DE_DADOS_SSL', 'false');

  // Telemetria desabilitada em testes
  applyDefault('REDIS_DISABLED', 'false');

  bootstrapped = true;
}

bootstrapBackendTestEnvironment();
