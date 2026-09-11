const { Client } = require('pg');

const {
  DropRedundantAprCompositeIndexes1709000000403,
} = require('../dist/infra/database/migrations/1709000000403-drop-redundant-apr-composite-indexes');
const {
  AddMissingAprWorkflowForeignKeys1709000000404,
} = require('../dist/infra/database/migrations/1709000000404-add-missing-apr-workflow-fk-constraints');

const BASE_URL_ENV = 'PG17_MIGRATION_0403_0404_TEST_URL';
const EXECUTOR_ROLE = 'migration_0403_0404_executor';
const TEST_PASSWORD = 'migration-0403-0404-pg17-test-only';
const DATABASE = 'migration_0403_0404_pg17';

const CANDIDATE_INDEXES = [
  { name: 'IDX_aprs_company_created', def: '(company_id, created_at DESC)' },
  { name: 'IDX_aprs_status_company', def: '(status, company_id)' },
  { name: 'IDX_aprs_site_company', def: '(site_id, company_id)' },
];
const KEEPER_INDEX = 'IDX_aprs_company_site_status_keeper';

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

/**
 * Adapta um pg.Client ao contrato QueryRunner.query(sql, params) => rows[]
 * que as migrations reais recebem do TypeORM.
 */
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
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(EXECUTOR_ROLE)}`);
  } finally {
    await admin.end();
  }
}

async function indexExists(client, name) {
  const rows = await queryRows(
    client,
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [name],
  );
  return rows.length > 0;
}

async function totalTableReads(client) {
  const rows = await queryRows(
    client,
    `SELECT (seq_scan + idx_scan) AS total FROM pg_stat_user_tables WHERE relname = 'aprs'`,
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Gera >= `count` seq_scans reais em aprs (sem WHERE, então nunca usa os 3
 * índices candidatos) para ultrapassar o piso de 5000 leituras que a
 * migration 403 exige antes de agir. As estatísticas do Postgres só ficam
 * visíveis depois que a transação que as gerou comitou — por isso o polling
 * curto abaixo em vez de assumir visibilidade instantânea.
 */
async function generateSeqScanTraffic(client, count) {
  await client.query(
    `DO $$
     BEGIN
       FOR i IN 1..${count} LOOP
         PERFORM count(*) FROM aprs;
       END LOOP;
     END $$;`,
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const total = await totalTableReads(client);
    if (total >= 5000) return total;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    'pg_stat_user_tables never reflected the generated traffic within the polling window',
  );
}

/**
 * Força um idx_scan real no índice indicado via enable_seqscan=off — numa
 * tabela pequena o planner prefere seq scan por padrão; desligar as
 * alternativas é a forma padrão de obrigar o uso de um índice específico em
 * teste.
 */
async function forceIndexScan(client, whereClause, times) {
  await client.query('SET enable_seqscan = off');
  await client.query('SET enable_bitmapscan = off');
  try {
    for (let i = 0; i < times; i += 1) {
      await client.query(`SELECT 1 FROM aprs WHERE ${whereClause} LIMIT 1`);
    }
  } finally {
    await client.query('RESET enable_seqscan');
    await client.query('RESET enable_bitmapscan');
  }
}

async function setupSchema(executor) {
  await executor.query(`
    CREATE TABLE public.companies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    );
    CREATE TABLE public.sites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    );
    CREATE TABLE public.apr_workflow_configs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenantId" uuid,
      "siteId" uuid
    );
    CREATE TABLE public.aprs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      site_id uuid,
      status varchar(40) NOT NULL DEFAULT 'Pendente',
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      "workflowConfigId" uuid
    );
  `);
}

// ─────────────────────────── Migration 0403 ────────────────────────────────

async function runMigration403Suite(executor) {
  for (const candidate of CANDIDATE_INDEXES) {
    await executor.query(
      `CREATE INDEX ${quoteIdentifier(candidate.name)} ON public.aprs ${candidate.def}`,
    );
  }
  // Simula um índice "substituto" (padrão das migrations 131/161) que a 403
  // NUNCA deve tocar — nem nomeado nela, então continua existindo em
  // qualquer cenário.
  await executor.query(
    `CREATE INDEX ${quoteIdentifier(KEEPER_INDEX)} ON public.aprs (company_id, site_id, status) WHERE deleted_at IS NULL`,
  );

  // Cenário A — abaixo do piso de tráfego: nenhum índice é tocado.
  const trafficBefore = await totalTableReads(executor);
  assert(
    trafficBefore < 5000,
    `expected fresh traffic below threshold, got ${trafficBefore}`,
  );
  await new DropRedundantAprCompositeIndexes1709000000403().up(
    migrationRunner(executor),
  );
  for (const candidate of CANDIDATE_INDEXES) {
    assert(
      await indexExists(executor, candidate.name),
      `0403 [below threshold]: "${candidate.name}" was dropped despite traffic below the safety floor`,
    );
  }
  assert(
    await indexExists(executor, KEEPER_INDEX),
    '0403 [below threshold]: unrelated keeper index was touched',
  );
  console.log('[PG17][0403] PASS: no-op below the 5000-read safety floor');

  // Cenário B — acima do piso, todos os 3 candidatos sem idx_scan: os 3
  // devem ser removidos; o índice substituto nunca é tocado.
  await generateSeqScanTraffic(executor, 5200);
  await new DropRedundantAprCompositeIndexes1709000000403().up(
    migrationRunner(executor),
  );
  for (const candidate of CANDIDATE_INDEXES) {
    assert(
      !(await indexExists(executor, candidate.name)),
      `0403 [above threshold]: "${candidate.name}" was NOT dropped despite zero idx_scan`,
    );
  }
  assert(
    await indexExists(executor, KEEPER_INDEX),
    '0403 [above threshold]: unrelated keeper index was dropped — only the 3 named candidates may ever be touched',
  );
  console.log(
    '[PG17][0403] PASS: drops only the 3 named redundant indexes once traffic proves them unused',
  );

  // Cenário C — execução segura/idempotente quando os índices esperados já
  // não existem (chamada repetida de up()).
  await new DropRedundantAprCompositeIndexes1709000000403().up(
    migrationRunner(executor),
  );
  assert(
    await indexExists(executor, KEEPER_INDEX),
    '0403 [idempotent up]: keeper index disappeared on a second up() run',
  );
  console.log(
    '[PG17][0403] PASS: up() is safe to re-run when the candidate indexes are already gone',
  );

  // down() recria os 3 índices originais, com CONCURRENTLY, sem tocar no
  // substituto.
  await new DropRedundantAprCompositeIndexes1709000000403().down(
    migrationRunner(executor),
  );
  for (const candidate of CANDIDATE_INDEXES) {
    assert(
      await indexExists(executor, candidate.name),
      `0403 [down]: "${candidate.name}" was not recreated`,
    );
  }
  assert(
    await indexExists(executor, KEEPER_INDEX),
    '0403 [down]: unrelated keeper index disappeared',
  );
  console.log('[PG17][0403] PASS: down() recreates the 3 dropped indexes');
}

// ─────────────────────────── Migration 0404 ────────────────────────────────

async function fkConstraintState(executor, constraintName) {
  const rows = await queryRows(
    executor,
    `SELECT convalidated, confdeltype
     FROM pg_constraint
     WHERE conname = $1`,
    [constraintName],
  );
  return rows[0] ?? null;
}

async function runMigration404Suite(executor) {
  const [{ id: companyId }] = await queryRows(
    executor,
    `INSERT INTO companies DEFAULT VALUES RETURNING id`,
  );
  const [{ id: siteId }] = await queryRows(
    executor,
    `INSERT INTO sites DEFAULT VALUES RETURNING id`,
  );
  const orphanCompanyId = '00000000-0000-4000-8000-0000000000aa';
  const orphanSiteId = '00000000-0000-4000-8000-0000000000bb';
  const orphanConfigId = '00000000-0000-4000-8000-0000000000cc';

  const [{ id: validConfigId }] = await queryRows(
    executor,
    `INSERT INTO apr_workflow_configs ("tenantId", "siteId") VALUES ($1, NULL) RETURNING id`,
    [companyId],
  );
  const [{ id: orphanConfigRowId }] = await queryRows(
    executor,
    `INSERT INTO apr_workflow_configs ("tenantId", "siteId") VALUES ($1, $2) RETURNING id`,
    [orphanCompanyId, orphanSiteId],
  );

  const [{ id: aprWithValidConfigId }] = await queryRows(
    executor,
    `INSERT INTO aprs (company_id, "workflowConfigId") VALUES ($1, $2) RETURNING id`,
    [companyId, validConfigId],
  );
  const [{ id: aprWithOrphanConfigId }] = await queryRows(
    executor,
    `INSERT INTO aprs (company_id, "workflowConfigId") VALUES ($1, $2) RETURNING id`,
    [companyId, orphanConfigId],
  );

  // ── up(): remediação de órfãos + FKs NOT VALID/VALIDATE ──────────────────
  await new AddMissingAprWorkflowForeignKeys1709000000404().up(
    migrationRunner(executor),
  );

  const [orphanApr] = await queryRows(
    executor,
    `SELECT "workflowConfigId" FROM aprs WHERE id = $1`,
    [aprWithOrphanConfigId],
  );
  assert(
    orphanApr.workflowConfigId === null,
    '0404 [remediation]: orphaned aprs.workflowConfigId was not nulled before ADD CONSTRAINT',
  );
  const [validApr] = await queryRows(
    executor,
    `SELECT "workflowConfigId" FROM aprs WHERE id = $1`,
    [aprWithValidConfigId],
  );
  assert(
    validApr.workflowConfigId === validConfigId,
    '0404 [remediation]: a VALID aprs.workflowConfigId was incorrectly cleared',
  );

  const [orphanConfig] = await queryRows(
    executor,
    `SELECT "tenantId", "siteId" FROM apr_workflow_configs WHERE id = $1`,
    [orphanConfigRowId],
  );
  assert(
    orphanConfig.tenantId === null && orphanConfig.siteId === null,
    '0404 [remediation]: orphaned apr_workflow_configs.tenantId/siteId were not nulled before ADD CONSTRAINT',
  );

  const fkAprs = await fkConstraintState(executor, 'FK_aprs_workflow_config_id');
  assert(fkAprs, '0404 [up]: FK_aprs_workflow_config_id was not created');
  assert(
    booleanValue(fkAprs.convalidated),
    '0404 [up]: FK_aprs_workflow_config_id was created but never validated (NOT VALID left behind)',
  );
  assert(
    fkAprs.confdeltype === 'n',
    '0404 [up]: FK_aprs_workflow_config_id is not ON DELETE SET NULL',
  );

  const fkTenant = await fkConstraintState(
    executor,
    'FK_apr_workflow_configs_tenant_id',
  );
  assert(fkTenant, '0404 [up]: FK_apr_workflow_configs_tenant_id was not created');
  assert(
    fkTenant.confdeltype === 'c',
    '0404 [up]: FK_apr_workflow_configs_tenant_id is not ON DELETE CASCADE',
  );

  const fkSite = await fkConstraintState(
    executor,
    'FK_apr_workflow_configs_site_id',
  );
  assert(fkSite, '0404 [up]: FK_apr_workflow_configs_site_id was not created');
  assert(
    fkSite.confdeltype === 'n',
    '0404 [up]: FK_apr_workflow_configs_site_id is not ON DELETE SET NULL',
  );
  console.log(
    '[PG17][0404] PASS: orphan remediation ran before each ADD CONSTRAINT, all 3 FKs created and validated',
  );

  // ── enforcement real: inserir referência inválida deve falhar ───────────
  await assertRejects(
    executor.query(
      `INSERT INTO aprs (company_id, "workflowConfigId") VALUES ($1, $2)`,
      [companyId, '00000000-0000-4000-8000-0000000000ff'],
    ),
    '23503',
    '0404 [enforcement]: aprs.workflowConfigId accepted a non-existent config id',
  );
  await assertRejects(
    executor.query(
      `INSERT INTO apr_workflow_configs ("tenantId", "siteId") VALUES ($1, NULL)`,
      ['00000000-0000-4000-8000-0000000000ff'],
    ),
    '23503',
    '0404 [enforcement]: apr_workflow_configs.tenantId accepted a non-existent company id',
  );
  console.log('[PG17][0404] PASS: FKs actively reject invalid references');

  // ── nullable tenantId/siteId continuam permitidos (configs globais) ─────
  const globalConfig = await queryRows(
    executor,
    `INSERT INTO apr_workflow_configs ("tenantId", "siteId") VALUES (NULL, NULL) RETURNING id`,
  );
  assert(
    globalConfig.length === 1,
    '0404 [nullable]: a global config (tenantId/siteId both NULL) should remain insertable',
  );
  console.log('[PG17][0404] PASS: NULL tenantId/siteId (global configs) still allowed');

  // ── ON DELETE SET NULL / CASCADE realmente disparam ──────────────────────
  await executor.query(`DELETE FROM apr_workflow_configs WHERE id = $1`, [
    validConfigId,
  ]);
  const [aprAfterConfigDelete] = await queryRows(
    executor,
    `SELECT "workflowConfigId" FROM aprs WHERE id = $1`,
    [aprWithValidConfigId],
  );
  assert(
    aprAfterConfigDelete.workflowConfigId === null,
    '0404 [ON DELETE SET NULL]: deleting the referenced config did not null aprs.workflowConfigId',
  );

  const [{ id: cascadeConfigId }] = await queryRows(
    executor,
    `INSERT INTO apr_workflow_configs ("tenantId", "siteId") VALUES ($1, $2) RETURNING id`,
    [companyId, siteId],
  );
  await executor.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  const cascaded = await queryRows(
    executor,
    `SELECT 1 FROM apr_workflow_configs WHERE id = $1`,
    [cascadeConfigId],
  );
  assert(
    cascaded.length === 0,
    '0404 [ON DELETE CASCADE]: deleting the referenced company did not cascade-delete the workflow config',
  );
  console.log(
    '[PG17][0404] PASS: ON DELETE SET NULL (aprs->configs, configs->sites) and ON DELETE CASCADE (configs->companies) behave as declared',
  );

  // ── down(): remove as 3 constraints ──────────────────────────────────────
  await new AddMissingAprWorkflowForeignKeys1709000000404().down(
    migrationRunner(executor),
  );
  for (const name of [
    'FK_aprs_workflow_config_id',
    'FK_apr_workflow_configs_tenant_id',
    'FK_apr_workflow_configs_site_id',
  ]) {
    assert(
      (await fkConstraintState(executor, name)) === null,
      `0404 [down]: constraint "${name}" was not dropped`,
    );
  }
  console.log('[PG17][0404] PASS: down() drops all 3 constraints');

  // ── idempotência: rodar up() de novo depois do down() recria sem erro ────
  await new AddMissingAprWorkflowForeignKeys1709000000404().up(
    migrationRunner(executor),
  );
  assert(
    await fkConstraintState(executor, 'FK_aprs_workflow_config_id'),
    '0404 [idempotent up]: re-running up() after down() did not recreate the FK',
  );
  console.log('[PG17][0404] PASS: up() is safe to re-run after down()');
}

async function assertRejects(promise, expectedSqlState, message) {
  try {
    await promise;
  } catch (error) {
    if (error && error.code === expectedSqlState) return;
    throw new Error(
      `${message} (expected SQLSTATE ${expectedSqlState}, got ${error && error.code}: ${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  throw new Error(message);
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
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
    `);
    // CREATE DATABASE não pode compartilhar transação implícita com outros comandos.
    await admin.query(`CREATE DATABASE ${DATABASE} OWNER ${EXECUTOR_ROLE}`);
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
    await executor.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await setupSchema(executor);

    // As duas migrations declaram `transaction = false` (403 usa
    // CREATE/DROP INDEX CONCURRENTLY, que exige rodar fora de bloco de
    // transação; 404 precisa que NOT VALID e VALIDATE CONSTRAINT sejam
    // transações separadas). Por isso .up()/.down() são chamados
    // diretamente aqui, sem BEGIN/COMMIT — exatamente como
    // scripts/run-migrations.js executa quando `migration.transaction !==
    // false` é falso, e diferente do padrão usado no script do 0402 (que
    // testa uma migration transacional).
    await runMigration403Suite(executor);
    await runMigration404Suite(executor);

    console.log('[PG17][0403][0404] PASS');
  } finally {
    await executor.end();
    await cleanup(baseUrl);
  }
}

main().catch((error) => {
  console.error(
    '[PG17][0403][0404] FAIL',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
