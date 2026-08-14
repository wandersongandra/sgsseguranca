# SGS APR — Fase 4 Final: Adversarial E2E Security Proof

Data: 2026-08-11
Escopo: somente provas adversariais HTTP real + PostgreSQL/RLS + Redis +
storage/migration/concurrency quando executáveis. Nenhuma configuração de
produção foi usada.

## Veredito

**APR SECURITY PARTIALLY VERIFIED**

O repositório agora contém um harness E2E adversarial reproduzível e um job CI
dedicado. A execução local foi **BLOCKED** porque o host não possui Docker,
Docker Compose ou Podman e não havia PostgreSQL/Redis nas portas de teste.
Portanto, nenhum gate HTTP/SQL foi promovido indevidamente a VERIFIED E2E.

### Scores honestos

| Dimensão           | Resultado                         | Evidência                                         |
| ------------------ | --------------------------------- | ------------------------------------------------- |
| APR security final | PARTIALLY VERIFIED                | E2E bloqueado localmente                          |
| E2E adversarial    | E2E PENDING/BLOCKED               | 4 testes compilados, 4 skipped por infra          |
| Content integrity  | VERIFIED UNIT / E2E PENDING       | testes Fase 3.5; tampering HTTP+SQL aguardando CI |
| Forensic integrity | VERIFIED UNIT / E2E PENDING       | fault unitário; fault injection real pendente     |
| Tenant isolation   | STATICALLY VERIFIED / E2E PENDING | suíte multi-tenant existente + harness novo       |
| Site isolation     | STATICALLY VERIFIED / E2E PENDING | guards/queries + cenário A1/A2 preparado          |

## Infraestrutura descoberta

- `backend/docker-compose.test.yml`: PostgreSQL 16 Alpine, Redis 7 Alpine e
  ClamAV de teste.
- `.github/workflows/ci.yml`: job `backend-e2e` com services PostgreSQL 16 e
  Redis 7, reconstrução por migrations e roles `sgs_app`/`sgs_admin`.
- Runtime alvo: NestJS real através de `TestApp`, supertest, JWT login real,
  CSRF real e DataSource TypeORM.
- Migration crítica incluída no worktree:
  `1709000000375-add-apr-signature-content-integrity.ts`.
- Storage: a suíte está pronta para validar os caminhos de PDF existentes, mas
  overwrite/ACL de storage não foi executado localmente.

## Identidades e topologia do harness

| Ator           | Empresa | Obra  | Papel                 | Escopo            |
| -------------- | ------- | ----- | --------------------- | ----------------- |
| `tstA`         | A       | A1    | TST                   | site A1           |
| `adminA`       | A       | A1/A2 | Administrador Empresa | company-wide      |
| `tstB`         | B       | B1    | TST                   | site B1           |
| fixture APR A1 | A       | A1    | documento             | alvo legítimo     |
| fixture APR A2 | A       | A2    | documento             | alvo cross-site   |
| fixture APR B1 | B       | B1    | documento             | alvo cross-tenant |

O seed utiliza contas sintéticas criadas pelo `TestApp`; nenhum token real é
usado. A fixture A2 é criada apenas para a prova e o usuário temporariamente
vinculado ao site é restaurado imediatamente.

## Provas HTTP adversariais implementadas

Arquivo: `backend/test/aprs/apr-phase4-adversarial.e2e-spec.ts`.

| Cenário                    | HTTP                                                  | Pós-condição SQL                        |
| -------------------------- | ----------------------------------------------------- | --------------------------------------- |
| TST A1 contra APR A2       | GET, PATCH, submit, approve, reject, finalize, reopen | `site_id/status/titulo` inalterados     |
| Move-site A1 → A2          | PATCH `/aprs/:id`                                     | `site_id` inalterado                    |
| Mass assignment            | POST com company/status/actor/hash fake               | status 400 e contagem de APR inalterada |
| Assinatura A1 contra A2/B1 | POST `/signatures`                                    | nenhuma nova linha em `signatures`      |
| Assinatura legítima        | POST `/signatures`                                    | colunas V1 persistidas                  |
| Tampering direto           | SQL altera título após assinatura                     | verify retorna `CONTENT_MISMATCH`       |

O job CI executa o teste após a suíte E2E crítica:

```text
npm run test:e2e -- --forceExit aprs/apr-phase4-adversarial.e2e-spec.ts
```

## Resultado da execução nesta sessão

Comandos executados:

```text
docker --version                         BLOCKED (comando indisponível)
docker-compose --version                 BLOCKED
podman --version                         BLOCKED
npm run test:e2e -- ...apr-phase4...     1 suite skipped / 4 testes skipped
npx tsc --noEmit                         PASS
backend npm run build                    PASS
frontend npx tsc --noEmit                PASS
frontend npm run build                   PASS
npx eslint test/aprs/...                 PASS
npx prettier --write test/aprs/...       PASS
git diff --check                          PASS
```

A mensagem do executor foi `infraestrutura indisponível (DB=✗ Redis=✗)`. O
resultado é BLOCKED, não PASS.

## Gates

| Gate                              | Estado                  | Motivo                                                     |
| --------------------------------- | ----------------------- | ---------------------------------------------------------- |
| Migration real                    | PENDING                 | CI preparada; não há banco local                           |
| Cross-tenant HTTP + SQL           | PENDING                 | harness pronto, não executado                              |
| Cross-site HTTP + SQL             | PENDING                 | harness pronto, não executado                              |
| RBAC/header spoof/mass assignment | PENDING                 | mass assignment incluso; HTTP não executado                |
| RLS com runtime role              | PENDING                 | job CI prepara roles, sem executor local                   |
| Signature content/tamper          | UNIT PASS / E2E PENDING | prova unitária verde; SQL real pendente                    |
| Audit atomicity fault injection   | UNIT PASS / E2E PENDING | fault unitário; DB fault pendente                          |
| PostgreSQL concurrency            | PENDING                 | sem banco real                                             |
| Redis isolation/failure           | PENDING                 | sem Redis                                                  |
| Offline browser                   | PENDING                 | não é gate backend executável nesta sessão                 |
| PDF/storage overwrite             | PENDING                 | storage de teste não levantado                             |
| OpenAPI                           | PENDING                 | export não executado nesta rodada                          |
| Backup/restore                    | PENDING                 | requer executor CI/DB descartável                          |
| Inversion tests                   | PENDING                 | reversões não foram aplicadas para não contaminar worktree |

## Inversão e controle de regressão

Não foram feitas reversões temporárias em arquivos compartilhados, pois o host
não possui executor E2E para observar a falha e o worktree já contém alterações
de fases anteriores. A suíte foi escrita para servir aos cenários APR-01 a
APR-07, F3-OFF-01, F35-CRYPTO-01 e F35-AUDIT-01 no CI; cada inversão deve ser
isolada, temporária e nunca commitada.

## Limites materiais

Ainda não há evidência desta sessão para: RLS com role sem `BYPASSRLS`, leakage
de contexto em pool, corrida sign/update/sign/sign/approve/finalize, falha de
Redis, storage overwrite, hash dos bytes do PDF, restore de backup ou migration
up/down sobre dados legacy. Esses itens permanecem PENDING/BLOCKED conforme a
regra do briefing.

## Próximo executor seguro

Em CI ou host descartável com Docker:

1. subir `backend/docker-compose.test.yml` ou usar services do workflow;
2. reconstruir schema com `npm run migration:run`, sem `synchronize()`;
3. executar `backend/test/aprs/apr-phase4-adversarial.e2e-spec.ts`;
4. executar as suítes críticas existentes e validar SQL/RLS com `sgs_app`;
5. adicionar os resultados JUnit/SQL como artefatos sem secrets;
6. somente então recalcular o veredito.
