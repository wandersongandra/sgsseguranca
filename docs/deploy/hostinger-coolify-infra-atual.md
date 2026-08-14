# Infraestrutura atual — Hostinger VPS + Coolify

**Atualizado em:** 2026-07-31
**Substitui:** [`coolify-vultr-backend-web-worker.md`](./coolify-vultr-backend-web-worker.md) (histórico — VPS Vultr/Integrator desativada)

Este é o documento de referência para a infraestrutura de backend em produção. Se algo aqui
divergir do que você observa no Coolify, **confie no Coolify** e atualize este arquivo.

---

## Por que migramos (Integrator → Hostinger)

A VPS anterior (Vultr, provedor "Integrator Host") ficava fisicamente em **Centreville, Virgínia
(EUA)**, apesar de o provedor ser brasileiro. O banco (Neon) e o Redis ficavam em São Paulo — RTT
de ~118ms (banco) e ~205ms (Redis), com login medindo 400–700ms. A VPS Hostinger fica no Brasil:
o health check pelo domínio de produção agora responde em **~0,6s** ponta a ponta.

---

## Topologia atual

| Componente | Onde roda | Observação |
|---|---|---|
| API (Backend WEB) | Hostinger VPS, container Coolify | Porta interna 3001 |
| Worker (BullMQ) | Hostinger VPS, **mesma VPS** da API | Container Coolify separado |
| **Redis** | Hostinger VPS, container `sgs-redis` (self-hosted) | Rede Docker `coolify`, **não é mais Upstash** |
| **ClamAV** | Hostinger VPS, container `clamav` | Rede Docker `coolify`, antivírus de upload |
| Frontend | Vercel | Deploy manual, sem integração git |
| Banco (PostgreSQL) | Neon | `sa-east-1` (São Paulo) — inalterado |
| Storage | Backblaze B2 | inalterado |
| DR Storage | Backblaze B2 (2ª conta) | inalterado |

**Mudança importante:** API, Worker, Redis e ClamAV **compartilham a mesma máquina física** agora,
comunicando-se pela rede Docker interna `coolify` (nomes de container, não IP/porta pública).
Antes, o Redis era Upstash (serviço gerenciado externo); agora é um container local.

---

## VPS Hostinger — Detalhes

- **IP:** `179.198.107.5`
- **Hostname:** `srv1870554`
- **OS:** Ubuntu 24.04.4 LTS
- **Recursos:** 4 vCPU / 15 GB RAM / 193 GB SSD (bem mais folgada que a VPS anterior, que tinha 5,9 GB)
- **SSH:** chave dedicada (gerada nesta migração), `root@179.198.107.5`
- **Docker:** 29.7.0

### Uso de recursos (medido em 2026-07-31, referência)

Com tudo rodando (API + Worker + Redis + ClamAV + Coolify), a VPS usava **~5 GB de 15 GB** —
folga considerável. `sgs-redis` consome poucos MB (Redis é leve para o volume atual); `clamav` é
o container mais pesado (~950 MB, pela base de assinaturas de vírus). Não há necessidade de plano
maior nem de serviços gerenciados de Redis/antivírus enquanto o volume de dados for este.

---

## Coolify (gerenciamento de deploy)

- **URL:** `http://179.198.107.5:8000` (Coolify 4.1.2)
- **Projeto:** `My first project` (UUID: `k4tvj4jbsu1vc7jqggwzvv1f`)
- **Environment:** `production` (UUID: `r2j049cg1r2ocoi4lx57xzuj`)
- **Server (localhost):** UUID `sa80fcnx6zqhdeyypcyge6oc`
- **Source do Git:** repositório público `complianceX/sgsseguranca` — não precisa de deploy key
  nem GitHub App; o Coolify clona direto por HTTPS.

### Apps no Coolify

| App | UUID | Dockerfile | Domínio |
|---|---|---|---|
| backend-web | `s2jgvkq9trtm8c9itahmn7og` | `/Dockerfile` | `https://api.sgsseguranca.com.br` |
| backend-worker | `x3k7efj1x3pcl4ipcuswwmll` | `/Dockerfile.worker` | (sem domínio público — comunica só por fila/Redis) |

- Repo: `complianceX/sgsseguranca`, branch: `main`
- TLS: Let's Encrypt automático via Traefik (`certresolver=letsencrypt`), atrás do Cloudflare
  (proxy laranja) — mesmo esquema da infra anterior.

### Redis (`sgs-redis`) — container standalone, fora do Coolify

Diferente dos apps acima, o Redis **não foi criado pela interface do Coolify** — foi subido
manualmente via `docker run` na mesma rede Docker (`coolify`), por isso **não aparece na tela de
Resources do Coolify**, embora esteja rodando e acessível normalmente pelos apps. Mesmo tratamento
usado para o ClamAV (replicando como já era feito na VPS anterior).

```
docker run -d --name sgs-redis --network coolify --restart unless-stopped \
  -v sgs-redis-data:/data redis:7-alpine \
  redis-server --requirepass '<senha>' --appendonly yes --maxmemory-policy noeviction
```

- **Persistência:** AOF (`appendonly yes`) — sobrevive a restart do container.
- **Política de memória:** `noeviction` — adequada para filas BullMQ (nunca descarta jobs
  silenciosamente; se a memória faltar, prefere erro explícito a perda de dado).
- **Rede:** só acessível dentro da rede Docker `coolify` (não exposto publicamente).
- **Senha:** guardada nas env vars `REDIS_PASSWORD` dos apps web/worker.

Se quiser esses containers visíveis na tela do Coolify (organização/cosmético, não afeta
funcionamento), é possível registrá-los como "Resources" depois — não é uma ação de risco, mas
não foi feita nesta migração por não ser prioritária.

### Variável nova: `REDIS_ALLOW_INSECURE_INTERNAL`

O código exige TLS para Redis remoto em produção. Como o Redis agora roda na mesma VPS (tráfego
nunca sai da máquina), essa exigência foi dispensada via opt-in explícito:

```
REDIS_ALLOW_INSECURE_INTERNAL=true
```

Isso é seguro **apenas** porque o Redis está na mesma rede Docker interna do host. Se um dia o
Redis voltar a ser remoto (outro serviço, outra VPS), **essa flag deve ser removida** e a conexão
deve usar `rediss://` de verdade. Ver `backend/src/shared/redis/redis-connection.util.ts`.

### Como disparar deploy

Ver o passo a passo completo (com o aviso crítico sobre não sobrepor deploys) em
[`COMO-COLOCAR-EM-PRODUCAO.md`](./COMO-COLOCAR-EM-PRODUCAO.md#2-backend-web-e-worker-coolify).

---

## Frontend (Vercel)

Inalterado — deploy manual, `cd frontend && vercel --prod --yes`. Não depende da VPS.

---

## Banco de Dados (Neon PostgreSQL)

Inalterado pela migração de VPS — `sa-east-1` (São Paulo), endpoint direto (sem `-pooler`) em
`DATABASE_URL`, pooler apenas em `DATABASE_MIGRATION_URL`. Roles: `sgs_app` (runtime, sem
BYPASSRLS), `neondb_owner` (migrations/DDL). Ver `docs/consulta-rapida/*` para detalhes de RLS.

---

## Redis — mudança de arquitetura (Upstash → self-hosted)

**Antes:** Upstash (gerenciado, São Paulo), 3 conexões lógicas (`REDIS_AUTH_URL`,
`REDIS_CACHE_URL`, `REDIS_QUEUE_URL`) apontando para o mesmo endpoint Upstash com TLS.

**Agora:** container `sgs-redis` na própria VPS. As mesmas 3 variáveis lógicas continuam
existindo (o código não mudou), mas todas apontam para `redis://default:<senha>@sgs-redis:6379`
(plaintext, seguro por estar confinado à rede Docker interna) em vez do endpoint Upstash com TLS.

**Motivo da mudança:** durante a migração, o Redis remoto (Upstash) atravessando a internet exigia
TLS pelo código (regra de segurança correta), mas o endpoint específico usado não suportava TLS
na porta configurada. Em vez de reconfigurar um Redis gerenciado com TLS, optou-se por hospedar o
Redis na própria VPS — mais rápido (latência ~0), mais barato, e o código foi ajustado (não
enfraquecido) para permitir esse cenário especificamente via opt-in explícito.

---

## Infra antiga (desativada)

- VPS Vultr `216.238.99.177` — API antes da migração de 2026-07-23. **Não usar.**
- VPS Vultr `216.238.127.254` — Worker antes da migração. **Não usar.**
- **VPS Integrator `216.22.43.246`** — API+Worker, Coolify UUIDs `zdz9pgctj4k0gpds0sj2az6s`
  (web) e `jos9vyejobbagk1yejqlsfhd` (worker). Foi a infra de produção até 2026-07-31. Os
  containers de app já saíram do ar; a VPS em si segue de pé (não desligada), como fallback
  temporário. Desligar definitivamente só depois de um período de estabilidade confirmada na
  Hostinger.
- Redis Upstash (o antigo, remoto) — pode ser desativado após confirmar que nenhuma env var em
  nenhum ambiente ainda aponta para ele.

---

## Firewall e hardening (aplicado em 2026-07-31)

### ufw

Estava **inativo** por padrão na VPS nova (nenhuma proteção de rede, qualquer porta escutando em
`0.0.0.0` era alcançável da internet). Configurado com política restritiva:

```text
Default: deny (incoming), allow (outgoing), deny (routed)

22/tcp   LIMIT IN   # SSH — rate-limited (ufw derruba IP com 6+ tentativas em 30s)
80/tcp   ALLOW IN   # HTTP (Traefik → redirect HTTPS)
443/tcp  ALLOW IN   # HTTPS (Traefik → backend-web)
8000/tcp ALLOW IN   # Painel Coolify
6001/tcp ALLOW IN   # Coolify realtime (websocket do painel)
6002/tcp ALLOW IN   # Coolify realtime
```

Regras espelhadas em IPv6. Validado com conexão SSH **nova** (não a sessão que configurou) e
`curl` real em `https://api.sgsseguranca.com.br/health` antes e depois do `ufw enable`.

**Ressalva importante — Docker ignora o ufw por padrão.** O Docker manipula o `iptables`
diretamente (cadeia `DOCKER`/`DOCKER-USER`), inserindo regras que podem furar o filtro do ufw
para qualquer porta publicada por container com `-p host:container`. Hoje isso não é um problema
porque **nenhum container sensível está publicado no host** — `sgs-redis` (6379), `clamav`
(3310/7357), `backend-web` (3001) e `backend-worker` (3002) só são alcançáveis pela rede Docker
interna `coolify`, nunca por `0.0.0.0`. As únicas portas publicadas no host são as que o ufw já
libera de propósito (80/443 via `coolify-proxy`, 8000/6001/6002 via `coolify`).
**Se no futuro algum `docker run -p` publicar uma porta nova no host, ela pode escapar do ufw** —
revisar `docker ps --format '{{.Names}} | {{.Ports}}'` regularmente.

**Tentativa de restringir 80/443 aos IPs da Cloudflare via `ufw-docker` — CAUSOU INDISPONIBILIDADE
REAL, revertida (2026-08-01).** Motivação: `getRequestIp()` (`backend/src/shared/utils/request-ip.util.ts`)
usa só `request.ip` (via `trust proxy=1` do Express) e deliberadamente ignora headers como
`CF-Connecting-IP`/`X-Forwarded-For` por serem forjáveis por quem conectar direto na origem — então
hoje o IP logado em `login_failed` (e usado por brute-force/throttling/fail2ban) é o **IP de borda da
Cloudflare**, não o do visitante real. Só seria seguro confiar em `CF-Connecting-IP` se a origem só
aceitasse conexão vinda da própria Cloudflare — daí a tentativa de travar `80/443` no ufw aos ranges
oficiais da Cloudflare via `ufw-docker` (necessário porque `docker run -p` fura o ufw puro, ver acima).

O que aconteceu: `ufw-docker install` + `systemctl restart ufw` cria a chain `ufw-user-forward` e
reordena o processamento de `DOCKER-USER` — e por algum motivo não totalmente diagnosticado (a
hipótese mais provável é a cadeia `FORWARD` do ufw, política `DROP`, passar a interceptar o tráfego
Docker-encaminhado antes de alcançar o veredito `ACCEPT` da própria chain `DOCKER`, já que nunca
foram adicionadas regras `ufw route allow` — só `ufw allow` comum, que afeta a chain `INPUT`, não
`FORWARD`), tanto acesso direto por IP quanto o próprio proxy da Cloudflare (`522` no
`api.sgsseguranca.com.br`) pararam de alcançar a origem. Revertido em poucos minutos: `iptables -F
DOCKER-USER` (+ `ufw6`) restaurou o estado anterior (chain vazia, igual a antes da instalação);
`/etc/ufw/after.rules`/`after6.rules` restaurados dos backups que o próprio `ufw-docker install`
criou (`/etc/ufw/after.rules-ufw-docker~<timestamp>~`); binário `/usr/local/bin/ufw-docker` removido.
Produção confirmada saudável (`/health` 200, frontend 200, SSH com conexão nova) minutos depois.

**Estado atual: NÃO restringido.** As 21 regras `ufw allow from <cidr-cloudflare> to any port
80,443` continuam no `ufw status` (linhas 5-19 e 24-30 aproximadamente) — são **inofensivas mas sem
efeito nenhum** (mesma limitação de sempre: `docker run -p` fura o ufw puro). `getRequestIp()`
continua como estava, sem confiar em `CF-Connecting-IP`. O jail `sgs-login` do fail2ban funciona
tecnicamente (filtro casa, IP é extraído corretamente do log), mas bane o IP de borda da Cloudflare
compartilhado, não o atacante real — reforço fraco na prática, não perigoso.

**Se for retentar no futuro:** investigar com `iptables -v -L FORWARD` durante o teste (contadores de
pacote por regra, pra ver exatamente onde o tráfego está sendo dropado) antes de reverter às cegas;
considerar alternativa mais segura de testar — restringir no nível do **Traefik** (middleware de IP
allowlist, `ipwhitelist`/`ipAllowList`) em vez de iptables direto, já que isso roda dentro do próprio
pipeline de request do Traefik e não arrisca derrubar o FORWARD chain do host inteiro.

### fail2ban

Instalado e configurado (`/etc/fail2ban/jail.local`): jail `sshd` ativo, `maxretry=5` em
`findtime=10m`, `bantime=1h`. Complementa o rate-limit do ufw com banimento mais duradouro após
tentativas de força bruta.

**Jail `sgs-login` (adicionado em 2026-08-01)** — reforço de rede para tentativas de login na API,
complementando o rate-limit/bloqueio por IP+CPF que já existe na camada de aplicação (Redis,
`BruteForceService`). Bane no iptables (portas 80/443 apenas) o IP que acumular `maxretry=8`
eventos `login_failed` em `findtime=10m`; `bantime=1h`.

Como funciona:

- O backend (`auth.controller.ts`) loga `{"event":"login_failed","ip":"<ip>",...}` em JSON por
  linha no stdout do container a cada tentativa de login recusada.
- O nome do container `backend-web` muda a cada deploy (sufixo numérico), então um serviço próprio
  (`sgs-log-shipper.service`, `/usr/local/bin/sgs-tail-backend-web.sh`) resolve o container atual
  pelo prefixo estável do UUID da app no Coolify (`s2jgvkq9trtm8c9itahmn7og`) e encaminha
  `docker logs -f` continuamente para um arquivo fixo (`/var/log/sgs-backend-web.log`). O
  `systemd` (`Restart=always`) reconecta automaticamente ao container novo sempre que um deploy
  substitui o antigo — não precisa de intervenção manual.
- `fail2ban` lê esse arquivo fixo via o filtro `/etc/fail2ban/filter.d/sgs-login.conf`
  (`failregex = "event":"login_failed".*"ip":"<HOST>"`), jail em `/etc/fail2ban/jail.d/sgs-login.conf`.
- `logrotate` (`/etc/logrotate.d/sgs-backend-web`, `copytruncate`) evita crescimento ilimitado do
  arquivo.

**Depende do deploy do commit que adiciona o campo `ip` ao log `login_failed`** — antes desse
deploy, o jail fica ativo mas sem eventos para casar (log sem o campo `ip`, filtro não bane
nada). Validado com `fail2ban-regex` contra uma linha sintética (1/1 casou, IP extraído
corretamente); não foi testado contra tráfego real ainda.

Verificar depois do próximo deploy:

```bash
systemctl status sgs-log-shipper.service   # deve estar active, apontando pro container atual
tail -f /var/log/sgs-backend-web.log       # deve mostrar login_failed com ip preenchido
fail2ban-client status sgs-login           # Currently failed / Total banned devem reagir a tentativas reais
```

---

## Pendências conhecidas

- **Registrar Redis/ClamAV como Resources no Coolify** — cosmético, não bloqueia operação.
- **Desligar a VPS Integrator** — só depois de confirmar estabilidade da Hostinger por alguns dias.
- **`TENANT_BACKUP_ENCRYPTION_KEY`** — mesma pendência já registrada desde a migração Vultr→Integrator:
  se a chave antiga (era da Vultr) não foi recuperada, backups daquela era são irrecuperáveis com
  a chave atual.

## Lição operacional da migração (2026-07-31)

Redeploys disparados em sequência rápida (sem esperar o anterior terminar) fazem o Coolify
**cancelar o build em andamento** (BuildKit: `context canceled`) e remover o container que estava
rodando, sem subir um novo no lugar — a aplicação fica fora do ar até o próximo deploy bem-sucedido.
Isso não é falta de recurso da VPS (CPU/RAM/disco estavam folgados); é concorrência entre chamadas
de deploy para o mesmo app. **Sempre aguarde `status == finished` (ou `failed`) antes do próximo
deploy**, inclusive entre Web e Worker — um de cada vez. Ver aviso reforçado em
[`COMO-COLOCAR-EM-PRODUCAO.md`](./COMO-COLOCAR-EM-PRODUCAO.md).
