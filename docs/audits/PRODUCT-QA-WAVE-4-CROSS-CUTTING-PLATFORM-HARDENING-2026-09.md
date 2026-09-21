# SGS — Product QA Wave 4 — Cross-Cutting Platform Hardening

**Data da evidência:** 02/09/2026
**Repositório:** `wandersongandra/sgsseguranca`
**Branch:** `product/wave-4-cross-cutting-platform-hardening`
**Base empilhada:** PR #342 / `c9cb42c96c766dcbee490ffe495e50939690a9be`
**Escopo:** uploads, PDFs, assinaturas, notificações, relatórios, UX de erro,
mobile, acessibilidade, observabilidade e concorrência.
**Produção:** não acessada nem alterada.

## Veredito

```text
PRODUCT QA WAVE 4: PASS WITH P2 FOLLOW-UP — local/source scope
P0 findings: 0
P1 findings: 0
P2 follow-ups: 1 — notification durable deduplication requires schema change
Tenant isolation: PASS — source contracts and consumer guardrails
Frontend regression: PASS — 157 suites / 890 tests / 2 declared skips
Backend regression: PASS — 314 suites / 2724 tests / 0 skips
Browser mobile regression: PASS — 24/24 with one serial worker
Production release gate: NOT CLOSED BY THIS RUN
```

Este resultado cobre a branch empilhada em relação à Wave 3 e não promove
validação de produção, deploy, migration ou runtime externo. O follow-up P2 é
uma condição de concorrência para deduplicação durável de notificações; não é
um bypass de tenant ou de autorização.

## Matriz de capacidades

| Capacidade | Estado | Evidência / limite |
|---|---|---|
| Upload | PASS | Guards JWT/tenant/role/permissão, PDF MIME + magic bytes, quarentena e inspeção fail-closed em produção |
| Download | PASS | Referências governadas, vínculo tenant/document registry, TTL curto e chave restrita a `documents/*.pdf` |
| PDF generation | PASS LIMITED | Fila, quota, tenant no payload, cleanup/timeout e testes existentes; runtime externo não foi repetido nesta Wave |
| PDF verification | PASS | Rota pública real e testes de hash; estados legados permanecem distintos de inválido |
| Signature | PASS | Contrato HMAC/keyring/versionamento da base preservado; nenhuma autoridade criptográfica foi alterada |
| Public verification | PASS | `/public/signature/verify` e tela `/verify` cobertos pelos testes de rota |
| Notifications | PASS LIMITED | Backend filtra usuário + empresa; cliente filtra tenant, deduplica realtime e cancela efeitos de tenant antigo |
| Report export | PASS | Exportações usam utilitário Excel comum com neutralização de formula/CSV injection e consultas tenant-scoped |
| Audit history | PASS LIMITED | Evidência da Wave 3 preservada; não houve auditoria modular duplicada |
| File cleanup | PASS | Compensação, contenção de path, URLs temporárias e revogação de object URLs existentes |

## Achado aberto

### W4-P2-001 — deduplicação durável de notificações não é atômica

**Estado:** OPEN FOLLOW-UP
**Arquivo:** `backend/src/modules/notifications/notifications.service.ts`
**Evidência:** `createDeduped` consulta uma notificação recente e, se não a
encontra, chama `create`; o índice existente por usuário/tipo/título/data não
é unique. Duas produtoras concorrentes podem, portanto, persistir duplicatas.
**Impacto:** duplicação de aviso e ruído operacional sob concorrência; o
escopo atual continua filtrando `company_id` e `userId`, sem evidência de
vazamento cross-tenant.
**Correção necessária:** definir identidade de dedupe estável e constraint
atômica, com migration futura e testes concorrentes.
**Schema:** `SCHEMA CHANGE REQUIRED`; nenhuma migration 0403+ foi criada.
**Decisão nesta Wave:** follow-up P2 permitido; não flexibilizar segurança nem
simular atomicidade no cliente.

## Correções aplicadas

- `useRealtimeNotifications` agora rejeita eventos sem `company_id` ou de
  tenant diferente, evita incremento duplicado entre polling/WebSocket,
  descarta respostas HTTP de tenant anterior e ressincroniza ao trocar a
  empresa selecionada.
- A marcação otimista de leitura não restaura snapshot obsoleto em caso de
  corrida; após sucesso ou erro, o estado do tenant ativo é recarregado e o
  erro é propagado ao consumidor.
- `AppNotification` transporta `company_id` para permitir a defesa em
  profundidade no cliente; a autoridade continua sendo o backend.
- Foram adicionados overrides mínimos nos manifests/lockfiles para
  `fast-uri@3.1.7`, `qs@6.16.0` e `@xmldom/xmldom@0.8.15`. Os audits de
  produção passaram sem vulnerabilidades reportadas.

Nenhuma alteração foi feita em migrations, contratos HMAC, proxy/XFF,
produção, banco, storage externo ou módulos de Wave 3.

## Cobertura de segurança e produto

- Uploads preservam autorização por tenant/role/permissão, MIME e magic
  bytes, limite de tamanho, quarentena, inspeção antivírus e compensação.
- Download não aceita chave arbitrária; referências governadas e grants
  vinculam tenant, documento e operação.
- PDFs verificam ownership/tenant no serviço e usam fila com `companyId`; o
  HTML de relatório escapa valores e o nome de arquivo é gerado no servidor.
- Assinaturas mantêm HMAC-SHA-256, comparação constant-time, keyring
  verification-only e `LEGACY_KEY_UNAVAILABLE` distinto de `INVALID`.
- Notificações HTTP usam `userId + company_id`; o gateway autentica o token.
  A deduplicação persistente é o único follow-up aberto.
- Exportações Excel passam pela neutralização de células iniciadas por
  `=`, `+`, `-`, `@`, tab, CR ou LF.
- A camada de erros preserva respostas 400/401/403/404/409/422/429/5xx,
  `Retry-After`, boundaries e mensagens de rede sem retries automáticos de
  429.
- URLs externas passam pelo allowlist/sanitização existente; não foram
  encontrados redirects abertos ou HTML arbitrário novos.
- Nenhum segredo foi adicionado a código, teste, log, imagem ou relatório.

## Validação executada

```text
Node: v24.13.0
Frontend focused tests: PASS — 2 suites / 11 tests
Backend focused tests: PASS — 2 suites / 15 tests
Frontend full Jest: PASS — 157 suites / 890 tests / 2 skips
Backend full Jest: PASS — 314 suites / 2724 tests / 0 skips
Backend type-check: PASS
Backend lint: PASS — max warnings 0
Frontend lint + permission imports + stylelint: PASS
Frontend build: PASS — Next.js production build
Backend build: PASS
Playwright mobile first run: 15 pass / 9 runner OOM failures with 8 workers
Playwright mobile serial rerun: PASS — 24/24
Mobile coverage: 320, 360, 390, 412, 430, 768, landscape 844x390, 1440
Semgrep: PASS — 74 rules / 8 files / 0 findings
Frontend production dependency audit: PASS — 0 vulnerabilities
Backend production dependency audit: PASS — 0 vulnerabilities
Excel formula/CSV injection tests: PASS — included in backend focused run
Git diff --check: PASS before final staging
```

O primeiro resultado Playwright não é promovido como falha de produto: os
workers do runner encerraram por `Zone Allocation failed - process out of
memory`; a mesma matriz passou integralmente com um worker serial. O aviso
`MaxListenersExceededWarning` do backend permanece conhecido e não foi
suprimido.

## Limites e pendências

```text
Inspections Product Contract: OPEN FOLLOW-UP — carried from Wave 3
Notification durable deduplication: OPEN P2 — SCHEMA CHANGE REQUIRED
Full axe audit in this Wave: NOT RUN — prior accessibility evidence preserved
Production runtime/Traefik: NOT RUN — out of scope and unchanged
Storage DR: OUT OF SCOPE — prior production gate remains blocked
Migrations 0385–0402: UNCHANGED
```

Não foi criado módulo de inspeções, não houve refatoração ampla, e nenhuma
alteração foi feita para esconder falha de CI ou de segurança.

## Estado final obrigatório

```text
Repository: wandersongandra/sgsseguranca
Branch: product/wave-4-cross-cutting-platform-hardening
Stacked on Wave 3 / PR #342: YES
Wave 3 base HEAD: c9cb42c96c766dcbee490ffe495e50939690a9be
Wave 4 HEAD before commit: c9cb42c96c766dcbee490ffe495e50939690a9be
Upload: PASS
Download: PASS
PDF Generation: PASS LIMITED
PDF Verification: PASS
Signature: PASS
Public Verification: PASS
Notifications: PASS LIMITED
Report Export: PASS
Audit History: PASS LIMITED
File Cleanup: PASS
Error UX: PASS
Mobile/Responsive: PASS — Playwright serial 24/24
Accessibility: PASS LIMITED — browser/static evidence; full axe not run
Observability: PASS LIMITED — no new secret/raw-body logging introduced
Idempotency/Concurrency: PASS LIMITED — durable idempotency exists; notification dedupe P2 open
Tenant Isolation: PASS
Open P0: 0
Open P1: 0
Open P2: 1
Migrations changed: NO
Production changed: NO
Production deploy: NO
Production migration: 0
Commit: PENDING FINAL REVIEW
Push: PENDING FINAL REVIEW
PR: PENDING FINAL REVIEW
Merge: NO
```

## Conclusão

A Wave 4 confirmou os contratos transversais de upload, download, PDF,
assinatura, notificações, exportação, UX e mobile na branch empilhada. A
correção de cliente evita mistura de tenants e respostas fora de ordem, e os
overrides mínimos eliminaram as vulnerabilidades de dependência observadas.
Não há P0/P1 aberto. Permanece um P2 de deduplicação atômica de notificações
que exige schema/constraint futura; migrations continuam intocadas. Este
resultado é de QA local/source e não fecha o cutover ou release de produção.

## Addendum — branch, PR e CI final

**Data:** 02/09/2026

O commit focado foi publicado na branch empilhada sobre a PR #342 e a PR #343
foi aberta contra a base `product/wave-3-operational-records-documents`. O
merge permanece explicitamente proibido nesta execução.

```text
Wave 4 implementation commit: eb4352bf06b0b4c184bb2bb31fdc9a2dd76846f4
Push: YES — product/wave-4-cross-cutting-platform-hardening
PR: #343 — https://github.com/wandersongandra/sgsseguranca/pull/343
PR state: OPEN
PR draft: NO
PR mergeable: YES
PR base: product/wave-3-operational-records-documents
Initial PR head at implementation CI verification: eb4352bf06b0b4c184bb2bb31fdc9a2dd76846f4
Documentation follow-up commit: 423c82640eab81bd0eee7c48a61ab9b25875172d
Current PR head before this wording-only update: 423c82640eab81bd0eee7c48a61ab9b25875172d
Unexpected commits: 0
CI: PASS — 9/9 reported checks passed
CI pending: 0
CI failed: 0
Required backend/frontend/E2E/DR/PostgreSQL/security checks: PASS
CodeRabbit: PASS — review skipped because reviews are disabled for this base
P0: 0
P1: 0
P2: 1 — notification durable deduplication requires future schema change
Storage DR: OUT OF SCOPE / STILL BLOCKED
Ready for Wave 4 review: YES
Ready for production: NO
Merge: NO
Production access: NO
Production changed: NO
Production migration: 0
Production deploy: NO
```

O CI verde foi confirmado no commit de implementação e novamente no HEAD
documental subsequente. O PR continua aberto para revisão; a Wave 4 está
pronta para revisão com um único follow-up P2 documentado. Migrations
0385–0402 permanecem inalteradas e nenhum gate de cutover, Storage DR ou
produção foi executado.
