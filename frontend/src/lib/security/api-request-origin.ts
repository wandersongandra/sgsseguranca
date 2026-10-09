/**
 * Browser API requests carry session credentials, auth and tenant headers.
 * Fail closed if a URL or per-request baseURL attempts to redirect them outside
 * the configured API surface. This is a client guard, not a server auth boundary.
 */
export const UNTRUSTED_API_TARGET_CODE = 'ERR_UNTRUSTED_API_TARGET';

const INVALID_URL_CHARACTERS = /[\u0000-\u001f\u007f\\]/;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

function untrustedTargetError(): Error & { code: string } {
  return Object.assign(
    new Error('Destino da requisição não permitido pelo cliente SGS.'),
    { code: UNTRUSTED_API_TARGET_CODE },
  );
}

export function assertTrustedApiTarget(
  requestUrl: string | undefined,
  expectedBaseUrl: string,
  requestBaseUrl?: string,
): void {
  const value = requestUrl?.trim();
  if (!value || INVALID_URL_CHARACTERS.test(value) || value.startsWith('//')) {
    throw untrustedTargetError();
  }

  try {
    const expected = new URL(expectedBaseUrl);
    const base = new URL(requestBaseUrl || expectedBaseUrl);

    // Axios joins relative paths to baseURL even if they start with a slash:
    // baseURL=https://app.example/proxy + /users => /proxy/users.
    // Absolute URLs are used as-is unless explicitly disabled in Axios.
    const absolute = URL_SCHEME.test(value);
    const target = absolute
      ? new URL(value)
      : new URL(
          `${base.toString().replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`,
        );
    const prefix = expected.pathname.replace(/\/+$/, '') || '/';
    const staysInsideApiPath =
      prefix === '/' ||
      target.pathname === prefix ||
      target.pathname.startsWith(`${prefix}/`);

    if (
      !['http:', 'https:'].includes(expected.protocol) ||
      base.origin !== expected.origin ||
      target.protocol !== expected.protocol ||
      target.origin !== expected.origin ||
      !staysInsideApiPath ||
      target.username ||
      target.password
    ) {
      throw untrustedTargetError();
    }
  } catch {
    throw untrustedTargetError();
  }
}
