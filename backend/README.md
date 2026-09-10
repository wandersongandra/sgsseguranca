# Backend API

Backend em NestJS para o SGS, Sistema de Gestão de Segurança.

## Requisitos

- Node.js 20+
- PostgreSQL
- Redis

## Instalação

```bash
npm install
```

## Execução

```bash
# desenvolvimento
npm run start:dev

# produção (build já gerado)
npm run start:prod
```

## Build

```bash
npm run build
```

## Testes

```bash
npm run test
npm run test:e2e
npm run test:cov
```

## Migrações de Banco

```bash
npm run migration:run
npm run migration:revert
npm run release:migrate
npm run ci:migration:check
```

## Variáveis de ambiente

Use `backend/.env.example` como base.

Variáveis críticas de produção:

- `JWT_SECRET` (mínimo 64 caracteres)
- `ENCRYPTION_KEY` (mínimo 32 caracteres)
- `FRONTEND_URL`
- `DATABASE_URL`
- `REDIS_AUTH_URL`, `REDIS_CACHE_URL` e `REDIS_QUEUE_URL`
- `REDIS_URL` apenas como compatibilidade legada, se algum script ainda exigir
- Se houver apenas uma instância Redis, repita a mesma URL nas três variáveis.
- `GOOGLE_OAUTH_ENABLED` e `AZURE_OAUTH_ENABLED` como `true` apenas se OAuth estiver configurado
- `ACCESS_TOKEN_TTL` e `REFRESH_TOKEN_TTL_DAYS`
- `MAX_ACTIVE_SESSIONS_PER_USER`
- `PASSWORD_MIN_LENGTH` e `BCRYPT_SALT_ROUNDS`
- `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS`
- `CACHE_TTL_SECONDS`
- `BACKUP_SECRET_KEY`

## Segurança

- `DB_SYNC` deve permanecer `false` em produção.
- `ALLOW_DB_SYNC_IN_PROD` só deve ser `true` em operação controlada.
- `REQUIRE_NO_PENDING_MIGRATIONS=true` bloqueia startup em produção se houver migration pendente.
- Swagger é habilitado apenas fora de produção.
- `DATABASE_URL` e `REDIS_AUTH_URL`/`REDIS_CACHE_URL`/`REDIS_QUEUE_URL` não podem usar placeholders (ex.: `host`, `base`, `abc`, `${{...}}`).
- Política de senha forte é aplicada em criação/edição/troca de senha.
- Sessões simultâneas são limitadas por `MAX_ACTIVE_SESSIONS_PER_USER` (tokens antigos são revogados automaticamente).
- Endpoint de backup (`POST /compliance/backup-log`) aceita `x-backup-secret` e faz comparação em tempo constante.

## Observabilidade

- Health checks reais:
  - `GET /health/public` para liveness do web
  - `GET /health` para prontidão do web
- `x-request-id` é retornado nas respostas para correlação.
- Logs do backend saem em JSON estruturado no stdout/stderr.
- New Relic APM é opcional:
  - habilitar com `NEW_RELIC_ENABLED=true`
  - configurar `NEW_RELIC_LICENSE_KEY` e `NEW_RELIC_APP_NAME`
- OpenTelemetry é opcional:
  - habilitar com `OTEL_ENABLED=true`
  - exporter Prometheus usa `PROMETHEUS_PORT`
  - tracing usa `JAEGER_ENDPOINT`
- Sentry é opcional:
  - instalar manualmente: `npm i @sentry/node`
  - configurar: `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`
- Sem `OTEL_ENABLED=true`, o sistema continua funcional, mas não exporta métricas/traces.

## Deploy Seguro (Migrations)

Fluxo recomendado em produção:

1. Aplicar migration pelo job separado antes de subir nova versão:
`npm run release:migrate`
2. Subir aplicação:
`npm run start:web`
3. Subir worker separadamente:
`npm run start:worker`
4. Habilitar proteção de startup:
`REQUIRE_NO_PENDING_MIGRATIONS=true`

## Arquitetura legada (histórico; não usar como runbook)

O modelo abaixo foi usado antes da consolidação na Hostinger e permanece somente
como referência histórica. Para o ambiente atual, use
`docs/deploy/hostinger-coolify-infra-atual.md` e
`docs/deploy/INFRAESTRUTURA-ATUAL.md`.

Modelo histórico:

- backend continua em NestJS
- banco em Neon Postgres com URL direta enquanto RLS depender de contexto de sessao
- web e worker no Vultr/Coolify como servicos separados
- Redis em provedor externo com tres URLs lógicas
- storage oficial em Backblaze B2 via API S3 compativel

Comandos esperados no Vultr/Coolify:

- `backend-web`
  - build: `npm ci && npm run build`
  - start: `npm run start:web`
- `backend-worker`
  - build: `npm ci && npm run build`
  - start: `npm run start:worker`

Variaveis criticas em ambos os servicos:

- `DATABASE_URL` (Neon direta da role runtime, com `sslmode=require`)
- `DATABASE_SSL=true`
- `DATABASE_SSL_ALLOW_INSECURE=false`
- `REDIS_AUTH_URL`, `REDIS_CACHE_URL`, `REDIS_QUEUE_URL`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `VALIDATION_TOKEN_SECRET`
- `CORS_ALLOWED_ORIGINS`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_S3_BUCKET` / `AWS_BUCKET_NAME`
- `AWS_S3_ENDPOINT` / `AWS_ENDPOINT` (Backblaze B2 S3 compativel)

Runbook histórico:

- `docs/deploy/coolify-vultr-backend-web-worker.md`

## Etapas 5, 6 e 7

- Etapa 5 (Hardening API/Auth):
  - Política forte de senha com validação server-side.
  - Limite de sessões simultâneas por usuário.
  - Segredo de backup por header com comparação segura.
- Etapa 6 (Escala/Performance):
  - Pool de conexões do Postgres configurável por ambiente.
  - Cache TTL configurável por ambiente.
  - Thresholds de monitoramento configuráveis por ambiente.
- Etapa 7 (Backup/DR):
  - Runbook operacional em `backend/OPERATIONS_RUNBOOK.md`.
  - Script de prontidão de disaster recovery: `npm run ops:dr:check`.

## Operação de Security Hardening

- Runbook unificado: `backend/docs/security-hardening-operations.md`
- Runbook detalhado D-1 / D-Day / D+1: `backend/docs/security-hardening-runbook-d1-dday-d1.md`
- Checklist curto para war-room: `backend/docs/security-hardening-war-room-checklist.md`
- Template Jira/Linear: `backend/docs/security-hardening-ticket-template.md`
- Baseline operacional: `npm run security:phase0:baseline`
