# Auditoria loadtest versus produção — 2026-08-13

## Resultado executivo

O timeout observado na campanha anterior foi reproduzido no caminho público do
ambiente loadtest e deixou de ocorrer após duas correções restritas ao loadtest:

- o edge Caddy passou a negociar somente HTTP/1.1 e HTTP/2, removendo HTTP/3
  do primeiro ciclo de validação;
- os limites de memória/CPU do edge e do proxy interno foram dimensionados para
  a VPS de 16 GB e 6 vCPU.

Não foi feita alteração em produção, banco, DNS ou firewall de produção.

## Evidência do loadtest

Alvo: `api-loadtest.sgsseguranca.com.br`, exclusivamente sintético.

| Perfil | Duração | VUs máximos | Resultado |
| --- | ---: | ---: | --- |
| spike | 60 s | 25 | aprovado; 0% de falha; checks 100% |
| stress | 3 min | 20 | aprovado; 0% de falha; checks 100% |
| soak | 10 min | 5 | aprovado; 0% de falha; checks 100% |

O soak terminou com p95 aproximado de 193 ms. Houve um máximo isolado de
aproximadamente 6,45 s, mas nenhum erro HTTP, timeout ou threshold reprovado.

## Evidência pública de produção

Consultas somente leitura em 2026-08-13:

- `GET https://api.sgsseguranca.com.br/health/public`: HTTP 200, corpo
  `{"status":"ok"}`;
- `GET https://api.sgsseguranca.com.br/health`: HTTP 200;
- `GET https://api.sgsseguranca.com.br/auth/csrf`: HTTP 200;
- a resposta de CSRF informou limite de 20 requisições e 19 restantes na janela;
- DNS de produção resolveu para a camada Cloudflare, sem exposição do origin;
- não foi realizado login em produção e nenhuma credencial de produção foi usada.

Esses dados comprovam disponibilidade pública e o comportamento do endpoint de
CSRF, mas não comprovam a taxa de sucesso do login. O limite de login previsto
no código é 5 requisições por 60 segundos em produção, salvo sobrescrita por
variável de ambiente no runtime. A confirmação do valor efetivo exige leitura
do ambiente/telemetria do Coolify ou uma credencial sintética explicitamente
destinada à produção; não se deve inferir esse valor a partir do loadtest.

## Causa e escopo

O padrão anterior era compatível com saturação/instabilidade do transporte do
edge público do loadtest, não com falha do endpoint `/health/public` do NestJS.
Depois da correção do edge, as três campanhas concluíram normalmente. Não há
evidência atual de que o mesmo erro exista em produção.

O risco ainda aberto é operacional: um gerador compartilhado pode concentrar
requisições no mesmo identificador de IP/fingerprint do throttler. Por isso,
login deve ser medido em campanha separada, com taxa controlada, e não como
parte de todos os VUs de um teste de throughput geral.

## Degrau de 50 VUs

O primeiro aumento para 50 VUs por 2 minutos foi reprovado de forma válida:
35.151 requisições, aproximadamente 251 req/s, 24,97% de falha e 75,02% de
checks aprovados. O código de resposta foi compatível com o limitador defensivo
do Nginx do loadtest: 200 req/s por IP, burst 400.

Isso não indicou falha da API: a latência p95 permaneceu em aproximadamente
191 ms. Para que esse degrau meça a API sem remover a proteção, o limite do
proxy isolado foi ajustado para 400 req/s, burst 800 e 100 conexões por cliente.
O Nginx foi validado com `nginx -t` na VPS. A próxima execução deve confirmar
que a taxa de 50 VUs fica abaixo do novo teto.

Após o restart controlado do `proxy-loadtest`, a repetição de 50 VUs foi
aprovada: 32.661 requisições, 0% de falha, 100% de checks e p95 aproximado de
293 ms. Os containers permaneceram saudáveis; o maior consumo observado foi
aproximadamente 326 MiB na API, 21 MiB no edge e 5 MiB no proxy. O host ficou
com cerca de 14 GiB disponíveis e 25% do disco utilizado.

O ensaio sustentado seguinte, com 50 VUs por 4 minutos, também foi aprovado:
37.633 requisições, 0% de falha, 100% de checks, p95 aproximado de 193 ms e
máximo aproximado de 750 ms. Ao final, API, PostgreSQL e Redis estavam
saudáveis; os consumos observados foram API 326,6 MiB, edge 20,7 MiB, proxy
4,0 MiB, PostgreSQL 31,5 MiB e Redis 3,8 MiB.

## Degraus de 75 e 100 VUs

O degrau de 75 VUs por 2 minutos foi aprovado: 37.033 requisições, 0% de
falha, 100% de checks, p95 aproximado de 582 ms e máximo aproximado de 1,52 s.
Esse resultado mostra aumento de latência, mas não falha funcional do ambiente.

O degrau seguinte, de 100 VUs por 2 minutos, foi reprovado pelos thresholds:
45.495 requisições, 13,37% de falha, 86,62% de checks aprovados, p95 aproximado
de 823 ms e taxa média aproximada de 325 req/s. A execução foi válida — houve
requisições e iterações — e não deve ser classificada como sucesso.

O padrão é compatível com saturação do envelope defensivo do proxy isolado
(400 req/s, burst 800) durante a rampa e com respostas 429/latência elevada,
mas o resumo do k6 não capturou o status individual dessas falhas. Portanto,
não se afirma que todos os erros foram emitidos pelo Nginx sem uma execução
diagnóstica específica de baixa carga. A carga não foi aumentada além de 100
VUs e o limite do proxy não foi ampliado novamente.

Após o ensaio de 100 VUs, os containers continuaram operacionais: API e
PostgreSQL saudáveis; edge, proxy e Redis em execução. Consumo observado:
API 326,1 MiB (21,23% do limite), edge 27,91 MiB (10,90%), proxy 2,215 MiB
(1,73%), PostgreSQL 31,47 MiB (3,07%) e Redis 3,77 MiB (1,47%).

## Controles de regressão

Os testes `spike`, `stress` e `soak` agora exigem `http_reqs > 0` e
`iterations > 0`, além dos thresholds existentes de checks e falhas HTTP.
Assim, uma execução interrompida sem resumo não pode ser interpretada como
sucesso.

## Próximo passo seguro

O limite operacional demonstrado nesta campanha é 75 VUs aprovado e 100 VUs
reprovado. Não aumentar novamente antes de decidir se o objetivo é medir o
limite do proxy ou a capacidade da API. Para separar as medições, a próxima
ação segura é um diagnóstico de baixa carga que registre apenas códigos HTTP
agregados, sem login adicional nem exposição de segredos. Qualquer novo
degrau deve monitorar HTTP 429/5xx, p95, CPU, memória, PostgreSQL e Redis,
parar no primeiro threshold reprovado e nunca repetir automaticamente após
timeout.
