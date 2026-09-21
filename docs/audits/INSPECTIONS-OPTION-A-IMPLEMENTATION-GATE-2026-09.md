# SGS — Inspections Option A Implementation Gate

**Data da evidência:** 03/09/2026
**Repositório:** `wandersongandra/sgsseguranca`
**Branch:** `product/inspections-option-a`
**Base empilhada:** `audit/inspections-product-contract`
**Parent HEAD:** `3fe8124618d9fecc04335211d7ee05a9226a6a44`
**Parent PR:** #345 — aberto, não-draft, mergeable
**Escopo:** implementação frontend/documental da decisão de produto Option A.
**Produção:** não acessada, alterada, migrada ou publicada.

## Veredito

```text
INSPECTIONS OPTION A IMPLEMENTATION GATE: PASS — local and branch scope
Product Contract: PASS — Audits = formal audits and inspections
Checklist Boundary: PASS — separate field execution product
Legacy Inspection Boundary: PASS — compatibility/read-only infrastructure
Backend Functional Changes: 0
Migration 0385–0403: UNCHANGED
Migration 0404: NOT CREATED
Production Changed: NO
Production Migration: 0
Production Deploy: NO
```

Esta implementação materializa a decisão do Product Owner sem criar um novo
bounded context de `Inspection`. A camada de produto continua sendo `Audit`,
com a apresentação combinada **Auditorias e Inspeções**. Checklists continuam
separados como execução operacional em campo.

## 1. Decisão e limites preservados

```text
Option A: ACCEPTED
Formal product layer: Audit / /dashboard/audits / /audits
Combined UX label: Auditorias e Inspeções
Checklist layer: separate
Existing Inspection entity/table: LEGACY / COMPATIBILITY / READ-ONLY
AUDIT_INSPECTION_SUBTYPE: NOT YET PERSISTED
New Inspection backend module/controller/service/repository/DTO: NO
New Inspection RBAC contract: NO
New Inspection table/workflow/PDF/storage pipeline: NO
Historical Inspection rows modified: 0 — no database access
```

As migrations `0385–0403` não foram alteradas e nenhuma `0404` foi criada.
Não houve novo endpoint de backend, novo contrato de persistência, backfill,
reclassificação histórica ou mistura silenciosa de dados de `Inspection` com
os agregados de `Audit`.

## 2. Implementação

O trabalho foi empilhado sobre o HEAD real do PR #345 e ficou restrito a:

- contrato visual e textual de Audits como **Auditorias e Inspeções**;
- um único item de navegação canônico em `/dashboard/audits`, com o alias
  `/dashboard/inspections` ativo para compatibilidade;
- alias server-side que redireciona para `/dashboard/audits` preservando
  parâmetros de consulta, sem fetch ou autenticação paralela;
- proteção de leitura por `can_view_audits` e proteção de gestão por
  `can_manage_audits` nas rotas e ações de criar, editar, excluir, CAPA e
  emissão PDF;
- remoção do KPI independente enganoso de “Inspeções concluídas” no dashboard;
- preservação da entidade/tabela `Inspection` legada sem nova superfície de
  escrita;
- ADR `docs/architecture/ADR-AUDITS-AS-FORMAL-INSPECTIONS.md` registrando a
  decisão, consequências e limites.

O PDF final governado existente continua sendo o contrato de visualização.
A emissão permanece sujeita à permissão de gestão; não foi criado gerador,
storage ou fluxo PDF paralelo.

## 3. RBAC, tenant e compatibilidade

```text
Canonical Audit list/alias: CAN_VIEW_AUDITS
Audit create/edit/delete/CAPA/PDF emission: CAN_MANAGE_AUDITS
Viewer management actions hidden: PASS
Backend authority: PRESERVED
Tenant/site/API contract: UNCHANGED
Frontend-controlled authorization: NOT USED AS SOLE AUTHORITY
```

O frontend apenas reflete o contrato de autorização já existente; a
autoridade continua no backend. O cliente continua consumindo o serviço
canônico de Audit, com seu contrato de empresa/site e isolamento existentes.
A validação de navegador usou mocks sintéticos e, portanto, não é prova nova
de RLS live ou de autorização em banco.

`queryKeys.inspections` foi mantido e classificado como
`LEGACY/UNKNOWN RETAINED`; não houve limpeza ampla nem remoção especulativa de
consumidores desconhecidos. A área de relatórios fotográficos permanece
separada.

## 4. Commits e escopo Git

```text
Implementation commit: bb8c0433d826fba46cee617dc72edbcc635fb15f
Route guard commit: c9664fe0957644cda19611148213b79297de3cd0
Implementation commits: 2
Files in implementation commits: 13
Backend files changed: 0
Migration files changed: 0
Frontend verify changes: PRE-EXISTING / PRESERVED / NOT STAGED
```

O worktree já continha alterações locais em:

```text
M frontend/app/verify/page.test.tsx
M frontend/app/verify/page.tsx
```

Essas alterações não foram editadas, staged ou incluídas no escopo da
implementação.

## 5. Validação local

```text
Focused Option A suites: PASS — 3 suites / 38 tests
Full frontend Jest: PASS — 158 suites passed, 1 skipped
Full frontend tests: PASS — 900 passed, 2 skipped, 902 total
Type-check: PASS — tsc --noEmit
Lint: PASS
Build: PASS — Next.js 16.3.1 production build
Prettier focused check: PASS
Git diff --check: PASS
Migration diff 0385–0403: EMPTY
Migration diff 0404: NOT CREATED
```

O `npm audit --omit=dev --audit-level=high` não encontrou vulnerabilidades
High/Critical; permaneceu uma vulnerabilidade Moderate baseline em `fflate`,
fora do escopo desta mudança.

```text
Semgrep: PASS — 74 rules / 11 implementation files / 0 findings
Gitleaks staged: PASS — no leaks found
```

O Semgrep exibiu um warning de validação de uma regra empacotada, mas a
varredura terminou sem findings e exit code 0. Nenhum segredo foi registrado,
adicionado ou usado.

## 6. Navegador real e acessibilidade

A validação foi executada em Chrome real com Playwright contra servidor local
e API sintética interceptada; não houve endpoint de produção.

```text
Unauthenticated alias: redirected to /login
Authenticated alias: redirected to /dashboard/audits
Query parameters: preserved, including repeated values
Single canonical navigation entry: PASS
Combined heading and label: PASS
Admin manage CTA: visible
Viewer manage CTA/edit/delete/CAPA: hidden
Viewer audit view: visible
Misleading independent Inspection KPI: absent
```

Viewports validados sem overflow horizontal:

```text
320, 360, 390, 414, 430, 768, 1024, 1440
```

Teclado e foco passaram: botão de navegação alcançável por teclado, Enter
abriu o drawer, foco permaneceu dentro do drawer e o rótulo longo
**Auditorias e Inspeções** permaneceu visível no viewport mobile.
Screenshots locais foram preservados em `frontend/output/playwright` como
artefatos de inspeção visual; não contêm dados reais.

## 7. Estado de segurança e produto

```text
New P0: 0
New P1: 0
New P2: 0
FE-LOW-002: OPEN-DEFERRED — LOW, fora do escopo
W4-P2-001: UNCHANGED — parent evidence preserved
Production credentials: NOT USED
Production access: NO
Production database changed: NO
Production application changed: NO
```

Os testes locais não promovem evidência de produção, RLS, storage, Redis,
PDF provider ou runtime live. O backend não foi funcionalmente alterado; a
regressão backend e os gates de infraestrutura do parent permanecem
supporting evidence, não são reexecutados como se esta mudança tivesse
alterado o backend.

## 8. Estado de publicação

```text
Parent PR #345: OPEN / non-draft / mergeable
Parent PR #345 checks: PASS — 10/10 displayed checks
Option A branch push: PENDING THIS GATE
Option A PR: PENDING THIS GATE
Merge: NO
Deploy: NO
Production migration: 0
Main branch changed: NO
```

O PR desta implementação deve permanecer empilhado em
`audit/inspections-product-contract`, com título:

```text
feat(product): align formal inspections with audits
```

Merge, deploy e qualquer ativação de produção permanecem fora deste gate.

## Estado final

```text
Audits Formal Product Layer: PASS
Checklists Separate Boundary: PASS
Legacy Inspection Compatibility Boundary: PASS
Canonical Audit Route: PASS
Inspections Alias: PASS
Query Preservation: PASS
RBAC View/Manage Separation: PASS
Legacy KPI Separation: PASS
PDF Governance: PASS — existing contract preserved
Tenant/API Contract: PASS — unchanged
Browser Responsive Matrix: PASS
Keyboard/Focus: PASS
Backend Functional Changes: 0
Migration Changes: 0
New Security Findings: 0
INSPECTIONS OPTION A IMPLEMENTATION GATE: PASS — branch scope
Production Release Readiness: NOT CLOSED BY THIS GATE
```

**Conclusão:** a decisão Option A foi implementada no produto usando a camada
existente de `Audit` para Auditorias e Inspeções formais, mantendo Checklists
separados e `Inspection` apenas como compatibilidade legada. O alias, a
navegação, o RBAC de leitura/gestão, a separação do dashboard e a validação em
navegador real passaram. Não houve alteração de backend funcional,
migration, banco, produção ou merge.

PARAR.
