# SGS load-test isolado

Ambiente exclusivo para testes do SGS. O alvo desta rodada é a VPS `Teste SGS`
em Ubuntu 24.04, EUA-NY2, com 6 vCPU, 16 GB RAM e 60 GB SSD. O diagnóstico
executado no host confirmou esses recursos; não há swap configurado.

## Arquitetura

- `postgres-loadtest`: PostgreSQL 16, apenas na rede Docker interna.
- `redis-loadtest`: Redis 7, apenas na rede Docker interna.
- `migrations-loadtest`: job de execução única com a credencial de DDL.
- `seed-loadtest`: job de execução única com dados sintéticos e determinísticos.
- `api-loadtest`: backend NestJS com o papel `sgs_app`, sem credencial de DDL.
- `proxy-loadtest`: Nginx leve, somente na rede Docker; aplica limites de
  requisição/conexão e encaminha para a API.
- `edge-loadtest`: Caddy separado para o hostname exclusivo
  `api-loadtest.sgsseguranca.com.br`, TLS automático e chave
  `X-Loadtest-Key`. O segredo fica apenas no `.env.loadtest` da VPS.

Frontend, Grafana, Prometheus, Loki, Kubernetes, MinIO e worker não fazem parte
do primeiro boot. O worker só deve ser habilitado depois da medição de RAM com
API, banco e Redis estáveis. O storage documental inicial é local, em volume
exclusivo do ambiente.

## Guardas obrigatórios

Todos os jobs e a API executam `scripts/guard-environment.mjs`. Ele recusa:

- `NODE_ENV=production`;
- qualquer banco que não seja exatamente `sgs_loadtest`;
- API/app de produção, Neon, Upstash, Backblaze ou endpoints externos não
  permitidos;
- buckets que não comecem por `sgs-loadtest-`;
- ausência de `APP_ENV=loadtest` e `APP_LOADTEST_MARKER=sgs-loadtest`.

Os scripts k6 repetem a proteção antes de enviar a primeira requisição. Os
testes average, stress, spike e soak ficam preparados, mas não devem ser
executados nesta primeira implantação.

## Operação local/SSH

```powershell
Copy-Item .env.loadtest.example .env.loadtest
# Preencha os valores sintéticos no arquivo local; nunca o versione.

docker compose --env-file .env.loadtest -f compose.yml config
docker compose --env-file .env.loadtest -f compose.yml up -d
docker compose --env-file .env.loadtest -f compose.yml ps
docker stats --no-stream

# Acesso funcional somente por túnel SSH na primeira fase:
ssh -N -L 8088:127.0.0.1:8088 <usuario>@<ip-da-vps>

# Em outro terminal local:
$env:BASE_URL='http://127.0.0.1:8088'
$env:TEST_USER='<cpf-sintetico>'
$env:TEST_PASSWORD='<senha-sintetica>'
$env:TENANT_ID='00000000-0000-4000-8000-000000000001'
$env:MAX_VUS='5'
$env:TEST_DURATION='40s'
k6 run tests/load/smoke.js
```

Antes do primeiro `up`, registrar no host:

```bash
docker version
docker compose version
free -h
df -h
nproc
uname -m
swapon --show
ss -lntup
```

## Reset seguro

O reset remove somente os volumes nomeados do ambiente `sgs-loadtest` e exige
uma confirmação explícita:

```powershell
$env:APP_ENV='loadtest'
./scripts/reset-loadtest.ps1 -ConfirmLoadTestReset
```

Não usar `docker system prune`, `docker volume prune`, `cloudcli server
terminate` ou qualquer comando que possa atingir outros ambientes.

## Limites e próximos gates

O compose geral usa limites dimensionados para esta VPS de 16 GB (API 1,5 GB,
PostgreSQL 1 GB, Redis 256 MB, proxy 128 MB, com heap Node de 1 GB). O perfil
`compose.low-memory.yml` existe apenas como fallback para uma máquina menor e
não foi usado nesta implantação.

O primeiro smoke cobre somente health público, login sintético e `/auth/me`.
Não usar produção, credenciais reais, dados reais, storage real ou os domínios
`api.sgsseguranca.com.br`/`app.sgsseguranca.com.br`.

## Publicação controlada

O edge público usa somente 80/443 para o hostname exclusivo. HTTP é redirecionado
para HTTPS; `/health/public` é a única rota sem chave; todas as demais exigem
`X-Loadtest-Key`. O acesso por IP cai no virtual host de descarte e não alcança
a API. PostgreSQL, Redis e `127.0.0.1:8088` permanecem sem publicação pública.

Antes de subir o edge, gerar a chave diretamente na VPS e gravá-la somente no
arquivo secreto, sem imprimir o valor:

```bash
umask 077
openssl rand -hex 32
# salvar o resultado como LOADTEST_PROXY_KEY em infra/load-test/.env.loadtest
docker compose --env-file .env.loadtest -f compose.yml config --quiet
docker compose --env-file .env.loadtest -f compose.yml up -d edge-loadtest
```

Caddy gerencia a emissão e renovação do certificado ACME. Os logs Docker têm
rotação de 10 MB por 3 arquivos; o edge limita o corpo a 20 MB, mantém
timeouts defensivos e o proxy interno recupera a origem encaminhada pelo edge
para limitar a 400 req/s por cliente, burst 800 e 100 conexões simultâneas por
cliente.

## Prova automatizada de RLS da trilha forense

Depois do boot, execute o script dentro da rede Docker isolada:

```bash
docker compose --env-file .env.loadtest -f compose.yml run --rm \
  --entrypoint node api-loadtest \
  /opt/load-test/scripts/forensic-rls-proof.cjs
```

Ele valida o role `sgs_app`, `rolbypassrls = false`, persistência do
`LOGIN_SUCCESS`, insert/select do tenant correto, bloqueio de leitura por
outro tenant e rejeição de INSERT sem contexto.

O repositório possui 297 migrations antes desta correção; a migration
`1709000000376` passa a ser a 298ª e torna a policy de INSERT tenant-bound.
Em um banco novo, a execução deve terminar com todas as migrations registradas
na tabela `migrations`; o número “Applied N” representa apenas o lote pendente
daquela execução, não o total histórico.

## Evidência da primeira rodada

- `docker compose config --quiet`: passou na VPS.
- `/health/public`, `/health/ready` e `/health`: HTTP 200.
- Smoke k6: 5 VUs, 5 iterações, 21/21 checks, 0% falhas, p95 aproximado de
  302 ms.
- Proxy disponível somente em `127.0.0.1:8088`; PostgreSQL e Redis sem portas
  publicadas.
- O login sintético revelou um gap do baseline: a persistência de
  `forensic_trail_events` é rejeitada pela política RLS durante o login. A
  autenticação e `/auth/me` continuam funcionais, mas esse erro deve ser
  corrigido antes de tratar a aplicação como completamente limpa.
## Escala controlada pelo PowerShell

Para medir crescimento sem transformar cada VU em uma rajada ilimitada, use o
perfil `tests/load/scale-ramp.js`. Ele pausa entre iterações, registra a
quantidade agregada por código HTTP em `http_status_count` e aborta quando os
thresholds de erro ou checks são violados. O destino continua protegido pelo
guard do loadtest.

Exemplo inicial, sem executar automaticamente:

```powershell
$env:BASE_URL='https://api-loadtest.sgsseguranca.com.br'
$env:TARGET_VUS='100'
$env:RAMP_UP='60s'
$env:HOLD_DURATION='60s'
$env:RAMP_DOWN='30s'
$env:ITERATION_SLEEP='1'
k6 run tests/load/scale-ramp.js
```

Acima de 100 VUs, o comando exige confirmação explícita do ambiente isolado:

```powershell
$env:LOADTEST_CONFIRM='SGS_LOADTEST_ONLY'
$env:TARGET_VUS='250'
k6 run tests/load/scale-ramp.js
```

Esse parâmetro não remove limites do proxy nem autoriza produção. Para milhares
de VUs, distribua a execução entre geradores k6 e avance somente após o degrau
anterior permanecer verde. Nunca aponte `BASE_URL` para produção.

O perfil também publica as métricas agregadas `http_status_count`,
`http_status_429`, `http_status_5xx` e `transport_failure`. Qualquer 429, 5xx
ou falha de transporte reprova e interrompe o degrau após a janela de
avaliação. Isso permite distinguir rejeição do proxy de falha de conexão sem
registrar corpos, tokens ou credenciais.

## Degraus planejados

Não executar os degraus em paralelo. Depois de cada execução, validar saúde e
recursos da VPS. A sequência sugerida é 500, 1000 e 2000 VUs. Para 1000 e
2000, usar geradores k6 distribuídos ou rede privada; uma única origem pública
concentrará as conexões no limite por IP do proxy e não representará usuários
independentes.

Exemplo para o próximo degrau local controlado:

```powershell
$env:LOADTEST_CONFIRM='SGS_LOADTEST_ONLY'
$env:TARGET_VUS='500'
$env:RAMP_UP='180s'
$env:HOLD_DURATION='180s'
$env:RAMP_DOWN='90s'
$env:ITERATION_SLEEP='1'
k6 run .\tests\load\scale-ramp.js
```

Se qualquer threshold falhar, guardar o resumo, consultar os recursos e não
subir automaticamente para o próximo degrau. Aumentar o limite do Nginx não é
uma correção universal: apenas desloca o gargalo para a API, PostgreSQL ou
Redis e deve ser uma decisão separada do teste de capacidade.
