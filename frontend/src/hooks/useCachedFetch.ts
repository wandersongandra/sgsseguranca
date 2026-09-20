'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { recordClientMetric } from '@/lib/perf/clientMetrics';
import { resolveBrowserCacheScope } from '@/lib/cache-scope';

type CacheEntry<TResult> = {
  value?: TResult;
  expiresAt: number;
  inflight?: Promise<TResult>;
  lastAccessedAt: number;
};

const memoryCache = new Map<string, CacheEntry<unknown>>();
const CACHE_CLEANUP_INTERVAL_MS = 60_000;
const MAX_MEMORY_CACHE_ENTRIES = 500;
let lastCacheCleanupAt = 0;
let cacheGeneration = 0;

function maybePruneCache(force = false) {
  const now = Date.now();
  if (
    !force &&
    now - lastCacheCleanupAt < CACHE_CLEANUP_INTERVAL_MS &&
    memoryCache.size <= MAX_MEMORY_CACHE_ENTRIES
  ) {
    return;
  }

  lastCacheCleanupAt = now;

  for (const [key, entry] of memoryCache.entries()) {
    if (!entry.inflight && entry.expiresAt <= now) {
      memoryCache.delete(key);
    }
  }

  if (memoryCache.size <= MAX_MEMORY_CACHE_ENTRIES) {
    return;
  }

  const evictableEntries = Array.from(memoryCache.entries())
    .filter(([, entry]) => !entry.inflight)
    .sort(
      (left, right) =>
        (left[1].lastAccessedAt ?? 0) - (right[1].lastAccessedAt ?? 0),
    );

  const overflow = memoryCache.size - MAX_MEMORY_CACHE_ENTRIES;
  for (
    let index = 0;
    index < overflow && index < evictableEntries.length;
    index += 1
  ) {
    const [entryKey] = evictableEntries[index]!;
    memoryCache.delete(entryKey);
  }
}

function buildCacheKey(
  baseKey: string,
  args: readonly unknown[],
  scope?: string,
) {
  const scopedBaseKey = scope ? `${baseKey}@${scope}` : baseKey;
  if (args.length === 0) {
    return scopedBaseKey;
  }

  return `${scopedBaseKey}:${JSON.stringify(args)}`;
}

export function clearCachedFetches(): void {
  cacheGeneration += 1;
  memoryCache.clear();
  lastCacheCleanupAt = Date.now();
}

export interface CachedFetchController<TArgs extends unknown[], TResult> {
  fetch: (...args: TArgs) => Promise<TResult>;
  invalidate: (...args: TArgs) => void;
  invalidateAll: () => void;
}

/**
 * Opcoes opcionais para configurar o comportamento do hook.
 */
export interface CachedFetchOptions {
  /**
   * Quando true (padrao), invalida o cache e re-busca os dados quando o usuario
   * retorna a aba/janela apos ela ter ficado inativa. Util para garantir que
   * dados exibidos apos longa ausencia sejam atualizados automaticamente.
   */
  revalidateOnFocus?: boolean;
  /**
   * Args fixos para o re-fetch disparado pelo foco de aba.
   * Se omitido, nenhum re-fetch automatico ocorre (apenas invalidacao).
   */
  revalidateArgs?: unknown[];
}

export function useCachedFetch<TArgs extends unknown[], TResult>(
  cacheKey: string,
  fetcher: (...args: TArgs) => Promise<TResult>,
  ttlMs: number,
  options?: CachedFetchOptions,
): CachedFetchController<TArgs, TResult> {
  const fetchWithCache = useCallback(
    async (...args: TArgs): Promise<TResult> => {
      maybePruneCache();
      const resolvedKey = buildCacheKey(
        cacheKey,
        args,
        resolveBrowserCacheScope(),
      );
      const now = Date.now();
      const requestGeneration = cacheGeneration;
      const requestScope = resolveBrowserCacheScope();
      const existingEntry = memoryCache.get(resolvedKey) as
        | CacheEntry<TResult>
        | undefined;

      if (
        existingEntry &&
        existingEntry.value !== undefined &&
        existingEntry.expiresAt > now
      ) {
        existingEntry.lastAccessedAt = now;
        recordClientMetric({
          name: 'cache_hit',
          key: resolvedKey,
          ttlMs,
        });
        return existingEntry.value;
      }

      if (existingEntry?.inflight) {
        recordClientMetric({
          name: 'cache_inflight_reuse',
          key: resolvedKey,
          ttlMs,
        });
        return existingEntry.inflight;
      }

      const startedAt = performance.now();
      recordClientMetric({
        name: 'cache_miss',
        key: resolvedKey,
        ttlMs,
      });

      const inflight = fetcher(...args)
        .then((result) => {
          const durationMs = performance.now() - startedAt;
          if (
            requestGeneration === cacheGeneration &&
            requestScope === resolveBrowserCacheScope()
          ) {
            memoryCache.set(resolvedKey, {
              value: result,
              expiresAt: Date.now() + ttlMs,
              lastAccessedAt: Date.now(),
            });
          }
          recordClientMetric({
            name: 'fetch_success',
            key: resolvedKey,
            ttlMs,
            durationMs,
          });
          return result;
        })
        .catch((error: unknown) => {
          const durationMs = performance.now() - startedAt;
          if (
            requestGeneration === cacheGeneration &&
            requestScope === resolveBrowserCacheScope()
          ) {
            if (existingEntry?.value !== undefined) {
              memoryCache.set(resolvedKey, {
                value: existingEntry.value,
                expiresAt: existingEntry.expiresAt,
                lastAccessedAt: existingEntry.lastAccessedAt ?? Date.now(),
              });
            } else {
              memoryCache.delete(resolvedKey);
            }
          }

          recordClientMetric({
            name: 'fetch_error',
            key: resolvedKey,
            ttlMs,
            durationMs,
            detail: {
              message: error instanceof Error ? error.message : String(error),
            },
          });

          throw error;
        });

      memoryCache.set(resolvedKey, {
        value: existingEntry?.value,
        expiresAt: existingEntry?.expiresAt ?? 0,
        inflight,
        lastAccessedAt: now,
      });

      return inflight;
    },
    [cacheKey, fetcher, ttlMs],
  );

  const invalidate = useCallback(
    (...args: TArgs) => {
      cacheGeneration += 1;
      const resolvedKey = buildCacheKey(
        cacheKey,
        args,
        resolveBrowserCacheScope(),
      );
      memoryCache.delete(resolvedKey);
      maybePruneCache(true);
      recordClientMetric({
        name: 'cache_invalidate',
        key: resolvedKey,
        ttlMs,
      });
    },
    [cacheKey, ttlMs],
  );

  const invalidateAll = useCallback(() => {
    cacheGeneration += 1;
    const keyPrefix = `${cacheKey}:`;
    const scopedPrefix = `${cacheKey}@`;
    let deletedCount = 0;

    for (const key of memoryCache.keys()) {
      if (
        key === cacheKey ||
        key.startsWith(keyPrefix) ||
        key.startsWith(scopedPrefix)
      ) {
        memoryCache.delete(key);
        deletedCount += 1;
      }
    }
      maybePruneCache(true);
      recordClientMetric({
        name: 'cache_invalidate_all',
        key: cacheKey,
      ttlMs,
      detail: { deletedCount },
    });
  }, [cacheKey, ttlMs]);

  // Ref para evitar que o callback de foco capture versoes stale de invalidateAll/fetchWithCache
  const controllerRef = useRef({ invalidateAll, fetchWithCache });
  useEffect(() => {
    controllerRef.current = { invalidateAll, fetchWithCache };
  }, [invalidateAll, fetchWithCache]);

  // Revalidacao automatica quando o usuario retorna a aba.
  // Invalida o cache client-side e, se `revalidateArgs` for fornecido, dispara
  // o re-fetch imediatamente para que o dado fresco esteja pronto ao renderizar.
  useEffect(() => {
    const { revalidateOnFocus = true, revalidateArgs } = options ?? {};

    if (!revalidateOnFocus || typeof window === 'undefined') {
      return;
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') {
        return;
      }

      controllerRef.current.invalidateAll();

      if (revalidateArgs !== undefined) {
        void controllerRef.current.fetchWithCache(
          ...(revalidateArgs as TArgs),
        );
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- options e primitiva config, nao precisa ser dep
  }, [options?.revalidateOnFocus]);

  return useMemo(
    () => ({
      fetch: fetchWithCache,
      invalidate,
      invalidateAll,
    }),
    [fetchWithCache, invalidate, invalidateAll],
  );
}
