# SGS — Auditoria Extrema 360° dos Módulos Operacionais

**Data de início:** 2026-08-14
**Branch:** `fix/rls-fail-open-company-delete-guard`
**Escopo:** DDS, ARR, PT, EPI, Checklist, RDO, Relatório Fotográfico
**Princípio:** NÃO CONFIE EM NADA. PROVE.

---

## FASE 0 — INVENTÁRIO TOTAL

### Tabela-mestre

| Módulo | Backend (`backend/src/modules/`) | Tabelas | Frontend (`frontend/app/dashboard/`) | Service FE | PDF | Upload | Tests | Integrações |
|---|---|---|---|---|---|---|---|---|
| **DDS** | `dds/` (2005 L service, 866 L controller, 4 services aux, 2 controllers públicos) | `dds`, `dds_participants`, `dds_approval_records`, `dds_signature_invites` | `dds/` (page, new, edit) | `ddsService.ts`, `publicDdsSignatureService.ts` | `pdf-system/blueprints/ddsBlueprint.ts` + `pdf/ddsGenerator.ts` | fotos/evidência | 8 spec files + `load/dds-emit-*.ts` | signatures, document-registry, mail, notifications |
| **ARR** | `arrs/` (652 L service, 242 L controller) | `arrs` | `arrs/` (page, new, edit) | `arrsService.ts` | `blueprints/arrBlueprint.ts` + `pdf/arrGenerator.ts` | — | 2 spec files + `load/arr-emit-batch.ts` | document-registry, risks |
| **PT** | `pts/` (2348 L service, 529 L controller) | `pts`, `pt_executantes` | `pts/` (24 componentes, hooks) | `ptsService.ts` | `blueprints/ptBlueprint.ts` + `pdf/ptGenerator.ts` | fotos de evidência | 5 spec files | checklists (NR-33/35), signatures, document-registry |
| **EPI** | `epis/` (236 L) + `epi-assignments/` (364 L) | `epis`, `epi_assignments` | `epis/`, `epi-fichas/` | `episService.ts`, `epiAssignmentsService.ts` | (ficha via `pdf/`) | — | 5 spec files | users, signatures |
| **Checklist** | `checklists/` (3764 L service — **maior do escopo**, 388 L controller, 16 presets NR) | `checklists` | `checklists/`, `checklist-models/`, `checklist-templates/` | `checklistsService.ts` | `blueprints/checklistBlueprint.ts` + `pdf/checklistGenerator.ts` + `tables/checklistTable.ts` | fotos governadas | 8 spec + `test/critical/checklist-lifecycle.e2e-spec.ts` | nonconformities, corrective-actions, PT |
| **RDO** | `rdos/` (2647 L service, 496 L controller, audit service) | `rdos`, `rdo_audit_events` | `rdos/` (**apenas `page.tsx`**) | `rdosService.ts` | `blueprints/rdoBlueprint.ts` + `pdf/rdoGenerator.ts` | fotos de atividade | 2 spec files | document-registry, signatures |
| **Rel. Fotográfico** | `photographic-reports/` (2319 L service, renderer, word export) | `photographic_reports`, `photographic_report_days`, `photographic_report_images`, `photographic_report_exports` | `photographic-reports/` (wizard 3 passos) | `photographicReportsService.ts` | backend Puppeteer (`renderer.ts`) + `blueprints/photographicReportBlueprint.ts` | **upload múltiplo de imagens** | 4 spec files | storage B2, document-registry, forensic-trail |

**Total de código de serviço auditado:** 14.335 linhas (services) + 3.091 linhas (controllers).

### Migrations relevantes (59 identificadas)

Faixa histórica `1709000000000` → `1709000000371`. Migrations-chave por módulo:

- **DDS:** 000, 043, 099, 100 (optimistic lock), 102, 136 (hardening fase 1), 138 (approval flow), 162, 194, 210 (signature invites)
- **ARR:** 115 (criação do módulo), 333 (hardening fase 1)
- **PT:** 007–013 (checklists NR), 040 (approval rules), 045, 162, 312 (GDPR + temporal check), 313 (unique número/company), 343 (field operations), 344 (final PDF hash)
- **EPI:** 017 (assignments), 314 (GDPR erasure), 315 (RLS WITH CHECK)
- **Checklist:** 051, 095, 320 (GIN + checks), 321 (FK p/ NC), 322, 323, 342, 347, 353 (trigram)
- **RDO:** 025 (criação + RLS), 052, 098, 105 (audit events), 184, 327 (hardening enterprise)
- **Foto:** 204 (criação), 205 (RBAC), 368 (RLS super-admin flag), 369 (photo_conditions), 370 (SST + integridade), 371 (índices de governança)

### Lacunas do inventário — investigadas e resolvidas

| # | Hipótese inicial | Resultado da verificação |
|---|---|---|
| I-01 | RDO teria só `page.tsx` no frontend | ❌ **REFUTADA.** O RDO tem UI completa em outro caminho: `frontend/app/dashboard/relatorios/rdos/` (RdoPage, export Excel, hooks de isolamento de tenant) + `frontend/src/components/rdos/` (RdoEditorModal, RdoViewerModal, RdoActivityEditorCard, RdoActionModals). O padrão é **modal**, não página dedicada. Corrigido na tabela-mestre. |
| I-02 | Checklist service com 3.764 linhas | ✅ Confirmado — god service. Tratado como risco de 1ª ordem na FASE 1/2. |
| I-03 | Nenhum E2E de API em 6 de 7 módulos | ✅ **Confirmado.** Só existe `backend/test/critical/checklist-lifecycle.e2e-spec.ts`. Lifecycle real não é provado por automação em DDS, ARR, PT, EPI, RDO e Foto. |
| I-04 | `arrs` sem RLS | ❌ **REFUTADA.** [1709000000115:110-130](backend/src/infra/database/migrations/1709000000115-create-arrs-module.ts#L110) faz `ENABLE` + `FORCE ROW LEVEL SECURITY` e cria `tenant_isolation_policy` com `USING` **e** `WITH CHECK`, para `arrs` e `arr_participants`. |
| I-05 | Tabelas sem `CREATE POLICY` literal estariam sem RLS | ❌ **REFUTADA.** Ver `tenant-isolation.md`. Cobertura provada tabela a tabela; nenhuma das 17 tabelas do escopo ficou descoberta. |
| I-06 | DDS tem 2 controllers públicos | ✅ Confirmado — superfície pública sob auditoria adversarial dedicada. |
| I-07 | Relatório Fotográfico renderiza PDF no backend (Puppeteer) | ✅ Confirmado — caminho de renderização distinto dos demais (que usam `pdf-system` no frontend). |

### Correções aplicadas à tabela-mestre

- **RDO / Frontend:** `dashboard/rdos/page.tsx` + `dashboard/relatorios/rdos/*` + `src/components/rdos/*` (5 componentes, padrão modal).

---

## Estrutura desta auditoria

| Arquivo | Conteúdo |
|---|---|
| `00-master-audit.md` | Este arquivo — inventário, método, índice |
| `01-dds.md` … `07-photo-report.md` | Relatório por módulo |
| `security-matrix.md`, `tenant-isolation.md`, `site-isolation.md`, `rbac-matrix.md` | Segurança |
| `database-review.md`, `migrations-review.md` | Banco |
| `pdf-quality.md`, `design-review.md` | Documentos e produto |
| `performance-review.md`, `tests-review.md` | Performance e testes |
| `findings.md`, `fixes.md`, `final-verdict.md` | Consolidação |

---

## STATUS DA AUDITORIA — rodada 1 concluída

### O que foi coberto

| Fase | Escopo | Status |
|---|---|---|
| 0 | Inventário total | ✅ concluída |
| 1–3 | Arquitetura, Backend, DTOs, Máquinas de estado | ✅ concluída (7 módulos) |
| 4 | Multi-tenancy / RLS | ✅ concluída — `tenant-isolation.md` |
| 5 | Isolamento por obra | ✅ concluída — `site-isolation.md` |
| 6–7 | RBAC / IDOR | ✅ parcial — cadeia RBAC provada para PT e RDO |
| 8–9 | Banco / Migrations | ✅ concluída |
| 10 | Concorrência | ✅ concluída (análise estática) |
| 18–19 | Assinaturas / Integridade documental | ✅ concluída |
| 20–21 | Uploads / Imagens | ✅ concluída |
| 31–32 | Observabilidade / Audit log | ✅ concluída |
| **11–17** | **Frontend, Design System, Responsividade, Acessibilidade, PDFs** | ⛔ **NÃO EXECUTADA** |
| **22–24** | **Redis, Performance de carga, Network** | ⛔ **NÃO EXECUTADA** |
| **26–28** | **Cobertura de testes, E2E de lifecycle, adversarial em runtime** | ⛔ **NÃO EXECUTADA** |
| **49–51** | **Golden Documents e inspeção visual de PDF** | ⛔ **NÃO EXECUTADA** |

**Motivo da interrupção:** o limite de sessão foi atingido durante a rodada 1. Os 7 agentes auditores concluíram; os 7 verificadores adversariais falharam com `session limit · resets 8:50`. A verificação adversarial foi então **refeita manualmente**, inline, sobre todos os CRITICAL e os HIGH de maior impacto — com leitura direta do código, não por delegação.

### Números da rodada 1

| | |
|---|---|
| Achados brutos dos auditores | **81** (6 CRITICAL, 24 HIGH, 41 MEDIUM, 10 LOW) |
| Achados próprios (fora dos agentes) | **3** (2 CRITICAL, 1 HIGH) |
| Verificados adversarialmente | **13** (todos os CRITICAL + HIGH de maior impacto) |
| Refutados na verificação | **1** (`SGS-CHK-SEC-001`) |
| Rebaixados na verificação | **4** (`SGS-RF-STM-001`, `SGS-PT-SEC-004`, `SGS-RDO-SEC-002`, `SGS-PT-SM-008`) |
| Ainda **não confrontados** | **68** — marcados como ⏳ nos relatórios por módulo |
| Baseline de testes | 33 suítes / **481 testes verdes** (`npx jest` nos 7 módulos) |

> ⚠️ **Os 68 achados não confrontados NÃO devem ser tratados como fato.** Cada relatório por módulo marca explicitamente o estado de verificação de cada achado.

### Scorecard — parcial e honesto

O scorecard completo da FASE 42 pondera 10 áreas. Apenas **55 dos 100 pontos** foram efetivamente medidos nesta rodada. Emitir nota final agora seria inventar 45% do resultado.

| Área | Peso | Medida? |
|---|---:|---|
| Segurança | 20 | ✅ |
| Backend | 10 | ✅ |
| Banco | 10 | ✅ |
| Regras de negócio | 10 | ✅ |
| Observabilidade | 5 | ✅ |
| Frontend | 10 | ⛔ |
| UX/UI | 10 | ⛔ |
| PDF/documentos | 10 | ⛔ |
| Testes | 10 | ⛔ |
| Performance | 5 | ⛔ |

**Nota parcial sobre as 5 áreas medidas (55 pts normalizados para 100):**

| Módulo | Nota parcial | Status provisório | Bloqueadores confirmados |
|---|---:|---|---|
| ARR | 62 | 🟠 NOT READY | Sem assinatura/aprovação; PDF final sem vínculo com o banco; sem trilha forense |
| Checklist | 61 | 🟠 NOT READY | `is_modelo` editável desliga reset de assinatura; PDF final 100% do cliente |
| DDS | 52 | 🔴 BLOCKED | `SGS-DDS-INT-001` (CRITICAL) |
| RDO | 55 | 🟠 NOT READY | Trilha de auditoria mutável + destruída por CASCADE; e-mail sem allowlist |
| Rel. Fotográfico | 48 | 🔴 BLOCKED | `SGS-RF-SEC-012` (sem isolamento por obra) + trilha forense ausente |
| EPI | 44 | 🔴 BLOCKED | `SGS-EPI-SEC-001` + `SGS-EPI-PRIV-001` (ambos CRITICAL) |
| **PT** | **38** | 🔴 **BLOCKED** | `SGS-PT-SEC-001` + `SGS-PT-SEC-002` (CRITICAL) + `SGS-PT-BR-003` — os gates de NR estão desligados ou furados |

> **Nenhum dos 7 módulos pode receber PRODUCTION READY nesta rodada.** Além dos CRITICAL abertos, a FASE 43 exige lifecycle testado, PDF crítico validado e regressão executada — nada disso foi feito (rodadas 2 e 3 não rodaram).

### Ranking técnico da rodada 1

- **Maior risco de segurança:** PT — os únicos dois CRITICAL que afetam decisão de segurança do trabalho real (aprovar PT sem assinatura de executante, com treinamento vencido, e com os gates NR-33 permanentemente desligados).
- **Maior risco operacional:** PT, pelo mesmo motivo — é o documento que autoriza altura, espaço confinado, trabalho a quente e elétrica.
- **Maior risco de conformidade:** EPI — regressão LGPD silenciosa na migration 345, que também atinge PT.
- **Maior dívida técnica:** Checklist — 3.764 linhas em um único service.
- **Maior risco de integridade documental:** DDS — único documento governado do escopo cujo `remove()` destrói o PDF final e o registro público.
- **Melhor implementação relativa:** ARR — o menor e mais simples; os achados são de ausência de controles, não de controles quebrados.

### Próximos passos

1. **P0 (bloqueia produção):** corrigir os 6 CRITICAL confirmados. Detalhamento em `findings.md`.
2. **Rodada 2** (após 8:50, quando a cota de subagentes reseta): Frontend, Design System, UX, responsividade, acessibilidade e auditoria visual dos PDFs — inclusive a auditoria dedicada do design da PT (FASE 13) e os Golden Documents (FASES 49–51).
3. **Rodada 3:** confrontar adversarialmente os 68 achados restantes; testes E2E de lifecycle; adversarial em runtime contra banco descartável; performance com volume.

> Status: **RODADA 1 CONCLUÍDA — RODADAS 2 E 3 PENDENTES.**
