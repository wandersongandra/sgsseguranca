/**
 * Seed de Carga — Cria 100 tenants de teste com 500 APRs cada.
 *
 * Uso:
 *   node ./node_modules/ts-node/dist/bin.js -r tsconfig-paths/register test/load/seed-tenants.ts
 *   node ./node_modules/ts-node/dist/bin.js -r tsconfig-paths/register test/load/seed-tenants.ts --dry-run
 *   node ./node_modules/ts-node/dist/bin.js -r tsconfig-paths/register test/load/seed-tenants.ts --clean
 *
 * Variáveis de ambiente (opcionais — padrões apontam para o docker-compose.test.yml):
 *   DATABASE_HOST, DATABASE_PORT, DATABASE_NAME (ou POSTGRES_DB)
 *   DATABASE_USER (ou POSTGRES_USER), DATABASE_PASSWORD (ou POSTGRES_PASSWORD)
 *
 * Saída:
 *   test/load/tenants.json — credenciais e IDs para o k6-load-test.js
 *
 * Idempotência:
 *   Limpa dados anteriores (companies com razao_social LIKE 'K6_%') antes de criar novos.
 *   Use --clean para apenas limpar sem criar.
 */

import { Pool } from 'pg';
import { hash } from 'bcryptjs';
import { writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import * as path from 'path';

// ─── Configuração ────────────────────────────────────────────────────────────

const LOAD_TEST_MARKER = 'K6_';
const TENANT_COUNT = 100;
const APRS_PER_TENANT = 500;
const APR_BATCH_SIZE = 100; // INSERT ... VALUES por batch
const TEST_PASSWORD = 'LoadTest@123';

const APR_STATUSES = ['Pendente', 'Aprovada', 'Encerrada'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * CNPJ de 14 dígitos para teste.
 * Não segue o algoritmo de dígitos verificadores — bypass do service layer via SQL direto.
 * Formato: XXXXXXXX000100 onde X é o índice sequencial.
 */
function testCnpj(index: number): string {
  return String(index + 1).padStart(8, '0') + '000100';
}

/**
 * CPF de 11 dígitos para teste.
 * Gera CPFs válidos (com dígitos verificadores corretos) a partir de um índice.
 */
function testCpf(index: number): string {
  // Usa uma faixa alta e reservada para evitar colisão com usuários reais/importados.
  const base = String(900000000 + index)
    .padStart(9, '0')
    .slice(-9);
  const digits = base.split('').map((d) => Number(d));

  const calcDigit = (values: number[], factorStart: number): number => {
    const sum = values.reduce(
      (acc, value, idx) => acc + value * (factorStart - idx),
      0,
    );
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  const d1 = calcDigit(digits, 10);
  const d2 = calcDigit([...digits, d1], 11);
  return `${base}${d1}${d2}`;
}

/**
 * Gera data no formato YYYY-MM-DD, offset em meses a partir de hoje.
 */
function dateOffset(monthsFromNow: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + monthsFromNow);
  return d.toISOString().slice(0, 10);
}

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface TenantCredential {
  tenantIndex: number;
  companyId: string;
  siteId: string;
  userId: string;
  cpf: string;
  password: string;
}

// ─── Seed principal ──────────────────────────────────────────────────────────

async function cleanLoadTestData(pool: Pool): Promise<void> {
  console.log('⟳  Limpando dados de carga anteriores...');

  // A ordem respeita as FK: aprs → sites/users → companies
  const deleted = await pool.query<{
    aprs: string;
    sessions: string;
    sites: string;
    users: string;
    companies: string;
  }>(
    `WITH
       del_aprs AS (
         DELETE FROM aprs
         WHERE company_id IN (SELECT id FROM companies WHERE razao_social LIKE $1)
         RETURNING 1
       ),
       del_sessions AS (
         DELETE FROM user_sessions
         WHERE user_id IN (
           SELECT id FROM users WHERE email LIKE $2
         )
         RETURNING 1
       ),
       del_sites AS (
         DELETE FROM sites
         WHERE company_id IN (SELECT id FROM companies WHERE razao_social LIKE $1)
         RETURNING 1
       ),
       del_users AS (
         DELETE FROM users
         WHERE email LIKE $2
         RETURNING 1
       ),
       del_companies AS (
         DELETE FROM companies
         WHERE razao_social LIKE $1
         RETURNING 1
       )
     SELECT
       (SELECT COUNT(*) FROM del_aprs)     AS aprs,
       (SELECT COUNT(*) FROM del_sessions) AS sessions,
       (SELECT COUNT(*) FROM del_sites)    AS sites,
       (SELECT COUNT(*) FROM del_users)    AS users,
       (SELECT COUNT(*) FROM del_companies) AS companies`,
    [`${LOAD_TEST_MARKER}%`, `k6.%@test.local`],
  );

  const row = deleted.rows[0];
  console.log(
    `   Removidos: ${row.companies} companies, ${row.sites} sites, ${row.users} users, ${row.sessions} sessões, ${row.aprs} APRs`,
  );
}

async function resolveAdminProfileId(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string; nome: string }>(
    `SELECT id, nome FROM profiles WHERE nome = $1 LIMIT 1`,
    ['Administrador da Empresa'],
  );

  if (!rows.length) {
    throw new Error(
      'Profile "Administrador da Empresa" não encontrado.\n' +
        '→ Execute o backend ao menos uma vez para criar os profiles via SeedService.',
    );
  }

  return rows[0].id;
}

async function createTenants(
  pool: Pool,
  profileId: string,
  passwordHash: string,
  dryRun: boolean,
): Promise<TenantCredential[]> {
  const tenants: TenantCredential[] = [];

  console.log(`\n⟳  Criando ${TENANT_COUNT} tenants...`);

  for (let i = 0; i < TENANT_COUNT; i++) {
    const companyId = randomUUID();
    const siteId = randomUUID();
    const userId = randomUUID();
    const padded = String(i + 1).padStart(4, '0');
    const cnpj = testCnpj(i);
    const cpf = testCpf(i);
    const email = `k6.tenant${padded}@test.local`;

    if (!dryRun) {
      await pool.query(
        `INSERT INTO companies (id, razao_social, cnpj, endereco, responsavel, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())`,
        [
          companyId,
          `${LOAD_TEST_MARKER}Empresa ${padded}`,
          cnpj,
          'Rua de Teste, 100',
          'Resp. Teste',
        ],
      );

      await pool.query(
        `INSERT INTO sites (id, nome, local, company_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, NOW(), NOW())`,
        [
          siteId,
          `${LOAD_TEST_MARKER}Obra ${padded}`,
          'Local de Teste',
          companyId,
        ],
      );

      await pool.query(
        `INSERT INTO users (id, nome, cpf, email, password, company_id, profile_id, status, module_access_keys, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, NOW(), NOW())`,
        [
          userId,
          `K6 Admin ${padded}`,
          cpf,
          email,
          passwordHash,
          companyId,
          profileId,
          JSON.stringify([]),
        ],
      );
    }

    tenants.push({
      tenantIndex: i,
      companyId,
      siteId,
      userId,
      cpf,
      password: TEST_PASSWORD,
    });

    if ((i + 1) % 20 === 0) {
      process.stdout.write(`   ${i + 1}/${TENANT_COUNT} tenants\n`);
    }
  }

  return tenants;
}

async function bulkInsertAprs(
  pool: Pool,
  tenants: TenantCredential[],
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;

  const total = TENANT_COUNT * APRS_PER_TENANT;
  console.log(
    `\n⟳  Inserindo ${total.toLocaleString()} APRs (${APR_BATCH_SIZE}/batch)...`,
  );

  const dataInicio = dateOffset(-6); // 6 meses atrás
  const dataFim = dateOffset(6); // 6 meses à frente

  let globalCounter = 0;

  for (const tenant of tenants) {
    let inserted = 0;

    while (inserted < APRS_PER_TENANT) {
      const batchSize = Math.min(APR_BATCH_SIZE, APRS_PER_TENANT - inserted);
      const valuePlaceholders: string[] = [];
      const params: unknown[] = [];
      let p = 1;

      for (let j = 0; j < batchSize; j++) {
        const aprIdx = inserted + j + 1;
        const numero = `${LOAD_TEST_MARKER}${String(tenant.tenantIndex + 1).padStart(4, '0')}-${String(aprIdx).padStart(4, '0')}`;
        const titulo = `APR de Carga ${aprIdx}`;
        const status = APR_STATUSES[aprIdx % APR_STATUSES.length];

        valuePlaceholders.push(
          `($${p},$${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},NOW(),NOW())`,
        );
        params.push(
          randomUUID(), // id
          numero, // numero
          titulo, // titulo
          dataInicio, // data_inicio
          dataFim, // data_fim
          status, // status
          tenant.siteId, // site_id
          tenant.userId, // elaborador_id
          tenant.companyId, // company_id
        );
        p += 9;
      }

      await pool.query(
        `INSERT INTO aprs (id, numero, titulo, data_inicio, data_fim, status, site_id, elaborador_id, company_id, created_at, updated_at)
         VALUES ${valuePlaceholders.join(',')}`,
        params,
      );

      inserted += batchSize;
      globalCounter += batchSize;
    }

    if ((tenant.tenantIndex + 1) % 10 === 0) {
      const pct = ((globalCounter / total) * 100).toFixed(0);
      process.stdout.write(
        `   ${globalCounter.toLocaleString()}/${total.toLocaleString()} APRs (${pct}%)\n`,
      );
    }
  }
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.env.LOAD_TEST_ALLOW_SEED !== 'true') {
    console.error(
      '[seed-tenants] BLOQUEADO: defina LOAD_TEST_ALLOW_SEED=true para executar contra este banco.',
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const cleanOnly = args.includes('--clean');

  const pool = new Pool({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5433),
    database:
      process.env.DATABASE_NAME || process.env.POSTGRES_DB || 'minha-api',
    user: process.env.DATABASE_USER || process.env.POSTGRES_USER || 'postgres',
    password:
      process.env.DATABASE_PASSWORD ||
      process.env.POSTGRES_PASSWORD ||
      'postgres',
    connectionTimeoutMillis: 5000,
  });

  console.log('\n=== Seed de Carga K6 ===');
  if (dryRun)
    console.log('⚠  Modo --dry-run: nenhum dado será escrito no banco.');
  if (cleanOnly) console.log('⚠  Modo --clean: apenas limpeza, sem criação.');

  try {
    // Verifica conectividade
    await pool.query('SELECT 1');
    console.log('✓  Banco de dados acessível.');

    await cleanLoadTestData(pool);

    if (cleanOnly) {
      console.log('\n✓  Limpeza concluída.\n');
      return;
    }

    const profileId = await resolveAdminProfileId(pool);

    console.log('⟳  Gerando hash de senha (bcrypt 10 rounds)...');
    const passwordHash = dryRun
      ? 'DRY_RUN_HASH'
      : await hash(TEST_PASSWORD, 10);

    const startedAt = Date.now();
    const tenants = await createTenants(pool, profileId, passwordHash, dryRun);
    await bulkInsertAprs(pool, tenants, dryRun);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    // Salva credenciais
    const outputPath = path.join(__dirname, 'tenants.json');
    if (!dryRun) {
      writeFileSync(outputPath, JSON.stringify(tenants, null, 2), 'utf-8');
    }

    console.log('\n' + '─'.repeat(50));
    console.log(`✓  Seed concluído em ${elapsed}s`);
    console.log(`   Tenants criados      : ${TENANT_COUNT}`);
    console.log(`   APRs por tenant      : ${APRS_PER_TENANT}`);
    console.log(
      `   Total APRs           : ${(TENANT_COUNT * APRS_PER_TENANT).toLocaleString()}`,
    );
    console.log(
      `   Credenciais salvas em: ${dryRun ? '(--dry-run, não salvo)' : outputPath}`,
    );
    console.log('─'.repeat(50));
    console.log('\nPróximo passo:');
    console.log(
      '  k6 run test/load/k6-load-test.js -e BASE_URL=http://localhost:3001\n',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('\n✗  Erro no seed:', msg);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
