const { Client } = require('/app/node_modules/pg');
const { randomUUID } = require('node:crypto');

const appDatabaseUrl = process.env.DATABASE_URL;
const apiUrl = process.env.LOADTEST_API_URL || 'http://api-loadtest:3001';
const tenantA = process.env.LOADTEST_COMPANY_ID;
const tenantB = '00000000-0000-4000-8000-000000000011';
const cpf = process.env.LOADTEST_ADMIN_CPF;
const password = process.env.LOADTEST_ADMIN_PASSWORD;

if (
  process.env.APP_ENV !== 'loadtest' ||
  process.env.APP_LOADTEST_MARKER !== 'sgs-loadtest' ||
  !appDatabaseUrl?.includes('/sgs_loadtest') ||
  !tenantA ||
  !cpf ||
  !password
) {
  throw new Error('forensic proof guard rejected the environment');
}

const client = new Client({ connectionString: appDatabaseUrl });
const proofKey = `${tenantA}:security:proof-${randomUUID()}`;

async function withTenant(tenantId, callback) {
  await client.query('BEGIN');
  await client.query(
    `SELECT
       set_config('app.current_company', $1, true),
       set_config('app.current_company_id', $1, true),
       set_config('app.is_super_admin', 'false', true)`,
    [tenantId],
  );
  try {
    const result = await callback();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function expectRejected(label, callback) {
  try {
    await callback();
  } catch (error) {
    if (/row-level security|violates row-level security/i.test(String(error.message))) {
      console.log(`[forensic-proof] PASS ${label}`);
      return;
    }
    throw error;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function login() {
  const csrfResponse = await fetch(`${apiUrl}/auth/csrf`);
  const csrfBody = await csrfResponse.json();
  const setCookies =
    typeof csrfResponse.headers.getSetCookie === 'function'
      ? csrfResponse.headers.getSetCookie()
      : [csrfResponse.headers.get('set-cookie') || ''];
  const cookie =
    setCookies
      .filter((value) => /^csrf-token=.+/.test(value))
      .at(-1)
      ?.split(';', 1)[0] || '';
  const response = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      'x-csrf-token': csrfBody.csrfToken,
    },
    body: JSON.stringify({ cpf, password }),
  });
  if (!response.ok) throw new Error(`login returned HTTP ${response.status}`);
}

async function main() {
  await client.connect();
  const identity = await client.query(
    `SELECT current_user, rolbypassrls
       FROM pg_roles
      WHERE rolname = current_user`,
  );
  if (identity.rows[0]?.current_user !== 'sgs_app') {
    throw new Error(`unexpected application role: ${identity.rows[0]?.current_user}`);
  }
  if (identity.rows[0]?.rolbypassrls !== false) {
    throw new Error('sgs_app has BYPASSRLS');
  }
  console.log('[forensic-proof] PASS role=sgs_app bypassrls=false');

  await withTenant(tenantA, async () => {
    const context = await client.query(
      `SELECT current_user,
              current_setting('app.current_company_id', true) AS company_id,
              current_setting('app.is_super_admin', true) AS is_super_admin`,
    );
    console.log(
      `[forensic-proof] INSERT_CONTEXT role=${context.rows[0].current_user} company=${context.rows[0].company_id} super_admin=${context.rows[0].is_super_admin}`,
    );
    await client.query(
      `INSERT INTO forensic_trail_events
        (stream_key, stream_sequence, event_type, module, entity_id,
         company_id, event_hash, occurred_at)
       VALUES ($1::text, 1, 'PROOF_INSERT', 'security', 'proof-a', $2::uuid, md5($1::text), now())`,
      [proofKey, tenantA],
    );
    const result = await client.query(
      `SELECT count(*)::int AS count
         FROM forensic_trail_events
         WHERE company_id = $1 AND event_type = 'PROOF_INSERT' AND stream_key = $2`,
      [tenantA, proofKey],
    );
    if (result.rows[0].count !== 1) throw new Error('tenant A cannot read its event');
    console.log('[forensic-proof] PASS tenant A insert/select');
  });

  await withTenant(tenantB, async () => {
    const result = await client.query(
      `SELECT count(*)::int AS count
         FROM forensic_trail_events
         WHERE company_id = $1 AND event_type = 'PROOF_INSERT' AND stream_key = $2`,
      [tenantA, proofKey],
    );
    if (result.rows[0].count !== 0) throw new Error('tenant B saw tenant A event');
    console.log('[forensic-proof] PASS tenant B cannot select tenant A');
  });

  await expectRejected('missing tenant context rejects insert', async () => {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_company', '', true),
              set_config('app.current_company_id', '', true),
              set_config('app.is_super_admin', 'false', true)`,
    );
    await client.query(
      `INSERT INTO forensic_trail_events
        (stream_key, stream_sequence, event_type, module, entity_id,
         company_id, event_hash, occurred_at)
       VALUES ('missing-context', 1, 'PROOF_DENY', 'security', 'proof-none', $1, md5(random()::text), now())`,
      [tenantA],
    );
  });
  await client.query('ROLLBACK');

  await login();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await withTenant(tenantA, () =>
      client.query(
        `SELECT count(*)::int AS count
           FROM forensic_trail_events
          WHERE company_id = $1 AND event_type = 'LOGIN_SUCCESS' AND user_id = $2`,
        [tenantA, process.env.LOADTEST_USER_ID],
      ),
    );
    if (result.rows[0].count > 0) {
      console.log('[forensic-proof] PASS login persists LOGIN_SUCCESS');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('login did not persist LOGIN_SUCCESS');
}

main()
  .catch((error) => {
    console.error(`[forensic-proof] FAIL ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => client.end());
