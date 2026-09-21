# SGS — Product QA Wave 2: Critical SST Workflows

**Data da evidência:** 02/09/2026
**Repositório:** `wandersongandra/sgsseguranca`
**SHA de produção/cutover congelado:** `03f1574ee6e82558630e82d0a50a08361f8ee6d5`
**Base da Wave 2:** `ea530532f2dd1b45bf4d340b4de6bc05739b45f5` — PR #340 / Wave 1
**Branch:** `product/wave-2-sst-critical-workflows`
**Escopo:** Inspeções, APR, DDS, PT, EPI e seus fluxos críticos UI → API → autorização → tenant → workflow → persistência → assinatura/PDF → histórico → resposta/UI.
**Produção:** não acessada, não alterada, não migrada e não publicada.

## Veredito

```text
PRODUCT QA WAVE 2 GATE: PASS WITH FOLLOW-UPS
Ready For Wave 2 Review: YES
Ready For Production: NO
```

Os fluxos APR, DDS, PT e EPI possuem implementação frontend/backend rastreável,
contratos de autorização e suites permanentes. A inspeção foi mapeada para a
superfície existente de `audits`/activities/checklists/photographic-reports;
existe uma entidade legada `Inspection`, mas não há controller, service ou rota
frontend dedicada a `inspections`. Isso permanece como follow-up de produto,
não foi mascarado como uma feature independente.

Foi corrigido um defeito de integridade no EPI: a edição genérica agora é
rejeitada depois da assinatura de entrega ou da geração do PDF final. Os
fluxos formais de devolução e substituição continuam sendo os únicos caminhos
para alterar o ciclo de vida após a entrega.

O resultado é `PASS WITH FOLLOW-UPS`, não readiness de produção: Docker,
PostgreSQL/RLS e backend HTTP completo não estavam disponíveis neste worktree.
Nenhuma prova local foi promovida como runtime de produção.

## Limites e preservação

- A branch foi criada exatamente a partir de `ea530532f2dd1b45bf4d340b4de6bc05739b45f5`, sem alterar `main` ou a branch de produção.
- O checkout principal, worktrees concorrentes, alterações frontend preexistentes e `.env.coolify.local` foram preservados e não foram usados.
- Não houve acesso a VPS, Coolify, Traefik, firewall, DNS, Neon default/produção, Redis de produção, B2 primário ou Storage DR.
- Não houve deploy, restart produtivo, migration, alteração de secret, push de `main` ou merge.
- Nenhuma migration foi criada ou alterada. O manifesto permaneceu com 322 arquivos.
- Não foram impressos tokens, cookies, JWTs, credenciais, chaves, IPs, valores de ambiente ou dados de cliente.
- Foram usados somente valores sintéticos no build frontend e nos testes locais.
- O servidor Next local foi encerrado após a smoke. Arquivos de erro temporários do Playwright foram removidos individualmente; ficaram apenas diretórios vazios ignorados.

Classificação: `CONFIRMED` = observado diretamente; `INFERRED` = derivado de
código/testes; `NOT RUN` = não executado; `FOLLOW-UP` = lacuna não promovida a
PASS de produção.

## Baseline, ancestry e mudanças

```text
Base Wave 1: ea530532f2dd1b45bf4d340b4de6bc05739b45f5
Branch: product/wave-2-sst-critical-workflows
Code fix commit: f805622d — fix(product): harden signed EPI assignment edits
Code fix HEAD tested: f805622d
Final Wave 2 PR HEAD: ddf97176df0da51d2897dbdea9f4d270b9b53a7c
Final report sync after CI: documentation-only commit follows
Initial index: EMPTY
Migrations changed: 0
Dependency manifests changed: 0
Production source deploy: NO
Production database migration: 0
```

Alterações do commit focado:

```text
M backend/src/modules/epi-assignments/epi-assignments.service.ts
M backend/src/modules/epi-assignments/epi-assignments.service.spec.ts
```

O guard rejeita `ConflictException` quando `assinatura_entrega.signature_hash`
ou `pdf_file_key` já existe. A regressão cobre os dois estados e verifica o
contrato sem tocar no banco.

## Matriz de implementação e contratos

| Domínio/contrato | Frontend real | Backend real | Estado de fonte | Evidência/limite |
|---|---|---|---|---|
| Inspeções | `/dashboard/audits`, activities, checklists e photographic reports | `audits.controller/service`, activities, checklists e `photographic-reports` | `PARTIAL` | A entidade `Inspection` existe em `shared/entities`, mas não há módulo/controller/service/rota dedicada; a superfície operacional existente é audit-based. |
| APR — criação/listagem/detalhe | `/dashboard/aprs`, `aprsService`, hooks | `aprs.controller`, `AprsService` | `PASS` | DTO, tenant/site, roles/permissões e respostas tipadas presentes; runtime HTTP não executado localmente. |
| APR — workflow/aprovação | telas de edição/estado e ações do service | `AprWorkflowService` e endpoints de submit/reopen/approve/reject/finalize | `PASS` | Transições, locks, etapas pendentes e estados finais protegidos por fonte/testes. |
| APR — evidência/PDF/histórico | uploads, PDF, logs, versões e comparação | evidence/PDF/log/version endpoints governados | `PASS` | PDF final congela edição genérica; uploads são tenant-scoped e validados. |
| DDS — criação/listagem/detalhe | `/dashboard/dds`, `ddsService` | `dds.controller/service` | `PASS` | Tenant/site, participantes, payloads e erros têm cobertura de fonte/testes. |
| DDS — assinatura pública | `/assinar/dds/[token]` | public signature/validation controllers | `PASS` | Caminho público separado; token e validação não foram exercitados contra backend real nesta rodada. |
| DDS — aprovação/histórico/PDF | ações, convites, assinaturas e PDF | approval, invite, signature, PDF e audit endpoints | `PASS` | Alteração pós-assinatura exige confirmação/reset formal; PDF e histórico são governados. |
| PT — criação/validade | `/dashboard/pts`, `ptsService`, `PtForm` | `pts.controller/service` | `PASS` | Status, datas, site/entidades e limites são validados; matriz explícita UTC/Cuiabá passou. |
| PT — aprovação/encerramento/expiração | ações de aprovar/rejeitar/finalizar | transitions, evidence, approval/PDF controllers | `PASS` | Transições formais, lock e freeze de PDF presentes; runtime HTTP não executado localmente. |
| PT — checklist/evidência/PDF | checklist, FormData e PDF | attachments, readings, photos e governed PDF | `PASS` | magic bytes/FileInspection e escopo de tenant presentes. |
| EPI — catálogo | `/dashboard/epis`, `episService`, `EpiForm` | `epis.controller/service` | `PASS` | CRUD, CA e escopo de tenant/RBAC presentes; sem alteração de catálogo nesta tarefa. |
| EPI — entrega/estoque | `/dashboard/epi-fichas`, `epiAssignmentsService` | `epi-assignments.controller/service` | `PASS` | Criação valida EPI/usuário/site/CA e decrementa estoque com lock/transação. |
| EPI — assinatura/PDF/retorno/substituição | assinatura, PDF, devolução e substituição | assignment/PDF/return/replace endpoints | `PASS` | Assinatura obrigatória; retorno/substituição preservam estoque e actor scope. Edição genérica pós-assinatura/PDF foi corrigida. |

### Contratos de operação transversal

```text
Auth guards on scoped controllers: PASS — JwtAuthGuard/TenantGuard/RolesGuard
Permissions/roles on sensitive actions: PASS — source/controller matrix
Tenant/site scoping in services: PASS — fail-closed context and company/site filters
Frontend tenant identity: PASS — company_id is not accepted as authority for writes
Public signing isolation: PASS — separate public controllers and token path
PDF/storage governance: PASS — signed/governed access and magic-byte checks in source
Optimistic/pessimistic concurrency controls: PASS — APR/DDS/PT/EPI source paths
Generic EPI edit after signed delivery/final PDF: FIXED — f805622d
Migration 0385–0402: UNCHANGED
```

## Relatório por módulo

### 1. Inspeções — `PARTIAL / FOLLOW-UP`

O fluxo que existe no produto é a combinação de `/dashboard/audits`,
activities, checklists e relatórios fotográficos. `audits.controller.ts` e
`audits.service.ts` fazem validação de company/site/auditor, CRUD tenant-scoped,
upload governado, PDF com acesso assinado e lock após PDF. A entidade
`Inspection` em `backend/src/shared/entities/inspection.entity.ts` contém
estrutura de inspeção, riscos, plano de ação e evidências, mas não possui
camada de aplicação correspondente nem rota frontend dedicada.

```text
UI → dedicated inspections service: NOT FOUND
UI → existing audits service: CONFIRMED
Tenant/RBAC on existing audit surface: PASS
Inspection-specific status transitions: NOT FOUND
Inspection-specific PDF/signature history: NOT FOUND
```

Follow-up P2: confirmar com o owner de produto se `audits` é o contrato oficial
de Inspeções ou criar uma fatia dedicada em tarefa separada. Não foi criada
uma API nova nem migration 0403+ nesta Wave 2.

### 2. APR — `PASS`

O caminho é `/dashboard/aprs` → `aprsService`/hooks → controller/DTO → guards,
tenant/site e `AprWorkflowService` → persistência e serviços de evidência/PDF.
O source bloqueia atualização de status por edição genérica, exige estado
pendente para alterações, usa lock/controle otimista e impede edição após PDF
final. As transições Pendente → Aprovada/Cancelada e Aprovada → Encerrada/
Cancelada estão separadas de criação e edição. Evidências, versões, logs,
comparação e PDF têm endpoints governados.

### 3. DDS — `PASS`

O caminho autenticado é `/dashboard/dds` → `ddsService` → controller/DTO →
tenant/site/permission → `DdsService`/approval/signature/PDF. O caminho público
de assinatura e validação usa controllers separados. Alterações que impactam
conteúdo, participantes, tema, data, site ou facilitador exigem confirmação de
reset de assinatura; o serviço remove assinaturas afetadas dentro de transação
e impede mutação de documento final/auditado. Convites, assinatura, auditoria,
PDF e histórico são tratados por serviços próprios.

### 4. PT — `PASS`

O caminho é `/dashboard/pts` → `ptsService`/`PtForm` → controller/DTO →
TenantInterceptor/guards → serviço de PT. O domínio mantém Pendente, Aprovada,
Cancelada, Encerrada e Expirada, com transições formais. Datas inicial/final,
site, participantes, evidências, leituras atmosféricas, checklist e PDF têm
validação separada. O controle de freeze impede inconsistência de documento
após PDF final.

### 5. EPI — `PASS AFTER FOCUSED FIX`

O caminho é `/dashboard/epi-fichas` → `epiAssignmentsService` →
`epi-assignments.controller.ts` → guards/interceptor → serviço com validação de
company/site/EPI/usuário/CA, lock de estoque e transação. A entrega exige
assinatura. Devolução e substituição são fluxos formais com restauração,
decremento e actor scope.

Finding fechado nesta Wave 2: `PATCH /epi-assignments/:id` aceitava edição
genérica após assinatura ou PDF final. A menor correção passou a rejeitar o
PATCH nesses estados com `409 Conflict`; não altera devolução/substituição,
não reescreve tokens e não muda schema.

## Segurança, tenant e autorização

| Controle | Resultado | Limite |
|---|---|---|
| JWT + tenant + roles/permissions | `PASS` por controller/source/tests | Sem execução HTTP autenticada local nesta rodada. |
| List/get/create/update/delete entre tenants | `PASS` por filtros/guards nos serviços cobertos | RLS isolado não executado: Docker/PostgreSQL indisponíveis. |
| Site/empresa cross-tenant | `PASS` por validações de relação e company filters | Teste A/B real fica para CI/runtime isolado. |
| Assinatura/approval forjado | `PASS` por separação de controllers, estados e testes | Sem provedor/live backend neste worktree. |
| PDF/documento arbitrário | `PASS` por acesso governado, tenant e chaves assinadas | Storage real não executado. |
| Upload | `PASS` por DTO/interceptor/FileInspection/magic bytes | Storage/AV real não executado. |
| Respostas 400/401/403/404/409/422/429/5xx | `PASS` por handlers/testes fonte | Falha de rede em browser autenticado não executada. |
| Booleanos/zero/empty state | `PASS` em componentes/testes existentes | Cobertura visual não equivale a todas as rotas. |
| Draft/dirty/double submit/concurrency | `PASS` parcial por hooks, request sequence, locks e optimistic checks | Cenários completos de browser autenticado não executados. |
| Segredos/logs | `PASS` no diff e scanners; nenhum valor registrado | Produção não foi inspecionada. |

Não foram identificados P0. O único finding de integridade desta rodada foi o
EPI pós-assinatura/PDF, tratado como P1 focado e fechado antes do relatório.

## Findings

### `QA-W2-HIGH-001` — edição genérica de EPI após assinatura/PDF

```text
Severity: P1 / HIGH
Status: CLOSED
Component: EpiAssignmentsService.update
Evidence: Object.assign permitted generic PATCH after delivery signature or final PDF
Impact: signed safety/stock record could diverge from its evidentiary artifact
Fix: ConflictException when signature_hash or pdf_file_key is present
Commit: f805622d
Regression: PASS — signed and final-PDF cases
```

### `QA-W2-MED-001` — superfície dedicada de Inspeções não comprovada

```text
Severity: P2 / MEDIUM
Status: OPEN FOLLOW-UP
Component: Inspection entity versus audits/activities frontend/backend surface
Evidence: entity exists; dedicated application/API/UI path not found
Impact: product naming and traceability may diverge from the intended inspection contract
Action: product owner must confirm audit-as-inspection or commission a separate bounded slice
Migration: none proposed in this task
```

### `QA-W2-MED-002` — runtime local isolado de banco/RLS não disponível

```text
Severity: P2 / MEDIUM
Status: FOLLOW-UP / NOT A SOURCE DEFECT
Evidence: Docker and psql unavailable in the Wave 2 worktree
Impact: no local tenant A/B, RLS, storage, Redis or authenticated HTTP proof
Action: use isolated CI/test-VPS run before production readiness
```

## Validação executada

```text
Backend focused SST suites: PASS — 25 suites / 477 tests
Frontend focused SST suites: PASS — 16 suites / 58 tests
PT TZ=UTC: PASS — 3 suites / 71 tests
PT TZ=America/Cuiaba: PASS — 3 suites / 71 tests
Backend full Jest: PASS — 314 suites / 2718 tests / 0 failures
Frontend full Jest: PASS — 156 passed / 1 skipped suites; 887 passed / 2 skipped tests
Backend type-check: PASS
Frontend type-check: PASS
Backend lint: PASS — max warnings 0
Frontend lint: PASS — permission imports and styles included
Backend build: PASS
Frontend Next build: PASS — 91 pages generated
Migration manifest: PASS — 322 files / 20 names derived from class
Backend runtime dependency audit: PASS — 0 vulnerabilities
Frontend runtime dependency audit: PASS — 0 vulnerabilities
Semgrep changed source scope: PASS — 210 rules / 2 files / 0 findings
Gitleaks changed files: PASS — 0 leaks
Gitleaks staged scope: PASS — 0 leaks
Git diff --check: PASS
```

O warning conhecido `MaxListenersExceededWarning` apareceu na regressão
backend e não foi suprimido. O build frontend usou somente URLs sintéticas
fornecidas no processo; nenhum `.env` foi criado.

### Browser smoke local

```text
Next server: PASS — 127.0.0.1:4310; encerrado após a prova
Playwright available projects: PASS
Public mobile smoke: 21 PASS / 3 NOT EXECUTABLE
Unavailable cases: mobile-320x568 requires missing WebKit executable
Failure type: infrastructure — browser executable missing, no app assertion failure
Authenticated Wave 2 backend browser flows: NOT RUN
```

Os 21 casos executados cobriram login, recuperação de senha e redirecionamento
do dashboard sem sessão nas viewports disponíveis. Os três casos de 320px não
foram reclassificados como falha funcional porque o Playwright não possuía o
binário WebKit requerido pelo projeto.

## Validações não executadas e motivo

```text
Docker/PostgreSQL 17 local: NOT RUN — docker/psql unavailable
RLS tenant A/B isolated runtime: NOT RUN — requires database runtime
Redis/storage real: NOT RUN — requires isolated runtime
Authenticated backend HTTP smoke: NOT RUN — no DB/Redis runtime
APR/DDS/PT/EPI end-to-end browser flows: NOT RUN — no authenticated backend
Real upload/PDF/provider validation: NOT RUN — no storage/provider runtime
Production RLS/read-only probe: NOT RUN — production explicitly out of scope
Production health/deploy/migration: NOT RUN — prohibited by task
```

Essas lacunas não foram convertidas em PASS. O CI oficial da PR empilhada
passou; um runtime isolado continua necessário antes de qualquer decisão de
produção.

## Git, PR e produção

```text
Branch: product/wave-2-sst-critical-workflows
Base branch: product/wave-1-core-dashboard-companies-users-sites
Stacked on PR: #340
Code fix commit: f805622d
Initial report commit: 1d032de9d4d5723bda22415d60c04c5b848876df
CI addendum commit: ddf97176df0da51d2897dbdea9f4d270b9b53a7c
PR: #341 OPEN / non-draft / mergeable
CI: PASS — 9/9 reported checks
Unexpected commits: 0 in Wave 2 scope
Migrations changed: 0
Merge: NO
Push: YES — Wave 2 branch only
Deploy: NO
Production database changed: NO
Production application changed: NO
Coolify/Traefik/firewall/DNS changed: NO
Storage DR: OUT OF SCOPE / STILL BLOCKED
```

## Status final obrigatório

```text
Inspections: PARTIAL — existing audits surface; dedicated inspection path not proven
APR: PASS — source/contracts/tests
DDS: PASS — source/contracts/tests
PT: PASS — source/contracts/tests and UTC/Cuiaba matrix
EPI: PASS — source/contracts/tests plus focused integrity fix
P0 findings: 0
Open P1 findings: 0
Open P2 findings: 2 follow-ups
Backend regression: PASS — 314/314 suites; 2718/2718 tests
Frontend regression: PASS — 156/157 suites; 887/889 tests; baseline skips preserved
Build/type/lint/security: PASS
RLS/database/storage runtime: NOT RUN locally
Production credentials used: NO
Production changed: NO
Production migration: 0
Production deploy: NO
Storage DR: OUT OF SCOPE / STILL BLOCKED
Ready For Wave 2 Review: YES — PR #341 CI terminal PASS; reviewer confirmation remains
Ready For Production: NO
Merge: NO
PRODUCT QA WAVE 2 GATE: PASS WITH FOLLOW-UPS
FINAL VERDICT: PASS WITH FOLLOW-UPS — review-ready, not production-ready
PARAR.

```

---

## Addendum — PR #341 CI e estado de revisão

**Data:** 02/09/2026
**PR:** [#341](https://github.com/wandersongandra/sgsseguranca/pull/341)
**Escopo:** publicação da branch Wave 2 e acompanhamento do CI, sem merge.

```text
PR #341: OPEN
PR #341 Draft: NO
PR #341 Mergeable: YES
PR #341 Base: product/wave-1-core-dashboard-companies-users-sites
PR #341 Base SHA: ea530532f2dd1b45bf4d340b4de6bc05739b45f5
PR #341 HEAD: ddf97176df0da51d2897dbdea9f4d270b9b53a7c
Unexpected commits: 0 — two expected Wave 2 commits
Required checks: PASS — 9/9 reported checks
Backend Lint/Test/Build: PASS
Frontend Lint/Test/Build: PASS
Backend E2E Critical Flows: PASS
Backend E2E DR Restore: PASS
PostgreSQL 17 Migration 0392 Integration: PASS
Snyk: PASS — no manifest changes detected
semantic-pr: PASS
PR Labeler: PASS
CodeRabbit: PASS — review skipped by base-branch policy
Merge: NO
Deploy: NO
Production migration: 0
Production changed: NO
```

O CI remoto confirmou a execução isolada de E2E crítico, DR Restore e
PostgreSQL 17 para o HEAD exato da PR. Isso fortalece a evidência de revisão
da branch, mas não autoriza merge, deploy, migration ou cutover. O blocker de
produto permanece o follow-up P2 sobre a nomenclatura/ausência de uma camada
dedicada de Inspeções; o runtime de produção e Storage DR permanecem fora do
escopo e bloqueados por seus gates próprios.

```text
PRODUCT QA WAVE 2 GATE: PASS WITH FOLLOW-UPS
Ready For Wave 2 Review: YES
Ready For Production: NO
Storage DR: OUT OF SCOPE / STILL BLOCKED
Production Authenticated Proxy: NOT ACTIVATED
FINAL VERDICT: PASS WITH FOLLOW-UPS — STOP
```

PARAR.

### Próximos limites

Após o encerramento do CI da PR empilhada, não fazer merge, não iniciar Wave 3,
não executar migration 0385–0402/0403+, não publicar o SHA de produção, não
ativar proxy autenticado e não desbloquear Storage DR nesta execução.

PARAR.
