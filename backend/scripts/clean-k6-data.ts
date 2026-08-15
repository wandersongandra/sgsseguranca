/**
 * Limpeza de dados de teste de carga k6.
 *
 * Soft-deleta registros criados pelo seed-tenants.ts (identificados por
 * razao_social LIKE 'K6_%' em companies) e em cascata: sites, users, aprs, pts.
 *
 * Uso:
 *   DATABASE_URL=... npx ts-node scripts/clean-k6-data.ts
 *   DATABASE_URL=... npx ts-node scripts/clean-k6-data.ts --dry-run
 */

import { Pool } from 'pg';

const LOAD_TEST_MARKER = 'K6_%';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[clean-k6-data] DATABASE_URL não definida.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

  try {
    await pool.query('SELECT 1');
    console.log('✓  Banco acessível.');

    // Contar registros afetados antes de deletar
    const { rows: counts } = await pool.query<{
      companies: string;
      sites: string;
      users: string;
      aprs: string;
      pts: string;
    }>(`
      SELECT
        (SELECT count(*) FROM companies WHERE razao_social LIKE $1 AND deleted_at IS NULL) AS companies,
        (SELECT count(*) FROM sites WHERE company_id IN (SELECT id FROM companies WHERE razao_social LIKE $1) AND deleted_at IS NULL) AS sites,
        (SELECT count(*) FROM users WHERE company_id IN (SELECT id FROM companies WHERE razao_social LIKE $1) AND deleted_at IS NULL) AS users,
        (SELECT count(*) FROM aprs WHERE company_id IN (SELECT id FROM companies WHERE razao_social LIKE $1) AND deleted_at IS NULL) AS aprs,
        (SELECT count(*) FROM pts WHERE company_id IN (SELECT id FROM companies WHERE razao_social LIKE $1) AND deleted_at IS NULL) AS pts
    `, [LOAD_TEST_MARKER]);

    const c = counts[0];
    console.log('\nRegistros a remover:');
    console.log(`  companies : ${c.companies}`);
    console.log(`  sites     : ${c.sites}`);
    console.log(`  users     : ${c.users}`);
    console.log(`  aprs      : ${c.aprs}`);
    console.log(`  pts       : ${c.pts}`);

    if (dryRun) {
      console.log('\n⚠  Modo --dry-run: nenhum dado foi alterado.');
      return;
    }

    const now = new Date().toISOString();
    await pool.query('BEGIN');

    // Cascata: aprs e pts primeiro (dependem de company_id e site_id)
    await pool.query(
      `UPDATE aprs SET deleted_at = $1 WHERE company_id IN (SELECT id FROM companies WHERE razao_social LIKE $2) AND deleted_at IS NULL`,
      [now, LOAD_TEST_MARKER],
    );
    await pool.query(
      `UPDATE pts SET deleted_at = $1 WHERE company_id IN (SELECT id FROM companies WHERE razao_social LIKE $2) AND deleted_at IS NULL`,
      [now, LOAD_TEST_MARKER],
    );
    await pool.query(
      `UPDATE sites SET deleted_at = $1 WHERE company_id IN (SELECT id FROM companies WHERE razao_social LIKE $2) AND deleted_at IS NULL`,
      [now, LOAD_TEST_MARKER],
    );
    await pool.query(
      `UPDATE users SET deleted_at = $1 WHERE company_id IN (SELECT id FROM companies WHERE razao_social LIKE $2) AND deleted_at IS NULL`,
      [now, LOAD_TEST_MARKER],
    );
    await pool.query(
      `UPDATE companies SET deleted_at = $1 WHERE razao_social LIKE $2 AND deleted_at IS NULL`,
      [now, LOAD_TEST_MARKER],
    );

    await pool.query('COMMIT');
    console.log('\n✓  Dados de teste k6 removidos com sucesso.');
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => undefined);
    console.error('[clean-k6-data] Erro:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
