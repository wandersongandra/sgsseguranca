# Checklist — Relatório de Auditoria

> Escopo desta rodada: **Arquitetura · Backend · Banco · Segurança · Máquina de estados · Concorrência · Integridade documental · Observabilidade**.
> Frontend, Design/UX, PDF e Performance de carga ficaram para a rodada 2 (ver `00-master-audit.md` › Status).

## Resumo executivo

O módulo Checklist é um god-service de 3764 linhas com boa base de isolamento (RLS ENABLE+FORCE+RESTRICTIVE com WITH CHECK na tabela `checklists`, `findOneEntity` filtrando company_id + escopo de obra, `validateChecklistRelations` validando site/inspetor via serviços tenant-scoped, e `mutateChecklistLocked` com SELECT FOR UPDATE NOWAIT + retry/409 nos anexos de foto). O controller público é magro e correto: exige token assinado (`assertActiveToken`) amarrado a code+companyId+portal, com throttle 3/min e resposta genérica — não enumera. Porém a governança de fotos tem um furo estrutural: toda a validação de referência governada (`gst:checklist-photo:`) vive no caminho `itens` e é COMPLETAMENTE PULADA no caminho `topicos`, permitindo forjar uma referência para qualquer fileKey do bucket; como `documentStorageService.deleteFile()` não faz `assertTenantOwnership` (ao contrário do presign), isso vira DELEÇÃO ARBITRÁRIA de arquivo em storage, inclusive de outro tenant e inclusive de PDFs finais governados que a própria trava de `remove()` protege. Em segundo lugar, `is_modelo` é editável via PATCH (PartialType) e o reset de assinaturas retorna cedo para modelos — dá para alterar respostas de um checklist já assinado sem invalidar a assinatura e depois emitir o PDF final. Terceiro: o PDF final é 100% fornecido pelo cliente e o hash registrado não tem nenhum vínculo com o estado persistido do checklist; o `generatePdf()` do backend (237 linhas) é código morto sem nenhum chamador. Além disso a rota real de listagem (`findPaginated`) perde o filtro de obra em modelos que `findAll` aplica, o JSONB hierárquico não tem nenhum limite de tamanho/quantidade, e o único E2E do escopo tem asserts condicionais e um teste cujo nome promete `ON DELETE SET NULL` sem nunca deletar nada.

| Severidade | Confirmados |
|---|---|
| 🟠 HIGH | 2 |
| 🟡 MEDIUM | 6 |
| 🔵 LOW | 1 |
| ⚫ REFUTADO na verificação | 1 |

## Máquina de estados observada no código

## Máquina de estados observada NO CÓDIGO

### Eixo 1 — natureza do registro (`is_modelo`)

| Estado | Como entra | Quem pode | Efeitos observados no código |
|---|---|---|---|
| `is_modelo = false` (execução) | `POST /checklists` (default `false` na entity, `checklist.entity.ts:71-72`) | ADMIN_GERAL / ADMIN_EMPRESA / TST / SUPERVISOR + `can_manage_checklists` | exige `site_id` e `inspetor_id` (`assertChecklistExecutionRequirements`, service:577-595); sujeito à trava de PDF final (`assertChecklistDocumentMutable`, service:597-609) |
| `is_modelo = true` (modelo) | `POST /checklists {is_modelo:true}`, `POST /checklists/templates/bootstrap`, `POST /checklists/seed/welding-machine`, `POST /checklists/import-word` | idem | **pula** validação de obra/inspetor (service:580-582); **pula** a trava de PDF final (service:600-602); **pula** o reset de assinaturas (service:1638-1640); não pode emitir PDF final (service:617-621) |
| `false -> true` e `true -> false` | **`PATCH /checklists/:id {is_modelo}`** (service:2491-2493, DTO herda de `PartialType(CreateChecklistDto)`) | idem | **transição livre, sem guarda nenhuma** — vetor do achado SGS-CHK-STM-002 |

### Eixo 2 — status de conformidade (derivado, não comandado)

| Estado | Transição | Regra |
|---|---|---|
| `Pendente` | derivado | execução sem itens, ou algum status vazio/`Pendente` (`deriveChecklistStatus`, service:1745-1794) |
| `Não Conforme` | derivado | qualquer item/subitem com `nok`/`nao`/`false`/`Não Conforme` |
| `Conforme` | derivado | todos os itens avaliados sem NC |
| qualquer | `status` do cliente | **só honrado quando `is_modelo = true`** (service:1734-1743). Em execução o valor do DTO é ignorado — correto. |

CHECK no banco: `chk_checklists_status IN ('Pendente','Conforme','Não Conforme','Parcialmente Conforme')` (migration 320) — aceita `Parcialmente Conforme`, valor que o código nunca produz nem aceita no DTO.

### Eixo 3 — ciclo documental (execução)

| Estado | Entrada | Saída permitida | Guarda no código |
|---|---|---|---|
| Rascunho (sem `pdf_file_key`) | `create` / `fillFromTemplate` | editar itens, anexar fotos, assinar, remover | `assertChecklistDocumentMutable` passa |
| Assinado (>=1 signature, sem PDF) | `POST /signatures` (módulo externo) | emitir PDF final | `assertChecklistReadyForFinalPdf` exige `!is_modelo` + site + inspetor + >=1 assinatura (service:611-636) |
| Emitido (`pdf_file_key` != null) | `POST /:id/file` (`attachPdf`, service:3294) | **nada** — `update`, `attachEquipmentPhoto`, `attachItemPhoto` e `remove` devolvem 400 | `assertChecklistDocumentMutable` (service:604-608) + `remove` (service:2565-2569) |

**Transições ilegais que o código NÃO impede:**
1. Assinado -> itens alterados -> ainda "Assinado" com a assinatura antiga: `PATCH {is_modelo:true, topicos:[...]}` seguido de `PATCH {is_modelo:false}` (SGS-CHK-STM-002).
2. Emitido -> emitido novamente com outro PDF: duas chamadas concorrentes a `POST /:id/file` passam ambas na guarda (SGS-CHK-CON-007).
3. Emitido (de OUTRO documento/tenant) -> arquivo destruído: via referência de foto forjada + `DELETE /checklists/:idForjado` (SGS-CHK-SEC-001).

## Achados

### ⚫ SGS-CHK-SEC-001 — Caminho `topicos` pula 100% da validação de referência de foto governada -> deleção arbitrária de arquivo no storage (inclusive cross-tenant)

| | |
|---|---|
| **Severidade** | REFUTADO |
| **Categoria** | Security |
| **Local** | `backend/src/modules/checklists/checklists.service.ts:1361` |
| **Verificação adversarial** | REFUTED — REFUTADO por leitura direta do código. O auditor afirmou que o caminho `topicos` pula a validação de referência governada. Falso: `flattenChecklistTopics` repassa `...options` — incluindo `allowedGovernedReferences` — para `normalizeChecklistItemValue` (checklists.service.ts:1259-1260), exatamente como `normalizeChecklistItems` faz (checklists.service.ts:1187-1190). Os dois caminhos convergem no MESMO ponto de checagem (checklists.service.ts:818), que é fail-closed por optional chaining: com `allowedGovernedReferences` indefinido, `!options?.allowedGovernedReferences?.has(x)` avalia `true` e rejeita. |

> **Este achado foi refutado.** Mantido no relatório para rastreabilidade — não deve entrar no roadmap de correção.

### 🟠 SGS-CHK-STM-002 — `is_modelo` é editável via PATCH e desliga o reset de assinaturas: respostas alteradas depois de assinado, com a assinatura sobrevivendo

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | StateMachine |
| **Local** | `backend/src/modules/checklists/checklists.service.ts:2491` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`UpdateChecklistDto` é `PartialType(CreateChecklistDto)` (update-checklist.dto.ts:1-4), então `is_modelo` (create-checklist.dto.ts:114-116, `@IsBoolean() @IsOptional()`) entra no whitelist do ValidationPipe e é aplicado sem guarda alguma:

```ts
// service.ts:2491-2493
if (updateChecklistDto.is_modelo !== undefined) {
  checklist.is_modelo = updateChecklistDto.is_modelo;
}
```

O reset de assinaturas roda DEPOIS do save, sobre a entidade já salva, e retorna cedo para modelo:

```ts
// service.ts:1634-1640
private async resetChecklistSignatures(
  checklist: Pick<Checklist,'id'|'company_id'|'site_id'|'is_modelo'>, reason: string,
): Promise<boolean> {
  if (checklist.is_modelo) {
    return false;      // <-- saved.is_modelo já é true
  }

// service.ts:2533-2537
const materialChanged =
  previousMaterialSnapshot !== this.buildChecklistMaterialSnapshot(saved);
const signaturesReset = materialChanged
  ? await this.resetChecklistSignatures(saved, 'material_update')
  : false;
```

E `buildChecklistMaterialSnapshot` (service:1596-1632) NÃO inclui `is_modelo` no snapshot, então a volta para execução não conta como mudança material.

REPRODUÇÃO:
1. Criar checklist operacional, responder itens, assinar via `POST /signatures {document_type:'CHECKLIST'}` (fluxo idêntico ao E2E, checklist-lifecycle.e2e-spec.ts:214-226).
2. `PATCH /checklists/{id}` com `{ is_modelo: true, itens: [ ...respostas trocadas de 'nok' para 'ok'... ] }`. A ordem em `update()` aplica `itens` (2481) ANTES de `is_modelo` (2491); `saved.is_modelo === true`; `materialChanged === true`; `resetChecklistSignatures` retorna `false` na primeira linha. Assinatura intacta.
3. `PATCH /checklists/{id}` com `{ is_modelo: false }`. Snapshot material idêntico -> `materialChanged === false` -> nenhum reset.
4. `POST /checklists/{id}/file`: `assertChecklistReadyForFinalPdf` (service:611-636) confere `!is_modelo` (ok), site, inspetor e `signatures.length` (ok, a assinatura pré-adulteração está lá) -> PDF final governado emitido, com registry, hash e código público, sobre conteúdo alterado após a assinatura.

**Impacto** — Quebra do vínculo assinatura<->conteúdo no documento governado. Um checklist reprovado (`Não Conforme`, item crítico com `bloqueia_operacao_quando_nc`) pode ser convertido em `Conforme` depois de assinado pelo inspetor, e ainda assim virar documento final com QR de validação pública. Em contexto SST isso é falsificação de evidência de inspeção com valor probatório (NR-12/NR-33/NR-35). O próprio código declara a intenção oposta — há reset de assinatura em update material, em troca de foto de equipamento e em adição de foto de item — mas ela é anulada por um único campo booleano do payload.

**Causa raiz** — Campo de classificação estrutural (`is_modelo`) tratado como atributo editável comum, herdado automaticamente pelo `PartialType`. Somado a isso, o reset de assinatura é decidido pelo estado PÓS-mutação (`saved`) em vez do estado PRÉ-mutação (`checklist` carregado), e o snapshot material ignora justamente o campo que controla o reset.

**Correção recomendada**

Três ajustes:

(1) Proibir a transição no update — `is_modelo` é imutável após a criação:
```ts
// service.ts, substituir 2491-2493
if (
  updateChecklistDto.is_modelo !== undefined &&
  updateChecklistDto.is_modelo !== checklist.is_modelo
) {
  throw new BadRequestException(
    'A natureza do checklist (modelo x execução) não pode ser alterada. Crie um novo registro.',
  );
}
```
(ou declarar `is_modelo?: never` com `@IsEmpty()` em um `UpdateChecklistDto` explícito, no mesmo padrão já usado para `company_id` em create-checklist.dto.ts:58-63).

(2) Decidir o reset pelo estado ORIGINAL, não pelo salvo:
```ts
// service.ts:2535
const signaturesReset = materialChanged
  ? await this.resetChecklistSignatures(
      { ...saved, is_modelo: wasModeloBeforeUpdate }, 'material_update')
  : false;
```

(3) Incluir `is_modelo` em `buildChecklistMaterialSnapshot` (service:1613-1631) para que qualquer flip futuro conte como mudança material.

**Teste de regressão** — `checklists.service.spec.ts`: (a) `update` com `{is_modelo: true}` sobre execução deve lançar `BadRequestException`; (b) teste da cadeia completa — mock de `signaturesService.removeByDocumentSystem`, `update({is_modelo:true, itens:[alterados]})` e assert que `removeByDocumentSystem` FOI chamado (hoje não é). E2E em `checklist-lifecycle.e2e-spec.ts`: assinar, `PATCH {is_modelo:true, itens:[...]}`, `PATCH {is_modelo:false}`, e exigir que `POST /:id/file` retorne 400 com a mensagem de 'assinatura'.

---

### 🟠 SGS-CHK-INT-003 — PDF final governado é totalmente fornecido pelo cliente e o hash registrado não tem vínculo nenhum com o estado do checklist; o gerador do backend é código morto

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/checklists/checklists.service.ts:3294` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`attachPdf` recebe o arquivo do cliente e registra o hash DELE, sem comparar com nada do checklist:

```ts
// service.ts:3294-3353
async attachPdf(id: string, file: Express.Multer.File, userId?: string) {
  const checklist = await this.findOneEntity(id);
  await this.assertChecklistReadyForFinalPdf(checklist);
  ...
  await this.documentStorageService.uploadFile(fileKey, file.buffer, file.mimetype);
  await this.documentGovernanceService.registerFinalDocument({
    ...
    fileBuffer: file.buffer,      // <-- hash é do arquivo enviado
```

e em `document-governance.service.ts:122`: `const hash = this.pdfService.computeHash(input.fileBuffer);`. As validações prévias (`assertChecklistReadyForFinalPdf`, service:611-636) checam apenas: não é modelo, tem site, tem inspetor, não tem PDF ainda, tem >=1 assinatura. Nada sobre o CONTEÚDO do PDF (só magic bytes de PDF + ClamAV, controller:291-295).

Enquanto isso, `ChecklistsService.generatePdf(checklist)` — 237 linhas (service:2897-3134) que renderizam tópicos, barreiras, subitens, foto governada do equipamento e assinaturas — não tem NENHUM chamador em todo o backend:
```
$ grep -rn "generatePdf" backend/src --include=*.ts
src/modules/checklists/checklists.service.ts:2897:  async generatePdf(checklist: Checklist): Promise<Buffer> {
```
(os outros hits do grep são `regeneratePdfWithSupersededWatermark` do módulo APR). O endpoint legado que o usava foi transformado em `GoneException` (controller:268-275 e service:3276-3292).

Consequência direta e testável: `POST /checklists/{id}/file` com um PDF de conteúdo arbitrário (o próprio E2E envia um PDF sintético de 8 linhas que não tem relação alguma com o checklist — checklist-lifecycle.e2e-spec.ts:8-27 e 228-241) resulta em 201, `document_registry` ativo, hash registrado em `pdf_hash_integrity`, código público `CHK-{ano}-{8 chars}` válido em `/public/checklists/validate` e trilha forense `FINAL_DOCUMENT_REGISTERED`.

**Impacto** — O 'documento governado' certifica apenas que um arquivo foi enviado e não mudou depois — não que ele corresponda às respostas do checklist. A validação pública por QR (`validateByCode`, service:3709-3744) confirma o registry, dando ao terceiro que escaneia a impressão de que o conteúdo é o oficial. Um usuário com `can_manage_checklists` pode emitir como documento oficial de inspeção um PDF completamente diferente do checklist respondido no sistema, e nenhuma verificação server-side detecta a divergência. Também deixa 237 linhas de código morto que chamam `resolveChecklistPdfImage` -> `documentStorageService.downloadFileBuffer(fileKey)` (service:2004-2025 e 156-167) — este SEM `assertTenantOwnership` — pronto para virar leitura cross-tenant se alguém reativar o gerador.

**Causa raiz** — Migração do fluxo de PDF para o cliente (padrão `frontend/pdf-system`) sem substituir a garantia perdida: nem regeneração server-side para comparação, nem assinatura do payload de renderização, nem snapshot imutável do estado no momento da emissão. O gerador antigo foi deixado no arquivo em vez de removido ou promovido a fonte da verdade.

**Correção recomendada**

Escolher uma das duas e implementar de fato:

(A) Backend passa a ser a fonte do PDF: reativar `generatePdf` e emitir a partir do estado persistido — `POST /:id/file` deixa de aceitar corpo e o service faz `const buffer = await this.generatePdf(checklist)` antes de `uploadFile`/`registerFinalDocument`. Elimina a divergência por construção.

(B) Manter o PDF do cliente, mas amarrar ao estado: persistir junto ao registry o snapshot material no instante da emissão, dando ao verificador as duas pontas:
```ts
// service.ts, dentro de attachPdf, antes de registerFinalDocument
const stateHash = createHash('sha256')
  .update(this.buildChecklistMaterialSnapshot(checklist))  // já existe, service:1596
  .digest('hex');
// e propagar stateHash no metadata do registry e na trilha forense,
// bloqueando a emissão se o snapshot mudou entre a última assinatura e o upload.
```

Em ambos os casos, remover `generatePdf`/`resolvePdfImage`/`resolveChecklistPdfImage` se ficarem sem uso, e adicionar `assertTenantOwnership` em `downloadFileBuffer`.

**Teste de regressão** — E2E: criar checklist, assinar, e emitir `POST /:id/file` com um PDF cujo conteúdo textual não contém o título do checklist -> deve falhar (opção A: endpoint não aceita corpo; opção B: 400 por divergência de `stateHash`). Teste unitário adicional: emitir, depois alterar `itens` e tentar reemitir, exigindo bloqueio. E um teste de arquitetura simples que falhe se `generatePdf` continuar sem chamador (ou seja removido).

---

### 🟡 SGS-CHK-BAK-004 — `findPaginated` (a rota que o controller realmente usa) perde o filtro de obra em modelos que `findAll` aplica

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Backend |
| **Local** | `backend/src/modules/checklists/checklists.service.ts:2372` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`GET /checklists` chama `findPaginated` (checklists.controller.ts:144-162). No caminho sem `segment` — o caminho default — a query é montada assim:

```ts
// service.ts:2263-2266
const applySiteFilter = !isSuperAdmin && siteScope !== 'all';
if (applySiteFilter && !options?.onlyTemplates) {
  filter.site_id = In(siteIds);
}
...
// service.ts:2372-2380
const [rows, total] = await this.checklistsRepository.findAndCount({
  where: { ...filter, deleted_at: IsNull() },   // <-- sem nenhuma cláusula de obra quando onlyTemplates=true
  select: this.checklistListSelect,
  relations: ['company', 'site', 'inspetor'],
  ...
});
```

`findAll`, para o mesmo caso, aplica explicitamente a regra e a documenta:

```ts
// service.ts:2206-2212
if (applySiteFilter && options?.onlyTemplates) {
  // Do not skip site filters improperly for templates: global templates (null site) + site-matching ones
  findWhere = [
    { ...filter, site_id: IsNull(), deleted_at: IsNull() },
    { ...filter, site_id: In(siteIds), deleted_at: IsNull() },
  ];
}
```

O caminho `segment` de `findPaginated` também aplica a regra (service:2307-2312). Só o caminho default — o mais usado — não aplica. `findOneEntity` (service:2401-2411) bloqueia o acesso individual, então o vazamento é de listagem.

**Impacto** — Usuário restrito à obra A recebe, em `GET /checklists?onlyTemplates=true`, os modelos criados especificamente para a obra B da mesma empresa: `titulo`, `descricao`, `equipamento`, `maquina`, `site.nome`, `inspetor.nome` (campos de `checklistListSelect`, service:435-464). Sem cross-tenant (company_id sempre aplicado) e sem acesso ao corpo (`itens` fora do select), mas é quebra do isolamento por obra que o restante do módulo se esforça para manter, e o próprio comentário do código declara a intenção violada. Também produz incoerência visível: `findAll` e `findPaginated` respondem conjuntos diferentes para o mesmo usuário e filtro.

**Causa raiz** — Regra de escopo duplicada em três lugares (`findAll` sem segmento, `findPaginated` com segmento, `findPaginated` sem segmento) e implementada em dois deles. Sintoma clássico do god-service: a mesma decisão de autorização reescrita a cada método de listagem.

**Correção recomendada**

Extrair a construção do `where` para um helper único usado pelos três caminhos:
```ts
// service.ts
private buildChecklistScopeWhere(
  filter: FindOptionsWhere<Checklist>,
  opts: { onlyTemplates?: boolean; applySiteFilter: boolean; siteIds: string[] },
): FindOptionsWhere<Checklist> | FindOptionsWhere<Checklist>[] {
  if (!opts.applySiteFilter) return { ...filter, deleted_at: IsNull() };
  if (opts.onlyTemplates) {
    return [
      { ...filter, site_id: IsNull(), deleted_at: IsNull() },
      { ...filter, site_id: In(opts.siteIds), deleted_at: IsNull() },
    ];
  }
  return { ...filter, site_id: In(opts.siteIds), deleted_at: IsNull() };
}
```
e trocar as linhas 2204-2212 e 2372-2373 por chamadas a ele.

**Teste de regressão** — `checklists.service.spec.ts`: usuário com `siteScope='single'` e `siteIds=['site-A']` chamando `findPaginated({onlyTemplates:true})` deve produzir um `where` com a cláusula OR (site_id IS NULL | IN ['site-A']). E2E: criar modelo com `site_id` = obra B, autenticar usuário escopado na obra A, `GET /checklists?onlyTemplates=true` e exigir que o id do modelo da obra B não apareça em `data`.

---

### 🟡 SGS-CHK-BR-005 — `fillFromTemplate` quebra com 400 para qualquer modelo que tenha foto de equipamento governada (e, se não quebrasse, faria dois checklists compartilharem o mesmo arquivo)

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | BusinessRule |
| **Local** | `backend/src/modules/checklists/checklists.service.ts:3247` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Modelos PODEM receber foto governada: `attachEquipmentPhoto` (service:2605-2612) chama `assertChecklistDocumentMutable`, que retorna cedo para modelo (service:600-602), então `POST /checklists/{modeloId}/equipment-photo` grava um `gst:checklist-photo:...` em `foto_equipamento`.

`buildChecklistFromTemplate` copia esse valor para a execução nova:
```ts
// service.ts:1909-1910
foto_equipamento:
  fillData.foto_equipamento ?? template.foto_equipamento ?? undefined,
```

e `fillFromTemplate` o normaliza SEM conjunto de referências permitidas:
```ts
// service.ts:3246-3251
const newChecklist = this.buildChecklistFromTemplate(template, fillData);
newChecklist.foto_equipamento =
  this.normalizeChecklistPhotoReference(
    newChecklist.foto_equipamento,
    'Foto do equipamento',
  ) ?? '';        // <-- sem allowedGovernedReferences
```

Com `allowedGovernedReferences` undefined, `normalizeChecklistPhotoReference` (service:815-824) cai direto no `throw new BadRequestException('... deve ser enviado pelo endpoint governado de fotos do checklist.')`. Ou seja: `POST /checklists/fill-from-template/{id}` e `POST /checklists/fill-from-model/{id}` (controller:244-266) respondem 400 permanente para esse modelo, sem que o payload do usuário tenha qualquer erro.

Não é falso positivo por reset: `resetExecutionState` só zera fotos de ITEM (service:1144-1149), nunca `foto_equipamento`.

**Impacto** — Um modelo que recebeu foto do equipamento fica permanentemente inutilizável — todo preenchimento a partir dele falha com uma mensagem que aponta para o endpoint errado ('envie pelo endpoint governado'), sem caminho de recuperação pela UI. E o comportamento 'correto' aparente também seria errado: se a referência fosse aceita, a execução e o modelo passariam a apontar para o MESMO `fileKey`, e a remoção da execução (`remove()` -> `cleanupGovernedChecklistPhotoFiles`, service:2592-2597) apagaria o arquivo do modelo, quebrando todas as execuções anteriores. As duas pontas do bug estão no mesmo trecho.

**Causa raiz** — `buildChecklistFromTemplate` copia a REFERÊNCIA de storage em vez de copiar o ARQUIVO. Nenhum dos dois modelos mentais (compartilhar vs. duplicar) foi implementado; o código herda a string e depois esbarra na validação anti-forja, que não distingue 'referência forjada pelo cliente' de 'referência herdada de linha confiável do banco' — distinção que `cloneChecklistItems` (service:1839-1857) já resolve para itens, mas que não foi aplicada ao equipamento.

**Correção recomendada**

Duplicar o objeto no storage, para que cada execução tenha o próprio arquivo e o próprio ciclo de vida:
```ts
// service.ts, em fillFromTemplate, no lugar de 3247-3251
const inherited = this.parseGovernedChecklistPhotoReference(template.foto_equipamento);
if (!fillData.foto_equipamento && inherited) {
  const buffer = await this.documentStorageService.downloadFileBuffer(inherited.fileKey);
  const newKey = this.documentStorageService.generateDocumentKey(
    template.company_id, 'checklist-photos', newChecklist.id ?? randomUUID(), inherited.originalName,
  );
  await this.documentStorageService.uploadFile(newKey, buffer, inherited.mimeType);
  newChecklist.foto_equipamento = this.buildGovernedChecklistPhotoReference({
    ...inherited, fileKey: newKey, uploadedAt: new Date().toISOString(),
  });
} else {
  newChecklist.foto_equipamento =
    this.normalizeChecklistPhotoReference(fillData.foto_equipamento, 'Foto do equipamento') ?? '';
}
```
Alternativa mínima: não herdar `foto_equipamento` de modelo (deixar vazio e exigir upload na execução).

**Teste de regressão** — `checklists.service.spec.ts`: mockar `findOneEntity` devolvendo modelo com `is_modelo:true` e `foto_equipamento: 'gst:checklist-photo:<payload válido>'`, chamar `fillFromTemplate(templateId, { site_id, inspetor_id })` e exigir 201 com `foto_equipamento` apontando para um fileKey DIFERENTE do modelo. Segundo teste: remover a execução e verificar que `deleteFile` foi chamado com a chave da cópia, nunca com a do modelo.

---

### 🟡 SGS-CHK-DB-006 — JSONB hierárquico sem nenhum limite de tamanho, quantidade ou profundidade — payload de 5 MB por checklist, com índice GIN sobre a coluna

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Database |
| **Local** | `backend/src/modules/checklists/dto/checklist-item.dto.ts:107` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Nenhum DTO do módulo tem `@MaxLength` ou `@ArrayMaxSize`. Todos os campos de texto são livres e todos os arrays são ilimitados:

```ts
// checklist-item.dto.ts:102-140  (nenhum @MaxLength, nenhum @ArrayMaxSize)
@IsOptional() @IsString() @Transform(sanitizePlainTextTransform)
acao_corretiva_imediata?: string;
@IsOptional() @IsString() @Transform(sanitizePlainTextTransform)
observacao?: string;
@IsOptional() @IsArray() @IsString({ each: true })
fotos?: string[];
@IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ChecklistSubitemDto)
subitens?: ChecklistSubitemDto[];

// checklist-topic.dto.ts:84-88 — só piso, nunca teto
@IsArray() @ArrayMinSize(1, {...}) @ValidateNested({ each: true }) @Type(() => ChecklistItemDto)
itens: ChecklistItemDto[];

// create-checklist.dto.ts:100-112 — idem para topicos
```

`sanitizePlainText` (shared/utils/plain-text-sanitizer.util.ts:11-22) apenas escapa 5 caracteres HTML e remove NUL — não trunca nada, e o escape de `&`/`<`/`>` INFLA a string (cada `&` vira 5 bytes).

O único teto é o body parser global: `app.use(json({ limit: '5mb' }))` (src/main.ts:334). Ou seja, cada `POST /checklists` / `PATCH /checklists/:id` pode gravar ~5 MB (mais, após o escape) na coluna `itens jsonb`, sem limite de itens, subitens, fotos por item ou profundidade lógica.

Agravante de banco: a migration 320 cria `CREATE INDEX ... idx_checklists_itens_gin ON checklists USING GIN (itens)` (1709000000320-add-checklists-gin-index-and-checks.ts) com `jsonb_ops`, que indexa cada chave E cada valor do documento como entrada individual.

O throttle limita a taxa (10/min por usuário, 30/min e 120/h por tenant — controller:138-139), não o tamanho.

**Impacto** — (a) Armazenamento: 120 requisições/hora × ~5 MB = ~600 MB/h de jsonb por tenant, sem cota. (b) Leitura: `findOne`/`update` carregam o jsonb inteiro e o `toChecklistResponse` reagrupa tudo em memória via `buildChecklistTopicsFromItems` (service:1393-1553), com sorts aninhados e `classifyChecklistItemAssessment` por item — CPU no event loop proporcional ao payload. (c) Índice GIN com `jsonb_ops` tem teto por entrada; valores de texto muito longos dentro do jsonb podem fazer o próprio INSERT/UPDATE falhar com 'index row size exceeds maximum', transformando um payload legítimo grande em 500 recorrente para aquele checklist. (d) O escape de `sanitizePlainText` amplifica: um texto só de `&` quintuplica antes de chegar ao banco.

**Causa raiz** — Validação estrutural (tipos, enums, nested) foi feita com cuidado, mas validação dimensional foi inteiramente omitida — nenhum campo do módulo tem teto. A defesa foi delegada implicitamente ao limite de 5 MB do body parser, que é global e generoso demais para um documento cujo caso de uso real são dezenas de itens.

**Correção recomendada**

Adicionar tetos coerentes com o domínio (um checklist SST real tem dezenas de itens, não milhares) e alinhar com o teto do índice GIN:
```ts
// checklist-item.dto.ts
@IsString() @MaxLength(500) item: string;
@IsOptional() @IsString() @MaxLength(2000) observacao?: string;
@IsOptional() @IsString() @MaxLength(1000) acao_corretiva_imediata?: string;
@IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(2048, { each: true }) fotos?: string[];
@IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ChecklistSubitemDto) subitens?: ChecklistSubitemDto[];

// checklist-topic.dto.ts
@IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) ... itens: ChecklistItemDto[];

// create-checklist.dto.ts
@ArrayMaxSize(200) itens?: ChecklistItemDto[];
@ArrayMaxSize(50)  topicos?: ChecklistTopicDto[];
```
E, defesa em profundidade, um CHECK no banco: `ALTER TABLE checklists ADD CONSTRAINT chk_checklists_itens_size CHECK (pg_column_size(itens) < 1048576);` (migration nova, próximo timestamp livre).

**Teste de regressão** — `checklists.controller.spec.ts` / teste de pipe: `POST /checklists` com `topicos: [{titulo:'t', itens: Array(5000).fill({item:'x'})}]` deve retornar 400 com erro de `ArrayMaxSize`, e com `observacao` de 100 000 caracteres deve retornar 400 com `MaxLength` — hoje ambos retornam 201. Teste de banco (integração) inserindo um `itens` de ~2 MB e exigindo rejeição pelo CHECK em vez de erro do índice GIN.

---

### 🟡 SGS-CHK-CON-007 — `attachPdf` emite o documento final sem lock nem guarda condicional: duas emissões concorrentes passam ambas e deixam arquivo órfão no B2

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Concurrency |
| **Local** | `backend/src/modules/checklists/checklists.service.ts:3299` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Todo o resto do módulo que faz read-modify-write usa `mutateChecklistLocked` com `SELECT ... FOR UPDATE NOWAIT` + retry + 409 (service:497-545, usado por `attachEquipmentPhoto` 2638-2650 e `attachItemPhoto` 2739-2756). A emissão do documento final — a operação mais crítica — não usa:

```ts
// service.ts:3299-3327
const checklist = await this.findOneEntity(id);          // leitura sem lock
await this.assertChecklistReadyForFinalPdf(checklist);   // checa pdf_file_key == null (service:604)
...
await this.documentStorageService.uploadFile(fileKey, file.buffer, file.mimetype);  // upload fora de tx
...
await this.documentGovernanceService.registerFinalDocument({
  ...
  persistEntityMetadata: async (manager) => {
    await manager.getRepository(Checklist).update(
      { id: checklist.id },                              // <-- UPDATE incondicional, sem AND pdf_file_key IS NULL
      { pdf_file_key: fileKey, pdf_folder_path: folderPath, pdf_original_name: file.originalname },
    );
  },
});
```

O `fileKey` inclui `Date.now()` (document-storage.service.ts:47-59), então duas requisições geram chaves distintas e ambos os uploads sucedem. `registerFinalDocument` (document-governance.service.ts:119-183) abre a transação SÓ depois do upload, e o único guarda de reentrada dentro dela é `if (existing?.finalized_at || existing?.signed_at)` (document-registry.service.ts:101-105) — campos que `attachPdf` nunca popula. Não há `Idempotency-Key` obrigatória na rota (controller:277-305); o throttle de 5/min por usuário não serializa nada.

**Impacto** — Duas emissões simultâneas (duplo clique, retry de rede do app, reenvio pelo mobile) produzem: dois objetos no Backblaze B2, dois hashes registrados em `pdf_hash_integrity` como válidos para o mesmo documento, dois eventos `FINAL_DOCUMENT_REGISTERED` na trilha forense, e `checklists.pdf_file_key` apontando para o vencedor da corrida — o arquivo perdedor fica órfão no storage para sempre (nenhuma rotina o referencia) e seu hash continua 'válido' no registro de integridade. Um verificador que confira o hash de um PDF baixado de um link antigo obtém 'válido' para um arquivo que não é mais o documento oficial. Custo de armazenamento acumula silenciosamente.

**Causa raiz** — O padrão de serialização já existente e documentado no próprio arquivo (`mutateChecklistLocked`, com o comentário 'espelha executePtWorkflowTransition', service:487-496) foi aplicado às fotos e não à emissão. A checagem de 'já emitido' é feita em memória sobre uma leitura sem lock (TOCTOU), e a escrita final é um UPDATE sem predicado de estado.

**Correção recomendada**

Serializar a emissão na mesma linha e tornar a escrita condicional:
```ts
// service.ts, em attachPdf, envolver a fase de persistência
persistEntityMetadata: async (manager) => {
  const res = await manager.getRepository(Checklist)
    .createQueryBuilder()
    .update(Checklist)
    .set({ pdf_file_key: fileKey, pdf_folder_path: folderPath, pdf_original_name: file.originalname })
    .where('id = :id AND company_id = :companyId AND pdf_file_key IS NULL', {
      id: checklist.id, companyId: checklist.company_id,
    })
    .execute();
  if (!res.affected) {
    throw new ConflictException('Este checklist já teve o PDF final emitido.');
  }
},
```
(o `throw` dentro da transação de `registerFinalDocument` já dispara o `cleanupUploadedFile` do catch em service:3366-3373, removendo o upload perdedor). Complementarmente, exigir `Idempotency-Key` na rota, já que o `IdempotencyInterceptor` é global (app.module.ts:1380-1383).

**Teste de regressão** — `checklists.service.spec.ts`: disparar `Promise.allSettled([attachPdf(id,f1), attachPdf(id,f2)])` com o repositório mockado devolvendo `affected: 0` na segunda chamada e exigir exatamente um sucesso, um `ConflictException`, e uma chamada a `deleteFile` com a chave perdedora. E2E: dois `POST /:id/file` concorrentes -> um 201 e um 409, e `GET /:id/pdf` retornando o fileKey do vencedor.

---

### 🟡 SGS-CHK-INT-008 — `update()` não é transacional: salva itens, apaga arquivos do storage e reseta assinaturas em três operações independentes

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/checklists/checklists.service.ts:2519` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Ao contrário de `remove()` (que usa `this.dataSource.transaction`, service:2575-2602), o `update()` executa quatro efeitos colaterais em sequência, sem transação e sem compensação:

```ts
// service.ts:2519-2537
const saved: Checklist = await this.checklistsRepository.save(checklist);      // (1) grava itens
const nextPhotoEntries = this.getGovernedChecklistPhotoEntries(saved);
...
if (removedPhotoEntries.length > 0) {
  await this.cleanupGovernedChecklistPhotoFiles(saved.id, removedPhotoEntries); // (2) deleta arquivos no B2
}
const materialChanged =
  previousMaterialSnapshot !== this.buildChecklistMaterialSnapshot(saved);
const signaturesReset = materialChanged
  ? await this.resetChecklistSignatures(saved, 'material_update')              // (3) invalida assinaturas
  : false;
```

E `cleanupGovernedChecklistPhotoFiles` engole toda falha de storage em um catch que só loga (service:1580-1591):
```ts
} catch (error) {
  this.logChecklistEvent('checklist_photo_storage_cleanup_failed', null, {...});
}
```

Não há lock na linha durante o update — `mutateChecklistLocked` (service:497) existe e é usado só pelos anexos de foto.

**Impacto** — Se (3) falhar (Redis/DB indisponível, `removeByDocumentSystem` lançando), o checklist fica com as respostas NOVAS e as assinaturas ANTIGAS, e o request retorna 500 — o operador vê erro e assume que nada mudou, quando na verdade ficou num estado que permite emitir PDF final sobre conteúdo alterado (mesmo desfecho do SGS-CHK-STM-002, sem precisar do flip de `is_modelo`). Se (2) falhar, o arquivo continua no B2 sem referência (órfão silencioso, custo permanente). E, sem lock, um `update` concorrente com `attachItemPhoto` pode perder a foto recém-anexada: `attachItemPhoto` serializa contra outro `attachItemPhoto`, mas `update()` salva a entidade lida antes do lock existir.

**Causa raiz** — Efeitos colaterais de domínios diferentes (linha do checklist, storage externo, tabela de assinaturas) orquestrados linearmente no service, sem unidade de trabalho. O padrão correto já existe duas vezes no mesmo arquivo (`remove()` com `dataSource.transaction`, anexos com `mutateChecklistLocked`) e não foi aplicado ao caminho de escrita mais frequente.

**Correção recomendada**

Executar (1) e (3) na mesma transação e sob o mesmo lock já disponível, e mover (2) para depois do commit (deleção de arquivo é irreversível e não deve estar dentro da transação):
```ts
// service.ts, no lugar de 2519-2537
const { saved, result } = await this.mutateChecklistLocked(id, async (locked, manager) => {
  Object.assign(locked, mutacoesCalculadas);   // itens, status, campos
  const changed = previousMaterialSnapshot !== this.buildChecklistMaterialSnapshot(locked);
  if (changed && !wasModelo) {
    await manager.getRepository(Signature).softDelete({
      document_id: locked.id, document_type: 'CHECKLIST', company_id: locked.company_id,
    });
  }
  return { materialChanged: changed };
});
if (removedPhotoEntries.length > 0) {
  await this.cleanupGovernedChecklistPhotoFiles(saved.id, removedPhotoEntries); // pós-commit
}
```
E promover o catch de `cleanupGovernedChecklistPhotoFiles` a uma fila de retentativa/reconciliação (há `npm run registry:reconcile`) em vez de só logar.

**Teste de regressão** — `checklists.service.spec.ts`: mockar `signaturesService.removeByDocumentSystem` para lançar e chamar `update` com itens alterados; exigir que o estado dos itens NÃO tenha sido persistido (rollback) — hoje o save já ocorreu. Segundo teste: mockar `deleteFile` para lançar e exigir que o `update` ainda retorne 200 mas registre a pendência de reconciliação.

---

### 🟡 SGS-CHK-TST-009 — Único E2E do escopo tem asserts condicionais e um teste cujo nome promete `ON DELETE SET NULL` sem nunca deletar nada

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Testing |
| **Local** | `backend/test/critical/checklist-lifecycle.e2e-spec.ts:532` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O teste chamado `'delete atomicidade: remove com signatures, registry e lock de edicao; NC link fica SET NULL'` (linha 532) nunca observa uma deleção nem verifica FK alguma:

```ts
// linhas 586-614
const hasNc = ncCreate.status === 201;
const ncid = hasNc ? ((ncCreate.body as { id?: string }).id ?? null) : null;
...
const delRes = await ...delete(`/checklists/${cid}`)...;
expect(delRes.status).toBe(400);              // o delete é BLOQUEADO (checklist tem PDF final)
...
if (hasNc && ncid) {                          // se a NC não criar, nada é verificado
  const ncGet = await ...get(`/nonconformities/${ncid}`)...;
  expect(ncGet.status).toBe(200);
  const ncBody: unknown = ncGet.body;
  expect(ncBody).toBeDefined();               // assert vazio: qualquer corpo passa
}
```
O `ON DELETE SET NULL` da FK `FK_nonconformities_checklist_id` (migration 1709000000321) fica sem cobertura nenhuma, e o `checklist_id` da NC nunca é lido.

O teste principal (linha 91) tem asserts condicionais que absolvem falha de storage:
```ts
// linhas 153-169
if (equipmentAccessBody.availability === 'ready') {
  ...
  if (equipmentDownloadRes.status === 200) { ...expect content-type... }
  else { expect([400, 404]).toContain(equipmentDownloadRes.status); }  // download quebrado = teste verde
} else {
  expect(equipmentAccessBody.url).toBeNull();                          // presign quebrado = teste verde
}
```
Mesmo padrão nas linhas 196-212 (foto de item) e 254-273 (PDF final).

E o teste de rate limit (linha 617) aceita qualquer coisa:
```ts
calls.forEach((r) => expect([201, 400, 403, 429, 500]).toContain(r.status));
```
incluindo 500 — não pode falhar.

No nível unitário, o teste que deveria proteger contra referência governada forjada exercita apenas o caminho `itens` (checklists.service.spec.ts:2767-2811), deixando o caminho `topicos` descoberto — foi exatamente essa lacuna que permitiu SGS-CHK-SEC-001 passar despercebido.

**Impacto** — A suíte marcada como 'critical' dá garantia menor do que aparenta. Regressões que o time acredita cobertas passam verdes: quebra do presign de storage, quebra do download do PDF final, quebra do throttle, e a semântica de FK entre checklist e não conformidade. Pior, o nome do teste é lido como evidência de cobertura em revisão de PR e em auditoria — é documentação falsa de conformidade. Nenhum teste do módulo cobre a transição de `is_modelo`, o reset de assinatura pós-alteração, nem o caminho `topicos` de fotos.

**Causa raiz** — Testes escritos para tolerar ambiente de CI instável (storage indisponível, throttler desligado, NC com payload variável), usando ramificação condicional em vez de skip explícito ou de fixture determinística. O nome do teste foi mantido de uma versão anterior em que o `remove()` ainda era permitido com PDF final, e não foi atualizado quando a trava de integridade entrou.

**Correção recomendada**

(1) Renomear e reescrever o teste 532 para provar o que diz: criar checklist SEM PDF final, criar NC vinculada, `DELETE /checklists/{cid}` esperando 200/204, e depois `GET /nonconformities/{ncid}` exigindo `checklist_id === null`. Manter em teste separado a asserção de que checklist COM PDF final devolve 400 no delete.
(2) Trocar os `if (availability === 'ready')` por precondição dura: um `beforeAll` que valida a disponibilidade do storage e faz `describe.skip` do arquivo inteiro se indisponível (o padrão `E2E_INFRA_AVAILABLE` já existe na linha 5-6), e dentro dos testes exigir `expect(availability).toBe('ready')` e `expect(downloadRes.status).toBe(200)`.
(3) Remover 500 da lista aceita no teste 617 ou apagar o teste — hoje ele só consome tempo de CI.
(4) Fazer `hasNc` virar `expect(ncCreate.status).toBe(201)` em vez de flag condicional.

**Teste de regressão** — O próprio conjunto reescrito acima. Adicionalmente, adotar a regra de que teste em `test/critical/` não pode conter `if` em torno de `expect`: um lint simples (`eslint-plugin-jest` com `no-conditional-expect`, já disponível) aplicado a `backend/test/critical/**` quebraria hoje nos casos das linhas 153-169, 196-212, 254-273 e 606-614.

---

### 🔵 SGS-CHK-OBS-010 — Criação, edição e anexo de fotos do checklist não geram trilha forense — apenas log Winston volátil

| | |
|---|---|
| **Severidade** | LOW |
| **Categoria** | Observability |
| **Local** | `backend/src/modules/checklists/checklists.controller.ts:135` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Das operações de escrita do controller, só a deleção declara auditoria forense:
```ts
// controller.ts:381-387
@Delete(':id')
@Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
@Authorize('can_manage_checklists')
@ForensicAuditAction('delete', 'checklist')     // <-- único no arquivo
remove(@Param('id', new ParseUUIDPipe()) id: string) { ... }
```
`create` (135), `update` (224), `attachEquipmentPhoto` (307), `attachItemPhoto` (343), `fillFromTemplate` (244), `sendEmail` (234) e `importWord` (105) não têm o decorator. A emissão do PDF final (`attachFile`, 277) também não — mas é a exceção coberta, pois `registerFinalDocument` grava `FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REGISTERED` (document-governance.service.ts:160-180).

O que existe para as demais é `logChecklistEvent` (service:638-651), que escreve em `this.logger.log({...})` — stdout do container:
```ts
this.logger.log({
  event, checklistId: checklist?.id ?? null,
  companyId: checklist?.company_id ?? this.tenantService.getTenantId(),
  requestId: RequestContext.getRequestId(), actorId: RequestContext.getUserId(), ...extra,
});
```

**Impacto** — As mutações que alteram o conteúdo probatório da inspeção — inclusive as usadas nos achados SGS-CHK-SEC-001 e SGS-CHK-STM-002 (POST com `topicos` forjados, PATCH flipando `is_modelo`, PATCH alterando respostas depois da assinatura) — não deixam registro consultável em `audit_logs`/`forensic_trail`. A investigação pós-incidente depende de log de container, que rotaciona e não é query-ável por tenant/recurso, e cujo `reason` de reset de assinatura (`'material_update'`) some junto. Para um SaaS de SST com valor probatório e obrigações LGPD, a cadeia de custódia do documento cobre a emissão e a exclusão, mas não a edição.

**Causa raiz** — A trilha forense foi instrumentada no nível do documento final (registry) e da exclusão, e não no nível das mutações de conteúdo que antecedem a emissão. O `logChecklistEvent` foi tratado como equivalente a auditoria, mas escreve em transporte volátil.

**Correção recomendada**

Aplicar o decorator existente nas rotas de escrita e, para o conteúdo, gravar o delta na trilha:
```ts
// controller.ts
@Post()          @ForensicAuditAction('create', 'checklist')            create(...)
@Patch(':id')    @ForensicAuditAction('update', 'checklist')            update(...)
@Post(':id/equipment-photo') @ForensicAuditAction('attach_photo','checklist') ...
@Post(':id/items/:itemIndex/photos') @ForensicAuditAction('attach_photo','checklist') ...
@Post('fill-from-template/:templateId') @ForensicAuditAction('create','checklist') ...
```
E, no `update()`, quando `materialChanged === true`, acrescentar um `forensicTrailService.append` com `{ previousStateHash, nextStateHash, signaturesReset }` — os dois hashes saem de graça de `buildChecklistMaterialSnapshot` (service:1596), que já é calculado antes e depois.

**Teste de regressão** — `checklists.controller.spec.ts`: usar `Reflect.getMetadata` para exigir a presença de metadata de `@ForensicAuditAction` nos handlers `create`, `update`, `attachEquipmentPhoto` e `attachItemPhoto`. E2E: após `PATCH` que altera itens de checklist assinado, consultar a trilha forense do módulo `checklist` e exigir um evento com o `entityId` correspondente e `signaturesReset: true`.

---

## NOT VERIFIED — o que não foi possível provar nesta rodada

- Execução real do exploit de SGS-CHK-SEC-001 contra o storage: a cadeia foi provada por leitura de código ponta a ponta (rota `topicos` sem validação -> persistência do `gst:` forjado -> `getGovernedChecklistPhotoEntries` -> `cleanupGovernedChecklistPhotoFiles` -> `documentStorageService.deleteFile` sem `assertTenantOwnership`), mas não foi executada — exigiria API + Postgres + bucket B2/local rodando, e a fase é somente leitura. O passo que resta confirmar empiricamente é apenas se o provider S3 devolve erro em DELETE de chave inexistente (irrelevante para o caso da chave existente, e engolido pelo catch de service:1580).
- Se o índice GIN `idx_checklists_itens_gin` (migration 320, `jsonb_ops`) de fato rejeita entradas com valores de texto longos ('index row size exceeds maximum'). O risco é inerente ao `jsonb_ops` e o código não impõe teto algum (SGS-CHK-DB-006), mas confirmar o limiar exato exigiria um Postgres com o índice criado e um INSERT de teste — não disponível nesta fase. O achado foi mantido em MEDIUM apoiado apenas na evidência de código (ausência de `@MaxLength`/`@ArrayMaxSize` + limite de 5 MB no body parser).
- Comportamento exato do `save()` do TypeORM em corrida entre `update()` e `attachPdf()` — se o diff interno preserva `pdf_file_key` gravado por outra transação. Não afirmei apagamento de `pdf_file_key` por esse caminho porque dependeria do modo de diff do TypeORM 0.3 em runtime; o achado de concorrência (SGS-CHK-CON-007) foi limitado ao que é provável só por leitura: ausência de lock e de predicado `pdf_file_key IS NULL` no UPDATE.
- Estado real das policies RLS em produção (Neon). As migrations 079 e 177 criam ENABLE + FORCE + policy RESTRICTIVE com `USING` e `WITH CHECK` para `checklists`, e a 177 cria a PERMISSIVE `FOR ALL TO sgs_app` também com `WITH CHECK` — cobertura correta de SELECT/INSERT/UPDATE/DELETE. Mas ambas as migrations pulam a tabela silenciosamente quando o papel que roda a migration não é membro do owner (`canManageTablePolicies`, migration 177:93-113), então a aplicação efetiva em produção precisa ser confirmada com `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='checklists'` e `SELECT * FROM pg_policies WHERE tablename='checklists'`.
- Se o `SecurityActionInterceptor` global (app.module.ts:1392-1395) persiste em `audit_logs` ou apenas emite métrica/log. Li apenas a extração de módulo por path (shared/security/security-action.interceptor.ts:34-99). Por isso o achado SGS-CHK-OBS-010 foi mantido em LOW e restrito ao que é indiscutível: nenhuma rota de escrita do controller além de DELETE declara `@ForensicAuditAction`.
- Geração automática de não conformidade a partir de item NÃO CONFORME (item (d) do escopo): NÃO EXISTE no backend. `grep -rn 'checklist_id' backend/src/modules/nonconformities/` mostra que a ligação é sempre passada pelo cliente em `CreateNonConformityDto.checklist_id` (dto:336) e validada por `validateChecklistLink` (nonconformities.service.ts:1156-1184), que confere company_id, `deleted_at IS NULL` e igualdade de `site_id` entre NC e checklist — validação correta. Não há nenhum gatilho, job ou chamada em `checklists.service.ts` que crie NC. Portanto não há o que auditar quanto a transacionalidade ou criação em tenant/obra errados: o fluxo automático simplesmente não foi implementado, o que é uma lacuna funcional (itens com `bloqueia_operacao_quando_nc`/`exige_observacao_quando_nc` dos presets NR-33/NR-35/NR-10/LOTO não geram tratativa alguma), não um defeito de segurança — por isso não virou finding.
- Presets como vetor de injeção (item (e) do escopo): descartado com evidência. `getChecklistPresetSeedByKey` é chamado uma única vez, com a constante literal `'welding-machine'` (service:3137-3138), e `createPresetTemplates` itera `CHECKLIST_PRESET_SEEDS` sem qualquer entrada do cliente (service:3206-3217). Nenhuma chave de preset trafega em DTO ou query param. Os builders (`presets/preset-template.utils.ts`) produzem apenas literais de código. Não há confiança em preset vindo do cliente.
