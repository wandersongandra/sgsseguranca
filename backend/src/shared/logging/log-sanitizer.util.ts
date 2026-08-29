const REDACTED = '***REDACTED***';
const MASKED = '***MASKED***';

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'csrf',
  'password',
  'refresh_token',
  'secret',
  'senha',
  'signature_pin',
  'token',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-refresh-csrf',
  'x-sgs-proxy-auth',
]);

const SENSITIVE_PATH_TOKEN_PREFIXES: string[][] = [
  ['storage', 'download'],
  ['public', 'dds', 'signature'],
  ['tenant-lifecycle', 'onboarding'],
];

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '_');
}

function isVersionPathSegment(segment: string): boolean {
  return /^v\d+$/i.test(segment);
}

function startsWithPathPrefix(
  segments: string[],
  offset: number,
  prefix: string[],
): boolean {
  if (segments.length < offset + prefix.length + 1) {
    return false;
  }

  return prefix.every((part, index) => segments[offset + index] === part);
}

function redactSensitivePathSegments(pathname: string): string {
  const hasTrailingSlash = pathname.endsWith('/') && pathname.length > 1;
  const originalSegments = pathname.split('/').filter(Boolean);

  if (originalSegments.length === 0) {
    return pathname;
  }

  const redactedSegments = [...originalSegments];
  const candidateOffsets = isVersionPathSegment(redactedSegments[0])
    ? [1, 0]
    : [0];

  for (const prefix of SENSITIVE_PATH_TOKEN_PREFIXES) {
    for (const offset of candidateOffsets) {
      if (!startsWithPathPrefix(redactedSegments, offset, prefix)) {
        continue;
      }

      const tokenIndex = offset + prefix.length;
      redactedSegments[tokenIndex] = REDACTED;
      break;
    }
  }

  const rebuiltPath = `/${redactedSegments.join('/')}`;
  if (hasTrailingSlash && !rebuiltPath.endsWith('/')) {
    return `${rebuiltPath}/`;
  }

  return rebuiltPath;
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_QUERY_KEYS.has(normalized) ||
    normalized.includes('secret') ||
    /(^|_|-)token($|_|-)/.test(normalized)
  );
}

export function maskCpf(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 11) {
    return MASKED;
  }

  return `${digits.slice(0, 3)}.***.***-**`;
}

export function maskEmail(value: string): string {
  const [local, domain] = value.split('@');
  if (!domain) {
    return MASKED;
  }

  return `${local?.[0] || '*'}***@${domain}`;
}

export function maskSensitiveText(value: string): string {
  // Limitar tamanho antes de aplicar regexes para evitar backtracking excessivo
  const safe = value.length > 2000 ? value.slice(0, 2000) : value;
  return safe
    .replace(
      /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,10}\b/gi,
      (email) => maskEmail(email),
    )
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, (cpf) => maskCpf(cpf))
    .replace(/\bBearer\s+[A-Za-z0-9._-]{1,2048}\b/g, 'Bearer ***REDACTED***')
    .replace(/\bcf(?:ut|k)_[A-Za-z0-9_-]{1,256}\b/g, REDACTED);
}

export function sanitizeLogValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) {
    return REDACTED;
  }

  const normalized = normalizeKey(key);
  if (normalized.includes('cpf')) {
    return typeof value === 'string' ? maskCpf(value) : MASKED;
  }

  if (normalized.includes('email')) {
    return typeof value === 'string' ? maskEmail(value) : MASKED;
  }

  if (typeof value === 'string') {
    return maskSensitiveText(value);
  }

  return value;
}

export function sanitizeLogUrl(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return '';
  }

  try {
    const parsed = new URL(rawUrl, 'http://sgs.local');
    for (const key of Array.from(parsed.searchParams.keys())) {
      const values = parsed.searchParams.getAll(key);
      parsed.searchParams.delete(key);
      for (const value of values) {
        const sanitizedValue = sanitizeLogValue(key, value);
        parsed.searchParams.append(
          key,
          typeof sanitizedValue === 'string' ? sanitizedValue : '',
        );
      }
    }

    const query = parsed.searchParams.toString();
    const sanitizedPath = redactSensitivePathSegments(parsed.pathname);
    return `${sanitizedPath}${query ? `?${query}` : ''}`;
  } catch {
    return maskSensitiveText(rawUrl).slice(0, 500);
  }
}

export function sanitizeLogObject<T>(value: T, depth = 0): T {
  if (depth > 6) {
    return '***TRUNCATED***' as T;
  }

  if (Array.isArray(value)) {
    const sanitizedItems: unknown[] = value.map((item: unknown) =>
      sanitizeLogObject(item, depth + 1),
    );
    return sanitizedItems as T;
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = sanitizeLogObject(sanitizeLogValue(key, item), depth + 1);
    }
    return output as T;
  }

  if (typeof value === 'string') {
    return maskSensitiveText(value) as T;
  }

  return value;
}
