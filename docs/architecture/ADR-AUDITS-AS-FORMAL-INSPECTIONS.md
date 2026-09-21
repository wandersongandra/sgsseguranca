# ADR — Audits como camada de inspeções formais

- **Status:** Accepted
- **Data:** 03/09/2026
- **Decisão:** Option A — Audits = camada de produto para auditorias e inspeções formais
- **Escopo:** produto SGS, frontend e contratos já existentes

## Contexto

O SGS já possui o domínio técnico `Audit`, o cliente de API de auditorias, as
permissões `can_view_audits`/`can_manage_audits`, a rota `/audits` e o PDF
governado de auditoria. Também existem Checklists para execução estruturada em
campo e uma entidade/tabela `Inspection` legada.

A entidade `Inspection` não possui, no estado atual, um bounded context de
produto completo equivalente a Audits. Suas leituras existentes são de
compatibilidade e não devem ser promovidas silenciosamente a um novo fluxo de
inspeções formais.

## Decisão

Adotamos a Option A:

1. **Audits** é a camada de produto para **Auditorias e Inspeções** formais.
   O backend permanece tecnicamente nomeado como `Audit`, com `/audits`,
   `AuditsService`, permissões de auditoria e o mesmo contrato de tenant/site.
2. **Checklists** permanece uma camada separada de execução operacional e
   verificação recorrente em campo, com seus próprios modelos, itens,
   respostas, criticidade, fotos e status.
3. A rota frontend canônica continua sendo `/dashboard/audits`. O caminho
   `/dashboard/inspections`, quando usado, é apenas um alias UX que redireciona
   para a superfície canônica e preserva parâmetros de consulta; não há uma
   segunda página, fetch, estado ou evento de analytics.
4. A entidade/tabela `Inspection` existente permanece
   **LEGACY / COMPATIBILITY / READ-ONLY INFRASTRUCTURE**. Leituras legadas
   continuam somente onde contratos existentes exigirem. Não há nova escrita,
   CRUD, tela de edição ou promoção automática de registros legados.
5. Como não existe subtype persistido adequado no Audit, a interface usa
   nomenclatura combinada. Não criamos `auditType = "inspection"`, filtro
   fictício ou campo frontend que desapareça após o reload. O subtype
   `Audit/Inspection` está **NOT YET PERSISTED**.
6. Métricas de produto que não conseguem distinguir subtype usam somente
   agregados reais de Audit e linguagem combinada. Linhas legadas de
   `Inspection` não são somadas silenciosamente. O KPI legado enganoso de
   inspeções concluídas não é apresentado como uma contagem independente.
7. PDFs de inspeção formal continuam usando o PDF governado de Audit. Não há
   `InspectionPdfService`, novo storage pipeline ou alteração do contrato de
   imutabilidade dos PDFs finais.

## Invariantes de segurança e compatibilidade

- `can_view_audits` e `can_manage_audits` continuam sendo a autoridade de
  RBAC; não criamos um namespace `inspection.*`.
- O alias não cria superfície pública e permanece sob o mesmo layout de
  autenticação, tenant, site ownership e autorização da rota canônica.
- Criação, edição, CAPA, download, validação pública e geração de PDF usam os
  serviços e contratos já existentes de Audit.
- A assinatura, as migrations 0385–0403, a tabela legada e os contratos de
  Checklists não são alterados por esta decisão.
- Não criamos migration 0404, módulo/controller/service/repository/DTO de
  Inspection, tabela nova, workflow paralelo ou engine PDF duplicado.

## Consequências

### Positivas

- O produto apresenta uma capacidade única e compreensível sem duplicar
  backend, autorização, isolamento de tenant, PDF ou storage.
- Links existentes para `/dashboard/audits` permanecem válidos; o alias
  oferece compatibilidade de linguagem sem criar uma segunda implementação.
- Checklists mantém seu significado operacional, evitando que uma verificação
  recorrente seja confundida com uma avaliação formal.

### Limitações e trabalho futuro

- Analytics separados de auditoria versus inspeção formal exigirão um subtype
  persistido e uma decisão de produto/arquitetura futura. Isso não é criado
  nesta etapa.
- O inventário de dados históricos da tabela `Inspection` continua uma tarefa
  futura e separada. Até lá, os registros legados não são migrados,
  reescritos, regenerados ou misturados a métricas de Audit.
- Se a necessidade futura exigir uma view dos registros legados, ela deverá
  ser explicitamente read-only e aprovada em decisão própria.

## Rejeitadas nesta etapa

- Novo bounded context `Inspections`.
- Renomeação massiva de `Audit` para `Inspection`.
- `can_view_inspections`/`can_manage_inspections`.
- Migration 0404, coluna de subtype, backfill ou mutação histórica.
- Tela, API, serviço, workflow, PDF ou storage duplicado.

**Aprovação do Product Owner:** Option A aprovada em 03/09/2026.
