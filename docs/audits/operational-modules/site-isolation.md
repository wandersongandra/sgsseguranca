# FASE 5 — Isolamento por Obra (Site)

> Pergunta central: *um usuário autorizado apenas para a OBRA A consegue ler ou alterar um documento da OBRA B, dentro da mesma empresa?*

## Como o SGS implementa isolamento por obra

Duas camadas, e **só uma delas é obrigatória**:

1. **Banco (obrigatória).** A policy `site_scope_isolation_policy` é criada `AS RESTRICTIVE` — portanto combinada com **AND** à policy de tenant — em toda tabela que tenha **as duas** colunas `company_id` **e** `site_id` (filtro em [127:41](backend/src/infra/database/migrations/1709000000127-harden-site-scoped-tenant-rls.ts#L41) e [367:58](backend/src/infra/database/migrations/1709000000367-enable-multi-site-rls-scope.ts#L58)). Predicado final, após a 367:

   ```sql
   is_super_admin() = true
   OR ( company_id = current_company()
        AND ( current_site_scope() = 'all'
              OR site_id = ANY(current_site_ids()) ) )
   ```
   Aplicado em `USING` **e** `WITH CHECK` — isto é, cobre leitura **e** escrita.

2. **Aplicação (opcional, inconsistente).** Alguns services checam obra explicitamente (`getSiteAccessScopeOrThrow` no DDS, `site_id = ANY($3)` no lock da PT); outros não checam nada e dependem inteiramente do banco.

## Matriz — quem está protegido

| Módulo | Tabela | Tem `site_id`? | Policy RESTRICTIVE de obra | Checagem na aplicação | Veredito |
|---|---|---|---|---|---|
| DDS | `dds` | ✅ | ✅ aplica | ✅ `getSiteAccessScopeOrThrow` | 🟢 protegido nas 2 camadas |
| ARR | `arrs` | ✅ | ✅ aplica | ⚠️ não verificada | 🟡 protegido só pelo banco |
| PT | `pts` | ✅ | ✅ aplica | ✅ na leitura/lock; ❌ no `update()` | 🟡 ver `SGS-PT-SEC-004` |
| EPI (fichas) | `epi_assignments` | ✅ | ✅ aplica | ⚠️ parcial | 🟡 ver `SGS-EPI-SEC-008` |
| EPI (catálogo) | `epis` | ❌ | ❌ **não aplica** | ❌ | ⚪ aceitável — catálogo é por empresa, não por obra |
| Checklist | `checklists` | ✅ | ✅ aplica | ❌ perdida em `findPaginated` | 🟡 ver `SGS-CHK-BAK-004` |
| RDO | `rdos` | ✅ | ✅ aplica | ✅ na leitura; ❌ em create/update | 🟡 ver `SGS-RDO-SEC-002` |
| **Rel. Fotográfico** | `photographic_reports` | ❌ | ❌ **não aplica** | ❌ **nenhuma** | 🔴 **sem isolamento por obra** |

## SGS-RF-SEC-012 — Relatório Fotográfico não tem isolamento por obra em nenhuma camada

| Campo | Valor |
|---|---|
| **Severidade** | 🟠 **HIGH** |
| **Categoria** | Security |
| **Módulo** | Relatório Fotográfico |
| **Verdict** | ✅ CONFIRMED — achado próprio desta auditoria (não veio do agente) |

**Evidência.** Três provas independentes:

1. A entidade [`photographic-report.entity.ts`](backend/src/modules/photographic-reports/entities/photographic-report.entity.ts) não declara `site_id`.
2. Nenhuma das migrations do módulo (204, 205, 368, 369, 370, 371) cria coluna `site_id` — `grep -n "site_id"` sobre 204 e 370 retorna vazio.
3. `grep -nE "siteId|site_id|siteScope|getSiteAccessScope"` sobre as **2319 linhas** de `photographic-reports.service.ts` retorna **zero ocorrências**.

Como a policy `site_scope_isolation_policy` só é criada para tabelas com `company_id` **e** `site_id`, a tabela fica de fora do mecanismo. A obra é registrada apenas como **texto livre** (`project_name`, normalizado em `photographic-reports.service.ts:1024-1027`) — não é uma FK, não é filtrável e não é aplicável por RLS.

**Impacto.** Um TST ou Supervisor autorizado somente para a OBRA A lista, abre, edita, exporta e apaga relatórios fotográficos da OBRA B da mesma empresa. Em cliente com obras de contratantes distintos (o caso normal em SST terceirizada), isso é vazamento de evidência fotográfica entre clientes finais — fotos de não conformidade, rostos de trabalhadores, placas, localização. Os outros 6 módulos do escopo isolam por obra; este não. A inconsistência é o agravante: o operador confia que o escopo de obra vale para todo o sistema.

**Causa raiz.** O módulo foi criado na migration 204, depois da 127 (que estabeleceu o padrão de isolamento por obra). Como a 127 descobre tabelas dinamicamente e a 204 não incluiu `site_id`, o módulo nasceu fora do mecanismo — e nenhum gate impede isso (ver `SGS-XM-DB-002`).

**Correção recomendada.**

1. Migration nova (`1709000000377`): adicionar `site_id uuid NULL REFERENCES sites(id)` em `photographic_reports`, índice `(company_id, site_id, created_at DESC)`, e backfill deixando `NULL` no histórico.
2. Rodar `enableSiteScopePolicy` para a tabela — ou apenas garantir que a policy da 367 seja reaplicada, já que ela é dinâmica sobre `company_id + site_id`. **Atenção:** o predicado atual não tolera `site_id IS NULL` (só a policy de `users` tem `OR site_id IS NULL`, [367:190](backend/src/infra/database/migrations/1709000000367-enable-multi-site-rls-scope.ts#L190)). Com backfill `NULL`, todo o histórico ficaria invisível. Duas saídas: **(a)** backfill obrigatório a partir de `project_name`/obra antes de ativar a policy, ou **(b)** incluir `OR site_id IS NULL` no predicado desta tabela e tratar `NULL` como "empresa inteira", documentando a exceção.
3. Tornar `site_id` obrigatório em `CreatePhotographicReportDto` para relatórios novos.

**Teste de regressão.** E2E com 2 obras: usuário escopado na OBRA A recebe 404/403 em `GET /photographic-reports/:id` de relatório da OBRA B, e o `GET /photographic-reports` não lista o registro.

---

## Nota metodológica — por que dois HIGH viraram MEDIUM

Os achados `SGS-PT-SEC-004` e `SGS-RDO-SEC-002` foram reportados pelos auditores como *"isolamento por obra quebrado na escrita"*. A verificação adversarial rebaixou ambos para MEDIUM: as tabelas `pts` e `rdos` **têm** `site_id`, logo estão sob a policy RESTRICTIVE com `WITH CHECK`, e o Postgres **rejeita** o UPDATE que mova o documento para fora de `current_site_ids()`. Não existe escrita cross-site efetiva para usuário escopado.

O que permanece legítimo nos dois achados: não há validação na aplicação (ausência de defesa em profundidade) e a falha é suja — o usuário recebe um **500** do Postgres em vez de um **403** claro.

Este é exatamente o motivo pelo qual "existe uma policy" e "o service não valida" precisam ser avaliados **juntos**: isolados, cada um leva a uma conclusão errada.
