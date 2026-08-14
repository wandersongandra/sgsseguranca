# Auditoria Técnica Completa do Backend — NestJS SaaS Multi-Tenant

Você é um engenheiro backend sênior especializado em:

* NestJS;
* Node.js;
* TypeScript em modo estrito;
* PostgreSQL;
* arquitetura SaaS B2B multi-tenant;
* Redis e BullMQ;
* APIs REST;
* autenticação JWT e MFA;
* segurança de aplicações;
* observabilidade;
* desempenho;
* ambientes Linux e produção enterprise.

Execute uma auditoria técnica completa do backend deste projeto.

Não produza uma análise superficial. Inspecione o código real, execute os comandos disponíveis, reproduza os erros, identifique as causas-raiz, implemente correções seguras e valide o resultado final.

---

# 1. Regras obrigatórias

Antes de modificar qualquer arquivo:

1. Leia o `package.json`.
2. Identifique as versões reais de:

   * NestJS;
   * Node.js;
   * TypeScript;
   * ORM ou query builder;
   * PostgreSQL;
   * Redis;
   * BullMQ;
   * bibliotecas de autenticação;
   * bibliotecas de validação;
   * ferramentas de teste.
3. Identifique o gerenciador de pacotes pelo lockfile.
4. Leia:

   * `tsconfig.json`;
   * configuração do ESLint;
   * `nest-cli.json`;
   * arquivos Docker;
   * arquivos de ambiente de exemplo;
   * configurações de testes;
   * scripts de migration;
   * configurações de deploy;
   * estrutura completa de módulos.
5. Execute `git status`.
6. Preserve alterações existentes do usuário.
7. Não remova funcionalidades apenas para fazer testes ou build passarem.
8. Não altere regras de negócio sem evidência de erro.
9. Não execute migrations destrutivas em banco de produção.
10. Não imprima secrets, tokens, senhas ou URLs completas de conexão.
11. Não silencie erros utilizando:

    * `@ts-ignore`;
    * `@ts-nocheck`;
    * `eslint-disable` sem justificativa;
    * conversões indiscriminadas para `any`;
    * catches vazios;
    * retornos falsos apenas para esconder falhas.
12. Não invente arquivos, linhas, erros ou resultados.
13. Todo achado deve possuir evidência no código, configuração, teste ou saída de comando.
14. Considere ambiente Linux, containers e produção enterprise.
15. Considere que o sistema é multi-tenant e que qualquer vazamento entre empresas é crítico.

Caso a stack real seja diferente da informada, utilize a stack detectada como fonte de verdade e registre a divergência.

---

# 2. Levantamento inicial

Antes das correções, produza um baseline contendo:

* versão do NestJS;
* versão do Node.js;
* versão do TypeScript;
* ORM utilizado;
* banco utilizado;
* mecanismo de migrations;
* integração com Redis;
* filas e workers;
* estratégia de autenticação;
* estratégia de autorização;
* estratégia de isolamento multi-tenant;
* quantidade aproximada de módulos;
* quantidade de controllers;
* quantidade de services;
* quantidade de entities ou models;
* quantidade de migrations;
* quantidade de guards;
* quantidade de interceptors;
* quantidade de filters;
* quantidade de jobs;
* scripts disponíveis;
* resultado inicial de lint;
* resultado inicial do TypeScript;
* resultado inicial dos testes;
* resultado inicial do build;
* situação inicial do Git.

Não faça alterações antes de registrar esse baseline.

---

# 3. Comandos iniciais

Utilize os scripts reais do projeto.

Quando disponíveis, execute:

```bash
npm ci
npm run lint
npm run typecheck
npm run test
npm run test:e2e
npm run build
```

Caso não exista script de TypeScript:

```bash
npx tsc --noEmit
```

Caso existam testes separados:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
```

Caso o projeto utilize Docker para testes:

```bash
docker compose -f docker-compose.test.yml up -d
```

Registre para cada comando:

```text
Comando:
Código de saída:
Quantidade de erros:
Quantidade de testes executados:
Quantidade de testes aprovados:
Quantidade de testes falhos:
Primeiro erro relevante:
Arquivos afetados:
```

Não atualize dependências antes de reproduzir os problemas com o lockfile existente.

---

# 4. Riscos que podem quebrar produção

## 4.1 Exceptions não tratadas

Procure:

* promises sem `await`;
* promises sem tratamento de rejeição;
* callbacks assíncronos em `map`, `forEach` ou eventos;
* catches vazios;
* `throw new Error()` sem contexto;
* exceções internas expostas ao cliente;
* operações que podem gerar `undefined`;
* acesso a propriedades sem validação;
* parsing JSON sem tratamento;
* falhas de serviços externos sem timeout;
* chamadas ao banco sem tratamento;
* jobs que falham silenciosamente;
* processos que podem causar `unhandledRejection`;
* exceções que derrubam o worker;
* erros tratados como sucesso.

Verifique se existe um exception filter global.

Analise se ele:

* normaliza erros;
* mantém o status HTTP correto;
* não expõe stack trace;
* inclui identificador da requisição;
* diferencia erro operacional de erro interno;
* registra logs sem dados sensíveis.

## 4.2 Validação de entrada

Verifique:

* existência de `ValidationPipe` global;
* uso de `whitelist`;
* uso de `forbidNonWhitelisted`;
* uso de `transform`;
* DTOs ausentes;
* parâmetros sem validação;
* query strings sem limite;
* paginação sem limites máximos;
* UUIDs sem validação;
* enums aceitos como strings arbitrárias;
* datas inválidas;
* números negativos;
* arquivos sem validação;
* payloads excessivamente grandes;
* propriedades adicionais não previstas;
* mass assignment;
* validação apenas no frontend.

Confirme que o bootstrap utiliza configuração equivalente a:

```typescript
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
      enableImplicitConversion: false,
    },
  }),
);
```

Não aplique conversão implícita sem avaliar riscos.

## 4.3 Injeção de dependência

Procure:

* providers ausentes;
* módulos não importados;
* providers não exportados;
* dependências circulares;
* uso excessivo de `forwardRef`;
* tokens duplicados;
* injection tokens inconsistentes;
* classes instanciadas manualmente com `new`;
* serviços globais sem necessidade;
* módulos marcados como globais indevidamente;
* dependências opcionais usadas como obrigatórias;
* escopo request aplicado sem necessidade;
* dependências request-scoped causando degradação.

Para cada dependência circular, identifique a causa arquitetural. Não utilize `forwardRef` como correção automática.

## 4.4 Falhas de tipagem

Procure:

* `any`;
* `as any`;
* `as unknown as`;
* `Record<string, any>`;
* propriedades opcionais usadas como obrigatórias;
* retorno sem tipo;
* DTO diferente da entidade;
* resposta de API externa tratada como confiável;
* payload JWT sem interface;
* dados Redis desserializados sem validação;
* resultado SQL convertido manualmente;
* enum duplicado;
* tipos divergentes entre web e worker;
* variáveis de ambiente sem tipagem;
* `!` utilizado para ignorar nulabilidade.

---

# 5. Segurança

## 5.1 Autenticação

Analise:

* rotas sem guard;
* guards aplicados apenas no controller quando deveriam ser globais;
* endpoints administrativos públicos;
* endpoints internos expostos;
* autenticação opcional aplicada incorretamente;
* bypass de autenticação;
* decorators públicos mal utilizados;
* WebSockets sem autenticação;
* filas aceitando jobs sem origem confiável;
* endpoints de health expondo informações internas.

Crie uma relação de todas as rotas contendo:

```text
Método:
Rota:
Controller:
Autenticação exigida:
Autorização exigida:
Tenant exigido:
Papel exigido:
Risco identificado:
```

## 5.2 JWT e sessão

Verifique:

* algoritmo permitido;
* tamanho do secret;
* secret padrão;
* mesmo secret para access e refresh token;
* tokens sem expiração;
* refresh token sem rotação;
* refresh token armazenado em texto puro;
* ausência de revogação;
* ausência de identificação de sessão;
* ausência de `issuer`;
* ausência de `audience`;
* clock tolerance excessivo;
* payload com dados sensíveis;
* validação incompleta;
* refresh token reutilizável após logout;
* tokens aceitos após troca de senha;
* ausência de controle de sessões;
* cookie sem `HttpOnly`;
* cookie sem `Secure`;
* `SameSite` inadequado;
* logout que apenas remove cookie no navegador.

O backend deve validar explicitamente:

```typescript
{
  algorithms: ['HS256'],
  issuer: 'sgs-api',
  audience: 'sgs-web',
}
```

Adapte ao algoritmo realmente utilizado.

## 5.3 Autorização

Procure:

* validação apenas por role;
* ausência de permission guard;
* IDOR;
* usuários acessando recursos de outra empresa;
* administradores de tenant acessando funções globais;
* parâmetros fornecidos pelo usuário tratados como autorização;
* `companyId` aceito diretamente do body;
* tenant obtido de header sem validação;
* ausência de validação de ownership;
* acesso a recursos arquivados ou excluídos;
* mudanças de status sem autorização;
* endpoints de exportação sem escopo.

A autorização deve validar:

1. usuário autenticado;
2. sessão ativa;
3. empresa ativa;
4. vínculo usuário-empresa;
5. tenant da requisição;
6. papel;
7. permissão específica;
8. propriedade ou escopo do recurso;
9. estado do recurso;
10. MFA, quando exigido.

## 5.4 Isolamento multi-tenant

Trate qualquer possibilidade de vazamento entre tenants como `CRÍTICO`.

Analise:

* queries sem filtro de tenant;
* repositories usados sem contexto de tenant;
* `findOne({ id })` sem `companyId`;
* updates e deletes sem tenant;
* joins que ignoram tenant;
* cache sem prefixo por tenant;
* chaves Redis compartilhadas;
* jobs sem tenant ID;
* arquivos sem segregação;
* URLs assinadas sem validação de tenant;
* relatórios agregando empresas indevidamente;
* logs expondo tenant;
* filtros RLS ausentes;
* uso de conexão proprietária com `BYPASSRLS`;
* migrations que desativam RLS;
* transações que perdem contexto;
* raw SQL que ignora políticas;
* chamadas internas que confiam em `companyId` do payload.

Exemplo inseguro:

```typescript
return this.repository.findOne({
  where: {
    id: documentId,
  },
});
```

Exemplo esperado:

```typescript
return this.repository.findOne({
  where: {
    id: documentId,
    companyId: tenantId,
  },
});
```

Quando houver RLS, confirme empiricamente que o usuário real da aplicação não possui `BYPASSRLS`.

## 5.5 Dados sensíveis

Procure exposição de:

* senha;
* hash de senha;
* token;
* refresh token;
* segredo MFA;
* CPF;
* dados médicos;
* exames;
* laudos;
* documentos;
* chaves de API;
* credenciais de storage;
* URL de banco;
* dados de outras empresas;
* stack trace;
* SQL;
* detalhes internos de infraestrutura.

Verifique:

* entidades retornadas diretamente;
* ausência de response DTO;
* serialização;
* logs;
* interceptors;
* mensagens de erro;
* auditoria;
* Sentry;
* New Relic;
* Swagger;
* endpoints de debug;
* health checks.

Não retorne entidades completas quando houver campos internos.

## 5.6 Criptografia

Analise:

* algoritmos inseguros;
* chave fixa no código;
* IV reutilizado;
* ausência de autenticação do ciphertext;
* senhas criptografadas em vez de hash;
* hash de senha fraco;
* uso incorreto de bcrypt ou Argon2;
* secrets pequenos;
* mesma chave para finalidades diferentes;
* dados sensíveis armazenados em texto puro;
* logs anteriores e posteriores à criptografia.

---

# 6. Banco de dados

## 6.1 Queries inseguras

Procure:

* SQL injection;
* concatenação manual de SQL;
* raw queries com entrada externa;
* nomes de coluna ou ordenação definidos diretamente pelo usuário;
* filtros dinâmicos sem allowlist;
* update em massa sem filtro;
* delete sem tenant;
* `OR` que contorna filtro de tenant;
* parâmetros opcionais que removem escopo;
* paginação sem limite;
* busca com wildcard irrestrito;
* transações incompletas.

Exemplo inseguro:

```typescript
query(`SELECT * FROM users WHERE email = '${email}'`);
```

Exemplo correto:

```typescript
query(
  'SELECT * FROM users WHERE email = $1 AND company_id = $2',
  [email, tenantId],
);
```

## 6.2 Índices

Analise:

* foreign keys sem índice;
* filtros frequentes sem índice;
* consultas por tenant sem índice composto;
* índices duplicados;
* índices não utilizados;
* índices em colunas de baixa seletividade;
* buscas textuais sem estratégia;
* ordenação custosa;
* índices incompatíveis com a query;
* unique constraints ausentes;
* soft delete sem índice parcial;
* tabelas de auditoria crescendo sem estratégia.

Para cada índice sugerido, informe:

```text
Tabela:
Colunas:
Tipo de índice:
Query beneficiada:
Justificativa:
Custo de escrita:
Risco:
```

Não sugira índice sem relacioná-lo a uma query real.

## 6.3 Performance

Procure:

* N+1;
* joins excessivos;
* `SELECT *`;
* carregamento eager desnecessário;
* relations carregadas sem uso;
* paginação em memória;
* contagens repetidas;
* loops executando query;
* transações longas;
* locks;
* updates desnecessários;
* queries sem timeout;
* pool mal configurado;
* conexões não liberadas;
* excesso de conexões com Neon;
* falta de pooling;
* jobs concorrentes atualizando o mesmo registro;
* relatórios executados de forma síncrona;
* consultas pesadas no request principal.

## 6.4 Integridade

Verifique:

* foreign keys ausentes;
* `NOT NULL` ausente;
* unique constraints ausentes;
* check constraints ausentes;
* status aceitando valores inválidos;
* datas incoerentes;
* valores monetários em ponto flutuante;
* exclusões órfãs;
* cascade perigoso;
* soft delete inconsistente;
* ausência de versionamento ou optimistic locking;
* alterações críticas fora de transação.

## 6.5 Migrations

Analise:

* migration irreversível;
* migration não idempotente;
* alteração destrutiva imediata;
* índice criado bloqueando tabela;
* coluna obrigatória criada sem default ou backfill;
* enum alterado de forma insegura;
* migration dependente de ambiente local;
* migration fora de ordem;
* migration modificada após execução;
* rollback incompatível;
* tabela criada sem RLS;
* owner ou grants incorretos;
* execução simultânea por múltiplas réplicas.

Não execute migration em produção.

Teste migrations em banco vazio e, quando possível, em cópia de estrutura real.

---

# 7. Redis, cache e BullMQ

## 7.1 Redis

Analise:

* chaves sem prefixo;
* ausência de tenant na chave;
* ausência de TTL;
* cache de dados sensíveis;
* invalidação incompleta;
* serialização insegura;
* valores grandes;
* scans bloqueantes;
* uso de `KEYS`;
* credencial exposta;
* conexão sem TLS quando disponível;
* ausência de tratamento de reconexão;
* cache retornando dados de outro tenant.

Formato recomendado:

```text
sgs:{environment}:{tenantId}:{module}:{resource}:{id}
```

## 7.2 BullMQ

Verifique:

* jobs sem tenant;
* jobs sem idempotência;
* ausência de tentativas;
* ausência de backoff;
* jobs falhos ignorados;
* ausência de dead-letter strategy;
* payload contendo secrets;
* payload excessivamente grande;
* concorrência sem limite;
* job duplicado;
* lock expirando antes da conclusão;
* worker sem graceful shutdown;
* erro derrubando o processo;
* processamento sem transação;
* job concluído antes de persistir resultado;
* ausência de rastreabilidade.

---

# 8. Arquitetura

## 8.1 Controllers

Procure controllers que:

* contenham regra de negócio;
* façam query diretamente;
* manipulem entidades;
* acessem Redis;
* disparem jobs diretamente sem abstração;
* tenham tratamento de erro duplicado;
* retornem dados sem DTO;
* façam validação manual repetida;
* possuam muitos endpoints não relacionados.

Controllers devem coordenar entrada e saída, não implementar toda a regra.

## 8.2 Services

Identifique services:

* excessivamente grandes;
* com múltiplas responsabilidades;
* acoplados a muitos módulos;
* contendo regras de domínios diferentes;
* realizando HTTP, banco, cache, storage e auditoria no mesmo método;
* com métodos longos;
* difíceis de testar;
* com dependências excessivas;
* com lógica duplicada.

Não classifique apenas pelo número de linhas. Analise coesão, complexidade e responsabilidades.

## 8.3 DTOs

Verifique:

* endpoints sem DTO;
* uso de entidade como DTO;
* DTOs sem validação;
* DTOs compartilhados indevidamente;
* campos internos expostos;
* create e update utilizando o mesmo DTO;
* `PartialType` permitindo campos que não deveriam ser alterados;
* ausência de response DTO;
* enums duplicados;
* documentação Swagger divergente.

## 8.4 Separação de camadas

Analise se há separação clara entre:

* controller;
* application service;
* domínio;
* persistência;
* integrações externas;
* cache;
* filas;
* storage;
* autenticação;
* autorização;
* auditoria.

Identifique dependências invertidas incorretamente.

## 8.5 Código duplicado

Procure repetição em:

* obtenção do tenant;
* autorização;
* paginação;
* filtros;
* auditoria;
* tratamento de erro;
* upload;
* geração de URLs;
* chamadas externas;
* transações;
* soft delete;
* cache;
* validação de status;
* emissão de eventos.

Extraia abstrações apenas quando houver repetição real e responsabilidade clara.

---

# 9. APIs e contratos

Analise:

* status HTTP incorretos;
* respostas inconsistentes;
* ausência de paginação padronizada;
* erros sem código;
* contratos divergentes;
* datas em formatos diferentes;
* campos com nomes inconsistentes;
* endpoints que retornam `200` para erro;
* criação retornando objeto incompleto;
* delete retornando conteúdo indevido;
* PUT e PATCH utilizados incorretamente;
* idempotência ausente;
* versionamento de API;
* breaking changes;
* Swagger divergente do comportamento real.

Formato de erro recomendado:

```typescript
interface ApiErrorResponse {
  statusCode: number;
  code: string;
  message: string;
  requestId: string;
  timestamp: string;
  path: string;
  details?: Record<string, unknown>;
}
```

Não inclua detalhes internos em produção.

---

# 10. Integrações externas

Analise clientes de:

* storage;
* e-mail;
* IA;
* serviços de terceiros;
* webhooks;
* APIs externas.

Verifique:

* timeout;
* retry;
* backoff;
* circuit breaker;
* limite de concorrência;
* validação de resposta;
* assinatura de webhook;
* replay attack;
* idempotência;
* logs;
* secrets;
* tratamento de indisponibilidade;
* fallback;
* dados sensíveis enviados;
* minimização de payload;
* região de processamento.

Nenhuma chamada externa deve permanecer sem timeout explícito.

---

# 11. Configuração e variáveis de ambiente

Mapeie todas as variáveis utilizadas.

Para cada variável, informe:

```text
Nome:
Arquivos:
Obrigatória:
Ambiente:
Valor padrão:
Risco quando ausente:
É secret:
Validação existente:
```

Procure:

* variável obrigatória sem validação;
* fallback inseguro;
* secret padrão;
* ambiente de desenvolvimento usado em produção;
* URL inválida;
* boolean tratado como string;
* número sem parse;
* variável duplicada;
* nomes inconsistentes;
* secrets impressos nos logs.

Implemente validação centralizada utilizando schema apropriado.

Exemplo:

```typescript
const environmentSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .required(),

  DATABASE_URL: Joi.string()
    .uri()
    .required(),

  REDIS_URL: Joi.string()
    .uri()
    .required(),

  JWT_SECRET: Joi.string()
    .min(32)
    .required(),
});
```

---

# 12. Observabilidade e logs

Analise:

* logger padrão usado diretamente;
* `console.log`;
* logs sem contexto;
* ausência de request ID;
* ausência de correlation ID;
* logs contendo dados sensíveis;
* ausência de níveis;
* ausência de métricas;
* ausência de tracing;
* logs diferentes entre API e worker;
* erros sem stack nos logs internos;
* stack exposta ao cliente.

Logs devem permitir relacionar:

* requisição;
* usuário pseudonimizado;
* tenant pseudonimizado;
* serviço;
* job;
* operação;
* duração;
* resultado.

Não registrar:

* senha;
* token;
* cookie;
* segredo MFA;
* CPF completo;
* dado médico;
* arquivo;
* chave de API;
* URL de banco completa.

---

# 13. Testes

Analise a cobertura dos fluxos críticos:

* login;
* refresh token;
* logout;
* troca de senha;
* MFA;
* bloqueio de usuário;
* permissões;
* isolamento entre tenants;
* criação e edição de recursos;
* exclusão;
* upload;
* filas;
* auditoria;
* migrations;
* tratamento de erros;
* concorrência;
* idempotência.

Crie ou corrija testes quando necessário.

Para multi-tenancy, execute testes negativos:

1. crie Tenant A;
2. crie Tenant B;
3. autentique usuário do Tenant A;
4. tente acessar recurso do Tenant B;
5. confirme status `403` ou `404`;
6. confirme que nenhum dado do Tenant B foi retornado;
7. repita para leitura, atualização, exclusão, exportação e arquivos.

---

# 14. Classificação de risco

Utilize exatamente estas classificações:

## CRÍTICO

Problema que:

* permite vazamento entre tenants;
* permite bypass de autenticação;
* permite elevação de privilégio;
* expõe secret;
* permite SQL injection;
* causa perda ou corrupção de dados;
* impede build ou inicialização;
* quebra fluxo principal de produção;
* torna recuperação do banco inviável.

## ALTO

Problema que:

* causa falha relevante em produção;
* expõe dados sensíveis;
* permite IDOR;
* gera inconsistência de autorização;
* causa indisponibilidade;
* provoca duplicação de operações críticas;
* cria falha grave de performance;
* compromete jobs ou migrations.

## MÉDIO

Problema que:

* prejudica manutenção;
* causa falha em cenários específicos;
* reduz testabilidade;
* gera duplicação;
* aumenta risco operacional;
* causa degradação moderada;
* possui validação incompleta.

## MELHORIA

Aprimoramento que:

* reduz complexidade;
* melhora legibilidade;
* melhora observabilidade;
* melhora desempenho sem falha atual;
* facilita evolução;
* aumenta consistência.

Não classifique preferência estética como risco.

---

# 15. Formato obrigatório de cada achado

Para cada problema confirmado, utilize:

```text
ID:
Severidade:
Categoria:
Status: confirmado
Arquivo:
Linha inicial:
Linha final:
Classe ou método:
Endpoint ou job afetado:
Evidência:
Problema:
Causa-raiz:
Cenário de exploração ou falha:
Impacto em desenvolvimento:
Impacto em produção:
Impacto multi-tenant:
Impacto para o usuário:
Código anterior:
Código corrigido:
Correção aplicada:
Teste criado ou ajustado:
Validação executada:
Resultado:
Arquivos relacionados:
Risco de regressão:
```

Inclua trechos reais do código.

Não invente linhas.

Quando as linhas mudarem após a correção, informe:

* linha original;
* linha nova.

---

# 16. Estratégia de correção

Para cada problema:

1. reproduza;
2. identifique a causa-raiz;
3. classifique o risco;
4. proponha a menor correção segura;
5. implemente;
6. crie ou ajuste teste;
7. execute validação específica;
8. execute lint, TypeScript, testes e build;
9. verifique regressões;
10. registre os arquivos alterados.

Não faça grandes refatorações durante correções pontuais.

Não altere contratos da API sem documentar impacto no frontend, worker ou integrações.

Não execute alterações destrutivas no banco.

---

# 17. Validação final

Após as correções, execute novamente:

```bash
npm run lint
npx tsc --noEmit
npm run test
npm run test:e2e
npm run build
```

Quando existirem:

```bash
npm run migration:show
npm run test:integration
npm run test:security
```

Valide também:

* inicialização da API;
* inicialização do worker;
* conexão com PostgreSQL;
* conexão com Redis;
* health check;
* graceful shutdown;
* migrations em banco de teste;
* isolamento entre tenants;
* autenticação;
* autorização;
* filas.

Registre:

```text
Lint:
TypeScript:
Testes unitários:
Testes de integração:
Testes E2E:
Testes multi-tenant:
Build:
API inicializada:
Worker inicializado:
Health check:
Migrations:
Quantidade de erros antes:
Quantidade de erros depois:
Quantidade de testes antes:
Quantidade de testes depois:
```

Não afirme que algo passou sem executar.

---

# 18. Relatório final

Entregue o relatório nesta ordem:

## 1. Ambiente detectado

Versões, ferramentas, banco, filas, estrutura e comandos.

## 2. Baseline

Resultados antes das alterações.

## 3. Superfície de ataque

Rotas, guards, autenticação, autorização e isolamento multi-tenant.

## 4. Achados críticos

Todos os problemas `CRÍTICO`.

## 5. Achados altos

Todos os problemas `ALTO`.

## 6. Achados médios

Todos os problemas `MÉDIO`.

## 7. Melhorias

Oportunidades classificadas como `MELHORIA`.

## 8. Correções implementadas

Explique exatamente o que foi alterado.

## 9. Banco de dados

Queries, índices, constraints, migrations e performance.

## 10. Redis e BullMQ

Cache, filas, idempotência, concorrência e falhas.

## 11. Arquivos alterados

Liste:

```text
Arquivo:
Motivo:
Problemas corrigidos:
Possível impacto:
Validação:
```

## 12. Validação final

Comandos e resultados reais.

## 13. Pendências

Somente itens que não puderam ser resolvidos.

## 14. Riscos remanescentes

Riscos técnicos que ainda existem.

## 15. Próximas ações

Ordenadas por severidade, dependência e impacto.

---

# 19. Restrições finais

* Não resuma a auditoria.
* Não entregue recomendações genéricas.
* Não informe problema sem arquivo e evidência.
* Não invente números de linha.
* Não esconda erros.
* Não utilize `any` como solução.
* Não exponha secrets.
* Não faça commit ou push sem autorização.
* Não execute deploy.
* Não execute migration em produção.
* Não altere banco de produção.
* Não desative RLS.
* Não remova autenticação ou autorização para fazer testes passarem.
* Não reduza cobertura de testes.
* Não transforme erros em warnings.
* Não altere regras de negócio sem justificar.
* Priorize mudanças pequenas, verificáveis e reversíveis.
* Considere ambiente Linux, produção enterprise e isolamento SaaS multi-tenant.

Comece agora pelo levantamento inicial. Registre o baseline completo antes de realizar qualquer modificação.
