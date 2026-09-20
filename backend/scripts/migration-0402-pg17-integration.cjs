const { Client } = require('pg');

const {
  AddSignatureKeyVersioning1709000000402,
} = require('../dist/infra/database/migrations/1709000000402-add-signature-key-versioning');

const BASE_URL_ENV = 'PG17_MIGRATION_0402_TEST_URL';
const EXECUTOR_ROLE = 'migration_0402_executor';
const FUNCTION_OWNER = 'sgs_function_owner';
const APP_ROLE = 'sgs_app';
const ADMIN_ROLE = 'sgs_admin';
const TEST_PASSWORD = 'migration-0402-pg17-test-only';
const DATABASE = 'migration_0402_pg17';
const HASH = 'a'.repeat(64);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function booleanValue(value) {
  return value === true || value === 't' || value === 'true';
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function makeConnectionUrl(baseUrl, database, credentials) {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  if (credentials) {
    url.username = credentials.username;
    url.password = credentials.password;
  }
  return url.toString();
}

function createClient(connectionString) {
  const client = new Client({ connectionString, ssl: false });
  client.on('error', () => {});
  return client;
}

function migrationRunner(client) {
  return {
    query: async (sql, parameters) => {
      const result = await client.query(sql, parameters);
      return result.rows;
    },
  };
}

async function queryRows(client, sql, parameters) {
  return (await client.query(sql, parameters)).rows;
}

async function cleanup(baseUrl) {
  const admin = createClient(baseUrl);
  await admin.connect();
  try {
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(DATABASE)} WITH (FORCE)`,
    );
    for (const role of [APP_ROLE, ADMIN_ROLE, FUNCTION_OWNER, EXECUTOR_ROLE]) {
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
    }
  } finally {
    await admin.end();
  }
}

async function assertLegacyOwnerTransferFails(executor) {
  await executor.query(`
    GRANT CREATE ON SCHEMA public TO ${FUNCTION_OWNER};
    CREATE FUNCTION public.pg17_0402_owner_transfer_probe()
    RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
  `);

  await executor.query('BEGIN');
  await executor.query('SAVEPOINT before_owner_transfer');
  let failedAsExpected = false;
  try {
    await executor.query(
      `ALTER FUNCTION public.pg17_0402_owner_transfer_probe() OWNER TO ${FUNCTION_OWNER}`,
    );
  } catch (error) {
    failedAsExpected = /SET ROLE|must be able to SET ROLE/i.test(
      String(error?.message),
    );
  }
  await executor.query('ROLLBACK TO SAVEPOINT before_owner_transfer');
  await executor.query('COMMIT');

  assert(
    failedAsExpected,
    'PG17 legacy 0402 owner transfer unexpectedly succeeded without SET capability',
  );

  await executor.query(`
    DROP FUNCTION public.pg17_0402_owner_transfer_probe();
    REVOKE CREATE ON SCHEMA public FROM ${FUNCTION_OWNER};
  `);
}

async function assertFinalUpContract(executor) {
  const columns = await queryRows(
    executor,
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'signatures'
        AND column_name IN ('signature_key_id', 'timestamp_token_version')
      ORDER BY column_name
    `,
  );
  assert(columns.length === 2, '0402 metadata columns were not created');

  const state = (
    await queryRows(
      executor,
      `
        SELECT
          pg_get_userbyid(p.proowner) AS owner,
          p.prosecdef,
          p.proconfig,
          EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
            WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
          ) AS public_execute,
          has_function_privilege('${APP_ROLE}',
            'public.verify_signature_by_hash_public_versioned(text)', 'EXECUTE')
            AS app_execute,
          has_function_privilege('${ADMIN_ROLE}',
            'public.verify_signature_by_hash_public_versioned(text)', 'EXECUTE')
            AS admin_execute,
          has_schema_privilege('${FUNCTION_OWNER}', 'public', 'CREATE')
            AS owner_schema_create,
          has_table_privilege('${FUNCTION_OWNER}', 'public.signatures', 'SELECT')
            AS owner_select
        FROM pg_proc p
        WHERE p.oid = 'public.verify_signature_by_hash_public_versioned(text)'::regprocedure
      `,
    )
  )[0];

  assert(state, '0402 versioned verification function is absent');
  assert(state.owner === FUNCTION_OWNER, '0402 function owner is incorrect');
  assert(booleanValue(state.prosecdef), '0402 function lost SECURITY DEFINER');
  assert(
    Array.isArray(state.proconfig) &&
      state.proconfig.includes('search_path=pg_catalog, public, pg_temp'),
    '0402 function search_path is not hardened',
  );
  assert(!booleanValue(state.public_execute), 'PUBLIC retained EXECUTE on 0402');
  assert(booleanValue(state.app_execute), 'sgs_app lost 0402 EXECUTE');
  assert(!booleanValue(state.admin_execute), 'sgs_admin gained 0402 EXECUTE');
  assert(
    !booleanValue(state.owner_schema_create),
    'temporary CREATE privilege remained on sgs_function_owner',
  );
  assert(booleanValue(state.owner_select), 'function owner lost signatures SELECT');

  const membership = await queryRows(
    executor,
    `
      SELECT am.admin_option, am.inherit_option, am.set_option
      FROM pg_auth_members am
      JOIN pg_roles granted_role ON granted_role.oid = am.roleid
      JOIN pg_roles member_role ON member_role.oid = am.member
      WHERE granted_role.rolname = '${FUNCTION_OWNER}'
        AND member_role.rolname = '${EXECUTOR_ROLE}'
    `,
  );
  assert(membership.length === 1, 'executor owner membership is missing');
  assert(
    booleanValue(membership[0].admin_option) &&
      !booleanValue(membership[0].inherit_option) &&
      !booleanValue(membership[0].set_option),
    'temporary PG17 owner membership options were not restored',
  );
}

async function assertRuntimeVerification(appUrl) {
  const app = createClient(appUrl);
  await app.connect();
  try {
    const rows = await queryRows(
      app,
      `SELECT * FROM public.verify_signature_by_hash_public_versioned($1)`,
      [HASH],
    );
    assert(rows.length === 1, 'sgs_app could not execute the versioned verifier');
    assert(rows[0].signature_hash === HASH, 'versioned verifier returned wrong hash');
  } finally {
    await app.end();
  }
}

async function assertDownContract(executor) {
  const state = (
    await queryRows(
      executor,
      `
        SELECT
          to_regprocedure('public.verify_signature_by_hash_public_versioned(text)') IS NULL
            AS function_absent,
          NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'signatures'
              AND column_name IN ('signature_key_id', 'timestamp_token_version')
          ) AS columns_absent,
          has_schema_privilege('${FUNCTION_OWNER}', 'public', 'CREATE')
            AS owner_schema_create
      `,
    )
  )[0];
  assert(booleanValue(state.function_absent), '0402 down left function behind');
  assert(booleanValue(state.columns_absent), '0402 down left metadata columns behind');
  assert(
    !booleanValue(state.owner_schema_create),
    '0402 down left temporary schema CREATE behind',
  );

  const membership = await queryRows(
    executor,
    `
      SELECT am.admin_option, am.inherit_option, am.set_option
      FROM pg_auth_members am
      JOIN pg_roles granted_role ON granted_role.oid = am.roleid
      JOIN pg_roles member_role ON member_role.oid = am.member
      WHERE granted_role.rolname = '${FUNCTION_OWNER}'
        AND member_role.rolname = '${EXECUTOR_ROLE}'
    `,
  );
  assert(membership.length === 1, '0402 down removed baseline owner membership');
  assert(
    booleanValue(membership[0].admin_option) &&
      !booleanValue(membership[0].inherit_option) &&
      !booleanValue(membership[0].set_option),
    '0402 down did not restore membership options',
  );
}

async function main() {
  const baseUrl = process.env[BASE_URL_ENV];
  assert(baseUrl, `${BASE_URL_ENV} is required`);

  await cleanup(baseUrl);

  const admin = createClient(baseUrl);
  await admin.connect();
  try {
    await admin.query(`
      CREATE ROLE ${EXECUTOR_ROLE}
        LOGIN PASSWORD '${TEST_PASSWORD}'
        NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOBYPASSRLS
    `);
    // CREATE DATABASE cannot share an implicit multi-statement transaction.
    await admin.query(
      `CREATE DATABASE ${DATABASE} OWNER ${EXECUTOR_ROLE}`,
    );
  } finally {
    await admin.end();
  }

  const executorUrl = makeConnectionUrl(baseUrl, DATABASE, {
    username: EXECUTOR_ROLE,
    password: TEST_PASSWORD,
  });
  const executor = createClient(executorUrl);
  await executor.connect();

  try {
    await executor.query(`
      CREATE ROLE ${FUNCTION_OWNER}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      CREATE ROLE ${APP_ROLE}
        LOGIN PASSWORD '${TEST_PASSWORD}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      CREATE ROLE ${ADMIN_ROLE}
        LOGIN PASSWORD '${TEST_PASSWORD}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      CREATE TABLE public.signatures (
        signature_hash text,
        signed_at timestamp without time zone,
        timestamp_authority text,
        type text,
        timestamp_token text,
        integrity_payload jsonb,
        deleted_at timestamptz
      );
      REVOKE ALL ON TABLE public.signatures FROM PUBLIC, ${APP_ROLE}, ${ADMIN_ROLE};
      GRANT SELECT ON TABLE public.signatures TO ${FUNCTION_OWNER};
      GRANT USAGE ON SCHEMA public TO ${FUNCTION_OWNER}, ${APP_ROLE}, ${ADMIN_ROLE};
      INSERT INTO public.signatures (
        signature_hash, signed_at, timestamp_authority, type,
        timestamp_token, integrity_payload, deleted_at
      ) VALUES (
        '${HASH}', '2026-09-01 12:00:00', 'internal-hmac-v1', 'hmac',
        'token', '{}'::jsonb, NULL
      );
    `);

    await assertLegacyOwnerTransferFails(executor);

    await executor.query('BEGIN');
    try {
      await new AddSignatureKeyVersioning1709000000402().up(
        migrationRunner(executor),
      );
      await executor.query('COMMIT');
    } catch (error) {
      await executor.query('ROLLBACK');
      throw error;
    }

    await assertFinalUpContract(executor);

    const appUrl = makeConnectionUrl(baseUrl, DATABASE, {
      username: APP_ROLE,
      password: TEST_PASSWORD,
    });
    await assertRuntimeVerification(appUrl);

    await executor.query('BEGIN');
    try {
      await new AddSignatureKeyVersioning1709000000402().down(
        migrationRunner(executor),
      );
      await executor.query('COMMIT');
    } catch (error) {
      await executor.query('ROLLBACK');
      throw error;
    }

    await assertDownContract(executor);
    console.log('[PG17][0402] PASS');
  } finally {
    await executor.end();
    await cleanup(baseUrl);
  }
}

main().catch((error) => {
  console.error('[PG17][0402] FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
