import { scopeBrowserCacheKey } from '@/lib/cache-scope';

export type PaginatedResponse<T> = {
  data: T[];
  total: number;
  page: number;
  lastPage: number;
};

export type CursorPaginatedResponse<T> = {
  data: T[];
  cursor: string | null;
  hasMore: boolean;
  total?: number;
};

type FetchAllPagesCacheEntry = {
  expiresAt: number;
  data: unknown[];
};

type FetchAllPagesProgressCallback = (
  loadedPages: number,
  totalPages: number,
  loadedItems: number,
) => void;

export class FetchAllPagesMaxPagesExceededError extends Error {
  readonly totalPages: number;
  readonly maxPages: number;
  readonly limit: number;

  constructor(params: { totalPages: number; maxPages: number; limit: number }) {
    super(
      `A consulta exigiu ${params.totalPages} páginas, acima do limite configurado de ${params.maxPages} (limit=${params.limit}).`,
    );
    this.name = "FetchAllPagesMaxPagesExceededError";
    this.totalPages = params.totalPages;
    this.maxPages = params.maxPages;
    this.limit = params.limit;
  }
}

const DEFAULT_FETCH_ALL_PAGES_CACHE_TTL_MS = 30_000;
const fetchAllPagesCache = new Map<string, FetchAllPagesCacheEntry>();
let fetchAllPagesCacheGeneration = 0;

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal) {
    return;
  }

  if (signal.aborted) {
    throw new DOMException("Operação cancelada", "AbortError");
  }
}

function getCachedFetchAllPagesData<T>(cacheKey?: string): T[] | null {
  if (!cacheKey) {
    return null;
  }

  const scopedCacheKey = scopeBrowserCacheKey(cacheKey);
  const now = Date.now();
  const entry = fetchAllPagesCache.get(scopedCacheKey);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= now) {
    fetchAllPagesCache.delete(scopedCacheKey);
    return null;
  }

  return [...(entry.data as T[])];
}

function setCachedFetchAllPagesData<T>(
  cacheKey: string | undefined,
  data: T[],
  ttlMs: number,
  requestGeneration: number,
  requestScope?: string,
): void {
  if (!cacheKey || ttlMs <= 0) {
    return;
  }

  const scopedCacheKey = scopeBrowserCacheKey(cacheKey);
  if (
    requestGeneration !== fetchAllPagesCacheGeneration ||
    (requestScope !== undefined && requestScope !== scopedCacheKey)
  ) {
    return;
  }

  fetchAllPagesCache.set(scopedCacheKey, {
    expiresAt: Date.now() + ttlMs,
    data: [...data],
  });
}

function resolveTotalPages<T>(first: PaginatedResponse<T>, limit: number): number {
  if (Number.isFinite(first.lastPage) && first.lastPage > 0) {
    return first.lastPage;
  }

  if (Number.isFinite(first.total) && first.total > 0) {
    return Math.max(1, Math.ceil(first.total / Math.max(1, limit)));
  }

  return 1;
}

export function clearFetchAllPagesCache(cacheKey?: string): void {
  fetchAllPagesCacheGeneration += 1;
  if (!cacheKey) {
    fetchAllPagesCache.clear();
    return;
  }

  fetchAllPagesCache.delete(scopeBrowserCacheKey(cacheKey));
}

export async function fetchAllPages<T>(opts: {
  fetchPage: (
    page: number,
    limit: number,
    signal?: AbortSignal,
  ) => Promise<PaginatedResponse<T>>;
  limit?: number;
  maxPages?: number;
  strictMaxPages?: boolean;
  batchSize?: number;
  signal?: AbortSignal;
  cacheKey?: string;
  cacheTtlMs?: number;
  onProgress?: FetchAllPagesProgressCallback;
}): Promise<T[]> {
  const requestGeneration = fetchAllPagesCacheGeneration;
  const requestScope = opts.cacheKey
    ? scopeBrowserCacheKey(opts.cacheKey)
    : undefined;
  const cached = getCachedFetchAllPagesData<T>(opts.cacheKey);
  if (cached) {
    const cachedTotalPages = Math.max(1, Math.ceil(cached.length / (opts.limit ?? 100)));
    opts.onProgress?.(cachedTotalPages, cachedTotalPages, cached.length);
    return cached;
  }

  assertNotAborted(opts.signal);

  const limit = opts.limit ?? 100;
  const maxPages = opts.maxPages ?? 50;
  const strictMaxPages = opts.strictMaxPages ?? true;
  const batchSize = Math.max(1, opts.batchSize ?? 3);
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_FETCH_ALL_PAGES_CACHE_TTL_MS;

  const first = await opts.fetchPage(1, limit, opts.signal);
  const totalPages = resolveTotalPages(first, limit);
  if (strictMaxPages && totalPages > maxPages) {
    throw new FetchAllPagesMaxPagesExceededError({
      totalPages,
      maxPages,
      limit,
    });
  }
  const pages = Math.min(totalPages, maxPages);
  const all = [...first.data];
  let loadedPages = 1;

  opts.onProgress?.(loadedPages, pages, all.length);

  if (pages <= 1) {
    setCachedFetchAllPagesData(
      opts.cacheKey,
      all,
      cacheTtlMs,
      requestGeneration,
      requestScope,
    );
    return all;
  }

  for (let page = 2; page <= pages; page += batchSize) {
    assertNotAborted(opts.signal);

    const batchPages = Array.from(
      { length: Math.min(batchSize, pages - page + 1) },
      (_, index) => page + index,
    );

    const responses = await Promise.all(
      batchPages.map((currentPage) =>
        opts.fetchPage(currentPage, limit, opts.signal),
      ),
    );

    responses.forEach((res) => {
      all.push(...res.data);
    });

    loadedPages += responses.length;
    opts.onProgress?.(loadedPages, pages, all.length);
  }

  setCachedFetchAllPagesData(
    opts.cacheKey,
    all,
    cacheTtlMs,
    requestGeneration,
    requestScope,
  );

  return all;
}
