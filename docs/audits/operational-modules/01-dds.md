# DDS — Diálogo Diário de Segurança — Relatório de Auditoria

> Escopo desta rodada: **Arquitetura · Backend · Banco · Segurança · Máquina de estados · Concorrência · Integridade documental · Observabilidade**.
> Frontend, Design/UX, PDF e Performance de carga ficaram para a rodada 2 (ver `00-master-audit.md` › Status).

## Resumo executivo

O módulo DDS tem uma superfície pública bem desenhada no papel (token JWT HS256 assinado com VALIDATION_TOKEN_SECRET, hash SHA-256 do token persistido com UNIQUE, expiração, uso único, vínculo a dds_version, RLS com USING+WITH CHECK na tabela de convites), mas o caminho de submissão da assinatura pública está tecnicamente quebrado: `loadInviteForToken` combina 5 `leftJoinAndSelect` com `setLock('pessimistic_write')`, e o TypeORM emite um `FOR UPDATE` sem cláusula `OF`, o que o PostgreSQL rejeita sobre o lado anulável de outer join. Não há um único teste real de banco cobrindo esse caminho (o spec mocka o próprio query builder). O controle de integridade documental é mais fraco do que aparenta: assinaturas de DDS não carregam `content_hash` (o binding de conteúdo é exclusivo de APR), e a única barreira contra edição pós-assinatura — `getSignatureResetReasons` — é contornável enviando `conteudo: null`, porque `@IsOptional()` ignora null e o comparador usa `??`. O lock otimista da migration 100 é decorativo: a coluna `version` só é incrementada, nunca é usada como predicado (`lock: {mode:'optimistic'}` não existe em lugar nenhum do repositório), então os `catch (OptimisticLockVersionMismatchError)` em `updateStatus`/`updateAudit` são código morto e as escritas concorrentes são last-write-wins. O fluxo de aprovação é sólido (índices parciais únicos por etapa/decisão, cadeia de hash, PIN obrigatório, lock pessimista real), mas escreve `AUDITADO` por fora da máquina de estados declarada. Por fim, `DELETE /dds/:id` não tem a trava de PDF final que PT e NC têm — apaga o registry e o PDF físico no B2 de um DDS já emitido.

| Severidade | Confirmados |
|---|---|
| 🔴 CRITICAL | 1 |
| 🟠 HIGH | 4 |
| 🟡 MEDIUM | 5 |
| 🔵 LOW | 1 |

## Máquina de estados observada no código

| Estado atual | Transições declaradas (`DDS_ALLOWED_TRANSITIONS`, dds.entity.ts:30-35) | Quem pode | Transições reais observadas no código |
|---|---|---|---|
| `rascunho` | `publicado`, `arquivado` | `PATCH /dds/:id/status` — ADMIN_GERAL, ADMIN_EMPRESA, TST, SUPERVISOR + `can_manage_dds` | idem. Modelos (`is_modelo`) não podem ir para `publicado`/`auditado` (dds.service.ts:703-710) |
| `publicado` | `arquivado` | idem | **`auditado` também acontece** — gravado direto por `DdsApprovalService.approveStep` via `ddsRepository.update()` quando a última etapa é aprovada (dds-approval.service.ts:203-213), sem passar por `DDS_ALLOWED_TRANSITIONS` |
| `auditado` | `arquivado` | idem | idem. Bloco de validação de pré-requisitos de `auditado` em `updateStatus` (dds.service.ts:718-734) é **inalcançável**, pois nenhuma transição declarada leva a `auditado` |
| `arquivado` | (nenhuma) | — | terminal. `assertFinalDocumentMutable` bloqueia edição (dds.service.ts:1777-1781) |
| qualquer | soft delete | `DELETE /dds/:id` — ADMIN_GERAL, ADMIN_EMPRESA, TST | **sem trava de PDF final** — apaga registry + arquivo físico mesmo em DDS `auditado` com PDF emitido (SGS-DDS-INT-001) |

Fluxo de aprovação (`dds_approval_records`), independente do status:
| Estado do fluxo | Transição | Guarda real |
|---|---|---|
| `not_started` → `pending` | `POST /:id/approvals/initialize` | `assertApprovalMutable` (bloqueia `is_modelo`, `rascunho`, `auditado`, `arquivado`, `pdf_file_key`); 1..5 níveis; papel validado por `normalizeRoleName` |
| `pending` → `approved` | `POST /:id/approvals/:approvalId/approve` | lock pessimista na linha `dds`; `assertStepCanBeDecided` exige ser a etapa corrente; `assertActorCanDecide` exige perfil igual ao `approver_role` (ADMIN_GERAL faz bypass); PIN 4-6 dígitos; índice único parcial `IDX_dds_approval_records_decision_unique` impede dupla decisão concorrente |
| `pending` → `rejected` | `.../reject` | idem + motivo ≥10 chars |
| `rejected` → `pending` (novo ciclo) | `POST /:id/approvals/reopen` | só a partir de `rejected`; motivo ≥10 chars; PIN |
| `approved` | (terminal do ciclo) | dispara `status = auditado` + `resultado_auditoria = Conforme` |

## Achados

### 🔴 SGS-DDS-INT-001 — DELETE /dds/:id apaga DDS com PDF final emitido — registry removido e arquivo destruído no storage

| | |
|---|---|
| **Severidade** | CRITICAL |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/dds/dds.service.ts:1534` |
| **Verificação adversarial** | CONFIRMED — CONFIRMADO por comparação lado a lado. `PtsService.remove()` (pts.service.ts:1983-1988) tem a trava `if (pt.pdf_file_key) throw new BadRequestException(...)`. `DdsService.remove()` (dds.service.ts:1534-1541) NÃO tem trava equivalente e cai direto em `removeFinalDocumentReference` com `cleanupStoredFile: (fileKey) => documentStorageService.deleteFile(fileKey)` — apaga o objeto no B2. Um DDS `auditado` com PDF final e código público de validação é destruído, quebrando permanentemente todo QR já emitido. |

**Evidência**

`DdsService.remove` não tem nenhuma checagem de `pdf_file_key`/status antes de acionar a esteira de remoção:

```ts
async remove(id: string): Promise<void> {
  const dds = await this.findOne(id);
  await this.documentGovernanceService.removeFinalDocumentReference({
    companyId: dds.company_id,
    module: 'dds',
    entityId: dds.id,
    trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
    trailMetadata: { removalMode: 'soft_delete' },
    removeEntityState: async (manager) => {
      await manager.getRepository(Dds).softDelete(id);
    },
    cleanupStoredFile: (fileKey) =>
      this.documentStorageService.deleteFile(fileKey),   // <-- apaga o PDF no B2
  });
```

Comparar com o mesmo fluxo em PT (backend/src/modules/pts/pts.service.ts:1983-1989), que TEM a trava:

```ts
async remove(id: string): Promise<void> {
  const pt = await this.findOne(id);
  if (pt.pdf_file_key) {
    throw new BadRequestException(
      'Somente PTs sem PDF final podem ser removidas. ...');
  }
```

e em NC (backend/src/modules/nonconformities/nonconformities.service.ts:1563-1567), idêntico. O DDS ficou de fora.

O que a esteira faz de fato (backend/src/modules/document-registry/document-governance.service.ts:268-308 e document-registry.service.ts:173-184): `registryRepository.delete({...})` — DELETE físico da linha do registry — e depois `cleanupStoredFile(registryEntry.file_key)` — DELETE do objeto no Backblaze B2.

Repro: criar DDS → publicar → concluir fluxo de aprovação (status `auditado`) → `POST /dds/:id/file` com o PDF final → `DELETE /dds/:id` como ADMIN_EMPRESA/TST (dds.controller.ts:859-865). Retorna 200. O PDF governado deixa de existir no storage e o código público de validação para de resolver.

O teste existente confirma a ausência da trava: dds.service.spec.ts:1010-1020 monta um DDS `{ id, company_id }` sem `pdf_file_key` e só assere que `softDelete` foi chamado — nunca testa a condição que importa.

**Impacto** — Destruição irreversível de documento SST legalmente exigido (DDS auditado e emitido) por qualquer ADMIN_GERAL/ADMIN_EMPRESA/TST com `can_manage_dds`. O arquivo é apagado do object storage e a linha do document_registry é removida com DELETE físico, quebrando a validação pública por QR/código. Sobra apenas o evento no forensic_trail com o hash — insuficiente para reconstituir o documento em auditoria/fiscalização. É exatamente o padrão de governança que já foi corrigido em PT, NC, Audit, Checklist, ARR, DID e Relatórios Fotográficos.

**Causa raiz** — Ao aplicar o hardening de 'exclusão de documento governado' nos demais módulos, o DDS não recebeu o guard `if (dds.pdf_file_key) throw new BadRequestException(...)`. A esteira central `removeFinalDocumentReference` é deliberadamente burra: ela executa o que o chamador pede, delegando a política ao serviço de domínio.

**Correção recomendada**

Adicionar a trava no início de `remove`, alinhada a PT/NC:

```ts
async remove(id: string): Promise<void> {
  const dds = await this.findOne(id);
  if (dds.pdf_file_key || dds.final_pdf_hash_sha256) {
    throw new BadRequestException(
      'Somente DDS sem PDF final podem ser removidos. Use o arquivamento (status arquivado) para registros já emitidos.',
    );
  }
  if (dds.status === DdsStatus.AUDITADO) {
    throw new BadRequestException(
      'DDS auditado não pode ser removido. Arquive o registro.',
    );
  }
  ...
}
```

Complementarmente, avaliar trocar o `registryRepository.delete` por soft-delete/estado `revoked` no document-registry, para que a validação pública responda 'documento revogado' em vez de 'inexistente'.

**Teste de regressão** — Em `dds.service.spec.ts`: (1) `repository.findOne` devolvendo `{ id, company_id, pdf_file_key: 'companies/x/dds/y.pdf' }` → `expect(service.remove('dds-1')).rejects.toThrow(BadRequestException)` e `expect(documentGovernanceService.removeFinalDocumentReference).not.toHaveBeenCalled()` e `expect(documentStorageService.deleteFile).not.toHaveBeenCalled()`; (2) mesmo teste com `status: 'auditado'` sem pdf; (3) manter o caso feliz atual (rascunho sem pdf) verde. E2E: emitir PDF, chamar DELETE, esperar 400 e conferir que `GET /public/dds/validate` continua retornando valid=true.

---

### 🟠 SGS-DDS-CON-002 — Portal público de assinatura inoperante: SELECT ... LEFT JOIN ... FOR UPDATE é rejeitado pelo PostgreSQL

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Backend |
| **Local** | `backend/src/modules/dds/dds-signature-invite.service.ts:677` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`loadInviteForToken` monta a consulta com cinco LEFT JOINs e, quando `lock: true`, aplica `pessimistic_write`:

```ts
const query = repository
  .createQueryBuilder('invite')
  .leftJoinAndSelect('invite.dds', 'dds')
  .leftJoinAndSelect('dds.site', 'site')
  .leftJoinAndSelect('dds.company', 'company')
  .leftJoinAndSelect('dds.facilitador', 'facilitador')
  .leftJoinAndSelect('invite.participant', 'participant')
  .where('invite.id = :inviteId', { inviteId: input.inviteId })
  ...
if (input.lock) {
  query.setLock('pessimistic_write');
}
const invite = await query.getOne();
```

O único chamador com `lock: true` é o submit público (mesmo arquivo, linhas 409-417):

```ts
this.inviteRepository.manager.transaction(async (manager) => {
  const invite = await this.loadInviteForToken({
    manager, inviteId: payload.jti, companyId: payload.companyId,
    ddsId: payload.code, tokenHash, lock: true,
  });
```

O TypeORM instalado gera `FOR UPDATE` **sem** cláusula `OF` quando `setLock` é chamado sem lista de tabelas — node_modules/typeorm/query-builder/SelectQueryBuilder.js:1515-1519: `return " FOR UPDATE" + lockTablesClause + onLockExpression;`, e `lockTablesClause` só é preenchido quando `setLock(mode, version, tables)` recebe `tables`. Um `FOR UPDATE` sem `OF` aplica-se a todas as relações do FROM, incluindo o lado anulável dos LEFT JOINs, o que o PostgreSQL recusa em tempo de planejamento (ERRO 0A000, 'FOR UPDATE cannot be applied to the nullable side of an outer join').

Nenhum teste exercita isso contra banco real: dds-signature-invite.service.spec.ts:101-128 substitui o query builder inteiro por um mock (`setLock: jest.fn().mockReturnThis()`, `getOne: jest.fn()`), e não existe nenhum E2E — `grep -rl "public/dds/signature|signature-invites" backend/test/` não retorna nada.

Observe o contraste: os outros dois locks pessimistas do módulo não têm joins e funcionam — dds.service.ts:1121-1127 e dds-approval.service.ts:416-426.

**Impacto** — `POST /public/dds/signature/:token` falha com 500 em toda tentativa: o participante abre o link (o GET usa `lock: false` e funciona, mostrando os dados do DDS), desenha a assinatura, envia e recebe erro. O recurso de coleta de assinatura por link público — que é o caminho para o DDS chegar a `assertReadyForFinalDocument` sem reunir todos no tablet do facilitador — nunca conclui. Em ambiente de desenvolvimento (SQLite/better-sqlite3) o mesmo caminho lança `LockNotSupportedOnGivenDriverError`, então o defeito não é observável só em produção.

**Causa raiz** — Uso de `setLock('pessimistic_write')` sobre uma query que carrega relações por LEFT JOIN. O lock precisa incidir apenas sobre `dds_signature_invites`, mas a API do TypeORM aplica a todas as relações quando não se passa a lista de tabelas — e o spec mocka justamente a camada que revelaria o erro.

**Correção recomendada**

Separar o lock da hidratação das relações. Opção mínima (mantém uma query):

```ts
if (input.lock) {
  query.setLock('pessimistic_write', undefined, ['invite']);
}
```
(o TypeORM gera `FOR UPDATE OF "invite"`, permitido com outer joins).

Opção mais segura: travar primeiro só a linha do convite e depois carregar as relações:
```ts
if (input.lock) {
  await repository.createQueryBuilder('invite')
    .setLock('pessimistic_write')
    .where('invite.id = :id AND invite.company_id = :c AND invite.token_hash = :h',
           { id: input.inviteId, c: input.companyId, h: input.tokenHash })
    .getOne();
}
const invite = await query.getOne(); // sem setLock
```

**Teste de regressão** — Teste de integração com PostgreSQL real (docker-compose.test.yml): criar company/site/user/dds/convite, chamar `DdsSignatureInviteService.submitPublicSignature(token, {...})` e esperar `signed: true`. Um teste unitário com query builder mockado NÃO cobre isso — o teste precisa bater no banco. Adicionalmente, um teste que assere a SQL gerada: `expect(qb.getQuery()).toMatch(/FOR UPDATE OF/)`.

---

### 🟠 SGS-DDS-INT-003 — Conteúdo assinado do DDS pode ser apagado sem invalidar assinaturas enviando `conteudo: null`

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/dds/dds.service.ts:1301` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`UpdateDdsDto` é `PartialType(OmitType(CreateDdsDto, ['company_id']))` (dto/update-dds.dto.ts:5-7). `PartialType` aplica `@IsOptional()` em cada propriedade (node_modules/@nestjs/mapped-types/dist/partial-type.helper.js:17), e `@IsOptional()` do class-validator ignora a validação quando o valor é `null` **ou** `undefined`. O ValidationPipe global (main.ts:343-350) usa `whitelist: true` — que só remove propriedades *sem* decorator — e `enableImplicitConversion`, que preserva `null`. Logo `{"conteudo": null}` atravessa a validação intacto.

No serviço, a única defesa contra edição pós-assinatura é `getSignatureResetReasons`, que compara com `??` (dds.service.ts:1948-1959):

```ts
const nextConteudo = nextValues.conteudo ?? dds.conteudo ?? '';
...
if (nextConteudo !== (dds.conteudo ?? '')) {
  reasons.push('content_changed');
}
```

Com `nextValues.conteudo === null`, `null ?? dds.conteudo` devolve `dds.conteudo` → `nextConteudo === (dds.conteudo ?? '')` → **nenhum motivo de reset é registrado**. Em seguida, a gravação usa o objeto cru:

```ts
Object.assign(dds, rest);            // dds.conteudo = null
...
const persistedDds = await manager.getRepository(Dds).save(dds);
if (signatureResetReasons.length > 0) {  // vazio -> assinaturas preservadas
  await manager.getRepository(Signature).delete({...});
}
```

O mesmo buraco vale para `site_id: null` (coluna anulável; `if (rest.site_id) this.assertSiteAllowed(rest.site_id)` na linha 1268 também é pulado, e `nextSiteId = null ?? dds.site_id` não gera `site_changed`) e para `auditado_por_id: null`/`notas_auditoria: null`.

Agrava o quadro: assinaturas de DDS não têm vínculo criptográfico com o conteúdo. Em signatures.service.ts:421-428 o content binding é exclusivo de APR:
```ts
const contentBinding =
  payload.document_type.toLowerCase() === 'apr'
    ? await this.loadAprContentBinding({...})
    : null;
```
e o registro fica com `content_hash: contentBinding?.contentHash || null` (linha 504) — ou seja, `null` para DDS. Não há como detectar a alteração a posteriori a partir da assinatura.

Repro: criar DDS com `conteudo`, adicionar participantes, coletar assinaturas de todos (`PUT /dds/:id/signatures`), depois `PATCH /dds/:id` com body `{"conteudo": null}` (status ainda `rascunho`/`publicado`, `assertWorkflowMutable` passa). Retorna 200, `conteudo` vira NULL, todas as assinaturas continuam vivas, e o DDS segue para aprovação/PDF final.

**Impacto** — O texto do DDS — o conteúdo do diálogo de segurança que os trabalhadores declararam ter recebido ao assinar — pode ser esvaziado (ou o vínculo com a obra removido) sem que o sistema invalide as assinaturas nem exija `confirm_signature_reset`. O documento final é emitido com assinaturas que atestam um conteúdo que não existe mais. Como a assinatura de DDS não carrega `content_hash`, a adulteração é indetectável por verificação de assinatura. Com `site_id: null`, o DDS ainda escapa do escopo de obra (`applyDdsSiteScope` exige `site_id IN (...)`), sumindo da listagem de usuários restritos a obra.

**Causa raiz** — Combinação de (a) `@IsOptional()` tratando `null` como 'ausente' — sem `@IsNotEmpty()`/`@ValidateIf` nos campos do PartialType — e (b) `getSignatureResetReasons` usar `??` (que colapsa `null` no valor atual) em vez de checar a presença da chave no payload. A comparação e a gravação usam semânticas diferentes do mesmo payload.

**Correção recomendada**

1) Comparar por presença de chave, não por `??`:
```ts
const has = (k: keyof UpdateDdsDto) => Object.prototype.hasOwnProperty.call(nextValues, k);
const nextConteudo = has('conteudo') ? (nextValues.conteudo ?? '') : (dds.conteudo ?? '');
if (nextConteudo !== (dds.conteudo ?? '')) reasons.push('content_changed');
```
(idem para tema, data, site_id, facilitador_id, is_modelo).
2) Bloquear `null` explícito nos campos que não são anuláveis no domínio, no DTO:
```ts
export class UpdateDdsDto extends PartialType(OmitType(CreateDdsDto, ['company_id'] as const)) {
  @ValidateIf((_, v) => v !== undefined)
  @IsUUID()
  site_id?: string;   // rejeita null
  ...
}
```
3) Estender o content binding do APR para DDS em `persistSignature`, gravando `content_hash` sobre a forma canônica de (tema, conteudo, data, site_id, facilitador_id, participantes) — assim qualquer edição posterior é detectável na verificação, independente do guard de reset.

**Teste de regressão** — `dds.service.spec.ts`: DDS com `conteudo: 'texto original'` e assinaturas existentes → `service.update('dds-1', { conteudo: null } as any)` deve (a) lançar BadRequestException exigindo `confirm_signature_reset`, ou (b) com a flag, apagar as assinaturas. Assertar `expect(signatureRepository.delete).toHaveBeenCalled()` no caso confirmado e `rejects.toThrow(BadRequestException)` sem a flag. Testes gêmeos para `site_id: null` e `facilitador_id: null`. Teste de DTO com `plainToInstance(UpdateDdsDto, { site_id: null })` esperando erro de validação.

---

### 🟠 SGS-DDS-CON-004 — Lock otimista da migration 100 é decorativo: `version` nunca é usada como predicado e o catch é código morto

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Concurrency |
| **Local** | `backend/src/modules/dds/dds.service.ts:738` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

A entidade declara a coluna (entities/dds.entity.ts:143-144):
```ts
@VersionColumn()
version: number;
```
e a migration 1709000000100 diz explicitamente 'Incrementada automaticamente a cada save() pelo ORM'. O serviço trata o erro em dois pontos (dds.service.ts:738-747 e 1446-1456):
```ts
try {
  saved = await this.ddsRepository.save(dds);
} catch (error) {
  if (error instanceof OptimisticLockVersionMismatchError) {
    throw new ConflictException('O DDS foi modificado por outra operação simultânea. ...');
  }
  throw error;
}
```

Esse catch nunca dispara. No TypeORM instalado, `OptimisticLockVersionMismatchError` é lançado **exclusivamente** pelo SelectQueryBuilder quando se passa `lock: { mode: 'optimistic', version: N }` — node_modules/typeorm/query-builder/SelectQueryBuilder.js:699 e :704 são as únicas ocorrências fora do arquivo de definição do erro. E `grep -rn "mode: 'optimistic'|lockVersion" backend/src --include=*.ts` não retorna **nenhuma** ocorrência em todo o backend.

O caminho de `save()` monta o UPDATE com WHERE somente por chave primária: SubjectExecutor.js:423 chama `updateQueryBuilder.whereEntity(subject.identifier)`, e `whereEntity` (UpdateQueryBuilder.js:260-272) faz apenas `this.orWhereInIds(entityIdMap)` — nenhum predicado sobre `version`. O incremento acontece em UpdateQueryBuilder.js:397-401 (`version = version + 1`), sem condição.

SQL efetivo: `UPDATE dds SET status=$1, version = version + 1 WHERE id = $2`. Duas requisições concorrentes que leram `version = 3` gravam ambas com sucesso; a versão vira 5 e o segundo write sobrescreve o primeiro em silêncio.

Repro: dois `PATCH /dds/:id` simultâneos (um trocando `tema`, outro trocando `conteudo`), ambos partindo do mesmo `findOne`. Ambos retornam 200; o objeto final contém apenas os campos do último a commitar (`Object.assign(dds, rest)` + `save` grava o snapshot inteiro, não um patch).

**Impacto** — Perda silenciosa de edições concorrentes em documento SST. Pior: `update()` (dds.service.ts:1306-1318) grava o snapshot completo do objeto carregado, então uma edição concorrente não só perde o campo do outro — ela reverte para o valor que estava em memória quando a requisição começou, incluindo a lista de participantes. O usuário recebe 200 e acredita que a alteração foi aplicada. Também torna inconsistente a detecção de `signatureResetReasons`, que é calculada sobre um snapshot potencialmente obsoleto (a decisão de apagar ou preservar assinaturas é tomada com dados velhos).

**Causa raiz** — Confusão entre 'coluna de versão' e 'controle de concorrência otimista'. O TypeORM incrementa `@VersionColumn` automaticamente, mas só valida a versão quando o SELECT é feito com `lock: { mode: 'optimistic', version }`. A migration e os comentários assumem o comportamento errado, e o `catch` deu falsa confiança de que o controle existia.

**Correção recomendada**

Ler com o lock otimista antes de gravar, em `findOne` (quando destinado a escrita), `update`, `updateStatus` e `updateAudit`:
```ts
const dds = await this.ddsRepository.findOneOrFail({
  where: { id, company_id: tenantId, deleted_at: IsNull() },
  lock: { mode: 'optimistic', version: expectedVersion },
  relations: [...],
});
```
com `expectedVersion` vindo do cliente (novo campo `version: number` obrigatório em `UpdateDdsDto`/`UpdateDdsStatusDto`, validado com `@IsInt() @Min(1)`), ou — se não se quiser mudar o contrato — trocar por lock pessimista explícito nas escritas, como já é feito em `replaceSignatures` (dds.service.ts:1121-1127) e em `withApprovalWriteLock` (dds-approval.service.ts:416-426). Enquanto o lock não existir, remover os `catch (OptimisticLockVersionMismatchError)` para não mascarar a realidade.

**Teste de regressão** — Teste de integração com PostgreSQL: carregar o mesmo DDS em duas transações, aplicar `update` em ambas e esperar que a segunda lance `ConflictException` (409). Complementar com um teste que assere a SQL: `expect(spyQuery).toHaveBeenCalledWith(expect.stringMatching(/WHERE .*"version" = \$/), ...)`. Um teste unitário que apenas mocka `repository.save` para lançar `OptimisticLockVersionMismatchError` NÃO prova nada — foi essa a lacuna que permitiu o defeito passar.

---

### 🟠 SGS-DDS-INT-005 — replaceSignatures roda fora da própria transação e destrói (hard delete) as assinaturas HMAC do fluxo de aprovação

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/dds/dds.service.ts:1118` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

A troca de assinaturas abre uma transação, adquire lock pessimista na linha do DDS e então chama o serviço de assinaturas **sem repassar o `manager`**:

```ts
await this.ddsRepository.manager.transaction(async (manager) => {
  await manager.getRepository(Dds).createQueryBuilder('dds')
    .setLock('pessimistic_write').whereInIds([id])
    .andWhere('dds.deleted_at IS NULL').getOne();

  await this.signaturesService.replaceDocumentSignatures({   // <-- sem manager
    document_id: id, document_type: 'DDS',
    company_id: dds.company_id,
    authenticated_user_id: authenticatedUserId,
    signatures: signaturesToPersist,
  });
  await manager.getRepository(Dds).update(id, { photo_reuse_justification: justification });
});
```

`replaceDocumentSignatures` (signatures.service.ts:266-300) abre sua **própria** transação em outra conexão (`this.signaturesRepository.manager.transaction(...)`), portanto commita independentemente da transação externa. Se o `update` de `photo_reuse_justification` falhar, as assinaturas já foram trocadas e não voltam.

Dentro dela, o filtro do DELETE não distingue tipo de assinatura (signatures.service.ts:269-278):
```ts
const where = {
  document_id: input.document_id,
  document_type: documentType,
  ...(effectiveCompanyId ? { company_id: effectiveCompanyId } : {}),
};
const replacedSignatures = await signatureRepository.find({ where, select: ['id','signature_data_key'] });
await signatureRepository.delete(where);   // DELETE físico, não soft delete
```
`Signature` tem `@DeleteDateColumn` (signatures/entities/signature.entity.ts:91-92), mas `.delete()` remove a linha fisicamente.

Essas linhas incluem as assinaturas HMAC das decisões de aprovação, criadas por `DdsApprovalService.createApprovalSignature` com `document_type: 'DDS'` e o mesmo `document_id` (dds-approval.service.ts:795-818). O FK correspondente é `ON DELETE SET NULL` (entities/dds-approval-record.entity.ts:71-73 e migration 138), então `dds_approval_records.actor_signature_id` vira NULL.

Caminho de exploração legítima: fluxo de aprovação **reprovado** → `getApprovalFlowStatus` devolve `'rejected'`, e `assertNoPendingApprovalFlowForMutation` (dds.service.ts:1523-1532) só barra `'pending'` → o DDS continua `publicado`, `assertWorkflowMutable` passa → `PUT /dds/:id/signatures` apaga as assinaturas HMAC do ciclo reprovado. O mesmo vale para `update()` com `confirm_signature_reset: true`, que faz `manager.getRepository(Signature).delete({ document_id: id, document_type: 'DDS', company_id })` (dds.service.ts:1310-1314) — igualmente indiscriminado.

**Impacto** — (a) Atomicidade: falha após a troca deixa assinaturas novas com `photo_reuse_justification` antigo/ausente, e o lock pessimista adquirido não protege o trecho que importa, porque ele executa em outra conexão. (b) Integridade forense: a prova criptográfica das decisões de aprovação (assinatura HMAC do aprovador, com PIN) é destruída fisicamente por uma operação de rotina de assinatura de participantes. Os registros de `dds_approval_records` mantêm `actor_signature_hash` como varchar copiado, mas a assinatura referenciada não existe mais — a verificação (`SignaturesService.verifyById`) fica impossível e a cadeia de custódia da aprovação é irreparável. (c) `update()` apaga assinaturas sem chamar `cleanupSignatureEvidenceFiles`, deixando as imagens de assinatura (PII biométrica) órfãs no B2, sem registro que permita expurgo LGPD.

**Causa raiz** — Duas causas somadas: (1) `replaceDocumentSignatures` não aceita `EntityManager` externo, então o chamador não tem como participar da mesma transação — a assinatura do método força a quebra de atomicidade; (2) o escopo do DELETE é (document_id, document_type, company_id), sem filtro por natureza da assinatura, tratando assinaturas de participante e assinaturas de decisão de aprovação como o mesmo conjunto.

**Correção recomendada**

1) Aceitar manager externo:
```ts
async replaceDocumentSignatures(input: {...; manager?: EntityManager}): Promise<Signature[]> {
  const run = async (manager: EntityManager) => { /* corpo atual */ };
  return input.manager ? run(input.manager)
                       : this.signaturesRepository.manager.transaction(run);
}
```
e no DDS passar `manager` do bloco transacional.
2) Restringir o DELETE às assinaturas de execução, preservando as do fluxo de aprovação:
```ts
await signatureRepository.createQueryBuilder()
  .delete().from(Signature)
  .where('document_id = :id AND document_type = :t', { id, t: documentType })
  .andWhere('company_id = :c', { c: effectiveCompanyId })
  .andWhere("COALESCE(signature_context->>'scope','') <> 'dds_approval_flow'")
  .execute();
```
3) Trocar `.delete()` por `.softDelete()` e emitir evento no forensic_trail com a lista de ids removidos antes da remoção.

**Teste de regressão** — (1) Teste de integração: DDS publicado com fluxo reprovado que contém 2 assinaturas `hmac` de aprovação + 3 de participantes; chamar `replaceSignatures`; assertar que as 2 assinaturas de aprovação continuam existindo e que `dds_approval_records.actor_signature_id` permanece não-nulo. (2) Teste que força erro no `update` de `photo_reuse_justification` e assere que as assinaturas antigas continuam intactas (rollback real). (3) Assertar que `cleanupSignatureEvidenceFiles` é chamado também no caminho `update()` com `confirm_signature_reset`.

---

### 🟡 SGS-DDS-SEC-006 — GET /dds/people aceita site_id arbitrário e vaza cadastro de funcionários de outras obras do mesmo tenant

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Security |
| **Local** | `backend/src/modules/dds/dds.service.ts:344` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O parâmetro chega cru do controller (dds.controller.ts:395-407):
```ts
@Get('people')
@Authorize('can_view_dds')
listPeople(@Query('page') page?, @Query('limit') limit?, @Query('site_id') siteId?) {
  return this.ddsService.listPeople({ page: ..., limit: ..., siteId });
}
```
(sem `ParseUUIDPipe`, sem DTO).

No serviço (dds.service.ts:342-378):
```ts
// Prioridade: obra explicitamente selecionada no formulário (opts.siteId).
// Fallback para scope do usuário quando não há obra selecionada.
const siteIds = opts?.siteId
  ? [opts.siteId]                 // <-- nunca confrontado com scope.siteIds
  : scope.hasCompanyWideAccess
    ? []
    : scope.siteIds;
...
if (siteIds.length > 0) {
  qb.andWhere(`(user.site_id IN (:...siteIds) OR user.site_id IS NULL OR EXISTS (
      SELECT 1 FROM user_sites us WHERE us.user_id = user.id AND us.site_id IN (:...siteIds)
    ))`, { siteIds });
} else if (!scope.hasCompanyWideAccess) {
  qb.andWhere('1 = 0');
}
```
Quando `opts.siteId` é informado, o ramo `else if (!scope.hasCompanyWideAccess)` nunca é avaliado e `scope.siteIds` é descartado. O único limite restante é `user.company_id = :tenantId` (linha 360).

Repro: usuário com perfil TST/SUPERVISOR/COLABORADOR vinculado apenas à obra A faz `GET /dds/people?site_id=<uuid-da-obra-B>&limit=100`. Retorna nome, função, site_id e status dos funcionários da obra B.

Contraste com o resto do módulo, que respeita o escopo corretamente: `applyDdsSiteScope` (dds.service.ts:211-227), `assertSiteAllowed` (191-201) e `findOne` (683).

O teste existente (dds.service.spec.ts:361-380) passa `siteId: 'site-1'` e apenas confere que o WHERE foi montado com `['site-1']` — não testa uma obra fora do escopo do usuário, ou seja, valida exatamente o comportamento vulnerável.

**Impacto** — Quebra de isolamento por obra dentro do tenant e exposição de PII de RH (nome completo, função, vínculo com obra, status) de unidades operacionais às quais o usuário não tem acesso. Como a lista alimenta o seletor de participantes do DDS, também permite montar um DDS com participantes de outra obra — embora `assertUsersBelongToCompany` (dds.service.ts:1893-1929) bloqueie a gravação, a enumeração já aconteceu. Não é cross-tenant: `user.company_id = :tenantId` continua aplicado, e a RLS (`users` policy por company) também.

**Causa raiz** — O comentário no código revela a intenção — 'obra explicitamente selecionada no formulário tem prioridade' — mas trata o parâmetro do cliente como fonte de verdade de autorização em vez de como filtro dentro do escopo já autorizado. É um caso clássico de confiar no que o frontend envia.

**Correção recomendada**

Interseccionar o parâmetro com o escopo antes de usar:
```ts
const requestedSiteId = opts?.siteId?.trim() || null;
if (requestedSiteId && !scope.hasCompanyWideAccess && !scope.siteIds.includes(requestedSiteId)) {
  throw new ForbiddenException('Obra fora do escopo do usuário atual.');
}
const siteIds = requestedSiteId
  ? [requestedSiteId]
  : scope.hasCompanyWideAccess ? [] : scope.siteIds;
```
E validar o formato no controller com `@Query('site_id', new ParseUUIDPipe({ optional: true }))`.

**Teste de regressão** — `dds.service.spec.ts`: contexto de tenant com `siteIds: ['site-A']` e `hasCompanyWideAccess: false` → `expect(service.listPeople({ siteId: 'site-B' })).rejects.toThrow(ForbiddenException)`; mesmo contexto com `siteId: 'site-A'` → resolve; contexto ADMIN_EMPRESA (company-wide) com `siteId: 'site-B'` → resolve. Ajustar o teste atual, que hoje consagra o comportamento errado.

---

### 🟡 SGS-DDS-SM-007 — Fluxo de aprovação grava status AUDITADO por fora da máquina de estados declarada, tornando validações de updateStatus inalcançáveis

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | StateMachine |
| **Local** | `backend/src/modules/dds/dds-approval.service.ts:203` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

A máquina de estados declarada (entities/dds.entity.ts:30-35) não permite `publicado → auditado`:
```ts
export const DDS_ALLOWED_TRANSITIONS: Record<DdsStatus, DdsStatus[]> = {
  [DdsStatus.RASCUNHO]: [DdsStatus.PUBLICADO, DdsStatus.ARQUIVADO],
  [DdsStatus.PUBLICADO]: [DdsStatus.ARQUIVADO],
  [DdsStatus.AUDITADO]: [DdsStatus.ARQUIVADO],
  [DdsStatus.ARQUIVADO]: [],
};
```
Mas `approveStep` grava o estado diretamente, sem consultar a tabela de transições:
```ts
const latestFlow = this.buildFlow(dds, await this.getEvents(dds, approvals));
if (latestFlow.status === 'approved') {
  await ddsRepository.update(dds.id, {
    status: DdsStatus.AUDITADO,
    auditado_por_id: actor.userId,
    data_auditoria: new Date(),
    resultado_auditoria: AuditResult.CONFORME,
    notas_auditoria: reason?.trim() || 'Fluxo de aprovação DDS concluído sem ressalvas.',
  });
}
```
Como `assertApprovalMutable` (mesmo arquivo, 475-479) exige que o DDS **não** esteja em `rascunho`, o estado de origem é sempre `publicado` — exatamente a transição que `DDS_ALLOWED_TRANSITIONS` proíbe.

Consequência direta: o bloco de pré-requisitos de auditoria em `DdsService.updateStatus` (dds.service.ts:718-734) — que valida fluxo aprovado, `auditado_por_id`, `data_auditoria` e `resultado_auditoria` — é **código inalcançável**, porque a linha 712 (`if (!allowed.includes(status))`) rejeita `status === AUDITADO` vindo de qualquer estado antes de chegar lá.

Além disso, `resultado_auditoria` é forçado a `CONFORME` mesmo quando o aprovador tinha ressalvas — o enum `AuditResult` tem `NAO_CONFORME` e `OBSERVACAO`, e o único campo livre é `notas_auditoria`.

**Impacto** — A definição de máquina de estados do documento não descreve o comportamento real do sistema, o que invalida qualquer auditoria/documentação baseada nela (docs/state-machines.md). Cria dois caminhos de escrita de status com regras divergentes: o autenticado, que valida pré-requisitos, e o do fluxo de aprovação, que não passa por `assertFinalDocumentMutable` nem pelo mapa de transições. E força o resultado da auditoria a 'Conforme', impedindo registrar DDS aprovado com observação/não conformidade — informação relevante de SST perdida.

**Causa raiz** — O fluxo de aprovação foi introduzido (migration 138) depois da máquina de estados (entity), e escreve o status via `Repository.update()` — que não passa por nenhum guard de domínio — em vez de delegar a transição ao método que a governa.

**Correção recomendada**

1) Declarar a transição real: `[DdsStatus.PUBLICADO]: [DdsStatus.AUDITADO, DdsStatus.ARQUIVADO]`.
2) Centralizar a escrita: extrair um `applyStatusTransition(dds, next, manager)` em `DdsService` que valide `DDS_ALLOWED_TRANSITIONS` + `assertFinalDocumentMutable` e seja chamado tanto por `updateStatus` quanto por `approveStep`.
3) Permitir que a decisão final carregue `resultado_auditoria` (novo campo opcional em `DecideDdsApprovalDto`, `@IsEnum(AuditResult)`), com default `CONFORME`.

**Teste de regressão** — Teste em `dds-approval.service.spec.ts` que conclui o fluxo e assere que a transição passou pelo validador (spy em `applyStatusTransition`) e que uma tentativa de aprovar um DDS que voltou a `arquivado` entre a leitura e a gravação é rejeitada. E um teste em `dds.service.spec.ts` que assere que `updateStatus(id, AUDITADO)` a partir de `publicado` é aceito e valida os campos obrigatórios (hoje o caminho é inatingível).

---

### 🟡 SGS-DDS-INT-008 — Link público de assinatura pode ser emitido e usado em DDS já AUDITADO, contornando a imutabilidade aplicada ao caminho autenticado

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | BusinessRule |
| **Local** | `backend/src/modules/dds/dds-signature-invite.service.ts:529` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O caminho autenticado bloqueia qualquer mexida em assinatura depois de auditado — `replaceSignatures` chama `assertWorkflowMutable` (dds.service.ts:1035), que faz:
```ts
private assertWorkflowMutable(dds: Dds): void {
  this.assertFinalDocumentMutable(dds);
  if (dds.status === DdsStatus.AUDITADO) {
    throw new BadRequestException('DDS auditado. Gere um novo DDS operacional para um novo ciclo de execução.');
  }
}
```

O caminho público não tem essa checagem. Emissão de convites (dds-signature-invite.service.ts:529-545):
```ts
private assertDdsCanReceivePublicSignatureInvites(dds: Dds): void {
  if (dds.is_modelo) { ... }
  if (dds.pdf_file_key) { ... }
  if (dds.status === DdsStatus.ARQUIVADO) { ... }
}   // AUDITADO não é bloqueado
```
E o uso do convite (mesmo arquivo, 706-732):
```ts
private assertInviteUsable(invite, options?) {
  if (invite.revoked_at) ...
  if (invite.expires_at.getTime() <= Date.now()) ...
  if (!options?.allowUsed && invite.used_at) ...
  if (invite.dds.is_modelo || invite.dds.pdf_file_key) ...
  if (invite.dds.status === DdsStatus.ARQUIVADO) ...
  if (invite.dds.version !== invite.dds_version) ...
}   // AUDITADO não é bloqueado
```
A camada de assinaturas também não fecha: o `case 'dds'` de `assertDocumentSignatureMutable` (signatures.service.ts:1209-1232) só barra `is_modelo` e PDF final — diferente do `case 'apr'` (1119-1188), que valida status, progresso de aprovação e se o signatário é elaborador/participante.

Repro: concluir o fluxo de aprovação (DDS vira `auditado`) → `POST /dds/:id/signature-invites` retorna 200 e envia o e-mail → participante abre o link e assina → nova assinatura gravada em documento já auditado, antes da emissão do PDF.

**Impacto** — Assinatura de participante pode ser adicionada depois de o documento ter sido formalmente auditado/aprovado, sem nenhum novo ciclo de aprovação. O conjunto de signatários que sustenta a decisão dos aprovadores não é o mesmo que aparece no PDF final. O caminho público efetivamente contorna a regra de imutabilidade que o produto declara e aplica no caminho autenticado — duas superfícies com políticas diferentes sobre o mesmo objeto.

**Causa raiz** — As guardas do módulo de convites foram escritas de forma independente das guardas do `DdsService` (`assertWorkflowMutable`), replicando parcialmente as condições (modelo, PDF, arquivado) e omitindo `AUDITADO`. Não há uma função única de política de mutabilidade compartilhada entre os dois caminhos.

**Correção recomendada**

Extrair a política para um único ponto e reutilizar:
```ts
// dds.service.ts (exportado)
export function assertDdsSignatureSurfaceOpen(dds: Pick<Dds,'is_modelo'|'pdf_file_key'|'status'>) {
  if (dds.is_modelo) throw new BadRequestException(...);
  if (dds.pdf_file_key) throw new BadRequestException(...);
  if (dds.status === DdsStatus.AUDITADO) throw new BadRequestException('DDS auditado não recebe novas assinaturas.');
  if (dds.status === DdsStatus.ARQUIVADO) throw new BadRequestException(...);
}
```
Chamar em `assertDdsCanReceivePublicSignatureInvites`, em `assertInviteUsable` (como `GoneException`) e no `case 'dds'` de `assertDocumentSignatureMutable`. Adicionalmente, alinhar o DDS ao APR incluindo a verificação de que `signerUserId` pertence a `dds_participants`.

**Teste de regressão** — `dds-signature-invite.service.spec.ts`: (1) DDS com `status: 'auditado'` → `issueInvites` deve lançar BadRequestException; (2) convite válido cujo DDS passou a `auditado` → `submitPublicSignature` deve lançar GoneException; (3) DDS `publicado` continua funcionando. E um teste em `signatures.service.spec.ts` para o `case 'dds'` com status auditado.

---

### 🟡 SGS-DDS-OBS-009 — Edição de conteúdo e exclusão em massa de assinaturas do DDS não geram trilha forense nem audit log

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Observability |
| **Local** | `backend/src/modules/dds/dds.controller.ts:811` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O interceptor forense só age quando o handler tem o decorator (shared/interceptors/forensic-audit.interceptor.ts:55-67):
```ts
const action = this.reflector.getAllAndOverride<AuditableAction>(AUDIT_ACTION_METADATA_KEY, [...]);
const resourceType = this.reflector.getAllAndOverride<string>(AUDIT_RESOURCE_METADATA_KEY, [...]);
if (!action || !resourceType) {
  return next.handle();     // sem decorator, nada é registrado
}
```

No `DdsController`, têm `@ForensicAuditAction`: `observability/alerts/dispatch` (433), `approvals/initialize` (494), `approvals/reopen` (517), `approve` (541), `reject` (566), `signature-invites/:inviteId` DELETE (672), `videos` DELETE (780) e `DELETE /dds/:id` (862).

Não têm: `POST /dds` (235-250), **`PATCH /dds/:id`** (811-825), `PATCH /dds/:id/audit` (849-857), **`PUT /dds/:id/signatures`** (607-633), `POST /dds/:id/file` (681-717), `POST /dds/:id/signature-invites` (647-667), `POST /dds/:id/operationalize` (828-846).

O interceptor global de segurança (shared/security/security-action.interceptor.ts:42-80) cobre apenas `DELETE .../:id`, rotas terminadas em `/approve|/reject|/finalize` e `PATCH .../status` — nenhuma delas casa com `PATCH /dds/:id` nem com `PUT /dds/:id/signatures`.

Resultado: as duas operações mais destrutivas do módulo ficam registradas somente em log de aplicação (stdout), sem ator/tenant/site persistidos:
- `dds.service.ts:1320-1332`: `this.logger.log({ event: 'dds_updated', ... })` e `this.logger.warn({ event: 'dds_signatures_invalidated', ... })` — logo após um `DELETE` físico de todas as assinaturas (linha 1310).
- `dds.service.ts:1140-1147`: `this.logger.log({ event: 'dds_signatures_replaced', ... })` — logo após `replaceDocumentSignatures`, que também faz DELETE físico.

**Impacto** — Não é possível responder, a partir do banco, quem apagou as assinaturas de um DDS, quando, de qual IP, nem quais assinaturas existiam antes. O mesmo vale para alterações de conteúdo do documento e para a emissão do PDF final via `POST /:id/file` (que só registra o evento de governança de registro, não a ação do usuário). Em investigação de fraude ou fiscalização, a cadeia de custódia depende de logs de contêiner efêmeros. Isso enfraquece diretamente os achados SGS-DDS-INT-003 e SGS-DDS-INT-005, porque a adulteração fica sem rastro.

**Causa raiz** — A cobertura de auditoria é opt-in por decorator e foi aplicada por inspeção manual, rota a rota. As rotas de escrita adicionadas depois (ou consideradas 'rotineiras') não receberam o decorator, e o interceptor global de segurança usa casamento de sufixo de rota que não alcança `PATCH /:id` nem `PUT /:id/signatures`.

**Correção recomendada**

1) Decorar as rotas de escrita faltantes:
```ts
@Patch(':id')
@ForensicAuditAction('update', 'dds')
...
@Put(':id/signatures')
@ForensicAuditAction('update', 'dds_signatures')
...
@Post(':id/file')
@ForensicAuditAction('create', 'dds_final_document')
```
2) Em `replaceSignatures` e em `update` (quando `signatureResetReasons.length > 0`), emitir explicitamente um evento `forensicTrail.append` com a lista de `signature.id` + `signature_hash` removidos, dentro da mesma transação da remoção.
3) Adicionar `TenantThrottle` a `PATCH /dds/:id` e `PATCH /dds/:id/audit`, hoje sem rate limit (as demais rotas de escrita têm).

**Teste de regressão** — Teste de controller com `ForensicAuditInterceptor` real e `ForensicTrailService` mockado: `PATCH /dds/:id` e `PUT /dds/:id/signatures` devem resultar em `expect(forensicTrail.append).toHaveBeenCalledWith(expect.objectContaining({ module: 'dds', eventType: expect.any(String) }))`. Teste de serviço assegurando que o evento com os ids das assinaturas removidas é gravado antes do DELETE.

---

### 🟡 SGS-DDS-BR-010 — Qualquer UPDATE na linha do DDS invalida todos os convites públicos pendentes, mesmo sem alteração de conteúdo

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | BusinessRule |
| **Local** | `backend/src/modules/dds/dds-signature-invite.service.ts:727` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

A validade do convite é amarrada ao número de versão da linha:
```ts
if (invite.dds.version !== invite.dds_version) {
  throw new GoneException('Link de assinatura invalidado porque o DDS foi alterado.');
}
```
e o convite é criado com `dds_version: dds.version` (mesmo arquivo, linha 178).

Porém `version` é uma `@VersionColumn` e o TypeORM a incrementa em **todo** UPDATE da linha, inclusive via `Repository.update()` — node_modules/typeorm/query-builder/UpdateQueryBuilder.js:397-401:
```js
if (metadata.versionColumn && updatedColumns.indexOf(metadata.versionColumn) === -1)
    updateColumnAndValues.push(this.escape(metadata.versionColumn.databaseName) + " = " + this.escape(metadata.versionColumn.databaseName) + " + 1");
```

Operações que incrementam `version` sem tocar no conteúdo assinável do DDS:
- `DdsService.updateStatus` → `save(dds)` (dds.service.ts:739) — publicar um DDS rascunho mata todos os convites já enviados;
- `DdsService.replaceSignatures` → `manager.getRepository(Dds).update(id, { photo_reuse_justification })` (dds.service.ts:1136-1138) — gravar a justificativa de foto mata os convites;
- `DdsApprovalService.approveStep` → `ddsRepository.update(dds.id, { status, auditado_por_id, ... })` (dds-approval.service.ts:204-212);
- `DdsService.attachPdf` → `manager.getRepository(Dds).update(id, {...})` (dds.service.ts:813-823).

Fluxo real quebrado: emitir convites com o DDS em `rascunho` (permitido por `assertDdsCanReceivePublicSignatureInvites`, que só barra modelo/PDF/arquivado) → publicar o DDS → todos os participantes que clicarem no link recebem 410 Gone com a mensagem 'o DDS foi alterado', embora nada do conteúdo tenha mudado.

**Impacto** — Convites de assinatura morrem por operações rotineiras e legítimas, com uma mensagem que atribui a causa a uma alteração do documento que não ocorreu. Na prática, o time reemite convites repetidamente (gerando e-mails e tokens novos) sem entender o motivo, e o histórico de `dds_signature_invites` enche de convites revogados. Também induz erro em investigação: um `GoneException` de 'DDS alterado' passa a ser ruído, não sinal.

**Causa raiz** — Uso da `@VersionColumn` (que reflete qualquer escrita na linha, incluindo metadados operacionais como `photo_reuse_justification`, `status` e campos de emissão do PDF) como proxy para 'o conteúdo assinável mudou'. Os dois conceitos não coincidem.

**Correção recomendada**

Amarrar o convite a um hash do conteúdo assinável, não ao contador de linha:
```ts
private contentFingerprint(dds: Dds): string {
  return createHash('sha256').update(JSON.stringify({
    tema: dds.tema, conteudo: dds.conteudo ?? '',
    data: this.toDateString(dds.data), site_id: dds.site_id,
    facilitador_id: dds.facilitador_id,
    participants: this.sortedParticipantIds(dds),
  })).digest('hex');
}
```
Gravar em nova coluna `dds_content_hash varchar(64)` (migration nova) e comparar em `assertInviteUsable`. Isso resolve também a lacuna do SGS-DDS-INT-003 (`conteudo: null` passaria a mudar o fingerprint). Manter `dds_version` apenas como metadado informativo.

**Teste de regressão** — `dds-signature-invite.service.spec.ts`: (1) emitir convite, simular `dds.version + 1` sem alteração de conteúdo → `getPublicContext`/`submitPublicSignature` devem continuar funcionando; (2) alterar `tema`/`conteudo`/participantes → devem lançar GoneException. E2E: emitir convite em rascunho → publicar → assinar pelo link com sucesso.

---

### 🔵 SGS-DDS-SEC-011 — withApprovalWriteLock monta o filtro de empresa condicionalmente (padrão fail-open)

| | |
|---|---|
| **Severidade** | LOW |
| **Categoria** | Security |
| **Local** | `backend/src/modules/dds/dds-approval.service.ts:411` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

```ts
private async withApprovalWriteLock<T>(ddsId: string, callback): Promise<T> {
  const companyId = this.tenantService.getTenantId();
  return this.ddsRepository.manager.transaction(async (manager) => {
    ...
    const qb = ddsRepository.createQueryBuilder('dds')
      .setLock('pessimistic_write')
      .where('dds.id = :ddsId', { ddsId })
      .andWhere('dds.deleted_at IS NULL');

    if (companyId) {                                  // <-- fail-open
      qb.andWhere('dds.company_id = :companyId', { companyId });
    }
    const dds = await qb.getOne();
```
Sem contexto de tenant, o SELECT ... FOR UPDATE atinge qualquer DDS do banco por id. Contraste com o método irmão no mesmo módulo, que falha fechado: `DdsService.getApprovalFlowStatus` usa `company_id: this.getTenantIdOrThrow()` (dds.service.ts:1474), e `getSiteAccessScopeOrThrow` lança `UnauthorizedException` (dds.service.ts:176-183).

Pela via HTTP o risco está mitigado: todas as rotas de aprovação passam por `TenantGuard` (dds.controller.ts:167), que lança `UnauthorizedException` quando `getTenantId()` é vazio, inclusive para super admin sem `x-company-id` (shared/guards/tenant.guard.ts:43-79). A RLS de `dds` (`company_id = current_company() OR is_super_admin()`, migration 1709000000177, policy `FOR ALL TO sgs_app` com USING e WITH CHECK) é a segunda barreira.

**Impacto** — Hoje não explorável por HTTP. O risco é de regressão: qualquer chamador interno (worker, job agendado, comando de manutenção) que invoque `DdsApprovalService` sem estabelecer `TenantContext` passa a travar e operar sobre DDS de qualquer tenant, dependendo apenas da RLS para conter o vazamento — e o histórico do projeto mostra que a RLS já esteve inoperante em runtime.

**Causa raiz** — Padrão 'guarda que falha aberta': o predicado de tenant é opcional em vez de obrigatório, replicando o antipadrão já catalogado no projeto.

**Correção recomendada**

```ts
const companyId = this.tenantService.getTenantId();
if (!companyId) {
  throw new UnauthorizedException('Contexto de empresa não identificado para DDS.');
}
...
qb.andWhere('dds.company_id = :companyId', { companyId });
```
(ou reutilizar `DdsService.getTenantIdOrThrow`, já exportado no mesmo módulo).

**Teste de regressão** — `dds-approval.service.spec.ts`: com `tenantService.getTenantId` devolvendo `undefined`, `expect(service.approveStep(...)).rejects.toThrow(UnauthorizedException)` e `expect(queryBuilder.getOne).not.toHaveBeenCalled()`.

---

## NOT VERIFIED — o que não foi possível provar nesta rodada

- Erro 0A000 do PostgreSQL em `SELECT ... LEFT JOIN ... FOR UPDATE` (achado SGS-DDS-CON-002): não há banco PostgreSQL disponível neste ambiente para executar a query. A conclusão vem de duas evidências de código — TypeORM emite ` FOR UPDATE` sem cláusula `OF` quando `setLock` é chamado sem lista de tabelas (node_modules/typeorm/query-builder/SelectQueryBuilder.js:1515-1519 + UpdateQueryBuilder/QueryExpressionMap: `lockTables` só é preenchido pelo 3º argumento) — e da restrição documentada do PostgreSQL de que a cláusula de bloqueio não pode incidir sobre o lado anulável de outer join. Confirmar rodando a query real contra o docker-compose.test.yml antes de priorizar.
- Estado real da RLS em produção: só foi lida a fonte das migrations (177 cria a policy `dds_runtime_tenant_access_policy` FOR ALL TO sgs_app com USING+WITH CHECK; 151 cobre `dds_approval_records`; 210 cobre `dds_signature_invites`; 106 cobre `dds_participants`). Não foi possível consultar `pg_policies`/`relrowsecurity` no banco para confirmar que ENABLE + FORCE estão de fato ativos nas quatro tabelas nem se a policy existe para o role runtime atual — `createPolicyIfManageable` pula silenciosamente a tabela quando o usuário da migration não é membro do owner.
- Não foi possível confirmar experimentalmente que `conteudo: null` atravessa o ValidationPipe (SGS-DDS-INT-003). A conclusão é derivada de: `PartialType` aplicando `applyIsOptionalDecorator` (node_modules/@nestjs/mapped-types/dist/partial-type.helper.js:17), da semântica de `@IsOptional()` do class-validator (ignora null e undefined) e de `whitelist:true` remover apenas propriedades sem decorator. Um teste `plainToInstance(UpdateDdsDto, { conteudo: null })` + `validate()` fecha a prova em segundos.
- Não foi possível exercitar nenhum dos caminhos contra a API real (produção ou local) — a análise é estática. Em particular, o passo a passo de reprodução do SGS-DDS-INT-001 (DELETE de DDS com PDF final) não foi executado; a conclusão vem da ausência do guard comparada com o guard presente em `pts.service.ts:1985` e `nonconformities.service.ts:1563`.
- Efeito real do DELETE físico no Backblaze B2 (`documentStorageService.deleteFile`) não foi verificado — não foi lido o adaptador de storage para confirmar se há versionamento/lifecycle no bucket que permitiria recuperar o objeto. Se houver object lock ou versionamento, a severidade de SGS-DDS-INT-001 cai de CRITICAL para HIGH.
- Frontend não foi analisado (escopo do pedido é backend/banco/segurança). Não sei se a UI expõe o botão de exclusão para DDS auditado, nem se ela envia `site_id` arbitrário em `/dds/people` — mas isso é irrelevante para os achados, já que todos são alcançáveis por chamada HTTP direta.
- Não avaliei os serviços `dds-observability.service.ts` e `dds-observability-alerts.service.ts` (não estavam na lista obrigatória e não participam do fluxo documental/assinaturas).
- Segregação de funções no fluxo de aprovação: `assertActorCanDecide` (dds-approval.service.ts:519-535) permite que um usuário com perfil ADMIN_GERAL aprove sozinho todos os níveis, e não impede que o facilitador do DDS seja também o aprovador. Não reportei como achado porque não encontrei, no código nem nos DTOs, uma regra de negócio declarada que exija aprovadores distintos — seria especulação sobre a intenção do produto. Vale confirmar com o dono do domínio.
