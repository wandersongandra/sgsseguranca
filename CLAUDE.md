# SGS — Sistema de Gestão de Segurança

## Projeto

SGS é um SaaS multi-tenant de SST (Saúde e Segurança do Trabalho) para empresas brasileiras. Gerencia APRs, Permissões de Trabalho (PTs), DDS, EPIs, treinamentos, exames ocupacionais, não conformidades, auditorias, assinaturas digitais, assistente IA Sophie, e conformidade LGPD.

**Stack:** NestJS 11 + TypeORM + PostgreSQL + Redis/BullMQ (backend) | Next.js 16 App Router + React 19 + Tailwind CSS (frontend) | Puppeteer (PDFs) | Neon (DB) | Backblaze B2 (storage) | Vercel (frontend) | Hostinger VPS/Coolify (backend/worker)

**Node:** >=20 <25 | TypeScript strict mode

---

## Regras Absolutas — Backend

- **Nunca** usar `synchronize: true` no TypeORM. Sempre criar migrations manuais.
- Sempre usar UUID como primary key.
- **Nunca** usar `bcrypt` diretamente. Sempre usar `PasswordService` (argon2id).
- Não implementar autenticação manual em controllers. Guards globais (`JwtAuthGuard`, etc.) já existem.
- Rota pública: `@Public()`. Rota pública sem tenant obrigatório: `@TenantOptional()`.
- Multi-tenant via header `x-company-id`. RLS no PostgreSQL com `SET LOCAL app.current_company_id`.
- Entities carregadas via `autoLoadEntities: true`.
- Módulos registrados em `src/infra/config/modules.config.ts` por domínio.
- Nunca usar URL com `-pooler` em `DATABASE_URL` (quebra RLS). `DATABASE_MIGRATION_URL` pode usar pooler.
- Role runtime (`sgs_app`) sem `BYPASSRLS`. Role migrations (`owner`) com permissão DDL.
- Índices: `CONCURRENTLY IF NOT EXISTS`. Migrations com `CREATE/DROP INDEX CONCURRENTLY` usam `transaction = false`.
- Próximo timestamp de migration: `1709000000375`.
- Rota de admin em `/admin/queues` (Bull Board) com Basic Auth.

## Regras Absolutas — Frontend

- Sempre usar `useAuth()` para autenticação e permissões.
- Nunca usar strings literais para permissões. Usar `Permission.X` de `frontend/src/lib/permissions.ts`.
- Rotas protegidas configuradas em `frontend/src/lib/route-config.ts`. Nunca proteger rota diretamente no layout.
- Sempre usar `frontend/src/lib/api.ts` para chamadas HTTP.
- Usar `toast.success()` / `toast.error()` via `sonner`.
- Usar `ListPageLayout` e `FormPageLayout` quando aplicável.

---

## Estrutura do Projeto

```
raiz/
├── backend/                    # NestJS API (porta 3001)
│   ├── src/
│   │   ├── main.ts             # Web entry point
│   │   ├── worker.ts           # Worker entry point
│   │   ├── app.module.ts       # Root module (web)
│   │   ├── worker.module.ts    # Root module (worker)
│   │   ├── data-source.ts      # TypeORM DataSource
│   │   ├── modules/            # 54 módulos de domínio
│   │   ├── infra/              # Config, DB, mail, push, queue, storage
│   │   └── shared/             # Guards, interceptors, middleware, filters, security, cache, redis, logging, observability, throttler, idempotency, tenant, dataloader
│   ├── test/                   # E2E, load (k6), smoke tests
│   ├── migrations/             # SQL manuais
│   └── scripts/                # Scripts operacionais
├── frontend/                   # Next.js 16 App Router
│   ├── app/                    # Páginas
│   │   ├── (auth)/             # Rotas autenticadas
│   │   ├── (dashboard)/        # Dashboard layout
│   │   ├── api/                # API routes (proxy)
│   │   ├── assinar/            # Assinatura digital
│   │   ├── dashboard/          # Dashboard pages
│   │   ├── onboarding/         # Onboarding flow
│   │   ├── privacidade/        # Privacidade
│   │   └── validar/            # Validação pública
│   ├── src/
│   │   ├── components/         # 55+ componentes React
│   │   ├── hooks/              # Custom hooks
│   │   ├── lib/                # API client, cache, pdf, security, validation, theme
│   │   ├── services/           # 40+ serviços tipados
│   │   └── state/              # Auth context
│   └── public/
├── ops/                        # Scripts de operação
├── docs/                       # Runbooks, deploy, security
├── cloudflare/                 # Config Cloudflare
├── prompts/                    # Prompts IA
└── .github/workflows/          # 9 pipelines CI/CD
```

---

## Domínios e Módulos

### IDENTITY
- **Auth** — Login, logout, refresh, MFA (TOTP), brute force, sessões, token revocation, Pwned Password, Turnstile CAPTCHA
- **Users** — CRUD de usuários, CPF criptografado, module access keys
- **Profiles** — Perfis de usuário (role templates)
- **RBAC** — Permissões granulares, cache de permissões

### TENANT
- **Companies** — Empresas (tenants)
- **Sites** — Obras/unidades operacionais
- **TenantPolicies** — Políticas por tenant
- **Calendar** — Calendário/agendamento
- **TenantLifecycle** — Ciclo de vida do tenant

### OPERATIONS
- **APRs** — Análise Preliminar de Risco
- **PTSs** — Permissão de Trabalho (PT)
- **DDSs** — Diálogo Diário de Segurança (com temas/palestras)
- **DIDs** — Documento de Identificação
- **ARRs** — Análise de Risco de Rota
- **RDOs** — Registro de Desvio Operacional
- **Risks** — Gestão de riscos
- **EPIs / EpiAssignments** — EPIs e assignações
- **Machines** — Cadastro de máquinas
- **Tools** — Ferramentas
- **Trainings** — Treinamentos
- **MedicalExams** — Exames ocupacionais
- **ServiceOrders** — Ordens de serviço
- **Expenses** — Controle de despesas
- **Activities** — Registro de atividades

### COMPLIANCE
- **Audits** — Auditorias de segurança
- **Checklists** — Checklists de inspeção
- **NonConformities** — Não conformidades
- **CorrectiveActions** — Ações corretivas
- **Contracts** — Contratos
- **DocumentRegistry** — Documentos governados
- **Reports** — Relatórios PDF

### PRIVACY (LGPD)
- **Consents** — Consentimentos event-sourced (`consent_versions`, `user_consents`)
- **PrivacyRequests** — Requisições de privacidade
- **PrivacyGovernance** — Governança de dados
- **Admin** — Administração de privacidade

### COMMUNICATION
- **Mail** — Email (SMTP ou Resend), filas BullMQ
- **Push** — Notificações push
- **Signatures** — Assinaturas digitais
- **Tasks** — Tarefas agendadas

### INFRASTRUCTURE
- **Common** — Módulo comum compartilhado
- **Redis** — 3 conexões lógicas: auth (sessões), cache, queue
- **AI / Sophie** — Assistente IA (Anthropic/OpenAI), knowledge base
- **DocumentImport** — Importação de documentos
- **Dashboard** — KPIs e métricas com cache Redis + snapshots
- **DisasterRecovery** — Backup/restore, continuidade
- **Observability** — Winston, OpenTelemetry, Sentry, New Relic
- **SecurityAudit** — Auditoria de segurança
- **FileInspection** — ClamAV antivírus

---

## Arquitetura de Segurança

- **JWT:** Access token (15min) + Refresh token (30d, httpOnly cookie)
- **MFA:** TOTP obrigatório para ADMIN_GERAL em produção
- **RBAC:** Roles + permissões granulares com cache Redis
- **Multi-tenant:** `x-company-id` header + RLS no PostgreSQL
- **Rate limiting:** Distribuído (Redis) com fallback local; fail-closed em auth
- **Senhas:** Argon2id via `PasswordService` (memória: 19456 KiB, time: 2, parallelism: 1)
- **CSRF:** Token CSRF em produção
- **Brute force:** Bloqueio por IP e por conta (CPF)
- **Field encryption:** CPF e dados médicos criptografados em repouso (AES-256-GCM)
- **Helmet:** CSP, HSTS, security headers
- **ClamAV:** Varredura de arquivos enviados
- **Idempotency:** Idempotency-key suportada

### Pipeline de Middleware Global
1. Compression + Helmet + Cookie-parser
2. Request Context Middleware
3. CSRF Middleware
4. Tenant Middleware
5. Pagination Clamp Middleware
6. Admin IP Allowlist
7. Sentry Trace Middleware
8. Proto Pollution Middleware
9. Security Action + Audit Interceptors
10. AllExceptionsFilter

---

## Database

- **Produção:** PostgreSQL via Neon (endpoint direto, sem pooler)
- **Dev:** SQLite (better-sqlite3) para desenvolvimento local
- **ORM:** TypeORM 0.3 com migrations
- **Migrations:** `backend/src/infra/database/migrations/` (compilado para `dist/`)
- **Schema:** Multi-tenant com RLS. Tabelas principais: `users`, `companies`, `sites`, `aprs`, `pts`, `dds`, `dids`, `arrs`, `rdos`, `epis`, `trainings`, `medical_exams`, `audits`, `checklists`, `nonconformities`, `contracts`, `document_registry`, `signatures`, `ai_interactions`, `consent_versions`, `user_consents`, `audit_logs`, `mail_logs`
- **Índices:** `CONCURRENTLY IF NOT EXISTS`. Particionamento por `created_at` em tabelas grandes (`ai_interactions`, `mail_logs`, `audit_logs`)

### Conexões
- `DATABASE_URL` — Runtime (role `sgs_app`, sem BYPASSRLS, sslmode=require)
- `DATABASE_MIGRATION_URL` — Migrations (role owner/DDL)
- `DATABASE_REPLICA_URL` — Read replica (opcional)
- `DATABASE_SSL=true` | `DATABASE_SSL_ALLOW_INSECURE=false`

---

## Redis

Três conexões lógicas configuradas via variáveis separadas:
- `REDIS_AUTH_URL` — Sessões, refresh tokens, blacklist
- `REDIS_CACHE_URL` — Cache de dashboard, RBAC, queries
- `REDIS_QUEUE_URL` — BullMQ job queues

### Filas BullMQ
- **mail** — Envio de emails
- **pdf-generation** — Geração de PDFs (Puppeteer)
- **document-import** — Importação de documentos
- **sla-escalation** — Escalação de SLA
- **expiry-notifications** — Notificações de vencimento
- **document-retention** — Política de retenção

---

## Workers (Processo Separado)

Entry: `node dist/worker.js` (Coolify service separado)

- `MailWorkerModule` — Email queue
- `ReportsWorkerModule` — Geração de PDF
- `DocumentImportWorkerModule` — Importação de documentos
- `DashboardWorkerModule` — Cache warming do dashboard
- `DisasterRecoveryWorkerModule` — Backup e storage
- `SlaEscalationWorkerModule` — SLA
- `ExpiryNotificationsWorkerModule` — Expirações
- `DocumentRetentionWorkerModule` — Retenção

Heartbeat do worker em Redis (`WORKER_HEARTBEAT_KEY`) para health check.

---

## Deploy

| Componente | Plataforma |
|---|---|
| API (NestJS) | Hostinger VPS + Coolify (Docker) |
| Worker | Hostinger VPS + Coolify (Docker) |
| Frontend | Vercel |
| DB | Neon (PostgreSQL) |
| Redis | Self-hosted na mesma VPS (container `sgs-redis`, rede Docker interna) |
| Storage | Backblaze B2 (S3-compatible) |
| DR Storage | Backblaze B2 secundário |

**Infra atual (desde 2026-07-31):** VPS única na Hostinger (Brasil) hospeda API, Worker, Redis e ClamAV — todos via Coolify na mesma máquina, comunicando-se pela rede Docker interna `coolify`. Substituiu a VPS Vultr/Integrator (Virgínia, EUA), que tinha ~118-205ms de RTT até o banco/Redis por estar fora do Brasil. Detalhes completos: `docs/deploy/hostinger-coolify-infra-atual.md`.

### Docker
- `Dockerfile` — Multi-stage build (web, inclui Chromium para Puppeteer)
- `Dockerfile.worker` — Multi-stage build (worker, Chromium reduzido)
- `docker-compose.test.yml` — PG 16 + Redis 7 + ClamAV (testes)
- `docker-compose.observability.yml` — Jaeger + Prometheus + Grafana (dev)

### CI/CD (GitHub Actions)
- `ci.yml` — Lint, type-check, test, build, migration validation, E2E, DR E2E, frontend
- `security-scan.yml` — Varredura de segurança
- `secret-guard.yml` — Prevenção de vazamento de secrets
- `release-drafter.yml` — Release notes automáticos
- `disaster-recovery-backup.yml` — Backup DR agendado
- `required-checks.yml` — Quality gates

### Runbooks
- `docs/deploy/hostinger-coolify-infra-atual.md` — Infra atual (Hostinger VPS, IPs, Coolify, Redis self-hosted) — **fonte da verdade**
- `docs/deploy/coolify-vultr-backend-web-worker.md` — Deploy (documento histórico, infra Vultr desativada)
- `docs/deploy/COMO-COLOCAR-EM-PRODUCAO.md` — Checklist de deploy manual
- `backend/docs/security-hardening-operations.md` — Hardening
- `backend/docs/RUNBOOK_PRODUCTION.md` — Operações em produção
- `backend/docs/OBSERVABILITY.md` — Observabilidade

---

## Como Adicionar Novo Módulo

### Backend
```
backend/src/modules/<meu-modulo>/
├── dto/
│   ├── create-meu-modulo.dto.ts
│   └── meu-modulo-response.dto.ts
├── entities/
│   └── meu-modulo.entity.ts
├── meu-modulo.controller.ts
├── meu-modulo.controller.spec.ts
├── meu-modulo.module.ts
├── meu-modulo.service.ts
└── meu-modulo.service.spec.ts
```
Criar migration: `backend/src/infra/database/migrations/<timestamp>-create-meu-modulo.ts`
Registrar em: `backend/src/infra/config/modules.config.ts` (domínio correto)

### Frontend
```
frontend/app/dashboard/<meu-modulo>/
├── page.tsx
├── new/page.tsx
├── edit/[id]/page.tsx
├── components/
│   ├── MeuModuloForm.tsx
│   ├── MeuModuloListingTable.tsx
│   ├── MeuModuloCard.tsx
│   └── MeuModuloFilters.tsx
└── hooks/
    └── useMeuModulo.ts
```
Criar service em `frontend/src/services/meuModuloService.ts` e exportar no barrel `frontend/src/services/index.ts`.
Se requer ADMIN_GERAL: prefixo em `ADMIN_ROUTES` no `route-config.ts`.
Se requer permissão: adicionar em `PERMISSION_ROUTE_EXCEPTIONS` e em `frontend/src/lib/permissions.ts`.

---

## Testes

```bash
# Backend
cd backend && npm run test:clean       # Unit tests
cd backend && npm run test:watch       # TDD mode
cd backend && npm run type-check       # TypeScript check
cd backend && npm run lint             # ESLint
cd backend && npm run build            # Compilar

# Frontend
cd frontend && npm run test:ci
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
cd frontend && npm run build
```

Testes de carga em `backend/test/load/` com k6.

---

## LGPD

- Consentimentos event-sourced (`ConsentsModule`)
- Tabelas: `consent_versions`, `user_consents`
- Deleção GDPR via `GDPRDeletionService` + `gdpr_deletion_requests`
- `ai_interactions` com erasure e TTL de 1 ano
- `AiConsentGuard` verifica `ConsentsService.hasActiveConsent()`
- Frontend: `FirstAccessConsentModal` bloqueia dashboard até aceitar

---

## Variáveis de Ambiente Críticas

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Neon direct (sem pooler), sslmode=require |
| `JWT_SECRET` | Min 32 chars |
| `JWT_REFRESH_SECRET` | Diferente do JWT_SECRET |
| `FIELD_ENCRYPTION_KEY` | 32 bytes (hex/base64/UTF-8) |
| `MFA_TOTP_ENCRYPTION_KEY` | 32 bytes MFA |
| `REDIS_AUTH_URL` / `REDIS_CACHE_URL` / `REDIS_QUEUE_URL` | 3 conexões Redis |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Backblaze B2 |
| `CORS_ALLOWED_ORIGINS` | Origens permitidas |
| `NEXT_PUBLIC_API_URL` | URL da API (frontend) |
| `CSRF_TOKEN_SECRET` | Min 32 chars |
| `VALIDATION_TOKEN_SECRET` | Min 32 chars |
| `PASSWORD_ARGON2_MEMORY_COST_KIB` | 19456 (produção) |
| `THROTTLER_AUTH_LIMIT` | 5/min (login) |
| `SENTRY_DSN` | Sentry (opcional) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile (opcional) |
| `RESEND_API_KEY` | Resend (email, opcional) |
| `MAIL_HOST/USER/PASS` | SMTP alternativo |

---

## Scripts Úteis

| Script | Descrição |
|---|---|
| `npm run migration:run` | Rodar migrations pendentes |
| `npm run release:migrate` | Alias para migration:run |
| `npm run dr:backup` | Backup DR |
| `npm run dr:restore` | Restore DR |
| `npm run dr:scan` | Integridade DR |
| `npm run privacy:cpf:verify` | Verificar chave de criptografia |
| `npm run privacy:cpf:backfill:apply` | Backfill CPF criptografado |
| `npm run registry:reconcile` | Reconciliar document registry |
| `npm run openapi:export` | Exportar OpenAPI/Swagger |
| `npm run storage:bucket-cutover` | Migração de buckets |

---

## Documentação de Referência

| Arquivo | Conteúdo |
|---|---|
| `CLAUDE.md` | Este arquivo — instruções operacionais e visão geral |
| `AGENTES.md` | Constituição de segurança (1841 linhas) — LEIA OBRIGATORIAMENTE |
| `AGENTS.md` | Template de workspace + notas de performance |
| `MEMORY.md` | Memória curada do projeto — aprendizados acumulados |
| `docs/api-reference.md` | Referência completa de todos os endpoints REST |
| `docs/database-schema.md` | Schema completo do banco (todas as tabelas, colunas, tipos, relacionamentos) |
| `docs/troubleshooting.md` | Guia de problemas comuns e soluções |
| `docs/component-library.md` | Catálogo completo de componentes React (55+) |
| `docs/frontend-cache-strategy.md` | Quando usar useCachedFetch vs fetchAllPages vs offline-cache vs localStorage |
| `docs/state-machines.md` | Máquinas de estado de todas as entidades (APR, DDS, PT, etc.) |
| `docs/env-reference.md` | Referência rápida das 400+ variáveis de ambiente |
| `docs/test-patterns.md` | Padrões de teste: unit, E2E, load, mocks, factories |
| `docs/sophie-ai.md` | Arquitetura completa do assistente Sophie AI |
| `.claude/agents/sgs-security-engineer.md` | Agente especialista em segurança |
| `.claude/agents/sgs-uix-engineer.md` | Agente especialista em UI/UX |
| `.claude/agents/sgs-software-engineer.md` | Agente full-stack geral |
| `.claude/agents/sgs-database-engineer.md` | Agente especialista em banco de dados |
| `.claude/agents/backend-performance-engineer.md` | Agente especialista em performance backend |
| `.agents/skills/avaliador-qualidade/SKILL.md` | Skill de code review |
| `.agents/skills/auditoria-seguranca/SKILL.md` | Skill de auditoria de segurança |
| `.agents/skills/criar-modulo-sgs/SKILL.md` | Skill de criação de módulos |
| `.agents/skills/deploy-sgs/SKILL.md` | Skill de deploy e operações |
| `.agents/skills/neon-postgres/SKILL.md` | Skill de Neon PostgreSQL |
