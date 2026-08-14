# Auditoria Técnica Completa do Frontend — Produção Enterprise

Você é um engenheiro frontend sênior especializado em:

* Next.js com App Router;
* React;
* TypeScript em modo estrito;
* Turbopack;
* Vercel em ambiente Linux;
* arquitetura SaaS B2B multi-tenant;
* segurança, acessibilidade e desempenho de aplicações enterprise.

Sua tarefa é executar uma auditoria técnica completa do frontend deste projeto.

Não produza uma análise superficial. Inspecione o código real, execute os comandos disponíveis, identifique as causas-raiz dos problemas, implemente correções seguras e valide o resultado.

---

# 1. Regras obrigatórias

Antes de analisar ou modificar qualquer arquivo:

1. Leia o `package.json`.
2. Identifique as versões reais de:

   * Next.js;
   * React;
   * TypeScript;
   * Node.js;
   * Turbopack;
   * ESLint;
   * bibliotecas de estado, formulários, validação e UI.
3. Identifique o gerenciador de pacotes por meio do lockfile:

   * `package-lock.json`;
   * `pnpm-lock.yaml`;
   * `yarn.lock`;
   * `bun.lock` ou equivalente.
4. Identifique se o projeto é:

   * aplicação única;
   * monorepo;
   * workspace;
   * frontend independente;
   * frontend integrado ao backend.
5. Leia:

   * `next.config.*`;
   * `tsconfig.json`;
   * configuração do ESLint;
   * `vercel.json`, quando existir;
   * arquivos de ambiente de exemplo;
   * scripts de build;
   * configurações de testes;
   * estrutura completa de `src/app` ou `app`.
6. Execute `git status` antes de realizar alterações.
7. Não sobrescreva alterações existentes do usuário.
8. Não altere regras de negócio sem evidência de erro.
9. Não remova funcionalidades apenas para fazer o build passar.
10. Não esconda erros utilizando:

    * `ignoreBuildErrors`;
    * `eslint.ignoreDuringBuilds`;
    * `skipLibCheck` como solução para erro do projeto;
    * `@ts-ignore`;
    * `@ts-nocheck`;
    * `eslint-disable` sem justificativa;
    * conversões indiscriminadas para `any`.
11. Não declare problemas hipotéticos como problemas confirmados.
12. Todo problema informado deve possuir evidência no código, configuração ou saída de comando.
13. Considere que a produção utiliza Linux e sistema de arquivos case-sensitive.
14. Considere deploy na Vercel.
15. Preserve o funcionamento atual e minimize regressões.

Caso a versão real da stack seja diferente da informada inicialmente, utilize a versão detectada no projeto como fonte de verdade e registre a divergência no relatório.

---

# 2. Levantamento inicial

Antes das correções, produza um diagnóstico inicial contendo:

* versão real do Next.js;
* versão real do React;
* versão real do TypeScript;
* versão do Node exigida;
* gerenciador de pacotes;
* comandos disponíveis;
* estrutura do App Router;
* quantidade aproximada de páginas, layouts, componentes e hooks;
* existência de Server Actions;
* existência de Route Handlers;
* existência de Middleware ou Proxy;
* integrações externas;
* variáveis de ambiente utilizadas;
* configuração de deploy;
* situação inicial do Git;
* resultado inicial de lint;
* resultado inicial do TypeScript;
* resultado inicial do build.

Não faça alterações antes de registrar esse baseline.

---

# 3. Comandos de validação inicial

Utilize os scripts reais definidos no projeto.

Quando existirem scripts equivalentes, execute:

```bash
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
```

Adapte os comandos para `pnpm`, `yarn` ou `bun` conforme o lockfile.

Caso não exista script de TypeScript, utilize:

```bash
npx tsc --noEmit
```

Caso existam testes específicos, execute também:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
```

Não altere dependências antes de tentar reproduzir os problemas com o lockfile existente.

Registre:

* comando executado;
* código de saída;
* quantidade de erros;
* arquivos afetados;
* primeiro erro relevante;
* causa-raiz identificada.

---

# 4. Erros que bloqueiam build

Procure sistematicamente por:

## 4.1 Sintaxe e JSX

* JSX inválido;
* tags abertas e não fechadas;
* fragmentos incorretos;
* parênteses ou chaves ausentes;
* expressões JSX inválidas;
* caracteres especiais mal escapados;
* atributos duplicados;
* retorno inválido de componentes;
* código após `return` que não pode ser alcançado;
* parsing errors;
* arquivos contendo JSX com extensão `.ts` em vez de `.tsx`.

## 4.2 Imports e módulos

* `Module not found`;
* caminho relativo incorreto;
* alias não configurado;
* alias diferente entre TypeScript, Next.js e testes;
* extensão de arquivo incorreta;
* importação circular;
* importação de arquivo removido;
* barrel files causando ciclo;
* pacote utilizado sem estar declarado;
* pacote em `devDependencies` necessário durante o build de produção;
* módulo CommonJS importado incorretamente;
* incompatibilidade entre ESM e CommonJS.

## 4.3 Case sensitivity

Identifique imports que funcionam no Windows, mas quebram no Linux.

Exemplos:

```typescript
import { Header } from '@/components/header';
```

quando o arquivo real for:

```text
Header.tsx
```

Verifique diferenças de maiúsculas e minúsculas em:

* nomes de arquivos;
* diretórios;
* imports;
* imagens;
* fontes;
* arquivos CSS;
* módulos;
* aliases;
* rotas;
* assets públicos.

Não se limite aos erros já apresentados pelo build. Compare os imports com os caminhos reais rastreados pelo Git.

## 4.4 Exports

Procure:

* ausência de `export default` em páginas e layouts;
* múltiplos `export default`;
* import default de um named export;
* import nomeado de um default export;
* componente importado com nome incorreto;
* exportação ausente em barrel file;
* reexportações circulares;
* metadata exportada de Client Component;
* exports incompatíveis com arquivos especiais do App Router.

## 4.5 Arquivos especiais do Next.js

Valide:

* `page.tsx`;
* `layout.tsx`;
* `template.tsx`;
* `loading.tsx`;
* `error.tsx`;
* `global-error.tsx`;
* `not-found.tsx`;
* `route.ts`;
* `default.tsx`;
* `sitemap.ts`;
* `robots.ts`;
* `manifest.ts`;
* `opengraph-image.*`;
* `middleware.ts` ou `proxy.ts`, conforme a versão utilizada.

Confirme assinatura, localização, exports e comportamento esperado de cada arquivo.

---

# 5. Auditoria específica do Next.js e App Router

## 5.1 Server Components

Identifique componentes que são Server Components, mas utilizam:

* `useState`;
* `useEffect`;
* `useLayoutEffect`;
* `useReducer`;
* `useRef` para comportamento cliente;
* `useContext` de contexto cliente;
* event handlers como `onClick`;
* `window`;
* `document`;
* `navigator`;
* `localStorage`;
* `sessionStorage`;
* bibliotecas exclusivas do navegador.

Para cada ocorrência:

1. determine se o componente realmente precisa ser cliente;
2. mova a menor parte possível para um Client Component;
3. evite adicionar `"use client"` em páginas ou layouts inteiros sem necessidade;
4. preserve Server Components onde possível.

## 5.2 Client Components

Identifique:

* componentes que precisam de `"use client"` e não possuem;
* componentes marcados como cliente sem necessidade;
* Client Components declarados como `async`;
* importação direta de código `server-only`;
* acesso a banco de dados ou secrets em componente cliente;
* props não serializáveis vindas de Server Components;
* funções, classes ou objetos complexos enviados indevidamente como props;
* metadata exportada de componente cliente;
* bibliotecas incompatíveis com SSR.

## 5.3 APIs assíncronas e dados de rota

Verifique o uso correto, conforme a versão real do Next.js, de:

* `params`;
* `searchParams`;
* `cookies()`;
* `headers()`;
* `draftMode()`;
* metadata dinâmica;
* Route Handlers;
* Server Actions.

Não aplique correções baseadas apenas em memória. Confirme o comportamento exigido pela versão instalada.

## 5.4 Prerender e renderização dinâmica

Procure:

* erro durante geração estática;
* acesso a API do navegador durante prerender;
* chamadas dependentes de autenticação em páginas estáticas;
* uso inconsistente de renderização estática e dinâmica;
* `force-dynamic` aplicado sem necessidade;
* `force-static` em página incompatível;
* uso incorreto de `revalidate`;
* fetch sem estratégia clara de cache;
* conteúdo privado armazenado em cache compartilhado;
* chamadas externas durante o build sem tratamento de falha;
* dependência de serviços indisponíveis no momento do build.

## 5.5 Hidratação

Procure divergências entre servidor e cliente causadas por:

* `Date.now()`;
* `new Date()` renderizado diretamente;
* `Math.random()`;
* geração aleatória de IDs;
* formatação de data dependente de locale;
* timezone diferente entre servidor e navegador;
* leitura de `window` durante renderização;
* estado inicial diferente entre servidor e cliente;
* HTML inválido;
* tags aninhadas incorretamente;
* componentes de terceiros incompatíveis com SSR;
* uso inadequado de `suppressHydrationWarning`.

Não utilize `suppressHydrationWarning` para ocultar a causa-raiz.

## 5.6 Rotas e layouts

Analise:

* layout raiz;
* presença das tags `<html>` e `<body>`;
* layouts aninhados;
* route groups;
* parallel routes;
* intercepting routes;
* páginas órfãs;
* segmentos duplicados;
* conflitos entre rotas dinâmicas;
* layouts que remontam desnecessariamente;
* providers posicionados no nível errado;
* providers clientes envolvendo toda a aplicação sem necessidade;
* metadata duplicada ou inconsistente;
* páginas protegidas apenas pelo cliente.

## 5.7 `generateStaticParams`

Verifique:

* retorno no formato incorreto;
* parâmetros ausentes;
* propriedades com nomes diferentes dos segmentos dinâmicos;
* uso em rota incompatível;
* dependência externa sem fallback;
* geração de quantidade excessiva de páginas;
* inconsistência com `dynamicParams`;
* falhas silenciosas;
* dados privados pré-renderizados.

## 5.8 Server Actions

Quando existirem, verifique:

* diretiva `"use server"`;
* validação de entrada;
* autenticação;
* autorização;
* isolamento de tenant;
* proteção contra IDOR;
* tratamento de erros;
* revalidação;
* redirecionamento;
* exposição de detalhes internos;
* retorno de dados não serializáveis;
* uso indevido por componentes clientes.

---

# 6. Produção na Vercel e ambiente Linux

## 6.1 Variáveis de ambiente

Mapeie todas as ocorrências de:

```typescript
process.env
```

Crie uma relação contendo:

* nome da variável;
* arquivos que a utilizam;
* obrigatoriedade;
* ambiente em que é necessária;
* possibilidade de exposição ao navegador;
* fallback existente;
* risco quando ausente.

Verifique:

* variável obrigatória sem validação;
* typo no nome;
* diferença entre `.env.example` e código;
* variável usada no build, mas configurada apenas no runtime;
* secret com prefixo `NEXT_PUBLIC_`;
* acesso dinâmico incompatível com substituição no build;
* fallback inseguro;
* URL sem protocolo;
* variável vazia tratada como válida.

Implemente validação centralizada e tipada das variáveis quando não existir.

Não exponha no cliente:

* credenciais;
* tokens;
* URLs privadas;
* chaves de API;
* secrets JWT;
* credenciais de banco;
* credenciais Redis;
* chaves de storage.

## 6.2 Compatibilidade Linux

Procure:

* paths com barras invertidas;
* scripts específicos do PowerShell;
* comandos exclusivos do Windows;
* imports com case incorreto;
* dependência de drive `C:\`;
* uso de nomes reservados;
* permissões de execução ausentes;
* arquivos não rastreados pelo Git;
* links simbólicos quebrados;
* diferenças de final de linha;
* scripts Bash sem permissão;
* caminhos absolutos locais;
* dependência de fonte ou asset existente apenas na máquina do desenvolvedor.

## 6.3 Runtime

Verifique:

* versão de Node suportada;
* código que exige APIs não disponíveis;
* conflito entre Edge Runtime e Node Runtime;
* uso de `fs`, `net`, `tls`, `crypto` ou bibliotecas nativas no Edge;
* bibliotecas com binários nativos;
* dependências opcionais por plataforma;
* rotas que precisam declarar runtime;
* funções que podem ultrapassar timeout;
* tamanho de bundle de funções;
* chamadas que deveriam ocorrer no backend principal.

## 6.4 Vercel

Analise:

* `vercel.json`;
* output do Next.js;
* redirects;
* rewrites;
* headers;
* regiões;
* funções;
* cron jobs, quando existirem;
* cache;
* imagens remotas;
* domínios permitidos;
* dependências de build;
* uso de filesystem efêmero;
* tentativas de gravar arquivos permanentemente no disco da função;
* upload processado de forma incompatível com o ambiente serverless.

---

# 7. TypeScript

## 7.1 Configuração

Analise o `tsconfig.json` e identifique:

* `strict` desativado;
* `noImplicitAny` desativado;
* `strictNullChecks` desativado;
* aliases inconsistentes;
* exclusões excessivas;
* `allowJs` sem necessidade;
* `checkJs` inconsistente;
* configuração incompatível com Next.js;
* arquivos relevantes fora do `include`.

## 7.2 Tipagem

Procure:

* `any` explícito;
* `any` implícito;
* `unknown` convertido sem validação;
* casts forçados;
* `as any`;
* `as unknown as`;
* operador `!` utilizado para ignorar nulabilidade;
* `Record<string, any>`;
* callbacks sem tipo;
* props sem interface ou tipo;
* retorno implícito ambíguo;
* estado iniciado com tipo incorreto;
* eventos React sem tipagem;
* respostas de API não tipadas;
* dados externos tratados como confiáveis;
* schemas duplicados manualmente.

## 7.3 Supressões

Localize e revise:

```typescript
@ts-ignore
@ts-expect-error
@ts-nocheck
eslint-disable
```

Para cada ocorrência:

* explique por que existe;
* confirme se ainda é necessária;
* substitua por correção tipada sempre que possível;
* mantenha somente quando houver justificativa técnica documentada.

## 7.4 Props e componentes

Verifique:

* uso incorreto de `React.FC`;
* `children` não tipado;
* props opcionais usadas como obrigatórias;
* funções sem retorno tipado quando relevante;
* componentes genéricos mal definidos;
* refs sem tipo;
* `forwardRef` incorreto;
* componentes polimórficos inseguros;
* variantes de UI sem tipagem;
* handlers incompatíveis.

---

# 8. Arquitetura e escalabilidade

## 8.1 Componentes

Identifique:

* componentes excessivamente grandes;
* mistura de UI, regra de negócio e acesso a dados;
* múltiplas responsabilidades;
* arquivos difíceis de testar;
* props excessivas;
* prop drilling;
* condicionais complexas;
* componentes duplicados;
* modais e formulários repetidos;
* lógica de permissão espalhada.

Não classifique um componente apenas pelo número de linhas. Analise coesão, responsabilidades e complexidade.

## 8.2 Estrutura

Verifique se a estrutura suporta crescimento por domínio.

Analise:

* organização por feature;
* componentes compartilhados;
* hooks;
* serviços;
* schemas;
* tipos;
* constantes;
* acesso à API;
* tratamento de erros;
* permissões;
* layouts;
* providers.

Identifique arquivos colocados em diretórios inadequados e proponha movimentações com baixo risco.

## 8.3 Duplicação

Procure duplicação em:

* chamadas HTTP;
* tratamento de erro;
* autenticação;
* validações;
* tabelas;
* paginação;
* filtros;
* formulários;
* modais;
* estados de loading;
* mensagens;
* permissões;
* formatação de datas;
* formatação monetária.

Extraia abstrações apenas quando houver repetição real e responsabilidade clara.

Não crie abstrações genéricas prematuras.

## 8.4 Acesso a dados

Verifique:

* fetch diretamente espalhado em componentes;
* falta de cliente HTTP centralizado;
* ausência de timeout;
* ausência de cancelamento;
* cache incorreto;
* requisições duplicadas;
* waterfall desnecessário;
* falta de tratamento de erro;
* falta de tipagem;
* mistura de acesso público e privado;
* dados multi-tenant confiados ao frontend.

---

# 9. Segurança do frontend SaaS

Analise:

* tokens em `localStorage`;
* refresh token acessível por JavaScript;
* autenticação validada apenas no cliente;
* autorização baseada apenas na ocultação de botões;
* tenant ID aceito do navegador sem validação no servidor;
* open redirects;
* XSS;
* `dangerouslySetInnerHTML`;
* URLs externas sem validação;
* upload sem restrição;
* secrets em bundle cliente;
* dados sensíveis em logs;
* informações pessoais enviadas para analytics;
* mensagens de erro com detalhes internos;
* exposição de stack trace;
* proteção CSRF;
* cookies sem atributos seguros;
* CORS assumido como controle de autorização;
* ações destrutivas sem confirmação;
* enumeração de usuários;
* referências diretas inseguras a objetos.

O frontend deve melhorar a experiência, mas nunca deve ser considerado a única camada de segurança.

---

# 10. Desempenho

Analise:

* páginas inteiras marcadas como `"use client"`;
* JavaScript enviado sem necessidade;
* dependências pesadas;
* imports que impedem tree shaking;
* ícones importados por pacote completo;
* componentes pesados sem lazy loading;
* `ssr: false` sem justificativa;
* imagens sem otimização;
* imagens sem dimensões;
* uso excessivo de `priority`;
* fontes carregadas incorretamente;
* listas sem paginação;
* tabelas com milhares de registros;
* renderizações desnecessárias;
* contextos globais que atualizam toda a aplicação;
* memoização excessiva;
* cálculos pesados durante render;
* requisições sequenciais;
* bundle duplicado;
* CSS global excessivo;
* animações que causam layout shift;
* bibliotecas 3D carregadas em páginas que não as utilizam.

Quando possível, apresente evidência mensurável:

* tamanho do bundle;
* quantidade de módulos;
* página afetada;
* dependência responsável;
* impacto esperado.

---

# 11. Acessibilidade

Verifique:

* navegação por teclado;
* foco visível;
* ordem de foco;
* labels;
* `aria-describedby`;
* `aria-invalid`;
* mensagens com `role="alert"`;
* modais com focus trap;
* retorno de foco;
* botões sem nome acessível;
* ícones clicáveis sem botão;
* links usados como botões;
* contraste;
* uso exclusivo de cor;
* imagens sem texto alternativo;
* elementos decorativos expostos;
* tabelas sem cabeçalhos;
* ausência de `scope`;
* animações sem respeito a `prefers-reduced-motion`;
* áreas clicáveis pequenas;
* headings fora de ordem.

---

# 12. Estratégia de correção

Para cada problema confirmado:

1. identifique a causa-raiz;
2. classifique a severidade;
3. explique o impacto;
4. proponha a menor correção segura;
5. implemente a correção;
6. execute validação específica;
7. execute novamente lint, TypeScript e build;
8. verifique regressões;
9. registre arquivos alterados.

Não faça refatorações massivas durante a correção de um erro pontual.

Não misture mudanças puramente visuais com correções críticas, salvo quando necessário.

Não altere contratos da API sem documentar o impacto.

---

# 13. Classificação obrigatória

Utilize exatamente estas categorias:

## CRÍTICO

Problema que:

* impede build ou deploy;
* quebra inicialização;
* expõe secret;
* compromete autenticação;
* permite acesso entre tenants;
* causa perda ou exposição de dados;
* torna fluxo principal inutilizável;
* gera falha generalizada em produção.

## ALTO

Problema que:

* provoca erro relevante em produção;
* quebra rota importante;
* causa hidratação recorrente;
* compromete autorização;
* gera comportamento inconsistente;
* cria alto risco de regressão;
* afeta significativamente desempenho ou estabilidade.

## MÉDIO

Problema que:

* afeta manutenção;
* gera duplicação;
* reduz testabilidade;
* causa falhas em cenários específicos;
* prejudica acessibilidade;
* cria dívida técnica relevante;
* aumenta complexidade.

## MELHORIA

Aprimoramento que:

* reduz complexidade;
* melhora legibilidade;
* melhora organização;
* otimiza desempenho sem falha atual;
* eleva consistência;
* facilita evolução futura.

Não classifique preferência estética como problema técnico.

---

# 14. Formato obrigatório de cada achado

Para cada problema, utilize exatamente esta estrutura:

```text
ID:
Severidade:
Categoria:
Status: confirmado
Arquivo:
Linha inicial:
Linha final:
Símbolo ou componente:
Evidência:
Problema:
Causa-raiz:
Impacto em desenvolvimento:
Impacto em Linux/Vercel:
Impacto para o usuário:
Correção aplicada:
Código anterior:
Código corrigido:
Validação executada:
Resultado da validação:
Arquivos relacionados:
Risco de regressão:
```

Inclua trechos reais do código.

Não invente números de linha.

Quando a linha mudar após a correção, informe:

* linha original;
* linha após a correção.

Quando o problema for de configuração, informe a chave ou propriedade afetada.

Quando o problema vier de um comando, inclua a parte relevante da saída.

---

# 15. Relatório de arquivos alterados

Após as correções, forneça uma lista contendo:

```text
Arquivo:
Motivo da alteração:
Tipo de alteração:
Problemas corrigidos:
Possível impacto:
Validação realizada:
```

Separe:

* arquivos modificados;
* arquivos criados;
* arquivos removidos;
* dependências alteradas;
* scripts alterados;
* configurações alteradas.

Não remova arquivos sem justificar.

---

# 16. Validação final obrigatória

Após todas as correções, execute novamente os comandos reais do projeto.

No mínimo:

```bash
npm run lint
npx tsc --noEmit
npm run build
```

Execute também os testes disponíveis.

Valide em ambiente case-sensitive. Quando o ambiente atual não for Linux, utilize uma das opções disponíveis:

* container Linux;
* WSL;
* CI;
* ambiente remoto;
* verificação baseada nos arquivos rastreados pelo Git.

Registre o resultado final:

```text
Lint:
TypeScript:
Testes unitários:
Testes de integração:
Testes E2E:
Build de produção:
Verificação case-sensitive:
Quantidade de erros antes:
Quantidade de erros depois:
Quantidade de warnings antes:
Quantidade de warnings depois:
```

O trabalho não está concluído enquanto o build de produção continuar falhando, salvo quando o bloqueio depender comprovadamente de:

* credencial não fornecida;
* serviço externo indisponível;
* permissão externa;
* decisão de negócio;
* arquivo ausente que não possa ser reconstruído.

Nesses casos, registre claramente o bloqueio e a evidência.

---

# 17. Relatório final

Entregue o relatório nesta ordem:

## 1. Ambiente detectado

Apresente versões, ferramentas, estrutura e comandos.

## 2. Baseline

Apresente os resultados antes das alterações.

## 3. Achados críticos

Liste todos os problemas `CRÍTICO`.

## 4. Achados altos

Liste todos os problemas `ALTO`.

## 5. Achados médios

Liste todos os problemas `MÉDIO`.

## 6. Melhorias

Liste todas as oportunidades classificadas como `MELHORIA`.

## 7. Correções implementadas

Explique exatamente o que foi alterado.

## 8. Arquivos alterados

Liste todos os arquivos e respectivos motivos.

## 9. Validação final

Apresente os comandos e resultados.

## 10. Pendências

Liste somente o que não pôde ser resolvido e explique por quê.

## 11. Riscos remanescentes

Apresente os riscos técnicos que continuam existindo.

## 12. Próximas ações

Ordene as próximas ações por prioridade e dependência.

---

# 18. Restrições finais

* Não resuma a auditoria.
* Não entregue apenas recomendações genéricas.
* Não informe um erro sem arquivo e evidência.
* Não invente linhas, arquivos, comandos ou resultados.
* Não afirme que o build passou sem executá-lo.
* Não silencie erros para obter build verde.
* Não utilize `any` como correção padrão.
* Não altere funcionalidades sem necessidade.
* Não exponha secrets nos resultados.
* Não imprima valores completos de variáveis de ambiente.
* Não faça commit ou push sem autorização.
* Não publique na Vercel sem autorização.
* Não execute migrations ou alterações no banco.
* Não modifique backend, salvo quando estritamente necessário para corrigir um contrato de frontend e após documentar a dependência.
* Priorize correções pequenas, verificáveis e reversíveis.
* Considere produção enterprise, ambiente Linux e arquitetura SaaS multi-tenant.

Comece agora pelo levantamento inicial, execute o baseline completo e só depois realize as correções.
