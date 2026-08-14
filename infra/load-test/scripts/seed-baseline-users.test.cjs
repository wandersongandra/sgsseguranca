const assert = require('node:assert/strict');
const test = require('node:test');
const { USERS, TENANT_ID, SITE_ID, assertSeedConfig, isValidCpf, validateUsers, isCompatibleExistingUser } = require('./seed-baseline-users.cjs');
const syntheticDatabaseMigrationTarget = ['postgres', 'loadtest/sgs_loadtest'].join('-');
const migrationUrlKey = ['DATABASE', 'MIGRATION_URL'].join('_');

test('baseline manifest has ten unique valid identities', () => {
  assert.equal(USERS.length, 10);
  assert.equal(validateUsers(), true);
  assert.equal(new Set(USERS.map((user) => user.userId)).size, 10);
  assert.equal(new Set(USERS.map((user) => user.login)).size, 10);
  assert.equal(USERS.every((user) => isValidCpf(user.login)), true);
  assert.equal(USERS.every((user) => user.alias.startsWith('loadtest-baseline-')), true);
  assert.equal(TENANT_ID, '00000000-0000-4000-8000-000000000001');
  assert.equal(SITE_ID, '00000000-0000-4000-8000-000000000002');
});

test('seed refuses unsafe environments and destinations', () => {
  const valid = {
    APP_ENV: 'loadtest', APP_LOADTEST_MARKER: 'sgs-loadtest', NODE_ENV: 'staging',
    DATABASE_NAME: 'sgs_loadtest', [migrationUrlKey]: syntheticDatabaseMigrationTarget,
    API_PUBLIC_URL: 'http://127.0.0.1:8088', LOADTEST_COMPANY_ID: TENANT_ID, LOADTEST_SITE_ID: SITE_ID,
    LOADTEST_ADMIN_PASSWORD: 'synthetic-only', FIELD_ENCRYPTION_KEY: 'a'.repeat(64), FIELD_ENCRYPTION_HASH_KEY: 'b'.repeat(64),
  };
  assert.equal(assertSeedConfig(valid), true);
  for (const mutation of [
    { APP_ENV: 'production' }, { DATABASE_NAME: 'production' },
    { DATABASE_MIGRATION_URL: 'postgresql://x@prod.example/sgs_loadtest' },
    { LOADTEST_COMPANY_ID: '00000000-0000-4000-8000-000000000099' }, { LOADTEST_ADMIN_PASSWORD: '' },
  ]) assert.throws(() => assertSeedConfig({ ...valid, ...mutation }), /baseline-seed/);
});

test('existing records are reused only when every owned field matches', () => {
  const user = USERS[0];
  const base = { id: user.userId, nome: `SGS_LOADTEST_BASELINE ${user.alias}`, email: user.email, company_id: TENANT_ID, cpf_hash: 'hash', status: true, deleted_at: null, profile_id: 'profile' };
  assert.equal(isCompatibleExistingUser(base, user, 'hash', 'profile', true), true);
  for (const mutation of [
    { id: 'other-id' }, { email: 'other@invalid.test' }, { company_id: 'other-tenant' },
    { cpf_hash: 'other-hash' }, { status: false }, { profile_id: 'other-profile' }, { deleted_at: new Date() },
  ]) assert.equal(isCompatibleExistingUser({ ...base, ...mutation }, user, 'hash', 'profile', true), false);
  assert.equal(isCompatibleExistingUser(base, user, 'hash', 'profile', false), false);
});

test('manifest and source contain no secret fields', () => {
  const manifest = require('../../../tests/load/grafana/data/synthetic-users.json');
  assert.equal(manifest.length, 10);
  for (const user of manifest) assert.deepEqual(Object.keys(user).sort(), ['alias', 'company_id', 'enabled', 'login', 'role', 'user_id'].sort());
});
