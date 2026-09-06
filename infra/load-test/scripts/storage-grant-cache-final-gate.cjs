/*
 * P0 storage/grant/cache gate.
 *
 * Loadtest only. The script creates a new synthetic fixture, never deletes
 * pre-existing rows/objects/Redis keys, and reports hashes instead of tokens,
 * e-mails, file keys or cache values.
 */
const { assertLoadtestEnvironment } = require('./loadtest-target-guard.cjs');
assertLoadtestEnvironment({ requireApi: true, requireDatabase: true, requireRedis: true, requireStorage: true });

const crypto = require("node:crypto");
const { Client } = require("/app/node_modules/pg");
const argon2 = require("/app/node_modules/argon2");
const jwt = require("/app/node_modules/jsonwebtoken");
const Redis = require("/app/node_modules/ioredis");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  ListBucketsCommand,
} = require("/app/node_modules/@aws-sdk/client-s3");

const API_URL = String(
  process.env.LOADTEST_API_URL || "http://api-loadtest:3001",
).replace(/\/+$/, "");
const MARKER = "SGS_STORAGE_RUNTIME";
const PASSWORD = `StorageRuntime-${crypto.randomBytes(24).toString("base64url")}`;
const USER_AGENT = "sgs-p0-storage-grant-cache-gate/1.0";
const MAX_RETRIES_AFTER_RATE_LIMIT = 2;
const PDF_A = Buffer.from(
  "%PDF-1.4\n% synthetic tenant A storage gate\n%%EOF\n",
  "ascii",
);
const PDF_B = Buffer.from(
  "%PDF-1.4\n% synthetic tenant B storage gate\n%%EOF\n",
  "ascii",
);
const runId = `STORAGE_RUNTIME_${crypto.randomBytes(12).toString("hex")}`;
const PROVIDER_ENDPOINT = String(process.env.STORAGE_ENDPOINT || "").trim();
const cleanupState = {
  companyIds: [],
  siteIds: [],
  userIds: [],
  registryIds: [],
  grantIds: [],
  providerKeys: new Set(),
  providerPrefixes: new Set(),
  redisKeys: new Set(),
};
let currentStage = "startup";

function fail(message) {
  throw new Error(`[storage-grant-cache-gate] ${message}`);
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashText(value) {
  return hash(Buffer.from(String(value)));
}

function uuid() {
  return crypto.randomUUID();
}

function assertEnvironment() {
  if (
    process.env.APP_ENV !== "loadtest" ||
    process.env.APP_LOADTEST_MARKER !== "sgs-loadtest"
  ) {
    fail("loadtest marker missing");
  }
  if (process.env.DATABASE_NAME !== "sgs_loadtest")
    fail("database is not sgs_loadtest");
  if (!process.env.DATABASE_MIGRATION_URL)
    fail("DATABASE_MIGRATION_URL missing");
  if (!process.env.DOCUMENT_DOWNLOAD_TOKEN_SECRET)
    fail("document token secret missing");
  if (!process.env.REDIS_URL) fail("REDIS_URL missing");
  if (
    !process.env.STORAGE_ACCESS_KEY_ID ||
    !process.env.STORAGE_SECRET_ACCESS_KEY
  ) {
    fail("provider verification credentials missing");
  }
  if (!PROVIDER_ENDPOINT) fail("provider endpoint missing");
  let endpoint;
  try {
    endpoint = new URL(PROVIDER_ENDPOINT);
  } catch {
    fail("provider endpoint is malformed");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  ) {
    fail("provider endpoint contains credentials or unexpected path");
  }
  if (endpoint.protocol !== "https:" || !process.env.NODE_EXTRA_CA_CERTS)
    fail("provider endpoint must use verified HTTPS");
  if (endpoint.hostname !== "minio-loadtest" || endpoint.port !== "9000") {
    fail("provider endpoint is not the authorized loadtest target");
  }
  if (process.env.PROVIDER_TARGET_IDENTITY !== "sgs-loadtest-minio")
    fail("provider target identity mismatch");
  if (process.env.PROVIDER_NETWORK !== "sgs-loadtest-internal")
    fail("provider network mismatch");
  if (process.env.PROVIDER_ALLOWED_BUCKET !== process.env.STORAGE_BUCKET)
    fail("provider bucket binding mismatch");
  if (process.env.PROVIDER_ALLOWED_BUCKET !== "sgs-loadtest-dds-test")
    fail("provider bucket is not the authorized test bucket");
  if (
    process.env.PROVIDER_TARGET_TYPE !== "minio" ||
    process.env.PROVIDER_RUNTIME_MARKER !== "sgs-loadtest"
  ) {
    fail("provider runtime marker missing");
  }
  if (
    process.env.PROVIDER_CREDENTIAL_SCOPE !== "loadtest-dedicated-bucket-prefix"
  )
    fail("provider credential scope marker missing");
  if (
    /production|neon|upstash|backblaze|api\.sgsseguranca\.com\.br|app\.sgsseguranca\.com\.br/i.test(
      JSON.stringify({
        APP_ENV: process.env.APP_ENV,
        APP_LOADTEST_MARKER: process.env.APP_LOADTEST_MARKER,
        DATABASE_NAME: process.env.DATABASE_NAME,
        STORAGE_ENDPOINT: PROVIDER_ENDPOINT,
        PROVIDER_TARGET_IDENTITY: process.env.PROVIDER_TARGET_IDENTITY,
      }),
    )
  ) {
    fail("production marker detected");
  }
}

function cpfFor(seed) {
  const digits = String(seed)
    .replace(/\D/g, "")
    .padEnd(9, "7")
    .slice(0, 9)
    .split("")
    .map(Number);
  const digit = (length) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += digits[i] * (length + 1 - i);
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  digits.push(digit(9));
  digits.push(digit(10));
  return digits.join("");
}

function encrypt(value, keyHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    iv,
    { authTagLength: 16 },
  );
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${data.toString("base64url")}`;
}

function hashCpf(cpf) {
  return crypto
    .createHmac("sha256", process.env.FIELD_ENCRYPTION_HASH_KEY)
    .update(cpf)
    .digest("hex");
}

function cookieHeader(setCookies) {
  return (setCookies || [])
    .map((value) => String(value).split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

async function responseJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function safeResponse(response, body) {
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body:
      body && typeof body === "object"
        ? { message: body.message, error: body.error, code: body.code }
        : undefined,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(headers) {
  const raw = Number(headers.get("retry-after") || 0);
  if (Number.isFinite(raw) && raw > 0)
    return Math.min(90_000, Math.max(1_000, raw * 1000 + 500));
  return 65_000;
}

async function provision(client) {
  const profileRows = await client.query(
    "SELECT id FROM profiles WHERE nome = 'Administrador da Empresa' ORDER BY id LIMIT 1",
  );
  if (!profileRows.rows[0]) fail("Administrador da Empresa profile missing");
  const profileId = profileRows.rows[0].id;
  const tenants = {};
  const stamp = `${Date.now()}${crypto.randomInt(100, 999)}`;

  for (const label of ["A", "B"]) {
    const companyId = uuid();
    const siteId = uuid();
    const secondSiteId = uuid();
    const userId = uuid();
    const cpf = cpfFor(String(crypto.randomInt(100_000_000, 999_999_999)));
    const cnpj = `${label === "A" ? "71" : "72"}${stamp.slice(-12)}`.slice(
      0,
      14,
    );
    const passwordHash = await argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO companies (id, razao_social, cnpj, endereco, responsavel, status) VALUES ($1,$2,$3,$4,$5,true)",
        [
          companyId,
          `${MARKER} Tenant ${label} ${runId}`,
          cnpj,
          "VPS loadtest sintético",
          "P0 storage/grant/cache",
        ],
      );
      await client.query(
        "INSERT INTO sites (id, nome, local, company_id, status) VALUES ($1,$2,$3,$4,true)",
        [siteId, `${MARKER} Site ${label} ${runId}`, "loadtest", companyId],
      );
      if (label === "A") {
        await client.query(
          "INSERT INTO sites (id, nome, local, company_id, status) VALUES ($1,$2,$3,$4,true)",
          [
            secondSiteId,
            `${MARKER} Extra Site A ${runId}`,
            "loadtest",
            companyId,
          ],
        );
      }
      await client.query(
        `INSERT INTO users (id,nome,cpf,cpf_hash,cpf_ciphertext,email,funcao,password,status,company_id,site_id,profile_id,module_access_keys,identity_type,access_status,ai_processing_consent,must_change_password)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,true,$8,$9,$10,'[]'::jsonb,'system_user','credentialed',false,false)`,
        [
          userId,
          `${MARKER} User ${label} ${runId}`,
          hashCpf(cpf),
          encrypt(cpf, process.env.FIELD_ENCRYPTION_KEY),
          `p0-storage-${label.toLowerCase()}-${runId}@invalid.test`,
          "Administrador de teste",
          passwordHash,
          companyId,
          siteId,
          profileId,
        ],
      );
      if (label === "A") {
        await client.query(
          `INSERT INTO monthly_snapshots (month, site_id, company_id, risk_score, nc_count, training_compliance)
           VALUES ($1,$2,$3,87.50,2,91.00)`,
          [`2026-08-${runId}`, siteId, companyId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    cleanupState.companyIds.push(companyId);
    cleanupState.siteIds.push(siteId);
    if (label === "A") cleanupState.siteIds.push(secondSiteId);
    cleanupState.userIds.push(userId);
    tenants[label] = { label, companyId, siteId, userId, cpf };
  }
  return tenants;
}

async function createSession(user) {
  const csrf = await fetch(`${API_URL}/auth/csrf`, {
    headers: { "user-agent": USER_AGENT },
  });
  const csrfBody = await responseJson(csrf);
  const csrfCookies = getSetCookies(csrf.headers);
  const csrfCookie =
    csrfCookies
      .filter((value) => /^csrf-token=.+/.test(String(value)))
      .at(-1)
      ?.split(";", 1)[0] || "";
  if (!csrf.ok || !csrfBody?.csrfToken || !csrfCookie)
    fail(`csrf failed for ${user.label}: HTTP ${csrf.status}`);

  const login = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: csrfCookie,
      "x-csrf-token": csrfBody.csrfToken,
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ cpf: user.cpf, password: PASSWORD }),
  });
  const body = await responseJson(login);
  if (!login.ok || typeof body?.accessToken !== "string")
    fail(
      `login failed for ${user.label}: HTTP ${login.status} ${JSON.stringify(safeResponse(login, body))}`,
    );
  return {
    ...user,
    accessToken: body.accessToken,
    cookie: cookieHeader([csrfCookie, ...getSetCookies(login.headers)]),
    csrfToken: csrfBody.csrfToken,
  };
}

async function callAt(baseUrl, session, method, path, body, options = {}) {
  const headers = {
    authorization: `Bearer ${session.accessToken}`,
    cookie: session.cookie,
    "x-csrf-token": session.csrfToken,
    "user-agent": USER_AGENT,
    ...(options.headers || {}),
  };
  let payload = body;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: payload,
  });
  return { response, body: await responseJson(response) };
}

async function call(session, method, path, body, options = {}) {
  return callAt(API_URL, session, method, path, body, options);
}

async function callWithNaturalRetry(session, method, path, body, results, id) {
  for (let attempt = 0; attempt <= MAX_RETRIES_AFTER_RATE_LIMIT; attempt += 1) {
    const result = await call(session, method, path, body);
    if (
      result.response.status !== 429 ||
      attempt === MAX_RETRIES_AFTER_RATE_LIMIT
    ) {
      if (result.response.status === 429) {
        results.rateLimitBlocked.push({
          id,
          retryAfter: result.response.headers.get("retry-after") || null,
        });
      }
      return result;
    }
    const delay = parseRetryAfter(result.response.headers);
    results.rateLimitWaits.push({ id, delayMs: delay });
    await wait(delay);
  }
  fail(`unreachable retry state for ${id}`);
}

function recordCase(cases, input) {
  const identity = (value) => {
    if (value === undefined || value === null) return null;
    return String(value)
      .split(/(->|\/)/)
      .map((part) => {
        if (part === "->" || part === "/") return part;
        return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)
          ? hashText(part).slice(0, 12)
          : part;
      })
      .join("");
  };
  cases.push({
    testId: input.testId,
    component: input.component,
    authenticatedTenant: identity(input.authenticatedTenant),
    resourceTenant: identity(input.resourceTenant),
    objectGrantCacheHash: input.objectGrantCacheHash || null,
    vector: input.vector,
    api: input.api || null,
    db: input.db || null,
    provider: input.provider || null,
    redis: input.redis || null,
    beforeAfter: input.beforeAfter || null,
    status: input.status,
    note: input.note || null,
  });
}

function s3Client() {
  return new S3Client({
    region: process.env.STORAGE_REGION || "us-east-1",
    endpoint: process.env.STORAGE_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
    },
  });
}

function trackProviderKey(key) {
  cleanupState.providerKeys.add(key);
}

function trackProviderPrefix(prefix) {
  cleanupState.providerPrefixes.add(prefix);
}

function trackRedisKey(key) {
  cleanupState.redisKeys.add(key);
}

async function bodyBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === "function")
    return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function headObject(client, key) {
  try {
    const result = await client.send(
      new HeadObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: key }),
    );
    return {
      exists: true,
      size: Number(result.ContentLength || 0),
      etag: result.ETag || null,
    };
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (
      status === 404 ||
      error?.name === "NotFound" ||
      error?.name === "NoSuchKey"
    )
      return { exists: false, size: 0, etag: null };
    if (status === 400 && /\.\.|^\//.test(key))
      return { exists: false, size: 0, etag: null, rejected: true };
    throw error;
  }
}

async function getObject(client, key) {
  const result = await client.send(
    new GetObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: key }),
  );
  const buffer = await bodyBuffer(result.Body);
  return { buffer, size: buffer.length, digest: hash(buffer) };
}

async function providerStorageProof(client, cases, fixture, tenants) {
  const prefix = `documents/provider-runtime/${runId}`;
  const aPrefix = `${prefix}/${tenants.A.companyId}`;
  const bPrefix = `${prefix}/${tenants.B.companyId}`;
  const aKey = `${aPrefix}/object-a.pdf`;
  const bKey = `${bPrefix}/object-b.pdf`;
  const replacementKey = `${aPrefix}/object-a-replaced.pdf`;
  const copyKey = `${bPrefix}/object-a-copy.pdf`;
  const deleteKey = `${aPrefix}/delete-me.pdf`;
  const concurrentAKey = `${aPrefix}/concurrent-a.pdf`;
  const concurrentBKey = `${bPrefix}/concurrent-b.pdf`;
  const orphanKey = `documents/${tenants.A.companyId}/${runId}/orphan.pdf`;
  const traversalKey = `${aPrefix}/../escape.pdf`;
  trackProviderPrefix(aPrefix);
  trackProviderPrefix(bPrefix);
  for (const key of [
    aKey,
    bKey,
    replacementKey,
    copyKey,
    deleteKey,
    concurrentAKey,
    concurrentBKey,
    orphanKey,
  ])
    trackProviderKey(key);

  currentStage = "provider-put-a";
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: aKey,
      Body: PDF_A,
      ContentType: "application/pdf",
    }),
  );
  currentStage = "provider-put-b";
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: bKey,
      Body: PDF_B,
      ContentType: "application/pdf",
    }),
  );
  currentStage = "provider-head-get";
  const aHead = await headObject(client, aKey);
  const bHead = await headObject(client, bKey);
  const aGet = await getObject(client, aKey);
  const bGet = await getObject(client, bKey);
  const basicPass =
    aHead.exists &&
    bHead.exists &&
    aHead.size === PDF_A.length &&
    bHead.size === PDF_B.length &&
    aGet.digest === hash(PDF_A) &&
    bGet.digest === hash(PDF_B) &&
    aGet.digest !== bGet.digest;
  recordCase(cases, {
    testId: "STO-PROVIDER-001",
    component: "storage-provider",
    resourceTenant: "A/B",
    objectGrantCacheHash: `${hashText(aKey).slice(0, 12)}/${hashText(bKey).slice(0, 12)}`,
    vector: "provider PUT + HEAD + GET with distinct tenant objects",
    provider: {
      a: {
        exists: aHead.exists,
        size: aHead.size,
        contentHash: aGet.digest.slice(0, 12),
      },
      b: {
        exists: bHead.exists,
        size: bHead.size,
        contentHash: bGet.digest.slice(0, 12),
      },
    },
    status: basicPass ? "PASS" : "FAIL",
  });

  currentStage = "provider-put-replacement";
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: replacementKey,
      Body: PDF_A,
      ContentType: "application/pdf",
    }),
  );
  currentStage = "provider-copy";
  await client.send(
    new CopyObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: copyKey,
      CopySource: `${process.env.STORAGE_BUCKET}/${encodeURIComponent(replacementKey)}`,
    }),
  );
  currentStage = "provider-replace-delete";
  currentStage = "provider-replace-a";
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: aKey,
      Body: Buffer.concat([PDF_A, Buffer.from("replacement")]),
      ContentType: "application/pdf",
    }),
  );
  currentStage = "provider-put-delete-control";
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: deleteKey,
      Body: Buffer.from("synthetic-delete-control"),
      ContentType: "application/octet-stream",
    }),
  );
  currentStage = "provider-put-orphan";
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: orphanKey,
      Body: PDF_A,
      ContentType: "application/pdf",
    }),
  );
  currentStage = "provider-read-replaced";
  const replaced = await getObject(client, aKey);
  currentStage = "provider-read-copied";
  const copied = await getObject(client, copyKey);
  currentStage = "provider-delete-control";
  await client.send(
    new DeleteObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: deleteKey,
    }),
  );
  currentStage = "provider-post-delete-read";
  currentStage = "provider-head-deleted";
  const deleted = await headObject(client, deleteKey);
  currentStage = "provider-head-traversal";
  const traversalHead = await headObject(client, traversalKey);
  const mutationPass =
    replaced.digest ===
      hash(Buffer.concat([PDF_A, Buffer.from("replacement")])) &&
    copied.digest === hash(PDF_A) &&
    !deleted.exists &&
    !traversalHead.exists;
  recordCase(cases, {
    testId: "STO-PROVIDER-002",
    component: "storage-provider",
    resourceTenant: "A/B",
    objectGrantCacheHash: hashText(`${aKey}|${copyKey}|${deleteKey}`).slice(
      0,
      12,
    ),
    vector: "replace + copy + delete synthetic control + traversal probe",
    provider: {
      replaceHash: replaced.digest.slice(0, 12),
      copyHash: copied.digest.slice(0, 12),
      deleted: !deleted.exists,
      traversalKeyAbsent: !traversalHead.exists,
    },
    status: mutationPass ? "PASS" : "FAIL",
    note: "Operações diretas foram executadas com a identidade dedicada apenas em objetos sintéticos desta rodada; não representam privilégio de tenant.",
  });

  currentStage = "provider-concurrent-tenant-writes";
  const concurrentWrites = await Promise.all([
    client.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_BUCKET,
        Key: concurrentAKey,
        Body: Buffer.from("synthetic-concurrent-tenant-a"),
        ContentType: "application/octet-stream",
      }),
    ),
    client.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_BUCKET,
        Key: concurrentBKey,
        Body: Buffer.from("synthetic-concurrent-tenant-b-payload"),
        ContentType: "application/octet-stream",
      }),
    ),
  ]);
  const concurrentHeads = await Promise.all([
    headObject(client, concurrentAKey),
    headObject(client, concurrentBKey),
  ]);
  const concurrentPass =
    concurrentWrites.length === 2 &&
    concurrentHeads.every((result) => result.exists) &&
    concurrentHeads[0].size !== concurrentHeads[1].size;
  recordCase(cases, {
    testId: "STO-PROVIDER-004",
    component: "storage-provider",
    resourceTenant: "A/B",
    objectGrantCacheHash: hashText(`${concurrentAKey}|${concurrentBKey}`).slice(
      0,
      12,
    ),
    vector: "concurrent writes with tenant-specific provider keys",
    provider: {
      writesCompleted: concurrentWrites.length,
      tenantAExists: concurrentHeads[0].exists,
      tenantBExists: concurrentHeads[1].exists,
      distinctSizes: concurrentHeads[0].size !== concurrentHeads[1].size,
    },
    status: concurrentPass ? "PASS" : "FAIL",
    note: "Escritas concorrentes usam chaves distintas por tenant; operações diretas não representam autorização de tenant.",
  });

  currentStage = "provider-admin-action-denial";
  let adminActionDenied = false;
  try {
    await client.send(new ListBucketsCommand({}));
  } catch (error) {
    adminActionDenied =
      error?.name === "AccessDenied" ||
      error?.$metadata?.httpStatusCode === 403;
  }
  recordCase(cases, {
    testId: "STO-PROVIDER-005",
    component: "storage-provider",
    resourceTenant: null,
    objectGrantCacheHash: null,
    vector: "dedicated identity cannot enumerate provider buckets",
    provider: { adminActionDenied },
    status: adminActionDenied ? "PASS" : "FAIL",
    note: "Ação administrativa somente leitura negada para a identidade de aplicação.",
  });

  currentStage = "provider-prefix-action-denial";
  const unauthorizedKey = `outside/${runId}/not-allowed.bin`;
  let unauthorizedActionDenied = false;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_BUCKET,
        Key: unauthorizedKey,
        Body: Buffer.from("synthetic-outside-prefix"),
        ContentType: "application/octet-stream",
      }),
    );
    trackProviderKey(unauthorizedKey);
  } catch (error) {
    unauthorizedActionDenied =
      error?.name === "AccessDenied" ||
      error?.$metadata?.httpStatusCode === 403;
  }
  recordCase(cases, {
    testId: "STO-PROVIDER-006",
    component: "storage-provider",
    resourceTenant: null,
    objectGrantCacheHash: hashText(unauthorizedKey).slice(0, 12),
    vector: "dedicated identity cannot write outside supported prefixes",
    provider: { unauthorizedActionDenied },
    status: unauthorizedActionDenied ? "PASS" : "FAIL",
    note: "Ação fora dos prefixos suportados foi negada sem mutação autorizada.",
  });

  const listedKeys = [];
  for (const prefixToList of [aPrefix, bPrefix]) {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: process.env.STORAGE_BUCKET,
        Prefix: prefixToList,
      }),
    );
    listedKeys.push(
      ...(listed.Contents || []).map((item) => item.Key).filter(Boolean),
    );
  }
  const unexpected = listedKeys.filter(
    (key) =>
      ![
        aKey,
        bKey,
        replacementKey,
        copyKey,
        concurrentAKey,
        concurrentBKey,
      ].includes(key),
  );
  const inventoryPass = unexpected.length === 0 && listedKeys.length === 6;
  recordCase(cases, {
    testId: "STO-PROVIDER-003",
    component: "storage-provider",
    resourceTenant: "A/B",
    objectGrantCacheHash: hashText(prefix).slice(0, 12),
    vector: "prefix inventory and unexpected-object check",
    provider: {
      objectCount: listedKeys.length,
      unexpectedCount: unexpected.length,
    },
    status: inventoryPass ? "PASS" : "FAIL",
  });
  fixture.provider = {
    prefixHash: hashText(prefix).slice(0, 12),
    aKeyHash: hashText(aKey).slice(0, 12),
    bKeyHash: hashText(bKey).slice(0, 12),
    aDigest: replaced.digest,
    bDigest: bGet.digest,
    listedCount: listedKeys.length,
    unexpectedCount: unexpected.length,
    traversalKeyHash: hashText(traversalKey).slice(0, 12),
    endpointProtocol: new URL(PROVIDER_ENDPOINT).protocol,
    tls: new URL(PROVIDER_ENDPOINT).protocol === "https:",
    credentialScope: process.env.PROVIDER_CREDENTIAL_SCOPE,
    orphanKeyHash: hashText(orphanKey).slice(0, 12),
  };
  return {
    aKey,
    bKey,
    orphanKey,
    aDigest: replaced.digest,
    bDigest: bGet.digest,
  };
}

async function storageHttpProof(
  sessions,
  tenants,
  provider,
  cases,
  fixture,
  results,
) {
  const aUpload = await callWithNaturalRetry(
    sessions.A,
    "POST",
    "/storage/presigned-url",
    { filename: `p0-${runId}-a.pdf`, contentType: "application/pdf" },
    results,
    "STO-API-A-PRESIGN",
  );
  const aKey = aUpload.body?.fileKey;
  const aUrl = aUpload.body?.uploadUrl;
  if (typeof aKey === "string") trackProviderKey(aKey);
  const aApiPass =
    aUpload.response.status === 201 &&
    typeof aKey === "string" &&
    aKey.startsWith(`quarantine/${tenants.A.companyId}/`) &&
    typeof aUrl === "string";
  if (aApiPass) {
    const put = await fetch(aUrl, {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: PDF_A,
    });
    const before = await headObject(provider.client, aKey);
    recordCase(cases, {
      testId: "STO-API-001",
      component: "storage-api",
      authenticatedTenant: tenants.A.companyId,
      resourceTenant: tenants.A.companyId,
      objectGrantCacheHash: hashText(aKey).slice(0, 12),
      vector: "same-tenant presign and physical PUT",
      api: { status: aUpload.response.status, putStatus: put.status },
      provider: {
        exists: before.exists,
        size: before.size,
        contentHash: hash(PDF_A).slice(0, 12),
      },
      status:
        put.ok && before.exists && before.size === PDF_A.length
          ? "PASS"
          : "FAIL",
    });
  } else {
    recordCase(cases, {
      testId: "STO-API-001",
      component: "storage-api",
      authenticatedTenant: tenants.A.companyId,
      resourceTenant: tenants.A.companyId,
      vector: "same-tenant presign and physical PUT",
      api: safeResponse(aUpload.response, aUpload.body),
      status: "FAIL",
    });
    return;
  }

  const bCross = await callWithNaturalRetry(
    sessions.B,
    "POST",
    "/storage/complete-upload",
    { fileKey: aKey, originalFilename: "foreign-a.pdf", sha256: hash(PDF_A) },
    results,
    "STO-API-B-CROSS-COMPLETE",
  );
  const aStill = await headObject(provider.client, aKey);
  recordCase(cases, {
    testId: "STO-API-002",
    component: "storage-api",
    authenticatedTenant: tenants.B.companyId,
    resourceTenant: tenants.A.companyId,
    objectGrantCacheHash: hashText(aKey).slice(0, 12),
    vector: "B→A complete-upload with foreign quarantine key",
    api: safeResponse(bCross.response, bCross.body),
    provider: {
      foreignObjectStillExists: aStill.exists,
      contentHash: aStill.exists
        ? (await getObject(provider.client, aKey)).digest.slice(0, 12)
        : null,
    },
    status:
      [400, 403, 404].includes(bCross.response.status) && aStill.exists
        ? "PASS"
        : "FAIL",
  });

  const aComplete = await callWithNaturalRetry(
    sessions.A,
    "POST",
    "/storage/complete-upload",
    {
      fileKey: aKey,
      originalFilename: `p0-${runId}-a.pdf`,
      sha256: hash(PDF_A),
    },
    results,
    "STO-API-A-COMPLETE",
  );
  const aDocumentKey = aComplete.body?.fileKey;
  if (typeof aDocumentKey === "string") trackProviderKey(aDocumentKey);
  const aDocument =
    typeof aDocumentKey === "string"
      ? await getObject(provider.client, aDocumentKey)
      : null;
  const aQuarantine = await headObject(provider.client, aKey);
  const promotePass =
    [200, 201].includes(aComplete.response.status) &&
    typeof aDocumentKey === "string" &&
    aDocument?.digest === hash(PDF_A) &&
    !aQuarantine.exists;
  recordCase(cases, {
    testId: "STO-API-003",
    component: "storage-api",
    authenticatedTenant: tenants.A.companyId,
    resourceTenant: tenants.A.companyId,
    objectGrantCacheHash: hashText(aDocumentKey || aKey).slice(0, 12),
    vector: "same-tenant complete-upload promotion and quarantine removal",
    api: safeResponse(aComplete.response, aComplete.body),
    provider: {
      promotedExists: Boolean(aDocument),
      promotedHash: aDocument?.digest.slice(0, 12),
      quarantineExists: aQuarantine.exists,
    },
    status: promotePass ? "PASS" : "FAIL",
  });

  const bUpload = await callWithNaturalRetry(
    sessions.B,
    "POST",
    "/storage/presigned-url",
    { filename: `p0-${runId}-b.pdf`, contentType: "application/pdf" },
    results,
    "STO-API-B-PRESIGN",
  );
  const bKey = bUpload.body?.fileKey;
  if (typeof bKey === "string") trackProviderKey(bKey);
  if (bUpload.response.status === 201 && bKey && bUpload.body?.uploadUrl) {
    const put = await fetch(bUpload.body.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: PDF_B,
    });
    const bComplete = await callWithNaturalRetry(
      sessions.B,
      "POST",
      "/storage/complete-upload",
      {
        fileKey: bKey,
        originalFilename: `p0-${runId}-b.pdf`,
        sha256: hash(PDF_B),
      },
      results,
      "STO-API-B-COMPLETE",
    );
    const bDocumentKey = bComplete.body?.fileKey;
    if (typeof bDocumentKey === "string") trackProviderKey(bDocumentKey);
    const bDocument =
      typeof bDocumentKey === "string"
        ? await getObject(provider.client, bDocumentKey)
        : null;
    const bPass =
      put.ok &&
      [200, 201].includes(bComplete.response.status) &&
      bDocument?.digest === hash(PDF_B);
    recordCase(cases, {
      testId: "STO-API-004",
      component: "storage-api",
      authenticatedTenant: tenants.B.companyId,
      resourceTenant: tenants.B.companyId,
      objectGrantCacheHash: hashText(bDocumentKey || bKey).slice(0, 12),
      vector: "same-tenant B presign, PUT and promotion",
      api: {
        presign: bUpload.response.status,
        put: put.status,
        complete: bComplete.response.status,
      },
      provider: { promotedHash: bDocument?.digest.slice(0, 12) || null },
      status: bPass ? "PASS" : "FAIL",
    });
    fixture.documents = {
      A: {
        fileKeyHash: hashText(aDocumentKey).slice(0, 12),
        fileKey: aDocumentKey,
        digest: aDocument?.digest || null,
      },
      B: {
        fileKeyHash: hashText(bDocumentKey).slice(0, 12),
        fileKey: bDocumentKey,
        digest: bDocument?.digest || null,
      },
    };
  } else {
    recordCase(cases, {
      testId: "STO-API-004",
      component: "storage-api",
      authenticatedTenant: tenants.B.companyId,
      resourceTenant: tenants.B.companyId,
      vector: "same-tenant B presign, PUT and promotion",
      api: safeResponse(bUpload.response, bUpload.body),
      status: "FAIL",
    });
  }

  const malformed = [
    [
      "STO-API-005",
      "path traversal",
      `quarantine/${tenants.B.companyId}/../${uuid()}.pdf`,
    ],
    [
      "STO-API-006",
      "encoded traversal",
      `quarantine/${tenants.B.companyId}/%2e%2e/${uuid()}.pdf`,
    ],
    [
      "STO-API-007",
      "absolute key",
      `/quarantine/${tenants.B.companyId}/${uuid()}.pdf`,
    ],
    [
      "STO-API-008",
      "partial prefix manipulation",
      `quarantine/${tenants.B.companyId}${tenants.A.companyId}/${uuid()}.pdf`,
    ],
    [
      "STO-API-009",
      "unexpected nested segment",
      `quarantine/${tenants.B.companyId}/${uuid()}/nested.pdf`,
    ],
  ];
  for (const [testId, vector, key] of malformed) {
    const attack = await callWithNaturalRetry(
      sessions.B,
      "POST",
      "/storage/complete-upload",
      { fileKey: key, originalFilename: "attack.pdf", sha256: hash(PDF_B) },
      results,
      testId,
    );
    const safeStatuses = [400, 403, 404];
    recordCase(cases, {
      testId,
      component: "storage-api",
      authenticatedTenant: tenants.B.companyId,
      resourceTenant: tenants.B.companyId,
      objectGrantCacheHash: hashText(key).slice(0, 12),
      vector,
      api: safeResponse(attack.response, attack.body),
      provider: { providerCall: "not reached if validator rejected" },
      status: safeStatuses.includes(attack.response.status)
        ? "PASS"
        : attack.response.status === 429
          ? "UNVERIFIED"
          : "FAIL",
      note:
        attack.response.status === 429
          ? "Rate limit retained; natural retry budget exhausted."
          : null,
    });
  }
}

async function bindRegistry(client, tenants, fixture) {
  if (!fixture.documents?.A?.fileKey || !fixture.documents?.B?.fileKey)
    fail("governed documents missing before registry binding");
  fixture.registry = {};
  for (const label of ["A", "B"]) {
    const tenant = tenants[label];
    const document = fixture.documents[label];
    const registryId = uuid();
    await client.query(
      `INSERT INTO document_registry
       (id, company_id, module, document_type, entity_id, title, document_date, iso_year, iso_week,
        file_key, original_name, mime_type, file_hash, document_code, created_by, status, deleted_at)
       VALUES ($1,$2,'pt','pdf',$3,$4,NOW(),2026,35,$5,$6,'application/pdf',$7,$8,$9,'ACTIVE',NULL)`,
      [
        registryId,
        tenant.companyId,
        tenant.siteId,
        `${MARKER} governed document ${label} ${runId}`,
        document.fileKey,
        `storage-runtime-${label.toLowerCase()}.pdf`,
        document.digest,
        `${MARKER}-${runId}-${label}`,
        tenant.userId,
      ],
    );
    cleanupState.registryIds.push(registryId);
    fixture.registry[label] = {
      idHash: hashText(registryId).slice(0, 12),
      fileKeyHash: document.fileKeyHash,
      module: "pt",
      ownerIdHash: hashText(tenant.siteId).slice(0, 12),
    };
  }
}

async function registryReadAndGrantProof(
  client,
  sessions,
  tenants,
  fixture,
  cases,
) {
  const registryId = fixture.registry?.A?.idHash
    ? (
        await client.query(
          "SELECT id FROM document_registry WHERE company_id = $1 AND file_key = $2 AND deleted_at IS NULL LIMIT 1",
          [tenants.A.companyId, fixture.documents.A.fileKey],
        )
      ).rows[0]?.id
    : null;
  if (!registryId) {
    recordCase(cases, {
      testId: "STO-REGISTRY-SETUP",
      component: "document-registry",
      vector: "active registry binding available for governed read",
      status: "FAIL",
    });
    return;
  }
  const aAccess = await call(
    sessions.A,
    "GET",
    `/document-registry/${registryId}/pdf`,
  );
  const aLink = aAccess.body?.url;
  const aDownload =
    typeof aLink === "string" && normalizeStorageLink(aLink)
      ? await downloadPath(API_URL, aLink, sessions.A)
      : null;
  const bAccess = await call(
    sessions.B,
    "GET",
    `/document-registry/${registryId}/pdf`,
  );
  const readPass =
    aAccess.response.status === 200 &&
    aAccess.body?.availability === "ready" &&
    typeof aLink === "string" &&
    aDownload?.response.status === 200 &&
    aDownload.digest === fixture.documents.A.digest &&
    bAccess.response.status === 200 &&
    bAccess.body?.hasFinalPdf === false &&
    bAccess.body?.url === null;
  const issued = (
    await client.query(
      "SELECT id FROM document_download_grants WHERE company_id = $1 AND file_key = $2 ORDER BY created_at DESC LIMIT 1",
      [tenants.A.companyId, fixture.documents.A.fileKey],
    )
  ).rows[0]?.id;
  if (issued) cleanupState.grantIds.push(issued);
  recordCase(cases, {
    testId: "STO-REGISTRY-001",
    component: "document-registry",
    authenticatedTenant: `${tenants.A.companyId}->${tenants.B.companyId}`,
    resourceTenant: tenants.A.companyId,
    objectGrantCacheHash: hashText(
      `${registryId}:${fixture.documents.A.fileKey}`,
    ).slice(0, 12),
    vector:
      "governed registry read, restricted grant issuance and cross-tenant denial",
    api: {
      ownerAccess: aAccess.response.status,
      ownerAvailability: aAccess.body?.availability || null,
      ownerDownload: aDownload?.response.status || null,
      foreignAccess: bAccess.response.status,
      foreignHasFinalPdf: bAccess.body?.hasFinalPdf ?? null,
      restrictedLinkType:
        typeof aLink === "string" ? "internal-governed-path" : null,
    },
    db: {
      grantIssued: Boolean(issued),
      registryIdHash: hashText(registryId).slice(0, 12),
    },
    provider: {
      downloadedHash:
        aDownload?.response.status === 200
          ? aDownload.digest.slice(0, 12)
          : null,
    },
    status: readPass ? "PASS" : "FAIL",
    note: "A URL de download governado não é uma URL S3 bruta; o fluxo de documentos usa grant restrito com binding no registry.",
  });
  fixture.grants.registryIssued = Boolean(issued);
}

async function orphanAuthorizationProof(
  client,
  session,
  tenant,
  provider,
  cases,
) {
  const orphan = await insertGrant(client, {
    companyId: tenant.companyId,
    fileKey: provider.orphanKey,
    ownerType: "pt",
    ownerId: tenant.siteId,
    purpose: "document-registry:pt:pdf",
  });
  const result = await download(orphan.token, session);
  const pass = [400, 403, 404, 503].includes(result.response.status);
  recordCase(cases, {
    testId: "STO-ORPHAN-001",
    component: "storage-provider",
    authenticatedTenant: tenant.companyId,
    resourceTenant: tenant.companyId,
    objectGrantCacheHash: orphan.tokenHash.slice(0, 12),
    vector:
      "physical provider object without active document registry must not become authorized application read",
    api: { status: result.response.status },
    provider: {
      physicalObjectExists: true,
      providerReadThroughApp: result.response.status === 200,
    },
    db: { registryBinding: false },
    status: pass ? "PASS" : "FAIL",
  });
}

async function providerReadFailureProof(
  client,
  session,
  tenant,
  fixture,
  cases,
) {
  if (!process.env.FAILURE_API_URL || !fixture.documents?.A?.fileKey) {
    recordCase(cases, {
      testId: "STO-FAILURE-002",
      component: "storage-provider",
      vector: "provider read failure through isolated failure API",
      status: "UNVERIFIED",
    });
    return;
  }
  const row = (
    await client.query(
      "SELECT id FROM document_registry WHERE company_id = $1 AND file_key = $2 AND deleted_at IS NULL LIMIT 1",
      [tenant.companyId, fixture.documents.A.fileKey],
    )
  ).rows[0];
  if (!row) fail("registry row missing for provider read failure proof");
  const result = await callAt(
    process.env.FAILURE_API_URL,
    session,
    "GET",
    `/document-registry/${row.id}/pdf`,
  );
  const body = result.body || {};
  const failedDownload =
    typeof body.url === "string" && normalizeStorageLink(body.url)
      ? await downloadPath(process.env.FAILURE_API_URL, body.url, session)
      : null;
  const pass =
    result.response.status === 200 &&
    body.availability === "ready" &&
    failedDownload?.response.status >= 500;
  recordCase(cases, {
    testId: "STO-FAILURE-002",
    component: "storage-provider",
    authenticatedTenant: tenant.companyId,
    resourceTenant: tenant.companyId,
    objectGrantCacheHash: hashText(row.id).slice(0, 12),
    vector:
      "provider read failure after governed link issuance must not become a successful download",
    api: {
      accessStatus: result.response.status,
      availability: body.availability || null,
      linkIssued: typeof body.url === "string",
      downloadStatus: failedDownload?.response.status || null,
    },
    status: pass ? "PASS" : "FAIL",
  });
}

async function providerFailureProof(sessions, cases) {
  if (!process.env.FAILURE_API_URL) {
    recordCase(cases, {
      testId: "STO-FAILURE-001",
      component: "storage-provider",
      vector:
        "provider write failure through API with isolated failure endpoint",
      status: "UNVERIFIED",
      note: "Failure API was not supplied by the isolated launcher.",
    });
    return;
  }
  const result = await callAt(
    process.env.FAILURE_API_URL,
    sessions.A,
    "POST",
    "/storage/presigned-url",
    { filename: `failure-${runId}.pdf`, contentType: "application/pdf" },
  );
  const sanitized = safeResponse(result.response, result.body);
  let putStatus = null;
  let putFailed = false;
  if (
    result.response.status === 201 &&
    typeof result.body?.uploadUrl === "string"
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const put = await fetch(result.body.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        body: PDF_A,
        signal: controller.signal,
      });
      putStatus = put.status;
      putFailed = !put.ok;
    } catch {
      putFailed = true;
    } finally {
      clearTimeout(timer);
    }
  }
  const disclosed = JSON.stringify(sanitized).match(
    /https?:\/\/|minio-loadtest|AWS_|secret|password/i,
  );
  const pass = result.response.status === 201 && putFailed && !disclosed;
  recordCase(cases, {
    testId: "STO-FAILURE-001",
    component: "storage-provider",
    authenticatedTenant: sessions.A.companyId,
    resourceTenant: sessions.A.companyId,
    vector: "provider physical PUT failure must not become success",
    api: {
      presignStatus: result.response.status,
      physicalPutStatus: putStatus,
      physicalPutFailed: putFailed,
    },
    status: pass ? "PASS" : "FAIL",
  });
}

async function insertGrant(client, input) {
  const id = uuid();
  await client.query(
    `INSERT INTO document_download_grants (id, company_id, file_key, original_name, content_type, issued_for_user_id, expires_at, consumed_at)
     VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,NULL)`,
    [
      id,
      input.companyId,
      input.fileKey,
      input.originalName || "synthetic.pdf",
      input.issuedForUserId || null,
      input.expiresAt || new Date(Date.now() + 300_000),
    ],
  );
  cleanupState.grantIds.push(id);
  const payload = {
    typ: "document_download",
    gid: id,
    companyId: input.companyId,
    key: input.fileKey,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    purpose: input.purpose,
    ...(input.issuedForUserId ? { uid: input.issuedForUserId } : {}),
  };
  const token = jwt.sign(payload, process.env.DOCUMENT_DOWNLOAD_TOKEN_SECRET, {
    algorithm: "HS256",
    expiresIn: input.jwtExpiresIn || 300,
  });
  return {
    id,
    token,
    tokenHash: hashText(token),
    companyId: input.companyId,
    fileKey: input.fileKey,
  };
}

async function grantRow(client, id) {
  const row = (
    await client.query(
      "SELECT id, company_id, file_key, expires_at, consumed_at FROM document_download_grants WHERE id = $1",
      [id],
    )
  ).rows[0];
  if (!row) return null;
  return {
    idHash: hashText(row.id).slice(0, 12),
    companyIdHash: hashText(row.company_id).slice(0, 12),
    fileKeyHash: hashText(row.file_key).slice(0, 12),
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

async function download(token, session) {
  return downloadPath(
    API_URL,
    `/storage/download/${encodeURIComponent(token)}`,
    session,
  );
}

function normalizeStorageLink(link) {
  try {
    const parsed = new URL(link, API_URL);
    return parsed.pathname.startsWith("/storage/download/")
      ? `${parsed.pathname}${parsed.search}`
      : null;
  } catch {
    return null;
  }
}

async function downloadPath(baseUrl, path, session) {
  const headers = { "user-agent": USER_AGENT };
  if (session) {
    headers.authorization = `Bearer ${session.accessToken}`;
    headers.cookie = session.cookie;
  }
  const relativePath = normalizeStorageLink(path);
  if (!relativePath)
    return {
      response: { status: 400 },
      buffer: Buffer.alloc(0),
      digest: hash(Buffer.alloc(0)),
    };
  const response = await fetch(`${baseUrl}${relativePath}`, { headers });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer, digest: hash(buffer) };
}

async function grantProof(client, sessions, tenants, provider, cases, fixture) {
  const documents = fixture.documents;
  if (!documents?.A?.fileKey || !documents?.B?.fileKey) {
    recordCase(cases, {
      testId: "GRT-SETUP",
      component: "grants",
      vector: "synthetic governed documents available for grant tests",
      status: "FAIL",
    });
    return;
  }

  const ownerGrant = await insertGrant(client, {
    companyId: tenants.A.companyId,
    fileKey: documents.A.fileKey,
    issuedForUserId: tenants.A.userId,
    ownerType: "pt",
    ownerId: tenants.A.siteId,
    purpose: "document-registry:pt:pdf",
  });
  const crossBeforeOwner = await download(ownerGrant.token, sessions.B);
  const owner = await download(ownerGrant.token, sessions.A);
  const ownerRow = await grantRow(client, ownerGrant.id);
  const ownerPass =
    crossBeforeOwner.response.status === 403 &&
    owner.response.status === 200 &&
    owner.digest === documents.A.digest;
  recordCase(cases, {
    testId: "GRT-001",
    component: "grants",
    authenticatedTenant: `${tenants.B.companyId}->${tenants.A.companyId}`,
    resourceTenant: tenants.A.companyId,
    objectGrantCacheHash: ownerGrant.tokenHash.slice(0, 12),
    vector: "B token use before owner; owner use after; user-bound grant",
    api: {
      crossStatus: crossBeforeOwner.response.status,
      ownerStatus: owner.response.status,
      ownerContentHash: owner.digest.slice(0, 12),
    },
    db: ownerRow,
    provider: {
      downloadedHash:
        owner.response.status === 200 ? owner.digest.slice(0, 12) : null,
    },
    status: ownerPass ? "PASS" : "FAIL",
    note:
      owner.response.status !== 200
        ? "Public download route did not accept the authenticated issuing user context."
        : null,
  });

  const replay = await download(ownerGrant.token, sessions.A);
  recordCase(cases, {
    testId: "GRT-002",
    component: "grants",
    authenticatedTenant: tenants.A.companyId,
    resourceTenant: tenants.A.companyId,
    objectGrantCacheHash: ownerGrant.tokenHash.slice(0, 12),
    vector: "second use/replay after atomic consumption",
    api: { status: replay.response.status },
    db: await grantRow(client, ownerGrant.id),
    provider: { providerDownloadAttempted: replay.response.status === 200 },
    status: replay.response.status === 403 ? "PASS" : "FAIL",
  });

  const expired = await insertGrant(client, {
    companyId: tenants.B.companyId,
    fileKey: documents.B.fileKey,
    expiresAt: new Date(Date.now() + 300_000),
    ownerType: "pt",
    ownerId: tenants.B.siteId,
    purpose: "document-registry:pt:pdf",
  });
  await client.query(
    "UPDATE document_download_grants SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
    [expired.id],
  );
  const expiredUse = await download(expired.token);
  recordCase(cases, {
    testId: "GRT-003",
    component: "grants",
    resourceTenant: tenants.B.companyId,
    objectGrantCacheHash: expired.tokenHash.slice(0, 12),
    vector: "database expiration before use",
    api: { status: expiredUse.response.status },
    db: await grantRow(client, expired.id),
    status: expiredUse.response.status === 403 ? "PASS" : "FAIL",
  });

  const tampered = await download(
    `${ownerGrant.token.slice(0, -1)}${ownerGrant.token.endsWith("a") ? "b" : "a"}`,
  );
  const truncated = await download(
    ownerGrant.token.slice(0, Math.floor(ownerGrant.token.length / 2)),
  );
  recordCase(cases, {
    testId: "GRT-004",
    component: "grants",
    resourceTenant: tenants.A.companyId,
    objectGrantCacheHash: hashText(`${ownerGrant.tokenHash}:tamper`).slice(
      0,
      12,
    ),
    vector: "signature tamper and token truncation",
    api: {
      tampered: tampered.response.status,
      truncated: truncated.response.status,
    },
    status:
      [400, 403].includes(tampered.response.status) &&
      [400, 403].includes(truncated.response.status)
        ? "PASS"
        : "FAIL",
  });

  const resourceSwap = await insertGrant(client, {
    companyId: tenants.A.companyId,
    fileKey: documents.A.fileKey,
    ownerType: "pt",
    ownerId: tenants.A.siteId,
    purpose: "document-registry:pt:pdf",
  });
  const resourceBefore = await grantRow(client, resourceSwap.id);
  await client.query(
    "UPDATE document_download_grants SET file_key = $2 WHERE id = $1",
    [resourceSwap.id, documents.B.fileKey],
  );
  const resourceUse = await download(resourceSwap.token);
  const resourceAfter = await grantRow(client, resourceSwap.id);
  recordCase(cases, {
    testId: "GRT-005",
    component: "grants",
    resourceTenant: tenants.A.companyId,
    objectGrantCacheHash: resourceSwap.tokenHash.slice(0, 12),
    vector: "resource/document file_key swap after token issue",
    api: { status: resourceUse.response.status },
    db: { before: resourceBefore, after: resourceAfter },
    status:
      resourceUse.response.status === 403 && !resourceAfter.consumedAt
        ? "PASS"
        : "FAIL",
  });

  const companySwap = await insertGrant(client, {
    companyId: tenants.A.companyId,
    fileKey: documents.A.fileKey,
    ownerType: "pt",
    ownerId: tenants.A.siteId,
    purpose: "document-registry:pt:pdf",
  });
  const companyBefore = await grantRow(client, companySwap.id);
  await client.query(
    "UPDATE document_download_grants SET company_id = $2 WHERE id = $1",
    [companySwap.id, tenants.B.companyId],
  );
  const companyUse = await download(companySwap.token);
  const companyAfter = await grantRow(client, companySwap.id);
  recordCase(cases, {
    testId: "GRT-006",
    component: "grants",
    resourceTenant: `${tenants.A.companyId}->${tenants.B.companyId}`,
    objectGrantCacheHash: companySwap.tokenHash.slice(0, 12),
    vector: "tenant/company swap after token issue",
    api: { status: companyUse.response.status },
    db: { before: companyBefore, after: companyAfter },
    status: companyUse.response.status === 403 ? "PASS" : "FAIL",
  });

  const concurrent = await insertGrant(client, {
    companyId: tenants.B.companyId,
    fileKey: documents.B.fileKey,
    ownerType: "pt",
    ownerId: tenants.B.siteId,
    purpose: "document-registry:pt:pdf",
  });
  const [first, second] = await Promise.all([
    download(concurrent.token),
    download(concurrent.token),
  ]);
  const statuses = [first.response.status, second.response.status].sort(
    (a, b) => a - b,
  );
  const concurrentRow = await grantRow(client, concurrent.id);
  const concurrentPass =
    statuses[0] === 200 && statuses[1] === 403 && concurrentRow?.consumedAt;
  recordCase(cases, {
    testId: "GRT-007",
    component: "grants",
    resourceTenant: tenants.B.companyId,
    objectGrantCacheHash: concurrent.tokenHash.slice(0, 12),
    vector: "concurrent consumption of same token",
    api: {
      statuses,
      successfulContentHashes: [first, second]
        .filter((item) => item.response.status === 200)
        .map((item) => item.digest.slice(0, 12)),
    },
    db: concurrentRow,
    provider: {
      oneDownloadOnly: statuses.filter((status) => status === 200).length === 1,
    },
    status: concurrentPass ? "PASS" : "FAIL",
  });

  const remaining = await client.query(
    "SELECT count(*)::int AS count, count(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS consumed FROM document_download_grants WHERE id IN ($1,$2,$3,$4,$5,$6)",
    [
      ownerGrant.id,
      expired.id,
      resourceSwap.id,
      companySwap.id,
      concurrent.id,
      uuid(),
    ],
  );
  fixture.grants = {
    ownerIdHash: hashText(ownerGrant.id).slice(0, 12),
    ownerTokenHash: ownerGrant.tokenHash.slice(0, 12),
    concurrentIdHash: hashText(concurrent.id).slice(0, 12),
    dbRowsObserved: remaining.rows[0],
  };
}

async function redisKeyState(redis, companyId, queryType) {
  const keys = [
    `dashboard:${companyId}:${queryType}`,
    `dashboard:${companyId}:${queryType}:stale`,
  ];
  keys.forEach(trackRedisKey);
  const result = {};
  for (const key of keys) {
    const value = await redis.get(key);
    result[key.endsWith(":stale") ? "stale" : "active"] = {
      keyHash: hashText(key).slice(0, 12),
      exists: value !== null,
      valueHash: value === null ? null : hashText(value).slice(0, 12),
    };
  }
  return result;
}

function responseDigest(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const { meta, ...content } = body;
    void meta;
    return hashText(JSON.stringify(content));
  }
  return hashText(JSON.stringify(body || null));
}

async function cacheTenantSequence(
  session,
  tenant,
  redis,
  cases,
  results,
  fixture,
) {
  const summary1 = await callWithNaturalRetry(
    session,
    "GET",
    "/dashboard/summary",
    undefined,
    results,
    `CACHE-${tenant.label}-SUMMARY-1`,
  );
  const summary2 = await callWithNaturalRetry(
    session,
    "GET",
    "/dashboard/summary",
    undefined,
    results,
    `CACHE-${tenant.label}-SUMMARY-2`,
  );
  const kpis1 = await callWithNaturalRetry(
    session,
    "GET",
    "/dashboard/kpis",
    undefined,
    results,
    `CACHE-${tenant.label}-KPIS-1`,
  );
  const kpis2 = await callWithNaturalRetry(
    session,
    "GET",
    "/dashboard/kpis",
    undefined,
    results,
    `CACHE-${tenant.label}-KPIS-2`,
  );
  const pendencies = await callWithNaturalRetry(
    session,
    "GET",
    "/dashboard/document-pendencies?page=1&limit=10&status=Pendente",
    undefined,
    results,
    `CACHE-${tenant.label}-FILTERED-PENDENCIES`,
  );
  const summaryState = await redisKeyState(redis, tenant.companyId, "summary");
  const kpisState = await redisKeyState(redis, tenant.companyId, "kpis");
  const pass =
    [summary1, summary2, kpis1, kpis2, pendencies].every(
      (item) => item.response.status === 200,
    ) &&
    summary1.body?.meta?.source &&
    summary2.body?.meta?.source &&
    responseDigest(summary1.body) === responseDigest(summary2.body);
  recordCase(cases, {
    testId: `CACHE-${tenant.label}-001`,
    component: "cache",
    authenticatedTenant: tenant.companyId,
    resourceTenant: tenant.companyId,
    objectGrantCacheHash: hashText(`${tenant.companyId}:summary:kpis`).slice(
      0,
      12,
    ),
    vector:
      "same dashboard routes, repeated hit, filtered pagination and tenant value digest",
    api: {
      summary1: summary1.response.status,
      summary2: summary2.response.status,
      summary1Source: summary1.body?.meta?.source || null,
      summary2Source: summary2.body?.meta?.source || null,
      kpis1: kpis1.response.status,
      kpis2: kpis2.response.status,
      filteredPendencies: pendencies.response.status,
      summaryDigest: responseDigest(summary1.body).slice(0, 12),
      kpisDigest: responseDigest(kpis1.body).slice(0, 12),
    },
    redis: { summary: summaryState, kpis: kpisState },
    status: pass
      ? "PASS"
      : summary1.response.status === 429
        ? "UNVERIFIED"
        : "FAIL",
  });
  fixture.cache[tenant.label] = {
    summaryDigest: responseDigest(summary1.body),
    kpisDigest: responseDigest(kpis1.body),
    summary: summaryState,
    kpis: kpisState,
  };
}

async function cacheProof(sessions, tenants, redis, cases, results, fixture) {
  await cacheTenantSequence(
    sessions.A,
    tenants.A,
    redis,
    cases,
    results,
    fixture,
  );
  await cacheTenantSequence(
    sessions.B,
    tenants.B,
    redis,
    cases,
    results,
    fixture,
  );
  const distinct =
    fixture.cache.A.summaryDigest !== fixture.cache.B.summaryDigest &&
    fixture.cache.A.kpisDigest !== fixture.cache.B.kpisDigest;
  recordCase(cases, {
    testId: "CACHE-001",
    component: "cache",
    authenticatedTenant: `${tenants.A.companyId}/${tenants.B.companyId}`,
    resourceTenant: "A/B",
    objectGrantCacheHash: hashText(
      `${tenants.A.companyId}:${tenants.B.companyId}`,
    ).slice(0, 12),
    vector: "cross-tenant response value isolation by digest",
    api: {
      aSummaryDigest: fixture.cache.A.summaryDigest.slice(0, 12),
      bSummaryDigest: fixture.cache.B.summaryDigest.slice(0, 12),
      aKpisDigest: fixture.cache.A.kpisDigest.slice(0, 12),
      bKpisDigest: fixture.cache.B.kpisDigest.slice(0, 12),
    },
    redis: { aKeys: fixture.cache.A.summary, bKeys: fixture.cache.B.summary },
    status: distinct ? "PASS" : "FAIL",
  });

  const invalidateA = await callWithNaturalRetry(
    sessions.A,
    "POST",
    "/dashboard/invalidate",
    { queryType: "summary" },
    results,
    "CACHE-A-INVALIDATE",
  );
  const afterInvalidateA = {
    a: await redisKeyState(redis, tenants.A.companyId, "summary"),
    b: await redisKeyState(redis, tenants.B.companyId, "summary"),
  };
  const aRevalidated = await callWithNaturalRetry(
    sessions.A,
    "GET",
    "/dashboard/summary",
    undefined,
    results,
    "CACHE-A-REVALIDATE",
  );
  const afterRevalidateA = await redisKeyState(
    redis,
    tenants.A.companyId,
    "summary",
  );
  const invalidateAPass =
    [200, 201].includes(invalidateA.response.status) &&
    !afterInvalidateA.a.active.exists &&
    afterInvalidateA.b.active.exists &&
    aRevalidated.response.status === 200 &&
    afterRevalidateA.active.exists;
  recordCase(cases, {
    testId: "CACHE-002",
    component: "cache",
    authenticatedTenant: tenants.A.companyId,
    resourceTenant: tenants.A.companyId,
    objectGrantCacheHash: hashText(tenants.A.companyId).slice(0, 12),
    vector: "A invalidation, B preservation and A revalidation",
    api: {
      invalidate: invalidateA.response.status,
      revalidate: aRevalidated.response.status,
    },
    redis: {
      before: fixture.cache.A.summary,
      afterInvalidateA,
      afterRevalidateA,
    },
    status: invalidateAPass
      ? "PASS"
      : invalidateA.response.status === 429
        ? "UNVERIFIED"
        : "FAIL",
  });

  const invalidateB = await callWithNaturalRetry(
    sessions.B,
    "POST",
    "/dashboard/invalidate",
    { queryType: "summary" },
    results,
    "CACHE-B-INVALIDATE",
  );
  const afterInvalidateB = {
    a: await redisKeyState(redis, tenants.A.companyId, "summary"),
    b: await redisKeyState(redis, tenants.B.companyId, "summary"),
  };
  const bRevalidated = await callWithNaturalRetry(
    sessions.B,
    "GET",
    "/dashboard/summary",
    undefined,
    results,
    "CACHE-B-REVALIDATE",
  );
  const afterRevalidateB = await redisKeyState(
    redis,
    tenants.B.companyId,
    "summary",
  );
  const invalidateBPass =
    [200, 201].includes(invalidateB.response.status) &&
    afterInvalidateB.a.active.exists &&
    !afterInvalidateB.b.active.exists &&
    bRevalidated.response.status === 200 &&
    afterRevalidateB.active.exists;
  recordCase(cases, {
    testId: "CACHE-003",
    component: "cache",
    authenticatedTenant: tenants.B.companyId,
    resourceTenant: tenants.B.companyId,
    objectGrantCacheHash: hashText(tenants.B.companyId).slice(0, 12),
    vector: "B invalidation, A preservation and B revalidation",
    api: {
      invalidate: invalidateB.response.status,
      revalidate: bRevalidated.response.status,
    },
    redis: {
      before: fixture.cache.B.summary,
      afterInvalidateB,
      afterRevalidateB,
    },
    status: invalidateBPass
      ? "PASS"
      : invalidateB.response.status === 429
        ? "UNVERIFIED"
        : "FAIL",
  });
}

async function cleanup(client, redis, providerClient, fixture) {
  const cleanupResult = {
    providerObjectsDeleted: 0,
    providerObjectsRemaining: 0,
    redisKeysDeleted: 0,
    redisKeysRemaining: 0,
    registryRowsDeleted: 0,
    registryRowsRemaining: 0,
    grantRowsDeleted: 0,
    grantRowsRemaining: 0,
    activeFixturesRemaining: 0,
    errors: [],
  };
  currentStage = "cleanup-provider";
  for (const key of cleanupState.providerKeys) {
    try {
      await providerClient.send(
        new DeleteObjectCommand({
          Bucket: process.env.STORAGE_BUCKET,
          Key: key,
        }),
      );
      const state = await headObject(providerClient, key);
      if (state.exists) cleanupResult.providerObjectsRemaining += 1;
      else cleanupResult.providerObjectsDeleted += 1;
    } catch (error) {
      cleanupResult.errors.push({
        area: "provider",
        name: error?.name || "unknown",
      });
    }
  }
  for (const prefix of cleanupState.providerPrefixes) {
    try {
      const listed = await providerClient.send(
        new ListObjectsV2Command({
          Bucket: process.env.STORAGE_BUCKET,
          Prefix: prefix,
        }),
      );
      cleanupResult.providerObjectsRemaining += (listed.Contents || []).filter(
        (item) => item.Key,
      ).length;
    } catch (error) {
      cleanupResult.errors.push({
        area: "provider-inventory",
        name: error?.name || "unknown",
      });
    }
  }

  currentStage = "cleanup-redis";
  try {
    const keys = [...cleanupState.redisKeys];
    if (keys.length) cleanupResult.redisKeysDeleted = await redis.del(...keys);
    for (const key of keys)
      if ((await redis.get(key)) !== null)
        cleanupResult.redisKeysRemaining += 1;
  } catch (error) {
    cleanupResult.errors.push({
      area: "redis",
      name: error?.name || "unknown",
    });
  }

  currentStage = "cleanup-database";
  try {
    await client.query("BEGIN");
    if (cleanupState.grantIds.length) {
      const result = await client.query(
        "DELETE FROM document_download_grants WHERE id = ANY($1::uuid[])",
        [cleanupState.grantIds],
      );
      cleanupResult.grantRowsDeleted = result.rowCount || 0;
    }
    if (cleanupState.registryIds.length) {
      const result = await client.query(
        "DELETE FROM document_registry WHERE id = ANY($1::uuid[])",
        [cleanupState.registryIds],
      );
      cleanupResult.registryRowsDeleted = result.rowCount || 0;
    }
    if (cleanupState.companyIds.length)
      await client.query(
        "DELETE FROM monthly_snapshots WHERE company_id = ANY($1::uuid[])",
        [cleanupState.companyIds],
      );
    if (cleanupState.userIds.length)
      await client.query(
        "UPDATE users SET status = false, deleted_at = COALESCE(deleted_at, NOW()) WHERE id = ANY($1::uuid[])",
        [cleanupState.userIds],
      );
    if (cleanupState.siteIds.length)
      await client.query(
        "UPDATE sites SET status = false, deleted_at = COALESCE(deleted_at, NOW()) WHERE id = ANY($1::uuid[])",
        [cleanupState.siteIds],
      );
    if (cleanupState.companyIds.length)
      await client.query(
        "UPDATE companies SET status = false, deleted_at = COALESCE(deleted_at, NOW()) WHERE id = ANY($1::uuid[])",
        [cleanupState.companyIds],
      );
    await client.query("COMMIT");
    if (cleanupState.companyIds.length) {
      const residual = await client.query(
        `SELECT COUNT(*) FILTER (WHERE status = true)::int AS active
        FROM companies WHERE id = ANY($1::uuid[])`,
        [cleanupState.companyIds],
      );
      cleanupResult.activeFixturesRemaining = Number(
        residual.rows[0]?.active || 0,
      );
    }
    if (cleanupState.registryIds.length) {
      const residual = await client.query(
        "SELECT COUNT(*)::int AS count FROM document_registry WHERE id = ANY($1::uuid[])",
        [cleanupState.registryIds],
      );
      cleanupResult.registryRowsRemaining = Number(
        residual.rows[0]?.count || 0,
      );
    }
    if (cleanupState.grantIds.length) {
      const residual = await client.query(
        "SELECT COUNT(*)::int AS count FROM document_download_grants WHERE id = ANY($1::uuid[])",
        [cleanupState.grantIds],
      );
      cleanupResult.grantRowsRemaining = Number(residual.rows[0]?.count || 0);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    cleanupResult.errors.push({
      area: "database",
      name: error?.name || "unknown",
    });
  }
  fixture.cleanup = cleanupResult;
  if (
    cleanupResult.errors.length ||
    cleanupResult.providerObjectsRemaining ||
    cleanupResult.redisKeysRemaining ||
    cleanupResult.registryRowsRemaining ||
    cleanupResult.grantRowsRemaining ||
    cleanupResult.activeFixturesRemaining
  ) {
    throw new Error(
      `bounded cleanup failed at ${cleanupResult.errors.map((item) => item.area).join(",") || "residual-check"}`,
    );
  }
}

async function main() {
  assertEnvironment();
  const client = new Client({
    connectionString: process.env.DATABASE_MIGRATION_URL,
  });
  const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  const providerClient = s3Client();
  const cases = [];
  const results = { rateLimitWaits: [], rateLimitBlocked: [] };
  const fixture = {
    marker: MARKER,
    runId,
    target: "sgs-loadtest",
    tenants: {},
    provider: {},
    documents: {},
    grants: {},
    cache: {},
  };
  let cleanupCompleted = false;
  try {
    await client.connect();
    const tenants = await provision(client);
    fixture.tenants = Object.fromEntries(
      Object.entries(tenants).map(([label, tenant]) => [
        label,
        {
          companyIdHash: hashText(tenant.companyId).slice(0, 12),
          siteIdHash: hashText(tenant.siteId).slice(0, 12),
          userIdHash: hashText(tenant.userId).slice(0, 12),
          cpfHash: hashText(tenant.cpf).slice(0, 12),
        },
      ]),
    );
    const sessions = {
      A: await createSession(tenants.A),
      B: await createSession(tenants.B),
    };
    currentStage = "provider-direct";
    const provider = await providerStorageProof(
      providerClient,
      cases,
      fixture,
      tenants,
    );
    provider.client = providerClient;
    currentStage = "storage-http";
    await storageHttpProof(
      sessions,
      tenants,
      provider,
      cases,
      fixture,
      results,
    );
    currentStage = "registry-binding";
    await bindRegistry(client, tenants, fixture);
    currentStage = "registry-grant";
    await registryReadAndGrantProof(client, sessions, tenants, fixture, cases);
    currentStage = "orphan-authorization";
    await orphanAuthorizationProof(
      client,
      sessions.A,
      tenants.A,
      provider,
      cases,
    );
    currentStage = "provider-failure";
    await providerFailureProof(sessions, cases);
    await providerReadFailureProof(
      client,
      sessions.A,
      tenants.A,
      fixture,
      cases,
    );
    currentStage = "grant-runtime";
    await grantProof(client, sessions, tenants, provider, cases, fixture);
    currentStage = "cache-runtime";
    await cacheProof(sessions, tenants, redis, cases, results, fixture);
    await cleanup(client, redis, providerClient, fixture);
    cleanupCompleted = true;
    const counts = cases.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    const reportFixture = JSON.parse(JSON.stringify(fixture));
    for (const document of Object.values(reportFixture.documents || {})) {
      delete document.fileKey;
    }
    console.log(
      JSON.stringify(
        {
          gate: "P0_STORAGE_GRANT_CACHE",
          fixture: reportFixture,
          counts,
          rateLimit: results,
          cases,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!cleanupCompleted)
      await cleanup(client, redis, providerClient, fixture);
    await client.end().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    providerClient.destroy();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      gate: "P0_STORAGE_GRANT_CACHE",
      status: "ERROR",
      stage: currentStage,
      name: error?.name || null,
      code: error?.Code || error?.code || null,
      httpStatus: error?.$metadata?.httpStatusCode || null,
      message: "runtime gate failed; inspect sanitized stage and provider logs",
    }),
  );
  process.exitCode = 1;
});
