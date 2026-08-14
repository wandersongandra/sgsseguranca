# 📖 Runbook de Produção - Wanderson Gandra

## 1. STARTUP & HEALTH CHECKS

### 1.1 Iniciar Sistema
```bash
# Verificar status dos containers
docker-compose ps

# Iniciar sistema
docker-compose up -d

# Verificar logs
docker-compose logs -f api

# Testar health check
curl http://localhost:3001/health
curl http://localhost:3001/health/detailed
```

### 1.2 Verificações Pré-Produção
```bash
# 1. Database connectivity
docker-compose exec db psql -U sst_user -d sst -c "SELECT 1"

# 2. Redis connectivity
docker-compose exec redis redis-cli -a $REDIS_PASSWORD ping

# 3. API responsiveness
curl -I http://localhost:3001/api

# 4. Migrations status
docker-compose exec api npm run migration:show

# 5. SSL certificate validity
openssl x509 -in backend/certbot/conf/live/seu-dominio.com/fullchain.pem -noout -dates
```

---

## 2. MONITORAMENTO

### 2.1 Métricas em Tempo Real
```bash
# CPU e Memória
docker stats

# Conexões ativas do banco
docker-compose exec db psql -U sst_user -d sst -c "SELECT count(*) FROM pg_stat_activity"

# Tamanho do banco
docker-compose exec db psql -U sst_user -d sst -c "SELECT pg_size_pretty(pg_database_size('sst'))"

# Tamanho do Redis
docker-compose exec redis redis-cli -a $REDIS_PASSWORD info memory

# Fila de jobs (BullMQ)
curl http://localhost:3001/bull-board
```

### 2.2 Logs Estruturados
```bash
# Logs em tempo real
docker-compose logs -f api

# Últimas 100 linhas
docker-compose logs --tail=100 api

# Filtrar por erro
docker-compose logs api | grep ERROR

# Filtrar por request ID
docker-compose logs api | grep "request-id-xyz"
```

### 2.3 Alertas Críticos
```bash
# Monitorar taxa de erro
docker-compose logs api | grep "ERROR" | wc -l

# Monitorar latência
docker-compose logs api | grep "duration" | tail -20

# Monitorar conexões
docker-compose exec db psql -U sst_user -d sst -c "SELECT count(*) FROM pg_stat_activity WHERE state='active'"
```

---

## 3. TROUBLESHOOTING

### 3.1 API não inicia
```bash
# Ver logs detalhados
docker-compose logs api

# Verificar variáveis de ambiente
docker-compose exec api env | grep -E "JWT|DATABASE|REDIS"

# Verificar porta em uso
lsof -i :3001

# Reiniciar container
docker-compose restart api
```

### 3.2 Erro de conexão com Database
```bash
# Verificar se DB está rodando
docker-compose ps db

# Testar conexão
docker-compose exec db psql -U sst_user -d sst -c "SELECT 1"

# Ver logs do DB
docker-compose logs db

# Reiniciar DB
docker-compose restart db

# Verificar espaço em disco
docker-compose exec db df -h
```

### 3.3 Erro de conexão com Redis
```bash
# Verificar se Redis está rodando
docker-compose ps redis

# Testar conexão
docker-compose exec redis redis-cli -a $REDIS_PASSWORD ping

# Ver logs do Redis
docker-compose logs redis

# Reiniciar Redis
docker-compose restart redis

# Verificar memória
docker-compose exec redis redis-cli -a $REDIS_PASSWORD info memory
```

### 3.4 Lentidão da API
```bash
# 1. Verificar CPU
docker stats api

# 2. Verificar memória
docker-compose exec api ps aux | grep node

# 3. Verificar queries lentas
docker-compose exec db psql -U sst_user -d sst -c "SELECT query, calls, mean_time FROM pg_stat_statements ORDER BY mean_time DESC LIMIT 10"

# 4. Verificar índices
docker-compose exec db psql -U sst_user -d sst -c "SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0"

# 5. Aumentar recursos
# Editar docker-compose.yml e aumentar limits
docker-compose up -d --build
```

### 3.5 Fila de jobs travada
```bash
# Ver status da fila
curl http://localhost:3001/bull-board

# Contar jobs na fila
docker-compose exec redis redis-cli -a $REDIS_PASSWORD LLEN bull:pdf-queue:wait

# Limpar fila (CUIDADO!)
docker-compose exec redis redis-cli -a $REDIS_PASSWORD DEL bull:pdf-queue:wait

# Reiniciar workers
docker-compose restart worker
```

---

## 4. BACKUP & RESTORE

### 4.1 Backup Manual
```bash
# Fazer backup
docker-compose exec api /app/scripts/backup-database.sh

# Listar backups
ls -lh /backups/

# Verificar integridade
gunzip -t /backups/db_backup_*.sql.gz
```

### 4.2 Restore Manual
```bash
# 1. Parar API
docker-compose stop api

# 2. Restaurar backup
gunzip -c /backups/db_backup_20260224_020000.sql.gz | \
  docker-compose exec -T db psql -U sst_user -d sst

# 3. Iniciar API
docker-compose start api

# 4. Verificar
curl http://localhost:3001/health
```

### 4.3 Disaster Recovery Test
```bash
# Executar teste de DR
chmod +x backend/scripts/disaster-recovery-test.sh
./backend/scripts/disaster-recovery-test.sh

# Verificar relatório
cat dr_test_report_*.txt
```

### 4.4 Validação da Cadeia de Migrations (DR zero-to-schema)

Última validação: 2026-07-24 — 283 migrations — OK

Ambiente validado: PostgreSQL 16.14 limpo, topologia de roles equivalente à produção.

#### Resultado

| Critério | Resultado |
| --- | --- |
| Total de migrations aplicadas | **283 de 283** (exit code 0) |
| Migration mais antiga | `InitialSchema1699000000000` |
| Migration mais recente | `RevokeRlsBypassFromSgsApp1709000000361` |
| Índice crítico `idx_checklists_company_modelos_created` | **CRIADO** |
| Tabelas com RLS enabled + FORCE | **93 tabelas** (1 exceção intencional: consent_versions) |
| Políticas RLS totais | **258 policies** |
| Matviews com índices | **2** (company_dashboard_metrics, apr_risk_rankings) |
| `sgs_app` possui BYPASSRLS | **f** (correto — hardening migration 361 ativo) |
| `sgs_app` membro de sgs_rls_bypass | **f** (correto — migration 361 revogou) |
| Audit checks (integridade + cross-tenant + FK) | **Todos 0 — limpo** |
| Cache hit ratio | 99,79% |
| Partições mail_logs | 19 mensais + default (abr/2026 a ago/2027) |
| Partições ai_interactions | 24 mensais + default (abr/2026 a mar/2028) |
| Tempo total de recovery (migrations) | ~2 min |

#### Advertências conhecidas (não bloqueantes)

- **3 pares de índices duplicados detectados** pelo audit check 7.4 em `rdos`, `photographic_report_days` e `photographic_report_images` — pré-existentes, fora do escopo da migration 350. Candidatos a remoção em janela de manutenção.
- **audit_logs** não foi particionado (a migration 091 detectou divergência de schema e pulou) — comportamento esperado; particionamento de audit_logs requer migração dedicada com schema expandido.
- **consent_versions** tem `FORCE ROW LEVEL SECURITY = false` — intencional por design (migration 356): tabela de catálogo lida mesmo sem contexto de tenant.

#### Procedimento de replicação

```bash
# 1. Criar PostgreSQL 16 limpo (equivalente Neon)
psql -U postgres -c "
  CREATE ROLE neondb_owner LOGIN PASSWORD '<senha>' SUPERUSER;
  CREATE ROLE sgs_app LOGIN PASSWORD '<senha>' NOSUPERUSER NOBYPASSRLS;
  CREATE DATABASE sst_staging OWNER neondb_owner;
"

# 2. Build do backend (migrations rodam do dist/)
cd backend && npm run build

# 3. Rodar todas as migrations do zero
DATABASE_MIGRATION_URL=postgresql://neondb_owner:<senha>@<host>:5432/sst_staging \
DATABASE_SSL=false \
NODE_ENV=development \
node scripts/run-migrations.js 2>&1 | tee migration_$(date +%Y%m%d).log

# 4. Verificar contagem final
psql ... -c "SELECT COUNT(*) FROM migrations;"   -- esperado: 287

# 5. Validação de integridade
psql ... -f backend/scripts/db-audit-checks.sql

# 6. Confirmar índice crítico
psql ... -c "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_checklists_company_modelos_created';"
```

---

### 4.5 Janela de Produção — Hardening RLS (migration 361)

Data: 2026-07-25 | Operador: wandersongandra (antigo @complianceX) via Claude Code

#### Ações executadas

1. PRs #157 e #158 mergeados e deployados (web + worker)
2. Role `sgs_admin` criada no Neon com `GRANT sgs_rls_bypass TO sgs_admin`
3. `DATABASE_ADMIN_URL` configurada no Coolify para web e worker
4. Migration 361 (`REVOKE sgs_rls_bypass FROM sgs_app`) aplicada via `npm run migration:run`

#### Evidências

| Critério | Resultado |
| --- | --- |
| `pg_has_role('sgs_app', 'sgs_rls_bypass', 'member')` | **f** — sgs_app não tem mais bypass |
| `pg_has_role('sgs_admin', 'sgs_rls_bypass', 'member')` | **t** — conexão privilegiada operacional |
| `GET /health/public` pós-REVOKE | **200 ok** |
| Worker processando filas após deploy | **Sim** — QueueMonitorService ativo |
| `GET /health/detailed` (requer auth) | **401** — correto, guard ativo |

#### Plano de rollback (< 1 min)

```bash
# Rodar como neondb_owner via DATABASE_MIGRATION_URL:
psql "$DATABASE_MIGRATION_URL" -c "GRANT sgs_rls_bypass TO sgs_app;"
# Conexões existentes precisam de novo connect() para efetivar — reiniciar os containers.
```

### 4.6 Validação DR pós-review da PR #158

Data: 2026-07-26 | PR: #170 | Run: `30224986759` | Job: `89854165870`

O review tardio identificou que apenas a descoberta de empresas permanecia em
`sgs_admin`; as leituras que montavam o payload voltavam para o DataSource
comum. A PR #170 mantém o mesmo cliente privilegiado em todas as leituras do
payload, dentro de um snapshot `REPEATABLE READ READ ONLY`, e exclui partições
filhas do inventário para não duplicar linhas já lidas pelas tabelas-pai.

#### Evidência controlada em PostgreSQL 16 limpo

| Critério | Resultado |
| --- | --- |
| Cadeia reconstruída por migrations | **286 de 286 — success** |
| Schema version no backup | `FixCompaniesRlsSuperAdminFlag1709000000364` |
| `sgs_app` membro de `sgs_rls_bypass` | **false** |
| `sgs_admin` membro de `sgs_rls_bypass` | **true** |
| Exportação via `DATABASE_ADMIN_URL` | **true** |
| Tabelas com RLS + FORCE | **133** |
| Policies RLS | **259** |
| Índices | **940** |
| Materialized views consultáveis | **2** |
| APRs órfãs após restore | **0** |
| APRs com site cross-tenant após restore | **0** |
| Partições-filhas no payload | **0** |
| Arquivo de backup | **3.694 bytes**, não vazio |
| Arquivo de metadata | **1.863 bytes**, não vazio |
| Checksum metadata/payload | **igual** |
| Linhas principais exportadas/restauradas | companies **1**, sites **1**, users **4**, aprs **1**, forensic_trail_events **5** |

#### Medições controladas

| Medição | Observado | Meta |
| --- | ---: | ---: |
| Geração do backup de tenant | **549 ms** | — |
| Restore do tenant | **240 ms** | RTO 4 h |
| Frescor do backup na validação | **643 ms** | RPO 24 h |
| Build + reconstrução por migrations | **30 s** | — |
| Job completo, incluindo instalação e containers | **3 min 44 s** | — |

Artefato do CI: `backend-dr-e2e-evidence` (retenção de 14 dias), contendo
`dr-e2e-evidence.json` e `dr-db-structural-evidence.txt`.

#### Limite da evidência

Esta execução comprova o fluxo sobre dados sintéticos e schema reconstruído em
PostgreSQL limpo. Ela **não** substitui o ensaio operacional com um backup de
tenant de produção pós-migration 361. Esse ensaio só pode ocorrer após
merge/deploy da PR #170 e deve restaurar o artefato em ambiente isolado, com
acesso restrito e sem transportar dados pessoais para artefatos públicos de CI.
Até esse ensaio, o RTO/RPO acima são medições sintéticas, não SLO comprovado de
produção.

### 4.7 Ensaio operacional final pós-REVOKE

Data: 2026-07-27 | PR final: #196 | SHA implantado:
`6c1c40815167f43c05ad7affd2df8f53d3dd7282` | CI `30298664977`

O ensaio foi executado com backups reais de todos os tenants ativos depois da
migration 365 e do deploy do mesmo SHA no web e no worker. Nenhum identificador
de tenant ou dado pessoal foi publicado em artefatos de CI.

#### Backups definitivos

| Tenant anonimizado | Backup ID | Tabelas | Tabelas não vazias | Linhas | Artefato |
| --- | --- | ---: | ---: | ---: | ---: |
| T1 | `tenant-20260727-195413-b8124573` | 60 | 12 | 421 | 76.022 bytes |
| T2 | `tenant-20260727-195442-8b427e6c` | 72 | 55 | 44.432 | 26.009.096 bytes |
| T3 | `tenant-20260727-195519-85017f7a` | 60 | 13 | 497 | 291.934 bytes |
| T4 | `tenant-20260727-195545-45710c9a` | 68 | 44 | 91.362 | 54.767.156 bytes |
| T5 | `tenant-20260727-195624-bb98cab3` | 60 | 11 | 415 | 73.952 bytes |

Tempo do lote: **157.435 ms**. Os cinco arquivos foram descompactados,
descriptografados e validados: envelope AES-256-GCM v1, IV de 12 bytes, tag de
16 bytes e checksum SHA-256 do payload igual ao metadata em **5/5**. A versão de
schema gravada em todos foi
`AllowPrivilegedConsentVersionRestore1709000000365`.

#### Restore em PostgreSQL limpo

O banco temporário `sgs_dr_verify_20260727_1643` foi criado vazio e reconstruído
exclusivamente pela cadeia de migrations. O Neon confirmou as migrations em
duas invocações retomáveis (252 + 35), sem dados de empresa entre elas. Antes do
restore: **287 migrations, migration 365 como última e zero empresas**.

O maior backup (T4) foi restaurado como clone isolado usando `sgs_app` na
conexão comum e `sgs_admin` no `PrivilegedDbService`.

| Critério | Resultado |
| --- | --- |
| Tabelas restauradas | **67** |
| Linhas restauradas após reconciliação global | **91.278** |
| `roles` / `permissions` reconciliados por chave natural | **0 / 2 inseridos** |
| `consent_versions` reconciliados | **2** |
| `document_registry` / versões | **34 / 54** |
| `forensic_trail_events` | **3.809** |
| `users` | **88**, incluindo 1 placeholder histórico anonimizado |

#### Segurança, estrutura e integridade

| Critério | Resultado |
| --- | --- |
| Tabelas com RLS habilitado / FORCE | **134 / 133** |
| Policies RLS | **262** |
| Policies de `consent_versions` | **4** |
| Índices | **940** |
| Materialized views consultáveis | **2/2** |
| `sgs_app` / `sgs_admin` com `sgs_rls_bypass` | **false / true** |
| Probe `sgs_app` sem contexto / tenant próprio / tenant alheio | **0 / 1 / 0** |
| Relações `company_id` verificadas / linhas cross-tenant | **125 / 0** |
| APRs órfãs / APR-site cross-tenant | **0 / 0** |
| Placeholder histórico sem e-mail, CPF, senha e login | **1/1** |
| Documentos restaurados presentes / hash igual | **34/34 / 34/34** |

A única constraint `NOT VALID` é
`pts.CHK_pts_data_hora_validas`, deliberadamente criada assim pela migration
312 para não bloquear dados legados. Ela não representa falha do restore.

Durante a verificação foi encontrada uma lacuna anterior ao restore: 28
referências ativas apontavam para objetos que nunca chegaram ao bucket e não
possuíam versão recuperável no B2. Os documentos foram reconstruídos a partir
dos registros canônicos, com aviso de reconstrução embutido, hash novo, nova
versão no registry e evento forense, sem fabricar aprovações ou assinaturas.
Após a correção, a produção ficou com **54/54 objetos presentes e 54/54 hashes
válidos**; o restore do tenant ensaiado confirmou **34/34**.

Quatro execuções históricas órfãs em estado `running` (todas com mais de seis
horas) foram reconciliadas para `failed` com evento forense. Nenhuma execução
ativa recente foi alterada.

#### RTO e RPO observados

| Medição | Observado | Meta | Resultado |
| --- | ---: | ---: | --- |
| Reconstrução por migrations | **18m31s** | — | medido no Neon |
| Restore do maior tenant | **2m22s** | — | success |
| Validação estrutural + B2 | **41s** | — | success |
| RTO ponta a ponta | **21m34s** | **4h** | **atendido** |
| RPO no início do restore | **28m38s** | **24h** | **atendido** |

Conclusão: o Disaster Recovery pós-REVOKE está operacionalmente validado. O
papel comum permanece fail-closed e o backup/restore usa a conexão privilegiada
somente nos caminhos administrativos previstos.

---

## 5. DEPLOYMENT

### 5.1 Deploy de Nova Versão
```bash
# 1. Backup antes de atualizar
docker-compose exec api /app/scripts/backup-database.sh

# 2. Pull do código
git pull origin main

# 3. Rebuild e restart
docker-compose up -d --build

# 4. Executar migrações
docker-compose exec api npm run migration:run

# 5. Verificar
docker-compose logs -f api
curl http://localhost:3001/health
```

### 5.2 Rollback
```bash
# 1. Parar containers
docker-compose down

# 2. Voltar para versão anterior
git checkout <commit-anterior>

# 3. Rebuild
docker-compose up -d --build

# 4. Restaurar backup (se necessário)
gunzip -c /backups/db_backup_*.sql.gz | \
  docker-compose exec -T db psql -U sst_user -d sst

# 5. Verificar
curl http://localhost:3001/health
```

---

## 6. PERFORMANCE TUNING

### 6.1 Otimizar Database
```bash
# Analisar tabelas
docker-compose exec db psql -U sst_user -d sst -c "ANALYZE"

# Reindex
docker-compose exec db psql -U sst_user -d sst -c "REINDEX DATABASE sst"

# Vacuum
docker-compose exec db psql -U sst_user -d sst -c "VACUUM ANALYZE"
```

### 6.2 Otimizar Redis
```bash
# Ver memória usada
docker-compose exec redis redis-cli -a $REDIS_PASSWORD info memory

# Limpar chaves expiradas
docker-compose exec redis redis-cli -a $REDIS_PASSWORD BGSAVE

# Monitorar comandos lentos
docker-compose exec redis redis-cli -a $REDIS_PASSWORD SLOWLOG GET 10
```

### 6.3 Otimizar API
```bash
# Aumentar worker threads
# Editar docker-compose.yml: NODE_OPTIONS=--max-old-space-size=1024

# Aumentar pool de conexões
# Editar .env: DB_POOL_SIZE=20

# Ativar compression
# Já ativado em main.ts

# Monitorar heap
docker-compose exec api node -e "console.log(require('v8').getHeapStatistics())"
```

---

## 7. SEGURANÇA

### 7.1 Verificar SSL/TLS
```bash
# Testar HTTPS
curl -I https://seu-dominio.com

# Verificar certificado
openssl s_client -connect seu-dominio.com:443

# Verificar headers de segurança
curl -I https://seu-dominio.com | grep -E "Strict-Transport|X-Frame|X-Content"
```

### 7.2 Verificar Rate Limiting
```bash
# Fazer múltiplas requisições
for i in {1..100}; do curl http://localhost:3001/auth/login; done

# Verificar se foi bloqueado (429)
```

### 7.3 Verificar Auditoria
```bash
# Ver logs de auditoria
docker-compose exec db psql -U sst_user -d sst -c "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 20"

# Ver incidentes de segurança
docker-compose exec db psql -U sst_user -d sst -c "SELECT * FROM security_incidents ORDER BY created_at DESC LIMIT 20"
```

---

## 8. ESCALABILIDADE

### 8.1 Testes de Carga
```bash
# Credenciais reais obrigatórias para fluxos autenticados
export K6_LOGIN_CPF=00000000000
export K6_LOGIN_PASSWORD='senha-real'

# Opcional para admin geral / troca explicita de tenant
export K6_COMPANY_ID=00000000-0000-0000-0000-000000000000

# Smoke test (auth + dashboard + upload/PDF opcionais)
npm run loadtest:smoke

# Baseline (fluxos reais do dashboard e fila de PDF)
npm run loadtest:baseline

# Stress test (aumenta carga mantendo contrato real da API)
npm run loadtest:stress
```

### 8.2 Escalar Horizontalmente
```bash
# Aumentar réplicas da API
# Editar docker-compose.yml ou k8s deployment

# Aumentar workers
# Editar KEDA scaledobject.yaml

# Aumentar pool de conexões
# Editar .env: DB_POOL_SIZE
```

---

## 9. INCIDENTES

### 9.1 Resposta a Incidente
```bash
# 1. Preservar evidências
docker-compose logs > incident_logs_$(date +%Y%m%d_%H%M%S).txt

# 2. Isolar o sistema (se necessário)
docker-compose down

# 3. Investigar
# - Verificar logs
# - Verificar métricas
# - Verificar auditoria

# 4. Remediar
# - Aplicar patch
# - Restaurar backup
# - Reiniciar serviços

# 5. Documentar
# - Criar issue no GitHub
# - Documentar causa raiz
# - Implementar prevenção
```

### 9.2 Contatos de Emergência
- **DevOps Lead:** [contato]
- **Security Team:** [contato]
- **Database Admin:** [contato]

---

## 10. CHECKLIST DIÁRIO

- [ ] Verificar health check
- [ ] Verificar logs de erro
- [ ] Verificar taxa de erro
- [ ] Verificar latência da API
- [ ] Verificar espaço em disco
- [ ] Verificar conexões ativas
- [ ] Verificar fila de jobs
- [ ] Verificar backup status

---

**Última atualização:** 2026-02-24
**Versão:** 1.0
