# SGS — Product QA Wave 1: módulos centrais

**Data da evidência:** 02/09/2026
**Repositório:** `wandersongandra/sgsseguranca`
**Branch:** `product/wave-1-core-dashboard-companies-users-sites`
**Base empilhada:** PR #339 / `aee907869f131276c15d06283b6489a016ed84bd`
**Commit da correção:** `e7681de3baf6d8d5f1392b51d31b5bb3477ae93`
**Release congelada:** `03f1574ee6e82558630e82d0a50a08361f8ee6d5`
**Escopo:** Dashboard, Empresas, Usuários, Sites/Obras e permissões/RBAC.
**Produção:** não acessada, alterada ou publicada.

## Veredito

```text
PRODUCT QA WAVE 1: PASS — local source/build/browser evidence
Open Wave 1 P0: 0
Open Wave 1 P1: 0
Real P0/P1 security blocker found: NO
Production validation: NOT RUN
Test-VPS backend validation: NOT RUN — browser used synthetic API only
Migration 0403+: NOT REQUIRED
Production migration: 0
Production deploy: NO
Merge: NO
```

A Wave 1 encontrou e corrigiu inconsistências de contexto de tenant, ações de
RBAC exibidas pela UI, formulário de perfil e mensagens de conflito/rate-limit.
As correções permanecem no frontend e não substituem a autorização do backend.
Nenhuma mudança de schema foi necessária.

## Limites e preservação

- A validação foi executada no worktree isolado criado a partir do HEAD exato
  do PR #339. A release `03f1574...` e a `main` congelada não foram alteradas.
- Não houve acesso à VPS de teste, produção, Coolify, Traefik, firewall, DNS,
  Neon, Redis de produção, Backblaze B2, Storage DR ou secret store.
- Nenhum segredo, token, cookie real, credencial, dado de cliente ou valor de
  ambiente foi registrado. A sessão do navegador usou apenas valores
  sintéticos e API mockada em `127.0.0.1:3999`.
- O worktree já possuía alterações fora do escopo em
  `frontend/CLAUDE.md` e `frontend/app/verify/*`; elas foram preservadas e
  não foram staged.
- Não foram executadas migrations `0385–0402` ou qualquer migration nova.

Classificação: `CONFIRMED` = observado em código/teste/runtime local;
`INFERRED` = derivado do contrato de código e dos endpoints;
`UNVERIFIED` = não exercitado nesta Wave.

## Fluxos rastreados

| Módulo | UI → hook/service → endpoint | Tenant/contexto | Autorização e estado | Resultado |
|---|---|---|---|---|
| Dashboard | `dashboard/page.tsx` → `useDashboardData` → `dashboardService` → `/dashboard/summary` e `/dashboard/pending-queue` | `selectedTenantStore`, cache escopado e estado ocultado até o escopo carregado coincidir | API interceptor e guards do backend permanecem autoridade; resposta stale é descartada no hook | `CONFIRMED` — corrigido o stale visual durante troca de tenant |
| Empresas | `companies/page.tsx` → `companiesService` → `/companies` e mutações por ID | Conta não-admin usa empresa da sessão; conta admin pode consultar catálogo autorizado | rota de leitura usa `CAN_VIEW_COMPANIES`; mutações exigem permissão e alias `SUPER_ADMIN`, alinhado ao backend | `CONFIRMED` — ações de mutação não aparecem para Administrador da Empresa |
| Usuários | `users/page.tsx` → `useUsers` → `usersService.findPaginated` e endpoints de mutação | `companyId` explícito no request; troca de tenant limpa lista, paginação e confirmações; respostas fora da sequência são ignoradas | CRUD destrutivo mantém step-up; backend continua responsável por tenant/role/ownership | `CONFIRMED` — lista e mutações ficaram tenant-aware |
| Sites/Obras | `sites/page.tsx` → `sitesService` → `/sites` com `companyId`/header de tenant | `selectedTenantStore` ou empresa da sessão; estado anterior é removido antes do novo carregamento | escrita: admin empresa/TST; exclusão: admin empresa/TST/supervisor, sempre condicionada à permissão | `CONFIRMED` — ações agora refletem os papéis aceitos pelo backend |

## Achados e correções

### QA-W1-001 — dados antigos permaneciam visíveis durante troca de tenant

**Severidade:** corrigido; sem finding aberto.
**Evidência:** Dashboard, Usuários e Sites mantinham dados/paginação do escopo
anterior enquanto o request do novo tenant estava pendente. Requests antigos
também poderiam concluir depois do novo request.
**Correção:** estado é limpo ao trocar o tenant, cada carregamento possui
sequência monotônica, `companyId` é enviado explicitamente quando aplicável e
o hook só expõe dados cujo escopo corresponde ao tenant atual.
**Limite:** a correção impede stale presentation; autorização e isolamento
real continuam dependendo do backend e não foram promovidos por este browser
mock.

### QA-W1-002 — UI de Empresas oferecia mutações além do RBAC efetivo

**Severidade:** corrigido; sem finding aberto.
**Evidência:** a rota de leitura precisava aceitar `CAN_VIEW_COMPANIES`, mas
isso não podia liberar `new/edit/delete` para papéis que o backend restringe.

**Correção:** exceção de rota para leitura e gate explícito de mutação com
permissão mais papel `SUPER_ADMIN`; formulário também falha fechado para
usuário sem autorização.

### QA-W1-003 — ações de Sites não distinguiam escrita de exclusão

**Severidade:** corrigido; sem finding aberto.
**Correção:** aliases de papel são normalizados e ações de criar/editar e
excluir são exibidas separadamente conforme o contrato de backend. QR Code
continua disponível como consulta operacional.

### QA-W1-004 — perfil editável sugeria alteração não suportada pelo PATCH

**Severidade:** corrigido; sem finding aberto.
**Correção:** em edição, o seletor de perfil fica somente leitura e explica
que mudança de papel ocorre pelo fluxo MFA apropriado.

### QA-W1-005 — conflitos e rate-limit não tinham mensagem de formulário

**Severidade:** corrigido; sem finding aberto.
**Correção:** `getFormErrorMessage` e `handleApiError` tratam 409 e 429,
preservando `Retry-After` sem expor detalhes internos. Testes de regressão
foram adicionados.

## RBAC e multi-tenant

- `Permission` continua sendo importado da fonte canônica; o check de imports
  retornou `PERMISSION_IMPORTS_OK`.
- `SUPER_ADMIN` foi tratado separadamente de `CAN_MANAGE_COMPANIES`; ter a
  permissão de leitura/mutação não promove automaticamente um Administrador da
  Empresa a administrador global.
- O frontend não é considerado mecanismo de segurança. Guards JWT/tenant/role,
  ownership e persistência do backend não foram removidos nem substituídos.
- Não foi introduzido `trust proxy`, bypass de tenant, header alternativo,
  cache global ou fallback de autorização.

## QA em navegador

Runtime local: build Next de produção servido em `0.0.0.0:3101`, com dados
sintéticos e rotas API mockadas. Nenhum backend real foi usado.

```text
Login público: PASS — formulário, labels, links de ajuda e navegação
Dashboard autenticado sintético: PASS — sessão Administrador da Empresa
Empresas autenticado sintético: PASS — leitura visível; mutações ocultas
Usuários autenticado sintético: PASS — lista e ações autorizadas visíveis
Sites/Obras autenticado sintético: PASS — CRUD conforme papel/permissão
Viewport 320x568 em Empresas/Sites: PASS — scrollWidth igual à viewport
Redirect sem sessão para /dashboard: PASS — /login
Termos e Privacidade: PASS — conteúdo/navegação acessíveis
Console de aplicação: PASS — somente WebSocket local recusado, sem backend
```

O erro WebSocket foi esperado porque o mock cobria HTTP e não havia servidor
Socket.IO local. Não foi classificado como erro funcional da Wave.

## Validação automatizada

```text
Focused Jest: PASS — 6 suites / 50 tests
Full frontend Jest: PASS under TZ=UTC — 156 suites / 887 tests; 1 suite skipped; 2 tests skipped
TypeScript noEmit: PASS
ESLint focused: PASS — 0 errors / 0 warnings
Prettier focused: PASS
Permission import check: PASS
Next production build: PASS — compiled, TypeScript and static pages 91/91
git diff --check: PASS — warnings only for untouched pre-existing CRLF files
```

A suíte completa em timezone local apresentou uma falha preexistente fora da
Wave em `frontend/src/lib/medical-exams/date.test.ts`; sob `TZ=UTC`, contrato
usado pelo build/teste, a suíte completa passou. Nenhum teste foi removido,
afrouxado ou marcado como skip pela Wave.

## Git e publicação

```text
Base PR #339 HEAD: aee907869f131276c15d06283b6489a016ed84bd
Wave source commit: e7681de3baf6d8d5f1392b51d31b5bb3477ae93
Focused paths in source commit: 16
Unexpected staged paths: 0
Pre-existing dirty files staged: 0
Documentation commit before this update: ac5aa393e44f19cc3b83b93fd0537f04b7e5a1fb
Push: YES — branch published normally, no force push
Stacked PR: OPEN — #340, base PR #339 branch
PR draft: NO
PR mergeable: YES — observed before this documentation update
PR checks: RUNNING — pending checks observed before this documentation update
Merge: NO
```

## Status final obrigatório

```text
Repository: wandersongandra/sgsseguranca
Release SHA frozen: 03f1574ee6e82558630e82d0a50a08361f8ee6d5
Parent PR #339 HEAD: aee907869f131276c15d06283b6489a016ed84bd
Dashboard: PASS — source/cache/tenant QA
Empresas: PASS — read/mutation RBAC alignment
Usuários: PASS — tenant-aware list and stale-response guard
Sites/Obras: PASS — tenant-aware list and role-gated actions
Permissions/RBAC: PASS — frontend gates aligned; backend remains authority
Forms/Errors: PASS — profile contract, 409 and 429 coverage
Mobile 320px: PASS — no horizontal overflow in tested modules
Accessibility basic browser QA: PASS — labels, headings, focusable actions and skip link observed
Real backend browser E2E: NOT RUN — synthetic API only
Test VPS: NOT USED
Storage DR: NOT TOUCHED
Migration 0403+: NOT REQUIRED
New Critical: 0
New High: 0
Open Wave P0: 0
Open Wave P1: 0
Source commit: e7681de3baf6d8d5f1392b51d31b5bb3477ae93
Documentation: COMMITTED — final status update follows in this branch
Push: YES
Stacked PR: OPEN — #340
PR checks: RUNNING at status capture
Merge: NO
Deploy: NO
Production migration: 0
Production database changed: NO
Production application changed: NO
FINAL VERDICT: PASS — local Wave 1 evidence; production readiness not implied
```

PARAR.
