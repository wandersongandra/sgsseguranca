import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

describe('WorkerHeartbeatService', () => {
  function createService(overrides?: {
    config?: Partial<Record<string, string>>;
    redisGet?: string | null;
  }) {
    const config: Record<string, string> = {
      NODE_ENV: 'production',
      REDIS_DISABLED: 'false',
      WORKER_HEARTBEAT_ENABLED: 'true',
      WORKER_HEARTBEAT_KEY: 'worker:heartbeat:test',
      WORKER_HEARTBEAT_TTL_SECONDS: '90',
      ...overrides?.config,
    };

    const client = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(overrides?.redisGet ?? null),
    };

    const service = new WorkerHeartbeatService(
      {
        get: jest.fn((key: string, defaultValue?: string) => {
          if (Object.prototype.hasOwnProperty.call(config, key)) {
            return config[key];
          }
          return defaultValue ?? '';
        }),
      } as unknown as ConfigService,
      {
        getClient: jest.fn(() => client),
      } as unknown as RedisService,
    );

    return { service, client };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('grava heartbeat no redis com TTL configurado', async () => {
    const { service, client } = createService();

    await service.touch('worker-bootstrap');

    expect(client.set).toHaveBeenCalledWith(
      'worker:heartbeat:test',
      expect.any(String),
      'EX',
      90,
    );
  });

  it('retorna disabled quando heartbeat esta desabilitado', async () => {
    const { service } = createService({
      config: {
        WORKER_HEARTBEAT_ENABLED: 'false',
      },
    });

    await expect(service.getStatus()).resolves.toEqual({
      status: 'disabled',
      required: false,
      message: 'Worker heartbeat disabled by configuration or REDIS_DISABLED',
    });
  });

  it('retorna up quando encontra heartbeat ativo', async () => {
    const now = new Date().toISOString();
    const { service } = createService({
      redisGet: JSON.stringify({
        source: 'worker-loop',
        hostname: 'host-1',
        pid: 123,
        updatedAt: now,
      }),
    });

    await expect(service.getStatus()).resolves.toEqual(
      expect.objectContaining({
        status: 'up',
        required: true,
        lastSeenAt: now,
        source: 'worker-loop',
        hostname: 'host-1',
        pid: 123,
      }),
    );
  });

  it('retorna down quando nao encontra heartbeat ativo', async () => {
    const { service } = createService();

    await expect(service.getStatus()).resolves.toEqual({
      status: 'down',
      required: true,
      message: 'No active worker heartbeat found',
    });
  });

  it.each([
    { updatedAt: new Date(Date.now() - 120_000).toISOString() },
    { updatedAt: 'invalid' },
    { updatedAt: new Date(Date.now() + 120_000).toISOString() },
    {},
  ])(
    'rejeita heartbeat sem timestamp recente e válido: %j',
    async (payload) => {
      const { service } = createService({ redisGet: JSON.stringify(payload) });

      await expect(service.getStatus()).resolves.toMatchObject({
        status: 'down',
      });
    },
  );
});
