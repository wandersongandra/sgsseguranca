# DDS — FINAL PRODUCTION READINESS REPORT

Data: 2026-08-16
Escopo: DDS, assinaturas, aprovação, PDF/storage, tenancy/site, RBAC, migrations e superfícies compartilhadas diretamente consumidas pelo módulo.
Método: inventário repo-backed, código/migrations, testes focados, typecheck, build, lint e scans locais. Sem produção, dados reais ou segredos.

> `HISTORICAL_EVIDENCE`: referências à VPS isolada abaixo descrevem uma rodada
> anterior. O runtime autorizado atual é `HOSTINGER_CURRENT_VPS` (`PRE_PRODUCTION_QA`).

## 1. Executive Summary

### Addendum de fechamento — 2026-08-17

O worktree atual está com `0` findings Gitleaks após a quarentena recuperável de `.env` locais, logs, cache/build e artefatos Vercel/Puppeteer. Provider MinIO e Axe autenticado já passaram no ambiente isolado; backend, frontend, DR, E2E crítico e scans CI também passaram no PR #284. O relatório continua `NO-GO` exclusivamente porque o histórico completo mantém 13 findings antigos sem prova externa de revogação/rotação.

O DDS possui implementação ampla de tenant/site scope, workflow, aprovação, assinatura, storage governado, auditoria e PDF.
No worktree local foram corrigidos três limites: mass assignment de auditoria, race entre lock do DDS e replacement de assinaturas, e assinatura direta por não participante.
Backend/frontend compilam e os testes focados DDS/PDF/assinaturas passaram.
O workflow real é `RASCUNHO → PUBLICADO → AUDITADO → ARQUIVADO`, com arquivamento conforme as transições permitidas.
O VPS isolado de teste foi usado com API/Postgres/Redis saudáveis. Após rebuild controlado, mass assignment, BOLA de assinatura, cross-site, replay sequencial/concorrente, rate limit e DR sintético passaram live.
O release ainda não está pronto para produção: o conjunto reconciliado de 299 migrations passou no rebuild limpo e no restore de um dump 299 em alvo descartável. A autenticação real de teste, o fluxo browser de criação/publicação/assinatura, as três aprovações governadas, o provider MinIO sintético, o Axe autenticado e o PDF final browser passaram. O único blocker desta rodada é a rotação/revogação formal dos 13 findings históricos de secrets.
Dependências não apresentaram vulnerabilidades nos lockfiles. Gitleaks está em 0 no código-fonte, diff e worktree atual após quarentena recuperável; permanecem 13 ocorrências históricas triadas, não aprovadas.

## 2. Final Verdict

**DDS PRODUCTION READINESS: NO-GO — gates 01, 02 e 05 bloqueados; gates 03, 04, 06 e 07 passaram**

O bloqueio restante é de completude operacional: não há aprovação de provider externo, Axe sem violações ou encerramento dos findings Gitleaks em artifacts/env/histórico. O DR 299, a matriz RLS mutável, o workflow autenticado de três perfis e o PDF final governado passaram no alvo isolado.

### Decisão dos sete gates finais

| Gate | Estado | Evidência objetiva |
| --- | --- | --- |
| 01. Gitleaks amplo | BLOCKED/NO-GO | source/tracked/diff/worktree atuais 0 após quarentena recuperável; 13 findings históricos; verified active 0, mas rotação/revogação não comprovada |
| 02. Storage/provider externo | PASS runtime sintético | MinIO privado na VPS: upload/download, ACL, tamper, cross-tenant, expiração e limpeza final comprovados; staging definitivo pode exigir repetição |
| 03. DR migrations 299 | PASS | dump do estado 299 restaurado em `sgs_loadtest_dr_20260816_299_final`; schema/RLS/data e role app validados |
| 04. E2E autenticado | PASS runtime sintético | login real, create/publish/signature e três approvals governadas: TST/Supervisor/Admin, HTTP 201, estado `3/3`/`auditado`; mobile autenticado separado não provado |
| 05. Axe completo | PASS runtime sintético | Dashboard/lista/formulário autenticados em 3 viewports: 0 `serious/critical`; teclado mobile 2/2 |
| 06. RLS UPDATE/DELETE | PASS | alvo DR final; same/cross/missing em DDS, participants e signatures; INSERT também validado; rollback e pós-contagens preservados |
| 07. PDF browser final | PASS runtime sintético | ação oficial emitiu PDF governado; aba `blob:` `application/pdf`; key/timestamp/hash final confirmados no banco |

## 3. As-is e workflow real

```text
Next.js/React → ddsService/DdsForm/approval/invite/PDF
  → NestJS guards/controllers
  → DdsService/Approval/Signatures/Governance
  → TypeORM/PostgreSQL + RLS + dds_participants
  → S3-compatible storage + Redis/throttling + forensic trail
  → PDF final governado + hash/token de validação
```

Estados confirmados em `backend/src/modules/dds/entities/dds.entity.ts:30-34`:

```text
RASCUNHO → PUBLICADO → AUDITADO → ARQUIVADO
RASCUNHO → ARQUIVADO
PUBLICADO → AUDITADO ocorre pelo fluxo de aprovação; o endpoint genérico de status não permite esse salto. AUDITADO só arquiva; ARQUIVADO é terminal.
```

Não existem estados `scheduled`, `in_progress` ou `completed` no domínio atual. Emissão do PDF exige auditoria, aprovação concluída e assinaturas dos participantes.

## 4. Scorecard

| Área | Nota | Status |
| --- | ---: | --- |
| Arquitetura | 7/10 | PARTIAL |
| Backend | 8/10 | PASS estático |
| Frontend | 7/10 | build/typecheck PASS; runtime não provado |
| Banco | 8/10 | PASS runtime no rebuild/DR 299 |
| Multi-Tenancy | 9/10 | PASS dirigido HTTP/RLS; browser workflow limitado por perfis |
| RLS | 9/10 | PASS em SELECT/INSERT/UPDATE/DELETE com rollback |
| RBAC | 8/10 | PASS deny live; workflow multi-perfil ainda não executado |
| Assinaturas | 8/10 | replay/BOLA/concurrency dirigidos PASS |
| Integridade documental | 6/10 | PARTIAL |
| PDF | 7/10 | generator, stress e QA visual local PASS; emissão/download browser pendente |
| Segurança | 7/10 | source PASS; artifacts TRIAGED |
| UX | 6/10 | PARTIAL |
| Mobile | 7/10 | E2E público 18/18; golden DDS e teclado 390x844 sintéticos PASS |
| Performance | 4/10 | loadtest bloqueado |
| Observabilidade | 6/10 | PARTIAL |
| Testes | 8/10 | unit/build, E2E público e fluxo DDS autenticado crítico verdes |
| Production Readiness | 5/10 | NO-GO por gates residuais |

# DDS GLOBAL SCORE: 76/100

Nota conservadora limitada pela ausência de evidência executada nos gates críticos.

## 5. Findings

### P0

Nenhum P0 confirmado no código auditado.

### P1

| ID | Finding | Impacto | Correção/evidência | Status |
| --- | --- | --- | --- | --- |
| DDS-AUTH-001 | DTO genérico aceitava `auditado_por_id`, data, resultado e notas, apesar do fluxo de auditoria dedicado. | Colaborador podia tentar alterar metadados protegidos via PATCH/create. | Campos removidos dos DTOs genéricos; boundary spec; VPS retornou HTTP 400. | FIXED + LIVE PASS |
| DDS-SIG-RACE-001 | Lock do DDS ficava em transação diferente do delete+insert de assinaturas. | Lost update/replacement concorrente de evidências. | Manager propagado; lock pessimista, workflow e version check aplicados. | FIXED; unit PASS |
| DDS-SIG-BOLA-001 | `POST /signatures` aceitava DDS sem confirmar que o usuário era participante. | Evidência de presença podia ser criada por não participante. | Consulta parametrizada `dds_participants` + tenant; VPS retornou HTTP 403. | FIXED + LIVE PASS |
| DDS-SIG-REPLAY-001 | Endpoint direto aceitava duas assinaturas ativas para o mesmo participante/DDS. | Duplicação de evidência e possível corrupção de presença. | Lock pessimista no DDS + consulta de assinatura ativa; sequencial e concorrente retornaram `201/409`. | FIXED + LIVE PASS |
| DDS-SEC-001 | Gitleaks encontra 13 findings no histórico; o worktree atual foi zerado após quarentena recuperável. | Não há segredo ativo verificado, mas findings históricos plausíveis sem rotação/revogação comprovada podem representar exposição de credenciais. | Security owner deve classificar os 13 históricos, revogar/rotacionar qualquer credencial afetada e fechar evidência. | OPEN/P1 |

### P2

| ID | Finding | Impacto | Próximo passo | Status |
| --- | --- | --- | --- | --- |
| DDS-DOS-001 | Vídeo é recebido em disco, mas até 75 MiB é materializado em `Buffer` antes do storage. | Pressão de heap/DoS lógico sob concorrência. | Limite inclusivo, exato `201`, acima `413`, 2x10 MiB concorrentes e temp 0; avaliar streaming/chunking. | OPEN/P2 |
| DDS-PDF-001 | Golden/stress DDS, emissão governada browser e provider MinIO sintético foram cobertos após workflow TST/Supervisor/Admin. | Repetição no provider definitivo de staging pode permanecer necessária conforme o release. | Repetir no staging definitivo se o provider diferir da VPS isolada. | PASS sintético / P2 residual |
| DDS-ENV-DRIFT-001 | Artefato remoto e worktree divergiam em migrations. | Proveniência do runtime não era atribuível. | 0374/0375/0376 reconciliadas por SHA; EPI virou 0377; rebuild e DR isolado com 299. | CLOSED technical |
| DDS-STORAGE-001 | Provider MinIO externo sintético configurado e testado com bucket privado. | Repetição no provider definitivo de staging pode permanecer necessária. | Repetir somente se o provider/ambiente de release diferir. | PASS sintético / P2 residual |
| DDS-A11Y-001 | Axe autenticado em 3 viewports retornou 0 `serious/critical`; teclado mobile 2/2. | Não substitui repetição após mudanças futuras de tema/layout. | Manter a suíte no CI e rerodar no staging quando aplicável. | PASS runtime sintético |

### P3

Nenhum P3 aberto confirmado.

## 6. Changes Applied

- `backend/src/modules/dds/dto/create-dds.dto.ts`: removidos campos de auditoria dos writes genéricos.
- `backend/src/modules/dds/dds.service.ts:1120-1145`: lock retorna DDS, valida workflow/versão e passa manager ao replacement.
- `backend/src/modules/signatures/signatures.service.ts:230-290`: replacement reutiliza `EntityManager`, sem transação aninhada.
- `backend/src/modules/signatures/signatures.service.ts:178-188,1197-1221`: assinatura direta DDS exige participante do mesmo tenant.
- `backend/src/modules/signatures/signatures.service.ts:190-235`: assinatura direta DDS bloqueia a linha do documento e rejeita assinatura ativa duplicada com `ConflictException`.
- `backend/src/shared/interceptors/file-upload.interceptor.ts`: `GOVERNED_VIDEO_MAX_FILE_SIZE_BYTES` único, disk-first e limite padrão de 75 MiB.
- `backend/src/modules/dds/dds.controller.ts`: validação de vídeo usa o mesmo limite do interceptor; não há mais divergência de 500 MB.
- `frontend/app/(auth)/login/login.module.css`, `frontend/app/(auth)/auth.module.css`, `frontend/proxy.ts`: correção de zoom mobile e `upgrade-insecure-requests` somente em produção.
- `frontend/e2e/public-mobile.spec.ts`, `frontend/e2e/helpers/mobile.ts`: fluxo público Playwright validado em seis viewports.
- `frontend/src/services/ddsService.ts:297-314`: mutation input restrito a campos operacionais; `company_id` só deriva header e não vai no body.
- `backend/src/modules/dds/dto/dds-write-boundary.spec.ts`, `signatures.service.spec.ts` e `frontend/src/lib/pdf/ddsGenerator.golden.test.ts`: cobertura dos limites e Golden PDF com 30 participantes.

Nenhuma migration foi necessária para as correções. A junction já tem RLS com `ENABLE/FORCE` e policy por relação ao DDS pai em `1709000000106-rls-junction-tables-and-apr-children.ts:71-98`.

## 7. Test Evidence

| Gate | Resultado real |
| --- | --- |
| Backend DDS/signatures/DTO focused | 3 suites, 84 passed, 0 failed |
| Frontend DDS/PDF focused | baseline 4 suites/25 PASS; current 5-suite regression slice 17 passed; Golden/stress 5/30/100/300 participantes |
| Final focused regression | PASS: backend 5 suites/98 testes; frontend 5 suites/31 testes |
| Frontend Playwright mobile público | PASS: 18/18 em 6 viewports |
| Backend type-check/build | PASS/PASS |
| Frontend TypeScript/build | PASS/PASS; 91 páginas estáticas geradas |
| Focused backend ESLint | 0 errors, 1 warning em mock de teste |
| Migration check local | PASS, 299 migrations oficiais reconciliadas |
| Migration status/rebuild live | PASS: rebuild e dump/restore com 299 migrations, 135 tabelas, 261 policies; app role validada |
| OSV lockfiles | PASS, nenhum issue reportado |
| Trivy lockfiles | PASS, 0 vulnerabilidades reportadas |
| Integration/E2E local | BLOCKED: Docker não é reconhecido; HTTP adversarial e browser sintético passaram na VPS |
| RLS adversarial | PASS: alvo DR final; SELECT/INSERT/UPDATE/DELETE em same/cross/missing para DDS/participants/signatures, com rollback |
| Redis/load/performance | PASS parcial: Redis limitou `401 x5`/`429 x2`; carga 100/20 com p95 290 ms e 20 throttles |
| PDF Golden estrutural/visual | PASS local; browser preview abriu blob, PDF final governado pendente por aprovação/RBAC |
| Storage ACL | PASS runtime sintético: MinIO privado com grant/expiry/tamper/replay/cross-tenant |
| Video upload | PASS sintético: exato 75 MiB, +1 rejeitado, 2x10 MiB concorrentes e temp 0; Buffer P2 |
| DR | PASS: dump do estado 299 e restore em `sgs_loadtest_dr_20260816_299_final`, dados e RLS validados |
| Gitleaks | BLOCKED/NO-GO: source/tracked/diff/worktree atuais 0 após quarentena recuperável; 13 no histórico, high-risk unknown sem prova de rotação |

## 8. HTTP / database / security proof

### HTTP proof

Executado no VPS isolado com DDS e usuários sintéticos. GET próprio/cross-tenant retornou `200/403`; PDF cross-tenant `403`; mass assignment `400`; assinatura por não participante `403`. Usuário site-only contra outro site retornou `404` em GET e assinatura. Replay direto sequencial e concorrente retornou `201/409`. Workflow retornou `201/200/400/400/200` para create/publish/reverse/direct-audit/archive. Playwright público local retornou 18/18 nos seis viewports configurados.

Pendente: fechamento formal dos findings históricos de secrets. O fluxo TST/Supervisor/Admin, o E2E browser do PDF final, provider MinIO e Axe autenticado foram concluídos no ambiente sintético.

### Database proof

Confirmados no código: FKs, PK composta da junction, índices tenant/created, `@VersionColumn`, soft delete e migrations de RLS/approval/signature.

Confirmados live: papel `sgs_app` com `rolbypassrls=false`, insert/select/update/delete no tenant A, negação do tenant B e missing context, SELECT/INSERT/UPDATE/DELETE em DDS/participants/signatures, concorrência de assinatura direta, rebuild/DR com 299 migrations, 135 tabelas e 261 policies; as quatro tabelas DDS críticas têm FORCE RLS.

### Security proof

Confirmados por código/testes/live: DTO allowlist, ValidationPipe global com whitelist/forbidNonWhitelisted, filtros tenant/site, relation checks, assinatura direta limitada ao participante, replay sequencial/concorrente protegido, invite lock/state e replacement atomicamente protegido.

Não confirmados: BOLA completo além da matriz dirigida, revogação pré-consumo e rotação externa dos históricos de secrets. O scan direcionado de source, worktree e diff não encontrou findings; o histórico completo continua com 13 achados redigidos.

## 9. Performance e PDF

Uma carga read-only autenticada de 100 requests/20 concorrentes teve 80 respostas `200`, 20 `429`, p50 141,7 ms, p95 290 ms e p99 350 ms; os `429` são throttling esperado. O upload de vídeo tem limite inclusivo de 75 MiB, gravação em disco, fronteira exata `201`, acima `413`, concorrência 2x10 MiB `201` e temp `0`; `readUploadedFileBuffer` ainda materializa o arquivo em memória.

Engine PDF identificado: frontend `jsPDF` + blueprint DDS + QR/validation/signature blocks. Os cenários de 5/30/100/300 participantes geraram PDFs válidos e 61 páginas foram renderizadas/revisadas sem páginas vazias, clipping aparente ou sobreposição. O browser real concluiu o approval gate e emitiu o PDF final governado em aba `blob:` `application/pdf`; a persistência confirmou key, timestamp e hash.

## 10. Riscos residuais e próximos gates

 - Provider MinIO/ACL e Axe autenticado passaram; a VPS também provou DR 299, vídeo, RLS mutável cross-tenant, o E2E autenticado de três perfis e o PDF governado browser.
- A primeira imagem do runtime estava defasada, mas o rebuild controlado atual passou mass assignment, BOLA, replay e concorrência.
- DR sintético passou com as 299 migrations reconciliadas e a role de aplicação sem bypass RLS.
 - PDF estrutural/visual local e PDF final governado browser passaram; Axe autenticado passou em 3 viewports.
 - Dependências passaram; Gitleaks está limpo no source, diff e worktree atual, mas há 13 findings históricos sem rotação/revogação comprovada.
- Não houve produção, tokens, storage ou dados reais.

Antes do GO: fechar/rotacionar formalmente os 13 findings históricos de secrets. Os perfis sintéticos TST/Supervisor/Admin, provider MinIO e Axe sem serious/critical já foram provados.

## 11. Top 10 melhorias futuras

### REQUIRED

1. Alinhar SHA/migration bundle do runtime com o worktree auditado e repetir os fluxos no banco limpo.
2. Manter teste server-side de não participante e replay concorrente no endpoint genérico.
3. Automatizar a matriz HTTP de tenant/site no CI.
4. Executar stress autenticado de vídeo e avaliar streaming/chunking.

### RECOMMENDED

5. Automatizar Golden DDS visual no CI.
6. Adicionar matriz HTTP de site/tenant scope.
7. Adicionar p95 de PDF/upload e alertas de fila/storage.
8. Formalizar reabertura/versionamento pós-PDF.

### OPTIONAL

9. Expandir UX mobile/offline com browser real.
10. Consolidar documentação de workflow/threat model após os gates.

# 🔴 DDS — PRODUCTION READINESS BLOCKED

P0 OPEN: 0
P1 OPEN: 1
P2 OPEN: 4
P3 OPEN: 0

Critical E2E: PARTIAL; targeted runtime PASS
Adversarial E2E: PARTIAL; targeted runtime PASS
Cross-Tenant: PASS dirigido
Cross-Site: PASS dirigido
RLS: PASS parcial
Signature Integrity: PASS para BOLA/replay direto; invite completo pendente
Document Integrity: PASS application-level; provider externo pendente
Migration Rebuild: PASS técnico/DR 299
DR: PASS sintético
PDF Runtime: PASS estrutural/stress
PDF Visual QA: PASS local; emissão/download browser pendente
Security Scan: Source PASS; worktree TRIAGED
Frontend Build: PASS
Backend Build: PASS

DDS GLOBAL SCORE: 76/100

# GO / NO-GO RECOMMENDATION

**NO-GO para clientes/trabalhadores reais neste momento.** Os hardenings P1, DR 299, matriz RLS mutável, provider MinIO sintético, vídeo, workflow browser autenticado de três perfis, Axe e PDF governado passaram na VPS isolada. Resta o fechamento formal dos 13 findings históricos de secrets. Nenhum dado real ou produção foi usado.

## Final release authorization — 2026-08-16

O fechamento final continua **NO-GO** exclusivamente pelos 13 findings históricos Gitleaks sem classificação/rotação formal. O inventário local foi movido para quarentena recuperável e o scan atual retornou 0; provider MinIO e Axe autenticado passaram. A autorização e a prova mínima exigida por owner estão em [dds-final-release-authorization.md](dds-final-release-authorization.md).

## Runtime closure addendum — 2026-08-16

Após a criação do ambiente S3-compatible isolado e a correção do fixture de autenticação, os dois gates técnicos foram reexecutados:

- Provider MinIO privado: `presigned 201 → PUT 200 → complete 201`, hash/magic bytes válidos, download autorizado `200/%PDF-`, anônimo/tamper `403`, cross-tenant `403` sem URL e expiração provider `200→403`; prefixo final com `0` objetos.
- Axe autenticado: Dashboard, lista DDS e formulário em `390x844`, `430x932` e `1440x900`, `0` violações `serious/critical`; teclado mobile `2/2` PASS. O contraste do nome no cartão da Sidebar foi corrigido.
- Auth smoke: CSRF `200`, login `201`, `/auth/me` `200`; sem tokens/valores de credenciais registrados.

O veredito global permanece `NO-GO` exclusivamente pelo gate de secrets: o worktree atual está em `0`, mas os `13` findings históricos continuam sem prova formal de classificação, rotação/revogação e scan final. Este addendum atualiza os gates provider/Axe; não autoriza produção.
