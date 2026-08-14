# EPI — Equipamentos de Proteção Individual — Relatório de Auditoria

> Escopo desta rodada: **Arquitetura · Backend · Banco · Segurança · Máquina de estados · Concorrência · Integridade documental · Observabilidade**.
> Frontend, Design/UX, PDF e Performance de carga ficaram para a rodada 2 (ver `00-master-audit.md` › Status).

## Resumo executivo

O domínio é composto por um catálogo (`epis`, CRUD genérico via BaseController/BaseService) e o documento operacional (`epi_assignments`, serviço próprio com escopo de obra). O isolamento multi-tenant está sólido nas duas pontas: RLS com FORCE + WITH CHECK em `epis` (migration 315), policy RESTRICTIVE site-scoped em `epi_assignments` (migrations 127/367 por descoberta dinâmica de tabelas com company_id+site_id), e a chave de cache Redis é `catalog:epis:{tenantId}` — não há vazamento cross-tenant de cache. O que está quebrado é a camada probatória e de privacidade: a migration 345 sobrescreveu `gdpr_delete_user_data()` e apagou o bloco de `epi_assignments` que a 314 havia adicionado, de modo que a assinatura biométrica do trabalhador NUNCA é anonimizada em pedido de exclusão LGPD — e o teste que "prova" isso lê o arquivo da migration 314 com `readFileSync` + `toContain`. A validação do payload de assinatura é 100% inoperante (`@IsObject()` sem `@ValidateNested()`/`@Type()`), o que provei em runtime: 1 MB de `signature_data` e chaves arbitrárias passam sem um único erro. A assinatura não está amarrada ao conteúdo da ficha (o hash cobre só o traço), qualquer Operador/Colaborador pode devolver a ficha de um colega com carimbo de assinatura atribuído ao colega, e não existe controle de estoque nem validação de CA vencido na entrega. Devolução e substituição são read-modify-write sem lock nem version.

| Severidade | Confirmados |
|---|---|
| 🔴 CRITICAL | 1 |
| 🟠 HIGH | 3 |
| 🟡 MEDIUM | 6 |
| 🔵 LOW | 3 |

## Máquina de estados observada no código

Máquina de estados observada em `backend/src/modules/epi-assignments/epi-assignments.service.ts` (não há coluna de versão, nem CHECK constraint no banco sobre `status`):

| Estado | Como se entra | Transições permitidas pelo código | Quem pode | Ficha ainda editável? |
|---|---|---|---|---|
| `entregue` | `create()` L92 grava `status: 'entregue'` fixo (cliente não controla) | → `devolvido` (`returnAssignment` L219 exige `status === 'entregue'`); → `substituido` (`replaceAssignment` L252 exige `status === 'entregue'`) | create: ADMIN_GERAL, ADMIN_EMPRESA, TST, SUPERVISOR (`epi-assignments.controller.ts` L51) | SIM — `update()` L193 só bloqueia `devolvido` |
| `devolvido` | `returnAssignment()` L230 | nenhuma (terminal) | return: ADMIN_GERAL, ADMIN_EMPRESA, TST, SUPERVISOR **e COLABORADOR** (controller L145-151) | NÃO — `update()` L193-197 lança BadRequest |
| `substituido` | `replaceAssignment()` L258 | nenhuma para `status`, MAS a ficha continua mutável | replace: ADMIN_GERAL, ADMIN_EMPRESA, TST, SUPERVISOR (controller L162) | **SIM** — `update()` L193 só compara com `'devolvido'`, então `quantidade` e `observacoes` de uma ficha já substituída seguem editáveis para sempre |

Observações provadas:
- Não há transição ilegal alcançável via `status` no payload: `UpdateEpiAssignmentDto` só declara `quantidade` e `observacoes`, e o ValidationPipe global roda com `whitelist: true` + `forbidNonWhitelisted: true` (`src/main.ts` L344-346). Este ponto está correto.
- O bloqueio das transições é feito SOMENTE em memória, após `findOne()`, sem `SELECT ... FOR UPDATE`, sem `@VersionColumn` e sem `UPDATE ... WHERE status = 'entregue'`. Duas requisições concorrentes leem `entregue` e ambas gravam.
- O banco não tem CHECK em `epi_assignments.status` (grep em `1709000000202-add-check-constraints-status-columns.ts`, `1709000000310-add-missing-check-constraints.ts` e `1709000000107-constraints-uniqueness-and-checks.ts` não retorna `epi_assignments`), nem CHECK temporal `devolvido_em >= entregue_em`, nem CHECK `status='devolvido' => devolvido_em IS NOT NULL`.

## Achados

### 🔴 SGS-EPI-PRIV-001 — Migration 345 sobrescreveu gdpr_delete_user_data() e apagou o bloco de epi_assignments da 314 — assinatura biométrica do trabalhador NUNCA é anonimizada em pedido LGPD

| | |
|---|---|
| **Severidade** | CRITICAL |
| **Categoria** | Database |
| **Local** | `backend/src/infra/database/migrations/1709000000345-gdpr-anonymize-user-pii.ts:38` |
| **Verificação adversarial** | CONFIRMED — CONFIRMADO e AMPLIADO. Rastreamento das versões de `gdpr_delete_user_data()`: a 312 cobria 7 tabelas incluindo `pts_text_fields`; a 314 acrescentou `epi_assignments` (8 no total); a 345 — última migration a executar `CREATE OR REPLACE FUNCTION` sobre ela — cobre apenas activities, ai_interactions, apr_risk_evidences, audit_logs, document_registry, user_consents, user_sessions. Perdeu `epi_assignments` E `pts_text_fields`. Nenhuma migration posterior (346-376) redefine a função. A regressão LGPD atinge DOIS módulos do escopo, não um. |

**Evidência**

A migration 1709000000314 adicionou à função de erasure o bloco:

```sql
-- 314, L142-166
IF to_regclass('public.epi_assignments') IS NOT NULL THEN
  UPDATE epi_assignments
  SET deleted_at = NOW(),
      user_id = NULL,
      assinatura_entrega = jsonb_set(jsonb_set(COALESCE(assinatura_entrega,'{}'::jsonb),'{signer_name}','"[LGPD: removido]"'),'{signature_data}','"[LGPD: removido]"'),
      ...
```

A migration 1709000000345 (timestamp POSTERIOR, logo é a definição efetiva no banco) faz `CREATE OR REPLACE FUNCTION public.gdpr_delete_user_data(p_user_id uuid)` com corpo COMPLETO e novo (L38-146). Rodando `grep -n "epi_assignments" 1709000000345-gdpr-anonymize-user-pii.ts` o retorno é VAZIO. As únicas tabelas cobertas pela 345 são: `audit_logs`, `user_sessions`, `document_registry`, `ai_interactions`, `user_consents`, `apr_risk_evidences`, `users`. `epi_assignments` (e também o bloco `pts_text_fields` da migration 312) desapareceram silenciosamente.

Reprodução: em um banco com todas as migrations aplicadas, executar `SELECT prosrc FROM pg_proc WHERE proname='gdpr_delete_user_data';` — o texto não contém `epi_assignments`. Ou executar `SELECT * FROM gdpr_delete_user_data('<uuid-de-um-user-com-ficha-de-EPI>');` e observar que não há linha de retorno `epi_assignments` e que `SELECT assinatura_entrega->>'signature_data' FROM epi_assignments WHERE user_id='<uuid>'` continua devolvendo o traço da assinatura em base64.

Agravante latente: mesmo se o bloco da 314 estivesse ativo, ele quebraria. `epi_assignments.user_id` é `uuid NOT NULL` (criado assim em `1699000000000-initial-schema.ts` L543 e em `1709000000017-create-epi-assignments-table.ts` L12, e nenhuma migration posterior faz DROP NOT NULL — `grep -l epi_assignments *.ts` lista apenas 12 arquivos, nenhum deles altera a nulidade). O `SET user_id = NULL` da 314 levantaria `null value in column "user_id" violates not-null constraint`, abortando a função inteira e derrubando TODO o pedido de exclusão — exatamente o padrão de falha já documentado no cabeçalho da própria 345.

**Impacto** — O `signature_data` é o traço manuscrito do trabalhador (dado pessoal, tratado pelo próprio código como biometria: a migration 314 se auto-descreve como 'assinatura/biometria'). Um titular que exerce o direito de exclusão do art. 18, VI da LGPD tem sua assinatura preservada indefinidamente na tabela `epi_assignments`, junto com `signer_name`. O serviço reporta o pedido como concluído (a função 345 executa com sucesso e retorna 7 linhas), então a não-conformidade é silenciosa — ninguém percebe. Exposição regulatória direta perante a ANPD e falsidade no relatório de atendimento ao titular.

**Causa raiz** — Duas migrations independentes (312→pts, 314→epi_assignments, 342→apr_risk_evidences, 345→users) editam a MESMA função via `CREATE OR REPLACE` com corpo completo reescrito à mão, em vez de composição. Quem escreveu a 345 partiu da versão da 213/145 (que ainda tinha `activities`) para consertá-la e nunca rebaseou sobre o corpo já estendido pela 312/314. Não existe teste que execute a função contra um banco real e verifique a lista de tabelas retornadas — só assertions de string sobre o arquivo-fonte da 314.

**Correção recomendada**

1) Criar migration 1709000000377 que reescreve `public.gdpr_delete_user_data(uuid)` unindo TODOS os blocos hoje dispersos (audit_logs, user_sessions, document_registry, ai_interactions, user_consents, apr_risk_evidences, pts_text_fields da 312, epi_assignments da 314, users da 345), na ordem correta e com as colunas verificadas contra o schema real.

2) No bloco de epi_assignments, NÃO usar `user_id = NULL` (viola NOT NULL). Duas opções: (a) na mesma migration, `ALTER TABLE epi_assignments ALTER COLUMN user_id DROP NOT NULL` (a entidade TypeScript já declara `user_id: string` obrigatório, então precisaria virar `user_id?: string | null` e todas as queries por user_id já filtram por igualdade, o que exclui NULL naturalmente); ou (b) preservar o vínculo e anonimizar apenas o conteúdo:

```sql
UPDATE epi_assignments
SET deleted_at = COALESCE(deleted_at, NOW()),
    assinatura_entrega = jsonb_set(
      jsonb_set(COALESCE(assinatura_entrega, '{}'::jsonb),
        '{signer_name}', '"[LGPD: removido]"'),
      '{signature_data}', '"[LGPD: removido]"'),
    assinatura_devolucao = CASE WHEN assinatura_devolucao IS NOT NULL THEN
      jsonb_set(jsonb_set(assinatura_devolucao,'{signer_name}','"[LGPD: removido]"'),
        '{signature_data}','"[LGPD: removido]"')
    ELSE assinatura_devolucao END
WHERE user_id = p_user_id;
GET DIAGNOSTICS v_count = ROW_COUNT;
RETURN QUERY SELECT 'epi_assignments'::text, v_count;
```
(a linha `users` já é anonimizada pela 345, então o vínculo por FK deixa de identificar pessoa natural).

3) Adicionar comentário-âncora na função (`COMMENT ON FUNCTION ... IS 'tabelas cobertas: ...'`) e proibir `CREATE OR REPLACE` parcial via checklist de review.

**Teste de regressão** — Teste E2E contra Postgres real (não `readFileSync`), em `backend/test/e2e/gdpr-erasure.e2e-spec.ts`: (1) criar company + user + epi + `epi_assignment` com `assinatura_entrega.signature_data = 'TRACO-REAL-BASE64'`; (2) `SELECT * FROM gdpr_delete_user_data($userId)` e afirmar que o array de `table_name` retornado CONTÉM `'epi_assignments'` com `deleted_count = 1`; (3) `SELECT assinatura_entrega->>'signature_data', assinatura_entrega->>'signer_name', deleted_at FROM epi_assignments WHERE id=$id` e afirmar `'[LGPD: removido]'` nos dois campos e `deleted_at IS NOT NULL`; (4) teste-guarda que falha se a função executar sem erro mas omitir qualquer tabela de uma lista canônica exportada em código (`GDPR_ERASURE_COVERED_TABLES`), de modo que a próxima migration que reescrever a função quebre o CI em vez de quebrar a produção.

---

### 🟠 SGS-EPI-SEC-002 — @IsObject() sem @ValidateNested()/@Type() anula 100% da validação da assinatura — provado em runtime: 1 MB de signature_data e chaves arbitrárias passam sem um único erro

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Security |
| **Local** | `backend/src/modules/epi-assignments/dto/create-epi-assignment.dto.ts:54` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

```ts
// create-epi-assignment.dto.ts L54-55
@IsObject()
assinatura_entrega: EpiSignatureInputDto;
```
```ts
// return-epi-assignment.dto.ts L11-12
@IsObject()
assinatura_devolucao: EpiSignatureInputDto;
```
Não há `@ValidateNested()` nem `@Type(() => EpiSignatureInputDto)` em nenhum dos dois. Sem eles, o class-transformer não instancia a classe aninhada e o class-validator não desce no objeto — os `@MaxLength(400_000)`, `@MaxLength(80)`, `@MaxLength(200)`, `@IsNotEmpty()` de `EpiSignatureInputDto` (L13-28) nunca executam, e o `whitelist`/`forbidNonWhitelisted` global (`src/main.ts` L344-346) não poda chaves aninhadas.

Provei em runtime com os arquivos reais do repositório (`npx ts-node` importando o DTO de produção, `validate(dto, { whitelist: true, forbidNonWhitelisted: true })`):
```
CASO 1 ERROS: []
CASO 1 chaves sobreviventes: [ 'signature_data', 'signature_type', 'signer_name', 'campo_arbitrario', 'signature_hash' ]
CASO 1 signature_data length: 1000000  (MaxLength declarado = 400000)
CASO 2 (assinatura vazia) qtd erros: 0
CASO 2 issueFromRaw(undefined) -> TypeError: The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined
```
Ou seja: `POST /epi-assignments` com `assinatura_entrega: { signature_data: 'x'.repeat(1000000), signature_type: 'y'.repeat(5000), signer_name: 'z'.repeat(9999), campo_arbitrario: {...} }` é aceito. O teto real vira o body limit de 5 MB (`src/main.ts` L334 `json({ limit: '5mb' })`), 12x acima do limite declarado. E `assinatura_entrega: {}` também passa a validação e só explode em `SignatureTimestampService.issueFromRaw` (`src/shared/services/signature-timestamp.service.ts` L19 `createHash('sha256').update(rawPayload)`), devolvendo 500 em vez de 400.

**Impacto** — (1) DoS de armazenamento e de leitura: cada ficha pode carregar ~5 MB de jsonb; `findPaginated` faz `leftJoinAndSelect` e devolve 100 fichas por página, ou seja até ~500 MB serializados por request. (2) Poluição de jsonb com chaves arbitrárias vindas do cliente em uma coluna que é prova documental de entrega de EPI. (3) 500 em vez de 400 quando a assinatura vem vazia, o que polui Sentry e mascara requisições malformadas. (4) `signature_type` e `signer_name` sem limite algum vão direto para o jsonb e depois para qualquer render de ficha/PDF. O ponto mais grave é de confiança: a equipe acredita que a assinatura está validada — existe um spec inteiro afirmando isso (ver SGS-EPI-TEST-010).

**Causa raiz** — `@IsObject()` foi usado como se fosse validação estrutural. É apenas `typeof === 'object'`. O erro passou porque `epi-assignments-hardening.spec.ts` L200-219 valida `EpiSignatureInputDto` DIRETAMENTE via `plainToInstance(EpiSignatureInputDto, {...})`, um caminho que a aplicação nunca percorre — em produção o pipe valida `CreateEpiAssignmentDto`, e é ali que a recursão não acontece.

**Correção recomendada**

Nos dois DTOs:
```ts
import { Type } from 'class-transformer';
import { ValidateNested, IsDefined } from 'class-validator';

// create-epi-assignment.dto.ts
@IsDefined()
@IsObject()
@ValidateNested()
@Type(() => EpiSignatureInputDto)
assinatura_entrega: EpiSignatureInputDto;

// return-epi-assignment.dto.ts — idem para assinatura_devolucao
```
Revisar de imediato o `MaxLength(400_000)`: 400 KB de base64 ainda é grande para um traço de assinatura; um PNG/SVG de assinatura cabe em ~64 KB. Adicionar também `@IsIn(['drawn','typed','uploaded'])` em `signature_type` em vez de string livre de 80 chars. Por defesa em profundidade, validar em `EpiAssignmentsService.buildSignatureStamp` que `input?.signature_data` é string não vazia antes de chamar `issueFromRaw`, lançando `BadRequestException`.

**Teste de regressão** — Em `epi-assignments-hardening.spec.ts`, substituir os testes que validam `EpiSignatureInputDto` isolado por testes que validam o DTO DE ENTRADA REAL: `validate(plainToInstance(CreateEpiAssignmentDto, { epi_id, user_id, assinatura_entrega: { signature_data: 'x'.repeat(400_001), signature_type: 'drawn' } }), { whitelist: true, forbidNonWhitelisted: true })` deve retornar erro em `assinatura_entrega`. Somar: (a) `assinatura_entrega: {}` → erro; (b) `assinatura_entrega: { signature_data:'d', signature_type:'drawn', campo_extra: 1 }` → erro por `forbidNonWhitelisted`; (c) o mesmo trio para `ReturnEpiAssignmentDto`. Adicionar teste genérico que percorre todos os DTOs do módulo e falha se algum campo tipado como classe tiver `@IsObject()` sem `@ValidateNested()`.

---

### 🟠 SGS-EPI-SEC-003 — Qualquer Operador/Colaborador devolve a ficha de EPI de outro trabalhador, e o sistema carimba a assinatura como sendo do outro trabalhador

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Security |
| **Local** | `backend/src/modules/epi-assignments/epi-assignments.service.ts:225` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O controller libera a devolução para o perfil Colaborador:
```ts
// epi-assignments.controller.ts L144-159
@Post(':id/return')
@Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR, Role.COLABORADOR)
@Authorize('can_manage_epi_assignments')
returnAssignment(@Param('id', new ParseUUIDPipe()) id, @Body() dto, @Req() req) {
  return this.assignmentsService.returnAssignment(id, dto, req.user?.id);
}
```
E o perfil 'Operador / Colaborador' realmente possui a permissão (`1709000000103-fix-rbac-role-permissions-and-dids-rls.ts` L224: `'can_view_epi_assignments', 'can_manage_epi_assignments'` dentro do bloco `WHERE r.name = 'Operador / Colaborador'`). `Role.COLABORADOR = 'Operador / Colaborador'` (`src/modules/auth/enums/roles.enum.ts`).

No serviço, `returnAssignment` carrega a ficha por `findOne(id)` — que só filtra `company_id` e, para usuários site-scoped, `site_id` (L170-185) — e NUNCA compara o ator com o dono da ficha:
```ts
// epi-assignments.service.ts L213-228
async returnAssignment(id: string, dto: ReturnEpiAssignmentDto, actorId?: string) {
  const assignment = await this.findOne(id);
  if (assignment.status !== 'entregue') { throw new BadRequestException(...); }
  const assinaturaDevolucao = this.buildSignatureStamp(
    dto.assinatura_devolucao,
    assignment.user_id,          // <-- signer_user_id = dono da ficha, NÃO o ator
  );
```
`actorId` só é usado em `assignment.updated_by_id = actorId` (L235). O `signer_user_id` gravado no jsonb é `assignment.user_id` (`buildSignatureStamp` L321-337: `signer_user_id: signerUserId`), e `signer_name` vem cru do corpo da requisição.

Reprodução: Colaborador C1 (obra A) autentica, chama `GET /epi-assignments` e lê o `id` da ficha do colega C2 na mesma obra; chama `POST /epi-assignments/{id}/return` com `{ "assinatura_devolucao": { "signature_data": "<qualquer traço>", "signature_type": "drawn", "signer_name": "C2" } }`. Resultado: 200, ficha de C2 vai para `devolvido`, com `assinatura_devolucao.signer_user_id = <uuid de C2>` e carimbo de tempo HMAC válido emitido pelo próprio sistema. O mesmo vale para `create()` L79-82, que carimba `signer_user_id: user.id` (o destinatário) enquanto quem assina a requisição é o TST/Supervisor.

**Impacto** — A ficha de EPI é a prova que o empregador apresenta em fiscalização do MTE e em juízo de que o EPI foi entregue e devolvido (NR-6 item 6.6.1 'h'). O sistema produz, sob demanda de terceiro e sem nenhuma prova de identidade do signatário, um registro que afirma que o trabalhador assinou — com hash SHA-256 e timestamp token HMAC que dão aparência de autenticidade forte. Isso é repúdio garantido do documento (o trabalhador contesta e o sistema não tem como provar) e, no sentido inverso, permite a um colega encerrar indevidamente o vínculo de responsabilidade de outro sobre um EPI. Existe infraestrutura no projeto para resolver isso e ela não é usada: `users.signature_pin_hash`/`signature_pin_salt` (migration 1709000000050, e a coluna aparece na anonimização da 345).

**Causa raiz** — O modelo de assinatura do módulo confunde 'quem operou o endpoint' com 'quem assinou'. `buildSignatureStamp` recebe `signerUserId` do registro, não do contexto autenticado, e nenhuma camada exige comprovação de identidade do signatário (PIN, sessão do próprio titular, ou token de convite como o de DDS em `dds_signature_invites`). O `@Roles(..., Role.COLABORADOR)` foi adicionado presumindo que 'colaborador devolve o próprio EPI', mas a checagem de propriedade nunca foi escrita.

**Correção recomendada**

Duas correções, ambas necessárias:

1) Ownership no `returnAssignment`:
```ts
const scope = this.getSiteAccessScopeOrThrow();
const isPrivileged = scope.hasCompanyWideAccess ||
  [Role.TST, Role.SUPERVISOR].includes(scope.profileName as Role);
if (!isPrivileged && assignment.user_id !== scope.userId) {
  throw new ForbiddenException('Você só pode devolver EPIs atribuídos a você.');
}
```

2) Honestidade do carimbo: `signer_user_id` deve ser o ator autenticado, e um campo separado deve registrar em nome de quem se assinou:
```ts
return {
  signer_user_id: actorUserId,          // quem realmente estava autenticado
  signed_on_behalf_of_user_id: assignment.user_id,
  signature_method: pinVerified ? 'pin' : 'operator_witnessed',
  ...
};
```
Quando `signer_user_id !== signed_on_behalf_of_user_id`, exigir verificação do PIN de assinatura do titular (`PasswordService`/`signature_pin_hash`) ou marcar explicitamente o documento como 'assinado presencialmente perante o operador X', e refletir isso no PDF/ficha para que ninguém apresente o registro como assinatura do trabalhador.

**Teste de regressão** — Em `epi-assignments.service.spec.ts`: (1) contexto de Colaborador `userId='c1'`, ficha com `user_id='c2'` → `returnAssignment` deve rejeitar com `ForbiddenException`; (2) mesmo contexto com `user_id='c1'` → deve passar; (3) contexto de TST devolvendo ficha de 'c2' → deve passar, mas afirmar `saved.assinatura_devolucao.signer_user_id === '<uuid do TST>'` e `signed_on_behalf_of_user_id === 'c2'` (o teste falha hoje, pois grava `'c2'` em `signer_user_id`); (4) teste equivalente para `create()`, afirmando que `assinatura_entrega.signer_user_id` é o ator e não `dto.user_id`. Somar E2E: colaborador autenticado tentando `POST /epi-assignments/{id-de-outro}/return` → 403.

---

### 🟠 SGS-EPI-INT-004 — Assinatura não está amarrada ao conteúdo da ficha: o hash cobre só o traço, e quantidade/observações continuam editáveis depois de assinada (inclusive em ficha já 'substituido')

| | |
|---|---|
| **Severidade** | HIGH |
| **Categoria** | Integrity |
| **Local** | `backend/src/modules/epi-assignments/epi-assignments.service.ts:187` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

O hash e o timestamp token cobrem exclusivamente o desenho da assinatura:
```ts
// epi-assignments.service.ts L321-337
private buildSignatureStamp(input: EpiSignatureInputDto, signerUserId?: string) {
  const generated = this.signatureTimestampService.issueFromRaw(input.signature_data);
```
```ts
// shared/services/signature-timestamp.service.ts L18-21
issueFromRaw(rawPayload: string): TimestampStamp {
  const signatureHash = createHash('sha256').update(rawPayload).digest('hex');
```
Nada de `epi_id`, `user_id`, `quantidade`, `ca`, `validade_ca`, `entregue_em` ou `site_id` entra no digest. E o update pós-assinatura só barra o estado terminal `devolvido`:
```ts
// epi-assignments.service.ts L187-204
async update(id, dto, actorId) {
  const assignment = await this.findOne(id);
  if (assignment.status === 'devolvido') { throw new BadRequestException('Ficha já devolvida...'); }
  Object.assign(assignment, { ...dto, updated_by_id: actorId });
  const saved = await this.assignmentsRepository.save(assignment);
```
Reprodução: `POST /epi-assignments` com `quantidade: 1` e assinatura do trabalhador → 201. Em seguida `PATCH /epi-assignments/{id}` com `{"quantidade": 10000}` → 200. A ficha agora afirma que o trabalhador assinou o recebimento de 10.000 unidades, e `assinatura_entrega.signature_hash` / `timestamp_token` seguem verificando com sucesso via `SignatureTimestampService.verify()`, porque o hash nunca dependeu de `quantidade`. Idem para `observacoes` (que é justamente onde `replaceAssignment` L259-264 acumula texto que descreve o motivo da substituição).

Segundo caminho, mais sutil: uma ficha em `substituido` continua editável para sempre, porque L193 compara apenas com `'devolvido'` — `replaceAssignment` L258 grava `'substituido'` e nenhum guard cobre esse estado.

**Impacto** — O documento probatório de entrega de EPI é adulterável após a assinatura, sem deixar rastro no próprio artefato assinado. Como o sistema exibe hash SHA-256 + `timestamp_token` HMAC + `timestamp_authority: 'internal-hmac-v1'`, a ficha se apresenta como íntegra enquanto seu conteúdo mudou. Em disputa trabalhista sobre entrega de EPI, isso destrói o valor probatório de TODAS as fichas do sistema, não só da adulterada — basta a defesa demonstrar que o mecanismo permite a alteração. Diferentemente do APR (migration 1709000000375 `add-apr-signature-content-integrity`) e do PT (migration 1709000000344 `add-pt-final-pdf-hash`), que já amarram assinatura a hash de conteúdo, o módulo de EPI ficou para trás.

**Causa raiz** — `SignatureTimestampService.issueFromRaw` recebe apenas a imagem da assinatura porque foi projetado como carimbo de tempo do traço, não como selo de conteúdo. Ninguém adicionou o passo de canonicalizar o estado da ficha e incluí-lo no digest, e o guard de imutabilidade foi escrito olhando um único estado terminal (`devolvido`) em vez de 'existe assinatura de entrega'.

**Correção recomendada**

1) Amarrar a assinatura ao conteúdo, canonicalizando os campos materiais:
```ts
private buildContentDigest(a: Pick<EpiAssignment,'company_id'|'epi_id'|'user_id'|'site_id'|'ca'|'validade_ca'|'quantidade'|'entregue_em'>): string {
  const canonical = JSON.stringify({
    company_id: a.company_id, epi_id: a.epi_id, user_id: a.user_id,
    site_id: a.site_id ?? null, ca: a.ca ?? null,
    validade_ca: a.validade_ca ? new Date(a.validade_ca).toISOString().slice(0,10) : null,
    quantidade: a.quantidade,
    entregue_em: new Date(a.entregue_em).toISOString(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
// e assinar sobre `${contentDigest}.${input.signature_data}` via issueFromRaw,
// persistindo content_digest dentro do stamp.
```
2) Trocar o guard de `update()` por imutabilidade baseada em assinatura, não em estado:
```ts
if (assignment.assinatura_entrega) {
  const mutaCampoMaterial = dto.quantidade !== undefined && dto.quantidade !== assignment.quantidade;
  if (mutaCampoMaterial) {
    throw new BadRequestException('Ficha assinada: quantidade é imutável. Cancele e emita nova ficha.');
  }
}
if (assignment.status !== 'entregue') {
  throw new BadRequestException(`Ficha em estado ${assignment.status} não é editável.`);
}
```
(`observacoes` pode continuar mutável se for append-only com autoria e timestamp; se puder ser sobrescrita, deve entrar no digest também.)
3) Migration adicionando `CHECK (status IN ('entregue','devolvido','substituido'))` e `CHECK (devolvido_em IS NULL OR devolvido_em >= entregue_em)` em `epi_assignments`.

**Teste de regressão** — Em `epi-assignments.service.spec.ts`: (1) criar ficha assinada com `quantidade=1`, capturar `assinatura_entrega.content_digest`; chamar `update(id,{quantidade:5})` → deve lançar `BadRequestException` (hoje passa e devolve 200); (2) ficha com `status='substituido'` → `update()` deve lançar (hoje é permitido); (3) teste de integridade: montar stamp com `buildContentDigest`, alterar `quantidade` no objeto e afirmar que `buildContentDigest` recalculado DIFERE do gravado — provando que a adulteração é detectável; (4) teste de `SignatureTimestampService.verify(content_digest + signature_data, timestamp_token)` retornando false após mutação simulada da linha no banco.

---

### 🟡 SGS-EPI-CONC-005 — Devolução e substituição são read-modify-write sem lock nem coluna de versão: duas devoluções simultâneas passam ambas, e uma devolução pode sobrescrever uma substituição

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Concurrency |
| **Local** | `backend/src/modules/epi-assignments/epi-assignments.service.ts:213` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

```ts
// L213-237 returnAssignment
const assignment = await this.findOne(id);              // SELECT simples, sem FOR UPDATE
if (assignment.status !== 'entregue') { throw ... }      // checagem em memória
...
assignment.status = 'devolvido';
assignment.devolvido_em = new Date();
const saved = await this.assignmentsRepository.save(assignment);  // UPDATE por PK, sem WHERE de estado
```
```ts
// L246-267 replaceAssignment — mesmo padrão
const assignment = await this.findOne(id);
if (assignment.status !== 'entregue') { throw ... }
assignment.status = 'substituido';
```
`findOne` (L170-185) usa `assignmentsRepository.findOne({ where: {...} })` — nenhum `lock: { mode: 'pessimistic_write' }`. A entidade `EpiAssignment` (`entities/epi-assignment.entity.ts`) não tem `@VersionColumn` — as colunas são id, company_id, epi_id, user_id, site_id, ca, validade_ca, quantidade, status, entregue_em, devolvido_em, motivo_devolucao, observacoes, assinatura_entrega, assinatura_devolucao, created_by_id, updated_by_id, created_at, updated_at, deleted_at. E não há CHECK/estado no banco que reprove a segunda escrita (grep por `epi_assignments` em `1709000000202-add-check-constraints-status-columns.ts` e `1709000000310-add-missing-check-constraints.ts` não retorna nada).

Reprodução: disparar dois `POST /epi-assignments/{id}/return` em paralelo (dois cliques do usuário, ou retry automático do frontend). T1 e T2 leem `status='entregue'`; ambos passam o guard; ambos executam `UPDATE ... SET status='devolvido', devolvido_em=..., assinatura_devolucao=... WHERE id=$1`. Ambos retornam 200. A `assinatura_devolucao` e o `motivo_devolucao` do primeiro são sobrescritos pelo segundo, e `writeAuditLog` (L347-363) grava DOIS eventos `epi_assignment_returned` para a mesma ficha. O mesmo vale para `return` concorrente com `replace`: a ficha pode acabar `devolvido` com o texto de substituição já concatenado em `observacoes`, ou `substituido` tendo perdido a assinatura de devolução recém-gravada.

**Impacto** — Perda silenciosa da assinatura de devolução legítima (sobrescrita pela segunda requisição), trilha de auditoria inconsistente com dois eventos de devolução para uma ficha que só pode ser devolvida uma vez, e estado final não determinístico entre devolvido/substituído. Em um módulo cujo output é prova documental, 'quem assinou a devolução' passa a depender de ordem de chegada de rede. É exatamente o mesmo padrão já corrigido em PT, RDO, Checklist e NC neste repositório (locks `FOR UPDATE NOWAIT` com 409), e que aqui ficou sem correção.

**Causa raiz** — O guard de transição foi implementado em JavaScript sobre um snapshot lido fora de transação, e o `save()` do TypeORM gera `UPDATE ... WHERE id = $1` sem condicionar ao estado observado. Não existe transação envolvendo leitura + escrita + audit log, nem versão otimista, nem constraint de banco que sirva de última linha de defesa.

**Correção recomendada**

Envolver a transição em transação com lock pessimista e devolver 409 em conflito, seguindo o padrão já usado nos outros módulos:
```ts
async returnAssignment(id: string, dto: ReturnEpiAssignmentDto, actorId?: string) {
  const scope = this.getSiteAccessScopeOrThrow();
  return this.assignmentsRepository.manager.transaction(async (trx) => {
    let assignment: EpiAssignment | null;
    try {
      assignment = await trx.getRepository(EpiAssignment).findOne({
        where: { id, company_id: scope.companyId,
                 ...(!scope.hasCompanyWideAccess ? { site_id: scope.siteId } : {}) },
        lock: { mode: 'pessimistic_write', onLocked: 'nowait' },
      });
    } catch (e) {
      throw new ConflictException('Ficha em processamento por outra operação. Tente novamente.');
    }
    if (!assignment) throw new NotFoundException(...);
    if (assignment.status !== 'entregue') throw new BadRequestException(...);
    // ...mutação + save(trx) + audit log DENTRO da mesma transação
  });
}
```
Aplicar o mesmo em `replaceAssignment` e `update`. Complementar com a migration de CHECK do achado SGS-EPI-INT-004 e, opcionalmente, `@VersionColumn` para conflito otimista direcional.

**Teste de regressão** — Teste de integração com Postgres real em `backend/test/e2e/epi-assignments-concurrency.e2e-spec.ts`: `await Promise.allSettled([service.returnAssignment(id, dtoA, 'u1'), service.returnAssignment(id, dtoB, 'u2')])` e afirmar que exatamente 1 resolve e 1 rejeita com `ConflictException` ou `BadRequestException`; afirmar `SELECT COUNT(*) FROM audit_logs WHERE entity='EPI_ASSIGNMENT' AND entity_id=$id AND changes->>'event'='epi_assignment_returned'` = 1. Repetir para `return` vs `replace` concorrentes, afirmando que o estado final é um dos dois e que o outro recebeu erro.

---

### 🟡 SGS-EPI-BR-006 — É possível entregar EPI com CA vencido e EPI desativado no catálogo — o sistema copia a validade e só contabiliza o vencimento depois, no resumo

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | BusinessRule |
| **Local** | `backend/src/modules/epi-assignments/epi-assignments.service.ts:61` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

```ts
// epi-assignments.service.ts L61-98 — create()
const [epi, user] = await Promise.all([
  this.episRepository.findOne({ where: { id: dto.epi_id, company_id: companyId } }),
  this.usersRepository.findOne({ where: { id: dto.user_id, company_id: companyId } }),
]);
if (!epi) { throw new NotFoundException('EPI não encontrado para esta empresa.'); }
if (!user) { throw new NotFoundException('Colaborador não encontrado para esta empresa.'); }
...
const assignment = this.assignmentsRepository.create({
  ...
  ca: epi.ca,
  validade_ca: epi.validade_ca,      // snapshot copiado, NUNCA comparado com hoje
  quantidade: dto.quantidade || 1,
  status: 'entregue',
  entregue_em: new Date(),
```
Entre a linha 70 e a 100 não existe nenhuma comparação de `epi.validade_ca` com a data corrente, nem checagem de `epi.status` (o campo existe: `entities/epi.entity.ts` L28-29 `@Column({ default: true }) status: boolean`).

Que o sistema SABE que isso é um problema fica provado pelo próprio módulo, que mede o estrago depois do fato:
```ts
// epi-assignments.service.ts L298-310 — getSummary()
const caExpiradoQuery = this.assignmentsRepository.createQueryBuilder('assignment')
  .andWhere("assignment.status = 'entregue'")
  .andWhere('assignment.validade_ca IS NOT NULL')
  .andWhere('assignment.validade_ca < :now', { now });
```
e por `EpisService.findCaExpirySummary` (`epis.service.ts` L131-185), que classifica EPIs em `expired` / `expiringSoon`.

Reprodução: cadastrar EPI com `validade_ca: '2020-01-01'` (ou desativá-lo com `status: false` via `PATCH /epis/{id}`), depois `POST /epi-assignments` com esse `epi_id` → 201, ficha criada normalmente, e a mesma ficha aparece imediatamente no contador `caExpirado` de `GET /epi-assignments/summary`.

**Impacto** — O CA (Certificado de Aprovação) vencido significa que o EPI perdeu a aprovação do MTE; entregá-lo é o mesmo que não entregar EPI para fins da NR-6 (item 6.6.1 'a' — fornecer EPI adequado e com CA). O sistema não só permite como emite a ficha assinada, produzindo prova documental de uma entrega irregular — o registro passa a ser evidência CONTRA o empregador em fiscalização. Entregar EPI desativado no catálogo (`status=false`) tem o mesmo efeito operacional: itens retirados de linha continuam sendo distribuídos.

**Causa raiz** — O módulo tratou `validade_ca` como metadado de relatório (existem três agregações que a leem) e nunca como regra de entrada na entrega. A validação de negócio foi implementada no lado do dashboard em vez do lado da escrita.

**Correção recomendada**

Em `create()`, após carregar o EPI:
```ts
if (epi.status === false) {
  throw new BadRequestException('EPI inativo no catálogo não pode ser entregue.');
}
if (epi.validade_ca) {
  const validade = new Date(epi.validade_ca);
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  if (!Number.isNaN(validade.getTime()) && validade < hoje) {
    throw new BadRequestException(
      `CA ${epi.ca ?? ''} vencido em ${validade.toISOString().slice(0,10)}. Atualize o CA antes de entregar (NR-6).`,
    );
  }
}
```
Se a operação exigir exceção documentada (entrega emergencial), torná-la explícita e auditável: campo `justificativa_ca_vencido` obrigatório no DTO, permissão dedicada, e registro no audit log com `event: 'epi_assignment_delivered_with_expired_ca'` — nunca um caminho silencioso.

**Teste de regressão** — Em `epi-assignments.service.spec.ts`: (1) `episRepository.findOne` devolvendo `{ id:'epi-1', ca:'CA-001', validade_ca: '2020-01-01', status: true }` → `create()` deve rejeitar com `BadRequestException` contendo 'vencido' (hoje resolve com 201); (2) `validade_ca` de amanhã → deve passar; (3) `validade_ca: null` → deve passar (EPI sem CA registrado); (4) `status: false` → deve rejeitar; (5) teste de fronteira com `validade_ca` = hoje → deve passar (vence no fim do dia).

---

### 🟡 SGS-EPI-BR-007 — Não existe controle de estoque de EPI: a entidade não tem saldo, a entrega não decrementa nada e não há como saber quanto foi consumido

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | BusinessRule |
| **Local** | `backend/src/modules/epis/entities/epi.entity.ts:12` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

A entidade `Epi` inteira tem 6 campos de negócio e nenhum de saldo:
```ts
// backend/src/modules/epis/entities/epi.entity.ts L11-37
@Entity('epis')
export class Epi extends BaseAuditEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() nome: string;
  @Column({ nullable: true }) ca: string;
  @Column({ type: 'date', nullable: true }) validade_ca: Date;
  @Column({ type: 'text', nullable: true }) descricao: string;
  @Column({ default: true }) status: boolean;
  @ManyToOne(() => Company) company: Company;
  @Column() company_id: string;
}
```
`grep -rni "estoque|stock|saldo" backend/src/modules/epis backend/src/modules/epi-assignments` retorna ZERO ocorrências. `EpiAssignment.quantidade` (`entities/epi-assignment.entity.ts` L72-73) é gravada na ficha e nunca é confrontada com nada: `EpiAssignmentsService.create()` (L84-100) faz um único `create` + `save` sem tocar em `episRepository`, que é injetado apenas para o `findOne` de validação (L62-64).

Reprodução: `POST /epi-assignments` com `{ quantidade: 10000 }` (o máximo permitido pelo DTO) para o mesmo `epi_id`, quantas vezes se quiser → todas retornam 201. Não há como o sistema responder 'quantas luvas CA-12345 ainda existem no almoxarifado' nem 'este EPI já foi distribuído além do comprado'.

**Impacto** — Lacuna de regra de negócio, não vulnerabilidade: o produto se apresenta como gestão de EPI mas não fecha o ciclo compra→estoque→entrega→devolução. Consequências práticas: (a) impossível detectar entrega fantasma (ficha assinada de EPI que nunca existiu fisicamente), que é justamente a fraude que o registro documental deveria coibir; (b) impossível conciliar consumo com nota fiscal/despesa (o módulo Expenses existe e não conversa com EPI); (c) `quantidade` até 10.000 por ficha sem qualquer contraparte física é aceito. Registro como MEDIUM por ser ausência de controle, não quebra do que existe — mas é o achado que o item (a) do escopo pediu explicitamente para reportar caso não houvesse estoque.

**Causa raiz** — O domínio foi modelado como 'ficha de entrega' (documento) e não como 'movimentação de estoque'. `quantidade` foi adicionada à ficha para preencher o papel, sem a contraparte de saldo. Nenhuma migration cria tabela de movimentação (`grep -l epi *.ts` nas migrations retorna apenas as 12 já citadas, nenhuma de estoque).

**Correção recomendada**

Decisão de produto antes de código. Se estoque entra no escopo, o desenho mínimo seguro é event-sourced (nunca um contador mutável, que traz de volta o read-modify-write do achado SGS-EPI-CONC-005):

```sql
CREATE TABLE epi_stock_movements (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES companies(id),
  site_id uuid REFERENCES sites(id),
  epi_id uuid NOT NULL REFERENCES epis(id),
  tipo varchar NOT NULL CHECK (tipo IN ('entrada','saida','devolucao','ajuste','descarte')),
  quantidade integer NOT NULL CHECK (quantidade > 0),
  epi_assignment_id uuid REFERENCES epi_assignments(id),
  motivo text, created_by_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
```
Com RLS igual às demais (a policy site-scoped da migration 367 pega automaticamente por ter company_id+site_id). O saldo vira `SUM(CASE WHEN tipo IN ('entrada','devolucao') THEN quantidade ELSE -quantidade END)`. `EpiAssignmentsService.create()` passa a rodar em transação: `SELECT ... FOR UPDATE` sobre o agregado do par (epi_id, site_id), rejeitar com 409 se saldo < quantidade, inserir movimento 'saida' + ficha atomicamente. `returnAssignment` insere 'devolucao'. Se estoque NÃO entra no escopo, remover `quantidade` do DTO ou documentá-la explicitamente como 'quantidade declarada, sem lastro de estoque' na API e na UI, para não induzir o cliente a achar que há controle.

**Teste de regressão** — Depois de implementado: (1) saldo 5, `create({quantidade: 6})` → 409 e nenhuma ficha persistida; (2) saldo 5, duas chamadas concorrentes de `quantidade: 3` → uma 201 e uma 409, e `SUM` final = 2 (nunca negativo); (3) `returnAssignment` de ficha com `quantidade: 3` → saldo volta a 5; (4) devolução dupla não credita duas vezes (depende do fix de SGS-EPI-CONC-005). Enquanto não houver estoque, teste de contrato afirmando que a resposta de `GET /epi-assignments/summary` não expõe campo algum que sugira saldo.

---

### 🟡 SGS-EPI-SEC-008 — site_id não é validado contra a empresa quando o ator tem acesso company-wide, e user_id não é validado contra o escopo de obra do ator

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Security |
| **Local** | `backend/src/modules/epi-assignments/epi-assignments.service.ts:53` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

```ts
// epi-assignments.service.ts L51-60
const scope = this.getSiteAccessScopeOrThrow();
const companyId = scope.companyId;
const effectiveSiteId = !scope.hasCompanyWideAccess
  ? (dto.site_id ?? scope.siteId)
  : dto.site_id;                       // <-- caminho company-wide: passa cru
if (!scope.hasCompanyWideAccess && effectiveSiteId !== scope.siteId) {
  throw new BadRequestException('Ficha EPI deve ser lançada na obra atual.');
}
```
A validação de pertencimento existe SÓ para usuários site-scoped. Para ADMIN_EMPRESA/ADMIN_GERAL (`hasCompanyWideAccess === true` via `isCompanyWideProfile`, `shared/tenant/site-access-scope.util.ts` L21-23/L42), `dto.site_id` vai direto para o insert (L88 `site_id: effectiveSiteId`) sem nenhum `SELECT` em `sites` conferindo `company_id`. O serviço sequer injeta o repositório de `Site` — o construtor (L35-45) recebe apenas `assignmentsRepository`, `episRepository`, `usersRepository`, `tenantService`, `signatureTimestampService`, `auditService`. Compare com `epi_id` e `user_id`, que SÃO validados por empresa (L62-67 `where: { id, company_id: companyId }`).

A FK `FK_epi_assignments_site_id` (migration 1709000000017 L88-100) só exige que o UUID exista em `sites`, não que seja da mesma empresa. A policy RLS de `epi_assignments` (site_scope_isolation_policy, migrations 127 L69-93 e 367) checa `company_id = current_company() AND (current_site_scope() = 'all' OR site_id = ANY(current_site_ids()))` — com `siteScope='all'` para company-wide, o ramo do `site_id` não restringe nada. Ou seja: nem app nem banco barram.

Segundo furo, no mesmo bloco: `usersRepository.findOne({ where: { id: dto.user_id, company_id: companyId } })` (L65-67) valida empresa mas NÃO obra. Um TST restrito à obra A cria ficha com `user_id` de um trabalhador da obra B; o `effectiveSiteId` vira A (fallback L54) e a ficha nasce dizendo que o trabalhador da obra B recebeu EPI na obra A.

Reprodução (furo 1): autenticado como ADMIN_EMPRESA da empresa X, `POST /epi-assignments` com `site_id` = UUID de uma obra da empresa Y → 201. `SELECT company_id, site_id FROM epi_assignments WHERE id=$novo` mostra `company_id` de X e `site_id` de Y.

**Impacto** — Referência cruzada entre tenants persistida em tabela de documento SST: a linha aponta para uma obra de outra empresa. O `leftJoinAndSelect('assignment.site','site')` de `findPaginated` (L141) devolve `site: null` para essa ficha porque a RLS de `sites` esconde a obra alheia — resultado é uma ficha permanentemente órfã de obra, invisível para usuários site-scoped (a policy RESTRICTIVE exige `site_id = ANY(current_site_ids())`) e não conciliável em auditoria. É corrupção de integridade referencial multi-tenant, não leitura cross-tenant (nenhum dado da empresa Y vaza). O segundo furo produz fichas que atribuem entrega de EPI em obra errada, degradando o valor probatório do registro por obra.

**Causa raiz** — A checagem de escopo foi escrita como 'usuário restrito não pode escapar da sua obra' e assumiu que quem tem acesso company-wide não erra nem mente. Não existe a checagem simétrica 'a obra informada pertence à minha empresa', que é justamente a que o padrão do próprio módulo aplica a `epi_id` e `user_id`.

**Correção recomendada**

Injetar o repositório de `Site` e validar sempre que `dto.site_id` vier no payload:
```ts
if (dto.site_id) {
  const site = await this.sitesRepository.findOne({
    where: { id: dto.site_id, company_id: companyId },
  });
  if (!site) {
    throw new NotFoundException('Obra não encontrada para esta empresa.');
  }
}
```
(colocar ANTES do `if (!scope.hasCompanyWideAccess ...)`, para valer nos dois caminhos). Para o segundo furo, validar o vínculo do colaborador com a obra efetiva:
```ts
if (effectiveSiteId && user.site_id && user.site_id !== effectiveSiteId) {
  const vinculado = await this.userSitesRepository.exist({
    where: { user_id: user.id, site_id: effectiveSiteId },
  });
  if (!vinculado) {
    throw new BadRequestException('Colaborador não está vinculado à obra da ficha.');
  }
}
```
(a tabela `user_sites` existe desde a migration 1709000000336). Reforço no banco: `CHECK`/trigger ou FK composta `(company_id, site_id) REFERENCES sites(company_id, id)` — exige UNIQUE em `sites(company_id, id)`, que é barato e fecha a porta para sempre.

**Teste de regressão** — Em `epi-assignments.service.spec.ts`: (1) contexto ADMIN_EMPRESA de 'company-1' com `sitesRepository.findOne` devolvendo null para `site_id: 'site-de-outra-empresa'` → `create()` deve lançar `NotFoundException` (hoje resolve 201); (2) mesmo contexto com site válido da empresa → passa e grava o `site_id`; (3) TST site-scoped em 'site-a' criando ficha para user cujo `site_id='site-b'` e sem linha em `user_sites` → deve lançar `BadRequestException`. Somar teste de integração contra Postgres afirmando que o INSERT com `(company_id de X, site_id de Y)` é rejeitado pela constraint composta.

---

### 🟡 SGS-EPI-TEST-010 — O spec de hardening dá falsa garantia: testa migrations com readFileSync+toContain e valida uma classe de assinatura que a aplicação nunca valida — os dois achados mais graves passam verdes

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Testing |
| **Local** | `backend/src/modules/epi-assignments/epi-assignments-hardening.spec.ts:298` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Os testes de LGPD e RLS não tocam banco nenhum; leem o arquivo-fonte e procuram substrings:
```ts
// L298-341
describe('Migration 1709000000314 — epi_assignments LGPD erasure', () => {
  beforeAll(() => {
    const file = path.join(MIGRATIONS_DIR, '1709000000314-epi-assignments-gdpr-erasure.ts');
    content = fs.readFileSync(file, 'utf8');
  });
  it('inclui epi_assignments na função gdpr_delete_user_data', () => {
    expect(content).toContain("'epi_assignments'::text");
    expect(content).toContain('UPDATE epi_assignments');
  });
  it('nulifica user_id e aplica soft-delete', () => {
    expect(content).toContain('user_id = NULL');
```
Esses testes passam hoje e continuarão passando para sempre, porque o arquivo 314 nunca mudou — enquanto a função REAL no banco não cobre `epi_assignments` desde a migration 345 (achado SGS-EPI-PRIV-001), e o `user_id = NULL` que o teste celebra violaria o `NOT NULL` da coluna se algum dia rodasse. O mesmo vale para o bloco de RLS:
```ts
// L345-372
it('adiciona cláusula WITH CHECK à política de epis', () => {
  expect(content).toContain('WITH CHECK');
});
```
que não verifica se a policy está aplicada, se cobre INSERT/UPDATE/DELETE, nem se sobreviveu a migrations posteriores.

E o bloco que deveria cobrir a validação da assinatura valida a classe aninhada isoladamente, por um caminho que o ValidationPipe nunca percorre:
```ts
// L200-219
describe('EpiSignatureInputDto — achado M2', () => {
  it('rejeita signature_data acima de 400_000 caracteres', async () => {
    const dto = plainToInstance(EpiSignatureInputDto, { signature_data: 'x'.repeat(400_001), ... });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'signature_data')).toBe(true);
```
Em produção o pipe valida `CreateEpiAssignmentDto`, e ali a recursão não acontece (provado em SGS-EPI-SEC-002: zero erros com 1.000.000 de caracteres). O teste M2 de `CreateEpiAssignmentDto` (L164-198) só exercita campos de PRIMEIRO nível (`quantidade`, `observacoes`) — nunca o aninhado.

O teste `makeService` também mocka o que deveria provar: `signatureTimestampService.issueFromRaw` é `jest.fn().mockReturnValue({ signature_hash: 'hash', ... })` (L77-83), então nenhum teste do arquivo observa o que realmente entra no digest — que é a raiz do achado SGS-EPI-INT-004.

**Impacto** — O módulo aparenta estar auditado e endurecido (373 linhas de spec com nomes de achados M1/M2/Q1/A1/B1), enquanto os três defeitos mais graves — LGPD morta, validação de assinatura inoperante, assinatura desamarrada do conteúdo — passam no CI. Pior que não ter teste: a próxima pessoa que ler este arquivo vai concluir que a área já foi coberta e não vai olhar. É o mesmo mecanismo já registrado no histórico do projeto ('o CI não valida nada há semanas').

**Causa raiz** — Testes escritos para provar que uma correção foi ESCRITA, não que ela FUNCIONA. Assertion sobre texto de arquivo é imune tanto a regressão por migration posterior quanto a erro semântico de SQL; validação de DTO aninhado testada fora do caminho real é imune ao bug de `@ValidateNested` ausente.

**Correção recomendada**

1) Substituir os describes de migration por E2E contra Postgres real (o repo já tem `docker-compose.test.yml` com PG 16): executar `SELECT * FROM gdpr_delete_user_data($id)` e inspecionar o efeito nas linhas, e consultar `pg_policies`/`pg_class.relforcerowsecurity` para afirmar a policy efetiva de `epis` e `epi_assignments` (nome, `qual`, `with_check`, `cmd='ALL'`, FORCE ativo).
2) Trocar os testes de `EpiSignatureInputDto` isolado por testes do DTO de entrada real (ver regressionTest de SGS-EPI-SEC-002).
3) Não mockar `SignatureTimestampService`: instanciá-lo com um `ConfigService` de teste e afirmar sobre o digest efetivamente produzido.
4) Adicionar teste-guarda genérico que varre `backend/src/**/dto/*.ts` e falha quando um campo tipado como classe tiver `@IsObject()` sem `@ValidateNested()` — o mesmo bug quase certamente existe em outros módulos.

**Teste de regressão** — Meta-teste em `backend/test/e2e/gdpr-erasure.e2e-spec.ts` e `backend/test/e2e/rls-policies.e2e-spec.ts` que consultem o CATÁLOGO do Postgres, não arquivos: `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename IN ('epis','epi_assignments')` afirmando que toda policy tem `with_check IS NOT NULL` e `cmd='ALL'`; `SELECT relforcerowsecurity FROM pg_class WHERE relname='epi_assignments'` = true; e `SELECT prosrc FROM pg_proc WHERE proname='gdpr_delete_user_data'` contendo cada tabela de uma lista canônica versionada em código. Marcar os describes que leem `readFileSync` como proibidos via regra de lint customizada ou removê-los.

---

### 🟡 SGS-EPI-BACK-011 — Ficha é persistida antes do audit log e fora de transação: falha na auditoria devolve 500 com o documento já gravado, e sem idempotência o retry cria ficha duplicada

| | |
|---|---|
| **Severidade** | MEDIUM |
| **Categoria** | Backend |
| **Local** | `backend/src/modules/epi-assignments/epi-assignments.service.ts:100` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

```ts
// epi-assignments.service.ts L100-107
const saved = await this.assignmentsRepository.save(assignment);   // já commitou
await this.writeAuditLog(AuditAction.CREATE, saved, actorId, {     // fora da transação
  event: 'epi_assignment_delivered', companyId, epiId: saved.epi_id, userId: saved.user_id,
});
return saved;
```
```ts
// L347-363
private async writeAuditLog(action, assignment, actorId?, metadata?) {
  await this.auditService.log({
    action, entity: 'EPI_ASSIGNMENT', entityId: assignment.id,
    userId: actorId || '',            // string vazia quando actorId é undefined
    companyId: assignment.company_id, changes: metadata,
    ip: 'unknown', userAgent: 'system',
  });
}
```
E o AuditService LANÇA quando o userId é falsy:
```ts
// backend/src/modules/audit-trail/audit.service.ts L33-38
async log(data: AuditLogInput): Promise<void> {
  if (!data.userId || !data.companyId) {
    throw new InternalServerErrorException('AuditService: userId e companyId são obrigatórios');
  }
```
O controller passa `req.user?.id` (`epi-assignments.controller.ts` L57, L141, L158, L169) — encadeamento opcional. Sempre que `actorId` for `undefined` (chamada interna, worker, ou qualquer mudança futura no shape do principal), `userId: '' ` é falsy e o `log()` explode DEPOIS do `save()`: o cliente recebe 500 e a ficha está no banco.

Não há nada que impeça o duplicado: o controller não tem `@Throttle` nem interceptor de idempotência (`grep -rn "Throttle|Idempotenc" src/modules/epis src/modules/epi-assignments src/shared/base/base.controller.ts` retorna vazio), `create()` não consulta ficha equivalente já existente, e não há índice único parcial em `epi_assignments` (as únicas criações são os três índices não-únicos de company_id em `1709000000017` L33-44).

Reprodução: qualquer erro transitório na escrita de `audit_logs` (indisponibilidade, RLS, timeout) após um `POST /epi-assignments` bem-sucedido → 500 ao cliente com ficha persistida. O frontend/usuário refaz a operação → segunda ficha idêntica, com segunda assinatura, para a mesma entrega.

**Impacto** — Duas consequências que se somam: (a) inconsistência entre o documento e sua trilha — a ficha existe sem evento de auditoria correspondente, quebrando a premissa de que toda operação crítica (create/return/replace) é rastreável com ator/tenant; (b) duplicidade silenciosa de documento probatório — duas fichas assinadas para a mesma entrega, que na conciliação (e num futuro controle de estoque) contam em dobro. O mesmo padrão se repete em `returnAssignment` (L237-242) e `replaceAssignment` (L267-273), onde o 500 pós-commit induz o operador a repetir a devolução, esbarrando no race do achado SGS-EPI-CONC-005.

**Causa raiz** — Auditoria tratada como efeito colateral pós-commit em vez de parte da unidade de trabalho, combinada com um AuditService que falha ruidosamente (throw) em vez de degradar — decisão razoável para o AuditService, mas incompatível com ser chamado fora de transação depois do save. E `actorId` é opcional na assinatura do método (`actorId?: string`) enquanto o AuditService o trata como obrigatório: o contrato é contraditório e só não quebra hoje porque `req.user.id` existe (`auth-principal.service.ts` L132 `id: appUserId`).

**Correção recomendada**

1) Tornar ator obrigatório e explícito, eliminando a discrepância de contrato: `async create(dto: CreateEpiAssignmentDto, actorId: string)` e, no controller, `const actorId = req.user?.id; if (!actorId) throw new UnauthorizedException();` — falhar ANTES de escrever, não depois.
2) Envolver escrita + auditoria na mesma transação (aproveitando a transação introduzida no fix de SGS-EPI-CONC-005):
```ts
return this.assignmentsRepository.manager.transaction(async (trx) => {
  const saved = await trx.getRepository(EpiAssignment).save(assignment);
  await this.auditService.log({ ...payload, manager: trx });  // AuditService precisa aceitar manager
  return saved;
});
```
3) Idempotência na criação: aceitar header `Idempotency-Key` (a infra já existe em `src/shared/idempotency`) ou índice único parcial de janela curta, por exemplo `CREATE UNIQUE INDEX CONCURRENTLY uq_epi_assignment_dedup ON epi_assignments (company_id, epi_id, user_id, date_trunc('minute', entregue_em)) WHERE deleted_at IS NULL AND status = 'entregue'`, traduzindo a violação para 409.

**Teste de regressão** — Em `epi-assignments.service.spec.ts`: (1) `auditService.log` mockado para rejeitar → `create()` deve rejeitar E `assignmentsRepository.save` não deve ter deixado linha (com transação real em teste de integração, afirmar `SELECT COUNT(*) FROM epi_assignments` = 0); (2) `create(dto, undefined)` deve lançar antes de chamar `save` (hoje chama `save` e só depois explode no audit); (3) E2E: dois `POST /epi-assignments` idênticos com o mesmo `Idempotency-Key` → o segundo devolve o MESMO id, e `SELECT COUNT(*)` = 1.

---

### 🔵 SGS-EPI-SEC-012 — Consultas agregadas de EPI falham ABERTAS quando não há contexto de tenant (if (tenantId) em vez de exigir tenant), padrão já responsável por incidentes neste repo

| | |
|---|---|
| **Severidade** | LOW |
| **Categoria** | Security |
| **Local** | `backend/src/modules/epis/epis.service.ts:146` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Três métodos aplicam o filtro de empresa condicionalmente, e omitem o filtro quando o contexto está ausente:
```ts
// epis.service.ts L143-150 — findCaExpirySummary
const query = this.episRepository.createQueryBuilder('epi').where('epi.deleted_at IS NULL');
if (tenantId) {
  query.andWhere('epi.company_id = :tenantId', { tenantId });
}
const epis = await query.getMany();          // sem tenant => TODAS as empresas
```
```ts
// epis.service.ts L195-204 — dispatchExpiryNotifications
if (tenantId) { qb.andWhere('epi.company_id = :tenantId', { tenantId }); }
```
```ts
// epis.service.ts L122-129 — count
return this.episRepository.count({
  ...(options ?? {}),
  where: tenantId ? { ...where, company_id: tenantId } : where,
});
```
Compare com o padrão correto no mesmo arquivo: `findPaginated` L92 usa `this.getTenantId()`, que LANÇA `BadRequestException` quando não há tenant (`shared/base/base.service.ts` L27-35). E `BaseService.applyTenantFilter` (L37-47) tem o mesmo `if (!tenantId) return where;`, herdado por `findOne`/`findAll`/`update`/`remove` de todos os catálogos.

Consumidores reais dessas rotas fail-open: `src/modules/ai/sst-agent/sst-agent.tools.ts` L452 (`episService.findCaExpirySummary(dias)`), `src/infra/mail/mail.service.ts` L1855-1857 (`episService.count(...)` dentro de `buildAlertSummary`, cujo resultado vai para o e-mail de alerta de UMA empresa) e `src/modules/tasks/expiry-notifications.processor.ts` L61.

**Impacto** — Baixo hoje porque os dois consumidores de worker rodam dentro de `tenantService.run({ companyId: tenantId, ... })` (`expiry-notifications.processor.ts` L50-72) e porque a RLS falha FECHADA no banco — sem `app.current_company_id`, `current_company()` retorna NULL e a policy `company_id = current_company()` não devolve linha alguma para `sgs_app`. O risco é de defesa em profundidade: se a RLS for contornada (conexão com role privilegiada, `DATABASE_URL` com pooler, super-admin flag setada na sessão, DR/restore), esses três métodos agregam EPIs de todas as empresas e o resultado vai parar em e-mail de alerta e em resposta da Sophie. O histórico do projeto registra exatamente esse cenário (runtime conectando como `neondb_owner` com BYPASSRLS por meses).

**Causa raiz** — `if (tenantId)` foi escrito como tolerância a chamadas internas sem contexto, transformando ausência de contexto em ausência de filtro. A convenção segura já existe no mesmo `BaseService` (`getTenantId()` que lança) e não foi usada nos métodos agregados.

**Correção recomendada**

Trocar as três ocorrências por exigência de tenant, mantendo uma porta explícita e auditável para jobs globais:
```ts
async findCaExpirySummary(days = 30) {
  const tenantId = this.getTenantId();   // lança BadRequestException se ausente
  const query = this.episRepository.createQueryBuilder('epi')
    .where('epi.deleted_at IS NULL')
    .andWhere('epi.company_id = :tenantId', { tenantId });
```
Idem em `dispatchExpiryNotifications` e `count`. Se algum job realmente precisar varrer todas as empresas, que seja um método separado e nomeado (`countAcrossAllTenantsForOps()`), com log explícito. Revisar também `BaseService.applyTenantFilter` (L37-47) pelo mesmo motivo — ele propaga o fail-open para todos os catálogos que herdam de BaseService.

**Teste de regressão** — Em `epis.service.spec.ts`: com `tenantService.getTenantId` retornando `undefined`, afirmar que `findCaExpirySummary()`, `dispatchExpiryNotifications(30)` e `count()` REJEITAM com `BadRequestException` e que `createQueryBuilder`/`count` do repositório não foram chamados. Somar teste que, com tenant presente, afirma que o `andWhere('epi.company_id = :tenantId')` foi de fato aplicado (inspecionando as chamadas do query builder mock).

---

### 🔵 SGS-EPI-BACK-013 — GET /epi-assignments recebe query params crus sem DTO: user_id/epi_id não são validados como UUID e viram erro 500 do Postgres

| | |
|---|---|
| **Severidade** | LOW |
| **Categoria** | Backend |
| **Local** | `backend/src/modules/epi-assignments/epi-assignments.controller.ts:60` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

```ts
// epi-assignments.controller.ts L60-76
@Get()
@Authorize('can_view_epi_assignments')
findAll(
  @Query('page') page?: string,
  @Query('limit') limit?: string,
  @Query('status') status?: 'entregue' | 'devolvido' | 'substituido',
  @Query('user_id') userId?: string,
  @Query('epi_id') epiId?: string,
) {
  return this.assignmentsService.findPaginated({
    page: page ? Number(page) : 1, limit: limit ? Number(limit) : 20,
    status, user_id: userId, epi_id: epiId,
  });
}
```
O tipo de `status` é apenas uma anotação TypeScript — apagada em runtime, sem `@IsEnum`. Nenhum `ParseUUIDPipe` em `user_id`/`epi_id`, e nenhum DTO (compare com `GET /epi-assignments/lookups/users` L80, que usa `CatalogQueryDto`, e com `EpisController.findAll` L24, que também usa DTO). Os valores caem em `epi-assignments.service.ts` L156-165 como parâmetros vinculados:
```ts
if (filters?.user_id) { query.andWhere('assignment.user_id = :userId', { userId: filters.user_id }); }
```
Reprodução: `GET /epi-assignments?user_id=abc` → Postgres levanta `invalid input syntax for type uuid: "abc"` e o `AllExceptionsFilter` converte em 500. `GET /epi-assignments?status=qualquer-coisa` não erra, mas produz filtro silenciosamente vazio (nenhuma linha), sem indicar ao cliente que o parâmetro é inválido.

Não há injeção: os três valores são bound parameters, e paginação é sanitizada por `normalizeOffsetPagination` (`shared/utils/offset-pagination.util.ts` L27-32 trata `NaN` e negativos).

**Impacto** — Baixo — não há vazamento nem bypass. O efeito é 500 onde deveria haver 400, ruído em Sentry, e um filtro de status que aceita lixo em silêncio. Vale corrigir porque é o único endpoint de leitura do módulo sem contrato de entrada, e porque erros 500 mascaram varredura/fuzzing entre os alertas legítimos.

**Causa raiz** — O endpoint foi escrito com `@Query('x')` avulsos antes de o projeto padronizar `CatalogQueryDto`, e nunca foi migrado — os endpoints vizinhos do MESMO controller já usam DTO.

**Correção recomendada**

Criar `ListEpiAssignmentsQueryDto` e usá-lo:
```ts
export class ListEpiAssignmentsQueryDto extends CatalogQueryDto {
  @IsOptional() @IsIn(['entregue','devolvido','substituido'])
  status?: EpiAssignmentStatus;

  @IsOptional() @IsUUID()
  user_id?: string;

  @IsOptional() @IsUUID()
  epi_id?: string;
}

@Get()
@Authorize('can_view_epi_assignments')
findAll(@Query() query: ListEpiAssignmentsQueryDto) {
  return this.assignmentsService.findPaginated(query);
}
```
O `whitelist`+`forbidNonWhitelisted` global passa a rejeitar params desconhecidos, e o `Transform`/`enableImplicitConversion` já converte page/limit.

**Teste de regressão** — Teste de controller/E2E: (1) `GET /epi-assignments?user_id=abc` → 400 com `field: 'user_id'` (hoje 500); (2) `?status=invalido` → 400 (hoje 200 com lista vazia); (3) `?parametro_desconhecido=1` → 400 por `forbidNonWhitelisted`; (4) `?user_id=<uuid válido>&status=entregue&page=2&limit=50` → 200 e `findPaginated` recebe os valores já tipados.

---

### 🔵 SGS-EPI-PERF-014 — Cache de catálogo de EPI é corretamente isolado por tenant, mas a invalidação só cobre escritas via EpisService — 30 min de TTL mantém EPIs apagados visíveis para a Sophie

| | |
|---|---|
| **Severidade** | LOW |
| **Categoria** | Performance |
| **Local** | `backend/src/modules/epis/epis.service.ts:228` |
| **Verificação adversarial** | ⏳ NÃO VERIFICADO (verificadores do workflow caíram por limite de sessão; achado do auditor, ainda não confrontado) |

**Evidência**

Verifiquei o item (c) do escopo e o isolamento está CORRETO — registro o que foi provado e o que sobra:
```ts
// epis.service.ts L210-212
private buildCatalogCacheKey(tenantId: string): string {
  return `catalog:epis:${tenantId}`;
}
```
A chave inclui o tenant, e o caminho de cache só é tomado quando há tenant e não há filtros (L35-41: `if (!tenantId || hasFilters) return super.findAll(where, options);`). Não há leitura cruzada entre empresas. Os três caminhos de escrita do serviço invalidam (L69-85: `create`, `update`, `remove` chamam `invalidateCatalogCache`).

O que NÃO é coberto: qualquer alteração em `epis` que não passe por `EpisService` deixa o cache servindo dados obsoletos por até 30 minutos (`catalogCacheTtlMs = 30 * 60 * 1000`, L19) — restore de Disaster Recovery, correção via SQL direto, ou uma futura função de erasure/retention que toque a tabela. E o consumidor desse cache é o contexto da IA:
```ts
// src/modules/ai/ai.service.ts L2460
this.episService.findAll({}, { take: 500, select: ['id','nome','ca'] }),
```
que cai exatamente no ramo cacheado (where vazio, tenant presente).

Detalhe menor no mesmo trecho: o `set` faz merge lido-modificado-gravado do mapa de variantes (L57-64 `{ ...(cachedByVariant || {}), [variantKey]: data }`), então duas variantes populadas concorrentemente podem perder uma escrita — irrelevante para correção, apenas cache miss extra.

**Impacto** — Baixo e limitado a um tenant: a Sophie pode sugerir, em rascunho assistido de APR, um EPI que foi removido do catálogo minutos antes por um caminho fora do serviço. Não há impacto cross-tenant. Registro para fechar formalmente o item (c) do escopo com a conclusão de que o cache NÃO é um vetor de vazamento entre empresas.

**Causa raiz** — Invalidação acoplada aos métodos do serviço em vez de a um evento de domínio ou a um TTL curto. TTL de 30 minutos é longo para um catálogo que alimenta geração assistida de documento.

**Correção recomendada**

(1) Reduzir `catalogCacheTtlMs` para 5 minutos — o catálogo de EPI muda pouco e o ganho de 30 min sobre 5 min é marginal; (2) expor `invalidateCatalogCache` como método público e chamá-lo nos jobs que tocam `epis` fora do serviço (DR restore, scripts operacionais); (3) opcionalmente derivar a chave de um marcador de versão por tenant (`catalog:epis:{tenantId}:v{n}`) incrementado por qualquer escrita, tornando a invalidação atômica e imune a caminhos esquecidos.

**Teste de regressão** — Em `epis.service.cache.spec.ts` (que já cobre hit/miss/invalidação): somar (1) teste afirmando que a chave gerada para dois tenants distintos difere e que um `get` com tenant B nunca recebe payload de A; (2) teste de que `findAll` com filtros (`{ nome: 'x' }`) NÃO consulta nem grava cache; (3) após reduzir o TTL, afirmar `cacheManager.set` chamado com `5 * 60 * 1000`.

---

## NOT VERIFIED — o que não foi possível provar nesta rodada

- Não executei nada contra um banco PostgreSQL real — não havia instância disponível nesta sessão. Consequentemente: (a) o achado SGS-EPI-PRIV-001 está provado por leitura comparada das migrations 314 e 345 (a 345 é posterior, faz CREATE OR REPLACE com corpo completo e `grep epi_assignments` nela retorna vazio), mas não confirmei via `SELECT prosrc FROM pg_proc WHERE proname='gdpr_delete_user_data'` no banco de produção; (b) não confirmei via `pg_policies` quais policies estão de fato ATIVAS hoje em `epis` e `epi_assignments` — a análise é da sequência de migrations (021 cria, 172 dropa em site-scoped, 177 recria para sgs_app, 127/367 criam a RESTRICTIVE site-scoped, 315 recria a de epis com WITH CHECK), e a ordem é consistente, mas migrations podem ter sido puladas ou rodado com role sem permissão (a 177 tem `canManageTablePolicies` que SILENCIOSAMENTE pula a tabela se o usuário não for dono).
- Não confirmei em banco real se `epi_assignments.user_id` ainda é NOT NULL. A conclusão vem de: definição original NOT NULL em `1699000000000-initial-schema.ts` L543 e `1709000000017` L12, e nenhuma das 12 migrations que mencionam `epi_assignments` alterando nulidade. Um ALTER manual fora de migration não seria detectado por leitura de código.
- Não reproduzi a race condition de dupla devolução com concorrência real (exigiria Postgres + duas conexões). A prova é estrutural: `findOne` sem `lock`, entidade sem `@VersionColumn`, `save()` gerando UPDATE por PK, e ausência de CHECK de estado no banco — os três verificados no código.
- Não medi o comportamento de ponta a ponta do bypass de validação através do ValidationPipe do Nest em uma requisição HTTP real; provei em runtime com `validate(dto, { whitelist: true, forbidNonWhitelisted: true })` sobre o DTO real do repositório, usando exatamente as opções configuradas em `src/main.ts` L344-346. A diferença remanescente (o pipe também aplica `transform` e `enableImplicitConversion`) não altera o resultado, porque nenhuma dessas opções faz o class-validator descer em objeto aninhado sem `@ValidateNested`.
- Não auditei o frontend do módulo de EPI. Vários achados (ex.: colaborador devolvendo ficha alheia, entrega com CA vencido) podem estar bloqueados na UI — isso é irrelevante para a severidade, já que os endpoints são chamáveis diretamente, mas significa que não sei se algum deles é explorável apenas por API ou também pela interface.
- Não verifiquei se existe geração de PDF/ficha governada de EPI (document-registry + forensic-trail + hash do PDF final) como existe para APR/PT/NC. A busca por `EPI_ASSIGNMENT|epi-assignment` em `src/modules/document-registry`, `src/modules/forensic-trail` e `src/modules/reports` retornou apenas uma ocorrência solta em `reports.service.ts` L562. Isso sugere que a ficha de EPI NÃO é um documento governado com hash de PDF — o que seria uma lacuna adicional de governança documental —, mas não investiguei o módulo Reports a fundo o suficiente para afirmar.
