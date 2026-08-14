# Auditoria extrema de segurança — módulo APR

**Data:** 11/08/2026 · **Escopo:** frontend APR/SST Agent, API NestJS, workflow, assinaturas, evidências, cache e exportações.

## Conclusão executiva

O isolamento entre empresas está aplicado nos caminhos APR revisados (middleware/guard, `company_id`, consultas de escrita/leitura e DTOs). O isolamento entre obras dentro da mesma empresa tinha quatro falhas de escrita de alto impacto: transições críticas, criação, mudança de `site_id` e preparação do rules engine. Também havia reabertura de APR terminal, flag de workflow fail-open, assinatura sem vínculo funcional e vazamento de URLs assinadas em log. As correções foram aplicadas no worktree e validadas por testes direcionados, typecheck e builds.

**Resposta objetiva sobre multi-tenancy:** cross-tenant: **sim, protegido nos caminhos estáticos inspecionados**; RLS/ACL e runtime produtivo: **inconclusivo**, pois não houve credencial/DB live nesta rodada. Cross-site: **corrigido no patch** para as mutações cobertas; os E2E de infraestrutura continuam desabilitados no ambiente atual.

## Achados corrigidos

| ID | Severidade | Evidência | Correção |
|---|---|---|---|
| APR-01 | Alta | `AprWorkflowService` travava por `id + company_id`, permitindo approve/reject/finalize/submit de APR de outra obra | lock agora exige `deleted_at IS NULL` e, para perfil restrito, `site_id = ANY($3)` (`backend/src/modules/aprs/aprs-workflow.service.ts:100-105`) |
| APR-02 | Alta | `POST /aprs` aceitava site de outra obra do mesmo tenant | `assertSiteWithinCurrentActorScope` antes da transação (`backend/src/modules/aprs/aprs.service.ts:1207-1224,1290`) |
| APR-03 | Alta | `PATCH /aprs/:id` podia mover APR para `site_id` fora do escopo do ator | mesma guarda no target site (`backend/src/modules/aprs/aprs.service.ts:1916`) |
| APR-04 | Alta | `submit`/rules engine carregava APR só por empresa | `findOneWithRiskItems` aplica o escopo de obras (`backend/src/modules/aprs/aprs.service.ts:2219-2235`) |
| APR-05 | Média/Alta | `/reopen` podia reabrir APR `Encerrada`/`Cancelada` ou com PDF final | `processApproval(REABERTO)` rejeita estado terminal/PDF (`backend/src/modules/aprs/aprs-workflow.service.ts:850-858`) |
| APR-06 | Média | guard da flag retornava `true` em erro de banco | fail-closed com `503 ServiceUnavailableException` (`backend/src/modules/aprs/guards/apr-feature-flag.guard.ts:31-47`) |
| APR-07 | Média/Alta | qualquer usuário com `can_manage_signatures` podia assinar APR alheia sem ser participante | `POST /signatures` exige elaborador ou registro em `apr_participants` (`backend/src/modules/signatures/signatures.service.ts:946-999`) |
| APR-08 | Média | falha de fetch de evidência registrava URL assinada completa | log usa somente `evidenceId`, status e mensagem (`frontend/src/lib/pdf/aprGenerator.ts`) |
| APR-09 | Média | título/descrição da APR assistida e sugestão de checklist iam para query string | conteúdo passa por `sessionStorage`; URL contém apenas IDs/flag opaca (`frontend/app/dashboard/sst-agent/page.tsx:442-457`, `frontend/app/dashboard/aprs/components/AprForm.tsx:325,456-468`) |
| APR-10 | Baixa/Média | CSV podia executar fórmula ao abrir no Excel | prefixo seguro para `=`, `+`, `-`, `@` (`frontend/src/components/StoredFilesPanel.tsx:264-268`) |
| APR-11 | Média | logs de `AxiosError` podiam expor `response.data`, config e stack | logger reduz erros a `name/message/code/status` (`frontend/src/lib/logger.ts:14-42`) |
| APR-12 | Baixa | analytics/matriz contavam APRs soft-deletadas e analytics não variava por obra | filtros `deleted_at`, `site_id` e chave de cache por escopo (`backend/src/modules/aprs/aprs.service.ts:2896-2947,3115-3116`) |
| APR-13 | Baixa/Média | cálculo de versão não limitava empresa nem soft-delete | query inclui `company_id` e `deleted_at IS NULL` (`backend/src/modules/aprs/aprs.service.ts:2477-2484`) |

## Achados ainda abertos / hardening recomendado

1. **Excesso de dados (Médio, CWE-200/API3):** `GET /aprs/:id` serializa `CompanyResponseDto`/`UserResponseDto` completos, incluindo CNPJ, endereço, e-mail, status de acesso e permissões de perfil. O frontend APR usa nome/ID/função, não a matriz de permissões. Criar DTO de projeção mínima por endpoint.
2. **Evidências (Baixo/Médio, LGPD):** `GET /aprs/:id/evidence` ainda entrega GPS, device hash/IP mascarado e chaves internas de storage junto às URLs assinadas (`backend/src/modules/aprs/services/aprs-evidence.service.ts:393-429`). Remover `file_key`, `watermarked_file_key` e metadados não necessários para a tela; manter no audit server-side.
3. **PDF/storage (Baixo):** `getPdfAccess` retorna `fileKey`/`folderPath` além da URL assinada. Preferir filename seguro + URL e auditar consumidores.
4. **Dependências:** `npm audit --omit=dev` no frontend apontou `dompurify` moderado via jsPDF resolvendo 3.4.12; atualizar override/lock para >=3.4.13 e revisar novamente.
5. **Offline:** há risco concorrencial teórico de uma escrita da fila terminar após troca de tenant; não foi demonstrada exposição. Vincular cada item a `tenantId + session generation` e rejeitar gravações de geração anterior.
6. **E2E:** `backend/test/critical/apr-lifecycle.e2e-spec.ts` e `multi-tenant-apr.e2e-spec.ts` usam `describe.skip` quando `E2E_INFRA_AVAILABLE=false`; faltam testes live cross-site para create/update/approve/reject/finalize/submit e reopen terminal.

## Cobertura e controles negativos

- Não foram encontrados sinks APR de XSS (`dangerouslySetInnerHTML`, `innerHTML`, `eval`); React escapa texto e o PDF backend escapa HTML.
- CSRF, headers de tenant, `ValidationPipe(whitelist + forbidNonWhitelisted)`, magic bytes/inspeção de uploads e TTL de URLs assinadas foram revisados sem bypass confirmado.
- Não foi executado ataque HTTP/Burp, teste com dois tokens reais, inspeção de RLS/ACL ou storage live; portanto essas garantias não são declaradas como prova de produção.

## Validação executada

- Backend: 3 suítes direcionadas, **115 testes passando** (workflow, feature flag, assinaturas).
- Backend `npm run type-check`: **passou**.
- Frontend `npx tsc --noEmit`: **passou**.
- Backend `npm run build`: **passou**.
- Frontend `npm run build`: **passou** (Next 16.3, 91 páginas).
- Frontend `src/lib/sophie-draft-storage.test.ts`: **2 testes passando**.
- `git diff --check`: **passou**. O lint frontend ficou bloqueado por incompatibilidade do runner instalado (`ESLint 10.8.0`, `scopeManager.addGlobals is not a function`), não por diagnóstico de regra APR; o lint backend excedeu 120s sem emitir diagnóstico.

## Prioridade de fechamento

1. Publicar e executar E2E multi-obra com dois perfis/tokens.
2. Projetar DTO mínimo de APR/evidências e remover chaves/metadados desnecessários.
3. Atualizar `dompurify`/lockfile e corrigir a incompatibilidade do runner ESLint.
4. Corrigir fila offline com geração de sessão/tenant e repetir teste de troca de tenant.
