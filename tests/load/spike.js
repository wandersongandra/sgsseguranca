import http from 'k6/http';
import { check } from 'k6';
import { assertSafeTarget, url } from './helpers/target-guard.js';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8088';
const MAX_VUS = Number(__ENV.MAX_VUS || 25);
const TEST_DURATION = __ENV.TEST_DURATION || '60s';

export const options = {
  stages: [{ duration: '5s', target: Math.min(MAX_VUS, 5) }, { duration: '5s', target: MAX_VUS }, { duration: TEST_DURATION, target: MAX_VUS }, { duration: '10s', target: 0 }],
  thresholds: {
    http_reqs: ['count>0'],
    iterations: ['count>0'],
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  assertSafeTarget(BASE_URL, { maxVus: 100, maxDurationSeconds: 360 });
  return { baseUrl: BASE_URL };
}

export default function spike(data) {
  const response = http.get(url(data.baseUrl, '/health/public'), { tags: { profile: 'spike', endpoint: 'health_public' } });
  check(response, { 'health is 200': (res) => res.status === 200 });
}
