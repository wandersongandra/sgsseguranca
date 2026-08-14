# Relatório Fotográfico — Relatório de Auditoria

> Escopo desta rodada: **Arquitetura · Backend · Banco · Segurança · Máquina de estados · Concorrência · Integridade documental · Observabilidade**.
> Frontend, Design/UX, PDF e Performance de carga ficaram para a rodada 2 (ver `00-master-audit.md` › Status).

## Resumo executivo

O renderer Puppeteer é a parte MAIS sólida do módulo: todo dado interpolado passa por escapeHtml(), a geração usa page.setContent() (nunca goto), há request interception em pdf.service.ts bloqueando tudo que não seja data:/blob:, e --no-sandbox vem com mitigações documentadas — não encontrei XSS no PDF, SSRF nem file:// exploráveis. O upload valida magic bytes reais (JPEG/PNG/WebP), passa por ClamAV, randomiza o nome do arquivo e mascara IP/device/coordenadas. As políticas RLS das 4 tabelas têm ENABLE+FORCE, USING e WITH CHECK, e a 368 corrigiu corretamente a flag de super-admin. O buraco real do módulo NÃO é injeção: é a máquina de estados e a governança documental. `saveDraft()` devolve QUALQUER relatório para Rascunho incondicionalmente, `update()` rebaixa FINALIZADO para "Em edição", e a combinação derruba a única trava que impede `remove()` — que apaga IRREVERSIVELMENTE todas as fotos do storage antes de um soft delete. Exportar não tem pré-condição de status: um rascunho vira documento governado com código público e QR, e cada reexportação sobrescreve o registry sob o MESMO código de validação. Some-se a isso a ausência total de trilha forense (único módulo governado sem @ForensicAuditAction) e um índice único parcial que faz qualquer reordenação real de fotos estourar 500.

| Severidade | Confirmados |
|---|---|
| 🟠 HIGH | 4 |
| 🟡 MEDIUM | 7 |

## Máquina de estados observada no código

Máquina de estados observada NO CÓDIGO (`photographic-reports.service.ts`). Não existe nenhuma tabela de transições permitidas: cada método escreve `report.status` direto.

| Origem | Destino | Método / linha | Pré-condição REAL no código | Quem pode |
|---|---|---|---|---|
| — | `Rascunho` | `create()` :827 | nenhuma | ADMIN_GERAL, ADMIN_EMPRESA, TST, SUPERVISOR, COLABORADOR + `can_manage_photographic_reports` |
| qualquer | `Aguardando fotos` | `createDay()` :1203 via `markEditingIfNeeded` | dia novo | idem |
| qualquer | `Aguardando análise` | `uploadImages()` :1410-1414 | ≥1 arquivo. Se origem = FINALIZADO/EXPORTADO → `Em edição` | idem |
| qualquer | `Analisado` | `analyzeImage()` :1661, `analyzeAllImages()` :1743 | ≥1 foto | + `can_generate_photographic_report_ai` |
| `Finalizado`/`Exportado` | `Em edição` | `markEditingIfNeeded()` :640-646, chamado por `update`, `updateDay`, `removeDay`, `updateImage`, `removeImage`, `reorderImages` | **nenhuma** — basta mutar um campo | `can_manage_photographic_reports` |
| **qualquer (inclusive `Finalizado`/`Exportado`)** | **`Rascunho`** | **`saveDraft()` :1011** | **NENHUMA — status é forçado** | `can_manage_photographic_reports` |
| qualquer | `Finalizado` | `finalize()` :1763 | `images.length > 0` apenas | `can_finalize_photographic_report` |
| **qualquer (inclusive `Rascunho`)** | **`Exportado`** | `buildExportBufferAndPersist()` :2216 | `images.length > 0` apenas | `can_export_photographic_report_pdf` / `_word` |
| qualquer | (soft delete) | `remove()` :1175 | bloqueia só se status ∈ {Finalizado, Exportado} **ou** existir export :1122-1130 | ADMIN_GERAL, ADMIN_EMPRESA, TST, SUPERVISOR |
| — | `Cancelado` | **inexistente** | o valor está no enum (:25) e no CHECK da migration 204, mas **nenhum código o escreve** | ninguém |

Transições ilegais alcançáveis: `Finalizado → Rascunho`, `Exportado → Rascunho`, `Finalizado → Em edição → (delete)`, `Rascunho → Exportado` (emissão de documento governado sem análise nem finalização). O estado `Cancelado` é morto, embora a mensagem de erro de `remove()` (:1128) instrua o usuário a "usar os fluxos formais de cancelamento" — que não existem.

## Achados

### 🟠 SGS-RF-STM-001 — Trava de exclusão de relatório finalizado é contornável com um PATCH, e o delete destrói as fotos do storage de forma irreversível

| | |
|---|---|
| **Severidade** | HIGH _(ajustada de CRITICAL na verificação)_ |
| **Categoria** | StateMachine |
| **Local** | `backend/src/modules/photographic-reports/photographic-reports.service.ts:1118` |
| **Verificação adversarial** | CONFIRMED_PARCIAL — PARCIALMENTE CONFIRMADO — severidade REBAIXADA de CRITICAL para HIGH. A trava existe e é mais forte do que o auditor afirmou: `remove()` (photographic-reports.service.ts:1118-1129) bloqueia FINALIZADO, EXPORTADO **e** `(report.exports||[]).length > 0`, e `findReportEntity` (346-357) carrega de fato `exports: true` e `images`. Portanto um relatório JÁ EXPORTADO continua protegido mesmo depois do PATCH. O bypass é real apenas para relatório FINALIZADO que nunca foi exportado: `saveDraft` força `status: RASCUNHO` incondicionalmente (1011) e o `remove()` seguinte destrói as fotos no storage. |

**Evidência**

`remove()` só bloqueia dois status:

```ts
// service.ts:1122-1130
if (
  report.status === PhotographicReportStatus.FINALIZADO ||
  report.status === PhotographicReportStatus.EXPORTADO ||
  (report.exports || []).length > 0
) {
  throw new BadRequestException('Somente relatórios fotográficos sem exportação final podem ser removidos. Use os fluxos formais de cancelamento para registros já finalizados/exportados.');
}
```

Mas `markEditingIfNeeded` rebaixa exatamente esses dois status:

```ts
// service.ts:636-649
private markEditingIfNeeded(report, nextStatus) {
  if (report.status === PhotographicReportStatus.FINALIZADO ||
      report.status === PhotographicReportStatus.EXPORTADO) {
    report.status = PhotographicReportStatus.EM_EDICAO;
    return;
  }
  report.status = nextStatus;
}
```

e é chamado incondicionalmente por `update()` (:994-996) e por `saveDraft()` (:1011, que força `status: RASCUNHO`).

E, uma vez passada a trava, o delete apaga o arquivo do storage ANTES do soft delete:

```ts
// service.ts:1143-1153, 1175
for (const fileKey of imageKeys) {
  await this.documentStorageService.deleteFile(fileKey);   // destrutivo
}
...
await this.reportRepository.softDelete(report.id);          // só a linha é reversível
```

REPRO (relatório FINALIZADO, ator = TST com `can_manage_photographic_reports`):
1. `PATCH /photographic-reports/{id}` body `{"location":"x"}` → status vira `Em edição` (nenhum export existe ainda).
2. `DELETE /photographic-reports/{id}` → guarda não dispara; todas as fotos são removidas do bucket.

O teste `photographic-reports.service.spec.ts:162` ("bloqueia remove() quando o relatório já tem exportação final") só exercita o caminho EXPORTADO+export presente — nunca o rebaixamento via update, então o furo passa verde no CI.

**Impacto** — Perda irreversível da evidência fotográfica de um relatório técnico de SST já finalizado. O soft delete dá falsa sensação de reversibilidade: as linhas de `photographic_report_images` permanecem no banco com `image_url` apontando para objetos que não existem mais, e nenhum restore de DR recupera os binários (o backup de banco não contém o bucket). O estado `Cancelado`, citado na própria mensagem de erro como alternativa, não é escrito por nenhum código do módulo.

**Causa raiz** — A trava foi escrita sobre o VALOR do status em vez de sobre um fato imutável (existência de emissão/registro governado), e o mesmo serviço tem dois métodos que rebaixam esse valor sem nenhuma verificação. Nenhum caminho consulta `verification_code`/`pdf_generated_at`/document-registry antes de destruir arquivo.

**Correção recomendada**

1) Trocar o predicado da trava por um fato não rebaixável, e nunca destruir binário no soft delete:
```ts
const jaEmitido = Boolean(report.verification_code || report.pdf_generated_at) ||
  (report.exports || []).length > 0 ||
  Boolean(await this.documentRegistryService.findByDocument('photographic_report', report.id, 'pdf', companyId));
if (jaEmitido) throw new BadRequestException('Relatório já emitido não pode ser removido.');
```
2) Remover o loop `deleteFile(imageKeys)` de `remove()`. Soft delete não pode apagar bytes; a limpeza física deve ser um job de retenção separado, disparado só após o período de guarda e registrado no forensic trail.
3) Implementar de fato o fluxo `Cancelado` (endpoint dedicado, transição única a partir de FINALIZADO/EXPORTADO, sem apagar arquivo) — hoje a mensagem de erro aponta para algo inexistente.

**Teste de regressão** — E2E: criar relatório → upload de 1 foto → `POST /:id/finalize` → `PATCH /:id {location}` → `DELETE /:id` deve retornar 400 e `documentStorageService.deleteFile` NÃO deve ter sido chamado. Repetir com `POST /:id/draft` no lugar do PATCH. Unit: `remove()` com `report.verification_code` preenchido e `exports: []` deve lançar BadRequestException.

---

### 🟠 SGS-RF-STM-002 — saveDraft() força status Rascunho em QUALQUER relatório, inclusive um já exportado com código público e QR ativos

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | StateMachine |
| **Local** | `backend/src/modules/photographic-reports/photographic-reports.service.ts:1008` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

```ts
// service.ts:1002-1011
async saveDraft(id: string, dto: UpdatePhotographicReportDto) {
  const companyId = this.getCompanyIdOrThrow();
  const report = await this.findReportEntity(id, companyId);
  Object.assign(report, {
    ...report,
    ...dto,
    status: PhotographicReportStatus.RASCUNHO,   // <-- incondicional
    ...
```

Rota exposta sem qualquer verificação de status (`photographic-reports.controller.ts:97-111`):
```ts
@Post(':id/draft')
@Roles(ADMIN_GERAL, ADMIN_EMPRESA, TST, SUPERVISOR, COLABORADOR)
@Authorize('can_manage_photographic_reports')
saveDraft(@Param('id', new ParseUUIDPipe()) id, @Body() dto: UpdatePhotographicReportDto) {
  return this.photographicReportsService.saveDraft(id, dto);
}
```

O contraste com `update()` prova que a regra era conhecida e simplesmente não foi replicada:
```ts
// service.ts:988-992
if (dto.status !== undefined && dto.status !== report.status) {
  throw new BadRequestException('A transição de status deve ocorrer pelos fluxos dedicados (análise, finalização ou exportação).');
}
```
E existe teste só para esse caminho (`service.spec.ts:181` — "update() bloqueia transição direta de status"); `saveDraft` não tem NENHUM teste de status.

REPRO: `POST /photographic-reports/{id}/draft` com body `{}` sobre um relatório `Exportado` → responde 200 com `status: "Rascunho"`, enquanto `verification_code`, `final_pdf_hash_sha256`, `pdf_file_key` e `pdf_generated_at` permanecem preenchidos e a entrada no document-registry continua ativa.

**Impacto** — Um documento técnico já emitido, com código RFP-<ano>-<8> impresso, hash registrado em `pdf_integrity_records` e QR de validação pública válido por 30 dias, passa a aparecer como "Rascunho" para auditor, cliente e fiscalização. O sistema deixa de conseguir responder "este documento foi emitido?" pelo próprio campo que existe para isso. É também o primeiro passo do encadeamento do SGS-RF-STM-001.

**Causa raiz** — `saveDraft` foi escrito como um "salvar tudo" de formulário (Object.assign com spread) em vez de uma transição de estado. O autor tratou `status` como um campo de payload a ser sobrescrito, não como o resultado de uma regra.

**Correção recomendada**

Restringir a transição ao conjunto legítimo e nunca rebaixar documento emitido:
```ts
const REBAIXAVEIS = new Set([
  PhotographicReportStatus.RASCUNHO,
  PhotographicReportStatus.AGUARDANDO_FOTOS,
  PhotographicReportStatus.AGUARDANDO_ANALISE,
  PhotographicReportStatus.ANALISADO,
  PhotographicReportStatus.EM_EDICAO,
]);
if (!REBAIXAVEIS.has(report.status)) {
  throw new BadRequestException('Relatório finalizado/exportado não pode voltar a rascunho.');
}
```
E trocar `Object.assign(report, { ...report, ...dto, ... })` por atribuição campo a campo (como `update()` já faz): o spread `...dto` só não vaza hoje porque cada campo é reescrito logo abaixo — qualquer campo novo no DTO passa cru.

**Teste de regressão** — Unit: `saveDraft()` com report em FINALIZADO e em EXPORTADO deve lançar BadRequestException e não chamar `reportRepository.save`. Unit: `saveDraft()` em RASCUNHO/EM_EDICAO continua funcionando. E2E: exportar PDF, chamar `/draft`, e conferir que `GET /:id` ainda devolve `status: "Exportado"`.

---

### 🟠 SGS-RF-GOV-003 — Exportar não tem pré-condição de status: rascunho vira documento governado, e cada reexportação sobrescreve o registry sob o MESMO código de validação pública

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/photographic-reports/photographic-reports.service.ts:2222` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`exportPdf` só checa se há fotos:
```ts
// service.ts:2222-2234
async exportPdf(reportId: string) {
  const report = await this.findOne(reportId);
  if (report.images.length === 0) throw new BadRequestException('Relatório sem fotos.');
  const result = await this.buildExportBufferAndPersist({ report, exportType: PDF });
```
e `buildExportBufferAndPersist` carimba EXPORTADO vindo de qualquer origem (:2215-2217).

O registro governado é gravado sem verificar se já existe emissão anterior:
```ts
// service.ts:2108-2148
const documentCode = buildPhotographicReportCode(params.report);
await this.documentGovernanceService.registerFinalDocument({
  ...
  persistEntityMetadata: async (manager, hash) => {
    await manager.getRepository(PhotographicReport).update(
      { id: params.report.id, company_id: params.report.company_id },
      { final_pdf_hash_sha256: hash, verification_code: documentCode, pdf_file_key: params.fileKey, ... });
  },
});
```
E o registry é UPSERT, não insert-once:
```ts
// document-registry/document-governance.service.ts:143-158
const registryEntry = await this.documentRegistryService.upsertWithManager(manager, { ... fileHash: hash, documentCode: input.documentCode, ... });
```

O código é determinístico e NÃO depende do conteúdo:
```ts
// photographic-reports.document-code.ts:21-31
return `RFP-${year}-${suffix}`;  // suffix = 8 primeiros chars do id
```

REPRO: (a) criar relatório, subir 1 foto, chamar `POST /:id/export/pdf` — sem finalizar, sem análise, sem responsável técnico preenchido — sai um PDF com QR público e entrada no document-registry. (b) `PATCH /:id` alterando `responsible_name`/`client_name`, `POST /:id/images/{imgId}` trocando descrições, e `POST /:id/export/pdf` de novo → mesmo `verification_code`, novo `final_pdf_hash_sha256`, registry apontando para o novo arquivo. O PDF entregue ao cliente na 1ª emissão continua ostentando o mesmo código, agora resolvendo para outro documento.

**Impacto** — O código de validação pública deixa de identificar um documento e passa a identificar apenas a ENTIDADE. Duas cópias impressas do mesmo RFP-2026-XXXXXXXX com conteúdos diferentes validam igualmente, e a mais antiga não é detectável como superada. Além disso, `can_export_photographic_report_pdf` vira um caminho paralelo a `can_finalize_photographic_report` (que exige FeatureAiGuard + AiConsentGuard e roda a análise) para produzir um documento com a mesma aparência de oficialidade.

**Causa raiz** — A emissão foi modelada como "gerar arquivo" e não como "emitir versão". Falta (a) pré-condição de status para exportar, (b) versionamento no código público, e (c) um registro imutável por emissão — o upsert apaga o histórico em vez de acrescentar.

**Correção recomendada**

1) Exigir estado emitível antes de exportar PDF:
```ts
if (![PhotographicReportStatus.FINALIZADO, PhotographicReportStatus.EXPORTADO].includes(report.status)) {
  throw new BadRequestException('Somente relatório finalizado pode ser exportado como documento oficial.');
}
```
2) Versionar o código público: `RFP-<ano>-<8>-R<n>`, com `n` derivado de `COUNT(*)` de exports PDF do relatório dentro da mesma transação, e manter cada revisão como linha própria no registry (a UNIQUE parcial `UQ_photographic_reports_company_verification_code` da migration 371 já força um código por relatório — precisa acompanhar a mudança).
3) O endpoint de validação pública deve devolver a revisão e sinalizar "superada por revisão R<n+1>" quando o hash consultado não for o corrente.

**Teste de regressão** — E2E: `POST /:id/export/pdf` em relatório RASCUNHO deve retornar 400. E2E: finalizar → exportar (captura hash1 e code1) → editar → exportar (hash2, code2); assertar `code2 !== code1` e que `GET /validar/{code1}` ainda resolve para hash1 marcado como revisão anterior.

---

### 🟠 SGS-RF-OBS-004 — Nenhuma rota do módulo emite trilha forense — é o único módulo de documento governado sem @ForensicAuditAction

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Observability |
| **Local** | `backend/src/modules/photographic-reports/photographic-reports.controller.ts:39` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O controller inteiro (372 linhas, 21 rotas, incluindo `DELETE /:id`, `DELETE /:id/images/:imageId`, `POST /:id/finalize`, `POST /:id/export/pdf`, `POST /:id/draft`) não importa nem aplica nenhum decorador de auditoria — a lista de imports (linhas 1-37) não contém `AuditAction`/`AuditResource`.

E o interceptor é opt-in por decorador, não global por método HTTP:
```ts
// shared/interceptors/forensic-audit.interceptor.ts:55-66
const action = this.reflector.getAllAndOverride<AuditableAction>(AUDIT_ACTION_METADATA_KEY, [context.getHandler(), context.getClass()]);
const resourceType = this.reflector.getAllAndOverride<string>(AUDIT_RESOURCE_METADATA_KEY, [...]);
if (!action || !resourceType) {
  return next.handle();   // sem decorador = sem registro
}
```

Comparação direta com o módulo irmão de mesma criticidade (`modules/aprs/aprs.controller.ts`): linhas 517, 737, 753, 773, 794, 818, 833 e 902 — `@ForensicAuditAction('approve'|'reject'|'finalize'|'delete', 'apr')`. O mesmo padrão existe em audits, checklists, dds, nonconformities, pts, rdos, risks, corrective-actions, medical-exams, companies e profiles.

Único evento forense que o módulo gera é `FINAL_DOCUMENT_REGISTERED`, e só porque `registerFinalDocument` o emite internamente (document-governance.service.ts:160-180) — ou seja, apenas na exportação de PDF. Word, delete, finalize, draft e remoção de foto não deixam rastro.

**Impacto** — Não há como responder "quem apagou as fotos deste relatório", "quem devolveu o documento emitido para rascunho" ou "quem finalizou". Isso remove justamente a evidência que investigaria os achados SGS-RF-STM-001 e 002, e quebra a paridade de governança que o projeto mantém em todos os outros módulos documentais — com impacto direto em auditoria de SST e em prestação de contas LGPD.

**Causa raiz** — Módulo entregue depois da convenção de trilha forense e nunca alinhado a ela; como o interceptor é fail-open (sem decorador não registra e não avisa), a ausência é silenciosa e nenhum teste detecta.

**Correção recomendada**

Anotar as rotas mutantes, no mesmo padrão do APR:
```ts
import { AuditAction as ForensicAuditAction } from '../../shared/decorators/audit-action.decorator';

@Delete(':id')            @ForensicAuditAction('delete',   'photographic_report')
@Delete(':id/images/:imageId') @ForensicAuditAction('delete', 'photographic_report_image')
@Post(':id/finalize')     @ForensicAuditAction('finalize', 'photographic_report')
@Post(':id/export/pdf')   @ForensicAuditAction('export',   'photographic_report')
@Post(':id/export/word')  @ForensicAuditAction('export',   'photographic_report')
@Post(':id/draft')        @ForensicAuditAction('update',   'photographic_report')
```
Complementarmente, adicionar um teste de arquitetura que falhe quando um controller de módulo governado tiver rota Delete/Post de finalize/export sem decorador de auditoria.

**Teste de regressão** — Teste de metadata sobre o controller: para cada handler em {remove, removeImage, finalize, exportPdf, exportWord, saveDraft}, `Reflect.getMetadata(AUDIT_ACTION_METADATA_KEY, handler)` deve ser definido. E2E: `DELETE /photographic-reports/{id}` seguido de consulta ao forensic_trail deve retornar 1 evento com ator, tenant e entityId.

---

### 🟡 SGS-RF-DB-005 — Reordenar fotos viola o índice único parcial (report_id, image_order): qualquer permutação real estoura 500

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Database |
| **Local** | `backend/src/modules/photographic-reports/photographic-reports.service.ts:1567` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O banco mantém unicidade de ordem entre fotos ativas:
```ts
// migrations/1709000000348-partial-unique-indexes-soft-delete.ts:125-131
{
  table: 'photographic_report_images',
  constraintName: 'UQ_photographic_report_images_report_order',
  newName: 'UQ_photographic_report_images_report_order_active',
  columns: '("report_id", "image_order")',
  extraWhere: null,
}
```
(índice parcial `WHERE deleted_at IS NULL`, NÃO deferrable — a origem é o `CONSTRAINT UQ_photographic_report_images_report_order UNIQUE ("report_id","image_order")` da migration 204:84.)

O serviço grava a nova ordem em lote, sem estágio intermediário:
```ts
// service.ts:1581-1591
const imageMap = new Map(images.map((image) => [image.id, image]));
dto.imageIds.forEach((imageId, index) => {
  const image = imageMap.get(imageId);
  if (!image) throw new BadRequestException('A ordem enviada contém foto inválida.');
  image.image_order = index + 1;
});
...
await this.imageRepository.save([...imageMap.values()]);
```
`imageMap` é construído a partir de `this.sortImages(report.images)` (:1573), ou seja, em ordem crescente de `image_order`; o save emite um UPDATE por linha nessa ordem, dentro de uma transação.

REPRO: relatório com fotos A(order=1) e B(order=2). `POST /:id/images/reorder` com `{"imageIds":["B","A"]}`. O primeiro UPDATE (A → 2) colide com B, que ainda tem 2 → `duplicate key value violates unique constraint "UQ_photographic_report_images_report_order_active"` → 500 e rollback.

Mesma raiz atinge dois outros caminhos:
- `updateImage` aceita `image_order` livre e grava direto (`service.ts:1456-1458`, DTO `@IsInt() @Min(1)` sem Max nem checagem de colisão) → 500 ao colidir.
- `uploadImages` calcula `startingOrder = Math.max(...images.map(i => i.image_order), 0)` (:1307-1309) fora de transação/lock; dois uploads concorrentes no mesmo relatório calculam o mesmo início e o segundo INSERT (:1408) viola o índice.

Observação: a entidade declara apenas `@Index('IDX_photographic_report_images_report_order', ['report_id','image_order'])` (photographic-report-image.entity.ts:15-18), NÃO único — o código foi escrito contra um modelo mental que não corresponde ao schema real.

**Impacto** — Reordenar evidências — que definem a sequência narrativa de um relatório técnico — falha com erro genérico em praticamente todos os casos úteis (qualquer troca de posição). O usuário não consegue corrigir a ordem das fotos antes de emitir o documento, e o 500 não explica o motivo. Upload concorrente do mesmo relatório também quebra.

**Causa raiz** — Renumeração sem passo intermediário contra um índice único não deferrable. `renumberImages` (:380-401) só não quebra por acaso: ele sempre renumera de forma monotonicamente decrescente após uma exclusão.

**Correção recomendada**

Renumerar em duas fases dentro de uma transação com lock do relatório:
```ts
await this.dataSource.transaction(async (manager) => {
  const repo = manager.getRepository(PhotographicReportImage);
  await manager.query('SELECT id FROM photographic_reports WHERE id = $1 FOR UPDATE', [report.id]);
  // fase 1: mover todos para uma faixa livre (negativa)
  await repo.createQueryBuilder().update()
    .set({ image_order: () => '-image_order' })
    .where('report_id = :id AND deleted_at IS NULL', { id: report.id }).execute();
  // fase 2: aplicar a ordem final
  for (const [index, imageId] of dto.imageIds.entries()) {
    await repo.update({ id: imageId, report_id: report.id }, { image_order: index + 1 });
  }
});
```
Rejeitar IDs duplicados explicitamente (`new Set(dto.imageIds).size !== dto.imageIds.length`), remover `image_order` do `UpdatePhotographicReportImageDto` (a ordenação já tem endpoint próprio) e adquirir o mesmo lock em `uploadImages` antes de calcular `startingOrder`.

**Teste de regressão** — Teste de integração com Postgres real (o índice parcial não existe em SQLite): criar 3 fotos, chamar `reorderImages` com [C,B,A] e assertar 200 e ordens 1,2,3. Teste de duplicata: `imageIds: [A,A,B]` deve retornar 400, não 500. Teste de concorrência: dois `uploadImages` em paralelo no mesmo relatório devem ambos concluir com ordens distintas.

---

### 🟡 SGS-RF-SEC-006 — Content-Type do arquivo é o valor cru enviado pelo cliente: vai para o objeto no storage, para a coluna mime_type e para o data: URI do PDF

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Security |
| **Local** | `backend/src/modules/photographic-reports/photographic-reports.service.ts:1352` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Os magic bytes SÃO validados (bom), mas o MIME declarado nunca é confrontado com o detectado:
```ts
// service.ts:1326-1330
validateFileMagicBytes(buffer, ['image/jpeg','image/png','image/webp']);
await inspectUploadedFileBuffer(buffer, file, this.fileInspectionService);
```
```ts
// service.ts:1352-1356
await this.documentStorageService.uploadFile(storageKey, buffer, file.mimetype);   // Content-Type do objeto
```
```ts
// service.ts:1379
mime_type: file.mimetype || null,
```
E o interceptor de upload da rota não tem fileFilter — aceita qualquer `Content-Type` de parte multipart:
```ts
// controller.ts:178-187
FilesInterceptor('files', 30, createTemporaryUploadOptions({ maxFileSize: 15*1024*1024, maxFiles: 30 }))
```
```ts
// shared/interceptors/file-upload.interceptor.ts:144-148
fileFilter: options?.fileFilter || ((_req, _file, cb) => { cb(null, true); }),
```

O valor volta a ser usado como verdade em dois lugares:
```ts
// service.ts:2016-2021 (montagem do PDF)
data_url: await this.fileBufferToDataUrl(image.image_url, image.mime_type ?? this.guessImageMimeType(image.image_url)),
// service.ts:307
return `data:${mimeType};base64,${buffer.toString('base64')}`;
```
```ts
// renderer.ts:680-682 (manifesto de evidências, impresso como metadado do arquivo)
<td>${escapeHtml(sanitize(image.mime_type))}</td>
```
A URL assinada da imagem é servida direto pelo storage (o desvio para download pela aplicação só cobre `.pdf`):
```ts
// shared/services/document-storage.service.ts:367-369
private shouldUseRestrictedAppDownload(key: string): boolean {
  return key.startsWith('documents/') && /\.pdf$/i.test(key);
}
```

REPRO: `POST /photographic-reports/{id}/images` com um JPEG válido cujo `Content-Type` da parte multipart seja `text/html`. Magic bytes passam. O objeto no B2 fica com `Content-Type: text/html`; um JPEG poliglota (marcador APP mais adiante contendo `<script>`) abre como HTML no navegador de quem clicar na URL assinada. No PDF, o `<img src="data:text/html;base64,…">` não renderiza: a foto some do documento enquanto o manifesto continua listando a evidência como presente.

**Impacto** — Dois efeitos. (1) Conteúdo ativo servido pelo domínio de storage com Content-Type escolhido pelo usuário — origem distinta da aplicação, então sem roubo de sessão, mas viável para phishing hospedado em domínio confiável do cliente. (2) Integridade documental: quem envia a foto controla se ela aparece ou não no PDF final, com o manifesto afirmando que a evidência existe — divergência silenciosa entre manifesto e corpo do documento.

**Causa raiz** — A validação foi feita sobre os bytes (correta) mas o valor propagado adiante continuou sendo o declarado pelo cliente. `detectMimeFromMagicBytes` já roda dentro de `validateFileMagicBytes` e o resultado é descartado.

**Correção recomendada**

Expor o MIME detectado e usar SOMENTE ele:
```ts
// file-upload.interceptor.ts
export function resolveFileMagicMime(buffer: Buffer, allowedMimes: string[]): string {
  const detected = detectMimeFromMagicBytes(buffer.slice(0, 4100));
  if (!detected || !isCompatibleDetectedMime(detected, allowedMimes)) {
    throw new BadRequestException('Tipo de arquivo não permitido');
  }
  return detected;
}
```
```ts
// service.ts (uploadImages)
const detectedMime = resolveFileMagicMime(buffer, ['image/jpeg','image/png','image/webp']);
await this.documentStorageService.uploadFile(storageKey, buffer, detectedMime);
// ... mime_type: detectedMime
```
Adicionalmente, passar `fileFilter` restrito no `FilesInterceptor` da rota e garantir `X-Content-Type-Options: nosniff` / `Content-Disposition: attachment` no acesso a objetos de imagem.

**Teste de regressão** — Unit: `uploadImages` com `file.mimetype = 'text/html'` e buffer JPEG válido deve persistir `mime_type === 'image/jpeg'` e chamar `uploadFile` com `'image/jpeg'`. Unit: buffer SVG/HTML puro continua rejeitado por magic bytes.

---

### 🟡 SGS-RF-PERF-007 — Campos de texto sem limite + fotos sem teto por relatório = HTML e heap ilimitados na geração síncrona do PDF

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Performance |
| **Local** | `backend/src/modules/photographic-reports/dto/update-photographic-report.dto.ts:138` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Campos livres sem `@MaxLength` (o body JSON global aceita 5 MB — `main.ts:334`):
```ts
// update-photographic-report.dto.ts:138-148
@IsOptional() @IsString() general_observations?: string;
@IsOptional() @IsString() ai_summary?: string;
@IsOptional() @IsString() final_conclusion?: string;
```
```ts
// update-photographic-report-image.dto.ts:20-49
@IsOptional() @IsString() manual_caption?: string | null;
@IsOptional() @IsString() ai_title?: string | null;
@IsOptional() @IsString() ai_description?: string | null;
@IsOptional() @IsString() ai_technical_assessment?: string | null;
@IsOptional() @IsString() ai_condition_classification?: string | null;
@IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(8) ai_positive_points?: string[] | null;   // itens sem MaxLength
```
(compare com `inspection_methodology` / `scope_and_limitations`, que TÊM `@MaxLength(4000)` — a omissão é inconsistente dentro do mesmo DTO.)

Não há teto de fotos por relatório: o limite de 30 é POR REQUISIÇÃO (`controller.ts:179-186`) e `uploadImages` não consulta o total existente — só calcula o próximo `image_order` (`service.ts:1307-1309`).

Tudo é materializado de uma vez, em memória, no processo web:
```ts
// service.ts:2012-2024
const renderableImages: PhotographicReportRenderableImage[] = [];
for (const image of report.images) {
  renderableImages.push({ ...image, data_url: await this.fileBufferToDataUrl(...) });   // base64 de até 15 MB por foto
}
```
```ts
// service.ts:307
return `data:${mimeType};base64,${buffer.toString('base64')}`;
```
E a rota é síncrona, sem fila e sem throttle próprio (`controller.ts:311-327`; nenhum `@Throttle` no módulo).

REPRO: subir 200 fotos de ~10 MB (7 requisições de 30) e chamar `POST /:id/export/pdf`. O serviço monta ~2,6 GB de string base64 no heap do Node antes mesmo de o Chromium abrir a página. Variante barata: 20 PATCHes de 5 MB em `ai_description` de fotos distintas produz ~100 MB de HTML para o `page.setContent`.

**Impacto** — Negação de serviço no processo web da API (OOM do Node ou saturação do pool de Chromium, `PDF_BROWSER_UNAVAILABLE` para todos os tenants), disparável por um único usuário autenticado com permissão legítima de exportar. Diferente dos outros módulos, este renderiza PDF no backend, então o custo cai na API e não no worker.

**Causa raiz** — Nenhum orçamento de recursos definido para a emissão: nem limite de texto por campo, nem teto de evidências por documento, nem streaming/paginação das imagens, nem execução assíncrona em fila.

**Correção recomendada**

1) `@MaxLength` em todos os campos de texto livre (ex.: 4000 para narrativas, 500 para legendas/títulos, 300 por item de array).
2) Teto de fotos por relatório em `uploadImages`:
```ts
const MAX_IMAGES_PER_REPORT = 120;
const existing = await this.imageRepository.count({ where: { report_id: report.id, deleted_at: IsNull() } });
if (existing + files.length > MAX_IMAGES_PER_REPORT) {
  throw new BadRequestException(`Limite de ${MAX_IMAGES_PER_REPORT} fotos por relatório atingido.`);
}
```
3) Reamostrar/recomprimir a imagem no servidor antes de embutir no PDF (largura máxima ~1600px), em vez de embutir o original em base64.
4) Mover a exportação para a fila `pdf-generation` (o worker já existe) e aplicar `@Throttle` na rota de export.

**Teste de regressão** — Unit: `uploadImages` que ultrapasse o teto deve lançar BadRequestException sem tocar no storage. Unit de DTO: `ai_description` com 5.000 chars deve falhar na validação. Teste de carga: relatório no teto máximo deve exportar dentro do timeout com pico de heap medido abaixo do limite do container.

---

### 🟡 SGS-RF-INT-008 — A ressalva de integridade impressa no PDF depende de um booleano que o cliente declara e o servidor nunca verifica; o hash da foto nunca é reconferido

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/photographic-reports/photographic-reports.service.ts:1391` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O flag vem do payload:
```ts
// dto/upload-photographic-report-images.dto.ts:118-121
@IsOptional() @Transform(toOptionalBoolean) @IsBoolean()
client_reencoded?: boolean;
```
```ts
// service.ts:1391-1399
integrity_flags: buildIntegrityFlags({ ..., clientReencoded: dto.client_reencoded }),
```
e é o que decide a frase impressa no documento técnico:
```ts
// renderer.ts:667-671
const hasReencoded = images.some((image) =>
  (image.integrity_flags as { client_reencoded?: boolean } | null)?.client_reencoded === true);
```
```ts
// renderer.ts:698-699
hasReencoded
  ? 'O hash SHA-256 refere-se ao arquivo recebido e armazenado pelo SGS. Imagens capturadas por dispositivo móvel são otimizadas no navegador antes do envio; o hash comprova a integridade do arquivo desde o recebimento, não a autoria original da captura.'
  : '',
```
No frontend o valor é literal fixo, nunca medido:
```tsx
// frontend/app/dashboard/photographic-reports/components/PhotographicReportWorkspace.tsx:616-618
// `processMobileImage` sempre re-encoda neste fluxo. A flag faz o
client_reencoded: true,
```

O hash é calculado uma única vez no recebimento (`service.ts:1362`, `hash_sha256` em :1381) e nunca mais é recomputado: uma busca por `hash_sha256` em todo o módulo só encontra escrita e exibição — `renderer.ts:689`, `word.ts:923`, `service.ts:449` — nenhuma comparação contra os bytes em storage, nem no `buildPdfBuffer` (:2009-2024), que baixa o arquivo e nem confere.

REPRO: enviar a foto por API direta com `client_reencoded=false` → o PDF omite a ressalva, deixando o hash aparentar prova de autoria da captura. O inverso (`true` sobre um arquivo original de câmera) faz o documento afirmar um processamento que não ocorreu.

**Impacto** — A única afirmação de integridade probatória do documento — a nota de rodapé do Manifesto de Evidências — é controlada por quem envia a foto. Num relatório com registro profissional e ART, isso transforma a seção de integridade em passivo: ela declara ao leitor algo que o sistema não verificou. E, como o hash nunca é reconferido, uma troca do objeto no storage (por outro caminho) não seria detectada em nenhuma emissão futura.

**Causa raiz** — Metadado de proveniência aceito do cliente e usado como asserção do servidor. `buildIntegrityFlags` registra 'o cliente disse X' mas o renderer lê como 'o sistema constatou X'.

**Correção recomendada**

1) Derivar a ressalva de fato observável, não de declaração: comparar o EXIF do buffer recebido (presença de `DateTimeOriginal`/`Make`/`Model`) — ausência total é o indicador real de re-encode por canvas. Enquanto isso não existir, imprimir a ressalva SEMPRE (é a afirmação conservadora e correta) e remover `client_reencoded` do DTO.
2) Reconferir o hash na emissão: em `buildPdfBuffer`, após `downloadFileBuffer`, recalcular SHA-256 e comparar com `image.hash_sha256`; divergência deve marcar a linha do manifesto como "integridade não confere" e emitir evento forense — nunca falhar em silêncio.
3) Renomear a chave persistida para `client_reencoded_claimed` para que o dado não seja lido como constatação.

**Teste de regressão** — Unit de renderer: manifesto deve conter a ressalva de re-encode independentemente de `integrity_flags`. Unit de service: `buildPdfBuffer` com buffer cujo SHA-256 difere de `hash_sha256` deve produzir a marcação de divergência no manifesto e registrar o evento.

---

### 🟡 SGS-RF-SEC-009 — EXIF nunca é removido no servidor: GPS exato e identificação do dispositivo seguem no arquivo, enquanto o banco arredonda coordenadas 'por privacidade'

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Security |
| **Local** | `backend/src/modules/photographic-reports/photographic-reports.service.ts:1385` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O controle de privacidade declarado é explícito:
```ts
// service.ts:1385-1389
latitude: roundCoordinate(dto.latitude),
longitude: roundCoordinate(dto.longitude),
...
device_id: hashDeviceId(dto.device_id),
ip_address: maskIpAddress(ipAddress),
```
```ts
// shared/security/evidence-integrity.util.ts:59-65
/** É uma proteção de privacidade intencional... o documento comprova a região do registro, não a posição exata do trabalhador. */
export function roundCoordinate(value) { return Math.round(value * 100) / 100; }  // ~1 km
```
E a migration documenta a intenção (`1709000000370:124-126`: 'Arredondada para 2 casas (~1 km) por privacidade').

Mas os bytes originais são gravados intactos:
```ts
// service.ts:1352-1356
await this.documentStorageService.uploadFile(storageKey, buffer, file.mimetype);   // buffer = exatamente o que chegou
```
Não existe qualquer biblioteca ou rotina de remoção de metadados no backend: `grep -rn "sharp|exifr|piexif|stripExif|removeExif" backend/src/` não retorna nada, e `backend/package.json` não declara `sharp` nem nenhuma lib de EXIF.

O mesmo buffer é depois embutido inteiro no PDF (`service.ts:2016-2021` → `fileBufferToDataUrl` → `data:...;base64,<bytes originais>`), e o PDF é o documento distribuído externamente e validável publicamente por QR (`buildPublicValidationPresentation`, :1859-1907).

REPRO: `POST /photographic-reports/{id}/images` com um JPEG de câmera contendo GPSLatitude/GPSLongitude e Make/Model/SerialNumber. Baixar pela `download_url` (`service.ts:422`) ou extrair a imagem do PDF exportado e ler o EXIF: coordenadas em precisão de metros e identificação do aparelho estão presentes. A UI e a API, porém, mostram apenas `-23.56, -46.63` (~1 km) e um HMAC no lugar do device id.

**Impacto** — O controle de privacidade é aparente, não efetivo: a localização exata do trabalhador e a identificação do dispositivo viajam no arquivo distribuído ao cliente final e a qualquer pessoa com o link assinado. Sob a LGPD, é tratamento de dado de geolocalização precisa sem base declarada, exatamente contra a finalidade que o código afirma perseguir. A mitigação existente (`processMobileImage` no frontend, que re-encoda via canvas e destrói o EXIF) é client-side e opcional — a API aceita o original por chamada direta.

**Causa raiz** — A anonimização foi aplicada aos metadados estruturados (colunas) e não ao artefato que os contém. Não há normalização do binário na fronteira do servidor.

**Correção recomendada**

Reprocessar a imagem no servidor no upload, descartando todo metadado e mantendo só os pixels — o que também resolve o MIME declarado (SGS-RF-SEC-006) e reduz o custo do PDF (SGS-RF-PERF-007):
```ts
import sharp from 'sharp';
const normalized = await sharp(buffer)
  .rotate()                                   // aplica orientação EXIF antes de descartá-la
  .resize({ width: 1920, withoutEnlargement: true })
  .jpeg({ quality: 82, mozjpeg: true })       // sharp não copia EXIF por padrão
  .toBuffer();
const hashSha256 = createHash('sha256').update(normalized).digest('hex');
await this.documentStorageService.uploadFile(storageKey, normalized, 'image/jpeg');
```
Com isso, `client_reencoded` deixa de ser declaração do cliente e passa a ser fato do servidor (ver SGS-RF-INT-008).

**Teste de regressão** — Unit: `uploadImages` com JPEG contendo GPS deve gravar um buffer cujo parse de EXIF não retorne tags GPS nem Make/Model, e cujo `hash_sha256` corresponda ao buffer NORMALIZADO (não ao recebido). Teste de fixture: imagem com Orientation=6 deve sair visualmente correta após o strip.

---

### 🟡 SGS-RF-INT-010 — removeImage/removeDay fazem hard delete e apagam o arquivo do storage mesmo em relatório já finalizado ou exportado

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/photographic-reports/photographic-reports.service.ts:1542` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

```ts
// service.ts:1542-1565
async removeImage(reportId: string, imageId: string) {
  const companyId = this.getCompanyIdOrThrow();
  const report = await this.findReportEntity(reportId, companyId);
  const image = await this.ensureImageBelongsToReport(report, imageId);

  try {
    await this.documentStorageService.deleteFile(image.image_url);   // destrutivo, sem trava de status
  } catch (error) { this.logger.warn(...); }

  await this.imageRepository.delete({ id: image.id });               // HARD delete, apesar do @DeleteDateColumn
  await this.renumberImages(report);
  this.markEditingIfNeeded(report, PhotographicReportStatus.EM_EDICAO);   // única "consequência"
```
Mesmo padrão em `removeDay` (:1250-1265): `await this.dayRepository.delete({ id: dayId, report_id: report.id, company_id: companyId })`.

A entidade estende `BaseAuditEntity` e portanto TEM `deleted_at` (usado em `IsNull()` por `ensureImageBelongsToReport` :682 e `renumberImages` :385), e o índice único da migration 348 é parcial justamente em `deleted_at IS NULL` — ou seja, o schema foi preparado para soft delete que o código não usa.

Nenhuma checagem de `report.status`, `verification_code` ou `pdf_generated_at` precede a destruição.

**Impacto** — A evidência que lastreia um PDF já emitido (com hash registrado em `pdf_integrity_records` e código público impresso) pode ser apagada do banco e do storage sem deixar linha, sem deixar arquivo e — por SGS-RF-OBS-004 — sem deixar trilha forense. O PDF antigo continua validando pelo hash, mas o sistema perde a capacidade de exibir a evidência que ele documenta, e o `hash_sha256` daquela foto desaparece junto.

**Causa raiz** — Exclusão de evidência tratada como operação de edição de rascunho. O módulo aplica soft delete no agregado (`remove()` usa `softDelete`) mas hard delete nos filhos, invertendo a expectativa: o filho é o dado probatório.

**Correção recomendada**

1) Bloquear a remoção quando o relatório já foi emitido:
```ts
if (report.verification_code || report.pdf_generated_at || (report.exports || []).length > 0) {
  throw new BadRequestException('Fotos de relatório já emitido não podem ser removidas.');
}
```
2) Trocar `imageRepository.delete` por `imageRepository.softDelete` (o índice único parcial já suporta) e não chamar `deleteFile` — a remoção física fica para o job de retenção.
3) Idem para `removeDay`.

**Teste de regressão** — Unit: `removeImage` em relatório com `verification_code` preenchido deve lançar BadRequestException e não chamar `deleteFile` nem `delete`. Unit: `removeImage` em RASCUNHO deve chamar `softDelete` e a foto deixar de aparecer em `findOne`, mas a linha permanecer consultável com `withDeleted: true`.

---

### 🟡 SGS-RF-PERF-011 — finalize() reprocessa TODAS as fotos no LLM de visão, sequencialmente, dentro da requisição HTTP, sem idempotência

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Performance |
| **Local** | `backend/src/modules/photographic-reports/photographic-reports.service.ts:1682` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

```ts
// service.ts:1754-1766
async finalize(reportId: string) {
  ...
  const analyzed = await this.analyzeAllImages(reportId);   // reanálise integral
  const persisted = await this.findReportEntity(analyzed.id, companyId);
  persisted.status = PhotographicReportStatus.FINALIZADO;
```
```ts
// service.ts:1692-1708
for (const image of sortedImages) {
  ...
  const buffer = await this.documentStorageService.downloadFileBuffer(image.image_url);   // download serial
  const analysis = await this.aiAnalysisService.analyzePhotographicReportImage(buffer, ..., companyId);
  this.applyImageAnalysis(image, analysis);
  await this.imageRepository.save(image);                                                  // 1 UPDATE por foto
}
```
Não há filtro por `image.ai_title == null` — fotos já analisadas são reanalisadas e têm o conteúdo revisado pelo usuário SOBRESCRITO (`applyImageAnalysis` :1623-1635 atribui todos os campos `ai_*` sem condição). Não há `Idempotency-Key`, `@Throttle` nem enfileiramento; a rota é `POST /:id/finalize` síncrona (`controller.ts:297-309`), e `POST /:id/analyze` cai no mesmo `analyzeAllImages` via `generateReportSummary` (:1748-1752).

**Impacto** — Custo: cada clique em Finalizar dispara N chamadas de visão pagas, mesmo que nada tenha mudado — duplo submit dobra a fatura. Latência: com dezenas de fotos, a requisição estoura o timeout e o usuário reenvia, multiplicando o efeito. Dado: descrições e classificações corrigidas manualmente pelo responsável técnico (via `PATCH /:id/images/:imageId`) são silenciosamente substituídas pela saída do modelo no momento da finalização — perda de trabalho humano num documento assinado por um profissional com registro.

**Causa raiz** — Finalização e análise foram acopladas: `finalize` delega o trabalho pesado a `analyzeAllImages`, que não distingue "nunca analisada" de "analisada e revisada pelo humano".

**Correção recomendada**

1) Analisar apenas o que falta e nunca sobrescrever revisão humana:
```ts
const pendentes = sortedImages.filter((i) => !i.ai_title && !i.ai_description);
```
(e adicionar uma coluna `ai_reviewed_by`/`ai_reviewed_at` marcada por `updateImage` para tornar a proteção explícita).
2) Desacoplar: `finalize` deve exigir que todas as fotos já estejam analisadas e apenas transicionar o status, retornando 409 com a lista de pendências caso contrário.
3) Enfileirar a análise em lote (BullMQ) e aplicar `Idempotency-Key` nas rotas de análise e finalização.

**Teste de regressão** — Unit: `finalize()` sobre relatório cujas fotos já têm `ai_title` não deve chamar `aiAnalysisService.analyzePhotographicReportImage` nenhuma vez. Unit: foto com `ai_description` editada manualmente mantém o texto após `finalize()`. E2E: dois `POST /:id/finalize` simultâneos resultam em uma única execução de análise.

---

## NOT VERIFIED — o que não foi possível provar nesta rodada

- Enforcement real do RLS em runtime: não havia banco PostgreSQL disponível nesta sessão. As políticas das migrations 204/368 estão sintaticamente corretas (ENABLE + FORCE + USING + WITH CHECK nas 4 tabelas), mas não pude executar o teste decisivo — conectar como sgs_app com app.current_company_id do tenant A e tentar SELECT/UPDATE em linhas do tenant B.
- Ponto de atenção do RLS que só se prova com banco: as políticas das tabelas filhas (days/images/exports) resolvem o tenant por EXISTS sobre photographic_reports e NÃO amarram a coluna company_id da própria linha. Um INSERT com company_id de outro tenant e report_id do tenant corrente passaria no WITH CHECK. O código do serviço sempre grava company_id correto (service.ts:1364-1367), então não achei caminho de exploração pela API — mas a policy, isolada, permite a divergência.
- Vazamento de contexto entre requisições no pool: shared/database/tenant-db-context.service.ts:205-224 usa set_config(..., is_local = false), ou seja, escopo de SESSÃO, memoizado por contextKey no símbolo da conexão. Está fora do escopo deste módulo e exigiria teste de carga com tenants alternados para provar ou descartar reuso indevido de conexão.
- Comportamento do Backblaze B2 ao servir Content-Type controlado pelo cliente (SGS-RF-SEC-006): não pude confirmar se o bucket força nosniff/Content-Disposition na resposta da URL assinada. O impacto real do JPEG poliglota depende disso; o achado foi mantido em MEDIUM por essa incerteza.
- Confirmação empírica do 500 em reorderImages (SGS-RF-DB-005): o índice único parcial UQ_photographic_report_images_report_order_active só existe em PostgreSQL, e a suíte unitária do módulo usa repositórios mockados. A conclusão vem da leitura do índice (migration 348:125-131) somada à ordem de emissão dos UPDATEs por repository.save(array); não foi executada.
- Guards TenantGuard/PermissionsGuard/RolesGuard foram lidos apenas na superfície (aplicação no controller). Não auditei se x-company-id é validado contra as empresas do usuário — é responsabilidade transversal, já coberta por auditorias anteriores do projeto.
- Sandbox do Chromium: --no-sandbox está ativo (puppeteer-pool.service.ts:202) com mitigações compensatórias documentadas e verificadas no código (setContent, request interception, escape universal). Não validei a #4 da lista (container rodando como usuário não-root) porque não li o Dockerfile.worker nesta sessão.
