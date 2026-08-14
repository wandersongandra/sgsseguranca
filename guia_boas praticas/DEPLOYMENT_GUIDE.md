# Guia de Deploy Seguro — SGS

## 1. Objetivo

Este documento estabelece o procedimento recomendado para publicar, atualizar, monitorar e recuperar o SGS em ambiente de produção.

O processo considera a seguinte arquitetura:

| Componente                | Hospedagem                  |
| ------------------------- | --------------------------- |
| Frontend                  | Vercel                      |
| Backend Web/API           | VPS gerenciada pelo Coolify |
| Backend Worker            | VPS gerenciada pelo Coolify |
| Banco de dados            | Neon PostgreSQL             |
| Cache e filas             | Redis gerenciado            |
| Armazenamento de arquivos | Backblaze B2                |
| Proxy reverso e HTTPS     | Coolify                     |
| Repositório               | GitHub                      |

Os nomes de serviços, scripts e variáveis apresentados neste guia devem ser ajustados aos nomes existentes no repositório do SGS.

---

# 2. Princípios de segurança

O deploy de produção deve seguir os seguintes princípios:

* Nenhum segredo deve ser armazenado no GitHub.
* Nenhum arquivo `.env` de produção deve ser commitado.
* Banco de dados, Redis e storage não devem ficar publicamente expostos.
* Migrações devem ser executadas de forma controlada.
* O backend web e o worker devem ser publicados como serviços separados.
* Todo deploy deve possuir health check.
* Todo deploy deve permitir rollback da aplicação.
* Backups devem ser testados periodicamente.
* Logs não devem registrar senhas, tokens, CPF, dados médicos ou outros dados sensíveis.
* Alterações críticas devem ser aplicadas primeiro em ambiente de homologação.

---

# 3. Pré-requisitos

Antes do primeiro deploy, confirme:

* O domínio está configurado.
* O DNS aponta para o serviço correto.
* O repositório está privado.
* O Coolify possui acesso ao repositório.
* A VPS está atualizada.
* As portas públicas necessárias estão controladas pelo firewall.
* O projeto possui Dockerfile de produção.
* O backend possui endpoint de health check.
* As migrations foram testadas em um banco vazio.
* O Neon possui rotina de backup ou recuperação habilitada.
* O Backblaze B2 possui bucket privado.
* O Redis exige autenticação e conexão criptografada quando suportada.
* Os ambientes de produção e homologação estão separados.

---

# 4. Arquitetura recomendada no Coolify

O SGS deve ser publicado em pelo menos dois serviços independentes.

## 4.1 Backend Web

Responsável por:

* API HTTP;
* autenticação;
* processamento de requisições;
* emissão de relatórios;
* comunicação com o frontend;
* endpoints de health check.

Exemplo de comando de inicialização:

```bash
npm run start:prod
```

## 4.2 Backend Worker

Responsável por:

* filas BullMQ;
* envio de notificações;
* processamento de arquivos;
* geração assíncrona de documentos;
* tarefas agendadas;
* rotinas demoradas.

Exemplo de comando de inicialização:

```bash
npm run start:worker:prod
```

O worker não deve possuir domínio público, salvo quando existir uma necessidade técnica documentada.

## 4.3 Migrações

As migrações não devem ser executadas automaticamente por todas as réplicas.

Deve existir apenas um processo autorizado para executar:

```bash
npm run migration:run
```

Isso pode ser realizado:

* manualmente durante o deploy;
* por um job exclusivo;
* por uma etapa controlada do pipeline;
* por um comando executado uma única vez no serviço web.

---

# 5. Variáveis de ambiente

As variáveis de produção devem ser cadastradas diretamente no painel do Coolify e da Vercel.

Não utilize o arquivo `.env` local como fonte definitiva de produção.

## 5.1 Ambiente da aplicação

```env
NODE_ENV=production
APP_ENV=production

APP_NAME=SGS
APP_URL=https://api.seudominio.com
FRONTEND_URL=https://app.seudominio.com

PORT=3001
TRUST_PROXY=true
```

## 5.2 Banco de dados Neon

```env
DATABASE_URL=postgresql://usuario:senha@host.neon.tech/banco?sslmode=require
```

Recomendações:

* utilize um usuário exclusivo para a aplicação;
* não utilize a conta proprietária do banco no runtime;
* mantenha SSL obrigatório;
* limite privilégios do usuário;
* valide o Row Level Security;
* utilize pool de conexão compatível com o Neon;
* não exponha a URL do banco no frontend.

## 5.3 Redis gerenciado

```env
REDIS_URL=rediss://usuario:senha@host:porta
```

Recomendações:

* prefira `rediss://` quando disponível;
* utilize credencial exclusiva para produção;
* limite conexões;
* configure timeout e reconexão;
* não exponha o Redis diretamente à internet;
* defina TTL para sessões e caches;
* monitore crescimento das filas.

## 5.4 Autenticação e criptografia

```env
JWT_SECRET=<segredo-longo-e-aleatorio>
JWT_REFRESH_SECRET=<segredo-diferente>
ENCRYPTION_KEY=<chave-de-criptografia>
ENCRYPTION_SALT=<salt-aleatorio>
CSRF_SECRET=<segredo-aleatorio>
COOKIE_SECRET=<segredo-aleatorio>
```

Cada variável deve possuir um valor diferente.

Exemplo para geração de segredo:

```bash
openssl rand -base64 64
```

Para chave hexadecimal:

```bash
openssl rand -hex 32
```

Nunca copie a mesma chave para finalidades diferentes.

## 5.5 Backblaze B2

```env
S3_ENDPOINT=https://s3.<regiao>.backblazeb2.com
S3_REGION=<regiao>
S3_BUCKET=<nome-do-bucket>
S3_ACCESS_KEY_ID=<application-key-id>
S3_SECRET_ACCESS_KEY=<application-key>
S3_FORCE_PATH_STYLE=false
```

Recomendações:

* mantenha o bucket privado;
* crie uma Application Key específica para o SGS;
* conceda acesso apenas ao bucket necessário;
* não utilize a chave principal da conta;
* configure URLs assinadas para downloads;
* defina validade curta para URLs temporárias;
* ative regras de ciclo de vida quando aplicável;
* bloqueie listagem pública de arquivos.

## 5.6 Segurança administrativa

```env
ENFORCE_2FA_SETUP=true
REQUIRE_ADMIN_MFA=true
DISABLE_DEFAULT_ADMIN=true
```

A aplicação deve bloquear ou limitar operações administrativas enquanto o segundo fator não estiver configurado.

## 5.7 Monitoramento

```env
SENTRY_DSN=<dsn>
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.1
```

O monitoramento deve aplicar mascaramento de dados pessoais antes do envio.

---

# 6. Proteção da VPS

## 6.1 Atualização do sistema

```bash
sudo apt update
sudo apt upgrade -y
```

Reinicie a VPS quando houver atualização de kernel:

```bash
sudo reboot
```

## 6.2 Firewall

Quando o Coolify utiliza proxy reverso, normalmente devem permanecer públicas apenas:

* porta 80 para HTTP;
* porta 443 para HTTPS;
* porta SSH restrita para administração.

Exemplo:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow from SEU_IP_ADMINISTRATIVO to any port 22 proto tcp

sudo ufw enable
sudo ufw status verbose
```

Não exponha publicamente:

* PostgreSQL;
* Redis;
* porta interna da API;
* porta do worker;
* painel interno de métricas;
* serviços administrativos do Coolify.

Antes de restringir a porta SSH, confirme que o IP administrativo é fixo ou que existe outra forma segura de acesso.

## 6.3 SSH

Recomendações:

* utilizar chave SSH;
* desativar autenticação por senha;
* bloquear login direto de root;
* utilizar usuário administrativo com `sudo`;
* habilitar Fail2ban;
* registrar tentativas de acesso.

Exemplo de configurações em `/etc/ssh/sshd_config`:

```text
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

Após alterar:

```bash
sudo sshd -t
sudo systemctl restart ssh
```

Não encerre a sessão atual antes de testar uma nova conexão SSH.

---

# 7. Configuração no Coolify

## 7.1 Conectar o repositório

No Coolify:

1. Adicione a integração com o GitHub.
2. Selecione o repositório do SGS.
3. Escolha a branch de produção.
4. Defina o diretório correto do backend.
5. Configure o Dockerfile.
6. Cadastre as variáveis de ambiente.
7. Configure o domínio da API.
8. Habilite HTTPS automático.
9. Configure o health check.
10. Desative exposição pública de portas internas.

## 7.2 Health check

Endpoint recomendado:

```http
GET /health
```

Resposta esperada:

```json
{
  "status": "ok"
}
```

O health check básico não deve retornar:

* credenciais;
* nomes de tabelas;
* endereços internos;
* detalhes de exceções;
* versões sensíveis;
* dados pessoais.

O Coolify pode utilizar:

```text
/health
```

Porta interna:

```text
3001
```

Intervalo sugerido:

```text
30 segundos
```

Timeout sugerido:

```text
10 segundos
```

## 7.3 Health check aprofundado

Pode existir um endpoint interno separado:

```http
GET /health/ready
```

Esse endpoint pode validar:

* conexão com PostgreSQL;
* conexão com Redis;
* disponibilidade do storage;
* capacidade de processamento das filas.

O endpoint aprofundado deve ser protegido ou acessível apenas internamente.

---

# 8. Primeiro deploy

## 8.1 Validar o projeto localmente

Antes da publicação:

```bash
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
```

Caso existam testes de integração:

```bash
npm run test:e2e
```

O deploy não deve prosseguir quando houver:

* erro de compilação;
* erro de TypeScript;
* migration quebrada;
* teste crítico falhando;
* dependência crítica vulnerável sem avaliação;
* variável obrigatória ausente.

## 8.2 Criar serviços

Crie no Coolify:

* `sgs-backend-web`;
* `sgs-backend-worker`.

Ambos podem utilizar a mesma imagem, mas comandos de inicialização diferentes.

## 8.3 Executar migrações

Após o backend estar configurado e antes de liberar o tráfego:

```bash
npm run migration:run
```

Verifique o resultado:

```bash
npm run migration:show
```

Não marque migrations como executadas manualmente sem confirmar que as alterações realmente existem no banco.

## 8.4 Criar o primeiro administrador

Utilize um seed controlado:

```bash
npm run seed:admin
```

O seed deve:

* exigir e-mail explícito;
* gerar senha temporária;
* obrigar troca de senha;
* exigir MFA;
* ser idempotente;
* não criar credenciais padrão.

Não utilize combinações como:

```text
admin@admin.com
admin123
```

## 8.5 Validar a aplicação

```bash
curl -i https://api.seudominio.com/health
```

Resposta esperada:

```text
HTTP/2 200
```

Valide também:

* login;
* refresh token;
* logout;
* recuperação de senha;
* isolamento entre empresas;
* upload e download de arquivos;
* processamento de filas;
* envio de notificações;
* logs de auditoria;
* permissões administrativas.

---

# 9. Deploy do frontend na Vercel

Cadastre na Vercel apenas variáveis permitidas para o frontend.

Exemplo:

```env
NEXT_PUBLIC_API_URL=https://api.seudominio.com
NEXT_PUBLIC_APP_ENV=production
```

Nunca cadastre como `NEXT_PUBLIC_`:

* `DATABASE_URL`;
* `REDIS_URL`;
* `JWT_SECRET`;
* chaves do Backblaze;
* tokens de provedores;
* chaves privadas;
* credenciais de monitoramento com permissão administrativa.

Após o deploy, valide:

```bash
curl -I https://app.seudominio.com
```

Confirme:

* HTTPS;
* redirecionamentos;
* comunicação com a API;
* CORS;
* Content Security Policy;
* cookies seguros;
* ausência de secrets no bundle.

---

# 10. Atualização de produção

## 10.1 Antes da atualização

Execute:

```bash
git status
git pull origin main
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
```

Revise:

* migrations novas;
* alterações de variáveis;
* mudanças no Redis;
* alterações em filas;
* compatibilidade entre frontend e backend;
* alterações de contratos da API;
* mudanças em storage.

## 10.2 Compatibilidade das migrations

Migrações de produção devem ser preferencialmente retrocompatíveis.

Evite realizar em uma única versão:

1. remoção imediata de coluna;
2. publicação de código que ainda depende da coluna;
3. alteração irreversível de dados;
4. renomeação direta sem fase de transição.

Fluxo mais seguro:

1. criar a nova estrutura;
2. publicar código compatível com a estrutura antiga e nova;
3. migrar os dados;
4. validar;
5. remover a estrutura antiga em uma versão posterior.

## 10.3 Publicação

No Coolify:

1. confirme o commit que será publicado;
2. execute o deploy do backend web;
3. execute as migrations uma única vez;
4. execute o deploy do worker;
5. publique o frontend;
6. monitore logs e métricas;
7. execute testes rápidos de produção.

## 10.4 Verificação pós-deploy

```bash
curl -i https://api.seudominio.com/health
curl -I https://app.seudominio.com
```

Verifique:

* erros HTTP 500;
* aumento de latência;
* falhas de autenticação;
* filas paradas;
* conexões excessivas no banco;
* uso elevado de memória;
* falhas de upload;
* erros no Sentry;
* falhas de migration.

---

# 11. Rollback

## 11.1 Rollback da aplicação

Utilize no Coolify uma imagem ou deployment anterior conhecido como estável.

Após o rollback:

```bash
curl -i https://api.seudominio.com/health
```

Valide login, banco, Redis, filas e storage.

## 11.2 Rollback de banco de dados

Não execute rollback automático de migration sem avaliar:

* perda de dados;
* alterações destrutivas;
* dependências de versões posteriores;
* incompatibilidade com o código atual.

Migrations destrutivas podem exigir restauração de backup.

Por isso, o rollback da aplicação deve ser planejado para funcionar com migrations retrocompatíveis.

## 11.3 Critérios para rollback

Considere rollback quando houver:

* indisponibilidade recorrente;
* falha de autenticação;
* erro crítico em operações principais;
* quebra de isolamento multiempresa;
* corrupção de dados;
* falha generalizada de filas;
* aumento severo de erros;
* regressão de segurança.

---

# 12. Backup e recuperação

## 12.1 Banco Neon

O plano de backup deve considerar:

* recursos nativos de recuperação do Neon;
* retenção disponível no plano contratado;
* exportações periódicas independentes;
* teste de restauração;
* armazenamento criptografado;
* restrição de acesso.

Backup manual:

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="sgs_$(date +%Y%m%d_%H%M%S).dump"
```

Não envie o arquivo para um bucket público.

## 12.2 Restauração de teste

A restauração deve ser testada em banco separado:

```bash
pg_restore \
  --dbname="$DATABASE_RESTORE_URL" \
  --no-owner \
  --no-privileges \
  arquivo.dump
```

Nunca teste restauração diretamente no banco principal.

## 12.3 Backblaze B2

Verifique periodicamente:

* existência dos objetos;
* criptografia em trânsito;
* permissões da Application Key;
* regras de retenção;
* versões antigas;
* exclusões acidentais;
* possibilidade de recuperação;
* integridade dos arquivos.

## 12.4 Redis

O Redis não deve ser tratado como única fonte permanente de dados.

Filas críticas devem possuir:

* tentativas de reprocessamento;
* dead-letter queue quando aplicável;
* idempotência;
* persistência adequada;
* monitoramento de jobs falhos;
* procedimento de recuperação.

---

# 13. Monitoramento

## 13.1 Métricas da VPS

```bash
docker stats
df -h
free -h
uptime
```

Monitore:

* CPU;
* memória;
* armazenamento;
* carga do sistema;
* reinicializações;
* quantidade de containers;
* tráfego de rede.

## 13.2 Logs

No Coolify, acompanhe separadamente:

* backend web;
* worker;
* proxy;
* build;
* deploy;
* health checks.

Os logs devem possuir:

* timestamp;
* nível;
* identificador de requisição;
* tenant ID pseudonimizado;
* usuário pseudonimizado quando necessário;
* contexto técnico suficiente.

Os logs não devem conter:

* senha;
* token completo;
* cookie;
* CPF completo;
* dados de saúde;
* documentos;
* chaves de API;
* conteúdo integral de uploads.

## 13.3 Alertas mínimos

Configure alertas para:

* API indisponível;
* worker indisponível;
* excesso de erros HTTP 500;
* fila acumulada;
* falta de espaço;
* uso elevado de memória;
* falha de backup;
* falha de migration;
* aumento de tentativas de login;
* erro de comunicação com banco;
* erro de comunicação com Redis;
* falha de storage.

---

# 14. Verificações de segurança

## 14.1 Headers HTTP

```bash
curl -I https://app.seudominio.com
curl -I https://api.seudominio.com
```

Verifique a presença, conforme aplicável, de:

```text
Strict-Transport-Security
Content-Security-Policy
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
```

`X-Frame-Options` pode ser utilizado, mas aplicações modernas devem priorizar a diretiva `frame-ancestors` da Content Security Policy.

## 14.2 Cookies

Cookies de autenticação devem utilizar:

```text
HttpOnly
Secure
SameSite
```

O domínio, path e tempo de expiração devem ser restritos ao necessário.

## 14.3 CORS

A API deve permitir apenas origens conhecidas:

```text
https://app.seudominio.com
```

Não utilize em produção:

```text
Access-Control-Allow-Origin: *
```

principalmente quando houver cookies ou credenciais.

## 14.4 Rate limiting

O teste de rate limiting deve utilizar um ambiente autorizado e uma quantidade controlada de requisições.

Exemplo:

```bash
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    https://api.seudominio.com/auth/login
done
```

Não realize testes pesados de carga diretamente em produção sem planejamento, limite, janela autorizada e monitoramento.

---

# 15. Resposta a incidentes

## 15.1 Primeiras ações

Em caso de incidente:

1. registre o horário da detecção;
2. identifique os serviços afetados;
3. restrinja acessos comprometidos;
4. revogue tokens e credenciais expostas;
5. preserve logs e evidências;
6. avalie o impacto nos tenants;
7. acione os responsáveis;
8. documente todas as decisões;
9. contenha o incidente com o menor impacto possível;
10. inicie o processo de recuperação.

Não desligue toda a infraestrutura automaticamente sem avaliar o impacto e a preservação das evidências.

## 15.2 Preservação de evidências

Exporte logs sem alterá-los:

```bash
docker logs NOME_DO_CONTAINER \
  > "incident_$(date +%Y%m%d_%H%M%S).log" 2>&1
```

Registre:

* hash dos arquivos;
* horário;
* responsável pela coleta;
* origem;
* serviço;
* período abrangido.

Exemplo:

```bash
sha256sum incident_*.log
```

## 15.3 Rotação de credenciais

Em caso de exposição, altere:

* chaves JWT;
* credenciais administrativas;
* senha ou usuário do banco;
* credenciais Redis;
* Application Keys do Backblaze;
* tokens do GitHub;
* credenciais do Coolify;
* chaves de serviços externos.

Considere que a troca de chaves JWT pode encerrar todas as sessões ativas.

## 15.4 Comunicação

A comunicação deve seguir:

* contrato com o Cliente;
* Política de Privacidade;
* plano de resposta a incidentes;
* papel da SGS como controladora ou operadora;
* avaliação jurídica e regulatória aplicável.

---

# 16. Troubleshooting

## 16.1 Backend não inicia

Verifique:

```bash
docker logs NOME_DO_CONTAINER --tail 200
```

Confirme:

* variáveis obrigatórias;
* acesso ao Neon;
* conexão com Redis;
* comando de inicialização;
* porta interna;
* migration pendente;
* limite de memória;
* permissões de arquivos.

Não utilize comandos que imprimam secrets completos no terminal ou nos logs.

## 16.2 Falha de conexão com Neon

Teste utilizando uma ferramenta segura:

```bash
psql "$DATABASE_URL" -c "SELECT 1;"
```

Verifique:

* credencial;
* hostname;
* SSL;
* pool de conexão;
* limite de conexões;
* projeto ou branch do Neon;
* regras de acesso.

## 16.3 Falha de conexão com Redis

Utilize a URL configurada:

```bash
redis-cli -u "$REDIS_URL" ping
```

Resposta esperada:

```text
PONG
```

## 16.4 Worker não processa jobs

Verifique:

* conexão com Redis;
* prefixo das filas;
* nome das filas;
* concorrência;
* jobs atrasados;
* jobs falhos;
* dead-letter queue;
* logs do worker;
* variáveis diferentes entre web e worker.

## 16.5 Upload não funciona

Verifique:

* endpoint do Backblaze;
* região;
* bucket;
* Application Key;
* permissões;
* limite de tamanho;
* Content-Type;
* CORS do bucket;
* validade da URL assinada.

## 16.6 Certificado HTTPS

Como o HTTPS é gerenciado pelo Coolify, verifique:

* DNS do domínio;
* proxy habilitado;
* domínio cadastrado corretamente;
* portas 80 e 443;
* emissão do certificado;
* logs do proxy;
* existência de outro serviço utilizando o mesmo domínio.

Não é necessário instalar manualmente Nginx ou Certbot quando o Coolify já gerencia proxy e certificados.

---

# 17. Checklist de liberação

## Infraestrutura

* [ ] VPS atualizada.
* [ ] Firewall configurado.
* [ ] SSH protegido.
* [ ] Portas internas não expostas.
* [ ] HTTPS ativo.
* [ ] Domínio validado.

## Aplicação

* [ ] Build concluído.
* [ ] TypeScript sem erros.
* [ ] Lint sem erros críticos.
* [ ] Testes executados.
* [ ] Migrations validadas.
* [ ] Health check funcionando.
* [ ] Worker processando filas.
* [ ] Logs sem dados sensíveis.

## Dados

* [ ] RLS validado.
* [ ] Usuário do banco com privilégio mínimo.
* [ ] Backup configurado.
* [ ] Restauração testada.
* [ ] Bucket privado.
* [ ] Redis protegido.
* [ ] Retenção documentada.

## Segurança

* [ ] MFA administrativo obrigatório.
* [ ] Secrets diferentes por finalidade.
* [ ] Cookies seguros.
* [ ] CORS restrito.
* [ ] Rate limiting ativo.
* [ ] Headers de segurança configurados.
* [ ] Alertas ativos.
* [ ] Plano de incidente documentado.

## Operação

* [ ] Responsável pelo deploy definido.
* [ ] Responsável por rollback definido.
* [ ] Contatos de emergência atualizados.
* [ ] Procedimento de comunicação definido.
* [ ] Ambiente de homologação validado.
* [ ] Versão publicada registrada.

---

# 18. Práticas proibidas

Não realizar em produção:

* commit de arquivos `.env`;
* uso de credenciais padrão;
* exposição pública do PostgreSQL;
* exposição pública do Redis;
* compartilhamento de contas administrativas;
* execução de migrations simultâneas;
* exclusão de dados sem backup validado;
* testes destrutivos sem autorização;
* armazenamento de logs com dados sensíveis;
* uso do usuário proprietário do banco pela aplicação;
* rollback cego de migrations;
* desligamento total do ambiente sem avaliação;
* publicação direta sem validação mínima;
* uso de secrets de homologação em produção.

---

# 19. Registro de deploy

Todo deploy de produção deve registrar:

```text
Data e horário:
Versão:
Commit:
Responsável:
Serviços alterados:
Migrations executadas:
Variáveis alteradas:
Resultado dos testes:
Resultado do health check:
Problemas identificados:
Rollback disponível:
Observações:
```

---

**Última atualização:** 4 de agosto de 2026.
