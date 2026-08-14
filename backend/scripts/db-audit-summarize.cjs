// Sumariza o relatório de auditoria em métricas-chave
const fs = require('fs');
const path = require('path');
const txt = fs.readFileSync(path.join(__dirname, '..', 'output', 'db-audit-report.txt'), 'utf8');

function section(name) {
  const re = new RegExp('===== ' + name + ' =====\\n([\\s\\S]*?)(?=\\n===== |$)');
  const m = txt.match(re);
  if (!m) return null;
  const body = m[1].trim();
  if (body.startsWith('ERRO')) return { erro: body };
  try { return JSON.parse(body); } catch { return { raw: body.slice(0, 500) }; }
}

// 04 RLS
const rls = section('04_rls_status');
if (Array.isArray(rls)) {
  const noRls = rls.filter(r => !r.rls_enabled);
  const noForce = rls.filter(r => r.rls_enabled && !r.rls_forced);
  const noPolicy = rls.filter(r => r.rls_enabled && Number(r.policy_count) === 0);
  console.log('== RLS ==');
  console.log('total tabelas:', rls.length);
  console.log('SEM RLS (' + noRls.length + '):', noRls.map(r => r.schema + '.' + r.table).join(', '));
  console.log('RLS sem FORCE (' + noForce.length + '):', noForce.map(r => r.table).join(', '));
  console.log('RLS sem policy (' + noPolicy.length + '):', noPolicy.map(r => r.table).join(', '));
}

// 05 unused indexes
const unused = section('05_indices_nao_usados');
if (Array.isArray(unused)) {
  const totalBytes = unused.reduce((a, r) => a + Number(r.size_bytes), 0);
  const byTable = {};
  unused.forEach(r => { byTable[r.table] = (byTable[r.table] || 0) + 1; });
  console.log('\n== INDICES NAO USADOS ==');
  console.log('total:', unused.length, '| desperdicio:', (totalBytes / 1048576).toFixed(1) + ' MB');
  console.log('top tabelas:', Object.entries(byTable).sort((a, b) => b[1] - a[1]).slice(0, 15));
  console.log('top 10 maiores:', unused.slice(0, 10).map(r => `${r.table}.${r.index} (${r.size})`));
}

// 06 dup indexes
const dups = section('06_indices_duplicados');
console.log('\n== INDICES DUPLICADOS ==', Array.isArray(dups) ? dups.length + ' grupos' : dups);
if (Array.isArray(dups)) dups.slice(0, 15).forEach(g => console.log('  ', g.total_size, [g.idx1, g.idx2, g.idx3, g.idx4].filter(Boolean).join(' = ')));

// 07 FKs sem índice
const fks = section('07_fks_sem_indice');
console.log('\n== FKS SEM INDICE ==', Array.isArray(fks) ? fks.length : fks);
if (Array.isArray(fks)) fks.slice(0, 20).forEach(f => console.log('  ', f.table, '->', f.fk));

// 08 seq scans
const seq = section('08_seq_scan_vs_idx_scan');
console.log('\n== SEQ SCANS ALTOS ==', Array.isArray(seq) ? seq.length : seq);
if (Array.isArray(seq)) seq.slice(0, 15).forEach(r => console.log(`   ${r.table}: ${r.seq_pct}% seq (${r.seq_scan} scans, ${r.est_rows} rows, ${r.size})`));

// 09 cache hit
console.log('\n== CACHE HIT ==', JSON.stringify(section('09_cache_hit_ratio')));

// 10 dead tuples
const dead = section('10_dead_tuples_top');
console.log('\n== DEAD TUPLES ==', Array.isArray(dead) ? dead.length : dead);
if (Array.isArray(dead)) dead.slice(0, 10).forEach(r => console.log(`   ${r.table}: ${r.n_dead_tup} mortas (${r.dead_pct}%), last_autovacuum=${r.last_autovacuum}`));

// 11 roles
const roles = section('11_roles');
console.log('\n== ROLES ==');
if (Array.isArray(roles)) roles.forEach(r => console.log(`   ${r.rolname}: login=${r.rolcanlogin} super=${r.rolsuper} bypassrls=${r.rolbypassrls} connlimit=${r.rolconnlimit}`));

// 13 conexões
console.log('\n== CONEXOES ==', JSON.stringify(section('13_conexoes')));

// 14 sem PK
const nopk = section('14_tabelas_sem_pk');
console.log('\n== TABELAS SEM PK ==', Array.isArray(nopk) ? nopk.map(r => r.schema + '.' + r.table + ' (' + r.size + ')').join(', ') : nopk);

// 17 migrations
console.log('\n== MIGRACOES ==', JSON.stringify(section('17_migracoes_aplicadas')));

// 18 pg_stat_statements
const pss = section('18_top_queries_pg_stat_statements');
console.log('\n== PG_STAT_STATEMENTS ==', pss && pss.erro ? pss.erro : (Array.isArray(pss) ? pss.slice(0, 10) : pss));

// 20 partições
console.log('\n== PARTICOES ==', JSON.stringify(section('20_particoes_audit')));

// 21 config
console.log('\n== CONFIG ==', JSON.stringify(section('21_config_neon')));

// 15 colunas sensíveis - resumo por tabela
const sens = section('15_colunas_sensiveis_criptografia');
if (Array.isArray(sens)) {
  const byTable = {};
  sens.forEach(r => { const k = r.table_schema + '.' + r.table_name; byTable[k] = (byTable[k] || []).concat(r.column_name); });
  console.log('\n== COLUNAS SENSIVEIS ==');
  Object.entries(byTable).forEach(([t, cols]) => console.log('  ', t, '=>', cols.join(', ')));
}

// 03 resumo tamanho
const tabs = section('03_tabelas_tamanho_linhas');
if (Array.isArray(tabs)) {
  console.log('\n== TOP 10 TABELAS POR TAMANHO ==');
  tabs.slice(0, 10).forEach(r => console.log(`   ${r.table}: ${r.total_size} (${r.est_rows} rows, idx ${r.indexes_size})`));
  const overIndexed = tabs.filter(r => Number(r.total_bytes) > 1048576 && r.indexes_size && false);
}
