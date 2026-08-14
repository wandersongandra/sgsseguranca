# SGS — Sistema de Gestão de Segurança

<p align="left">
  <img alt="TypeScript em modo strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square">
  <img alt="NestJS 11" src="https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square">
  <img alt="PostgreSQL no Neon" src="https://img.shields.io/badge/PostgreSQL-Neon-336791?style=flat-square">
  <img alt="Arquitetura SaaS multi-tenant" src="https://img.shields.io/badge/SaaS-multi--tenant-0F766E?style=flat-square">
  <img alt="LGPD by design" src="https://img.shields.io/badge/LGPD-by--design-1F2937?style=flat-square">
  <img alt="Repositório privado" src="https://img.shields.io/badge/Acesso-privado-B91C1C?style=flat-square">
</p>

Plataforma SaaS B2B desenvolvida para centralizar a gestão de Saúde e Segurança do Trabalho, processos operacionais, evidências, inspeções, documentos, permissões, indicadores e controles corporativos.

O **SGS — Sistema de Gestão de Segurança** foi projetado para empresas que precisam administrar operações de segurança de forma rastreável, auditável e escalável, garantindo isolamento entre clientes, governança documental, proteção de dados e acompanhamento operacional em tempo real.

> **Aviso de confidencialidade:** este repositório é privado, proprietário e destinado exclusivamente a pessoas expressamente autorizadas. O acesso ao código-fonte não concede autorização para copiar, distribuir, reutilizar, comercializar ou divulgar qualquer parte do sistema.

---

## Visão geral

* **Produto:** plataforma operacional e administrativa para gestão de SST.
* **Modelo:** SaaS B2B multi-tenant.
* **Público:** gestores, técnicos de segurança, administradores, auditores e equipes operacionais.
* **Arquitetura:** monorepo com frontend, API, worker assíncrono, banco de dados, filas e armazenamento de arquivos.
* **Operação:** ambientes e processos separados para frontend, backend web, worker, banco de dados, cache e storage.
* **Prioridades técnicas:** isolamento entre tenants, LGPD, segurança, rastreabilidade, observabilidade, disponibilidade e desempenho operacional.

---

## Objetivos do SGS

O SGS tem como objetivo transformar processos descentralizados de segurança do trabalho em uma operação digital, integrada e governada.

A plataforma permite:

* centralizar informações de empresas, unidades, obras e trabalhadores;
* controlar processos, documentos, inspeções, treinamentos e vencimentos;
* acompanhar indicadores e situações críticas em tempo real;
* reduzir tarefas manuais e falhas operacionais;
* manter evidências e históricos auditáveis;
* aplicar controles de acesso por empresa, unidade, função e permissão;
* apoiar decisões de gestores e profissionais de SST;
* garantir maior rastreabilidade e conformidade dos processos.

---

## Principais capacidades

| Área                  | O que o SGS oferece                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| Dashboard SST         | Indicadores, alertas, filas críticas, SLA, conformidade, notificações e visão operacional             |
| Empresas e unidades   | Gestão multi-tenant de empresas, filiais, sites, obras, setores e estruturas organizacionais          |
| Usuários e permissões | Controle de acesso baseado em funções, escopos, empresas, unidades e responsabilidades                |
| Documentos governados | PDFs, assinaturas, anexos, evidências, versionamento, auditoria e armazenamento compatível com S3     |
| APR e RDO             | Fluxos operacionais, validações, pontuações, aprovações e registros de campo                          |
| Inspeções             | Planejamento, execução, evidências, não conformidades, responsáveis e acompanhamento de ações         |
| Treinamentos e exames | Controle de obrigações, vencimentos, trabalhadores, certificados e conformidade                       |
| Notificações          | Alertas operacionais, vencimentos, pendências, eventos críticos e comunicações internas               |
| Sophie IA             | Assistente interno de SST com consentimento, sanitização de dados, controle de acesso e rate limiting |
| Auditoria             | Registro de ações, alterações, acessos, eventos de segurança e operações críticas                     |
| Operação              | Health checks, logs estruturados, filas, jobs assíncronos, runbooks e recuperação de desastres        |

---

## Arquitetura do projeto

```text
frontend/  Aplicação web em Next.js, React e TypeScript
backend/   API principal em NestJS, TypeORM e PostgreSQL
worker/    Processamento de filas, PDFs, notificações e tarefas assíncronas
docs/      Arquitetura, auditorias, runbooks, checklists e documentação interna
ops/       Scripts e ferramentas compartilhadas de build, validação e operação
```

A arquitetura foi estruturada para separar responsabilidades, reduzir acoplamento e permitir a evolução independente dos principais componentes da plataforma.

### Componentes principais

* **Frontend:** interface web, dashboards, fluxos operacionais e experiência do usuário.
* **Backend web:** regras de negócio, autenticação, autorização, APIs e integrações.
* **Worker:** execução de tarefas pesadas e assíncronas fora do ciclo principal das requisições.
* **PostgreSQL:** armazenamento relacional, isolamento por tenant e integridade transacional.
* **Redis e BullMQ:** filas, cache, rate limiting e processamento distribuído.
* **Storage:** documentos, anexos, evidências, relatórios e arquivos governados.
* **Observabilidade:** logs, erros, métricas, rastreamento e acompanhamento da saúde dos serviços.

---

## Stack tecnológica

### Frontend

* Next.js 16
* React 19
* TypeScript em modo strict
* SCSS e tokens de design
* Radix UI
* Recharts
* Sentry

### Backend

* NestJS 11
* TypeORM
* PostgreSQL
* Redis
* BullMQ
* OpenAPI
* Sentry

### Infraestrutura

* Vercel
* Hostinger
* Coolify
* Neon PostgreSQL
* Backblaze B2
* APIs compatíveis com S3
* Cloudflare

### Qualidade e governança

* lint e validação estática;
* testes automatizados;
* validação de build;
* secret scanning;
* análise de dependências;
* templates para issues e pull requests;
* auditorias de segurança;
* migrations versionadas;
* documentação operacional;
* controles de revisão e aprovação.

---

## Princípios de engenharia

### 1. Tenant em primeiro lugar

Toda operação deve respeitar o isolamento entre clientes.

Nenhuma consulta, alteração, job, cache, arquivo ou evento pode perder o contexto de `tenantId`, `companyId` ou escopo equivalente.

O isolamento deve ser aplicado em todas as camadas:

* interface;
* API;
* serviços;
* banco de dados;
* filas;
* cache;
* storage;
* logs;
* relatórios;
* integrações externas.

### 2. LGPD por padrão

Dados pessoais, sensíveis e identificadores internos não devem ser expostos desnecessariamente.

É proibido publicar essas informações em:

* logs sem sanitização;
* issues;
* pull requests;
* prompts;
* documentação pública;
* mensagens de erro;
* ferramentas externas não autorizadas;
* dumps ou arquivos de diagnóstico.

Toda integração com inteligência artificial ou serviço externo deve considerar consentimento, minimização de dados, controle de acesso e sanitização de informações.

### 3. Alterações seguras

Mudanças no banco de dados devem ser realizadas por migrations versionadas, revisáveis e preferencialmente retrocompatíveis.

Alterações estruturais devem considerar:

* compatibilidade com versões anteriores;
* impacto no runtime;
* estratégia de rollback;
* tempo de execução;
* bloqueios de tabela;
* integridade dos dados;
* impacto em ambientes de produção.

### 4. Operação real

Toda funcionalidade deve ser planejada considerando seu comportamento em produção.

Isso inclui:

* logs estruturados;
* health checks;
* tratamento de erros;
* idempotência;
* observabilidade;
* recuperação de falhas;
* rollback;
* filas e retries;
* desempenho;
* consumo de recursos;
* continuidade da operação.

### 5. Segurança por design

Autenticação, autorização e validação devem ser aplicadas desde a concepção de cada funcionalidade.

Operações sensíveis devem possuir:

* validação de entrada;
* autorização por escopo;
* trilha de auditoria;
* proteção contra abuso;
* limitação de requisições;
* registro seguro de eventos;
* tratamento adequado de erros;
* prevenção contra exposição de dados.

### 6. UX operacional

As telas devem priorizar decisões rápidas, clareza e redução de esforço.

A experiência do usuário deve destacar:

* itens críticos;
* pendências;
* responsáveis;
* prazos;
* SLA;
* vencimentos;
* riscos;
* não conformidades;
* próximos passos;
* situação geral da operação.

---

## Multi-tenancy

O SGS utiliza uma arquitetura multi-tenant para atender diferentes empresas dentro da mesma plataforma, mantendo isolamento lógico e operacional entre os clientes.

Cada fluxo deve garantir que:

* um usuário acesse apenas os tenants autorizados;
* empresas e unidades respeitem o escopo do usuário;
* consultas sejam filtradas pelo tenant correto;
* arquivos sejam armazenados com escopo definido;
* jobs carreguem o contexto do tenant;
* caches utilizem chaves isoladas;
* relatórios não misturem informações de clientes;
* logs não exponham dados de outros tenants;
* operações administrativas sejam auditadas.

Qualquer alteração relacionada a consultas, permissões, banco, filas, cache ou storage deve ser revisada considerando possíveis riscos de vazamento cross-tenant.

---

## Segurança e privacidade

O projeto adota controles técnicos e operacionais voltados para:

* isolamento de dados;
* autenticação segura;
* autorização por funções e escopos;
* proteção de credenciais;
* sanitização de dados;
* trilhas de auditoria;
* rate limiting;
* validação de arquivos;
* proteção contra acessos indevidos;
* gerenciamento seguro de secrets;
* análise de dependências;
* monitoramento de erros e eventos críticos.

Credenciais, tokens, cookies, chaves privadas, variáveis de ambiente e dumps de banco de dados nunca devem ser adicionados ao repositório.

Vulnerabilidades não devem ser relatadas em issues públicas. O processo correto está descrito em [SECURITY.md](SECURITY.md).

---

## Infraestrutura e operação

| Componente             | Ambiente                            |
| ---------------------- | ----------------------------------- |
| Frontend               | Vercel                              |
| Backend web            | Hostinger e Coolify                 |
| Backend worker         | Hostinger e Coolify                 |
| Banco de dados         | Neon PostgreSQL                     |
| Cache e filas          | Redis e BullMQ                      |
| Storage                | Backblaze B2 com compatibilidade S3 |
| Proteção e rede        | Cloudflare                          |
| Monitoramento de erros | Sentry                              |

O backend web e o worker são executados como serviços separados, permitindo escalabilidade, isolamento de carga e maior controle operacional.

### Health checks

* `GET /health/public`
* `GET /health`

A disponibilidade dos recursos de observabilidade depende das configurações de cada ambiente. Logs estruturados fazem parte do comportamento padrão da aplicação, enquanto integrações como Sentry, OpenTelemetry e Prometheus são ativadas por configuração.

---

## Validação e qualidade

Toda alteração deve ser validada de acordo com a área impactada.

As validações podem incluir:

* lint;
* verificação de tipos;
* testes unitários;
* testes de integração;
* testes end-to-end;
* build de produção;
* migrations;
* validação de RLS;
* testes de isolamento entre tenants;
* testes de autorização;
* análise de dependências;
* secret scanning;
* testes de desempenho;
* validação de filas e jobs;
* revisão de logs e tratamento de erros.

Alterações relacionadas a banco de dados, autenticação, autorização, multi-tenancy, LGPD, arquivos ou integrações externas exigem atenção especial durante a revisão.

---

## Documentação essencial

* [Documentação do backend](backend/README.md)
* [Documentação geral](docs/README.md)
* [Arquitetura e stack](docs/consulta-rapida/arquitetura-e-stack.md)
* [Mapa de módulos](docs/consulta-rapida/mapa-de-modulos.md)
* [Segurança e governança](docs/consulta-rapida/seguranca-e-governanca.md)
* [Deploy com Vultr e Coolify](docs/deploy/coolify-vultr-backend-web-worker.md)
* [Runbook de produção](backend/docs/RUNBOOK_PRODUCTION.md)
* [Observabilidade](backend/docs/OBSERVABILITY.md)
* [Política de segurança](SECURITY.md)
* [Guia de contribuição](CONTRIBUTING.md)

---

## Contribuição interna

Antes de realizar alterações ou abrir um pull request:

1. leia o [CONTRIBUTING.md](CONTRIBUTING.md);
2. confirme o escopo da alteração;
3. avalie impactos em multi-tenancy, LGPD e segurança;
4. avalie impactos em banco, filas, cache e storage;
5. descreva os riscos operacionais;
6. informe as validações executadas;
7. mantenha as migrations retrocompatíveis;
8. não publique dados pessoais ou informações sensíveis;
9. documente decisões arquiteturais relevantes;
10. garanta que o código respeite os padrões do projeto.

Todo pull request deve informar, quando aplicável:

* módulos afetados;
* impacto em tenants;
* impacto em permissões;
* impacto em dados pessoais;
* migrations adicionadas;
* variáveis de ambiente adicionadas;
* estratégia de rollback;
* comandos de validação executados;
* evidências de testes.

---

## Regras de acesso e confidencialidade

Este repositório contém propriedade intelectual, regras de negócio, arquitetura, documentação e código-fonte exclusivos do SGS.

O acesso é restrito a colaboradores, prestadores e parceiros formalmente autorizados.

Não é permitido:

* copiar o código para projetos externos;
* compartilhar arquivos com pessoas não autorizadas;
* publicar trechos do sistema em fóruns ou ferramentas públicas;
* utilizar o código para fins particulares;
* criar versões derivadas sem autorização;
* divulgar arquitetura, credenciais ou regras internas;
* enviar código proprietário para serviços externos não aprovados;
* armazenar cópias locais após o encerramento da autorização de acesso.

O acesso ao repositório pode ser revogado a qualquer momento e não representa transferência de propriedade, licença comercial ou autorização de redistribuição.

---

## Propriedade intelectual

O SGS, incluindo seu código-fonte, identidade, arquitetura, documentação, banco de dados, fluxos, integrações, componentes, regras de negócio e materiais relacionados, constitui propriedade intelectual privada.

Todos os direitos são reservados.

A reprodução, distribuição, modificação, engenharia reversa, sublicenciamento, comercialização ou reutilização, total ou parcial, somente poderá ocorrer mediante autorização formal e expressa do proprietário.

---

## Licença

**Software privado e proprietário.**

Copyright © SGS — Sistema de Gestão de Segurança.

Todos os direitos reservados.

O acesso a este repositório não concede qualquer licença de uso, reprodução, distribuição, modificação, comercialização ou criação de trabalhos derivados.
