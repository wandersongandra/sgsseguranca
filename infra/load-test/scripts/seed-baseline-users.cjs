const { createCipheriv, createHmac, randomBytes } = require('node:crypto');

const MARKER = 'SGS_LOADTEST_BASELINE';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SITE_ID = '00000000-0000-4000-8000-000000000002';
const USERS = [
  { alias: 'loadtest-baseline-001', login: '80000000167', userId: 'f84d7cd4-6fee-470c-9bc7-f882eb37d6f5', email: 'loadtest-baseline-001@invalid.test', role: 'Administrador da Empresa' },
  { alias: 'loadtest-baseline-002', login: '80000000248', userId: 'b07281e6-aba0-4ae0-8da2-1d6f3ab2c377', email: 'loadtest-baseline-002@invalid.test', role: 'Administrador da Empresa' },
  { alias: 'loadtest-baseline-003', login: '80000000329', userId: 'ae66c722-2d6c-448f-a975-f3b38408c9e7', email: 'loadtest-baseline-003@invalid.test', role: 'Técnico de Segurança do Trabalho (TST)' },
  { alias: 'loadtest-baseline-004', login: '80000000400', userId: '2b4ccba6-028c-4ab7-9cf5-e32590ef7473', email: 'loadtest-baseline-004@invalid.test', role: 'Supervisor / Encarregado' },
  { alias: 'loadtest-baseline-005', login: '80000000590', userId: 'c9011a2c-58f6-43e6-acce-059fca3b4956', email: 'loadtest-baseline-005@invalid.test', role: 'Operador / Colaborador' },
  { alias: 'loadtest-baseline-006', login: '80000000671', userId: 'd9b3a1e7-2c48-4f91-9a63-0e7d5c1b2406', email: 'loadtest-baseline-006@invalid.test', role: 'Operador / Colaborador' },
  { alias: 'loadtest-baseline-007', login: '80000000752', userId: 'e4c7b2f8-3d59-4a02-8b74-1f8e6d2c3517', email: 'loadtest-baseline-007@invalid.test', role: 'Operador / Colaborador' },
  { alias: 'loadtest-baseline-008', login: '80000000833', userId: 'f5d8c309-4e6a-4b13-9c85-2a9f7e3d4628', email: 'loadtest-baseline-008@invalid.test', role: 'Operador / Colaborador' },
  { alias: 'loadtest-baseline-009', login: '80000000914', userId: 'a6e9d41a-5f7b-4c24-8d96-3b0a8f4e5739', email: 'loadtest-baseline-009@invalid.test', role: 'Operador / Colaborador' },
  { alias: 'loadtest-baseline-010', login: '80000001058', userId: 'b7fae52b-608c-4d35-9ea7-4c1b9f5a6840', email: 'loadtest-baseline-010@invalid.test', role: 'Operador / Colaborador' },
];

function fail(message) {
  throw new Error(`[baseline-seed] ${message}`);
}

function assertSeedConfig(env = process.env) {
  if (env.APP_ENV !== 'loadtest' || env.APP_LOADTEST_MARKER !== 'sgs-loadtest') fail('loadtest marker missing');
  if (env.NODE_ENV === 'production' || env.DATABASE_NAME !== 'sgs_loadtest') fail('unsafe runtime');
  if (!String(env.DATABASE_MIGRATION_URL || '').includes('/sgs_loadtest')) fail('migration database is not sgs_loadtest');
  if (String(env.API_PUBLIC_URL || '').includes('sgsseguranca.com.br')) fail('public URL is not private loadtest');
  if (env.LOADTEST_COMPANY_ID !== TENANT_ID || env.LOADTEST_SITE_ID !== SITE_ID) fail('destination tenant/site is not synthetic');
  if (!env.LOADTEST_ADMIN_PASSWORD) fail('synthetic password is missing');
  if (!/^[a-f0-9]{64}$/i.test(env.FIELD_ENCRYPTION_KEY || '')) fail('field encryption key is missing');
  if (!/^[a-f0-9]{64}$/i.test(env.FIELD_ENCRYPTION_HASH_KEY || '')) fail('field hash key is missing');
  if (!String(env.DATABASE_MIGRATION_URL).includes('postgres-loadtest')) fail('migration host is not loadtest');
  return true;
}

function normalizeCpf(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidCpf(value) {
  const cpf = normalizeCpf(value);
  if (!/^\d{11}$/.test(cpf) || /^([0-9])\1{10}$/.test(cpf)) return false;
  const digit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(cpf[index]) * (length + 1 - index);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

function validateUsers(users = USERS) {
  if (users.length !== 10) fail('exactly ten users are required');
  const ids = new Set(); const logins = new Set(); const emails = new Set();
  for (const user of users) {
    if (!/^loadtest-baseline-(00[1-9]|010)$/.test(user.alias)) fail('invalid baseline alias');
    if (!/^[0-9a-f-]{36}$/i.test(user.userId) || !isValidCpf(user.login)) fail('invalid synthetic identity');
    if (!/^loadtest-baseline-(00[1-9]|010)@invalid\.test$/.test(user.email)) fail('invalid synthetic email');
    if (ids.has(user.userId) || logins.has(user.login) || emails.has(user.email)) fail('duplicate synthetic identity');
    ids.add(user.userId); logins.add(user.login); emails.add(user.email);
  }
  return true;
}

function isCompatibleExistingUser(row, user, cpfHash, profileId, passwordMatches) {
  return row.id === user.userId && row.nome === `${MARKER} ${user.alias}` && row.email === user.email &&
    row.company_id === TENANT_ID && row.cpf_hash === cpfHash && row.status === true &&
    row.deleted_at === null && row.profile_id === profileId && passwordMatches === true;
}

function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${data.toString('base64url')}`;
}

async function main() {
  assertSeedConfig(); validateUsers();
  const { Client } = require('/app/node_modules/pg');
  const argon2 = require('/app/node_modules/argon2');
  const client = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  const fieldKey = Buffer.from(process.env.FIELD_ENCRYPTION_KEY, 'hex');
  const hashKey = process.env.FIELD_ENCRYPTION_HASH_KEY;
  const password = process.env.LOADTEST_ADMIN_PASSWORD;
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  await client.connect();
  try {
    await client.query('BEGIN');
    const company = await client.query('SELECT id, status FROM companies WHERE id = $1', [TENANT_ID]);
    const site = await client.query('SELECT id, status, company_id FROM sites WHERE id = $1', [SITE_ID]);
    if (company.rowCount !== 1 || company.rows[0].status !== true) fail('synthetic company missing or inactive');
    if (site.rowCount !== 1 || site.rows[0].status !== true || site.rows[0].company_id !== TENANT_ID) fail('synthetic site missing or incompatible');
    const profiles = new Map();
    for (const role of new Set(USERS.map((user) => user.role))) {
      const result = await client.query('SELECT id, status FROM profiles WHERE nome = $1 ORDER BY id LIMIT 1', [role]);
      if (result.rowCount !== 1 || result.rows[0].status !== true) fail(`required profile unavailable: ${role}`);
      profiles.set(role, result.rows[0]);
    }
    let created = 0; let existing = 0;
    for (const user of USERS) {
      const cpf = normalizeCpf(user.login);
      const cpfHash = createHmac('sha256', hashKey).update(cpf).digest('hex');
      const byId = await client.query('SELECT id, nome, company_id, cpf_hash, password, email, status, profile_id, deleted_at FROM users WHERE id = $1', [user.userId]);
      const conflicts = await client.query(`select
        exists(select 1 from users where cpf_hash=$1 and deleted_at is null and id<>$2) cpf_conflict,
        exists(select 1 from users where lower(trim(email))=lower(trim($3)) and deleted_at is null and id<>$2) email_conflict`, [cpfHash, user.userId, user.email]);
      if (conflicts.rows[0].cpf_conflict || conflicts.rows[0].email_conflict) fail(`SEED_CONFLICT identity ${user.alias}`);
      const profile = profiles.get(user.role);
      if (byId.rowCount === 1) {
        const row = byId.rows[0];
        let passwordMatches = false;
        try { passwordMatches = Boolean(row.password && await argon2.verify(row.password, password)); } catch {}
        if (!isCompatibleExistingUser(row, user, cpfHash, profile.id, passwordMatches)) fail(`SEED_CONFLICT incompatible ${user.alias}`);
        existing += 1; continue;
      }
      await client.query(`INSERT INTO users
        (id, nome, cpf, cpf_hash, cpf_ciphertext, email, funcao, password, status,
         company_id, site_id, profile_id, module_access_keys, identity_type, access_status,
         ai_processing_consent, must_change_password)
        VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, true, $8, $9, $10, '[]'::jsonb,
                'system_user', 'credentialed', false, false)`,
      [user.userId, `${MARKER} ${user.alias}`, cpfHash, encrypt(cpf, fieldKey), user.email, user.role, passwordHash, TENANT_ID, SITE_ID, profile.id]);
      created += 1;
    }
    await client.query('COMMIT');
    console.log(`[baseline-seed] OK created=${created} existing=${existing} password_source=ENV hash_generated=true field_hash_key_match=true cpf_lookup_match=true`);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.end(); }
}

module.exports = { USERS, TENANT_ID, SITE_ID, assertSeedConfig, isValidCpf, validateUsers, isCompatibleExistingUser };
if (require.main === module) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
