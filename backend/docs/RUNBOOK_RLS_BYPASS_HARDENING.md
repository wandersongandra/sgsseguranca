# Runbook — Conclusao do hardening de isolamento multi-tenant (bypass de RLS, PR #137)

> Status: PLANO APROVADO (Caminho A — conexao dedicada). Fases 2 e 3 dependem de
> staging, credenciais de owner do banco e janela controlada. NADA em producao
> deve ser executado fora deste runbook e sem janela + backup.

## 1. Contexto e estado atual

A migration `1709000000346-harden-rls-bypass-role-gate` (do #137) ja redefiniu
`public.is_super_admin()` para exigir DUAS condicoes: a flag de sessao
`app.is_super_admin` E `pg_has_role(current_user,'sgs_rls_bypass','MEMBER')`.
Ela tambem concedeu `sgs_rls_bypass` ao `sgs_app` (compatibilidade), entao o
comportamento hoje e identico ao anterior. O vetor so fecha de fato com o
`REVOKE sgs_rls_bypass FROM sgs_app` — e esse REVOKE so e seguro depois que as
operacoes que legitimamente precisam de acesso cross-tenant deixarem de usar a
conexao comum (`sgs_app`).

Runtime hoje liga o bypass apenas quando `isSuperAdmin && !companyId`
(super admin sem empresa) — ver `TenantDbContextService`.

## 2. Consumidores do bypass (mapeados)

| Consumidor | Uso | Destino no plano |
|---|---|---|
| Login (auth.service) | achar usuario por CPF sem tenant + rehash senha | funcao SECURITY DEFINER escopada |
| Exclusao LGPD (gdpr-deletion) | apagar/anonimizar dados de empresa/titular | conexao dedicada sgs_admin |
| Trilha forense (forensic-trail) | gravar auditoria fora de contexto de tenant | conexao dedicada sgs_admin |
| Cleanup / observability / mail (tarefas) | jobs sem contexto de tenant | conexao dedicada sgs_admin |
| Operador super-admin (dashboards globais, provisionamento) | ver/gerir todos os tenants | REMOVER (nao e necessario) |

LGPD e login DEVEM continuar funcionando — sao obrigacao legal / acesso de todos.
"Remover super admin" = remover as telas/rotas de OPERADOR cross-tenant, nao a conta.

## 3. Arquitetura alvo (Caminho A)

- Nova role de banco: `sgs_admin LOGIN`, membro de `sgs_rls_bypass`.
- Nova env: `DATABASE_ADMIN_URL` (aponta para `sgs_admin`), endpoint Neon DIRETO (sem -pooler).
- Novo DataSource/pool privilegiado no app (dormante se `DATABASE_ADMIN_URL` ausente).
- Operacoes raras cross-tenant (LGPD, forense, cleanup) passam a usar o pool privilegiado.
- Login: nova funcao `SECURITY DEFINER` `find_login_user(cpf)` — resolve o usuario sem
  bypass de sessao; auth.service passa a chama-la.
- Remover rotas/telas de operador super-admin.
- Runtime `sgs_app` deixa de precisar do bypass -> REVOKE.

## 4. FASE 1 — codigo (PR revisado, sem tocar em producao)

Fatiar para reduzir risco:
- PR 1a: DataSource privilegiado + config (Joi `DATABASE_ADMIN_URL`) + guardas + testes. Aditivo/dormante.
- PR 1b: rotear LGPD/forense/cleanup para o pool privilegiado + testes.
- PR 1c: login via `find_login_user` SECURITY DEFINER (migration + auth.service) + testes. (Mais sensivel — validar em staging.)
- PR 1d: remover rotas/telas de operador super-admin.

## 5. Convencao de passos por ambiente

Cada passo mutante e nomeado com prefixo de ambiente para nao haver ambiguidade:

- `S1..Sn` = executados em STAGING.
- `P1..Pn` = executados em PRODUCAO.

O REVOKE que fecha o vetor aparece DUAS vezes, com nomes distintos: `S-REV` (staging,
secao 6) e `P-REV` (producao, secao 7). Nunca execute um no ambiente do outro.

Todos os passos que criam role, concedem/revogam grants ou membership exigem uma
conexao de OWNER com atributo `CREATEROLE` (ou superuser). No SGS isso e a role
`neondb_owner`, alcancavel via `DATABASE_MIGRATION_URL`. A conexao de runtime
(`sgs_app`, via `DATABASE_URL`) NAO tem privilegio para esses comandos e deve
falhar por design se usada aqui. Motivo (PostgreSQL): `CREATE ROLE` exige
`CREATEROLE`/superuser; `GRANT <role> TO ...` exige `ADMIN OPTION` sobre a role
concedida — atributos que `sgs_app` nao possui.

## 6. FASE 2 — staging

Executar TODOS os passos abaixo conectado como OWNER (`DATABASE_MIGRATION_URL`),
exceto os testes da secao 8, que rodam como `sgs_app` / `sgs_admin`.

1. Provisionar `sgs_admin` no banco de staging (passos S1-S3 abaixo).
2. Setar `DATABASE_ADMIN_URL` no staging (role `sgs_admin`, endpoint DIRETO).
3. Deploy do codigo das fases 1a-1d.
4. Validar: login OK; operacao normal de tenant OK; LGPD/forense OK via pool dedicado.
5. Rodar os testes de isolamento (secao 8) ANTES do REVOKE (baseline).
6. So depois de tudo verde: aplicar `S-REV` (REVOKE em staging) e repetir a secao 8.

```sql
-- S1. Snapshot dos grants ATUAIS de sgs_app (evidencia + fonte do rollback).
--     Nao basta a membership: capturamos os grants de TABELA e de SEQUENCE,
--     porque e isso que o rollback precisa restaurar se algo for revogado por engano.
SELECT r.rolname AS member, g.rolname AS granted_role
FROM pg_auth_members m
JOIN pg_roles r ON r.oid = m.member
JOIN pg_roles g ON g.oid = m.roleid
WHERE g.rolname = 'sgs_rls_bypass'
ORDER BY 1;

-- Grants de tabela de sgs_app (guardar a saida como evidencia/rollback):
SELECT table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE grantee = 'sgs_app' AND table_schema = 'public'
GROUP BY table_name
ORDER BY table_name;

-- Grants de sequence de sgs_app:
SELECT sequence_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
FROM information_schema.role_usage_grants
WHERE grantee = 'sgs_app'
ORDER BY sequence_name;

-- S2. Criar a role dedicada (senha forte via segredo; NAO commitar a senha).
--     Requer conexao OWNER com CREATEROLE (ver secao 5).
CREATE ROLE sgs_admin LOGIN PASSWORD '<SEGREDO_FORTE>';
GRANT sgs_rls_bypass TO sgs_admin;

-- S3. Conceder a sgs_admin os MESMOS privilegios de dados que sgs_app tem.
--     SQL validado (idempotente): cobre tabelas e sequences existentes e futuras.
GRANT USAGE ON SCHEMA public TO sgs_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sgs_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sgs_admin;
-- Objetos criados no futuro por migrations (owner) tambem devem ficar acessiveis:
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sgs_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sgs_admin;

-- Conferir que sgs_admin ficou com a mesma cobertura de sgs_app (diff deve ser vazio):
SELECT table_name FROM information_schema.role_table_grants
  WHERE grantee = 'sgs_app' AND table_schema = 'public' AND privilege_type = 'SELECT'
EXCEPT
SELECT table_name FROM information_schema.role_table_grants
  WHERE grantee = 'sgs_admin' AND table_schema = 'public' AND privilege_type = 'SELECT';
-- esperado: 0 linhas

-- S-REV. (SO apos secao 8 verde em staging) fecha o vetor no runtime comum:
REVOKE sgs_rls_bypass FROM sgs_app;
```

## 7. FASE 3 — producao (janela controlada)

Pre-requisitos: BACKUP recente confirmado; conexao OWNER (`DATABASE_MIGRATION_URL`)
disponivel; janela de menor uso; fases 1a-1d ja deployadas e validadas em staging;
secao 8 verde em staging (antes e depois de `S-REV`).

Ordem (NAO pular). Executar P1-P3 como OWNER; validar; so entao P-REV.

```sql
-- P1. Snapshot dos grants atuais (mesmas 3 consultas do passo S1). Guardar a saida:
--     e a evidencia inicial E a referencia para reconstruir grants caso necessario.
--     (Ver os 3 SELECTs de S1.)

-- P2. Criar a role dedicada (identico a S2). Requer OWNER + CREATEROLE.
CREATE ROLE sgs_admin LOGIN PASSWORD '<SEGREDO_FORTE>';
GRANT sgs_rls_bypass TO sgs_admin;

-- P3. Conceder privilegios de dados a sgs_admin (identico a S3).
--     (Ver o bloco GRANT ... / ALTER DEFAULT PRIVILEGES ... de S3.)

-- P3b. Setar DATABASE_ADMIN_URL no Coolify (sgs_admin, endpoint DIRETO) e fazer deploy.
--      Validar /health e um fluxo de LGPD/forense em modo seguro ANTES do P-REV.

-- P-REV. O passo que fecha o vetor (apos P3b validado):
REVOKE sgs_rls_bypass FROM sgs_app;
```

## 8. Testes de isolamento

Usar duas empresas de teste (companyA, companyB). Rodar a bateria completa como
`sgs_app` (deve BLOQUEAR cross-tenant) e depois como `sgs_admin` (deve CONTINUAR
enxergando cross-tenant, para LGPD/forense).

Os testes de escrita usam uma tabela real com RLS FORCE (`aprs`) dentro de uma
transacao com ROLLBACK, para nao deixar residuo. Substitua `<companyA>`/`<companyB>`
por UUIDs reais de empresas de teste; `<algum_apr_de_B>` por um id de APR do tenant B.

```sql
-- Contexto de tenant A
SELECT set_config('app.current_company_id','<companyA>',false),
       set_config('app.is_super_admin','false',false);

-- 8.1 READ cross-tenant deve retornar 0 linhas de B (como sgs_app)
SELECT count(*) FROM users WHERE company_id = '<companyB>';   -- esperado: 0

-- 8.2 Tentar escalar via flag (o vetor) — deve NAO conceder bypass
SELECT set_config('app.is_super_admin','true',false);
SELECT count(*) FROM users WHERE company_id = '<companyB>';   -- esperado: 0 (pg_has_role falha para sgs_app)
SELECT public.is_super_admin();                               -- esperado: false (sgs_app)
SELECT set_config('app.is_super_admin','false',false);        -- limpar a flag

-- 8.3 INSERT / UPDATE / DELETE cross-tenant (como sgs_app).
--     Expectativas com RLS FORCE + WITH CHECK:
--       INSERT com company_id de B -> ERRO (new row violates row-level security policy)
--       UPDATE de linhas de B      -> 0 linhas afetadas (USING filtra antes)
--       DELETE de linhas de B      -> 0 linhas afetadas (USING filtra antes)
BEGIN;
  -- INSERT: esperar erro de RLS (transacao aborta; o ROLLBACK abaixo cobre isso)
  INSERT INTO aprs (id, company_id, site_id, titulo, status, created_at, updated_at)
  VALUES (gen_random_uuid(), '<companyB>', NULL, 'x', 'RASCUNHO', now(), now());
ROLLBACK;

BEGIN;
  UPDATE aprs SET updated_at = now() WHERE company_id = '<companyB>';  -- esperado: UPDATE 0
  DELETE FROM aprs WHERE company_id = '<companyB>';                     -- esperado: DELETE 0
ROLLBACK;

-- 8.4 Fail-closed sem contexto de tenant (como sgs_app)
SELECT set_config('app.current_company_id','',false);
SELECT count(*) FROM users;                                  -- esperado: 0 (current_company() -> NULL, policy nega)
```

Depois de rodar 8.1-8.4 como `sgs_app`, reconectar como `sgs_admin` e repetir:

- 8.1 deve retornar a contagem REAL de usuarios de B (bypass legitimo).
- 8.3 INSERT/UPDATE/DELETE cross-tenant devem FUNCIONAR (dentro de transacao + ROLLBACK).
- 8.4 sem contexto deve enxergar todos os tenants (esperado para operacao privilegiada).

## 9. Rollback

> CRITICO: o rollback do hardening e APENAS o GRANT abaixo. NAO rode o `down()` da
> migration `1709000000346`. Aquele `down()` restaura a definicao ANTIGA de
> `is_super_admin()` (que confia so na flag de sessao) e REABRE exatamente o vetor de
> escalonamento que o #137 fechou — via `set_config('app.is_super_admin','true')`.
> Reverter a funcao NAO e necessario para restaurar o funcionamento: reconceder a
> membership ja devolve tudo, mantendo a funcao endurecida.

Se algo quebrar apos o REVOKE:

```sql
-- Rollback seguro e suficiente: devolve o bypass ao runtime comum, mantendo
-- is_super_admin() na versao endurecida (dupla checagem preservada).
GRANT sgs_rls_bypass TO sgs_app;
```

Login/LGPD voltam a funcionar imediatamente na conexao comum. Investigar a causa
antes de retentar o REVOKE. Se algum grant de dados de `sgs_app` tiver sido alterado
por engano, reconstruir a partir da saida guardada em S1/P1.

## 10. Evidencias a registrar

- Saida das 3 consultas de S1/P1 (membership + grants de tabela + grants de sequence, antes/depois).
- Resultado de cada teste 8.1-8.4 (como `sgs_app` e como `sgs_admin`).
- `/health` pos-deploy, um login real, uma operacao LGPD de teste via pool dedicado.
- Confirmacao final de que `sgs_app` NAO e mais membro de `sgs_rls_bypass`:

```sql
SELECT EXISTS (
  SELECT 1
  FROM pg_auth_members m
  JOIN pg_roles member ON member.oid = m.member
  JOIN pg_roles grp    ON grp.oid    = m.roleid
  WHERE grp.rolname = 'sgs_rls_bypass'
    AND member.rolname = 'sgs_app'
) AS sgs_app_ainda_tem_bypass;   -- esperado: false
```

## Criterio de conclusao

Runtime (`sgs_app`) sem `sgs_rls_bypass`; login e LGPD funcionando (definer / conexao
dedicada); leitura e escrita cross-tenant bloqueadas com o papel comum; fail-closed sem
contexto confirmado.

## 11. Encerramento operacional

Validado em 2026-07-27, após a migration 365 e o deploy do SHA
`6c1c40815167f43c05ad7affd2df8f53d3dd7282`.

- `sgs_app` sem `sgs_rls_bypass`; `sgs_admin` com a membership dedicada.
- Probe real de RLS como `sgs_app`: sem contexto `0`, tenant próprio `1`,
  tenant alheio `0`.
- Cinco backups reais pós-REVOKE gerados e validados com AES-256-GCM e checksum.
- Maior backup restaurado em PostgreSQL reconstruído por 287 migrations:
  67 tabelas e 91.278 linhas após reconciliação de catálogos globais.
- Zero linhas cross-tenant em 125 relações com `company_id`.
- 34/34 documentos do tenant restaurado presentes no B2 e com hash válido.
- RTO observado de 21m34s, abaixo da meta de 4h; RPO de 28m38s, abaixo da meta
  de 24h.

As evidências detalhadas, os IDs anonimizados dos backups e a ressalva da
constraint legado `NOT VALID` estão na seção 4.7 de
`backend/docs/RUNBOOK_PRODUCTION.md`.

---

## Contrato de conexões após a migration 361 (atualizado 2026-08-11)

### A regra

```text
sgs_app    = runtime. SEM bypass de RLS. Sempre com tenant no contexto.
sgs_admin  = operações cross-tenant privilegiadas (DATABASE_ADMIN_URL).

NUNCA usar a conexão de runtime como fallback para uma operação
que dependa de enxergar linhas que a RLS pode ocultar.
```

### Por que o fallback deixou de ser equivalente

`is_super_admin()` começa checando `pg_has_role(current_user,'sgs_rls_bypass','MEMBER')`.
Depois da 361, `sgs_app` não é mais membro — então `SET LOCAL app.is_super_admin = 'true'`
virou **no-op** nessa conexão.

O ponto que passou despercebido por semanas: isso não gera erro. Sem tenant no
contexto, `SELECT` devolve **0 linhas** e `UPDATE`/`DELETE` afetam **0 linhas**,
silenciosamente. Três formas de falhar:

| Forma | Sintoma |
|---|---|
| SELECT com 0 linhas | o código conclui "não existe" e segue por um ramo alternativo |
| UPDATE com 0 linhas | o TypeORM não reclama; a operação reporta sucesso sem ter feito nada |
| **Guarda fail-open** | `if (count > 0) throw` nunca dispara — o pior dos três |

### Como escrever código novo

Pergunta obrigatória em qualquer query que decida uma condição:

> **Se esta query devolver zero linhas por causa da RLS, o código libera ou bloqueia?**

Se libera, use a variante que **falha fechado**:

```ts
// SQL literal
await privilegedDb.withRequiredPrivilegedClient('minha_operacao', async (client) => { ... });

// entidades TypeORM
await provisioningDataSource.requiredTransaction('minha_operacao', async (manager) => { ... });
```

Ambas respondem **503** e emitem `{ event: 'privileged_connection_required', severity: 'HIGH' }`
quando `DATABASE_ADMIN_URL` está ausente. **Não** as envolva em `try/catch` que
converta a exceção em caminho alternativo.

`isEnabled()` / `isDedicated()` servem para health check e telemetria — **não**
para escolher caminho de execução.

### DATABASE_ADMIN_URL — decisão de arquitetura

Continua **opcional no boot**, inclusive em produção. Torná-la obrigatória
converteria um erro de configuração em queda total da API (login incluso). O
contrato adotado é mais cirúrgico:

1. `PrivilegedDbService.onModuleInit` loga `ERROR` em produção se faltar;
2. cada operação cross-tenant falha fechado (503) em vez de degradar;
3. `GET /health/detailed` → `checks.admin_operations` reporta o estado.

Deliberadamente **fora** de `/health/ready`: sem a conexão privilegiada, login,
leitura e escrita dentro de um tenant continuam corretos. Tirar a API do
balanceador seria pior que bloquear só as operações administrativas.

### Tabelas cuja ESCRITA é impossível para `sgs_app`

Policies que exigem `is_super_admin()` **sem cláusula de tenant** — para estas,
qualquer escrita pelo runtime é descartada em silêncio, com ou sem `x-company-id`:

- `profiles` (INSERT/UPDATE/DELETE)
- `gdpr_retention_cleanup_runs` (ALL)
- `disaster_recovery_executions` (ALL)

Exceções que ainda funcionam pelo runtime, porque leem
`current_setting('app.is_super_admin')` direto: `companies` (migrations 364/372),
`photographic_reports` e filhas (368), `epis` (315), `user_sites` (336).

### Funções SQL e o papel que pode executá-las

| Função | SECURITY DEFINER | Quem executa |
|---|---|---|
| `find_login_user`, `find_user_bridge`, `update_login_user_password_hash`, `reset_login_user_password` | sim | `sgs_app` |
| `gdpr_delete_user_data`, `cleanup_expired_data` | **não** | **só `sgs_admin`** (migration 374) |

As duas de GDPR não são SECURITY DEFINER de propósito: rodam com o privilégio de
quem chama, e só `sgs_admin` reúne EXECUTE + membership em `sgs_rls_bypass`.
Conceder EXECUTE a `sgs_app` daria a qualquer sessão da aplicação a capacidade de
disparar anonimização em massa.
