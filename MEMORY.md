# MEMORY.md — SGS Segurança

> Memória curada do projeto SGS. Atualizada conforme novos aprendizados.
> Criada em: 2026-06-14

---

## Arquitetura do Sistema

- **Full-stack SaaS multi-tenant** de SST (Saúde e Segurança do Trabalho)
- Backend NestJS 11 + TypeORM + PostgreSQL (Neon) + Redis/BullMQ
- Frontend Next.js 16 App Router + React 19 + Tailwind CSS
- Monorepo com `backend/`, `frontend/`, `ops/`, `docs/`

## Regras Críticas (Nunca Esquecer)

1. `synchronize: true` é **proibido** — migrations manuais sempre
2. `bcrypt` é **proibido** — usar `PasswordService` (argon2id)
3. Role runtime (`sgs_app`) **nunca** pode ter `BYPASSRLS`
4. `DATABASE_URL` **nunca** pode usar host `-pooler` (quebra RLS)
5. `CREATE INDEX CONCURRENTLY` requer `transaction = false`
6. UUID como primary key — sempre
7. Rotas públicas: `@Public()`. Sem tenant: `@TenantOptional()`
8. Nunca inferir o próximo timestamp de migration; conferir o diretório de migrations e executar o check oficial antes de criar uma nova.
9. `FIELD_ENCRYPTION_ENABLED=true` em produção

## Estrutura de Módulos

Domínios: IDENTITY → TENANT → OPERATIONS → COMPLIANCE → PRIVACY → COMMUNICATION → INFRASTRUCTURE

Módulos registrados em `backend/src/infra/config/modules.config.ts`.

## Banco de Dados

- Produção: Neon PostgreSQL (direct, sem pooler, sslmode=require)
- Dev: SQLite (better-sqlite3)
- Tabelas grandes para particionar: `audit_logs`, `mail_logs`, `ai_interactions`
- Migrations em `backend/src/infra/database/migrations/`
- RLS via `SET LOCAL app.current_company_id`

## Redis

3 conexões lógicas: `REDIS_AUTH_URL` (sessões), `REDIS_CACHE_URL` (cache), `REDIS_QUEUE_URL` (BullMQ)

Filas: mail, pdf-generation, document-import, sla-escalation, expiry-notifications, document-retention

## Segurança

- Rate limiting: login 5/min, API 100/min, dashboard 50/min
- MFA TOTP obrigatório para ADMIN_GERAL em produção
- Throttler com fallback local e fail-closed em auth
- CPF criptografado com AES-256-GCM
- CSRF ativo em produção
- ClamAV para uploads

## Workers

Processo separado (`node dist/worker.js`). 8 workers: Mail, Reports, DocumentImport, Dashboard, DisasterRecovery, SlaEscalation, ExpiryNotifications, DocumentRetention

## Deploy e ambientes

- Ambiente operacional atual: Hostinger VPS + Coolify; web e worker separados; classificação `PRE_PRODUCTION_QA` conforme o escopo vigente.
- Frontend: Vercel.
- DB: Neon PostgreSQL direto, sem host `-pooler`.
- Redis: self-hosted na infraestrutura atual; não assumir Upstash.
- Storage: Backblaze B2; Cloudflare R2 é histórico e não deve ser usado como provider atual.
- Testes: usar o runtime autorizado na Hostinger atual; os harnesses Jest/Playwright/k6/Compose continuam versionados para execução controlada e dados sintéticos, mas não há uma VPS remota separada de testes autorizada.
- Processo obrigatório: `docs/OPERACAO-CANONICA-SGS.md`.

## Padrões de Código

- Serviços usam exceções nativas do NestJS (BadRequestException, NotFoundException, etc.)
- Resposta de erro: `{ success: false, statusCode, message, errorCode, error: { code, message, details, timestamp, path, requestId } }`
- ValidationPipe: whitelist=true, forbidNonWhitelisted=true, transform=true
- Paginação sempre com limite máximo
- Auditoria: ações críticas logadas em `audit_logs`

## Fluxos de Negócio

### APR
Status: PENDENTE → APROVADA → ENCERRADA | CANCELADA
Workflow de aprovação: 3 níveis (TST → Supervisor → Admin Empresa)
Risk items com evidências fotográficas (GPS, EXIF, device ID)

### DDS
Status: RASCUNHO → PUBLICADO → ARQUIVADO | AUDITADO
Aprovação multi-ciclo com hash chain criptográfico
Detecção de reuso de fotos entre DDSs

### PT
Status: PENDENTE → APROVADA → ENCERRADA | EXPIRADA → ENCERRADA | CANCELADA
Tipos de trabalho: altura, espaço confinado, trabalho quente, eletricidade, escavação

### Sophie AI
Assistente de SST com análise de APRs, PTs, checklists, geração de DDS
Feature flag `APR_RULES_ENGINE` para rules engine

## Agentes

- `sgs-security-engineer` — Segurança e LGPD
- `sgs-uix-engineer` — UI/UX Frontend
- `sgs-software-engineer` — Full-stack geral
- `sgs-database-engineer` — Banco de dados
- `backend-performance-engineer` — Performance backend

## Skills

- `avaliador-qualidade` — Code review
- `neon-postgres` — Neon PostgreSQL
- `auditoria-seguranca` — Auditoria de segurança
- `criar-modulo-sgs` — Criação de módulos
- `deploy-sgs` — Deploy e operações

## Roadmap de Auditoria

Roadmap em `docs/architecture/AUDIT-2026-03-remediation-roadmap.md` organiza correções em 7 fases.
Relatório Sprint A em `.agents/auditoria/RELATORIO_SPRINT_A.md`.

### Sprint A (Fase 1 — Blindagem e Confiança Pública) — 2026-06-15
- P0-01 (isolamento jobs fila por tenant): ✅ já implementado
- P0-02 (verify page pública): ⚠️ ajuste menor — adicionada rota DDS- no frontend
- P0-03 (verificação hash PDF): ✅ já implementado

### Sprint B (Fase 2 — Contratos de Infraestrutura) — 2026-06-15
- P0-04 (degradação sem Redis): ✅ lógica inline substituída pelo util `shouldUseRedisQueueInfra()`
- P1-03 (health checks): ✅ `HealthModule` criado e registrado — endpoints /health ativados
- P1-04 (consolidar storage): ⏳ pendente — `StorageService` e `S3Service` duplicados

## Aprendizados (seção viva — atualizar conforme descobre)

<!-- Adicione aqui lições aprendidas durante o desenvolvimento -->
- Sophie AI usa OpenAI (gpt-4o) com circuit breaker (3 falhas → 30s open) e PII sanitizer
- Rate limiting do Sophie: 10 req/min por tenant, throttles específicos por endpoint
- Testes E2E usam `TestApp` class com seed de 2 tenants + login real
- Components UI primitivos em `frontend/src/components/ui/` (16 componentes)
- Layouts padrão: `ListPageLayout` e `FormPageLayout`
- Toda doc de referência em `docs/` — consultar antes de codar
