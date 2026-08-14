/**
 * Análise crítica READ-ONLY do banco (Neon Postgres).
 * Carrega credenciais de backend/.env sem imprimir segredos.
 * Cada query roda em try/catch — falhas de permissão são reportadas, não fatais.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const url =
  process.env.DATABASE_URL ||
  process.env.DATABASE_MIGRATION_URL ||
  process.env.DATABASE_DIRECT_URL;

if (!url) {
  console.error('Nenhuma DATABASE_URL encontrada no .env');
  process.exit(1);
}

// Sanity: nunca imprimir a URL. Só o host (sem credenciais) para identificar o ambiente.
try {
  const u = new URL(url);
  console.log(`# Conectando em host: ${u.hostname} db: ${u.pathname.slice(1)} user: ${u.username}`);
} catch {}

const QUERIES = [
  {
    name: '01_versao_e_tamanho',
    sql: `SELECT current_database() AS db, version() AS version,
            pg_size_pretty(pg_database_size(current_database())) AS db_size,
            pg_database_size(current_database()) AS db_size_bytes`,
  },
  {
    name: '02_schemas',
    sql: `SELECT n.nspname AS schema, count(c.oid) FILTER (WHERE c.relkind='r') AS tables,
                 count(*) FILTER (WHERE c.relkind='i') AS indexes,
                 count(*) FILTER (WHERE c.relkind IN ('v','m')) AS views
          FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid
          WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
          GROUP BY 1 ORDER BY 1`,
  },
  {
    name: '03_tabelas_tamanho_linhas',
    sql: `SELECT schemaname, relname AS table,
            n_live_tup AS est_rows, n_dead_tup AS dead_rows,
            pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
            pg_total_relation_size(relid) AS total_bytes,
            pg_size_pretty(pg_relation_size(relid)) AS table_size,
            pg_size_pretty(pg_indexes_size(relid)) AS indexes_size,
            seq_scan, idx_scan,
            last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
          FROM pg_stat_user_tables
          ORDER BY pg_total_relation_size(relid) DESC`,
  },
  {
    name: '04_rls_status',
    sql: `SELECT n.nspname AS schema, c.relname AS table,
            c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
            (SELECT count(*) FROM pg_policies p WHERE p.schemaname=n.nspname AND p.tablename=c.relname) AS policy_count
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
          ORDER BY c.relrowsecurity, n.nspname, c.relname`,
  },
  {
    name: '05_indices_nao_usados',
    sql: `SELECT s.schemaname, s.relname AS table, s.indexrelname AS index,
            s.idx_scan, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
            pg_relation_size(s.indexrelid) AS size_bytes
          FROM pg_stat_user_indexes s
          JOIN pg_index i ON i.indexrelid = s.indexrelid
          WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
          ORDER BY pg_relation_size(s.indexrelid) DESC`,
  },
  {
    name: '06_indices_duplicados',
    sql: `SELECT pg_size_pretty(sum(pg_relation_size(idx))::bigint) AS total_size,
            (array_agg(idx))[1] AS idx1, (array_agg(idx))[2] AS idx2,
            (array_agg(idx))[3] AS idx3, (array_agg(idx))[4] AS idx4
          FROM (
            SELECT indexrelid::regclass AS idx,
                   (indrelid::text || E'\\n' || indclass::text || E'\\n' || indkey::text || E'\\n' ||
                    coalesce(indexprs::text,'') || E'\\n' || coalesce(indpred::text,'')) AS key
            FROM pg_index
          ) sub
          GROUP BY key HAVING count(*) > 1 ORDER BY sum(pg_relation_size(idx)) DESC`,
  },
  {
    name: '07_fks_sem_indice',
    sql: `SELECT conrelid::regclass AS table, conname AS fk, pg_get_constraintdef(oid) AS def
          FROM pg_constraint c
          WHERE contype='f'
            AND NOT EXISTS (
              SELECT 1 FROM pg_index i
              WHERE i.indrelid = c.conrelid
                AND (i.indkey::int2[])[0:array_length(c.conkey,1)-1] @> c.conkey::int2[]
            )
            AND connamespace NOT IN ('pg_catalog'::regnamespace)
          ORDER BY 1`,
  },
  {
    name: '08_seq_scan_vs_idx_scan',
    sql: `SELECT schemaname, relname AS table, seq_scan, idx_scan,
            CASE WHEN seq_scan+idx_scan = 0 THEN NULL
                 ELSE round(100.0*seq_scan/(seq_scan+idx_scan),1) END AS seq_pct,
            n_live_tup AS est_rows,
            pg_size_pretty(pg_relation_size(relid)) AS size
          FROM pg_stat_user_tables
          WHERE seq_scan > 100 AND n_live_tup > 1000
          ORDER BY seq_scan DESC LIMIT 40`,
  },
  {
    name: '09_cache_hit_ratio',
    sql: `SELECT 'index' AS tipo, round(100.0*sum(idx_blks_hit)/nullif(sum(idx_blks_hit)+sum(idx_blks_read),0),2) AS hit_pct
          FROM pg_statio_user_indexes
          UNION ALL
          SELECT 'table', round(100.0*sum(heap_blks_hit)/nullif(sum(heap_blks_hit)+sum(heap_blks_read),0),2)
          FROM pg_statio_user_tables`,
  },
  {
    name: '10_dead_tuples_top',
    sql: `SELECT schemaname, relname AS table, n_dead_tup, n_live_tup,
            CASE WHEN n_live_tup+n_dead_tup = 0 THEN 0
                 ELSE round(100.0*n_dead_tup/(n_live_tup+n_dead_tup),1) END AS dead_pct,
            last_autovacuum, n_mod_since_analyze
          FROM pg_stat_user_tables
          WHERE n_dead_tup > 1000
          ORDER BY n_dead_tup DESC LIMIT 30`,
  },
  {
    name: '11_roles',
    sql: `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
            rolcanlogin, rolreplication, rolbypassrls, rolconnlimit
          FROM pg_roles ORDER BY rolname`,
  },
  {
    name: '12_extensoes',
    sql: `SELECT extname, extversion FROM pg_extension ORDER BY 1`,
  },
  {
    name: '13_conexoes',
    sql: `SELECT usename, application_name, state, count(*)
          FROM pg_stat_activity WHERE datname = current_database()
          GROUP BY 1,2,3 ORDER BY 4 DESC`,
  },
  {
    name: '14_tabelas_sem_pk',
    sql: `SELECT n.nspname AS schema, c.relname AS table,
            pg_size_pretty(pg_total_relation_size(c.oid)) AS size
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
            AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary)
          ORDER BY pg_total_relation_size(c.oid) DESC`,
  },
  {
    name: '15_colunas_sensiveis_criptografia',
    sql: `SELECT table_schema, table_name, column_name, data_type
          FROM information_schema.columns
          WHERE column_name ~* '(cpf|rg|password|senha|secret|token|medical|exame|totp)'
            AND table_schema NOT IN ('pg_catalog','information_schema')
          ORDER BY 1,2,3`,
  },
  {
    name: '16_politicas_rls_detalhe',
    sql: `SELECT schemaname, tablename, policyname, permissive, roles, cmd,
            left(coalesce(qual,''),80) AS qual_preview
          FROM pg_policies ORDER BY schemaname, tablename, policyname`,
  },
  {
    name: '17_migracoes_aplicadas',
    sql: `SELECT count(*) AS total_aplicadas, max(timestamp) AS ultima
          FROM migrations`,
  },
  {
    name: '18_top_queries_pg_stat_statements',
    sql: `SELECT left(query,120) AS query_preview, calls,
            round(total_exec_time::numeric,1) AS total_ms,
            round(mean_exec_time::numeric,2) AS mean_ms,
            rows
          FROM pg_stat_statements
          WHERE query NOT ILIKE '%pg_stat_statements%'
          ORDER BY total_exec_time DESC LIMIT 25`,
  },
  {
    name: '19_varchar_sem_limite_e_json',
    sql: `SELECT table_schema, table_name, column_name, data_type, character_maximum_length
          FROM information_schema.columns
          WHERE table_schema NOT IN ('pg_catalog','information_schema')
            AND (data_type = 'character varying' AND character_maximum_length IS NULL)
          ORDER BY 1,2`,
  },
  {
    name: '20_particoes_audit',
    sql: `SELECT parent.relname AS parent, count(child.oid) AS partitions
          FROM pg_class parent
          JOIN pg_inherits i ON i.inhparent = parent.oid
          JOIN pg_class child ON child.oid = i.inhrelid
          GROUP BY 1 ORDER BY 1`,
  },
  {
    name: '21_config_neon',
    sql: `SELECT name, setting FROM pg_settings
          WHERE name IN ('max_connections','shared_buffers','work_mem','effective_cache_size',
                         'random_page_cost','idle_in_transaction_session_timeout','statement_timeout',
                         'default_transaction_isolation','ssl')
          ORDER BY 1`,
  },
];

(async () => {
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  for (const q of QUERIES) {
    console.log(`\n===== ${q.name} =====`);
    try {
      // savepoint para isolar falhas de permissão dentro da transação
      await client.query('SAVEPOINT sp');
      const res = await client.query(q.sql);
      console.log(JSON.stringify(res.rows, null, 1));
      await client.query('RELEASE SAVEPOINT sp');
    } catch (e) {
      console.log(`ERRO: ${e.message}`);
      await client.query('ROLLBACK TO SAVEPOINT sp').catch(() => {});
    }
  }
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
