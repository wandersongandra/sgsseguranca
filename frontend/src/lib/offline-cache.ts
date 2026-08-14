import { sanitizeSensitiveDraftValue } from "./sensitive-draft-sanitizer";
import { secureOfflineDB } from "./offline-db-secure";
import { logger } from "./logger";

type CacheEnvelope<T> = {
  value: T;
  createdAt: string;
  maxAgeMs?: number;
};

export type OfflineCacheContext = Readonly<{
  generation: number;
  tenantId: string;
}>;

export type StaleResult<T> = { stale: true; data: T };

export function isStaleResult<T>(result: T | StaleResult<T>): result is StaleResult<T> {
  return (
    typeof result === "object" &&
    result !== null &&
    "stale" in (result as object) &&
    (result as Record<string, unknown>).stale === true
  );
}

export const CACHE_TTL = {
  CACHE_TTL_CRITICAL: 120_000,
  CRITICAL: 120_000,
  LIST: 300_000,
  RECORD: 1_800_000,
  REFERENCE: 3_600_000,
} as const;

const PREFIX = "gst.cache";
const LEGACY_PREFIX = "compliancex.cache";
const CACHE_PREFIXES = [`${PREFIX}.`, `${LEGACY_PREFIX}.`];
const TENANT_STORAGE_KEY = "cx_selected_tenant";
const NO_TENANT = "no-tenant";
const isBrowser = () => typeof window !== "undefined";
const isOnline = () => typeof navigator !== "undefined" ? navigator.onLine : true;
const isManagedCacheKey = (key: string) =>
  CACHE_PREFIXES.some((prefix) => key.startsWith(prefix));

const currentTenantId = (): string => {
  if (!isBrowser()) return NO_TENANT;
  try {
    const raw = window.sessionStorage.getItem(TENANT_STORAGE_KEY);
    const value = raw ? (JSON.parse(raw) as { companyId?: unknown }) : null;
    return typeof value?.companyId === "string" && value.companyId
      ? value.companyId
      : NO_TENANT;
  } catch {
    return NO_TENANT;
  }
};

let cacheGeneration = 0;
const pendingWrites = new Map<Promise<void>, number>();
const _memoryCache = new Map<string, CacheEnvelope<unknown>>();

export const createOfflineCacheContext = (): OfflineCacheContext => ({
  generation: cacheGeneration,
  tenantId: currentTenantId(),
});

const buildKey = (
  key: string,
  context: OfflineCacheContext = createOfflineCacheContext(),
  prefix = PREFIX,
) => `${prefix}.tenant.${encodeURIComponent(context.tenantId)}.${key}`;

// IndexedDB hydration is epoch guarded: a tenant cleanup that happens while
// keys/get are pending invalidates this hydration and prevents memory leaks.
if (isBrowser()) {
  const initializationGeneration = cacheGeneration;
  secureOfflineDB.keys("sgs-cache")
    .then(async (keys) => {
      for (const dbKey of keys) {
        const envelope = await secureOfflineDB.get<CacheEnvelope<unknown>>(
          "sgs-cache",
          dbKey,
        );
        if (envelope && initializationGeneration === cacheGeneration) {
          _memoryCache.set(dbKey, envelope);
        }
      }
      try {
        for (const rawKey of Object.keys(window.localStorage)) {
          if (isManagedCacheKey(rawKey)) window.localStorage.removeItem(rawKey);
        }
      } catch {
        // best effort legacy cleanup
      }
    })
    .catch((err) => {
      logger.warn("Falha ao inicializar cache do IndexedDB em memoria:", err);
    });
}

const removeCacheKey = (key: string) => {
  _memoryCache.delete(key);
  if (isBrowser()) void secureOfflineDB.del("sgs-cache", key);
};

export const setOfflineCache = <T>(
  key: string,
  value: T,
  maxAgeMs: number | undefined,
  context: OfflineCacheContext,
): void => {
  if (!isBrowser()) return;
  // A response started before a tenant/cache epoch transition cannot write
  // into the current tenant namespace.
  if (
    context.generation !== cacheGeneration ||
    context.tenantId !== currentTenantId()
  ) return;

  const payload: CacheEnvelope<unknown> = {
    value: sanitizeSensitiveDraftValue(value),
    createdAt: new Date().toISOString(),
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
  };
  const primaryKey = buildKey(key, context);
  _memoryCache.set(primaryKey, payload);

  const write = secureOfflineDB
    .set("sgs-cache", primaryKey, payload)
    .then(() => undefined);
  pendingWrites.set(write, context.generation);
  void write.finally(() => pendingWrites.delete(write));
};

export const getOfflineCache = <T>(
  key: string,
  context: OfflineCacheContext = createOfflineCacheContext(),
): T | StaleResult<T> | null => {
  if (!isBrowser()) return null;
  if (
    context.generation !== cacheGeneration ||
    context.tenantId !== currentTenantId()
  ) return null;

  const primaryKey = buildKey(key, context);
  const parsed = _memoryCache.get(primaryKey) as CacheEnvelope<T> | undefined;
  if (!parsed) return null;
  if (!parsed.createdAt) {
    removeCacheKey(primaryKey);
    return null;
  }

  if (parsed.maxAgeMs !== undefined) {
    const ageMs = Date.now() - new Date(parsed.createdAt).getTime();
    if (ageMs > parsed.maxAgeMs) {
      if (isOnline()) {
        removeCacheKey(primaryKey);
        return null;
      }
      return { stale: true, data: parsed.value };
    }
  }
  return parsed.value;
};

export const consumeOfflineCache = <T>(
  key: string,
  context: OfflineCacheContext = createOfflineCacheContext(),
): T | null => {
  const result = getOfflineCache<T>(key, context);
  if (result === null) return null;
  if (isStaleResult(result)) {
    if (isBrowser()) {
      window.dispatchEvent(new CustomEvent("app:stale-cache", { detail: { key } }));
    }
    return result.data;
  }
  return result;
};

export const clearExpiredCache = (): void => {
  if (!isBrowser()) return;
  for (const [rawKey, parsed] of Array.from(_memoryCache.entries())) {
    if (!isManagedCacheKey(rawKey) || !parsed?.createdAt || !parsed?.maxAgeMs) continue;
    const ageMs = Date.now() - new Date(parsed.createdAt).getTime();
    if (ageMs > parsed.maxAgeMs) removeCacheKey(rawKey);
  }
};

/** Clears the synchronous mirror and invalidates every captured request context. */
export const clearOfflineMemoryCache = (): void => {
  cacheGeneration += 1;
  _memoryCache.clear();
};

/**
 * Invalidates memory immediately, drains old-epoch writes, then clears the
 * persistent store. This prevents an old async write from surviving cleanup.
 */
export const clearOfflineCache = async (): Promise<void> => {
  const oldGeneration = cacheGeneration;
  clearOfflineMemoryCache();
  const oldWrites = Array.from(pendingWrites.entries())
    .filter(([, generation]) => generation <= oldGeneration)
    .map(([write]) => write.catch(() => undefined));
  await Promise.all(oldWrites);
  if (isBrowser()) await secureOfflineDB.clear("sgs-cache");
};

export const isOfflineRequestError = (error: unknown) => {
  const code = (error as { code?: string })?.code;
  return (
    code === "ERR_NETWORK" ||
    code === "ECONNABORTED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT"
  );
};
