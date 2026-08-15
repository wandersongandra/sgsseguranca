import http from 'k6/http';
import { check, fail } from 'k6';
import secrets from 'k6/secrets';
import { SharedArray } from 'k6/data';

const BASE_URL = 'https://api-loadtest.sgsseguranca.com.br';
const TEST_RUN_ID = String(__ENV.TEST_RUN_ID || `sgs-smoke-${Date.now()}`);
const USERS = new SharedArray('synthetic-users', () => JSON.parse(open('./data/synthetic-users.json')));
const ALLOWED_KEYS = new Set(['alias', 'login', 'user_id', 'company_id', 'role']);

export const options = {
  scenarios: { smoke: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '60s' } },
  thresholds: {
    http_reqs: ['count>0'], iterations: ['count>0'], checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<1000'],
  },
};

const json = (response) => { try { return response.json(); } catch { return null; } };
const url = (path) => `${BASE_URL}${path}`;
const isBad = (response) => response.status === 429 || response.status >= 500;

function validateUser(user) {
  if (!user || typeof user !== 'object') fail('synthetic user entry is invalid');
  if (Object.keys(user).some((key) => !ALLOWED_KEYS.has(key))) fail('synthetic user contains a forbidden field');
  if (!/^loadtest-[a-z0-9-]+$/.test(String(user.alias || ''))) fail('synthetic alias is not loadtest-scoped');
  if (!/^\d{11}$/.test(String(user.login || ''))) fail('synthetic login format is invalid');
  if (!/^[0-9a-f-]{36}$/i.test(String(user.user_id || '')) || !/^[0-9a-f-]{36}$/i.test(String(user.company_id || ''))) fail('synthetic user or tenant id is invalid');
  if (!String(user.role || '').trim()) fail('synthetic role is missing');
}

function resolveFingerprint(user) {
  return `grafana-smoke-${String(user.alias || user.user_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
}

function requestOptions(gateKey, endpoint, statuses, token = '', companyId = '', fingerprint = '', extra = {}) {
  return {
    ...extra,
    headers: {
      Accept: 'application/json', 'X-Loadtest-Key': gateKey, 'X-Test-Run-ID': TEST_RUN_ID,
      ...(companyId ? { 'x-company-id': companyId } : {}),
      ...(fingerprint ? { 'x-client-fingerprint': fingerprint } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extra.headers || {}),
    },
    responseCallback: http.expectedStatuses(...statuses), tags: { endpoint, ...(extra.tags || {}) },
  };
}

async function readSecrets() {
  const envGateKey = String(__ENV.LOADTEST_PROXY_KEY || '').trim();
  const envPassword = String(__ENV.LOADTEST_ADMIN_PASSWORD || '').trim();
  try {
    const [gateKey, password] = await Promise.all([
      secrets.get('loadtest-gate-key'), secrets.get('sgs-loadtest-password'),
    ]);
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
  if (USERS.length < 1) fail('smoke requires at least one confirmed synthetic user');
  validateUser(USERS[0]);
  return { credentials: await readSecrets(), user: USERS[0] };
}

export default function smoke(data) {
  if (__VU !== 1) fail('smoke requires exactly one VU');
  const { gateKey, password } = data.credentials;
  const user = data.user;
  const fingerprint = resolveFingerprint(user);

  const health = http.get(url('/health/public'), {
    headers: { Accept: 'application/json', 'X-Test-Run-ID': TEST_RUN_ID },
    responseCallback: http.expectedStatuses(200), tags: { endpoint: 'health_public' },
  });
  check(health, { 'health public is 200': (r) => r.status === 200 });
  if (isBad(health)) fail(`health public returned ${health.status}`);

  const csrf = http.get(url('/auth/csrf'), requestOptions(gateKey, 'csrf', [200]));
  const csrfToken = String(json(csrf)?.csrfToken || '');
  check(csrf, { 'csrf is 200': (r) => r.status === 200, 'csrf token exists': () => Boolean(csrfToken) });
  if (isBad(csrf) || !csrfToken) fail(`csrf failed with ${csrf.status}`);

  const login = http.post(
    url('/auth/login'),
    JSON.stringify({ cpf: user.login, password }),
    requestOptions(gateKey, 'login', [200, 201], '', user.company_id, fingerprint, {
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      redirects: 0,
    }),
  );
  const loginBody = json(login) || {};
  const token = String(loginBody.accessToken || '');
  check(login, {
    'login is successful': (r) => r.status === 200 || r.status === 201,
    'access token exists': () => Boolean(token),
  });
  if (isBad(login) || !token) fail(`login failed with ${login.status}`);

  const me = http.get(url('/auth/me'), requestOptions(gateKey, 'auth_me', [200], token, user.company_id, fingerprint));
  const meUser = json(me)?.user || {};
  check(me, {
    'auth/me is 200': (r) => r.status === 200,
    'auth/me confirms synthetic user': () => meUser.id === user.user_id,
    'auth/me confirms synthetic tenant': () => meUser.company_id === user.company_id,
  });
  if (isBad(me)) fail(`auth/me returned ${me.status}`);

  const mfa = http.get(url('/auth/mfa/status'), requestOptions(gateKey, 'auth_mfa_status', [200], token, user.company_id, fingerprint));
  const mfaBody = json(mfa) || {};
  check(mfa, { 'mfa status is 200': (r) => r.status === 200, 'mfa shape is read-only': () => typeof mfaBody.enabled === 'boolean' && typeof mfaBody.required === 'boolean' });
  if (isBad(mfa)) fail(`mfa status returned ${mfa.status}`);
}
