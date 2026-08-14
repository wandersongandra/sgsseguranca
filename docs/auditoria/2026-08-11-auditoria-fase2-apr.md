# SGS APR — Security Audit Fase 2

**Data:** 11/08/2026
**Escopo:** red team controlado do APR, com prioridade para prova HTTP/E2E, cross-tenant, cross-site, workflow, assinatura, cache/offline, storage e regressões da Fase 1.

## 1. Executive Summary

A Fase 2 foi executada até o limite seguro do host. A suíte E2E oficial foi chamada com os testes APR críticos, mas a infraestrutura não pôde ser levantada: `docker` não está instalado e não existem Postgres/Redis locais nas portas esperadas. O runner confirmou objetivamente `DB=✗ Redis=✗` e marcou 27 testes como skipped. Portanto, esta rodada **não produziu prova HTTP/E2E nem prova RLS**.

As correções da Fase 1 foram revalidadas por 115 testes unitários direcionados, typecheck, build e lint. O código continua com proteção de escopo de obra, lock de workflow, fail-closed de feature flag e vínculo de assinatura APR. Também corrigi o finding de dependência `dompurify` e a cadeia de tooling que impedia o lint frontend.

## 2. Verified Security Score

- **Code Security Score:** 8,2/10 — controles principais presentes e cobertos por testes de serviço; DTO excessivo, metadados de evidência e fila offline continuam pendentes.
- **Verified E2E Security Score:** 1,5/10 — somente o mecanismo de execução/skip foi observado; nenhuma ação autenticada real foi executada contra banco Redis/HTTP de teste.

**Veredito:** `APR SECURITY PARTIALLY VERIFIED`.

## 3. Infraestrutura E2E utilizada

Infraestrutura prevista em `backend/docker-compose.test.yml`:

- Postgres 16 (`5433`)
- Redis 7 (`6379`)
- ClamAV (`3310`)

Resultados reais:

- `docker version` / `docker compose version`: comando não encontrado.
- `Test-NetConnection 127.0.0.1:5433/5432/6379`: todas indisponíveis.
- `npm run test:e2e -- --testPathPatterns=critical/(apr-lifecycle|multi-tenant-apr)...`: 2 suítes, 27 testes skipped, `DB=✗ Redis=✗`.
- `node backend/scripts/run-e2e.cjs`: falhou ao executar `docker compose ... up -d`.

Nenhum banco, Redis, storage, worker ou seed E2E foi usado. Nenhuma ação foi enviada à produção.

## 4. Identidades e tenants criados

**Nenhum registro foi criado nesta rodada**, porque o bootstrap E2E não iniciou. O código de seed existente define `tenantA`/`tenantB`, um site por tenant e perfis reais (`ADMIN_EMPRESA`, `TST`, `SUPERVISOR`, `COLABORADOR`, `TRABALHADOR`), mas isso não é evidência de execução.

## 5. Matriz cross-tenant

| Operação A → APR B | Esperado | Real Fase 2 | Status |
|---|---:|---:|---|
| LIST/GET | 404/403 | não executado | E2E PENDING |
| CREATE com header spoof | 403/sem criação | não executado | E2E PENDING |
| UPDATE/DELETE | 404/403 | não executado | E2E PENDING |
| SUBMIT/APPROVE/REJECT/FINALIZE/REOPEN | 404/403 | não executado | E2E PENDING |
| SIGN/evidence/PDF/export/history | 404/403 | não executado | E2E PENDING |

O teste existente `multi-tenant-apr.e2e-spec.ts` contém GET e spoof de `x-company-id`, mas foi pulado pela mesma pré-condição.

## 6. Matriz cross-site

| Ator A1 → APR A2 | Esperado | Real Fase 2 | Status |
|---|---:|---:|---|
| GET/list/history/PDF/export/evidence | 404/403/filtrado | não executado | E2E PENDING |
| CREATE com `site_id=A2` | 403/sem APR | não executado | E2E PENDING |
| UPDATE movendo A1→A2 | 403/sem alteração | não executado | E2E PENDING |
| SUBMIT/APPROVE/REJECT/FINALIZE/REOPEN | 404/403 | não executado | E2E PENDING |
| SIGN | 403 | não executado | E2E PENDING |

A proteção está coberta no nível de serviço: `site_id = ANY(...)` no lock e `assertSiteWithinCurrentActorScope` em create/update, mas ainda falta a prova ponta a ponta exigida pelo critério de sucesso.

## 7. Matriz de permissões

Revalidação estática: `@Authorize` usa `can_view_apr`, `can_create_apr`, `can_update_apr`, `can_delete_apr`, `can_approve_apr`, `can_reject_apr`, `can_finalize_apr` e `can_generate_apr_pdf`. Mutations críticas também têm guardas de role. `ValidationPipe` usa `whitelist + forbidNonWhitelisted`.

Não houve token real nesta fase para provar revogação, sessão expirada, usuário desativado ou troca de permissão.

## 8. Lifecycle real

Estados observados no código: `Pendente`, `Aprovada`, `Cancelada`, `Encerrada`.

| Origem | Ação | Destino | Resultado estático |
|---|---|---|---|
| Pendente | approve/submit | Aprovada | permitido sob role/etapa |
| Pendente | reject | Cancelada | permitido sob permissão |
| Aprovada | finalize | Encerrada | exige PDF final/lock |
| Aprovada | reject | Cancelada | permitido conforme workflow |
| Cancelada/Encerrada | reopen/edit/approve/finalize | — | bloqueado |
| Aprovada | new-version | Pendente (nova identidade) | permitido |

## 9. Testes de assinatura

O teste unitário direcionado cobre usuário não participante com `403`, além de escopo de obra e APR pendente. O assinante efetivo é derivado do contexto autenticado; DTO `user_id` não faz impersonação. A prova E2E de participante/elaborador/cross-site/cross-tenant não foi executada.

## 10. Testes de concorrência

Não houve requests concorrentes reais. O código mantém transação e `FOR UPDATE NOWAIT` com retry para approve/reject/finalize/submit. Permanecem pendentes os cenários approve+approve, approve+cancel, sign+sign, update+finalize e reopen+finalize contra Postgres real.

## 11. Cache/offline/logout

Inspeção estática confirma query keys e namespace offline por tenant/session storage, limpeza no logout/troca de tenant e drafts APR em `sessionStorage`. O risco residual de uma escrita offline em voo sobreviver à troca de tenant permanece **não reproduzido**; falta teste browser/IndexedDB real. A fila deveria carregar `tenantId + sessionGeneration + actor binding`.

## 12. Evidências/storage

Validação server-side de magic bytes, escopo de APR/risk item e URLs assinadas foi rechecado estaticamente. Não foi possível testar TTL, logout, replay, ACL de bucket, enumeração de file IDs ou usuário de outra obra sem storage/HTTP E2E.

## 13. Findings novos

- **Médio — tooling de segurança:** ESLint 10 era incompatível com plugins do Next e quebrava antes do lint. Corrigido para ESLint 9.39.5, com override compatível de `minimatch`.
- **Baixo — lint de artefato:** coverage gerado era analisado por ESLint/Stylelint. Ignorado explicitamente; nenhum código de produção foi excluído.
- **DomPurify:** override atualizado de `>=3.4.9` para `>=3.4.13`; `npm audit --omit=dev` frontend/backend reportou zero vulnerabilidades.

Não foi confirmado novo bypass de autorização sem infraestrutura real.

## 14. Findings antigos revalidados

APR-01 a APR-07: **FIXED + STATICALLY VERIFIED + UNIT TESTED; E2E PENDING**.
APR-08 a APR-13: **FIXED/OPEN conforme relatório da Fase 1; E2E PENDING**. URLs/logs/CSV estão corrigidos; DTO excessivo, evidence DTO, PDF access internals e fila offline continuam abertos.

## 15. Patches aplicados nesta Fase 2

- `frontend/package.json` / lock: ESLint 9.39.5, DomPurify >=3.4.13, override minimatch compatível.
- `frontend/eslint.config.mjs` e `stylelint.config.mjs`: ignoram somente `coverage/**` gerado.
- Nenhuma alteração foi feita para simular banco, desabilitar guards ou transformar E2E em mock.

## 16. Testes por inversão

Não executados contra a aplicação real: a infraestrutura necessária não existe no host. Os testes unitários de negativa usam mocks de escopo/participante e passaram, mas não constituem prova de inversão HTTP/RLS. O próximo run deve executar cada APR-01…APR-07 com patch, sem patch e restauração em worktree isolado.

## 17. Comandos executados

```text
docker version; docker compose version                         → docker não encontrado
Test-NetConnection 127.0.0.1 nas portas 5433/5432/6379       → indisponíveis
node backend/scripts/run-e2e.cjs                               → falha no docker compose
npm run test:e2e ... critical/(apr-lifecycle|multi-tenant)     → 27 skipped
npm test -- ... workflow/feature-flag/signatures              → 115 passed
npm run type-check (backend)                                   → passed
npx tsc --noEmit (frontend)                                    → passed
npm run lint (frontend)                                        → passed
npm run build (frontend)                                       → passed
npm audit --omit=dev (backend/frontend)                        → 0 vulnerabilities
```

## 18. Resultados de build/typecheck/lint/tests

Frontend lint, typechecks, builds, testes APR direcionados e auditoria de dependências passaram. O lint backend foi executado, mas falhou em quatro migrations fotográfico-relatório fora do escopo APR (formatação Prettier) e em três warnings de testes existentes; não houve erro APR no diagnóstico. O único gate de segurança não executado é E2E/integração real por ausência objetiva de Docker, Postgres e Redis.

## 19. Riscos residuais

1. Falta de prova cross-tenant/cross-site por HTTP e consulta direta ao banco.
2. RLS não comprovada; os E2E normais usam `synchronize()` quando executados e não provam policies sem modo migrado.
3. DTO APR/evidence/PDF ainda expõe campos além do necessário.
4. Fila offline sem binding explícito de geração de sessão.
5. Concorrência, revogação de token/permissão, back button, CSRF cookie real e storage ACL sem execução.

## 20. Veredito

`APR SECURITY PARTIALLY VERIFIED`

Para mudar para `APR SECURITY VERIFIED`, é obrigatório executar a mesma matriz com Postgres/Redis de teste, seed descartável, dois tenants e dois sites no tenant A, incluindo consulta SQL pós-request, testes de concorrência e inversão APR-01…APR-07.
