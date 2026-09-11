# Env Reference — SGS Segurança

> Referência rápida das ~400 variáveis de ambiente organizadas por categoria.
> Fonte oficial: `backend/.env.example` (403 linhas).

---

## Core

| Variável | Obrigatório | Default | Descrição |
|----------|-------------|---------|-----------|
| `NODE_ENV` | Sim | `development` | development / production / test |
| `PORT` | Não | `3001` | Porta da API |
| `API_PUBLIC_URL` | Sim (prod) | — | URL pública da API |
| `UV_THREADPOOL_SIZE` | Não | `16` | Thread pool libuv |

---

## Database

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `DATABASE_URL` | Sim (prod) | Neon direct (sem `-pooler`), `sslmode=require` |
| `DATABASE_MIGRATION_URL` | Sim (prod) | Role owner para DDL |
| `DATABASE_REPLICA_URL` | Não | Read replica |
| `DATABASE_SSL` | Sim (prod) | `true` em produção |
| `DATABASE_SSL_ALLOW_INSECURE` | Não | `false` em produção |
| `DATABASE_SSL_CA` | Não | CA certificate base64 |
| `DB_APPLICATION_NAME_WEB` | Não | `api_web` |
| `DB_APPLICATION_NAME_WORKER` | Não | `api_worker` |

**Fallbacks aceitos:** `DATABASE_DIRECT_URL`, `DATABASE_PUBLIC_URL`, `URL_DO_BANCO_DE_DADOS`

---

## Redis

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `REDIS_AUTH_URL` | Sim (prod) | Sessões, refresh tokens |
| `REDIS_RATE_LIMIT_URL` | Sim (prod) | Rate limiting e idempotência; política `noeviction` |
| `REDIS_CACHE_URL` | Sim (prod) | Cache de dashboard, RBAC |
| `REDIS_QUEUE_URL` | Sim (prod) | BullMQ job queues |
| `REDIS_<TIER>_HOST/PORT/USERNAME/PASSWORD` | Alternativa | Configuração separada quando o provedor não entrega URL completa |
| `REDIS_URL` | Não | Legado (compatibilidade) |
| `REDIS_DISABLED` | Não | `false` — modo degradado |
| `REDIS_FAIL_OPEN` | Não | `false` em produção |
| `REDIS_ALLOW_INSECURE_INTERNAL` | Não | Dispensa exigência de TLS quando o Redis remoto está na mesma rede Docker interna da VPS (tráfego nunca sai da máquina). Senha continua obrigatória. Ver `ops/docker/redis/` e `docs/deploy/redis-hardening-rollout.md` |

---

## JWT / Auth

| Variável | Obrigatório | Default | Descrição |
|----------|-------------|---------|-----------|
| `JWT_SECRET` | Sim | — | **Min 64 chars em produção.** Gere com `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | Sim | — | **Min 64 chars em produção, diferente de `JWT_SECRET`.** Gere com `openssl rand -hex 32` |
| `JWT_ISSUER` | Sim (prod) | — | **Obrigatório em produção.** URL pública da API. Ex: `https://api.seu-dominio.com.br` |
| `JWT_AUDIENCE` | Sim (prod) | — | **Obrigatório em produção.** Identificador do app. Ex: `sgs-app` |
| `ACCESS_TOKEN_TTL` | Não | `15m` | |
| `REFRESH_TOKEN_TTL` | Não | `30d` | |
| `REFRESH_BINDING` | Não | `none` | `ua` para vincular a User-Agent |
| `LEGACY_PASSWORD_AUTH_ENABLED` | Não | `true` | |


---

## MFA

| Variável | Obrigatório | Default | Descrição |
|----------|-------------|---------|-----------|
| `MFA_ENABLED` | Não | `true` | |
| `MFA_ISSUER` | Não | `SGS Seguranca` | |
| `MFA_TOTP_ENCRYPTION_KEY` | Sim (prod) | — | 32 bytes |
| `ADMIN_GERAL_MFA_REQUIRED` | Não | `true` | **Obrigatório em produção** |

---

## Field Encryption

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `FIELD_ENCRYPTION_ENABLED` | Sim (prod) | `true` em produção |
| `FIELD_ENCRYPTION_KEY` | Sim (prod) | 32 bytes (64 hex / 32 UTF-8 / base64) |
| `FIELD_ENCRYPTION_HASH_KEY` | Sim (prod) | Chave HMAC para lookup de CPF |
| `SECURITY_AUDIT_HMAC_KEY` | Sim (prod) | Chave exclusiva de 32+ caracteres para pseudônimos em logs; não reutilizar outras chaves |
| `IDEMPOTENCY_TTL_SECONDS` | Não | `3600`; intervalo permitido de 60 a 86400 segundos |
| `IDEMPOTENCY_MAX_RESPONSE_BYTES` | Não | `65536`; respostas maiores não são copiadas para Redis nem reexecutadas |
| `IDEMPOTENCY_MAX_KEYS_PER_SCOPE` | Não | `100`; quota por tenant e usuário dentro do TTL |

---

## Rate Limiting

| Variável | Default | Descrição |
|----------|---------|-----------|
| `THROTTLER_ENABLED` | `true` | |
| `THROTTLER_AUTH_LIMIT` | `5` | /min — login |
| `THROTTLER_PUBLIC_LIMIT` | `10` | /min — rotas públicas |
| `THROTTLER_API_LIMIT` | `100` | /min — API geral |
| `THROTTLER_DASHBOARD_LIMIT` | `50` | /min — dashboard |
| `THROTTLER_WINDOW_MS` | `60000` | Janela de 60s |
| `THROTTLER_FAIL_CLOSED_AUTH_ROUTES` | `true` | Fail-closed em auth |
| `LOGIN_FAIL_MAX` | `10` | Tentativas por IP |
| `LOGIN_FAIL_ACCOUNT_MAX` | `10` | Tentativas por CPF |

---

## APR (Análise Preliminar de Risco)

| Variável | Default | Descrição |
|----------|---------|-----------|
| `APR_CREATE_USER_THROTTLE_LIMIT` | `20` | /min por usuário — `POST /aprs` |
| `APR_CREATE_TENANT_THROTTLE_LIMIT` | `60` | /min por tenant — `POST /aprs` |
| `APR_CREATE_TENANT_THROTTLE_HOUR_LIMIT` | derivado | /hora por tenant — `POST /aprs` |
| `APR_LIST_USER_THROTTLE_LIMIT` | `120` | /min por usuário — `GET /aprs` |
| `APR_LIST_TENANT_THROTTLE_LIMIT` | `240` | /min por tenant — `GET /aprs` |
| `APR_LIST_TENANT_THROTTLE_HOUR_LIMIT` | derivado | /hora por tenant — `GET /aprs` |
| `APR_PDF_USER_THROTTLE_LIMIT` | `5` | /min por usuário — `POST /aprs/:id/generate-final-pdf` (Puppeteer) |
| `APR_PDF_TENANT_THROTTLE_LIMIT` | `20` | /min por tenant — idem |
| `APR_PDF_TENANT_THROTTLE_HOUR_LIMIT` | derivado | /hora por tenant — idem |
| `APR_BUNDLE_USER_THROTTLE_LIMIT` | `2` | /min por usuário — `GET /aprs/files/weekly-bundle` (Puppeteer, sem cache) |
| `APR_BUNDLE_TENANT_THROTTLE_LIMIT` | `6` | /min por tenant — idem |
| `APR_BUNDLE_TENANT_THROTTLE_HOUR_LIMIT` | derivado | /hora por tenant — idem |
| `APR_OVERVIEW_CACHE_TTL_SECONDS` | `30` | TTL do cache (Redis) de `analytics/overview` e `risks/matrix`. Clamp entre 10 e 300s |
| `APR_METRICS_RETENTION_DAYS` | `90` | Retenção de `apr_metrics` (observabilidade operacional — 1 linha por `GET /aprs/:id` + eventos de mutação). Limpeza diária às 04:15 no worker |

---

## CSRF

| Variável | Obrigatório | Default |
|----------|-------------|---------|
| `CSRF_TOKEN_SECRET` | Sim (prod) | — |
| `REFRESH_CSRF_ENFORCED` | Não | `true` |
| `CSRF_TOKEN_TTL_SECONDS` | Não | `3600` |

---

## S3 Storage

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `AWS_ACCESS_KEY_ID` | Sim (prod) | Backblaze B2 |
| `AWS_SECRET_ACCESS_KEY` | Sim (prod) | |
| `AWS_S3_BUCKET` | Sim (prod) | |
| `AWS_ENDPOINT` | Sim (prod) | `https://s3.us-west-xxx.backblazeb2.com` |
| `AWS_REGION` | Não | `auto` |

---

## AI / Sophie

| Variável | Default | Descrição |
|----------|---------|-----------|
| `FEATURE_AI_ENABLED` | `true` | Master switch |
| `AI_PROVIDER` | `openai` | `nvidia` / `openai` / `stub` / `local` |
| `NVIDIA_API_KEY` | — | Obrigatório quando `AI_PROVIDER=nvidia`; nunca reutilizar `OPENAI_API_KEY` |
| `NVIDIA_API_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Endpoint oficial NVIDIA NIM; host arbitrário é bloqueado |
| `NVIDIA_MODEL` | `openai/gpt-oss-120b` | Modelo textual principal NVIDIA |
| `NVIDIA_FALLBACK_MODEL` | — | Fallback NVIDIA opcional |
| `NVIDIA_REASONING_EFFORT` | `medium` | `low` / `medium` / `high` |
| `OPENAI_API_KEY` | — | Obrigatório apenas para `AI_PROVIDER=openai` |
| `OPENAI_MODEL` | `gpt-4o-2024-11-20` | Modelo principal OpenAI |
| `OPENAI_VISION_MODEL` | `gpt-4o-2024-11-20` | Modelo para imagens OpenAI |
| `OPENAI_CHAT_COMPLETION_TIMEOUT_MS` | `30000` | Timeout |

`openai/gpt-oss-120b` é somente texto. Com `AI_PROVIDER=nvidia`, o SGS bloqueia análise de imagens até a aprovação de um modelo visual NVIDIA separado.

---

## Mail

| Variável | Default | Descrição |
|----------|---------|-----------|
| `MAIL_ENABLED` | `true` | |
| `MAIL_HOST` | — | SMTP host (prioritário) |
| `MAIL_USER` / `MAIL_PASS` | — | SMTP credentials |
| `RESEND_API_KEY` | — | Fallback se SMTP não configurado |
| `MAIL_FROM_NAME` | `GST - Gestão de Segurança do Trabalho` | |
| `MAIL_FROM_EMAIL` | `onboarding@resend.dev` | |

---

## Antivírus

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `ANTIVIRUS_PROVIDER` | Sim (prod) | `clamav` |
| `CLAMAV_HOST` | Não | `127.0.0.1` |
| `CLAMAV_PORT` | Não | `3310` |

---

## Observabilidade

| Variável | Descrição |
|----------|-----------|
| `LOG_LEVEL` | `warn` em produção |
| `SENTRY_DSN` | Sentry (opcional) |
| `SENTRY_ENVIRONMENT` | |
| `OTEL_ENABLED` | OpenTelemetry |
| `NEW_RELIC_LICENSE_KEY` | New Relic |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile |
| `PROMETHEUS_PORT` | `9464` |

---

## Workers

| Variável | Default | Descrição |
|----------|---------|-----------|
| `WORKER_HEARTBEAT_ENABLED` | `true` | |
| `WORKER_HEARTBEAT_KEY` | `worker:heartbeat:queue-runtime` | |
| `WORKER_HEARTBEAT_TTL_SECONDS` | `90` | |

---

## Validation Token

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `VALIDATION_TOKEN_SECRET` | Sim (prod) | Min 32 chars |
| `PUBLIC_VALIDATION_LEGACY_COMPAT` | Não | `false` |

---

## Dev Only

| Variável | Default | Descrição |
|----------|---------|-----------|
| `DEV_LOGIN_BYPASS` | `false` | Login sem DB |
| `DEV_ADMIN_CPF` | — | CPF do admin bypass |
| `DISABLE_LOGIN_THROTTLE_IN_DEV` | `false` | Desliga throttle em dev |
| `N1_QUERY_DETECTION_ENABLED` | `false` | Detecta N+1 queries |

---

## Segurança — Checklist de Produção

- [ ] `DATABASE_SSL=true`
- [ ] `FIELD_ENCRYPTION_ENABLED=true`
- [ ] `FIELD_ENCRYPTION_KEY` = 32 bytes válidos
- [ ] `SECURITY_AUDIT_HMAC_KEY` = segredo exclusivo com 32+ caracteres
- [ ] `ANTIVIRUS_PROVIDER=clamav`
- [ ] `ADMIN_GERAL_MFA_REQUIRED=true`
- [ ] `MFA_ENABLED=true`
- [ ] `REFRESH_CSRF_ENFORCED=true`
- [ ] `CSRF_TOKEN_SECRET` = 32+ chars
- [ ] `JWT_SECRET` = 64+ chars (gerado com `openssl rand -hex 32`)
- [ ] `JWT_REFRESH_SECRET` = 64+ chars, diferente de `JWT_SECRET` (gerado com `openssl rand -hex 32`)
- [ ] `JWT_ISSUER` configurado (ex: `https://api.seu-dominio.com.br`)
- [ ] `JWT_AUDIENCE` configurado (ex: `sgs-app`)
- [ ] `VALIDATION_TOKEN_SECRET` = 32+ chars
- [ ] `THROTTLER_FAIL_CLOSED_AUTH_ROUTES=true`
- [ ] `REQUIRE_EXPLICIT_TENANT_FOR_SUPER_ADMIN=true`
- [ ] `LOG_LEVEL=warn` (ou `error`)
- [ ] `DATABASE_URL` sem `-pooler` no runtime
- [ ] Role `sgs_app` sem `BYPASSRLS`
