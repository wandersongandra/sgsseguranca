# Correções aplicadas — P0 da rodada 1

> Cada correção abaixo tem **teste de regressão que falha sem ela**. Onde a prova foi executada revertendo temporariamente o fix, o resultado da execução está transcrito.

## Estado da verificação

| | Antes | Depois |
|---|---|---|
| `npm run type-check` | ✅ limpo | ✅ limpo |
| `npx jest` (suíte completa) | 290 suítes / 2497 testes | **290 suítes / 2499 testes, todos verdes** |
| `npm run lint` | ❌ 1 erro pré-existente | ❌ o mesmo 1 erro pré-existente |

O erro de lint remanescente é `prettier/prettier` em [`1709000000376-fix-forensic-trail-runtime-rls.ts`](backend/src/infra/database/migrations/1709000000376-fix-forensic-trail-runtime-rls.ts) — arquivo **não rastreado**, anterior a esta auditoria e fora do escopo dela. Nenhum arquivo tocado aqui tem erro de lint.

---

## FIX-01 — `SGS-PT-SEC-001` · Gate de aprovação da PT avaliava entidade sem relações

**Arquivos:** [`pts.service.ts`](backend/src/modules/pts/pts.service.ts)

`executePtWorkflowTransition` usava o `SELECT * ... FOR UPDATE NOWAIT` — necessário para o lock — também como fonte da entidade. `SELECT *` devolve apenas colunas escalares, então `manager.getRepository(Pt).create(rows[0])` produzia uma PT com **todas as relações `undefined`**.

Agora o SELECT continua servindo só para adquirir o lock, e a entidade é recarregada **com relações, dentro da mesma transação e já sob o lock**:

```ts
const pt = await manager.getRepository(Pt).findOne({
  where: { id },
  relations: [...PT_WORKFLOW_RELATIONS],   // inclui 'executantes'
});
```

`PT_WORKFLOW_RELATIONS` virou constante única, também usada por `findOne()` — antes a lista estava duplicada.

**Prova.** Dois testes novos em `pts.service.spec.ts`. Com o fix revertido:

```
● bloqueia aprovação quando um executante não assinou
    expect(received).rejects.toThrow()
    Received function did not throw            ← a PT foi APROVADA

● bloqueia aprovação quando um EXECUTANTE tem treinamento bloqueante vencido
    Expected: ArrayContaining ["resp-1", "exec-1", "exec-2"]
    Received: ["resp-1"]                       ← executantes nunca avaliados
```

**Achado colateral — o mock escondia o bug.** O fixture de `pts.service.spec.ts` fazia o `query` mockado devolver a entidade inteira, *com* `executantes` populado — coisa que o Postgres nunca faz num `SELECT *`. Por isso 106 testes passavam sobre um gate furado. O mock foi corrigido para remover as relações e imitar o banco de verdade.

---

## FIX-02 — `SGS-PT-SEC-002` · Operador desligava as regras de aprovação da empresa inteira

**Arquivos:** [`pts.controller.ts`](backend/src/modules/pts/pts.controller.ts), [`pts.service.ts`](backend/src/modules/pts/pts.service.ts)

`PATCH /pts/approval-rules` exigia só `@Authorize('can_manage_pt')` — permissão que a migration 103 concede ao perfil `Operador / Colaborador` — e o `@Roles` de classe inclui `COLABORADOR`.

Três mudanças:

1. `@Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA)` no método. O `@Roles` de método sobrepõe o de classe (`Reflector.getAllAndOverride`, [roles.guard.ts:26](backend/src/modules/auth/roles.guard.ts#L26)).
2. `@ForensicAuditAction('update', 'pt_approval_rules')` na rota.
3. `updateApprovalRules` passou a receber o autor, gravar `logAudit` com `before`/`after` e logar explicitamente **quais regras foram desligadas**:

```ts
const disabled = (Object.keys(merged) as (keyof typeof merged)[]).filter(
  (rule) => previous[rule] === true && merged[rule] === false,
);
```

---

## FIX-03 — `SGS-PT-BR-003` · As 4 regras NR-33 eram inalcançáveis pela API

**Arquivos:** [`update-pt-approval-rules.dto.ts`](backend/src/modules/pts/dto/update-pt-approval-rules.dto.ts)

O DTO expunha 4 das 8 regras. Como a rota roda com `whitelist` + `forbidNonWhitelisted`, as outras 4 eram rejeitadas pelo pipe e ficavam presas no default `false` — tornando todo o bloco de conformidade NR-33 de `assertCanApprove` código morto em produção.

Adicionadas ao DTO: `blockConfinedSpaceWithoutAtmosphericReadings`, `blockConfinedSpaceWithoutWatch`, `blockConfinedSpaceWithoutRescuePlan`, `blockWithoutBeforeEvidence`.

**Prova.** `update-pt-approval-rules.dto.spec.ts` — 10 testes que validam cada regra individualmente e as 8 juntas, com a lista das regras como fonte da verdade do contrato.

> **Atenção operacional:** os defaults continuam `false` (opt-in, decisão de produto preservada). O que mudou é que **agora existe como ligá-las**. Ligar as regras NR-33 por empresa é decisão de negócio, não desta auditoria.

---

## FIX-04 — `SGS-DDS-INT-001` · DELETE de DDS destruía o PDF final emitido

**Arquivos:** [`dds.service.ts`](backend/src/modules/dds/dds.service.ts)

Adicionada a mesma trava que `PtsService.remove()` e `NonConformitiesService.remove()` já tinham:

```ts
if (dds.pdf_file_key) {
  throw new BadRequestException(
    'Somente DDS sem PDF final podem ser removidos. Use os fluxos formais de arquivamento para registros já emitidos.',
  );
}
```

**Prova.** Teste novo em `dds.service.spec.ts` que verifica o 400 **e** que nem `removeFinalDocumentReference` nem `documentStorageService.deleteFile` são chamados.

---

## FIX-05 — `SGS-EPI-SEC-001` · `ValidationPipe` ignorado nas rotas de catálogo

**Arquivos:** [`base.service.ts`](backend/src/shared/base/base.service.ts), [`epis.controller.ts`](backend/src/modules/epis/epis.controller.ts), [`machines.controller.ts`](backend/src/modules/machines/machines.controller.ts), [`tools.controller.ts`](backend/src/modules/tools/tools.controller.ts), [`epis.service.ts`](backend/src/modules/epis/epis.service.ts)

Duas camadas:

1. **Controllers** — `EpisController`, `MachinesController` e `ToolsController` passaram a sobrescrever `create`/`update` declarando o `@Body()` com a **classe DTO concreta**, restaurando `whitelist`, `forbidNonWhitelisted` e todos os decorators — inclusive o `sanitizePlainTextTransform` anti-XSS, que nunca chegou a rodar nessas rotas. (`RisksController` já fazia isso e por isso estava protegido.)
2. **`BaseService.sanitizeWritePayload`** — passou a remover também `id`, `deleted_at`, `created_at` e `updated_at`, protegendo qualquer subclasse futura que caia na mesma armadilha.

**Bug latente exposto pela correção.** Com o tipo concreto, o compilador acusou o que o `DeepPartial<T>` genérico escondia: `CreateEpiDto.validade_ca` é `string` (`@IsDateString()`) e `Epi.validade_ca` é `Date`. Resolvido com uma ponte explícita e tipada, `EpisService.toEntityPayload()`.

**Prova.** Dois specs novos:

- `base-controller-body-validation.spec.ts` — documenta a armadilha (o `ValidationPipe` deixa passar cru um payload com `id`, `deleted_at`, `company_id`, `<script>` e data inválida quando o metatype é `Object`, e rejeita o mesmo payload com o DTO concreto) e **falha se qualquer subclasse de `BaseController` voltar a expor `@Body()` sem tipo**.
- `base.service.sanitize.spec.ts` — 13 testes cobrindo cada campo removido, inclusive `deleted_at: null` (ressurreição).

---

## FIX-06 — `SGS-EPI-PRIV-001` · Regressão LGPD na `gdpr_delete_user_data()`

**Arquivo:** [`1709000000377-restore-gdpr-epi-and-pt-erasure.ts`](backend/src/infra/database/migrations/1709000000377-restore-gdpr-epi-and-pt-erasure.ts) *(migration nova)*

A migration 345 recriou a função inteira e esqueceu dois blocos: `epi_assignments` (adicionado pela 314) e `pts_text_fields` (adicionado pela 312). Desde então, um pedido de exclusão do titular **não anonimizava** a assinatura do trabalhador na ficha de EPI nem os campos de texto livre da PT.

A 377 reconstrói a função da 345 na íntegra e reintroduz os dois blocos, com guarda `to_regclass` para manter idempotência. O `down()` volta exatamente à definição da 345 (documentado como "reintroduz a regressão", para reversibilidade formal).

> ⚠️ **NOT VERIFIED:** a migration não foi executada contra banco nesta sessão. Precisa rodar em ambiente descartável antes de produção, com o teste: criar usuário sintético com ficha de EPI assinada e PT aprovada → `SELECT * FROM gdpr_delete_user_data('<uuid>')` → conferir que o retorno inclui as linhas `epi_assignments` e `pts_text_fields` e que `assinatura_entrega->>'signature_data'` virou `[LGPD: removido]`.

> **Próximo timestamp de migration passa a ser `1709000000378`** — atualizar `CLAUDE.md`.

---

## Correções P0 ainda NÃO aplicadas

| Achado | Módulo | Por que não foi corrigido agora |
|---|---|---|
| `SGS-RF-SEC-012` | Rel. Fotográfico | Exige coluna `site_id` nova + decisão de produto sobre o backfill do histórico (a policy de obra não tolera `site_id IS NULL`). Ver `site-isolation.md` para as duas saídas possíveis. |
| `SGS-RF-STM-001` / `-002` | Rel. Fotográfico | `saveDraft()` força `RASCUNHO` incondicionalmente. A correção exige definir quais transições de volta a rascunho são legítimas — decisão de produto. |
| `SGS-RDO-INT-001` / `-002` | RDO | Tornar `rdo_audit_events` append-only (trigger + revogar UPDATE/DELETE) e trocar o hard delete por soft delete. Mexe em RLS e em CASCADE — merece migration própria e validação em banco descartável. |
| `SGS-RDO-SEC-001` | RDO | Falta decidir a política: allowlist de domínio? teto de destinatários? throttle por tenant? É decisão de produto. |
