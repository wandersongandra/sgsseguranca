/**
 * Logger utilitário para o frontend.
 * Em produção, logs de diagnóstico são suprimidos e todo argumento passa
 * por uma sanitização recursiva antes de chegar ao console.
 */

const isDev = process.env.NODE_ENV === 'development';
const LOG_PREFIX = '[SGS]';

const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|csrf|token|secret|api[_-]?key|password|senha|cpf|cnpj|telefone|phone|email|otp|recovery|private|signature|assinatura|base64|dataurl|^data$|^payload$|^body$/i;

const SENSITIVE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]'],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[REDACTED_CPF]'],
  [/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
  [
    /([?&](?:access[_-]?token|refresh[_-]?token|token|signature|x-amz-signature|x-amz-credential|credential|api[_-]?key|password|senha|csrf)=)[^&#\s]*/gi,
    '$1[REDACTED]',
  ],
];

function redactText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );
}

function sanitizeLogValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    return redactText(value);
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }

  if (depth >= 6) {
    return '[TRUNCATED]';
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);

    if (value instanceof Error) {
      const result: Record<string, unknown> = {
        name: value.name,
        message: redactText(value.message),
      };
      for (const property of Object.keys(value)) {
        result[property] = sanitizeLogValue(
          (value as unknown as Record<string, unknown>)[property],
          property,
          seen,
          depth + 1,
        );
      }
      return result;
    }

    if (Array.isArray(value)) {
      return value.map((item) =>
        sanitizeLogValue(item, undefined, seen, depth + 1),
      );
    }

    const result: Record<string, unknown> = {};
    for (const [property, propertyValue] of Object.entries(value)) {
      result[property] = sanitizeLogValue(
        propertyValue,
        property,
        seen,
        depth + 1,
      );
    }
    return result;
  }

  return '[UNSUPPORTED]';
}

function sanitizeArgs(args: unknown[]): unknown[] {
  const seen = new WeakSet<object>();
  return args.map((arg) => sanitizeLogValue(arg, undefined, seen, 0));
}

export const logger = {
  log: (...args: unknown[]) => {
    if (isDev) console.log(LOG_PREFIX, ...sanitizeArgs(args));
  },

  warn: (...args: unknown[]) => {
    console.warn(LOG_PREFIX, ...sanitizeArgs(args));
  },

  error: (...args: unknown[]) => {
    console.error(LOG_PREFIX, ...sanitizeArgs(args));
  },

  info: (...args: unknown[]) => {
    if (isDev) console.info(LOG_PREFIX, ...sanitizeArgs(args));
  },

  debug: (...args: unknown[]) => {
    if (isDev) console.debug(LOG_PREFIX, ...sanitizeArgs(args));
  },
} as const;

export const shouldLog = isDev;
