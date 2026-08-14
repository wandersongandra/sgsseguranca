# ARR — Análise de Risco da Rotina — Relatório de Auditoria

> Escopo desta rodada: **Arquitetura · Backend · Banco · Segurança · Máquina de estados · Concorrência · Integridade documental · Observabilidade**.
> Frontend, Design/UX, PDF e Performance de carga ficaram para a rodada 2 (ver `00-master-audit.md` › Status).

## Resumo executivo

O ARR é, de fato, o módulo mais enxuto do escopo — e a maior parte da simplicidade é legítima: não há JSONB de riscos (os campos são colunas escalares tipadas), o isolamento multi-tenant está correto em duas camadas (app + RLS), e todos os query builders filtram deleted_at. A cobertura de RLS foi confirmada e NÃO é um achado: a tabela `arrs` tem ENABLE + FORCE ROW LEVEL SECURITY e três policies com USING **e** WITH CHECK (`tenant_isolation_policy` permissiva recriada dinamicamente pela migration 334, `arrs_runtime_tenant_access_policy` permissiva TO sgs_app pela 177, e `site_scope_isolation_policy` RESTRICTIVE pelas 127/367 — `arrs` entra por ter company_id + site_id). A junção `arr_participants` também tem ENABLE+FORCE+policy EXISTS delegando a `arrs` (migration 115). O que falta no ARR são os *controles* que os módulos irmãos têm: é o único controller documental do escopo sem `@ForensicAuditAction`, não tem etapa de aprovação nem assinatura (o tipo 'arr' está explicitamente fora da allowlist de assinaturas), o nível de risco não é derivado no servidor de probabilidade × severidade, e o banco não tem CHECK para nenhum desses três campos. O PDF "governado" é integralmente produzido e enviado pelo cliente — o servidor hasheia e sela o que recebe, sem qualquer confronto com o registro no banco.

| Severidade | Confirmados |
|---|---|
| 🟠 HIGH | 1 |
| 🟡 MEDIUM | 6 |
| 🔵 LOW | 2 |

## Máquina de estados observada no código

Estados observados em `backend/src/modules/arrs/entities/arr.entity.ts:16-28` e transições aplicadas em `arrs.service.ts:288-314` / `arrs.service.ts:370-384`.

| De | Para | Como | Quem | Guardas reais no código |
|---|---|---|---|---|
| (inexistente) | `rascunho` | `POST /arrs` (default da coluna, `entities/arr.entity.ts:136-141`) | ADMIN_GERAL, ADMIN_EMPRESA, TST, SUPERVISOR, COLABORADOR com `can_manage_arrs` | tenant do JWT define company_id; site precisa estar no escopo (`assertSiteAllowed`, service:100-107) |
| `rascunho` | `analisada` | `PATCH /arrs/:id/status` | mesmos papéis (`can_manage_arrs`) | `ARR_ALLOWED_TRANSITIONS` + `assertFinalDocumentMutable` |
| `rascunho` | `arquivada` | `PATCH /arrs/:id/status` | mesmos papéis | idem |
| `analisada` | `tratada` | `PATCH /arrs/:id/status` **ou** efeito colateral de `POST /arrs/:id/file` (service:379-383) | mesmos papéis | emissão exige participantes ≥1 e site_id (service:502-520) |
| `analisada` | `arquivada` | `PATCH /arrs/:id/status` | mesmos papéis | idem |
| `tratada` | `arquivada` | `PATCH /arrs/:id/status` | mesmos papéis | **inalcançável se houve emissão de PDF** — `assertFinalDocumentMutable` (service:290, 522-527) barra qualquer mudança quando `pdf_file_key` está preenchido |
| `arquivada` | — | — | — | terminal (`ARR_ALLOWED_TRANSITIONS[ARQUIVADA] = []`) |
| qualquer sem PDF | soft-delete | `DELETE /arrs/:id` | ADMIN_GERAL, ADMIN_EMPRESA, TST, SUPERVISOR (COLABORADOR excluído) | recusa se `pdf_file_key` (service:474-480) |

Não existem estados de aprovação, rejeição, assinatura ou revisão. Não existe coluna `approved_by`/`analisado_por`: o mesmo usuário que cria pode levar o documento até a emissão do PDF final sozinho. Transições ilegais clássicas (tratada→rascunho, arquivada→analisada) estão corretamente bloqueadas pela tabela de transições.

## Achados

### 🟠 SGS-ARR-INTEG-001 — PDF final "governado" da ARR é produzido pelo cliente e selado sem qualquer confronto com o registro do banco

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/arrs/arrs.service.ts:316` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O controller aceita um arquivo arbitrário do cliente e o entrega direto ao serviço:

`backend/src/modules/arrs/arrs.controller.ts:169-190`
```ts
@UseInterceptors(FileInterceptor('file', createGovernedPdfUploadOptions()))
async attachFile(@Param('id', new ParseUUIDPipe()) id: string, @Req() req, @UploadedFile() file?: Express.Multer.File) {
  const pdfFile = await assertUploadedPdf(file, undefined, this.fileInspectionService);
  try {
    return await this.arrsService.attachPdf(id, pdfFile, { userId: this.getRequestUserId(req) });
```

E o serviço faz upload + hash + registro do que recebeu, sem nunca ler `arr.risco_identificado`, `arr.nivel_risco`, `arr.controles_imediatos` etc. para conferir o conteúdo:

`backend/src/modules/arrs/arrs.service.ts:349-370`
```ts
await this.documentStorageService.uploadFile(key, file.buffer, file.mimetype);
...
const { hash } = await this.documentGovernanceService.registerFinalDocument({
  companyId: arr.company_id, module: 'arr', entityId: arr.id,
  title: arr.titulo || 'Análise de Risco Rápida',
  fileBuffer: file.buffer,
```

`DocumentGovernanceService.registerFinalDocument` (`backend/src/modules/document-registry/document-governance.service.ts:122`) apenas faz `const hash = this.pdfService.computeHash(input.fileBuffer)`. Não existe geração server-side de PDF de ARR: `grep -rn "nivel_risco" backend/src` só encontra o DTO, a entidade e a migration — nenhum gerador/blueprint no backend consome esses campos.

Reprodução: criar ARR com `nivel_risco: 'critico'`; mudar status para `analisada`; `POST /arrs/:id/file` enviando um PDF (válido, passa ClamAV/assertUploadedPdf) cujo texto diga "nível de risco: baixo, sem controles necessários". O documento é aceito, hasheado, gravado em `document_registry` com `finalized_at`, e a partir daí a ARR fica imutável (`assertFinalDocumentMutable`) — congelando a divergência.

**Impacto** — O artefato que tem valor probatório perante fiscalização (NR/MTE, perícia, Ministério Público do Trabalho) não é derivado do estado do sistema. O hash SHA-256 e a trilha forense provam apenas "este byte-stream foi enviado por este usuário", não "este documento reflete a análise de risco registrada". Como update/updateStatus/remove passam a ser recusados após a emissão, a divergência vira permanente e o próprio sistema a apresenta como documento governado íntegro na validação pública por QR.

**Causa raiz** — Decisão arquitetural de gerar o PDF no frontend (frontend/src/lib/pdf-system) para todos os módulos exceto APR e Relatório Fotográfico, sem uma etapa server-side de renderização canônica ou de verificação (nem sequer um campo de snapshot do estado no momento da emissão).

**Correção recomendada**

Duas opções, em ordem de robustez: (1) gerar o PDF da ARR no backend a partir da entidade (mesmo caminho Puppeteer/pdf-service já usado por APR), ignorando qualquer arquivo enviado pelo cliente — `POST /arrs/:id/emit` sem upload; (2) se a geração no cliente for mantida no curto prazo, persistir junto ao registro um snapshot canônico do estado (`JSON.stringify` determinístico dos campos de negócio) e o seu hash, gravando ambos em `document_registry.metadata`/coluna nova, e expor esse snapshot na validação pública para que o verificador possa confrontar o PDF com o registro. Em ambos os casos, remover `attachPdf` como rota pública do módulo ou restringi-la a um fluxo de importação explicitamente rotulado como não-governado.

**Teste de regressão** — `arrs.service.spec.ts`: "emitir PDF final deve rejeitar arquivo cujo snapshot canônico não corresponda ao estado da ARR" — montar ARR com nivel_risco='critico', chamar attachPdf com buffer arbitrário e esperar BadRequestException; e teste E2E `test/e2e/arr-emission.e2e-spec.ts` que emite pelo backend e verifica que o texto extraído do PDF contém nivel_risco/probabilidade/severidade iguais aos da linha em `arrs`.

---

### 🟡 SGS-ARR-BR-002 — nivel_risco é declarado livremente pelo cliente, sem derivação nem coerência com probabilidade × severidade

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | BusinessRule |
| **Local** | `backend/src/modules/arrs/dto/create-arr.dto.ts:60` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`backend/src/modules/arrs/dto/create-arr.dto.ts:15-17,60-70`
```ts
const ARR_NIVEIS_RISCO = ['baixo', 'medio', 'alto', 'critico'] as const;
const ARR_PROBABILIDADES = ['baixa', 'media', 'alta'] as const;
const ARR_SEVERIDADES = ['leve', 'moderada', 'grave', 'critica'] as const;
...
  @IsString() @IsIn(ARR_NIVEIS_RISCO)  nivel_risco: string;
  @IsString() @IsIn(ARR_PROBABILIDADES) probabilidade: string;
  @IsString() @IsIn(ARR_SEVERIDADES)    severidade: string;
```
Os três campos são independentes. Em `arrs.service.ts:117-150` (`create`) e `254-286` (`update`) não há nenhuma checagem cruzada — `create` só valida company_id, site e pessoas; `update` faz `Object.assign(arr, rest)` (linha 274) sem tocar nesses campos. `grep -rn "nivel_risco" backend/src --include=*.ts` não retorna nenhuma função de matriz de risco para o módulo ARR (só `nivel_risco_padrao` de checklists, que é outra coisa).

Reprodução: `POST /arrs` com `{ probabilidade: 'alta', severidade: 'critica', nivel_risco: 'baixo', ... }` → 201 Created.

**Impacto** — O campo que dirige priorização, dashboards de conformidade e a leitura do documento pela fiscalização pode ser rebaixado arbitrariamente enquanto os fatores que o compõem indicam risco crítico. Como não há aprovação por terceiro (ver SGS-ARR-STATE-005), o próprio autor pode subdimensionar o risco de uma atividade e emitir o PDF final sozinho. Também torna qualquer agregação de risco por obra/empresa não confiável.

**Causa raiz** — A matriz de risco existe conceitualmente (probabilidade e severidade são coletadas) mas nunca foi implementada como regra de domínio no servidor; o cálculo, se existe, vive no formulário do frontend e é enviado como dado.

**Correção recomendada**

Derivar `nivel_risco` no serviço e ignorar/rejeitar o valor vindo do cliente. Ex.: em `arrs.service.ts`, adicionar `private resolveNivelRisco(probabilidade, severidade)` com a matriz 3x4 explícita e aplicá-la em `create` e em `update` (recalculando sempre que probabilidade ou severidade mudarem); remover `nivel_risco` do `CreateArrDto` (ou mantê-lo com `@IsEmpty()` como já é feito com `company_id` em `create-arr.dto.ts:89-94`) e expor o valor derivado apenas na resposta.

**Teste de regressão** — `arrs.service.spec.ts`: "nivel_risco é derivado da matriz e ignora o valor enviado pelo cliente" — chamar create com probabilidade='alta', severidade='critica', nivel_risco='baixo' e assertar que o objeto passado a `arrRepository.create` tem nivel_risco='critico'; e "update recalcula nivel_risco quando severidade muda".

---

### 🟡 SGS-ARR-DB-003 — Banco aceita qualquer string em nivel_risco/probabilidade/severidade — só `status` tem CHECK

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Database |
| **Local** | `backend/src/infra/database/migrations/1709000000115-create-arrs-module.ts:18` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`backend/src/infra/database/migrations/1709000000115-create-arrs-module.ts:18-20,39`
```sql
"nivel_risco" varchar(20) NOT NULL,
"probabilidade" varchar(20) NOT NULL,
"severidade" varchar(20) NOT NULL,
...
CONSTRAINT "chk_arrs_status" CHECK ("status" IN ('rascunho', 'analisada', 'tratada', 'arquivada'))
```
A migration 1709000000333-arr-phase1-hardening.ts (lida integralmente) não adiciona nenhum CHECK — só colunas de PDF, a FK `FK_arrs_emitted_by_user_id` e o índice único de document_code. Logo, o único guardião dos três campos é o `@IsIn` do DTO, que não cobre nenhuma escrita fora do controller HTTP: `manager.getRepository(Arr).update(...)` (usado pelo próprio módulo em `arrs.service.ts:371`), backfills, restore de DR ou correções manuais.

**Impacto** — Divergência silenciosa entre o enum lógico e o dado persistido. Qualquer caminho não-HTTP grava valores fora do domínio; consultas por `nivel_risco` (dashboards, relatórios de conformidade) passam a subcontar sem erro. Também impede que o banco sirva como última linha de defesa, ao contrário de `status`, que tem CHECK.

**Causa raiz** — O hardening de fase 1 (migration 333) focou em governança documental (código, hash, emissor) e não revisitou o domínio dos campos de risco criados na 115.

**Correção recomendada**

Nova migration (próximo timestamp livre) com `ALTER TABLE "arrs" ADD CONSTRAINT "chk_arrs_nivel_risco" CHECK ("nivel_risco" IN ('baixo','medio','alto','critico')) NOT VALID;` (idem para probabilidade e severidade), seguida de `VALIDATE CONSTRAINT` após auditar/limpar as linhas existentes com `SELECT DISTINCT nivel_risco, probabilidade, severidade FROM arrs`. Usar NOT VALID + VALIDATE para não travar a tabela.

**Teste de regressão** — Teste de migration em `backend/test/` que roda a nova migration contra o Postgres do docker-compose.test.yml e assere que `INSERT INTO arrs (... nivel_risco ...) VALUES ('gravissimo')` falha com violação de CHECK.

---

### 🟡 SGS-ARR-OBS-004 — ARR é o único módulo documental do escopo sem @ForensicAuditAction — criação e alteração de conteúdo não deixam trilha persistida

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Observability |
| **Local** | `backend/src/modules/arrs/arrs.controller.ts:216` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O interceptor de trilha forense só age quando o handler declara os dois metadados:

`backend/src/shared/interceptors/forensic-audit.interceptor.ts:56-67`
```ts
const action = this.reflector.getAllAndOverride<AuditableAction>(AUDIT_ACTION_METADATA_KEY, [context.getHandler(), context.getClass()]);
const resourceType = this.reflector.getAllAndOverride<string>(AUDIT_RESOURCE_METADATA_KEY, [...]);
if (!action || !resourceType) { return next.handle(); }
```

`grep -c "AuditAction" backend/src/modules/arrs/arrs.controller.ts` → **0**. Já `grep -rln "AuditAction" backend/src/modules/*/*.controller.ts` lista 21 controllers, incluindo aprs, pts, dds, rdos, checklists, audits, nonconformities, cats, corrective-actions, trainings, medical-exams — todos os irmãos documentais do ARR.

O que sobra para a ARR é o `SecurityActionInterceptor`, que é route-pattern based e cobre apenas dois casos:
`backend/src/shared/security/security-action.interceptor.ts:43-46,70-72`
```ts
if (method === 'DELETE' && routePath.includes(':id')) { ... deletionInitiated ... }
if (method === 'PATCH' && routePath.endsWith('/status')) { ... approvalDecision ... }
```
Ou seja: `POST /arrs` (criação) e `PATCH /arrs/:id` (alteração de título, risco identificado, controles imediatos, ação recomendada) não geram nenhum registro persistido — apenas `this.logger.log({ event: 'arr_updated', ... })` em `arrs.service.ts:280-284`, que vai para log de aplicação, não para `forensic_trail`/`audit_logs`.

**Impacto** — Uma ARR já marcada como `analisada` pode ter `risco_identificado` e `controles_imediatos` reescritos sem que exista, no banco, quem alterou, quando e o que havia antes. Em investigação de acidente, é exatamente esse o campo em disputa. A trilha só reaparece na emissão do PDF (FINAL_DOCUMENT_REGISTERED), já com o conteúdo reescrito.

**Causa raiz** — O módulo ARR foi criado depois da convenção de decoradores de auditoria e nunca foi retrofitado; a cobertura genérica do SecurityActionInterceptor deu a falsa impressão de que o módulo estava auditado.

**Correção recomendada**

Anotar os handlers mutantes em `arrs.controller.ts` seguindo o padrão de `dds.controller.ts:433,494,862`: `@ForensicAuditAction('create', 'arr')` no `create`, `@ForensicAuditAction('update', 'arr')` no `update`, `@ForensicAuditAction('finalize', 'arr')` no `attachFile` e `@ForensicAuditAction('delete', 'arr')` no `remove`. Adicionalmente, gravar o diff dos campos de negócio no metadata (o interceptor atual só grava rota/método), porque sem before/after a trilha de `update` responde "quem" mas não "o quê".

**Teste de regressão** — `arrs.controller.spec.ts`: usar `Reflector` para assertar que `create`, `update`, `attachFile` e `remove` carregam AUDIT_ACTION_METADATA_KEY e AUDIT_RESOURCE_METADATA_KEY; e teste de integração que faz PATCH /arrs/:id e verifica uma linha nova em forensic_trail com eventType AUDIT_UPDATE e module 'arr'.

---

### 🟡 SGS-ARR-STATE-005 — ARR não tem aprovação nem assinatura: 'arr' está fora da allowlist de assinaturas, e o mesmo COLABORADOR cria, analisa e emite o PDF final

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | StateMachine |
| **Local** | `backend/src/modules/signatures/signatures.service.ts:152` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O tipo documental 'arr' está mapeado na governança e no escopo de obra das assinaturas…

`backend/src/modules/document-registry/document-governance.service.ts:68-70`
```ts
['ARR', 'arr'],
['ANALISE_DE_RISCO_RAPIDA', 'arr'],
```
`backend/src/modules/signatures/signatures.service.ts:132-139`
```ts
const SITE_SCOPED_SIGNATURE_DOCUMENT_ENTITIES = { apr: Apr, pt: Pt, dds: Dds, arr: Arr, ... };
```

…mas a criação de assinatura para 'arr' é rejeitada:
`backend/src/modules/signatures/signatures.service.ts:152-162, 2032-2036`
```ts
const ACTIVE_SIGNATURE_DOCUMENT_TYPES = new Set(['apr','pt','dds','checklist','cat','nonconformity','audit','rdo','photographic_report']);  // sem 'arr'
...
if (!ACTIVE_SIGNATURE_DOCUMENT_TYPES.has(normalized)) {
  throw new BadRequestException('document_type inválido para criação de assinatura.');
}
```

E não há segregação de funções: `arrs.controller.ts:94-100` libera a classe inteira para COLABORADOR, `create`/`update`/`updateStatus`/`attachFile` exigem apenas `can_manage_arrs` (linhas 123, 164, 200, 224), e a migration que criou o módulo concedeu essa permissão ao papel 'Operador / Colaborador':
`backend/src/infra/database/migrations/1709000000115-create-arrs-module.ts:84-97`
```sql
WHERE r.name IN ('Administrador Geral','Administrador da Empresa','Técnico de Segurança do Trabalho (TST)','Supervisor / Encarregado','Operador / Colaborador')
  AND p.name IN ('can_view_arrs', 'can_manage_arrs')
```
A entidade (`entities/arr.entity.ts`) não tem nenhuma coluna `approved_by`/`analisado_por`/`signed_at` — só `emitted_by_user_id`.

**Impacto** — A ARR lista participantes (`arr_participants`, obrigatório ≥1 para emitir — service:515-519) e o PDF final é apresentado como documento governado, mas nenhum participante jamais assina e ninguém além do autor valida a análise. O mesmo usuário de menor senioridade percorre rascunho → analisada → PDF final sozinho. Não há prova de ciência dos expostos ao risco nem de aprovação técnica — justamente o que se espera de um documento de SST em fiscalização.

**Causa raiz** — O módulo foi entregue como CRUD + emissão de PDF, e o suporte a assinatura ficou meio-implementado (mapeamentos existem, allowlist não). Não houve modelagem de fluxo de aprovação como em APR (apr_approval_steps/apr_approval_records) ou DDS.

**Correção recomendada**

Decidir explicitamente entre as duas saídas e implementar por inteiro: (a) habilitar assinatura — adicionar 'arr' a `ACTIVE_SIGNATURE_DOCUMENT_TYPES`, exigir assinatura de responsável e participantes antes de permitir `attachPdf`, e amarrar a assinatura ao `final_pdf_hash_sha256` (o gancho `findRegistryContextForSignature` já existe); ou (b) remover 'arr' de `SITE_SCOPED_SIGNATURE_DOCUMENT_ENTITIES` e do mapa de `signatureDocumentTypeToRegistryModule`, documentando que ARR não é documento assinável. Em qualquer caso, separar a permissão de emissão: criar `can_emit_arrs` (ou exigir TST/SUPERVISOR/ADMIN em `@Roles` de `attachFile` e da transição analisada→tratada) e adicionar coluna `analisada_por_user_id` preenchida pelo servidor na transição rascunho→analisada.

**Teste de regressão** — `arrs.controller.spec.ts`: "COLABORADOR não pode emitir o PDF final da ARR" — assertar que os `@Roles` de `attachFile` não incluem Role.COLABORADOR; `signatures.service.spec.ts`: "assinatura de ARR é aceita e vinculada ao hash do PDF final" (caso a) ou "'arr' não aparece em nenhum mapa de assinatura" (caso b).

---

### 🟡 SGS-ARR-DB-007 — Índice único de document_code é global (sem company_id) e o código deriva de 8 hex do UUID — colisão entre tenants bloqueia permanentemente a emissão

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Database |
| **Local** | `backend/src/infra/database/migrations/1709000000333-arr-phase1-hardening.ts:57` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`backend/src/infra/database/migrations/1709000000333-arr-phase1-hardening.ts:56-60`
```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_arrs_document_code_active"
ON "arrs" ("document_code")
WHERE "document_code" IS NOT NULL AND "deleted_at" IS NULL
```
Não há `company_id` na chave do índice — a unicidade é global no cluster, atravessando tenants.

O código é derivado só de ano + últimos 8 caracteres alfanuméricos do UUID:
`backend/src/modules/arrs/arrs.service.ts:634-651`
```ts
const reference = String(arr.id || arr.titulo || 'ARR').replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase();
return `ARR-${year}-${reference || String(Date.now()).slice(-6)}`;
```
Espaço efetivo = 8 hex ≈ 4,3e9 por ano, compartilhado por todas as empresas.

Caminho da falha: em `attachPdf`, o upload já ocorreu quando `registerFinalDocument` roda `persistEntityMetadata` → `manager.getRepository(Arr).update(id, { document_code: documentCode, ... })` (`arrs.service.ts:370-384`). Uma violação de unicidade aborta a transação, cai no `catch` de `arrs.service.ts:391-396` que chama `cleanupUploadedFile` e relança — a ARR nunca consegue emitir o PDF, e o erro não é acionável pelo usuário (o `document_code` é determinístico a partir do id, portanto tentar de novo dá exatamente a mesma colisão).

**Impacto** — Uma ARR de outra empresa impede permanentemente a emissão do documento final de uma ARR sua — acoplamento cross-tenant em um recurso que deveria ser isolado, e negação de serviço definitiva para o registro afetado (não há retry que resolva). Também vaza, por canal lateral, a existência de um document_code de outro tenant.

**Causa raiz** — O índice foi criado como unicidade de "código documental" sem considerar que o namespace do código é por empresa, e o gerador do código trocou entropia por legibilidade (8 hex) sem incluir discriminante de tenant.

**Correção recomendada**

Nova migration: `DROP INDEX CONCURRENTLY IF EXISTS "UQ_arrs_document_code_active"` e recriar como `CREATE UNIQUE INDEX CONCURRENTLY "UQ_arrs_document_code_active" ON "arrs" ("company_id", "document_code") WHERE "document_code" IS NOT NULL AND "deleted_at" IS NULL` (migration com `transaction = false`, como a 333). Complementarmente, tornar `buildArrDocumentCode` resistente a colisão dentro do tenant — por exemplo usando um sequencial por empresa/ano, ou ampliando `slice(-8)` para 12 caracteres.

**Teste de regressão** — Teste de migration contra o Postgres de teste: inserir duas ARRs de `company_id` diferentes com o mesmo `document_code` e assertar que ambas persistem; e assertar que duas ARRs do MESMO company_id com o mesmo document_code violam a constraint.

---

### 🟡 SGS-ARR-CONC-008 — update() e updateStatus() fazem read-modify-write sem lock nem coluna de versão — lost update e janela para alterar documento recém-emitido

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Concurrency |
| **Local** | `backend/src/modules/arrs/arrs.service.ts:254` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`backend/src/modules/arrs/arrs.service.ts:254-286`
```ts
async update(id: string, updateArrDto: UpdateArrDto): Promise<Arr> {
  const arr = await this.findOne(id);          // leitura sem FOR UPDATE
  this.assertFinalDocumentMutable(arr);        // guarda avaliada sobre a leitura
  ...
  Object.assign(arr, rest);
  arr.participants = participantIds.map(...) as User[];
  const saved = await this.arrRepository.save(arr);   // escrita sem checar versão
```
`arrs.service.ts:288-314` (`updateStatus`) segue o mesmo padrão: `findOne` → `assertFinalDocumentMutable` → checagem de `ARR_ALLOWED_TRANSITIONS` → `save`. `findOne` (linhas 232-252) usa `arrRepository.findOne({ where: {...} })`, sem `lock`. A entidade `Arr` (`entities/arr.entity.ts:33-142`) estende `BaseAuditEntity`, que declara apenas `@CreateDateColumn`, `@UpdateDateColumn` e `@DeleteDateColumn` (`shared/entities/base-audit.entity.ts:21-30`) — não há `@VersionColumn`. Nenhuma migration adiciona coluna `version` a `arrs`.

Dois cenários reproduzíveis: (1) dois PATCH /arrs/:id simultâneos — o último a gravar sobrescreve os campos do primeiro sem conflito nem 409, e como não há trilha de update (SGS-ARR-OBS-004) a perda é invisível; (2) PATCH /arrs/:id/status concorrente com POST /arrs/:id/file — ambos leem `pdf_file_key = null`, a emissão commita, e o `save` do status escreve por cima, deixando um documento emitido em `arquivada`.

Contraste: o módulo PT/Checklist já adotou `FOR UPDATE NOWAIT` nesses caminhos (ver histórico do repositório); o ARR não.

**Impacto** — Perda silenciosa de alterações no conteúdo de um documento de segurança (dois usuários editando a mesma ARR na obra é cenário corriqueiro), e possibilidade de deixar o ciclo de vida inconsistente com o estado documental. A guarda de imutabilidade pós-emissão vira probabilística, não determinística.

**Causa raiz** — Padrão load-entity/assign/save herdado do CRUD gerado, sem controle de concorrência otimista nem pessimista — o mesmo padrão já corrigido em Checklist, RDO, NC e PT neste repositório, mas não replicado no ARR.

**Correção recomendada**

Adicionar `@VersionColumn({ name: 'version', default: 1 })` à entidade `Arr` (com migration `ALTER TABLE "arrs" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1`), aceitar `expected_version` no `UpdateArrDto` e traduzir `OptimisticLockVersionMismatchError` em `ConflictException` (409) — mesmo tratamento já usado no APR. Alternativamente/adicionalmente, para `updateStatus` e `attachPdf`, recarregar a entidade com `lock: { mode: 'pessimistic_write', onLocked: 'nowait' }` dentro de uma transação antes de avaliar `assertFinalDocumentMutable`.

**Teste de regressão** — `arrs.service.spec.ts`: "update com expected_version obsoleta retorna 409"; e teste de integração contra Postgres: abrir duas transações, ambas lendo a mesma ARR, e assertar que o segundo `save` falha em vez de sobrescrever.

---

### 🔵 SGS-ARR-STATE-006 — ARR com PDF emitido fica presa em `tratada` para sempre — `arquivada` vira estado inalcançável e o registro não pode ser encerrado

| | |
|---|---|
| **Severidade** | LOW |
| **Categoria** | StateMachine |
| **Local** | `backend/src/modules/arrs/arrs.service.ts:288` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`backend/src/modules/arrs/arrs.service.ts:288-296`
```ts
async updateStatus(id: string, status: ArrStatus): Promise<Arr> {
  const arr = await this.findOne(id);
  this.assertFinalDocumentMutable(arr);   // <-- lança se pdf_file_key
```
`backend/src/modules/arrs/arrs.service.ts:522-527`
```ts
private assertFinalDocumentMutable(arr: Arr): void {
  if (arr.pdf_file_key) {
    throw new BadRequestException('Documento com PDF final emitido. Gere um novo registro para alterações.');
  }
```
E a remoção também recusa:
`backend/src/modules/arrs/arrs.service.ts:474-480`
```ts
if (arr.pdf_file_key) {
  throw new BadRequestException('Somente ARRs sem PDF final podem ser removidas. Use os fluxos formais de cancelamento/encerramento para registros já emitidos.');
}
```
Os "fluxos formais de cancelamento/encerramento" citados na mensagem **não existem** no módulo: `arrs.controller.ts` expõe apenas POST /, GET /, GET /:id, GET /:id/pdf, GET /:id/validation-context, POST /:id/file, PATCH /:id/status, PATCH /:id, DELETE /:id — nenhuma rota de cancelamento.

Reprodução: emitir o PDF de uma ARR (status vai a `tratada`, service:379-383) e depois tentar `PATCH /arrs/:id/status {"status":"arquivada"}` → 400.

**Impacto** — Toda ARR emitida permanece indefinidamente como ativa/`tratada` nas listagens e nos indicadores, sem caminho de encerramento. A transição `tratada → arquivada`, declarada em `ARR_ALLOWED_TRANSITIONS` (`entities/arr.entity.ts:26`), é código morto na prática, e a mensagem de erro do `remove` aponta para um fluxo inexistente — o operador fica sem ação possível.

**Causa raiz** — A guarda de imutabilidade pós-emissão foi aplicada de forma indiscriminada a `updateStatus`, sem separar mudança de conteúdo (que deve ser bloqueada) de mudança de ciclo de vida (arquivamento, que deveria continuar permitida e auditada).

**Correção recomendada**

Em `updateStatus`, substituir `assertFinalDocumentMutable(arr)` por uma guarda que só bloqueie transições de conteúdo: permitir `→ ArrStatus.ARQUIVADA` mesmo com `pdf_file_key` preenchido (mantendo o bloqueio para qualquer outro destino), e registrar a transição na trilha forense. Ajustar também a mensagem do `remove` para não citar um fluxo inexistente, ou implementar de fato o cancelamento.

**Teste de regressão** — `arrs.service.spec.ts`: "permite arquivar ARR já emitida" — mock de findOne com pdf_file_key preenchido e status 'tratada', chamar updateStatus(id, ArrStatus.ARQUIVADA) e esperar resolução; e "continua bloqueando tratada→analisada em ARR emitida".

---

### 🔵 SGS-ARR-BE-009 — update() não replica a guarda de company_id que create() tem — `{"company_id": null}` chega ao Object.assign e derruba a requisição em 500

| | |
|---|---|
| **Severidade** | LOW |
| **Categoria** | Backend |
| **Local** | `backend/src/modules/arrs/arrs.service.ts:254` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

`create` rejeita explicitamente qualquer presença do campo:
`backend/src/modules/arrs/arrs.service.ts:118-126`
```ts
const { participants, company_id, ...rest } = createArrDto;
...
if (company_id !== undefined) {
  throw new BadRequestException('company_id não é permitido no payload. O tenant autenticado define a empresa.');
}
```
`update` não extrai nem checa `company_id`:
`backend/src/modules/arrs/arrs.service.ts:258,274`
```ts
const { participants, ...rest } = updateArrDto;   // company_id continua dentro de rest
...
Object.assign(arr, rest);
```
E o DTO deixa passar valores "vazios" — `@IsEmpty()` do class-validator aceita `null` e `''`:
`backend/src/modules/arrs/dto/create-arr.dto.ts:89-94`
```ts
@IsOptional()
@IsEmpty({ message: 'company_id não é permitido no payload. ...' })
company_id?: never;
```
`UpdateArrDto` é `PartialType(CreateArrDto)` (`dto/update-arr.dto.ts:4`), preservando esse validador. Como `company_id` é propriedade declarada, o `whitelist: true` global (`src/main.ts:345-346`) não a remove.

Reprodução: `PATCH /arrs/:id` com body `{"company_id": null}` → passa a validação → `arr.company_id = null` → `save` emite `UPDATE arrs SET company_id = NULL ...` → violação de NOT NULL (`migration 115:25`) e/ou do `WITH CHECK` da policy RLS → 500 em vez de 400.

**Impacto** — Sem escalada de privilégio (o `@IsEmpty` impede apontar para outro tenant), mas é um 500 disparável por qualquer usuário autenticado com `can_manage_arrs`, poluindo Sentry/alertas e mascarando erros reais. É também a evidência de que a guarda de tenant do `update` depende exclusivamente do DTO, sem defesa no serviço — divergência de postura com o `create`.

**Causa raiz** — A proteção contra forja de company_id foi implementada apenas no caminho de criação; o `update`, escrito depois, assumiu que o DTO bastava.

**Correção recomendada**

Em `arrs.service.ts:258`, espelhar o `create`: `const { participants, company_id, ...rest } = updateArrDto; if (company_id !== undefined) { throw new BadRequestException('company_id não é permitido no payload.'); }`. Opcionalmente trocar `@IsEmpty()` por `@IsUndefined()` (validador customizado) no DTO para rejeitar `null`/`''` já na borda, em ambos os fluxos.

**Teste de regressão** — `arrs.service.spec.ts`: "rejeita company_id no payload de update, inclusive null" — chamar `service.update('arr-1', { company_id: null } as never)` e esperar BadRequestException, assertando que `arrRepository.save` não foi chamado (espelhando o teste já existente para `create` na linha 75).

---

## NOT VERIFIED — o que não foi possível provar nesta rodada

- Comportamento real do RLS no banco de produção: toda a análise de policies foi feita lendo as migrations 115, 127, 172, 177, 334 e 367. Não foi possível rodar `SELECT * FROM pg_policies WHERE tablename IN ('arrs','arr_participants')` nem `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='arrs'` contra a instância Neon — não há banco acessível nesta sessão. A conclusão de que a cobertura está correta assume que as migrations 172/177/334/367 foram todas aplicadas na ordem; se a 172 (que faz DROP da tenant_isolation_policy de arrs) tiver rodado e a 177/334 não, `arrs` fica só com a policy RESTRICTIVE e nega tudo (fail-closed, não vazamento). Recomendo confirmar em produção com o script backend/scripts/db-critical-analysis.cjs.
- Colisão real de `document_code` (SGS-ARR-DB-007): não foi possível medir o volume atual de ARRs por ano em produção (`SELECT date_part('year', data), count(*) FROM arrs GROUP BY 1`) para estimar a probabilidade concreta. O defeito estrutural (índice único sem company_id) está provado pela leitura do SQL; a frequência esperada, não.
- Divergência entre o PDF e o registro (SGS-ARR-INTEG-001): não foi possível baixar um PDF final de ARR de produção e comparar o texto com a linha correspondente em `arrs`, o que exigiria credenciais de storage e do banco. A ausência de qualquer geração/verificação server-side está provada por grep (`nivel_risco` não aparece em nenhum gerador de PDF do backend), mas o caso concreto de divergência não foi materializado.
- Cobertura do ARR pelos fluxos de LGPD/GDPR (soft-delete de empresa, retenção, erasure) e pelo Disaster Recovery: fora do escopo dos arquivos obrigatórios e não auditado. `arrs` tem `deleted_at`, o que sugere cobertura, mas não confirmei se a tabela consta das listas de `GDPRDeletionService` e do restore de DR.
- Comportamento do frontend: não foi verificado se o formulário de ARR calcula `nivel_risco` a partir de probabilidade × severidade antes de enviar. Isso não altera o achado SGS-ARR-BR-002 (a API aceita qualquer combinação independentemente do frontend), mas muda a avaliação de quão fácil é o abuso pela UI oficial.
- Efeito prático da corrida entre dois `POST /arrs/:id/file` simultâneos: a segunda transação é abortada pela guarda `if (existing?.finalized_at || existing?.signed_at) throw` em document-registry.service.ts:101-105, e a chave de storage inclui `Date.now()` (document-storage.service.ts:47), então a janela para apagar o arquivo da primeira emissão exige colisão no mesmo milissegundo. Por não conseguir reproduzir, não reportei como achado.
