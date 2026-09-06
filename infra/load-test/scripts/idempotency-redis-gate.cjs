/*
 * D2 runtime gate. This probe is private loadtest evidence, not product code.
 * It uses one unique run namespace and cleans only objects created by itself.
 */
const { assertLoadtestEnvironment } = require('./loadtest-target-guard.cjs');
assertLoadtestEnvironment({ requireApi: true, requireDatabase: true, requireRedis: true });

const crypto = require("node:crypto");
const { Client } = require("/app/node_modules/pg");
const { DataSource } = require("/app/node_modules/typeorm");
const Redis = require("/app/node_modules/ioredis");
const {
  IdempotencyService,
} = require("/app/dist/shared/idempotency/idempotency.service.js");

const RUN_ID = `D2_RUNTIME_${crypto.randomUUID().replaceAll("-", "")}`;
const MARKER = "SGS_P1_IDEMPOTENCY_REDIS";
const API_URL = String(
  process.env.LOADTEST_API_URL || "http://api-loadtest:3001",
).replace(/\/+$/, "");
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_RATE_LIMIT_URL || process.env.REDIS_URL;
const COMPANY_ID = process.env.LOADTEST_COMPANY_ID;
const EXPECTED_USER_ID = process.env.LOADTEST_USER_ID;
const CPF = process.env.LOADTEST_ADMIN_CPF;
const PASSWORD = process.env.LOADTEST_ADMIN_PASSWORD;
const RUN_TOKEN = RUN_ID.slice("D2_RUNTIME_".length);
const ACTIVITY_NAMES = [
  `D2_${RUN_TOKEN}_HTTP`,
  `D2_${RUN_TOKEN}_DUPLICATE`,
  `D2_${RUN_TOKEN}_CONFLICT_A`,
  `D2_${RUN_TOKEN}_CONFLICT_B`,
  `D2_${RUN_TOKEN}_CONCURRENT`,
  `D2_${RUN_TOKEN}_CONCURRENT_A`,
  `D2_${RUN_TOKEN}_CONCURRENT_B`,
];

class GateAssertionError extends Error {
  constructor(code) {
    super(code);
    this.name = "GateAssertionError";
    this.code = code;
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new GateAssertionError(code);
}

function internalHostname(urlValue, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new GateAssertionError("invalid_target_url");
  }
  requireCondition(allowedHosts.has(parsed.hostname), "external_target_host");
  return parsed;
}

function assertEnvironment() {
  requireCondition(
    process.env.APP_ENV === "loadtest",
    "loadtest_app_env_missing",
  );
  requireCondition(
    process.env.APP_LOADTEST_MARKER === "sgs-loadtest",
    "loadtest_marker_missing",
  );
  requireCondition(
    process.env.NODE_ENV !== "production",
    "production_target_denied",
  );
  requireCondition(
    process.env.DATABASE_NAME === "sgs_loadtest",
    "database_name_denied",
  );
  requireCondition(DATABASE_URL, "database_url_missing");
  requireCondition(REDIS_URL, "redis_url_missing");
  requireCondition(COMPANY_ID && EXPECTED_USER_ID, "fixture_identity_missing");
  requireCondition(CPF && PASSWORD, "fixture_credentials_missing");
  requireCondition(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      COMPANY_ID,
    ),
    "fixture_company_id_invalid",
  );
  requireCondition(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      EXPECTED_USER_ID,
    ),
    "fixture_user_id_invalid",
  );

  const api = internalHostname(
    API_URL,
    new Set(["api-loadtest", "127.0.0.1", "localhost"]),
  );
  requireCondition(api.protocol === "http:", "api_tls_policy_invalid");

  const database = internalHostname(
    DATABASE_URL,
    new Set(["postgres-loadtest", "127.0.0.1", "localhost", "::1"]),
  );
  requireCondition(
    ["postgres:", "postgresql:"].includes(database.protocol),
    "database_protocol_invalid",
  );
  requireCondition(
    decodeURIComponent(database.pathname.replace(/^\//, "")) === "sgs_loadtest",
    "database_target_invalid",
  );

  const redis = internalHostname(
    REDIS_URL,
    new Set(["redis-loadtest", "127.0.0.1", "localhost", "::1"]),
  );
  requireCondition(
    ["redis:", "rediss:"].includes(redis.protocol),
    "redis_protocol_invalid",
  );
  requireCondition(
    !/production|neon|upstash|backblaze|sgsseguranca\.com\.br/i.test(API_URL),
    "production_api_marker",
  );
  requireCondition(
    !/production|neon|upstash|backblaze|sgsseguranca\.com\.br/i.test(
      DATABASE_URL,
    ),
    "production_database_marker",
  );
  requireCondition(
    !/production|neon|upstash|backblaze|sgsseguranca\.com\.br/i.test(REDIS_URL),
    "production_redis_marker",
  );
  return { api, database, redis };
}

async function responseJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function cookieHeader(values) {
  return values
    .map((value) => String(value).split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function bodyEqual(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function decodeAccessTokenUserId(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

async function login() {
  const csrf = await fetch(`${API_URL}/auth/csrf`, {
    headers: { "user-agent": "sgs-d2-idempotency-gate/1.0" },
  });
  const csrfBody = await responseJson(csrf);
  const csrfCookies =
    typeof csrf.headers.getSetCookie === "function"
      ? csrf.headers.getSetCookie()
      : [csrf.headers.get("set-cookie") || ""];
  const csrfCookie =
    csrfCookies
      .filter((value) => /^csrf-token=.+/.test(String(value)))
      .at(-1)
      ?.split(";", 1)[0] || "";
  requireCondition(
    csrf.ok && csrfBody?.csrfToken && csrfCookie,
    "csrf_request_failed",
  );

  const loginResponse = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: csrfCookie,
      "x-csrf-token": csrfBody.csrfToken,
      "user-agent": "sgs-d2-idempotency-gate/1.0",
    },
    body: JSON.stringify({ cpf: CPF, password: PASSWORD }),
  });
  const loginBody = await responseJson(loginResponse);
  const loginCookies =
    typeof loginResponse.headers.getSetCookie === "function"
      ? loginResponse.headers.getSetCookie()
      : [loginResponse.headers.get("set-cookie") || ""];
  requireCondition(
    loginResponse.ok && typeof loginBody?.accessToken === "string",
    "login_failed",
  );
  const userId = decodeAccessTokenUserId(loginBody.accessToken);
  requireCondition(userId === EXPECTED_USER_ID, "login_identity_mismatch");
  return {
    authorization: `Bearer ${loginBody.accessToken}`,
    cookie: cookieHeader([csrfCookie, ...loginCookies]),
    csrfToken: csrfBody.csrfToken,
    userId,
  };
}

async function createActivity(session, key, name) {
  const response = await fetch(`${API_URL}/activities`, {
    method: "POST",
    headers: {
      authorization: session.authorization,
      cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      "x-idempotency-key": key,
      "user-agent": "sgs-d2-idempotency-gate/1.0",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      nome: name,
      descricao: `D2 runtime fixture ${RUN_ID}`,
      status: true,
    }),
  });
  return {
    status: response.status,
    replayed: response.headers.get("x-idempotent-replayed") === "true",
    body: await responseJson(response),
  };
}

function configStub() {
  return { get: () => undefined };
}

function fakeRedis({ down = false, failSet = false } = {}) {
  let quota = 0;
  return {
    set: async () => {
      if (down || failSet) throw new Error("synthetic_redis_failure");
      return "OK";
    },
    get: async () => {
      if (down) throw new Error("synthetic_redis_failure");
      return null;
    },
    del: async () => 0,
    exists: async () => 0,
    incr: async () => ++quota,
    decr: async () => Math.max(0, --quota),
    expire: async () => 1,
  };
}

function durableParameters(scope, method, path, key) {
  const hash = (value) =>
    crypto.createHash("sha256").update(value).digest("hex");
  return [hash(scope), method, path, hash(key)];
}

function redisKey(scope, method, path, key) {
  return `idempotency:${scope}:${method}:${path}:${key}`;
}

function quotaKey(scope) {
  return `idempotency:quota:${crypto.createHash("sha256").update(scope).digest("hex")}`;
}

function rememberRecord(state, scope, method, path, key) {
  const identity = JSON.stringify([scope, method, path, key]);
  let record = state.records.find((entry) => entry.identity === identity);
  if (!record) {
    record = { identity, scope, method, path, key, reserved: false };
    state.records.push(record);
  }
  return record;
}

async function reserveAndComplete(
  state,
  service,
  scope,
  method,
  path,
  key,
  requestHash,
) {
  const record = rememberRecord(state, scope, method, path, key);
  const acquisition = await service.markProcessing(
    scope,
    method,
    path,
    key,
    requestHash,
  );
  if (acquisition === "acquired") {
    record.reserved = true;
    await service.saveResponse(scope, method, path, key, requestHash, 200, {
      marker: RUN_ID,
      synthetic: true,
    });
  }
  return acquisition;
}

async function saveAndReadResponse(state, dataSource, redis, scope, key, body) {
  const path = "/d2/response-policy";
  const requestHash = crypto
    .createHash("sha256")
    .update(`${RUN_ID}:${key}`)
    .digest("hex");
  const record = rememberRecord(state, scope, "POST", path, key);
  const service = new IdempotencyService(redis, configStub(), dataSource);
  const acquisition = await service.markProcessing(
    scope,
    "POST",
    path,
    key,
    requestHash,
  );
  requireCondition(
    acquisition === "acquired",
    "response_policy_reservation_failed",
  );
  record.reserved = true;
  await service.saveResponse(scope, "POST", path, key, requestHash, 200, body);
  return service.getRecord(scope, "POST", path, key);
}

async function directScopeMatrix(state, dataSource, redis, primaryScope) {
  const requestHash = crypto
    .createHash("sha256")
    .update(`${RUN_ID}:scope`)
    .digest("hex");
  const service = new IdempotencyService(redis, configStub(), dataSource);
  const key = `d2-scope-${RUN_TOKEN}`;
  const otherUserScope = `tenant:${COMPANY_ID}:user:d2-user-${RUN_TOKEN}`;
  const otherTenantScope = `tenant:d2-tenant-${RUN_TOKEN}:user:${EXPECTED_USER_ID}`;
  const sameTenantOtherUser = await reserveAndComplete(
    state,
    service,
    otherUserScope,
    "POST",
    "/d2/scope",
    key,
    requestHash,
  );
  const differentMethod = await reserveAndComplete(
    state,
    service,
    primaryScope,
    "PATCH",
    "/d2/scope",
    key,
    requestHash,
  );
  const differentRoute = await reserveAndComplete(
    state,
    service,
    primaryScope,
    "POST",
    "/d2/other-route",
    key,
    requestHash,
  );
  const primaryKey = `d2-cross-tenant-${RUN_TOKEN}`;
  await reserveAndComplete(
    state,
    service,
    primaryScope,
    "POST",
    "/d2/cross-tenant",
    primaryKey,
    requestHash,
  );
  const crossTenantBeforeReservation = await service.getRecord(
    otherTenantScope,
    "POST",
    "/d2/cross-tenant",
    primaryKey,
  );
  const otherTenant = await reserveAndComplete(
    state,
    service,
    otherTenantScope,
    "POST",
    "/d2/cross-tenant",
    primaryKey,
    requestHash,
  );
  return {
    userScope: sameTenantOtherUser === "acquired",
    methodScope: differentMethod === "acquired",
    routeScope: differentRoute === "acquired",
    crossTenantReplayIsolation:
      crossTenantBeforeReservation === null && otherTenant === "acquired",
  };
}

async function compiledDurableProbe(state, dataSource, redis, primaryScope) {
  const path = "/d2/durable";
  const requestHash = crypto
    .createHash("sha256")
    .update(`${RUN_ID}:durable`)
    .digest("hex");
  const postCommitKey = `d2-post-redis-${RUN_TOKEN}`;
  const postCommitRecord = rememberRecord(
    state,
    primaryScope,
    "POST",
    path,
    postCommitKey,
  );
  const acquired = await new IdempotencyService(
    redis,
    configStub(),
    dataSource,
  ).markProcessing(primaryScope, "POST", path, postCommitKey, requestHash);
  requireCondition(acquired === "acquired", "durable_reservation_failed");
  postCommitRecord.reserved = true;

  let dbOkRedisFail = false;
  try {
    await new IdempotencyService(
      fakeRedis({ failSet: true }),
      configStub(),
      dataSource,
    ).saveResponse(
      primaryScope,
      "POST",
      path,
      postCommitKey,
      requestHash,
      201,
      { marker: RUN_ID, synthetic: true },
    );
  } catch {
    dbOkRedisFail = true;
  }
  const replayDuringRedisFailure = await new IdempotencyService(
    fakeRedis({ down: true }),
    configStub(),
    dataSource,
  ).getRecord(primaryScope, "POST", path, postCommitKey);

  const redisOnlyKey = `d2-redis-only-${RUN_TOKEN}`;
  const redisOnlyRawKey = redisKey(primaryScope, "POST", path, redisOnlyKey);
  state.redisOnlyKeys.push(redisOnlyRawKey);
  await redis.set(
    redisOnlyRawKey,
    JSON.stringify({ status: "completed", requestHash, responseStored: true }),
    "EX",
    60,
  );
  const redisOnlyLookup = await new IdempotencyService(
    redis,
    configStub(),
    dataSource,
  ).getRecord(primaryScope, "POST", path, redisOnlyKey);

  const redisDownKey = `d2-redis-down-${RUN_TOKEN}`;
  let redisDownFailClosed = false;
  try {
    await new IdempotencyService(
      fakeRedis({ down: true }),
      configStub(),
      dataSource,
    ).markProcessing(primaryScope, "POST", path, redisDownKey, requestHash);
  } catch {
    redisDownFailClosed = true;
  }

  const dbFailService = new IdempotencyService(redis, configStub(), {
    query: async () => {
      throw new Error("synthetic_database_failure");
    },
  });
  let redisOkDbFail = false;
  try {
    await dbFailService.getRecord(
      primaryScope,
      "POST",
      path,
      `d2-db-fail-${RUN_TOKEN}`,
    );
  } catch {
    redisOkDbFail = true;
  }

  const recoveryKey = `d2-recovery-${RUN_TOKEN}`;
  const recoveryAcquisition = await reserveAndComplete(
    state,
    new IdempotencyService(redis, configStub(), dataSource),
    primaryScope,
    "POST",
    path,
    recoveryKey,
    requestHash,
  );

  const sensitiveKey = `d2-sensitive-${RUN_TOKEN}`;
  const sensitiveReplay = await saveAndReadResponse(
    state,
    dataSource,
    redis,
    primaryScope,
    sensitiveKey,
    { marker: RUN_ID, authorization: "synthetic-not-secret" },
  );
  const nonSensitiveReplay = await saveAndReadResponse(
    state,
    dataSource,
    redis,
    primaryScope,
    `d2-non-sensitive-${RUN_TOKEN}`,
    { marker: RUN_ID, public: "safe-response-control" },
  );
  const nestedSensitiveReplay = await saveAndReadResponse(
    state,
    dataSource,
    redis,
    primaryScope,
    `d2-nested-sensitive-${RUN_TOKEN}`,
    { marker: RUN_ID, payload: { authorization: "synthetic-not-secret" } },
  );
  const arraySensitiveReplay = await saveAndReadResponse(
    state,
    dataSource,
    redis,
    primaryScope,
    `d2-array-sensitive-${RUN_TOKEN}`,
    { marker: RUN_ID, items: [{ token: "synthetic-not-secret" }] },
  );
  const oversizedReplay = await saveAndReadResponse(
    state,
    dataSource,
    redis,
    primaryScope,
    `d2-oversized-${RUN_TOKEN}`,
    { marker: RUN_ID, description: "x".repeat(70 * 1024) },
  );

  const scope = await directScopeMatrix(state, dataSource, redis, primaryScope);
  const sameKey = `d2-concurrent-${RUN_TOKEN}`;
  const concurrentHash = crypto
    .createHash("sha256")
    .update(`${RUN_ID}:concurrent`)
    .digest("hex");
  const concurrentRecord = rememberRecord(
    state,
    primaryScope,
    "POST",
    "/d2/concurrent",
    sameKey,
  );
  const concurrentResults = await Promise.all([
    new IdempotencyService(redis, configStub(), dataSource).markProcessing(
      primaryScope,
      "POST",
      "/d2/concurrent",
      sameKey,
      concurrentHash,
    ),
    new IdempotencyService(redis, configStub(), dataSource).markProcessing(
      primaryScope,
      "POST",
      "/d2/concurrent",
      sameKey,
      concurrentHash,
    ),
  ]);
  concurrentRecord.reserved = concurrentResults.includes("acquired");

  return {
    dbOkRedisFail,
    durableReplayWhileRedisDown:
      replayDuringRedisFailure?.status === "completed" &&
      replayDuringRedisFailure.requestHash === requestHash,
    redisOnlyCompletedIgnored: redisOnlyLookup === null,
    redisDownFailClosed,
    redisOkDbFail,
    redisRecovery: recoveryAcquisition === "acquired",
    sensitiveResponseStored: sensitiveReplay?.responseStored === true,
    sensitiveResponseBodyPresent: Boolean(
      sensitiveReplay && Object.hasOwn(sensitiveReplay, "body"),
    ),
    sensitiveResponseNotStored:
      sensitiveReplay?.responseStored === false &&
      !Object.hasOwn(sensitiveReplay, "body"),
    nonSensitiveResponseStored:
      nonSensitiveReplay?.responseStored === true &&
      nonSensitiveReplay?.body?.public === "safe-response-control",
    nestedSensitiveResponseNotStored:
      nestedSensitiveReplay?.responseStored === false &&
      !Object.hasOwn(nestedSensitiveReplay, "body"),
    arraySensitiveResponseNotStored:
      arraySensitiveReplay?.responseStored === false &&
      !Object.hasOwn(arraySensitiveReplay, "body"),
    oversizedResponseNotStored:
      oversizedReplay?.responseStored === false &&
      !Object.hasOwn(oversizedReplay, "body"),
    scope,
    concurrentDuplicateSuppression:
      concurrentResults.filter((value) => value === "acquired").length === 1 &&
      concurrentResults.filter((value) => value === "exists").length === 1,
  };
}

async function queryActivityCount(client, names) {
  const result = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE deleted_at IS NULL)::int AS active
       FROM public.activities
      WHERE company_id = $1
        AND nome = ANY($2::text[])`,
    [COMPANY_ID, names],
  );
  return {
    total: Number(result.rows[0]?.total || 0),
    active: Number(result.rows[0]?.active || 0),
  };
}

async function assertFixtureOwnership(client) {
  const result = await client.query(
    `SELECT c.id, u.id
       FROM public.companies c
       JOIN public.users u ON u.company_id = c.id
      WHERE c.id = $1
        AND c.razao_social LIKE 'SGS_LOADTEST_SYNTHETIC%'
        AND u.id = $2
        AND u.email = 'loadtest.admin@invalid.test'
        AND u.status = true
        AND u.deleted_at IS NULL
      LIMIT 1`,
    [COMPANY_ID, EXPECTED_USER_ID],
  );
  requireCondition(result.rows.length === 1, "fixture_ownership_not_proven");
}

async function cleanup(state, client, dataSource, redis) {
  const summary = {
    durableDeleted: 0,
    redisDeleted: 0,
    redisOnlyDeleted: 0,
    activitiesSoftDeleted: 0,
    activeActivitiesRemaining: null,
    totalRunActivities: null,
    durableRemaining: 0,
    redisRemaining: 0,
  };

  for (const record of state.records) {
    const [scopeHash, method, path, keyHash] = durableParameters(
      record.scope,
      record.method,
      record.path,
      record.key,
    );
    const removed = await dataSource.query(
      `DELETE FROM public.idempotency_durable_records
        WHERE scope_hash = $1
          AND method = $2
          AND path = $3
          AND idempotency_key_hash = $4
       RETURNING id`,
      [scopeHash, method, path, keyHash],
    );
    summary.durableDeleted += removed.length;
    const redisRemoved = await redis.del(
      redisKey(record.scope, record.method, record.path, record.key),
    );
    summary.redisDeleted += Number(redisRemoved || 0);
    if (record.reserved && redisRemoved > 0) {
      await redis.decr(quotaKey(record.scope));
    }
  }

  for (const key of state.redisOnlyKeys) {
    summary.redisOnlyDeleted += Number(await redis.del(key));
  }

  const activityUpdate = await client.query(
    `UPDATE public.activities
        SET deleted_at = NOW()
      WHERE company_id = $1
        AND nome = ANY($2::text[])
        AND deleted_at IS NULL`,
    [COMPANY_ID, state.activityNames],
  );
  summary.activitiesSoftDeleted = Number(activityUpdate.rowCount || 0);
  const activityCount = await queryActivityCount(client, state.activityNames);
  summary.activeActivitiesRemaining = activityCount.active;
  summary.totalRunActivities = activityCount.total;

  for (const record of state.records) {
    const [scopeHash, method, path, keyHash] = durableParameters(
      record.scope,
      record.method,
      record.path,
      record.key,
    );
    const remaining = await dataSource.query(
      `SELECT count(*)::int AS count
         FROM public.idempotency_durable_records
        WHERE scope_hash = $1
          AND method = $2
          AND path = $3
          AND idempotency_key_hash = $4`,
      [scopeHash, method, path, keyHash],
    );
    summary.durableRemaining += Number(remaining[0]?.count || 0);
    summary.redisRemaining += Number(
      await redis.exists(
        redisKey(record.scope, record.method, record.path, record.key),
      ),
    );
  }
  for (const key of state.redisOnlyKeys) {
    summary.redisRemaining += Number(await redis.exists(key));
  }
  return summary;
}

async function main() {
  let dataSource;
  let client;
  let redis;
  const state = {
    records: [],
    redisOnlyKeys: [],
    activityNames: [...ACTIVITY_NAMES],
  };
  let result = { target: "loadtest", pass: false };
  let failureCode = null;
  let cleanupResult = null;

  try {
    const target = assertEnvironment();
    dataSource = new DataSource({
      type: "postgres",
      url: DATABASE_URL,
      synchronize: false,
      entities: [],
    });
    client = new Client({ connectionString: DATABASE_URL });
    redis = new Redis(REDIS_URL);
    await dataSource.initialize();
    await client.connect();
    await client.query(
      "SELECT set_config('app.current_company_id', $1, false), set_config('app.current_company', $1, false), set_config('app.current_user_id', $2, false), set_config('app.is_super_admin', 'false', false)",
      [COMPANY_ID, EXPECTED_USER_ID],
    );
    await dataSource.query("SELECT 1");
    const pong = await redis.ping();
    const policy = await redis.config("GET", "maxmemory-policy");
    requireCondition(pong === "PONG", "redis_ping_failed");
    requireCondition(
      policy[1] === "noeviction",
      "redis_eviction_policy_invalid",
    );
    await assertFixtureOwnership(client);
    const beforeActivities = await queryActivityCount(
      client,
      state.activityNames,
    );
    requireCondition(
      beforeActivities.total === 0,
      "activity_fixture_name_collision",
    );

    const session = await login();
    const primaryScope = `tenant:${COMPANY_ID}:user:${session.userId}`;
    const httpKey = `d2-http-${RUN_TOKEN}`;
    const httpRecord = rememberRecord(
      state,
      primaryScope,
      "POST",
      "/activities",
      httpKey,
    );
    httpRecord.reserved = true;
    const first = await createActivity(session, httpKey, ACTIVITY_NAMES[0]);
    const replay = await createActivity(session, httpKey, ACTIVITY_NAMES[0]);
    const mismatch = await createActivity(session, httpKey, ACTIVITY_NAMES[1]);
    const httpRowCount = await queryActivityCount(client, [
      ACTIVITY_NAMES[0],
      ACTIVITY_NAMES[1],
    ]);
    const httpReplay =
      first.status === 201 &&
      replay.status === 201 &&
      replay.replayed &&
      bodyEqual(first.body, replay.body) &&
      mismatch.status === 409 &&
      httpRowCount.total === 1;

    const concurrentKey = `d2-api-concurrent-${RUN_TOKEN}`;
    const concurrentApiRecord = rememberRecord(
      state,
      primaryScope,
      "POST",
      "/activities",
      concurrentKey,
    );
    concurrentApiRecord.reserved = true;
    const concurrent = await Promise.all([
      createActivity(session, concurrentKey, ACTIVITY_NAMES[4]),
      createActivity(session, concurrentKey, ACTIVITY_NAMES[4]),
    ]);
    const concurrentRows = await queryActivityCount(client, [
      ACTIVITY_NAMES[4],
    ]);
    const concurrentDuplicate =
      concurrentRows.total === 1 &&
      concurrent.every(
        (entry) => entry.status === 201 || entry.status === 409,
      ) &&
      concurrent.filter((entry) => entry.status === 201).length >= 1;

    const conflictKey = `d2-api-conflict-${RUN_TOKEN}`;
    const conflictApiRecord = rememberRecord(
      state,
      primaryScope,
      "POST",
      "/activities",
      conflictKey,
    );
    conflictApiRecord.reserved = true;
    const conflict = await Promise.all([
      createActivity(session, conflictKey, ACTIVITY_NAMES[5]),
      createActivity(session, conflictKey, ACTIVITY_NAMES[6]),
    ]);
    const conflictRows = await queryActivityCount(client, [
      ACTIVITY_NAMES[5],
      ACTIVITY_NAMES[6],
    ]);
    const concurrentConflict =
      conflict.filter((entry) => entry.status === 201).length === 1 &&
      conflict.filter((entry) => entry.status === 409).length === 1 &&
      conflictRows.total === 1;

    const durable = await compiledDurableProbe(
      state,
      dataSource,
      redis,
      primaryScope,
    );
    const pass =
      httpReplay &&
      concurrentDuplicate &&
      concurrentConflict &&
      durable.dbOkRedisFail &&
      durable.durableReplayWhileRedisDown &&
      durable.redisOnlyCompletedIgnored &&
      durable.redisDownFailClosed &&
      durable.redisOkDbFail &&
      durable.redisRecovery &&
      durable.sensitiveResponseNotStored &&
      durable.nonSensitiveResponseStored &&
      durable.nestedSensitiveResponseNotStored &&
      durable.arraySensitiveResponseNotStored &&
      durable.oversizedResponseNotStored &&
      durable.concurrentDuplicateSuppression &&
      durable.scope.userScope &&
      durable.scope.methodScope &&
      durable.scope.routeScope &&
      durable.scope.crossTenantReplayIsolation;
    result = {
      runId: RUN_ID,
      target: {
        appEnv: "loadtest",
        database: "sgs_loadtest",
        apiHost: target.api.hostname,
        databaseHost: target.database.hostname,
        redisHost: target.redis.hostname,
        redisMaxmemoryPolicy: policy[1] || null,
      },
      http: {
        first: first.status,
        replay: replay.status,
        replayHeader: replay.replayed,
        payloadConflict: mismatch.status,
        exactReplayBody: bodyEqual(first.body, replay.body),
        createdRows: httpRowCount.total,
        pass: httpReplay,
      },
      apiConcurrency: {
        duplicateStatuses: concurrent
          .map((entry) => entry.status)
          .sort((a, b) => a - b),
        duplicateRows: concurrentRows.total,
        payloadConflictStatuses: conflict
          .map((entry) => entry.status)
          .sort((a, b) => a - b),
        payloadConflictRows: conflictRows.total,
        duplicateSuppression: concurrentDuplicate,
        payloadConflict: concurrentConflict,
      },
      durable,
      cleanup: null,
      pass,
    };
    if (!pass) failureCode = "runtime_matrix_failed";
  } catch (error) {
    failureCode =
      error instanceof GateAssertionError ? error.code : "runtime_probe_error";
    result = { runId: RUN_ID, target: "loadtest", pass: false };
  } finally {
    if (dataSource && client && redis) {
      try {
        cleanupResult = await cleanup(state, client, dataSource, redis);
      } catch {
        cleanupResult = {
          cleanupError: "cleanup_failed",
          activeActivitiesRemaining: null,
          durableRemaining: null,
          redisRemaining: null,
        };
        failureCode = failureCode || "cleanup_failed";
      }
    }
    if (client) await client.end().catch(() => undefined);
    if (dataSource?.isInitialized)
      await dataSource.destroy().catch(() => undefined);
    if (redis) redis.disconnect();
  }

  result.cleanup = cleanupResult;
  const cleanupPass =
    cleanupResult &&
    cleanupResult.activeActivitiesRemaining === 0 &&
    cleanupResult.durableRemaining === 0 &&
    cleanupResult.redisRemaining === 0;
  result.cleanupPass = Boolean(cleanupPass);
  result.pass = Boolean(result.pass && cleanupPass);
  if (!result.pass) result.failure = failureCode || "runtime_gate_failed";
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}

main().catch(() => {
  console.error(
    JSON.stringify({
      runId: RUN_ID,
      target: "loadtest",
      pass: false,
      failure: "fatal_probe_error",
    }),
  );
  process.exitCode = 1;
});
