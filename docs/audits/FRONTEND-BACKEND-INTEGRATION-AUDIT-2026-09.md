# SGS — Frontend ↔ Backend Integration, Product QA e Release Preparation

**Data da evidência:** 01/09/2026
**Repositório:** `wandersongandra/sgsseguranca`
**SHA de produção congelado:** `03f1574ee6e82558630e82d0a50a08361f8ee6d5`
**Branch da auditoria:** `audit/frontend-backend-product-integration-release`
**Escopo:** integração React/Next ↔ Nest, contratos de API, autenticação,
tenant/RBAC, estados de erro, uploads/PDF/assinaturas, QA de produto,
acessibilidade, responsividade e preparação de release.
**Produção:** não acessada, não alterada, não migrada e não publicada.

## Veredito

```text
FRONTEND↔BACKEND INTEGRATION GATE: PASS WITH DEFERRED LOW
LOCAL SOURCE/CONTRACT VALIDATION: PASS
REMOTE CI FOR CURRENT PR HEAD: PASS
LOCAL FRONTEND BUILD: BLOCKED_BY_LOCAL_MEMORY
REMOTE FRONTEND CI BUILD: PASS
EFFECTIVE PR BUILD GATE: PASS
PRODUCTION RUNTIME READINESS: BLOCKED_BY_PRODUCTION_ACCESS
TEST-VPS RUNTIME: NOT RUN — no executable test infrastructure path in this session
READY FOR PRODUCTION: NO
```

O código e os contratos examinados passaram os testes completos locais, lint,
type-check isolado, auditorias de dependência, Semgrep, Gitleaks de fonte e
QA básico em navegador real. Duas correções focadas de integração foram feitas
nesta branch: eliminação de uma corrida de estado tenant/site e eliminação do
redirecionamento duplicado no logout por inatividade.

O build do backend passou. O build Next local compilou o bundle, mas o
subprocesso de type-check interno do Next encerrou por OOM do runner; o
`tsc --noEmit` executado isoladamente passou. Essa limitação local permanece
registrada historicamente. O job `Frontend Lint/Test/Build` do CI remoto, no
HEAD atual do PR, concluiu o build frontend com sucesso; portanto o gate de
build efetivo do PR é PASS sem mascarar o OOM local.

Não houve Postgres/Redis local ou VPS de teste disponível para executar o
backend HTTP completo nesta sessão. O CI remoto executou E2E crítico, DR
restore e PostgreSQL 17 em ambientes isolados; isso não é prova de runtime
live de produção. RLS de produção, storage real e release de produção
permanecem não comprovados.

## Limites e preservação

- O SHA de produção `03f1574ee6e82558630e82d0a50a08361f8ee6d5` foi preservado.
- A branch da auditoria foi criada a partir de `origin/main`, que corresponde
  exatamente ao SHA de produção congelado.
- O checkout original sujo foi preservado; suas alterações preexistentes não
  foram resetadas, restauradas, limpas ou staged.
- Nenhuma credencial, variável de ambiente, token, cookie, segredo, IP, chave,
  conteúdo de `.env` ou dado de cliente foi impresso ou copiado.
- Nenhum acesso a produção, Coolify, Traefik, firewall, DNS, banco, Redis,
  B2, migration, deploy ou restart produtivo foi realizado.
- O QA de navegador usou somente `127.0.0.1`, sem backend local e sem dados
  reais. O erro de conexão da API local foi mantido como limitação observada.
- Artefatos temporários do Playwright foram removidos individualmente. Não foi
  executada limpeza ampla do workspace nem dos volumes Docker.

Classificação: `CONFIRMED` = observado diretamente; `INFERRED` = derivado de
código/configuração; `NOT RUN` = não executado nesta rodada.

## Baseline e escopo da branch

```text
origin/main: 03f1574ee6e82558630e82d0a50a08361f8ee6d5
HEAD inicial da branch: 03f1574ee6e82558630e82d0a50a08361f8ee6d5
HEAD atual da branch: `64ceb8841382c665540cb36cb9cd88f459ffcb9b`
Commits de auditoria: `91fbbd93`, `a6ac4c19`, `64ceb884`
Branch: audit/frontend-backend-product-integration-release
Frontend route/page files: 117
Backend controller files: 66
Frontend source files: 399
Frontend test files: 111
Production source deploy: NO
Production database migration: 0
```

Alterações focadas da branch:

```text
frontend/src/lib/selectedTenantStore.ts
frontend/src/lib/selectedTenantStore.test.ts
frontend/src/lib/siteStore.ts
frontend/src/lib/siteStore.test.ts
frontend/src/state/AuthContext.tsx
frontend/src/state/AuthContext.test.tsx
frontend/src/components/Sidebar.tsx
```

`frontend/app/verify/page.tsx` e seu teste apresentaram somente alteração de
line ending gerada pelo checkout/build e foram excluídos do commit. O arquivo
`frontend/CLAUDE.md` recebeu conteúdo automático do Next durante o teste e foi
restaurado ao conteúdo-base. Nenhum desses artefatos é evidência funcional.

## Fluxo de integração auditado

O caminho seguido foi:

```text
UI route/component
  -> frontend service / central axios client
  -> auth, CSRF, refresh e tenant headers
  -> Nest controller e DTO
  -> JwtAuthGuard / TenantGuard / RolesGuard / PermissionsGuard
  -> TenantService / ownership / service query
  -> TypeORM / RLS contract
  -> response/status/error handler
  -> frontend state, toast, cache e navigation
```

### Inventário e matriz de features

| Feature | Frontend | Backend | Auth/tenant/RBAC | Payload/response | Runtime |
|---|---|---|---|---|---|
| Dashboard | `/dashboard`, `dashboard` services | `dashboard.controller.ts` | `CONFIRMED` source guards/context | typed service responses; `INFERRED` complete shape | `NOT RUN` |
| Companies | `/dashboard/companies`, `companiesService` | `companies.controller.ts` | JWT + tenant + roles; superadmin actions restricted | DTOs and paginated/list responses | `NOT RUN` |
| Users | `/dashboard/users`, `usersService` | `users.controller.ts` | JWT + tenant + role/permission checks | typed user DTOs; validation source present | `NOT RUN` |
| Inspections | `/dashboard/audits`, activities and risk pages | `audits.controller.ts`, `activities.controller.ts`, `risks.controller.ts` | tenant/ownership checks in services | typed service calls; no live response proof | `NOT RUN` |
| APR | `/dashboard/aprs`, `aprsService`, APR hooks | `aprs.controller.ts` and workflow controllers | JWT + tenant + role/permission gates | workflow, evidence and PDF contracts present | `NOT RUN` |
| DDS | `/dashboard/dds`, public signing route | `dds.controller.ts`, public DDS controllers | authenticated tenant path and separate public token path | signing/validation response contracts present | `NOT RUN` |
| PT | `/dashboard/pts`, `ptsService` | `pts.controller.ts` | JWT + tenant + role/permission source guards | DTO validation and typed responses | `NOT RUN` |
| EPI | `/dashboard/epis`, EPI assignment pages | `epis.controller.ts`, `epi-assignments.controller.ts` | tenant and role/permission controls | assignment/list payloads typed | `NOT RUN` |
| Checklists | checklist pages/templates/fill flows | `checklists.controller.ts`, public checklist controller | JWT/tenant for management; public contract separated | PDF/upload DTOs and validation source | `NOT RUN` |
| RDO | `/dashboard/rdos`, report pages | `rdos.controller.ts` | tenant context, ownership and role actions | signing/PDF state included in response contracts | `NOT RUN` |
| Photographic Reports | `/dashboard/photographic-reports`, report subroutes | `photographic-reports.controller.ts` | JWT + tenant + roles | multipart images and report DTOs | `NOT RUN` |
| Signatures | APR/DDS/RDO hooks and public verification | `signatures.controller.ts`, public signatures controller | tenant-scoped writes; public verification isolated | keyring/version/status contract present | `NOT RUN` |
| PDF | module PDF hooks/generators and verification UI | PDF services and `pdf-security.controller.ts` | tenant/permission checks before governed access | governed access response and hash fields | `NOT RUN` |
| Uploads | service `FormData` calls and upload UI | `infra/storage/storage.controller.ts` | JWT + TenantGuard + RolesGuard + throttling | presigned/complete upload DTOs | `NOT RUN` |
| Notifications | notification UI/service | `notifications.controller.ts` | JWT and tenant service context | unread/read/read-all contracts | `NOT RUN` |
| Reports | `/dashboard/relatorios/*`, monthly/RDO/photo views | dashboard/module report handlers | tenant-scoped source path | `INFERRED` from service contracts | `NOT RUN` |
| Medical Exams | `/dashboard/medical-exams` | `medical-exams.controller.ts` | tenant/permissions in source | typed service calls | `NOT RUN` |
| Expenses | `/dashboard/expenses` | `expenses.controller.ts` | tenant/ownership source controls | typed list/detail/update contracts | `NOT RUN` |
| Nonconformities | `/dashboard/nonconformities` | `nonconformities.controller.ts` | tenant + role/permission | typed CRUD and validation source | `NOT RUN` |
| Document Registry/Import | registry and import pages | registry/download/import controllers | tenant/permission and governed download | upload/import DTOs | `NOT RUN` |
| Sites | `/dashboard/sites` | `sites.controller.ts` | tenant/site scope source | selected site contract | `NOT RUN` |
| Machines/Tools/Trainings | respective dashboard pages | matching controllers | tenant/role source controls | typed CRUD services | `NOT RUN` |
| Service Orders | `/dashboard/service-orders` | `service-orders.controller.ts` | tenant and permissions | typed service calls | `NOT RUN` |
| CATs | `/dashboard/cats` | `cats.controller.ts`, public CAT controller | tenant plus public validation separation | upload/PDF/access contracts | `NOT RUN` |
| ARR/DID | `/dashboard/arrs`, `/dashboard/dids` | matching controllers | tenant/role source controls | typed workflow/PDF contracts | `NOT RUN` |
| AI/Sophie | `/dashboard/sst-agent` and AI services | AI/SST controllers | authenticated tenant path | typed request/response source | `NOT RUN` |
| Calendar/KPIs/Risk Map | dashboard utility routes | calendar and dashboard controllers | authenticated tenant context | source mapping only | `NOT RUN` |

A comparação estática anterior desta cadeia normalizou 534 endpoints do
backend e 362 strings de endpoint dos serviços frontend, sem `NOT_FOUND` ou
method mismatch. Esse resultado é supporting source evidence; o parser não
foi reexecutado como prova de runtime nesta branch e não substitui E2E.

## Contratos de autenticação, tenant e erros

### Autenticação e sessão

- `frontend/src/lib/api.ts` centraliza Authorization, bootstrap CSRF,
  refresh coordenado e lock de concorrência para refresh.
- O refresh usa cookie `httpOnly` no contrato do backend e headers CSRF
  separados; access token não é tratado como autoridade de tenant.
- `401` tenta refresh uma vez para endpoints não-auth e, se necessário,
  encerra a sessão. `403` não dispara logout: é tratado como ausência de
  autorização/toast.
- `409`, `422` e `429` possuem caminhos distintos no error handler; o
  `Retry-After` é preservado quando disponível.
- O backend mantém guards JWT, tenant e roles/permissions nos módulos
  sensíveis. Autenticação não foi tratada como autorização.

### Tenant, site e cache

- O tenant selecionado é salvo em `sessionStorage` com validação de shape; o
  site tem store separado e também validação.
- A troca de tenant/site limpa dados sensíveis antes de aplicar o novo
  contexto. A correção adicionada nesta branch impede que uma operação
  assíncrona antiga ressuscite tenant/site depois de logout, clear ou troca de
  contexto.
- `clear()` do tenant agora também limpa o site selecionado, evitando estado
  de obra pertencente ao tenant anterior.
- O cliente API mantém tratamento específico para erros de contexto de tenant
  e evita transformar falha de tenant em refresh/logout involuntário.
- RLS live de produção, banco live e cache Redis de produção não foram
  executados nesta sessão. O CI remoto validou E2E/RLS em ambiente PostgreSQL
  isolado; isso permanece distinto de `Production RLS Runtime: NOT RUN`.

### Datas, timezone e payloads

O código usa strings ISO e serialização de API em vários contratos, mas a
matriz completa de datas depende de dados e backend executando em conjunto.
Conversões de horário, limites de dia e relatórios mensais não foram provados
em timezone de teste; status: `PARTIAL / NOT RUN`.

### Upload, PDF e assinatura

- O controller de storage exige JWT/TenantGuard/RolesGuard, valida PDF,
  extensão/content type, usa quarantine/presigned upload e fluxo de complete.
- Os módulos de upload usam interceptors governados e contratos `FormData`;
  a validação de magic bytes, tamanho, AV e cleanup está no backend source,
  mas não foi executada com storage real nesta sessão.
- PDFs governados usam chaves/metadata e validação de tenant no backend;
  URLs e acesso final não foram exercitados em runtime.
- Assinaturas usam serviço de timestamp/keyring versionado, estados legados
  explícitos e comparação constant-time no backend; nenhuma chave ou token
  real foi usado ou registrado.

## QA de produto, acessibilidade e navegador

QA executado em navegador Chrome real contra Next local:

```text
GET /login: 200 — título, logo, skip link, CPF, senha, toggle e submit
GET /forgot-password: 200 — formulário e navegação renderizados
GET /dashboard sem sessão: redirecionou para /login
Viewport 320x568: scrollWidth=320, innerWidth=320 — sem overflow horizontal
Inputs em viewport móvel: 16px — evita zoom automático iOS
Backend API local: ausente — ERR_CONNECTION_REFUSED esperado e não mascarado
Authenticated dashboard E2E: NOT RUN
Backend critical authenticated E2E in isolated CI: PASS
```

Foi verificada a presença de labels/nomes acessíveis, skip link, foco inicial
no formulário e navegação de teclado básica. Não foram executados nesta sessão
um ciclo completo de teclado em todas as 117 rotas, leitor de tela, contraste
automatizado, `prefers-reduced-motion` em todas as telas ou teste real de
mobile authenticated.

Performance de rede, bundle budget e carga não foram medidos. A suíte de
testes e o build não são tratados como prova de performance.

## Findings

### FE-MED-001 — corrida de estado poderia ressuscitar contexto antigo

**Estado:** `CLOSED IN AUDIT BRANCH`; ainda não publicado.
**Componente:** `selectedTenantStore.ts`, `siteStore.ts`.
**Evidência:** `set()` aguardava limpeza assíncrona de storage; um `clear()`
durante essa espera podia permitir que a continuação antiga gravasse tenant ou
site novamente. A limpeza de tenant também não limpava o site selecionado.
**Risco:** estado visual e requisições futuras poderiam apontar para contexto
antigo até o backend rejeitar; isso é relevante para isolamento e integridade
da experiência multi-tenant, embora o backend permaneça autoridade.
**Correção:** versionamento monotônico das transições, guards antes/depois do
`await`, limpeza acoplada tenant→site e testes de regressão.
**Validação:** suíte frontend completa passou; testes focados cobrem clear
durante limpeza, clear antes da execução e limpeza do site.

### FE-LOW-001 — logout por inatividade emitia dois redirects

**Estado:** `CLOSED IN AUDIT BRANCH`; ainda não publicado.
**Componente:** `AuthContext.tsx`, `Sidebar.tsx`.
**Evidência:** o timer chamava `logout()` e depois fazia `router.push()`
separado, enquanto `logout()` também navegava; o callback do Sidebar também
dependia diretamente de uma função assíncrona com assinatura diferente do
handler React.
**Correção:** `logout(redirectPath?)` concentra a navegação e o timer usa
`/login?expired=1`; o botão usa callback explícito.
**Validação:** teste de redirecionamento de sessão expirada e frontend full
passaram.

### FE-LOW-002 — rate-limit de rotas auxiliares depende de IP encaminhado

**Estado:** `OPEN / RECOMMENDATION`; nenhum fix cego aplicado.
**Componentes:** `frontend/app/monitoring-tunnel/route.ts:22-25,55` e
`frontend/app/api/keepalive/route.ts:70`.
**Evidência:** os handlers usam o primeiro `x-forwarded-for` para a chave de
rate-limit local. Sem um contrato de proxy confiável demonstrado na camada
Next, um caller pode variar esse header e reduzir a efetividade do limite por
IP.
**Impacto:** disponibilidade/abuso do tunnel ou keepalive; não foi promovido
como bypass de autenticação. O keepalive exige Authorization/CRON_SECRET em
produção e falha fechado quando a configuração está ausente.
**Classificação solicitada:** o limite usa o primeiro `X-Forwarded-For`
fornecido ao handler (`YES`). O monitoring tunnel não possui autenticação
independente por ser uma rota de ingestão pública; o keepalive possui
autenticação independente em produção por `CRON_SECRET` (`NO` para o tunnel,
`YES` para o keepalive). Não é bypass de autenticação (`NO`). A correção sem
contrato live da borda não é segura (`NO`); manter `OPEN-DEFERRED UNTIL EDGE
CONTRACT`, severidade `LOW`.
**Correção recomendada:** definir a autoridade de proxy na borda e passar um
identificador de peer confiável, ou mover o limite para uma camada com
identidade e estado apropriados. Não assumir CIDR/Cloudflare sem prova live.

### Observações sem finding novo

- `isPublicApiRequest()` usa prefixos para selecionar comportamento de cliente;
  a autoridade continua no matching/guards do backend. Não foi demonstrado
  bypass HTTP e não foi alterado.
- `403` não é convertido em logout pelo cliente.
- `trust proxy=true`/`trust proxy=1` não foi encontrado como solução de
  autorização frontend; o boundary autenticado do backend permanece separado.

## Validação executada

```text
Backend Jest: PASS — 314 suites / 2716 tests / 0 failures
Frontend Jest: PASS — 155 suites passed / 878 tests passed / 2 skipped
Backend lint: PASS
Frontend lint + permission-import check + stylelint: PASS
Backend type-check: PASS
Frontend tsc --noEmit (isolated): PASS
Backend build: PASS
Frontend Next compile: PASS — type-check phase not completed by runner OOM
Frontend Local Production Build: BLOCKED_BY_LOCAL_MEMORY — Next internal type-check OOM
Frontend Remote CI Build: PASS — `Build frontend` succeeded on current PR HEAD
Effective PR Build Gate: PASS
Frontend npm audit --omit=dev --audit-level=high: PASS — 0 vulnerabilities
Backend npm audit --omit=dev --audit-level=high: PASS — 0 vulnerabilities
Semgrep focused changed source: PASS — 0 findings
Gitleaks source/config paths: PASS — no leaks found
Gitleaks broad workspace: NOT PROMOTED — node_modules/cache included; 35 findings
Prettier: baseline focused files already not clean; no broad reformat applied
Git diff --check: PASS
Browser QA local: PASS LIMITED
Playwright authenticated E2E: NOT RUN
PostgreSQL/Redis live integration: NOT RUN
CodeQL local: NOT AVAILABLE
```

### Reconciliação do CI remoto no HEAD atual

```text
PR HEAD validated by CI: 64ceb8841382c665540cb36cb9cd88f459ffcb9b
CI workflow: SUCCESS
Backend Lint/Test/Build: SUCCESS
Frontend Lint/Test/Build: SUCCESS — Build frontend SUCCESS
Backend E2E Critical Flows: SUCCESS — isolated PostgreSQL/RLS environment
Backend E2E DR Restore (Dedicated Postgres): SUCCESS
PostgreSQL 17 Migration 0392 Integration: SUCCESS
Security Scan: SUCCESS — CodeQL jobs, Semgrep, Gitleaks, Docker, SBOM and dependency checks
Secret Guard: SUCCESS
Required Checks: SUCCESS — 25/25 current checks
CI Pending: 0
CI Failed: 0
```

O warning `MaxListenersExceededWarning` apareceu na suíte backend e não foi
suprimido. A primeira falha de teste ocorreu enquanto `npm ci` ainda estava
incompleto; depois da reinstalação serializada a suíte passou integralmente.

## Segurança e release

```text
Open Critical: 0
Open High: 0
Open Medium: 0
Open Low: 1 — FE-LOW-002
Production credentials used: NO
Production access: NO
Production changed: NO
Production migration: 0
Production deploy: NO
Coolify/Traefik/firewall/DNS changed: NO
Storage DR: OUT OF SCOPE / STILL BLOCKED
Real tenant/customer data used: NO
```

Os findings fechados nesta branch só podem ser considerados ativos no release
após revisão, commit/PR e publicação autorizados. O finding baixo restante é
dependente da topologia real de proxy e deve ser resolvido com contrato de
infraestrutura comprovado, não com confiança em header arbitrário.

## Status final obrigatório

```text
Repository: wandersongandra/sgsseguranca
Frozen Cutover Base SHA: 03f1574ee6e82558630e82d0a50a08361f8ee6d5
Audit Branch: audit/frontend-backend-product-integration-release
Audit Branch Initial SHA: 03f1574ee6e82558630e82d0a50a08361f8ee6d5
Audit Branch Current SHA: 64ceb8841382c665540cb36cb9cd88f459ffcb9b
Current PR HEAD: 64ceb8841382c665540cb36cb9cd88f459ffcb9b
Frontend↔Backend Integration: PASS WITH DEFERRED LOW
Static Contract Inventory: PASS LIMITED — source evidence only
Frontend Full Regression: PASS — 155 suites / 878 tests passed
Backend Full Regression: PASS — 314 suites / 2716 tests passed
Frontend Type-check: PASS — isolated tsc
Backend Type-check: PASS
Frontend Lint: PASS
Backend Lint: PASS
Backend Build: PASS
Frontend Local Build: BLOCKED_BY_LOCAL_MEMORY after successful compile
Frontend Remote CI Build: PASS
Effective PR Build Gate: PASS
Dependency Audit: PASS — frontend/backend 0 high or critical
Semgrep: PASS focused scope
Gitleaks: PASS source/config scope
Browser QA: PASS LIMITED — public local routes
Authenticated E2E: NOT RUN
Backend Critical E2E CI: PASS — isolated environment
Database DR Restore CI: PASS — isolated dedicated PostgreSQL
PostgreSQL 17 CI: PASS
Postgres/Redis Local Runtime: NOT RUN
Production RLS Runtime: NOT RUN
Storage/B2 Runtime: NOT RUN
Storage DR: OUT OF SCOPE / STILL BLOCKED
Open Critical: 0
Open High: 0
Open Medium: 0
Open Low: 1
Production Access: NO
Production Changed: NO
Production Migration: 0
Production Deploy: NO
Production Authenticated Proxy Activation: NO
Production Final Readiness: NO — runtime and production gates pending
Commit: CREATED — focused audit changes
Push: YES — audit branch
PR: OPEN — #339
PR Title: fix(frontend): harden tenant state and session logout
PR Title Accurate: YES
Report Reconciled: YES
Merge: NO
Deploy: NO
```

## Próximos passos bloqueados

1. Revisar o PR #339 e os sete arquivos funcionais com seus testes focados.
2. Manter o OOM local registrado; o build remoto do HEAD atual já passou e é
   a evidência autoritativa do gate de build do PR.
3. Disponibilizar um backend isolado Postgres/Redis ou VPS de teste executável
   para repetir E2E frontend autenticado, contratos 401/403/409/422/429,
   upload, PDF, assinatura, restart e recovery.
4. Triar `FE-LOW-002` com o owner da borda/proxy e mantê-lo deferido até o
   contrato de proxy ser comprovado.
5. Não mergear sem autorização separada. Storage DR só deve ser tratado
   quando a VPS/Coolify e o mecanismo aprovado estiverem disponíveis.

**Conclusão:** a revisão final do PR #339 reconciliou a evidência local com o
GitHub: a base congelada permaneceu intacta, o HEAD atual foi separado da base,
os três commits são do escopo esperado, o CI remoto do HEAD passou e o build
frontend remoto resolveu a limitação de memória local sem apagar seu registro.
Os testes focados passaram, FE-MED-001 e FE-LOW-001 estão fechados nesta
branch, e FE-LOW-002 permanece LOW/deferido até contrato da borda. O PR está
pronto para decisão futura de merge, não para merge, deploy ou cutover.

PARAR.

---

## Addendum — PR #339 final review e reconciliação do CI

**Data da evidência:** 02/09/2026
**Escopo:** revisão final do diff do PR, reconciliação com o GitHub e baseline
de produto. Nenhuma auditoria ampla adicional, operação de produção ou
configuração de Storage DR foi executada.

### Estado autoritativo

```text
Repository: wandersongandra/sgsseguranca
PR: #339
PR State: OPEN
PR Draft: NO
PR Mergeable: YES
Base Branch: main
Frozen Cutover Base SHA: 03f1574ee6e82558630e82d0a50a08361f8ee6d5
PR Current HEAD: 64ceb8841382c665540cb36cb9cd88f459ffcb9b
Audit Branch Initial SHA: 03f1574ee6e82558630e82d0a50a08361f8ee6d5
Audit Branch Current SHA: 64ceb8841382c665540cb36cb9cd88f459ffcb9b
Commits: 3
Changed Files: 8
Additions: 530
Deletions: 18
Unexpected Commits: 0
Unexpected Files: 0
```

Os três commits são os esperados para esta branch: correções tenant/site,
correção do logout/callback React, testes de regressão e documentação da
auditoria. A lista real do GitHub contém oito arquivos e não contém secrets,
credenciais Backblaze ou arquivos de produção.

### Revisão dos arquivos do PR

```text
frontend/src/lib/selectedTenantStore.ts: Expected YES; Security Relevant YES; Functional Change YES; Tests YES; Finding NONE
frontend/src/lib/selectedTenantStore.test.ts: Expected YES; Security Relevant YES; Functional Change NO; Tests N/A; Finding NONE
frontend/src/lib/siteStore.ts: Expected YES; Security Relevant YES; Functional Change YES; Tests YES; Finding NONE
frontend/src/lib/siteStore.test.ts: Expected YES; Security Relevant YES; Functional Change NO; Tests N/A; Finding NONE
frontend/src/state/AuthContext.tsx: Expected YES; Security Relevant YES; Functional Change YES; Tests YES; Finding NONE
frontend/src/state/AuthContext.test.tsx: Expected YES; Security Relevant YES; Functional Change NO; Tests N/A; Finding NONE
frontend/src/components/Sidebar.tsx: Expected YES; Security Relevant NO; Functional Change YES; Tests YES; Finding NONE
docs/audits/FRONTEND-BACKEND-INTEGRATION-AUDIT-2026-09.md: Expected YES; Security Relevant YES; Functional Change NO; Tests N/A; Finding NONE
```

O versionamento monotônico invalida continuações antigas antes e depois do
`await`; `set(B)` vence `set(A)` enfileirado quando necessário, e `clear()`
impede a ressuscitação. `selectedTenantStore` importa `siteStore`, mas não há
import inverso. O schema de `sessionStorage` continua validado e o acesso
permanece protegido contra SSR.

`clearAuthenticatedSession()` limpa token, sessão, refresh hint, caches,
storage sensível, tenant e site antes do redirect. `logout()` mantém o
comportamento padrão para callers existentes e aceita o caminho explícito do
timer. O Sidebar usa callback explícito, portanto nenhum `MouseEvent` pode ser
interpretado como caminho de redirect.

### Reconciliação do CI remoto

```text
CI HEAD: 64ceb8841382c665540cb36cb9cd88f459ffcb9b
CI: SUCCESS
Backend Lint/Test/Build: SUCCESS
  lint: SUCCESS
  typecheck: SUCCESS
  tests: SUCCESS
  build: SUCCESS
  migration validation: SUCCESS
Frontend Lint/Test/Build: SUCCESS
  dependency audit: SUCCESS
  lint: SUCCESS
  tests: SUCCESS
  build: SUCCESS
Backend E2E Critical Flows: SUCCESS — PostgreSQL/RLS isolado
Backend E2E DR Restore (Dedicated Postgres): SUCCESS — PostgreSQL dedicado isolado
PostgreSQL 17 Migration 0392 Integration: SUCCESS
Security Scan: SUCCESS — CodeQL jobs, Semgrep, Gitleaks, Docker, SBOM e dependências
Secret Guard: SUCCESS
Required Checks: SUCCESS — 25/25
Pending: 0
Failed: 0
```

O job remoto `Build frontend` do mesmo HEAD concluiu com sucesso. O OOM do
type-check interno do Next local permanece como limitação histórica do
runner, e não foi apagado nem mascarado; a conclusão correta é
`Frontend Local Build: BLOCKED_BY_LOCAL_MEMORY`, `Frontend Remote CI Build:
PASS` e `Effective Build Gate: PASS`.

### FE-LOW-002 e segurança

```text
Monitoring tunnel uses caller-controlled first X-Forwarded-For: YES
Keepalive uses caller-controlled first X-Forwarded-For: YES
Monitoring tunnel independently authenticated: NO — public ingestion route
Keepalive independently authenticated in production: YES — CRON_SECRET
Authentication bypass demonstrated: NO
Current Severity: LOW
Safe fix without live edge contract: NO
Disposition: OPEN-DEFERRED UNTIL EDGE CONTRACT
```

Não foi aplicado `trust proxy=true`, `trust proxy=1`, CIDR arbitrária ou
correção cega. O limite local dessas rotas continua uma recomendação de
disponibilidade/abuso, não um bypass de autenticação demonstrado.

### Relatório final obrigatório

```text
Repository: wandersongandra/sgsseguranca
PR: #339
PR State: OPEN
PR Draft: NO
PR Mergeable: YES
Base Branch: main
Frozen Cutover Base SHA: 03f1574ee6e82558630e82d0a50a08361f8ee6d5
PR Current HEAD: 64ceb8841382c665540cb36cb9cd88f459ffcb9b
Commits: 3
Changed Files: 8
Unexpected Commits: 0
Unexpected Files: 0
Tenant Store Review: PASS
Site Store Review: PASS
AuthContext Review: PASS
Sidebar Review: PASS
Focused Tests: PASS — 3 suites / 15 tests
Frontend Full Tests: PASS — 155 suites / 878 tests / 2 skipped
Backend Full Tests: PASS — 314 suites / 2716 tests
Frontend Local Build: BLOCKED_BY_LOCAL_MEMORY
Frontend Remote CI Build: PASS
Effective Build Gate: PASS
Backend Build CI: PASS
Critical E2E CI: PASS
RLS Isolated CI: PASS
Database DR Restore CI: PASS
PostgreSQL 17 CI: PASS
Security Scan: PASS
Secret Guard: PASS
Required Checks: PASS
CI Pending: 0
CI Failed: 0
FE-MED-001: CLOSED
FE-LOW-001: CLOSED
FE-LOW-002: OPEN-DEFERRED
Critical: 0
High: 0
Medium: 0
Low: 1
Report Reconciled: YES
PR Title Accurate: YES — fix(frontend): harden tenant state and session logout
Production Access: NO
Production Changed: NO
Production Migration: 0
Production Deploy: NO
Storage DR: OUT OF SCOPE / STILL BLOCKED
Main Merge: NO
Frozen Cutover Release Preserved: YES
Functional Code Changed After Initial Fix: NO
Tests Changed After Initial Fix: NO
Migrations Changed: NO
Backend Production Code Changed: NO
Secrets Added: 0
Commit: YES — docs(audit): reconcile PR 339 remote CI evidence
Push: YES — audit/frontend-backend-product-integration-release
Merge: NO
Ready For Review: YES
Ready For Merge Decision: YES
Ready For Production Cutover: NO — this gate does not authorize cutover
PR #339 REVIEW GATE: PASS WITH DEFERRED LOW
FINAL VERDICT: PASS WITH DEFERRED LOW
```

`main` continua no SHA congelado. Produção, Storage DR, Neon de produção,
Backblaze, Redis de produção, Coolify, Traefik, firewall e DNS permaneceram
intocados. O PR está pronto para decisão futura de merge, mas esta missão
proíbe o merge.

PARAR.
