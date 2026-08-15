import http from 'k6/http';
import execution from 'k6/execution';
import { check, fail, sleep } from 'k6';
import secrets from 'k6/secrets';
import { SharedArray } from 'k6/data';

const BASE_URL = 'https://api-loadtest.sgsseguranca.com.br';
const TEST_RUN_ID = String(__ENV.TEST_RUN_ID || `sgs-baseline-auth-${Date.now()}`);
const USERS = new SharedArray('synthetic-users', () => JSON.parse(open('./data/synthetic-users.json')));
const ALLOWED_KEYS = new Set(['alias', 'login', 'user_id', 'company_id', 'role']);
const TARGET_USERS = Number(__ENV.TARGET_USERS || 10);
const LOGIN_STAGGER_SECONDS = Number(__ENV.LOGIN_STAGGER_SECONDS || 20);
const HOLD_DURATION = String(__ENV.HOLD_DURATION || '60s');
const SEEDED_ADMIN_LOGIN = String(__ENV.LOADTEST_ADMIN_CPF || '').replace(/\D/g, '');
let session = null;
let loginCount = 0;

export const options = {
  scenarios: { authenticated_baseline: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: `${TARGET_USERS * LOGIN_STAGGER_SECONDS}s`, target: TARGET_USERS }, { duration: HOLD_DURATION, target: TARGET_USERS }, { duration: '30s', target: 0 }], gracefulRampDown: '15s' } },
  thresholds: {
    http_reqs: ['count>0'], iterations: ['count>0'], checks: ['rate>0.99'], http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'], 'http_req_duration{endpoint:login}': ['p(95)<1500'], 'http_req_duration{endpoint:auth_me}': ['p(95)<1000'],
  },
};

const json = (response) => { try { return response.json(); } catch { return null; } };
const url = (path) => `${BASE_URL}${path}`;
const isBad = (response) => response.status === 429 || response.status >= 500;
const userForVu = (users) => users[execution.vu.idInTest - 1];

function validateUser(user) {
  if (!user || typeof user !== 'object') fail('synthetic user entry is invalid');
  if (Object.keys(user).some((key) => !ALLOWED_KEYS.has(key))) fail('synthetic user contains a forbidden field');
  if (!/^loadtest-[a-z0-9-]+$/.test(String(user.alias || ''))) fail('synthetic alias is not loadtest-scoped');
  if (!/^\d{11}$/.test(String(user.login || ''))) fail('synthetic login format is invalid');
  if (!/^[0-9a-f-]{36}$/i.test(String(user.user_id || '')) || !/^[0-9a-f-]{36}$/i.test(String(user.company_id || ''))) fail('synthetic user or tenant id is invalid');
  if (!String(user.role || '').trim()) fail('synthetic role is missing');
}

function resolveFingerprint(user) {
  return `grafana-baseline-${String(user.alias || user.user_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
}

function abortTest(message) {
  if (execution.test && typeof execution.test.abort === 'function') execution.test.abort(message);
  fail(message);
}

function params(gateKey, endpoint, statuses, token = '', companyId = '', fingerprint = '', extra = {}) {
  return {
    ...extra,
    headers: {
      Accept: 'application/json',
      'X-Loadtest-Key': gateKey,
      'X-Test-Run-ID': TEST_RUN_ID,
      ...(companyId ? { 'x-company-id': companyId } : {}),
      ...(fingerprint ? { 'x-client-fingerprint': fingerprint } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extra.headers || {}),
    },
    responseCallback: http.expectedStatuses(...statuses), tags: { endpoint, ...(extra.tags || {}) },
  };
}

async function readSecrets() {
  const envGateKey = String(__ENV.LOADTEST_PROXY_KEY || '').trim();
  const envPassword = String(__ENV.LOADTEST_ADMIN_PASSWORD || '').trim();
  try {
    const [gateKey, password] = await Promise.all([secrets.get('loadtest-gate-key'), secrets.get('sgs-loadtest-password')]);
    const resolvedGateKey = envGateKey || String(gateKey || '').trim();
    const resolvedPassword = envPassword || String(password || '').trim();
    if (!resolvedGateKey || !resolvedPassword) throw new Error('required secret is empty');
    return { gateKey: resolvedGateKey, password: resolvedPassword };
  } catch {
    if (envGateKey && envPassword) return { gateKey: envGateKey, password: envPassword };
    throw new Error('Missing Grafana secrets or env fallback: loadtest-gate-key, sgs-loadtest-password, LOADTEST_PROXY_KEY, LOADTEST_ADMIN_PASSWORD');
  }
}

export async function setup() {
  if (__ENV.BASE_URL && __ENV.BASE_URL !== BASE_URL) fail('BASE_URL is fixed to the loadtest hostname');
  if (!/^\d{11}$/.test(SEEDED_ADMIN_LOGIN)) fail('LOADTEST_ADMIN_CPF is required outside Git');
  if (!Number.isInteger(TARGET_USERS) || TARGET_USERS < 1 || TARGET_USERS > 121) fail('TARGET_USERS must be an integer between 1 and 121');
  if (!Number.isFinite(LOGIN_STAGGER_SECONDS) || LOGIN_STAGGER_SECONDS < 5) fail('LOGIN_STAGGER_SECONDS must be at least 5 seconds');
  if (USERS.length < TARGET_USERS) fail('not enough confirmed synthetic users for TARGET_USERS');
  const seededAdmin = USERS.find((user) => String(user.login) === SEEDED_ADMIN_LOGIN);
  if (!seededAdmin) fail('seeded admin is not present in synthetic-users.json');
  const selectedUsers = [seededAdmin, ...USERS.filter((user) => user !== seededAdmin)].slice(0, TARGET_USERS);
  const seen = new Set();
  selectedUsers.forEach((user) => { validateUser(user); for (const value of [user.login, user.user_id]) { if (seen.has(value)) fail('duplicate synthetic user across VUs'); seen.add(value); } });
  return { credentials: await readSecrets(), users: selectedUsers };
}

function login(credentials, user) {
  if (loginCount >= 1) abortTest('login already failed for this VU; stopping without retry');
  const fingerprint = resolveFingerprint(user);
  const csrf = http.get(url('/auth/csrf'), params(credentials.gateKey, 'csrf', [200], '', user.company_id, fingerprint));
  const csrfToken = String(json(csrf)?.csrfToken || '');
  check(csrf, { 'csrf is 200': (r) => r.status === 200, 'csrf token exists': () => Boolean(csrfToken) });
  if (isBad(csrf) || !csrfToken) abortTest(`csrf failed with HTTP ${csrf.status}`);
  const response = http.post(
    url('/auth/login'),
    JSON.stringify({ cpf: user.login, password: credentials.password }),
    params(credentials.gateKey, 'login', [200, 201], '', user.company_id, fingerprint, {
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      redirects: 0,
    }),
  );
  const token = String(json(response)?.accessToken || '');
  loginCount += 1;
  check(response, { 'login is successful': (r) => r.status === 200 || r.status === 201, 'access token exists': () => Boolean(token) });
  if (isBad(response) || !token || response.status < 200 || response.status > 299) {
    abortTest(`login failed with HTTP ${response.status}`);
  }
  session = { token, mfaChecked: false };
}

export default function baseline(data) {
  if (__VU < 1 || __VU > TARGET_USERS) fail('VU count exceeds TARGET_USERS');
  const user = userForVu(data.users);
  validateUser(user);
  if (!session) { sleep((execution.vu.idInTest - 1) * LOGIN_STAGGER_SECONDS); login(data.credentials, user); }

  const fingerprint = resolveFingerprint(user);
  let me = http.get(url('/auth/me'), params(data.credentials.gateKey, 'auth_me', [200, 401], session.token, user.company_id, fingerprint));
  if (me.status === 401) {
    fail('auth/me returned 401 unexpectedly; refusing to re-login during baseline');
  }
  const meUser = json(me)?.user || {};
  check(me, { 'auth/me is 200': (r) => r.status === 200, 'auth/me confirms synthetic user': () => meUser.id === user.user_id, 'auth/me confirms synthetic tenant': () => meUser.company_id === user.company_id });
  if (isBad(me)) fail(`auth/me returned ${me.status}`);

  if (!session.mfaChecked) {
    const mfa = http.get(url('/auth/mfa/status'), params(data.credentials.gateKey, 'auth_mfa_status', [200], session.token, user.company_id, fingerprint));
    const mfaBody = json(mfa) || {};
    check(mfa, { 'mfa status is 200': (r) => r.status === 200, 'mfa shape is read-only': () => typeof mfaBody.enabled === 'boolean' && typeof mfaBody.required === 'boolean' });
    if (isBad(mfa)) fail(`mfa status returned ${mfa.status}`);
    session.mfaChecked = true;
  }
  sleep(1);
}
