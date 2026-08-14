# SGS APR — Auditoria de Segurança Fase 3.5

## Escopo e vereditos

Revisão direcionada da integridade criptográfica do conteúdo assinado de APR,
vinculação da assinatura à versão/documento e fechamento da trilha forense.

- **APR CONTENT INTEGRITY: PARTIALLY VERIFIED**
- **APR FORENSIC AUDIT INTEGRITY: PARTIALLY VERIFIED**

O código e os testes unitários cobrem cálculo determinístico, persistência do
vínculo e fail-closed dos eventos críticos. A verificação não é declarada
integral porque a migration ainda precisa ser aplicada no ambiente alvo e não
houve E2E com PostgreSQL/Redis/storage real para concorrência, overwrite de
objeto ou restauração de backup.

## Arquitetura antes/depois

Antes, o envelope usava um hash de estado/document binding que não representava
todos os campos semânticos da APR nem possuía canonicalização própria. As linhas
antigas de `signatures` não tinham colunas de vínculo de conteúdo e não era
seguro inferir retroativamente o conteúdo assinado.

Depois, `apr-integrity.util.ts` constrói o conteúdo APR V1 com campos semânticos,
relações e itens de risco em ordem determinística; normaliza texto em NFC,
datas em ISO e calcula SHA-256. A assinatura APR persiste
`content_hash`, `hash_algorithm`, `canonicalization_version` e
`integrity_scheme`, além do snapshot interno. O cálculo ocorre em transação
com lock da APR, e a verificação retorna `VALID`, `CONTENT_MISMATCH`,
`LEGACY_SIGNATURE`, `MISSING_CONTENT`, `MISSING_SIGNATURE` ou `INVALID_STATE`.
O snapshot canônico completo não é devolvido pela listagem pública.

## Matriz de conteúdo signável

| Grupo | Incluído | Tratamento |
|---|---|---|
| Identidade | APR id, company, site, elaborador e auditado | IDs estáveis e tenant |
| Documento | número, título, descrição, tipo, frente, área, turno, local, responsável e datas | texto NFC; datas ISO |
| Estado | status, versão, parent, flags de modelo e scores | valores semânticos |
| Controles | descrição/evidência e classificação | texto normalizado |
| Relações | company/site/usuários, atividades, riscos, EPIs, ferramentas, máquinas e participantes | ordenação determinística |
| Itens de risco | ordem e campos semânticos | `ordem`, depois ID |
| Evidências | nome original, hashes SHA-256, hash watermarked e captura | sem URL/chave de storage |
| Excluído | URLs, `file_key`, permissões, e-mail e `updated_at` volátil | evita instabilidade/vazamento |

## Matriz de testes de hash

Mesma APR com relações reordenadas produz o mesmo hash; alterações de título,
item de risco, controle ou versão produzem hash diferente; Unicode equivalente
(NFC/NFD) permanece estável; e-mail, PDF key e permissões não influenciam o
hash. A adulteração posterior da APR retorna `CONTENT_MISMATCH`.

## Legacy, imutabilidade e PDF

A migration `1709000000375-add-apr-signature-content-integrity.ts` adiciona as
quatro colunas como nullable, sem backfill. Assinaturas sem `content_hash` são
`LEGACY_SIGNATURE`, sem reconstituição especulativa. As proteções anteriores
continuam bloqueando alteração de APR, evidência e assinatura após PDF final.
`content_hash` prova o conteúdo semântico; `final_pdf_hash_sha256` prova os bytes
do PDF. São provas distintas. Overwrite no storage e restauração de backup
continuam pendentes de E2E real.

## Trilha forense e atomicidade

Criação grava log crítico e `APR_CREATED`; atualização grava `APR_UPDATED`;
aprovação/finalização gravam `APR_APPROVED`/`APR_FINALIZED`; rejeição mantém o
evento de cancelamento transacional; nova versão grava criação, itens, steps,
dois logs e `APR_NEW_VERSION` na mesma transação; assinatura grava o vínculo na
transação própria. Falhas críticas lançam `InternalServerErrorException` e não
são silenciadas. Logs operacionais duplicados posteriores a alguns workflows
continuam fora da transação, mas o evento forense mínimo transacional existe.

## Findings e correções

- **F35-CRYPTO-01 (alto, corrigido):** vínculo completo e versionado por
  canonicalização V1 + SHA-256 + lock transacional + mismatch explícito.
- **F35-LEGACY-01 (médio, corrigido):** nenhum backfill especulativo; legado é
  explicitamente reportado.
- **F35-AUDIT-01 (alto, corrigido no caminho crítico):** trilha forense
  transacional e fail-closed para eventos APR críticos.
- **F35-DATA-01 (médio, corrigido):** snapshot canônico não é exposto na
  listagem pública de assinaturas.
- **Residual:** validar storage overwrite, restore/backup e concorrência em E2E.

## Validação executada

- Jest APR integridade, serviço, workflow e assinaturas: **4 suites, 167 testes aprovados**.
- `npx tsc --noEmit` no backend: **aprovado**.
- ESLint e Prettier dos arquivos tocados: **aprovados**.
- E2E PostgreSQL/Redis/storage reais: **não executado** por indisponibilidade da infraestrutura local.

## Gates antes de VERIFIED

1. Aplicar/verificar migration em staging/produção com backup e rollback.
2. E2E de duas sessões concorrentes assinando/atualizando a mesma APR.
3. Testar overwrite do PDF e divergência entre hash do conteúdo e hash dos bytes.
4. Testar restauração de backup e revalidação de assinaturas antigas/legadas.
5. Exportar/validar OpenAPI no pipeline após a migration.
