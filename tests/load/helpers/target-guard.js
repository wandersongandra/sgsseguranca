import http from 'k6/http';
import { fail } from 'k6';

const PRODUCTION_MARKERS = [
  'api.sgsseguranca.com.br',
  'app.sgsseguranca.com.br',
  'neon.tech',
  'upstash.io',
  'backblaze',
];

function isPrivateIpv4(host) {
  const parts = String(host).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

export function assertSafeTarget(baseUrl, { maxVus = 5, maxDurationSeconds = 60 } = {}) {
  const parsed = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)(?:\/|$)/i.exec(String(baseUrl));
  if (!parsed) {
    fail('BASE_URL must be an absolute http(s) URL.');
  }
  const normalized = String(baseUrl).toLowerCase();
  if (PRODUCTION_MARKERS.some((marker) => normalized.includes(marker))) {
    fail('k6 refused: BASE_URL matches a production domain/provider marker.');
  }
  const protocol = `${parsed[1].toLowerCase()}:`;
  const host = parsed[2].replace(/:\d+$/, '').toLowerCase();
  const allowed = host === 'localhost' || host === '127.0.0.1' || host === 'api-loadtest.sgsseguranca.com.br' || isPrivateIpv4(host);
  if (!allowed) fail(`k6 refused: host ${host} is not in the load-test allowlist.`);
  if (protocol !== 'http:' && protocol !== 'https:') fail('BASE_URL must use http or https.');
  if (Number(__ENV.MAX_VUS || 1) > maxVus) fail(`MAX_VUS must be <= ${maxVus} for this profile.`);
  const duration = String(__ENV.TEST_DURATION || '40s');
  const seconds = duration.endsWith('s') ? Number(duration.slice(0, -1)) : duration.endsWith('m') ? Number(duration.slice(0, -1)) * 60 : NaN;
  if (!Number.isFinite(seconds) || seconds > maxDurationSeconds) fail(`TEST_DURATION must be <= ${maxDurationSeconds}s for this profile.`);
  return { protocol, hostname: host };
}

export function requiredCredentials() {
  if (!__ENV.TEST_USER || !__ENV.TEST_PASSWORD) fail('TEST_USER and TEST_PASSWORD are required and must stay outside Git.');
  return { cpf: String(__ENV.TEST_USER), password: String(__ENV.TEST_PASSWORD) };
}

export function tenantHeaders() {
  return __ENV.TENANT_ID ? { 'x-company-id': String(__ENV.TENANT_ID) } : {};
}

export function url(baseUrl, path) {
  return `${String(baseUrl).replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

export function json(response) {
  try { return response.json(); } catch { return null; }
}

export function login(baseUrl, tags = {}) {
  const credentials = requiredCredentials();
  const csrf = http.get(url(baseUrl, '/auth/csrf'), { tags: { ...tags, endpoint: 'csrf' } });
  const csrfBody = json(csrf) || {};
  const csrfToken = String(csrfBody.csrfToken || '');
  const response = http.post(url(baseUrl, '/auth/login'), JSON.stringify(credentials), {
    headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
    tags: { ...tags, endpoint: 'login' },
    redirects: 0,
  });
  const body = json(response) || {};
  return { response, token: String(body.accessToken || ''), csrfToken };
}
