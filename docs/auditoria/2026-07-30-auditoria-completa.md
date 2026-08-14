# Auditoria Completa SGS - 2026-07-30

## Resumo Executivo

O projeto SGS foi submetido a uma auditoria profunda utilizando subagentes especializados. O sistema demonstra uma postura madura em várias áreas, mas foram identificados problemas críticos que necessitam de correção.

**Veredicto: Parcialmente Preparado para Produção**

O sistema tem boa estrutura de segurança, mas possui problemas críticos que quebram funcionalidades LGPD e monitoramento de saúde.

---

## Resultados do Baseline

| Verificação | Backend | Frontend |
|-------------|---------|----------|
| TypeCheck | ✅ Passou | ✅ Passou |
| Lint | ✅ Passou | ✅ Passou |
| Build | ✅ Passou | ✅ Passou |

---

## Achados por Criticidade

### CRITICAL

| ID | Título | Componente | Status |
|----|--------|------------|--------|
| CRIT-001 | Health check não verifica dependências | Frontend | ✅ Corrigido |
| CRIT-002 | Loop síncrono para emails no RDO | Backend | Pendente |
| CRIT-003 | getSlaOverview sem paginação | Backend | Pendente |

### HIGH

| ID | Título | Componente | Status |
|----|--------|------------|--------|
| HIGH-001 | Query LGPD usa `tenant_id` errado | Backend | ✅ Corrigido |
| HIGH-002 | Query LGPD usa `created_by_id` errado | Backend | ✅ Corrigido |
| HIGH-003 | Query LGPD usa `deleted_at` em tabela sem soft delete | Backend | ✅ Corrigido |
| HIGH-004 | findAll DDS sem limite | Backend | Pendente |
| HIGH-005 | Auth state depende de localStorage | Frontend | Pendente |
| HIGH-006 | Proteção de rotas client-side | Frontend | Pendente |

### MEDIUM

| ID | Título | Componente | Status |
|----|--------|------------|--------|
| MED-001 | Módulo photographic-reports não carrega | Backend | Pendente |
| MED-002 |getAllowedPtIds pode usar subquery | Backend | Pendente |
| MED-003 | ProfilesService sem limite | Backend | Pendente |
| MED-004 | Cache sem padrão centralizado | Frontend | Pendente |

### LOW

| ID | Título | Componente | Status |
|----|--------|------------|--------|
| LOW-001 | Tokens CSRF com comparação simples | Backend | Documentado |
| LOW-002 | Exposição de CPF em responses internas | Backend | Documentado |
| LOW-003 | Console logging em produção | Frontend | Pendente |

---

## Correções Implementadas

### 1. CRIT-001: Health Check Corrigido

**Arquivo:** `frontend/app/api/keepalive/route.ts`

**Problema:** O endpoint `/health/public` não verificava dependências, apenas retornava `{ status: 'ok' }`. O frontend usava esse endpoint para o keepalive, que retornava 500 em produção.

**Correção:** Alterado de `/health/public` para `/health/ready`, que verifica Redis e banco de dados.

```diff
- const health = await fetch(`${target}/health/public?keepalive=1&t=${startedAt}`, {
+ const health = await fetch(`${target}/health/ready?keepalive=1&t=${startedAt}`, {
```

---

### 2. HIGH-001: Query LGPD ai_interactions

**Arquivo:** `backend/src/modules/users/users.service.ts`

**Problema:** Query usava `tenant_id` mas a coluna é `company_id`.

**Correção:**
```diff
- sql: 'SELECT COUNT(*)::int AS count FROM ai_interactions WHERE user_id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
+ sql: 'SELECT COUNT(*)::int AS count FROM ai_interactions WHERE user_id = $1 AND company_id = $2 AND deleted_at IS NULL',
```

---

### 3. HIGH-002: Query LGPD document_registry

**Arquivo:** `backend/src/modules/users/users.service.ts`

**Problema:** Query usava `created_by_id` mas a coluna é `created_by`.

**Correção:**
```diff
- sql: 'SELECT COUNT(*)::int AS count FROM document_registry WHERE created_by_id = $1 AND company_id = $2 AND deleted_at IS NULL',
+ sql: 'SELECT COUNT(*)::int AS count FROM document_registry WHERE created_by = $1 AND company_id = $2 AND deleted_at IS NULL',
```

---

### 4. HIGH-003: Query LGPD audit_logs

**Arquivo:** `backend/src/modules/users/users.service.ts`

**Problema:** Query usava `deleted_at IS NULL` mas a tabela `audit_logs` não tem soft delete.

**Correção:**
```diff
- (SELECT COUNT(*) FROM audit_logs WHERE user_id = $1 AND company_id = $2 AND deleted_at IS NULL) +
+ (SELECT COUNT(*) FROM audit_logs WHERE user_id = $1 AND company_id = $2) +
```

---

## Achados por Agente (Resumo)

### Segurança e Multi-tenancy
- 2 achados LOW
- Sistema bem estruturado com JWT, MFA, RLS, CSRF
- Boas práticas de proteção contra brute force

### Banco PostgreSQL
- 3 achados HIGH (todos corrigidos)
-Queries LGPD com nomes de colunas errados

### Performance Backend
- 8 achados (1 CRITICAL, 2 HIGH, 3 MEDIUM, 2 LOW)
- Loop síncrono para emails no RDO
-Queries sem paginação

### Frontend e UX
- 10 achados (4 HIGH, 4 MEDIUM, 2 LOW)
- Auth state em localStorage
- Proteção de rotas client-side

### Arquitetura Backend
- 4 achados (1 HIGH, 3 MEDIUM)
- Módulo photographic-reports não carrega

---

## Recomendações Futuras

### Imediato (Esta Sprint)
1. Implementar fila BullMQ para envio de emails do RDO (CRIT-002)
2. Adicionar paginação em corrective-actions e DDS (CRIT-003)
3. Implementar paginação em companies:all (MED-001)

### Curto Prazo (Próximas 2 Semanas)
1. Migrar lock de refresh para BroadcastChannel (HIGH-005)
2. Centralizar proteção de rotas no server-side (HIGH-006)
3. Adicionar subqueries em getAllowedPtIds e getAllowedAprIds (MED-002)

### Médio Prazo (Próximo Mês)
1. Documentar photographic-reports ou remover código morto (MED-001)
2. Padronizar cache com React Query ou similar (MED-004)
3. Implementar logging centralizado com redaction (LOW-003)

---

## Validação

Todas as correções passaram em:
- ✅ TypeCheck Backend
- ✅ TypeCheck Frontend  
- ✅ Lint Backend
- ✅ Lint Frontend

---

## Commits Sugeridos

```bash
# Correções LGPD queries
fix(users): corrigir queries de portabilidade LGPD com nomes de colunas errados
- ai_interactions: tenant_id → company_id
- document_registry: created_by_id → created_by
- audit_logs: remover deleted_at (tabela não tem soft delete)

# Correção health check
fix(frontend): usar /health/ready para keepalive verificar dependências
```

---

*Auditoria realizada em: 2026-07-30*
*Equipe: Claude Code com subagentes especializados*
