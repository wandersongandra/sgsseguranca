# Backup, Restore e Disaster Recovery

Este guia documenta a base executável de resiliência operacional implementada no repositório.

Ele cobre:

- backup do banco PostgreSQL
- proteção do storage governado
- restore seguro
- recovery validado em ambiente separado
- scanner de integridade entre banco, registry e storage
- trilha auditável de execuções críticas

## Objetivo

O sistema agora possui uma base real para:

- gerar backup governado do banco
- manter manifesto e retenção
- registrar execução de backup/restore/scan/replicação
- proteger artefatos oficiais em bucket secundário
- validar recovery em ambiente separado
- detectar gaps entre registry e storage
- provar operacionalmente a recuperação

## Decisão técnica adotada para o storage

### Estratégia escolhida

Foi adotada como estratégia principal:

- **replicação para bucket secundário compatível com S3/R2**

Em vez de depender apenas de versionamento do bucket primário.

### Por que essa estratégia foi escolhida

Porque ela é:

- implementável no contexto atual do projeto
- defensável para Backblaze B2, Cloudflare R2 ou storage S3-compatible equivalente
- compatível com restore em ambiente separado
- mais clara operacionalmente do que uma "cópia lógica" implícita

### O que ela protege

- documentos oficiais do `document_registry`
- vídeos governados
- anexos governados de `CAT`
- anexos governados de `Não Conformidade`
- evidências governadas da `APR`

### O que ela não mascara

- artefato ausente continua sendo ausente
- documento oficial sem artefato continua aparecendo como gap crítico
- fallback degradado não vira documento saudável

## O que foi implementado em código

### Backend

- módulo `backend/src/modules/disaster-recovery`
- entidade `disaster_recovery_executions`
- serviço de execução auditável
- serviço de scanner de integridade
- serviço de réplica secundária:
  - `disaster-recovery-replica-storage.service.ts`
- serviço de proteção do storage:
  - `disaster-recovery-storage-protection.service.ts`

### Scripts

- `npm run dr:backup`
- `npm run dr:backup:dry-run`
- `npm run dr:protect-storage`
- `npm run dr:protect-storage:dry-run`
- `npm run dr:restore`
- `npm run dr:restore:dry-run`
- `npm run dr:recover-environment`
- `npm run dr:recover-environment:dry-run`
- `npm run dr:scan`
- `npm run dr:scan:dry-run`

### Workflow

- `.github/workflows/disaster-recovery-backup.yml`

Esse workflow agora pode:

- gerar backup do banco
- subir o dump governado
- replicar artefatos governados para bucket secundário

quando os secrets necessários estiverem configurados.

## Estratégia de backup implementada

### Banco

Comando principal:

```bash
cd backend
npm run dr:backup -- --trigger-source=manual
```

Ele gera:

- dump do PostgreSQL em formato custom do `pg_dump`
- pasta segregada por ambiente
- manifesto JSON
- trilha local JSONL
- registro em `disaster_recovery_executions`
- upload opcional do dump para o storage governado

### Dry-run seguro

```bash
cd backend
npm run dr:backup:dry-run
```

Observação operacional:

- o dry-run gera manifesto mesmo sem banco local resolvido
- isso valida naming, retenção e fluxo de restore sem vender restore real

### Nome padronizado

```text
db-backup__<ambiente>__<label-opcional>__<timestamp-iso-normalizado>
```

Exemplo:

```text
db-backup__production__nightly__2026-03-23T12-00-00-000Z
```

### Retenção

Configurável por:

- `DR_BACKUP_RETENTION_DAYS`
- ou `--retention-days=<n>`

Default atual:

- `30 dias`

## Estratégia de proteção do storage implementada

### Fluxo

Comando principal:

```bash
cd backend
npm run dr:protect-storage -- --execute --trigger-source=manual
```

Dry-run:

```bash
cd backend
npm run dr:protect-storage:dry-run
```

### O que o fluxo faz

1. executa o scanner/inventário das fontes governadas
2. identifica artefatos ausentes na origem
3. compara a chave com o bucket secundário
4. preserva o objeto da réplica quando já existe
5. copia o buffer da origem para o bucket secundário quando necessário
6. registra hash SHA-256 e metadados mínimos da replicação
7. registra a execução em `disaster_recovery_executions`

### Probe sintético da réplica

Para validar somente o caminho da réplica, sem selecionar ou ler objetos de
clientes e sem inicializar o contexto da aplicação/banco:

```bash
cd backend
npm run dr:protect-storage -- --execute --synthetic-probe
```

Esse modo gera bytes aleatórios em `sgs-dr-probe/<uuid>/probe.bin`, executa
`PutObject` e `GetObject`, compara SHA-256 ponta a ponta e remove o objeto em
`finally`, inclusive após falha intermediária. Qualquer falha, incluindo
`DeleteObject`, retorna código não zero. O probe não grava banco nem bucket
primário e resolve a configuração apenas de:
`DR_STORAGE_REPLICA_BUCKET`, `DR_STORAGE_REPLICA_ENDPOINT`,
`DR_STORAGE_REPLICA_REGION`, `DR_STORAGE_REPLICA_ACCESS_KEY_ID`,
`DR_STORAGE_REPLICA_SECRET_ACCESS_KEY` e `DR_STORAGE_REPLICA_FORCE_PATH_STYLE`.
Credenciais `AWS_*` nunca são usadas como fallback.

### Regras operacionais

- não sobrescreve por padrão
- só sobrescreve com `--force-replace`
- mantém a mesma `storage key` para facilitar recovery
- não inventa disponibilidade quando a origem está ausente

### Variáveis da réplica

- `DR_STORAGE_REPLICA_BUCKET`
- `DR_STORAGE_REPLICA_REGION`
- `DR_STORAGE_REPLICA_ENDPOINT`
- `DR_STORAGE_REPLICA_ACCESS_KEY_ID`
- `DR_STORAGE_REPLICA_SECRET_ACCESS_KEY`
- `DR_STORAGE_REPLICA_FORCE_PATH_STYLE`

## Estratégia de restore implementada

### Restore do banco

Comando:

```bash
cd backend
npm run dr:restore -- --execute --backup-manifest=output/disaster-recovery/backups/<environment>/database/<backup-name>/manifest.json --target-db-url=postgres://...
```

Dry-run:

```bash
cd backend
npm run dr:restore:dry-run -- --backup-manifest=output/disaster-recovery/backups/<environment>/database/<backup-name>/manifest.json
```

### Proteções implementadas

- restore exige manifesto
- dry-run existe e deve ser o primeiro passo
- restore real exige `--execute`
- restore em produção é bloqueado por padrão
- produção só libera com dupla confirmação explícita
- validação SQL pós-restore é executada

## Recovery validado em ambiente separado

### Comando orquestrador

```bash
cd backend
npm run dr:recover-environment -- --execute --backup-manifest=output/disaster-recovery/backups/<environment>/database/<backup-name>/manifest.json --target-db-url=postgres://... --target-environment=recovery
```

Dry-run:

```bash
cd backend
npm run dr:recover-environment:dry-run -- --backup-manifest=output/disaster-recovery/backups/<environment>/database/<backup-name>/manifest.json --target-environment=recovery
```

### O que esse fluxo faz

1. valida que origem e alvo são ambientes distintos
2. executa `dr-restore.ts` no banco alvo
3. executa `dr-integrity-scan.ts` no ambiente restaurado
4. aponta o scanner para:
   - bucket de réplica, por padrão
   - ou bucket primário, se `--storage-mode=primary`
5. grava relatório final do recovery validation
6. registra execução auditável de `environment_recovery_validation`

### Proteções importantes

- não permite recovery real no mesmo ambiente por padrão
- continua herdando o bloqueio forte de produção do `dr-restore.ts`
- `target-environment=recovery|sandbox` é mapeado para `NODE_ENV=staging`
- o rótulo real do ambiente é preservado em `DR_ENVIRONMENT_NAME`

## Scanner de integridade

### Comando

```bash
cd backend
npm run dr:scan -- --include-orphans --verify-hashes
```

### Dry-run

```bash
cd backend
npm run dr:scan:dry-run
```

### O que ele valida

- documento no `document_registry` sem artefato físico
- hash divergente em documento oficial
- vídeo governado faltando
- anexo governado faltando
- evidência governada da APR faltando
- hash divergente de evidência da APR
- órfãos no storage sob prefixes suportados
- resumo do alvo efetivo de storage consultado pelo scanner

### Fontes cobertas

- `document_registry`
- `document_video_attachments`
- anexos governados de `CAT`
- anexos governados de `Não Conformidade`
- evidências governadas de `APR`

## RPO e RTO propostos

Valores iniciais propostos:

- `RPO inicial`: `24 horas`
- `RTO inicial`: `4 horas`

Hipótese operacional:

- existe pelo menos um backup diário automatizado
- o bucket secundário está configurado e acessível
- existe banco alvo separado para recovery
- a equipe executa o runbook e o scanner pós-restore

## Runbook resumido

### 1. Confirmar o tipo do incidente

- perda só no banco?
- perda só no storage?
- corrupção entre registry e storage?
- incidente em produção, staging ou recovery?

### 2. Executar dry-runs

```bash
cd backend
npm run dr:backup:dry-run
npm run dr:protect-storage:dry-run
npm run dr:restore:dry-run -- --backup-manifest=...
npm run dr:recover-environment:dry-run -- --backup-manifest=... --target-environment=recovery
```

### 3. Confirmar pré-condições do recovery real

- `pg_dump` e `pg_restore` disponíveis
- banco alvo separado provisionado
- credenciais válidas do banco alvo
- bucket secundário configurado
- chaves válidas do storage
- confirmação explícita se houver qualquer passo em produção

### 4. Rodar backup e proteção do storage

```bash
cd backend
npm run dr:backup -- --trigger-source=manual --upload-to-storage
npm run dr:protect-storage -- --execute --trigger-source=manual
```

### 5. Rodar recovery validado em ambiente separado

```bash
cd backend
npm run dr:recover-environment -- --execute --backup-manifest=... --target-db-url=postgres://... --target-environment=recovery
```

### 6. Validar resultado

Checks mínimos:

- contagem de tabelas públicas
- contagem de empresas
- contagem de `document_registry`
- scanner sem perda silenciosa crítica
- storage keys resolvíveis no bucket escolhido
- hashes coerentes quando `--verify-hashes`

## Passos proibidos

- restaurar produção sem confirmação explícita
- usar o mesmo ambiente como alvo real sem liberação intencional
- tratar fallback degradado como documento oficial saudável
- mascarar bucket ausente como réplica válida
- sobrescrever a réplica por padrão sem `--force-replace`

## Dependências de infraestrutura externa

O que o repositório já entrega:

- scripts
- módulo de DR
- registro de execuções
- scanner de integridade
- workflow agendável
- runbook

O que depende de infra externa:

- `pg_dump` / `pg_restore`
- PostgreSQL de origem e de recovery
- bucket secundário real no Backblaze B2, Cloudflare R2 ou storage S3-compatible equivalente
- credenciais válidas da réplica
- versionamento/bucket lock do provedor, se desejado como camada extra

## Limitações reais desta rodada

- a replicação física entre buckets depende de bucket secundário provisionado
- o restore real em ambiente separado depende de banco alvo externo
- o scanner real continua exigindo banco e storage acessíveis
- proteção extra como bucket lock/versioning nativo continua sendo configuração do provedor, não do app

## Onde olhar no código

- `backend/src/modules/disaster-recovery`
- `backend/scripts/dr-backup.ts`
- `backend/scripts/dr-protect-storage.ts`
- `backend/scripts/dr-restore.ts`
- `backend/scripts/dr-recover-environment.ts`
- `backend/scripts/dr-integrity-scan.ts`
- `.github/workflows/disaster-recovery-backup.yml`
