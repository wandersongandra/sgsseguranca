# Checklist de Auditoria de Segurança — SGS

## 1. Objetivo

Esta checklist deve ser utilizada para auditorias periódicas de segurança do SGS.

Periodicidade recomendada:

* controles críticos: mensalmente;
* revisão de acessos administrativos: mensalmente;
* restauração de backup: mensalmente;
* auditoria técnica completa: trimestralmente;
* teste de invasão profissional: anualmente ou após mudanças relevantes;
* revisão extraordinária: após incidente, migração, grande atualização ou alteração de arquitetura.

A auditoria deve considerar a seguinte infraestrutura:

| Componente      | Serviço                     |
| --------------- | --------------------------- |
| Frontend        | Vercel                      |
| Backend Web/API | Coolify em VPS              |
| Backend Worker  | Coolify em VPS              |
| Banco de dados  | Neon PostgreSQL             |
| Cache e filas   | Redis gerenciado            |
| Armazenamento   | Backblaze B2                |
| Repositório     | GitHub                      |
| Monitoramento   | Conforme configuração ativa |

Todos os testes devem ser executados apenas em sistemas, domínios e ambientes expressamente autorizados.

Testes intrusivos, scans intensivos, testes de carga e tentativas automatizadas de autenticação devem ser realizados preferencialmente em homologação.

---

# 2. Informações da auditoria

```text
Data:
Horário de início:
Horário de término:
Auditor:
Responsável técnico:
Versão do SGS:
Commit analisado:
Ambiente:
Domínio:
Backend Web:
Backend Worker:
Banco Neon:
Redis:
Bucket Backblaze:
Resultado geral:
```

---

# 3. Classificação dos achados

## Crítico

Problema que pode:

* permitir vazamento entre empresas;
* permitir acesso sem autenticação;
* permitir elevação de privilégio;
* expor secrets;
* causar perda ou corrupção de dados;
* comprometer o banco;
* permitir execução remota;
* tornar o sistema indisponível;
* impedir restauração de backup.

Prazo sugerido para tratamento: imediato.

## Alto

Problema que pode:

* expor dados sensíveis;
* causar IDOR;
* comprometer sessões;
* permitir acesso indevido;
* causar indisponibilidade relevante;
* comprometer filas ou integrações críticas;
* reduzir significativamente a capacidade de resposta a incidentes.

Prazo sugerido para tratamento: até 7 dias.

## Médio

Problema que:

* reduz a segurança em cenários específicos;
* aumenta a superfície de ataque;
* prejudica observabilidade;
* dificulta investigação;
* aumenta risco operacional;
* representa configuração incompleta.

Prazo sugerido para tratamento: até 30 dias.

## Melhoria

Aprimoramento que:

* eleva maturidade;
* reduz complexidade;
* melhora documentação;
* aumenta rastreabilidade;
* melhora automação;
* facilita auditorias futuras.

Prazo sugerido: conforme planejamento.

---

# 4. Autenticação

## Controles

* [ ] Todos os administradores utilizam autenticação multifator.
* [ ] Contas administrativas sem MFA não conseguem executar operações críticas.
* [ ] Não existem contas administrativas compartilhadas.
* [ ] Não existem usuários ou senhas padrão.
* [ ] O primeiro administrador é criado por processo controlado.
* [ ] A senha inicial exige alteração no primeiro acesso.
* [ ] O sistema não registra senhas em logs.
* [ ] O sistema não informa se determinado CPF ou e-mail está cadastrado em fluxos públicos.
* [ ] Tentativas de login são limitadas.
* [ ] Bloqueios temporários não podem ser utilizados facilmente para causar negação de serviço contra outro usuário.
* [ ] Existe proteção contra credential stuffing.
* [ ] O login registra eventos de segurança.
* [ ] Logins suspeitos podem gerar alertas.
* [ ] Alterações de senha invalidam sessões conforme a política definida.
* [ ] Recuperação de senha utiliza token de uso único.
* [ ] Token de recuperação possui expiração curta.
* [ ] Token de recuperação não é armazenado em texto puro.
* [ ] A resposta da recuperação de senha não permite enumeração de usuários.
* [ ] Usuários desativados não conseguem autenticar.
* [ ] Empresas suspensas não conseguem utilizar a plataforma indevidamente.

## Política de senha

* [ ] Existe tamanho mínimo adequado.
* [ ] Senhas comuns ou comprometidas são rejeitadas quando possível.
* [ ] Não existe limite máximo pequeno que prejudique o uso de gerenciadores de senha.
* [ ] Senhas são armazenadas apenas como hash seguro.
* [ ] O custo do algoritmo foi definido com base na capacidade da infraestrutura.
* [ ] A alteração periódica obrigatória de senha não é aplicada sem justificativa de risco.
* [ ] A troca é exigida após comprometimento, redefinição administrativa ou evidência de exposição.

Não dependa apenas de regras como letra maiúscula, número e caractere especial. Comprimento, bloqueio de senhas comuns, MFA e proteção contra tentativas automatizadas são controles mais importantes.

---

# 5. JWT, cookies e sessões

## Controles

* [ ] Access token possui expiração curta.
* [ ] Refresh token possui expiração definida.
* [ ] Access token e refresh token utilizam secrets ou chaves diferentes.
* [ ] O algoritmo aceito é declarado explicitamente.
* [ ] O backend valida `issuer`.
* [ ] O backend valida `audience`.
* [ ] O backend valida expiração.
* [ ] O backend não aceita algoritmo diferente do esperado.
* [ ] O payload não contém senha, CPF completo, dado médico ou secret.
* [ ] Refresh tokens são rotacionados.
* [ ] Reutilização de refresh token antigo é detectada.
* [ ] Refresh tokens são armazenados de forma segura.
* [ ] Logout invalida a sessão no backend.
* [ ] Logout não depende apenas da remoção de cookie no navegador.
* [ ] Alteração de senha revoga sessões quando aplicável.
* [ ] Desativação do usuário revoga sessões.
* [ ] Existe limite de sessões simultâneas quando necessário.
* [ ] O usuário consegue visualizar ou encerrar sessões ativas, quando aplicável.
* [ ] Cookies de autenticação usam `HttpOnly`.
* [ ] Cookies de autenticação usam `Secure`.
* [ ] `SameSite` foi definido de acordo com o fluxo real.
* [ ] Domínio e `Path` dos cookies estão restritos.
* [ ] Cookies não são enviados a subdomínios desnecessários.
* [ ] O frontend não armazena refresh token em `localStorage`.
* [ ] Existe proteção CSRF nas operações baseadas em cookies, quando aplicável.

## Verificação manual

Realize o teste em homologação ou com conta de auditoria:

1. autentique o usuário;
2. capture o identificador da sessão sem registrar o token completo;
3. faça logout;
4. tente reutilizar a sessão anterior;
5. confirme que a sessão foi rejeitada;
6. realize o refresh;
7. tente reutilizar o refresh token anterior;
8. confirme o comportamento esperado.

Nunca publique tokens reais em relatórios.

---

# 6. Autorização

## Controles

* [ ] Todas as rotas privadas exigem autenticação.
* [ ] Rotas administrativas exigem autorização específica.
* [ ] O sistema não depende apenas da função exibida no frontend.
* [ ] As permissões são verificadas no backend.
* [ ] Operações críticas exigem permissões específicas.
* [ ] Administradores de empresa não possuem privilégios globais.
* [ ] Usuários comuns não conseguem chamar endpoints administrativos diretamente.
* [ ] O sistema valida propriedade ou escopo do recurso.
* [ ] IDs fornecidos pelo cliente não são utilizados como prova de autorização.
* [ ] Operações de leitura, criação, edição, exclusão e exportação são verificadas separadamente.
* [ ] Recursos arquivados ou excluídos não podem ser acessados indevidamente.
* [ ] Mudanças de status respeitam o fluxo de aprovação.
* [ ] Acesso de suporte técnico é controlado e auditado.
* [ ] Impersonação, quando existente, exige autorização forte e auditoria.
* [ ] A autorização é testada negativamente.

## Matriz de autorização

```text
Módulo:
Operação:
Papel:
Permissão:
MFA exigido:
Escopo:
Resultado esperado:
Resultado obtido:
```

---

# 7. Isolamento multi-tenant

Qualquer falha que permita acesso entre empresas deve ser classificada como crítica.

## Controles

* [ ] Todas as tabelas multi-tenant possuem identificador de tenant.
* [ ] As queries filtram o tenant.
* [ ] Updates filtram o tenant.
* [ ] Deletes filtram o tenant.
* [ ] Joins mantêm o escopo do tenant.
* [ ] Relatórios respeitam o tenant.
* [ ] Exportações respeitam o tenant.
* [ ] Jobs de fila contêm tenant validado.
* [ ] Chaves Redis incluem tenant.
* [ ] Arquivos no storage possuem escopo de tenant.
* [ ] URLs assinadas são emitidas apenas após autorização.
* [ ] O frontend não define sozinho o tenant autorizado.
* [ ] O backend valida o vínculo entre usuário e empresa.
* [ ] O usuário real da aplicação não possui `BYPASSRLS`.
* [ ] As políticas RLS estão habilitadas nas tabelas aplicáveis.
* [ ] O proprietário da tabela não é usado como usuário normal da aplicação.
* [ ] Migrations não desativam RLS permanentemente.
* [ ] Transações preservam o contexto de tenant.
* [ ] Cache não retorna dados de outra empresa.
* [ ] Logs não misturam dados entre tenants.

## Teste obrigatório de isolamento

Para cada módulo crítico:

1. crie um recurso no Tenant A;
2. autentique um usuário do Tenant B;
3. tente consultar o recurso do Tenant A;
4. tente alterar o recurso;
5. tente excluir o recurso;
6. tente exportar o recurso;
7. tente acessar arquivos relacionados;
8. confirme que nenhum dado foi retornado;
9. confirme resposta `403` ou `404`, conforme o padrão do sistema;
10. confirme que o evento foi registrado.

Módulos mínimos:

* empresas;
* usuários;
* documentos;
* treinamentos;
* APR;
* PTA;
* inspeções;
* relatórios;
* arquivos;
* dados médicos;
* auditoria.

---

# 8. Rate limiting e proteção contra abuso

## Controles

* [ ] Existe limite global adequado.
* [ ] Login possui limite específico.
* [ ] Recuperação de senha possui limite específico.
* [ ] MFA possui limite específico.
* [ ] Refresh de sessão possui limite.
* [ ] Upload possui limite.
* [ ] Exportações possuem limite.
* [ ] Endpoints de IA possuem controle de consumo.
* [ ] Endpoints públicos possuem proteção.
* [ ] Os limites consideram IP, usuário, conta e tenant conforme o risco.
* [ ] O sistema funciona corretamente atrás do proxy do Coolify.
* [ ] `trust proxy` está configurado corretamente.
* [ ] Cabeçalhos de IP não são aceitos de qualquer origem.
* [ ] Respostas `429` possuem formato padronizado.
* [ ] Tentativas excessivas são monitoradas.
* [ ] O limite não pode ser facilmente contornado por alteração simples de cabeçalho.

## Teste controlado

Execute apenas em homologação ou janela autorizada:

```bash
for i in $(seq 1 10); do
  curl --silent \
    --output /dev/null \
    --write-out "%{http_code}\n" \
    --request POST \
    "https://api.seudominio.com/auth/login" \
    --header "Content-Type: application/json" \
    --data '{"identifier":"usuario-de-teste","password":"senha-incorreta"}'
done
```

Resultado esperado:

* primeiras tentativas processadas normalmente;
* tentativas excedentes respondendo `429`;
* nenhum bloqueio permanente;
* evento registrado;
* nenhuma senha ou identificador sensível exposto nos logs.

Não utilize CPF real durante testes.

---

# 9. Criptografia e transporte

## HTTPS e TLS

* [ ] HTTPS está ativo.
* [ ] HTTP redireciona para HTTPS.
* [ ] O certificado é válido.
* [ ] O certificado cobre os domínios utilizados.
* [ ] A renovação automática está funcionando.
* [ ] Protocolos antigos estão desabilitados.
* [ ] HSTS está configurado após validação completa do HTTPS.
* [ ] Comunicação entre serviços utiliza TLS quando disponível.
* [ ] Neon utiliza conexão SSL.
* [ ] Redis utiliza TLS quando suportado pelo provedor.
* [ ] Backblaze utiliza HTTPS.
* [ ] Não existem chamadas HTTP inseguras em produção.
* [ ] Conteúdo misto não é carregado pelo frontend.

## Testes

```bash
curl -I https://app.seudominio.com
curl -I https://api.seudominio.com
```

Verifique:

```text
Strict-Transport-Security
Content-Security-Policy
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
```

Teste de TLS:

```bash
openssl s_client \
  -connect api.seudominio.com:443 \
  -servername api.seudominio.com \
  -tls1_2
```

Não considere apenas a conexão bem-sucedida. Verifique também certificado, hostname, cadeia e data de validade.

## Criptografia em repouso

* [ ] Senhas utilizam hash, não criptografia reversível.
* [ ] Dados que exigem criptografia possuem justificativa documentada.
* [ ] Chaves não ficam no mesmo local que os dados.
* [ ] Chaves são diferentes por ambiente.
* [ ] IVs ou nonces não são reutilizados.
* [ ] O algoritmo fornece autenticidade, quando aplicável.
* [ ] A rotação de chave possui procedimento documentado.
* [ ] Backups sensíveis são protegidos.
* [ ] Arquivos privados não são públicos no storage.
* [ ] Dados médicos possuem acesso restrito.

Não presuma que todos os campos pessoais precisam de criptografia de aplicação. A decisão deve considerar risco, necessidade de busca, índice, acesso e modelo de ameaça.

---

# 10. Proteção da API

## Controles

* [ ] CORS possui allowlist.
* [ ] CORS não utiliza `*` com credenciais.
* [ ] Origens são comparadas de forma segura.
* [ ] Métodos permitidos estão restritos.
* [ ] Headers permitidos estão restritos.
* [ ] Helmet ou controles equivalentes estão ativos.
* [ ] Existe limite global de body.
* [ ] Uploads possuem limite separado.
* [ ] DTOs validam todas as entradas.
* [ ] `whitelist` está habilitado.
* [ ] Campos não permitidos são rejeitados.
* [ ] UUIDs são validados.
* [ ] Enums são validados.
* [ ] Datas são validadas.
* [ ] Paginação possui limite máximo.
* [ ] Ordenação utiliza allowlist.
* [ ] Filtros dinâmicos são validados.
* [ ] SQL utiliza parâmetros.
* [ ] Erros não expõem stack trace.
* [ ] O formato de erro é padronizado.
* [ ] Existe identificador de requisição.
* [ ] Endpoints de debug estão desabilitados em produção.
* [ ] Swagger está protegido ou desabilitado quando necessário.
* [ ] Health checks públicos não revelam detalhes internos.

## Teste de CORS

```bash
curl -i \
  -X OPTIONS \
  "https://api.seudominio.com/auth/login" \
  -H "Origin: https://origem-nao-autorizada.example" \
  -H "Access-Control-Request-Method: POST"
```

Resultado esperado:

* a origem não autorizada não recebe permissão de CORS;
* o servidor não reflete automaticamente a origem;
* nenhuma credencial é exposta.

## Teste de validação

Utilize payload de teste sem conteúdo executável real:

```bash
AUTH_HEADER="Authorization: Bearer $TOKEN"
curl -i \
  -X POST \
  "https://api.seudominio.com/users" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "name": "",
    "unexpectedField": "value"
  }'
```

Resultado esperado:

* rejeição dos campos inválidos;
* rejeição de campos não permitidos;
* ausência de detalhes internos;
* nenhum registro criado.

A prevenção de XSS deve ocorrer principalmente por codificação segura na saída e sanitização contextual quando HTML for aceito. Não aplique sanitização genérica a todos os campos sem avaliar perda ou alteração indevida de dados.

---

# 11. PostgreSQL e Neon

## Controles de conexão

* [ ] A aplicação usa usuário próprio.
* [ ] O runtime não utiliza o usuário proprietário.
* [ ] O usuário não possui `SUPERUSER`.
* [ ] O usuário não possui `BYPASSRLS`.
* [ ] O usuário não pode criar roles.
* [ ] O usuário não pode criar bancos.
* [ ] A conexão exige SSL.
* [ ] O pool está configurado.
* [ ] O número de conexões é compatível com o Neon.
* [ ] API e worker não excedem o limite total de conexões.
* [ ] Conexões ociosas são controladas.
* [ ] Queries possuem timeout quando aplicável.

## RLS

* [ ] RLS está habilitado nas tabelas multi-tenant.
* [ ] RLS está forçado quando necessário.
* [ ] Todas as operações possuem políticas adequadas.
* [ ] `SELECT`, `INSERT`, `UPDATE` e `DELETE` foram testados.
* [ ] O papel real da aplicação foi usado nos testes.
* [ ] O teste não foi executado apenas como owner.
* [ ] Policies não possuem condição permissiva indevida.
* [ ] Funções `SECURITY DEFINER` foram revisadas.
* [ ] Raw SQL respeita o contexto de tenant.

Consulta de inventário:

```sql
SELECT
  schemaname,
  tablename,
  rowsecurity,
  forcerowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

Verificação do papel da aplicação:

```sql
SELECT
  rolname,
  rolsuper,
  rolcreaterole,
  rolcreatedb,
  rolbypassrls
FROM pg_roles
WHERE rolname = 'NOME_DO_USUARIO_DA_APLICACAO';
```

Não inclua senha ou URL completa do banco no relatório.

## Queries e performance

* [ ] Não existem queries com concatenação de entrada.
* [ ] Updates possuem filtro.
* [ ] Deletes possuem filtro.
* [ ] Queries multi-tenant possuem tenant.
* [ ] Ordenação dinâmica utiliza allowlist.
* [ ] Paginação possui limite.
* [ ] Não existem N+1 críticos.
* [ ] Queries pesadas foram analisadas.
* [ ] Índices correspondem às queries reais.
* [ ] Foreign keys críticas possuem índices quando necessários.
* [ ] Índices compostos começam por colunas úteis ao filtro.
* [ ] Índices duplicados foram revisados.
* [ ] Relatórios pesados são processados de forma assíncrona quando necessário.
* [ ] Transações são curtas.
* [ ] Locks prolongados são monitorados.

## Integridade

* [ ] Foreign keys estão configuradas.
* [ ] Campos obrigatórios utilizam `NOT NULL`.
* [ ] Unicidade está no banco quando necessária.
* [ ] Constraints validam estados críticos.
* [ ] Valores monetários não usam ponto flutuante inadequado.
* [ ] Soft delete é consistente.
* [ ] Exclusões em cascata foram revisadas.
* [ ] Operações críticas usam transação.
* [ ] Concorrência foi considerada.

---

# 12. Migrations

## Controles

* [ ] Todas as migrations estão versionadas.
* [ ] Migrations já executadas não foram modificadas.
* [ ] A ordem de execução é consistente.
* [ ] O banco pode ser reconstruído a partir de zero.
* [ ] O teste de reconstrução utiliza ambiente limpo.
* [ ] Novas tabelas multi-tenant recebem RLS.
* [ ] Grants são aplicados corretamente.
* [ ] Migrations não dependem de caminhos locais.
* [ ] Migrations não dependem de dados inexistentes.
* [ ] Alterações destrutivas possuem plano de transição.
* [ ] Colunas obrigatórias possuem backfill planejado.
* [ ] Índices grandes são criados de forma segura.
* [ ] Migrações são executadas por apenas uma instância.
* [ ] API e worker não executam migration simultaneamente.
* [ ] Existe plano de rollback da aplicação.
* [ ] Rollback de banco não é executado automaticamente sem avaliação.

## Teste em banco descartável

1. crie um banco de teste vazio;
2. aplique todas as migrations;
3. confirme que todas concluíram;
4. execute os seeds mínimos;
5. inicialize a aplicação;
6. execute os testes de integração;
7. descarte o banco.

Nunca execute esse teste destrutivo no banco de produção.

---

# 13. Backup e recuperação do Neon

## Controles

* [ ] A retenção disponível no plano do Neon foi confirmada.
* [ ] O recurso de recuperação está ativo.
* [ ] Existe cópia independente quando necessária.
* [ ] Backups são protegidos.
* [ ] O acesso ao backup é restrito.
* [ ] A restauração é testada.
* [ ] O teste utiliza ambiente separado.
* [ ] O tempo de recuperação é medido.
* [ ] A perda máxima aceitável de dados está definida.
* [ ] O procedimento está documentado.
* [ ] O responsável pela restauração está definido.
* [ ] O backup inclui schema, dados e objetos necessários.
* [ ] A restauração preserva permissões e RLS.
* [ ] A integridade após a restauração é validada.

Exemplo de exportação controlada:

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="sgs_backup_$(date +%Y%m%d_%H%M%S).dump"
```

Restauração em banco separado:

```bash
pg_restore \
  --dbname="$DATABASE_RESTORE_URL" \
  --no-owner \
  --no-privileges \
  "arquivo.dump"
```

O teste não termina quando o comando conclui. Valide tabelas, registros, constraints, RLS, autenticação e fluxos críticos.

---

# 14. Redis gerenciado e BullMQ

## Redis

* [ ] Redis não está exposto sem autenticação.
* [ ] TLS é utilizado quando suportado.
* [ ] A credencial é exclusiva de produção.
* [ ] A credencial não está no repositório.
* [ ] API e worker usam a mesma configuração de filas.
* [ ] Chaves possuem prefixo por ambiente.
* [ ] Chaves relacionadas a tenant incluem tenant.
* [ ] Caches possuem TTL.
* [ ] Sessões possuem expiração.
* [ ] Dados permanentes não dependem apenas do Redis.
* [ ] Operações bloqueantes foram evitadas.
* [ ] O comando `KEYS` não é utilizado em produção.
* [ ] Reconexões são tratadas.
* [ ] Falhas de Redis não derrubam operações que poderiam degradar de forma segura.
* [ ] Dados sensíveis armazenados no Redis foram minimizados.

Formato recomendado:

```text
sgs:{environment}:{tenantId}:{module}:{resource}:{identifier}
```

Teste autorizado:

```bash
redis-cli -u "$REDIS_URL" ping
```

Resultado esperado:

```text
PONG
```

Não imprima a URL completa no terminal compartilhado ou relatório.

## BullMQ

* [ ] Todos os jobs possuem tenant validado.
* [ ] Jobs críticos são idempotentes.
* [ ] Existe limite de tentativas.
* [ ] Existe backoff.
* [ ] Jobs falhos são monitorados.
* [ ] Jobs não desaparecem silenciosamente.
* [ ] Concorrência é limitada.
* [ ] Payloads não contêm secrets.
* [ ] Payloads não carregam arquivos grandes.
* [ ] Jobs possuem identificador de correlação.
* [ ] Worker implementa graceful shutdown.
* [ ] A conclusão do job ocorre após persistência segura.
* [ ] Jobs duplicados são tratados.
* [ ] Existe procedimento de reprocessamento.
* [ ] Filas acumuladas geram alerta.
* [ ] Retenção de jobs concluídos e falhos foi definida.

---

# 15. Backblaze B2 e arquivos

## Controles

* [ ] O bucket é privado.
* [ ] A listagem pública está desabilitada.
* [ ] A Application Key é exclusiva.
* [ ] A chave possui acesso apenas ao bucket necessário.
* [ ] A chave principal da conta não é usada pela aplicação.
* [ ] Uploads utilizam validação no backend.
* [ ] Extensão é validada.
* [ ] MIME type é validado.
* [ ] Tamanho é limitado.
* [ ] O conteúdo não é confiado apenas pelo nome do arquivo.
* [ ] Nomes de arquivos são normalizados.
* [ ] O caminho inclui tenant seguro.
* [ ] Downloads exigem autorização.
* [ ] URLs assinadas possuem duração curta.
* [ ] Uma URL assinada não permite acesso a outro arquivo.
* [ ] Arquivos excluídos seguem a política de retenção.
* [ ] Regras de lifecycle foram revisadas.
* [ ] Evidências e documentos críticos podem ser recuperados.
* [ ] Logs não contêm chaves ou URLs assinadas completas.
* [ ] Uploads incompletos são tratados.
* [ ] Arquivos potencialmente perigosos não são executados no navegador.

## Teste multi-tenant

1. envie arquivo pelo Tenant A;
2. autentique como Tenant B;
3. tente solicitar a URL do arquivo;
4. tente utilizar o ID diretamente;
5. confirme que o acesso foi negado;
6. confirme que nenhuma URL assinada foi gerada.

---

# 16. Docker, Coolify e VPS

## Containers

* [ ] Containers da aplicação não executam como root.
* [ ] A imagem utiliza base adequada.
* [ ] Dependências de desenvolvimento não ficam na imagem final.
* [ ] O build utiliza múltiplos estágios quando apropriado.
* [ ] `.dockerignore` está configurado.
* [ ] `.env` não entra na imagem.
* [ ] Secrets não estão no Dockerfile.
* [ ] Health checks estão configurados.
* [ ] API e worker são serviços separados.
* [ ] O worker não possui porta pública desnecessária.
* [ ] A porta interna da API não está exposta diretamente.
* [ ] O filesystem é tratado como efêmero.
* [ ] Logs são enviados para saída padrão.
* [ ] Existe graceful shutdown.
* [ ] Limites de recursos foram avaliados.
* [ ] As imagens possuem versão ou digest rastreável.
* [ ] O deploy pode retornar para versão anterior.

Verificar usuário:

```bash
docker exec NOME_DO_CONTAINER id
```

Resultado esperado: usuário não root, salvo justificativa técnica documentada.

## Coolify

* [ ] Acesso administrativo utiliza credencial forte.
* [ ] MFA está habilitado quando disponível.
* [ ] Apenas pessoas autorizadas possuem acesso.
* [ ] Integração com GitHub possui escopo mínimo.
* [ ] Variáveis estão cadastradas como secrets.
* [ ] Logs não expõem variáveis.
* [ ] Domínios estão configurados corretamente.
* [ ] HTTPS está ativo.
* [ ] Health check funciona.
* [ ] Deploy automático está controlado.
* [ ] Branch de produção está protegida.
* [ ] Backend web e worker possuem comandos distintos.
* [ ] Migrações são executadas apenas uma vez.
* [ ] Rollback foi testado.
* [ ] Backups da configuração do Coolify foram considerados.

## VPS

* [ ] Sistema operacional está atualizado.
* [ ] SSH utiliza chave.
* [ ] Autenticação SSH por senha está desabilitada quando possível.
* [ ] Login direto de root está desabilitado.
* [ ] Firewall permite apenas portas necessárias.
* [ ] Painéis administrativos não estão publicamente expostos sem proteção.
* [ ] Fail2ban ou controle equivalente está ativo.
* [ ] Usuários antigos foram removidos.
* [ ] Chaves SSH antigas foram revogadas.
* [ ] Espaço em disco é monitorado.
* [ ] Reinicializações são monitoradas.
* [ ] Horário do sistema está sincronizado.

---

# 17. Vercel e frontend

## Controles

* [ ] Apenas variáveis públicas usam `NEXT_PUBLIC_*`.
* [ ] Secrets não estão presentes no bundle.
* [ ] O frontend não armazena refresh token em `localStorage`.
* [ ] Rotas protegidas são validadas no servidor quando aplicável.
* [ ] O backend repete toda autorização.
* [ ] CORS permite apenas origens conhecidas.
* [ ] CSP foi configurada e testada.
* [ ] Imagens remotas possuem allowlist.
* [ ] Redirecionamentos não permitem open redirect.
* [ ] Erros não expõem detalhes internos.
* [ ] Source maps de produção seguem a política definida.
* [ ] Preview deployments não utilizam secrets de produção indevidamente.
* [ ] Domínios antigos foram removidos.
* [ ] Deployments antigos não permanecem acessíveis com dados reais sem necessidade.
* [ ] Logs da Vercel não possuem dados sensíveis.
* [ ] Integração GitHub possui acesso mínimo.
* [ ] Branch de produção está protegida.

---

# 18. Gestão de secrets

## Controles

* [ ] `.env` está no `.gitignore`.
* [ ] Arquivos `.env` não estão rastreados.
* [ ] Secrets não aparecem no histórico do Git.
* [ ] Produção utiliza secrets diferentes de homologação.
* [ ] Secrets possuem entropia adequada.
* [ ] Secrets não utilizam valores padrão.
* [ ] JWT access e refresh usam materiais diferentes.
* [ ] Chaves de criptografia são separadas.
* [ ] Chaves do Neon são restritas.
* [ ] Credenciais Redis são restritas.
* [ ] Application Keys do Backblaze são restritas.
* [ ] Tokens GitHub possuem menor privilégio.
* [ ] Credenciais do Coolify são controladas.
* [ ] Acesso aos secrets é limitado.
* [ ] Existe inventário de secrets.
* [ ] Existe responsável por cada secret.
* [ ] Existe procedimento de rotação.
* [ ] Secrets são rotacionados após suspeita de exposição.
* [ ] Secrets antigos são revogados após rotação.
* [ ] A aplicação suporta troca de credencial sem perda de dados.

Não imponha rotação automática a cada 90 dias sem avaliar impacto e ameaça. O controle deve considerar criticidade, capacidade técnica, exposição e eventos de segurança.

## Verificações Git

```bash
git status --short
git ls-files | grep -E '(^|/)\.env($|\.)'
git log --all --full-history -- "*.env"
```

Também utilize uma ferramenta específica de detecção de secrets no repositório e no histórico.

Não exiba os valores encontrados no relatório. Registre apenas tipo, arquivo, commit e situação da revogação.

---

# 19. Dependências e cadeia de suprimentos

## Controles

* [ ] O lockfile está versionado.
* [ ] O deploy utiliza instalação reproduzível.
* [ ] Dependências críticas estão atualizadas.
* [ ] Vulnerabilidades foram analisadas.
* [ ] Alertas automáticos estão ativos.
* [ ] Dependências abandonadas foram identificadas.
* [ ] Pacotes desnecessários foram removidos.
* [ ] Scripts de pós-instalação foram revisados.
* [ ] Pacotes são obtidos de fonte confiável.
* [ ] O GitHub possui proteção de branch.
* [ ] Pull requests exigem revisão.
* [ ] Commits diretos em produção são controlados.
* [ ] Actions utilizam versões fixadas quando necessário.
* [ ] Tokens de CI possuem menor privilégio.
* [ ] Artefatos de build são rastreáveis ao commit.

## Auditoria

```bash
npm audit
npm outdated
```

O resultado do `npm audit` deve ser analisado. Não aplique automaticamente correções com quebra de versão sem revisar impacto.

## Imagens Docker

Quando houver autorização:

```bash
trivy image NOME_DA_IMAGEM:TAG
```

Registre:

* imagem;
* tag;
* digest;
* vulnerabilidades críticas;
* vulnerabilidades altas;
* exceções aceitas;
* prazo de correção.

---

# 20. Logs, auditoria e monitoramento

## Logs de aplicação

* [ ] Logs possuem timestamp.
* [ ] Logs possuem nível.
* [ ] Logs possuem request ID.
* [ ] Logs permitem correlacionar API e worker.
* [ ] Erros internos registram stack apenas no ambiente protegido.
* [ ] Stack trace não é retornado ao cliente.
* [ ] Logs não contêm senha.
* [ ] Logs não contêm token.
* [ ] Logs não contêm cookie.
* [ ] Logs não contêm CPF completo.
* [ ] Logs não contêm dados médicos.
* [ ] Logs não contêm documento completo.
* [ ] Logs não contêm URL de banco.
* [ ] Logs não contêm chave do Backblaze.
* [ ] Logs não contêm payload integral de IA.
* [ ] Retenção dos logs está documentada.
* [ ] Acesso aos logs é controlado.

## Auditoria

* [ ] Login é auditado.
* [ ] Logout é auditado.
* [ ] Falha de login é auditada.
* [ ] Ativação de MFA é auditada.
* [ ] Desativação de MFA é auditada.
* [ ] Alteração de permissão é auditada.
* [ ] Criação de administrador é auditada.
* [ ] Exportação de dados é auditada.
* [ ] Exclusão de dados é auditada.
* [ ] Acesso a dados sensíveis é auditado quando aplicável.
* [ ] Alterações críticas registram valor anterior e posterior de forma segura.
* [ ] Logs de auditoria não podem ser alterados por usuários comuns.
* [ ] Integridade da trilha é verificada.
* [ ] O hash chain, quando existente, é testado.
* [ ] Falhas na geração de auditoria não passam silenciosamente.

## Alertas

* [ ] API indisponível.
* [ ] Worker indisponível.
* [ ] Aumento de respostas `500`.
* [ ] Aumento de respostas `401` e `403`.
* [ ] Excesso de respostas `429`.
* [ ] Falhas de MFA.
* [ ] Tentativas de login suspeitas.
* [ ] Fila acumulada.
* [ ] Jobs falhos.
* [ ] Falha de conexão com o banco.
* [ ] Falha de conexão com Redis.
* [ ] Falha de upload.
* [ ] Falha de backup.
* [ ] Pouco espaço em disco.
* [ ] Uso elevado de memória.
* [ ] Reinicialização repetitiva de container.
* [ ] Alteração administrativa crítica.

---

# 21. Gestão de usuários e acessos

## Controles

* [ ] Princípio do menor privilégio está aplicado.
* [ ] Permissões são revisadas periodicamente.
* [ ] Administradores possuem justificativa.
* [ ] Usuários desligados são desativados rapidamente.
* [ ] Contas inativas são revisadas.
* [ ] Contas de serviço possuem finalidade documentada.
* [ ] Contas de serviço não são utilizadas por pessoas.
* [ ] Acesso de suporte é temporário quando possível.
* [ ] Acesso à Vercel é revisado.
* [ ] Acesso ao Coolify é revisado.
* [ ] Acesso ao Neon é revisado.
* [ ] Acesso ao Redis é revisado.
* [ ] Acesso ao Backblaze é revisado.
* [ ] Acesso ao GitHub é revisado.
* [ ] Chaves SSH são revisadas.
* [ ] Mudanças de papel são auditadas.
* [ ] Não existem usuários órfãos.
* [ ] Não existem contas genéricas.

## Relatório de revisão

```text
Usuário:
Sistema:
Nível de acesso:
Justificativa:
Último uso:
MFA:
Responsável:
Decisão: manter, reduzir ou revogar
Data:
```

---

# 22. Privacidade e LGPD

## Governança

* [ ] Os papéis de controlador e operador estão definidos.
* [ ] As finalidades de tratamento estão documentadas.
* [ ] As bases legais estão documentadas.
* [ ] Os dados coletados são necessários.
* [ ] Dados sensíveis possuem controles adicionais.
* [ ] O inventário de dados está atualizado.
* [ ] Suboperadores estão documentados.
* [ ] Transferências internacionais estão documentadas.
* [ ] Contratos e DPAs foram avaliados.
* [ ] O canal de privacidade está ativo.
* [ ] O encarregado está identificado quando aplicável.
* [ ] Solicitações de titulares possuem procedimento.
* [ ] A identidade do solicitante é verificada.
* [ ] Exportações não incluem dados de outros titulares ou tenants.
* [ ] Exclusões respeitam obrigações de retenção.
* [ ] Retenção está implementada tecnicamente.
* [ ] Offboarding de tenant está documentado.
* [ ] Backups são considerados no processo de eliminação.
* [ ] Incidentes possuem processo de avaliação regulatória.

## Documentos

* [ ] Política de Privacidade atualizada.
* [ ] Termos de Uso atualizados.
* [ ] Política de Cookies atualizada.
* [ ] Contratos refletem os provedores ativos.
* [ ] A lista de suboperadores corresponde à produção.
* [ ] Prazos declarados correspondem à operação real.
* [ ] Cookies declarados correspondem aos cookies reais.
* [ ] Funcionalidades de IA estão descritas corretamente.
* [ ] Fluxos de consentimento são utilizados apenas quando adequados.
* [ ] Não existem declarações de conformidade sem evidência.

---

# 23. Inteligência artificial

Quando funcionalidades de IA estiverem habilitadas:

* [ ] O provedor ativo está documentado.
* [ ] Os dados enviados estão mapeados.
* [ ] Dados desnecessários são removidos.
* [ ] Dados pessoais são minimizados.
* [ ] Dados sensíveis possuem tratamento específico.
* [ ] Imagens enviadas são tratadas conforme a política.
* [ ] Prompts não contêm secrets.
* [ ] Respostas não são tratadas como decisão técnica definitiva.
* [ ] Saídas de IA exigem revisão humana quando necessário.
* [ ] Existe controle de custo.
* [ ] Existe rate limiting.
* [ ] Existe timeout.
* [ ] Existe fallback.
* [ ] Logs não armazenam prompts sensíveis integralmente.
* [ ] O tenant é preservado.
* [ ] Respostas de outro tenant não podem aparecer.
* [ ] Instruções maliciosas em documentos não são tratadas como comandos confiáveis.
* [ ] Uploads analisados por IA passam pelos mesmos controles de segurança.
* [ ] O contrato do provedor foi avaliado.
* [ ] A retenção do provedor foi confirmada.
* [ ] O recurso pode ser desabilitado por tenant.

---

# 24. Resposta a incidentes

## Preparação

* [ ] Plano documentado.
* [ ] Papéis e responsáveis definidos.
* [ ] Contatos atualizados.
* [ ] Critérios de severidade definidos.
* [ ] Canal de comunicação alternativo disponível.
* [ ] Procedimento de preservação de evidências definido.
* [ ] Procedimento de revogação de secrets definido.
* [ ] Procedimento de isolamento definido.
* [ ] Procedimento de restauração definido.
* [ ] Comunicação com clientes definida.
* [ ] Avaliação jurídica e regulatória definida.
* [ ] Simulação realizada no último ano.

## Durante o incidente

* [ ] Horário da detecção registrado.
* [ ] Responsável designado.
* [ ] Escopo inicial identificado.
* [ ] Serviços afetados identificados.
* [ ] Tenants afetados identificados.
* [ ] Evidências preservadas.
* [ ] Logs exportados.
* [ ] Hash das evidências calculado.
* [ ] Credenciais comprometidas revogadas.
* [ ] Contenção aplicada.
* [ ] Impacto da contenção avaliado.
* [ ] Comunicação interna registrada.
* [ ] Linha do tempo mantida.
* [ ] Decisões registradas.

## Evidências

Exemplo de coleta de log:

```bash
docker logs NOME_DO_CONTAINER \
  > "incident_$(date +%Y%m%d_%H%M%S).log" 2>&1
```

Hash:

```bash
sha256sum incident_*.log
```

Não desligue toda a infraestrutura automaticamente sem avaliar:

* preservação de evidências;
* impacto nos clientes;
* possibilidade de contenção parcial;
* risco de perda de dados;
* dependências externas.

---

# 25. Continuidade e recuperação

## Controles

* [ ] RTO foi definido.
* [ ] RPO foi definido.
* [ ] Dependências críticas foram identificadas.
* [ ] Falha do Neon foi considerada.
* [ ] Falha do Redis foi considerada.
* [ ] Falha do Backblaze foi considerada.
* [ ] Falha da VPS foi considerada.
* [ ] Falha do Coolify foi considerada.
* [ ] Falha da Vercel foi considerada.
* [ ] Falha do GitHub foi considerada.
* [ ] Rollback da aplicação foi testado.
* [ ] Restauração de banco foi testada.
* [ ] Recriação do worker foi testada.
* [ ] Configuração de produção está documentada.
* [ ] Secrets podem ser recuperados de forma segura.
* [ ] Existe responsável pela declaração de desastre.
* [ ] Existe procedimento de retorno à normalidade.

Não teste rollback utilizando `git checkout` diretamente no ambiente de produção sem planejamento. Utilize uma imagem, deployment ou commit anterior validado e mantenha compatibilidade com as migrations aplicadas.

---

# 26. Testes de segurança

## Testes internos

* [ ] Auditoria de dependências executada.
* [ ] Análise estática executada.
* [ ] Detecção de secrets executada.
* [ ] Testes de autorização executados.
* [ ] Testes multi-tenant executados.
* [ ] Testes de upload executados.
* [ ] Testes de rate limiting executados.
* [ ] Testes de sessão executados.
* [ ] Testes de recuperação de senha executados.
* [ ] Testes de MFA executados.
* [ ] Testes de RLS executados.
* [ ] Testes de restore executados.
* [ ] Testes de filas executados.

## Pentest

* [ ] Escopo formalmente definido.
* [ ] Autorização registrada.
* [ ] Ambiente definido.
* [ ] Janela definida.
* [ ] IPs de origem registrados.
* [ ] Contato de emergência definido.
* [ ] Limites de teste definidos.
* [ ] Dados reais foram evitados.
* [ ] Achados foram classificados.
* [ ] Correções foram validadas.
* [ ] Reteste foi realizado.
* [ ] Relatório foi armazenado de forma segura.

## Informações

```text
Último scan autorizado:
Ferramenta:
Escopo:
Responsável:
Achados críticos:
Achados altos:
Pendências:

Último pentest:
Empresa ou auditor:
Escopo:
Relatório:
Reteste:
Próximo pentest:
```

Não execute scans amplos ou testes agressivos contra produção sem autorização, janela e monitoramento.

---

# 27. Documentação

* [ ] Diagrama de arquitetura atualizado.
* [ ] Fluxo de autenticação documentado.
* [ ] Fluxo de autorização documentado.
* [ ] Modelo multi-tenant documentado.
* [ ] Políticas RLS documentadas.
* [ ] Matriz de permissões atualizada.
* [ ] Inventário de dados atualizado.
* [ ] Inventário de secrets atualizado.
* [ ] Inventário de suboperadores atualizado.
* [ ] Procedimento de deploy atualizado.
* [ ] Procedimento de rollback atualizado.
* [ ] Procedimento de backup atualizado.
* [ ] Procedimento de restore atualizado.
* [ ] Runbook da API atualizado.
* [ ] Runbook do worker atualizado.
* [ ] Runbook de Redis atualizado.
* [ ] Runbook de incidentes atualizado.
* [ ] Contatos atualizados.
* [ ] Dependências críticas documentadas.
* [ ] Exceções de segurança aprovadas e datadas.

---

# 28. Registro de achados

Utilize o formato abaixo para cada problema:

```text
ID:
Título:
Severidade:
Categoria:
Status:
Data da identificação:
Auditor:
Arquivo ou componente:
Linha ou configuração:
Ambiente:
Evidência:
Descrição:
Causa-raiz:
Cenário de exploração ou falha:
Impacto:
Tenants afetados:
Dados afetados:
Correção recomendada:
Responsável:
Prazo:
Validação necessária:
Data da correção:
Data do reteste:
Resultado do reteste:
Risco residual:
```

---

# 29. Pontuação da auditoria

A pontuação não deve substituir a análise dos riscos.

Um único problema crítico pode tornar o resultado geral reprovado, independentemente da pontuação numérica.

## Distribuição sugerida

| Área                       | Pontos |
| -------------------------- | -----: |
| Autenticação e sessões     |     12 |
| Autorização e multi-tenant |     18 |
| API e validação            |     10 |
| Banco, RLS e migrations    |     15 |
| Redis, filas e storage     |     10 |
| Infraestrutura e deploy    |     10 |
| Secrets e dependências     |      8 |
| Logs e monitoramento       |      7 |
| Privacidade e LGPD         |      5 |
| Incidentes e continuidade  |      5 |
| Total                      |    100 |

## Resultado

```text
Pontuação obtida:
Pontuação máxima: 100

Achados críticos:
Achados altos:
Achados médios:
Melhorias:

Resultado:
[ ] Aprovado
[ ] Aprovado com pendências
[ ] Reprovado

Justificativa:
```

## Critérios

### Aprovado

* nenhum achado crítico;
* nenhum achado alto vencido;
* controles mínimos implementados;
* backup restaurado com sucesso;
* isolamento multi-tenant validado.

### Aprovado com pendências

* nenhum achado crítico;
* achados altos com mitigação temporária e prazo aprovado;
* riscos formalmente aceitos;
* plano de correção definido.

### Reprovado

* qualquer vazamento entre tenants;
* bypass de autenticação;
* secret ativo exposto;
* SQL injection;
* backup sem possibilidade comprovada de restauração;
* RLS ineficaz nas tabelas críticas;
* vulnerabilidade crítica explorável;
* ausência de resposta para risco imediato.

---

# 30. Plano de ação

```text
ID do achado:
Severidade:
Ação:
Responsável:
Dependências:
Data de início:
Prazo:
Status:
Evidência da correção:
Responsável pelo reteste:
Resultado:
```

Prioridade recomendada:

1. contenção dos riscos críticos;
2. revogação de secrets expostos;
3. correção de autenticação e autorização;
4. correção de isolamento multi-tenant;
5. proteção de dados e banco;
6. disponibilidade e recuperação;
7. observabilidade;
8. melhorias estruturais.

---

# 31. Resultado final

```text
Data da auditoria:
Auditor:
Versão analisada:
Commit:
Ambiente:

Pontuação:
Resultado:

Achados críticos:
1.
2.
3.

Achados altos:
1.
2.
3.

Achados médios:
1.
2.
3.

Riscos aceitos:
1.
2.
3.

Prazo geral para correção:

Responsável pelo plano de ação:

Data do próximo acompanhamento:

Data da próxima auditoria:
```

---

# 32. Metas de segurança

* [ ] Todos os administradores com MFA.
* [ ] Nenhum secret ativo exposto.
* [ ] Nenhuma vulnerabilidade crítica conhecida sem contenção.
* [ ] Nenhum vazamento entre tenants.
* [ ] Todas as tabelas críticas protegidas por escopo de tenant.
* [ ] Backups restaurados mensalmente em ambiente separado.
* [ ] Migrations reconstruindo o banco do zero.
* [ ] Alertas críticos funcionando.
* [ ] Workers monitorados.
* [ ] Jobs falhos tratados.
* [ ] Acessos administrativos revisados mensalmente.
* [ ] Pentest profissional realizado conforme o risco.
* [ ] Incidente simulado pelo menos uma vez por ano.
* [ ] Documentação crítica atualizada.
* [ ] Riscos pendentes com responsável e prazo.

Metas de disponibilidade e tempos de resposta devem ser compatíveis com o contrato, a infraestrutura e a capacidade real da equipe.

Evite metas sem definição operacional, como “MTTR menor que cinco minutos”, caso não existam plantão, alertas e procedimentos capazes de sustentá-las.

---

**Última atualização:** 4 de agosto de 2026.

**Próxima revisão planejada:** 4 de novembro de 2026.
