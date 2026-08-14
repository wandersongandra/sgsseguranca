import { ConfigService } from '@nestjs/config';

type RedisConfigReader = ConfigService | NodeJS.ProcessEnv;
export type RedisConnectionTier = 'auth' | 'cache' | 'queue' | 'rateLimit';

export type ResolvedRedisConnection = {
  source: 'url' | 'host';
  url?: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: {
    rejectUnauthorized: boolean;
  };
};

export function assertSecureRedisConnection(
  connection: ResolvedRedisConnection,
  environment = process.env.NODE_ENV,
): void {
  const isRemoteProduction =
    environment === 'production' && !isLocalRedisConnection(connection);

  // Opt-in explícito para um Redis na MESMA rede interna do host (ex.: um
  // container Redis na mesma VPS, acessível apenas pela rede docker interna).
  // Nesse cenário o tráfego nunca sai da máquina, então a exigência de TLS —
  // pensada para Redis remoto atravessando a internet — pode ser dispensada.
  // Continua sendo exigida por padrão: só é relaxada quando esta flag é
  // ligada deliberadamente. A autenticação (senha) permanece obrigatória.
  const trustInternalNetwork = /^true$/i.test(
    process.env.REDIS_ALLOW_INSECURE_INTERNAL || '',
  );

  if (isRemoteProduction && !connection.tls && !trustInternalNetwork) {
    throw new Error(
      'Redis remoto em produção exige TLS. Use rediss:// ou habilite REDIS_<TIER>_TLS=true com endpoint TLS válido. ' +
        'Para um Redis na mesma rede interna do host, defina REDIS_ALLOW_INSECURE_INTERNAL=true.',
    );
  }
  if (isRemoteProduction && !connection.password) {
    throw new Error(
      'Redis remoto em produção exige autenticação. Configure senha na URL ou em REDIS_<TIER>_PASSWORD.',
    );
  }
}

export function isLoopbackHostname(hostname?: string | null): boolean {
  if (typeof hostname !== 'string') {
    return false;
  }

  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

export function isLocalRedisConnection(
  connection: ResolvedRedisConnection | null | undefined,
): boolean {
  return Boolean(connection && isLoopbackHostname(connection.host));
}

function readValue(reader: RedisConfigReader, key: string): string | undefined {
  if (reader instanceof ConfigService) {
    return reader.get<string>(key) ?? undefined;
  }

  return reader[key];
}

function firstNonEmpty(
  reader: RedisConfigReader,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = readValue(reader, key);
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function resolveTls(
  reader: RedisConfigReader,
  tier: RedisConnectionTier | undefined,
  forceTls = false,
): ResolvedRedisConnection['tls'] {
  const prefix = tier ? `REDIS_${tierEnvName(tier)}_` : 'REDIS_';
  const tlsEnabled =
    forceTls ||
    /^true$/i.test(firstNonEmpty(reader, [`${prefix}TLS`, 'REDIS_TLS']) || '');

  if (!tlsEnabled) return undefined;

  return { rejectUnauthorized: true };
}

function tierEnvName(tier: RedisConnectionTier): string {
  return tier === 'rateLimit' ? 'RATE_LIMIT' : tier.toUpperCase();
}

export function isRedisExplicitlyDisabled(reader: RedisConfigReader): boolean {
  return /^true$/i.test(readValue(reader, 'REDIS_DISABLED') || '');
}

function resolveRedisUrlConnection(
  reader: RedisConfigReader,
  tier: RedisConnectionTier | undefined,
  prefix: string | undefined,
  redisUrl: string,
): ResolvedRedisConnection {
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(
      `Protocolo Redis inválido: ${parsed.protocol}. Use redis:// ou rediss://.`,
    );
  }

  const username =
    (parsed.username ? decodeURIComponent(parsed.username) : undefined) ??
    firstNonEmpty(
      reader,
      prefix ? [`${prefix}USERNAME`, 'REDIS_USERNAME'] : ['REDIS_USERNAME'],
    );
  const password =
    (parsed.password ? decodeURIComponent(parsed.password) : undefined) ??
    firstNonEmpty(
      reader,
      prefix ? [`${prefix}PASSWORD`, 'REDIS_PASSWORD'] : ['REDIS_PASSWORD'],
    );

  return {
    source: 'url',
    url: redisUrl,
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username,
    password,
    tls: resolveTls(reader, tier, parsed.protocol === 'rediss:'),
  };
}

function resolveRedisHostConnection(
  reader: RedisConfigReader,
  tier: RedisConnectionTier | undefined,
  prefix: string | undefined,
  host: string,
): ResolvedRedisConnection {
  const port = Number(
    firstNonEmpty(
      reader,
      prefix ? [`${prefix}PORT`, 'REDIS_PORT'] : ['REDIS_PORT'],
    ) || 6379,
  );

  return {
    source: 'host',
    host,
    port: Number.isFinite(port) && port > 0 ? port : 6379,
    username: firstNonEmpty(
      reader,
      prefix ? [`${prefix}USERNAME`, 'REDIS_USERNAME'] : ['REDIS_USERNAME'],
    ),
    password: firstNonEmpty(
      reader,
      prefix ? [`${prefix}PASSWORD`, 'REDIS_PASSWORD'] : ['REDIS_PASSWORD'],
    ),
    tls: resolveTls(reader, tier),
  };
}

export function resolveRedisConnection(
  reader: RedisConfigReader,
  tier?: RedisConnectionTier,
): ResolvedRedisConnection | null {
  if (isRedisExplicitlyDisabled(reader)) {
    return null;
  }

  const prefix = tier ? `REDIS_${tierEnvName(tier)}_` : undefined;
  const redisUrl = firstNonEmpty(
    reader,
    prefix
      ? [`${prefix}URL`, 'REDIS_URL', 'URL_REDIS', 'REDIS_PUBLIC_URL']
      : ['REDIS_URL', 'URL_REDIS', 'REDIS_PUBLIC_URL'],
  );

  if (redisUrl) {
    return resolveRedisUrlConnection(reader, tier, prefix, redisUrl);
  }

  const host = firstNonEmpty(
    reader,
    prefix ? [`${prefix}HOST`, 'REDIS_HOST'] : ['REDIS_HOST'],
  );
  if (!host) {
    return null;
  }

  return resolveRedisHostConnection(reader, tier, prefix, host);
}
