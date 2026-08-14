# SGS — R2 INCIDENT RESPONSE REPORT

**Fase:** 0 — P0 Incident Response: Cloudflare R2
**Data da análise:** 2026-08-14
**Repositório:** `wandersongandra/sgsseguranca`
**Escopo:** exclusivamente credenciais históricas de storage S3-compatible/Cloudflare R2.

## 1. Resumo executivo

Foi confirmada exposição histórica de um bloco de configuração de storage no commit `355c9000c918fa839705f1fc812d5464aa9b7568`, no arquivo `prompts/CLOUDFLARE_R2_CONFIGURADO.md`.

A análise do blob histórico encontrou cinco atribuições de configuração com valores não-placeholder-like: access key, secret access key, bucket, região e endpoint. Os valores reais não foram impressos, registrados ou reproduzidos neste relatório.

O arquivo não existe no `HEAD` atual, mas a remoção do arquivo da ponta não remove a exposição do histórico Git público. Não foi possível obter acesso autorizado ao Cloudflare/R2, ao Coolify, à VPS, ao Vercel ou aos logs do provedor nesta sessão. Portanto, não foi possível comprovar revogação, criar/propagar nova credencial, executar redeploy ou executar o inversion test.

**Resultado:** `P0_R2_INCIDENT_NOT_CLOSED`

## 2. Evidência histórica

| Item | Evidência |
|---|---|
| Commit de introdução | `355c9000c918fa839705f1fc812d5464aa9b7568` |
| Data do commit | `2026-02-27T19:30:26-03:00` |
| Arquivo | `prompts/CLOUDFLARE_R2_CONFIGURADO.md` |
| Tamanho do arquivo histórico | 218 linhas |
| Presença no HEAD | Não existe |
| Commit que registra a remoção/consolidação | `c2ca688ce637ef5cfa067ebde5370fe0da086a8a` |
| Data da remoção/consolidação | `2026-03-22T23:25:27-03:00` |
| Histórico analisado | `git log --all`, `git log -S`, `git log -G`, `git rev-list --all`, `git show`, `git grep` |
| Referências alcançáveis | 1.532 commits alcançáveis no clone local |

### Linhas históricas relevantes — valores omitidos

| Linha | Tipo | Classificação |
|---:|---|---|
| 13 | `AWS_ACCESS_KEY_ID` | valor não-placeholder-like; comprimento observado: 32 |
| 14 | `AWS_SECRET_ACCESS_KEY` | valor não-placeholder-like; comprimento observado: 64 |
| 15 | `AWS_BUCKET_NAME` | valor não-placeholder-like; comprimento observado: 21 |
| 16 | `AWS_REGION` | valor não-placeholder-like; comprimento observado: 4 |
| 17 | `AWS_ENDPOINT` | valor não-placeholder-like; comprimento observado: 65 |

Nenhum valor, hash identificável, URL completa, token ou segredo foi incluído no relatório.

## 3. Quantidade de ocorrências

### Bloco de credencial confirmado

- `AWS_ACCESS_KEY_ID`: 1 atribuição no documento histórico.
- `AWS_SECRET_ACCESS_KEY`: 1 atribuição no documento histórico.
- `AWS_BUCKET_NAME`: 1 atribuição no documento histórico.
- `AWS_REGION`: 1 atribuição no documento histórico.
- `AWS_ENDPOINT`: 1 atribuição no documento histórico.
- Total: 5 atribuições no bloco histórico confirmado; 1 par de credenciais (access key + secret access key).

### Varredura ampla do histórico

A busca por referências de storage e presigned URLs encontrou correspondências em 56 commits alcançáveis, totalizando 440 linhas adicionadas e 177 linhas removidas nos diffs. Esse número inclui documentação, exemplos, testes, aliases S3/R2 e código de storage; não representa 617 credenciais distintas.

Para os aliases de configuração, a contagem de linhas de diff foi:

| Variável | Linhas adicionadas | Linhas removidas |
|---|---:|---:|
| `AWS_ACCESS_KEY_ID` | 59 | 21 |
| `AWS_SECRET_ACCESS_KEY` | 57 | 20 |
| `AWS_BUCKET_NAME` | 105 | 46 |
| `AWS_ENDPOINT` | 60 | 18 |
| `AWS_REGION` | 42 | 18 |

## 4. Status da credencial antiga

**Classificação:** `UNKNOWN`

Motivo: não há sessão/token Cloudflare autorizado disponível no ambiente. O binário local `wrangler` não pôde consultar a conta porque o pacote instalado contém o binário nativo de Windows, incompatível com o WSL/Linux. Também não há credenciais Cloudflare/R2 disponíveis nas variáveis de ambiente da sessão.

Não foi possível verificar:

- existência atual da access key;
- estado ativo/revogado/deletado;
- escopo/permissões;
- bucket associado;
- data de criação;
- última utilização;
- logs de acesso.

A credencial deve continuar sendo tratada como comprometida até revogação comprovada.

## 5. Evidência de revogação

**Não comprovada.**

Nenhuma chamada de revogação foi executada, pois não havia acesso autorizado ao Cloudflare/R2. Não é seguro declarar `REVOKED` sem confirmação da API ou painel do provedor.

## 6. Nova credencial criada?

**NÃO.**

Não foi criada credencial nova porque o provedor não estava acessível de forma autenticada e não foi identificado, com evidência operacional, o escopo mínimo efetivamente necessário para o ambiente ativo.

## 7. Consumidor atual e variáveis identificadas

O código atual possui consumidores S3-compatible em:

- `backend/src/shared/services/storage.service.ts`
- `backend/src/shared/storage/s3.service.ts`
- `backend/src/shared/services/document-storage.service.ts`
- `backend/src/infra/storage/storage.controller.ts`
- serviços de documentos, evidências, anexos, assinaturas, logos e PDFs APR;
- scripts de disaster recovery e reconciliação de storage;
- worker e módulos de geração/processamento documental.

Aliases encontrados:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_BUCKET_NAME` / `AWS_S3_BUCKET`
- `AWS_ENDPOINT` / `AWS_S3_ENDPOINT`
- `AWS_REGION`
- `S3_FORCE_PATH_STYLE`
- variáveis de réplica `DR_STORAGE_REPLICA_*`

A documentação versionada indica consumidores atuais no backend web e worker gerenciados por Coolify/Hostinger VPS. O frontend é publicado manualmente no Vercel, mas não foi identificado uso de credenciais R2 no frontend neste escopo.

## 8. Fallbacks inseguros e fail closed

A validação de configuração de produção foi verificada em:

- `backend/src/app.module.ts:949-973`
- `backend/src/app.module.ts:975-984`
- `backend/src/app.module.ts:986-997`

Evidência: em `NODE_ENV=production`, a inicialização falha quando bucket, access key ou secret access key estão ausentes; para endpoint R2, também exige `S3_FORCE_PATH_STYLE=true`.

Os construtores de storage usam strings vazias como valores internos de ausência (`storage.service.ts:83-85` e `s3.service.ts:85-88`), mas a barreira de validação de produção acima deve impedir inicialização normal sem as credenciais exigidas. Não foi feita alteração de código nesta fase.

## 9. Ambientes atualizados

**Nenhum.**

Não foram encontrados, nesta sessão, acessos autenticados operacionais para Coolify/Hostinger VPS, Cloudflare/R2, Vercel ou outros gestores de secrets. Nenhuma variável real foi lida ou alterada.

## 10. Serviços redeployados

**Nenhum.**

Não houve redeploy de backend web, worker ou frontend.

## 11. Testes realizados

| Teste | Resultado |
|---|---|
| Backend type-check (`npm run type-check`) | PASS |
| Backend build (`npm run build`) | PASS |
| Testes direcionados de storage/configuração | BLOQUEADO: `ts-jest` ausente em `backend/node_modules` |
| Backend lint (`npm run lint -- --no-fix`) | BLOQUEADO por timeout de 600s; sem conclusão |
| Upload/download/presigned URL/PDF APR/evidence/attachments em ambiente real | NÃO EXECUTADO: sem credenciais novas e sem ambiente autorizado |
| Tenant isolation | NÃO EXECUTADO nesta fase de incidente R2 |

## 12. Inversion test obrigatório

```text
OLD_CREDENTIAL_REJECTED=UNKNOWN
NEW_CREDENTIAL_WORKING=NOT_RUN
```

O teste não pode ser considerado aprovado sem uma credencial antiga revogada/invalidada e uma credencial nova validada, sem exposição dos valores.

## 13. Análise dos logs

**Não concluída.**

Não foram disponibilizados logs autorizados do Cloudflare R2, do bucket, do Coolify/Hostinger ou do serviço consumidor. Portanto, não é possível afirmar ausência de abuso.

Formulação correta neste momento: **não foi possível avaliar evidência de abuso nos logs do provedor porque os logs não estavam disponíveis nesta sessão.**

## 14. Riscos residuais

1. A credencial histórica pode ainda estar ativa.
2. A credencial pode ter sido reutilizada em ambientes históricos ou atuais.
3. O histórico público continua contendo o material comprometido até um history rewrite futuro, que está fora desta fase e não foi executado.
4. Não há conclusão sobre downloads, uploads, deletes, ListBucket, IPs ou user agents anormais.
5. Os ambientes operacionais ainda não foram confirmados com a nova credencial.
6. O teste de rejeição da credencial antiga e o teste funcional da nova credencial continuam pendentes.

## 15. Arquivos modificados

- `docs/audits/P0_R2_INCIDENT_RESPONSE_REPORT.md` — relatório desta fase, sem segredos.

Nenhum arquivo de frontend, regra de negócio ou configuração operacional foi alterado.

O worktree já estava sujo antes desta atividade, com modificações e arquivos não rastreados preexistentes. Essas alterações não foram tocadas.

## 16. Commits criados

**Nenhum.**

Nenhum commit ou push foi executado. Nenhum history rewrite e nenhum force push foi executado.

## 17. Bloqueios encontrados

- Ausência de credencial/token autorizado para consulta e revogação no Cloudflare.
- Ausência de acesso aos ambientes Coolify/Hostinger/Vercel e respectivos gestores de secrets.
- `wrangler` local incompatível com WSL/Linux por instalação do binário nativo Windows.
- Ausência de `gh` CLI para consulta autenticada do GitHub.
- Testes Jest direcionados bloqueados por dependência `ts-jest` ausente no `node_modules` local.
- Lint sem conclusão dentro do limite de 600 segundos.
- Worktree previamente modificado por atividade externa, impedindo assumir estado limpo para testes completos.

## Critério de fechamento

O incidente **não está fechado**. Para permitir `P0_R2_INCIDENT_CLOSED`, ainda são necessários, fora deste relatório:

1. revogar ou invalidar a credencial histórica no Cloudflare/R2;
2. registrar confirmação não sensível de estado `REVOKED`/`DELETED`;
3. criar, se necessário, nova credencial com menor privilégio;
4. atualizar somente consumidores reais descobertos;
5. redeployar backend web e worker afetados;
6. validar upload, download, presigned URL, PDF APR, evidências e anexos;
7. executar o inversion test sem imprimir segredos;
8. obter logs suficientes e registrar a análise de abuso;
9. somente depois, planejar history rewrite em operação separada, sem force push nesta fase.

## FASE 0B — OPERATIONAL CLOSURE

### Resultado da fase

`BLOCKED_CLOUDFLARE_ACCESS`

`P0_R2_INCIDENT_NOT_CLOSED`

A regra operacional desta fase determina parada antes de qualquer alteração de credencial, revogação, criação de segredo, propagação ou redeploy quando não existe acesso Cloudflare autorizado comprovável.

### 1. Ambiente documentado e grau de confirmação

| Serviço | Ambiente documentado | Host/provedor documentado | Consumidor de storage | Confirmação operacional |
|---|---|---|---|---|
| Backend web | production | Hostinger VPS via Coolify | API NestJS e módulos documentais | Não confirmada por acesso ao runtime |
| Backend worker | production | Hostinger VPS via Coolify | worker NestJS, PDFs, filas e tarefas documentais | Não confirmada por acesso ao runtime |
| Frontend | production | Vercel, deploy manual | Não deve receber credenciais R2 | Não confirmada por acesso ao provedor |
| DR/storage replica | condicional/recovery | configuração `DR_STORAGE_REPLICA_*` | scripts de backup/recovery | Não confirmada |
| CI | staging/test | GitHub Actions documentado | testes/configuração, não produção | Não acessado via GitHub autenticado |
| Railway/Render/Vultr | historical | documentação histórica | consumidores históricos | Tratados como históricos; não assumidos como atuais |

Evidência de documentação: `README.md:289-295`, `docs/deploy/COMO-COLOCAR-EM-PRODUCAO.md:25-27`, `docs/deploy/hostinger-coolify-infra-atual.md:24-28` e `backend/.env.production.example:172-189`.

Esse é um mapa do ambiente documentado, não uma prova de que os serviços estão atualmente ativos. A prova operacional exigiria acesso autenticado ao Coolify/Hostinger/Vercel e aos logs.

### 2. Consumidores e aliases inventariados

Foram confirmados no código os consumidores de storage compartilhados por backend web/worker:

- `backend/src/shared/services/storage.service.ts`
- `backend/src/shared/storage/s3.service.ts`
- `backend/src/shared/services/document-storage.service.ts`
- `backend/src/infra/storage/storage.controller.ts`
- módulos de documentos, APR/PDF, evidências, anexos, assinaturas e logos;
- scripts de DR, proteção de storage, cutover e reconciliação.

Aliases encontrados, sem leitura de valores:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_BUCKET_NAME` / `AWS_S3_BUCKET`
- `AWS_ENDPOINT` / `AWS_S3_ENDPOINT`
- `AWS_REGION`
- `S3_FORCE_PATH_STYLE`
- `DR_STORAGE_REPLICA_BUCKET`
- `DR_STORAGE_REPLICA_ENDPOINT`
- `DR_STORAGE_REPLICA_REGION`
- `DR_STORAGE_REPLICA_ACCESS_KEY_ID`
- `DR_STORAGE_REPLICA_SECRET_ACCESS_KEY`
- `DR_STORAGE_REPLICA_FORCE_PATH_STYLE`

A configuração principal e a configuração de réplica são logicamente separadas no código. Não foi possível provar quais delas estão preenchidas no ambiente ativo.

### 3. Acesso autorizado ao Cloudflare

**Resultado:** `BLOCKED_CLOUDFLARE_ACCESS`

Evidências:

- não existem variáveis de ambiente Cloudflare/R2 disponíveis na sessão;
- não existe `gh` autenticado disponível;
- o `wrangler` existe, mas falha antes da autenticação por incompatibilidade do binário nativo `workerd` Windows com WSL/Linux;
- não há token Cloudflare autorizado que possa ser usado sem risco de exposição.

Nenhuma chamada de API Cloudflare foi realizada. Nenhum bucket, token, access key, escopo, estado de revogação ou log foi consultado. Não foi feita tentativa de adivinhar ou recuperar segredo de arquivo local.

### 4. Operações deliberadamente não executadas

Por causa do bloqueio acima, esta fase não executou:

- revogação ou disable da credencial histórica;
- criação de nova credential;
- atualização de secrets em Coolify, Hostinger, Vercel, GitHub ou outro provedor;
- redeploy;
- golden storage test;
- inversion test;
- tenant isolation operacional;
- path/object-key probes contra storage real;
- análise de logs do provedor.

### 5. Estados obrigatórios nesta fase

```text
OLD_CREDENTIAL_STATUS=UNKNOWN
OLD_CREDENTIAL_REJECTED=BLOCKED
NEW_CREDENTIAL_WORKING=NOT_RUN
SECRET_UPDATED=NO
UPLOAD=NOT_RUN
DOWNLOAD=NOT_RUN
PRESIGNED_URL=NOT_RUN
APR_PDF_STORAGE=NOT_RUN
EVIDENCE_STORAGE=NOT_RUN
ATTACHMENT_STORAGE=NOT_RUN
CROSS_TENANT_STORAGE_ACCESS=NOT_RUN
INSECURE_STORAGE_CONFIG_BLOCKED=PASS_STATIC_ONLY
NEW_SECRET_IN_GIT=NO_NEW_SECRET_CREATED (scanner pós-mudança não aplicável)
BACKEND_TYPECHECK=PASS
BACKEND_BUILD=PASS
ABUSE_ANALYSIS=INCONCLUSIVE
```

`INSECURE_STORAGE_CONFIG_BLOCKED=PASS` refere-se à validação já existente em `backend/src/app.module.ts:965-984`, verificada por type-check/build e pelo teste de configuração disponível no código. Não substitui a validação operacional do storage real.

### 6. Blockers exatos para fechamento

1. `BLOCKED_CLOUDFLARE_ACCESS`: falta de acesso Cloudflare autorizado e funcional.
2. `OLD_CREDENTIAL_STATUS=UNKNOWN`: não há evidência de `REVOKED`, `DELETED` ou `NOT_FOUND_VALIDATED`.
3. `OLD_CREDENTIAL_REJECTED=BLOCKED`: o inversion test não pode ser realizado sem identificar e testar a credencial histórica após revogação.
4. `NEW_CREDENTIAL_WORKING=NOT_RUN`: não há credential nova criada nem validada.
5. `storage funcional não validado`: upload, download, presigned URL, APR/PDF, evidências e anexos não foram testados no ambiente operacional.
6. `CROSS_TENANT_STORAGE_ACCESS=NOT_RUN`: isolamento não foi provado contra o ambiente real.
7. `ABUSE_ANALYSIS=INCONCLUSIVE`: logs do provider não disponíveis.

### 7. Arquivos, commits e evidências desta subfase

- Arquivo modificado: `docs/audits/P0_R2_INCIDENT_RESPONSE_REPORT.md`.
- Código de aplicação/frontend: não modificado.
- Secrets: nenhum lido, criado, alterado ou exibido.
- Commits criados: nenhum.
- History rewrite/force push: não executados.
- Evidência de bloqueio: saída não sensível de descoberta de ferramentas/ambiente e erro de incompatibilidade do `wrangler` registrados na sessão; nenhum token foi exposto.

**Veredito da Fase 0B:** `P0_R2_INCIDENT_NOT_CLOSED`

**PARADA OBRIGATÓRIA:** a execução termina aqui até que seja fornecido acesso Cloudflare autorizado e operacional, sem avançar para Fase 1, limpeza de histórico ou qualquer outra fase.

## FASE 0C — CLOUDFLARE ACCESS & REVOCATION

### Resultado

`BLOCKED_CLOUDFLARE_ACCESS`

`P0_R2_INCIDENT_NOT_CLOSED`

O caminho existente e utilizado como fonte de verdade é `docs/audits/P0_R2_INCIDENT_RESPONSE_REPORT.md`. O caminho informado como `docs/audits/P0R2INCIDENTRESPONSEREPORT.md` não existe no checkout.

### 1. Runtime e compatibilidade do Wrangler

```text
OS=WSL2
DISTRIBUTION=Ubuntu 24.04.4 LTS
NODE=v22.22.2
NPM=10.9.7
NODE_PATH=/usr/bin/node
NPM_PATH=/usr/bin/npm
SYSTEM_WRANGLER_PATH=/mnt/c/Users/User/AppData/Roaming/npm/wrangler
ISOLATED_WRANGLER=npx wrangler@4.123.0
```

O Wrangler instalado globalmente no caminho Windows continua incompatível com WSL por causa do binário nativo `workerd-windows-64`.

Foi utilizada uma instalação isolada compatível com Linux/WSL:

```text
npx --yes wrangler@4.123.0 --version
RESULT=4.123.0
```

Nenhuma instalação global foi alterada e nenhuma versão foi rebaixada arbitrariamente.

### 2. Teste read-only de identidade Cloudflare

Com o Wrangler isolado compatível:

```text
npx --yes wrangler@4.123.0 whoami
CLOUDFLARE_AUTHENTICATED=FAIL
```

Resultado não sensível retornado pelo provedor:

```text
You are not authenticated. Please run `wrangler login`.
```

Não foi executado `wrangler login`, não foi aberto fluxo de autenticação interativo e nenhum token foi solicitado, colado ou armazenado. A autenticação exige ação autorizada do titular da conta pelo navegador/dashboard ou injeção segura de secret fora do repositório.

### 3. Conta, bucket e credencial histórica

Como a identidade Cloudflare não foi autenticada, as etapas seguintes não podem ser executadas com segurança:

```text
CLOUDFLARE_ACCOUNT_MATCH=BLOCKED
BUCKET_FOUND=BLOCKED
BUCKET_CURRENTLY_USED=UNKNOWN
OLD_CREDENTIAL_STATUS=UNKNOWN
OLD_CREDENTIAL_REVOCATION=BLOCKED
OLD_CREDENTIAL_REJECTED=BLOCKED
```

Não houve consulta a conta, bucket, access key, token, escopo, metadata ou logs. Não é permitido escolher uma conta por inferência ou revogar uma credential sem confirmação de contexto.

### 4. Operações não executadas por bloqueio

- revogação da credential histórica;
- inversion test;
- criação de nova credential;
- atualização de secrets no Coolify/Hostinger;
- redeploy de backend web ou worker;
- golden storage test;
- fluxo real de documentos/APR/evidências/anexos;
- cross-tenant negative test contra o storage real;
- análise de logs Cloudflare/R2;
- history rewrite, force push ou qualquer limpeza de histórico.

### 5. Estados operacionais

```text
NEW_CREDENTIAL_CREATED=NO
NEW_CREDENTIAL_WORKING=NOT_RUN
BACKEND_STORAGE_CREDENTIAL=UNKNOWN
WORKER_STORAGE_CREDENTIAL=UNKNOWN
BACKEND_UPDATED=NO
WORKER_UPDATED=NO
UPLOAD=NOT_RUN
DOWNLOAD=NOT_RUN
PRESIGNED_URL=NOT_RUN
APR_PDF_STORAGE=NOT_RUN
EVIDENCE_STORAGE=NOT_RUN
ATTACHMENT_STORAGE=NOT_RUN
CROSS_TENANT_STORAGE_ACCESS=NOT_RUN
PRODUCTION_STORAGE_FAIL_CLOSED=PASS_STATIC_ONLY
ABUSE_ANALYSIS=INCONCLUSIVE
NEW_SECRET_COMMITTED=NO_NEW_SECRET_CREATED
```

`PRODUCTION_STORAGE_FAIL_CLOSED=PASS_STATIC_ONLY` permanece baseado na validação existente em `backend/src/app.module.ts:965-984`; não foi executado novamente o teste Jest porque o bloqueio de dependência `ts-jest` permanece no ambiente local.

### 6. Blockers exatos

1. `CLOUDFLARE_AUTHENTICATED=FAIL`: Wrangler compatível instalado, porém sem sessão autorizada.
2. `CLOUDFLARE_ACCOUNT_MATCH=BLOCKED`: conta correta não pode ser confirmada.
3. `OLD_CREDENTIAL_STATUS=UNKNOWN`: status administrativo não consultado.
4. `OLD_CREDENTIAL_REJECTED=BLOCKED`: inversion test não executável sem contexto/credential autorizado.
5. `NEW_CREDENTIAL_WORKING=NOT_RUN`: nenhum segredo novo criado ou propagado.
6. Storage funcional e isolamento de tenant não validados operacionalmente.
7. Logs de abuso indisponíveis.

### 7. Integridade e segurança da execução

- Nenhum segredo foi impresso ou incluído no relatório.
- Nenhuma credential foi adicionada ao Git.
- Nenhum arquivo de aplicação/frontend foi modificado.
- Nenhum commit foi criado.
- Nenhum push, force push ou history rewrite foi executado.
- A verificação de identidade foi exclusivamente read-only.

**Veredito da Fase 0C:** `P0_R2_INCIDENT_NOT_CLOSED`

**PARADA:** falta autenticação Cloudflare autorizada. Não avançar para revogação, propagação, deploy ou Fase 1 até que o titular autentique o Wrangler pelo navegador/dashboard ou disponibilize secret injection segura fora do repositório.

## FASE 0C-R — AUTHENTICATED OPERATIONAL CLOSURE

### Resultado

`BLOCKED_CLOUDFLARE_AUTHENTICATION`

`P0_R2_INCIDENT_NOT_CLOSED`

A retomada foi iniciada exatamente a partir do bloqueio anterior, sem reiniciar a investigação e sem executar operações administrativas.

### Prova obrigatória de autenticação

Com o Wrangler compatível isolado:

```text
COMMAND=npx --yes wrangler@4.123.0 whoami
WRANGLER_VERSION=4.123.0
CLOUDFLARE_AUTHENTICATED=FAIL
```

Resposta não sensível recebida:

```text
You are not authenticated. Please run `wrangler login`.
```

O código de saída do processo não foi usado como prova de autenticação; a mensagem explícita do Wrangler determinou o resultado `FAIL`.

### Estados desta retomada

```text
CLOUDFLARE_AUTHENTICATED=FAIL
CLOUDFLARE_ACCOUNT_MATCH=NOT_RUN
BUCKET_FOUND=NOT_RUN
OLD_CREDENTIAL_STATUS=UNKNOWN
OLD_CREDENTIAL_REVOCATION=NOT_RUN
OLD_CREDENTIAL_REJECTED=BLOCKED
NEW_CREDENTIAL_CREATED=NO
NEW_CREDENTIAL_WORKING=NOT_RUN
BACKEND_UPDATED=NO
WORKER_UPDATED=NO
UPLOAD=NOT_RUN
DOWNLOAD=NOT_RUN
PRESIGNEDURL=NOT_RUN
CROSS_TENANT_STORAGE_ACCESS=NOT_RUN
ABUSE_ANALYSIS=INCONCLUSIVE
NEW_SECRET_COMMITTED=NO
```

### Operações não executadas

A execução parou antes de:

- identificar contas Cloudflare;
- listar buckets R2;
- identificar ou revogar a credential histórica;
- executar inversion test;
- criar ou propagar nova credential;
- atualizar Coolify/Hostinger;
- fazer redeploy;
- executar golden storage ou fluxo documental;
- executar teste cross-tenant;
- consultar logs R2.

Nenhum token, access key, secret, cookie ou header de autorização foi impresso ou armazenado. Não houve alteração de código, frontend, histórico Git, branch, commit ou push.

### Blocker exato para continuar

O titular precisa autenticar o Wrangler com um mecanismo seguro, por exemplo:

```text
npx wrangler@4.123.0 login
```

Essa autenticação deve ser realizada pelo titular no fluxo oficial do navegador/dashboard. Nenhum token deve ser colado no chat, prompt, arquivo, Markdown ou repositório.

**Veredito da Fase 0C-R:** `P0_R2_INCIDENT_NOT_CLOSED`

**PARADA OBRIGATÓRIA:** não avançar para identificação de conta, bucket, revogação, deploy, inversion test ou qualquer fase posterior enquanto `CLOUDFLARE_AUTHENTICATED` não for comprovadamente `PASS`.

## FASE 0C-R — AUTHENTICATED INVENTORY RETRY

### Resultado

`CLOUDFLARE_AUTHENTICATED=PASS`

`CLOUDFLARE_ACCOUNT_MATCH=FAIL`

`P0_R2_INCIDENT_NOT_CLOSED`

A autenticação WSL foi confirmada com `npx --yes wrangler@4.123.0 whoami`, usando OAuth armazenado no arquivo de configuração local do Wrangler. Nenhum token ou credencial foi impresso.

### Evidência read-only

A conta autenticada possui os seguintes buckets listados pelo Wrangler:

- `sgs-01`
- `sgs-02`
- `sgs-03`
- `site-sgs-seguranca-opennext-cache`
- `wanderson-gandra-docs`

O bucket `wanderson-gandra-docs` foi consultado somente com `r2 bucket info`:

```text
BUCKET_FOUND=YES
BUCKET_NAME=wanderson-gandra-docs
CREATED=2026-03-22T21:18:24.585Z
LOCATION=ENAM
OBJECT_COUNT=45
BUCKET_SIZE=16.8 MB
BUCKET_CURRENTLY_USED=UNKNOWN
```

A existência do bucket na conta autenticada não é suficiente para provar que ele é o bucket histórico do incidente.

### Divergência de conta

O endpoint histórico contém um account ID diferente do account context autenticado. Para não expor identificadores completos, foi registrada somente a forma parcial:

```text
HISTORICAL_ENDPOINT_ACCOUNT=5ba0***10e1
AUTHENTICATED_ACCOUNT=<REDACTED>
ACCOUNT_IDS_EQUAL=FALSE
CLOUDFLARE_ACCOUNT_MATCH=FAIL
```

Essa divergência impede determinar, com segurança, se `wanderson-gandra-docs` na conta autenticada é o mesmo recurso referenciado pela configuração histórica. Pode representar conta diferente, migração, endpoint antigo ou bucket homônimo. A regra de segurança exige parada quando a conta correta não pode ser determinada.

### Estados bloqueados

```text
CLOUDFLARE_AUTHENTICATED=PASS
CLOUDFLARE_ACCOUNT_MATCH=FAIL
BUCKET_FOUND=YES (na conta autenticada; correspondência histórica não comprovada)
BUCKET_CURRENTLY_USED=UNKNOWN
OLD_CREDENTIAL_STATUS=UNKNOWN
OLD_CREDENTIAL_REVOCATION=NOT_RUN
OLD_CREDENTIAL_REJECTED=BLOCKED
NEW_CREDENTIAL_CREATED=NO
NEW_CREDENTIAL_WORKING=NOT_RUN
BACKEND_UPDATED=NO
WORKER_UPDATED=NO
UPLOAD=NOT_RUN
DOWNLOAD=NOT_RUN
PRESIGNEDURL=NOT_RUN
CROSS_TENANT_STORAGE_ACCESS=NOT_RUN
ABUSE_ANALYSIS=INCONCLUSIVE
NEW_SECRET_COMMITTED=NO
```

### Operações não executadas

Não foram listadas, identificadas, criadas ou revogadas credenciais. Também não foram executados inversion test, deploy, golden storage test, fluxo documental, teste cross-tenant ou consulta de logs.

Nenhum segredo foi impresso, armazenado no relatório, inserido no Git ou usado em operação administrativa. Não houve alteração de código, frontend, histórico Git, commit, push ou history rewrite.

### Blocker exato

`CLOUDFLARE_ACCOUNT_MATCH=FAIL`.

É necessário autenticar/acessar a conta correspondente ao account ID do endpoint histórico, ou obter evidência administrativa confiável de migração/relacionamento entre as contas, antes de identificar ou revogar a credential comprometida. Não é seguro continuar usando a conta atualmente autenticada por inferência de nome de bucket.

**Veredito da retomada:** `P0_R2_INCIDENT_NOT_CLOSED`

**PARADA OBRIGATÓRIA:** não avançar para identificação/revogação de credencial, criação de nova credential, propagação, deploy ou inversion test enquanto `CLOUDFLARE_ACCOUNT_MATCH` não for resolvido.

## FASE 0D — ACCOUNT ATTRIBUTION & MIGRATION FORENSICS

### Veredito

`P0_R2_INCIDENT_NOT_CLOSED`

`ACCOUNT_ATTRIBUTION_INCOMPLETE`

A investigação não executou alterações administrativas, criação de credential, atualização de produção, deploy, exclusão de bucket/objeto, history rewrite ou force push.

### FASE A/B — Identidade histórica e pesquisa global

A partir de `355c9000c918fa839705f1fc812d5464aa9b7568:prompts/CLOUDFLARE_R2_CONFIGURADO.md`:

```text
HISTORICAL_ACCOUNT_FINGERPRINT=5ba0***10e1
HISTORICAL_ACCOUNT_ID_LENGTH=32
```

O account ID histórico foi pesquisado em todos os refs alcançáveis com `git log --all --full-history -S`:

| Ocorrência | Commit | Data | Arquivo/contexto |
|---|---|---|---|
| 1 | `355c9000c918fa839705f1fc812d5464aa9b7568` | 2026-02-27 19:30:26 -03:00 | Configuração inicial de deploy Railway/R2 |
| 2 | `c2ca688ce637ef5cfa067ebde5370fe0da086a8a` | 2026-03-22 23:25:27 -03:00 | Consolidação documental e remoção do prompt histórico |

O endpoint histórico e o account ID histórico também aparecem somente nesses dois commits. Não foi encontrada outra ocorrência do account ID histórico em HEAD, documentação atual ou outros refs alcançáveis.

### FASE C — Timeline forense

| Data | Evidência versionada | Interpretação segura |
|---|---|---|
| 2026-02-27 | Commit inicial contém configuração R2 e credenciais históricas | Exposição histórica confirmada |
| 2026-02-28 a 2026-03-21 | Commits de Railway, deploy, S3, storage, PDFs e uploads | Período de uso/ajuste do stack histórico; não prova operação externa atual |
| 2026-03-22 14:14 | `f393ce784c9bfd5e5697598a076de398b34dab48` restaura upload governado em storage legado | Código/documentação de storage, sem prova de migração de conta |
| 2026-03-22 19:00 | `5adb586b0483e2d0c64ff7588d941ae668092f8f` exige storage oficial e env documental | Hardening de configuração, sem prova de migração R2→R2 |
| 2026-03-22 23:25 | `c2ca688ce637ef5cfa067ebde5370fe0da086a8a` remove prompt histórico e consolida docs | Remoção/consolidação documental confirmada |
| 2026-03-26 a 2026-03-31 | Commits de rollout, Render/Supabase e deploy | Transições de plataforma históricas; sem prova de continuidade R2 |
| 2026-04-02 | Bucket `wanderson-gandra-docs` da conta atualmente autenticada declara criação em `2026-03-22` | Coincidência temporal observada; não prova sucessão/migração |
| Atual | Documentação atual aponta Backblaze B2 para storage governado | Produção documentada não aponta para o R2 autenticado |

A coincidência de 2026-03-22 é real, mas não há evidência direta suficiente para afirmar migração de conta/bucket.

### FASE D — Diff do commit de consolidação

O commit `c2ca688ce637ef5cfa067ebde5370fe0da086a8a` tem como pai `30466ad7874776cc9d7f46e41ec106bc225343f3` e:

- remove `prompts/CLOUDFLARE_R2_CONFIGURADO.md` integralmente — 218 linhas;
- adiciona `docs/consulta-rapida/arquitetura-e-rotas.md`;
- adiciona `docs/consulta-rapida/implementacoes-recentes.md`;
- modifica índices e documentação consolidada;
- registra referências históricas de Railway/R2 e credenciais como contexto documental;
- não contém comando de cópia de objetos, `CopyObject`, `aws s3 sync`, `rclone` ou prova de transferência R2→R2 no diff do commit.

**Resultado:** `MIGRATION_COMMIT_EVIDENCE=YES` somente para remoção/consolidação documental. Não há evidência direta de migração física de objetos ou de troca de account ID.

### FASE E — Inventory Cloudflare acessível

A sessão OAuth autenticada expôs um único account context no `whoami`:

```text
CURRENT_ACCOUNT_FINGERPRINT=6c64***ae9b
```

A tentativa read-only de consultar o account histórico diretamente pela API Cloudflare resultou em:

```text
HISTORICAL_ACCOUNT_ACCESSIBLE=NO_AUTHORIZATION
ACCOUNT_ENDPOINT_HTTP=403
R2_BUCKETS_ENDPOINT_HTTP=403
```

Isso prova que a sessão atual não possui autorização para o account histórico. Não prova que a conta histórica foi deletada.

Classificação operacional:

```text
HISTORICAL_ACCOUNT_ACCESSIBLE=NO
ACCOUNT_ATTRIBUTION_STATE=ACCOUNT_ACCESS_REMOVED_OR_ACCOUNT_OWNED_BY_OTHER_LOGIN_OR_UNKNOWN
```

Não foi possível distinguir entre acesso removido, outro login proprietário, migração ou conta deletada apenas com o acesso atual.

### FASE F/G — Bucket homônimo e timeline de objetos

Na conta atualmente autenticada, `wanderson-gandra-docs` existe:

```text
CURRENT_BUCKET_FOUND=YES
CURRENT_BUCKET_CREATED_AT=2026-03-22T21:18:24.585Z
CURRENT_BUCKET_REGION=ENAM
CURRENT_BUCKET_OBJECT_COUNT=45
CURRENT_BUCKET_SIZE=16.8 MB
HISTORICAL_BUCKET_FOUND=UNKNOWN (conta histórica sem autorização)
```

O Wrangler 4.123.0 disponível não fornece comando read-only de listagem de objetos (`r2 object` expõe somente get/put/delete). Não foram usados downloads nem credenciais S3 atuais para obter listagem. Portanto:

```text
OLD_OBJECT_DATE=UNKNOWN
NEWEST_OBJECT_DATE=UNKNOWN
OBJECT_TIMELINE=NOT_AVAILABLE_WITH_CURRENT_READ_ONLY_ACCESS
```

A existência, data de criação e quantidade de objetos do bucket homônimo não provam que ele seja sucessor do bucket histórico.

### FASE H — Evidência de migração em código

Foram encontrados mecanismos genéricos de storage/cutover/reconciliação:

- `backend/scripts/storage-bucket-cutover.ts` — usa `ListObjectsV2`, `GetObject` e `CopyObject` para cutovers explicitamente parametrizados;
- `backend/scripts/reconcile-signature-storage.js` — reconcilia objetos de assinatura entre origem e alvo parametrizados;
- `backend/scripts/dr-protect-storage.ts` e serviços de DR — replicação para storage de proteção;
- `backend/scripts/externalize-company-logos.js` e `externalize-signature-data.js` — externalização S3-compatible.

Não foi encontrado no histórico analisado um manifesto, log de execução, relatório de cutover ou comando com os dois account IDs provando transferência do bucket histórico para `wanderson-gandra-docs`.

```text
MIGRATION_HYPOTHESIS=INCONCLUSIVE
```

### FASE I/K — Storage documentado para produção hoje

A documentação atual versão HEAD declara:

- `docs/consulta-rapida/implementacoes-recentes.md:14-17`: estado atual versionado = Vultr/Coolify + Backblaze B2; Railway, Cloudflare R2 e Render são históricos;
- `docs/consulta-rapida/implementacoes-recentes.md:75-98`: R2 foi configuração histórica no Railway;
- `docs/deploy/hostinger-coolify-infra-atual.md:24-31`: API/worker na Hostinger/Coolify e storage documentado como Backblaze B2, com DR em segunda conta B2;
- `docs/deploy/COMO-COLOCAR-EM-PRODUCAO.md:9-14,23-28`: infraestrutura atual documentada em Hostinger/Coolify, substituindo Vultr.

Não há acesso autenticado ao Coolify/Hostinger nesta sessão para ler os valores ativos do backend web/worker. Portanto, a conclusão correta é:

```text
PRODUCTION_STORAGE_ACCOUNT=UNKNOWN_OPERATIONAL
DOCUMENTED_PRODUCTION_STORAGE=BACKBLAZE_B2_OTHER_ACCOUNT
BACKEND_STORAGE_CREDENTIAL=UNKNOWN
WORKER_STORAGE_CREDENTIAL=UNKNOWN
DR_STORAGE_CREDENTIAL=UNKNOWN
```

Não se pode afirmar que a produção atual usa a conta R2 autenticada somente com documentação ou bucket homônimo.

### FASE J/N — Credential histórica

Não foi consultado painel administrativo da conta histórica, porque a sessão atual recebeu `403`. Nenhuma credencial adicional foi criada ou revogada.

```text
OLD_CREDENTIAL_STATUS=UNKNOWN
OLD_CREDENTIAL_ADMIN_STATE=NOT_VERIFIABLE_WITH_CURRENT_ACCOUNT
```

### FASE O — Inversion test controlado

Foi executado um processo temporário, sem command line secret, sem arquivo persistente, sem debug HTTP e sem exposição de headers, usando apenas `HeadBucket` contra o endpoint/bucket histórico.

Resultado filtrado:

```text
RESULT=AUTH_REJECTED
HTTP_STATUS=403
OLD_CREDENTIAL_REJECTED=PASS
```

Esse resultado prova que a combinação histórica não possui autorização operacional no endpoint/bucket testado. Não prova, isoladamente, se o estado administrativo é `REVOKED`, `DELETED`, credencial inválida, conta migrada ou perda de permissão. Por isso o status administrativo permanece `UNKNOWN`.

Não houve `GetObject`, `PutObject`, `DeleteObject` nem listagem de objetos no inversion test.

### Evidence Matrix

| Claim | Evidence | Source | Confidence | Status |
|---|---|---|---|---|
| Account ID histórico identificado | Fingerprint `5ba0***10e1` derivada do endpoint histórico | Blob do commit inicial, linhas 13-17 | Alta | Confirmado |
| Account ID histórico aparece no Git | Exatamente 2 commits alcançáveis | `git log --all -S` | Alta | Confirmado |
| Conta autenticada é a histórica | IDs divergem; endpoint histórico recebeu 403 | `whoami` + API Cloudflare read-only | Alta | Rejeitado |
| Bucket homônimo existe na conta atual | `r2 bucket list` e `r2 bucket info` | Wrangler 4.123.0 | Alta | Confirmado |
| Bucket atual é sucessor do histórico | Apenas coincidência de nome/data; sem manifesto de transferência | Git + metadata R2 | Baixa | Não comprovado |
| Houve migração física R2→R2 | Nenhum log/manifesto direto encontrado | Diff c2 + scripts | Baixa | Inconclusivo |
| Produção atual usa R2 autenticado | Docs apontam B2; runtime Coolify não acessível | Deploy docs | Baixa | Não comprovado |
| Credential histórica está operacionalmente rejeitada | `HeadBucket` retornou 403 | Teste efêmero controlado | Alta | Confirmado |
| Credential histórica está administrativamente revogada | Painel/account histórico inacessível | API Cloudflare 403 | Nula | Não comprovado |

### Estados obrigatórios da Fase 0D

```text
CLOUDFLARE_AUTHENTICATED=PASS
CURRENT_ACCOUNT_FINGERPRINT=6c64***ae9b
HISTORICAL_ACCOUNT_FINGERPRINT=5ba0***10e1
ACCOUNT_IDS_EQUAL=FALSE
HISTORICAL_ACCOUNT_ACCESSIBLE=NO
CURRENT_BUCKET_FOUND=YES
CURRENT_BUCKET_CREATED_AT=2026-03-22T21:18:24.585Z
HISTORICAL_BUCKET_FOUND=UNKNOWN
PRODUCTION_STORAGE_ACCOUNT=UNKNOWN_OPERATIONAL
MIGRATION_COMMIT_EVIDENCE=YES_DOCUMENT_REMOVAL_ONLY
MIGRATION_HYPOTHESIS=INCONCLUSIVE
OLD_CREDENTIAL_STATUS=UNKNOWN
OLD_CREDENTIAL_REJECTED=PASS
```

### Blockers remanescentes

1. A conta histórica não está autorizada para o login atual (`403`), portanto não é possível confirmar existência administrativa nem estado `REVOKED/DELETED`.
2. Não há acesso ao Coolify/Hostinger para confirmar os valores de storage ativos no backend web/worker.
3. Não há evidência direta de que o bucket homônimo atual seja sucessor do bucket histórico.
4. Não há timeline de objetos disponível por metadata read-only no Wrangler atual.
5. Não é seguro executar revogação em qualquer conta atualmente acessível por inferência de nome.

**Veredito da Fase 0D:** `P0_R2_INCIDENT_NOT_CLOSED`

**PARADA:** não executar revogação, criação de credential, update de produção, deploy, exclusão, history rewrite ou Fase 1. A próxima ação segura exige acesso ao account histórico ou evidência administrativa de migração/ownership, além de acesso read-only ao runtime atual para confirmar o storage de produção.

## FASE 0E — PRODUCTION STORAGE GROUND TRUTH

### Veredito

```text
PRODUCTION_STORAGE_GROUND_TRUTH=INCOMPLETE
P0_R2_INCIDENT_NOT_CLOSED
```

Esta fase separou explicitamente evidência de código, documentação, metadata da conta Cloudflare atualmente autenticada e configuração operacional real. Nenhum secret foi impresso, lido para o relatório, criado, alterado ou propagado.

### 1. Correção da classificação do HeadBucket histórico

A resposta `HTTP 403 AccessDenied` do `HeadBucket` histórico **não** é prova de credencial revogada, inválida ou rejeitada administrativamente. Ela prova somente que a operação tentada não foi autorizada no endpoint/bucket testado.

A classificação normativa desta fase é:

```text
OLD_CREDENTIAL_OPERATIONAL_ACCESS=DENIED
OLD_CREDENTIAL_REJECTED=INCONCLUSIVE
OLD_CREDENTIAL_ADMIN_STATUS=UNKNOWN
OLD_CREDENTIAL_REVOKED=UNPROVEN
```

O resultado permanece compatível com credencial válida sem permissão para `HeadBucket`/`ListBucket`, credencial revogada, credencial deletada, bucket/conta diferente, endpoint migrado ou outra causa de `AccessDenied`. O status administrativo somente poderá ser concluído com consulta autorizada à conta/provedor correto ou evidência administrativa equivalente.

### 2. Inventário local de aliases e consumidores

A varredura foi limitada ao checkout principal, excluindo `.git`, `node_modules`, `.next`, artefatos de build, coverage e worktrees auxiliares. Foram encontrados os seguintes grupos:

| Grupo | Variáveis/aliases | Consumidores evidenciados |
|---|---|---|
| Storage principal | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_BUCKET_NAME`, `AWS_S3_BUCKET`, `AWS_ENDPOINT`, `AWS_S3_ENDPOINT`, `AWS_REGION`, `S3_FORCE_PATH_STYLE` | `backend/src/app.module.ts:577-590,949-997`; `backend/src/shared/services/storage.service.ts:61-93`; `backend/src/shared/storage/s3.service.ts:67-95` |
| Réplica/DR | `DR_STORAGE_REPLICA_BUCKET`, `DR_STORAGE_REPLICA_ENDPOINT`, `DR_STORAGE_REPLICA_REGION`, `DR_STORAGE_REPLICA_ACCESS_KEY_ID`, `DR_STORAGE_REPLICA_SECRET_ACCESS_KEY`, `DR_STORAGE_REPLICA_FORCE_PATH_STYLE` | `backend/src/app.module.ts:585-590,986-997`; `backend/src/modules/disaster-recovery/disaster-recovery-replica-storage.service.ts:43-68`; `backend/scripts/disaster-recovery/common.ts:343-374` |
| Cutover/reconciliação | `STORAGE_SOURCE_*`, `STORAGE_MIGRATION_TARGET_*`, `STORAGE_TARGET`, `STORAGE_SOURCE`, `S3_BUCKET`, `S3_ENDPOINT` | `backend/scripts/storage-bucket-cutover.ts:157-221`; `backend/scripts/reconcile-signature-storage.js:54-75,189-200` |
| Jobs/backup | `STORAGE_BACKUP_PREFIX`, `STORAGE_PROTECTION_LIMIT_PER_SOURCE` | `backend/scripts/dr-backup.ts:8,228-229`; `.github/workflows/disaster-recovery-backup.yml:43-121` |

A configuração do processo worker é carregada por `backend/src/worker.ts:1-7`, que executa `dotenv.config` sobre `backend/.env`, e o módulo do worker declara os mesmos parâmetros de timeout S3 em `backend/src/worker.module.ts:268-271`. Isso demonstra o caminho de configuração compartilhado, mas não prova quais valores estão implantados no worker de produção.

### 3. Fail-closed estático

A validação em `backend/src/app.module.ts:965-984` exige, em `NODE_ENV=production`, bucket, access key e secret; se o endpoint for Cloudflare R2, exige também `S3_FORCE_PATH_STYLE=true`. A validação da réplica em `backend/src/app.module.ts:986-997` exige endpoint e credenciais quando `DR_STORAGE_REPLICA_BUCKET` está configurado.

Os construtores ainda usam string vazia como ausência interna (`storage.service.ts:61-86`; `s3.service.ts:67-90`). Portanto, o resultado é **PASS estático condicionado à execução da barreira de configuração**, não prova de que o runtime ativo tenha sido iniciado com configuração correta.

### 4. Evidência de ambiente operacional

```text
PRIOR_CHECK_BACKEND_HEALTH=https://api.sgsseguranca.com.br/health -> HTTP 200 (evidência registrada anteriormente nesta auditoria)
PRIOR_CHECK_BACKEND_READY=https://api.sgsseguranca.com.br/health/ready -> HTTP 200 (evidência registrada anteriormente nesta auditoria)
CURRENT_RECHECK_BACKEND_HEALTH=https://api.sgsseguranca.com.br/health -> HTTP 403
CURRENT_RECHECK_BACKEND_READY=https://api.sgsseguranca.com.br/health/ready -> HTTP 403
CURRENT_RECHECK_FRONTEND_LOGIN=https://app.sgsseguranca.com.br/login -> HTTP 200
PRODUCTION_ENV_ACCESS=NOT_OBTAINED
BACKEND_RUNTIME_STORAGE=UNKNOWN
WORKER_RUNTIME_STORAGE=UNKNOWN
```

As respostas públicas variaram entre verificações e não constituem prova de configuração interna: a rechecagem atual recebeu `403` na API e `200` no login do frontend. Mesmo a evidência anterior de `200` somente confirmava disponibilidade HTTP naquele momento; nenhum desses endpoints revela provider, endpoint mascarado, bucket, região, `forcePathStyle` ou fingerprint da credencial. Não foram encontrados nesta execução acesso autenticado ao Coolify/Hostinger, shell da VPS ou logs do worker; consequentemente não houve leitura de configuração operacional.

### 5. Conclusão por componente

```text
DOCUMENTED_PRODUCTION_STORAGE=BACKBLAZE_B2_OTHER_ACCOUNT
BACKEND_STORAGE_PROVIDER=UNKNOWN_OPERATIONAL
WORKER_STORAGE_PROVIDER=UNKNOWN_OPERATIONAL
PRODUCTION_STORAGE_ACCOUNT=UNKNOWN_OPERATIONAL
BACKEND_STORAGE=UNKNOWN
WORKER_STORAGE=UNKNOWN
PRODUCTION_USES_HISTORICAL_ACCESS_KEY=UNPROVEN
BACKBLAZE_PRODUCTION_CONFIRMED=DOCUMENTED_ONLY
R2_CURRENT_PRODUCTION_DEPENDENCY=UNPROVEN
```

A documentação versionada aponta Backblaze B2, mas isso não substitui leitura do ambiente efetivamente implantado. A existência anterior de bucket homônimo na conta Cloudflare atualmente autenticada também não prova sucessão, migração ou uso pela produção.

### 6. Ações não executadas e critério de encerramento

Não foram executados: revogação, criação/rotação de credenciais, atualização de Coolify/Hostinger, redeploy, upload/download/presigned URL real, fluxo APR/evidência/anexo, teste cross-tenant, consulta de logs, history rewrite ou force push.

A Fase 0E só poderá ser encerrada quando houver, por canal autorizado e sem colar secrets no chat, o endpoint mascarado, bucket, região, `forcePathStyle` e fingerprint da configuração do backend web e do worker, além da confirmação de que a access key histórica não está implantada. Depois disso, os testes funcionais devem ser executados separadamente para backend e worker.

**Veredito da Fase 0E:** `PRODUCTION_STORAGE_GROUND_TRUTH=INCOMPLETE` / `P0_R2_INCIDENT_NOT_CLOSED`.

## FASE 0F — PRODUCTION RUNTIME STORAGE VERIFICATION

### Resultado de parada antecipada

```text
PRODUCTION_RUNTIME_ACCESS=BLOCKED
P0_R2_INCIDENT_NOT_CLOSED
```

A Fase 0F foi interrompida antes da leitura de qualquer configuração de produção porque não foi encontrado, nesta sessão, um canal administrativo autorizado e operacional para Hostinger/Coolify ou para os containers ativos.

### Fase A/B — Identificação de serviços e versão

```text
BACKEND_SERVICE_FOUND=UNKNOWN
WORKER_SERVICE_FOUND=UNKNOWN
BACKEND_COMMIT=UNKNOWN
WORKER_COMMIT=UNKNOWN
```

Não foram obtidos metadados de container/service, ambiente, image/tag, commit SHA, hostname ou uptime. O checkout local e a documentação não foram tratados como prova de que representam a release atualmente executada.

### Evidência do bloqueio de acesso

Foram verificadas apenas presenças/ausências não sensíveis:

```text
DOCKER_CLI=NOT_FOUND
PODMAN_CLI=NOT_FOUND
DOCKER_SOCKET=ABSENT
SSH_CONFIG_HOSTS=NONE_FOUND
SSH_KEY_FILENAMES=NONE_FOUND
COOLIFY_API_TOKEN=MISSING
HOSTINGER_API_TOKEN=MISSING
RUNTIME_ACCESS_TOKEN=MISSING
```

O Wrangler possui uma sessão OAuth local para Cloudflare, mas isso não concede acesso ao runtime Hostinger/Coolify e não foi usado para alterar recursos. Nenhum token, cookie, header de autorização ou valor de variável foi impresso.

### Fase C/M — Configuração seletiva

```text
BACKEND_CONFIG_SOURCE=UNKNOWN
WORKER_CONFIG_SOURCE=UNKNOWN
BACKEND_STORAGE_PROVIDER=UNKNOWN
WORKER_STORAGE_PROVIDER=UNKNOWN
BACKEND_STORAGE_HOST=UNKNOWN
WORKER_STORAGE_HOST=UNKNOWN
BACKEND_BUCKET_NAME=UNKNOWN
WORKER_BUCKET_NAME=UNKNOWN
BACKEND_REGION=UNKNOWN
WORKER_REGION=UNKNOWN
BACKEND_FORCE_PATH_STYLE=UNKNOWN
WORKER_FORCE_PATH_STYLE=UNKNOWN
BACKEND_USES_HISTORICAL_ACCESS_KEY=UNKNOWN
WORKER_USES_HISTORICAL_ACCESS_KEY=UNKNOWN
BACKEND_R2_ACCOUNT=UNKNOWN
WORKER_R2_ACCOUNT=UNKNOWN
BACKBLAZE_RUNTIME_CONFIRMED=NOT_RUN
BACKEND_WORKER_STORAGE_CONFIG_MATCH=UNKNOWN
DR_STORAGE_ENABLED=UNKNOWN
DR_STORAGE_PROVIDER=UNKNOWN
```

Nenhum processo, container, orchestrator ou arquivo montado de produção foi consultado. Portanto, não é possível determinar o provider, hostname, bucket, região, path style, identidade da Access Key, conta R2 ou coerência backend/worker. A documentação Backblaze B2 continua sendo apenas evidência documental.

### Fase N/O — Credencial histórica

```text
HISTORICAL_R2_CREDENTIAL_STILL_DEPLOYED=UNKNOWN
HISTORICAL_R2_CREDENTIAL_NOT_DEPLOYED=UNKNOWN
```

A Access Key histórica não foi comparada porque a Access Key atual de produção não está acessível por canal autorizado nesta sessão. Não há base para declarar `TRUE` ou `FALSE`.

### Fase P/U — Testes funcionais

A regra de parada foi aplicada antes do Golden Storage Test:

```text
UPLOAD=NOT_RUN
DOWNLOAD=NOT_RUN
PRESIGNED_URL=NOT_RUN
APR_PDF_STORAGE=NOT_RUN
EVIDENCE_STORAGE=NOT_RUN
ATTACHMENT_STORAGE=NOT_RUN
CROSS_TENANT_STORAGE_ACCESS=BLOCKED
CROSS_SITE_STORAGE_ACCESS=BLOCKED
```

Não foram feitos uploads, downloads, geração de APR, presigned URLs, deletes, testes cross-tenant ou cross-site. Não foram feitas chamadas diretas ao SDK de storage.

### Fase V/W — Health endpoints

As verificações externas já registradas nesta auditoria observaram respostas variáveis:

```text
HEALTH_EXTERNAL_CURRENT=/health -> HTTP 403
READY_EXTERNAL_CURRENT=/health/ready -> HTTP 403
BACKEND_INTERNAL_HEALTH=NOT_RUN
READY_INTERNAL=NOT_RUN
HEALTH_403_ROOT_CAUSE=UNKNOWN
```

Sem acesso ao serviço interno, proxy, WAF, nginx, Coolify ou logs, não é possível distinguir entre `AUTH_REQUIRED`, `PROXY_POLICY`, `WAF`, `IP_RESTRICTION` e `APPLICATION`. Nenhuma regra foi alterada.

### Fase X — Verificação de vazamento durante a auditoria

```text
RUNTIME_SECRET_LEAK_DURING_AUDIT=NO
```

Foram consultados somente nomes de comandos, existência de socket/arquivos de acesso e status booleanos de variáveis. Não foram executados `cat .env`, `printenv`, `env`, `set`, `export -p` ou `docker inspect`; nenhum secret, token, cookie, header, private key, `DATABASE_URL`, `REDIS_URL` ou senha foi incluído no relatório.

### Conclusão e próximo desbloqueio

A Fase 0F **não confirmou** o storage real do backend web ou worker, não confirmou uso de R2 histórico, não confirmou uso da Access Key histórica e não permitiu comparar os serviços. O resultado correto é bloqueio operacional, não falha de storage:

```text
PRODUCTION_RUNTIME_ACCESS=BLOCKED
PRODUCTION_STORAGE_GROUND_TRUTH=INCOMPLETE
P0R2INCIDENTNOTCLOSED
```

Para retomar com segurança, é necessário acesso autorizado ao Coolify/Hostinger, SSH autorizado ou terminal dos containers. O acesso deve permitir leitura seletiva de metadados e das variáveis de storage, sem expor valores sensíveis. Não executar rotação, deploy, history rewrite, Fase 1 ou commit automático.

## FASE 0G — SECURE RUNTIME ACCESS BOOTSTRAP

### Resultado

```text
COOLIFY_BASE_URL_PRESENT=NO
COOLIFY_API_TOKEN_PRESENT=YES
RUNTIME_ACCESS_BOOTSTRAP=BLOCKED
PRODUCTION_RUNTIME_ACCESS=BLOCKED
```

A variável `COOLIFY_API_TOKEN` foi detectada apenas como presente em memória; seu valor não foi impresso, armazenado ou usado em saída. A variável obrigatória `COOLIFY_BASE_URL` não está disponível na sessão atual.

Conforme a regra de parada da Fase 0G, nenhuma chamada à API Coolify foi executada. Portanto, permanecem não determinados:

```text
COOLIFY_AUTHENTICATED=NOT_RUN
COOLIFY_TEAM_VISIBLE=UNKNOWN
COOLIFY_SERVERS_VISIBLE=UNKNOWN
COOLIFY_PROJECTS_VISIBLE=UNKNOWN
COOLIFY_APPLICATIONS_VISIBLE=UNKNOWN
BACKEND_RUNTIME_FOUND=UNKNOWN
WORKER_RUNTIME_FOUND=UNKNOWN
BACKEND_ENV_READABLE=NOT_RUN
WORKER_ENV_READABLE=NOT_RUN
WRITE_PERMISSION=UNKNOWN
DEPLOY_PERMISSION=UNKNOWN
ROOT_PERMISSION=UNKNOWN
AUDIT_ACCESS_SECRET_LEAK=NO
```

### Higiene da sessão

Nenhum token foi adicionado ao relatório, Git, arquivo temporário ou shell history. Nenhum header `Authorization` foi criado ou registrado. Nenhuma resposta da API Coolify foi obtida ou persistida.

### Veredito

`RUNTIME_ACCESS_BOOTSTRAP=BLOCKED` porque falta `COOLIFY_BASE_URL`. A Fase 0G termina aqui, sem prosseguir para leitura de recursos, ambientes, storage ou para a Fase 0F.

Para nova tentativa, disponibilizar `COOLIFY_BASE_URL` na sessão de shell e manter o token somente em memória, com escopo read-only. Nenhuma permissão deve ser alterada automaticamente.

## FASE 0G-R — COOLIFY RUNTIME ACCESS BOOTSTRAP

### Resultado da retomada — somente GET read-only

```text
COOLIFY_BASE_URL_PRESENT=YES
COOLIFY_API_TOKEN_PRESENT=YES
COOLIFY_AUTHENTICATED=PASS
COOLIFY_TEAM_VISIBLE=YES
COOLIFY_SERVERS_VISIBLE=YES
SGS_SERVER_FOUND=YES
COOLIFY_PROJECTS_VISIBLE=YES
SGS_PROJECT_FOUND=YES
COOLIFY_APPLICATIONS_VISIBLE=YES
COOLIFY_SERVICES_VISIBLE=YES (0 services; os dois runtimes são applications)
BACKEND_RUNTIME_FOUND=YES
WORKER_RUNTIME_FOUND=YES
BACKEND_ENV_READABLE=YES
WORKER_ENV_READABLE=YES
READ_SENSITIVE_CAPABILITY=PASS
READ_PERMISSION=YES
READ_SENSITIVE_PERMISSION=YES
WRITE_PERMISSION=UNKNOWN
DEPLOY_PERMISSION=UNKNOWN
ROOT_PERMISSION=UNKNOWN
PRODUCTION_RUNTIME_ACCESS=PASS
RUNTIME_ACCESS_BOOTSTRAP=PASS
AUDIT_ACCESS_SECRET_LEAK=NO
```

### Evidências sanitizadas

- Team visível: `Root Team`, fingerprint do identificador: `0`.
- Server visível: `localhost`, fingerprint `sa80fcnx6z`; o Coolify reportou o endereço interno `host.docker.internal`. A URL do painel e a topologia documentada identificam este como o servidor Hostinger/Coolify do SGS.
- Projeto: `My first project`, fingerprint `k4tvj4jbsu`; environment `production`, fingerprint `r2j049cg1r`.
- Backend web: fingerprint `s2jgvkq9tr`; repositório reportado pelo Coolify `complianceX/sgsseguranca.git`; branch `main`; último deployment `finished`; commit curto `2d5e4959f1`; status reportado `running:unknown`; domínio `https://api.sgsseguranca.com.br`.
- Worker: fingerprint `x3k7efj1x3`; repositório reportado pelo Coolify `complianceX/sgsseguranca.git`; branch `main`; último deployment `finished`; commit curto `2d5e4959f1`; status reportado `running:unknown`; sem domínio público operacional.
- A API Coolify reporta `complianceX/sgsseguranca.git`, divergente do owner atualmente documentado/versionado neste checkout (`wandersongandra/sgsseguranca.git`). A divergência foi registrada, sem alteração remota.

### Presença sanitizada de environment — nenhum valor lido para saída

Backend e worker retornaram HTTP 200 em `GET /api/v1/applications/{resource}/envs`. Em ambos:

```text
AWS_ENDPOINT=PRESENT
AWS_S3_ENDPOINT=MISSING
AWS_BUCKET_NAME=PRESENT
AWS_S3_BUCKET=MISSING
AWS_REGION=PRESENT
S3_FORCE_PATH_STYLE=PRESENT
AWS_ACCESS_KEY_ID=PRESENT
AWS_SECRET_ACCESS_KEY=PRESENT
DR_STORAGE_REPLICA_BUCKET=MISSING
DR_STORAGE_REPLICA_ENDPOINT=MISSING
DR_STORAGE_REPLICA_REGION=MISSING
DR_STORAGE_REPLICA_ACCESS_KEY_ID=MISSING
DR_STORAGE_REPLICA_SECRET_ACCESS_KEY=MISSING
DR_STORAGE_REPLICA_FORCE_PATH_STYLE=MISSING
```

Os valores, inclusive endpoints, buckets e credenciais, não foram impressos nem persistidos. Não houve tentativa de identificar provider, comparar chaves, testar R2/Backblaze, executar request de storage, deploy ou qualquer operação de escrita. A Fase 0F não foi iniciada automaticamente.

### Higiene da sessão

Nenhum token, header `Authorization`, JSON bruto contendo environments, `.env`, cookie, chave privada ou secret foi salvo no relatório, arquivo temporário ou Git. Nenhuma operação administrativa, de escrita, deploy ou alteração de produção foi executada.

`RUNTIME_ACCESS_BOOTSTRAP=PASS` / `PRODUCTION_RUNTIME_ACCESS=PASS`.

## FASE 0H — PRODUCTION SOURCE PROVENANCE

### Resultado

```text
BACKEND_SOURCE_REPOSITORY=complianceX/sgsseguranca.git
WORKER_SOURCE_REPOSITORY=complianceX/sgsseguranca.git
LOCAL_ORIGIN_REPOSITORY=https://github.com/wandersongandra/sgsseguranca.git
BACKEND_SOURCE_BRANCH=main
WORKER_SOURCE_BRANCH=main
BACKEND_DEPLOYED_COMMIT=2d5e4959f1b921211c576f8cc2912d5bed83def8
WORKER_DEPLOYED_COMMIT=2d5e4959f1b921211c576f8cc2912d5bed83def8
PRODUCTION_COMMIT_EXISTS_LOCALLY=YES
REPOSITORIES_SHARE_HISTORY=YES
BACKEND_WORKER_SOURCE_MATCH=PASS
PRODUCTION_CODE_MATCHES_AUDITED_SOURCE=PASS
PRODUCTION_SOURCE_DIVERGENCE=NO
PRODUCTION_SOURCE_PROVENANCE=PASS
```

### Evidências de identidade

- O Coolify usa `complianceX/sgsseguranca.git`, branch `main`, build `dockerfile`, com `/Dockerfile` no backend e `/Dockerfile.worker` no worker.
- Backend e worker possuem o mesmo deployment SHA completo `2d5e4959f1b921211c576f8cc2912d5bed83def8`, ambos com status `finished`.
- O objeto existe no clone local. Metadata: author/commit date `2026-08-14T03:18:16Z`, subject `fix(apr): security hardening and load-test proof`, pais `3f54720d7108ba3751ae198ed11653e952ab5be7` e `f86530812d3c5e24f805e63f42fb0dc60c922955`.
- `wandersongandra/sgsseguranca` e `complianceX/sgsseguranca` retornaram o mesmo `main` e o mesmo SHA; a comparação read-only encontrou 69 refs iguais.
- A URL antiga `complianceX/sgsseguranca` respondeu HTTP 301 para `wandersongandra/sgsseguranca`. A API GitHub normalizou ambos para `wandersongandra/sgsseguranca`, com `fork=false`, mesmos pais, datas e metadata. Isso confirma rename/transfer de identidade, não fork ou mirror independente.

### Ressalva do checkout local

O `origin` local aponta para `wandersongandra/sgsseguranca.git`. O `HEAD` local é `f86530812d3c5e24f805e63f42fb0dc60c922955`, pai direto do commit de produção, e o working tree contém alterações não commitadas preexistentes. Isso não altera a prova de que o SHA de produção pertence ao mesmo repositório auditado; essas alterações locais não foram tratadas como código implantado e não foram modificadas nesta fase.

Não houve push, pull, fetch, troca de branch, alteração de remote, deploy, restart ou qualquer mutação. A Fase 0F não foi iniciada automaticamente.

## FASE 0F-R — PRODUCTION STORAGE RUNTIME GROUND TRUTH

### Configuração efetiva lida no Coolify

```text
BACKEND_CONFIG_SOURCE=COOLIFY_RUNTIME_ENVIRONMENT
WORKER_CONFIG_SOURCE=COOLIFY_RUNTIME_ENVIRONMENT
BACKEND_STORAGE_PROVIDER=BACKBLAZE_B2
WORKER_STORAGE_PROVIDER=BACKBLAZE_B2
BACKEND_STORAGE_HOST=s3.us-east-005.backblazeb2.com
WORKER_STORAGE_HOST=s3.us-east-005.backblazeb2.com
BACKEND_BUCKET=sha256:3aa3ba1eebb9
WORKER_BUCKET=sha256:3aa3ba1eebb9
BACKEND_REGION=us-east-005
WORKER_REGION=us-east-005
BACKEND_FORCE_PATH_STYLE=true
WORKER_FORCE_PATH_STYLE=true
BACKEND_WORKER_STORAGE_CONFIG_MATCH=PASS
```

Backend e worker retornaram HTTP 200 em `GET /api/v1/applications/{resource}/envs`. Os nomes de access key e secret key estavam presentes em ambos, mas nenhum valor foi impresso, salvo ou incluído no relatório. O host foi sanitizado para hostname; query strings e credenciais embutidas não foram emitidas.

### Comparação da credencial histórica R2

```text
BACKEND_USES_HISTORICAL_ACCESS_KEY=FALSE
WORKER_USES_HISTORICAL_ACCESS_KEY=FALSE
HISTORICAL_R2_CREDENTIAL_STILL_DEPLOYED=NO
HISTORICAL_R2_CREDENTIAL_NOT_DEPLOYED=PASS
HISTORICAL_R2_NOT_IN_PRODUCTION=PASS
```

A comparação foi feita em memória entre os dois environments atuais e a única atribuição histórica identificada no blob `355c9000c918fa839705f1fc812d5464aa9b7568`, arquivo `prompts/CLOUDFLARE_R2_CONFIGURADO.md`. A secret access key histórica não foi lida nem comparada.

```text
BACKEND_R2_ACCOUNT=N/A
WORKER_R2_ACCOUNT=N/A
BACKBLAZE_RUNTIME_CONFIRMED=PASS
R2_CURRENT_PRODUCTION_DEPENDENCY=NO
DR_STORAGE_ENABLED=NO
DR_STORAGE_PROVIDER=N/A
```

Isso prova apenas que a credential histórica não está carregada nos dois runtimes observados. Não prova revogação, deleção ou invalidação administrativa da credential antiga.

### Golden storage / fluxos funcionais

```text
UPLOAD=NOT_RUN
DOWNLOAD=NOT_RUN
PRESIGNED_URL=NOT_RUN
APR_PDF_STORAGE=NOT_RUN
EVIDENCE_STORAGE=NOT_RUN
ATTACHMENT_STORAGE=NOT_RUN
CROSS_TENANT_STORAGE_ACCESS=NOT_RUN
CROSS_SITE_STORAGE_ACCESS=NOT_RUN
```

Os testes foram deliberadamente interrompidos antes de qualquer mutação porque não havia, nesta sessão, `TEST_COMPANY_ID`, senha de smoke ou outro contexto sintético de tenant autenticado. Os smoke scripts existentes exigem contexto operacional adicional e os `.env` locais existentes declaram `NODE_ENV=development`; nenhum `.env` foi aberto ou reutilizado. Não foi criado tenant, usuário, APR, arquivo, PDF ou objeto de storage.

### Health

```text
EXTERNAL_HEALTH_PUBLIC_CURRENT=PASS (HTTP 200)
EXTERNAL_HEALTH_CURRENT=PASS (HTTP 200)
EXTERNAL_READY_CURRENT=PASS (HTTP 200)
BACKEND_INTERNAL_HEALTH=UNKNOWN
READY_INTERNAL=UNKNOWN
HEALTH_403_ROOT_CAUSE=UNKNOWN
```

Os três endpoints públicos responderam HTTP 200 na rechecagem atual; portanto, o 403 histórico não foi reproduzido e sua causa atual não pode ser atribuída. Não houve alteração de proxy, WAF, firewall ou proteção de health.

### Veredito e higiene

```text
RUNTIME_SECRET_LEAK_DURING_AUDIT=NO
P0R2INCIDENTCONTAINED_NOT_CLOSED
```

O runtime atual está comprovadamente em Backblaze B2 e não usa a Access Key histórica R2. O status administrativo da credential antiga permanece desconhecido; por isso o incidente está contido no runtime, mas não fechado. Os testes funcionais e de isolamento permanecem pendentes até existir um contexto sintético de produção explicitamente seguro.

## FASE 0I — GOLDEN STORAGE & ISOLATION ACCEPTANCE

### Mecanismos existentes e gate de autenticação

| Mecanismo | Finalidade | Requisitos sensíveis/operacionais | Controles de segurança |
|---|---|---|---|
| `backend/scripts/prod-gandra-*-smoke.js` | smoke real de módulos e PDFs em produção | contexto de empresa, credencial de smoke e, conforme o script, acesso runtime de banco/JWT | `PRODUCTION_SAFE_TEST_MODE=true`, notificações externas desabilitadas, limite de documentos e marcadores sintéticos |
| `backend/test/critical/*.e2e-spec.ts` | E2E com tenants/fixtures sintéticos | PostgreSQL/Redis descartáveis via `docker-compose.test.yml` | isolamento local/CI; não é prova do runtime Coolify/Hostinger |
| `backend/src/infra/storage/storage.controller.ts` | fluxo real presigned upload → PUT → complete upload | autenticação JWT, tenant e papel autorizado | quarentena por tenant, magic bytes, inspeção AV e promoção governada |

```text
SYNTHETIC_AUTH=FAIL
```

Não havia nesta sessão um `TEST_COMPANY_ID`, senha de smoke ou sessão autenticada sintética autorizada. Os `.env` locais existentes declaram `NODE_ENV=development` e não foram abertos nem reutilizados. Não foi criada infraestrutura paralela, tenant, usuário ou credencial.

### Resultados funcionais

```text
UPLOAD=NOT_RUN
STORAGE_METADATA=NOT_RUN
DOWNLOAD=NOT_RUN
CONTENT_INTEGRITY=NOT_RUN
PRESIGNED_URL=NOT_RUN
APR_PDF_STORAGE=NOT_RUN
APR_PDF_HASH_INTEGRITY=NOT_RUN
EVIDENCE_STORAGE=NOT_RUN
ATTACHMENT_STORAGE=NOT_RUN
CROSS_TENANT_METADATA=NOT_RUN
CROSS_TENANT_DOWNLOAD=NOT_RUN
CROSS_TENANT_PRESIGNED_URL=NOT_RUN
CROSS_TENANT_STORAGE_ACCESS=NOT_RUN
CROSS_SITE_STORAGE_ACCESS=NOT_RUN
OBJECT_ID_TAMPERING=NOT_RUN
SENSITIVE_STORAGE_METADATA_LEAK=NOT_RUN
FILE_VALIDATION=NOT_RUN
PATH_TRAVERSAL_STORAGE=NOT_RUN
SYNTHETIC_CLEANUP=NOT_APPLICABLE
RUNTIME_SECRET_LEAK_DURING_AUDIT=NO
CURRENT_PRODUCTION_STORAGE_SAFE=INCOMPLETE
```

O contrato real de `POST /storage/presigned-url` exige `application/pdf` e nome terminado em `.pdf`; portanto o arquivo solicitado `security-storage-proof.txt` não é aceito por esse fluxo. Isso foi identificado por inspeção do código versionado, sem request mutável. Nenhum upload, download, presigned URL, APR, evidence, attachment, teste cross-tenant/cross-site ou tentativa de tampering foi executado.

### Veredito

`CURRENT_PRODUCTION_STORAGE_SAFE=INCOMPLETE`.

O gate foi interrompido antes de qualquer mutação porque a autenticação sintética falhou por ausência de contexto autorizado. Não há evidência funcional para declarar storage seguro operacionalmente, embora a configuração Backblaze e a não implantação da Access Key histórica já estejam comprovadas na Fase 0F-R. A Fase 1 não foi iniciada.

### Retomada no ambiente oficial `loadtest`

O ambiente encontrado no repositório e confirmado por SSH read-only foi o loadtest isolado, com `APP_ENV=loadtest`, marcador `sgs-loadtest`, banco `sgs_loadtest` e volume local exclusivo de documentos. O guard oficial rejeita marcadores de produção, endpoints externos e buckets não sintéticos. Nenhum valor de credencial foi impresso.

```text
LOADTEST_GUARD=PASS
LOADTEST_STORAGE_MODE=LOCAL_ISOLATED_VOLUME
SYNTHETIC_AUTH=PASS
```

Autenticação sintética: CSRF HTTP 200, login HTTP 201 e `/auth/me` HTTP 200, com correspondência do usuário e tenant sintéticos esperados. O fluxo funcional criou um APR sintético, consultou metadata, anexou uma evidência PNG sintética, executou os checks de tampering/validação e removeu o APR criado.

```text
UPLOAD=FAIL
STORAGE_METADATA=PASS
DOWNLOAD=NOT_APPLICABLE_LOCAL_VOLUME
CONTENT_INTEGRITY=NOT_APPLICABLE_LOCAL_VOLUME
PRESIGNED_URL=NOT_APPLICABLE_LOCAL_VOLUME
APR_PDF_STORAGE=FAIL_TIMEOUT
APR_PDF_HASH_INTEGRITY=NOT_RUN
EVIDENCE_STORAGE=PASS
ATTACHMENT_STORAGE=NOT_APPLICABLE
CROSS_TENANT_METADATA=NOT_RUN_TENANT_B_ABSENT
CROSS_TENANT_DOWNLOAD=NOT_RUN_TENANT_B_ABSENT
CROSS_TENANT_PRESIGNED_URL=NOT_RUN_TENANT_B_ABSENT
CROSS_TENANT_STORAGE_ACCESS=NOT_RUN_TENANT_B_ABSENT
CROSS_SITE_STORAGE_ACCESS=NOT_RUN_SITE_B_ABSENT
OBJECT_ID_TAMPERING=BLOCKED
SENSITIVE_STORAGE_METADATA_LEAK=NO
FILE_VALIDATION=PASS
PATH_TRAVERSAL_STORAGE=BLOCKED
SYNTHETIC_CLEANUP=PASS
RUNTIME_SECRET_LEAK_DURING_AUDIT=NO
CURRENT_PRODUCTION_STORAGE_SAFE=INCOMPLETE
```

O endpoint genérico `/storage/presigned-url` não foi aprovado no loadtest porque o compose oficial usa `LOCAL_DOCUMENT_STORAGE_DIR` para os fluxos documentais governados, enquanto esse endpoint depende do `StorageService` S3. Isso não altera a prova da Fase 0F-R sobre o B2 de produção. A execução única do runner oficial de APR/PDF excedeu o limite de 180 segundos e foi encerrada sem retry; por isso PDF, download e hash não foram declarados aprovados. O seed oficial possui somente o tenant e site sintéticos A; não há tenant B ou site B para concluir os gates adversariais sem criar massa adicional.

`CURRENT_PRODUCTION_STORAGE_SAFE=INCOMPLETE`. A Fase 0F não foi retomada automaticamente, nenhum secret foi alterado, e a Fase 1 não foi iniciada.
