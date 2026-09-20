# Auditoria de hardening do módulo DDS

Repositório: `wandersongandra/sgsseguranca`
Worktree: `C:\Users\User\Documents\trae_projects\sgs-dds-hardening-20260911`
Branch: `audit/dds-module-hardening-20260911`
START_MAIN_SHA: `21a675466cee63844ea2f01741898b71c3dd42bb`

## GATE SETUP/BASELINE

- **Comando ou inspeção:** `git fetch origin`; `git rev-parse origin/main`; `git worktree add -b audit/dds-module-hardening-20260911 ... origin/main`; `git status --short --branch`; `npm ci --no-audit --no-fund`; lint, typecheck, testes, build e audit em backend/frontend.
- **Evidência:** `docs/audits/dds-module-hardening-baseline-20260911.md`; `origin/main=21a675466cee63844ea2f01741898b71c3dd42bb`; status inicial preservou somente os dois arquivos `frontend/app/verify/*` com EOL histórico.
- **Classificação:** CONFIRMED / baseline isolado; frontend build BLOCKED por `NEXT_PUBLIC_API_URL` ausente.
- **Ação tomada:** nenhuma correção de código; somente criação da worktree e registro do baseline.

## GATE A1 TENANT_ISOLATION

- **Comando ou inspeção:** leitura repo-local do controller, `DdsService`, `DocumentRegistryService`, `DdsSignatureInviteService` e `ddsService` frontend; `rg -n "company_id|site_id|TenantGuard|TenantInterceptor|listFinalDocuments|buildTenantScopedIdsWhere" backend/src/modules/dds backend/src/modules/document-registry frontend/src/services/ddsService.ts`.
- **Evidência:** `backend/src/modules/dds/dds.controller.ts:168-170` aplica `JwtAuthGuard`, `TenantGuard`, `RolesGuard` e `TenantInterceptor`; `backend/src/modules/dds/dds.service.ts:174-218,275-297,476-609,1660-1713` deriva escopo, força `company_id`, filtra `site_id`, exporta/lista storage e reconcilia DDS novamente no tenant; `backend/src/modules/document-registry/document-registry.service.ts:637-640,778-789` resolve a empresa do contexto. `backend/src/modules/dds/dds.service.spec.ts` e a suíte DDS final passaram: `11 passed`, `124 passed`.
- **Classificação:** PASS estático/unitário. `BACKEND_CONTRACT_BLOCKER` para RLS/banco live, storage, WebSocket, jobs e endpoints não exercitados neste checkout.
- **Contrato backend esperado/observado/risco:** esperado: tenant e site devem ser derivados do contexto confiável e aplicados a leitura, escrita, exportação, download e jobs, independentemente de IDs enviados pelo cliente. Observado: o código local possui escopo e filtros; RLS/live não foi exercitado. Risco: um contrato server-side/RLS incompleto ainda poderia permitir cross-tenant fora da prova unitária.
- **Ação tomada:** nenhuma remoção de isolamento; mantidos filtros fail-closed e bloqueador explícito para validação externa.

## GATE A2 AUTH_PUBLIC_SIGNATURES

- **Comando ou inspeção:** leitura das rotas protegidas e públicas, token assinado, convite, Turnstile, lock transacional e verificação de versão; teste `npm run test -- src/modules/dds` no backend e teste do token público no frontend.
- **Evidência:** `backend/src/modules/dds/dds.controller.ts:168-170,237-868` protege as rotas autenticadas por guard/roles/permissões; `backend/src/modules/dds/public-dds-signature.controller.ts:22-74` limita o portal público a token assinado e throttle; `backend/src/modules/dds/dds-signature-invite.service.ts:372-473,687-745` valida token, tenant, convite, expiração, estado, versão e usa `pessimistic_write` na submissão. Resultado: 11 suítes DDS e 124 testes passaram.
- **Classificação:** PASS estático/unitário; `BACKEND_CONTRACT_BLOCKER` para revogação/rotação de sessão e execução contra ambiente live.
- **Contrato backend esperado/observado/risco:** esperado: token inválido, expirado, revogado, de outro portal, tenant ou versão deve falhar fechado; submissão repetida deve ser idempotente. Observado: contrato local cobre esses estados e retorno existente é reaproveitado; não houve chamada real ao servidor.
- **Ação tomada:** corrigida a preferência pelo token da URL no frontend (`frontend/app/assinar/dds/[token]/page.tsx:85-102,162-180`) e mantida a barreira transacional pública.

## GATE A3 SSR_CACHE

- **Comando ou inspeção:** `rg -n -e 'cache: "no-store"' -e 'unstable_cache' -e 'force-cache' -e 'revalidate' frontend/app/validar frontend/app/assinar/dds frontend/app/dashboard/dds frontend/src/services/ddsService.ts frontend/src/services/publicDdsSignatureService.ts`.
- **Evidência:** a busca não encontrou `unstable_cache`, `force-cache` ou `revalidate` nos fluxos DDS; `frontend/app/validar/[code]/page.tsx:169-194` usa `fetch(..., { cache: "no-store" })` e guarda contra resposta tardia. `npm run build` frontend continuou bloqueado antes da compilação por `NEXT_PUBLIC_API_URL` ausente.
- **Classificação:** PASS estático; runtime/SSR não verificado por `TEST_BLOCKER` de configuração.
- **Ação tomada:** nenhum cache autenticado ou fallback de ambiente foi introduzido.

## GATE A4 SECRETS

- **Comando ou inspeção:** `rg -n -e 'CRON_SECRET' -e 'NEXT_PUBLIC' -e 'process\\.env' backend/src/modules/dds frontend/app/assinar/dds frontend/app/dashboard/dds frontend/src/services/ddsService.ts` e inspeção de fontes do DDS.
- **Evidência:** `backend/src/modules/dds/dds.controller.ts:96-164` usa somente limites de throttle; `backend/src/modules/dds/dds-signature-invite.service.ts:978-989` lê somente configuração de origem pública no backend; `frontend/app/assinar/dds/[token]/page.tsx:117` expõe apenas `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. Nenhum segredo real foi encontrado no código DDS. O bundle não foi inspecionado porque o build frontend foi bloqueado.
- **Classificação:** PASS estático; bundle `NÃO VERIFICADO` por bloqueio de build.
- **Ação tomada:** nenhum segredo adicionado, impresso ou colocado em frontend/testes.

## GATE A5 ROUTE_MATCHING

- **Comando ou inspeção:** inventário de `@Get/@Post/@Patch/@Put/@Delete` dos controllers DDS e leitura de ordem das rotas estáticas versus `:id`/`:token`.
- **Evidência:** `backend/src/modules/dds/dds.controller.ts:280-447` declara primeiro `export/all`, `historical-photo-hashes`, `files/*`, `batch`, `people` e `observability/*`, somente depois `:id`; `backend/src/modules/dds/public-dds-signature.controller.ts:30-46` mantém `:token` isolado sob prefixo público. O inventário não mostrou colisão de rota. O frontend usa `frontend/src/services/ddsService.ts:396-405,534-621` com IDs codificados pelo cliente HTTP existente e `frontend/app/assinar/dds/[token]/page.tsx:85-102` com decode fail-closed.
- **Classificação:** PASS estático/unitário.
- **Ação tomada:** nenhum router trocado; token malformado agora resulta em string vazia e erro fechado.

## GATE A6 OPEN_REDIRECT

- **Comando ou inspeção:** busca de `window.open`, `location`, `URL.createObjectURL` e leitura de `safe-external-url`/`print-utils`.
- **Evidência:** `frontend/src/lib/security/safe-external-url.ts:54-112` aceita somente origem do app/API/storage permitido, HTTPS (HTTP apenas localhost), e rejeita protocolos perigosos; `frontend/src/lib/print-utils.ts:5-57` aplica a política antes de abrir PDF/artefato. `frontend/app/dashboard/dds/page.tsx:661-783,807` usa somente os wrappers para PDFs remotos; `frontend/src/components/DdsForm.tsx:273-298` abre apenas blob criado localmente para prévia PDF. Testes `safe-external-url`, `print-utils` e DDS passaram.
- **Classificação:** PASS nos sinks auditados; `BACKEND_CONTRACT_BLOCKER` para autorização, tenant e expiração de URL assinada de anexos/PDF.
- **Contrato backend esperado/observado/risco:** esperado: storage deve emitir URL somente após autorização do usuário/tenant/recurso, com expiração e MIME coerentes. Observado: o frontend faz allowlist local; o servidor/storage não foi testado live. Risco: uma URL HTTPS autorizada localmente ainda pode representar recurso indevido se o backend assinar incorretamente.
- **Ação tomada:** nenhuma abertura arbitrária adicionada; blob URLs são revogadas após 60 segundos ou imediatamente no download local.

## GATE B1 RBAC_UX

- **Comando ou inspeção:** leitura do controller, `documentActionPolicy`, `DdsPage`, `DdsForm` e `DdsApprovalPanel`.
- **Evidência:** `backend/src/modules/dds/dds.controller.ts:238-268,281-868` diferencia `can_view_dds`/`can_manage_dds` e roles; `frontend/app/dashboard/components/documentActionPolicy.ts:15-40` e `frontend/app/dashboard/dds/page.tsx:2092-2110` filtram ações e estados da UI; `frontend/src/components/dds/DdsApprovalPanel.tsx:482-513` desabilita ações durante estado locked/acting.
- **Classificação:** PASS de UX/RBAC aparente; `BACKEND_CONTRACT_BLOCKER` para autorização real em cada endpoint.
- **Contrato backend esperado/observado/risco:** esperado: cada mutação valida usuário, tenant/site, recurso, role/permissão e estado no servidor, retornando 401/403/409 conforme contrato. Observado: guards/permissões existem no controller local; backend live/RLS não foi exercitado. Risco: `disabled`, menu oculto e route guard jamais podem ser a única barreira.
- **Ação tomada:** nenhuma elevação de confiança baseada na UI; bloqueador server-side mantido explícito.

## GATE B2 STALE_ASYNC_DDS

- **Comando ou inspeção:** reprodução com promises deferred em `DdsForm`, leitura de loaders de histórico/vídeo/aprovação e suíte frontend.
- **Evidência:** `frontend/src/components/DdsForm.tsx:526-690,701-836` cancela o ciclo anterior e protege `state`, `catch` e `finally`; `frontend/src/hooks/useDocumentVideos.ts` mantém guardas de montagem/operação; `frontend/src/components/DdsForm.test.tsx:339-389` reproduz DDS antigo resolvendo após o atual. Antes da correção o teste não encontrava `DDS atual`; depois: `1 passed`. A suíte frontend final passou 927/929 com 2 skips.
- **Classificação:** CONFIRMED corrigido para `DdsForm` e loaders DDS auditados; sem stale overwrite observado nos fluxos cobertos.
- **Ação tomada:** flags de ciclo de vida, sem troca de camada de dados ou state manager.

## GATE B3 MUTATION_SAFETY

- **Comando ou inspeção:** testes red/green de assinaturas parciais, aprovação, reset de formulário, lock de linha e guardas de ações do painel.
- **Evidência:** `backend/src/modules/dds/dds.service.ts:1073-1090` agora rejeita payload sem todas as assinaturas de participantes antes de `replaceDocumentSignatures`; o teste falhava antes com promise resolvida e depois passou. `backend/src/modules/dds/dds.service.ts:702-758,1321-1400,1471-1538` usa `lockDdsForMutation` com `pessimistic_write` para status, edição e auditoria; o teste novo falhou antes com `Number of calls: 0` para `setLock` e depois `dds.service.spec.ts` passou 45/45. `frontend/src/hooks/useApprovalWorkflow.ts:18-36` e `frontend/src/hooks/useSingleFlightGuard.ts:3-18` usam ref síncrona; `frontend/app/dashboard/dds/page.tsx:256-260,491-510,731-751,815-836,934-1009` protegem delete, operacionalização, status, links e dispatch. `frontend/src/components/DdsForm.tsx:307-311,1909-1933` protege o reset de assinaturas.
- **Classificação:** CONFIRMED: perda de assinaturas parciais, corrida de persistência e duplo disparo dos handlers cobertos corrigidos. `BACKEND_CONTRACT_BLOCKER` para idempotency keys/constraints/transações além dos locks locais.
- **Contrato backend esperado/observado/risco:** esperado: mutações críticas devem ser idempotentes ou protegidas por transação/constraint/chave de idempotência no servidor. Observado: locks e transações existem nos caminhos DDS locais; não houve retry/concurrency contra banco live.
- **Ação tomada:** menor mudança correta; sem confirmação nativa, sem relaxar validação e sem remover autorização.

## GATE B4 DOM_XSS_AND_MEDIA

- **Comando ou inspeção:** busca de `dangerouslySetInnerHTML|innerHTML|DOMParser|eval|new Function|window.open|location.assign|location.replace` nos fluxos DDS; leitura de imagens, assinatura e PDF.
- **Evidência:** nenhum sink DOM dinâmico foi encontrado nos caminhos DDS, exceto `frontend/src/components/DdsForm.tsx:297`, que abre blob PDF gerado localmente. `frontend/src/components/DdsForm.tsx:131-138,1735-1754` bloqueia SVG/protocolo executável antes de `NextImage`; `frontend/src/components/SignaturesPanel.tsx:53-60,125-129` aplica a mesma política; `frontend/src/lib/pdf-system/components/EvidenceGallery.ts:20-41,146-171` aceita somente data URL de imagem para o PDF e trata falha como indisponibilidade. Testes de imagem, assinatura, blueprint e galeria passaram.
- **Classificação:** PASS nos sinks auditados; `BACKEND_CONTRACT_BLOCKER` para MIME/conteúdo/ownership de anexos retornados pelo servidor.
- **Ação tomada:** helper seguro e testes negativos para SVG/javascript; nenhuma interpolação HTML ou execução de input foi introduzida.

## GATE B5 IMMUTABILITY_UX

- **Comando ou inspeção:** leitura das transições da entidade, assertions de mutabilidade, política de ações e estados finalizados.
- **Evidência:** `backend/src/modules/dds/entities/dds.entity.ts:25-47,145-146` define estados e `VersionColumn`; `backend/src/modules/dds/dds.service.ts:1734-1801` exige aprovação/participantes para PDF final e `:1858-1883` bloqueia PDF final/auditado/arquivado; `frontend/app/dashboard/dds/page.tsx:2092-2110` oculta edição/ações quando locked.
- **Classificação:** PASS de UX e invariantes locais; `BACKEND_CONTRACT_BLOCKER` para prova server-side contra bypass direto.
- **Ação tomada:** mantidos disabled/read-only e as transições fail-closed; nenhuma mutação de documento final foi liberada.

## GATE B6 LOGGER_PII

- **Comando ou inspeção:** busca de `console.*`, logs de `signature_data`, URLs e segredos nos caminhos DDS; leitura dos eventos do serviço.
- **Evidência:** não foram encontrados `console.*` nos runtime paths DDS. `backend/src/modules/dds/dds.service.ts:745-758,878-885,918-932` registra IDs, empresa, estado e fingerprints de storage, não conteúdo de assinatura; `backend/src/modules/dds/dds-signature-invite.service.ts:475-484` registra metadados de IDs sem raw signature; frontend usa `logger` em `frontend/app/dashboard/dds/page.tsx:400-404,499-503,820-830`.
- **Classificação:** PASS estático para ausência de log bruto de PII/segredo nos caminhos auditados; validação de política de retenção/collector externo não verificada.
- **Ação tomada:** nenhum valor secreto foi impresso ou adicionado à documentação.

## GATE B7 ATTACHMENT_BLOB

- **Comando ou inspeção:** inventário de `URL.createObjectURL`/`URL.revokeObjectURL`, wrappers de PDF e acesso a vídeo/storage.
- **Evidência:** `frontend/src/lib/print-utils.ts:5-10,21-57` agenda revogação de blob para abertura/print; `frontend/app/dashboard/dds/page.tsx:671-678,781-783,886-893,1026-1033` revoga PDFs, CSV e pacote semanal; `frontend/src/components/DdsForm.tsx:296-298` revoga prévia; `backend/src/modules/dds/dds.service.ts:797-910,1660-1713` usa storage governado, escopo e URL assinada. Testes de `print-utils` passaram.
- **Classificação:** PASS nos caminhos auditados; `BACKEND_CONTRACT_BLOCKER` para autorização/expiração do storage e vídeo no servidor.
- **Ação tomada:** nenhuma revogação imediata que quebrasse print/aba; atraso controlado de 60 segundos preserva o consumo do recurso.

## GATE C P2_P3_STATIC_BROWSER

- **Comando ou inspeção:** busca repo-local de confirms nativos, acessibilidade semântica, breakpoints e build; `npm run build` frontend.
- **Evidência:** não há `window.confirm`/`window.alert` no painel DDS; os fluxos usam `ConfirmModal` em `frontend/app/dashboard/dds/page.tsx:2417-2437`. Validação visual desktop/tablet/mobile, teclado/foco real e `prefers-reduced-motion` não foi executada porque `npm run build` encerrou com exit 1: `[env] NEXT_PUBLIC_API_URL é obrigatória para build/start protegidos`. Não foi inventada configuração nem usado produção.
- **Classificação:** P2/P3 `BLOCKED`/`TEST_BLOCKER` para browser visual; não é falha funcional inferida do código.
- **Ação tomada:** mantida a implementação existente de responsividade/a11y e registrado o bloqueio para ambiente aprovado.

## GATE FINAL_VALIDATION

- **Comando ou inspeção:** backend `npm run test:ci`, `npm run lint`, `npm run type-check`, `npm run build`, `npm audit --audit-level=high`; frontend `npm run test:ci`, `npm run lint`, `npx tsc --noEmit --pretty false`, `npm audit --audit-level=high`, `npm run build`; `git diff --check`; `git status --short --branch`.
- **Evidência:** backend final: `327 passed`, `2.873 passed`; módulo DDS: `11 passed`, `124 passed`; backend lint/type-check/build sem erro; audit `found 0 vulnerabilities`. Frontend final: `171 passed`, `1 skipped`, `927 passed`, `2 skipped`; lint com `PERMISSION_IMPORTS_OK`, Stylelint e typecheck sem erro; audit `found 0 vulnerabilities`. `git diff --check` sem erro de whitespace; warnings de CRLF permanecem somente nos dois `frontend/app/verify/*` históricos e não relacionados. Frontend build: exit 1 no prebuild por `NEXT_PUBLIC_API_URL` ausente. Status final mantém apenas código DDS/docs e os dois arquivos `verify` pré-existentes; branch isolada está atrás do origin por commits posteriores ao START, sem rebase/merge automático.
- **Classificação:** PASS em testes, lint, typecheck, build backend e audit; `STATUS=PARTIAL` por build/browser frontend bloqueado e ausência de prova live de backend/RLS/storage.
- **Ação tomada:** revisão do diff concluída; nenhum backend fora de `backend/src/modules/dds`, migration, workflow, produção, branch compartilhado, commit, push, PR, merge ou deploy foi executado.
