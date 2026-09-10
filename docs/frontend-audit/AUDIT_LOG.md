# Frontend hardening audit log

Repositório: `wandersongandra/sgsseguranca`
Worktree: `C:\Users\User\Documents\trae_projects\sgs-frontend-hardening-20260909`
Branch: `fix/frontend-hardening-phase1`
START_MAIN_SHA: `3a3cc0232e168dab8d42e76fd814cfbdc573dc10`

## GATE SETUP/BASELINE

- **Comando ou inspeção:** `git fetch origin`; `git rev-parse origin/main`; `git worktree add -b audit/frontend-hardening-phase1 ... origin/main`; inspeção de `git status --short` no checkout original e no worktree.
- **Evidência:** `docs/frontend-audit/BASELINE.md:3-7,29-34`; worktree criado no caminho solicitado e checkout original preservado.
- **Classificação:** CONFIRMED / baseline isolado.
- **Ação tomada:** nenhuma correção; somente criação do worktree e registro.

## GATE BASELINE

- **Comando ou inspeção:** `npm ci`; `npm run lint`; `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --pretty false`; `npm run test:ci`; `npm run build`; `npm audit`.
- **Evidência:** `docs/frontend-audit/BASELINE.md:13-26`.
- **Classificação:** PASS com `npm run build` BLOCKED por `NEXT_PUBLIC_API_URL` ausente.
- **Ação tomada:** nenhuma correção antes do registro; bloqueio de ambiente mantido explícito.

## GATE A1 TENANT_ISOLATION

- **Comando ou inspeção:** busca repo-wide por tenantId/selectedTenant/cache/storage e leitura dos fluxos de cache, paginação, seleção de tenant/site e logout; testes direcionados de cache, paginação e transição de sessão.
- **Evidência:** frontend/src/hooks/useCachedFetch.ts:18,74,117,157,177,218,236 e frontend/src/services/pagination.ts:46,91,116,140,172,204 agora associam leitura/escrita ao escopo e a uma geração de cache. frontend/src/lib/auth-session-state.ts:78-86 limpa caches, token, sessão, dica, tenant e site. frontend/src/lib/selectedTenantStore.ts:16,63-84 e frontend/src/lib/siteStore.ts:18,78-110 invalidam transições assíncronas pendentes. Testes frontend/src/hooks/useCachedFetch.test.ts:22-48, frontend/src/services/pagination.test.ts:107-135 e frontend/src/lib/auth-session-logout.test.ts:22-55 passaram; antes da correção, os testes de cache restauravam dados do tenant A depois do clear.
- **Classificação:** CONFIRMED: regressão frontend de revalidação/cache após troca ou logout, corrigida. BACKEND_CONTRACT_BLOCKER: o frontend não prova isolamento autoritativo de endpoints, exports, downloads, WebSocket, jobs ou storage.
- **Contrato backend esperado/observado/risco:** esperado: cada request e recurso retornado deve derivar tenant do contexto autenticado e rejeitar cross-tenant, independentemente de tenantId enviado pelo cliente. Observado: inspeção frontend só mostra escopo local; servidor/RLS não está em alcance. Risco: se o contrato backend faltar, cache seguro no cliente não impede vazamento cross-tenant.
- **Ação tomada:** adicionados guards de geração/escopo e limpeza assíncrona; não alterado backend. Contrato bloqueador registrado para validação própria.

## GATE A2 AUTH_SESSION_REFRESH_LOGOUT

- **Comando ou inspeção:** leitura de frontend/src/services/authService.ts, frontend/src/state/AuthContext.tsx e frontend/src/lib/auth-session-state.ts; testes de concorrência de refresh/logout e limpeza de sessão.
- **Evidência:** frontend/src/services/authService.ts:57-149 implementa refreshInFlight/logoutInFlight; frontend/src/state/AuthContext.tsx:151-156,196-200,222,253,289-296 limpa estado React imediatamente, aguarda limpeza e usa logger; frontend/src/lib/auth-session-state.ts:78-86 aguarda storage sensível. frontend/src/services/authService.test.ts:226-273 e frontend/src/lib/auth-session-logout.test.ts:22-55 passaram. O teste de concorrência falhava antes com duas chamadas api.post para uma única operação.
- **Classificação:** CONFIRMED: refresh single-flight e logout single-flight/atômico no estado frontend corrigidos. BACKEND_CONTRACT_BLOCKER: autenticação, revogação e rotação real de refresh token dependem do servidor.
- **Contrato backend esperado/observado/risco:** esperado: POST /auth/refresh aceitar somente sessão/refresh válido, rotacionar/revogar conforme contrato e responder token/estado documentados; POST /auth/logout invalidar a sessão no servidor e responder sucesso idempotente. Observado: chamadas frontend existem, mas backend está fora de alcance e não foi exercitado. Risco: sem revogação server-side, limpar armazenamento local não encerra sessão roubada; sem resposta contratual estável, o single-flight pode mascarar erro.
- **Ação tomada:** barreiras de single-flight, limpeza imediata e awaiting do clear. Nenhuma chamada real a backend/produção.

## GATE A3 SSR_CACHE

- **Comando ou inspeção:** busca por unstable_cache, force-cache, revalidate e fetches server-side; inspeção das páginas de login, validação pública e keepalive.
- **Evidência:** frontend/app/(auth)/login/page.tsx:6 declara dynamic = force-dynamic; frontend/app/validar/[code]/page.tsx:173 usa cache: no-store; frontend/app/api/keepalive/route.ts:98 usa cache: no-store. Não foram encontrados unstable_cache ou force-cache em frontend para dados autenticados.
- **Classificação:** PASS estático; runtime/build de SSR não verificado porque o build permanece bloqueado por NEXT_PUBLIC_API_URL ausente.
- **Ação tomada:** nenhuma alteração necessária no gate. Manter validação visual/runtime bloqueada até fornecer configuração de build não secreta e aprovada.

## GATE A4 SECRETS

- **Comando ou inspeção:** busca de chaves/tokens/credenciais em frontend, process.env e bundle sources; leitura da rota keepalive.
- **Evidência:** frontend/app/api/keepalive/route.ts:37-49 lê CRON_SECRET somente no handler server-side; o frontend não deve receber esse valor. frontend/src/lib/api.ts:23,45 exige NEXT_PUBLIC_API_URL explicitamente para o build protegido, sem fallback implícito em produção. Nenhuma credencial real foi encontrada no escopo frontend durante a busca.
- **Classificação:** PASS estático para ausência de segredo evidente no código; bundle não pôde ser inspecionado porque o build foi bloqueado.
- **Ação tomada:** nenhum segredo adicionado ou exposto. NEXT_PUBLIC_API_URL foi tratado como configuração pública obrigatória, não como segredo.

## GATE A5 ROUTE_MATCHING

- **Comando ou inspeção:** busca histórica por startsWith/includes("admin"/pathname e testes de rotas públicas, proxy, API e contexto de IA.
- **Evidência:** frontend/src/lib/route-config.ts:79-109 exporta matchesPathSegment e usa correspondência exata/por segmento; frontend/proxy.ts:30-36, frontend/src/lib/api.ts:194-206,233-236,586-587,691-699 e frontend/src/lib/ai-context.ts:30-136 usam o matcher. frontend/src/lib/route-config.test.ts:51-53, frontend/proxy.test.ts:88-97, frontend/src/lib/api.test.ts:113-126 e frontend/src/lib/ai-context.test.ts:4-14 passaram. Antes, rotas como /login-evil, /api-evil e /dashboard/pts-evil eram aceitas por prefixo e recebiam tratamento indevido.
- **Classificação:** CONFIRMED: matcher amplo de rota corrigido no frontend.
- **Ação tomada:** menor mudança estrutural: helper comum de segmento, sem troca de router. Cobertura negativa adicionada para prefixos maliciosos.

## GATE A6 OPEN_REDIRECT

- **Comando ou inspeção:** localização de window.open/location e leitura de frontend/src/lib/safe-external-url.ts, LoginPageClient, ChecklistSection e RdoPage; testes de URLs externas e QR/MFA.
- **Evidência:** frontend/src/lib/safe-external-url.ts:70-112 centraliza allowlist de origem/protocolo; frontend/app/(auth)/login/LoginPageClient.tsx:49-63,180 valida otpauth apenas para host totp/hotp; frontend/app/dashboard/pts/components/ChecklistSection.tsx:125-132 bloqueia URL de artefato insegura; frontend/app/dashboard/relatorios/rdos/RdoPage.tsx:1326-1334 usa isSafeImagePreviewUrl. frontend/app/(auth)/login/LoginPageClient.test.tsx:113-134 e frontend/app/dashboard/pts/components/ChecklistSection.test.tsx:84-99 passaram. Antes, javascript: era renderizado/aberto pelos caminhos testados.
- **Classificação:** CONFIRMED: open redirect/URL injection frontend corrigido nos sinks auditados. BACKEND_CONTRACT_BLOCKER: URLs de anexos/assinaturas precisam autorização, tenant e expiração server-side.
- **Contrato backend esperado/observado/risco:** esperado: GET/download de attachment ou assinatura validar usuário, tenant, ownership/permissão, recurso e expiração; responder somente URL/recurso autorizado. Observado: frontend só aplica allowlist local; servidor não auditado. Risco: URL HTTPS permitida pode continuar sendo um recurso cross-tenant se o backend assinar sem autorização.
- **Ação tomada:** allowlists e testes negativos; nenhuma ampliação de contrato backend.

## GATE B1 RBAC_UX

- **Comando ou inspeção:** leitura do guard de dashboard, Sidebar, permissões de documentos e estados read-only/finalizados; busca de controles condicionais de UI.
- **Evidência:** frontend/app/dashboard/layout.tsx:108-127,164-171 protege a entrada e o frontend/app/dashboard/components/Sidebar.tsx:62-67 filtra navegação por permissão. frontend/app/dashboard/components/documentActionPolicy.ts:15-40 concentra políticas de ação; APR e checklist usam readOnly/disabled nos caminhos auditados. Testes de policy existentes passaram no test:ci final.
- **Classificação:** PASS de UX/RBAC aparente. BACKEND_CONTRACT_BLOCKER: autorização real não pode depender de Sidebar, route guard ou disabled.
- **Contrato backend esperado/observado/risco:** esperado: cada endpoint mutável validar identidade, tenant, ownership/recurso, role/permissão e estado permitido, retornando 401/403 conforme contrato. Observado: backend/RLS fora do escopo e não exercitado. Risco: usuário pode chamar API diretamente mesmo com UI oculta.
- **Ação tomada:** nenhuma falsa elevação de confiança; mantidos guards de UX e bloqueador explícito server-side.

## GATE B2 STALE_ASYNC_PT_FORM

- **Comando ou inspeção:** busca de loaders em PtForm, incluindo ausência de AbortController/flag de versão; inspeção de loaders de assinaturas e testes deferred.
- **Evidência:** frontend/app/dashboard/pts/components/PtForm.tsx:1274-1535 usa flag active em loadData/loadCompanies e protege state, catch e finally; loaders dependentes já mantêm guards em :1540-1735. frontend/src/components/SignaturesPanel.tsx:67-92 limpa estado no início e ignora resposta/erro/finally tardios. frontend/app/dashboard/pts/components/PtForm.test.tsx:635-664 e frontend/src/components/SignaturesPanel.test.tsx:26-74 passaram. Antes, a resposta do ID antigo sobrescrevia a do novo documento; os testes reproduziram esse resultado.
- **Classificação:** CONFIRMED: stale async severo corrigido em PtForm e SignaturesPanel.
- **Ação tomada:** menor correção por flag de ciclo de vida, sem trocar camada de dados. Testes de regressão adicionados.

## GATE B3 MUTATION_SAFETY

- **Comando ou inspeção:** busca de submit/delete/update, disabled/isSubmitting, window.confirm/confirm e teste de duplo submit.
- **Evidência:** frontend/src/hooks/useFormSubmit.ts:19-29,49-52 usa barreira síncrona em ref; frontend/app/(auth)/login/LoginPageClient.tsx:250-271,430-433 desabilita controles durante login. frontend/src/hooks/useFormSubmit.test.tsx:32-48 passou; antes a função de mutação era chamada duas vezes no mesmo ciclo.
- **Classificação:** CONFIRMED: hook de submit corrigido. P1_REMAINING: handlers destrutivos fora do hook ainda não têm uma barreira síncrona uniforme; ocorrências principais em frontend/app/dashboard/activities/page.tsx:68-85, frontend/app/dashboard/audits/page.tsx:313-330, frontend/app/dashboard/checklists/hooks/useChecklists.tsx:247-280, frontend/app/dashboard/dids/hooks/useDids.ts:381-407 e frontend/app/dashboard/service-orders/page.tsx:322-332.
- **Contrato backend esperado/observado/risco:** esperado: DELETE/mutações críticas serem idempotentes ou protegidas por chave de idempotência/constraint/transação no servidor. Observado: backend fora do escopo. Risco: double-submit de UI ou retry pode gerar exclusão/duplicidade.
- **Ação tomada:** corrigido o caminho compartilhado useFormSubmit; handlers diretos foram registrados como pendência P1 para não afirmar cobertura inexistente.

## GATE B4 DOM_XSS

- **Comando ou inspeção:** busca por dangerouslySetInnerHTML, innerHTML, DOMParser, eval, new Function e sinks de URL; leitura de QR/MFA, artefatos, imagens e script inline.
- **Evidência:** frontend/app/layout.tsx:110 contém somente DEV_CACHE_RESET_INLINE_SCRIPT estático, sem interpolação de input; não foram encontrados sinks dinâmicos equivalentes. frontend/app/(auth)/login/LoginPageClient.tsx:49-63,180, frontend/app/dashboard/pts/components/ChecklistSection.tsx:125-132, frontend/app/dashboard/relatorios/rdos/RdoPage.tsx:1326-1334 e frontend/src/components/SignaturesPanel.tsx:53-61,122-129 passam por allowlists. Testes LoginPageClient.test.tsx:113-134, ChecklistSection.test.tsx:84-99 e SignaturesPanel.test.tsx:13-21 passaram; antes javascript: era aceito nos caminhos cobertos.
- **Classificação:** CONFIRMED: sinks auditados não aceitam javascript/data SVG. BACKEND_CONTRACT_BLOCKER: XSS/tenant safety de resposta de anexos e assinaturas depende também da origem e autorização server-side.
- **Contrato backend esperado/observado/risco:** esperado: URL/recurso retornado para attachment/signature ser autorizado por usuário/tenant/ownership, com MIME e expiração coerentes. Observado: apenas validação frontend foi exercitada. Risco: HTTPS permitido localmente ainda pode apontar para recurso indevido ou conteúdo ativo se o servidor assinar incorretamente.
- **Ação tomada:** sanitização centralizada onde aplicável e testes negativos; nenhuma alteração backend.

## GATE B5 IMMUTABILITY_UX

- **Comando ou inspeção:** leitura de documentActionPolicy e formulários APR/PT/checklist finalizado; teste unitário da policy.
- **Evidência:** frontend/app/dashboard/components/documentActionPolicy.ts:15-40 define ações permitidas; frontend/app/dashboard/pts/components/AprForm.tsx:311-318,525-550 e frontend/app/dashboard/pts/components/PtForm.tsx:2201,2437,2550-2596 refletem readOnly/disabled; checklist finalizado usa o mesmo padrão. Testes de policy e suíte completa passaram.
- **Classificação:** PASS de UX de imutabilidade. BACKEND_CONTRACT_BLOCKER: estado final e transições permitidas precisam ser autoridade do servidor.
- **Contrato backend esperado/observado/risco:** esperado: mutações de documento finalizado responderem 409/403 conforme contrato e não aceitarem bypass de disabled. Observado: backend fora do escopo. Risco: alteração de documento final por chamada direta ou corrida.
- **Ação tomada:** nenhuma mudança de contrato; evidência de UI separada da garantia server-side.

## GATE B6 LOGGER_PII

- **Comando ou inspeção:** localização do logger central, busca de console e teste de dados sensíveis em args, Error e URLs.
- **Evidência:** frontend/src/lib/logger.ts:10-99 sanitiza recursivamente chaves sensíveis, Bearer, CPF, email, query params, Error, circularidade e truncamento; :101-121 aplica sanitização a todos os níveis. frontend/src/lib/error-handler.ts:217-223,281, frontend/src/state/AuthContext.tsx:253 e frontend/src/components/AppErrorBoundary.tsx:28-30 usam o logger. frontend/src/lib/logger.test.ts:8-53 passou; antes password e signature-secret apareciam no mock do console. Busca residual encontrou console somente no próprio logger, e2e/scripts fora do runtime de produção.
- **Classificação:** CONFIRMED: logger central com redaction de PII/segredos corrigido no frontend.
- **Ação tomada:** substituídos consumers diretos relevantes por logger e adicionados testes de regressão; nenhum valor secreto foi impresso no relatório.

## GATE B7 ATTACHMENT_BLOB

- **Comando ou inspeção:** localização do utilitário de download/print, todos os URL.createObjectURL/revokeObjectURL e allowlist de attachment.
- **Evidência:** frontend/src/lib/print-utils.ts:5-10,21-50 valida URL e agenda revokeBlobUrlLater; frontend/src/lib/security/safe-external-url.ts:70-112 restringe origem/protocolo. O RDO revoga URL local em frontend/app/dashboard/relatorios/rdos/RdoPage.tsx:1717-1720; demais ocorrências inspecionadas usam revoke local ou utilitário central. frontend/src/lib/print-utils.test.ts:82-103 passou com fake timers; antes não havia revoke agendado.
- **Classificação:** CONFIRMED: vazamento de blob URL nos caminhos centrais corrigido. BACKEND_CONTRACT_BLOCKER: download de attachment ainda requer autorização/tenant/expiração no servidor.
- **Ação tomada:** revogação tardia para permitir consumo pelo novo contexto e allowlist compartilhada; não revogar imediatamente para não quebrar aba/print.

## GATE C P2_P3_STATIC

- **Comando ou inspeção:** busca dos itens históricos restantes: window.confirm/confirm, window.alert/alert, mobile/a11y, criação de blob URL e EOL; inspeção de .gitattributes e dos dois arquivos verify.
- **Evidência:** confirms nativos ainda existem em frontend/app/dashboard/activities/page.tsx:69, frontend/app/dashboard/audits/page.tsx:314, frontend/app/dashboard/checklists/hooks/useChecklists.tsx:277, frontend/app/dashboard/dids/hooks/useDids.ts:388, frontend/app/dashboard/service-orders/page.tsx:323, além de expenses/[id], epis, risks, machines, tools, sites, checklist-models e photographic-reports. São backlog P2/P3 de UX, com sobreposição ao P1 de double-submit já registrado. frontend/app/verify/page.tsx contém 559 linhas CRLF e frontend/app/verify/page.test.tsx contém 271 linhas CRLF; .gitattributes exige *.tsx text eol=lf. git diff --ignore-space-at-eol nos dois arquivos retornou zero linhas.
- **Classificação:** P2/P3_REMAINING: confirm nativo e normalização EOL preexistente. A validação mobile, teclado/foco, a11y funcional, toasts e skeletons ficou não verificada por falta de build/browser.
- **Ação tomada:** não alterados os dois arquivos verify nem o commit local antigo 328ade5b da worktree descartável; nenhum redesign ou troca de modal nesta fase. Os handlers destrutivos diretos permanecem explicitamente pendentes.

## GATE C BROWSER_VISUAL

- **Comando ou inspeção:** tentativa de npm run build após as correções e preparação para inspeção em navegador real.
- **Evidência:** npm run build encerrou com exit 1 no prebuild: [env] NEXT_PUBLIC_API_URL é obrigatória para build/start protegidos. Nenhum deploy deve depender de fallback implícito. Sem build, não houve servidor frontend nem evidência real de desktop/tablet/mobile, foco/teclado ou prefers-reduced-motion.
- **Classificação:** BLOCKED / TEST_BLOCKER de ambiente; não é falha funcional inferida do código.
- **Ação tomada:** nenhum valor de ambiente inventado, nenhum deploy e nenhum teste contra produção. Visual/browser fica para fase posterior após configuração autorizada.

## GATE FINAL_VALIDATION

- **Comando ou inspeção:** npm run lint; NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --pretty false; npm run test:ci; npm audit; git diff --check; git status --short --branch.
- **Evidência:** lint exit 0 com PERMISSION_IMPORTS_OK e Stylelint concluído; typecheck exit 0 sem saída; test:ci exit 0, 1 suíte skipped, 160 passed de 161 total, 2 testes skipped e 892 passed de 894; npm audit exit 0, found 0 vulnerabilities; git diff --check sem saída. Status mostra somente frontend/** alterado e docs/frontend-audit/** novo no worktree isolado.
- **Classificação:** PASS nos checks executáveis; STATUS=PARTIAL pela ausência de NEXT_PUBLIC_API_URL, browser visual/E2E autenticado e contratos backend.
- **Ação tomada:** revisão final do diff feita; nenhuma alteração em backend, migrations, workflows, produção ou branch compartilhado; sem commit/push/PR/merge/deploy.

## GATE RESIDUAL_SCOPE

- **Comando ou inspeção:** git status --short; git rev-parse HEAD; git log --oneline --decorate -10; verificação de escopo.
- **Evidência:** HEAD permaneceu 3a3cc0232e168dab8d42e76fd814cfbdc573dc10; origin/main no início e no fim permaneceu no mesmo SHA. SCOPE_CHECK=PASS: somente frontend/**, docs/frontend-audit/** e testes/helpers frontend novos aparecem no worktree. BACKEND_CHANGED=NO, MIGRATIONS_CHANGED=NO, CI_WORKFLOW_CHANGED=NO, PRODUCTION_CHANGED=NO.
- **Classificação:** CONFIRMED / escopo íntegro.
- **Ação tomada:** preservado o checkout compartilhado; nenhum arquivo verify/* foi tocado.

## GATE RESIDUAL_DOUBLE_SUBMIT

- **Comando ou inspeção:** inspeção dos handlers destrutivos históricos; teste red-green de frontend/src/lib/mutation-lock.test.ts; busca final de confirm().
- **Evidência:** frontend/src/lib/mutation-lock.ts:1-18 adquire a trava antes da Promise, descarta concorrência e libera em finally. O helper é usado nos handlers de activities:75, audits:320, checklist bulk:253, dids:394, service-orders:326, epis:76, expenses:194,237, machines:69, photographic reports:617,839, risks:76, checklist-models:126, sites:79 e tools:72. A tentativa pré-implementação do teste falhou por módulo ausente; portanto a evidência pré-fix dos handlers é CODE_PATH_REPRODUCED, não um teste comportamental. Após a implementação passou: Test Suites 1 passed, Tests 1 passed. O teste chama a mutation duas vezes antes de rerender, rejeita a primeira e confirma nova tentativa posterior.
- **Classificação:** CONFIRMED: P1_OPEN=0. A trava cobre a mesma ação quando há caminhos desktop/mobile ou handlers equivalentes; confirm nativo permanece somente questão de UX.
- **Ação tomada:** adicionada uma barreira síncrona tipada e reutilizada; nenhuma dependência nova, debounce ou alteração de backend.

## GATE RESIDUAL_BUILD

- **Comando ou inspeção:** leitura de frontend/scripts/check-required-env.mjs e frontend/scripts/public-env.mjs; npm run build com configuração pública local sintética.
- **Evidência:** NEXT_PUBLIC_API_URL_REQUIREMENT=URL absoluta http:// ou https://; build protegido também exige NEXT_PUBLIC_APP_URL. BUILD_ENV_USED=NEXT_PUBLIC_API_URL=http://127.0.0.1:3001 e NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000. O build não precisou de endpoint ativo: compilou, terminou TypeScript, coletou dados e gerou páginas 91/91 sem request de rede observado. BUILD_RESULT=PASS.
- **Classificação:** BUILD_CONFIGURATION_MISSING no baseline, separado de BUILD_APPLICATION_FAILURE; depois corrigido apenas no processo por configuração pública sintética não secreta.
- **Ação tomada:** nenhum endpoint de produção, credencial ou fallback foi criado.

## GATE RESIDUAL_PUBLIC_BROWSER

- **Comando ou inspeção:** servidor local do build em 127.0.0.1:3000; smoke real em Chrome instalado; rotas /login, /forgot-password e /dashboard.
- **Evidência:** LOGIN_STATUS=200; FORGOT_STATUS=200; DASHBOARD_REDIRECT=http://127.0.0.1:3000/login; CLIENT_SECRET_MARKERS=NONE; CONSOLE_ERRORS=0; PAGE_ERRORS=0.
- **Classificação:** CONFIRMED: boot e navegação pública básica passaram em browser real.
- **Ação tomada:** servidor local encerrado ao final; nenhuma autenticação fabricada e nenhum teste contra produção.

## GATE RESIDUAL_PUBLIC_E2E

- **Comando ou inspeção:** execução do spec existente frontend/e2e/public-mobile.spec.ts com dois projetos temporários apontando para Chrome do sistema, um mobile 390x844 e um desktop 1440x900, workers=1.
- **Evidência:** 6 passed (15.9s), sem alteração do spec ou asserts. A execução padrão com 24 projetos não lançou por ausência de binários Playwright; a tentativa de download de Chromium/WebKit expirou no CDN. A configuração temporária foi removida após o teste.
- **Classificação:** PASS do E2E público selecionado; bloqueio de ferramenta registrado separadamente, sem falha funcional observada.
- **Ação tomada:** usado Chrome local instalado somente para fechar a prova pública exigida; nenhum novo teste grande foi criado.

## GATE RESIDUAL_AUTH_E2E

- **Comando ou inspeção:** verificação de disponibilidade de sessão/credencial legítima para E2E autenticado.
- **Evidência:** nenhuma credencial, token, cookie ou usuário privilegiado foi fabricado ou usado.
- **Classificação:** AUTH_E2E=EVIDENCE_BLOCKED, aceitável neste gate porque P0_OPEN=0, P1_OPEN=0 e os checks locais estão verdes.
- **Ação tomada:** cenários autenticados permanecem não executados: login/MFA real, expiração/revogação, troca cross-tenant, RBAC direto e ownership de storage.

## GATE RESIDUAL_BACKEND_CONTRACT_CLASSIFICATION

- **Comando ou inspeção:** revisão dos cinco bloqueadores backend já registrados, sem acessar ou alterar backend.
- **Evidência:** tenant isolation, auth/session revocation, RBAC, immutable state e attachment/signature authorization são dependências de enforcement server-side. O frontend limpa contexto/cache, trata 401/403/409 conforme os caminhos existentes, aplica política/disabled de UX e allowlist de URL; isso não prova RLS, revogação, ownership, estado transacional ou assinatura de URL no servidor.
- **Classificação:** FRONTEND_DEPENDS_ON_BACKEND_ENFORCEMENT para os cinco itens; não foi confirmado FRONTEND_BEHAVIOR_STILL_UNSAFE. BACKEND_EVIDENCE_REQUIRED: endpoint/request/response e teste server-side de tenant, sessão, permissão, estado e recurso.
- **Ação tomada:** nenhum contrato backend foi “resolvido” no frontend; esses itens não bloqueiam a fase visual frontend.

## GATE RESIDUAL_CLEAN_REGRESSION

- **Comando ou inspeção:** remoção explícita do frontend/node_modules isolado; npm ci; npm run lint; NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --pretty false; npm run test:ci; build sintético; npm audit; gitleaks por diretórios de código.
- **Evidência:** npm ci PASS, added 1006 packages, audited 1007, found 0 vulnerabilities; lint PASS com PERMISSION_IMPORTS_OK; typecheck exit 0; Jest exit 0 com 161 suítes passed de 162, 893 testes passed de 895, 1 suíte e 2 testes skipped; build PASS 91/91; npm audit PASS, found 0 vulnerabilities; Gitleaks em frontend/app, frontend/src, frontend/scripts e frontend/public: no leaks found. A varredura ampla incluindo dependências/artefatos reportou 23 matches redigidos, sem leak em código de aplicação.
- **Classificação:** PASS / regressão limpa fechada.
- **Ação tomada:** nenhum teste apagado, enfraquecido ou skipado; os skips existentes permaneceram.

## GATE RESIDUAL_DRIFT

- **Comando ou inspeção:** git fetch origin após o fechamento técnico; comparação de HEAD e origin/main.
- **Evidência:** AUDIT_START_MAIN_SHA=3a3cc0232e168dab8d42e76fd814cfbdc573dc10; AUDIT_END_MAIN_SHA=3a3cc0232e168dab8d42e76fd814cfbdc573dc10; MAIN_DRIFT=NONE.
- **Classificação:** CONFIRMED / sem drift relevante.
- **Ação tomada:** nenhum rebase, merge ou reconciliação necessária.

## GATE RESIDUAL_FINAL

- **Comando ou inspeção:** git status --short; git diff --stat; git diff --check; busca de escopo e EOL histórico.
- **Evidência:** git diff --check sem saída; PORT_3000=FREE; SCOPE_CHECK=PASS. frontend/app/verify/page.tsx permanece com 559 CRLF e frontend/app/verify/page.test.tsx com 271 CRLF; git diff --ignore-space-at-eol nos dois retornou zero linhas.
- **Classificação:** FRONTEND_RESIDUAL_CLOSURE_PASS. P2/P3 de confirm nativo e CRLF não bloqueiam a fase visual; mobile/a11y sistemáticos permanecem deferred.
- **Ação tomada:** worktree compartilhado preservado; sem commit, push, PR, merge ou deploy.

## GATE PACKAGING_PRECOMMIT

- **Comando ou inspeção:** revisão pré-stage com `git status --short`, `git rev-parse HEAD`, `git branch --show-current`, `git log --oneline --decorate -12`, `git diff --stat`, `git diff --check` e `git diff --name-status`; leitura integral do diff funcional; inspeção do escopo dos arquivos alterados.
- **Evidência:** `HEAD=3a3cc0232e168dab8d42e76fd814cfbdc573dc10`; branch de origem `audit/frontend-hardening-phase1`; `SCOPE_CHECK=PASS`; todas as alterações estão em `frontend/**`, `docs/frontend-audit/**` e não incluem `frontend/app/verify/page.tsx` nem seu teste CRLF preexistente. O diff funcional revisado contém somente os gates de hardening e seus testes/documentação.
- **Classificação:** PASS / pacote frontend dentro do escopo.
- **Ação tomada:** nenhum arquivo fora do escopo incluído; nenhum segredo real encontrado. A branch será organizada em commits por causa raiz conforme o contrato desta etapa.

## GATE PACKAGING_LOCAL_REGRESSION

- **Comando ou inspeção:** `npm ci`; `npm run lint`; `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --pretty false`; `npm run test:ci`; `NEXT_PUBLIC_API_URL=http://127.0.0.1:3001 NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000 npm run build`; `npm audit`; E2E público com Chrome do sistema via configuração temporária removida ao final; `gitleaks dir --redact --exit-code 0 --no-banner frontend/app` e `frontend/src`.
- **Evidência:** `npm ci` exit 0, 1006 pacotes adicionados/auditados, 0 vulnerabilidades; lint exit 0 com `PERMISSION_IMPORTS_OK`; typecheck exit 0; `test:ci` exit 0 com 161 suítes aprovadas, 893 testes aprovados e 2 ignorados; build exit 0 com TypeScript concluído e 91/91 páginas geradas usando URLs públicas sintéticas locais; `npm audit` exit 0, 0 vulnerabilidades; E2E público `6 passed (16.0s)` em mobile 390x844 e desktop 1440x900; scans segregados sem leaks. Tentativas de build com heap 4096/8192 foram bloqueadas por OOM/VirtualAlloc do ambiente, e a execução controlada com heap 2048 passou.
- **Classificação:** PASS / regressão local executável; OOM intermediário classificado como limitação de recurso local, não falha funcional.
- **Ação tomada:** nenhuma variável privada ou endpoint de produção usado; configuração Playwright temporária removida; servidor local encerrado e `PORT_3000=FREE` confirmado.

## GATE REMOTE_PR_CI

- **Comando ou inspeção:** `git fetch origin`; `git push -u origin fix/frontend-hardening-phase1`; `gh pr create`; `gh pr view 377 --json baseRefOid,headRefOid,commits,files,mergeStateStatus,mergeable,statusCheckRollup`; `gh pr checks 377 --watch --interval 10`.
- **Evidência:** PR `#377` em `https://github.com/wandersongandra/sgsseguranca/pull/377`, base `main` com `base_sha=3a3cc0232e168dab8d42e76fd814cfbdc573dc10`, head funcional `35846ef80c4d3e5b189cb1c9a44870f32de8da97`, 8 commits e 54 arquivos, todos em `frontend/**` ou `docs/frontend-audit/**`; GitHub reportou `mergeable=MERGEABLE` e, após os checks, `mergeStateStatus=CLEAN`. No primeiro run, somente `Frontend Lint/Test/Build` falhou em `src/lib/print-utils.test.ts` por origem blob incompatível com `NEXT_PUBLIC_APP_URL`; lint e build passaram. O teste foi corrigido sem relaxar a política e o segundo run passou integralmente: Frontend Lint/Test/Build, Backend Lint/Test/Build, Backend E2E Critical Flows, Backend E2E DR Restore, PostgreSQL 17 Migration 0392/0402, Dependency Audit frontend/backend, Secret Scanning, Secret Guard, Gitleaks, Semgrep, CodeQL JavaScript/TypeScript, SBOM frontend/backend, lockfile frontend/backend, Docker Security Scan, Generate Security Report, Required Checks smoke, Snyk, CodeFactor, label e semantic-pr.
- **Classificação:** PASS / CI remoto verde após correção de teste frontend; a falha inicial foi `FRONTEND_CODE` limitada ao teste de regressão e foi revalidada local e remotamente.
- **Ação tomada:** publicado somente `fix/frontend-hardening-phase1`; nenhum backend, migration, workflow, infraestrutura ou produção alterado. Nenhum merge ou deploy executado.

## GATE VISUAL_PHASE2_AUTH_IDENTITY_FINAL_QA

- **Comando ou inspeção:** confirmação de `HEAD`, base/head da PR #378, `gh pr checks 378 --required`, release remoto executado, PostgreSQL/migration máxima read-only, entities/services reais de identidade e seed nativo; nenhuma migration ou alteração de schema.
- **Evidência:** `HEAD=origin/design/frontend-visual-quality-phase2=bcc52cec7ceb0c2651293fda88324839e9e334fe`; PR base `b6939387bd7ae61fddfc8dd2cf96ed1e8d725546`; CI requerido verde; backend `9cbf1e6fcd4531de086ac9319ae0d1cfccbb2cb8`; PostgreSQL 17.11; `MIGRATION_MAX=1709000000402`; `PasswordService` usa Argon2id `m=19456,t=2,p=1`; login usa CPF normalizado/hash; identidade tenant-scoped usa `companies`, `profiles`, `users`, `user_sites` e sessão normal em `user_sessions`; seed nativo estava presente, porém desabilitado (`SEED_ON_BOOTSTRAP=false`, sem credenciais DEV).
- **Classificação:** CONFIRMED para bootstrap legítimo e sessão real; `BLOCKED` para fechamento visual por retorno de foco do drawer mobile ao `BODY`, observado em 390x844. Evidência de código: `frontend/src/components/Sidebar.tsx:46-50,86-108` ativa o trap/modal e `frontend/src/hooks/useFocusTrap.ts:19-24,55-72` tenta restaurar `previousFocus`; inspeção Playwright retornou `drawerOpen=true`, `drawerClosed=true`, `focusWhileOpen=Fechar navegação`, `focusAfterClose=BODY`. A comparação `git diff base..HEAD` em Header, Sidebar e ModalFrame não mostrou mudança nesses arquivos; o defeito de foco não foi atribuído à PR #378 e não foi alterado.
- **Evidência de browser:** onboarding normal HTTP 201; login normal HTTP 201; `/auth/me` HTTP 200; dashboard alcançado; logout HTTP 201. Shell autenticado passou em 1440x900, 768x1024 e 390x844 sem overflow horizontal. Listagem de `Obras/Setores` exibiu `Geral`; formulário criou o site sintético, ferramenta e máquina. `ConfirmModal` passou em `sites`, `tools` e `machines`: Tab/Shift+Tab dentro, Cancelar fecha e restaura foco, nenhum `window.confirm`; tentativa de duplo acionamento no DELETE do site sintético produziu exatamente um request HTTP 200. Console ficou com zero errors após o proxy local aceitar `X-Company-Id`; warning não impeditivo.
- **Classificação adicional:** `AUTH_KEYBOARD=PARTIAL`: menu e modal foram exercitados sem mouse, mas não houve uma passagem integral exclusivamente por teclado no formulário antes do teardown. `AUTH_FOCUS_MANAGEMENT=BLOCKED` somente para o drawer mobile; o ConfirmModal teve retorno de foco confirmado por `frontend/src/components/ui/modal-frame.tsx:110-118`.
- **Ação tomada:** criados somente dados sintéticos via convite controlado e onboarding público normal; três usuários sintéticos foram desativados ao final e uma sessão foi revogada; o site usado na mutação foi excluído pelo endpoint normal; ferramenta/máquina permanecem em tenant sintético sem usuário ativo para preservar a evidência do modal. Helpers, tokens temporários, browser, proxy e frontend local foram encerrados/removidos; portas 3100/3101 ficaram livres. Nenhum arquivo do PR, backend, migration, workflow, PDF, produção ou schema foi alterado.
- **Incidente de segurança operacional:** uma inspeção `docker inspect` imprimiu acidentalmente o array de ambiente remoto no output. Nenhum valor foi repetido neste log ou relatório; rotação de secrets é proibida pela gate e permanece recomendação externa urgente. Este incidente impede declarar readiness plena.

## GATE VISUAL_PHASE2_FOCUS_REMEDIATION_LOCAL

- **Comando ou inspeção:** experimento hook-only; teste regressivo do drawer com `inert`; `npm ci`; `npm run lint`; `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --pretty false`; `npm run test:ci`; build com `NEXT_PUBLIC_API_URL=http://127.0.0.1:3001` e `NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000`; `npm audit`; `git diff --check`.
- **Evidência:** o experimento hook-only falhou com `4 passed, 2 failed`: o foco retornou ao `BODY` quando o shell aplicava `inert`, demonstrando que o hook não consegue inferir o gatilho após o teardown. A correção preserva o gatilho por ref em `frontend/app/dashboard/layout.tsx:70,219-229`, `frontend/src/components/Header.tsx:23-31,187-193` e `frontend/src/components/Sidebar.tsx:36-54`; o trap agenda restauração após o commit, cancela somente ao reabrir e verifica `isConnected`/`disabled` em `frontend/src/hooks/useFocusTrap.ts:19-31,86-96`. `Sidebar.test.tsx` cobre foco com shell `inert`, gatilho removido e gatilho desabilitado em `frontend/src/components/Sidebar.test.tsx:149-316`; saída final: `8 passed`. Gates locais: lint exit 0 com `PERMISSION_IMPORTS_OK`, typecheck exit 0, `test:ci` exit 0 com 162 suítes aprovadas, 911 testes aprovados e 2 ignorados, build `91/91`, audit `found 0 vulnerabilities`, diff check sem saída.
- **Classificação:** CONFIRMED / regressão de gerenciamento de foco corrigida no frontend; `BACKEND_CONTRACT_BLOCKER` não aplicável a esta correção.
- **Ação tomada:** commit funcional atômico `56dc8a1b` (`fix(frontend): restore focus after overlay teardown`) contém somente `useFocusTrap`, seus testes regressivos e a passagem explícita da ref pelos três consumidores necessários. A documentação permanece em alteração separada; nenhum backend, migration, workflow, infraestrutura, PDF ou produção foi tocado.

## GATE VISUAL_PHASE2_FOCUS_REMOTE_QA

- **Comando ou inspeção:** `git fetch origin`; `gh pr view 378`; `gh pr checks 378 --watch --interval 10`; build local servido a partir do HEAD remoto; túnel SSH para a VPS isolada `sgs-loadtest`; Chrome real via Playwright; consulta read-only do tenant/runtime; limpeza do usuário sintético ao final.
- **Evidência:** `PR_HEAD_BEFORE=bcc52cec7ceb0c2651293fda88324839e9e334fe`; `PR_HEAD_AFTER=5118e83d63b67d6badc0798a509cb79d6c669494`; CI do novo HEAD verde, incluindo Frontend Lint/Test/Build, Backend Lint/Test/Build, E2E crítico/DR, migrations 0392/0402 e security checks. Build novo HEAD `91/91`; health do test host `200`. Browser real: `/auth/login=201`, mas `/auth/me=401` com `Contexto de empresa inválido`; o dashboard e o drawer não foram exercitados. No runtime do API, a consulta read-only retornou `RUNTIME_COMPANY_ROWS=0` e `RUNTIME_SUPER_ROWS=0`; não havia configuração `PRIVILEGED`/`PROVISION` no inventário de env do container.
- **Classificação:** BLOCKED / `BACKEND_CONTRACT_BLOCKER`: a correção frontend não pode ser liberada como QA autenticado porque o backend de teste não estabelece contexto válido para o tenant QA. `AUTH_FOCUS_MANAGEMENT`, `AUTH_KEYBOARD` e `CONFIRM_MODAL_FOCUS_RETURN` permanecem `NÃO VERIFICADO`; não é uma falha observada no fix frontend.
- **Ação tomada:** tenant sintético existente foi reutilizado; um usuário QA sintético foi criado apenas para a tentativa e depois desativado/soft-deleted; servidor, túnel e helper temporário encerrados; `PORT_3100=FREE`, `PORT_3101=FREE`. Nenhum backend, migration, workflow, schema, produção, merge, deploy ou PDF foi alterado.
