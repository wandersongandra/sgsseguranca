import {
  HttpException,
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { IpThrottlerGuard } from './ip-throttler.guard';

type GuardWithTracker = IpThrottlerGuard & {
  getTracker(req: Record<string, unknown>): Promise<string>;
};

describe('IpThrottlerGuard', () => {
  const guard = Object.create(IpThrottlerGuard.prototype) as IpThrottlerGuard;
  const guardWithTracker = guard as GuardWithTracker;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFailClosed = process.env.THROTTLER_FAIL_CLOSED_AUTH_ROUTES;
  const originalAuthFallbackEnabled =
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_ENABLED;
  const originalAuthFallbackLimit =
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_LIMIT;
  const originalAuthFallbackTtl =
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_TTL_MS;
  const originalAuthMeFallbackLimit =
    process.env.THROTTLER_AUTH_ME_LOCAL_FALLBACK_LIMIT;
  const originalAuthMeFallbackTtl =
    process.env.THROTTLER_AUTH_ME_LOCAL_FALLBACK_TTL_MS;

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalFailClosed === undefined) {
      delete process.env.THROTTLER_FAIL_CLOSED_AUTH_ROUTES;
    } else {
      process.env.THROTTLER_FAIL_CLOSED_AUTH_ROUTES = originalFailClosed;
    }
    if (originalAuthFallbackEnabled === undefined) {
      delete process.env.THROTTLER_AUTH_LOCAL_FALLBACK_ENABLED;
    } else {
      process.env.THROTTLER_AUTH_LOCAL_FALLBACK_ENABLED =
        originalAuthFallbackEnabled;
    }
    if (originalAuthFallbackLimit === undefined) {
      delete process.env.THROTTLER_AUTH_LOCAL_FALLBACK_LIMIT;
    } else {
      process.env.THROTTLER_AUTH_LOCAL_FALLBACK_LIMIT =
        originalAuthFallbackLimit;
    }
    if (originalAuthFallbackTtl === undefined) {
      delete process.env.THROTTLER_AUTH_LOCAL_FALLBACK_TTL_MS;
    } else {
      process.env.THROTTLER_AUTH_LOCAL_FALLBACK_TTL_MS =
        originalAuthFallbackTtl;
    }
    if (originalAuthMeFallbackLimit === undefined) {
      delete process.env.THROTTLER_AUTH_ME_LOCAL_FALLBACK_LIMIT;
    } else {
      process.env.THROTTLER_AUTH_ME_LOCAL_FALLBACK_LIMIT =
        originalAuthMeFallbackLimit;
    }
    if (originalAuthMeFallbackTtl === undefined) {
      delete process.env.THROTTLER_AUTH_ME_LOCAL_FALLBACK_TTL_MS;
    } else {
      process.env.THROTTLER_AUTH_ME_LOCAL_FALLBACK_TTL_MS =
        originalAuthMeFallbackTtl;
    }
  });

  beforeEach(() => {
    Reflect.set(guard as object, 'logger', {
      warn: jest.fn(),
      error: jest.fn(),
    });
  });

  it('usa apenas IP em rotas não sensíveis', async () => {
    const tracker = await guardWithTracker.getTracker({
      path: '/users/me',
      headers: { 'user-agent': 'jest' },
      socket: { remoteAddress: '10.0.0.10' },
    });

    expect(tracker).toBe('10.0.0.10');
  });

  it('combina IP e fingerprint hash em rotas públicas sensíveis', async () => {
    const tracker = await guardWithTracker.getTracker({
      path: '/public/documents/validate',
      headers: {
        'user-agent': 'Mozilla/5.0 test',
        'x-client-fingerprint': 'device-123',
      },
      socket: { remoteAddress: '10.0.0.10' },
    });

    expect(tracker.startsWith('10.0.0.10:')).toBe(true);
    expect(tracker).toHaveLength('10.0.0.10:'.length + 16);
  });

  it('mantém o bucket para o mesmo peer não confiável apesar de XFFs diferentes', async () => {
    const trackers = await Promise.all(
      ['203.0.113.10', '198.51.100.20', '192.0.2.30'].map((forwardedIp) =>
        guardWithTracker.getTracker({
          path: '/auth/login',
          headers: {
            'user-agent': 'jest',
            'x-forwarded-for': forwardedIp,
          },
          socket: { remoteAddress: '10.10.10.10' },
        }),
      ),
    );

    expect(new Set(trackers).size).toBe(1);
    expect(trackers[0]?.startsWith('10.10.10.10:')).toBe(true);
  });

  it('fecha em rota crítica de auth quando throttler falha e fail-closed está ativo', async () => {
    process.env.NODE_ENV = 'production';
    process.env.THROTTLER_FAIL_CLOSED_AUTH_ROUTES = 'true';
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_ENABLED = 'false';

    jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockRejectedValueOnce(new Error('redis down'));

    const authContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          path: '/auth/login',
          headers: {},
        }),
      }),
    } as ExecutionContext;

    await expect(
      IpThrottlerGuard.prototype.canActivate.call(guard, authContext),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('mantém fail-open em rota não crítica quando throttler falha', async () => {
    process.env.NODE_ENV = 'production';
    process.env.THROTTLER_FAIL_CLOSED_AUTH_ROUTES = 'true';

    jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockRejectedValueOnce(new Error('redis down'));

    const usersContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          path: '/users/me',
          headers: {},
        }),
      }),
    } as ExecutionContext;

    await expect(
      IpThrottlerGuard.prototype.canActivate.call(guard, usersContext),
    ).resolves.toBe(true);
  });

  it('aplica fallback local em rota crítica quando redis do throttler falha', async () => {
    process.env.NODE_ENV = 'production';
    process.env.THROTTLER_FAIL_CLOSED_AUTH_ROUTES = 'true';
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_ENABLED = 'true';
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_LIMIT = '10';
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_TTL_MS = '60000';

    jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockRejectedValue(new Error('redis down'));

    const authContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          ip: '10.10.10.10',
          path: '/auth/login',
          headers: {
            'user-agent': 'jest',
            'x-client-fingerprint': 'device-1',
          },
        }),
      }),
    } as ExecutionContext;

    await expect(
      IpThrottlerGuard.prototype.canActivate.call(guard, authContext),
    ).resolves.toBe(true);
  });

  it('retorna 429 quando fallback local excede o limite', async () => {
    process.env.NODE_ENV = 'production';
    process.env.THROTTLER_FAIL_CLOSED_AUTH_ROUTES = 'true';
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_ENABLED = 'true';
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_LIMIT = '1';
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_TTL_MS = '60000';

    jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockRejectedValue(new Error('redis down'));

    const authContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          ip: '10.10.10.11',
          path: '/auth/login',
          headers: {
            'user-agent': 'jest',
            'x-client-fingerprint': 'device-2',
          },
        }),
      }),
    } as ExecutionContext;

    await expect(
      IpThrottlerGuard.prototype.canActivate.call(guard, authContext),
    ).resolves.toBe(true);

    try {
      await IpThrottlerGuard.prototype.canActivate.call(guard, authContext);
      throw new Error('expected 429 on second local fallback hit');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    }
  });

  it('usa limite dedicado para /auth/me no fallback local', async () => {
    process.env.NODE_ENV = 'production';
    process.env.THROTTLER_FAIL_CLOSED_AUTH_ROUTES = 'true';
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_ENABLED = 'true';
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_LIMIT = '1';
    process.env.THROTTLER_AUTH_LOCAL_FALLBACK_TTL_MS = '60000';
    process.env.THROTTLER_AUTH_ME_LOCAL_FALLBACK_LIMIT = '3';
    process.env.THROTTLER_AUTH_ME_LOCAL_FALLBACK_TTL_MS = '60000';

    jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockRejectedValue(new Error('redis down'));

    const meContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          ip: '10.10.10.12',
          path: '/auth/me',
          headers: {
            'user-agent': 'jest',
          },
        }),
      }),
    } as ExecutionContext;

    await expect(
      IpThrottlerGuard.prototype.canActivate.call(guard, meContext),
    ).resolves.toBe(true);
    await expect(
      IpThrottlerGuard.prototype.canActivate.call(guard, meContext),
    ).resolves.toBe(true);
    await expect(
      IpThrottlerGuard.prototype.canActivate.call(guard, meContext),
    ).resolves.toBe(true);

    try {
      await IpThrottlerGuard.prototype.canActivate.call(guard, meContext);
      throw new Error('expected 429 on fourth /auth/me fallback hit');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    }
  });
});
