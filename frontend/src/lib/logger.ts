/**
 * Logger utilitário para o frontend
 * Em produção, console.log/info/debug são suprimidos para performance e segurança
 * Erros (error/warn) são mantidos para debugging crítico
 */

const isDev = process.env.NODE_ENV === 'development';

const LOG_PREFIX = '[SGS]';

const SENSITIVE_HEADER_PATTERN =
  /authorization|cookie|csrf|token|secret|api[_-]?key/i;

/**
 * Remove headers sensíveis (ex.: Authorization com o Bearer em memória) de
 * objetos AxiosError antes de chegar ao console — evita vazar o token de
 * acesso para quem abrir o devtools em produção.
 */
function sanitizeErrorArg(arg: unknown): unknown {
  if (!(arg instanceof Error)) return arg;

  const config = (arg as Error & { config?: Record<string, unknown> }).config;
  if (!config || typeof config !== 'object') return arg;

  const headers = config.headers;
  if (!headers || typeof headers !== 'object') return arg;

  const sanitizedHeaders: Record<string, string> = {};
  for (const key of Object.keys(headers as Record<string, unknown>)) {
    sanitizedHeaders[key] = SENSITIVE_HEADER_PATTERN.test(key)
      ? '[REDACTED]'
      : String((headers as Record<string, unknown>)[key]);
  }

  return {
    ...arg,
    config: {
      ...config,
      headers: sanitizedHeaders,
    },
  };
}

function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map(sanitizeErrorArg);
}

export const logger = {
  /** Log apenas em desenvolvimento */
  log: (...args: unknown[]) => {
    if (isDev) {
      console.log(LOG_PREFIX, ...args);
    }
  },

  /** Warn sempre visível (produção e dev) */
  warn: (...args: unknown[]) => {
    console.warn(LOG_PREFIX, ...sanitizeArgs(args));
  },

  /** Error sempre visível (produção e dev) */
  error: (...args: unknown[]) => {
    console.error(LOG_PREFIX, ...sanitizeArgs(args));
  },

  /** Info apenas em desenvolvimento */
  info: (...args: unknown[]) => {
    if (isDev) {
      console.info(LOG_PREFIX, ...args);
    }
  },

  /** Debug apenas em desenvolvimento */
  debug: (...args: unknown[]) => {
    if (isDev) {
      console.debug(LOG_PREFIX, ...args);
    }
  },
} as const;

/**
 * Helper para verificar se deve logar
 * Útil para evitar cálculos desnecessários
 */
export const shouldLog = isDev;
