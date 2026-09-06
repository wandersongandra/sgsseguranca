'use strict';

const PRODUCTION_MARKERS = [
  'api.sgsseguranca.com.br',
  'app.sgsseguranca.com.br',
  'neon.tech',
  'upstash.io',
  'backblazeb2.com',
  'backblaze.com',
  'r2.cloudflarestorage.com',
];

const API_HOSTS = new Set([
  'api-loadtest',
  'api-loadtest.sgsseguranca.com.br',
]);
const DATABASE_HOST = 'postgres-loadtest';
const REDIS_HOST = 'redis-loadtest';
const STORAGE_HOST = 'minio-loadtest';
const EPHEMERAL_ACK = 'sgs-loadtest-ephemeral';

function reject(message) {
  throw new Error(`[loadtest-target-guard] REFUSED: ${message}`);
}

function parseUrl(value, label) {
  if (!value) reject(`${label} is required`);
  try {
    return new URL(String(value));
  } catch {
    reject(`${label} is malformed`);
  }
}

function isPrivateIpv4(host) {
  const parts = String(host).split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function isExplicitEphemeralHost(host, env) {
  return (
    env.LOADTEST_EPHEMERAL_TARGET_ACK === EPHEMERAL_ACK &&
    (host === 'localhost' || host === '127.0.0.1' || isPrivateIpv4(host))
  );
}

function assertNoProductionMarkers(env) {
  for (const [name, value] of Object.entries(env)) {
    const raw = String(value || '').toLowerCase();
    if (PRODUCTION_MARKERS.some((marker) => raw.includes(marker))) {
      reject(`${name} contains a forbidden production provider or domain marker`);
    }
  }
}

function assertLoadtestApiUrl(value, label = 'LOADTEST_API_URL', env = process.env) {
  const parsed = parseUrl(value, label);
  const host = parsed.hostname.toLowerCase();
  const isCanonicalHost = API_HOSTS.has(host);
  if (!isCanonicalHost && !isExplicitEphemeralHost(host, env)) {
    reject(`${label} must target api-loadtest or an explicitly acknowledged private ephemeral target`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    reject(`${label} must use HTTP(S)`);
  }
  if (parsed.username || parsed.password) {
    reject(`${label} must not contain credentials`);
  }
  return parsed;
}

function assertLoadtestDatabaseUrl(value, label = 'DATABASE_URL') {
  const parsed = parseUrl(value, label);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname.toLowerCase() !== DATABASE_HOST ||
    databaseName !== 'sgs_loadtest'
  ) {
    reject(`${label} must target postgres-loadtest/sgs_loadtest`);
  }
  return parsed;
}

function assertLoadtestDatabaseHost(value, label = 'DATABASE_HOST') {
  if (!value) return;
  if (String(value).trim().toLowerCase() !== DATABASE_HOST) {
    reject(`${label} must target ${DATABASE_HOST}`);
  }
}

function assertLoadtestRedisUrl(value, label = 'REDIS_URL') {
  const parsed = parseUrl(value, label);
  if (
    !['redis:', 'rediss:'].includes(parsed.protocol) ||
    parsed.hostname.toLowerCase() !== REDIS_HOST
  ) {
    reject(`${label} must target redis-loadtest`);
  }
  return parsed;
}

function assertLoadtestStorageEndpoint(value, label = 'STORAGE_ENDPOINT') {
  const parsed = parseUrl(value, label);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== STORAGE_HOST ||
    parsed.port !== '9000'
  ) {
    reject(`${label} must target https://minio-loadtest:9000`);
  }
  return parsed;
}

function assertLoadtestEnvironment(options = {}, env = process.env) {
  if (env.APP_ENV !== 'loadtest' || env.APP_LOADTEST_MARKER !== 'sgs-loadtest') {
    reject('APP_ENV=loadtest and APP_LOADTEST_MARKER=sgs-loadtest are mandatory');
  }
  if (env.NODE_ENV === 'production') {
    reject('NODE_ENV=production is never accepted');
  }
  if (env.DATABASE_NAME !== 'sgs_loadtest') {
    reject('DATABASE_NAME must be exactly sgs_loadtest');
  }
  assertNoProductionMarkers(env);

  const databaseUrl = env.DATABASE_URL;
  const migrationUrl = env.DATABASE_MIGRATION_URL;
  for (const name of [
    'DATABASE_URL',
    'DATABASE_MIGRATION_URL',
    'DATABASE_PRIVATE_URL',
    'DATABASE_PUBLIC_URL',
    'DATABASE_DIRECT_URL',
    'DATABASE_ADMIN_URL',
    'POSTGRES_URL',
  ]) {
    if (env[name]) assertLoadtestDatabaseUrl(env[name], name);
  }
  for (const name of ['DATABASE_HOST', 'PGHOST', 'POSTGRES_HOST']) {
    assertLoadtestDatabaseHost(env[name], name);
  }
  if (options.requireDatabase && !databaseUrl && !migrationUrl) {
    reject('a load-test PostgreSQL URL is required');
  }

  const apiUrl = env.LOADTEST_API_URL || (options.requireApi ? 'http://api-loadtest:3001' : '');
  if (apiUrl) assertLoadtestApiUrl(apiUrl, 'LOADTEST_API_URL', env);
  if (env.FAILURE_API_URL) assertLoadtestApiUrl(env.FAILURE_API_URL, 'FAILURE_API_URL', env);
  if (options.requireApi && !apiUrl) reject('LOADTEST_API_URL is required');

  const redisVariables = [
    'REDIS_URL',
    'REDIS_AUTH_URL',
    'REDIS_RATE_LIMIT_URL',
    'REDIS_CACHE_URL',
    'REDIS_QUEUE_URL',
  ];
  for (const name of redisVariables) {
    if (env[name]) assertLoadtestRedisUrl(env[name], name);
  }
  if (options.requireRedis && !redisVariables.some((name) => env[name])) {
    reject('a load-test Redis URL is required');
  }
  if (env.REDIS_HOST && String(env.REDIS_HOST).trim().toLowerCase() !== REDIS_HOST) {
    reject('REDIS_HOST must target redis-loadtest');
  }

  const storageEndpoint = env.STORAGE_ENDPOINT || env.AWS_ENDPOINT || env.AWS_S3_ENDPOINT;
  if (storageEndpoint) assertLoadtestStorageEndpoint(storageEndpoint);
  if (options.requireStorage && !storageEndpoint) {
    reject('a load-test storage endpoint is required');
  }

  for (const name of ['AWS_BUCKET_NAME', 'AWS_S3_BUCKET', 'DR_STORAGE_REPLICA_BUCKET']) {
    if (env[name] && !String(env[name]).startsWith('sgs-loadtest-')) {
      reject(`${name} must use the sgs-loadtest- prefix`);
    }
  }
  return true;
}

function assertLoadtestReturnedUrl(value, apiUrl, label = 'returned URL') {
  const parsed = parseUrl(value, label);
  const api = assertLoadtestApiUrl(apiUrl, 'LOADTEST_API_URL');
  const sameApi = parsed.origin === api.origin;
  const sameStorage =
    parsed.protocol === 'https:' &&
    parsed.hostname.toLowerCase() === STORAGE_HOST &&
    parsed.port === '9000';
  if (!sameApi && !sameStorage) reject(`${label} points outside the authorized load-test API/storage targets`);
  return parsed;
}

module.exports = {
  assertLoadtestEnvironment,
  assertLoadtestApiUrl,
  assertLoadtestDatabaseUrl,
  assertLoadtestRedisUrl,
  assertLoadtestStorageEndpoint,
  assertLoadtestReturnedUrl,
};
