# Ambiente de testes isolado

Este diretório concentra harnesses de testes locais/temporários e portáveis. O
runtime atual de QA é a VPS Hostinger (`PRE_PRODUCTION_QA`); este código não
define uma VPS remota separada e não deve receber credenciais, dados pessoais ou
artefatos gerados de uma execução.

## Estrutura

- `compose/`: PostgreSQL, Redis, ClamAV e overrides de storage para E2E.
- `load/`: wrappers e cenários k6 operacionais; a implementação específica do
  backend permanece em `backend/test/load/`.
- `storage/`: bootstrap, limpeza e smoke tests do storage S3-compatible de
  teste. O padrão local é MinIO privado; um provider externo só deve ser usado
  com bucket/prefixo de staging isolado e credenciais temporárias.
- `infra/load-test/`: harness histórico/portátil; não o trate como alvo remoto
  atual nem misture seus manifestos com os Compose portáveis deste diretório.

## Comandos principais

Executados a partir de `backend/`:

```powershell
npm run test:e2e:up
npm run test:e2e:ci
npm run test:e2e:down
```

Para carga, use `ops/test/load/` e mantenha a massa sintética fora do Git.
Para storage, configure apenas um arquivo local baseado nos exemplos e rode os
scripts em `ops/test/storage/`.

Quando o harness for executado em ambiente de QA autorizado, antes de subir a API
com o override de storage, o operador deve
executar `ops/test/storage/provision-loadtest-admin.sh`. O script gira uma
senha sintética para `sgs_admin`, garante somente o membership
`sgs_admin -> sgs_rls_bypass` e grava `DATABASE_ADMIN_URL` em `.env.admin`
com modo `0600`. Esse arquivo é carregado apenas pela API de teste e nunca deve
ser commitado ou copiado para produção.

## Isolamento obrigatório

- banco, Redis e volumes devem ter nomes/portas do ambiente de teste;
- storage deve usar bucket/prefixo exclusivo de teste;
- testes devem usar tenants, usuários e PDFs sintéticos;
- tokens e secrets devem entrar somente por variáveis locais/secret store e
  nunca aparecer em logs ou relatórios;
- toda execução deve registrar um `run-id` e gravar evidências em
  `artifacts/test-runs/<run-id>/`, diretório ignorado pelo Git.

## Limpeza

O teardown E2E remove os volumes do Compose. Scripts de storage devem limpar os
prefixos `quarantine/` e `documents/` do ambiente de teste ao final. Não use
comandos de limpeza contra produção ou contra buckets sem validação explícita.
