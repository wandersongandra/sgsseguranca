# SGS — Sistema de Gestão de Segurança

<p align="left">
  <img alt="TypeScript em modo strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square">
  <img alt="NestJS 11" src="https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-production-336791?style=flat-square">
  <img alt="Arquitetura SaaS multi-tenant" src="https://img.shields.io/badge/SaaS-multi--tenant-0F766E?style=flat-square">
  <img alt="LGPD by design" src="https://img.shields.io/badge/LGPD-by--design-1F2937?style=flat-square">
  <img alt="Código público com licença proprietária" src="https://img.shields.io/badge/C%C3%B3digo-p%C3%BAblico%20%7C%20propriet%C3%A1rio-7C3AED?style=flat-square">
</p>

O **SGS — Sistema de Gestão de Segurança** é uma plataforma SaaS B2B multi-tenant para gestão de Saúde e Segurança do Trabalho, criada para centralizar documentos governados, inspeções, evidências, permissões, indicadores, auditoria e fluxos operacionais em uma arquitetura preparada para produção.

**Produção:** https://app.sgsseguranca.com.br

> **Aviso de propriedade intelectual:** o código-fonte deste repositório é publicamente visível para fins de portfólio, transparência técnica e colaboração autorizada. A visibilidade pública não concede licença para copiar, redistribuir, reutilizar comercialmente ou criar trabalhos derivados. Consulte a seção de licença ao final deste documento.

---

## Visão geral

- **Produto:** plataforma operacional e administrativa para gestão de SST.
- **Modelo:** SaaS B2B multi-tenant.
- **Público:** gestores, técnicos de segurança, administradores, auditores e equipes operacionais.
- **Arquitetura:** frontend, API, processamento assíncrono, banco relacional, cache/filas e armazenamento de arquivos.
- **Prioridades:** isolamento entre clientes, LGPD, segurança, rastreabilidade, disponibilidade, observabilidade e desempenho operacional.

---

## Principais capacidades

| Área | O que o SGS oferece |
| --- | --- |
| Dashboard SST | Indicadores, alertas, filas críticas, SLA, conformidade e visão operacional |
| Empresas e unidades | Gestão multi-tenant de empresas, filiais, sites, obras e estruturas organizacionais |
| Usuários e permissões | Controle de acesso por função, escopo, empresa, unidade e responsabilidade |
| Documentos governados | PDFs, assinaturas, anexos, evidências, versionamento e auditoria |
| APR, ARR, PT, RDO e DDS | Fluxos operacionais, validações, aprovações, registros e emissão governada |
| Inspeções e checklists | Planejamento, execução, evidências, não conformidades e ações corretivas |
| Treinamentos e exames | Obrigações, vencimentos, trabalhadores, certificados e conformidade |
| Notificações | Alertas operacionais, vencimentos, pendências e eventos críticos |
| Sophie IA | Assistência aplicada ao contexto de SST com controles de acesso e sanitização |
| Auditoria | Registro de ações, alterações, acessos e operações críticas |
| Operação | Health checks, logs estruturados, filas, jobs assíncronos e recuperação de falhas |

---

## Arquitetura

```text
frontend/  Interface web, dashboards e fluxos operacionais
backend/   API, regras de negócio, autenticação, autorização e integrações
worker/    Processamento assíncrono, documentos, notificações e tarefas pesadas
docs/      Arquitetura, decisões, runbooks e documentação técnica
ops/       Scripts e ferramentas compartilhadas de validação e operação
```

A arquitetura separa responsabilidades para reduzir acoplamento e permitir evolução independente dos principais componentes.

### Componentes centrais

- **Frontend:** Next.js, React e TypeScript.
- **Backend:** NestJS, TypeORM e PostgreSQL.
- **Processamento assíncrono:** Redis, filas e workers dedicados.
- **Storage:** arquivos e evidências com armazenamento compatível com S3.
- **Observabilidade:** logs estruturados, métricas, health checks e monitoramento de erros.

---

## Stack tecnológica

### Frontend

- Next.js 16
- React 19
- TypeScript strict
- Radix UI
- Recharts
- Sentry

### Backend

- NestJS 11
- TypeORM
- PostgreSQL
- Redis
- BullMQ
- OpenAPI
- Sentry

### Engenharia e operação

- Docker e Linux
- CI/CD com GitHub Actions
- migrations versionadas
- testes automatizados e E2E
- secret scanning
- análise de dependências
- SAST e code scanning
- SBOM
- observabilidade e runbooks

---

## Princípios de engenharia

### Multi-tenancy em primeiro lugar

Toda operação deve preservar o contexto de tenant e impedir vazamento entre clientes em consultas, arquivos, cache, filas, relatórios, logs e integrações.

### LGPD por padrão

Dados pessoais e identificadores internos devem ser minimizados, protegidos e sanitizados antes de aparecerem em logs, prompts, erros, integrações externas ou ferramentas de diagnóstico.

### Segurança por design

Operações sensíveis devem incluir validação de entrada, autenticação, autorização por escopo, trilha de auditoria, rate limiting, tratamento seguro de erros e prevenção contra abuso.

### Operação real

Funcionalidades são avaliadas considerando comportamento em produção: idempotência, rollback, filas, retries, desempenho, consumo de recursos, observabilidade e recuperação de falhas.

---

## Segurança

O repositório possui validações automatizadas que incluem, conforme o fluxo impactado:

- Gitleaks e TruffleHog para detecção de segredos;
- Semgrep e CodeQL para análise estática;
- auditoria de dependências;
- Trivy para análise de vulnerabilidades;
- validação de lockfiles;
- testes de autenticação, autorização e isolamento multi-tenant;
- testes de migrations e PostgreSQL real;
- geração de SBOM;
- required checks antes de alterações na branch principal.

Credenciais, tokens, cookies, chaves privadas, arquivos `.env` reais e dumps de banco de dados não devem ser adicionados ao repositório.

Vulnerabilidades não devem ser relatadas em issues públicas. Consulte [SECURITY.md](SECURITY.md).

---

## Qualidade e validação

Mudanças podem exigir:

- lint e formatação;
- type-check;
- testes unitários e de integração;
- testes end-to-end;
- build de produção;
- validação de migrations;
- testes de isolamento entre tenants;
- análise de dependências e segredos;
- revisão de logs e tratamento de erros;
- validação de desempenho quando aplicável.

Alterações em autenticação, autorização, multi-tenancy, LGPD, arquivos, banco de dados ou integrações externas exigem revisão adicional.

---

## Contribuição

Antes de abrir um pull request:

1. leia o [CONTRIBUTING.md](CONTRIBUTING.md);
2. mantenha o escopo da alteração claro;
3. avalie impactos em tenants, permissões e dados pessoais;
4. documente migrations, variáveis de ambiente e estratégia de rollback quando aplicável;
5. informe os comandos de validação executados;
6. não publique dados pessoais ou segredos;
7. garanta que os checks obrigatórios estejam aprovados antes do merge.

---

## Propriedade intelectual e licença

O SGS, incluindo código-fonte, identidade, arquitetura, documentação, fluxos, integrações, componentes e regras de negócio, constitui software proprietário.

**Todos os direitos são reservados.**

A disponibilização pública deste repositório não concede licença de uso, reprodução, redistribuição, modificação, comercialização, sublicenciamento ou criação de trabalhos derivados.

Qualquer utilização além da leitura e avaliação técnica depende de autorização formal e expressa do proprietário.
