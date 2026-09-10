# DDS — Final Production Acceptance

Data: 2026-08-16
Ambiente histórico: VPS isolada de testes (`APP_ENV=loadtest`)
Decisão: **NO-GO para produção**

> `HISTORICAL_EVIDENCE`: este documento registra uma execução anterior; o runtime
> autorizado atual é `HOSTINGER_CURRENT_VPS` (`PRE_PRODUCTION_QA`).

Nenhuma produção, credencial real, CPF real, assinatura real, e-mail real ou objeto real de storage foi usado. Não houve commit, push, deploy ou limpeza destrutiva do worktree.

## Atualização — Absolute Final Closure

### Addendum de evidência — 2026-08-17

O provider MinIO e o Axe autenticado permanecem `PASS runtime sintético`, conforme o addendum de runtime abaixo. Os artefatos locais identificados por Gitleaks foram movidos para quarentena recuperável e o scan atual do worktree retornou `0`. O histórico completo ainda retorna `13` findings antigos; portanto o único blocker técnico-operacional restante é a classificação e revogação/rotação formal desses históricos.

Os cinco blockers finais foram executados no ambiente sintético da VPS. O veredito continua **NO-GO**, mas os gates de E2E autenticado e PDF governado foram fechados:

| Blocker final | Estado atual | Evidência objetiva |
| --- | --- | --- |
| Secret closure | **BLOCKED** | source/tracked/diff/worktree atual: 0; histórico: 13; rotação/revogação formal não comprovada |
| Provider externo | **PASS runtime sintético** | MinIO privado na VPS: ACL, upload/download, tamper, cross-tenant, expiração e limpeza final comprovados |
| E2E autenticado DDS | **PASS** | sessão browser real: TST etapa 1 `201`, Supervisor etapa 2 `201`, Administrador etapa 3 `201`; estado final `3/3`, `auditado` |
| Accessibility/Axe | **PASS runtime sintético** | Dashboard/lista/formulário autenticados em 3 viewports: 0 `serious/critical`; teclado mobile 2/2 |

### Runtime closure update posterior

O provider externo foi então provisionado na VPS isolada com MinIO S3-compatible privado: fluxo `201/200/201`, hash/magic bytes, download autorizado `200/%PDF-`, anônimo/tamper `403`, cross-tenant `403` sem URL, expiração `200→403` e limpeza final `0` objetos. O Axe autenticado passou em Dashboard, lista DDS e formulário nos viewports `390x844`, `430x932` e `1440x900`, com `0` violações `serious/critical`; teclado mobile passou `2/2`. Portanto, provider e Axe não são mais blockers técnicos desta rodada. O `NO-GO` permanece exclusivamente pelo fechamento formal de Secrets/Gitleaks.
| PDF governado browser | **PASS** | 1 ação de emissão; nova aba `blob:` com `application/pdf`; banco confirmou `pdf_file_key`, `pdf_generated_at` e hash final |

O fixture de roles foi temporário e foi restaurado ao perfil/função originais; não houve alteração de código, migration, commit, push ou deploy nesta rodada.

## Sete gates finais

| Gate | Estado | Prova/limite |
| --- | --- | --- |
| 01. Gitleaks amplo | **BLOCKED / NO-GO** | Source/tracked/diff/worktree atuais: 0; histórico: 13. Não há segredo ativo verificado, mas a rotação/revogação externa não foi comprovada. |
| 02. Storage/provider externo | **PASS runtime sintético** | MinIO privado: grant/download `%PDF-`, anônimo/tamper `403`, cross-tenant sem URL, expiração `200→403` e limpeza final `0` objetos. |
| 03. DR com 299 migrations | **PASS** | Dump do estado 299 e restore em `sgs_loadtest_dr_20260816_299_final`: 299 migrations, 135 tabelas, 261 policies, 255 FKs, 927 índices, 7 colunas 0377, 4/4 RLS+FORCE, `sgs_app` sem bypass; dados sintéticos intactos. |
| 04. E2E autenticado DDS | **PASS runtime sintético** | Browser real concluiu criação/publicação/assinatura e as três etapas governadas: TST, Supervisor e Administrador, cada uma com HTTP `201`; estado final `3/3`, `auditado`. Mobile autenticado continua separado e não provado. |
| 05. Axe completo | **PASS runtime sintético** | Dashboard/lista/formulário autenticados em `390x844`, `430x932` e `1440x900`: 0 `serious/critical`; teclado mobile 2/2. |
| 06. RLS UPDATE/DELETE | **PASS** | No alvo DR final, role `sgs_app`, mesmo tenant, tenant cruzado e contexto ausente testados em DDS, `dds_participants` e `signatures`. SELECT/INSERT/UPDATE/DELETE: same-tenant permitido, cross/missing negado; rollback e pós-contagens `12/10/130`. |
| 07. PDF final browser | **PASS runtime sintético** | Após `auditado`, a ação oficial emitiu o PDF governado; uma nova aba `blob:` foi identificada como `application/pdf`. Pós-condições SQL confirmaram key, timestamp e hash final. |

## Controles anteriores confirmados

- Mass assignment dos campos de auditoria: corrigido e testado.
- Assinatura direta por não participante: negada server-side e testada.
- Replay sequencial/concorrente: `201/409`, com lock e estado transacional.
- Isolamento tenant/site HTTP e RLS dirigido: comprovado no ambiente sintético.
- Upload de vídeo: limite exato de 75 MiB aceito, acima rejeitado, concorrência sintética e limpeza temporária validadas; risco de materialização em `Buffer` permanece P2.
- Build/typecheck backend e frontend e testes focados DDS/PDF: passaram no baseline registrado.
- Regressão final: backend 5 suites/98 testes e frontend 5 suites/31 testes; builds backend/frontend e typechecks passaram.
- Usuário sintético remanescente: banco de teste, privilégio administrativo apenas no tenant sintético, sem acesso de produção; classificado como `POST-TEST CLEANUP`, não blocker de produção.

## Estado final obrigatório

```text
P0 OPEN: 0
P1 OPEN: 1
P2 OPEN: 4
P3 OPEN: 0

Gitleaks source: 0
Gitleaks tracked sensitive files/diff: 0
Verified active secrets: 0
Unresolved high-risk findings: YES, unknown artifacts/history

External provider: MinIO S3-compatible privado de teste
Bucket privacy: privado; prefixo isolado
Anonymous access: 403
Authorized grant: 200
Cross-tenant storage: sem emissão de URL/token
Tamper/expiration/replay: 403
Revocation: sem endpoint pré-consumo; compensação por TTL/consumo único

DR migrations: 299
DR target: sgs_loadtest_dr_20260816_299_final
Tables/policies: 135/261
FORCE RLS DDS: 4/4
Runtime role: sgs_app, BYPASSRLS=false

Real login: PASS
Authenticated DDS E2E: PASS — TST/Supervisor/Admin, 3/3, auditado
Authenticated mobile: NOT PROVED
Axe: Dashboard/list/form 0 serious/critical em 3 viewports
Keyboard/focus/dialogs: teclado mobile 2/2 PASS

RLS SELECT/INSERT/UPDATE/DELETE: PASS
RLS missing context/cross tenant: DENY
Browser PDF issue: PASS — ação governada e aba blob `application/pdf`
Browser PDF database postcondition: PASS — key/timestamp/hash final
Cross-tenant PDF: HTTP 403

Backend tests/typecheck/build: 98 / PASS / PASS
Frontend tests/typecheck/build: 31 / PASS / PASS
DDS GLOBAL SCORE: 76/100
```

## Critério de reabertura

O GO só pode ser reavaliado após: encerramento e rotação formal dos findings Gitleaks; provider externo de teste com ACL/isolation/revoke comprovados; correção e rerun do Axe sem violações serious; e, como risco separado, prova mobile autenticada se esse requisito permanecer no escopo de release.

Documentos de suporte: [dds-security-matrix.md](dds-security-matrix.md), [dds-test-evidence.md](dds-test-evidence.md), [dds-production-readiness.md](dds-production-readiness.md), [dds-storage-security.md](dds-storage-security.md), [dds-migration-forensics.md](dds-migration-forensics.md) e [dds-release-unblock-final-3.md](dds-release-unblock-final-3.md).

## Checkpoint — Release Unblock Final 3 (2026-08-17)

As correções estruturais de acessibilidade foram aplicadas em `PageHeader`, métricas semânticas e títulos client-side. O rerun Axe autenticado completo passou em 3 viewports, o provider MinIO sintético passou, o worktree atual foi zerado após quarentena recuperável e o CI/DR/E2E crítico passou. O gate histórico de Gitleaks continua `BLOCKED` pelos 13 findings sem prova formal de rotação/revogação.

Autorização final, classificação redigida dos 13 findings históricos e ações mínimas dos owners: [dds-final-release-authorization.md](dds-final-release-authorization.md).
