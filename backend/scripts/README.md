# Scripts de Segurança e Manutenção

## 📜 Scripts Disponíveis

### 🔐 generate-secrets.sh
Gera secrets criptograficamente seguros para produção.

**Uso:**
```bash
./scripts/generate-secrets.sh
```

**Saída:**
- JWT_SECRET (64 bytes)
- ENCRYPTION_KEY (32 bytes)
- ENCRYPTION_SALT (16 bytes)
- REDIS_PASSWORD (32 bytes)
- DATABASE_PASSWORD (24 bytes)
- BACKUP_SECRET_KEY (32 bytes)

---

### 🔒 init-ssl.sh
Configura certificados SSL usando Let's Encrypt.

**Uso:**
```bash
./scripts/init-ssl.sh seu-dominio.com seu-email@example.com
```

**Pré-requisitos:**
- Domínio apontando para o servidor
- Porta 80 acessível
- Docker Compose rodando

---

### 💾 dr-backup.ts
Cria backup governado do banco PostgreSQL com manifesto, retenção e trilha local/auditável.

**Uso:**
```bash
# Dry-run seguro
npm run dr:backup:dry-run

# Execução real
npm run dr:backup -- --trigger-source=manual

# Execução real com cópia do artefato para o storage governado
npm run dr:backup -- --trigger-source=manual --upload-to-storage
```

**Recursos:**
- pg_dump em formato custom (`pg_restore`)
- Manifesto JSON por execução
- Retenção configurável
- Separação por ambiente
- Trilha local em JSONL
- Registro em `disaster_recovery_executions`
- Upload opcional do artefato para o storage governado

**Observação operacional:**
- o dry-run gera manifesto e prova do fluxo mesmo sem banco local configurado
- a execução real continua exigindo `pg_dump` e credenciais válidas

**Restaurar backup:**
```bash
npm run dr:restore:dry-run -- --backup-manifest=output/disaster-recovery/backups/production/database/<backup>/manifest.json
npm run dr:restore -- --execute --backup-manifest=output/disaster-recovery/backups/production/database/<backup>/manifest.json --target-db-url=postgres://...
```

---

### 🧪 dr-integrity-scan.ts
Executa scanner de consistência entre registry, storage governado, vídeos, anexos e evidências.

**Uso:**
```bash
# Dry-run seguro
npm run dr:scan:dry-run

# Scanner real
npm run dr:scan -- --include-orphans

# Scanner real com verificação de hash
npm run dr:scan -- --include-orphans --verify-hashes
```

**Observação operacional:**
- o scanner real depende de banco/configuração do ambiente acessíveis
- se o bootstrap do app falhar por credenciais locais ou serviços externos indisponíveis, a falha deve ser tratada como limitação real do ambiente

**Detecta pelo menos:**
- documentos no registry sem artefato físico
- hash divergente em documento oficial
- vídeos governados indisponíveis
- anexos governados indisponíveis
- evidências governadas da APR inconsistentes
- órfãos no storage sob os prefixes governados suportados

---

### ♻️ dr-restore.ts
Executa restore seguro com dry-run padrão, bloqueio forte para produção e validação pós-restore.

**Uso:**
```bash
# Dry-run
npm run dr:restore:dry-run -- --backup-manifest=output/disaster-recovery/backups/production/database/<backup>/manifest.json

# Restore real para ambiente alvo
npm run dr:restore -- --execute --backup-manifest=output/disaster-recovery/backups/production/database/<backup>/manifest.json --target-db-url=postgres://...
```

**Proteções:**
- não restaura sem manifesto
- dry-run por padrão
- bloqueia produção sem confirmação explícita
- faz validação SQL pós-restore
- pode disparar integrity scan pós-restore

---

### 🛡️ dr-protect-storage.ts
Replica artefatos governados do storage principal para um bucket secundário de recovery.

**Uso:**
```bash
# Dry-run seguro
npm run dr:protect-storage:dry-run

# Execução real
npm run dr:protect-storage -- --execute --trigger-source=manual

# Probe sintético somente na réplica (sem Nest, banco ou objetos de clientes)
npm run dr:protect-storage -- --execute --synthetic-probe

# Execução real restrita a uma empresa e forçando overwrite
npm run dr:protect-storage -- --execute --company-id=<uuid> --force-replace
```

**Estratégia implementada:**
- bucket secundário compatível com S3/R2
- preserva a mesma `storage key`
- não sobrescreve por padrão
- registra hash SHA-256 do objeto replicado
- registra execução em `disaster_recovery_executions`

O modo `--execute --synthetic-probe` é uma operação separada para validar a
réplica sem inventariar artefatos governados. Ele gera 64 KiB aleatórios,
usa uma chave exclusiva `sgs-dr-probe/<uuid>/probe.bin`, executa `PutObject`,
`GetObject`, compara SHA-256 e remove o objeto em `finally`. Não lê objetos
de clientes, não grava banco e retorna código não zero em qualquer falha,
inclusive falha de limpeza. Ele exige exclusivamente as seis variáveis
`DR_STORAGE_REPLICA_*` abaixo; não há fallback para credenciais `AWS_*`.

**Variáveis esperadas:**
- `DR_STORAGE_REPLICA_BUCKET`
- `DR_STORAGE_REPLICA_REGION`
- `DR_STORAGE_REPLICA_ENDPOINT`
- `DR_STORAGE_REPLICA_ACCESS_KEY_ID`
- `DR_STORAGE_REPLICA_SECRET_ACCESS_KEY`
- `DR_STORAGE_REPLICA_FORCE_PATH_STYLE`

---

### 🪣 storage-bucket-cutover.ts
Inventaria e copia objetos entre buckets S3/R2 preservando a mesma key, com `dry-run` por padrão e relatório JSON versionado.

**Uso:**
```bash
# Inventário + plano sem copiar nada
npm run storage:bucket-cutover:dry-run -- --target-bucket=sgs-01 --target-endpoint=https://<account>.r2.cloudflarestorage.com --target-region=auto --target-force-path-style=true

# Execução real preservando todas as keys
npm run storage:bucket-cutover -- --target-bucket=sgs-01 --target-endpoint=https://<account>.r2.cloudflarestorage.com --target-region=auto --target-force-path-style=true

# Execução real com limite e prefixo (janela controlada / homologação)
npm run storage:bucket-cutover -- --target-bucket=sgs-01 --prefix=documents/ --max-keys=100 --sample-size=10
```

**Fonte de configuração:**
- origem: `AWS_BUCKET_NAME` / `AWS_S3_BUCKET`, `AWS_ENDPOINT` / `AWS_S3_ENDPOINT`, `AWS_REGION`, credenciais `AWS_*`
- destino: flags `--target-*` ou envs `STORAGE_MIGRATION_TARGET_*`
- se as credenciais do destino não forem informadas, o script reutiliza as credenciais `AWS_*`

**Recursos:**
- inventário com total de objetos, bytes totais e agrupamento por prefixo
- cópia preservando a key original
- validação pós-cópia por contagem de keys e amostra com SHA-256
- item log em JSONL para auditoria
- `--force-replace` para sobrescrever objetos já presentes no destino

**Saídas:**
- relatório: `output/disaster-recovery/reports/<env>/storage-bucket-cutover-<timestamp>.json`
- item log: `output/disaster-recovery/reports/<env>/storage-bucket-cutover-<timestamp>.items.jsonl`
- auditoria: `output/disaster-recovery/audit/storage-bucket-cutover.jsonl`

---

### ✍️ reconcile-signature-storage.js
Reconcilia objetos de assinatura ja externalizados no banco (`signatures.signature_data_key`) entre o storage antigo e o storage alvo atual. Use antes de apontar producao para um bucket novo.

**Uso:**
```bash
# Verifica se o storage alvo contem todas as signatures ja externalizadas
npm run signatures:storage:verify

# Planeja copia das keys ausentes no alvo, lendo a origem antiga
npm run signatures:storage:reconcile:dry

# Copia objetos ausentes preservando exatamente a mesma key
npm run signatures:storage:reconcile:apply
```

**Destino:**
- usa `AWS_BUCKET_NAME` / `AWS_S3_BUCKET`, `AWS_ENDPOINT` / `AWS_S3_ENDPOINT`, `AWS_REGION`, `S3_FORCE_PATH_STYLE` e credenciais `AWS_*`

**Origem antiga:**
- `SIGNATURE_STORAGE_SOURCE_BUCKET`
- `SIGNATURE_STORAGE_SOURCE_ENDPOINT`
- `SIGNATURE_STORAGE_SOURCE_REGION`
- `SIGNATURE_STORAGE_SOURCE_ACCESS_KEY_ID`
- `SIGNATURE_STORAGE_SOURCE_SECRET_ACCESS_KEY`
- `SIGNATURE_STORAGE_SOURCE_FORCE_PATH_STYLE`

**Protecoes:**
- `dry-run` por padrao
- `apply` exige origem configurada
- bloqueia origem e destino iguais
- valida hash contra `integrity_payload.signature_evidence_hash` quando disponivel
- `verify-only` falha fechado se qualquer key do banco estiver ausente no storage alvo

---

### ✍️ externalize-signature-data.js
Externaliza assinaturas ainda inline (`signatures.signature_data`) para storage S3-compatible e grava `signature_data_key`.

**Uso:**
```bash
# Planeja as assinaturas inline sem alterar banco/storage
npm run signatures:externalize:dry

# Verifica objetos ja externalizados
npm run signatures:externalize:verify

# Externaliza assinaturas inline
npm run signatures:externalize:apply
```

**Legado/teste descartavel:**
Se o banco ainda referencia objetos antigos que foram apenas teste e nao precisam bloquear a externalizacao nova, use a variante explicita:

```bash
npm run signatures:externalize:apply:ignore-missing-existing
npm run signatures:externalize:verify:ignore-missing-existing
```

Essa flag ignora apenas objetos ja externalizados ausentes no bucket alvo. Ela nao ignora falhas de upload, divergencia de hash nem erro de update no banco.

---

### 🧪 dr-recover-environment.ts
Orquestra o recovery validado em ambiente separado, restaurando o banco alvo e executando scanner pós-restore apontado para o storage escolhido.

**Uso:**
```bash
# Dry-run do fluxo completo
npm run dr:recover-environment:dry-run -- --backup-manifest=output/disaster-recovery/backups/production/database/<backup>/manifest.json --target-environment=recovery

# Execução real usando storage de réplica
npm run dr:recover-environment -- --execute --backup-manifest=output/disaster-recovery/backups/production/database/<backup>/manifest.json --target-db-url=postgres://... --target-environment=recovery

# Execução real validando contra o storage primário
npm run dr:recover-environment -- --execute --storage-mode=primary --backup-manifest=output/disaster-recovery/backups/production/database/<backup>/manifest.json --target-db-url=postgres://... --target-environment=staging
```

**O que ele faz:**
- valida que o ambiente alvo é separado do de origem
- chama `dr-restore.ts` em modo real com `--skip-post-restore-scan`
- executa `dr-integrity-scan.ts --include-orphans --verify-hashes`
- aponta o scanner para o bucket de recovery quando `storage-mode=replica`
- registra trilha local e execução auditável do recovery validation

**Proteções:**
- não aceita restore real sem `--execute`
- não aceita restore real no mesmo ambiente por padrão
- continua herdando o bloqueio forte de produção do `dr-restore.ts`
- mapeia `target-environment=recovery|sandbox` para `NODE_ENV=staging`, preservando o rótulo real em `DR_ENVIRONMENT_NAME`

---

### 🧾 recover-ajn-quality-from-csv.ts
Recupera `companies + users` por CSV (estratégia `insert-only`), com `dry-run`, `apply`, relatório JSON e SQL de rollback.

**Uso:**
```bash
# Simulação (não grava no banco)
npm run recovery:ajn-quality:dry -- --file=scripts/recovery/templates/ajn-quality-recovery.template.csv

# Execução real (insere faltantes e dispara forgot password para usuários novos)
npm run recovery:ajn-quality -- --file=scripts/recovery/ajn-quality.csv
```

**CSV esperado:**
- obrigatórios: `razao_social, cnpj, endereco, responsavel, nome, email, cpf, funcao`
- opcionais: `email_contato_empresa, perfil`

**Pré-requisitos de ambiente:**
- `DATABASE_URL` apontando para o Postgres/Neon
- `DATABASE_SSL=true`
- `DATABASE_SSL_ALLOW_INSECURE=false`

**Saídas:**
- relatório: `output/recovery/ajn-quality/recovery-<timestamp>.report.json`
- rollback: `output/recovery/ajn-quality/recovery-<timestamp>.rollback.sql`

---

### 🔐 recover-rbac-production.ts
Repara RBAC em produção com base no `PROFILE_PERMISSION_FALLBACK`, corrigindo `profiles.permissoes`, recompondo `user_roles`, reconciliando `role_permissions` e invalidando cache/sessões no Redis.

**Uso:**
```bash
# Simulação (não grava no banco e não invalida Redis)
npm run recovery:rbac:dry

# Execução real
npm run recovery:rbac
```

**Comportamento:**
- transação `SERIALIZABLE` no modo `--apply`
- preenche apenas dados faltantes/inválidos (sem remover customizações existentes)
- recria vínculos por `users.profile_id -> profiles.nome -> roles.name`
- invalida `rbac:access:*` e, por padrão, força renovação de sessão removendo chaves `refresh:*`

**Saída:**
- relatório: `output/recovery/rbac-production/recover-rbac-<timestamp>.report.json`

---

### 🔍 verify-tenant-rls.js
Valida RLS tenant-aware nas tabelas com colunas de tenant do schema informado, com saída estruturada em JSON.

**Uso:**
```bash
# Resumo textual (schema public)
npm run verify:rls

# JSON para CI/ops
npm run verify:rls:json

# Schema específico
node scripts/verify-tenant-rls.js --schema=tmp_homolog_rls_20260331 --json
```

**Recursos:**
- parse robusto de `tenant_columns` (array texto/array nativo)
- valida `USING + WITH CHECK + is_super_admin()`
- relatório versionável com status e falhas por tabela

---

### 📊 smoke-db-readonly.js
Executa smoke read-only de banco com foco em conectividade, consistência e latência operacional.

**Uso:**
```bash
# Execução padrão
npm run smoke:db:readonly

# Saída JSON
npm run smoke:db:readonly:json

# Ajuste de iterações/limite de alerta
node scripts/smoke-db-readonly.js --iterations=15 --latency-warn-ms=250 --json
```

**Métricas coletadas:**
- conectividade e identidade do banco
- contagens críticas (`users`, `companies`, `aprs`, `dds`, etc.)
- duplicidades (`users.cpf`, `users.email`, `companies.cnpj`)
- latência `p50/p95` de queries-chave
- `pg_stat_user_tables`, estado de conexões e `pg_stat_statements` (quando disponível)

**Saída:**
- relatório JSON em `temp/db-smoke-readonly-<schema>-<timestamp>.json`

---

### 🧪 homolog-rls-temp-schema.js
Pipeline de homologação técnica no mesmo banco (Neon) via schema temporário para validar RLS antes de aplicar em `public`.

**Uso:**
```bash
# Execução padrão (cria/valida/remove schema temporário)
npm run homolog:rls:tmp

# Saída JSON
npm run homolog:rls:tmp:json

# Manter schema temporário para inspeção
node scripts/homolog-rls-temp-schema.js --keep-schema --json
```

**Escopo atual:**
- `document_video_attachments`
- `forensic_trail_events`
- `pdf_integrity_records`
- `monthly_snapshots`

---

### 🔑 recover-null-password-users.ts
Higiene de usuários ativos sem senha via atualização auditável de e-mail + disparo de reset (`forgot-password`) por CPF.

**Uso:**
```bash
# Dry-run (lista candidatos e gera template)
npm run recovery:null-password:dry

# Apply real (exige map-file CPF->email)
npm run recovery:null-password -- --map-file=scripts/recovery/templates/null-password-users-email-map.template.json
```

**Template:**
- `scripts/recovery/templates/null-password-users-email-map.template.json`

**Regras:**
- não define senha manual temporária
- atualiza somente usuários ativos sem senha
- registra relatório com status de update e disparo de reset

---

### 🚪 Cutover para Supabase Auth (HISTÓRICO — COMPLETO)

> **Nota:** O cutover do Supabase Auth foi concluído. O Supabase foi removido da stack. A autenticação agora é feita inteiramente via JWT nativo com PostgreSQL (Neon). Esta seção é mantida apenas como registro histórico.

Fluxo que foi seguido para desligar a autenticação legada por `public.users.password` sem quebrar produção:

1. manter `SUPABASE_AUTH_SYNC_ENABLED=true`
2. manter `SUPABASE_PASSWORD_SYNC_ON_LOCAL_LOGIN=true`
3. manter `LEGACY_PASSWORD_AUTH_ENABLED=true` durante a transição
4. deixar os usuários ativos migrarem organicamente via login local bem-sucedido
5. rodar `npm run auth:sync:supabase` para garantir o bridge `public.users.auth_user_id`
6. usar `POST /auth/forgot-password` / `POST /auth/reset-password` ou `npm run recovery:null-password` para os remanescentes
7. só então desligar `LEGACY_PASSWORD_AUTH_ENABLED=false`

**Observação importante (histórica):**
- quando `LEGACY_PASSWORD_AUTH_ENABLED=false`, o backend deixa de usar `public.users.password` como fonte canônica.
- `POST /auth/login`, `POST /auth/change-password` e `POST /auth/confirm-password` continuam funcionando, mas a verificação passa a usar `auth.users.encrypted_password`.
- nesse ponto, o backend deve estar com `SUPABASE_JWT_SECRET` configurado para validar também os JWTs emitidos pelo projeto.
- o frontend pode continuar usando o fluxo atual via API; autenticação direta no client do Supabase vira uma opção arquitetural, não mais uma exigência do cutover.

**Diagnóstico operacional (histórico):**
```bash
# Resumo textual
npm run auth:cutover:readiness

# JSON versionável
npm run auth:cutover:readiness:json
```

**O diagnóstico media pelo menos:**
- usuários ativos com `auth_user_id`
- usuários ativos sem bridge
- usuários ativos com senha utilizável no `auth.users`
- usuários ativos ainda sem senha no `Supabase Auth`
- usuários ativos sem e-mail
- legado de senha local fora do padrão (`argon2` / `bcrypt`)

---

### ⏰ setup-cron-backup.sh
Script legado de cron local.

**Status atual:** legado. Prefira `dr-backup.ts` + workflow `.github/workflows/disaster-recovery-backup.yml`.

---

### 📧 audit-mail-runtime.js
Audita o runtime de e-mail e as filas `mail` / `mail-dlq` com foco operacional pós-incidente.

**Uso:**
```bash
# Auditoria legível
npm run mail:runtime:audit

# Saída JSON
npm run mail:runtime:audit:json

# Prune conservador do histórico de failures da fila principal
npm run mail:runtime:prune-failed

# Prune imediato após incidente resolvido
node scripts/audit-mail-runtime.js --prune-failed --min-age-minutes=0
```

**O que valida:**
- provider configurado no ambiente
- autenticação SMTP ativa via `transporter.verify()`
- contagem de jobs da fila principal `mail`
- contagem e resumo da `mail-dlq`
- prune opcional dos `failed` retidos na fila principal

**Proteções:**
- o prune é ignorado quando a `mail-dlq` ainda possui itens pendentes
- por padrão, o prune exige jobs com pelo menos `1440` minutos de idade
- a `mail-dlq` continua sendo a fonte operacional para retry manual
- se o `REDIS_URL` apontar para hostname privado do Vultr/Coolify e o script rodar fora do runtime do serviço, a inspeção de filas é pulada com `warn` em vez de travar
- para validar filas nesse cenário, rode o script dentro de um one-off job ou sessão SSH do Vultr/Coolify

---

## 🪟 Nota para Windows

Os scripts são escritos para Linux/Unix. No Windows:

1. **Use WSL2** (recomendado):
   ```bash
   wsl
   cd /mnt/c/caminho/do/projeto
   ./scripts/generate-secrets.sh
   ```

2. **Use Git Bash**:
   ```bash
   bash scripts/generate-secrets.sh
   ```

3. **Execute dentro do container Docker**:
   ```bash
   docker-compose exec api bash /app/scripts/generate-secrets.sh
   ```

---

## 🔧 Permissões

No Linux/Mac, torne os scripts executáveis:

```bash
chmod +x scripts/*.sh
```

No Windows com WSL2:
```bash
wsl chmod +x scripts/*.sh
```

---

## 📋 Checklist de Segurança

Antes de ir para produção:

- [ ] Executar `generate-secrets.sh` e atualizar `.env`
- [ ] Executar `init-ssl.sh` para configurar HTTPS
- [ ] Configurar secrets e ativar `.github/workflows/disaster-recovery-backup.yml`
- [ ] Testar `npm run dr:backup -- --trigger-source=manual --upload-to-storage`
- [ ] Testar `npm run dr:protect-storage -- --execute`
- [ ] Testar `npm run dr:restore:dry-run -- --backup-manifest=...`
- [ ] Testar `npm run dr:recover-environment:dry-run -- --backup-manifest=... --target-environment=recovery`
- [ ] Testar `npm run dr:scan -- --include-orphans` em ambiente com banco acessível
- [ ] Verificar que todos os secrets foram alterados
- [ ] Confirmar que `.env` não está no git

---

## 🆘 Suporte

Em caso de problemas:

1. Verificar logs: `docker-compose logs -f`
2. Verificar permissões dos scripts
3. Verificar variáveis de ambiente
4. Consultar `docs/OPERACAO-CANONICA-SGS.md` e, para publicação, `docs/deploy/COMO-COLOCAR-EM-PRODUCAO.md`
