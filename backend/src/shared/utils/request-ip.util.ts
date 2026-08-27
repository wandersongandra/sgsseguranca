import { BlockList, isIP } from 'node:net';

const TRUSTED_PROXY_CIDRS_ENV = 'TRUSTED_PROXY_CIDRS';
const MAX_FORWARDED_FOR_LENGTH = 4096;
const MAX_FORWARDED_FOR_ENTRIES = 32;

type IpFamily = 'ipv4' | 'ipv6';

type NormalizedIp = {
  address: string;
  family: IpFamily;
};

export type RequestIpInput = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | null;
  connection?: { remoteAddress?: string | null } | null;
};

export type TrustedProxyPolicy = {
  cidrs: readonly string[];
  isTrusted: (address: string) => boolean;
};

export class TrustedProxyConfigurationError extends Error {
  readonly code = 'TRUSTED_PROXY_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'TrustedProxyConfigurationError';
  }
}

function normalizeIp(value: unknown): NormalizedIp | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const unbracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed;
  const version = isIP(unbracketed);

  if (version === 4) {
    return { address: unbracketed, family: 'ipv4' };
  }

  if (version !== 6) {
    return null;
  }

  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(unbracketed);
  if (mappedIpv4 && isIP(mappedIpv4[1]) === 4) {
    return { address: mappedIpv4[1], family: 'ipv4' };
  }

  return { address: unbracketed, family: 'ipv6' };
}

function parseTrustedProxyCidr(value: string): {
  normalized: string;
  network: string;
  prefix: number;
  family: IpFamily;
} {
  const separator = value.lastIndexOf('/');
  if (separator <= 0 || separator === value.length - 1) {
    throw new TrustedProxyConfigurationError(
      `${TRUSTED_PROXY_CIDRS_ENV}: INVALID_CIDR`,
    );
  }

  const network = normalizeIp(value.slice(0, separator));
  const prefixRaw = value.slice(separator + 1);
  if (!network || !/^\d+$/.test(prefixRaw)) {
    throw new TrustedProxyConfigurationError(
      `${TRUSTED_PROXY_CIDRS_ENV}: INVALID_CIDR`,
    );
  }

  const prefix = Number(prefixRaw);
  const maxPrefix = network.family === 'ipv4' ? 32 : 128;
  if (!Number.isSafeInteger(prefix) || prefix < 1 || prefix > maxPrefix) {
    throw new TrustedProxyConfigurationError(
      `${TRUSTED_PROXY_CIDRS_ENV}: UNSAFE_CIDR`,
    );
  }

  return {
    normalized: `${network.address}/${prefix}`,
    network: network.address,
    prefix,
    family: network.family,
  };
}

function readEnvironmentValue(
  env: Record<string, unknown>,
  key: string,
): string {
  const value = env[key];
  return typeof value === 'string' ? value : '';
}

export function createTrustedProxyPolicy(
  env: Record<string, unknown> = process.env,
  options: { requireInProduction?: boolean } = {},
): TrustedProxyPolicy {
  const raw = readEnvironmentValue(env, TRUSTED_PROXY_CIDRS_ENV).trim();
  const isProduction =
    readEnvironmentValue(env, 'NODE_ENV').toLowerCase() === 'production';

  if (!raw) {
    if (options.requireInProduction && isProduction) {
      throw new TrustedProxyConfigurationError(
        `${TRUSTED_PROXY_CIDRS_ENV}: REQUIRED_IN_PRODUCTION`,
      );
    }

    return { cidrs: [], isTrusted: () => false };
  }

  const values = raw.split(',').map((value) => value.trim());
  if (
    values.length === 0 ||
    values.length > MAX_FORWARDED_FOR_ENTRIES ||
    values.some((value) => value.length === 0)
  ) {
    throw new TrustedProxyConfigurationError(
      `${TRUSTED_PROXY_CIDRS_ENV}: INVALID_CIDR_LIST`,
    );
  }

  const parsed = values.map(parseTrustedProxyCidr);
  const blockList = new BlockList();
  for (const cidr of parsed) {
    blockList.addSubnet(cidr.network, cidr.prefix, cidr.family);
  }

  return {
    cidrs: parsed.map((cidr) => cidr.normalized),
    isTrusted: (address: string) => {
      const normalized = normalizeIp(address);
      return normalized
        ? blockList.check(normalized.address, normalized.family)
        : false;
    },
  };
}

let cachedPolicyKey: string | undefined;
let cachedPolicy: TrustedProxyPolicy | undefined;

function getDefaultTrustedProxyPolicy(): TrustedProxyPolicy {
  const raw = String(process.env[TRUSTED_PROXY_CIDRS_ENV] ?? '').trim();
  const nodeEnv = String(process.env.NODE_ENV ?? '').toLowerCase();
  const cacheKey = `${nodeEnv}\u0000${raw}`;
  if (cachedPolicy && cachedPolicyKey === cacheKey) {
    return cachedPolicy;
  }

  cachedPolicy = createTrustedProxyPolicy(process.env);
  cachedPolicyKey = cacheKey;
  return cachedPolicy;
}

function readSocketAddress(request: RequestIpInput): NormalizedIp | null {
  return (
    normalizeIp(request.socket?.remoteAddress) ??
    normalizeIp(request.connection?.remoteAddress)
  );
}

function readForwardedAddresses(
  request: RequestIpInput,
): NormalizedIp[] | null {
  const header = request.headers?.['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;

  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_FORWARDED_FOR_LENGTH
  ) {
    return null;
  }

  const entries = raw.split(',');
  if (
    entries.length === 0 ||
    entries.length > MAX_FORWARDED_FOR_ENTRIES ||
    entries.some((entry) => entry.trim().length === 0)
  ) {
    return null;
  }

  const addresses = entries.map(normalizeIp);
  return addresses.every((address): address is NormalizedIp => address !== null)
    ? addresses
    : null;
}

/**
 * Resolve the transport client address. Forwarded headers are considered only
 * after the immediate peer matches an explicitly configured proxy network.
 * This function is the sole application-level authority that parses XFF.
 */
export function resolveClientIp(
  request: RequestIpInput,
  policy: TrustedProxyPolicy = getDefaultTrustedProxyPolicy(),
): string | null {
  const peer = readSocketAddress(request);
  if (!peer) {
    return null;
  }

  let effective = peer;
  const forwarded = readForwardedAddresses(request);
  if (!forwarded) {
    return effective.address;
  }

  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    if (!policy.isTrusted(effective.address)) {
      break;
    }
    effective = forwarded[index];
  }

  return effective.address;
}

export function getRequestIp(request: RequestIpInput): string | null {
  return resolveClientIp(request);
}
