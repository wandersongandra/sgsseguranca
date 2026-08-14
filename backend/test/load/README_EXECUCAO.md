# README_EXECUCAO - benchmark auth (login + /auth/me)

## Emissão concorrente de APRs no teste local

O runner `test/load/apr-emit-batch.ts` emite APRs sintéticas em paralelo e
executa o fluxo completo por APR: criação, assinatura, aprovação, PDF final,
finalização e leitura de confirmação. Ele usa o `TestApp` com HTTP real dentro
do Nest, limite de concorrência e relatório opcional em JSON.

O runner é deliberadamente bloqueado fora do banco local `sst_test`. O bootstrap
reseta somente esse banco de teste para garantir perfis, usuários, empresa e
site sintéticos; não use esse comando com qualquer URL externa.

```powershell
cd backend
$env:NODE_ENV="test"
$env:E2E_PRESERVE_MIGRATED_SCHEMA="true"
$env:APR_BATCH_CONFIRM_TEST="true"
$env:APR_BATCH_BOOTSTRAP="true"
$env:APR_BATCH_TOTAL="10"
$env:APR_BATCH_CONCURRENCY="3"
$env:APR_BATCH_REPORT_FILE="temp/apr-batch-report.json"
npm run test:apr:batch
```

`APR_BATCH_TOTAL` aceita 1–100 APRs e `APR_BATCH_CONCURRENCY` aceita 1–20
workers. Os registros e PDFs permanecem no banco/storage local para inspeção;
o relatório lista IDs, status, tempos, chaves de PDF e hashes finais.

## Emissão no VPS de load-test

Para a VPS isolada, use `test/load/apr-emit-remote-batch.mjs` dentro do
container `api-loadtest`. Ele exige `APP_ENV=loadtest` e
`APP_LOADTEST_MARKER=sgs-loadtest`, usa somente as credenciais sintéticas do
`.env.loadtest` da VPS e não reseta o banco remoto. O runner aceita até 100
APRs, mas o padrão é `APR_REMOTE_CONCURRENCY=5`; a geração de PDF usa o pool
do Puppeteer e deve permanecer limitada para não degradar a API.

O rate limit por tenant do load-test é 60 requisições/minuto no plano STARTER.
Como o fluxo completo consome várias requisições por APR, lotes grandes devem
ser fracionados ou executados com um plano de teste explicitamente dimensionado;
não desative o guard de rate limit para acelerar a emissão.

Este pacote foi alinhado ao contrato real do backend:

- `POST /auth/login` com `cpf`, `password`, `turnstileToken?`
- resposta com `accessToken` (JSON)
- cookies `refresh_token` e `refresh_csrf`
- `GET /auth/me` com `Authorization: Bearer <token>`

Fontes: `src/auth/auth.controller.ts`, `src/auth/dto/login.dto.ts`,
`src/auth/dto/auth-response.dto.ts`, `src/users/users.service.ts`.

## Scripts disponíveis

- `test/load/login-smoke.js`
  - valida contrato e fluxo básico
- `test/load/login-load.js`
  - benchmark progressivo (rampa + hold opcional)
- `test/load/login-soak.js`
  - soak de 60 minutos (taxa constante)
- `test/load/import-login-users.ts`
  - importa/genera pool de usuários para benchmark (hash argon2)
- `test/load/build-auth-me-users.ts`
  - valida credenciais no fluxo real auth (`login + /auth/me`)
  - gera pool `auth-valid` para benchmark sem ruído de credencial inválida
- `test/load/build-dds-publish-users.ts`
  - valida credenciais com fluxo real DDS (login + `/auth/me` + create + publish)
  - gera pool "publish-valid" para eliminar falso negativo por permissão

Runbook completo Railway:

- `test/load/RAILWAY_AUTH_BENCHMARK_RUNBOOK.md`

## Pré-requisitos

- k6 instalado (ou Docker com imagem `grafana/k6`)
- ambiente de staging com domínio público
- massa de credenciais de benchmark (não repetir 40 usuários)

## 1) Importar usuários de benchmark (opcional)

No diretório `backend`:

```powershell
# valida sem gravar
$env:IMPORT_USERS_FILE="test/load/fixtures/users-batch-2026-03-28.csv"
$env:IMPORT_USERS_AUTOFIX_INVALID_CPF="true"
npm run loadtest:users:import:dry

# grava no banco
npm run loadtest:users:import
```

Para ampliar o pool:

```powershell
$env:IMPORT_USERS_MULTIPLIER="3"
npm run loadtest:users:import
```

Saída:

- `test/load/fixtures/login-users.generated.json`

## 2) Smoke

Opcional (recomendado): montar pool `auth-valid` antes do smoke.

```powershell
$env:BASE_URL="http://localhost:3011"
$env:LOGIN_USERS_FILE="test/load/fixtures/login-users.local.generated.json"
$env:AUTH_VALID_USERS_OUTPUT_FILE="test/load/fixtures/login-users.auth.valid.local.generated.json"
$env:MIN_VALID_USERS="10"
npm run loadtest:auth:users:build
```

```powershell
$env:BASE_URL="https://seu-staging.up.railway.app"
$env:LOGIN_USERS_FILE="test/load/fixtures/login-users.auth.valid.local.generated.json"
$env:CALL_AUTH_ME="true"
$env:SEND_COMPANY_HEADER="false"
$env:CLIENT_FINGERPRINT_MODE="per-iteration"
$env:EXPECT_REFRESH_COOKIES="true"
npm run loadtest:login:smoke
```

## 3) Progressivo

```powershell
$env:BASE_URL="https://seu-staging.up.railway.app"
$env:LOGIN_USERS_FILE="test/load/fixtures/login-users.generated.json"
$env:CALL_AUTH_ME="true"
$env:SEND_COMPANY_HEADER="false"
$env:CLIENT_FINGERPRINT_MODE="per-iteration"
$env:EXPECT_REFRESH_COOKIES="true"
$env:DYNAMIC_POOL_GUARD="true"
$env:TARGET_LOGINS_PER_USER="300"
npm run loadtest:login:progressive
```

## 4) Soak 60 minutos

```powershell
$env:BASE_URL="https://seu-staging.up.railway.app"
$env:LOGIN_USERS_FILE="test/load/fixtures/login-users.generated.json"
$env:CALL_AUTH_ME="true"
$env:SEND_COMPANY_HEADER="false"
$env:CLIENT_FINGERPRINT_MODE="per-iteration"
$env:EXPECT_REFRESH_COOKIES="true"
$env:SOAK_RATE="75"
$env:SOAK_DURATION="60m"
$env:DYNAMIC_POOL_GUARD="true"
$env:TARGET_LOGINS_PER_USER="300"
npm run loadtest:login:soak
```

## 5) Execução via Docker (sem k6 local)

```powershell
docker run --rm -i -v "${PWD}:/work" -w /work grafana/k6 run `
  -e BASE_URL="https://seu-staging.up.railway.app" `
  -e LOGIN_USERS_FILE="test/load/fixtures/login-users.generated.json" `
  -e CALL_AUTH_ME="true" `
  -e SEND_COMPANY_HEADER="false" `
  -e CLIENT_FINGERPRINT_MODE="per-iteration" `
  -e EXPECT_REFRESH_COOKIES="true" `
  test/load/login-smoke.js
```

## 6) Saídas geradas

- `test/load/login-smoke-summary.json`
- `test/load/login-load-summary.json`
- `test/load/login-soak-summary.json`
- `test/load/login-smoke-report.txt`
- `test/load/login-load-report.txt`
- `test/load/login-soak-report.txt`

## 7) Guardrails

- Muito `429` normalmente indica anti-abuso/rate-limit.
- `401/403` no `/auth/me` em cascata sugere churn/sessão/tenant mismatch.
- Se `http_req_failed > 1%` com `p95` alto, o patamar já está degradando.
- Sempre correlacionar com CPU/RAM/restarts/logs no Railway.

## 8) DDS - benchmark de emissão (local/staging)

Pré-requisito: ter credenciais no arquivo `LOGIN_USERS_FILE`.

### 8.1 Gerar pool "publish-valid"

No diretório `backend`:

```powershell
$env:BASE_URL="http://localhost:3001"
$env:LOGIN_USERS_FILE="test/load/fixtures/login-users.120.json"
$env:DDS_VALID_USERS_OUTPUT_FILE="test/load/fixtures/dds-users.publish.valid.local.generated.json"
$env:MIN_VALID_USERS="10"
npm run loadtest:dds:users:build
```

### 8.2 Smoke DDS

```powershell
$env:BASE_URL="http://localhost:3001"
$env:TEST_PROFILE="smoke"
$env:LOGIN_MODE="per_vu"
$env:PREFER_AUTH_ME="true"
$env:REQUIRE_STORAGE="false"
$env:K6_USERS_JSON=(Get-Content "test/load/fixtures/dds-users.publish.valid.local.generated.json" -Raw)
npm run loadtest:dds:smoke
```

### 8.3 Progressivo DDS

```powershell
$env:BASE_URL="http://localhost:3001"
$env:TEST_PROFILE="progressive"
$env:LOGIN_MODE="per_vu"
$env:PREFER_AUTH_ME="true"
$env:REQUIRE_STORAGE="false"
$env:K6_USERS_JSON=(Get-Content "test/load/fixtures/dds-users.publish.valid.local.generated.json" -Raw)
npm run loadtest:dds:progressive
```

### 8.4 Soak DDS (60 minutos)

```powershell
$env:BASE_URL="http://localhost:3001"
$env:TEST_PROFILE="soak60"
$env:SOAK_DURATION="60m"
$env:SOAK_VUS="4"
$env:LOGIN_MODE="per_vu"
$env:PREFER_AUTH_ME="true"
$env:REQUIRE_STORAGE="false"
$env:K6_USERS_JSON=(Get-Content "test/load/fixtures/dds-users.publish.valid.local.generated.json" -Raw)
npm run loadtest:dds:soak
```

## 9) Emissão rápida de DDS (para caçar bugs) — 50 DDSs

Script TypeScript simples (um único usuário autenticado) para emitir N DDSs rapidamente, fazendo:

- POST /dds (create)
- PATCH /dds/:id/status → publicado
- POST /dds/:id/file (PDF mínimo)

Útil para:

- Validar fluxo completo de emissão antes de release
- Pegar erros de validação, RLS, storage, CSRF, rate-limit, status machine etc.
- Testes manuais de 20~200 DDSs

### Como rodar (PowerShell)

```powershell
cd backend

# Configurar credenciais (use um TST / ADMIN_EMPRESA / SUPERVISOR)
$env:BASE_URL="http://localhost:3001"
$env:DDS_TEST_CPF="00000000000"          # 11 dígitos, sem máscara
$env:DDS_TEST_PASSWORD="sua-senha-aqui"

# Opcional: MFA
# $env:DDS_TEST_MFA_CODE="123456"
# $env:DDS_TEST_MFA_SECRET="base32secret..."   # para gerar TOTP automaticamente

# Quantidade (padrão 50)
$env:DDS_EMIT_COUNT="50"

npm run loadtest:dds:emit-50
```

Se der erro de CSRF/login/MFA, o script imprime a causa claramente.

O script continua executando todos os 50 e no final reporta quantos falharam + detalhes da primeira linha do erro de cada um.

Exemplos de falhas que ele ajuda a pegar:

- 403 no publish (role/permissão)
- Erro de site_id ou facilitador_id não pertencendo ao tenant
- Problemas no attach de PDF (tamanho, inspeção ClamAV, storage)
- Rate limiting / throttle por tenant
- Problemas de CSRF ou header x-company-id
- Erros de data / validação de DTO

### Dicas

- Rode contra `localhost` com `npm run start:dev` no backend.
- Para rodar contra staging, ajuste `BASE_URL`.
- Se quiser rodar só 5 para depurar: `$env:DDS_EMIT_COUNT="5"`
- Após rodar, verifique no dashboard ou listagem de DDSs da empresa que os registros apareceram corretamente.

## 10) Emissão em lote com múltiplos usuários (carga real)

Script `dds-emit-batch.ts` para gerar **muito mais DDS** usando um pool de usuários válidos.

Características:
- Carrega usuários de `dds-users.publish.valid.*.json` (ou qualquer arquivo com cpf/password/companyId/siteId)
- Cada usuário faz login independente (com CSRF corrigido)
- Suporta concorrência (padrão 6)
- Total configurável (padrão 200)
- Reutiliza usuários em round-robin
- Foco em create + publicar (o fluxo principal de emissão)

### Preparação de usuários (recomendado)

```powershell
cd backend
$env:BASE_URL="http://localhost:3001"
$env:LOGIN_USERS_FILE="test/load/fixtures/login-users.120.json"
$env:DDS_VALID_USERS_OUTPUT_FILE="test/load/fixtures/dds-users.publish.valid.local.generated.json"
$env:MIN_VALID_USERS="10"
npm run loadtest:dds:users:build
```

Isso gera um pool validado (create + publish permitido).

### Como rodar carga maior

```powershell
cd backend

$env:BASE_URL="http://localhost:3001"
$env:DDS_USERS_FILE="test/load/fixtures/dds-users.publish.valid.local.generated.json"

# Quantidade total de DDS
$env:DDS_BATCH_TOTAL="300"

# Quantos em paralelo (cuidado com rate limit / DB)
$env:DDS_BATCH_CONCURRENCY="8"

npm run loadtest:dds:emit-batch
```

Exemplos úteis:

- Carga moderada: `DDS_BATCH_TOTAL=200` + `CONCURRENCY=5`
- Carga pesada: `DDS_BATCH_TOTAL=800` + `CONCURRENCY=10` (se o pool tiver usuários suficientes)
- Teste rápido com poucos usuários: use o arquivo com 5-10 usuários e alto TOTAL

O script reporta:
- Sucessos x falhas
- Tempo total
- Amostra das falhas com motivo

Erros comuns que ele pega em escala:
- Concorrência / locks em status ou approval
- Rate limit por tenant
- Problemas de RLS / company isolation quando usuários de empresas diferentes
- Lentidão em publish (DB/Redis)
- Validações de site/facilitador/participantes em massa

### Dicas para mais carga

- Gere um pool maior rodando o builder com `login-users.120.json` ou mais.
- Monitore o backend (logs, CPU, conexões DB) durante a execução.
- Se quiser também PDF final, você precisará completar o fluxo de aprovação (inicializar + aprovar com PIN).
- Para testes de carga mais realistas (com ramp, think time etc), use os scripts k6 (`loadtest:dds:*`).

Se quiser, posso ajustar o script para:
- Gerar automaticamente mais usuários
- Incluir fluxo completo de aprovação + PDF
- Exportar relatório detalhado por usuário
- Adicionar delays aleatórios entre criações

É só pedir!
```
