# Estratégia de cache no frontend

O frontend tem **quatro** mecanismos de cache/storage no browser, cada um com propósito e escopo
diferentes. Este documento existe porque a adoção de `useCachedFetch` é baixa (só ~7 das 101
páginas do dashboard usam) e não havia registro de quando usar cada mecanismo — não é uma proposta
de migração, é a convenção para código novo e para decidir se vale portar uma página existente.

## 1. `useCachedFetch` — leitura com TTL (a opção padrão)

`frontend/src/hooks/useCachedFetch.ts`

Cache em memória (`Map` global, não sobrevive a reload de página) com:

- TTL por chamada (`ttlMs`), dedupe de requisições em voo (`inflight`), eviction LRU acima de
  `MAX_MEMORY_CACHE_ENTRIES = 500`;
- revalidação automática ao focar a aba (`revalidateOnFocus`, ligado por padrão);
- escopo automático por tenant/sessão via `resolveBrowserCacheScope()`
  (`frontend/src/lib/cache-scope.ts`) — a mesma chave lógica não vaza dados entre empresas/usuários;
- métricas via `recordClientMetric` (`cache_hit`/`cache_miss`/`cache_inflight_reuse`).

**Use quando:** a página busca uma lista/resumo que não muda a cada segundo (summary de KPIs,
lookups de sites/workers para populate de formulário, listas de referência) e você quer evitar
refetch a cada navegação de volta pra página.

```tsx
const catsSummaryCache = useCachedFetch(
  CACHE_KEYS.catsSummary,
  catsService.getSummary,
  SUMMARY_CACHE_TTL_MS,
);
// ...
const summary = await catsSummaryCache.fetch();
```

**Não use para:** dados que precisam estar sempre frescos no primeiro render (ex.: fila de
pendências que o usuário está prestes a aprovar) — nesses casos, `useEffect` + fetch direto (o
padrão que a maioria das páginas já usa) continua correto.

## 2. `fetchAllPages` — cache de paginação completa

`frontend/src/services/pagination.ts` (`fetchAllPagesCache`)

Cache próprio, também em memória e escopado por tenant (via `scopeBrowserCacheKey`), mas com
propósito distinto: memorizar o resultado de **buscar todas as páginas de um recurso** (usado por
telas que precisam da lista inteira, não paginada, ex.: exports, selects com muitas opções). Não
compartilha estado com `useCachedFetch` — são dois `Map`s diferentes.

**Use quando:** já está chamando `fetchAllPages(...)` para montar uma lista completa e quer evitar
repetir isso a cada re-render/navegação.

## 3. `offline-cache` — persistência offline/PWA

`frontend/src/lib/offline-cache.ts` + `frontend/src/lib/offline-db-secure.ts`
(IndexedDB via `secureOfflineDB`, prefixos `gst.cache.`/`compliancex.cache.` legado)

Não é um cache de performance — é a camada que permite o app funcionar (ler dados já vistos)
**sem rede**, com TTLs em `CACHE_TTL` (`CRITICAL`/`LIST`/`RECORD`/`REFERENCE`, de 2min a 1h) e
suporte a retornar dado "stale" (`isStaleResult`) quando offline. Sobrevive a reload de página
(IndexedDB), diferente de `useCachedFetch`/`fetchAllPages` (memória, perdido no F5).

**Use quando:** o dado precisa estar disponível no modo offline/PWA (campo, obra sem sinal).
**Não use** como substituto de `useCachedFetch` para telas puramente online — é mais pesado e tem
semântica de staleness diferente.

## 4. `localStorage` direto — rascunho de formulário (autosave), não cache de leitura

Ex.: `ChecklistForm.tsx`, `PtForm.tsx`, `AIButton.tsx`, `OnboardingModal.tsx`.

Isso não é "cache" no sentido de evitar refetch — é persistência de **rascunho não salvo** do
usuário (autosave de formulário longo) para sobreviver a um refresh acidental. Continue usando
`localStorage.setItem` direto para isso; não tem por que passar por `useCachedFetch`. Ao adicionar
um novo autosave, sempre limpe a chave no submit bem-sucedido e considere registrar o prefixo em
`browser-sensitive-storage.ts` (limpeza no logout/troca de tenant).

## Resumo — qual usar

| Preciso de... | Use |
|---|---|
| Evitar refetch de uma lista/summary ao navegar de volta pra página | `useCachedFetch` |
| A lista **completa** de um recurso paginado (export, select grande) | `fetchAllPages` (cache embutido) |
| O app funcionar sem internet (campo/obra) | `offline-cache` / `secureOfflineDB` |
| Não perder o que o usuário digitou num formulário longo se a aba recarregar | `localStorage` direto (autosave) |
| Dado que precisa estar sempre fresco no primeiro render | Nenhum — `useEffect` + fetch direto |

Não há prazo definido para migrar as ~93% de páginas que hoje fazem fetch direto sem
`useCachedFetch` — isso é dívida técnica de adoção, não um bug. Ao tocar numa página existente que
busca dados que se beneficiariam de TTL (lookups, summaries), prefira migrar para `useCachedFetch`
em vez de replicar outro padrão de cache ad-hoc.
