import { fileURLToPath, URL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadCanonicalEnvironmentContract() {
  for (const candidate of [
    "/app/dist/shared/config/environment-contract.js",
    new URL(
      "../../../backend/dist/shared/config/environment-contract.js",
      import.meta.url,
    ),
  ]) {
    try {
      return require(
        candidate instanceof URL ? fileURLToPath(candidate) : candidate,
      );
    } catch {
      // Source-only guard tests may run before the backend build exists.
    }
  }
  return null;
}

const canonicalEnvironmentContract = loadCanonicalEnvironmentContract();

const PRODUCTION_MARKERS = [
  "api.sgsseguranca.com.br",
  "app.sgsseguranca.com.br",
  "neon.tech",
  "upstash.io",
  "backblazeb2.com",
  "backblaze.com",
  "r2.cloudflarestorage.com",
];

const ALLOWED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "postgres-loadtest",
  "redis-loadtest",
  "minio-loadtest",
  "api-loadtest.sgsseguranca.com.br",
]);

function isPrivateIpv4(host) {
  const parts = String(host).split(".").map(Number);
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

function hostFrom(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(
      raw.includes("://") ? raw : `http://${raw}`,
    ).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isAllowedHost(host) {
  return ALLOWED_HOSTS.has(host) || isPrivateIpv4(host);
}

function reject(reason) {
  throw new Error(`[loadtest-guard] REFUSED: ${reason}`);
}

export function assertLoadtestEnvironment(env = process.env) {
  if (canonicalEnvironmentContract) {
    try {
      canonicalEnvironmentContract.assertNoUnknownSgsEnvironmentKeys(env);
    } catch (error) {
      reject(
        error instanceof Error
          ? error.message
          : "environment contract rejected",
      );
    }
  }
  assertLoadtestIdentity(env);
  assertLoadtestNetwork(env);
  assertNoProductionMarkers(env);
  assertLoadtestBuckets(env);
  assertLoadtestRedisHosts(env);
  return true;
}

function assertLoadtestIdentity(env) {
  if (
    env.APP_ENV !== "loadtest" ||
    env.APP_LOADTEST_MARKER !== "sgs-loadtest"
  ) {
    reject(
      "APP_ENV=loadtest and APP_LOADTEST_MARKER=sgs-loadtest are mandatory",
    );
  }
  if (env.NODE_ENV === "production") {
    reject("NODE_ENV=production is never accepted");
  }
  if (env.DATABASE_NAME !== "sgs_loadtest") {
    reject("database name must be exactly sgs_loadtest");
  }
  if (
    env.DATABASE_HOST &&
    !isAllowedHost(String(env.DATABASE_HOST).toLowerCase())
  ) {
    reject("DATABASE_HOST is outside the load-test allowlist");
  }
}

function assertLoadtestNetwork(env) {
  const networkValues = [
    ["DATABASE_URL", env.DATABASE_URL],
    ["DATABASE_MIGRATION_URL", env.DATABASE_MIGRATION_URL],
    ["REDIS_URL", env.REDIS_URL],
    ["REDIS_AUTH_URL", env.REDIS_AUTH_URL],
    ["REDIS_RATE_LIMIT_URL", env.REDIS_RATE_LIMIT_URL],
    ["REDIS_CACHE_URL", env.REDIS_CACHE_URL],
    ["REDIS_QUEUE_URL", env.REDIS_QUEUE_URL],
    ["AWS_ENDPOINT", env.AWS_ENDPOINT],
    ["API_PUBLIC_URL", env.API_PUBLIC_URL],
    ["BASE_URL", env.BASE_URL],
  ];

  for (const [name, value] of networkValues) {
    const raw = String(value || "")
      .trim()
      .toLowerCase();
    if (!raw) continue;
    if (PRODUCTION_MARKERS.some((marker) => raw.includes(marker))) {
      reject(`${name} contains a production provider or domain marker`);
    }
    const host = hostFrom(raw);
    if (!host || !isAllowedHost(host)) {
      reject(`${name} points outside the load-test host allowlist`);
    }
  }
}

function assertNoProductionMarkers(env) {
  for (const [name, value] of Object.entries(env)) {
    const raw = String(value || "").toLowerCase();
    if (PRODUCTION_MARKERS.some((marker) => raw.includes(marker))) {
      reject(`${name} contains a forbidden production marker`);
    }
  }
}

function assertLoadtestBuckets(env) {
  for (const bucketName of [
    "AWS_BUCKET_NAME",
    "AWS_S3_BUCKET",
    "DR_STORAGE_REPLICA_BUCKET",
  ]) {
    const bucket = String(env[bucketName] || "").trim();
    if (bucket && !bucket.startsWith("sgs-loadtest-")) {
      reject(`${bucketName} must use the sgs-loadtest- prefix`);
    }
  }
}

function assertLoadtestRedisHosts(env) {
  const redisHosts = [
    "REDIS_AUTH_HOST",
    "REDIS_RATE_LIMIT_HOST",
    "REDIS_CACHE_HOST",
    "REDIS_QUEUE_HOST",
  ];
  for (const name of redisHosts) {
    const value = String(env[name] || "")
      .trim()
      .toLowerCase();
    if (value && !isAllowedHost(value)) {
      reject(`${name} points outside the load-test host allowlist`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    assertLoadtestEnvironment();
    console.log(
      "[loadtest-guard] OK: isolated load-test configuration accepted",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
