const { randomBytes, createCipheriv, createHmac } = require('node:crypto');
const { Client } = require('/app/node_modules/pg');
const argon2 = require('/app/node_modules/argon2');

const MARKER = 'SGS_LOADTEST_SYNTHETIC';
const CPF = String(process.env.LOADTEST_ADMIN_CPF || '').replace(/\D/g, '');
const PASSWORD = String(process.env.LOADTEST_ADMIN_PASSWORD || '');

function fail(message) {
  throw new Error(`[loadtest-seed] ${message}`);
}

function keyFromHex(value, name) {
  if (!/^[a-f0-9]{64}$/i.test(value || '')) fail(`${name} must be 32 bytes as 64 hex chars`);
  return Buffer.from(value, 'hex');
}

function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${data.toString('base64url')}`;
}

function assertConfig() {
  if (process.env.APP_ENV !== 'loadtest' || process.env.APP_LOADTEST_MARKER !== 'sgs-loadtest') {
    fail('load-test marker is missing');
  }
  if (process.env.DATABASE_NAME !== 'sgs_loadtest') fail('database name is not sgs_loadtest');
  if (CPF.length !== 11 || !PASSWORD) fail('synthetic admin credentials are missing');
  if (!/^[a-f0-9]{64}$/i.test(process.env.FIELD_ENCRYPTION_KEY || '')) fail('field encryption key is missing');
  if (!/^[a-f0-9]{64}$/i.test(process.env.FIELD_ENCRYPTION_HASH_KEY || '')) fail('field encryption hash key is missing');
}

async function main() {
  assertConfig();
  const client = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  const fieldKey = keyFromHex(process.env.FIELD_ENCRYPTION_KEY, 'FIELD_ENCRYPTION_KEY');
  const hashKey = process.env.FIELD_ENCRYPTION_HASH_KEY;
  const cpfHash = createHmac('sha256', hashKey).update(CPF).digest('hex');
  const cpfCiphertext = encrypt(CPF, fieldKey);
  const passwordHash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const companyId = process.env.LOADTEST_COMPANY_ID;
  const siteId = process.env.LOADTEST_SITE_ID;
  const userId = process.env.LOADTEST_USER_ID;

  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO profiles (nome, permissoes, status)
       VALUES ('Administrador da Empresa', '{}'::jsonb, true)
       ON CONFLICT DO NOTHING`,
    );
    const profile = await client.query(
      `SELECT id FROM profiles WHERE nome = 'Administrador da Empresa' ORDER BY id LIMIT 1`,
    );
    if (!profile.rows[0]) fail('required profile could not be created');

    await client.query(
      `INSERT INTO companies (id, razao_social, cnpj, endereco, responsavel, status)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (id) DO UPDATE SET razao_social = EXCLUDED.razao_social, updated_at = NOW()`,
      [companyId, `${MARKER} Empresa`, '99000000000100', 'Ambiente isolado', 'Seed sintético'],
    );
    await client.query(
      `INSERT INTO sites (id, nome, local, company_id, status)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (id) DO UPDATE SET company_id = EXCLUDED.company_id, updated_at = NOW()`,
      [siteId, `${MARKER} Site`, 'VPS load-test', companyId],
    );
    await client.query(
      `INSERT INTO users
       (id, nome, cpf, cpf_hash, cpf_ciphertext, email, funcao, password, status,
        company_id, site_id, profile_id, module_access_keys, identity_type, access_status,
        ai_processing_consent, must_change_password)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, true, $8, $9, $10, '[]'::jsonb,
               'system_user', 'credentialed', false, false)
       ON CONFLICT (id) DO UPDATE SET
         cpf = NULL, cpf_hash = EXCLUDED.cpf_hash, cpf_ciphertext = EXCLUDED.cpf_ciphertext,
         password = EXCLUDED.password, company_id = EXCLUDED.company_id,
         site_id = EXCLUDED.site_id, profile_id = EXCLUDED.profile_id,
         status = true, access_status = 'credentialed', deleted_at = NULL, updated_at = NOW()`,
      [
        userId,
        `${MARKER} Admin`,
        cpfHash,
        cpfCiphertext,
        'loadtest.admin@invalid.test',
        'Administrador de teste',
        passwordHash,
        companyId,
        siteId,
        profile.rows[0].id,
      ],
    );
    await client.query('COMMIT');
    console.log(`[loadtest-seed] OK: synthetic tenant ${companyId} ready; credentials were not printed`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
