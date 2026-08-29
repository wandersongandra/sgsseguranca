import type { NextFunction, Request, Response } from 'express';
import {
  createTrustedProxyPolicy,
  resolveClientIp,
  setTrustedProxyAuthenticationState,
  TrustedProxyConfigurationError,
} from './request-ip.util';
import { createTrustedProxyAuthenticationMiddleware } from '../middleware/trusted-proxy-auth.middleware';

const AUTH_SECRET = 'proxy-auth-runtime-key-7f2c9a1e4d6b8c0a';

function createPolicy(overrides: Record<string, unknown> = {}) {
  return createTrustedProxyPolicy({
    NODE_ENV: 'staging',
    TRUSTED_PROXY_MODE: 'authenticated',
    TRUSTED_PROXY_AUTH_SECRET: AUTH_SECRET,
    TRUSTED_FORWARDED_HOP_CIDRS: '10.0.0.0/8',
    ...overrides,
  });
}

function createRequest(
  headers: Record<string, string | string[] | undefined> = {},
  peer = '10.0.0.5',
): Request {
  return {
    headers,
    socket: { remoteAddress: peer },
  } as Request;
}

function runMiddleware(
  request: Request,
  policy: ReturnType<typeof createPolicy>,
): void {
  const next = jest.fn() as NextFunction;
  createTrustedProxyAuthenticationMiddleware(policy)(
    request,
    {} as Response,
    next,
  );
  expect(next).toHaveBeenCalledTimes(1);
}

describe('authenticated trusted proxy boundary', () => {
  it('ignora XFF sem header interno válido', () => {
    const policy = createPolicy();
    const request = createRequest({
      'x-forwarded-for': '203.0.113.10',
      'x-sgs-proxy-auth': 'wrong',
    });

    runMiddleware(request, policy);

    expect(resolveClientIp(request, policy)).toBe('10.0.0.5');
  });

  it('processa XFF somente após proxy semelhante ao Traefik substituir o header', () => {
    const policy = createPolicy();
    const request = createRequest({
      'x-forwarded-for': '203.0.113.10, 10.0.0.6',
      'x-sgs-proxy-auth': 'attacker-value',
    });

    // O cliente não consegue criar o estado interno. O proxy de entrada
    // substitui o valor antes do middleware da aplicação.
    request.headers['x-sgs-proxy-auth'] = AUTH_SECRET;
    runMiddleware(request, policy);

    expect(resolveClientIp(request, policy)).toBe('203.0.113.10');
  });

  it('não aceita header duplicado ou array como autenticação', () => {
    const policy = createPolicy();
    const duplicated = createRequest({
      'X-SGS-Proxy-Auth': AUTH_SECRET,
      'x-sgs-proxy-auth': AUTH_SECRET,
      'x-forwarded-for': '203.0.113.10',
    });
    const arrayHeader = createRequest({
      'x-sgs-proxy-auth': [AUTH_SECRET, AUTH_SECRET],
      'x-forwarded-for': '203.0.113.10',
    });

    runMiddleware(duplicated, policy);
    runMiddleware(arrayHeader, policy);

    expect(resolveClientIp(duplicated, policy)).toBe('10.0.0.5');
    expect(resolveClientIp(arrayHeader, policy)).toBe('10.0.0.5');
  });

  it('compara comprimentos diferentes sem lançar exceção', () => {
    const policy = createPolicy();
    const request = createRequest({
      'x-sgs-proxy-auth': 'x',
      'x-forwarded-for': '203.0.113.10',
    });

    expect(() => runMiddleware(request, policy)).not.toThrow();
    expect(resolveClientIp(request, policy)).toBe('10.0.0.5');
  });

  it('resiste a spoof à esquerda e respeita o primeiro hop não confiável', () => {
    const policy = createPolicy();
    const request = createRequest({
      'x-sgs-proxy-auth': AUTH_SECRET,
      'x-forwarded-for': '1.1.1.1, 203.0.113.10, 10.0.0.6',
    });

    runMiddleware(request, policy);

    expect(resolveClientIp(request, policy)).toBe('203.0.113.10');
  });

  it('falha fechado quando todos os endereços encaminhados são trusted hops', () => {
    const policy = createPolicy();
    const request = createRequest({
      'x-sgs-proxy-auth': AUTH_SECRET,
      'x-forwarded-for': '10.0.0.6, 10.0.0.7',
    });

    runMiddleware(request, policy);

    expect(resolveClientIp(request, policy)).toBe('10.0.0.5');
  });

  it('não usa X-Real-IP, Forwarded ou CF-Connecting-IP como autoridade', () => {
    const policy = createPolicy();
    const request = createRequest({
      'x-sgs-proxy-auth': AUTH_SECRET,
      'x-real-ip': '203.0.113.10',
      forwarded: 'for=203.0.113.10',
      'cf-connecting-ip': '203.0.113.10',
    });

    runMiddleware(request, policy);

    expect(resolveClientIp(request, policy)).toBe('10.0.0.5');
  });

  it('preserva o contrato CIDR, inclusive o fallback leftmost all-trusted', () => {
    const policy = createTrustedProxyPolicy({
      TRUSTED_PROXY_MODE: 'cidr',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    });
    const request = createRequest(
      { 'x-forwarded-for': '10.0.0.6, 10.0.0.7' },
      '10.0.0.5',
    );

    expect(resolveClientIp(request, policy)).toBe('10.0.0.6');
  });

  it('rejeita configuração autenticada sem modo, segredo, hops ou com CIDR antigo', () => {
    expect(() =>
      createTrustedProxyPolicy(
        { NODE_ENV: 'production' },
        { requireExplicitMode: true },
      ),
    ).toThrow('TRUSTED_PROXY_MODE: REQUIRED_IN_PRODUCTION_LIKE_ENVIRONMENT');

    expect(() => createPolicy({ TRUSTED_PROXY_AUTH_SECRET: '' })).toThrow(
      TrustedProxyConfigurationError,
    );
    expect(() => createPolicy({ TRUSTED_FORWARDED_HOP_CIDRS: '' })).toThrow(
      'TRUSTED_FORWARDED_HOP_CIDRS',
    );
    expect(() => createPolicy({ TRUSTED_PROXY_CIDRS: '10.0.0.0/8' })).toThrow(
      'MUST_BE_EMPTY_IN_AUTHENTICATED_MODE',
    );
    expect(() => createPolicy({ TRUSTED_PROXY_AUTH_SECRET: 'short' })).toThrow(
      'TRUSTED_PROXY_AUTH_SECRET',
    );
  });

  it('não considera estado interno vindo de header sem middleware', () => {
    const policy = createPolicy();
    const request = createRequest({
      'x-sgs-proxy-auth': AUTH_SECRET,
      'x-forwarded-for': '203.0.113.10',
    });

    expect(resolveClientIp(request, policy)).toBe('10.0.0.5');
    setTrustedProxyAuthenticationState(request, false);
    expect(resolveClientIp(request, policy)).toBe('10.0.0.5');
  });
});
