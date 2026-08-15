# SGS APR — Fase 4.2 — Fechamento dos failures do CI

## Escopo

Esta rodada trata exclusivamente os dois blockers observados na execução real
da Fase 4 adversarial:

- `F42-SCHEMA-01`: drift do schema de integridade de assinatura APR.
- `F42-LOCK-01`: `55P03` não tratado durante lock `FOR UPDATE NOWAIT`.

O veredito permanece `APR SECURITY PARTIALLY VERIFIED` até a nova execução
E2E terminar verde e os demais gates da Fase 4 serem reavaliados.

## Run anterior

- Run: [31563591133](https://github.com/wandersongandra/sgsseguranca/actions/runs/31563591133)
- SHA: `6770bb97d9ea457a5b3175d604f3dde1d053411a`
- Backend lint/test/build: passou.
- Frontend lint/test/build: passou.
- DR/migrations com PostgreSQL real: passou.
- `Backend E2E Critical Flows`: falhou.
- Resultado Jest: 18 suítes, 16 passadas e 2 falhas; 157 testes, 140 passados,
  16 falhos e 1 todo.

### Causas agrupadas

1. A suíte adversarial consultou `signatures.content_hash`, mas a coluna não
   existia no banco reconstruído.
2. O lock APR emitia `55P03` cru. No SHA executado, o workflow ainda não
   traduzia o conflito para uma resposta de domínio; os requests cross-site
   chegaram ao lock porque o filtro de obra também não estava versionado.

## F42-SCHEMA-01

### Root cause

A migration `1709000000375-add-apr-signature-content-integrity.ts` existia
somente como arquivo não versionado no worktree. O build local compilava o
arquivo em `backend/dist`, mas o checkout do GitHub Actions no SHA
`6770bb97` não o possuía. O job E2E reconstruía corretamente um banco vazio a
partir do checkout recebido, portanto a tabela `signatures` não tinha as
quatro colunas esperadas.

O job DR passou porque usa outro banco descartável e executa as migrations do
próprio checkout; o sucesso do DR não compartilha estado com o job E2E.

### Correção

- Versionar a migration `AddAprSignatureContentIntegrity1709000000375`.
- Manter `synchronize = false` na configuração de migrations.
- Preservar assinaturas legadas com as novas colunas `NULL`.
- Adicionar gate SQL no job E2E após `npm run migration:run` e antes do Jest.
  O gate imprime banco/schema/contagem, exige o registro da migration e falha
  se faltar qualquer coluna:

  - `content_hash varchar(64)`
  - `hash_algorithm varchar(32)`
  - `canonicalization_version integer`
  - `integrity_scheme varchar(32)`

### Evidência local

- `npm run ci:migration:check`: 297 migrations detectadas.
- `npm run build`: passou e compilou a migration.
- Testes de integridade e assinatura: passaram.
- Confirmação PostgreSQL das quatro colunas: pendente da nova execução CI,
  pois Docker/PostgreSQL não está disponível neste checkout local.

## F42-LOCK-01

### Endpoint e SQL

- Serviço: `AprWorkflowService.executeAprWorkflowTransition`.
- Lock: `SELECT ... FROM aprs ... FOR UPDATE NOWAIT`.
- SQLSTATE: `55P03` (`lock_not_available`).

### Correção

- Preservar `FOR UPDATE NOWAIT`.
- Aplicar escopo de tenant, obra e `deleted_at IS NULL` no lock.
- Reconhecer o código tanto no erro TypeORM quanto em
  `error.driverError.code`.
- Fazer no máximo três retries curtos (`50/100/200 ms`).
- Após esgotar as tentativas, retornar `409 Conflict` com mensagem segura,
  sem SQLSTATE, SQL ou stack no corpo HTTP.
- Registrar somente `aprId`, tentativa e duração no log técnico.

### Evidência local

- Teste unitário com `driverError.code = 55P03`: 4 tentativas e
  `ConflictException`.
- Teste E2E adicionado com PostgreSQL real: uma transação mantém a APR
  bloqueada, o segundo request deve receber `409`, e o status permanece
  `Pendente` antes e depois da liberação do lock.
- Suites unitárias backend: 286 suites / 2450 testes passaram em dois shards.

## Antes / depois

```text
ANTES
checkout sem migration 0375
  -> banco E2E sem content_hash
  -> falha de schema durante a prova

ANTES
transação A segura APR
  -> transação B NOWAIT
  -> 55P03 cru / cascata de falhas

DEPOIS
checkout contém migration 0375
  -> migration:run
  -> schema gate confirma 4 colunas e migration registrada
  -> Jest adversarial executa

DEPOIS
transação A segura APR
  -> transação B NOWAIT
  -> retry limitado
  -> 409 seguro ou sucesso posterior
  -> banco permanece consistente
```

## Fechamento

## Execução controlada posterior

No ambiente sintético da VPS, a prova foi reexecutada com schema migrado:

- E2E adversarial APR: **5/5 testes aprovados** (cross-site, mutação,
  workflow, assinatura, integridade/hash e lock `55P03 -> 409`).
- Carga controlada: **100 APRs** emitidas e finalizadas; `status=Encerrada`,
  100 hashes finais, 1 `company_id` e 1 `site_id` sintéticos.
- Health da API de teste: `/health/public`, `/health/ready` e `/health` em
  HTTP 200.
- `VALIDATION_TOKEN_SECRET` foi provisionado somente no `.env.loadtest` da
  VPS com valor sintético não reutilizado em produção.

## Gap de schema remanescente

`Inspection` (`backend/src/shared/entities/inspection.entity.ts`) é consumida
por assinaturas e dashboards, porém não há migration de criação de
`public.inspections` neste checkout. As migrations `214` e `352` apenas
referenciam/ajustam uma tabela que existe em alguns ambientes históricos.
Não foi criada uma tabela especulativa: é necessário recuperar o contrato e o
DDL de origem antes de habilitar qualquer fluxo que dependa dela em um banco
reconstruído.

Com os gates executados acima, o fluxo APR sintético está operacional e
adversarialmente validado; o veredito global permanece condicionado à
reconciliação formal de `inspections` e à revisão/commit separado das mudanças
do worktree antes de qualquer publicação.
