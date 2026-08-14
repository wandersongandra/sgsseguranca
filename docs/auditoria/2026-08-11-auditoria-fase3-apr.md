# SGS APR — Auditoria de Segurança Fase 3

Data: 2026-08-11
Escopo: minimização de dados, evidências/PDF, fila offline, integridade documental/assinaturas e trilha forense.
Veredito: **APR INTEGRITY PARTIALLY VERIFIED**

## Executive Summary

| Domínio | Resultado | Evidência |
|---|---|---|
| Data minimization | PASS (projeção APR) | `AprResponseDto` agora usa resumos de usuário/empresa/obra; teste de ausência de email, CNPJ e permissões. |
| Evidence/PDF exposure | PASS (código) | Evidence API não serializa chaves, GPS, device/IP ou EXIF; acesso PDF não serializa `fileKey`/`folderPath` e informa `url`, nome, tipo e expiração. |
| Offline isolation | PASS (unitário) | Item carrega actor, company, obra e `sessionGeneration`; replay incompatível é descartado. |
| Document immutability | PARTIAL | APR assinada não aceita update nem upload de evidência; workflow/PDF final permanecem protegidos. Storage externo não foi validado. |
| Signature integrity | PARTIAL | Signatário e timestamp são server-side e o payload é canônico, mas o binding APR usa estado/versão, não snapshot/hash completo do conteúdo. |
| Audit integrity | PARTIAL | Eventos e forensic trail existem, mas `addLog` engole falhas e criação de APR registra em fire-and-forget; há janela de lacuna forense. |

## DTO Exposure Matrix

| Endpoint/campo | UI usa? | Sensível/interno | Ação |
|---|---:|---|---|
| `GET /aprs/:id` `company` | razão social | CNPJ, contato, trial/status de conta | Removidos via `AprCompanySummaryResponseDto` (`id`, `razao_social`). |
| `GET /aprs/:id` usuários | nome, função, id | email, sites, perfil, permissões, status de acesso | Removidos via `AprUserSummaryResponseDto`. |
| `GET /aprs/:id` obra | nome/id | endereço, cidade, estado, flags e timestamps | Removidos via `AprSiteSummaryResponseDto`. |
| `GET /aprs/:id/evidence` storage | URL temporária | `file_key`, watermark key | Não serializados; permanecem somente no servidor para emissão de URL. |
| Evidence metadata | nome, hash, datas, ordem, URLs | GPS, accuracy, device hash, IP, EXIF, tamanho/MIME, watermark text | Mantidos server-side; DTO público minimizado. |
| `GET /aprs/:id/pdf` e geração | URL, nome | `fileKey`, `folderPath` | Removidos; retorno inclui `contentType` e `expiresAt`. |

## Offline Threat Matrix

| Cenário | Esperado | Controle | Status |
|---|---|---|---|
| A/company A/site A1 → logout → B | não replayar | actor + company + generation | FIXED + TESTED |
| mesmo tenant, usuário A → usuário B | não replayar | actor + generation | FIXED + TESTED |
| troca de empresa sem logout | não replayar | rotação imediata da generation em `selectedTenantStore` | FIXED + TESTED (unitário de generation/contexto) |
| troca de obra | não executar em outra obra | `siteId` opcional e validação no replay | FIXED (código) |
| item legado sem binding | não executar silenciosamente | `isOfflineBindingCompatible` rejeita/removerá o item | FIXED (código) |

O backend continua sendo a barreira final: a fila apenas chama a API autenticada, que revalida tenant/site/RBAC.

## Document Integrity Model

```text
APR (id, versao, parent_apr_id)
  ↓
approval steps / status server-side
  ↓
signature canonical payload (APR id, status, versao, updated_at, stateHash)
  ↓
SHA-256 do payload canônico + timestamp token server-side
  ↓
PDF final governado + hash/registro no document registry
  ↓
storage key determinística (imutabilidade física não verificável sem storage real)
```

O `stateHash` atual cobre identidade, referência, status, versão e `updated_at`; não é um hash dos campos completos, riscos, controles, participantes e anexos da APR.

## Signature Integrity

| Pergunta | Resposta |
|---|---|
| Signatário deriva da sessão? | SIM — JWT é a identidade efetiva; DTO `user_id` não substitui o ator. |
| Timestamp server-side? | SIM — `signedAt` e timestamp token são gerados no backend. |
| Assinatura aponta para versão? | SIM, indiretamente — `versao` entra no binding; não há FK explícita `apr_version_id`. |
| Existe hash do conteúdo completo? | NÃO CONFIRMADO / efetivamente NÃO para o snapshot completo; existe hash do estado canônico reduzido. |
| Hash calculado server-side? | SIM. |
| Conteúdo canônico? | SIM para o payload de prova (ordenação recursiva); conteúdo APR completo não é incluído. |
| APR pode mudar após assinatura? | NÃO nos caminhos verificados: update bloqueado e upload de evidência bloqueado. |
| Recursos filhos podem mudar? | Evidência bloqueada após assinatura; não foram encontrados controllers filhos APR adicionais. |
| PDF final pode ser sobrescrito? | INCONCLUSIVO — geração é bloqueada quando já existe, mas ACL/versionamento do storage não foi testado. |
| Nova versão copia assinatura? | NÃO observado; nova entidade/revisão usa novo documento e não copia assinaturas. |

**DECISÃO DE ARQUITETURA/NEGÓCIO NECESSÁRIA:** decidir se a assinatura precisa provar o snapshot integral da APR. Se sim, criar versão de canonicalização + `content_hash`/snapshot server-side e migration compatível, sem atribuir prova retroativa a assinaturas legadas.

## Audit Trail Matrix

| Ação | Actor | Timestamp | Old/New ou hash | Imutabilidade | Resultado |
|---|---|---|---|---|---|
| create/update | usuário derivado do contexto | DB/entity | metadata de trace e versão | append-only por serviço | registrado; criação é assíncrona |
| approve/reject/finalize | JWT + IP/role | backend | status anterior/novo no forensic trail | mesma transação para workflow | implementado |
| sign | JWT efetivo | backend | canonical payload hash/evidence hash | assinatura soft-delete | implementado |
| evidence upload | JWT | backend | hash SHA-256 e metadata de auditoria | log append | implementado |
| reopen/delete/new-version | rota/service | backend | logs/forensic events | sem edição pelo usuário | cobertura E2E pendente |

Limite: `AprsService.addLog` captura e engole erro de persistência; criação usa `void this.addLog(...)`. Isso pode deixar mutação confirmada sem evento APR, embora o forensic interceptor/workflow registre eventos críticos.

## Findings

| ID | Severidade | Área | Finding | Status |
|---|---|---|---|---|
| F3-DTO-01 | MÉDIO | API3/CWE-200 | DTO genérico expunha PII/RBAC de Company/User/Site. | FIXED + TESTED |
| F3-EVID-01 | MÉDIO | LGPD/CWE-200 | Evidence response entregava storage keys, GPS, device/IP/EXIF e MIME/tamanho sem uso pela UI. | FIXED + TESTED |
| F3-PDF-01 | MÉDIO | Storage exposure | PDF access entregava `fileKey`/`folderPath`. | FIXED + TESTED |
| F3-OFF-01 | ALTO | Offline/BOLA | Fila não possuía binding forte a ator/tenant/site/sessão. | FIXED + TESTED |
| F3-SIG-01 | ALTO | Integridade | Prova de assinatura não inclui hash do conteúdo APR completo. | OPEN — decisão arquitetural necessária |
| F3-IMM-01 | MÉDIO | Imutabilidade | Update e evidência após assinatura permitiam risco de divergência em caminhos não protegidos. | FIXED nos caminhos verificados + TESTED |
| F3-AUD-01 | MÉDIO | Forense | Falha de log pode ser suprimida; create é fire-and-forget. | OPEN / hardening recomendado |

## Patches

- `backend/src/modules/aprs/dto/apr-response.dto.ts`: projeções mínimas para relações APR.
- `backend/src/modules/aprs/services/aprs-evidence.service.ts`: DTO público mínimo e bloqueio de upload após assinatura.
- `backend/src/modules/aprs/aprs.service.ts` e `services/aprs-pdf.service.ts`: PDF sem chaves internas; bloqueio de update após assinatura.
- `frontend/src/lib/sessionStore.ts`, `auth-session-state.ts`, `selectedTenantStore.ts`: geração efêmera por sessão/troca de empresa.
- `frontend/src/lib/offline-sync.ts`: binding e validação antes do replay.
- Testes: `apr-response.dto.spec.ts`, `offline-sync.test.ts`, `aprs-evidence.service.spec.ts`.

## Tests

- Backend APR service + evidence: **84 passed**.
- Backend PDF service: **7 passed**.
- DTO minimization: **1 passed**.
- Frontend offline isolation: **6 passed**.
- Frontend typecheck: **pass** (`npx tsc --noEmit`).
- Backend typecheck: **pass** (`npx tsc --noEmit`).
- E2E: **não executável neste ambiente** — Docker/Postgres/Redis indisponíveis; suites críticas permanecem skipadas. O seed E2E existente também não cobre a matriz A1/A2 de obras.
- Build/lint: não usados como evidência de segurança nesta rodada; devem ser executados no CI após reconciliar o worktree já sujo.

## Residual Risks / Boundaries

- **Frontend boundary:** recebe summaries, hashes, datas e URLs temporárias; metadados forenses ficam server-side.
- **API/auth boundary:** escopo tenant/site e autorização backend continuam obrigatórios no replay.
- **Signature boundary:** autenticação e hash do payload são fortes, mas o conteúdo integral da APR ainda não está criptograficamente comprometido.
- **Storage boundary:** TTL da URL é 3600 s; ACL, logs de proxy e versionamento/WORM do storage não foram verificados.
- **Contrato OpenAPI:** o DTO governado compartilhado ainda documenta `fileKey`/`folderPath` para módulos legados; o runtime APR não os retorna. Recomenda-se regenerar/definir schema específico APR para evitar contrato permissivo.
- **Audit boundary:** eventos críticos existem, porém falhas de `AprLog` podem gerar lacuna.
- **Production/E2E:** sem infraestrutura local não há prova de banco/RLS, concorrência, storage real ou fluxos cross-site.
