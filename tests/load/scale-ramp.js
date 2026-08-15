import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { assertSafeTarget, url } from './helpers/target-guard.js';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8088';
const TARGET_VUS = Number(__ENV.TARGET_VUS || 100);
const HOLD_DURATION = String(__ENV.HOLD_DURATION || '60s');
const RAMP_UP = String(__ENV.RAMP_UP || '30s');
const RAMP_DOWN = String(__ENV.RAMP_DOWN || '30s');
const ITERATION_SLEEP = Number(__ENV.ITERATION_SLEEP || 1);
const HIGH_SCALE_CONFIRMATION = 'SGS_LOADTEST_ONLY';
const statusCounts = new Counter('http_status_count');
const status429 = new Rate('http_status_429');
const status5xx = new Rate('http_status_5xx');
const transportFailures = new Rate('transport_failure');

export const options = {
  stages: [
    { duration: RAMP_UP, target: TARGET_VUS },
    { duration: HOLD_DURATION, target: TARGET_VUS },
    { duration: RAMP_DOWN, target: 0 },
  ],
  thresholds: {
    http_reqs: [{ threshold: 'count>0', abortOnFail: true, delayAbortEval: '5s' }],
    iterations: [{ threshold: 'count>0', abortOnFail: true, delayAbortEval: '5s' }],
    checks: [{ threshold: 'rate>0.99', abortOnFail: true, delayAbortEval: '15s' }],
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '15s' }],
    http_status_429: [{ threshold: 'rate==0', abortOnFail: true, delayAbortEval: '5s' }],
    http_status_5xx: [{ threshold: 'rate==0', abortOnFail: true, delayAbortEval: '5s' }],
    transport_failure: [{ threshold: 'rate==0', abortOnFail: true, delayAbortEval: '5s' }],
  },
};

function parseSeconds(value) {
  const raw = String(value).trim();
  if (/^\d+(\.\d+)?s$/.test(raw)) return Number(raw.slice(0, -1));
  if (/^\d+(\.\d+)?m$/.test(raw)) return Number(raw.slice(0, -1)) * 60;
  return NaN;
}

export function setup() {
  assertSafeTarget(BASE_URL, { maxVus: 10000, maxDurationSeconds: 1800 });

  if (!Number.isInteger(TARGET_VUS) || TARGET_VUS < 1 || TARGET_VUS > 10000) {
    fail('TARGET_VUS must be an integer between 1 and 10000.');
  }
  if (!Number.isFinite(ITERATION_SLEEP) || ITERATION_SLEEP < 0.1) {
    fail('ITERATION_SLEEP must be at least 0.1 seconds.');
  }
  const totalSeconds = parseSeconds(RAMP_UP) + parseSeconds(HOLD_DURATION) + parseSeconds(RAMP_DOWN);
  if (!Number.isFinite(totalSeconds) || totalSeconds > 1800) {
    fail('RAMP_UP, HOLD_DURATION and RAMP_DOWN must use seconds/minutes and total at most 1800 seconds.');
  }
  if (TARGET_VUS > 100 && __ENV.LOADTEST_CONFIRM !== HIGH_SCALE_CONFIRMATION) {
    fail(`TARGET_VUS above 100 requires LOADTEST_CONFIRM=${HIGH_SCALE_CONFIRMATION}.`);
  }

  return { baseUrl: BASE_URL };
}

export default function scaleRamp(data) {
  const response = http.get(url(data.baseUrl, '/health/public'), {
    tags: { profile: 'scale-ramp', endpoint: 'health_public' },
  });
  statusCounts.add(1, { status: String(response.status) });
  status429.add(response.status === 429);
  status5xx.add(response.status >= 500 && response.status <= 599);
  transportFailures.add(response.status === 0);
  check(response, {
    'health public is 200': (res) => res.status === 200,
  });
  sleep(ITERATION_SLEEP);
}
