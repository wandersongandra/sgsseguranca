# DDS Test Evidence

Data: 2026-08-17. Fixtures sintéticas; nenhum dado ou segredo real foi usado.

> `HISTORICAL_EVIDENCE`: esta evidência registra execuções anteriores em ambiente
> isolado. O runtime autorizado atual é `HOSTINGER_CURRENT_VPS` (`PRE_PRODUCTION_QA`).

## Passing evidence

| Escopo | Resultado |
| --- | --- |
| Backend DDS/signatures/DTO focused | 3 suites, 84 testes PASS |
| Frontend DDS/PDF focused | baseline 4 suites/25 PASS; current 5-suite regression slice 17 PASS, inclui Golden DDS |
| Final focused regression | PASS: backend 5 suites/98 testes; frontend 5 suites/31 testes |
| Frontend Playwright mobile público | 18/18 PASS em 6 viewports; login, recuperação e redirect |
| Backend `npm run type-check` | PASS |
| Backend `npm run build` | PASS |
| Frontend `npx tsc --noEmit` | PASS |
| Frontend `npm run build` | PASS; Next gerou 91 páginas estáticas |
| Focused backend ESLint | 0 errors, 1 warning em mock de teste |
| Backend migration check | PASS; 299 migrations oficiais no worktree reconciliado |
| Migration clean rebuild | PASS: banco vazio com 299 migrations, 135 tabelas, 261 policies e 4 tabelas DDS com FORCE RLS |
| DR restore bundle 299 | PASS: alvo `sgs_loadtest_dr_20260816_299_final`, dump/restore do estado 299, 135 tabelas, 261 policies, 255 FKs, 927 índices e `sgs_app` sem bypass RLS |
| Authenticated API/browser DDS | PASS crítico: login API 201, `/auth/me` 200, logout/pós-logout 201/401; browser real criou, publicou e assinou DDS sintético |
| Authenticated approval workflow | PASS runtime: TST, Supervisor e Administrador aprovaram etapas 1/2/3 com HTTP 201; estado final `3/3` e `auditado` |
| Governed PDF browser | PASS runtime: ação oficial emitiu uma aba `blob:` reconhecida como `application/pdf`; pós-condições SQL de key/timestamp/hash confirmadas |
| Axe authenticated matrix | PASS runtime sintético: Dashboard/lista/formulário em `390x844`, `430x932` e `1440x900`, 0 `serious/critical`; teclado mobile 2/2 |
| Gitleaks tracked scope | PASS limitado: source 0; arquivos tracked `.env*.example` 0; `gitleaks protect` no diff 0; worktree atual 0 após quarentena; histórico 13 |
| OSV backend/frontend lockfiles | nenhum issue reportado |
| Trivy backend/frontend lockfiles | 0 vulnerabilidades reportadas |

## Remaining gates

| Prova obrigatória | Resultado | Motivo |
| --- | --- | --- |
| Integration/E2E local | BLOCKED | Docker não está disponível localmente; matriz HTTP dirigida foi executada na VPS |
| Frontend E2E/mobile/accessibility | PASS workflow/runtime sintético | browser real cobriu login, criação, publicação, assinatura e aprovação TST/Supervisor/Admin; Axe autenticado 3/3 viewports sem serious/critical; teclado 2/2 |
| Postgres RLS adversarial | PASS | same-tenant/cross-tenant/missing-context em SELECT, INSERT, UPDATE e DELETE para DDS/participants/signatures; mutações em rollback; pós-contagens preservadas |
| Redis/rate-limit | PASS | `401 x5` seguido de `429 x2` em login sintético |
| Load/performance | PASS parcial | 100 GET autenticados/20 concorrentes: 80x `200`, 20x `429`, p95 290 ms |
| Migration status/rebuild | PASS rebuild/DR 299 | 0374/0375/0376 reconciliadas por hash; EPI forward-only 0377; dump/restore do estado 299 validado em alvo novo |
| DR restore | PASS sintético | dump do estado 299 e restore em `sgs_loadtest_dr_20260816_299_final`; role app sem bypass, dados/schema/RLS validados; storage externo não usado |
| Golden DDS estrutural | PASS | gerador real, 30 participantes, PDF 383 KB e header PDF válido |
| Golden DDS visual | PASS local; PASS browser governado | 5/30/100/300 participantes, 61 páginas renderizadas, 0 páginas vazias; emissão oficial browser abriu `blob:` `application/pdf` e banco confirmou key/timestamp/hash |
| HTTP cross-tenant/site | PASS dirigido | `200/403` cross-tenant; usuário site-only `404/404` cross-site |
| Storage/ACL | PASS runtime sintético | MinIO privado: upload `201/200/201`, download autorizado `%PDF-`, anônimo/tamper `403`, cross-tenant sem URL, expiração `200→403`, limpeza `0` objetos |
| Video upload stress | PASS sintético/PARTIAL memória | exato 75 MiB `201`, +1 `413`, 2x10 MiB concorrentes `201`, temp `0`; controller ainda materializa Buffer |
| Gitleaks | BLOCKED/NO-GO | source/tracked/diff/worktree atuais 0; histórico 13 em commits antigos; rotação/revogação externa ainda não foi comprovada |

## Live test VPS evidence — 2026-08-16

Ambiente isolado confirmado: API, Postgres e Redis healthy; `APP_ENV=loadtest`; `sgs_app` com `rolbypassrls=false`.

| Caso | Resultado |
| --- | --- |
| Forensic RLS/context/missing tenant/login event | PASS |
| DDS synthetic create | HTTP 201 |
| Own DDS GET | HTTP 200 |
| Cross-tenant DDS GET | HTTP 403 |
| Cross-tenant PDF | HTTP 403 |
| Generic audit mass assignment | HTTP 400 — PASS na imagem endurecida |
| Nonparticipant direct signature | HTTP 403 — PASS na imagem endurecida |
| Direct signature replay sequential/concurrent | `201/409` em ambos — PASS |
| Cross-site site-only GET/signature | `404/404` — PASS deny |
| Redis login throttle | `401 x5`, `429 x2` — PASS |
| DR synthetic restore | PASS atual; dump/restore do estado 299 em alvo final, 12 DDS, 10 participants, 130 signatures, 1229 forensic events |
| Browser real auth DDS | PASS workflow | login real, dashboard, create, publish, assinatura e aprovação TST/Supervisor/Admin; 3 etapas HTTP 201, estado `auditado`; mobile autenticado não provado |
| Browser PDF final | PASS governado | emissão oficial; aba `blob:` `application/pdf`; pós-condições SQL key/timestamp/hash |
| Synthetic cleanup | signature HTTP 200; DDS soft-delete HTTP 200 |

Os dois failures da primeira rodada foram reproduzidos como regressão do runtime antigo. Após o rebuild controlado, ambos passaram; a prova live atual não usa produção, dados reais, tokens reais ou storage real. O fixture temporário de roles/CPF foi restaurado ao estado original.

## Final release authorization — 2026-08-17

O veredito binário permanece **NO-GO** exclusivamente pelo gate histórico de secrets. O scan Git/history redigido encontrou 13 findings históricos (6 `curl-auth-header`, 4 `generic-api-key`, 3 `jwt`); source atual, exemplos tracked, diff/protect e worktree após quarentena permaneceram em 0. Provider MinIO e Axe autenticado passaram no ambiente isolado; a rotação/revogação externa dos históricos ainda não foi comprovada.

Classificação, owners e provas mínimas estão em [dds-final-release-authorization.md](dds-final-release-authorization.md).

Regressão frontend final desta rodada: `154` suítes executadas, `872` testes PASS, `2` testes skipped e `1` suíte skipped; nenhum failure. O security smoke delta e o Axe autenticado final não foram executados até o fim porque dependem dos blockers externos/fixture.

## Regra de regressão

Os testes verdes e a VPS fecham os casos executados. Permanecem bloqueados a ACL de provider externo, a correção das violações Axe e os findings Gitleaks em artifacts/env/histórico. O workflow autenticado de três perfis e o PDF final governado browser passaram; o DR 299 e a matriz RLS mutável foram executados no alvo isolado.

## Runtime closure addendum — provider e Axe

Evidência posterior executada na VPS isolada: provider MinIO S3-compatible privado passou `presigned 201 → PUT 200 → complete 201`, hash/magic bytes, download autorizado `200/%PDF-`, anônimo `403`, tamper `403`, cross-tenant `403` sem URL e expiração provider `200→403`. O bucket de teste foi limpo ao final (`0` objetos).

A suíte Axe autenticada foi criada em `frontend/e2e/dds-axe-authenticated.spec.ts` e passou em `3/3` viewports (`390x844`, `430x932`, `1440x900`) com `0` violações `serious/critical` em Dashboard, lista DDS e formulário. A suíte de teclado mobile passou `2/2`. O achado desktop de contraste no nome do usuário foi corrigido em `frontend/src/components/Sidebar.tsx`.

O veredito global continua `NO-GO` exclusivamente pelo gate Gitleaks/secrets: source, `ops/test` e worktree atual estão sem findings na varredura redigida desta rodada; os `13` históricos ainda exigem classificação, rotação/revogação formal e scan history final.

## Runtime correction closure — VPS de teste — 2026-08-21

Esta rodada foi executada exclusivamente em `APP_ENV=loadtest`, na VPS isolada. Nenhuma API, banco, storage ou deploy de produção foi alterado.

| Evidência | Resultado |
| --- | --- |
| Correção do lookup público do registry | PASS: `DocumentRegistryService.validatePublicCode` executa sob contexto explícito do tenant |
| Correção do trace forense público | PASS: controller mantém validação e `PUBLIC_VALIDATION_ATTEMPT` no mesmo contexto do tenant |
| Build da API de teste | PASS: `docker build` compilou TypeScript e recriou `sgs-loadtest-api-loadtest-1` |
| Smoke DDS governado | PASS: DDS `auditado`, registry `ACTIVE`, hash/PDF presentes, storage `ready`, PDF HTTP 200 |
| Validação pública DDS | PASS: HTTP 200 e `valid=true` para código + token sintéticos |
| Token público inválido | PASS: endpoint não aceitou token inválido (`valid` não verdadeiro) |
| Leitura cross-tenant | PASS: leitura do DDS com tenant sintético diferente foi rejeitada |
| Forensic trail | PASS: 3 traces `PUBLIC_VALIDATION_ATTEMPT` encontrados para o código sintético |
| Testes unitários na VPS | PASS: 2 suítes, 14 testes |
| Saúde após execução | PASS: API HTTP 200; API/Postgres/Redis healthy |

Os identificadores e tokens foram mascarados ou omitidos. O relatório não constitui autorização de produção: o gate histórico de secrets/Gitleaks permanece pendente de classificação, rotação/revogação formal e novo scan de history.
