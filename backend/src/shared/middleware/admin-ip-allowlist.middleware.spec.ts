import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { AdminIpAllowlistMiddleware } from './admin-ip-allowlist.middleware';

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as ConfigService;
}

function makeRequest(
  ip = '203.0.113.10',
  headers: Record<string, string> = {},
): Request {
  return {
    path: '/admin/security/score',
    method: 'GET',
    headers,
    socket: { remoteAddress: ip },
  } as Request;
}

describe('AdminIpAllowlistMiddleware', () => {
  it('falha fechado em produção quando allowlist é obrigatória e ausente', () => {
    const middleware = new AdminIpAllowlistMiddleware(
      makeConfig({
        NODE_ENV: 'production',
        ADMIN_IP_ALLOWLIST_REQUIRED: 'true',
        ADMIN_IP_ALLOWLIST: '',
      }),
    );
    const next = jest.fn() as NextFunction;

    expect(() => middleware.use(makeRequest(), {} as Response, next)).toThrow(
      ForbiddenException,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('permite IP listado quando allowlist está ativa', () => {
    const middleware = new AdminIpAllowlistMiddleware(
      makeConfig({
        NODE_ENV: 'production',
        ADMIN_IP_ALLOWLIST_REQUIRED: 'true',
        ADMIN_IP_ALLOWLIST: '203.0.113.10',
      }),
    );
    const next = jest.fn() as NextFunction;

    middleware.use(makeRequest('203.0.113.10'), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('bloqueia IP fora da allowlist', () => {
    const middleware = new AdminIpAllowlistMiddleware(
      makeConfig({
        NODE_ENV: 'production',
        ADMIN_IP_ALLOWLIST_REQUIRED: 'true',
        ADMIN_IP_ALLOWLIST: '198.51.100.5',
      }),
    );
    const next = jest.fn() as NextFunction;

    expect(() =>
      middleware.use(makeRequest('203.0.113.10'), {} as Response, next),
    ).toThrow(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });

  it('bloqueia XFF forjado por acesso direto mesmo quando aponta para IP permitido', () => {
    const middleware = new AdminIpAllowlistMiddleware(
      makeConfig({
        NODE_ENV: 'production',
        ADMIN_IP_ALLOWLIST_REQUIRED: 'true',
        ADMIN_IP_ALLOWLIST: '203.0.113.10',
      }),
    );
    const next = jest.fn() as NextFunction;

    expect(() =>
      middleware.use(
        makeRequest('198.51.100.5', {
          'x-forwarded-for': '203.0.113.10',
        }),
        {} as Response,
        next,
      ),
    ).toThrow(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });

  it('não trata IP parcial como prefixo implícito', () => {
    const middleware = new AdminIpAllowlistMiddleware(
      makeConfig({
        NODE_ENV: 'production',
        ADMIN_IP_ALLOWLIST_REQUIRED: 'true',
        ADMIN_IP_ALLOWLIST: '203.0.113.1',
      }),
    );
    const next = jest.fn() as NextFunction;

    expect(() =>
      middleware.use(makeRequest('203.0.113.10'), {} as Response, next),
    ).toThrow(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });

  it('permite range CIDR IPv4 válido', () => {
    const middleware = new AdminIpAllowlistMiddleware(
      makeConfig({
        NODE_ENV: 'production',
        ADMIN_IP_ALLOWLIST_REQUIRED: 'true',
        ADMIN_IP_ALLOWLIST: '203.0.113.0/24',
      }),
    );
    const next = jest.fn() as NextFunction;

    middleware.use(makeRequest('203.0.113.42'), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('mantém prefixo legado apenas quando termina com ponto', () => {
    const middleware = new AdminIpAllowlistMiddleware(
      makeConfig({
        NODE_ENV: 'production',
        ADMIN_IP_ALLOWLIST_REQUIRED: 'true',
        ADMIN_IP_ALLOWLIST: '10.0.',
      }),
    );
    const next = jest.fn() as NextFunction;

    middleware.use(makeRequest('10.0.25.7'), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
