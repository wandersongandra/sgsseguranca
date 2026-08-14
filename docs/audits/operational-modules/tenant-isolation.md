# FASE 4/5 — Isolamento Multi-Tenant e por Obra (Site)

> Método: **não confiar que "existe uma policy" significa RLS ativa**. Cada tabela dos 7 módulos foi rastreada
> da sua migration de criação até a última migration que a toca, verificando `ENABLE`, `FORCE`, `USING` e `WITH CHECK`.

---

## 1. Cobertura RLS — as 17 tabelas do escopo

Duas armadilhas foram testadas explicitamente:

- **Armadilha A:** a migration genérica [1709000000021](backend/src/infra/database/migrations/1709000000021-rls-all-tenant-tables.ts) descobre tabelas dinamicamente via `information_schema` — é um **retrato do momento**. Tabela criada depois dela não é coberta.
- **Armadilha B:** as varreduras dinâmicas mais recentes — [325](backend/src/infra/database/migrations/1709000000325-rls-add-with-check.ts) e [334](backend/src/infra/database/migrations/1709000000334-ensure-rls-with-check.ts) — fazem **apenas `DROP POLICY` + `CREATE POLICY`**, sem `ENABLE`/`FORCE ROW LEVEL SECURITY`. Uma tabela com policy mas sem RLS habilitada tem isolamento **zero**.

### Resultado tabela a tabela

| Tabela | Criada em | RLS habilitada por | Policy tenant | `WITH CHECK` | Veredito |
|---|---|---|---|---|---|
| `dds` | initial-schema `1699000000000` | 021 + 029 (varredura dinâmica, tem `company_id`) | 334 (final) | ✅ | ✅ COBERTA |
| `dds_participants` | initial-schema | [106](backend/src/infra/database/migrations/1709000000106-rls-junction-tables-and-apr-children.ts) explícita | 106 | ✅ | ✅ COBERTA |
| `dds_approval_records` | [138](backend/src/infra/database/migrations/1709000000138-dds-approval-flow.ts) | [151](backend/src/infra/database/migrations/1709000000151-enterprise-public-grants-notifications-rls.ts) `enableCompanyPolicy()` | 151 | ✅ | ✅ COBERTA |
| `dds_signature_invites` | [210](backend/src/infra/database/migrations/1709000000210-create-dds-signature-invites.ts) | 210 + [211](backend/src/infra/database/migrations/1709000000211-emergency-db-hardening-critical-rls-and-gdpr.ts):190-193 | 211:199 | ✅ | ✅ COBERTA |
| `arrs` | [115](backend/src/infra/database/migrations/1709000000115-create-arrs-module.ts) | 115:110-111 explícita | 115:116 | ✅ 115:122 | ✅ COBERTA |
| `arr_participants` | 115 | 115:131-134 | 115:140 | ✅ 115:152 | ✅ COBERTA |
| `pts` | initial-schema | 021 + 029 | 334 | ✅ | ✅ COBERTA |
| `pt_executantes` | initial-schema | 106 explícita | 106 | ✅ | ✅ COBERTA |
| `epis` | initial-schema | 021 + 029 | [315](backend/src/infra/database/migrations/1709000000315-epis-rls-with-check.ts) / 334 | ✅ | ✅ COBERTA |
| `epi_assignments` | initial-schema | 021 + 029 | 334 | ✅ | ✅ COBERTA |
| `checklists` | initial-schema | 021 + 029 | 334 | ✅ | ✅ COBERTA |
| `rdos` | [025](backend/src/infra/database/migrations/1709000000025-create-rdos.ts):56 (`ENABLE` só) | `FORCE` veio de 029 (varredura dinâmica) | 334 | ✅ | ✅ COBERTA (ver nota 1) |
| `rdo_audit_events` | [105](backend/src/infra/database/migrations/1709000000105-create-rdo-audit-events.ts) | [187](backend/src/infra/database/migrations/1709000000187-classify-writable-runtime-rls.ts):89-96 `enableParentTenantPolicy()` | via pai `rdos.company_id` | ✅ | ✅ COBERTA (ver nota 2) |
| `photographic_reports` | [204](backend/src/infra/database/migrations/1709000000204-create-photographic-reports-module.ts):175-180 | 204 explícita | 204:187 | ✅ | ✅ COBERTA |
| `photographic_report_days` | 204 | 204 explícita | 204:194 (`EXISTS` no pai) | ✅ | ✅ COBERTA |
| `photographic_report_images` | 204 | 204 explícita | 204:213 (`EXISTS` no pai) | ✅ | ✅ COBERTA |
| `photographic_report_exports` | 204 | 204 explícita | 204:232 (`EXISTS` no pai) | ✅ | ✅ COBERTA |

**Nota 1 — `rdos`:** a migration 025 só executa `ENABLE ROW LEVEL SECURITY`, sem `FORCE`. O `FORCE` chegou pela varredura dinâmica da 029 (que faz `ENABLE` **e** `FORCE` em toda tabela com `company_id`). Portanto o estado final é correto, mas **por acidente de ordenação**, não por intenção da migration que criou a tabela.

**Nota 2 — `rdo_audit_events`:** não possui coluna `company_id` própria. Isso a torna **invisível para todas as varreduras dinâmicas** (021, 029, 325, 334, que filtram por `column_name = 'company_id'`). O isolamento vem de uma policy de tenant-por-pai criada na 187, que checa `rdos.company_id` do RDO referenciado. Funciona — mas é a única tabela do escopo cuja proteção depende de uma migration temática e não do mecanismo padrão.

### Veredito da FASE 4

> **Não há tabela do escopo sem RLS.** As hipóteses I-04 e I-05 foram refutadas com evidência.
> O risco remanescente **não é o estado atual — é o processo**. Ver `SGS-XM-DB-002`.

---

## 2. Isolamento por obra (site) — FASE 5

Hipótese testada: *"o SGS tem duas policies permissivas na mesma tabela (`tenant_isolation_policy` e `site_scope_isolation_policy`); no PostgreSQL policies PERMISSIVE são combinadas com **OR**, logo a policy de tenant sozinha já liberaria a linha e o escopo de obra seria inútil."*

**❌ REFUTADA.** Ambas as migrations criam a policy de obra como `AS RESTRICTIVE`:

```sql
-- 1709000000127-harden-site-scoped-tenant-rls.ts:71-74
CREATE POLICY "site_scope_isolation_policy"
ON "<tabela>"
AS RESTRICTIVE          -- <<< combinada com AND, não OR
FOR ALL
USING (
  is_super_admin() = true
  OR (company_id = current_company()
      AND (current_site_scope() = 'all' OR site_id = current_site_id()))
)
WITH CHECK ( ...mesmo predicado... )
```

```sql
-- 1709000000367-enable-multi-site-rls-scope.ts:163-167
CREATE POLICY "site_scope_isolation_policy" ON <tabela>
AS RESTRICTIVE FOR ALL
USING (... site_id = ANY(current_site_ids()) ...)
```

A 367 introduziu **multi-obra** (`current_site_ids()` retorna array, com fallback para `current_site_id()`), corrigindo o caso do TST/Supervisor autorizado em mais de uma obra — que antes enxergava apenas uma.

Como as varreduras 325/334 só removem/recriam a policy de nome `tenant_isolation_policy`, elas **não clobberam** o escopo de obra. Verificado.

Aplicação: toda tabela que tenha **as duas** colunas `company_id` e `site_id` (filtro em 127:41 e 367:58).

---

## 3. Plumbing de runtime — como o contexto chega ao Postgres

[`TenantDbContextService`](backend/src/shared/database/tenant-db-context.service.ts) faz *monkey-patch* de `pool.connect()` do driver `pg`. A cada conexão emprestada do pool ele executa um único `SELECT set_config(...)` com 10 parâmetros (company, super-admin, user, site, sites, scope + 3 timeouts).

Pontos verificados:

| Verificação | Resultado |
|---|---|
| Injeção de SQL no contexto | ✅ Seguro — `set_config` **parametrizado** ([:202-225](backend/src/shared/database/tenant-db-context.service.ts#L202)) |
| Fail-closed em erro | ✅ Sim — em exceção, zera o tenant e derruba a conexão ([:230-277](backend/src/shared/database/tenant-db-context.service.ts#L230)) |
| Cobre réplicas de leitura | ✅ Sim — patcheia `driver.master` **e** `driver.slaves[]` ([:108-118](backend/src/shared/database/tenant-db-context.service.ts#L108)) |
| Bypass de super-admin | ✅ Só quando `isSuperAdmin && !companyId` ([:184](backend/src/shared/database/tenant-db-context.service.ts#L184)) — ADMIN_GERAL com empresa selecionada fica **escopado** àquela empresa |
| **Cache de contexto** (`previousContextKey !== contextKey` pula o `set_config`) | ⚠️ Investigado a fundo — ver abaixo |

**Sobre o cache de contexto:** a otimização em [:190](backend/src/shared/database/tenant-db-context.service.ts#L190) pula o `set_config` quando a conexão emprestada já tem exatamente o mesmo contexto. Isso só é seguro se **nenhum outro código alterar as variáveis de sessão de forma persistente**. Varredura completa de `src/` (excluindo migrations e specs) encontrou **9 pontos** que elevam `app.is_super_admin` — `mail.service`, `gdpr-deletion.service` (3×), `disaster-recovery-execution.service`, `tenant-backup.service` (3×) — e **todos usam `SET LOCAL` ou `set_config(..., true)`**, ou seja, escopo de transação/statement, revertido no commit. A `forensic-trail.service` e a `rls-validation.service` usam `set_config(..., true)` para **rebaixar** o contexto, o que também é seguro.

> ✅ Nenhum caminho encontrado corrompe o cache. **Mas é uma invariante não escrita e não testada** — um único `SET app.is_super_admin = 'true'` (sem `LOCAL`) introduzido no futuro vazaria privilégio para requisições subsequentes que reutilizassem aquela conexão do pool, de forma silenciosa. Ver `SGS-XM-SEC-003`.

`sgs_app` perdeu o bypass em [361](backend/src/infra/database/migrations/1709000000361-revoke-rls-bypass-from-sgs-app.ts):35 (`REVOKE sgs_rls_bypass FROM sgs_app`), o que torna `is_super_admin()` inerte para o runtime — os ramos `OR is_super_admin() = true` das policies são, na prática, letra morta em produção.

---

## 4. O que NÃO foi verificado

| Item | Motivo |
|---|---|
| Execução real das policies contra um Postgres com 2 tenants | Requer banco descartável provisionado; a auditoria estática cobre o **desenho**, não o **estado do banco de produção** |
| Se produção tem exatamente o schema que as migrations produzem (schema drift) | Exigiria conexão ao Neon de produção — fora do escopo seguro desta auditoria |
| Se `current_site_ids()` está populado corretamente para todo perfil | Depende de dados de `user_sites` em runtime |

Recomendação: promover a suíte descrita em `SGS-XM-DB-002` a gate de CI — ela cobre exatamente esses três pontos com banco efêmero.
