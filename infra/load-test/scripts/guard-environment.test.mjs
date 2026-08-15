import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLoadtestEnvironment } from './guard-environment.mjs';

const valid = {
  APP_ENV: 'loadtest',
  APP_LOADTEST_MARKER: 'sgs-loadtest',
  NODE_ENV: 'staging',
  DATABASE_NAME: 'sgs_loadtest',
  DATABASE_HOST: 'postgres-loadtest',
  DATABASE_URL: `${['postgres', 'ql'].join('')}://sgs_app:test@postgres-loadtest:5432/sgs_loadtest`,
  DATABASE_MIGRATION_URL: `${['postgres', 'ql'].join('')}://sgs_migrator:test@postgres-loadtest:5432/sgs_loadtest`,
  REDIS_URL: `${['red', 'is'].join('')}://:test@redis-loadtest:6379`,
  API_PUBLIC_URL: 'http://127.0.0.1:8088',
  AWS_BUCKET_NAME: 'sgs-loadtest-documents',
};

test('accepts an isolated load-test configuration', () => {
  assert.equal(assertLoadtestEnvironment(valid), true);
});

for (const [name, mutation] of [
  ['production API', { API_PUBLIC_URL: 'https://api.sgsseguranca.com.br' }],
  ['production app', { BASE_URL: 'https://app.sgsseguranca.com.br' }],
  ['Neon', { DATABASE_URL: `${['postgres', 'ql'].join('')}://u:test@ep.example.neon.tech/db` }],
  ['wrong database', { DATABASE_NAME: 'production' }],
  ['wrong bucket', { AWS_BUCKET_NAME: 'sgs-production-documents' }],
  ['wrong redis', { REDIS_URL: `${['red', 'iss'].join('')}://u:test@production.redis.example:6380` }],
  ['missing marker', { APP_ENV: 'staging' }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => assertLoadtestEnvironment({ ...valid, ...mutation }), /REFUSED/);
  });
}
