# DDS — Release Unblock: Final 3

Data: 2026-08-17. Escopo restrito aos três gates finais; sem produção, commit, push ou deploy.

> `HISTORICAL_EVIDENCE`: referências ao ambiente isolado abaixo descrevem uma
> rodada anterior; não há VPS remota de testes separada autorizada atualmente.

## Decisão

`NO-GO`: o gate de secrets continua aberto. Os gates de provider externo e accessibility foram executados no ambiente isolado e passaram nesta rodada.

| Gate | Estado | Evidência atual | Fechamento necessário | Owner/dependência |
| --- | --- | --- | --- | --- |
| Secret closure / Gitleaks | **BLOCKED** | Source/tracked/diff: 0; worktree atual após quarentena recuperável: 0 findings; histórico `--all`: 13 findings antigos | Classificar os 13 históricos, revogar/rotacionar qualquer credencial plausível e repetir scan history com relatório redigido | Owner de secrets/GitHub + segurança |
| Provider externo | **PASS runtime sintético** | MinIO S3-compatible privado na VPS; upload `201`, PUT `200`, complete `201`, hash/magic bytes, download autorizado `200/%PDF-`, anônimo `403`, tamper `403`, cross-tenant `403` sem URL e expiração provider `200 → 403`; prefixo final vazio | Repetir com credenciais temporárias do provider escolhido para staging, se o release exigir staging externo distinto | Infra/storage |
| Accessibility / Axe | **PASS runtime sintético** | Login real sintético; Axe autenticado em Dashboard, lista DDS e formulário DDS nos viewports `390x844`, `430x932`, `1440x900`: `0` serious/critical; teclado mobile `2/2` PASS; correção do texto da Sidebar aplicada | Manter a suíte no CI e repetir em staging após mudanças de tema/layout | Frontend/QA |

## Runtime closure addendum — ambiente isolado

- Auth smoke: CSRF `200`, login `201`, `/auth/me` `200`, empresa e usuário presentes.
- Storage: provider MinIO interno, bucket privado e credenciais sintéticas somente de teste. Fluxo oficial `presigned → PUT → complete` passou; objeto promovido ficou em `documents/`; GET anônimo retornou `403`.
- Registry/PDF: registro sintético autorizado retornou `200`, corpo com magic `%PDF-`; URL adulterada `403`; tentativa cross-tenant `403` sem emissão de URL; URL provider com TTL de 5 s retornou `200 → 403`.
- Hygiene: prefixos `quarantine/` e `documents/` do bucket de teste foram limpos; contagem final de objetos `0`. Nenhum token ou valor de credencial foi registrado.
- Axe: `3/3` projetos PASS; Dashboard/lista/formulário sem violações `serious` ou `critical`; teclado mobile `2/2` PASS.

## Atualização de fechamento — 2026-08-17

- Os 203 findings do diretório de trabalho foram identificados como `.env` locais, logs, cache/build e artefatos Vercel/Puppeteer não tracked.
- Esses artefatos foram movidos para quarentena temporária recuperável fora do repositório; o scan amplo atual retornou `0` findings.
- O scan histórico completo continua em `13` findings. Não houve reescrita de histórico nem force-push.
- O R2 legado foi parcialmente retirado: `sgs-02` e `sgs-03` foram excluídos; `sgs-01` teve a retenção removida sob autorização explícita, seus 71 objetos restantes foram apagados e o bucket também foi excluído. Backblaze B2 não foi alterado.
- O owner informou a revogação do token histórico do Cloudflare; nenhum valor foi registrado. A confirmação independente por API e o ticket/evidência redigida ainda são necessários para fechar formalmente o gate.
- O PR técnico passou backend, frontend, DR, E2E crítico e todos os scans CI; isso não substitui a revogação externa dos históricos.

## Secret inventory redigido

- Os findings atuais do worktree foram removidos para quarentena e o scan atual está zerado; o inventário anterior incluía logs, `.env` locais não tracked, artefatos `.next`/cache e tipos de regra `generic-api-key`, `cloudflare-api-key`, `jwt`, `openai-api-key` e `sentry-org-token`.
- Os 13 findings históricos estão em exemplos/documentação, fixtures ou scripts antigos. Serem históricos/sintéticos não prova revogação.
- Nenhum valor de segredo foi aberto ou emitido no relatório. O gate continua bloqueado por ausência de ownership, rotação e revogação formal.

## Correções acessíveis aplicadas

- `PageHeader` não mantém conteúdo focável dentro de `aria-hidden`.
- Cards de métricas do Dashboard e fila foram trocados de `<dl>` inválido com wrappers para lista semântica com `role=list/listitem`.
- O card móvel de documentos DDS deixou de usar `<dl>` com `<div>` direto.
- Dashboard, lista DDS e formulário DDS definem títulos explícitos em navegação client-side.
- `tsc --noEmit`, ESLint dos arquivos alterados e Stylelint de `globals.css`: `PASS`.

O rerun Axe autenticado pós-correção foi concluído: `0` violações `serious/critical` nos três viewports. O relatório continua sem certificação GO por causa do gate de secrets.

## Score recalculado

O score-base desta rodada permanece **76/100**; não foi inflado automaticamente pelo fechamento parcial. Provider externo e accessibility deixaram de ser blockers técnicos, mas secrets/readiness ainda impedem GO.

## Próxima evidência mínima

1. Security owner encerra a classificação/rotação dos 13 históricos, com prova redigida de revogação e novo scan history.
2. Frontend/QA mantém a suíte Axe e repete-a no staging definitivo se o provider/ambiente de release diferir da VPS isolada.

Até o gate de secrets ter evidência verificável de classificação, rotação/revogação e scan final, a certificação permanece `NO-GO`.

## Runtime verification addendum — VPS isolada — 2026-08-17

Execução realizada na VPS de testes `sgs-loadtest`, com dados sintéticos e sem
produção. O código foi publicado nos commits `6dd6fbf5` e `f0fe843d`.

| Prova | Resultado | Evidência redigida |
| --- | --- | --- |
| Migrations/runtime grants | PASS | `2` migrations aplicadas; `sgs_admin` com `LOGIN`, `sgs_rls_bypass` e grants mínimos em `forensic_trail_events`/`companies`; `sgs_app` com `bypassrls=false` e sem membership de bypass |
| Forensic/RLS | PASS | tenant A insere/lê; tenant B não lê A; contexto ausente rejeita; login persiste `LOGIN_SUCCESS` |
| Auth/DDS | PASS | CSRF `200`, login `201`, `/auth/me` `200`, people `200` com `11` registros sintéticos, DDS `200` |
| Provider/storage | PASS | presigned `201`, PUT `200`, complete `201`, SHA/magic bytes, namespace `documents/`, anônimo `403`, tamper `403` |
| Registry/PDF | PASS | download autorizado `200` com `%PDF-`, anônimo `403`, expiração `200 → 403`, cross-tenant `403` sem URL, fixture removido |
| Hygiene/health | PASS | bucket final com `0` objetos; DDS sintético pendente `0`; API healthy; health público `200`; endpoints protegidos sem credencial `401`; logs pós-correção sem erros de RLS |

Essa rodada fecha os blockers técnicos verificáveis do ambiente isolado. Ela
não substitui o fechamento formal do inventário Gitleaks histórico/worktree,
nem prova o provider Backblaze de staging/produção se ele diferir do MinIO de
teste. A decisão de release permanece `NO-GO` até o gate de secrets ter scan,
classificação e evidência de rotação/revogação.
