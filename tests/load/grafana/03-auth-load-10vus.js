import http from 'k6/http';
import execution from 'k6/execution';
import { check, fail, sleep } from 'k6';
import secrets from 'k6/secrets';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { assertSafeTarget, url } from '../helpers/target-guard.js';

const BASE_URL = 'https://api-loadtest.sgsseguranca.com.br';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const TEST_RUN_ID = String(__ENV.TEST_RUN_ID || `sgs-auth-load-10vus-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const ALLOWED_KEYS = new Set(['alias', 'login', 'user_id', 'company_id', 'role', 'enabled']);
const USERS = new SharedArray('synthetic-users-10vus', () => {
  const users = JSON.parse(open('./data/synthetic-users.json'));
  return users;
});

const loginAttempts = new Counter('login_attempts');
const status401 = new Counter('auth_http_401_total');
const status403 = new Counter('auth_http_403_total');
const status429 = new Counter('auth_http_429_total');
const status5xx = new Counter('auth_http_5xx_total');

export const options = {
  scenarios: {
    authenticated_load_10vus: {
      executor: 'constant-vus',
      vus: 10,
      duration: '90s',
      gracefulStop: '10s',
    },
  },
  thresholds: {
    http_reqs: ['count>0'],
    iterations: ['count>0'],
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
    'http_req_duration{endpoint:login}': ['p(95)<1500'],
    'http_req_duration{endpoint:auth_me}': ['p(95)<1000'],
    'http_reqs{endpoint:login}': ['count==10'],
    'http_req_failed{endpoint:login}': ['rate==0'],
    login_attempts: ['count==10'],
  },
};

let session = null;
let loginStarted = false;

function parseJson(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function validateUser(user) {
  if (!user || typeof user !== 'object') fail('synthetic user entry is invalid');
  if (Object.keys(user).some((key) => !ALLOWED_KEYS.has(key))) fail('synthetic user contains a forbidden field');
  if (!/^loadtest-baseline-(00[1-9]|010)$/.test(String(user.alias || ''))) fail('synthetic alias is not approved');
  if (!/^\d{11}$/.test(String(user.login || ''))) fail('synthetic login format is invalid');
  if (!/^[0-9a-f-]{36}$/i.test(String(user.user_id || ''))) fail('synthetic user id is invalid');
  if (String(user.company_id) !== TENANT_ID) fail('synthetic tenant is invalid');
  if (!String(user.role || '').trim() || user.enabled !== true) fail('synthetic user is disabled or incomplete');
}

function userForVu() {
  const vuId = execution.vu.idInTest;
  if (vuId < 1 || vuId > 10) fail('this profile requires exactly ten VUs');
  return USERS[vuId - 1];
}

function requestOptions(gateKey, endpoint, expectedStatuses, token = '', extra = {}) {
  return {
    ...extra,
    headers: {
      Accept: 'application/json',
      'X-Loadtest-Key': gateKey,
      'X-Test-Run-ID': TEST_RUN_ID,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extra.headers || {}),
    },
    responseCallback: http.expectedStatuses(...expectedStatuses),
    tags: { endpoint, ...(extra.tags || {}) },
  };
}

function recordStatus(response) {
  if (response.status === 401) status401.add(1);
  if (response.status === 403) status403.add(1);
  if (response.status === 429) status429.add(1);
  if (response.status >= 500 && response.status <= 599) status5xx.add(1);
}

function abortOnUnexpectedStatus(response, endpoint) {
  recordStatus(response);
  if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
    execution.test.abort(`${endpoint} returned a disallowed HTTP status`);
  }
}

async function readSecrets() {
  try {
    const [gateKey, password] = await Promise.all([
      secrets.get('loadtest-gate-key'),
      secrets.get('sgs-loadtest-password'),
    ]);
    if (!gateKey || !password) throw new Error('required Grafana secret is empty');
    return { gateKey: String(gateKey), password: String(password) };
  } catch {
    throw new Error('Missing Grafana secrets: loadtest-gate-key, sgs-loadtest-password');
  }
}

export async function setup() {
  assertSafeTarget(BASE_URL, { maxVus: 10, maxDurationSeconds: 100 });
  if (__ENV.BASE_URL && __ENV.BASE_URL !== BASE_URL) fail('BASE_URL is fixed to the loadtest hostname');
  if (USERS.length !== 10) fail('exactly ten enabled synthetic users are required');
  const seen = new Set();
  for (const user of USERS) {
    validateUser(user);
    for (const identity of [user.login, user.user_id]) {
      if (seen.has(identity)) fail('duplicate synthetic identity across VUs');
      seen.add(identity);
    }
  }
  return { credentials: await readSecrets() };
}

function login(credentials, user) {
  if (loginStarted || session) fail('automatic relogin is disabled');
  const csrf = http.get(
    url(BASE_URL, '/auth/csrf'),
    requestOptions(credentials.gateKey, 'csrf', [200]),
  );
  abortOnUnexpectedStatus(csrf, 'csrf');
  const csrfToken = String(parseJson(csrf)?.csrfToken || '');
  check(csrf, {
    'csrf status is 200': (response) => response.status === 200,
    'csrf token is present': () => Boolean(csrfToken),
  });
  if (csrf.status !== 200 || !csrfToken) fail('csrf precondition failed');

  const loginResponse = http.post(
    url(BASE_URL, '/auth/login'),
    JSON.stringify({ cpf: user.login, password: credentials.password }),
    requestOptions(credentials.gateKey, 'login', [200, 201], '', {
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      redirects: 0,
    }),
  );
  abortOnUnexpectedStatus(loginResponse, 'login');
  const accessToken = String(parseJson(loginResponse)?.accessToken || '');
  loginAttempts.add(1);
  loginStarted = true;
  check(loginResponse, {
    'login status is 200 or 201': (response) => response.status === 200 || response.status === 201,
    'login access token is present': () => Boolean(accessToken),
  });
  if (![200, 201].includes(loginResponse.status) || !accessToken) fail('login failed or access token is absent');
  session = { accessToken, mfaChecked: false };
}

export default function authenticatedLoad(data) {
  const user = userForVu();
  validateUser(user);
  if (!session) {
    sleep((execution.vu.idInTest - 1) * 5);
    login(data.credentials, user);
  }

  const authMe = http.get(
    url(BASE_URL, '/auth/me'),
    requestOptions(data.credentials.gateKey, 'auth_me', [200], session.accessToken),
  );
  abortOnUnexpectedStatus(authMe, 'auth/me');
  const authMeUser = parseJson(authMe)?.user || {};
  const userMatch = authMeUser.id === user.user_id;
  const tenantMatch = authMeUser.company_id === TENANT_ID;
  check(authMe, {
    'auth/me status is 200': (response) => response.status === 200,
    'auth/me confirms VU user': () => userMatch,
    'auth/me confirms synthetic tenant': () => tenantMatch,
  });
  if (authMe.status !== 200 || !userMatch || !tenantMatch) fail('auth/me identity validation failed');

  if (!session.mfaChecked) {
    const mfaStatus = http.get(
      url(BASE_URL, '/auth/mfa/status'),
      requestOptions(data.credentials.gateKey, 'auth_mfa_status', [200], session.accessToken),
    );
    abortOnUnexpectedStatus(mfaStatus, 'auth/mfa/status');
    const mfaBody = parseJson(mfaStatus) || {};
    check(mfaStatus, {
      'mfa status is 200': (response) => response.status === 200,
      'mfa response is read-only shape': () => typeof mfaBody.enabled === 'boolean' && typeof mfaBody.required === 'boolean',
    });
    if (mfaStatus.status !== 200) fail('mfa status failed');
    session.mfaChecked = true;
  }
  sleep(5);
}
