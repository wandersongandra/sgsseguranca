# SGS — Findings da Auditoria Extrema 360°

> Cada achado só entra aqui com **evidência de código real**. "Parece correto" não é evidência.
> Status: EM ANDAMENTO — consolidação por fase.

---

## SGS-EPI-SEC-001 — `ValidationPipe` global é totalmente ignorado nas rotas herdadas de `BaseController` (mass assignment + escalação de privilégio)

| Campo | Valor |
|---|---|
| **Severidade** | 🔴 **CRITICAL** |
| **Categoria** | Security / Backend |
| **Módulos afetados** | **EPI** (escopo), + `machines`, `tools` (mesmo defeito, fora do escopo dos 7) |
| **Localização** | [base.controller.ts:79](backend/src/shared/base/base.controller.ts#L79), [base.controller.ts:144](backend/src/shared/base/base.controller.ts#L144), [base.service.ts:104-123](backend/src/shared/base/base.service.ts#L104-L123) |
| **Verdict** | ✅ CONFIRMED — prova empírica executada |

### Evidência

`BaseController.create` / `.update` recebem o body tipado com um **parâmetro genérico** (`CreateDto`, `UpdateDto`). O TypeScript emite `Object` como `design:paramtypes` para type parameters. Prova no build atual:

```
backend/dist/shared/base/base.controller.js:73
    __metadata("design:paramtypes", [Object]),          // create()
backend/dist/shared/base/base.controller.js:144
    __metadata("design:paramtypes", [String, Object]),  // update()
```

O `ValidationPipe` do Nest pula validação quando o metatype é `Object`:

```
node_modules/@nestjs/common/pipes/validation.pipe.js:120-121
    const types = [String, Boolean, Number, Array, Object, Buffer, Date];
    return !types.some(t => metatype === t) && !isNil(metatype);
```

**Prova executada** (`node` contra o `dist` real, com o mesmo `ValidationPipe` configurado em [main.ts:344](backend/src/main.ts#L344)):

```
--- 1) metatype = Object (o que BaseController realmente emite) ---
{"nome":"<script>alert(1)</script>","id":"1111...","deleted_at":"2020-01-01T00:00:00Z",
 "company_id":"2222...","campo_inexistente":"xxxx...","validade_ca":"nao-e-data"}
   → PASSOU 100% CRU

--- 2) metatype = CreateEpiDto (o que deveria acontecer) ---
   → REJEITADO 400 com 5 erros:
     "property id should not exist"
     "property deleted_at should not exist"
     "property campo_inexistente should not exist"
     "validade_ca must be a valid ISO 8601 date string"
     "company_id não é permitido no payload..."
```

`RisksController` **sobrescreve** `create`/`update` com o DTO concreto ([risks.controller.ts:33](backend/src/modules/risks/risks.controller.ts#L33)) — por isso está protegido. `EpisController`, `MachinesController` e `ToolsController` **não sobrescrevem** e ficam expostos em `POST` e `PATCH`.

### Impacto

Rotas afetadas: `POST /epis`, `PATCH /epis/:id`, `POST /machines`, `PATCH /machines/:id`, `POST /tools`, `PATCH /tools/:id` (e `/v1/...`).

1. **Escalação de privilégio → soft-delete por quem não pode deletar.**
   `Epi extends BaseAuditEntity`, que declara `@DeleteDateColumn deleted_at` ([base-audit.entity.ts:29](backend/src/shared/entities/base-audit.entity.ts#L29)).
   `BaseService.update` faz `repository.merge(entity, next)` + `save()` e **não remove `deleted_at`** do payload ([base.service.ts:116-122](backend/src/shared/base/base.service.ts#L116-L122)).
   → `PATCH /epis/:id {"deleted_at":"2020-01-01"}` apaga (soft) o EPI.
   `PATCH` exige `@Roles(ADMIN_GERAL, ADMIN_EMPRESA, TST)`; `DELETE` exige `@Roles(ADMIN_GERAL)` ([base.controller.ts:128](backend/src/shared/base/base.controller.ts#L128) vs [:152](backend/src/shared/base/base.controller.ts#L152)).
   → **Um TST executa uma ação reservada ao ADMIN_GERAL**, e sem passar pelo `@ForensicAuditAction('delete','catalog')` que só existe no `DELETE` ([base.controller.ts:154](backend/src/shared/base/base.controller.ts#L154)) — ou seja, **a exclusão não é registrada na trilha forense**.

2. **Ressurreição de registro apagado.** `PATCH {"deleted_at": null}` reverte um soft-delete feito por ADMIN_GERAL, também sem trilha.

3. **`POST` age como `UPDATE` arbitrário.** `BaseService.create` não remove `id` ([base.service.ts:105-112](backend/src/shared/base/base.service.ts#L105-L112)); `repository.create({id, ...}) → save()` com PK presente faz UPDATE. `POST /epis {"id":"<uuid-existente>", "nome":"..."}` sobrescreve outro registro do mesmo tenant.

4. **XSS armazenado.** `CreateEpiDto` aplica `@Transform(sanitizePlainTextTransform)` em `nome`/`descricao`/`ca` — **nunca executado**. `nome` de EPI flui para PDFs (inclusive o renderer **Puppeteer/HTML** do Relatório Fotográfico) e para a UI.

5. **DoS / poluição de dados.** Sem `@MaxLength`, `descricao` é coluna `text` sem limite; `validade_ca` aceita string arbitrária → erro 500 do Postgres em vez de 400.

**O que NÃO é possível:** cross-tenant. `BaseService.sanitizeWritePayload` remove `company_id`/`role`/`permissions` ([base.service.ts:53-67](backend/src/shared/base/base.service.ts#L53-L67)) e a RLS tem `WITH CHECK`. Isso limita o teto do achado — mas não reduz a escalação de privilégio nem a quebra de trilha forense.

### Causa raiz

Uso de **type parameter genérico** como tipo do `@Body()` em classe abstrata. O metadata de decorator do TypeScript não é genérico: apaga para `Object`. É um bypass **silencioso** — nenhum lint, nenhum teste e nenhum type-check acusa.

### Correção recomendada

Duas camadas (defesa em profundidade):

1. **Fechar o buraco genérico** — tornar o DTO explícito nas subclasses (padrão que `RisksController` já usa), OU aplicar um `ValidationPipe` explícito com o tipo concreto no parâmetro:
   ```ts
   // epis.controller.ts
   @Post()
   @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
   @Authorize('can_manage_catalogs')
   override create(@Body() dto: CreateEpiDto): Promise<Epi> {
     return this.episService.create(dto);
   }

   @Patch(':id')
   @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
   @Authorize('can_manage_catalogs')
   override update(
     @Param('id', new ParseUUIDPipe()) id: string,
     @Body() dto: UpdateEpiDto,
   ): Promise<Epi> {
     return this.episService.update(id, dto);
   }
   ```
   Idem para `MachinesController` e `ToolsController`.

2. **Blindar o `BaseService`** — `sanitizeWritePayload` deve remover também `id`, `deleted_at`, `created_at`, `updated_at`. Isso protege qualquer controller futuro que caia na mesma armadilha.

3. **Guard-rail permanente** — teste que falha se qualquer rota de escrita tiver `design:paramtypes` igual a `Object` (ver teste de regressão).

### Teste de regressão

```ts
// backend/test/security/body-validation-metatype.spec.ts
it('nenhuma rota de escrita pode ter @Body() com metatype Object', () => {
  // varre todos os controllers registrados; para cada handler POST/PUT/PATCH,
  // lê Reflect.getMetadata('design:paramtypes', proto, key) e o índice do @Body()
  // via ROUTE_ARGS_METADATA; falha se o tipo for Object/undefined.
});

// backend/src/modules/epis/epis.controller.spec.ts
it('PATCH /epis/:id rejeita deleted_at no payload', async () => {
  await request(app).patch(`/epis/${id}`).set(tstAuth)
    .send({ deleted_at: '2020-01-01T00:00:00Z' })
    .expect(400);
});
it('POST /epis rejeita id no payload', async () => { /* 400 */ });
```

---

## P0 — CRITICAL confirmados (bloqueiam produção)

Todos abaixo foram **confrontados com leitura direta do código**. Detalhamento completo em cada relatório de módulo.

| ID | Módulo | Título | Onde |
|---|---|---|---|
| `SGS-EPI-SEC-001` | EPI (+machines/tools) | `ValidationPipe` global ignorado nas rotas herdadas de `BaseController` | ↑ acima |
| `SGS-PT-SEC-001` | PT | Gate de aprovação lê a PT sem relações → assinaturas de executantes e treinamento vencido **nunca** são checados | [pts.service.ts:1304](backend/src/modules/pts/pts.service.ts#L1304) |
| `SGS-PT-SEC-002` | PT | `Operador/Colaborador` desliga as regras de aprovação da empresa inteira, sem audit log | [pts.controller.ts:243](backend/src/modules/pts/pts.controller.ts#L243) |
| `SGS-EPI-PRIV-001` | EPI + PT | Migration 345 regrediu `gdpr_delete_user_data()` e perdeu `epi_assignments` **e** `pts_text_fields` | [345:154](backend/src/infra/database/migrations/1709000000345-gdpr-anonymize-user-pii.ts#L154) |
| `SGS-DDS-INT-001` | DDS | `DELETE /dds/:id` destrói PDF final emitido e seu registro público — PT tem a trava, DDS não | [dds.service.ts:1534](backend/src/modules/dds/dds.service.ts#L1534) |
| `SGS-PT-BR-003` | PT | As 4 regras NR-33/evidência são inalcançáveis pela API — permanentemente desligadas | [update-pt-approval-rules.dto.ts:3](backend/src/modules/pts/dto/update-pt-approval-rules.dto.ts#L3) |

### SGS-PT-SEC-001 — detalhe da prova

`executePtWorkflowTransition` hidrata a PT a partir de SQL cru:

```ts
// pts.service.ts:1304
const rows = await manager.query<Pt[]>(
  `SELECT * FROM "pts" WHERE "id" = $1 AND "company_id" = $2${siteClause} FOR UPDATE NOWAIT`, params,
);
const pt = manager.getRepository(Pt).create(rows[0]);   // <<< só colunas escalares
```

`pt.executantes` é uma relação (`pt_executantes`) → fica `undefined`. Em `assertCanApprove`:

```ts
// pts.service.ts:2156
const executantes = Array.isArray(pt.executantes) ? pt.executantes : [];   // → []
if (executantes.length > 0) {            // → FALSE, bloco inteiro pulado
  const signatures = await this.signaturesService.findByDocument(pt.id, 'PT');
  ...  // conferência de assinaturas dos executantes NUNCA roda
}
const workerIds = [pt.responsavel_id, ...executantes.map(e => e.id)]      // → só o responsável
const workerStatuses = await this.workerOperationalStatusService.getByUserIds(workerIds);
// treinamento vencido dos EXECUTANTES nunca é avaliado
```

**Duas falhas ABERTAS**, ambas em gates de segurança do trabalho: PT aprovada sem assinatura dos executantes e com executante de treinamento NR vencido.

### SGS-PT-SEC-002 — cadeia RBAC fechada

1. `PATCH /pts/approval-rules` exige só `@Authorize('can_manage_pt')` — [pts.controller.ts:244](backend/src/modules/pts/pts.controller.ts#L244)
2. `@Roles` de classe inclui `Role.COLABORADOR` — [pts.controller.ts:59-65](backend/src/modules/pts/pts.controller.ts#L59)
3. A migration [103:210-224](backend/src/infra/database/migrations/1709000000103-fix-rbac-role-permissions-and-dids-rls.ts#L210) concede `can_manage_pt` ao perfil **`Operador / Colaborador`**
4. `updateApprovalRules` grava em `companies.pt_approval_rules` — **escopo de empresa inteira** — sem `logAudit`, sem trilha forense ([pts.service.ts:2126-2135](backend/src/modules/pts/pts.service.ts#L2126))

O Operador não aprova PT (não tem `can_approve_pt`), mas **desliga os gates para todos** — e não há como descobrir quem desligou.

### SGS-EPI-PRIV-001 — evolução da função LGPD

| Migration | Tabelas cobertas por `gdpr_delete_user_data()` |
|---|---|
| 312 | activities, audit_logs, user_sessions, document_registry, ai_interactions, user_consents, **pts_text_fields** |
| 314 | as 7 acima **+ epi_assignments** |
| **345 (vigente)** | activities, ai_interactions, **apr_risk_evidences**, audit_logs, document_registry, user_consents, user_sessions |

A 345 é a última migration a executar `CREATE OR REPLACE FUNCTION` sobre ela (verificado nas 298 migrations). Perdeu **2 tabelas de módulos deste escopo** e ganhou 1 de outro. Um pedido de exclusão LGPD hoje **não anonimiza** a assinatura do trabalhador na ficha de EPI nem os campos de texto com PII da PT.

---

## Achados transversais (fora dos 7 módulos, seguindo a cadeia de evidências)

### SGS-XM-SEC-002 — 8 handlers de escrita sem validação de body

Varredura própria sobre os **67 controllers compilados** (`dist`), cruzando `design:paramtypes` com o índice do `@Body()`:

```
67 controllers varridos | 153 handlers POST/PUT/PATCH com @Body
---
dist/infra/push/push.controller.js            :: PushController.subscribe()
dist/modules/ai/ai.controller.js              :: AiController.suggestAprRiskItems()
dist/modules/ai/sst-agent/sst-agent.controller.js :: SstAgentController.analyzeImageRisk()
dist/modules/aprs/aprs.controller.js          :: AprsController.getControlSuggestions()
dist/modules/dashboard/dashboard.controller.js:: DashboardController.invalidateDashboardCache()
dist/modules/rdos/rdos.controller.js          :: RdosController.savePdfLegacy()
dist/shared/base/base.controller.js           :: BaseController.create()  / .update()
```

Causa raiz comum: **tipo inline (`{ filename?: string }`) ou type parameter genérico** em vez de classe DTO. Nos dois casos o TypeScript emite `Object` e o `ValidationPipe` desiste.

Triagem por caminho de exploração:

- `RdosController.savePdfLegacy()` — **INFO, sem risco.** `markPdfSaved` ignora o body (`_body`) e sempre lança `GoneException` ([rdos.service.ts:2083-2098](backend/src/modules/rdos/rdos.service.ts#L2083)). É uma lápide de endpoint. Observação separada: o header `Sunset` é `Tue, 30 Jun 2026` — **já vencido**; a rota deveria ter sido removida.
- `PushController.subscribe()` — **MEDIUM.** O `endpoint` é uma URL arbitrária persistida e depois usada como destino de POST pelo web-push. Superfície de SSRF.
- `DashboardController.invalidateDashboardCache()` — **LOW/MEDIUM.** `queryType` cru chega a montagem de chave Redis.
- Os 3 de IA/APR — fora do escopo desta auditoria; registrados para o backlog.
- `BaseController` — coberto por `SGS-EPI-SEC-001` acima.

### SGS-XM-DB-002 — nenhum gate impede uma tabela nova nascer sem RLS

**Severidade:** 🟡 MEDIUM (risco de processo, não de estado atual)

As varreduras dinâmicas mais recentes — [325](backend/src/infra/database/migrations/1709000000325-rls-add-with-check.ts) e [334](backend/src/infra/database/migrations/1709000000334-ensure-rls-with-check.ts) — fazem **apenas `DROP POLICY` + `CREATE POLICY`**, sem `ENABLE`/`FORCE ROW LEVEL SECURITY`. As últimas a habilitar RLS dinamicamente foram a 021 e a 029. Uma tabela criada hoje com `company_id` e sem `ENABLE` explícito ficaria com **policy inerte** — o cenário exato que o enunciado desta auditoria alerta ("não considere RLS segura só porque existe uma policy").

O CI valida RLS de **uma única tabela**: `companies` ([ci.yml:435-444](.github/workflows/ci.yml#L435)). O `rls_force_tables` é apenas contado, sem piso.

`SGS-RF-SEC-012` (Relatório Fotográfico sem `site_id`) é a materialização desse risco: o módulo nasceu na 204, depois da 127, e ficou fora do mecanismo de isolamento por obra sem que nada acusasse.

**Correção:** assertion em CI que falha se **qualquer** tabela com `company_id` não tiver `relrowsecurity AND relforcerowsecurity` e uma policy com `WITH CHECK`; e se qualquer tabela com `company_id` **e** `site_id` não tiver a `site_scope_isolation_policy` RESTRICTIVE.

### SGS-XM-SEC-003 — invariante não escrita no cache de contexto RLS

**Severidade:** 🔵 LOW (hoje correto; frágil por construção)

[`TenantDbContextService:190`](backend/src/shared/database/tenant-db-context.service.ts#L190) pula o `set_config` quando a conexão emprestada já carrega o mesmo contexto. Isso só é seguro porque **todos** os 9 pontos do código que elevam `app.is_super_admin` usam `SET LOCAL` ou `set_config(..., true)` — verificado um a um. Um único `SET app.is_super_admin = 'true'` sem `LOCAL` introduzido no futuro vazaria privilégio para requisições seguintes que reutilizassem aquela conexão, silenciosamente.

**Correção:** teste que falha em `grep` por `SET +app\.` sem `LOCAL` fora de migrations; e comentário de invariante no próprio serviço.

---

_Os 68 achados ainda não confrontados estão nos relatórios por módulo (`01-dds.md` … `07-photo-report.md`), marcados com ⏳._
