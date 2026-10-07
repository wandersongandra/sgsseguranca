# Refinamento visual do frontend — 2026-10-07

## Objetivo

Elevar a interface do SGS sem alterar regras de negócio, contratos de API, RBAC, multi-tenant ou fluxos documentais. A direção visual é de software técnico de SST: claro, sóbrio, denso o suficiente para operação diária e sem linguagem ou ornamentos genéricos.

## Princípios

- conteúdo e estado operacional acima de decoração;
- tipografia legível, sem excesso de negrito;
- superfícies brancas e neutras, com azul reservado para ação e navegação;
- bordas discretas, sombras mínimas e cantos moderados;
- sem gradientes decorativos ou cartões para informação que pode ser apresentada de forma plana;
- cores semânticas somente para risco, alerta, sucesso, erro e informação;
- comportamento responsivo e acessível preservado;
- animações curtas e funcionais, respeitando `prefers-reduced-motion`.

## Fases

### Fase 1 — Fundação visual
Ajustar tokens de cor, borda, raio, sombra, tipografia e densidade. Reduzir o aspecto excessivamente azulado/arredondado e criar uma base neutra consistente.

### Fase 2 — Shell e navegação
Refinar topbar, sidebar, seletores de empresa/obra e espaçamento do conteúdo. Melhorar leitura da navegação e reduzir elementos com aparência de “cockpit” genérico.

### Fase 3 — Componentes compartilhados
Padronizar cards, campos, botões, tabelas, métricas, estados e badges. Campos devem usar peso regular/médio; tabelas devem priorizar leitura; cards devem ter profundidade mínima.

### Fase 4 — Layouts de página
Refinar `PageHeader`, `ListPageLayout` e `FormPageLayout` para hierarquia clara, ações previsíveis e largura/ritmo consistentes entre módulos.

### Fase 5 — Dashboard
Manter indicadores realmente operacionais, simplificar textos, reduzir blocos decorativos e reforçar pendências, risco, conformidade e ações principais.

### Fase 6 — Responsividade e acessibilidade
Revisar alvos de toque, foco visível, contraste, overflow de tabelas, barras de ação mobile, safe areas e movimento reduzido.

### Fase 7 — QA
Executar TypeScript, lint, testes unitários relevantes e build. A validação de ambiente deve seguir `docs/OPERACAO-CANONICA-SGS.md`: primeiro na VPS de teste isolada; produção somente após gates verdes e autorização explícita.


## Status de execução

### Fase 1 — Fundação visual — CONCLUÍDA
Tokens de cor, borda, raio, sombra, tipografia e densidade foram refinados. O frontend passou a usar superfícies mais neutras, azul institucional mais sóbrio, cantos menores e sombras discretas.

### Fase 2 — Shell e navegação — CONCLUÍDA
Topbar, sidebar, seletores de empresa/obra e navegação mobile foram refinados. O shell preserva safe areas, foco e escopo de empresa/obra.

### Fase 3 — Componentes compartilhados — CONCLUÍDA
Cards, botões, inputs, selects, textareas, tabelas, métricas, estados, callouts, modais e barra de ações mobile foram alinhados ao mesmo padrão visual.

### Fase 4 — Layouts e formulários — CONCLUÍDA
Page headers, listas, formulários e telas de cadastro foram simplificados. Textos que comentavam o próprio design, como “fluxo guiado”, “leitura rápida”, “ruído visual” e equivalentes, foram substituídos por instruções operacionais.

### Fase 5 — Dashboard e módulos operacionais — CONCLUÍDA
Dashboard principal, visão TST, DDS, DID, APR, ARR, PT, NC, auditoria, importação, usuários, atividades, treinamentos, RDO e superfícies auxiliares receberam refinamento visual e de copy.

### Fase 6 — Responsividade e acessibilidade — CONCLUÍDA
Safe areas, navegação inferior, alvos de toque, foco visível e `prefers-reduced-motion` foram preservados. Animações foram reduzidas e priorizam mudança de cor/estado em vez de movimento decorativo.

### Fase 7 — QA — PARCIALMENTE CONCLUÍDA
- branch: `improve/pdf-frontend-polish-20261007`;
- PR draft: #446;
- branch 0 commits atrás de `main`;
- PR reportado pelo GitHub como mergeable;
- Snyk: PASS;
- CodeRabbit status: PASS;
- revisão do patch: sem marcadores de conflito, sem novos `rounded-2xl`, `transition-all`, blur pesado ou textos meta de interface;
- GitHub Actions: BLOQUEADO por `startup_failure` antes da criação de jobs, inclusive em workflows do `main` anteriores a esta branch;
- lint, type-check, build e suítes completas continuam sem evidência de execução enquanto o Actions não iniciar os jobs;
- merge/deploy de produção não realizado.
