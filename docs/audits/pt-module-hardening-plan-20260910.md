# SGS — plano de hardening do módulo PT

**Data:** 2026-09-10
**Repositório:** `wandersongandra/sgsseguranca`
**Worktree:** `C:\Users\User\Documents\trae_projects\sgs-pt-hardening-20260910`
**Branch:** `audit/pt-module-hardening-20260910`
**Base:** `origin/main` em `5a5ae66ae8eb6410ade8a4b0e68dbd3105fc6219`
**Escopo:** somente o módulo PT, seus contratos diretos, testes e documentação desta auditoria.

## Objetivo

Auditar e executar o hardening do fluxo completo de Permissão de Trabalho:

1. banco de dados, migrations, constraints, índices, soft delete, RLS e junction `pt_executantes`;
2. backend, DTOs, guards, tenant/site scope, RBAC, state machine, concorrência, uploads, storage, PDF, exportações, auditoria e contratos;
3. frontend, rotas, carregamento assíncrono, mutations, permissões de UX, formulários, PDF, mobile, desktop, teclado, foco, labels, contraste e reduced motion;
4. validação automatizada focada e, quando o ambiente permitir, navegador real em 390px, 768px e 1440px.

## Ordem de execução

### Gate 0 — baseline e fronteira

Registrar instalação e checks sem alterar código funcional. O checkout principal e o trabalho concorrente de APR ficam fora da worktree. As diferenças CRLF pré-existentes em `frontend/app/verify/page.tsx` e `page.test.tsx` não pertencem ao PT e não serão tocadas.

### Gate 1 — isolamento e contratos críticos

Verificar todas as rotas `/pts`, company/site scope, relações `site`, `apr`, usuários, `pt_executantes`, RLS/FORCE RLS, soft delete, exportação, storage e resposta DTO. Qualquer garantia que dependa de servidor, banco live, storage ou deployment será classificada como `BACKEND_CONTRACT_BLOCKER` ou `NÃO VERIFICADO`, conforme a evidência disponível.

### Gate 2 — integridade do workflow

Verificar criação, edição, aprovação, reprovação, encerramento, expiração, remoção, anexos, PDF final e concorrência. Cada correção P0/P1 terá regressão que falha antes e passa depois; se isso não for viável, registrar `TEST_BLOCKER` com tentativa e motivo.

### Gate 3 — frontend e UX acessível

Verificar `dashboard/pts`, rotas `new`/`edit`, `usePts`, `PtForm`, listagem, modais, anexos, PDF, responsividade e acessibilidade. Corrigir apenas causas estruturais dentro do PT, sem trocar router, state manager, biblioteca visual ou redesenhar o sistema.

### Gate 4 — validação final

Executar lint, typecheck, testes focados e suíte aplicável no backend/frontend, `git diff --check`, auditoria de dependências quando disponível e navegador real sem mutações em produção. O resultado será `READY`, `PARTIAL` ou `BLOCKED` conforme a evidência, nunca por inferência.

## Achados preliminares confirmados

- `backend/src/modules/pts/pts.service.ts:2280-2300`: `getAnalyticsOverview()` não inclui `deleted_at IS NULL`, divergindo das demais leituras do PT e inflando métricas com registros soft-deleted.
- `frontend/app/dashboard/pts/hooks/usePts.ts:491-525,542-558,702-827`: ações assíncronas de pré-liberação, emissão de PDF, aprovação, reprovação e encerramento dependem somente de estado React; falta barreira síncrona contra duplo clique no mesmo ciclo de evento.
- `frontend/app/dashboard/pts/components/ChecklistSection.tsx:180-203`: perguntas de rádio são exibidas como texto seguido de inputs, sem `fieldset`/`legend` ou nome programático para o grupo; o rótulo textual da pergunta não está associado aos controles.

Os achados serão reproduzidos em testes antes da correção, quando tecnicamente possível, e reclassificados após a validação.

## Fora de alcance

- produção, VPS, deploy, migrations executadas em ambiente compartilhado, dados reais, criação de credenciais e chamadas mutáveis remotas;
- APR e qualquer arquivo que pertença ao trabalho concorrente do Claude Code;
- CI/workflows, salvo leitura necessária para descobrir comandos de validação;
- alteração/normalização dos arquivos `frontend/app/verify/page.tsx` e `frontend/app/verify/page.test.tsx`.

## Critérios de saída

- nenhum P0/P1 confirmado sem correção, regressão ou `TEST_BLOCKER` explícito;
- tenant/site scope e autoridade do backend separados da UX do frontend;
- somente arquivos do PT, testes do PT e estes documentos aparecem no diff funcional;
- todas as pendências e bloqueios têm comando, arquivo/linha e saída registrada no log.

## Resultado da execução — 2026-09-10

- Correções aplicadas: exclusão de soft-deleted nas métricas, locks transacionais do workflow PT com hidratação de `pt_executantes` dentro da transação, limpeza de storage pós-commit, substituição atômica de assinaturas PT com soft-delete forense, limpeza pós-commit e compensação de upload parcial, endpoint PT específico para assinatura avulsa com validação de executante, bloqueio fail-closed dos endpoints genéricos de mutação de assinatura para PT, barreiras de double-submit incluindo emissão e upload do PDF final, preservação da obra selecionada em escopo multi-site, rejeição de executantes duplicados tanto na criação quanto no replacement de assinaturas, validação do vigia no escopo da obra, validação de APR no escopo da obra, serialização das regras de aprovação por empresa e leitura dessas regras pelo manager transacional sob lock, chaves de foto/anexo derivadas da obra protegida pelo lock, snapshots de auditoria derivados da PT protegida pelo lock, paginação completa da allow-list de arquivos e da exportação legada sem teto silencioso, proteção contra paginação stale, loaders stale do formulário, guards de geração para contexto APR e revalidação da PT, limites de tamanho nos DTOs/schema e controles textuais principais, validação estrita de ano/semana nos filtros de arquivos, espera da atualização de expiração antes das métricas, semântica de grupos de rádio, labels de tabela, modais acessíveis, allowlist de URLs de artefatos, revogação/geração segura de thumbnails e revogação da blob URL de impressão local. No adendo de 2026-09-11, foi corrigido o fallback fail-open de `current_site_scope()` por migration corretiva, a validação de relações do `update()` passou a usar o manager da transação protegida, referências legadas de evidência receberam limite de 100 KB, o autosave do formulário passou a ser isolado por empresa e usuário autenticado e o gerador Sophie passou a persistir o rascunho PT no mesmo contrato escopado do formulário.
- Validação automatizada: backend lint/typecheck/test/build/audit verdes (`328` suítes, `2878` testes na suíte completa final); frontend lint/typecheck/test/build/audit verdes (`168` suítes de `169`, `916` testes de `918`, com skips registrados). Os números e comandos reproduzíveis estão em `docs/audits/pt-module-hardening-log-20260910.md`, Gates 2.4, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 2.15, 2.16, 2.17, 2.18, 2.19, 2.20, 2.21, 2.22, 2.23, 2.24, 2.25, 2.26, 2.27, 2.28, 2.29, 2.30, 2.31, 2.32, 2.33, 2.34, 2.35, 3.4, 3.5, 3.6, Final-Recheck-4, Final-Recheck-5, Final-Recheck-7, Final-Recheck-8, Final-Recheck-9, Final-Recheck-10, Final-Recheck-12, Final-Recheck-13, Final-Recheck-14, Final-Recheck-15, Final-Recheck-16, Final-Recheck-17, Final-Recheck-18, Final-Recheck-19, Final-Recheck-20, Final-Recheck-21 e Final-Recheck-22.
- RLS multi-site: a migration já existente `1709000000367-enable-multi-site-rls-scope` corrige a limitação singular da migration 0127 para todas as tabelas site-scoped, incluindo `pts`; a migration nova `1709000000405-harden-site-scope-fail-closed` corrige o fallback de contexto ausente/inválido para escopo fechado. Ambas foram auditadas estaticamente; a execução e o comportamento no banco de QA ainda dependem de migration/RLS live autorizados. O identificador `0405` evita a colisão com as migrations APR `0403`/`0404` já presentes no `origin/main` atual.
- Bloqueios honestos: RLS/contratos backend/storage live não exercitados e QA autenticado com credenciais reais não executado; os browsers gerenciados do Playwright não estão instalados, mas o E2E público foi concluído com o Chrome do sistema (`24 passed` em todos os viewports). O formulário PT teve inspeção visual sintética local em 1440px e 390px, sem overflow horizontal e sem erro de APR após a correção; isso não prova sessão real, banco/RLS, storage, mutação remota, foco completo de todos os modais ou reduced-motion. O blocker P0 de substituição de assinaturas foi fechado pelo endpoint PT transacional; a reprodução red do código histórico foi registrada como `TEST_BLOCKER`, mas o fluxo atual possui regressões verdes.
- Revalidação final em 2026-09-11, após os Gates 2.11 a 3.6 e 2.18–2.35: `STATUS_PATHS=56`, `APR_FILES=0`, `MIGRATION_FILES=1` (`1709000000405-harden-site-scope-fail-closed.ts`), `WORKFLOW_FILES=0`, `VERIFY_NON_EOL_DIFF=0` e `PT_RUNTIME_DANGEROUS_SINKS=NONE`, registrada nos gates `FINAL-CLOSURE-20260911`, `FINAL-RECHECK-7`, `FINAL-RECHECK-8`, `FINAL-RECHECK-9`, `FINAL-RECHECK-10`, `FINAL-RECHECK-11`, `FINAL-RECHECK-12`, `FINAL-RECHECK-13`, `FINAL-RECHECK-14`, `FINAL-RECHECK-15`, `FINAL-RECHECK-16`, `FINAL-RECHECK-17`, `FINAL-RECHECK-18`, `FINAL-RECHECK-19`, `FINAL-RECHECK-20`, `FINAL-RECHECK-21` e `FINAL-RECHECK-22`. O worktree permaneceu em `HEAD=5a5ae66ae8eb6410ade8a4b0e68dbd3105fc6219`; após `git fetch origin`, `origin/main=cc4184625eac3f373481a4e2db6e499682d85314` avançou por commits do trabalho APR e não foi incorporado.
- Contagem de findings no escopo PT após o adendo: `P0_FOUND=4`, `P0_FIXED=4`, `P0_OPEN=0`; `P1_FOUND=24`, `P1_FIXED=24`, `P1_OPEN=0`; `P2_FOUND=9`, `P2_FIXED=9`, `P2_OPEN=0`. Resíduos de handlers destrutivos em outros módulos e a normalização EOL de `verify` permanecem fora do escopo PT desta worktree.
- Status operacional: `STATUS=PARTIAL`; não é autorização para merge, push, PR, deploy ou alteração de produção. O fechamento estático de sinks/fronteira e a validação sintética de layout foram registrados nos gates `FINAL-SCOPE-RECHECK-2`, `FINAL-CLOSURE-20260911`, `FINAL-RECHECK-6`, `3.4`, `3.5`, `3.6` e `FINAL-RECHECK-8`; permanecem bloqueados apenas os gates que exigem autenticação real, banco/RLS/storage live e validação completa de foco/reduced-motion.
- Integridade da worktree: `frontend/CLAUDE.md` também apareceu modificado pelo `next dev`; foi preservado e excluído do diff desta auditoria, assim como os dois arquivos `verify` EOL-only.

## Adendo de validação pública — 2026-09-11

- A suíte existente `frontend/e2e/public-mobile.spec.ts` foi executada serialmente com o Chrome instalado no sistema em oito viewports e terminou `24 passed (46.0s)`. Foram cobertos login, recuperação de senha, overflow/tamanho de controles e redirecionamento de `/dashboard` sem sessão.
- O runner oficial permanece `BLOCKED` porque os browsers gerenciados do Playwright não estão instalados e a tentativa de download terminou em timeout no CDN. A configuração temporária usada para apontar para o Chrome do sistema foi removida após o teste.
- O resultado detalhado está em `docs/audits/pt-module-hardening-log-20260910.md`, Gates `3.7` e `FINAL-RECHECK-23`; o status global permanece `STATUS=PARTIAL` por autenticação E2E do PT, banco/RLS/storage live, contratos server-side remotos, runner oficial e foco/reduced-motion completos.

## Adendo de isolamento de tenant — 2026-09-11

- Foi fechado um finding P0 adicional: a lista principal de PT e o painel de arquivos mantinham dados em memória depois da troca de empresa/obra. `usePts` e `StoredFilesPanel` agora assinam `selectedTenantStore`/`siteStore`, invalidam gerações e limpam dados sensíveis antes do refetch. Regressões red/green e limitações server-side estão no Gate `2.36`.
- Revalidação após a correção: frontend `169/170` suítes e `918/920` testes (1 suíte e 2 testes ignorados), lint/typecheck/build/audit verdes; build passou com `NODE_OPTIONS=--max-old-space-size=4096` após uma tentativa local com OOM nos workers. Fronteira atual: `APR_FILES=0`, `WORKFLOW_FILES=0`, `MIGRATION_FILES=1` (`1709000000405-harden-site-scope-fail-closed.ts`), `VERIFY_NON_EOL_DIFF=0`, `PT_RUNTIME_DANGEROUS_SINKS=NONE`, `NO_LISTENER_3100`.
- Contagem atualizada: `P0_FOUND=5`, `P0_FIXED=5`, `P0_OPEN=0`; `P1_FOUND=24`, `P1_FIXED=24`, `P1_OPEN=0`; `P2_FOUND=9`, `P2_FIXED=9`, `P2_OPEN=0`. O status global continua `STATUS=PARTIAL` por evidência autenticada/live e contratos remotos não disponíveis. Detalhamento no `FINAL-RECHECK-24`.

## Adendo de fechamento de storage e validação final — 2026-09-11

- Foi fechado um bypass P1 no download de arquivo: `StoredFilesPanel.fetchPdfBlob` agora aplica `resolveSafeBrowserUrl` antes de usar o client autenticado. A regressão negativa e o resultado `3/3` estão no Gate `2.37` do log.
- Foi corrigida uma inconsistência P2 de UX/contrato: o PT não enumera empresas nem exibe um filtro cujo valor é ignorado pelo controller, que deriva o escopo do tenant confiável. O componente compartilhado continua compatível com filtros autoritativos; a regressão e o resultado `2 suítes / 4 testes` estão no Gate `2.38`.
- Revalidação final local: frontend `169/170` suítes e `920/922` testes, com `1` suíte e `2` testes ignorados; lint, typecheck, build com `91/91` páginas e audit verdes. O build exigiu `NODE_OPTIONS=--max-old-space-size=8192` após OOM local no typecheck com heap menor. A suíte E2E pública permanece com `24 passed` usando Chrome do sistema; o runner oficial, autenticação PT real, banco/RLS/storage live, contratos remotos e foco/reduced-motion completo continuam bloqueados ou não verificados.
- Fronteira final: `APR_FILES=0`, `WORKFLOW_FILES=0`, `VERIFY_NON_EOL_DIFF_EXIT=0`, `DIFF_CHECK_EXIT=0` com apenas dois avisos CRLF históricos de `verify`, `LISTENER_3100=NO` e configuração temporária do Playwright ausente. `origin/main` avançou para `cc4184625eac3f373481a4e2dbd3106e499682d85314` por trabalho APR e não foi incorporado à branch isolada.
- Contagem de findings permanece: `P0_FOUND=5`, `P0_FIXED=5`, `P0_OPEN=0`; `P1_FOUND=25`, `P1_FIXED=25`, `P1_OPEN=0`; `P2_FOUND=9`, `P2_FIXED=9`, `P2_OPEN=0`. A correção de coerência do filtro de storage foi registrada como hardening complementar, sem inflar a contagem histórica de findings.
- Status operacional: `STATUS=PARTIAL`; não há autorização implícita para commit, push, PR, merge, deploy, migration compartilhada ou produção. Detalhamento no `FINAL-RECHECK-25` do log.

## Adendo de revalidação backend — 2026-09-11

- A revalidação backend terminou verde: `328/328` suítes, `2878/2878` testes, lint, typecheck, build Nest, audit com `0 vulnerabilities` e `ci:migration:check` com `323 files; 20 names derived from class`.
- Nenhuma migration foi executada e nenhum endpoint mutável foi chamado. Permanecem como `BACKEND_CONTRACT_BLOCKER` a execução em QA autenticado, RLS live, storage/URLs assinadas, autorização server-side efetiva e confirmação de que o deploy remoto corresponde ao commit auditado.
- O resultado consolidado continua `STATUS=PARTIAL`: código local e regressões estão verdes no escopo auditado, mas isso não autoriza publicação nem permite afirmar prontidão operacional sem as provas externas listadas.

## Adendo de drift e encerramento operacional — 2026-09-11

- `AUDIT_START_MAIN_SHA=5a5ae66ae8eb6410ade8a4b0e68dbd3105fc6219`; `AUDIT_END_MAIN_SHA=cc4184625eac3f373481a4e2dbd3106e499682d85314`. A `origin/main` avançou por sete commits do trabalho APR/infra associada e não foi incorporada à branch PT. A fronteira final continua `APR_FILES=0` e `WORKFLOW_FILES=0`.
- O código local PT foi revalidado com backend e frontend verdes nos checks disponíveis, regressões P0/P1 e E2E público com Chrome do sistema. Isso não prova ambiente remoto, RLS/storage live, autorização efetiva ou E2E autenticado.
- Encerramento da execução local: `STATUS=PARTIAL`. A próxima reconciliação com `origin/main` deve ser uma etapa separada, revisada e repetida nos checks relevantes; não fazer rebase cego nem misturar o trabalho APR.

## Adendo de QA visual sintético do PT — 2026-09-11

- O navegador local encontrou e corrigiu um finding P2 real: filtros PT/storage mediam `42px` e usavam fonte de `14px` em mobile. A correção aplica `min-h-11`, `text-base` e `sm:text-sm`; o teste red/green e o resultado `6 passed (23.8s)` estão no Gate `3.8`.
- O smoke autenticado sintético cobriu `390x844`, `768x1024` e `1440x900`, sem overflow, com controles táteis, foco de abertura e restauração de foco dos modais. As APIs foram interceptadas com dados fictícios; não é prova de backend, RLS, storage ou credenciais reais.
- Contagem atualizada: `P0_FOUND=5`, `P0_FIXED=5`, `P0_OPEN=0`; `P1_FOUND=25`, `P1_FIXED=25`, `P1_OPEN=0`; `P2_FOUND=10`, `P2_FIXED=10`, `P2_OPEN=0`. `P3_BACKLOG=0` para o escopo priorizado desta execução.
- Revalidação frontend após a correção: `169/170` suítes, `920/922` testes, lint/typecheck/build/audit verdes e build `91/91`. O status permanece `STATUS=PARTIAL` por autenticação real, banco/RLS/storage live, contratos remotos, browser oficial e reduced-motion completo.

## Adendo de reduced-motion e encerramento local — 2026-09-11

- O teste browser do PT para `prefers-reduced-motion: reduce` passou em `390x844`, `768x1024` e `1440x900`; o smoke autenticado sintético completo terminou `9 passed (29.9s)`. Foram verificadas ausência de overflow, controles táteis, fonte móvel, foco/restauração de foco e `scroll-behavior`/transições reduzidos.
- A regra global de reduced-motion já existente permaneceu intacta; a nova cobertura está em `frontend/e2e/pt-authenticated-visual.spec.ts:177-195`. O cenário usa sessão e API sintéticas interceptadas e não substitui E2E real ou contrato backend.
- Contagem final: `P0_FOUND=5`, `P0_FIXED=5`, `P0_OPEN=0`; `P1_FOUND=25`, `P1_FIXED=25`, `P1_OPEN=0`; `P2_FOUND=10`, `P2_FIXED=10`, `P2_OPEN=0`; `P3_BACKLOG=0` no escopo priorizado.
- Fechamento local: `STATUS=PARTIAL`. Permanecem bloqueados somente os gates que exigem credenciais/QA autenticado legítimo, banco/RLS/storage live, confirmação do deploy remoto e runner Playwright oficial; não houve produção, commit ou publicação.

## Adendo de formulário PT e fechamento final local — 2026-09-11

- O formulário PT foi exercitado em sessão sintética nos viewports `390x844`, `768x1024` e `1440x900`. O teste encontrou `#pt-numero` com `42px` e `14px` antes da correção; após a regra scoped de `min-height: 44px` e fonte móvel de `16px`, o arquivo E2E terminou `12 passed (27.1s)`. A evidência red/green está no Gate `3.10` do log.
- A correção usa `ds-pt-form-page` em `frontend/app/dashboard/pts/components/PtForm.tsx:1973` e regras específicas em `frontend/app/globals.css:704-715`; controles checkbox/radio não foram artificialmente ampliados. Não houve redesign, troca de router/state manager, endpoint remoto ou uso de credencial real.
- Revalidação local final: frontend lint, typecheck, Jest (`169/170` suítes; `920/922` testes, com skips registrados), build Next `16.3.4` (`91/91` páginas), audit (`0 vulnerabilities`) e E2E sintético (`12/12`) verdes. O E2E público continua `24 passed` com Chrome do sistema; o runner oficial permanece bloqueado por browsers gerenciados ausentes.
- Contagem final do escopo priorizado: `P0_FOUND=5`, `P0_FIXED=5`, `P0_OPEN=0`; `P1_FOUND=25`, `P1_FIXED=25`, `P1_OPEN=0`; `P2_FOUND=12`, `P2_FIXED=12`, `P2_OPEN=0`; `P3_BACKLOG=0`. O finding P2 do foco vindo da URL é adicional ao finding anterior de filtros PT/storage e está fechado.
- Fronteira: `APR_FILES=0`, `WORKFLOW_FILES=0`, `VERIFY_NON_EOL_DIFF_EXIT=0`, listener local `3100=NO`; `git diff --check` registra apenas avisos de normalização de EOL em `frontend/app/globals.css` e nos dois arquivos históricos `verify`. `origin/main=cc4184625eac3f373481a4e2dbd3106e499682d85314` avançou por trabalho APR e não foi incorporada. `STATUS=PARTIAL` continua correto por autenticação real, QA/RLS/storage live, contratos remotos, deploy não confirmado e browser oficial.

## Adendo de allowlist de foco na URL — 2026-09-11

- O teste negativo reproduziu `SyntaxError` quando `focus=\"]` era interpolado no `querySelector` do `PtForm`; a allowlist de quatro destinos válidos foi aplicada e o focused passou `17/17`.
- Contagem consolidada: `P0_FOUND=5`, `P0_FIXED=5`, `P0_OPEN=0`; `P1_FOUND=25`, `P1_FIXED=25`, `P1_OPEN=0`; `P2_FOUND=12`, `P2_FIXED=12`, `P2_OPEN=0`; `P3_BACKLOG=0`.
- O E2E sintético PT passou `12/12` após a execução receber `NEXT_PUBLIC_API_URL` explicitamente; a tentativa sem a variável foi classificada como falha de fixture/configuração, não como regressão funcional. O QA remoto segue indisponível e `STATUS=PARTIAL` permanece.

## Adendo de revalidação final do foco — 2026-09-11

- O conjunto local pós-correção passou: focused `PtForm` `17/17`; frontend `test:ci` `169/170` suítes e `921/923` testes; lint, typecheck, build Next `16.3.4` (`91/91` páginas) e `npm audit --audit-level=high` (`0 vulnerabilities`) verdes.
- O E2E PT sintético passou `12/12` em `390x844`, `768x1024` e `1440x900` após configurar explicitamente a URL pública da API no runner local; não houve credencial real nem requisição mutável.
- `P2_FOUND=12`, `P2_FIXED=12`, `P2_OPEN=0`. QA remoto permanece bloqueado por timeout em HTTPS/443; `STATUS=PARTIAL` continua correto.
