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
