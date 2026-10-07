# Plano de refinamento mobile — SGS

Data: 2026-10-07  
Branch: `improve/pdf-frontend-polish-20261007`  
PR: #446

## Objetivo

Elevar a experiência mobile do SGS sem alterar regras de negócio nem degradar o desktop. O foco é uso real em campo: leitura rápida, toque confiável, formulários longos, listas densas, modais, navegação e safe areas.

## Fase 1 — Fundação responsiva

- Consolidar safe areas, espaçamento lateral e clearance da navegação inferior.
- Evitar overflow horizontal acidental.
- Garantir 16px em campos nativos no mobile para impedir zoom automático no iOS.
- Padronizar touch targets mínimos de 44px.

## Fase 2 — Navegação e shell

- Refinar topbar e drawer mobile.
- Melhorar navegação inferior para cinco destinos com estados ativos discretos.
- Tornar banners de empresa/obra responsivos e sem colisões.
- Preservar espaço para navegação, barra de ações e SOPHIE.

## Fase 3 — Hierarquia de páginas

- Compactar PageHeader em telas estreitas.
- Empilhar ações sem apertar título/descrição.
- Melhorar legibilidade de títulos, descrições e contexto.

## Fase 4 — Formulários

- Reduzir padding excessivo em seções.
- Tornar ações finais confortáveis para uma mão.
- Melhorar grids, field groups e áreas sticky.
- Evitar que barra de ações cubra campos e mensagens.

## Fase 5 — Listas, tabelas e cards

- Padronizar cards mobile.
- Melhorar grupos de ações e metadados.
- Evitar tabelas horizontais como experiência principal em telas pequenas.
- Ajustar paginação para largura reduzida.

## Fase 6 — Modais e drawers

- Converter modal central em comportamento de bottom sheet no mobile.
- Aplicar safe area no rodapé.
- Ações primárias com largura adequada e scroll interno previsível.

## Fase 7 — Dashboard e páginas críticas

- Refinar ações principais, KPIs e blocos operacionais.
- Revisar APR, PT, Checklist, CAT, Treinamentos e cadastros.
- Priorizar informação operacional sobre decoração.

## Fase 8 — Acessibilidade e ergonomia

- Touch targets de 44px.
- Foco visível e navegação por teclado.
- Labels acessíveis.
- Respeito a reduced motion.
- Truncamento somente onde não elimina informação essencial.

## Fase 9 — QA

- Atualizar testes afetados.
- Revisar padrões mobile duplicados.
- Validar 320px, 360px, 390px, 430px, 768px e transição para desktop.
- Não promover para produção antes dos gates do SGS.


## Status da implementação

Implementado nesta rodada:

- Fase 1 — Fundação responsiva: concluída no código.
- Fase 2 — Navegação e shell: concluída no código.
- Fase 3 — Hierarquia de páginas: concluída no design system compartilhado.
- Fase 4 — Formulários: concluída na base e nos fluxos críticos de APR, PT, Checklist e DDS.
- Fase 5 — Listas, tabelas e cards: concluída na abstração compartilhada e nos principais cards operacionais.
- Fase 6 — Modais e drawers: ModalFrame convertido para bottom sheet em mobile; fluxos antigos de DDS, Checklist e RDO alinhados.
- Fase 7 — Dashboard e páginas críticas: hero, KPIs, atalhos e cards de APR/PT/Checklist/CAT/Treinamentos refinados.
- Fase 8 — Acessibilidade e ergonomia: touch targets, safe areas, iOS field focus, semântica de listas e labels revisados.
- Fase 9 — QA: auditoria estática concluída; execução integral de testes/E2E e validação visual em navegador ainda depende de ambiente de CI/runtime funcional.

### Critérios aplicados

- Campos nativos com 16px em mobile para evitar zoom automático no Safari/iOS.
- Alvos de toque com mínimo de 44px.
- Navegação inferior e barras de ação respeitam safe area.
- Modais compartilhados se comportam como bottom sheet abaixo de 768px.
- Conteúdo recebe clearance para navegação inferior e barras sticky.
- Listagens mobile montam somente a árvore interativa ativa.
- Desktop preservado por regras responsivas e breakpoints existentes.
