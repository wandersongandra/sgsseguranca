/*
 * BE-008 runtime gate. Loadtest only.
 *
 * Creates one synthetic tenant ADMIN_GERAL account using the existing
 * loadtest secret, then verifies that the account remains tenant-scoped,
 * cannot enter platform routes, cannot switch company and cannot assign the
 * ADMIN_GERAL profile. No token, cookie, secret, PII or response body is
 * printed.
 */
const { assertLoadtestEnvironment } = require('./loadtest-target-guard.cjs');
assertLoadtestEnvironment({ requireApi: true, requireDatabase: true });

const { randomBytes, createCipheriv, createHmac } = require("node:crypto");
const { Client } = require("/app/node_modules/pg");
const argon2 = require("/app/node_modules/argon2");
const jwt = require("/app/node_modules/jsonwebtoken");

const API_URL = String(
  process.env.LOADTEST_API_URL || "http://api-loadtest:3001",
).replace(/\/+$/, "");
const CPF = "15082302698";
const USER_ID = "00000000-0000-4000-8000-000000000004";
const SECOND_SITE_ID = "00000000-0000-4000-8000-000000000005";
const FOREIGN_COMPANY_ID = "00000000-0000-4000-8000-000000000099";
const MARKER = "SGS_P1_AUTHORIZATION_LEAST_PRIVILEGE";
const PASSWORD = String(process.env.LOADTEST_ADMIN_PASSWORD || "");

function fail(message) {
  throw new Error(`[authorization-least-privilege-gate] ${message}`);
}

function assertEnvironment() {
  if (
    process.env.APP_ENV !== "loadtest" ||
    process.env.APP_LOADTEST_MARKER !== "sgs-loadtest"
  ) {
    fail("loadtest marker missing");
  }
  if (process.env.DATABASE_NAME !== "sgs_loadtest") {
    fail("database is not sgs_loadtest");
  }
  if (!PASSWORD || !process.env.DATABASE_MIGRATION_URL) {
    fail("synthetic runtime configuration is missing");
  }
}

function keyFromHex(value, name) {
  if (!/^[a-f0-9]{64}$/i.test(value || "")) {
    fail(`${name} must be 32 bytes as 64 hex chars`);
  }
  return Buffer.from(value, "hex");
}

function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}:${cipher
    .getAuthTag()
    .toString("base64url")}:${data.toString("base64url")}`;
}

function readSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function updateCookieJar(jar, headers) {
  for (const rawCookie of readSetCookies(headers)) {
    const pair = String(rawCookie).split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (value) jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function responseJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function provisionSyntheticAdmin() {
  const client = new Client({
    connectionString: process.env.DATABASE_MIGRATION_URL,
  });
  const hashKey = String(process.env.FIELD_ENCRYPTION_HASH_KEY || "");
  if (!/^[a-f0-9]{64}$/i.test(hashKey)) {
    fail("FIELD_ENCRYPTION_HASH_KEY must be configured");
  }
  const fieldKey = keyFromHex(
    process.env.FIELD_ENCRYPTION_KEY,
    "FIELD_ENCRYPTION_KEY",
  );
  const cpfHash = createHmac("sha256", hashKey).update(CPF).digest("hex");
  const cpfCiphertext = encrypt(CPF, fieldKey);
  const passwordHash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await client.connect();
  try {
    await client.query(
      `INSERT INTO profiles (nome, permissoes, status)
       VALUES ('Administrador Geral', '{}'::jsonb, true)
       ON CONFLICT DO NOTHING`,
    );
    const profile = await client.query(
      `SELECT id FROM profiles WHERE nome = 'Administrador Geral' ORDER BY id LIMIT 1`,
    );
    if (!profile.rows[0]?.id) fail("ADMIN_GERAL profile is missing");

    const existingSite = await client.query(
      "SELECT nome, company_id FROM sites WHERE id = $1",
      [SECOND_SITE_ID],
    );
    if (
      existingSite.rows[0] &&
      (existingSite.rows[0].nome !== `${MARKER} Site secundário` ||
        existingSite.rows[0].company_id !== process.env.LOADTEST_COMPANY_ID)
    ) {
      fail("refusing to overwrite a non-synthetic site fixture");
    }
    const existingUser = await client.query(
      "SELECT nome, email, company_id FROM users WHERE id = $1",
      [USER_ID],
    );
    if (
      existingUser.rows[0] &&
      (existingUser.rows[0].nome !== `${MARKER} Admin Geral` ||
        existingUser.rows[0].email !== "p1-authorization-admin@invalid.test" ||
        existingUser.rows[0].company_id !== process.env.LOADTEST_COMPANY_ID)
    ) {
      fail("refusing to overwrite a non-synthetic user fixture");
    }

    await client.query(
      `INSERT INTO sites (id, nome, local, company_id, status)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (id) DO UPDATE SET
         nome = EXCLUDED.nome, local = EXCLUDED.local,
         company_id = EXCLUDED.company_id, status = true,
         deleted_at = NULL, updated_at = NOW()`,
      [
        SECOND_SITE_ID,
        `${MARKER} Site secundário`,
        "VPS load-test",
        process.env.LOADTEST_COMPANY_ID,
      ],
    );

    await client.query(
      `INSERT INTO users
       (id, nome, cpf, cpf_hash, cpf_ciphertext, email, funcao, password,
        status, company_id, site_id, profile_id, module_access_keys,
        identity_type, access_status, ai_processing_consent, must_change_password)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, true, $8, $9, $10,
               '[]'::jsonb, 'system_user', 'credentialed', false, false)
       ON CONFLICT (id) DO UPDATE SET
         cpf = NULL, cpf_hash = EXCLUDED.cpf_hash,
         cpf_ciphertext = EXCLUDED.cpf_ciphertext, password = EXCLUDED.password,
         company_id = EXCLUDED.company_id, site_id = EXCLUDED.site_id,
         profile_id = EXCLUDED.profile_id, status = true,
         access_status = 'credentialed', deleted_at = NULL, updated_at = NOW()`,
      [
        USER_ID,
        `${MARKER} Admin Geral`,
        cpfHash,
        cpfCiphertext,
        "p1-authorization-admin@invalid.test",
        "Administrador Geral sintético",
        passwordHash,
        process.env.LOADTEST_COMPANY_ID,
        process.env.LOADTEST_SITE_ID,
        profile.rows[0].id,
      ],
    );

    const state = await client.query(
      `SELECT status, company_id, site_id, profile_id,
              cpf_hash IS NOT NULL AS has_cpf_hash,
              length(password) AS password_length
       FROM users WHERE id = $1`,
      [USER_ID],
    );
    if (!state.rows[0]?.status || !state.rows[0]?.has_cpf_hash) {
      fail("synthetic ADMIN_GERAL was not provisioned");
    }

    return String(profile.rows[0].id);
  } finally {
    await client.end();
  }
}

async function login() {
  return { accessToken: createAccessToken(), jar: new Map() };
}

function createAccessToken({
  companyId = process.env.LOADTEST_COMPANY_ID,
  profileName = "Administrador Geral",
} = {}) {
  if (
    !process.env.JWT_SECRET ||
    !process.env.JWT_ISSUER ||
    !process.env.JWT_AUDIENCE
  ) {
    fail("JWT runtime configuration is missing");
  }
  const accessToken = jwt.sign(
    {
      sub: USER_ID,
      app_user_id: USER_ID,
      company_id: companyId,
      site_id: process.env.LOADTEST_SITE_ID,
      profile: { nome: profileName },
      isAdminGeral: false,
      jti: `p1-be008-${Date.now()}`,
      token_type: "access",
    },
    process.env.JWT_SECRET,
    {
      algorithm: "HS256",
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE,
      expiresIn: "10m",
    },
  );
  return accessToken;
}

async function call(session, method, path, body, csrfToken) {
  const headers = {
    authorization: `Bearer ${session.accessToken}`,
    cookie: cookieHeader(session.jar),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody = await responseJson(response);
  return { status: response.status, body: responseBody };
}

async function cleanupSyntheticAdmin() {
  const client = new Client({
    connectionString: process.env.DATABASE_MIGRATION_URL,
  });
  await client.connect();
  try {
    for (const table of [
      "user_mfa_recovery_codes",
      "user_mfa_credentials",
      "user_sessions",
    ]) {
      const exists = await client.query(
        "SELECT to_regclass($1) IS NOT NULL AS exists",
        [`public.${table}`],
      );
      if (exists.rows[0]?.exists) {
        await client.query(`DELETE FROM public.${table} WHERE user_id = $1`, [
          USER_ID,
        ]);
      }
    }
    await client.query(
      "UPDATE public.users SET deleted_at = COALESCE(deleted_at, NOW()), status = false WHERE id = $1 AND nome = $2 AND email = $3",
      [USER_ID, `${MARKER} Admin Geral`, "p1-authorization-admin@invalid.test"],
    );
    await client.query(
      "UPDATE public.sites SET deleted_at = COALESCE(deleted_at, NOW()), status = false WHERE id = $1 AND nome = $2",
      [SECOND_SITE_ID, `${MARKER} Site secundário`],
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  assertEnvironment();
  try {
    const adminGeralProfileId = await provisionSyntheticAdmin();
  const session = await login();
  const csrfResponse = await fetch(`${API_URL}/auth/csrf`);
  const csrfBody = await responseJson(csrfResponse);
  updateCookieJar(session.jar, csrfResponse.headers);
  if (!csrfResponse.ok || typeof csrfBody?.csrfToken !== "string") {
    fail("request csrf failed");
  }

  const platformRoute = await call(session, "GET", "/admin/cache/status");
  if (platformRoute.status !== 403) {
    fail(
      `ADMIN_GERAL reached platform route with HTTP ${platformRoute.status}`,
    );
  }

  const healthRoute = await call(session, "GET", "/health/detailed");
  if (healthRoute.status !== 403) {
    fail(
      `ADMIN_GERAL reached protected health route with HTTP ${healthRoute.status}`,
    );
  }

  const ownCompany = await call(session, "GET", "/companies");
  if (ownCompany.status !== 200) {
    fail(
      `ADMIN_GERAL lost own-tenant company access with HTTP ${ownCompany.status}`,
    );
  }
  const data = Array.isArray(ownCompany.body?.data) ? ownCompany.body.data : [];
  if (data.length !== 1 || data[0]?.id !== process.env.LOADTEST_COMPANY_ID) {
    fail("ADMIN_GERAL company list crossed tenant boundary");
  }

  const ownSites = await call(session, "GET", "/sites");
  const siteData = Array.isArray(ownSites.body?.data) ? ownSites.body.data : [];
  if (
    ownSites.status !== 200 ||
    !siteData.some((site) => site?.id === process.env.LOADTEST_SITE_ID) ||
    !siteData.some((site) => site?.id === SECOND_SITE_ID)
  ) {
    fail("ADMIN_GERAL did not retain all sites of its own tenant");
  }

  const foreignHeader = await call(session, "GET", "/companies", undefined);
  if (foreignHeader.status !== 200) {
    fail(
      `own tenant baseline company request failed with HTTP ${foreignHeader.status}`,
    );
  }
  const spoofResponse = await fetch(`${API_URL}/companies`, {
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      cookie: cookieHeader(session.jar),
      "x-company-id": FOREIGN_COMPANY_ID,
    },
  });
  await spoofResponse.text();
  if (spoofResponse.status !== 403) {
    fail(`ADMIN_GERAL switched tenant with HTTP ${spoofResponse.status}`);
  }

  const forgedTenant = await call(
    {
      accessToken: createAccessToken({ companyId: FOREIGN_COMPANY_ID }),
      jar: new Map(),
    },
    "GET",
    "/companies",
  );
  if (forgedTenant.status !== 401) {
    fail(
      `forged JWT company claim was accepted with HTTP ${forgedTenant.status}`,
    );
  }

  const forgedRole = await call(
    {
      accessToken: createAccessToken({ profileName: "SUPER_ADMIN" }),
      jar: new Map(),
    },
    "GET",
    "/admin/cache/status",
  );
  if (forgedRole.status !== 403) {
    fail(`forged JWT role claim was accepted with HTTP ${forgedRole.status}`);
  }

  const escalation = await call(
    session,
    "POST",
    "/users",
    {
      nome: `${MARKER} attempted promotion`,
      cpf: "11144477735",
      email: "p1-authorization-escalation@invalid.test",
      password: "Synthetic-Only-2026!",
      profile_id: adminGeralProfileId,
      company_id: process.env.LOADTEST_COMPANY_ID,
      site_id: process.env.LOADTEST_SITE_ID,
    },
    csrfBody.csrfToken,
  );
  if (escalation.status !== 403) {
    fail(
      `ADMIN_GERAL self-promotion was not blocked: HTTP ${escalation.status}`,
    );
  }

    console.log(
    JSON.stringify({
      pass: true,
      role: "ADMIN_GERAL",
      platformRoute: platformRoute.status,
      protectedHealth: healthRoute.status,
      ownTenantCompanies: data.length,
      ownTenantSites: siteData.length,
      tenantSpoof: spoofResponse.status,
      forgedTenantClaim: forgedTenant.status,
      forgedRoleClaim: forgedRole.status,
      selfPromotion: escalation.status,
    }),
    );
  } finally {
    await cleanupSyntheticAdmin();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
