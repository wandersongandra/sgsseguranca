import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController readiness', () => {
  function createController(options?: { redisPingError?: Error }) {
    const redis = {
      ping: options?.redisPingError
        ? jest.fn().mockRejectedValue(options.redisPingError)
        : jest.fn().mockResolvedValue('PONG'),
    };
    const cacheManager = {
      set: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue('ok'),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const puppeteerPool = {
      getPoolStats: jest.fn().mockReturnValue({
        total: 0,
        inUse: 0,
        available: 0,
        poolSize: 2,
      }),
      probeRuntime: jest.fn().mockResolvedValue({
        durationMs: 12,
        stats: { total: 1, inUse: 0, available: 1, poolSize: 2 },
      }),
    };
    const controller = new HealthController(
      { check: jest.fn() } as never,
      {
        pingCheck: jest.fn().mockResolvedValue({ database: { status: 'up' } }),
      } as never,
      {} as never,
      {} as never,
      cacheManager as never,
      redis as never,
      redis as never,
      redis as never,
      redis as never,
      puppeteerPool as never,
      {} as never,
      // PrivilegedDbService — só usado por /health/detailed.
      { isEnabled: () => true } as never,
      undefined,
      undefined,
    );

    return { controller, redis, cacheManager, puppeteerPool };
  }

  it('só retorna ready após validar banco, quatro tiers e cache distribuído', async () => {
    const { controller, redis, cacheManager } = createController();

    await expect(controller.ready()).resolves.toEqual({ status: 'ready' });

    expect(redis.ping).toHaveBeenCalledTimes(4);
    expect(cacheManager.set).toHaveBeenCalledWith(
      expect.stringMatching(/^health:cache:\d+:/),
      'ok',
      1000,
    );
    expect(cacheManager.get).toHaveBeenCalled();
    expect(cacheManager.del).toHaveBeenCalled();
  });

  it('retorna indisponível quando um tier Redis falha', async () => {
    const { controller, redis } = createController({
      redisPingError: new Error('redis unavailable'),
    });

    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(redis.ping).toHaveBeenCalledTimes(4);
  });

  it('compartilha uma única sondagem entre chamadas concorrentes e usa cache curto', async () => {
    const { controller, redis, cacheManager } = createController();

    await expect(
      Promise.all(Array.from({ length: 25 }, () => controller.ready())),
    ).resolves.toHaveLength(25);
    await expect(controller.ready()).resolves.toEqual({ status: 'ready' });

    expect(redis.ping).toHaveBeenCalledTimes(4);
    expect(cacheManager.set).toHaveBeenCalledTimes(1);
    expect(cacheManager.get).toHaveBeenCalledTimes(1);
    expect(cacheManager.del).toHaveBeenCalledTimes(1);
  });

  it('executa probe leve real do runtime Puppeteer na rota administrativa', async () => {
    const { controller, puppeteerPool } = createController();

    await expect(controller.puppeteer()).resolves.toEqual({
      status: 'up',
      runtime: {
        durationMs: 12,
        pool: { total: 1, inUse: 0, available: 1, poolSize: 2 },
      },
    });
    expect(puppeteerPool.probeRuntime).toHaveBeenCalledTimes(1);
  });

  it('não expõe a mensagem bruta da falha do Chromium', async () => {
    const { controller, puppeteerPool } = createController();
    puppeteerPool.probeRuntime.mockRejectedValue(
      new Error('secret path /tmp/private-profile'),
    );

    await expect(controller.puppeteer()).resolves.toEqual({
      status: 'down',
      error: 'Error',
      pool: { total: 0, inUse: 0, available: 0, poolSize: 2 },
    });
  });
});
