# Infraestrutura atual do SGS

**Fonte de verdade operacional — classificação atual: `PRE_PRODUCTION_QA`**

Este documento separa o ambiente operacional atual, harnesses de teste e evidência
histórica. Não contém tokens, senhas, chaves privadas ou valores de variáveis sensíveis.

## Ambiente operacional atual (`PRE_PRODUCTION_QA`)

| Componente | Plataforma | Estado/contrato |
|---|---|---|
| Frontend | Vercel | Deploy manual; alias `app.sgsseguranca.com.br` |
| API web | Hostinger VPS + Coolify | App `backend-web`; domínio `api.sgsseguranca.com.br` |
| Worker | Hostinger VPS + Coolify | App separado `backend-worker`; sem domínio público |
| Redis | Container self-hosted `sgs-redis` na mesma VPS | Rede Docker interna `coolify`; não público |
| ClamAV | Container self-hosted na mesma VPS | Rede Docker interna `coolify` |
| PostgreSQL | Neon | Região São Paulo; acesso direto para operações DDL |
| Storage oficial | Backblaze B2 compatível com S3 | PDFs, anexos e vídeos governados |
| Observabilidade | Sentry, OpenTelemetry, Prometheus/Grafana | Conforme variáveis de cada serviço |

### Hostinger/Coolify

- VPS: `179.198.107.5`, hostname `srv1870554`.
- Painel Coolify: `http://179.198.107.5:8000`.
- Projeto: `My first project` (`k4tvj4jbsu1vc7jqggwzvv1f`).
- Environment: `production` (`r2j049cg1r2ocoi4lx57xzuj`).
- Server no Coolify: `localhost` (`sa80fcnx6zqhdeyypcyge6oc`).
- Web: `s2jgvkq9trtm8c9itahmn7og`.
- Worker: `x3k7efj1x3pcl4ipcuswwmll`.

Web e worker usam o mesmo repositório/branch de produção, mas são aplicações
Coolify independentes. Deploys devem ser feitos um por vez e só o próximo deve
ser disparado após o anterior terminar (`finished` ou `failed`). Migrations são
manuais e não rodam no boot.

## Runtime de testes atual

`CURRENT_TEST_RUNTIME=HOSTINGER_CURRENT_VPS` e `SEPARATE_TEST_VPS=NONE`.
Os harnesses de carga e os guards continuam versionados para preservar os testes
do software, mas não existe mais um alvo remoto separado autorizado para execução.
Não provisionar, acessar ou reutilizar uma VPS de load test separada a partir deste
documento.

## Referência histórica: load test separado (`LEGACY_TEST_REFERENCE_ONLY`)

Os dados abaixo são somente evidência histórica e não representam o runtime atual.
O estado remoto não foi comprovado como cancelado nem como vazio; por isso não há
autorização para decomissioná-lo nesta rodada.

| Item | Valor operacional |
|---|---|
| VPS | `83.229.115.37` (`sgs-loadtest`) |
| Usuário SSH | `sgsops` |
| Chave local | `C:\Users\User\.ssh\sgs-loadtest-vps_ed25519` |
| Projeto remoto | `/opt/sgs-loadtest` |
| Domínio | `https://api-loadtest.sgsseguranca.com.br` |
| Aplicação | `APP_ENV=loadtest` |
| Banco | `sgs_loadtest` |
| Tenant sintético | `00000000-0000-4000-8000-000000000001` |
| Proteção de borda | `X-Loadtest-Key`, somente via secret local da VPS/Grafana |

Containers esperados:

- `postgres-loadtest`
- `redis-loadtest`
- `api-loadtest`
- `proxy-loadtest`
- `edge-loadtest`

O guard `infra/load-test/scripts/guard-environment.mjs` deve continuar bloqueando
produção, Neon, Upstash, B2 e bancos fora de `sgs_loadtest`. Nunca remover esse
guard para acelerar uma campanha.

### Evidências históricas de carga já concluídas

Registradas em `docs/auditoria/2026-08-13-loadtest-vs-producao.md`:

- spike: 25 VUs por 60 segundos, aprovado;
- stress: 20 VUs por 3 minutos, aprovado;
- soak: 5 VUs por 10 minutos, aprovado.

A campanha autenticada Grafana de 10 VUs possui script preparado em
`tests/load/grafana/03-auth-load-10vus.js`, mas só deve ser considerada concluída
com Run ID e resumo oficial do Grafana Cloud.

## Local e CI

- Harness de load test preservado: `infra/load-test/` (sem alvo remoto atual).
- Compose local/E2E isolado: `ops/test/compose/docker-compose.e2e.yml` e
  `ops/test/compose/docker-compose.storage.override.yml`.
- CI: `.github/workflows/ci.yml` e `.github/workflows/security-scan.yml`.
- Smoke/load scripts: `ops/test/load/` e `backend/test/load/`.
- Frontend: `frontend/`, publicado manualmente na Vercel.

## Infraestrutura histórica — não usar

- Vultr API: `216.238.99.177`.
- Vultr worker: `216.238.127.254`.
- Integrator: `216.22.43.246`.
- Railway, Render, Cloudflare R2 e Upstash aparecem somente em documentação e
  histórico de migração; não são o runtime atual.

## Regras de operação

1. Confirmar o alvo antes de qualquer teste ou deploy.
2. Para carga, exigir `APP_ENV=loadtest`, banco `sgs_loadtest` e tenant sintético.
3. Não usar secrets de produção em scripts, logs, tags ou relatórios.
4. Não executar deploys concorrentes no Coolify.
5. Após qualquer alteração, validar SHA, health público, worker heartbeat e logs
   sem expor PII ou credenciais.

## Documentos relacionados

- [Hostinger + Coolify](./hostinger-coolify-infra-atual.md)
- [Operação de produção](./COMO-COLOCAR-EM-PRODUCAO.md)
- [Load test isolado](../../infra/load-test/README.md)
- [Auditoria loadtest versus produção](../auditoria/2026-08-13-loadtest-vs-producao.md)
