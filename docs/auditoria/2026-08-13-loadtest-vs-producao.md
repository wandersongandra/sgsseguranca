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

## Controles de regressão

Os testes `spike`, `stress` e `soak` agora exigem `http_reqs > 0` e
`iterations > 0`, além dos thresholds existentes de checks e falhas HTTP.
Assim, uma execução interrompida sem resumo não pode ser interpretada como
sucesso.

## Próximo passo seguro

Após a PR estar verde, aumentar somente a carga sintética do loadtest em degraus
controlados, monitorando HTTP 429/5xx, p95, CPU, memória, PostgreSQL e Redis.
Parar no primeiro threshold reprovado e não repetir automaticamente após
timeout.
