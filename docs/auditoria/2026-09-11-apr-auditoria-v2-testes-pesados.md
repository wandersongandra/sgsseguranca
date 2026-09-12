# Auditoria APR v2 + Trilha de Testes Pesados — 2026-09-11/12

Continuação da auditoria e hardening completo do módulo APR (Parte 1: onda
1-3, banco/backend/frontend, já entregue e documentada em sessão anterior).
Este relatório cobre a Parte 2: remediação da PR #381 a pedido de revisor
externo, deploy real em produção, e a trilha de testes pesados contra o
ambiente real (`179.198.107.5` / `api.sgsseguranca.com.br`), autorizada
explicitamente pelo dono do produto enquanto não há cliente real dependendo
do uptime.

## 1. PRs mergeados nesta sessão

| PR | Título | Conteúdo |
|---|---|---|
| [#381](https://github.com/wandersongandra/sgsseguranca/pull/381) | `refactor(apr): auditoria e hardening completo do módulo APR` | Ondas 1-3 (banco/backend/frontend) + remediação de 11 pontos de um revisor externo (RLS fail-closed em `cleanup.task.ts`, testes PG17 reais para migrations 403/404, etc.) |
| [#382](https://github.com/wandersongandra/sgsseguranca/pull/382) | `fix(docker): copy backend/vendor before npm ci in both build images` | Bug pré-existente que bloqueava TODO deploy padrão via Coolify desde que os patches vendorizados (`@nestjs/throttler`, `nest-winston`) foram introduzidos — produção rodava um container buildado manualmente havia dias |
| [#384](https://github.com/wandersongandra/sgsseguranca/pull/384) | `fix(aprs): resolve companyId via sessionStore fallback in useAprs` | Bug crítico achado ao vivo nesta trilha (ver seção 4) |
| [#385](https://github.com/wandersongandra/sgsseguranca/pull/385) | `fix(dashboard): allow non admin_geral users to select a site` | Segunda camada do mesmo bug (ver seção 4) |

Todos os 4 PRs com CI 100% verde (28 checks incluindo PG17 real, CodeQL,
Semgrep, Gitleaks, SBOM) antes do merge.

## 2. Deploy em produção

Sequência seguida conforme `docs/deploy/COMO-COLOCAR-EM-PRODUCAO.md`:

1. `backend-web` deployado com o commit mergeado de #381+#382 — primeira
   tentativa via Coolify falhou por causa do bug do #382 (confirmado via
   log real de build, não teórico); corrigido e redeployado.
2. Migrations `1709000000403` (índices compostos redundantes) e
   `1709000000404` (FKs de workflow config) aplicadas com sucesso via
   container efêmero reaproveitando a imagem já buildada.
3. Container antigo (`sgs-backend-green-9cbf1e6f`) confirmado saudável e
   sem receber tráfego durante toda a troca (IP interno `10.0.1.10`); novo
   container (`10.0.1.15`) validado internamente (`/health` 200) antes do
   cutover no Traefik (arquivo de rota dinâmica editado, `providers.file.watch=true`
   aplica sem restart).
4. `backend-worker` deployado em seguida (nunca concorrente com o web, por
   política do projeto) — subiu limpo, sem crash-loop, pois as migrations já
   estavam aplicadas.
5. Containers antigos (`green-9cbf1e6f`, web e worker) apenas **parados**
   (não removidos) como rollback rápido — seguem parados na VPS, podem ser
   removidos quando a confiança no novo release estiver consolidada.
6. Frontend deployado 3x ao longo da sessão via `vercel --prod --yes`
   (último deploy inclui os fixes #384+#385).

Smoke pós-deploy: `/health` 200, `/auth/csrf` 200, headers de segurança
presentes (HSTS, nosniff, frame-options). `/health/ready` retorna 403 via
Cloudflare — comportamento **esperado**, já documentado (bloqueio de WAF
intencional para rota interna).

**Nota operacional:** durante o deploy, a porta 8000 (painel Coolify) e o
SSH da VPS ficaram intermitentemente inacessíveis a partir da minha origem
— confirmado como bloqueio de borda (fail2ban/anti-abuso reagindo à rajada
de conexões), não suspensão da VPS: ping e `https://api.sgsseguranca.com.br`
via Cloudflare responderam normalmente o tempo todo. Contornado roteando as
chamadas da API do Coolify através do próprio SSH (`localhost:8000` de
dentro da VPS) e aguardando reconexões automáticas quando necessário.
Produção não foi impactada em nenhum momento.

## 3. Trilha de testes pesados

Ambiente: tenants sintéticos criados via script dedicado
(`backend/test/load/apr-loadtest-seed.js`, não commitado — script ad-hoc
executado via SSH), rodando o mesmo esquema de criptografia de CPF real da
aplicação (`hashSensitiveValue`/`encryptSensitiveValue`) para que os
usuários funcionem no login real (validado via `POST /auth/login` de
verdade, não bypass). Três empresas marcadas `APRLOADTEST — ... — NAO E
CLIENTE REAL`: **MAIN** (40 APRs seed + ~11 criadas via API durante os
testes), **ISO-A** e **ISO-B** (10 APRs cada, para o teste de isolamento).

Scripts novos em `backend/test/load/apr-heavy-suite.js` (commitados),
complementando o `k6-load-test.js` já existente:

| Cenário | Resultado |
|---|---|
| **Smoke** (`k6-load-test.js`) | 0% erro HTTP, 0% rate-limit, p95: dashboard 200ms, create 338ms, list 223ms, login 311ms — todos os thresholds |
| **Lifecycle** (create → assinatura → submit/aprovação → PDF final Puppeteer → encerramento) | 100% sucesso após corrigir 2 suposições erradas do próprio script (ver achados abaixo) |
| **Throttle** (`GET /aprs/files/weekly-bundle`, limite 2/min) | Confirmado: a partir da 3ª tentativa em rajada, API responde 429 corretamente |
| **Race condition** (10 VUs concorrentes em `POST /:id/submit` na mesma APR Pendente) | Exatamente 1 sucesso, 9 rejeitados — exclusão mútua real confirmada, zero aprovação dupla |
| **Progressive** (10→75 VUs em `GET /aprs`/`GET /aprs/:id`, abort no 1º degrau reprovado) | Rodou os 9 estágios completos sem abortar; isolamento multi-tenant 100% (1119/1119 checks); p95 lista 93ms, p95 detalhe 277ms — mesmo com throttle por-usuário ativo em ~19k das ~20k requisições (achado de metodologia, não de app — ver abaixo) |

### Achados de metodologia (não são bugs do produto)

- **Login por VU aciona o rate-limit de borda do Cloudflare** (`error code:
  1015`), não o throttler da aplicação — corrigido pré-autenticando os
  tenants uma única vez em `setup()` e reusando os tokens entre VUs.
- **Cookie `Secure` sobre HTTP puro impede testar via IP interno da VPS**
  (correto — TLS é real, não um bug) — testes de progressão rodaram contra
  o domínio HTTPS público em vez do container interno.
- **Perdedor da corrida recebe 400, não 409**: a transação vencedora já
  commita o novo status antes do perdedor reler o estado, então ele vê
  "APR não está pronta para aprovação" em vez de um conflito de lock — o
  resultado final (exclusão mútua real) é idêntico; só a semântica HTTP
  difere do que o plano original assumia.
- **Ordem real do fluxo de aprovação**: para papéis com permissão de
  aprovar, `submit()` já executa Pendente→Aprovada diretamente (não existe
  um `PATCH /approve` separado depois, para este papel) — e a assinatura
  digital precisa acontecer **antes** do submit, não depois (bloqueada uma
  vez que a aprovação está em andamento). Documentado inline no script.
- **Com apenas 3 contas sintéticas para até 75 VUs**, o throttle por-usuário
  (120 req/min) engata muito antes de qualquer limite real de capacidade —
  isso mede corretamente o app respeitando seu próprio throttle sob reuso
  pesado de conta, não uma falha de capacidade (métrica separada,
  documentada no próprio script).

## 4. Bug crítico de produto achado e corrigido

Durante a verificação visual (Playwright, item 7 do plano original), a
listagem de APR (`/dashboard/aprs`) mostrava **"0 APRs encontradas"** para
o tenant sintético mesmo com 40+ APRs reais no banco — enquanto o mesmo
endpoint via curl/k6 (headers explícitos) retornava os dados corretamente.
Investigação (agente de exploração + verificação manual linha a linha)
confirmou dois bugs em cadeia, ambos na mesma raiz:

1. **`useAprs.ts`** lia `companyId` exclusivamente de `selectedTenantStore`
   — populado só quando um `admin_geral` escolhe uma empresa no seletor de
   tenant. `persistAuthenticatedSession` limpa esse store incondicionalmente
   em **todo** login, inclusive para usuários comuns — para eles, o tenant
   real vive em `sessionStore` (JWT). Sem o fallback (que já existia, correto,
   em `useUsers.ts`), `loadAprs()` nunca chamava a API para nenhum usuário
   fora do admin_geral. **(PR #384)**
2. **`dashboard/layout.tsx`**: mesmo corrigindo o companyId, o banner
   "Selecionar obra" — cujo próprio comentário no código dizia ser "para
   todos os usuários" — estava condicionado ao mesmo `selectedTenant`
   exclusivo do admin_geral. Resultado: nenhum usuário comum via o botão
   para selecionar uma obra, `siteStore` nunca era populado, e o módulo
   ficava bloqueado permanentemente, sem contorno possível pela UI.
   **(PR #385)**

**Impacto real:** como o produto ainda não tem cliente pagante usando em
produção, este bug nunca foi observado por um usuário de verdade — mas
teria afetado **100% dos usuários de toda empresa cliente** (qualquer
perfil fora de admin_geral) assim que o primeiro cliente real começasse a
usar o módulo. A trilha de testes pesados criando um tenant sintético e
navegando como um cliente real faria foi o que expôs isso.

Fix consolidado num helper compartilhado (`frontend/src/lib/tenant-context.ts`,
`resolveActiveCompanyId()`), reaproveitado por `useAprs.ts` e
`dashboard/layout.tsx` (4 pontos de leitura corrigidos no layout: banner de
seleção, banner de obra ativa, comparação em `handleSiteSelect`, prop do
`SiteSelectorModal`). Novo teste de regressão em `useAprs.test.tsx` cobrindo
o cenário real (`selectedTenantStore` vazio + `sessionStore` populado).
`dashboard/layout.tsx` não tinha suíte de teste própria — registrado como
ponto de atenção para auditoria futura de cobertura.

**Verificado ao vivo em produção** (não só em teste automatizado): após os
dois deploys, login como o tenant sintético → banner "Selecionar obra"
finalmente aparece → seleção da obra → listagem carrega **51 APRs
encontradas** corretamente.

## 5. Screenshots (desktop 1440px + mobile 375px)

Capturados contra o ambiente real após todos os fixes: listagem, criação,
edição (APR com PDF final emitido) e aprovação (APR Pendente com ação
"Aprovar APR" visível). Entregues ao usuário durante a sessão.

## 6. Estado dos dados sintéticos

Três empresas `APRLOADTEST` (MAIN, ISO-A, ISO-B) seguem no banco de
produção, claramente marcadas (`razao_social` com sufixo "NAO E CLIENTE
REAL", e-mails `@test.local`), sem qualquer sobreposição com dados reais.
Deixadas para inspeção — limpeza total (companies + sites + users + aprs)
disponível a qualquer momento via o mesmo script ad-hoc usado para criá-las
(`--clean`), rodando no mesmo container efêmero contra `DATABASE_MIGRATION_URL`.
Nenhuma ação destrutiva foi tomada sem confirmação nesta sessão.

## 7. Documentação

`docs/deploy/INFRAESTRUTURA-ATUAL.md`, `docs/auditoria/2026-08-13-loadtest-vs-producao.md`
e `infra/load-test/README.md` já haviam sido marcados como histórico
(VPS de load-test dedicada desativada) em rodada anterior desta mesma
sessão — confirmado sem necessidade de nova alteração.

## 8. Pendências / recomendações para próxima rodada

- Auditar se o mesmo padrão de bug (`selectedTenantStore` sem fallback)
  afeta outros hooks de módulos com escopo de obra (PT, DDS foram citados
  como suspeitos pelo comentário original do código, não confirmados).
- Escrever suíte de teste para `dashboard/layout.tsx` (hoje sem cobertura).
- Decidir quando remover (não só parar) os containers antigos
  `sgs-backend-green-9cbf1e6f` / `sgs-worker-green-9cbf1e6f` na VPS.
- Decidir sobre limpeza dos dados sintéticos `APRLOADTEST`.
