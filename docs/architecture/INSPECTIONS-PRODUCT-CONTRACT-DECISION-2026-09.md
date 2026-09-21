# SGS — Inspections Product Contract Decision

**Data:** 03/09/2026
**Repositório:** `wandersongandra/sgsseguranca`
**Parent PR:** #344 — durable notification deduplication
**Parent HEAD:** `cf4668c3cfb78eaf95dee3e9f08936eeae1fe153`
**Parent base:** `product/wave-4-cross-cutting-platform-hardening`
**Branch documental:** `audit/inspections-product-contract`
**Escopo:** decisão do contrato de produto para Inspections, sem implementação.
**Produção:** não acessada, alterada ou migrada.

## 1. Decisão executiva

**Decisão recomendada: opção A — `Audits` é o product layer para inspeções
formais; `Checklists` é a camada de execução operacional em campo.**

O código possui uma entidade/tabela `Inspection`, mas não possui módulo,
service, controller, rota frontend, permissões RBAC ou transições de estado
específicas para um produto de inspeções. Em contraste, `Audits` já possui o
fluxo formal completo de criação, consulta, achados, risco, plano de ação,
PDF, validação e CAPA. `Checklists` já possui o fluxo de execução/template,
itens, criticidade, respostas, fotos, status e PDF.

Portanto, a recomendação é não criar um quarto CRUD paralelo. Uma inspeção
formal deve ser representada pelo agregado de `Audit`, quando o owner
confirmar essa linguagem de produto; uma verificação de campo baseada em
itens deve continuar sendo `Checklist`. A tabela `inspections` deve ser
tratada como legado/compatibilidade e infraestrutura de leitura enquanto
não houver inventário de seus registros e decisão explícita sobre migração ou
retenção.

```text
INSPECTIONS PRODUCT CONTRACT GATE: PASS — decision/documentation only
Recommended Option: A — Audits product layer + Checklists execution layer
Product Owner Decision: REQUIRED
Implementation: NONE
New Inspection Module: NO
New Inspection Route: NO
Migration 0404: NOT CREATED
Production: UNCHANGED
```

Esta decisão não autoriza merge do PR #344, deploy, migration, mudança de
schema, alteração de nomenclatura na interface ou operação de produção.

## 2. Limites e classificação da evidência

O levantamento foi read-only no checkout documental derivado do HEAD real do
PR #344. O checkout original de notificações não foi alterado. O worktree
documental já possuía duas mudanças rastreadas no frontend, preservadas e
não incluídas neste documento:

```text
M frontend/app/verify/page.test.tsx
M frontend/app/verify/page.tsx
```

Não foram executados banco, migrations, storage DR, VPS, produção ou testes
de browser. Não foram usados segredos nem valores de ambiente.

Classificação usada neste relatório:

- `CONFIRMED`: observado diretamente em código, configuração ou rota;
- `INFERRED`: conclusão de produto derivada de múltiplas evidências;
- `NÃO VERIFICADO`: não demonstrado pelo código/execução desta etapa;
- `BLOCKED`: depende de decisão, dado ou ambiente ainda indisponível.

## 3. Inventário atual

| Área         | Evidência atual                                                                                                               | Estado de produto                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Inspection` | `backend/src/shared/entities/inspection.entity.ts`; tabela criada/reconhecida por `1709000000387-create-inspections-table.ts` | `CONFIRMED`: entidade e persistência existem; fluxo de produto dedicado não existe                     |
| `Audits`     | `backend/src/modules/audits/audits.controller.ts` e `audits.service.ts`                                                       | `CONFIRMED`: CRUD, contexto de validação, PDF, upload e remoção ativos                                 |
| `Checklists` | `backend/src/modules/checklists/checklists.controller.ts` e `checklists.service.ts`                                           | `CONFIRMED`: modelos, execuções, itens, fotos, PDF, status e validação ativos                          |
| Dashboard    | `dashboard.service.ts`, `dashboard-document-availability-*`                                                                   | `CONFIRMED`: lê/transporta referências de `Inspection`, mas os KPIs específicos têm slots legados/zero |
| Assinaturas  | `signatures.service.ts`                                                                                                       | `CONFIRMED`: leitura legada de `inspection`; novas assinaturas de inspeção são descontinuadas          |
| Frontend     | rotas e serviços de `audits` e `checklists`                                                                                   | `CONFIRMED`: não há rota ou serviço dedicado de `inspections`                                          |
| RBAC         | `user-module-access.config.ts`, `rbac.service.ts`                                                                             | `CONFIRMED`: há permissões de audit/checklist; não há permissão de inspection                          |

### 3.1 Inspection: contrato persistido, sem superfície de produto

`Inspection` contém `company_id`, `site_id`, `responsavel_id`, setor/área,
tipo, data, horário, objetivo, descrição do local, metodologia,
perigos/riscos, plano de ação, evidências, conclusão, timestamps e soft
delete (`inspection.entity.ts`; migration `1709000000387`). O tipo documenta
Rotina, Programada, Especial e Atendimento a NR.

Isso demonstra um modelo de dados plausível para relatório de inspeção, mas
não demonstra uma funcionalidade utilizável por um usuário. Não foram
encontrados `InspectionModule`, `InspectionService`, `InspectionController`,
DTOs de criação/atualização, rota frontend ou fluxo de estado dedicado.

A migration `1709000000352-convert-inspections-deleted-at-timestamptz.ts`
registra que a tabela já existia em ambientes de produção fora da cadeia
original. A migration `1709000000387` adiciona/regulariza a tabela, índices,
RLS e grants. Isso sustenta a classificação de compatibilidade/legado, não a
existência de um produto ativo.

### 3.2 Audits: fluxo formal ativo

O controller `@Controller('audits')` aplica JWT, tenant e roles, e separa
`can_manage_audits` de `can_view_audits`. O service possui criação, listagem
com paginação, detalhe, atualização, remoção, upload de PDF, acesso ao PDF e
contexto de validação.

O agregado de audit relaciona empresa, site e auditor e mantém contexto,
objetivo/escopo/metodologia, documentos avaliados, conformidades,
não-conformidades classificadas, avaliação de risco, plano de ação,
respostas de checklist, evidências e conclusão. A criação valida site e
auditor; a edição/remoção é bloqueada depois da geração do PDF final.

A interface ativa usa `/dashboard/audits`, com “Auditorias HSE”, conformidades,
CAPAs, não-conformidades, PDF, bundle semanal, busca, paginação e exclusão.
O formulário se chama “Novo Relatório de Auditoria HSE” e já contém os
campos necessários para o relatório formal de inspeção.

### 3.3 Checklists: execução e modelos

O controller `@Controller('checklists')` separa leitura e gestão com
`can_view_checklists` e `can_manage_checklists`. O service cobre criação,
execução a partir de modelo, listagem, atualização, remoção, fotos de item e
equipamento, PDF, validação e importação.

`Checklist` possui título, empresa, site opcional para modelos, inspetor,
data, status derivado dos itens, itens estruturados, template, categoria,
periodicidade, risco padrão, respostas de auditoria e evidências. A UI ativa
é `/dashboard/checklists`, com Central de modelos, Execuções e Novo
checklist. A execução exige site e inspetor; os itens suportam criticidade,
observação, resposta e foto.

`Checklists` é, portanto, a primitiva adequada para inspeção/verificação de
campo recorrente. Isso não o torna automaticamente o agregado de um relatório
formal com escopo, achados, avaliação de risco, CAPA, conclusão e PDF
governado.

## 4. Mapa de entidades e relacionamentos

```text
Company
├── Site
├── Audit
│   ├── site_id / auditor_id
│   ├── findings, risks, action plan, checklist responses and evidences (JSONB)
│   └── governed PDF metadata
├── Checklist
│   ├── site_id / inspetor_id / template_id
│   ├── structured items, status and photos
│   └── governed PDF metadata
├── Inspection
│   ├── site_id / responsavel_id
│   └── risks, action plan and evidences (JSONB)
├── NonConformity
│   └── optional checklist_id; no audit_id or inspection_id
└── CorrectiveAction
    └── source_type supports manual, nonconformity and audit; not inspection
```

`Activity` é um registro associado à empresa sem relação direta demonstrada
com `Audit`, `Inspection` ou `Checklist`. Não foi encontrado um agregado
dedicado `Finding` ou `Evidence` nas entidades inspecionadas; achados,
respostas e evidências aparecem embutidos nos agregados e/ou em referências
de storage governado.

Consequências:

- `Audit` e `Inspection` têm sobreposição estrutural alta: empresa, site,
  responsável, data, metodologia, risco, ação, evidência e conclusão;
- `Checklist` tem sobreposição de execução e evidência, mas possui uma
  semântica operacional distinta por itens, respostas, modelos e status;
- `CorrectiveAction` já conhece `audit`, mas não `inspection`, e
  `NonConformity` conhece `checklist_id`, o que favorece manter a fronteira
  formal/execução explícita até uma decisão de produto posterior.

## 5. Matriz de capacidades

| Capacidade          | Audits                                         | Inspections atual                                        | Checklists                                    | Leitura                                             |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Criar               | `PASS` — POST `/audits`                        | `NÃO PRESENTE`                                           | `PASS` — create/bootstrap                     | Não existe entrada de criação para Inspection       |
| Listar/paginar      | `PASS`                                         | `NÃO PRESENTE`                                           | `PASS`                                        | Superfícies reais são audits/checklists             |
| Detalhar            | `PASS`                                         | leitura interna/legada                                   | `PASS`                                        | Inspection não possui endpoint próprio              |
| Empresa/site        | `PASS` com escopo                              | colunas/FKs e RLS                                        | `PASS` com escopo                             | Sem API Inspection para aplicar o contrato          |
| Responsável         | auditor validado no site                       | `responsavel_id`                                         | inspetor exigido na execução                  | Sem fluxo Inspection ativo                          |
| Itens/perguntas     | respostas de checklist embutidas no audit      | não há coleção de itens                                  | itens estruturados e modelos                  | Checklists é a primitiva de execução                |
| Achados/NCs         | JSONB de conformidades/NCs e criação de CAPA   | `NÃO VERIFICADO` como fluxo                              | respostas podem originar NC; `checklist_id`   | Audit concentra o relatório formal                  |
| Severidade/risco    | classificação de NC e avaliação de risco       | campos JSONB de risco                                    | criticidade dos itens e risco padrão          | Sem estado Inspection específico                    |
| Plano de ação       | JSONB + CorrectiveAction source `audit`        | JSONB sem produtor ativo                                 | ações derivadas de não-conformidade           | Sobreposição não justifica terceiro CRUD            |
| Evidências          | DTO e referências governadas                   | JSONB `evidencias`                                       | fotos e referências governadas                | Governança completa não foi provada para Inspection |
| Fotos               | evidências de auditoria                        | sem upload/endpoint dedicado encontrado                  | fotos de item/equipamento                     | Checklists possui fluxo operacional mais definido   |
| Status              | conclusão/PDF final; edição bloqueada após PDF | sem transições dedicadas encontradas                     | status derivado dos itens                     | Inspection não tem ciclo de vida ativo              |
| Finalização         | PDF final governa imutabilidade                | não encontrada                                           | PDF final governa imutabilidade               | Contrato formal existente em Audit                  |
| Assinatura          | document type ativo                            | somente leitura legada; novas assinaturas descontinuadas | document type ativo                           | Inspection não é caminho de emissão atual           |
| PDF                 | geração/acesso/bundle/validação                | sem controller/PDF próprio                               | geração/acesso/bundle/validação               | Audit e Checklist têm artefato governado            |
| Histórico/validação | contexto de validação e metadados PDF          | referências legadas de assinatura                        | contexto de validação e metadados PDF         | Inspection não possui trilha específica             |
| Dashboard/KPIs      | métricas ativas de auditoria                   | slots `0`/legados em `dashboard.service.ts`              | superfície própria de execuções               | Não há KPI ativo de Inspection                      |
| Tenant/RLS          | guards, service scope e FKs                    | RLS/site scope na tabela                                 | guards, interceptor e service scope           | Persistência não equivale a produto                 |
| RBAC                | `can_view_audits`/`can_manage_audits`          | nenhuma permissão específica                             | `can_view_checklists`/`can_manage_checklists` | Nova fronteira exigiria contrato novo               |

## 6. Rotas, UX e nomenclatura

### Rotas confirmadas

```text
Audits:
  /audits
  /audits/:id
  /audits/:id/file
  /audits/:id/pdf
  /audits/files/list
  /audits/files/weekly-bundle

Checklists:
  /checklists
  /checklists/:id
  /checklists/:id/pdf
  /checklists/:id/file
  /checklists/files/list
  /checklists/files/weekly-bundle
  /checklists/:id/photos/*

Inspections:
  nenhuma rota dedicada encontrada
```

Na navegação, `Auditorias` aparece em `/dashboard/audits` e Checklists possui
Central de modelos, Execuções e Novo checklist. Não há item de navegação de
Inspeções. O cache key `queryKeys.inspections` existe sem consumidor
frontend encontrado, o que é evidência de contrato cliente antigo/stale, não
de uma tela funcional.

A classificação de pendências documentais mapeia `inspection` para
“Relatório Fotográfico”, o mesmo rótulo usado por `photographic_report`.
Esse alias pode ser útil para compatibilidade, mas não deve ser tratado como
prova de que relatório fotográfico e inspeção são o mesmo produto. A decisão
de nomenclatura precisa ser feita pelo owner antes de qualquer mudança de UI.

### SST e fronteira semântica

Há três conceitos observáveis no produto atual:

1. **Checklist:** inspeção/verificação operacional por itens, modelo,
   periodicidade, criticidade, fotos e status;
2. **Audit:** relatório formal HSE de conformidade, com contexto, escopo,
   achados, risco, CAPA, conclusão, PDF e validação;
3. **Inspection persistido:** estrutura legada de relatório com tipos Rotina,
   Programada, Especial e NR, sem superfície ativa.

O código não contém hoje uma separação de UX implementada entre “inspeção
formal” e “auditoria formal”. A alternativa A exige decisão de vocabulário,
não uma duplicação técnica imediata.

## 7. Comparação de opções

Escala: `1` = baixo suporte/elevado risco para esta base; `5` = alto suporte/
baixo risco para esta base. As notas são análise de produto (`INFERRED`), não
medição de performance.

| Critério                                 | A — Audits como product layer | B — bounded context dedicado | C — não implementar agora |
| ---------------------------------------- | ----------------------------: | ---------------------------: | ------------------------: |
| Evidência de fluxo já utilizável         |                             5 |                            1 |                         1 |
| Reuso de autorização, tenant e PDF       |                             5 |                            1 |                         5 |
| Evita duplicação de domínio              |                             5 |                            1 |                         5 |
| Diferenciação semântica imediata         |                             3 |                            5 |                         3 |
| Custo/risco de implementação             |                             4 |                            1 |                         5 |
| Continuidade com dados legados           |                             4 |                            2 |                         2 |
| Adequação à necessidade atual do produto |                             5 |                            2 |                         1 |

### Opção A — recomendada

É a melhor correspondência com o código as-built. `Audit` já é o relatório
formal operacional e `Checklist` já cobre a execução. A tabela `Inspection`
não recebe novos registros por um fluxo ativo identificável.

### Opção B — quando seria justificável

Somente se o owner comprovar que inspeções de campo possuem requisitos
materialmente diferentes de auditorias, por exemplo: alta frequência móvel ou
offline, programação recorrente própria, workflow de aprovação distinto,
retensão/assinatura diferente, papéis RBAC próprios, métricas próprias,
exportação/PDF próprio e integrações que não cabem no agregado de Audit.

Sem esses requisitos, B duplicaria empresa/site/responsável/data/risco/ação/
evidência/PDF e criaria uma segunda fronteira de autorização e isolamento.

### Opção C — quando seria justificável

Se o owner declarar que nenhum fluxo de inspeção formal será entregue neste
ciclo e aceitar manter `Inspection` somente como compatibilidade técnica. Isso
não é a recomendação atual porque o produto já tem um fluxo formal de
auditoria e um fluxo operacional de checklist que cobrem o espaço funcional.

## 8. Decisão requerida do Product Owner

O owner precisa confirmar, antes de qualquer implementação:

1. se “Inspeção formal” será um modo/tipo/nomenclatura de `Audit`;
2. se a tela deve exibir “Auditorias e Inspeções” ou manter “Auditorias HSE”;
3. se registros legados de `inspections` serão apenas leitura, exportáveis ou
   sujeitos a uma migração futura;
4. se “Relatório Fotográfico” continuará sendo alias de compatibilidade ou
   será separado semanticamente;
5. como KPIs de inspeção formal devem ser derivados sem manter contadores
   hardcoded separados;
6. se a eventual rota `/dashboard/inspections` será apenas alias de UX para
   `/dashboard/audits`, sem novo backend.

Até essa confirmação, não criar DTO/controller/service/rota, não adicionar
permissões, não editar as migrations históricas, não criar migration 0404 e
não reescrever registros legados.

## 9. Plano futuro condicionado à opção A

Este é somente um plano; nenhum item foi implementado nesta etapa.

1. registrar um ADR de vocabulário e do limite entre Audit formal e Checklist
   operacional;
2. definir, com o owner, o tipo/subtipo formal de inspeção no agregado Audit;
3. mapear as referências legadas de `Inspection` para leitura/relatório
   somente após inventário de dados, sem migração cega;
4. manter registros legados imutáveis e com estado explícito quando não houver
   contrato de assinatura/PDF compatível;
5. usar somente o caminho de Audit para novos relatórios formais e preservar
   as permissões existentes, salvo decisão explícita de RBAC;
6. alinhar KPIs, pendências documentais, assinaturas, validação pública e
   CAPA em um PR de implementação separado;
7. se necessário, adicionar apenas um alias de rota frontend depois da
   decisão de UX, sem duplicar controller ou tabela;
8. validar tenant, ownership, storage, PDF, assinatura, rate limit e
   regressões em teste antes de qualquer publicação.

Se o owner escolher B, deve ser aberto um mini-RFC separado com requisitos
que provem a fronteira e o custo de um bounded context novo. Se escolher C,
deve ser registrado um plano de retenção/compatibilidade e a política para
remover contratos mortos, sem alteração nesta decisão.

## 10. O que não foi feito

```text
Inspection module/controller/service: NOT CREATED
Inspection frontend route/service: NOT CREATED
Inspection RBAC permissions: NOT CREATED
New entity/schema changes: NONE
Migration 0404: NOT CREATED
Migration 0385–0403: UNCHANGED
Inspection legacy rows: NOT READ OR MODIFIED
Notification PR #344: NOT MODIFIED
W4-P2-001 durable dedupe: UNCHANGED
Frontend changes: NONE — pre-existing verify changes preserved
Production database: NOT ACCESSED
Production application/infrastructure: UNCHANGED
Storage DR: OUT OF SCOPE / UNCHANGED
Deploy: NO
```

`FE-LOW-002` permanece `OPEN-DEFERRED LOW`; este documento não o reclassifica
nem o corrige.

## 11. Gate final

```text
Repository: wandersongandra/sgsseguranca
Parent PR: #344 — OPEN / non-draft / mergeable at inspection
Parent HEAD: cf4668c3cfb78eaf95dee3e9f08936eeae1fe153
Documentary Branch: audit/inspections-product-contract
Recommended Decision: A — Audits product layer; Checklists execution layer
Product Owner Decision: REQUIRED
Read/Map/Compare: PASS
Source Implementation: NONE
Schema/Migration Implementation: NONE
Migration 0403: UNCHANGED
Migration 0404: NOT CREATED
W4-P2-001: CLOSED — unchanged
FE-LOW-002: OPEN-DEFERRED LOW — unchanged
Production Changed: NO
Production Database Changed: NO
Production Deploy: NO
Merge PR #344: NO
Documentary Commit: e6d3fc41664bd71089f28388076a9ad34565c6c5
Documentary Push: YES
Documentary PR: #345 OPEN — stacked on PR #344
Merge Documentary PR: NO
Inspections Product Contract Gate: PASS — documentary decision only
Ready For Production: NO — separate release gate required
FINAL VERDICT: PASS — contract decision recorded; implementation deferred
```

**Conclusão:** a base atual não sustenta um produto `Inspection` separado.
`Audits` já contém o agregado e o fluxo formal mais completo; `Checklists`
contém a execução operacional em campo; `Inspection` é persistência legada e
compatibilidade sem superfície ativa. A opção A é recomendada com confiança
alta, condicionada à confirmação do Product Owner sobre vocabulário e
tratamento dos registros antigos. Nenhum código funcional, schema, migration,
produção ou PR #344 foi alterado por esta decisão.

## Addendum — publicação documental

**Data:** 03/09/2026
**Commit documental:** `e6d3fc41664bd71089f28388076a9ad34565c6c5`
**PR:** [#345](https://github.com/wandersongandra/sgsseguranca/pull/345)

```text
Branch: audit/inspections-product-contract
PR #345: OPEN / non-draft / mergeable
PR #345 base: fix/notification-durable-dedupe
PR #345 base HEAD: cf4668c3cfb78eaf95dee3e9f08936eeae1fe153
PR #345 HEAD: e6d3fc41664bd71089f28388076a9ad34565c6c5
Unexpected implementation commits: 0
Merge: NO
Deploy: NO
Production Changed: NO
```

O relatório documental foi o único arquivo do commit; as alterações
preexistentes em `frontend/app/verify/page.tsx` e seu teste continuam fora do
índice. O PR #344 não foi modificado.

PARAR.
