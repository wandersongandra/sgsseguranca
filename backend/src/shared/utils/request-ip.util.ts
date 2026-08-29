import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { constantTimeEquals } from '../security/constant-time.util';

export const TRUSTED_PROXY_MODE_ENV = 'TRUSTED_PROXY_MODE';
export const TRUSTED_PROXY_CIDRS_ENV = 'TRUSTED_PROXY_CIDRS';
export const TRUSTED_FORWARDED_HOP_CIDRS_ENV = 'TRUSTED_FORWARDED_HOP_CIDRS';
export const TRUSTED_PROXY_AUTH_SECRET_ENV = 'TRUSTED_PROXY_AUTH_SECRET';
export const TRUSTED_PROXY_AUTH_HEADER = 'x-sgs-proxy-auth';

const AUTH_HEADER_MAX_LENGTH = 4096;
const MAX_FORWARDED_FOR_LENGTH = 4096;
const MAX_FORWARDED_FOR_ENTRIES = 32;
const AUTH_SECRET_MIN_BYTES = 32;

type IpFamily = 'ipv4' | 'ipv6';

type NormalizedIp = {
  address: string;
  family: IpFamily;
};

export type TrustedProxyMode = 'cidr' | 'authenticated';

export type RequestIpInput = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | null;
  connection?: { remoteAddress?: string | null } | null;
};

export type TrustedProxyPolicy = {
  mode: TrustedProxyMode;
  cidrs: readonly string[];
  forwardedHopCidrs: readonly string[];
  isTrusted: (address: string) => boolean;
  isTrustedForwardedHop: (address: string) => boolean;
  isProxyAuthHeaderValid: (request: RequestIpInput) => boolean;
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

function parseTrustedProxyCidr(
  value: string,
  environmentKey: string,
): {
  normalized: string;
  network: string;
  prefix: number;
  family: IpFamily;
} {
  const separator = value.lastIndexOf('/');
  if (separator <= 0 || separator === value.length - 1) {
    throw new TrustedProxyConfigurationError(`${environmentKey}: INVALID_CIDR`);
  }

  const network = normalizeIp(value.slice(0, separator));
  const prefixRaw = value.slice(separator + 1);
  if (!network || !/^\d+$/.test(prefixRaw)) {
    throw new TrustedProxyConfigurationError(`${environmentKey}: INVALID_CIDR`);
  }

  const prefix = Number(prefixRaw);
  const maxPrefix = network.family === 'ipv4' ? 32 : 128;
  if (!Number.isSafeInteger(prefix) || prefix < 1 || prefix > maxPrefix) {
    throw new TrustedProxyConfigurationError(`${environmentKey}: UNSAFE_CIDR`);
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

function createBlockList(
  raw: string,
  environmentKey: string,
  required: boolean,
): {
  cidrs: readonly string[];
  isTrusted: (address: string) => boolean;
} {
  if (!raw) {
    if (required) {
      throw new TrustedProxyConfigurationError(
        `${environmentKey}: REQUIRED_CONFIGURATION`,
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
      `${environmentKey}: INVALID_CIDR_LIST`,
    );
  }

  const parsed = values.map((value) =>
    parseTrustedProxyCidr(value, environmentKey),
  );
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

function readHeader(
  request: RequestIpInput,
  expectedName: string,
): string | undefined {
  const matchingEntries = Object.entries(request.headers ?? {}).filter(
    ([name]) => name.toLowerCase() === expectedName,
  );
  if (matchingEntries.length !== 1) {
    return undefined;
  }

  const value = matchingEntries[0][1];
  return typeof value === 'string' ? value : undefined;
}

function isValidAuthSecret(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') >= AUTH_SECRET_MIN_BYTES &&
    !/(?:changeme|change[-_ ]?me|your[-_ ]?(?:key|secret|password)|test[-_ ]?secret|default[-_ ]?(?:key|secret|password)|password|secret|example\.invalid|replace[-_ ]?me|<[^>]+>)/i.test(
      value,
    )
  );
}

const proxyAuthenticationState = new WeakMap<object, boolean>();

/** State interno produzido somente pelo middleware; headers não o controlam. */
export function setTrustedProxyAuthenticationState(
  request: RequestIpInput,
  authenticated: boolean,
): void {
  proxyAuthenticationState.set(request, authenticated);
}

function hasTrustedProxyAuthenticationState(request: RequestIpInput): boolean {
  return proxyAuthenticationState.get(request) === true;
}

export function createTrustedProxyPolicy(
  env: Record<string, unknown> = process.env,
  options: {
    requireInProduction?: boolean;
    requireExplicitMode?: boolean;
  } = {},
): TrustedProxyPolicy {
  const rawMode = readEnvironmentValue(env, TRUSTED_PROXY_MODE_ENV)
    .trim()
    .toLowerCase();
  const production =
    readEnvironmentValue(env, 'NODE_ENV').toLowerCase() === 'production';
  const requireExplicitMode =
    options.requireExplicitMode === true ||
    (options.requireInProduction === true && production);

  if (!rawMode && requireExplicitMode) {
    throw new TrustedProxyConfigurationError(
      `${TRUSTED_PROXY_MODE_ENV}: REQUIRED_IN_PRODUCTION_LIKE_ENVIRONMENT`,
    );
  }

  const mode: TrustedProxyMode = (rawMode || 'cidr') as TrustedProxyMode;
  if (mode !== 'cidr' && mode !== 'authenticated') {
    throw new TrustedProxyConfigurationError(
      `${TRUSTED_PROXY_MODE_ENV}: INVALID_VALUE`,
    );
  }

  const rawCidrs = readEnvironmentValue(env, TRUSTED_PROXY_CIDRS_ENV).trim();
  if (mode === 'authenticated') {
    if (rawCidrs) {
      throw new TrustedProxyConfigurationError(
        `${TRUSTED_PROXY_CIDRS_ENV}: MUST_BE_EMPTY_IN_AUTHENTICATED_MODE`,
      );
    }

    const authSecret = readEnvironmentValue(env, TRUSTED_PROXY_AUTH_SECRET_ENV);
    if (!authSecret) {
      throw new TrustedProxyConfigurationError(
        `${TRUSTED_PROXY_AUTH_SECRET_ENV}: REQUIRED_IN_AUTHENTICATED_MODE`,
      );
    }
    if (!isValidAuthSecret(authSecret)) {
      throw new TrustedProxyConfigurationError(
        `${TRUSTED_PROXY_AUTH_SECRET_ENV}: INVALID_SECRET`,
      );
    }

    const rawForwardedHops = readEnvironmentValue(
      env,
      TRUSTED_FORWARDED_HOP_CIDRS_ENV,
    ).trim();
    if (!rawForwardedHops) {
      throw new TrustedProxyConfigurationError(
        `${TRUSTED_FORWARDED_HOP_CIDRS_ENV}: REQUIRED_IN_AUTHENTICATED_MODE`,
      );
    }
    const forwardedHops = createBlockList(
      rawForwardedHops,
      TRUSTED_FORWARDED_HOP_CIDRS_ENV,
      false,
    );

    return {
      mode,
      cidrs: [],
      forwardedHopCidrs: forwardedHops.cidrs,
      isTrusted: () => false,
      isTrustedForwardedHop: forwardedHops.isTrusted,
      isProxyAuthHeaderValid: (request) => {
        const header = readHeader(request, TRUSTED_PROXY_AUTH_HEADER);
        return (
          typeof header === 'string' &&
          header.length <= AUTH_HEADER_MAX_LENGTH &&
          constantTimeEquals(header, authSecret)
        );
      },
    };
  }

  const trustedProxies = createBlockList(
    rawCidrs,
    TRUSTED_PROXY_CIDRS_ENV,
    options.requireInProduction === true && production,
  );

  return {
    mode,
    cidrs: trustedProxies.cidrs,
    forwardedHopCidrs: [],
    isTrusted: trustedProxies.isTrusted,
    isTrustedForwardedHop: () => false,
    isProxyAuthHeaderValid: () => false,
  };
}

let cachedPolicyKey: string | undefined;
let cachedPolicy: TrustedProxyPolicy | undefined;

function getDefaultTrustedProxyPolicy(): TrustedProxyPolicy {
  const mode = String(process.env[TRUSTED_PROXY_MODE_ENV] ?? '').trim();
  const cidrs = String(process.env[TRUSTED_PROXY_CIDRS_ENV] ?? '').trim();
  const forwardedHops = String(
    process.env[TRUSTED_FORWARDED_HOP_CIDRS_ENV] ?? '',
  ).trim();
  const authSecretFingerprint = createHash('sha256')
    .update(String(process.env[TRUSTED_PROXY_AUTH_SECRET_ENV] ?? ''))
    .digest('hex');
  const nodeEnv = String(process.env.NODE_ENV ?? '').toLowerCase();
  const cacheKey = `${nodeEnv}\u0000${mode}\u0000${cidrs}\u0000${forwardedHops}\u0000${authSecretFingerprint}`;
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
 * Resolve o endereço do cliente a partir da autoridade de transporte.
 *
 * Em `cidr`, preserva o contrato histórico de XFF por CIDR. Em
 * `authenticated`, XFF só é considerado após o middleware validar o header
 * interno e somente os hops explicitamente confiáveis podem ser consumidos.
 */
export function resolveClientIp(
  request: RequestIpInput,
  policy: TrustedProxyPolicy = getDefaultTrustedProxyPolicy(),
): string | null {
  const peer = readSocketAddress(request);
  if (!peer) {
    return null;
  }

  if (
    policy.mode === 'authenticated' &&
    !hasTrustedProxyAuthenticationState(request)
  ) {
    return peer.address;
  }

  const forwarded = readForwardedAddresses(request);
  if (!forwarded) {
    return peer.address;
  }

  if (policy.mode === 'authenticated') {
    let effective = peer;
    for (let index = forwarded.length - 1; index >= 0; index -= 1) {
      if (!policy.isTrustedForwardedHop(effective.address)) {
        return effective.address;
      }

      effective = forwarded[index];
      if (!policy.isTrustedForwardedHop(effective.address)) {
        return effective.address;
      }
    }

    // Sem cadeia de cliente autenticável, não promove o leftmost arbitrário.
    return peer.address;
  }

  let effective = peer;
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
