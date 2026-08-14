import http from 'k6/http';
import execution from 'k6/execution';
import { check, fail, sleep } from 'k6';
import secrets from 'k6/secrets';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';

const BASE_URL = 'https://api-loadtest.sgsseguranca.com.br';
const TEST_RUN_ID = String(__ENV.TEST_RUN_ID || `sgs-baseline-auth-${Date.now()}`);
const USERS = new SharedArray('synthetic-users', () => JSON.parse(open('./data/synthetic-users.json')));
const ALLOWED_KEYS = new Set(['alias', 'login', 'user_id', 'company_id', 'role', 'enabled']);
let session = null;
let loginCount = 0;
const baselineLogins = new Counter('baseline_logins_total');
const baselineUsersSelected = new Counter('baseline_users_selected_total');
const baseline401 = new Counter('baseline_http_401_total');
const baseline403 = new Counter('baseline_http_403_total');
const baseline429 = new Counter('baseline_http_429_total');
const baseline5xx = new Counter('baseline_http_5xx_total');

export const options = {
  scenarios: { authenticated_baseline: { executor: 'constant-vus', vus: 5, duration: '60s', gracefulStop: '10s' } },
  thresholds: {
    http_reqs: ['count>0'], iterations: ['count>0'], checks: ['rate>0.99'], http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'], 'http_req_duration{endpoint:login}': ['p(95)<1500'], 'http_req_duration{endpoint:auth_me}': ['p(95)<1000'],
    'http_reqs{endpoint:login}': ['count==5'],
    'http_req_failed{endpoint:login}': ['rate==0'],
    'http_req_failed{endpoint:auth_me}': ['rate==0'],
    'http_req_failed{endpoint:auth_mfa_status}': ['rate==0'],
    baseline_logins_total: ['count==5'],
    baseline_users_selected_total: ['count==5'],
    baseline_http_401_total: ['count==0'],
    baseline_http_403_total: ['count==0'],
    baseline_http_429_total: ['count==0'],
    baseline_http_5xx_total: ['count==0'],
  },
};

const json = (response) => { try { return response.json(); } catch { return null; } };
const url = (path) => `${BASE_URL}${path}`;
const isBad = (response) => response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500;
const userForVu = () => USERS[execution.vu.idInTest - 1];

function recordStatus(response) {
  if (response.status === 401) baseline401.add(1);
  if (response.status === 403) baseline403.add(1);
  if (response.status === 429) baseline429.add(1);
  if (response.status >= 500) baseline5xx.add(1);
}

function validateUser(user) {
  if (!user || typeof user !== 'object') fail('synthetic user entry is invalid');
  if (Object.keys(user).some((key) => !ALLOWED_KEYS.has(key))) fail('synthetic user contains a forbidden field');
  if (!/^loadtest-[a-z0-9-]+$/.test(String(user.alias || ''))) fail('synthetic alias is not loadtest-scoped');
  if (!/^\d{11}$/.test(String(user.login || ''))) fail('synthetic login format is invalid');
  if (!/^[0-9a-f-]{36}$/i.test(String(user.user_id || '')) || !/^[0-9a-f-]{36}$/i.test(String(user.company_id || ''))) fail('synthetic user or tenant id is invalid');
  if (!String(user.role || '').trim()) fail('synthetic role is missing');
  if (user.enabled !== true) fail('synthetic baseline user is disabled');
}

function resolveFingerprint(user) {
  return `grafana-baseline-${String(user.alias || user.user_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
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
  try {
    const [gateKey, password] = await Promise.all([secrets.get('loadtest-gate-key'), secrets.get('sgs-loadtest-password')]);
    if (!gateKey || !password) throw new Error('required secret is empty');
    return { gateKey: String(gateKey), password: String(password) };
  } catch {
    throw new Error('Missing Grafana secrets: loadtest-gate-key, sgs-loadtest-password');
  }
}

export async function setup() {
  if (__ENV.BASE_URL && __ENV.BASE_URL !== BASE_URL) fail('BASE_URL is fixed to the loadtest hostname');
  if (USERS.length < 5) fail('baseline requires at least five confirmed synthetic users');
  const seen = new Set();
  USERS.slice(0, 5).forEach((user) => { validateUser(user); for (const value of [user.login, user.user_id]) { if (seen.has(value)) fail('duplicate synthetic user across VUs'); seen.add(value); } });
  return { credentials: await readSecrets() };
}

function login(credentials, user) {
  if (loginCount >= 1) fail('per-VU login count exceeded');
  const fingerprint = resolveFingerprint(user);
  const csrf = http.get(url('/auth/csrf'), params(credentials.gateKey, 'csrf', [200], '', user.company_id, fingerprint));
  recordStatus(csrf);
  const csrfToken = String(json(csrf)?.csrfToken || '');
  check(csrf, { 'csrf is 200': (r) => r.status === 200, 'csrf token exists': () => Boolean(csrfToken) });
  if (isBad(csrf) || !csrfToken) fail(`csrf failed with ${csrf.status}`);
  const response = http.post(
    url('/auth/login'),
    JSON.stringify({ cpf: user.login, password: credentials.password }),
    params(credentials.gateKey, 'login', [200, 201], '', user.company_id, fingerprint, {
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      redirects: 0,
    }),
  );
  const token = String(json(response)?.accessToken || '');
  baselineLogins.add(1);
  recordStatus(response);
  loginCount += 1;
  check(response, { 'login is successful': (r) => r.status === 200 || r.status === 201, 'access token exists': () => Boolean(token) });
  if (isBad(response) || !token) fail(`login failed with ${response.status}`);
  session = { token, mfaChecked: false };
}

export default function baseline(data) {
  if (__VU < 1 || __VU > 5) fail('baseline requires exactly five VUs');
  const user = userForVu();
  validateUser(user);
  if (!session) baselineUsersSelected.add(1);
  if (!session) { sleep((execution.vu.idInTest - 1) * 5); login(data.credentials, user); }

  const fingerprint = resolveFingerprint(user);
  let me = http.get(url('/auth/me'), params(data.credentials.gateKey, 'auth_me', [200], session.token, user.company_id, fingerprint));
  recordStatus(me);
  if (me.status === 401) {
    fail('auth/me returned 401 unexpectedly; refusing to re-login during baseline');
  }
  const meUser = json(me)?.user || {};
  check(me, { 'auth/me is 200': (r) => r.status === 200, 'auth/me confirms synthetic user': () => meUser.id === user.user_id, 'auth/me confirms synthetic tenant': () => meUser.company_id === user.company_id });
  if (isBad(me)) fail(`auth/me returned ${me.status}`);

  if (!session.mfaChecked) {
    const mfa = http.get(url('/auth/mfa/status'), params(data.credentials.gateKey, 'auth_mfa_status', [200], session.token, user.company_id, fingerprint));
    recordStatus(mfa);
    const mfaBody = json(mfa) || {};
    check(mfa, { 'mfa status is 200': (r) => r.status === 200, 'mfa shape is read-only': () => typeof mfaBody.enabled === 'boolean' && typeof mfaBody.required === 'boolean' });
    if (isBad(mfa)) fail(`mfa status returned ${mfa.status}`);
    session.mfaChecked = true;
  }
  sleep(1);
}
