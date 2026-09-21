# SGS — Notification Durable Dedupe Gate

**Data:** 03/09/2026
**Repositório:** `wandersongandra/sgsseguranca`
**Parent PR:** #343
**Parent HEAD:** `7c564a88d71e7c29449cbcbc4b002128c6e7424f`
**Branch:** `fix/notification-durable-dedupe`
**Escopo:** remediação futura de W4-P2-001, acima da product stack #343.
**Produção:** não acessada, alterada ou migrada.

## Estado

```text
Frozen Production/Cutover SHA: 03f1574ee6e82558630e82d0a50a08361f8ee6d5
Migration 0385–0402: UNCHANGED
Future Migration: 1709000000406
Historical Backfill: NO
Existing Notifications Modified: 0
W4-P2-001: OPEN — pending real PostgreSQL 17 concurrency proof
Notification Durable Dedupe Gate: BLOCKED / PENDING CI
Ready For Production: NO
```

## Decisão técnica

`Notification.dedupeKey` é nullable e físico em `dedupe_key`, com limite de
255 caracteres. Notificações normais criadas por `create()` permanecem fora da
unicidade. Somente `createDeduped()` recebe uma chave server-generated e
server-trusted.

O índice único parcial futuro é:

```text
company_id + "userId" + dedupe_key
WHERE dedupe_key IS NOT NULL AND deleted_at IS NULL
```

O nome físico de `userId` foi confirmado no schema e nas migrations existentes.
O índice antigo de consulta temporal não foi removido. Como o produto usa
soft delete e as consultas ativas excluem `deleted_at`, uma notificação
deduplicada removida pode ser recriada; o registro removido não é alterado.

`createDeduped()` usa `INSERT ... ON CONFLICT ... DO NOTHING` direcionado ao
índice parcial e lê a linha existente quando perde a corrida. O realtime é
enviado somente quando o insert retorna uma nova identidade. Conflito esperado
não vira erro 500; conflito de outra constraint não é mascarado.

## Inventário de produtores

| Produtor                                    | Identidade estável            | Chave nova                                         | Repetição                             |
| ------------------------------------------- | ----------------------------- | -------------------------------------------------- | ------------------------------------- |
| Dashboard — fila degradada                  | Sim, categoria operacional    | `dashboard:pending-queue:degraded:<período>`       | período existente de 180 min          |
| Dashboard — SLA vencido                     | Sim, categoria operacional    | `dashboard:pending-queue:sla-breached:<período>`   | período existente de 240 min          |
| Dashboard — itens críticos                  | Sim, categoria operacional    | `dashboard:pending-queue:critical:<período>`       | período existente de 240 min          |
| Dashboard — central documental degradada    | Sim, categoria operacional    | `dashboard:document-pendencies:degraded:<período>` | período existente de 180 min          |
| Dashboard — pendências documentais críticas | Sim, categoria operacional    | `dashboard:document-pendencies:critical:<período>` | período existente de 240 min          |
| DDS observability — loop de alertas         | Sim, `alert.code` server-side | `dds:observability:<alert.code>:<período>`         | `DDS_ALERTS_DEDUPE_MINUTES` existente |

Os períodos são incluídos porque esses produtores já possuem comportamento de
repetição periódica. Não são usados como filtro temporal para garantir
atomicidade. Título, mensagem, tradução, contagem e payload de apresentação
não participam da identidade. Nenhuma chave é recebida do frontend.

Todos os seis pontos de uso de `createDeduped()` foram atualizados; o método é
interno ao backend e não é superfície de API externa.

## Migration 0406

Arquivo:

```text
backend/src/infra/database/migrations/1709000000406-add-notification-durable-dedupe-key.ts
```

`up` adiciona somente a coluna nullable e cria o índice único parcial. Em
PostgreSQL usa `CREATE UNIQUE INDEX CONCURRENTLY` com `transaction = false`. Em
SQLite, usado apenas por fixtures compatíveis, usa a forma equivalente sem
`CONCURRENTLY`. `down` remove primeiro o índice e depois a coluna. A migration
não faz backfill, não remove duplicatas e não altera as migrations 0385–0402.

## Validação

```text
Focused notification/dashboard/DDS tests: PASS — 4 suites / 13 tests
Type-check: PASS
Build: PASS
Lint: PASS — 0 errors / 0 warnings
Prettier: PASS
Migration manifest: PASS — 323 files
PostgreSQL 17 UP/DOWN/UP: PENDING CI
Concurrent same-key insert: PENDING CI
Realtime single emission: PENDING CI
Cross-tenant/cross-user/different-key: PENDING CI
Soft-delete recreate: PENDING CI
```

O ambiente local Windows não possui Docker, `psql` ou `postgres`; portanto a
prova de atomicidade não foi falsamente promovida. O workflow CI adiciona um
serviço PostgreSQL 17 isolado, com guard explícito de destino de teste, cleanup
limitado à tabela fixture e sem credenciais externas.

## Segurança e limites

```text
Tenant scope: preserved through TenantService.run
Global unique collision: prevented by company_id + userId scope
Client-controlled dedupe authority: none
Realtime duplicate on conflict: prevented by created-row result
Unexpected constraint conflict: propagated
Existing notification rows backfilled: NO
Production credentials: NOT USED
Production database changed: NO
Production migration: 0
Production deploy: NO
Storage DR: unchanged / out of scope
```

## Gate final desta etapa

```text
W4-P2-001: OPEN — until PostgreSQL 17 integration job passes
Commit: NOT CREATED YET
Push: NO
PR: NOT OPEN YET
Merge: NO
```

Após a prova real verde, o relatório será atualizado com os resultados
observados e o PR stacked será preparado sobre o #343. Nenhuma operação de
produção ou cutover está autorizada por este trabalho.

PARAR.

---

## Addendum — PostgreSQL 17 concurrency proof and gate closure

**Data:** 03/09/2026
**Validated implementation HEAD:** `1a872917ef706d24466c5dc1597d8a5181e58f28`

O primeiro run remoto foi interrompido por uma incompatibilidade do harness
com o retorno do `QueryRunner`; o teste não mascarou a falha. O harness foi
corrigido e a segunda execução também ajustou a métrica para registrar somente
os eventos do cenário concorrente same-key.

```text
PostgreSQL 17 Notification Dedupe Integration: PASS
Migration 0406 UP/DOWN/UP: PASS
Concurrent same-key calls: 25
Concurrent same-key persisted rows: 1
Concurrent same-key realtime events: 1
Cross-tenant same key: PASS
Cross-user same key: PASS
Different key: PASS
Soft-delete recreation: PASS
Fixture cleanup: PASS — isolated CI database/table only
```

O run CI `33764221350` terminou com os seis jobs funcionais em sucesso:
backend lint/test/build, backend E2E crítico, backend E2E DR Restore,
PostgreSQL 17 da migration 0392, PostgreSQL 17 da deduplicação e frontend
lint/test/build. Os checks auxiliares de Snyk, label e semantic PR também
passaram; a revisão CodeRabbit foi pulada pela configuração da branch-base.

```text
W4-P2-001: CLOSED
Notification Durable Dedupe Gate: PASS — local + real PostgreSQL 17 CI
Migration 0385–0402: UNCHANGED
Historical Backfill: NO
Existing Notifications Modified: 0
Production Credentials: NOT USED
Production Database Changed: NO
Production Deploy: NO
```

O PR #344 permanece aberto, não-draft e mergeable, empilhado sobre o HEAD do
PR #343. Esta closure não autoriza merge, deploy, migration ou alteração de
produção.

```text
PR #344: OPEN
Merge: NO
Deploy: NO
Production Migration: 0
Ready For Production: NO — separate production release gate remains required
FINAL VERDICT: PASS — future notification dedupe scope
```

PARAR.
