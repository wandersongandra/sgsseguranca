#!/usr/bin/env node
'use strict';

const { assertLoadtestEnvironment } = require('../../infra/load-test/scripts/loadtest-target-guard.cjs');
assertLoadtestEnvironment({ requireDatabase: true });

const { Client } = require('pg');

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const appUrl = process.env.DATABASE_URL;

if (
  process.env.APP_ENV !== 'loadtest' ||
  process.env.APP_LOADTEST_MARKER !== 'sgs-loadtest' ||
  process.env.NODE_ENV === 'production'
) {
  throw new Error(
    'BE011 guard: probe requires APP_ENV=loadtest and APP_LOADTEST_MARKER=sgs-loadtest',
  );
}

function assertLoadtestDatabaseUrl(value, label) {
  if (!value) throw new Error(`BE011 guard: ${label} is required`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`BE011 guard: ${label} is malformed`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== 'postgres-loadtest' ||
    databaseName !== 'sgs_loadtest' ||
    /production|neon|coolify/i.test(value)
  ) {
    throw new Error(`BE011 guard: ${label} must target postgres-loadtest/sgs_loadtest`);
  }
}

assertLoadtestDatabaseUrl(migrationUrl, 'migration URL');
assertLoadtestDatabaseUrl(appUrl, 'application URL');

async function rows(client, sql, values) {
  return (await client.query(sql, values)).rows;
}

async function inventory(client) {
  const sql = [
    'SELECT n.nspname AS schema_name, p.oid, p.proname AS name,',
    'pg_get_function_identity_arguments(p.oid) AS signature,',
    'pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,',
    "CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility,",
    "CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' ELSE 'function' END AS kind,",
    'COALESCE(p.proconfig, ARRAY[]::text[]) AS config,',
    "EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute,",
    "has_function_privilege('sgs_app', p.oid, 'EXECUTE') AS sgs_app_execute,",
    "has_function_privilege('sgs_admin', p.oid, 'EXECUTE') AS sgs_admin_execute,",
    "EXISTS (SELECT 1 FROM aclexplode(p.proacl) AS acl WHERE acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'sgs_app') AND acl.privilege_type = 'EXECUTE') AS sgs_app_explicit,",
    "EXISTS (SELECT 1 FROM aclexplode(p.proacl) AS acl WHERE acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'sgs_admin') AND acl.privilege_type = 'EXECUTE') AS sgs_admin_explicit,",
    'COALESCE(dep.table_refs, ARRAY[]::text[]) AS table_refs,',
    'COALESCE(dep.writes, false) AS writes,',
    "position('EXECUTE ' IN pg_get_functiondef(p.oid)) > 0 AS has_dynamic_sql,",
    'pg_get_functiondef(p.oid) AS definition',
    'FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace',
    'LEFT JOIN LATERAL (',
    "SELECT array_agg(DISTINCT rn.nspname || '.' || rc.relname ORDER BY rn.nspname || '.' || rc.relname) AS table_refs,",
    "bool_or(position('UPDATE ' || upper(rc.relname) IN upper(pg_get_functiondef(p.oid))) > 0",
    "OR position('DELETE FROM ' || upper(rc.relname) IN upper(pg_get_functiondef(p.oid))) > 0",
    "OR position('INSERT INTO ' || upper(rc.relname) IN upper(pg_get_functiondef(p.oid))) > 0) AS writes",
    'FROM pg_depend d JOIN pg_class rc ON rc.oid = d.refobjid',
    'JOIN pg_namespace rn ON rn.oid = rc.relnamespace',
    "WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid",
    "AND d.refclassid = 'pg_class'::regclass AND rn.nspname NOT LIKE 'pg_%'",
    "AND rn.nspname <> 'information_schema') dep ON true",
    "WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'",
    'ORDER BY n.nspname, p.proname, signature',
  ].join(' ');
  return (await client.query(sql)).rows.map((row) => {
    const config = Array.isArray(row.config) ? row.config : [];
    const searchPath = config.find((item) => item.startsWith('search_path='));
    const definition = String(row.definition || '');
    const normalized = definition.toLowerCase();
    const sourceRefs = Array.from(
      new Set(
        [...definition.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)\b/gi)].map(
          (match) => `public.${match[1]}`,
        ),
      ),
    );
    return {
      schema: row.schema_name,
      name: row.name,
      signature: row.signature,
      owner: row.owner,
      security: row.security_definer ? 'SECURITY DEFINER' : 'SECURITY INVOKER',
      volatility: row.volatility,
      kind: row.kind,
      searchPath: searchPath ? searchPath.slice('search_path='.length) : null,
      publicExecute: row.public_execute,
      sgsAppExecute: row.sgs_app_execute,
      sgsAdminExecute: row.sgs_admin_execute,
      tableRefs: Array.from(
        new Set([...(row.table_refs || []), ...sourceRefs]),
      ),
      writes:
        Boolean(row.writes) ||
        /\b(update|insert|delete)\s+(?:public\.)?[a-z_]/i.test(definition),
      dynamicSql: row.has_dynamic_sql || normalized.includes('execute '),
      currentSetting: normalized.includes('current_setting('),
      sgsAppExplicit: row.sgs_app_explicit,
      sgsAdminExplicit: row.sgs_admin_explicit,
      tenantAware:
        normalized.includes('current_company') ||
        normalized.includes('current_tenant') ||
        normalized.includes('company_id'),
      definition,
    };
  });
}

async function runShadowing(client) {
  const result = {};
  await client.query('BEGIN');
  try {
    await client.query(
      'CREATE TEMP TABLE users (id uuid, nome varchar, cpf varchar, cpf_ciphertext text, email varchar, funcao varchar, password varchar, auth_user_id uuid, company_id uuid, site_id uuid, profile_id uuid, status boolean, must_change_password boolean, cpf_hash text, deleted_at timestamptz) ON COMMIT DROP',
    );
    await client.query(
      'CREATE TEMP TABLE profiles (id uuid, nome varchar) ON COMMIT DROP',
    );
    await client.query(
      'CREATE TEMP TABLE user_sites (user_id uuid, company_id uuid, site_id uuid, created_at timestamptz) ON COMMIT DROP',
    );
    await client.query(
      "INSERT INTO users (id,nome,email,password,auth_user_id,company_id,profile_id,status,must_change_password,cpf_hash) VALUES ('00000000-0000-4000-8000-0000000000a1','BE011_SHADOW_USER','be011-shadow@example.invalid','synthetic-hash','00000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a3',true,false,'be011-shadow-cpf-hash')",
    );
    await client.query(
      "INSERT INTO profiles (id,nome) VALUES ('00000000-0000-4000-8000-0000000000a3','BE011_SHADOW_PROFILE')",
    );

    const login = await rows(
      client,
      'SELECT id, email FROM public.find_login_user($1, NULL)',
      ['be011-shadow-cpf-hash'],
    );
    result.findLoginUser = login.length > 0 ? 'SHADOWED' : 'not-shadowed';
    await rows(
      client,
      'SELECT public.update_login_user_password_hash($1::uuid, $2)',
      ['00000000-0000-4000-8000-0000000000a1', 'be011-new-hash'],
    );
    const updated = await rows(
      client,
      'SELECT password FROM pg_temp.users WHERE id = $1::uuid',
      ['00000000-0000-4000-8000-0000000000a1'],
    );
    result.updateLoginPassword =
      updated[0] && updated[0].password === 'be011-new-hash'
        ? 'SHADOWED'
        : 'not-shadowed';
    const bridge = await rows(
      client,
      'SELECT id, company_id FROM public.find_user_bridge($1::uuid, NULL)',
      ['00000000-0000-4000-8000-0000000000a1'],
    );
    result.findUserBridge = bridge.length > 0 ? 'SHADOWED' : 'not-shadowed';
    const reset = await rows(
      client,
      'SELECT user_id FROM public.reset_login_user_password($1::uuid, $2)',
      ['00000000-0000-4000-8000-0000000000a1', 'be011-reset-hash'],
    );
    result.resetLoginPassword = reset.length > 0 ? 'SHADOWED' : 'not-shadowed';

    await client.query(
      'CREATE TEMP TABLE signatures (signature_hash text, signed_at timestamp, timestamp_authority text, type text, timestamp_token text, integrity_payload jsonb, deleted_at timestamptz) ON COMMIT DROP',
    );
    await client.query(
      "INSERT INTO signatures (signature_hash,signed_at,timestamp_authority,type,timestamp_token,integrity_payload) VALUES (repeat('b',64),now(),'BE011','synthetic','synthetic','{}'::jsonb)",
    );
    const signature = await rows(
      client,
      'SELECT signature_hash FROM public.verify_signature_by_hash_public($1)',
      ['b'.repeat(64)],
    );
    result.publicSignatureVerify =
      signature.length > 0 ? 'SHADOWED' : 'not-shadowed';

    await client.query(
      'CREATE TEMP TABLE apr_risk_evidences (hash_sha256 text, watermarked_hash_sha256 text) ON COMMIT DROP',
    );
    await client.query(
      "INSERT INTO apr_risk_evidences (hash_sha256,watermarked_hash_sha256) VALUES (repeat('c',64),NULL)",
    );
    const aprEvidence = await rows(
      client,
      'SELECT matched_in FROM public.verify_apr_evidence_by_hash_public($1)',
      ['c'.repeat(64)],
    );
    result.publicAprEvidenceVerify =
      aprEvidence.length > 0 ? 'SHADOWED' : 'not-shadowed';
  } finally {
    await client.query('ROLLBACK');
  }
  return result;
}

async function contextTests(client) {
  const a = '00000000-0000-4000-8000-0000000000a1';
  const b = '00000000-0000-4000-8000-0000000000b1';
  await client.query('BEGIN');
  try {
    const result = {};
    result.a = (
      await rows(
        client,
        "SELECT set_config('app.current_company_id',$1,false), public.current_company() AS current_company",
        [a],
      )
    )[0].current_company;
    result.b = (
      await rows(
        client,
        "SELECT set_config('app.current_company_id',$1,false), public.current_company() AS current_company",
        [b],
      )
    )[0].current_company;
    await client.query("SELECT set_config('app.current_company_id','',false)");
    result.missing =
      (
        await rows(client, 'SELECT public.current_company() AS current_company')
      )[0].current_company || null;
    await client.query(
      "SELECT set_config('app.current_company_id','not-a-uuid',false)",
    );
    result.invalid =
      (
        await rows(client, 'SELECT public.current_company() AS current_company')
      )[0].current_company || null;
    return result;
  } finally {
    await client.query('ROLLBACK');
  }
}

async function runtimeMaterializedViewAccess(client) {
  const result = {};
  for (const viewName of ['company_dashboard_metrics', 'apr_risk_rankings']) {
    try {
      await client.query(`SELECT 1 FROM public.${viewName} LIMIT 1`);
      result[viewName] = 'select-allowed';
    } catch (error) {
      result[viewName] =
        error && error.code === '42501'
          ? 'select-denied'
          : `error:${error && error.code ? error.code : 'unknown'}`;
    }
  }
  return result;
}

async function privilegedFlagSpoofTest(client) {
  await client.query('BEGIN');
  try {
    const row = (
      await client.query(
        "SELECT set_config('app.is_super_admin', 'true', false) AS flag, public.is_super_admin() AS role_gate",
      )
    ).rows[0];
    return {
      flag: row.flag === 'true',
      roleGate: row.role_gate === true,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main() {
  const migration = new Client({ connectionString: migrationUrl });
  const app = new Client({ connectionString: appUrl });
  let migrationConnected = false;
  let appConnected = false;
  try {
    await migration.connect();
    migrationConnected = true;
    await app.connect();
    appConnected = true;
    const functions = await inventory(migration);
    const definers = functions.filter(
      (fn) => fn.security === 'SECURITY DEFINER',
    );
    const triggers = await rows(
      migration,
      "SELECT n.nspname AS schema_name,c.relname AS table_name,t.tgname AS trigger_name,p.proname AS function_name,pg_get_function_identity_arguments(p.oid) AS signature,p.prosecdef AS security_definer,pg_get_userbyid(p.proowner) AS owner FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND n.nspname NOT LIKE 'pg_%' ORDER BY n.nspname,c.relname,t.tgname",
    );
    const defaults = await rows(
      migration,
      "SELECT COALESCE(r.rolname,'unknown') AS owner,COALESCE(n.nspname,'*') AS schema_name,d.defaclobjtype AS object_type,COALESCE(d.defaclacl,ARRAY[]::aclitem[])::text AS acl FROM pg_default_acl d LEFT JOIN pg_roles r ON r.oid=d.defaclrole LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE d.defaclobjtype='f' ORDER BY owner,schema_name",
    );
    const roles = await rows(
      migration,
      "SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolcanlogin,COALESCE(array_to_string(ARRAY(SELECT member_role.rolname FROM pg_auth_members m JOIN pg_roles member_role ON member_role.oid=m.roleid WHERE m.member=r.oid),','),'') AS memberships FROM pg_roles r WHERE rolname IN ('sgs_app','sgs_admin','sgs_migrator','sgs_rls_bypass','sgs_function_owner','neondb_owner','postgres') ORDER BY rolname",
    );
    const searchPathIssues = definers.filter(
      (fn) =>
        !fn.searchPath ||
        !fn.searchPath.includes('pg_temp') ||
        fn.searchPath.includes('$user'),
    );
    const publicDefiners = definers.filter((fn) => fn.publicExecute);
    const dynamicDefiners = definers.filter((fn) => fn.dynamicSql);
    const output = {
      database: 'sgs_loadtest',
      totalFunctions: functions.length,
      securityDefinerCount: definers.length,
      securityDefiners: definers.map(({ definition, ...fn }) => fn),
      appExecutableFunctions: functions
        .filter((fn) => fn.sgsAppExplicit)
        .map(({ definition, ...fn }) => fn),
      appEffectiveExecutableFunctions: functions
        .filter((fn) => fn.sgsAppExecute)
        .map(({ definition, ...fn }) => fn),
      searchPathIssues: searchPathIssues.map(({ definition, ...fn }) => fn),
      publicSecurityDefinerExecute: publicDefiners.map(
        ({ definition, ...fn }) => fn,
      ),
      dynamicSecurityDefiners: dynamicDefiners.map(
        ({ definition, ...fn }) => fn,
      ),
      triggers,
      triggerSecurityDefiners: triggers.filter((row) => row.security_definer),
      defaultFunctionPrivileges: defaults,
      roles,
      shadowing: await runShadowing(app),
      context: await contextTests(app),
      runtimeMaterializedViewAccess: await runtimeMaterializedViewAccess(app),
      privilegedFlagSpoof: await privilegedFlagSpoofTest(app),
    };
    output.pass =
      output.securityDefinerCount === 6 &&
      output.searchPathIssues.length === 0 &&
      output.publicSecurityDefinerExecute.length === 0 &&
      output.appEffectiveExecutableFunctions.length === 0 &&
      output.dynamicSecurityDefiners.length === 0 &&
      output.triggerSecurityDefiners.length === 0 &&
      Object.values(output.shadowing).every(
        (value) => value === 'not-shadowed',
      ) &&
      output.context.missing === null &&
      output.context.invalid === null &&
      Object.values(output.runtimeMaterializedViewAccess).every(
        (value) => value === 'select-denied',
      ) &&
      output.privilegedFlagSpoof.flag === true &&
      output.privilegedFlagSpoof.roleGate === false;
    console.log(JSON.stringify(output, null, 2));
    if (!output.pass) {
      throw new Error('BE011 security-definer assertions failed');
    }
  } finally {
    if (appConnected) await app.end();
    if (migrationConnected) await migration.end();
  }
}

main().catch((error) => {
  console.error(
    '[BE011-FAIL] ' + (error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
});
