# RDO — Relatório Diário de Obra — Relatório de Auditoria

> Escopo desta rodada: **Arquitetura · Backend · Banco · Segurança · Máquina de estados · Concorrência · Integridade documental · Observabilidade**.
> Frontend, Design/UX, PDF e Performance de carga ficaram para a rodada 2 (ver `00-master-audit.md` › Status).

## Resumo executivo

O módulo RDO é maduro em várias frentes: a race condition histórica em fotos de atividade FOI corrigida (attachActivityPhoto/removeActivityPhoto usam `mutateRdoContentLocked` com SELECT ... FOR UPDATE NOWAIT + retry, rdos.service.ts:1038-1079), todos os query builders filtram `deleted_at IS NULL` explicitamente (findPaginated:980, analytics:2431, exportExcel:2465), o DTO de criação tem @ValidateNested/@Type/@ArrayMaxSize/@IsEnum e bloqueia company_id, e o hardening de schema (migrations 184/327) trouxe CHECK de status, de intervalo de temperatura e de tipo jsonb. Porém o isolamento por obra é aplicado apenas na LEITURA: `create` e `update` validam site_id somente contra a empresa, permitindo que um usuário restrito à obra A crie ou mova RDOs para a obra B (o helper `isSiteVisibleToScope`, usado em NonConformities, nunca é chamado aqui). A trilha `rdo_audit_events` NÃO é imutável — a migration 187 cria explicitamente policies RLS de UPDATE e DELETE para o tenant, não existe trigger append-only (ao contrário de `forensic_trail_events`), e a FK é ON DELETE CASCADE, de modo que o hard delete feito por `RdosService.remove` apaga a trilha inteira do documento. `sign`, `update` e `updateStatus` operam sem lock nem versão otimista, e a decisão de invalidar assinaturas é tomada a partir de uma leitura obsoleta. Por fim, `POST /rdos/:id/send-email` aceita um array ilimitado de destinatários arbitrários, sem @ArrayMaxSize, sem allowlist e sem rate limit — expondo o PDF final governado para qualquer caixa externa e transformando o SGS em relay/amplificador de e-mail.

| Severidade | Confirmados |
|---|---|
| 🟠 HIGH | 4 |
| 🟡 MEDIUM | 6 |
| 🔵 LOW | 2 |

## Máquina de estados observada no código

## Máquina de estados observada NO CÓDIGO (rdos.service.ts:67-74, 1376-1424, 2327-2331, 2592-2645)

| De | Para | Onde | Quem | Pré-condições verificadas no código |
|---|---|---|---|---|
| (novo) | `rascunho` | `create` (1140) / `resolveStatusForCreate` (315) | ADMIN_GERAL, ADMIN_EMPRESA, TST, SUPERVISOR + `can_manage_rdos` | status só pode ser `rascunho`; `enviado`/`aprovado` no POST → 400 |
| `rascunho` | `enviado` | `updateStatus` (1376) | idem | `assertRdoDocumentMutable` (sem PDF final no registry) |
| `enviado` | `aprovado` | `updateStatus` (1376) | idem | `assertRdoSignaturesComplete` — exige `assinatura_responsavel` E `assinatura_engenheiro` |
| `enviado` | `rascunho` | `updateStatus` (1391-1394) | idem | reseta as duas assinaturas (`resetSignatures`, motivo `returned_to_draft`) |
| `aprovado` | — | `ALLOWED_STATUS_TRANSITIONS.aprovado = []` (70) | — | estado terminal via `/status` |
| `cancelado` | — | `ALLOWED_STATUS_TRANSITIONS.cancelado = []` (71) | — | terminal |
| `rascunho`/`enviado`/`aprovado` | `cancelado` | `cancel` (1416) | ADMIN_GERAL, ADMIN_EMPRESA, TST, SUPERVISOR | `CANCELABLE_STATUSES` (74) **E** `assertRdoDocumentMutable` (1418) → **na prática impossível se o PDF final já foi emitido** (ver SGS-RDO-BR-001) |
| `aprovado` (+2 assinaturas) | PDF final governado | `savePdf` (1589) | idem | `assertRdoReadyForFinalDocument` (2592): status = `aprovado` + 2 assinaturas |
| qualquer | assinado | `sign` (1489) | idem | status ≠ `rascunho`, ≠ `cancelado`, sem PDF final. **Sem lock; permite sobrescrever assinatura já existente** |
| `rascunho`/`enviado` | (hard delete) | `remove` (2317) | ADMIN_GERAL, ADMIN_EMPRESA, TST | bloqueia `aprovado`/`cancelado` (2327). **DELETE físico + CASCADE na trilha** |
| `aprovado` (conteúdo alterado) | `enviado` | `persistContentMutation` (1112-1116) e fotos (1765-1768) | idem | rebaixamento automático quando o snapshot muda |

### Trilha `rdo_audit_events` — operação → evento

| Operação | Evento gravado |
|---|---|
| `create` | `CREATED` |
| `update` | `UPDATED` (+ `SIGNATURES_RESET`) |
| `updateStatus` | `STATUS_CHANGED` (+ `SIGNATURES_RESET`) |
| `cancel` | `CANCELED` |
| `sign` | `SIGNED` |
| `savePdf` | `PDF_GENERATED` |
| `sendEmail` | `EMAIL_SENT` / `EMAIL_BLOCKED` |
| `attachActivityPhoto` / `removeActivityPhoto` | `ACTIVITY_PHOTO_UPLOADED` / `ACTIVITY_PHOTO_REMOVED` |
| `markPdfSaved` (legado) | `LEGACY_SAVE_PDF_ATTEMPT` |
| **`remove` (DELETE /rdos/:id)** | **NENHUM** (rótulo `REMOVED` existe em getAuditTrail:1472 mas nada o emite — e o CASCADE apaga tudo) |
| **`uploadVideoAttachment`** | **NENHUM** |
| **`removeVideoAttachment`** | **NENHUM** |
| **`downloadPdf` / `getPdfAccess`** | **NENHUM** |
| **`exportExcel` (dump de todos os RDOs do tenant)** | **NENHUM** |
| **`getWeeklyBundle` (download em lote dos PDFs finais)** | **NENHUM** |

## Achados

### 🟠 SGS-RDO-SEC-001 — send-email aceita lista ilimitada de destinatários arbitrários, sem allowlist e sem rate limit — exfiltração do PDF governado + relay/amplificação de e-mail

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Security |
| **Local** | `backend/src/modules/rdos/dto/send-email.dto.ts:3` |
| **Verificação adversarial** | CONFIRMED — CONFIRMADO com uma correção: o DTO VALIDA formato (`@IsArray()` + `@IsEmail({}, {each:true})`, send-email.dto.ts:4-6). O que não existe é `@ArrayMaxSize`, allowlist de domínio e `@Throttle` na rota (rdos.controller.ts:462-464). Como `can_manage_rdos` é concedido ao perfil `Operador / Colaborador` (migration 103:218), qualquer operador envia o PDF final governado para N endereços externos arbitrários. Exige PDF final emitido (`getPdfAccess` bloqueia sem ele, rdos.service.ts:2202). |

**Evidência**

DTO sem qualquer limite de cardinalidade ou domínio:

```ts
// send-email.dto.ts:3-7
export class SendEmailDto {
  @IsArray()
  @IsEmail({}, { each: true })
  to: string[];
}
```

Controlador só verifica que o array não é vazio e NÃO tem nenhum throttle (`grep -n "UserThrottle|TenantThrottle|Throttle" rdos.controller.ts` → zero resultados):

```ts
// rdos.controller.ts:462-475
@Post(':id/send-email')
@Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
@Authorize('can_manage_rdos')
sendEmail(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: SendEmailDto) {
  if (!body.to.length) { throw new BadRequestException('Informe pelo menos um destinatário para envio.'); }
  return this.rdosService.sendEmail(id, body.to);
}
```

Serviço enfileira um job por endereço, sem checar se o e-mail pertence à empresa/usuário do tenant:

```ts
// rdos.service.ts:2226-2254
for (const email of to) {
  try {
    await this.mailQueue.add('send-document', { documentId: rdo.id, documentType: 'RDO', email, companyId: rdo.company_id, tenantContext: workerTenantContext }, defaultJobOptions);
    queuedCount++;
  } catch (error) { ... await this.mailService.sendStoredDocument(rdo.id, 'RDO', email, rdo.company_id); }
}
```

Contraste no mesmo repo — Checklists envia para UM destinatário tipado como string (`src/modules/checklists/dto/send-checklist-email.dto.ts:5-9`), e o único limite global é `THROTTLER_API_LIMIT` = 100 req/min (`src/shared/throttler/resilient-throttler.service.ts:54`), que limita requisições, não destinatários.

Repro: autenticar como TST/SUPERVISOR com `can_manage_rdos`; emitir o PDF final de um RDO; `POST /rdos/<id>/send-email` com `{"to": ["atacante@gmail.com", ...10000 endereços...]}` → 10.000 jobs BullMQ com o PDF final anexado, em uma única requisição dentro do limite de 100 req/min.

**Impacto** — Dois impactos distintos. (1) Exfiltração: o PDF final governado do RDO — que contém mão de obra, ocorrências, acidentes e dados de responsáveis — é entregue a qualquer caixa externa escolhida pelo usuário, sem registro de autorização e sem restrição de domínio. (2) Abuso de infraestrutura: um usuário autenticado usa o SGS como relay/amplificador; 100 req/min × N destinatários satura a fila `mail`, queima a cota do Resend e derruba a reputação de envio do domínio verificado, afetando e-mails transacionais críticos (recuperação de senha, onboarding) de TODOS os tenants.

**Causa raiz** — O DTO trata `to` como dado livre do cliente. Não há @ArrayMaxSize, não há verificação de que o destinatário pertence ao tenant (usuário/contato cadastrado) e o endpoint não recebeu os decorators @UserThrottle/@TenantThrottle usados em outras rotas de escrita cara (ex.: checklists.controller.ts:247-249).

**Correção recomendada**

1) Limitar e normalizar o DTO:
```ts
export class SendEmailDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10, { message: 'Máximo de 10 destinatários por envio.' })
  @Transform(({ value }) => Array.isArray(value) ? Array.from(new Set(value.map(v => typeof v === 'string' ? v.trim().toLowerCase() : v))) : value)
  @IsEmail({}, { each: true })
  @MaxLength(254, { each: true })
  to: string[];
}
```
2) No serviço, antes do loop, validar cada destinatário contra os usuários ativos da empresa (ou uma allowlist de domínios do tenant em `tenant_policies`), rejeitando com 400 os que não pertencem ao escopo — e registrando `EMAIL_RECIPIENT_REJECTED` na trilha.
3) Aplicar rate limit por ator e por tenant no endpoint: `@UserThrottle({ requestsPerMinute: 5 })` + `@TenantThrottle({ requestsPerMinute: 20, requestsPerHour: 100 })`, seguindo o padrão de checklists.controller.ts:247-249.

**Teste de regressão** — `rdos.controller.spec.ts`: (a) POST /rdos/:id/send-email com 11 destinatários → 400 e `rdosService.sendEmail` não chamado; (b) `rdos.service.spec.ts`: `sendEmail` com um e-mail fora do tenant → BadRequestException e `mailQueue.add` não invocado; (c) teste de contrato garantindo que `SendEmailDto` possui metadata @ArrayMaxSize (evita remoção silenciosa), no molde de `aprs/dto/create-apr.dto.spec.ts:57`.

---

### 🟡 SGS-RDO-SEC-002 — Isolamento por obra (site_id) só é aplicado na leitura: create e update permitem gravar/mover RDO para obra fora do escopo do usuário

| | |
|---|---|
| **Severidade** | MEDIUM _(ajustada de HIGH na verificação)_ |
| **Categoria** | Security |
| **Local** | `backend/src/modules/rdos/rdos.service.ts:247` |
| **Verificação adversarial** | CONFIRMED_PARCIAL — PARCIALMENTE CONFIRMADO — severidade REBAIXADA de HIGH para MEDIUM, pelo mesmo motivo de SGS-PT-SEC-004: `rdos` tem `site_id` e portanto está sob a policy RESTRICTIVE de obra com `WITH CHECK`. O banco barra a gravação cross-site. Permanece a ausência de validação na aplicação e a falha com 500 em vez de 403. |

**Evidência**

A validação de escopo em escrita checa apenas a EMPRESA, nunca as obras autorizadas do ator:

```ts
// rdos.service.ts:247-266
private async validateRelatedEntityScope(input: { companyId: string; siteId?: string | null; responsavelId?: string | null; }): Promise<void> {
  await Promise.all([
    this.assertCompanyScopedEntityId(Site, input.companyId, input.siteId, 'Site'),
    this.assertCompanyScopedEntityId(User, input.companyId, input.responsavelId, 'Responsável'),
  ]);
}
// 234-238: exist({ where: { id, company_id: companyId } })  ← só company_id
```

`create` chama `resolveCompanyIdForCreate()` (268-271), que descarta `siteIds`/`siteScope`, e passa direto para `validateRelatedEntityScope`:
```ts
// rdos.service.ts:1140-1147
const companyId = this.resolveCompanyIdForCreate();
const normalizedPayload = this.normalizeRdoPayload(createRdoDto);
await this.validateRelatedEntityScope({ companyId, siteId: normalizedPayload.site_id, responsavelId: normalizedPayload.responsavel_id });
```

`update` idem, usando `rdo.company_id` e aceitando o novo `site_id` do payload:
```ts
// rdos.service.ts:1314-1324
await this.validateRelatedEntityScope({
  companyId: rdo.company_id,
  siteId: normalizedPayload.site_id !== undefined ? normalizedPayload.site_id : rdo.site_id,
  ...
});
```

A LEITURA, em contraste, é rigorosa — o que prova a intenção de isolar por obra:
```ts
// rdos.service.ts:1284-1290 (findOne)
if (!isSuperAdmin && siteScope !== 'all' && (!rdo.site_id || !siteIds.includes(rdo.site_id))) {
  throw new NotFoundException(`RDO com ID ${id} não encontrado`);
}
// 1243-1245 (findPaginated), 2432-2434 (analytics), 2466-2468 (exportExcel): andWhere('rdo.site_id IN (:...siteIds)')
```

O helper correto existe e é importado no módulo de escopo (`src/shared/tenant/site-access-scope.util.ts:91-103 isSiteVisibleToScope`) e é usado por NonConformities em create E update:
```ts
// nonconformities.service.ts:1196-1199
if (!isSiteVisibleToScope(payload.site_id, scope)) { throw new BadRequestException('Não conformidade deve ser criada em uma obra autorizada para o usuário.'); }
// nonconformities.service.ts:1465-1471
if (payload.site_id !== undefined && !isSiteVisibleToScope(payload.site_id, scope)) { throw new BadRequestException('Não conformidade não pode ser movida para uma obra não autorizada.'); }
```
RDO não faz nenhuma das duas. Além disso a RLS do Postgres não cobre isso: a policy de `rdos` é apenas `company_id = current_company() OR is_super_admin()` (migration 1709000000177 linhas 27-31 e 82-90), e a migration 172 removeu as antigas policies de site (`1709000000172-harden-site-scope-policies-and-drop-duplicate-indexes.ts:26-36`).

Repro: usuário com perfil não-company-wide (siteScope='single') vinculado à obra A. `POST /rdos` com `{"data":"2026-08-14","site_id":"<uuid-da-obra-B>"}` → 201. O RDO é gravado na obra B. Depois, `PATCH /rdos/<id-de-um-RDO-da-obra-A>` com `{"site_id":"<uuid-da-obra-B>"}` → 200, o documento sai do escopo do usuário e entra no da obra B.

**Impacto** — Escapada de escopo de obra em ESCRITA num SaaS cuja separação por obra é requisito operacional (encarregado de uma obra não deve tocar em documentos de outra). Um usuário de obra A: (a) injeta RDOs falsos/ruidosos no acervo regulatório da obra B, que serão contabilizados no dashboard, no Excel e no bundle semanal da obra B; (b) faz um RDO legítimo da obra A desaparecer do escopo da obra A movendo-o para B (ele próprio perde acesso, mas o registro da obra A fica com um buraco); (c) como a RLS do banco só filtra por empresa, não há rede de proteção alguma abaixo da aplicação.

**Causa raiz** — `validateRelatedEntityScope` foi escrita para prevenir IDOR cross-tenant (empresa) e nunca foi estendida ao eixo obra, apesar de `getTenantContextOrThrow()` já devolver `siteIds`/`siteScope`/`isSuperAdmin` e do helper `isSiteVisibleToScope` existir. A RLS de `rdos` também degradou para escopo apenas de empresa na migration 172.

**Correção recomendada**

Em `rdos.service.ts`, aplicar o mesmo padrão de NonConformities:
```ts
// em create(), após resolver o payload
const scope = this.getTenantContextOrThrow();
if (!isSiteVisibleToScope(normalizedPayload.site_id, { hasCompanyWideAccess: scope.isSuperAdmin || scope.siteScope === 'all', siteId: scope.siteId, siteIds: scope.siteIds })) {
  throw new BadRequestException('RDO deve ser criado em uma obra autorizada para o usuário.');
}

// em update(), antes de Object.assign (linha 1333)
if (normalizedPayload.site_id !== undefined && !isSiteVisibleToScope(normalizedPayload.site_id, scopeShape)) {
  throw new BadRequestException('RDO não pode ser movido para uma obra não autorizada.');
}
```
Recomenda-se ainda repor a defesa em profundidade no banco, adicionando `current_site_scope()`/`current_site_ids()` (já existentes, migrations 309/367) ao WITH CHECK da policy de `rdos`.

**Teste de regressão** — `rdos.service.spec.ts`: com TenantService mockado em `{ siteScope:'single', siteIds:['site-A'], isSuperAdmin:false }` — (a) `create({ data, site_id:'site-B' })` → BadRequestException e `rdosRepository.save` não chamado; (b) `update(id, { site_id:'site-B' })` sobre RDO da obra A → BadRequestException; (c) regressão positiva: `create({ site_id:'site-A' })` continua 201.

---

### 🟠 SGS-RDO-INT-001 — rdo_audit_events NÃO é imutável: a RLS cria explicitamente policies de UPDATE e DELETE para o tenant e não há trigger append-only

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Integrity |
| **Local** | `backend/src/infra/database/migrations/1709000000187-classify-writable-runtime-rls.ts:89` |
| **Verificação adversarial** | CONFIRMED — CONFIRMADO. A migration 187:268-275 cria explicitamente `rls_parent_tenant_update` (FOR UPDATE ... WITH CHECK) e `rls_parent_tenant_delete` (FOR DELETE) sobre `rdo_audit_events`. Busca por trigger append-only nas 298 migrations: nenhuma. Uma tabela cuja única razão de existir é imutabilidade forense é declarada gravável para o role de runtime. |

**Evidência**

A tabela recebe as quatro policies do template genérico, incluindo UPDATE e DELETE:

```ts
// 1709000000187-classify-writable-runtime-rls.ts:89-96
await this.enableParentTenantPolicy(queryRunner, {
  tableName: 'rdo_audit_events',
  parentTable: 'rdos', parentColumn: 'id', childColumn: 'rdo_id',
  parentTenantColumn: 'company_id', allowGlobalParentRead: false,
});
```
```ts
// mesma migration, 259-276 (corpo de enableParentTenantPolicy)
{ name: 'rls_parent_tenant_update',
  sql: `CREATE POLICY "rls_parent_tenant_update" ON ${table} FOR UPDATE USING ${writeExpression} WITH CHECK ${writeExpression}` },
{ name: 'rls_parent_tenant_delete',
  sql: `CREATE POLICY "rls_parent_tenant_delete" ON ${table} FOR DELETE USING ${writeExpression}` },
```
Onde `writeExpression` é apenas `EXISTS (SELECT 1 FROM rdos p WHERE p.id = rdo_audit_events.rdo_id AND (p.company_id = current_company() OR is_super_admin()))` (250-257). Ou seja: qualquer sessão do runtime com o tenant correto pode fazer UPDATE/DELETE nos eventos de auditoria.

O GRANT de tabela também permite: `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sgs_app` (`1709000000152-grant-runtime-role-privileges.ts:14`) e o DEFAULT PRIVILEGES equivalente (linha 24).

A migration de criação (105) não instala nenhuma trava:
```sql
-- 1709000000105-create-rdo-audit-events.ts:8-17 — só tabela, PK, FKs e índice.
```

Contraste explícito: a trilha forense do mesmo projeto É protegida por trigger:
```sql
-- 1709000000060-create-forensic-trail-events.ts:44-62
CREATE OR REPLACE FUNCTION prevent_forensic_trail_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'forensic_trail_events is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "TRG_forensic_trail_events_append_only"
  BEFORE UPDATE OR DELETE ON "forensic_trail_events" FOR EACH ROW
  EXECUTE FUNCTION prevent_forensic_trail_mutation();
```
Não existe equivalente para `rdo_audit_events` (`grep -rn "rdo_audit_events" src/` retorna apenas a migration 105, a 187 e a entity).

Repro: com a role de runtime `sgs_app` e `app.current_company_id` do tenant, `UPDATE rdo_audit_events SET details = '{}'::jsonb, event_type = 'CREATED' WHERE rdo_id = '<id>';` e `DELETE FROM rdo_audit_events WHERE rdo_id = '<id>' AND event_type = 'SIGNED';` — ambos autorizados pela policy e pelo GRANT.

**Impacto** — A trilha de auditoria exibida em `GET /rdos/:id/audit` não tem valor probatório: qualquer caminho de código com acesso ao EntityManager (ou qualquer SQL injection que atinja o runtime) pode reescrever ou apagar seletivamente eventos de assinatura, cancelamento e emissão de PDF, sem deixar rastro. Em um sistema de SST usado como prova em fiscalização/perícia, uma trilha adulterável é pior que trilha ausente, porque induz confiança indevida.

**Causa raiz** — `rdo_audit_events` foi classificada na migration 187 pelo template genérico de tabela filha com tenant herdado (`enableParentTenantPolicy`), pensado para dados operacionais editáveis, e não pelo template de tabela append-only. Ninguém reaproveitou o padrão `prevent_forensic_trail_mutation` já existente no projeto.

**Correção recomendada**

Nova migration (append-only + retirada de privilégio):
```sql
CREATE OR REPLACE FUNCTION public.prevent_rdo_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'rdo_audit_events is append-only'; END; $$;

DROP TRIGGER IF EXISTS "TRG_rdo_audit_events_append_only" ON "rdo_audit_events";
CREATE TRIGGER "TRG_rdo_audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "rdo_audit_events"
  FOR EACH ROW EXECUTE FUNCTION public.prevent_rdo_audit_mutation();

DROP POLICY IF EXISTS "rls_parent_tenant_update" ON "rdo_audit_events";
DROP POLICY IF EXISTS "rls_parent_tenant_delete" ON "rdo_audit_events";
REVOKE UPDATE, DELETE ON "rdo_audit_events" FROM sgs_app;
```
Atenção: isso interage com SGS-RDO-INT-002 — trocar o `ON DELETE CASCADE` da FK antes (ou junto), senão o hard delete de RDO passa a falhar com a exceção do trigger.

**Teste de regressão** — Teste de integração contra Postgres real (docker-compose.test.yml), após `SET app.current_company_id`: (a) `expect(UPDATE rdo_audit_events ...)` rejeita com 'is append-only'; (b) `expect(DELETE FROM rdo_audit_events ...)` rejeita; (c) INSERT via `RdoAuditService.recordEvent` continua funcionando; (d) asserção de schema: `SELECT policyname FROM pg_policies WHERE tablename='rdo_audit_events'` não contém `rls_parent_tenant_update`/`rls_parent_tenant_delete`.

---

### 🟠 SGS-RDO-INT-002 — DELETE /rdos/:id faz hard delete (apesar de o módulo ter soft-delete) e o CASCADE apaga toda a trilha rdo_audit_events do documento

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/rdos/rdos.service.ts:2354` |
| **Verificação adversarial** | CONFIRMED — CONFIRMADO. `rdosRepository.remove(rdo)` (rdos.service.ts:2354) é hard delete — apesar de o módulo ter soft-delete — e `rdo_audit_events.rdo_id` foi criada com `ON DELETE CASCADE` (migration 105:29-30). Excluir um RDO apaga a trilha inteira. Existe um `DOCUMENT_HARD_REMOVED` na trilha forense, mas ele é `.catch()`-ado (fail-open) e não preserva o conteúdo dos eventos perdidos. |

**Evidência**

A entidade tem soft-delete (`Rdo extends BaseAuditEntity`, e `base-audit.entity.ts:28-29` declara `@DeleteDateColumn() deleted_at`), e o próprio serviço documenta que RDOs soft-deletados existem em produção:
```ts
// rdos.service.ts:974-979 (comentário em applyFindPaginatedFilters)
// RDO tem soft-delete (deleted_at, incluído no gdpr_delete_user_data).
// createQueryBuilder NÃO filtra deleted_at automaticamente ...
```
Mas `remove()` usa `Repository.remove` (DELETE físico), não `softRemove`:
```ts
// rdos.service.ts:2354
await this.rdosRepository.remove(rdo);
```
E a FK da trilha é CASCADE:
```sql
-- 1709000000105-create-rdo-audit-events.ts:27-30
ALTER TABLE "rdo_audit_events"
  ADD CONSTRAINT "FK_rdo_audit_events_rdo_id"
  FOREIGN KEY ("rdo_id") REFERENCES "rdos"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
```
(confirmado também na entity: `rdo-audit-event.entity.ts:22 @ManyToOne(() => Rdo, { onDelete: 'CASCADE' })`)

Além disso, `remove()` (2317-2397) não grava nenhum evento em `rdo_audit_events` — nenhuma chamada a `rdoAuditService` no método — embora o rótulo exista no mapa de tradução: `REMOVED: 'Removido'` (rdos.service.ts:1472). Só sobram os eventos grossos em `forensic_trail_events` (`DOCUMENT_HARD_REMOVED`, 2369-2380) e o `@ForensicAuditAction('delete','rdo')` do controller (rdos.controller.ts:492).

Repro: criar RDO, mudar para `enviado`, assinar (gera `SIGNED`), depois `DELETE /rdos/<id>` como TST → `SELECT count(*) FROM rdo_audit_events WHERE rdo_id='<id>'` = 0. Toda a cronologia (CREATED, UPDATED, STATUS_CHANGED, SIGNED, ACTIVITY_PHOTO_*) desaparece do banco.

**Impacto** — Perda irreversível de evidência: um usuário TST (que nem é admin) apaga fisicamente um relatório diário de obra em `rascunho`/`enviado` e, junto, toda a trilha detalhada de quem criou, quem editou, quem assinou e quando — inclusive os eventos de assinatura de RDOs que chegaram a ser assinados antes de voltar para rascunho. Contradiz o desenho de soft-delete do próprio módulo (que o GDPR e o dashboard assumem) e quebra a retenção documental de SST. Sobram apenas eventos agregados na trilha forense, sem o detalhe por operação.

**Causa raiz** — O método de exclusão nunca foi migrado para `softRemove` quando a coluna `deleted_at` foi adicionada (migration 1709000000109-add-soft-delete-operational-tables), e a FK da trilha foi criada com CASCADE — combinação que transforma exclusão de documento em destruição de auditoria. A ausência de evento `REMOVED` é o sintoma visível (o rótulo existe, o emissor não).

**Correção recomendada**

1) Trocar por soft delete, preservando as compensações de storage/registry já existentes:
```ts
// rdos.service.ts:2354
await this.rdosRepository.softRemove(rdo);
```
(e ajustar `generateNumero`/uniques: o índice já é parcial `UQ_rdos_company_numero_active WHERE deleted_at IS NULL`, migration 348:59-61).
2) Gravar o evento antes da exclusão:
```ts
await this.rdoAuditService.recordEvent(rdo.id, 'REMOVED', { status: removedStatus, hadFinalPdf: hadFinalPdfBeforeRemove, activityPhotoCount: activityPhotoCountBeforeRemove });
```
3) Migration: trocar `ON DELETE CASCADE` por `ON DELETE RESTRICT` na FK `FK_rdo_audit_events_rdo_id`, de modo que nenhum caminho futuro consiga apagar a trilha por efeito colateral.

**Teste de regressão** — `rdos.service.spec.ts`: (a) `remove()` chama `rdosRepository.softRemove` e NÃO `remove`; (b) `rdoAuditService.recordEvent` é chamado com `'REMOVED'`; (c) teste de integração com Postgres: após `DELETE /rdos/:id`, `SELECT count(*) FROM rdo_audit_events WHERE rdo_id=$1` > 0 e `SELECT deleted_at FROM rdos WHERE id=$1` IS NOT NULL; (d) `findOne`/`findPaginated` não retornam o RDO removido.

---

### 🟠 SGS-RDO-CON-001 — sign/update/updateStatus sem lock nem versão otimista: a decisão de invalidar assinaturas é tomada sobre leitura obsoleta (o padrão de lock existe no mesmo arquivo, mas só é usado em fotos)

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Concurrency |
| **Local** | `backend/src/modules/rdos/rdos.service.ts:1489` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`sign` lê e grava sem lock nenhum:
```ts
// rdos.service.ts:1498-1551
const rdo = await this.findOne(id);           // leitura sem FOR UPDATE
...
if (body.tipo === 'responsavel') { rdo.assinatura_responsavel = sigData; } else { rdo.assinatura_engenheiro = sigData; }
const saved = await this.rdosRepository.manager.transaction(async (manager) => {
  const persisted = await manager.getRepository(Rdo).save(rdo);   // transação abre DEPOIS da leitura
```
`update` decide o reset de assinatura a partir de um estado lido antes:
```ts
// rdos.service.ts:1296-1333
const rdo = await this.findOne(id);
...
const hadSignatures = Boolean(rdo.assinatura_responsavel || rdo.assinatura_engenheiro);   // 1328-1330
Object.assign(rdo, { ...normalizedPayload, company_id: rdo.company_id });                  // 1333
// e em persistContentMutation (1108-1118):
const signaturesReset = input.hadSignaturesBeforeChange && contentChanged ? this.resetSignatures(rdo, 'content_changed') : false;
const saved = await this.rdosRepository.save(rdo);
```
`updateStatus` idem (1377-1395): `findOne` → mutação em memória → `save`, sem lock.

O padrão CORRETO existe no mesmo arquivo e é usado apenas nas fotos:
```ts
// rdos.service.ts:1051-1054 (mutateRdoContentLocked)
const rows = await manager.query<Rdo[]>(
  `SELECT * FROM "rdos" WHERE "id" = $1 AND "company_id" = $2 AND "deleted_at" IS NULL FOR UPDATE NOWAIT`, [id, companyId]);
```
e a entidade `Rdo` não tem `@VersionColumn` (rdo.entity.ts:51-153 — nenhuma).

Agravante: o `document_hash` que a assinatura grava (`rdos.service.ts:1517,1532`) NUNCA é lido/verificado em lugar nenhum do backend — `grep -rn "document_hash" src/ | grep -v spec` retorna somente as 4 linhas de ESCRITA em rdos.service.ts (160, 1532, 1566, 1580). Não existe rotina que compare `assinatura.document_hash` com `buildSnapshotHash(rdo)` atual.

Repro (janela real): T0 usuário A `PATCH /rdos/:id/sign {tipo:'responsavel'}` executa `findOne`; T1 usuário B `PATCH /rdos/:id` alterando `ocorrencias` — seu `findOne` vê assinaturas nulas, logo `hadSignatures=false`; T2 A grava a assinatura; T3 B grava o conteúdo novo com `signaturesReset=false` e nenhum evento `SIGNATURES_RESET`. Resultado: ou a assinatura de A é sobrescrita para NULL pelo diff do `save()` de B (assinatura destruída sem evento), ou sobrevive atestando conteúdo que mudou — e nada no sistema detecta, porque `document_hash` jamais é conferido.

**Impacto** — Quebra da amarração assinatura↔conteúdo, que é a única garantia de integridade documental do RDO antes da emissão do PDF. Nos dois desfechos possíveis da corrida há dano: assinatura apagada silenciosamente (sem `SIGNATURES_RESET` na trilha, contrariando o invariante que o resto do código sustenta), ou assinatura válida em cima de conteúdo alterado — que depois é promovido a `aprovado` (updateStatus só exige que os dois campos estejam preenchidos, 1386-1388) e vira PDF final governado com hash registrado. Como `document_hash` nunca é verificado, a divergência é permanente e indetectável.

**Causa raiz** — `mutateRdoContentLocked` foi introduzido para corrigir a race das fotos JSONB, mas os outros três caminhos de mutação da mesma linha (`update`, `updateStatus`, `sign`) continuaram com read-modify-write sem lock e sem `@VersionColumn`. E o `document_hash` foi projetado como prova de integridade mas nenhum verificador foi implementado.

**Correção recomendada**

1) Rotear `sign`, `update` e `updateStatus` por `mutateRdoContentLocked`, recomputando dentro do lock:
```ts
async sign(id, body, actorUserId) {
  const rdo = await this.findOne(id);                 // mantém a checagem de escopo de obra
  await this.assertRdoDocumentMutable(rdo);
  return this.mutateRdoContentLocked(id, rdo.company_id, async (locked, manager) => {
    this.assertRdoNotCancelled(locked, 'assinado');
    if (locked.status === 'rascunho') throw new BadRequestException(...);
    // hash e payload calculados sobre `locked`, não sobre a leitura de fora
    ...
    return manager.getRepository(Rdo).save(locked);
  });
}
```
(mesma transformação em `update`: `hadSignatures` e `previousSnapshot` devem sair de `locked`, não de `findOne`).
2) Adicionar `@VersionColumn()` em `Rdo` + migration, para defesa em profundidade contra lost update.
3) Implementar a verificação que falta: em `getValidationContext`/`getPdfAccess`, comparar `JSON.parse(assinatura).document_hash` com `this.buildSnapshotHash(rdo)` e expor `signatureIntegrity: 'match' | 'stale'`, além de gravar `SIGNATURE_INTEGRITY_MISMATCH` na trilha quando divergir.

**Teste de regressão** — `rdos.service.spec.ts`: (a) `sign` chama `mutateRdoContentLocked` (spy) e o `save` ocorre com a entidade travada; (b) simular concorrência mockando `manager.query` do lock para devolver uma linha JÁ com `assinatura_responsavel` preenchida enquanto o `findOne` externo devolveu null → `update` deve computar `hadSignatures=true`, resetar e emitir `SIGNATURES_RESET`; (c) novo teste de `verifySignatureIntegrity`: assinatura cujo `document_hash` ≠ snapshot atual → status `stale`.

---

### 🟡 SGS-RDO-INT-003 — O PDF final governado são bytes arbitrários do cliente: nada vincula o conteúdo do PDF ao estado do RDO, e após o registro o documento fica congelado

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/rdos/rdos.service.ts:1589` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`savePdf` aceita o arquivo enviado pelo cliente e o promove a documento final, calculando o hash sobre esses mesmos bytes:
```ts
// rdos.service.ts:1589-1649
async savePdf(id: string, file: Express.Multer.File) {
  const rdo = await this.findOne(id);
  await this.assertRdoDocumentMutable(rdo);
  this.assertRdoReadyForFinalDocument(rdo);          // só checa status 'aprovado' + 2 assinaturas
  ...
  await this.documentStorageService.uploadFile(fileKey, file.buffer, file.mimetype);
  await this.documentGovernanceService.registerFinalDocument({ ..., fileBuffer: file.buffer, ... });
```
O hash registrado é do buffer enviado: `document-governance.service.ts:122 const hash = this.pdfService.computeHash(input.fileBuffer);`. As únicas validações do arquivo são de formato/antivírus, no controller:
```ts
// rdos.controller.ts:358-373
@UseInterceptors(FileInterceptor('file', createGovernedPdfUploadOptions()))
const pdfFile = await assertUploadedPdf(file, undefined, this.fileInspectionService);
return await this.rdosService.savePdf(id, pdfFile);
```
Não existe geração server-side nem comparação com o estado do RDO. Depois do registro, o documento é congelado — qualquer edição passa a ser bloqueada:
```ts
// rdos.service.ts:2607-2622 (assertRdoDocumentMutable)
const registryEntry = await this.documentRegistryService.findByDocument('rdo', rdo.id, 'pdf', rdo.company_id);
if (registryEntry) { throw new BadRequestException('RDO com PDF final emitido está bloqueado para edição...'); }
```
E o código de validação pública é determinístico sobre id/data (`buildValidationCode`, 2556-2561), de modo que o QR valida o par código↔hash sem nunca confrontar o conteúdo do PDF com as colunas do RDO.

Repro: levar um RDO a `aprovado` com as duas assinaturas; `POST /rdos/<id>/file` com um PDF cujo texto contradiz o registro (ex.: sem a ocorrência de acidente que está em `ocorrencias`/`houve_acidente=true`) → 201, hash registrado, `document_registry` ACTIVE, RDO congelado. `GET /rdos/<id>` continua mostrando o acidente; o PDF distribuído e validável por QR, não.

**Impacto** — O artefato distribuído a cliente/fiscalização (o PDF, com selo de hash e validação pública) pode divergir arbitrariamente do registro auditável no banco, e a divergência se torna permanente porque o RDO fica imutável logo após a emissão. Em SST isso é material: um RDO cuja coluna registra acidente/paralisação pode ser emitido com um PDF que os omite, e a plataforma carimba esse PDF como 'documento final governado' verificado.

**Causa raiz** — O PDF do RDO é gerado no frontend (pdf-system) e apenas transportado para o backend; a governança implementada é de INTEGRIDADE DO ARQUIVO (hash imutável do que foi enviado), não de FIDELIDADE AO REGISTRO. Não há binding entre `buildSnapshotHash(rdo)` e o conteúdo do PDF em nenhum ponto da cadeia.

**Correção recomendada**

Amarrar o artefato ao estado do documento. Mínimo viável, sem migrar para geração server-side: (1) gravar o snapshot do RDO no momento da emissão junto ao registry — passar `metadata: { snapshotHash: this.buildSnapshotHash(rdo), snapshot: this.buildSignatureTrackedSnapshot(rdo) }` para `registerFinalDocument`; (2) exigir que o cliente envie o `snapshotHash` sobre o qual renderizou o PDF e rejeitar com 409 se não bater com o estado atual do servidor:
```ts
async savePdf(id: string, file: Express.Multer.File, expectedSnapshotHash: string) {
  const rdo = await this.findOne(id);
  if (this.buildSnapshotHash(rdo) !== expectedSnapshotHash) {
    throw new ConflictException('O PDF enviado foi gerado sobre uma versão diferente do RDO. Regere o documento.');
  }
  ...
}
```
(3) na validação pública, devolver o snapshot registrado junto do hash, para que o verificador possa confrontar PDF × registro. A solução definitiva é renderizar o PDF no worker a partir do snapshot, como já se faz em APR/Relatório Fotográfico com Puppeteer.

**Teste de regressão** — `rdos.service.spec.ts`: (a) `savePdf` com `expectedSnapshotHash` divergente → ConflictException e `documentStorageService.uploadFile` não chamado; (b) `savePdf` com hash correto → `registerFinalDocument` recebe `metadata.snapshotHash` igual a `buildSnapshotHash(rdo)`; (c) teste de contrato garantindo que o registry do RDO persiste o snapshot.

---

### 🟡 SGS-RDO-BR-001 — RDO com PDF final emitido não pode ser cancelado NEM excluído — beco sem saída que contradiz CANCELABLE_STATUSES e a documentação

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | StateMachine |
| **Local** | `backend/src/modules/rdos/rdos.service.ts:1418` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`cancel` aplica a trava de imutabilidade documental antes de checar os estados canceláveis:
```ts
// rdos.service.ts:1416-1424
async cancel(id: string, reason: string): Promise<Rdo> {
  const rdo = await this.findOne(id);
  await this.assertRdoDocumentMutable(rdo);            // ← 1418: lança se existir registry entry
  if (!CANCELABLE_STATUSES.has(rdo.status)) { throw new BadRequestException(`Transição de "${rdo.status}" para "cancelado" não permitida.`); }
```
e `assertRdoDocumentMutable` lança sempre que o PDF final foi emitido (2607-2622). Como o PDF só pode ser emitido em status `aprovado` (`assertRdoReadyForFinalDocument`, 2598-2602), TODO RDO que chegou à emissão final se torna incancelável — apesar de `aprovado` estar explicitamente na lista de estados canceláveis:
```ts
// rdos.service.ts:74
const CANCELABLE_STATUSES = new Set(['rascunho', 'enviado', 'aprovado']);
```
E a documentação afirma o mesmo: `docs/state-machines.md:142` — "Cancelável de qualquer estado (rascunho, enviado, aprovado → cancelado)."

A exclusão também está fechada, e sua mensagem manda usar justamente o cancelamento que está bloqueado:
```ts
// rdos.service.ts:2327-2331
if (rdo.status === 'aprovado' || rdo.status === 'cancelado') {
  throw new BadRequestException('RDOs aprovados ou cancelados não podem ser excluídos fisicamente. Utilize o cancelamento explícito.');
}
```

Repro: aprovar um RDO, emitir o PDF final via `POST /rdos/:id/file`, então `POST /rdos/:id/cancel {reason:'...'}` → 400 'RDO com PDF final emitido está bloqueado para edição'. `DELETE /rdos/:id` → 400 apontando para o cancelamento. Não existe nenhuma outra rota que mude o status.

**Impacto** — Um RDO emitido por engano (data errada, obra errada, conteúdo incorreto detectado após a emissão) fica permanentemente ativo e válido: aparece na listagem, nas métricas, no Excel, no bundle semanal e continua com validação pública positiva por QR. Não há nenhum caminho de retratação no produto — que é exatamente o cenário para o qual o cancelamento existe. Também impede a correção regulatória exigida quando um relatório diário de obra sai com informação errada.

**Causa raiz** — `assertRdoDocumentMutable` protege contra EDIÇÃO DE CONTEÚDO após a emissão, e foi reutilizada em `cancel` — mas cancelar não é editar conteúdo: é uma transição de ciclo de vida que deveria ser justamente o mecanismo de retratação de um documento já emitido.

**Correção recomendada**

Remover a chamada em `cancel` e substituir por uma trava específica que permita a retratação com rastro forte:
```ts
async cancel(id: string, reason: string): Promise<Rdo> {
  const rdo = await this.findOne(id);
  if (!CANCELABLE_STATUSES.has(rdo.status)) { throw new BadRequestException(...); }
  const hadFinalDocument = Boolean(await this.documentRegistryService.findByDocument('rdo', rdo.id, 'pdf', rdo.company_id));
  // se hadFinalDocument: exigir motivo mínimo, marcar o registry como CANCELED/superseded
  //   e registrar FORENSIC_EVENT_TYPES.DOCUMENT_CANCELED com { hadFinalDocument: true }
  ...
}
```
O conteúdo do RDO continua imutável (o `update`/`sign`/fotos seguem bloqueados por `assertRdoDocumentMutable`), mas o status passa a `cancelado` e o registry deixa de ser ACTIVE, retirando o documento da validação pública e dos bundles.

**Teste de regressão** — `rdos.service.spec.ts`: (a) RDO `aprovado` COM entry no registry → `cancel` retorna status `cancelado` e emite `DOCUMENT_CANCELED` com `hadFinalDocument: true`; (b) o mesmo RDO cancelado continua rejeitando `update`, `sign` e `attachActivityPhoto` com 400; (c) `documentRegistryService` recebe a marcação de cancelamento (o documento sai de `listFinalDocuments`).

---

### 🟡 SGS-RDO-BR-002 — generateNumero usa MAX() sobre string com padding de 3 dígitos: a criação de RDOs quebra permanentemente ao chegar em 1000 no mês

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | BusinessRule |
| **Local** | `backend/src/modules/rdos/rdos.service.ts:383` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

```ts
// rdos.service.ts:383-395
private async generateNumero(companyId: string): Promise<string> {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `RDO-${yyyymm}-`;
  const last = await this.rdosRepository.createQueryBuilder('rdo')
    .select('MAX(rdo.numero)', 'max')                       // ← MAX lexicográfico de varchar
    .where('rdo.company_id = :companyId', { companyId })
    .andWhere('rdo.numero LIKE :prefix', { prefix: `${prefix}%` })
    .getRawOne<{ max: string | null }>();
  const lastSeq = last?.max ? Number(last.max.slice(prefix.length)) || 0 : 0;
  return `${prefix}${String(lastSeq + 1).padStart(3, '0')}`;   // ← padding fixo de 3
}
```
A coluna é `varchar` (migration 1709000000025-create-rdos.ts:8) e o índice único é `(company_id, numero)` parcial (`1709000000348-partial-unique-indexes-soft-delete.ts:59-61`, `UQ_rdos_company_numero_active`).

Trace determinístico: com 999 RDOs no mês, MAX = 'RDO-202608-999' → lastSeq=999 → grava 'RDO-202608-1000' (OK). Na criação seguinte, o MAX lexicográfico compara 'RDO-202608-1000' com 'RDO-202608-999' no caractere após o prefixo: '1'(0x31) < '9'(0x39), logo MAX volta a ser 'RDO-202608-999' → lastSeq=999 → tenta 'RDO-202608-1000' de novo → violação da unique. O retry não ajuda porque é determinístico:
```ts
// rdos.service.ts:1151-1188
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const numero = await this.generateNumero(companyId);   // sempre o mesmo valor
  ...
  if (this.isDuplicateNumeroError(error) && attempt < 3) { continue; }
  if (this.isDuplicateNumeroError(error)) { throw new BadRequestException('Já existe um RDO com este número na empresa atual.'); }
```
Repro: seed de 1000 RDOs numa empresa no mês corrente (`RDO-YYYYMM-001` … `RDO-YYYYMM-1000`) → todo `POST /rdos` subsequente falha com 400 até virar o mês.

**Impacto** — Negação de serviço funcional autoinfligida: para qualquer empresa que ultrapasse 999 RDOs num mês (plenamente atingível com dezenas de obras × ~30 dias × turnos), a criação de RDOs para de funcionar por completo até a virada do mês, com uma mensagem enganosa ('Já existe um RDO com este número') que não indica a causa. A operação de campo perde o registro diário obrigatório.

**Causa raiz** — Numeração derivada por MAX() textual com padding de largura fixa. O padding de 3 casas torna a ordenação lexicográfica divergente da numérica assim que a sequência passa de 3 dígitos, e o retry repete o mesmo cálculo determinístico em vez de recalcular a partir do erro.

**Correção recomendada**

Derivar a sequência numericamente e deixar o banco garantir a unicidade:
```ts
const last = await this.rdosRepository.createQueryBuilder('rdo')
  .select(`MAX(NULLIF(regexp_replace(rdo.numero, '^.*-', ''), '')::int)`, 'max')
  .where('rdo.company_id = :companyId', { companyId })
  .andWhere('rdo.numero LIKE :prefix', { prefix: `${prefix}%` })
  .getRawOne<{ max: number | null }>();
const next = (last?.max ?? 0) + 1;
return `${prefix}${String(next).padStart(4, '0')}`;
```
E tornar o retry útil incrementando a partir do valor colidido (ou, melhor, migrar para uma sequência por (company_id, ano-mês) em tabela dedicada com `INSERT ... ON CONFLICT DO UPDATE RETURNING`, eliminando a race de leitura).

**Teste de regressão** — `rdos.service.spec.ts`: (a) mock do `getRawOne` devolvendo max=999 → o número gerado é `RDO-YYYYMM-1000`; (b) mock devolvendo os números já existentes até 1000 → o próximo é 1001 e não repete; (c) teste de integração com Postgres inserindo 1001 RDOs sequenciais na mesma empresa/mês e verificando que nenhum `create` lança BadRequestException.

---

### 🟡 SGS-RDO-DB-001 — Nenhuma unicidade por (company_id, site_id, data): o 'Relatório Diário de Obra' aceita N relatórios para o mesmo dia e a mesma obra, sem constraint nem checagem no serviço

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Database |
| **Local** | `backend/src/infra/database/migrations/1709000000327-harden-rdo-schema-enterprise.ts:251` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Levantamento completo dos uniques de `rdos` no repositório (`grep -rn "rdos" src/infra/database/migrations/*.ts | grep -iE "unique|uq_"`):
- `1709000000057-add-tenant-unique-operational-document-numbers.ts:28-29` → `CREATE UNIQUE INDEX "UQ_rdos_company_numero" ON "rdos" ("company_id", "numero")`
- `1709000000348-partial-unique-indexes-soft-delete.ts:59-61` → renomeia para `UQ_rdos_company_numero_active` (parcial em deleted_at IS NULL)

Nenhuma outra. A migration de hardening 327 cria apenas ÍNDICES NÃO ÚNICOS envolvendo a data:
```sql
-- 1709000000327:251-259
CREATE INDEX IF NOT EXISTS "idx_rdos_company_site_data_created"
  ON "rdos" ("company_id", "site_id", "data" DESC, "created_at" DESC) WHERE "site_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_rdos_company_status_data_created"
  ON "rdos" ("company_id", "status", "data" DESC, "created_at" DESC);
```
E `create()` (rdos.service.ts:1140-1198) não faz nenhuma consulta por `data`/`site_id` antes de inserir — a única validação de duplicidade é a de `numero` (1165-1178).

Consequência concreta: `buildValidationCode` deriva o código do prefixo do UUID, então dois RDOs do mesmo dia/obra geram DOIS códigos públicos distintos e ambos válidos:
```ts
// rdos.service.ts:2556-2561
return `RDO-${this.getIsoYear(documentDate)}-${String(this.getIsoWeekNumber(documentDate)).padStart(2,'0')}-${rdo.id.slice(0, 8).toUpperCase()}`;
```

Repro: `POST /rdos {data:'2026-08-14', site_id:'X'}` duas vezes → dois RDOs, ambos promovíveis a `aprovado`, ambos emitindo PDF final governado, ambos no bundle semanal da mesma obra e no mesmo dia.

**Impacto** — Duplicidade documental num artefato cuja definição é 'um por dia por obra': o acervo regulatório da obra passa a ter dois relatórios concorrentes para a mesma data, possivelmente com conteúdo divergente (mão de obra, ocorrências, acidentes), ambos assinados, ambos com hash registrado e ambos validáveis publicamente por QR. Em fiscalização isso destrói a confiabilidade da série histórica e torna ambíguo qual documento vale. Também polui as métricas de `getAnalyticsOverview` e o Excel.

**Causa raiz** — O invariante diário nunca foi materializado: não está escrito em `docs/state-machines.md` (que só descreve a máquina de status), não existe constraint no banco e não existe checagem no `create`. O par (company_id, site_id, data) só aparece como índice de leitura na migration 327.

**Correção recomendada**

Se a regra diária for confirmada com o produto, materializá-la nas duas camadas. Banco (nova migration, `transaction = false` por causa do CONCURRENTLY):
```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_rdos_company_site_data_active"
  ON "rdos" ("company_id", "site_id", "data")
  WHERE "deleted_at" IS NULL AND "status" <> 'cancelado' AND "site_id" IS NOT NULL;
```
Serviço, para dar erro legível em vez de 23505 cru — em `create()`, antes do insert:
```ts
const existing = await this.rdosRepository.findOne({ where: { company_id: companyId, site_id: normalizedPayload.site_id, data: normalizedPayload.data } });
if (existing) throw new ConflictException('Já existe um RDO para esta obra nesta data. Edite o existente ou cancele-o antes de criar outro.');
```
e tratar o 23505 do novo índice em `isDuplicateNumeroError`/irmão, devolvendo 409. Se a regra NÃO for diária estrita, documentá-la explicitamente em `docs/state-machines.md` — hoje o comportamento é indefinido.

**Teste de regressão** — `rdos.service.spec.ts`: (a) `create` com (company, site, data) já existente e não cancelado → ConflictException; (b) `create` para a mesma data mas outra obra → 201; (c) `create` para a mesma data/obra cujo RDO anterior está `cancelado` → 201; (d) teste de integração contra Postgres provando que o INSERT direto duplicado viola `UQ_rdos_company_site_data_active`.

---

### 🟡 SGS-RDO-OBS-001 — Trilha de auditoria fail-open e fora da transação, e operações críticas (exclusão, vídeos, exports, downloads) não geram evento algum

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Observability |
| **Local** | `backend/src/modules/rdos/rdo-audit.service.ts:21` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Toda falha de gravação da trilha é engolida — a operação de negócio segue como sucesso:
```ts
// rdo-audit.service.ts:16-48
async recordEvent(rdoId, eventType, details?) {
  try { ... await this.auditRepository.save(event); }
  catch (error) {
    this.logger.error(`Falha ao registrar evento de auditoria para o RDO ${rdoId} (Tipo: ${eventType})`, ...);
  }   // ← sem rethrow
}
```
E a gravação acontece SEMPRE depois do commit da mutação, nunca dentro dela:
```ts
// rdos.service.ts:1118-1125 (persistContentMutation)
const saved = await this.rdosRepository.save(rdo);
await this.rdoAuditService.recordEvent(saved.id, input.auditEventType, {...});
// rdos.service.ts:1428-1455 (cancel): a transaction() fecha em 1448 e só então recordCancellation em 1451
// rdos.service.ts:1548-1584 (sign): idem — recordSignature em 1584, após o commit
```
Operações críticas sem NENHUM evento na trilha (verificado por leitura integral dos métodos):
- `remove` (2317-2397): nenhuma chamada a `rdoAuditService`, embora `getAuditTrail` mapeie o rótulo `REMOVED: 'Removido'` (1472) — emissor inexistente
- `uploadVideoAttachment` (2027-2050) e `removeVideoAttachment` (2067-2081): só `logRdoEvent` (logger)
- `getPdfAccess` (2100) / `downloadPdf` (2161): exportação do PDF final — só rate limit (`rdos.controller.ts:201,225`), sem evento
- `exportExcel` (2453-2510): dump de TODOS os RDOs do tenant com observações, ocorrências e responsáveis — nenhum evento, nenhum forensic trail
- `getWeeklyBundle` (2303-2315): download em lote de todos os PDFs finais da semana — nenhum evento

O interceptor forense global só cobre rotas anotadas — e as únicas anotações no controller são as duas de delete:
```ts
// forensic-audit.interceptor.ts:64-66
if (!action || !resourceType) { return next.handle(); }
// rdos.controller.ts: @ForensicAuditAction aparece apenas em 443 (delete video) e 492 (delete rdo)
```

Repro: derrubar a conexão usada por `auditRepository` (ou provocar violação de FK em `user_id`) durante um `PATCH /rdos/:id/sign` → o RDO fica assinado, a API responde 200, e `GET /rdos/:id/audit` não mostra o evento `SIGNED`. Separadamente, `GET /rdos/export/excel` exfiltra a base de RDOs do tenant sem deixar rastro em `rdo_audit_events` nem em `forensic_trail_events`.

**Impacto** — A trilha do RDO é incompleta por construção e silenciosamente lacunar: (1) mutações bem-sucedidas podem não ter evento correspondente, sem que ninguém perceba, porque o erro só vira log; (2) como a gravação é pós-commit, qualquer crash entre o commit e o `recordEvent` produz o mesmo buraco; (3) exclusão de documento, anexação/remoção de vídeo e — principalmente — as duas rotas de exportação em massa (Excel de todos os RDOs, bundle semanal de PDFs) não deixam qualquer registro de quem exportou o quê e quando, o que é justamente o evento que uma investigação de vazamento precisa.

**Causa raiz** — O `RdoAuditService` foi desenhado como best-effort (nunca deve derrubar a operação de negócio) mas sem contrapartida: não há gravação transacional, não há fila de retry, não há métrica/alerta de falha. E o inventário de operações auditáveis nunca incluiu exclusão nem leitura/exportação em massa — o `@ForensicAuditAction` foi aplicado só nos dois deletes.

**Correção recomendada**

1) Gravar a trilha dentro da mesma transação da mutação, aceitando o custo: passar o `EntityManager` para `recordEvent` (`recordEvent(rdoId, type, details, { manager })`) e chamá-la dentro dos blocos `transaction()` de `cancel` (1428-1448), `sign` (1548-1575) e dentro de `mutateRdoContentLocked`.
2) Manter o catch apenas para o caminho não-transacional, mas incrementar um contador de observabilidade (`rdo_audit_write_failed_total`) e emitir warn estruturado alertável, em vez de só `logger.error`.
3) Fechar as lacunas: `recordEvent(rdo.id, 'REMOVED', ...)` em `remove()` antes da exclusão; `VIDEO_ATTACHED`/`VIDEO_REMOVED` em `uploadVideoAttachment`/`removeVideoAttachment`; e anotar as rotas de leitura sensível no controller — `@ForensicAuditAction('export','rdo')` em `exportExcel` e `getWeeklyBundle`, `@ForensicAuditAction('download','rdo_pdf')` em `downloadPdf` — acrescentando os rótulos correspondentes em `EVENT_LABELS` (1464-1477).

**Teste de regressão** — `rdos.service.spec.ts`: (a) `remove()` grava `REMOVED`; (b) `uploadVideoAttachment`/`removeVideoAttachment` gravam seus eventos; (c) simular `auditRepository.save` rejeitando dentro de `cancel` → a transação inteira faz rollback e o status do RDO permanece o anterior; `rdos.controller.spec.ts`: (d) asserção via Reflector de que `exportExcel`, `getWeeklyBundle` e `downloadPdf` carregam metadata de `@ForensicAuditAction`.

---

### 🔵 SGS-RDO-SEC-004 — GET /rdos/:id/audit devolve IP e User-Agent de outros usuários para qualquer portador de can_view_rdos

| | |
|---|---|
| **Severidade** | LOW |
| **Categoria** | Security |
| **Local** | `backend/src/modules/rdos/rdos.service.ts:1485` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O serviço de auditoria injeta IP e User-Agent do ator em `details`:
```ts
// rdo-audit.service.ts:25-38
const ip = RequestContext.get<string>('ip');
const userAgent = RequestContext.get<string>('userAgent');
const event = this.auditRepository.create({ ..., details: { requestId, companyId, ip: ip ?? null, userAgent: userAgent ?? null, ...(details || {}) } });
```
e `getAuditTrail` devolve `details` cru, sem projeção:
```ts
// rdos.service.ts:1479-1486
return events.map((event) => ({ id: event.id, eventType: event.event_type, eventLabel: ..., userId: event.user_id, createdAt: event.created_at, details: event.details || {} }));
```
A rota exige apenas a permissão de LEITURA, sem restrição de papel:
```ts
// rdos.controller.ts:477-487
@Get(':id/audit')
@Authorize('can_view_rdos')
getAuditTrail(@Param('id', ParseUUIDPipe) id: string) { return this.rdosService.getAuditTrail(id); }
```
Repro: qualquer usuário com `can_view_rdos` (inclusive papéis operacionais) faz `GET /rdos/<id>/audit` e recebe `details.ip` e `details.userAgent` de todos os atores que tocaram o documento — incluindo administradores.

**Impacto** — Vazamento lateral de dado pessoal (endereço IP é dado pessoal sob a LGPD) e de superfície de reconhecimento interno: um usuário operacional mapeia IPs e navegadores de administradores e colegas a partir de um endpoint de leitura corriqueiro. Não é escalada de privilégio, mas é exposição desnecessária num módulo que o próprio projeto trata como governado.

**Causa raiz** — `recordEvent` acumula metadados técnicos de requisição no mesmo campo `details` que é devolvido pela API de trilha, e `getAuditTrail` repassa o JSONB inteiro sem allowlist de chaves.

**Correção recomendada**

Projetar explicitamente os campos expostos, mantendo IP/UA persistidos apenas para análise interna:
```ts
// rdos.service.ts, em getAuditTrail
const PUBLIC_DETAIL_KEYS = new Set(['previousStatus','currentStatus','newStatus','signatureType','signerName','reason','signaturesReset','approvalReset','activityIndex','photoIndex','originalName','recipients','numero','siteId','responsavelId','deliveryMode']);
const safeDetails = Object.fromEntries(Object.entries(event.details ?? {}).filter(([k]) => PUBLIC_DETAIL_KEYS.has(k)));
```
Ou, alternativamente, mover `ip`/`userAgent` para colunas dedicadas em `rdo_audit_events` (fora de `details`) e expô-las apenas a ADMIN_GERAL/ADMIN_EMPRESA.

**Teste de regressão** — `rdos.service.spec.ts`: `getAuditTrail` sobre um evento cujo `details` contém `ip` e `userAgent` → o objeto retornado NÃO possui essas chaves, mas preserva `previousStatus`/`newStatus`; teste complementar garantindo que o INSERT continua persistindo `ip`/`userAgent` no banco.

---

### 🔵 SGS-RDO-CON-002 — savePdf concorrente emite dois PDFs finais: o upsert do registry preserva só um e o outro arquivo fica órfão no storage com hash de integridade registrado

| | |
|---|---|
| **Severidade** | LOW |
| **Categoria** | Concurrency |
| **Local** | `backend/src/modules/rdos/rdos.service.ts:1593` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

A checagem de imutabilidade e o upload acontecem fora de qualquer lock/transação comum:
```ts
// rdos.service.ts:1593-1624
const rdo = await this.findOne(id);
await this.assertRdoDocumentMutable(rdo);          // SELECT no document_registry
this.assertRdoReadyForFinalDocument(rdo);
...
const fileKey = this.documentStorageService.generateDocumentKey(rdo.company_id, 'rdos', rdo.id, originalName, {...});  // chave única por chamada
await this.documentStorageService.uploadFile(fileKey, file.buffer, file.mimetype);   // upload ANTES da transação
try { await this.documentGovernanceService.registerFinalDocument({ ... }) }
```
O registry é um upsert sobre a unique `(module, entity_id, document_type)` (`1709000000041-create-document-registry.ts:28` — `CONSTRAINT "UQ_document_registry_source" UNIQUE ("module","entity_id","document_type")`; `document-governance.service.ts:143-158` chama `documentRegistryService.upsertWithManager`), portanto a segunda chamada sobrescreve a primeira em vez de falhar.

Repro: dois `POST /rdos/<id>/file` simultâneos com PDFs diferentes. Ambos passam por `assertRdoDocumentMutable` (nenhum registry entry ainda), ambos sobem arquivos com chaves distintas, ambos chamam `registerFinalDocument`; o registry termina apontando para um deles, `rdos.pdf_file_key` idem, e o outro objeto permanece no Backblaze com `registerHashIntegrity` já gravado (document-governance.service.ts:133-141) e dois eventos `FINAL_DOCUMENT_REGISTERED` na trilha forense.

**Impacto** — Arquivo órfão no storage com hash de integridade registrado, custo de armazenamento acumulado e ruído forense (dois eventos de registro final para o mesmo documento). Baixo impacto de segurança — a janela é estreita e ambos os artefatos vêm do mesmo ator autorizado — mas contamina o inventário de documentos governados e complica auditorias de integridade.

**Causa raiz** — O check-then-act de emissão final (verificar ausência de registry → subir arquivo → registrar) não é serializado, ao contrário das mutações de conteúdo do mesmo arquivo, que já usam `mutateRdoContentLocked` com FOR UPDATE NOWAIT (rdos.service.ts:1038-1079).

**Correção recomendada**

Serializar a emissão pela mesma primitiva já existente, revalidando dentro do lock:
```ts
async savePdf(id: string, file: Express.Multer.File) {
  const rdo = await this.findOne(id);
  this.assertRdoReadyForFinalDocument(rdo);
  return this.mutateRdoContentLocked(id, rdo.company_id, async (locked, manager) => {
    if (locked.pdf_file_key) { throw new ConflictException('O PDF final deste RDO já foi emitido.'); }
    await this.assertRdoDocumentMutable(locked);
    ... // upload + registerFinalDocument dentro do lock, com compensação em caso de erro
  });
}
```
Alternativa mínima: gerar `fileKey` determinística por (entityId, documentCode), de modo que a segunda emissão sobrescreva o mesmo objeto em vez de criar um órfão.

**Teste de regressão** — `rdos.service.spec.ts`: (a) `savePdf` quando `pdf_file_key` já está preenchido → ConflictException e `documentStorageService.uploadFile` não chamado; (b) `savePdf` chama `mutateRdoContentLocked` (spy); (c) em caso de erro do `registerFinalDocument`, `deleteFile` é chamado com a chave recém-subida (regressão da compensação existente em 1650-1655).

---

## NOT VERIFIED — o que não foi possível provar nesta rodada

- Comportamento exato do diff de `Repository.save()` do TypeORM na corrida sign×update (SGS-RDO-CON-001): não foi possível provar SEM banco rodando se o `save()` do `update` emite `assinatura_responsavel = NULL` (destruindo a assinatura recém-gravada por outra requisição) ou se apenas ignora a coluna (deixando assinatura válida sobre conteúdo alterado). Os dois desfechos violam o invariante, e a ausência de lock/versão está provada no código, mas o desfecho exato precisa de um teste de integração com dois clientes concorrentes contra Postgres.
- Estado REAL das policies e privilégios em produção (Neon): todas as afirmações sobre RLS e GRANT vêm da leitura das migrations 152/172/177/187 e do trigger de forensic_trail (060/311). Não foi possível executar `SELECT policyname, cmd FROM pg_policies WHERE tablename IN ('rdos','rdo_audit_events')` nem `\dp rdo_audit_events` contra o banco. O histórico do projeto registra migrations que não rodaram em todos os ambientes (a própria 184 existe para resolver conflito de timestamp com a 087), então a divergência entre migrations e produção precisa ser confirmada com o banco em mãos.
- Existência do índice único `UQ_rdos_company_site_data_active` (SGS-RDO-DB-001): confirmei por grep que nenhuma migration o cria, mas não pude listar `pg_indexes` de produção para descartar um índice criado manualmente fora do versionamento.
- Se a regra de negócio 'um RDO por dia por obra' é de fato exigida pelo produto: `docs/state-machines.md:134-142` só descreve a máquina de status e não menciona unicidade diária. O achado reporta a ausência de qualquer enforcement e de qualquer especificação — a decisão entre 'criar a constraint' e 'documentar que múltiplos são permitidos' depende de confirmação com o dono do produto.
- Se algum consumidor externo ao backend (frontend, worker de e-mail, portal público de validação) verifica `assinatura.document_hash` contra o snapshot atual: o grep cobriu apenas `backend/src`. A conclusão de que o campo nunca é verificado vale para o backend; não inspecionei `frontend/src/lib/pdf-system` nem as rotas de validação pública do Next.js.
- Comportamento real do `mutateRdoContentLocked` sob contenção (retry de 3 tentativas com 50/100/200ms): a lógica está correta na leitura, mas não foi executada contra Postgres para confirmar que o erro 55P03 chega ao catch com `error.code` no formato esperado por `isRdoLockNotAvailableError` (rdos.service.ts:1081-1088) — o TypeORM às vezes encapsula em `QueryFailedError` com o código em `driverError.code`, caso em que o retry silenciosamente não funcionaria e a operação falharia com 500 em vez de 409.
- Cobertura efetiva do throttler global nas rotas do RDO: `resilient-throttler.service.ts:54` define `THROTTLER_API_LIMIT` = 100/min por padrão, mas não verifiquei se o guard correspondente está registrado como global e se a chave de contagem é por usuário, por IP ou por tenant — isso altera a magnitude prática do abuso descrito em SGS-RDO-SEC-001 (mas não a sua existência, já que o limite é de requisições e o array de destinatários é ilimitado).
