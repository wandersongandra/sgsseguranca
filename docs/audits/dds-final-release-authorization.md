# DDS — Final Release Authorization

Data: 2026-08-17. Escopo restrito aos três gates finais de autorização. Sem produção, commit, push ou deploy; nenhum segredo ou dado de produção foi aberto. A retirada administrativa do R2 legado está registrada abaixo.

> `HISTORICAL_EVIDENCE`: referências à VPS isolada abaixo descrevem uma rodada
> anterior e não autorizam reativação de infraestrutura remota separada.

## Veredito

**NO-GO.** Os três gates abaixo permanecem sem prova mínima de fechamento.

### Runtime closure update — VPS isolada

As linhas de provider externo e Accessibility abaixo são o snapshot anterior à execução. Nesta rodada, o provider MinIO S3-compatible privado passou upload `201/200/201`, hash/magic bytes, download autorizado `200/%PDF-`, anônimo/tamper `403`, cross-tenant `403` sem URL e expiração `200→403`, com limpeza final de `0` objetos. O Axe autenticado passou em `390x844`, `430x932` e `1440x900` com `0` violações `serious/critical`; teclado mobile passou `2/2`. O veredito permanece `NO-GO` somente pelo gate Secrets/Gitleaks, que ainda exige classificação, rotação/revogação e scan final.

| Gate | Evidência atual | Estado | Owner action | Prova mínima para reabrir |
| --- | --- | --- | --- | --- |
| Secrets / Gitleaks | Scan Git/history redigido: 13 findings (`curl-auth-header` 6, `generic-api-key` 4, `jwt` 3). Scan atual de `backend/src`, exemplos tracked, diff/protect e worktree após quarentena: 0. | **BLOCKED** | Security owner deve classificar cada root cause e revogar/rotacionar qualquer credencial plausível. | Relatório redigido com 13 findings, evidência de rotação/revogação e novo scan history sem findings aceito. |
| Provider externo | MinIO S3-compatible privado provisionado na VPS, com bucket/prefixo isolado e credenciais sintéticas. | **PASS runtime sintético** | Repetir no provider definitivo se o staging diferir da VPS isolada. | Upload/download, grant, IDOR, cross-tenant/site, tamper, expiração e limpeza passaram. |
| Accessibility / Axe | Login sintético funcional e matriz autenticada executada em 390x844, 430x932 e 1440x900. | **PASS runtime sintético** | Manter no CI e repetir após mudanças de tema/layout. | 0 `serious/critical` e teclado mobile 2/2. |

## Classificação redigida dos 13 findings históricos

Nenhum valor, token, hash ou fingerprint é exibido. A classificação abaixo é por causa raiz/path; “synthetic” e “example” não equivalem a revogação formal.

| Root cause | Regra | Localização redigida | Qtde. | Classificação | Fechamento |
| --- | --- | --- | ---: | --- | --- |
| RC-01 | `generic-api-key` | `backend/test/setup/test-env.ts` | 1 | Fixture de teste sintético provável | Owner de segurança confirma que não é credencial ativa; excluir/neutralizar e repetir scan. |
| RC-02 | `jwt` | `backend/test/critical/admin-routes-security.e2e-spec.ts` | 2 | Fixture de teste sintético provável | Confirmar assinatura/validade inexistente ou revogar qualquer valor plausível. |
| RC-03 | `generic-api-key` | `backend/.env.example` | 2 | Exemplo/documentação | Confirmar placeholders; se não forem placeholders, rotação imediata. |
| RC-04 | `jwt` | `.tmp_pdf_head.ps1` | 1 | Artefato temporário histórico | Remover o artefato e confirmar que nenhum token era utilizável. |
| RC-05 | `curl-auth-header` | `FIXAR_MIGRAÇÕES_RENDER.md`, `CHEAT_SHEET.md`, `GUIA_INTEGRACAO_MELHORIAS.md` | 5 | Documentação histórica não encerrada | Security/GitHub owner classifica, revoga/rotaciona quando plausível e registra evidência. |
| RC-06 | `generic-api-key` + `curl-auth-header` | `prompts/CLOUDFLARE_R2_CONFIGURADO.md` | 2 | Histórico relacionado a provider; não confirmado como sintético | Infra/storage + security owner confirmam status e revogam/rotacionam qualquer credencial. |
| **Total** |  |  | **13** |  |  |

Os 203 findings do inventário local foram movidos para quarentena recuperável fora do repositório; o scan atual do worktree retornou `0`. O histórico de 13 findings permanece pendente de ownership, classificação e revogação.

### Retirada do R2 legado

Após autorização explícita, `sgs-02` e `sgs-03` foram excluídos. Em `sgs-01`, a regra de retenção `governed-documents-365d` foi removida, os 71 objetos restantes foram apagados e o bucket foi excluído. Os buckets Cloudflare `site-sgs-seguranca-opennext-cache` e `wanderson-gandra-docs` foram preservados. Essa ação não revoga a credencial histórica; a rotação/revogação do token ainda exige owner com permissão de gerenciamento de tokens.

O owner informou em 2026-08-17 que o token histórico foi revogado. A informação foi registrada como atestado, sem valor secreto; falta anexar evidência redigida/ticket para converter `Verified Revoked: 0` em prova auditável.

### Resumo final de secrets

```text
Raw Source Findings: 0
Raw Tracked Example Findings: 0 (6 arquivos)
Raw Diff/Protect Findings: 0
Raw Worktree Findings: 0 (após quarentena recuperável)
Raw Historical Findings: 13
Unique Historical Root Causes: 6
Verified Active: 0 confirmados
Verified Revoked: 0
Historical Revoked: 0 comprovados
Synthetic Test Credentials: 3 ocorrências prováveis
Documentation Examples: 2 ocorrências
Env/Log/Cache/Build Artifacts: movidos para quarentena recuperável; scan atual 0
False Positives: 0 comprovados
Unknown Historical: 7 ocorrências documentais/provider-like
Unresolved High-Risk: YES
```

O scan histórico foi repetido nesta rodada com os mesmos 13 findings; source, seis exemplos tracked e diff/protect também foram repetidos com zero. Isso confirma o inventário, mas não substitui a etapa humana de revogação/rotação.

## Pacotes de handoff aos owners

### SECRET OWNER ACTION

```text
Owner: Security/GitHub
Credential classes: generic-api-key, jwt, curl-auth-header
Root IDs: RC-01 a RC-06
Risk: findings históricos plausíveis sem prova de validade, invalidez ou revogação
Required action: classificar cada root; identificar provider quando aplicável; rotacionar credencial plausível; revogar a antiga; verificar rejeição da antiga; remover artefatos locais seguros; corrigir origem de logging/injeção
Proof required: ticket/owner, fingerprint redigido ou referência segura, resultado de old-credential-invalid e scans source/tracked/worktree/history finais
```

### TEST STORAGE REQUEST

```text
Owner: Infraestrutura/Storage
Provider type: S3-compatible (adapter SGS existente; B2 é a referência operacional documentada)
Environment: TEST ONLY / VPS isolada
Required: isolated private bucket; isolated prefix; temporary least-privilege credentials; endpoint/region; signed URL capability; short TTL; HTTPS/TLS; encryption-at-rest evidence
Must NOT include: production bucket; customer objects; global/account-admin credentials
Proof required: application upload/download, anonymous LIST/GET denied, cross-tenant/site and IDOR denied, tamper denied, before/after TTL, replay behavior, revocation model and safe failure handling
```

### AXE OWNER ACTION

```text
Owner: Frontend/QA
Current dependency: none in the isolated test run
Required action: manter tenant/site/user sintéticos e repetir no staging definitivo quando aplicável
Must NOT include: disabled guards, arbitrary JWT, fake cookie/localStorage session or superadmin bypass
Proof required: Axe authenticated matrix at 390x844, 430x932 and 1440x900; zero Critical/Serious; keyboard, focus, dialogs, forms, signature and PDF control evidence
```

## Matriz final dos gates

| Gate | Previous | Final evidence | Result |
| --- | --- | --- | --- |
| Secrets | BLOCKED | 13 históricos confirmados; classificação/rotação formal incompleta; worktree atual 0 | **BLOCKED** |
| External Storage | PASS runtime sintético | MinIO privado com ACL, isolamento, expiração, tamper e limpeza comprovados | **PASS** |
| Accessibility | PASS runtime sintético | 3 viewports autenticados, 0 serious/critical e teclado 2/2 | **PASS** |

### Final storage matrix

```text
Provider previsto: S3-compatible; documentação operacional: Backblaze B2
Provider de teste ativo: MinIO S3-compatible privado
Private bucket / endpoint / region / prefix: PASS, prefixo isolado
Anonymous LIST / GET: DENY `403`
Official application upload/download: PASS `201/200/201`, download autorizado `%PDF-`
Cross-tenant / cross-site / file IDOR / object IDOR: PASS `403`/sem URL
Tamper / expiration / replay / revocation: PASS tamper `403`, TTL `200→403`, limpeza `0`
TLS / encryption / failure handling: executado no provider sintético privado
Application-level/provider controls: PASS runtime sintético; repetir se staging diferir
```

### Final accessibility matrix

```text
Login: PASS
Dashboard / DDS List / DDS form: PASS in `390x844`, `430x932`, `1440x900`
Critical: 0
Serious: 0
Moderate/Minor: não bloqueantes nesta matriz
Keyboard / Focus / Dialogs / Forms: teclado mobile `2/2` PASS
Cause of incompleteness: none in isolated runtime; staging repetition may remain
```

### Regression and smoke status

```text
Backend focused baseline: 98 PASS
Frontend closed-gate baseline: 31 PASS
Frontend final Jest regression: 154 suites executed; 872 PASS, 2 tests skipped, 1 suite skipped
Frontend typecheck: PASS
Targeted ESLint: PASS
Targeted Stylelint: PASS
git diff --check: PASS
Backend/frontend builds: PASS on prior closed-gate baseline; no source change in this closure round
Security smoke previously closed: PASS for tenant/site/RLS/mass-assignment/signature/PDF application controls
Final delta security smoke: PASS via CI backend/E2E critical/security scans
External-storage smoke: PASS MinIO sintético
Final authenticated Axe smoke: PASS 3/3 viewports
P0 OPEN: 0
P1 OPEN: 1 — unresolved release gates
P2/P3: existing accepted-risk/backlog items; not reopened
Recalculated current score: 151/200 = 75.5 -> 76/100; no gate gained points in this closure
```

## Gate de reabertura

O resultado só pode mudar para GO depois que os três owners anexarem as provas mínimas acima. Build, lint, testes unitários, configuração documentada ou VPS saudável isoladamente não substituem prova de segredo encerrado, provider externo funcional ou Axe autenticado completo.

Documentos relacionados: [dds-final-production-acceptance.md](dds-final-production-acceptance.md), [dds-security-matrix.md](dds-security-matrix.md), [dds-test-evidence.md](dds-test-evidence.md), [dds-production-readiness.md](dds-production-readiness.md) e [dds-release-unblock-final-3.md](dds-release-unblock-final-3.md).
