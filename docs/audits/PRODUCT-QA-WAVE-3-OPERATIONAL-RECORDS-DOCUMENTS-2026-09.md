# SGS — Product QA Wave 3

**Data da evidência:** 02/09/2026
**Repositório:** wandersongandra/sgsseguranca
**Branch de QA:** product/wave-3-operational-records-documents
**Base da Wave 3:** parent exato da PR #341
**HEAD de base:** 13e1b0d942d96e28a86f0d86e8ad66bfed3ae6a9
**Release de produção congelada:** 03f1574ee6e82558630e82d0a50a08361f8ee6d5

## Veredito

~~~text
PRODUCT QA WAVE 3: PASS LIMITED — local source and browser validation
P0 FINDINGS: 0
P1 FINDINGS OPEN: 0
P2 FOLLOW-UP: 1 — Inspeções needs an explicit product-contract decision
Production access: NO
Production database changed: NO
Production deploy: NO
Production migration: NO
Neon default/production branch changed: NO
Storage DR changed: NO
PR #341 changed: NO
Main changed: NO
Ready for production: NO — operational production gates remain separate
~~~

A Wave 3 foi validada no código e no frontend em um worktree isolado. Foram
encontrados e corrigidos dois caminhos de mutação após fechamento documental:
anexos de CAT fechada/com PDF final e edição de relatório fotográfico
FINALIZADO/EXPORTADO. A correção foi acompanhada por testes de regressão
permanentes.

O resultado é limitado à fonte, testes locais e browser local. Não promove
RLS, PostgreSQL, storage provider, Storage DR, deployment ou readiness de
produção.

## Preservação e limites

- A produção não foi acessada.
- Nenhuma configuração de Coolify, Traefik, firewall, DNS, Redis ou storage
  externo foi alterada.
- Nenhuma migration foi criada, editada ou executada.
- Migrations 0385–0402 permanecem intocadas.
- Não há requisito de schema identificado para esta Wave 3; migration 0403+
  não é necessária.
- Nenhum segredo, token, cookie, JWT, chave, conteúdo de env ou dado real foi
  registrado.
- A PR #341, sua branch e a branch main não foram alteradas.
- Nenhum reset, clean destrutivo, force push, merge ou deploy foi executado.
- A alteração automática temporária de frontend/CLAUDE.md criada pelo Next
  durante o dev server foi revertida por patch exato; não entrou no escopo.

Classificação usada: CONFIRMED = observado diretamente; INFERRED = derivado
de código/configuração; UNVERIFIED = não executado nesta rodada.

## Baseline Git

~~~text
Repository: wandersongandra/sgsseguranca
Base branch for Wave 3: product/wave-2-sst-critical-workflows
Base HEAD: 13e1b0d942d96e28a86f0d86e8ad66bfed3ae6a9
Wave 3 branch: product/wave-3-operational-records-documents
Initial worktree: clean at branch creation
Production release SHA: 03f1574ee6e82558630e82d0a50a08361f8ee6d5
Pre-existing product changes in Wave 3 worktree: 0
Migrations in scope: 0
~~~

O parent remoto da PR #341 foi confirmado como
product/wave-2-sst-critical-workflows, com HEAD
13e1b0d942d96e28a86f0d86e8ad66bfed3ae6a9. A PR #341 estava OPEN, non-draft,
MERGEABLE e com os checks observados em SUCCESS; ela não foi modificada.

## Matriz de módulos auditados

O fluxo considerado para cada módulo foi:

~~~text
UI → hook/service → endpoint → DTO/validation → authentication
→ permission/RBAC → tenant/site ownership → domain service
→ persistence/workflow → upload/storage → signature/PDF
→ history/audit → response → UI state
~~~

| Módulo | UI e contrato | Backend/tenant/RBAC | Upload/PDF/workflow | Estado Wave 3 |
| --- | --- | --- | --- | --- |
| Checklists | rotas de lista, preenchimento, modelos e templates | serviços e DTOs existentes; contexto de empresa/obra preservado | itens, respostas e fluxo documental existentes | PASS |
| RDO | dashboard, criação/edição e consulta | serviço, DTO, autenticação e escopo de obra revisados | registro operacional e histórico existentes | PASS |
| Relatórios fotográficos | workspace, wizard, upload, análise e exportação | relatório, dias, imagens, permissões e escopo de empresa revisados | storage key, análise, finalização e exportação revisados; final/exportado agora é somente leitura | PASS após correção |
| CAT | lista, detalhe, anexos e emissão | serviço, ownership e estado fechada revisados | anexos não podem ser adicionados/removidos após fechamento ou PDF final | PASS após correção |
| ARR | lista, edição, transições e PDF | serviço, participantes, empresa/obra e transições revisados | PDF governado, hash/metadados e estados de documento existentes | PASS |
| DID | lista, edição, transições e PDF | serviço, permissões, tenant e ownership revisados | PDF governado, assinatura/URL e estados de documento existentes | PASS |

## Finding corrigido — CAT

### P1-W3-001 — anexos mutáveis após fechamento documental

**Estado:** CLOSED no escopo da Wave 3.

Antes da correção, addAttachment e removeAttachment faziam a leitura inicial
da CAT, mas não impediam a alteração quando a CAT estava fechada ou já tinha
PDF final. Isso permitia inconsistência entre documento final e anexos e, no
caso de upload, poderia iniciar armazenamento antes de uma decisão segura.

Correção aplicada em:

~~~text
backend/src/modules/cats/cats.service.ts
backend/src/modules/cats/cats.service.spec.ts
~~~

O serviço agora exige status mutável e ausência de pdf_file_key antes do
upload/remoção e repete a verificação dentro da seção protegida por lock.
Uma corrida de fechamento entre a leitura inicial e a persistência é
rejeitada; o upload intermediário é limpo pelo fluxo de compensação existente.

Regressões cobertas:

~~~text
CAT fechada + addAttachment: rejeita antes de salvar/upload
CAT fechada + removeAttachment: rejeita antes de persistir/remover storage
CAT com PDF final: rejeita mutações de anexos
~~~

## Finding corrigido — Relatórios fotográficos

### P1-W3-002 — edição lateral de documento FINALIZADO/EXPORTADO

**Estado:** CLOSED no escopo da Wave 3.

O serviço tinha uma transição implícita de documento finalizado/exportado para
EM_EDICAO em markEditingIfNeeded. Isso abria mutação lateral em dados gerais,
dias, imagens, reordenação, análise, resumo e finalização. A UI também
mantinha controles editáveis quando o relatório já estava finalizado.

Correção aplicada em:

~~~text
backend/src/modules/photographic-reports/photographic-reports.service.ts
backend/src/modules/photographic-reports/photographic-reports.service.spec.ts
frontend/app/dashboard/photographic-reports/components/PhotographicReportWorkspace.tsx
frontend/app/dashboard/photographic-reports/components/PhotographicReportWorkspace.test.tsx
frontend/app/dashboard/photographic-reports/components/WizardStep3Review.tsx
~~~

O serviço centraliza assertPhotographicReportMutable e falha antes de
mutação, upload, download de storage ou chamada de IA. FINALIZADO e EXPORTADO
não são rebaixados pelo fluxo comum. A UI aplica o mesmo contrato: dados,
dias, upload, campos de imagem, resumo, análise e finalização ficam
desabilitados; exportação, download e histórico continuam disponíveis para
consulta.

Regressões cobertas:

~~~text
FINALIZADO/EXPORTADO + update: rejeita antes de alterar/salvar
FINALIZADO + updateImage: rejeita antes de carregar/salvar imagem
EXPORTADO + analyzeAllImages: rejeita antes de IA/storage/persistência
UI FINALIZADO: mensagem de somente leitura e controles de mutação disabled
~~~

## Inspeções — follow-up de produto

### P2-W3-001 — contrato de produto de Inspeções não está explícito

**Estado:** OPEN FOLLOW-UP; não bloqueia o código dos seis módulos desta Wave
3, mas bloqueia uma conclusão de cobertura funcional específica de Inspeções.

Foi encontrada a entidade/infraestrutura de inspections e referências de
contadores/integração no dashboard, porém não foi provado nesta rodada um
módulo de aplicação dedicado de Inspeções equivalente aos demais fluxos.
Audits é um módulo distinto e não foi tratado como substituto sem decisão de
produto.

Próxima decisão necessária:

~~~text
Inspeções é:
1. módulo operacional independente; ou
2. conceito absorvido por Audits/Checklists; ou
3. backlog explicitamente fora da Wave 3.
~~~

Nenhum módulo ou migration foi criado para mascarar essa lacuna. A cobertura
de inspeções permanece NOT PROMOTED até o owner de produto definir o contrato
canônico.

## Controles transversais

### Tenant, site e autorização

~~~text
Tenant context derivation: PASS — source review and existing tests
Company/site ownership paths: PASS — source review per module
Role/permission guards: PASS — source review and existing contracts
Client-provided tenant authority: DENIED by reviewed service contracts
Cross-tenant proof in this Wave 3 worktree: supporting prior CI/test evidence
Live RLS proof in this round: UNVERIFIED — Docker/psql unavailable locally
~~~

Autenticação não foi promovida como autorização isolada. Nos módulos
revisados, a decisão depende do contexto autenticado, empresa/obra e
permissão aplicável. A evidência live de RLS permanece um gate separado.

### Upload, storage e integridade

~~~text
File inspection paths: PASS — existing shared inspection contracts
Storage key ownership paths: PASS — source review
Cross-tenant object access: NOT PROMOTED live — no provider runtime here
Final document immutability: PASS for CAT and photographic-report fixes
ARR/DID governed PDF contracts: PASS — existing source/test evidence
Signature/PDF hash contracts: PASS — existing governed paths
Storage provider runtime: UNVERIFIED in this Wave 3 run
Storage DR: OUT OF SCOPE — prior production gate remains blocked
~~~

Não foram usados arquivos reais. Nenhum objeto externo, bucket primário,
réplica DR ou credencial de storage foi tocado.

### Estado final e histórico

Checklists, RDO, ARR e DID mantêm os fluxos de estado existentes e foram
revisados para impedir que a UI seja tratada como autoridade. Para relatórios
fotográficos, a regra foi reforçada no backend e no frontend. Para CAT, a
regra foi reforçada também dentro da região com lock, reduzindo a janela de
corrida entre leitura e persistência.

Não foi adicionada nova migration, alteração de entidade ou alteração de
ledger. O contrato atual não exige 0403+.

## Validação executada

### Testes

~~~text
Focused backend: PASS — 2 suites / 31 tests
Focused frontend: PASS — 1 suite / 2 tests
Full backend: PASS — 314 suites / 2724 tests / 0 skipped
Full frontend: PASS — 156 suites passed; 1 suite skipped
Full frontend tests: 888 passed / 2 skipped / 890 total
Known backend warning: MaxListenersExceededWarning remained visible and was not suppressed
~~~

### Static and build checks

~~~text
Backend type-check: PASS
Backend lint: PASS — max warnings 0
Backend build: PASS
Frontend type-check: PASS — npx tsc --noEmit
Frontend lint: PASS — permission imports, ESLint and stylelint
Frontend production build: PASS — synthetic local URLs in process only
Migration manifest: PASS — 322 files; 20 names derived from class
Git diff --check: PASS
~~~

O primeiro frontend build foi corretamente bloqueado pelo contrato de
ambiente por ausência de NEXT_PUBLIC_API_URL/NEXT_PUBLIC_APP_URL. O build foi
repetido com URLs 127.0.0.1 sintéticas somente no processo, sem editar env,
sem persistir valores e sem usar produção.

### Browser real

~~~text
Frontend dev server: PASS — 127.0.0.1:3100
Public/mobile Playwright matrix: PASS — 24/24
Viewports: mobile 320/360/390/412/430, tablet 768, landscape 844, desktop 1440
Login overflow/iOS zoom: PASS
Forgot-password overflow/control usability: PASS
Unauthenticated dashboard redirect: PASS
~~~

O WebKit ausente no primeiro intento foi instalado localmente pelo Playwright;
após isso, os três testes do viewport 320x568 passaram. O servidor local foi
encerrado ao final da prova.

### Segurança estática e disponibilidade local

~~~text
Semgrep: PASS — 210 rules / 7 changed files / 0 findings
Semgrep Windows encoding workaround: PYTHONUTF8=1, process-only
Gitleaks staged scope: PASS — no leaks found
Docker daemon: UNAVAILABLE locally
psql: UNAVAILABLE locally
PostgreSQL 17 local integration: NOT RUN
Live RLS/tenant database proof: NOT RUN
Storage provider integration: NOT RUN
Production browser/runtime: NOT RUN
~~~

O primeiro Semgrep retornou erro de encoding do ambiente Windows, sem
resultado de findings. A repetição em UTF-8 concluiu normalmente com zero
findings. A ausência de Docker/psql impede uma declaração local de
PostgreSQL 17, RLS ou provider runtime; essas provas permanecem externas e
separadas.

O Prettier focused check não foi promovido como PASS: os três arquivos
frontend já falhavam a mesma verificação no HEAD-base. Nenhum reformat amplo
foi aplicado para não misturar baseline com a correção funcional.

## Arquivos alterados pela Wave 3

~~~text
backend/src/modules/cats/cats.service.spec.ts
backend/src/modules/cats/cats.service.ts
backend/src/modules/photographic-reports/photographic-reports.service.spec.ts
backend/src/modules/photographic-reports/photographic-reports.service.ts
frontend/app/dashboard/photographic-reports/components/PhotographicReportWorkspace.test.tsx
frontend/app/dashboard/photographic-reports/components/PhotographicReportWorkspace.tsx
frontend/app/dashboard/photographic-reports/components/WizardStep3Review.tsx
docs/audits/PRODUCT-QA-WAVE-3-OPERATIONAL-RECORDS-DOCUMENTS-2026-09.md
~~~

Nenhum arquivo de migration, .env, chave, credencial, frontend fora do
escopo fotográfico ou infraestrutura externa foi alterado.

## PR e release boundary

~~~text
Suggested PR title: fix(product): harden operational SST records and documents
PR base: product/wave-2-sst-critical-workflows
PR stack: above PR #341
PR merge: NO
Production release SHA: 03f1574ee6e82558630e82d0a50a08361f8ee6d5
Release SHA changed: NO
Migration 0403+: NOT REQUIRED
Production authenticated proxy: unchanged
Storage DR: unchanged
~~~

A publicação, se autorizada depois da revisão, deve ser feita somente pela
branch Wave 3 empilhada na PR #341, com CI remoto concluído e revisão do
follow-up de Inspeções. Esta QA não fecha o cutover de produção.

## Status final obrigatório

~~~text
Repository: wandersongandra/sgsseguranca
Wave 3 Branch: product/wave-3-operational-records-documents
Parent PR: #341
Parent HEAD: 13e1b0d942d96e28a86f0d86e8ad66bfed3ae6a9
Production Release SHA: 03f1574ee6e82558630e82d0a50a08361f8ee6d5

Checklists: PASS
RDO: PASS
Photographic Reports: PASS — after P1-W3-002 remediation
CAT: PASS — after P1-W3-001 remediation
ARR: PASS
DID: PASS
Inspections Product Contract: OPEN FOLLOW-UP

P0 Open: 0
P1 Open: 0
P2 Open: 1
Semgrep: PASS — 0 findings
Full Backend Regression: PASS — 314 suites / 2724 tests
Full Frontend Regression: PASS — 156 passed suites; 888 passed tests
Browser Mobile Matrix: PASS — 24/24
Docker/PostgreSQL 17 Local Gate: NOT RUN — unavailable
Live RLS Gate: NOT RUN
Storage Provider Gate: NOT RUN
Storage DR Gate: OUT OF SCOPE / prior blocked gate
Migration 0403+: NOT REQUIRED

Production Access: NO
Production Changed: NO
Production Database Changed: NO
Production Migration: 0
Production Deploy: NO
Coolify/Traefik Changed: NO
Neon Production/Default Branch Changed: NO
PR #341 Changed: NO
Main Changed: NO
Merge: NO
~~~

**Conclusão:** a Wave 3 fechou os fluxos de Checklists, RDO, Relatórios
Fotográficos, CAT, ARR e DID no nível de código, testes e browser local. As
duas lacunas de integridade encontradas foram corrigidas com proteção no
backend, bloqueio coerente na UI e regressões permanentes. A decisão de
produto sobre Inspeções continua explicitamente pendente. Não houve acesso ou
alteração de produção, banco, storage, Coolify, migration, merge ou deploy.

## Addendum — PR #342 e CI remoto

```text
PR #342: OPEN
PR #342 HEAD: 928348028caae5f186e5728d28c73f6517306999
PR #342 Base: product/wave-2-sst-critical-workflows
PR #342 Draft: NO
PR #342 Mergeable: YES
Required/observed checks: PASS — 9/9
Backend Lint/Test/Build: PASS
Frontend Lint/Test/Build: PASS
Backend E2E Critical Flows: PASS
Backend E2E DR Restore: PASS
PostgreSQL 17 Migration 0392 Integration: PASS
Snyk: PASS — no manifest changes detected
semantic-pr: PASS
PR Labeler: PASS
CodeRabbit: PASS — review skipped for this base branch
Merge: NO
Deploy: NO
Production Migration: 0
```

A PR foi aberta somente para a branch Wave 3 empilhada na PR #341. O CI
remoto terminou sem falhas ou pendências. A PR permanece aberta para revisão;
nenhum merge, deploy, migration ou alteração de produção foi executado.

PARAR.
