/*
 * P1 Auth/MFA follow-up. Loadtest only.
 * Creates synthetic tenants/users and emits statuses/booleans only.
 */
const { assertLoadtestEnvironment } = require('./loadtest-target-guard.cjs');
assertLoadtestEnvironment({ requireApi: true, requireDatabase: true, requireRedis: true });

const crypto = require("node:crypto");
const { Client } = require("/app/node_modules/pg");
const argon2 = require("/app/node_modules/argon2");
const jwt = require("/app/node_modules/jsonwebtoken");
const Redis = require("/app/node_modules/ioredis");

const API_URL = String(
  process.env.LOADTEST_API_URL || "http://api-loadtest:3001",
).replace(/\/+$/, "");
const PASSWORD = String(process.env.LOADTEST_ADMIN_PASSWORD || "");
const MARKER = "SGS_P1_AUTH_MFA_FOLLOWUP";
let requestSequence = 0;

function fail(message) {
  throw new Error(`[mfa-auth-followup-gate] ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
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
    for (let index = 0; index < length; index += 1)
      sum += digits[index] * (length + 1 - index);
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
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

function hashCpf(cpf) {
  return crypto
    .createHmac("sha256", process.env.FIELD_ENCRYPTION_HASH_KEY)
    .update(cpf)
    .digest("hex");
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of String(value)
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) fail("invalid TOTP secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret) {
  const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const hmac = crypto
    .createHmac("sha1", decodeBase32(secret))
    .update(counterBuffer)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function wrongTotp(secret) {
  const valid = totp(secret);
  return valid === "000000" ? "111111" : "000000";
}

function nextRequestIp() {
  const value = requestSequence++;
  return `10.247.${Math.floor(value / 200)}.${(value % 200) + 1}`;
}

function setCookies(headers, jar) {
  const values =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie") || ""];
  for (const raw of values) {
    const pair = String(raw).split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (value) jar.set(name, value);
  }
}

function cookies(jar) {
  return [...jar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function json(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function databaseUrl() {
  if (process.env.DATABASE_MIGRATION_URL)
    return process.env.DATABASE_MIGRATION_URL;
  const user = process.env.POSTGRES_MIGRATOR_USER;
  const password = process.env.POSTGRES_MIGRATOR_PASSWORD;
  if (user && password)
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@postgres-loadtest:5432/sgs_loadtest`;
  fail("database migration configuration missing");
}

async function provision(tenants) {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  const profile = await client.query(
    "SELECT id FROM profiles WHERE nome = 'Administrador Geral' ORDER BY id LIMIT 1",
  );
  assert(profile.rows[0]?.id, "ADMIN_GERAL profile missing");
  const stamp = Date.now().toString().slice(-12);
  try {
    for (const label of ["A", "B"]) {
      const companyId = crypto.randomUUID();
      const siteId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const cpf = cpfFor(`${label === "A" ? "1" : "2"}${stamp}`);
      const passwordHash = await argon2.hash(PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      const cnpj = `${label === "A" ? "91" : "92"}${stamp}`;
      await client.query("BEGIN");
      try {
        await client.query(
          "INSERT INTO companies (id, razao_social, cnpj, endereco, responsavel, status) VALUES ($1,$2,$3,$4,$5,true)",
          [
            companyId,
            `${MARKER} Tenant ${label}`,
            cnpj,
            "VPS loadtest sintético",
            MARKER,
          ],
        );
        await client.query(
          "INSERT INTO sites (id, nome, local, company_id, status) VALUES ($1,$2,$3,$4,true)",
          [siteId, `${MARKER} Site ${label}`, "VPS loadtest", companyId],
        );
        await client.query(
          `INSERT INTO users
           (id,nome,cpf,cpf_hash,cpf_ciphertext,email,funcao,password,status,company_id,site_id,profile_id,module_access_keys,identity_type,access_status,ai_processing_consent,must_change_password)
           VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,true,$8,$9,$10,'[]'::jsonb,'system_user','credentialed',false,false)`,
          [
            userId,
            `${MARKER} User ${label}`,
            hashCpf(cpf),
            encrypt(cpf, process.env.FIELD_ENCRYPTION_KEY),
            `${MARKER.toLowerCase()}-${label.toLowerCase()}-${userId}@invalid.test`,
            "Administrador Geral",
            passwordHash,
            companyId,
            siteId,
            profile.rows[0].id,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      tenants[label] = { label, companyId, siteId, userId, cpf };
    }
  } finally {
    await client.end();
  }
  return tenants;
}

async function cleanupTenants(tenants) {
  const client = new Client({ connectionString: databaseUrl() });
  const companyIds = Object.values(tenants).map((tenant) => tenant.companyId);
  const userIds = Object.values(tenants).map((tenant) => tenant.userId);
  await client.connect();
  try {
    for (const table of [
      "user_mfa_recovery_codes",
      "user_mfa_credentials",
      "user_sessions",
    ]) {
      const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS exists", [`public.${table}`]);
      if (!exists.rows[0]?.exists) continue;
      await client.query(`DELETE FROM public.${table} WHERE user_id = ANY($1::uuid[])`, [userIds]);
    }
    await client.query(
      "UPDATE public.users SET deleted_at = COALESCE(deleted_at, NOW()), status = false WHERE id = ANY($1::uuid[])",
      [userIds],
    );
    await client.query(
      "UPDATE public.sites SET deleted_at = COALESCE(deleted_at, NOW()), status = false WHERE id = ANY($1::uuid[])",
      [Object.values(tenants).map((tenant) => tenant.siteId)],
    );
    await client.query(
      "UPDATE public.companies SET deleted_at = COALESCE(deleted_at, NOW()), status = false WHERE id = ANY($1::uuid[])",
      [companyIds],
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function request(session, method, path, body, extraHeaders = {}) {
  const headers = {
    "user-agent": "sgs-p1-auth-mfa-followup/1.0",
    "x-forwarded-for": nextRequestIp(),
    ...(session ? { cookie: cookies(session.jar) } : {}),
    ...(session?.accessToken
      ? { authorization: `Bearer ${session.accessToken}` }
      : {}),
    ...(session?.csrfToken ? { "x-csrf-token": session.csrfToken } : {}),
    ...extraHeaders,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (session) setCookies(response.headers, session.jar);
  return { status: response.status, body: await json(response) };
}

async function csrf(session) {
  const response = await request(session, "GET", "/auth/csrf");
  assert(
    response.status === 200 && typeof response.body?.csrfToken === "string",
    "CSRF bootstrap failed",
  );
  session.csrfToken = response.body.csrfToken;
}

async function loginStart(user) {
  const session = { jar: new Map(), csrfToken: "", accessToken: "" };
  await csrf(session);
  const response = await request(session, "POST", "/auth/login", {
    cpf: user.cpf,
    password: PASSWORD,
  });
  assert(
    response.status >= 200 && response.status < 300,
    `login failed with HTTP ${response.status}`,
  );
  return { user, session, response };
}

async function activateBootstrap(flow, secret, code = totp(secret)) {
  const response = await request(
    flow.session,
    "POST",
    "/auth/login/mfa/bootstrap/activate",
    {
      challengeToken: flow.response.body?.challengeToken,
      code,
    },
  );
  if (response.body?.accessToken)
    flow.session.accessToken = response.body.accessToken;
  return response;
}

async function verifyLogin(flow, code) {
  const response = await request(
    flow.session,
    "POST",
    "/auth/login/mfa/verify",
    {
      challengeToken: flow.response.body?.challengeToken,
      code,
    },
  );
  if (response.body?.accessToken)
    flow.session.accessToken = response.body.accessToken;
  return response;
}

function requireBootstrap(flow) {
  assert(
    flow.response.body?.mfaEnrollRequired === true,
    "login did not require MFA bootstrap",
  );
  assert(
    typeof flow.response.body.challengeToken === "string",
    "bootstrap challenge missing",
  );
  assert(
    typeof flow.response.body.manualEntryKey === "string",
    "bootstrap secret missing",
  );
  assert(
    Array.isArray(flow.response.body.recoveryCodes),
    "bootstrap recovery codes missing",
  );
  return flow.response.body.manualEntryKey;
}

function requireLoginChallenge(flow) {
  assert(
    flow.response.body?.mfaRequired === true,
    "login did not require active MFA challenge",
  );
  assert(
    typeof flow.response.body.challengeToken === "string",
    "login challenge missing",
  );
}

function assertJwtContract(token, user) {
  const decoded = jwt.decode(token, { complete: true });
  const header = decoded?.header || {};
  const payload = decoded?.payload || {};
  assert(header.alg === "HS256", "MFA session JWT algorithm mismatch");
  assert(
    payload.iss === process.env.JWT_ISSUER,
    "MFA session JWT issuer mismatch",
  );
  assert(
    payload.aud === process.env.JWT_AUDIENCE,
    "MFA session JWT audience mismatch",
  );
  assert(
    payload.token_type === "access",
    "MFA session JWT token type mismatch",
  );
  assert(
    Number.isFinite(payload.exp) && payload.exp > Math.floor(Date.now() / 1000),
    "MFA session JWT expiration mismatch",
  );
  assert(
    payload.sub === user.userId && payload.app_user_id === user.userId,
    "MFA session JWT principal mismatch",
  );
  assert(
    payload.company_id === user.companyId,
    "MFA session JWT tenant mismatch",
  );
}

async function deleteChallengeFromRedis(token) {
  const decoded = jwt.decode(token);
  const jti = decoded?.jti;
  assert(typeof jti === "string", "challenge jti missing");
  const redis = new Redis({
    host: process.env.REDIS_HOST || "redis-loadtest",
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD,
  });
  try {
    const removed = await redis.del(`mfa:challenge:${jti}`);
    assert(removed === 1, "synthetic challenge key was not removed");
  } finally {
    await redis.quit();
  }
}

async function mfaState(userId) {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const result = await client.query(
      "SELECT is_enabled, company_id, disabled_at FROM user_mfa_credentials WHERE user_id = $1 AND type = 'totp'",
      [userId],
    );
    return result.rows[0] || null;
  } finally {
    await client.end();
  }
}

async function refreshAndReplay(session) {
  const oldRefresh = session.jar.get("refresh_token");
  const oldRefreshCsrf = session.jar.get("refresh_csrf");
  assert(
    oldRefresh && oldRefreshCsrf,
    "refresh cookies missing after MFA session",
  );
  const refreshed = await request(session, "POST", "/auth/refresh", undefined, {
    "x-refresh-csrf": oldRefreshCsrf,
  });
  assert(
    refreshed.status >= 200 &&
      refreshed.status < 300 &&
      typeof refreshed.body?.accessToken === "string",
    "refresh after MFA failed",
  );
  session.accessToken = refreshed.body.accessToken;

  const replay = await request(session, "POST", "/auth/refresh", undefined, {
    cookie: `refresh_token=${oldRefresh}; refresh_csrf=${oldRefreshCsrf}; csrf-token=${session.jar.get("csrf-token") || ""}`,
    "x-refresh-csrf": oldRefreshCsrf,
  });
  assert(
    replay.status === 401,
    `refresh replay was accepted with HTTP ${replay.status}`,
  );
  return { refreshedStatus: refreshed.status, replayStatus: replay.status };
}

async function main() {
  assert(
    process.env.APP_ENV === "loadtest" &&
      process.env.APP_LOADTEST_MARKER === "sgs-loadtest",
    "loadtest guard failed",
  );
  assert(process.env.DATABASE_NAME === "sgs_loadtest", "wrong database");
  assert(
    PASSWORD &&
      /^[a-f0-9]{64}$/i.test(process.env.FIELD_ENCRYPTION_KEY || "") &&
      /^[a-f0-9]{64}$/i.test(process.env.FIELD_ENCRYPTION_HASH_KEY || ""),
    "synthetic runtime configuration missing",
  );
  assert(
    process.env.JWT_SECRET &&
      process.env.JWT_ISSUER &&
      process.env.JWT_AUDIENCE,
    "JWT configuration missing",
  );

  const tenants = {};
  try {
    await provision(tenants);
  const result = {
    marker: MARKER,
    tenantPrefixes: {
      A: tenants.A.companyId.slice(0, 8),
      B: tenants.B.companyId.slice(0, 8),
    },
    cases: {},
  };

  const bootstrapA = await loginStart(tenants.A);
  const secretA = requireBootstrap(bootstrapA);
  const invalidActivation = await activateBootstrap(
    bootstrapA,
    secretA,
    wrongTotp(secretA),
  );
  assert(
    invalidActivation.status === 401,
    `invalid bootstrap activation returned HTTP ${invalidActivation.status}`,
  );
  const activationA = await activateBootstrap(bootstrapA, secretA);
  assert(
    activationA.status >= 200 &&
      activationA.status < 300 &&
      bootstrapA.session.accessToken,
    `bootstrap activation failed with HTTP ${activationA.status}`,
  );
  const stateA = await mfaState(tenants.A.userId);
  assert(
    stateA?.is_enabled === true && stateA.company_id === tenants.A.companyId,
    "MFA activation was not durably enabled in tenant A",
  );
  result.cases.bootstrapActivation = {
    loginStatus: bootstrapA.response.status,
    invalidStatus: invalidActivation.status,
    activationStatus: activationA.status,
    persisted: true,
  };

  const meA = await request(bootstrapA.session, "GET", "/auth/me");
  assert(
    meA.status === 200,
    `authenticated /auth/me after MFA returned HTTP ${meA.status}`,
  );
  assertJwtContract(bootstrapA.session.accessToken, tenants.A);
  const statusA = await request(bootstrapA.session, "GET", "/auth/mfa/status");
  assert(
    statusA.status === 200 && statusA.body?.enabled === true,
    "MFA status after activation is not enabled",
  );
  const platformA = await request(
    bootstrapA.session,
    "GET",
    "/admin/cache/status",
  );
  assert(
    platformA.status === 403,
    `ADMIN_GERAL reached platform route after MFA with HTTP ${platformA.status}`,
  );
  result.cases.sessionAndAuthorization = {
    meStatus: meA.status,
    mfaStatus: statusA.status,
    platformStatus: platformA.status,
  };

  const bootstrapB = await loginStart(tenants.B);
  const secretB = requireBootstrap(bootstrapB);
  const activationB = await activateBootstrap(bootstrapB, secretB);
  assert(
    activationB.status >= 200 &&
      activationB.status < 300 &&
      bootstrapB.session.accessToken,
    `tenant B bootstrap activation failed with HTTP ${activationB.status}`,
  );
  const stateB = await mfaState(tenants.B.userId);
  assert(
    stateB?.is_enabled === true && stateB.company_id === tenants.B.companyId,
    "MFA activation was not durably enabled in tenant B",
  );

  const wrongTokenFlow = await loginStart(tenants.A);
  requireLoginChallenge(wrongTokenFlow);
  const invalidToken = await request(
    wrongTokenFlow.session,
    "POST",
    "/auth/login/mfa/verify",
    { challengeToken: "invalid-mfa-challenge", code: totp(secretA) },
  );
  assert(
    invalidToken.status === 403,
    `invalid MFA challenge returned HTTP ${invalidToken.status}`,
  );

  const wrongCodeFlow = await loginStart(tenants.A);
  requireLoginChallenge(wrongCodeFlow);
  const wrongCode = await verifyLogin(wrongCodeFlow, wrongTotp(secretA));
  assert(
    wrongCode.status === 401,
    `wrong TOTP returned HTTP ${wrongCode.status}`,
  );

  const expiredFlow = await loginStart(tenants.B);
  requireLoginChallenge(expiredFlow);
  await deleteChallengeFromRedis(expiredFlow.response.body.challengeToken);
  const expired = await verifyLogin(expiredFlow, totp(secretB));
  assert(
    expired.status === 403,
    `expired MFA challenge returned HTTP ${expired.status}`,
  );

  const crossA = await loginStart(tenants.A);
  const crossB = await loginStart(tenants.B);
  requireLoginChallenge(crossA);
  requireLoginChallenge(crossB);
  const crossTenant = await verifyLogin(crossA, totp(secretB));
  assert(
    crossTenant.status === 401 && !crossA.session.accessToken,
    "cross-tenant TOTP produced a session",
  );

  const replayFlow = await loginStart(tenants.B);
  requireLoginChallenge(replayFlow);
  const replayFirst = await verifyLogin(replayFlow, totp(secretB));
  assert(
    replayFirst.status >= 200 &&
      replayFirst.status < 300 &&
      replayFlow.session.accessToken,
    "valid MFA verification failed",
  );
  const replaySecond = await verifyLogin(replayFlow, totp(secretB));
  assert(
    replaySecond.status === 403,
    `MFA challenge replay returned HTTP ${replaySecond.status}`,
  );
  result.cases.challengeRejection = {
    invalidToken: invalidToken.status,
    wrongCode: wrongCode.status,
    expired: expired.status,
    crossTenant: crossTenant.status,
    replay: replaySecond.status,
  };

  const regenerated = await request(
    bootstrapA.session,
    "POST",
    "/auth/mfa/recovery-codes/regenerate",
  );
  assert(
    regenerated.status >= 200 &&
      regenerated.status < 300 &&
      Array.isArray(regenerated.body?.recoveryCodes) &&
      regenerated.body.recoveryCodes.length > 0,
    "recovery code regeneration failed",
  );
  const recoveryCode = regenerated.body.recoveryCodes[0];
  const recoveryFlow = await loginStart(tenants.A);
  requireLoginChallenge(recoveryFlow);
  const recoveryLogin = await verifyLogin(recoveryFlow, recoveryCode);
  assert(
    recoveryLogin.status >= 200 &&
      recoveryLogin.status < 300 &&
      recoveryFlow.session.accessToken,
    `valid recovery code was rejected with HTTP ${recoveryLogin.status}: ${String(recoveryLogin.body?.message || "no-message")}`,
  );
  const recoveryReplayFlow = await loginStart(tenants.A);
  requireLoginChallenge(recoveryReplayFlow);
  const recoveryReplay = await verifyLogin(recoveryReplayFlow, recoveryCode);
  assert(
    recoveryReplay.status === 401,
    `replayed recovery code returned HTTP ${recoveryReplay.status}`,
  );
  result.cases.recoveryCode = {
    regenerateStatus: regenerated.status,
    firstUse: recoveryLogin.status,
    replay: recoveryReplay.status,
  };

  const foreignHeader = await request(
    bootstrapA.session,
    "POST",
    "/auth/mfa/disable",
    { code: totp(secretA), userId: tenants.B.userId },
    { "x-company-id": tenants.B.companyId },
  );
  const stateBAfterForeignAttempt = await mfaState(tenants.B.userId);
  assert(
    foreignHeader.status === 403 &&
      stateBAfterForeignAttempt?.is_enabled === true,
    "cross-tenant MFA disable was not blocked",
  );
  result.cases.mfaAdministrationBoundary = {
    foreignTenantDisable: foreignHeader.status,
    tenantBStillEnabled: true,
  };

  const rotation = await refreshAndReplay(replayFlow.session);
  assertJwtContract(replayFlow.session.accessToken, tenants.B);
  const logout = await request(replayFlow.session, "POST", "/auth/logout");
  assert(
    logout.status >= 200 && logout.status < 300,
    `logout after MFA returned HTTP ${logout.status}`,
  );
  const afterLogout = await request(replayFlow.session, "GET", "/auth/me");
  assert(
    afterLogout.status === 401,
    `revoked MFA access token returned HTTP ${afterLogout.status}`,
  );
  result.cases.jwtRefreshLogout = {
    refresh: rotation.refreshedStatus,
    refreshReplay: rotation.replayStatus,
    logout: logout.status,
    revokedAccess: afterLogout.status,
  };

    console.log(
      JSON.stringify({
        pass: true,
        marker: MARKER,
        tenants: { A: result.tenantPrefixes.A, B: result.tenantPrefixes.B },
        cases: result.cases,
        secretsPrinted: false,
      }),
    );
  } finally {
    if (tenants) await cleanupTenants(tenants);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "MFA gate failed");
  process.exitCode = 1;
});
