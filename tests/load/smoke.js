import http from 'k6/http';
import { check, fail } from 'k6';
import { assertSafeTarget, json, login, tenantHeaders, url } from './helpers/target-guard.js';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8088';
const MAX_VUS = Math.max(Number(__ENV.MAX_VUS || 5), 1);
const TEST_DURATION = __ENV.TEST_DURATION || '40s';

export const options = {
  scenarios: {
    smoke: {
      executor: 'shared-iterations',
      vus: MAX_VUS,
      iterations: MAX_VUS,
      maxDuration: TEST_DURATION,
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500'],
  },
};

export function setup() {
  assertSafeTarget(BASE_URL, { maxVus: 5, maxDurationSeconds: 60 });
  const health = http.get(url(BASE_URL, '/health/public'), { tags: { endpoint: 'health_public' } });
  if (!check(health, { 'public health is 200': (response) => response.status === 200 })) {
    fail(`load-test health preflight failed with HTTP ${health.status}`);
  }
  if (__ENV.TENANT_ID && !/^[0-9a-f-]{36}$/i.test(__ENV.TENANT_ID)) fail('TENANT_ID must be a UUID when provided.');
  return { baseUrl: BASE_URL };
}

export default function smoke(data) {
  const auth = login(data.baseUrl, { profile: 'smoke' });
  const loginBody = json(auth.response) || {};
  const loginOk = check(auth.response, {
    'login status is successful': (response) => response.status === 200 || response.status === 201,
    'login returned access token': () => Boolean(auth.token),
  });

  if (!loginOk || !auth.token) return;

  const me = http.get(url(data.baseUrl, '/auth/me'), {
    headers: { Authorization: `Bearer ${auth.token}`, ...tenantHeaders() },
    tags: { profile: 'smoke', endpoint: 'auth_me' },
  });
  check(me, {
    'auth/me is successful': (response) => response.status === 200,
    'auth/me returns a user': (response) => Boolean(json(response)?.user?.id || loginBody?.user?.id),
  });
}
