# SGS — auditoria inicial de PRs e plano de correção por gates

Data: 2026-10-20. Repositório: `wandersongandra/sgsseguranca`.
Escopo autorizado: backend + PostgreSQL primeiro; depois frontend, PDFs e integrações.
Documento subordinado a `docs/OPERACAO-CANONICA-SGS.md`.

> **Status desta rodada: NO-GO.** A existência de commits e testes adicionados
> não substitui compilação, testes executados, CI e homologação na VPS de teste.
> Não houve acesso à VPS, banco, storage nem credenciais de produção nesta rodada.

## 1. Inventário e fatos observados

- A busca de PRs retornou **43 abertas** em 2026-10-20; foram consultadas
  **30 PRs já mescladas**, com ênfase em correções recentes e histórico de SST.
- As PRs #446 (155 arquivos: PDFs/frontend) e #450 (cliente API/roadmap)
  permanecem **draft**; a descrição de #450 declara QA não executado.
- A inspeção das execuções associadas aos commits das PRs #457, #455,
  #454, #453, #452, #450 e #446 encontrou seis workflows por commit,
  todos com `conclusion=startup_failure`; as execuções de CI verificadas
  tinham **zero jobs**. Isso **não** equivale a teste de código falhando,
  tampouco a um PASS. Verificar billing, elegibilidade do Actions, limites,
  políticas do repositório e avisos de execução na interface GitHub.
- Não fazer merge/auto-merge de nenhuma PR usando `mergeable=true` como
  prova de QA: esse campo confirma apenas ausência de conflito detectado.
- A `main` contém melhorias integradas em PRs #374 (imutabilidade SST),
  #377 (sessão/tenant frontend), #381/#383/#388 (APR/PT/DDS) e #429
  (DR/upload). Avaliar sobreposição de #341, #342, #339 e #343 antes
  de reaplicar patches antigos. #344 (deduplicação atômica de
  notificações) exige revisão própria contra o schema da `main`.
- A política de operação exige VPS de teste isolada, fixtures sintéticas,
  evidências por SHA e aprovação explícita para produção.

### Triagem de todas as PRs abertas

| PRs | Natureza | Encaminhamento |
| --- | --- | --- |
| #455, #453, #454, #445, #444, #443, #448, #447 | Correções de dependências com relevância de segurança | **P1:** validar integridade dos lockfiles e `npm ci`; priorizar correção sem pular gates |
| #452, #457 | NestJS/core e toolchain (inclui TypeScript major em #457) | **P1:** homologação separada; não combinar upgrades grandes às cegas |
| #449, #417, #451, #438, #436, #410, #408, #406 | Upgrade de runtime/tooling com potencial incompatibilidade | **P1/P2:** teste de integração por grupo; checar supersedência entre #449/#417 |
| #456, #451, #439, #432, #420, #418, #437, #407, #404, #397 | Dependências variadas | **P2:** reconciliar e testar por camada |
| #426, #425, #424, #422, #415 | Actions de segurança | **P1:** revisar pins, permissões e workflows como conjunto |
| #450 | Restrição de origem no cliente autenticado | **Draft/NO-GO:** testar login, proxy, upload externo, troca de tenant e regresões |
| #446 | 155 arquivos de PDF/design | **Draft/NO-GO:** dividir revisão por emissor e superfície; golden PDFs + comparação visual |
| #378, #346, #345, #340, #339, #343 | Frontend/produto/contratos | Revisar contra `main`, especialmente regressões já tratadas em #377 |
| #344 | Notificação com deduplicação no PostgreSQL | Validar migration 0403/0404 e impacto com histórico atual |
| #342, #341 | Imutabilidade CAT/fotos/EPI | Comparar contra #374 já integrada; fechar só se totalmente cobertas |

## 2. Correção isolada implementada nesta branch

O `TenantDbContextService` guardava uma chave de contexto diretamente no
objeto do cliente PostgreSQL e deixava de reconfigurar a sessão quando
o objeto era reutilizado com a mesma chave. Uma sessão pode ser modificada
fora desse cache; por isso, a presença da chave JS não comprova o contexto
RLS efetivo. **A correção reconfigura todas as variáveis RLS a cada checkout**.

Quando `set_config` falha, o fluxo anterior tentava limpar contexto e podia
devolver o cliente como se estivesse apto para consulta. **Agora descarta
a conexão com `release(error)` e propaga a exceção**, sem tratar a falha
como conjunto vazio de dados.

Foram adicionados testes Jest para: (1) reconfiguração da mesma conexão
em dois empréstimos consecutivos e (2) erro de `SET` que deve rejeitar
a aquisição e descartar a conexão. O impacto esperado é um round-trip
de configuração **por checkout** (em vez do eventual skip por cache).

**Limitação de arquitetura:** essa correção **não torna seguro** o uso de
pooler em modo transaction pooling com variáveis de sessão entre transações.
Esse modo precisa ser vetado ou migrado para `SET LOCAL` dentro da mesma
transação/mesma conexão, com testes integrados específicos.

## 3. Fases obrigatórias: backend e PostgreSQL primeiro

### B0 — Baseline, CI e dependências (bloqueador)

1. Restaurar execução GitHub Actions (não confundir `startup_failure` com
   falha de Jest/TS). Capturar job IDs, SHA e logs quando houver jobs.
2. Executar `npm ci`, `npm run type-check`, `npm run lint`,
   `npm run test:ci`, `npm run build:ci` em checkout limpo.
3. Rodar scans de secrets e `npm audit` com lockfiles verificados; testar
   upgrades menores de segurança antes de majors que alteram APIs.
4. Preparar inventário de schema e migrations na VPS isolada.
   **Gate:** setup reproduzível, jobs CI reais e nenhuma mudança em produção.

### D0 — PostgreSQL: privilégios, conexões, RLS (P0)

1. Conferir `sgs_app` sem `BYPASSRLS`, role de migrations separada
   de role runtime e conexão `DATABASE_ADMIN_URL` dedicada.
2. Auditar todas as tabelas tenant-scoped para `ENABLE/FORCE ROW LEVEL
   SECURITY`, políticas `USING` + `WITH CHECK`, default deny e
   owner bypass. Rodar `verify:rls` e `db:security-posture:strict`.
3. Exercitar troca de tenant/site no mesmo cliente físico, master e réplicas,
   jobs sem escopo, transações com rollback, `RESET ALL`, reconexão,
   erros de `SET` e pools saturados.
4. Determinar se há PgBouncer e o **modo de pooling**. Sem compatibilidade
   RLS comprovada, bloquear transações/consultas via pooler.
   **Gate:** 0 leituras/escritas cross-tenant em fixtures adversariais.

### D1 — Migrations e integridade (P0)

1. Comparar histórico aplicado e versionado, aliases legados e dependências.
2. Executar em PG17 sintético subida, rollback onde seguro, reaplicação;
   verificar `migration:pending:check`, constraints, índices, FKs e
   nulidade; classificar migrations destrutivas separadamente.
3. Auditar migrations 0392–0404, inclusive conflitos sobre dedupe key,
   constraints parciais e colunas de assinatura.
4. Testar upgrade sobre cópia **anonimizada** de dados, com backup íntegro,
   `EXPLAIN (ANALYZE, BUFFERS)` e janela de lock controlada.
   **Gate:** rollback documentado e nenhuma perda de registros.

### B1 — Contratos de autorização e identidades (P0)

Revisar JWT/refresh, sessão revogada, CSRF, MFA, autorização no backend,
`company_id`, `site_id`, IDOR em anexos e mudanças de perfil.
Cobrir cache/API/WebSocket/worker para não transportar escopo anterior.
**Gate:** testes negativos para usuário comum, admin de empresa e admin geral.

### B2 — Concorrência e fluxos SST (P0/P1)

Auditar APR/ARR/PT/DDS/EPI/CAT/Relatório Fotográfico/RDO com transações,
locks, deduplicação, idempotência, replays, assinaturas, imutabilidade
pós-finalização, outbox/filas e reprocessamento de jobs. Priorizar
#344 somente após comparar alterações com o histórico real de migrations.
**Gate:** corrida controlada gera um único efeito de negócio.

### B3 — Arquivos, PDFs governados e integrações (P1)

Hash antes/depois, magic bytes, allowlist de MIME, tamanho, URLs presigned,
download autorizado, S3/R2, reemissão, QR, registry, validade de assinatura,
workers e cleanup. Testar falhas parciais e recuperação.
**Gate:** nenhuma publicação incompleta e hashes preservados.

### B4 — Operação, desempenho, LGPD e DR (P1)

Testar p95/p99 sob carga controlada, N+1, filas e backpressure, exaustão de
pool, rate limit, observabilidade sem PII, retenção, exportação/exclusão LGPD,
backup/restore e rotação de chaves. **Gate:** SLO e restore comprovados.

### B5 — Segunda auditoria adversarial

Revisar PRs criadas na B0–B4; repetir gates após qualquer correção.
Não declarar aprovado com testes ignorados, flaky não investigado, vulnerabilidades
sem classificação ou documentação divergente do comportamento do código.

## 4. Somente depois dos gates backend/database

**F0–F3 (frontend):** reconciliar #450 e #446, avaliar RBAC/tenant,
API client e caches, corrigir responsividade 320–1920 px, formulários,
estados de carregamento/erro, WCAG e navegação por teclado.

**P0–P3 (PDFs):** revisão de template por documento, fontes UTF-8,
quebras de página, tabelas longas, QR/links, datas históricas, assinaturas,
hashes e golden snapshots. Não promover apenas pela comparação visual.

**E0–E2 (E2E/release):** Playwright/Axe desktop/mobile, API + DB + storage,
backup/restore e smoke do SHA na VPS. Somente após gates verdes criar
relatório final e solicitar autorização de deploy.

## 5. Comandos mínimos e evidência

```sh
cd backend
npm ci
npm run type-check
npm run lint
npm run test:ci -- --runTestsByPath src/shared/database/tenant-db-context.service.spec.ts
npm run build:ci
npm run ci:migration:check
# Somente na VPS de TESTE, com roles/URLs/fixtures sintéticas:
npm run verify:rls
npm run db:security-posture:strict
```

Registrar, por comando: ambiente, SHA, data, duração, status
`PASS/FAIL/BLOCKED/INCOMPLETE`, evidência redigida e responsável.
Executar em ordem crescente de risco e não executar comandos com acesso
a DB real até confirmar guardrails do runbook canônico.

**Veredito:** correção de código proposta, sem confirmação de compilação
ou execução dos testes; PR permanece aberta e não deve ser mergeada
até a restauração de CI e os testes PostgreSQL na VPS isolada.
