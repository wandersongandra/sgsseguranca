import http from 'k6/http';
import { check, fail } from 'k6';
import secrets from 'k6/secrets';

const BASE_URL = 'https://api-loadtest.sgsseguranca.com.br';
const TEST_RUN_ID = String(__ENV.TEST_RUN_ID || `sgs-smoke-${Date.now()}`);
const SYNTHETIC_USER_ID = '00000000-0000-4000-8000-000000000003';
const SYNTHETIC_TENANT_ID = '00000000-0000-4000-8000-000000000001';

export const options = {
  scenarios: {
    smoke: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '60s',
    },
  },
  thresholds: {
    http_reqs: ['count>0'],
    iterations: ['count==1'],
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<1000'],
    'http_reqs{endpoint:login}': ['count==1'],
    'http_req_failed{endpoint:login}': ['rate==0'],
    'http_req_duration{endpoint:login}': ['p(95)<1500'],
    'http_req_duration{endpoint:auth_me}': ['p(95)<1000'],
  },
};

function json(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function url(path) {
  return `${BASE_URL}${path}`;
}

function requestOptions(gateKey, endpoint, expectedStatuses, extra = {}) {
  return {
    ...extra,
    headers: {
      Accept: 'application/json',
      'X-Loadtest-Key': gateKey,
      'X-Test-Run-ID': TEST_RUN_ID,
      ...(extra.headers || {}),
    },
    responseCallback: http.expectedStatuses(...expectedStatuses),
    tags: { endpoint },
  };
}

function publicRequestOptions(endpoint, expectedStatuses, extra = {}) {
  return {
    ...extra,
    headers: {
      Accept: 'application/json',
      'X-Test-Run-ID': TEST_RUN_ID,
      ...(extra.headers || {}),
    },
    responseCallback: http.expectedStatuses(...expectedStatuses),
    tags: { endpoint },
  };
}

async function readSecrets() {
  try {
    const [gateKey, login, password] = await Promise.all([
      secrets.get('loadtest-gate-key'),
      secrets.get('sgs-loadtest-login'),
      secrets.get('sgs-loadtest-password'),
    ]);

    if (!gateKey || !login || !password) {
      throw new Error('required Grafana Cloud secret is empty');
    }

    return {
      gateKey: String(gateKey),
      login: String(login),
      password: String(password),
    };
  } catch {
    throw new Error(
      'Missing Grafana Cloud secrets: loadtest-gate-key, sgs-loadtest-login, sgs-loadtest-password',
    );
  }
}

export default async function smoke() {
  const { gateKey, login, password } = await readSecrets();

  const health = http.get(
    url('/health/public'),
    publicRequestOptions('health_public', [200]),
  );
  if (
    !check(health, {
      'health public is 200': (response) => response.status === 200,
    })
  ) {
    fail(`health public returned HTTP ${health.status}`);
  }

  const csrf = http.get(
    url('/auth/csrf'),
    requestOptions(gateKey, 'csrf', [200]),
  );
  const csrfBody = json(csrf) || {};
  const csrfToken = String(csrfBody.csrfToken || '');
  if (
    !check(csrf, {
      'csrf is 200': (response) => response.status === 200,
      'csrf token exists': () => Boolean(csrfToken),
    })
  ) {
    fail(`csrf failed with HTTP ${csrf.status}`);
  }

  // k6 mantém automaticamente os cookies por VU entre esta requisição e o login.
  const loginResponse = http.post(
    url('/auth/login'),
    JSON.stringify({ cpf: login, password }),
    requestOptions(gateKey, 'login', [200, 201], {
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      redirects: 0,
    }),
  );
  const loginBody = json(loginResponse) || {};
  const accessToken = String(loginBody.accessToken || '');
  if (
    !check(loginResponse, {
      'login is successful': (response) =>
        response.status === 200 || response.status === 201,
      'login access token exists': () => Boolean(accessToken),
    })
  ) {
    fail(`login failed with HTTP ${loginResponse.status}`);
  }

  const authMe = http.get(
    url('/auth/me'),
    requestOptions(gateKey, 'auth_me', [200], {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  );
  const authMeUser = json(authMe)?.user || {};
  if (
    !check(authMe, {
      'auth/me is 200': (response) => response.status === 200,
      'auth/me confirms synthetic user': () =>
        authMeUser.id === SYNTHETIC_USER_ID,
      'auth/me confirms synthetic tenant': () =>
        authMeUser.company_id === SYNTHETIC_TENANT_ID,
    })
  ) {
    fail(`auth/me validation failed with HTTP ${authMe.status}`);
  }

  const mfaStatus = http.get(
    url('/auth/mfa/status'),
    requestOptions(gateKey, 'auth_mfa_status', [200], {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  );
  const mfaBody = json(mfaStatus) || {};
  if (
    !check(mfaStatus, {
      'mfa status is 200': (response) => response.status === 200,
      'mfa status is read-only shape': () =>
        typeof mfaBody.enabled === 'boolean' &&
        typeof mfaBody.required === 'boolean',
    })
  ) {
    fail(`mfa status failed with HTTP ${mfaStatus.status}`);
  }
}
