import express from 'express';
import { createServer, type Server } from 'node:http';
import { createTrustedProxyPolicy, resolveClientIp } from './request-ip.util';
import { createTrustedProxyAuthenticationMiddleware } from '../middleware/trusted-proxy-auth.middleware';

describe('Express trust proxy runtime', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;

    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  async function requestWithHeaders(
    headers: Record<string, string>,
  ): Promise<{ expressIp: string; resolvedIp: string | null }> {
    const app = express();
    const policy = createTrustedProxyPolicy({
      TRUSTED_PROXY_CIDRS: headers['x-test-trusted-cidr'] || '',
    });
    app.set('trust proxy', policy.isTrusted);
    app.get('/', (request, response) => {
      response.json({
        expressIp: request.ip,
        resolvedIp: resolveClientIp(request, policy),
      });
    });

    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server?.listen(0, '127.0.0.1', () => resolve());
      server?.once('error', reject);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Express test server did not expose a TCP port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      headers: Object.fromEntries(
        Object.entries(headers).filter(
          ([key]) => key !== 'x-test-trusted-cidr',
        ),
      ),
    });
    if (!response.ok) {
      throw new Error(`Unexpected HTTP status: ${response.status}`);
    }

    return (await response.json()) as {
      expressIp: string;
      resolvedIp: string | null;
    };
  }

  it('ignora XFF forjado em acesso direto quando nenhum proxy é confiável', async () => {
    const result = await requestWithHeaders({
      'x-test-trusted-cidr': '',
      'x-forwarded-for': '1.1.1.1',
    });

    expect(result.expressIp).toBe('127.0.0.1');
    expect(result.resolvedIp).toBe('127.0.0.1');
  });

  it('aceita o IP do cliente somente de um peer no CIDR confiável', async () => {
    const result = await requestWithHeaders({
      'x-test-trusted-cidr': '127.0.0.1/32',
      'x-forwarded-for': '203.0.113.20',
    });

    expect(result.expressIp).toBe('203.0.113.20');
    expect(result.resolvedIp).toBe('203.0.113.20');
  });

  it('mantém o primeiro IP não confiável em uma cadeia spoofada', async () => {
    const result = await requestWithHeaders({
      'x-test-trusted-cidr': '127.0.0.1/32',
      'x-forwarded-for': '1.1.1.1, 203.0.113.20',
    });

    expect(result.expressIp).toBe('203.0.113.20');
    expect(result.resolvedIp).toBe('203.0.113.20');
  });

  it('não habilita o trust proxy do Express no modo autenticado', async () => {
    const app = express();
    const policy = createTrustedProxyPolicy({
      TRUSTED_PROXY_MODE: 'authenticated',
      TRUSTED_PROXY_AUTH_SECRET: 'proxy-auth-runtime-key-7f2c9a1e4d6b8c0a',
      TRUSTED_FORWARDED_HOP_CIDRS: '127.0.0.1/32',
    });

    app.use(createTrustedProxyAuthenticationMiddleware(policy));
    app.set('trust proxy', false);
    app.get('/', (request, response) => {
      response.json({
        expressIp: request.ip,
        resolvedIp: resolveClientIp(request, policy),
      });
    });

    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server?.listen(0, '127.0.0.1', () => resolve());
      server?.once('error', reject);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Express test server did not expose a TCP port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      headers: {
        'x-sgs-proxy-auth': 'proxy-auth-runtime-key-7f2c9a1e4d6b8c0a',
        'x-forwarded-for': '203.0.113.20',
      },
    });
    const result = (await response.json()) as {
      expressIp: string;
      resolvedIp: string | null;
    };

    expect(result.expressIp).toBe('127.0.0.1');
    expect(result.resolvedIp).toBe('203.0.113.20');
  });
});
