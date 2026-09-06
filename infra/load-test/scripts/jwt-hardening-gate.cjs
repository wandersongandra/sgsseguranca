/*
 * BE-007 runtime gate. Loadtest only.
 *
 * The script validates the complete local JWT contract through the real API:
 * login claims, authenticated access, refresh rotation, old refresh replay,
 * logout revocation and rejection of issuer/audience/type/algorithm/exp
 * violations. It never prints tokens, secrets, cookies or response bodies.
 */
const { assertLoadtestEnvironment } = require('./loadtest-target-guard.cjs');
assertLoadtestEnvironment({ requireApi: true });

const jwt = require("/app/node_modules/jsonwebtoken");

const API_URL = String(
  process.env.LOADTEST_API_URL || "http://api-loadtest:3001",
).replace(/\/+$/, "");
const EXPECTED_ISSUER = "http://api-loadtest:3001";
const EXPECTED_AUDIENCE = "sgs-loadtest";
const ACCESS_SECRET = String(process.env.JWT_SECRET || "");
const REFRESH_SECRET = String(process.env.JWT_REFRESH_SECRET || "");
const CPF = String(process.env.LOADTEST_ADMIN_CPF || "").replace(/\D/g, "");
const PASSWORD = String(process.env.LOADTEST_ADMIN_PASSWORD || "");

function fail(message) {
  throw new Error(`[jwt-hardening-gate] ${message}`);
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
  if (!CPF || !PASSWORD) {
    fail("synthetic credentials are missing");
  }
  if (ACCESS_SECRET.length < 64 || REFRESH_SECRET.length < 64) {
    fail("JWT secrets are missing or too short");
  }
  if (ACCESS_SECRET === REFRESH_SECRET) {
    fail("access and refresh secrets must be different");
  }
  if (
    /(api\.sgsseguranca\.com\.br|app\.sgsseguranca\.com\.br|neon\.tech|upstash|backblaze|r2\.cloudflarestorage\.com)/i.test(
      API_URL,
    )
  ) {
    fail("production endpoint marker detected");
  }
}

async function responseJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function parseSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function updateCookieJar(jar, headers) {
  for (const rawCookie of parseSetCookies(headers)) {
    const pair = String(rawCookie).split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    // The API clears legacy path-scoped cookies alongside the new cookie.
    // An empty Set-Cookie must not erase the valid value stored for the
    // broader path in this intentionally minimal, name-scoped test jar.
    if (value) jar.set(name, value);
  }
}

function cookieHeader(jar, names = null) {
  const entries = names
    ? names.map((name) => [name, jar.get(name)]).filter(([, value]) => value)
    : [...jar.entries()];
  return entries.map(([name, value]) => `${name}=${value}`).join("; ");
}

function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) fail("API returned a malformed JWT");
  const decode = (value) =>
    JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  return { header: decode(parts[0]), payload: decode(parts[1]) };
}

function assertJwtContract(token, expectedType) {
  const decoded = decodeJwt(token);
  if (decoded.header.alg !== "HS256") fail("JWT algorithm contract mismatch");
  if (decoded.payload.iss !== EXPECTED_ISSUER)
    fail("JWT issuer contract mismatch");
  if (decoded.payload.aud !== EXPECTED_AUDIENCE)
    fail("JWT audience contract mismatch");
  if (decoded.payload.token_type !== expectedType)
    fail(`JWT token_type mismatch for ${expectedType}`);
  if (!Number.isFinite(decoded.payload.exp))
    fail("JWT exp is absent or invalid");
  if (decoded.payload.exp <= Math.floor(Date.now() / 1000))
    fail("JWT is already expired");
  return decoded;
}

async function login() {
  const jar = new Map();
  const csrfResponse = await fetch(`${API_URL}/auth/csrf`, {
    headers: { "user-agent": "sgs-p1-jwt-hardening-gate/1.0" },
  });
  const csrfBody = await responseJson(csrfResponse);
  updateCookieJar(jar, csrfResponse.headers);
  if (!csrfResponse.ok || typeof csrfBody?.csrfToken !== "string") {
    fail(`csrf failed with HTTP ${csrfResponse.status}`);
  }

  const loginResponse = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader(jar),
      "x-csrf-token": csrfBody.csrfToken,
      "user-agent": "sgs-p1-jwt-hardening-gate/1.0",
    },
    body: JSON.stringify({ cpf: CPF, password: PASSWORD }),
  });
  const loginBody = await responseJson(loginResponse);
  updateCookieJar(jar, loginResponse.headers);
  if (!loginResponse.ok || typeof loginBody?.accessToken !== "string") {
    fail(`login failed with HTTP ${loginResponse.status}`);
  }
  if (!jar.get("refresh_token") || !jar.get("refresh_csrf")) {
    fail("login did not issue refresh cookies");
  }
  return { jar, accessToken: loginBody.accessToken };
}

async function authenticatedGet(path, accessToken) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "user-agent": "sgs-p1-jwt-hardening-gate/1.0",
    },
  });
  await response.text();
  return response.status;
}

async function refresh(session) {
  const oldRefreshToken = session.jar.get("refresh_token");
  const oldRefreshCsrf = session.jar.get("refresh_csrf");
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: {
      cookie: cookieHeader(session.jar),
      "x-csrf-token": session.jar.get("csrf-token"),
      "x-refresh-csrf": oldRefreshCsrf,
      "user-agent": "sgs-p1-jwt-hardening-gate/1.0",
    },
  });
  const body = await responseJson(response);
  updateCookieJar(session.jar, response.headers);
  if (!response.ok || typeof body?.accessToken !== "string") {
    fail(`refresh failed with HTTP ${response.status}`);
  }

  const replayResponse = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: {
      cookie: `refresh_token=${oldRefreshToken}; refresh_csrf=${oldRefreshCsrf}; csrf-token=${session.jar.get("csrf-token")}`,
      "x-csrf-token": session.jar.get("csrf-token"),
      "x-refresh-csrf": oldRefreshCsrf,
      "user-agent": "sgs-p1-jwt-hardening-gate/1.0",
    },
  });
  await replayResponse.text();
  if (replayResponse.status !== 401) {
    fail(`old refresh replay was not rejected: HTTP ${replayResponse.status}`);
  }
  return body.accessToken;
}

function signedInvalidToken(payload, secret, options = {}) {
  return jwt.sign(payload, secret, {
    algorithm: "HS256",
    issuer: EXPECTED_ISSUER,
    audience: EXPECTED_AUDIENCE,
    expiresIn: "5m",
    ...options,
  });
}

async function assertInvalidAccessToken(token, label) {
  const status = await authenticatedGet("/auth/me", token);
  if (status !== 401) fail(`${label} was accepted with HTTP ${status}`);
}

async function assertForgedAccessTokensRejected(validToken) {
  const { payload } = decodeJwt(validToken);
  const base = {
    sub: payload.sub,
    app_user_id: payload.app_user_id,
    company_id: payload.company_id,
    jti: `p1-jwt-${Date.now()}`,
    token_type: "access",
  };
  await assertInvalidAccessToken(
    signedInvalidToken(base, ACCESS_SECRET, { issuer: "https://evil.invalid" }),
    "wrong issuer token",
  );
  await assertInvalidAccessToken(
    signedInvalidToken(base, ACCESS_SECRET, { audience: "other-api" }),
    "wrong audience token",
  );
  await assertInvalidAccessToken(
    signedInvalidToken({ ...base, token_type: "refresh" }, ACCESS_SECRET),
    "refresh token on access route",
  );
  await assertInvalidAccessToken(
    jwt.sign(base, ACCESS_SECRET, {
      algorithm: "HS384",
      issuer: EXPECTED_ISSUER,
      audience: EXPECTED_AUDIENCE,
      expiresIn: "5m",
    }),
    "HS384 token",
  );
  await assertInvalidAccessToken(
    jwt.sign(base, ACCESS_SECRET, {
      algorithm: "HS256",
      issuer: EXPECTED_ISSUER,
      audience: EXPECTED_AUDIENCE,
      noTimestamp: true,
    }),
    "token without exp",
  );
}

async function assertAccessTokenRejectedAsRefresh(session, accessToken) {
  const { payload } = decodeJwt(accessToken);
  const accessAsRefresh = signedInvalidToken(
    {
      sub: payload.sub,
      app_user_id: payload.app_user_id,
      company_id: payload.company_id,
      jti: `p1-jwt-refresh-${Date.now()}`,
      token_type: "access",
    },
    REFRESH_SECRET,
  );
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: {
      cookie: `refresh_token=${accessAsRefresh}; refresh_csrf=${session.jar.get("refresh_csrf")}; csrf-token=${session.jar.get("csrf-token")}`,
      "x-csrf-token": session.jar.get("csrf-token"),
      "x-refresh-csrf": session.jar.get("refresh_csrf"),
      "user-agent": "sgs-p1-jwt-hardening-gate/1.0",
    },
  });
  await response.text();
  if (response.status !== 401) {
    fail(`access token was accepted as refresh: HTTP ${response.status}`);
  }
}

async function logout(session) {
  const response = await fetch(`${API_URL}/auth/logout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      cookie: cookieHeader(session.jar),
      "x-csrf-token": session.jar.get("csrf-token"),
      "user-agent": "sgs-p1-jwt-hardening-gate/1.0",
    },
  });
  await response.text();
  if (response.status !== 201 && response.status !== 200) {
    fail(`logout failed with HTTP ${response.status}`);
  }
}

async function main() {
  assertEnvironment();
  const session = await login();
  const loginClaims = assertJwtContract(session.accessToken, "access");
  assertJwtContract(session.jar.get("refresh_token"), "refresh");
  const accessStatus = await authenticatedGet("/auth/me", session.accessToken);
  if (accessStatus !== 200)
    fail(`/auth/me rejected login token: HTTP ${accessStatus}`);

  const refreshedAccessToken = await refresh(session);
  assertJwtContract(refreshedAccessToken, "access");
  assertJwtContract(session.jar.get("refresh_token"), "refresh");
  session.accessToken = refreshedAccessToken;
  const refreshedStatus = await authenticatedGet(
    "/auth/me",
    refreshedAccessToken,
  );
  if (refreshedStatus !== 200)
    fail(`/auth/me rejected refreshed token: HTTP ${refreshedStatus}`);

  await assertForgedAccessTokensRejected(session.accessToken);
  await assertAccessTokenRejectedAsRefresh(session, session.accessToken);
  await logout(session);
  const revokedStatus = await authenticatedGet("/auth/me", session.accessToken);
  if (revokedStatus !== 401)
    fail(`logout did not revoke access token: HTTP ${revokedStatus}`);

  console.log(
    JSON.stringify({
      pass: true,
      login: {
        claims: {
          algorithm: loginClaims.header.alg,
          issuer: loginClaims.payload.iss,
          audience: loginClaims.payload.aud,
          tokenType: loginClaims.payload.token_type,
          expPresent: Number.isFinite(loginClaims.payload.exp),
        },
        authenticatedStatus: accessStatus,
      },
      refresh: {
        rotatedTokenType: "access",
        authenticatedStatus: refreshedStatus,
        oldTokenReplayStatus: 401,
      },
      rejection: {
        wrongIssuer: true,
        wrongAudience: true,
        wrongType: true,
        wrongAlgorithm: true,
        missingExp: true,
        accessAsRefresh: true,
      },
      logout: { revokedAccessStatus: revokedStatus },
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
