# Inventário de infraestrutura legada de testes — 2026-09-10

## Contrato aplicado

`CURRENT_ENVIRONMENT=PRE_PRODUCTION_QA` e `CURRENT_TEST_RUNTIME=HOSTINGER_CURRENT_VPS`.
Esta rodada não migra banco ou storage e não remove Vercel, Neon, Backblaze B2,
Cloudflare, GitHub, Redis ou qualquer componente atual do SGS. Testes automatizados
e seus guards permanecem no repositório.

## Resultado antes de qualquer remoção

```text
LEGACY_TEST_INFRA_DISCOVERED=YES
LEGACY_TEST_VPS_FOUND=YES (candidato documentado; estado remoto UNKNOWN)
LEGACY_STAGING_FOUND=NO (nenhum host separado comprovado; ocorrências são CI/schema temporário)
LEGACY_QA_RESOURCES_FOUND=YES (harnesses e Compose de teste; preservados como código de teste)
LEGACY_TEST_REFERENCES_FOUND=YES
SAFE_TO_REMOVE=NONE
UNKNOWN_RESOURCES=83.229.115.37 / api-loadtest.sgsseguranca.com.br / /opt/sgs-loadtest
CORE_SGS_RESOURCES_PROTECTED=Hostinger atual, Vercel, Neon, Backblaze B2, Cloudflare, GitHub, Redis, PostgreSQL, storage, backend, frontend e workers
```

## Evidência de runtime

| Recurso | Tipo | Estado observado | Classificação | Decisão |
|---|---|---|---|---|
| `179.198.107.5` / `api.sgsseguranca.com.br` | VPS Hostinger atual + API | `Test-NetConnection :22 = True`; `GET /health/public` respondeu `200` | `CURRENT_PREPROD_QA_INFRASTRUCTURE` | Preservar |
| `app.sgsseguranca.com.br` | Frontend atual | `GET /login` respondeu `200`; resposta servida por Vercel | `SGS_CORE_INFRASTRUCTURE` | Preservar |
| Neon PostgreSQL | Banco atual | Referenciado pelo contrato/env e runtime do backend | `SGS_CORE_INFRASTRUCTURE` / `DATA_DEPENDENCY` | Preservar |
| Backblaze B2 | Storage atual | Referenciado pelo adapter S3 e workflows de DR | `SGS_CORE_INFRASTRUCTURE` / `DATA_DEPENDENCY` | Preservar |
| Cloudflare | DNS/edge/Turnstile | Referenciado por DNS, headers e Turnstile | `SGS_CORE_INFRASTRUCTURE` | Preservar |
| GitHub Actions | CI/CD e gates | Workflows de testes, segurança, migrations e DR versionados | `SGS_CORE_INFRASTRUCTURE` | Preservar |
| `83.229.115.37` / `api-loadtest.sgsseguranca.com.br` | VPS separada de load test | DNS A ainda aponta para o IP; TCP/22 falhou e HTTPS `/health/public` expirou | `UNKNOWN` até prova de cancelamento, dependências e dados | Não remover |

## Evidência de repositório

| Referência | Uso observado | Classificação | Ação nesta fase |
|---|---|---|---|
| `infra/load-test/compose*.yml`, guards e scripts | Harness de teste com PostgreSQL/Redis/API sintéticos e fail-closed | `SGS_CORE_INFRASTRUCTURE` (código de teste protegido) | Preservar |
| `ops/test/**`, `tests/load/**`, `backend/test/load/**` | Jest/E2E/k6/storage e dados sintéticos | `SGS_CORE_INFRASTRUCTURE` (código de teste protegido) | Preservar |
| `infra/load-test/README.md` | Instruções operacionais apontam para a VPS separada | `LEGACY_TEST_REFERENCE_ONLY` | Atualizar para não indicar host remoto como runtime atual |
| `docs/deploy/INFRAESTRUTURA-ATUAL.md` seção Load test | Declara VPS separada como ambiente operacional atual | `LEGACY_TEST_REFERENCE_ONLY` | Atualizar; preservar evidência histórica |
| `ops/test/README.md` referências à VPS isolada | Runbook operacional de teste remoto | `LEGACY_TEST_REFERENCE_ONLY` | Atualizar para Hostinger atual/Compose local |
| `backend/README.md` seção “Deploy Vultr...” | Modelo operacional antigo | `LEGACY_TEST_REFERENCE_ONLY` | Marcar como histórico e apontar para Hostinger |
| `docs/auditoria/2026-08-13-loadtest-vs-producao.md` | Evidência histórica de campanhas | `LEGACY_TEST_REFERENCE_ONLY` | Preservar; não reescrever resultados históricos |
| `docs/deploy/coolify-vultr-backend-web-worker.md` | Runbook histórico de migração | `LEGACY_TEST_REFERENCE_ONLY` | Preservar com marcador histórico |
| `backend/scripts/start-isolated-load-env.ps1` | Inicializador local de teste isolado | `SGS_CORE_INFRASTRUCTURE` (código de teste) | Preservar |

## Comandos executados

```text
git fetch origin
git rev-parse origin/main
Test-NetConnection 83.229.115.37 -Port 22 -> False
Resolve-DnsName api-loadtest.sgsseguranca.com.br -> 83.229.115.37
curl.exe -I --max-time 10 https://api-loadtest.sgsseguranca.com.br/health/public -> timeout
Test-NetConnection 179.198.107.5 -Port 22 -> True
curl.exe -I --max-time 10 https://api.sgsseguranca.com.br/health/public -> 200 OK
curl.exe -I --max-time 10 https://app.sgsseguranca.com.br/login -> 200 OK
```

## Gate de remoção

Não há candidato com `CURRENTLY_ACTIVE=NO`, `USED_BY_CURRENT_SGS=NO`,
`UNIQUE_DATA_PRESENT=NO`, `DEPENDENCIES=NONE` e `SAFE_TO_REMOVE=YES` comprovados.
Portanto, nenhuma remoção remota, exclusão de secret, limpeza de volume/banco,
alteração DNS ou remoção de workflow está autorizada por evidência nesta rodada.

As mudanças seguintes ficam limitadas à documentação operacional que poderia
induzir uma nova execução contra a VPS legada; os relatórios históricos e o código
de teste continuam preservados.

## Verificação após a atualização segura

Comando de inspeção:

```text
git grep -n -i -E 'api-loadtest\.sgsseguranca\.com\.br|83\.229\.115\.37|/opt/sgs-loadtest|Vultr/Coolify|Vultr' -- ':!docs/auditoria/2026-08-13-loadtest-vs-producao.md' ':!docs/deploy/coolify-vultr-backend-web-worker.md'
```

Resultado: as ocorrências restantes estão limitadas a evidência histórica,
harnesses/guards de teste protegidos, scripts de execução configuráveis e
referências não operacionais. Não restou instrução operacional vigente que
indique a VPS legada como runtime atual. A ausência de remoção remota é
intencional: DNS ainda resolve para o candidato antigo, mas não há prova
auditável de cancelamento, ausência de dados exclusivos ou ausência de
dependências.

## Resultado final obrigatório

```text
LEGACY_TEST_INFRA_CLEANUP=PARTIAL
REMOVED_REMOTE_TEST_RESOURCES=NONE (recurso remoto antigo permanece UNKNOWN)
REMOVED_TEST_CONFIGS=NONE (harnesses e guards automatizados preservados)
REMOVED_TEST_SECRETS=NONE (nenhum segredo lido, exposto ou removido)
REMOVED_OBSOLETE_REFERENCES=docs/deploy/INFRAESTRUTURA-ATUAL.md; infra/load-test/README.md; ops/test/README.md; backend/README.md; MEMORY.md; exemplos e runbook de Redis/Alertmanager
CURRENT_HOSTINGER_VPS=RETAINED
VERCEL=RETAINED
NEON=RETAINED
BACKBLAZE_B2=RETAINED
CLOUDFLARE=RETAINED
GITHUB=RETAINED
DATABASE=RETAINED
STORAGE=RETAINED
DATA_LOSS=NO
CURRENT_ENVIRONMENT=PRE_PRODUCTION_QA
SEPARATE_TEST_INFRASTRUCTURE=NONE (nenhum runtime remoto separado autorizado; código de harness permanece)
REMAINING_LEGACY_TEST_REFERENCES=api-loadtest.sgsseguranca.com.br; 83.229.115.37; /opt/sgs-loadtest; docs históricos; guards e scripts de teste protegidos
BLOCKERS=estado remoto, dados exclusivos, dependências e controle do provedor da infraestrutura legada não são comprováveis nesta sessão; não há autorização/evidência para remoção
```

## Validação local do frontend

| Comando | Resultado observado |
|---|---|
| `npm ci` em `frontend/` | PASS — 1006 pacotes adicionados; audit embutido com `0 vulnerabilities` |
| `npm run lint` | PASS — permission imports, ESLint e Stylelint |
| `npx tsc --noEmit --pretty false` | PASS |
| `npm run test:ci` | PASS — 161 suítes/testes passados; 1 suíte e 2 testes skipped existentes |
| `npm run build` sem ambiente | BLOCKED pelo guard de `NEXT_PUBLIC_API_URL` ausente |
| build com `NEXT_PUBLIC_API_URL` e `NEXT_PUBLIC_APP_URL` públicos temporários | PASS — compilação, TypeScript, 91 páginas e otimização concluídos |
| `npm audit` | PASS — `0 vulnerabilities` |
| `npm run test:e2e:mobile` | BLOCKED antes do browser — executáveis Playwright Chromium/WebKit ausentes |
| `npx playwright install chromium webkit` | BLOCKED — CDN Playwright expirou; retry com timeout de 120 s também falhou |
| smoke Chromium com Chrome instalado, servidor local e 8 viewports | PASS — login, recuperação, overflow, controles e redirect do dashboard; porta `3100` liberada ao final |

Nenhum teste executou mutação contra API, banco, storage ou produção. O smoke
Chromium é evidência adicional de navegador; não substitui a cobertura WebKit,
que permanece bloqueada pelo download do executável.
