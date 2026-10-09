# SGS — Plano faseado de frontend, banco de dados, backend e seguranca

Data de abertura: 2026-10-09
Ordem autorizada: **frontend completo (desktop + mobile) → PostgreSQL → backend**.
Referencia operacional obrigatoria: `docs/OPERACAO-CANONICA-SGS.md`.
Status geral: **EM EXECUCAO / NAO LIBERADO PARA PRODUCAO**.

> Este documento e um plano de execucao com gates de aceite, nao um atestado de que as fases passaram.
> Um `PASS` so existe apos evidencia de execucao; `BLOCKED` e `INCOMPLETE` impedem promocao.

## 0. Baseline e regras de preservacao

- Repositorio `wandersongandra/sgsseguranca`, branch principal `main`.
- Stack inspecionada: Next.js 16, React 19, TypeScript, Tailwind, NestJS 11, TypeORM, PostgreSQL, Redis.
- O cliente HTTP central e `frontend/src/lib/api.ts`; shell em `app/dashboard/layout.tsx`, `src/components/Header.tsx` e `Sidebar.tsx`; design tokens em `frontend/styles/`.
- A PR #446 (`improve/pdf-frontend-polish-20261007`) permanece **draft** com alteracoes amplas de PDFs, UI e mobile. Na descricao, a execucao da CI consta bloqueada por `startup_failure`. **Nao** duplicar nem sobrescrever essa PR sem integrar seus resultados e refazer QA.
- O SGS e multi-tenant: nenhuma alteracao visual pode enfraquecer escopo por empresa/site, permissão real no servidor, governanca de PDFs, assinatura ou autoria.
- Fonte da verdade: codigo, migrations e testes atuais; docs historicos podem estar desatualizados.
- Nao consultar/alterar producao para testes. Usar VPS isolada, tenants e dados sinteticos, sem revelar segredos, tokens, CPF ou URLs assinadas.

## Fases F — Frontend desktop e mobile (primeira prioridade)

### F0 — Inventario, baseline e conflitos
**Escopo:** mapear rotas do `frontend/app/`, navegacao e permissoes, contratos dos services, todas as telas por dominio e componentes duplicados; comparar `main` com PR #446; classificar defeitos por P0/P1/P2.

**Saida:** matriz `modulo × desktop × mobile × auth/RBAC × estado × testes`; registrar desvios e evidencias no PR.

**Gate:** sem alteracoes concorrentes ou conflitos nao tratados; comandos `lint`, `tsc --noEmit`, `test:ci`, `build` com ambiente de teste valido.

### F1 — Design system e estrutura de pagina
**Escopo:** tokens reais de cor SGS, contraste AA, tipografia, escala de espacos, grid, foco, buttons/inputs/selects, modais, menu, tabelas, cards, estado vazio/loading/erro, `PageHeader`, `ListPageLayout` e `FormPageLayout`.

**Gate:** componentes sem versoes paralelas, sem regressoes de teclado, sem copys genericas nem decoracao que obscureca conteudo de SST; Axe e testes de componentes.

### F2 — Desktop e produtividade operacional
**Escopo:** shell, sidebar, header, busca, selecao de empresa/site, dashboard, filtros, tabelas densas, ordenacao, paginacao, exportacao, atalhos e formularios longos.

**Gate:** fluxos de APR/PT/DDS/RDO, checklists, CAT, NC, EPI, treinamentos, usuarios, empresas, documentos e relatorios completos em >=1280px e 1440px, sem perda de estados ou contexto.

### F3 — Mobile de campo e tablet
**Escopo:** largura 320/360/390/430/768/1024px, safe areas, teclado iOS, campos >=16px, alvos de toque >=44px, bottom navigation, offcanvas, sheets, paginacao/cards, avisos e PDFs. Revisar assinatura, fotos, upload, scanner, rede instavel e fluxos operacionais longos.

**Gate:** sem scroll horizontal involuntario; nenhuma acao ou conteudo critico encoberto; foco/teclado e leitor de tela utilizaveis; Safari iOS e Chromium/Android revisados; teste E2E autenticado de cada modulo prioritario.

### F4 — Isolamento de dados no browser e seguranca de interface
**Escopo:** destinos de chamadas autenticadas; troca de tenant/sessao, logout e limpeza de cache/drafts; persistencia offline; URLs/links e arquivos externos; CSP/cookies/CSRF; dependencias; XSS, open redirect, IDOR e exposicao de dados em logs/client telemetry.

**Gate:** autenticacao/permissoes continuam exigidas no backend; requisicoes com credenciais ficam restritas a API configurada; testes negativos para destinos remotos, troca de tenant e sessao; scan de dependencias/secrets.

**Parcela em andamento:** branch `security/frontend-api-origin-20261009` adiciona protecao de destino no cliente HTTP e regressao Jest; CI/E2E pendentes.

### F5 — Performance, offline/PWA e modularidade
**Escopo:** revisar JS/hydration/bundle por rota, imagens/fontes, eventos de scroll, caches (`useCachedFetch`, IndexedDB, `fetchAllPages`), cancelamento de requisicoes, estado stale e tratamento de erros. Migrar gradualmente paginas monoliticas para a arquitetura modular aceita no ADR-001.

**Gate:** comparativo reproduzivel antes/depois para carga e interatividade, sem regressao de dados; nao armazenar dados sensiveis desnecessarios no navegador.

### F6 — QA e fechamento completo do frontend
**Escopo:** testes Jest, lint, typecheck, build, Playwright autentificado e publico, Axe, regressao visual nas resolucoes citadas, teste de contratos, erros de rede, navegacao, PDFs, tenant e RBAC.

**Gate para ir ao banco:** zero falhas P0/P1, CI funcional, evidencias sinteticas na VPS de teste e checklist por tela concluido. **Sem esse gate, o banco ainda nao entra em execucao.**

## Fases D — Banco de dados PostgreSQL (somente apos F6)

### D0 — Inventario estrutural
Catalogar schemas, entidades, migrations, indices, constraints, triggers, roles, grants, RLS, views/materialized views, jobs e volumetria **sem coletar dados pessoais reais**.

### D1 — Isolamento e integridade
Revalidar `SET LOCAL app.current_company_id`, role runtime sem `BYPASSRLS`, cobertura `FORCE ROW LEVEL SECURITY` onde aplicavel, joins indiretos, referencias a site/unidade, unicidade composta, FKs, soft delete, constraints e exclusao logica. Testes reais com pelo menos dois tenants e usuarios de permissoes diferentes.

### D2 — Desempenho e concorrencia
Capturar planos `EXPLAIN (ANALYZE, BUFFERS)` com dados sinteticos; corrigir N+1/indices, paginacao e hotspots. Preservar os requisitos de migrations `CONCURRENTLY` e `transaction = false` quando necessario.

### D3 — Migrations, backup, restore e rollback
Cada alteracao com migration versionada, revisao de compatibilidade, estrategia expand/contract, snapshot isolado, ensaio de restore e passo a passo de rollback. Proibido `synchronize: true`.

### D4 — Gate do banco
Migracoes em PostgreSQL real na VPS de teste, RLS cross-tenant/cross-site, carga sintética, restore e regressao de APIs aprovados. Sem aplicar schema diretamente em producao.

## Fases B — Backend NestJS (somente apos D4)

### B0 — Inventario de endpoints, contratos e arquitetura
Mapear controllers/guards/DTOs/services/queues/webhooks/storage, perfis, ownership por recurso, endpoints publicos, cron e limites de modulo; confrontar OpenAPI com consumo do frontend.

### B1 — Autenticacao, sessao e autorizacao
Revisar refresh/JWT/MFA/CSRF, RBAC de objeto/empresa/site, invalidacao de sessao e rate limiting distribuido. Negative tests para BOLA/IDOR, elevacao de privilegio, tenant e replay.

### B2 — Regras SST e documentos governados
Auditar APR, PT, DDS, RDO, CAT, checklists, EPI, NC e laudos: validacoes, maquinas de estado, assinatura, versao, trilha imutavel, hash, QR, emissao e verificacao de PDF. Nao alterar regras legais sem evidencias.

### B3 — Integracoes, arquivos, IA e filas
Inspecao de upload, MIME/magic bytes, virus scan, storage presigned e expiracao, SSRF, timeouts, idempotencia, DLQ, retries, Sophie e sanitizacao de PII.

### B4 — Escalabilidade e observabilidade
Instrumentar p95/p99, traces, logs sem segredos, erros por tenant, filas, cache, health/readiness, recuperacao e degradacao previsivel sem Redis.

### B5 — Gate final integrado
Executar testes e2e com duas empresas, cargas sinteticas, scans, contratos frontend/backend, RLS, PDF, storage, acessibilidade e backup/restore. Registrar o SHA validado; somente propor release com **todos os gates PASS** e aprovacao explicita.

## Condicoes de parada

- Dados, segredos, bancos e buckets reais jamais sao copiados para evidencias.
- Qualquer diferenca funcional relevante entre `main`, PR #446 e as novas PRs deve ser resolvida antes de merge.
- Merge/deploy somente apos checks e validacao reproduziveis; status `BLOCKED` significa **NO-GO**, nao aprovacao tacita.
- A cada fase: alterar codigo, acrescentar teste, registrar arquivos/risco/evidencias, criar PR revisavel e documentar rollback.
