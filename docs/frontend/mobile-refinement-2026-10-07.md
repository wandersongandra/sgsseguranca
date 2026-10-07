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


## Rodada cirúrgica adicional

Achados e correções aplicados após a implementação inicial:

- RDO Editor: removidos `col-span-2` inválidos em grids de uma coluna no mobile; agora os spans começam somente no breakpoint apropriado.
- RDO Editor: altura mínima de 28rem deixou de ser forçada em telefones pequenos.
- RDO Editor: rodapé reorganizado para uma ou duas colunas conforme largura útil.
- PT / Medições Atmosféricas: corrigido span implícito abaixo de 360px e inputs mantidos em tamanho seguro para iOS.
- Checklist Filters: campo de busca ganhou `min-width: 0`; controles foram reorganizados para largura estreita.
- Checklist Filters: o seletor de colunas, que só afeta a tabela desktop, deixou de aparecer no mobile.
- Checklist Mobile Card: ação destrutiva não força duas colunas quando o card já colapsou para uma.
- Command Palette: passou a respeitar safe areas, altura dinâmica da viewport e teclado virtual; resultados longos quebram linha sem overflow.
- RDO Action Modals: aderiram ao contrato de sheet mobile já usado pelo visualizador.
- Dashboard shell: removido padding-top duplicado após banners de empresa/obra.
- Auditoria estrutural final: CSS segue balanceado e não foram encontrados spans mobile inválidos nos arquivos críticos tocados nesta rodada.


## Rodada cirúrgica adicional

Aplicada após a primeira implementação mobile, com foco em falhas de telas estreitas e densidade de uso em campo.

### Ajustes

- RDO:
  - todos os modais legados de assinatura, e-mail, exclusão, cancelamento e visualização seguem o contrato de bottom sheet;
  - tabelas de mão de obra, equipamentos e materiais passam a leitura vertical em telas mobile, preservando tabela no desktop;
  - rodapés de modal evitam colisão de ações longas em 320–399px.
- Notificações:
  - painel deixa de depender do dropdown preso ao sino no mobile e passa a flutuar acima da navegação inferior.
- Menus de ações:
  - trigger de 44px e menu fixo acima da bottom navigation no mobile.
- APR:
  - stepper horizontal compacto em telas estreitas;
  - breadcrumb reduzido no mobile;
  - ações do cabeçalho em duas colunas, com Salvar APR em destaque;
  - drawer avançado usa safe area, rodapé responsivo e esconde densidade de tabela no mobile.
- PT:
  - stepper horizontal compacto;
  - resumo lateral detalhado fica restrito ao desktop;
  - copy de modo campo tornou-se operacional, sem descrever adaptação de interface.
- DDS:
  - remoção do bloco visual com gradiente e de copy meta;
  - redução de padding e espaçamento em cards apenas no mobile;
  - linguagem direta em Preparação do DDS.
- Não conformidade:
  - navegação das 13 seções com scroll-snap e touch target de 44px;
  - 14 seções reduziram padding no mobile, preservando desktop;
  - modal de câmera deixou de impor largura concorrente ao ModalFrame.
- StatusSelect:
  - deixou de usar formato pill como controle interativo e passou ao contrato de campo compacto.
- ActionMenu:
  - menu mobile não fica mais preso aos limites do card.
- Teste de regressão:
  - criado `frontend/app/dashboard/mobileSurgicalResponsivePattern.test.ts` para bloquear regressões dos padrões acima.

### Auditoria estática desta rodada

- CSS global balanceado: 561 chaves de abertura e 561 de fechamento no checkpoint da auditoria.
- zero ocorrências do padrão antigo de modal RDO centralizado nos arquivos revisados;
- zero ocorrências das copies meta marcadas na auditoria;
- nenhum merge ou deploy executado.


## Rodada cirúrgica — 2026-10-07

A segunda passada focou somente em defeitos que aparecem em telas estreitas ou em interação real:

- corrigido grid implícito no editor de RDO: campos `col-span-2` agora só expandem a partir de `sm`;
- corrigido o mesmo risco nas medições atmosféricas da PT abaixo de 360px;
- editor de RDO deixa de impor altura mínima excessiva no celular e o rodapé passa a reorganizar ações em 2 colunas / 1 coluna abaixo de 400px;
- modais de assinatura e envio por e-mail do RDO migrados para o `ModalFrame` compartilhado;
- Command Palette recebeu safe-area, altura dinâmica, scroll interno e alvos de toque de 44px;
- SOPHIE recebeu alvos de toque maiores em fechar/anexar/enviar e sugestões deixaram de usar pills pequenas;
- Checklist e DDS agora declaram suas barras sticky como zonas reservadas para a SOPHIE;
- filtros do Checklist reorganizados para largura estreita;
- seletor de obra da fila do dashboard passa a bottom-sheet/floating sheet no mobile e nomes longos não expandem a viewport;
- filtros e controles da fila passam a respeitar 44px;
- resumo da APR reduz densidade visual em 320–430px e evita duas métricas comprimidas abaixo de 360px;
- toolbar da APR recebeu marcadores próprios para comportamento mobile;
- contrato `.ds-form-sticky-bar` corrigido para ficar acima da bottom navigation;
- regras duplicadas de RDO/Checklist foram consolidadas no bloco cirúrgico;
- teste do Command Palette atualizado para o rótulo acessível atual `Fechar busca`.

Auditoria estática final desta rodada:
- `globals.css`: 569 chaves de abertura / 569 de fechamento;
- principais arquivos TSX tocados: blocos JSX balanceados na inspeção textual;
- zero referências aos overlays legados dentro de `RdoActionModals`;
- Checklist e DDS expõem `data-sophie-reserved-zone="bottom"`;
- zero resíduos encontrados de `Fechar palette`, `Proxima`, `item(ns)` ou caractere de substituição nos arquivos auditados.

A execução real de Jest/Playwright e a validação visual em navegador continuam pendentes enquanto o ambiente de CI/runtime não executar os jobs.


## Rodada cirúrgica adicional

Ajustes aplicados após a primeira implementação:

- filtros de PT e APR deixam de impor largura mínima no mobile;
- filtros avançados de APR agora funcionam como bottom sheet no mobile e drawer lateral no desktop;
- footer dos filtros avançados usa grade de ações adequada à largura disponível;
- navegação por seções da Não Conformidade recebeu labels acessíveis completos;
- navegação horizontal de etapas ganhou overscroll controlado e scrollbar oculta no mobile;
- sticky da navegação interna foi reposicionado dentro do scroll container do dashboard;
- launcher flutuante da SOPHIE é ocultado quando existe barra de ação mobile crítica; acesso permanece pela topbar;
- grids de detalhes colapsam para uma coluna abaixo de 360px;
- paginação recebe tratamento específico para telas extremamente estreitas;
- filtros e painéis revisados para evitar min-width rígido e colisão com teclado/safe area;
- CSS desta rodada permaneceu estruturalmente balanceado.
