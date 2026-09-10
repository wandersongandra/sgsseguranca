# DDS Security Matrix

Status em 2026-08-17. `PASS` significa evidência local e/ou runtime confirmada; `PARTIAL` preserva limites de escopo, provider ou cobertura. Esta matriz é a decisão final dos sete gates de aceitação.

> `HISTORICAL_EVIDENCE`: referências à VPS isolada abaixo descrevem uma rodada
> anterior. O runtime autorizado atual é `HOSTINGER_CURRENT_VPS` (`PRE_PRODUCTION_QA`).

## Addendum runtime — VPS isolada

Nesta rodada, o provider S3-compatible de teste foi provisionado exclusivamente na VPS isolada. O fluxo governado de upload/complete, registro e download autorizado passou; ACL privada, tamper, cross-tenant e expiração provider também passaram. O Axe autenticado passou em `390x844`, `430x932` e `1440x900`, com `0` violações `serious/critical`; teclado mobile passou em `2/2`. O gate de secrets continua `BLOCKED` por findings históricos/artifacts sem rotação formal.

| Superfície | Controle observado | Evidência | Estado |
| --- | --- | --- | --- |
| Auth | `JwtAuthGuard` nas rotas autenticadas; endpoints públicos separados | API real: login 201, `/auth/me` 200, logout 201 e pós-logout 401; browser real chegou ao dashboard | PASS runtime sintético |
| Tenant | TenantGuard/interceptor + filtros `company_id` | serviços DDS/signatures; HTTP/RLS adversarial | PASS dirigido |
| Site | Scope de site aplicado em consultas e relações | `DdsService`, `SignaturesService`; `404/404` cross-site | PASS dirigido |
| RBAC | permissions de DDS, approval, audit e signatures | controllers + migrations RBAC | PASS estático |
| DTO | whitelist/forbidNonWhitelisted e remoção de audit fields | `create-dds.dto.ts`, boundary spec | PASS |
| Participants | company/site checks; PK composta na junction | `DdsService`, initial schema | PASS estático |
| Direct signature | usuário autenticado deve ser participante; uma assinatura ativa por participante/DDS | `assertDdsSignerIsParticipant`, lock DDS e replay check | PASS unit/live |
| Public invite | hash, expiração, revogação, used state, row lock e participant check | invite service | PARTIAL |
| Replacement | manager reuse, lock pessimista e versão otimista | DDS/signatures services | PASS unit |
| Workflow/immutability | publicação válida; reverse e auditoria direta inválidas; arquivamento válido | VPS live: `201/200/400/400/200` | PASS dirigido |
| RLS DDS | parent e junction policies com FORCE | alvo DR 299; role `sgs_app` sem bypass; SELECT/INSERT/UPDATE/DELETE same-tenant, cross-tenant e missing-context com rollback | PASS runtime dirigido |
| Storage/PDF | key/hash/access governados e inspeção de upload | provider MinIO privado: upload `201/200/201`, download autorizado `200/%PDF-`, anônimo/tamper `403`, cross-tenant `403`, expiração `200→403`, limpeza final `0` objetos | PASS runtime sintético; staging definitivo ainda depende do provider escolhido |
| XSS/PDF visual | sanitização/testes; stress e render local sem páginas vazias | [PDF visual QA](dds-pdf-visual-qa.md) | PASS local/PARTIAL browser |
| Video upload | Multer disk-first, limite inclusivo de 75 MiB, rejeição acima e limpeza temp | VPS: exato 201, +1 413, 2x10 MiB 201, temp 0; unit 8/8 | PASS sintético; memória P2 |
| Rate limiting | throttles e Redis compartilhado | Redis live: `401 x5`, `429 x2`; carga autenticada | PASS runtime |
| Gitleaks | source, tracked examples/diff, worktree e histórico | source 0; tracked sensíveis/diff 0; worktree atual 0 após quarentena recuperável; histórico 13; sem valores expostos | BLOCKED: históricos aguardam rotação/revogação formal |
| Audit/forensic | forensic trail e approval events | services DDS/signatures | PARTIAL |
| Migration provenance | fonte local reconciliada com artefato remoto e rebuild oficial | [migration forensics](dds-migration-forensics.md) | PASS rebuild 299 |
| Frontend E2E/mobile | golden DDS autenticado, assinatura UI, approval e teclado mobile | login real; TST/Supervisor/Admin aprovaram 3 etapas; Axe `3/3` viewports; teclado `2/2` | PASS runtime sintético |
| Accessibility/Axe | matriz browser autenticada | Dashboard/lista/formulário em `390x844`, `430x932`, `1440x900`; `0` serious/critical; `Sidebar` corrigida | PASS runtime sintético |
| DR | dump/restore em banco temporário isolado | `sgs_loadtest_dr_20260816_299_final`: dump/restore do estado 299, 135 tabelas, 261 policies, 255 FKs, 927 índices, 7 colunas 0377, 4/4 RLS+FORCE | PASS |

## Threat-oriented decisions

- Cross-tenant HTTP próprio/cross-tenant retornou `200/403`; cross-site com usuário site-only retornou `404`.
- Mass assignment dos metadados de auditoria foi corrigido e testado.
- Assinatura direta por não participante foi corrigida no limite server-side e testada.
- Replay direto foi fechado com lock pessimista no DDS: sequência `201/409` e concorrência `201/409`.
- O conjunto oficial atual tem 299 migrations: 0374/0375/0376 reconciliadas byte a byte com a VPS e a migration EPI foi renumerada para 0377 forward-only.
- Nenhum dado, token, assinatura ou objeto de storage real foi usado. O provider externo e Axe passaram no alvo isolado; o workflow autenticado de três perfis e o PDF final governado browser passaram; DR 299 e RLS mutável foram provados no alvo isolado. Secrets continuam bloqueados.

## Live test VPS evidence — 2026-08-16

Ambiente confirmado por SSH/read-only: `APP_ENV=loadtest`, `sgs_app` sem `BYPASSRLS`, Postgres/Redis/API healthy, banco e Redis sem portas públicas.

| Caso | Resultado |
| --- | --- |
| RLS forensic role/context/missing tenant | PASS |
| DDS tenant A SELECT vs tenant B | PASS: A viu o DDS sintético; B retornou zero |
| GET DDS no próprio tenant | HTTP 200 |
| GET DDS cross-tenant | HTTP 403 |
| PDF cross-tenant | HTTP 403 |
| Generic PATCH com `notas_auditoria` | HTTP 400 — PASS após DTO hardening |
| `POST /signatures` por não participante | HTTP 403 — PASS após boundary server-side |
| Replay sequencial do mesmo participante | HTTP `201/409` — PASS |
| Replay concorrente do mesmo participante | HTTP `201/409` — PASS; uma única assinatura criada |
| Usuário site-only contra DDS de outro site | HTTP `404/404` em GET/assinatura — PASS deny |
| Login inválido via Redis | `401 x5`, depois `429 x2` — PASS |
| Carga read-only autenticada | 100 requests/20 concorrentes: 80x `200`, 20x `429`, p95 290 ms |
| DR sintético 299 final | alvo `sgs_loadtest_dr_20260816_299_final`: dump/restore do estado 299; 12 DDS, 10 participantes, 130 assinaturas e 1229 eventos forensic; role app sem bypass — PASS |
| Golden DDS estrutural | 30 participantes, PDF 383 KB, header `%PDF-` — PASS estrutural |
| Golden/stress PDF visual | 5/30/100/300 participantes; 61 páginas renderizadas, 0 vazias — PASS local |
| Frontend mobile público | 18/18 em iPhone SE, mobiles, tablet e landscape — PASS |
| Migration clean rebuild | banco vazio `sgs_loadtest_rebuild_20260816_299`: 299 migrations, 135 tabelas, 261 policies, 4 tabelas DDS com FORCE — PASS |
| Storage | provider MinIO privado: upload `201/200/201`, autorizado `200 %PDF-`, anônimo/tamper `403`, cross-tenant `403` sem URL, expiração `200→403`, limpeza final `0` objetos — PASS runtime sintético |
| Video upload | exato 75 MiB `201`, 75 MiB+1 `413`, concorrente 2x10 MiB `201`, temp `0` — PASS sintético; Buffer P2 |
| Frontend DDS autenticado | login real, dashboard, criação/publicação, assinatura e aprovação TST/Supervisor/Admin; HTTP 201 em cada etapa, `3/3`, `auditado`; Axe `3/3` viewports e teclado mobile `2/2` — PASS workflow |
| Browser PDF final | ação oficial emitiu PDF governado; aba `blob:` `application/pdf`; `pdf_file_key`, `pdf_generated_at` e hash final presentes — PASS |
| Gitleaks | source 0; tracked sensíveis/diff 0; worktree atual 0 após quarentena; histórico 13; sem segredo ativo verificado, mas rotação externa não comprovada — NO-GO ativo |

Conclusão: os hardenings P1, o rebuild/DR reconciliado com 299 migrations, a matriz RLS mutável, storage externo sintético, vídeo, o workflow browser autenticado de três perfis, o PDF governado e o Axe autenticado passaram. O release permanece `NO-GO` exclusivamente por findings Gitleaks/artifacts/histórico sem classificação e rotação formal.

Checkpoint Final 3: [dds-release-unblock-final-3.md](dds-release-unblock-final-3.md). O score foi recalculado independentemente em 76/100; não há certificação GO.

Autorização final dos três gates, classificação redigida e provas mínimas: [dds-final-release-authorization.md](dds-final-release-authorization.md). Veredito permanece `NO-GO`.

## Addendum de correção DDS — VPS de teste — 2026-08-21

O fluxo público de validação DDS foi corrigido e revalidado somente na VPS isolada: o lookup do `document_registry` e o `forensic_trail_events` agora executam sob contexto explícito do `company_id`. O smoke runtime confirmou `valid=true`, rejeição de token inválido, rejeição cross-tenant, storage `ready` e persistência de três traces forenses. As suítes `public-dds-validation.controller.spec.ts` e `document-registry.service.spec.ts` passaram com `14/14` testes. O veredito de produção continua `NO-GO` enquanto secrets/Gitleaks não tiverem classificação e rotação formais.
