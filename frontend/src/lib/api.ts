import axios, {
  AxiosError,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import { tokenStore } from './tokenStore';
import { sessionStore } from './sessionStore';
import { authRefreshHint } from './authRefreshHint';
import { selectedTenantStore } from './selectedTenantStore';
import { normalizePublicApiBaseUrl } from './public-api-url';
import { isAdminGeralAccount } from './auth-session-state';
import { getBrowserSentrySync } from './sentry/browser-client';
import {
  OfflineCapabilityError,
  isOfflineActionAllowed,
  resolveOfflineRouteCapability,
} from './offline-capabilities';

const resolveBaseUrl = () => {
  const explicitApiUrl = normalizePublicApiBaseUrl(
    process.env.NEXT_PUBLIC_API_URL,
  );

  if (explicitApiUrl) {
    return explicitApiUrl;
  }

  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location;
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';

    if (isLocalHost) {
      // Padrão local: backend roda em 3011 (run-local.ps1 / LOCAL_SETUP.md)
      return `${protocol}//${hostname}:3011`;
    }
  }

  return null;
};

const API_BASE_URL = resolveBaseUrl();
const API_BASE_URL_ERROR_MESSAGE =
  'API não configurada para este ambiente. Defina NEXT_PUBLIC_API_URL de forma explícita no frontend. O único fallback automático permitido é localhost em desenvolvimento.';

export function getApiBaseUrl(): string | null {
  return API_BASE_URL;
}

export function buildApiUrl(path: string): string | null {
  if (!API_BASE_URL) {
    return null;
  }

  const normalizedBase = API_BASE_URL.endsWith('/')
    ? API_BASE_URL.slice(0, -1)
    : API_BASE_URL;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return `${normalizedBase}${normalizedPath}`;
}

type RetryConfig = AxiosRequestConfig & { __retryCount?: number };
type AuthRetryConfig = RetryConfig & {
  __authRetry?: boolean;
  __tenantRetry?: boolean;
};
export type TenantAwareAxiosRequestConfig = AxiosRequestConfig & {
  skipTenantHeader?: boolean;
};
const MAX_API_PAGE_LIMIT = 100;
let loginRedirectScheduled = false;

const notifyApiStatus = (online: boolean, baseURL?: string) => {
  if (typeof window === 'undefined') return;
  const eventName = online ? 'app:api-online' : 'app:api-offline';
  window.dispatchEvent(
    new CustomEvent(eventName, {
      detail: { baseURL },
    }),
  );
};

function extractErrorMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractErrorMessage).filter(Boolean).join(' ');
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return [
      extractErrorMessage(obj.message),
      extractErrorMessage(obj.error),
      extractErrorMessage(obj.details),
    ]
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

function isTenantContextError(value: unknown): boolean {
  const message = extractErrorMessage(value).toLowerCase();
  return [
    'tenant',
    'empresa divergente',
    'company_id divergente',
    'empresa não identificad',
    'empresa nao identificad',
    'empresa inválid',
    'empresa invalid',
    'empresa removid',
    'empresa inativ',
  ].some((needle) => message.includes(needle));
}

function readHeaderValue(
  headers:
    | InternalAxiosRequestConfig['headers']
    | AxiosRequestConfig['headers']
    | undefined,
  name: string,
): unknown {
  if (!headers) {
    return undefined;
  }

  const record = headers as Record<string, unknown> & {
    get?: (key: string) => unknown;
  };

  return record.get?.(name) ?? record[name] ?? record[name.toLowerCase()];
}

function removeHeaderValue(
  headers:
    | InternalAxiosRequestConfig['headers']
    | AxiosRequestConfig['headers']
    | undefined,
  name: string,
): void {
  if (!headers) {
    return;
  }

  const record = headers as Record<string, unknown> & {
    delete?: (key: string) => void;
  };

  record.delete?.(name);
  delete record[name];
  delete record[name.toLowerCase()];
}

function setHeaderValue(
  headers:
    | InternalAxiosRequestConfig['headers']
    | AxiosRequestConfig['headers']
    | undefined,
  name: string,
  value: string,
): void {
  if (!headers) {
    return;
  }

  const record = headers as Record<string, unknown> & {
    set?: (key: string, nextValue: string) => void;
  };

  record.set?.(name, value);
  record[name] = value;
}

function normalizeRequestPath(url?: string): string {
  if (!url) {
    return '';
  }

  try {
    const parsed = new URL(url, API_BASE_URL || 'http://localhost');
    return parsed.pathname;
  } catch {
    return url.split('?')[0] || '';
  }
}

function isPublicApiRequest(url?: string): boolean {
  const path = normalizeRequestPath(url);
  return (
    path.startsWith('/auth/login') ||
    path.startsWith('/auth/refresh') ||
    path.startsWith('/auth/csrf') ||
    path.startsWith('/auth/forgot-password') ||
    path.startsWith('/auth/reset-password') ||
    path.startsWith('/tenant-lifecycle/onboarding') ||
    path.startsWith('/health') ||
    path.startsWith('/public') ||
    path.startsWith('/validation') ||
    path.startsWith('/validar')
  );
}

function clampRequestLimit(config: AxiosRequestConfig) {
  const params = config.params as Record<string, unknown> | undefined;
  if (!params || !('limit' in params)) {
    return;
  }

  const numericLimit = Number(params.limit);
  if (!Number.isFinite(numericLimit)) {
    params.limit = MAX_API_PAGE_LIMIT;
    return;
  }

  params.limit = Math.min(
    Math.max(Math.floor(numericLimit), 1),
    MAX_API_PAGE_LIMIT,
  );
}

function scheduleLoginRedirect() {
  if (loginRedirectScheduled || typeof window === 'undefined') {
    return;
  }

  loginRedirectScheduled = true;
  window.setTimeout(() => {
    const currentPath = window.location.pathname;
    if (!currentPath.startsWith('/login')) {
      window.location.replace('/login?expired=1');
    }
    loginRedirectScheduled = false;
  }, 0);
}

function createAuthRequiredError(
  config: InternalAxiosRequestConfig,
): AxiosError {
  const response: AxiosResponse = {
    data: {
      success: false,
      statusCode: 401,
      message: 'Sessão expirada. Faça login novamente.',
      error: 'UNAUTHORIZED',
    },
    status: 401,
    statusText: 'Unauthorized',
    headers: {},
    config,
  };

  return new AxiosError(
    'Sessão expirada. Faça login novamente.',
    'ERR_AUTH_REQUIRED',
    config,
    undefined,
    response,
  );
}

const refreshClient = axios.create({
  baseURL: API_BASE_URL || undefined,
  timeout: 15000,
  withCredentials: true,
});
const REFRESH_CSRF_COOKIE_NAME = 'refresh_csrf';
const ACCESS_TOKEN_REFRESH_SKEW_MS = 30_000;
let csrfBootstrapInFlight: Promise<void> | null = null;
// Cache do CSRF token computado pelo backend (HMAC quando CSRF_TOKEN_SECRET está configurado,
// rawToken quando não está). Nunca lido diretamente do cookie em memória.
let _csrfTokenCache: string | undefined;

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }

  const encoded = encodeURIComponent(name);
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${encoded}=`));

  if (!match) {
    return undefined;
  }

  return decodeURIComponent(match.slice(encoded.length + 1));
}

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getJwtExpiresAtMs(token: string): number | null {
  const [, payload] = token.split('.');
  if (!payload) {
    return null;
  }

  const decoded = decodeBase64UrlJson(payload);
  const exp = decoded?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

function shouldRefreshAccessToken(token: string): boolean {
  const expiresAtMs = getJwtExpiresAtMs(token);
  if (!expiresAtMs) {
    return false;
  }

  return expiresAtMs - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS;
}

export function buildRefreshRequestHeaders(
  csrfToken?: string,
  refreshCsrf?: string,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  if (csrfToken) {
    headers['x-csrf-token'] = csrfToken;
  }

  if (refreshCsrf) {
    headers['x-refresh-csrf'] = refreshCsrf;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

let refreshInFlight: Promise<string> | null = null;

const REFRESH_LOCK_KEY = 'sgs_auth_refresh_lock';

function safeNowMs(): number {
  return Date.now();
}

function randomLockId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Math.random().toString(16).slice(2)}-${safeNowMs()}`;
  }
}

function canUseLocalStorage(): boolean {
  return (
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  );
}

async function withCrossTabRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  if (
    typeof navigator !== 'undefined' &&
    (navigator as unknown as { locks?: unknown }).locks
  ) {
    const locks = (
      navigator as unknown as {
        locks: { request: (name: string, cb: () => Promise<T>) => Promise<T> };
      }
    ).locks;
    return locks.request('sgs-auth-refresh', fn);
  }

  if (!canUseLocalStorage()) {
    return fn();
  }

  const lockId = randomLockId();
  const lockTtlMs = 8000;
  const deadlineMs = safeNowMs() + 15000;

  const tryAcquire = (): boolean => {
    const now = safeNowMs();
    const raw = window.localStorage.getItem(REFRESH_LOCK_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { id?: string; expiresAt?: number };
        if (
          parsed?.expiresAt &&
          parsed.expiresAt > now &&
          parsed.id !== lockId
        ) {
          return false;
        }
      } catch {
        // Lock malformado → tratar como expirado e sobrescrever
      }
    }

    window.localStorage.setItem(
      REFRESH_LOCK_KEY,
      JSON.stringify({ id: lockId, expiresAt: now + lockTtlMs }),
    );

    const confirm = window.localStorage.getItem(REFRESH_LOCK_KEY);
    return typeof confirm === 'string' && confirm.includes(lockId);
  };

  while (!tryAcquire()) {
    if (safeNowMs() >= deadlineMs) {
      break;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, 80 + Math.random() * 120),
    );
  }

  try {
    return await fn();
  } finally {
    try {
      const raw = window.localStorage.getItem(REFRESH_LOCK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { id?: string };
        if (parsed?.id === lockId) {
          window.localStorage.removeItem(REFRESH_LOCK_KEY);
        }
      }
    } catch {
      // best-effort
    }
  }
}

async function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const csrfToken = await ensureCsrfToken();
      const refreshCsrf = readCookie(REFRESH_CSRF_COOKIE_NAME);
      const headers = buildRefreshRequestHeaders(csrfToken, refreshCsrf);
      const res = await withCrossTabRefreshLock(() =>
        refreshClient.post<{ accessToken: string }>(
          '/auth/refresh',
          undefined,
          headers ? { headers } : undefined,
        ),
      );
      const token = res.data?.accessToken;
      if (!token) {
        throw new Error('Refresh não retornou accessToken.');
      }
      tokenStore.set(token);
      return token;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function ensureCsrfToken(
  forceRefresh = false,
): Promise<string | undefined> {
  if (_csrfTokenCache && !forceRefresh) {
    return _csrfTokenCache;
  }

  if (forceRefresh) {
    _csrfTokenCache = undefined;
  }

  if (!csrfBootstrapInFlight) {
    csrfBootstrapInFlight = refreshClient
      .get<{ csrfToken?: string }>('/auth/csrf', {
        params: { ts: Date.now() },
      })
      .then((res) => {
        // Quando CSRF_TOKEN_SECRET está configurado no backend, o body contém
        // HMAC(secret, rawToken) que o middleware espera no header x-csrf-token.
        // Sem secret, csrfToken === rawToken (mesmo valor do cookie) — compatível.
        const bodyToken = res.data?.csrfToken;
        _csrfTokenCache = bodyToken || readCookie('csrf-token') || undefined;
      })
      .catch(() => {
        _csrfTokenCache = readCookie('csrf-token') || undefined;
      })
      .finally(() => {
        csrfBootstrapInFlight = null;
      });
  }

  await csrfBootstrapInFlight;
  return _csrfTokenCache;
}

/** Força refresh do CSRF token: limpa cache, busca novo token e atualiza cookie. */
export async function refreshCsrfToken(): Promise<void> {
  await ensureCsrfToken(true);
}

/** Timeouts específicos para operações longas — use via config override por request. */
export const TIMEOUT_EXPORT = 120_000; // 2 min — exportação Excel
export const TIMEOUT_PDF = 180_000; // 3 min — geração de PDF governado
export const TIMEOUT_UPLOAD = 90_000; // 1.5 min — upload de arquivos
export const TIMEOUT_AI = 45_000; // 45 s — operações de IA

export const TENANT_HEADER_NAME = 'x-company-id' as const;

const api = axios.create({
  baseURL: API_BASE_URL || undefined,
  timeout: 30000,
  withCredentials: true,
});

api.interceptors.request.use(async (config) => {
  if (typeof window === 'undefined') {
    return config;
  }
  if (!API_BASE_URL) {
    return Promise.reject(new Error(API_BASE_URL_ERROR_MESSAGE));
  }
  const method = (config.method || 'get').toLowerCase();
  const isReadMethod =
    method === 'get' || method === 'head' || method === 'options';
  if (navigator.onLine === false && !isReadMethod) {
    const pathname = window.location.pathname;
    const { capability } = resolveOfflineRouteCapability(pathname);
    if (!isOfflineActionAllowed(capability, 'write', false)) {
      return Promise.reject(
        new OfflineCapabilityError(pathname, method.toUpperCase(), capability),
      );
    }
  }
  let token = tokenStore.get();
  const session = sessionStore.get();
  const companyId = session?.companyId || null;
  const isAdminGeral = isAdminGeralAccount(session);
  const isPublicRequest = isPublicApiRequest(config.url);
  const skipTenantHeader = Boolean(
    (config as TenantAwareAxiosRequestConfig).skipTenantHeader,
  );
  clampRequestLimit(config);

  if (!token && !isPublicRequest) {
    tokenStore.clear();
    sessionStore.clear();
    authRefreshHint.clear();
    selectedTenantStore.clear();
    scheduleLoginRedirect();
    return Promise.reject(createAuthRequiredError(config));
  }

  if (token && !isPublicRequest && shouldRefreshAccessToken(token)) {
    try {
      token = await refreshAccessToken();
    } catch {
      tokenStore.clear();
      sessionStore.clear();
      authRefreshHint.clear();
      selectedTenantStore.clear();
      scheduleLoginRedirect();
      return Promise.reject(createAuthRequiredError(config));
    }
  }

  if (token && !isPublicRequest) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // Proteção CSRF: envia token em requisições mutáveis
  if (method !== 'get' && method !== 'head' && method !== 'options') {
    const csrfToken = await ensureCsrfToken();
    if (csrfToken) {
      config.headers['x-csrf-token'] = csrfToken;
    }
  }

  const requestUrl = String(config.url || '');
  if (requestUrl.includes('/auth/refresh')) {
    const refreshCsrf = readCookie(REFRESH_CSRF_COOKIE_NAME);
    if (refreshCsrf) {
      config.headers['x-refresh-csrf'] = refreshCsrf;
    }
  }

  // Propagação de trace Sentry → backend (correlação Sentry ↔ Jaeger/logs)
  try {
    const sentryApi = getBrowserSentrySync() as unknown as {
      getCurrentHub?: () => {
        getScope?: () => {
          getSpan?: () => { toTraceparent?: () => string | undefined };
        };
      };
      getTraceData?: () => Record<string, string | undefined>;
    };

    const sentryTrace = sentryApi
      .getCurrentHub?.()
      .getScope?.()
      .getSpan?.()
      .toTraceparent?.();

    if (sentryTrace) {
      config.headers['sentry-trace'] = sentryTrace;
    }

    const traceData = sentryApi.getTraceData?.() || {};
    const sentryBaggage = traceData['baggage'];
    if (sentryBaggage) {
      config.headers['baggage'] = sentryBaggage;
    } else if (traceData['sentry-trace'] && !sentryTrace) {
      config.headers['sentry-trace'] = traceData['sentry-trace'];
    }
  } catch {
    // Sentry não inicializado (ex: testes, SSR sem DSN) — ignorar silenciosamente
  }

  const existingCompanyId = readHeaderValue(config.headers, TENANT_HEADER_NAME);
  if (!isPublicRequest && !skipTenantHeader && !isAdminGeral) {
    if (typeof existingCompanyId === 'string' && existingCompanyId.trim()) {
      if (companyId) {
        setHeaderValue(config.headers, TENANT_HEADER_NAME, companyId);
      } else {
        removeHeaderValue(config.headers, TENANT_HEADER_NAME);
      }
    }
  }

  const normalizedCompanyId = readHeaderValue(config.headers, TENANT_HEADER_NAME);
  if (!isPublicRequest && !normalizedCompanyId && !skipTenantHeader) {
    if (isAdminGeral) {
      const selectedTenant = selectedTenantStore.get();
      const effectiveCompanyId = selectedTenant?.companyId;
      if (effectiveCompanyId) {
        config.headers[TENANT_HEADER_NAME] = effectiveCompanyId;
      }
    } else if (companyId) {
      config.headers[TENANT_HEADER_NAME] = companyId;
    }
  }

  return config;
});

api.interceptors.response.use(
  (response) => {
    notifyApiStatus(true, response.config?.baseURL);
    return response;
  },
  async (error: AxiosError) => {
    const config = error.config as AuthRetryConfig | undefined;
    if (!config) {
      return Promise.reject(error);
    }

    const status = error.response?.status;
    if (!status || error.code === 'ERR_NETWORK') {
      notifyApiStatus(false, config.baseURL || API_BASE_URL || undefined);
    }

    // Tenant inválido/divergente por seleção stale no navegador.
    // Permissão comum não deve apagar a empresa selecionada.
    if (
      [400, 401, 403].includes(status ?? 0) &&
      isTenantContextError(error.response?.data)
    ) {
      const sentCompanyId = readHeaderValue(config.headers, TENANT_HEADER_NAME);
      if (sentCompanyId) {
        const currentTenant = selectedTenantStore.get();
        if (currentTenant?.companyId === sentCompanyId) {
          selectedTenantStore.clear();
          removeHeaderValue(config.headers, TENANT_HEADER_NAME);

          if (!config.__tenantRetry) {
            config.__tenantRetry = true;
            return api.request(config);
          }
        }
      }
      // Erro de tenant nao e falha de autenticacao: nao disparar refresh de
      // token para evitar logout involuntario (ex: ADMIN_GERAL sem empresa).
      return Promise.reject(error);
    }

    // 401 → tenta refresh via cookie httpOnly e refaz a request uma única vez
    const url = String(config.url || '');
    const method = (config.method || 'get').toLowerCase();
    const isAuthEndpoint =
      url.includes('/auth/login') ||
      url.includes('/auth/refresh') ||
      url.includes('/auth/logout');

    if (status === 401 && !config.__authRetry && !isAuthEndpoint) {
      config.__authRetry = true;
      try {
        const newToken = await refreshAccessToken();
        config.headers = config.headers || {};
        if (typeof config.headers.set === 'function') {
          config.headers.set('Authorization', `Bearer ${newToken}`);
        } else {
          config.headers = {
            ...config.headers,
            Authorization: `Bearer ${newToken}`,
          };
        }
        return api.request(config);
      } catch {
        tokenStore.clear();
        sessionStore.clear();
        authRefreshHint.clear();
        selectedTenantStore.clear();
        scheduleLoginRedirect();
        return Promise.reject(error);
      }
    }

    const isIdempotent =
      method === 'get' || method === 'head' || method === 'options';
    const shouldRetry =
      isIdempotent &&
      (error.code === 'ECONNABORTED' ||
        !status ||
        (status >= 500 && status <= 599));

    if (!shouldRetry) {
      return Promise.reject(error);
    }

    config.__retryCount = config.__retryCount || 0;
    if (config.__retryCount >= 2) {
      return Promise.reject(error);
    }
    config.__retryCount += 1;
    const jitter = Math.random() * 100;
    const backoffMs = 300 * config.__retryCount + jitter;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    return api.request(config);
  },
);

export default api;
