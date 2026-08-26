import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  DurableIdempotencyPersistenceException,
  IdempotencyService,
} from './idempotency.service';

describe('IdempotencyService', () => {
  function createService(options?: {
    ttlSeconds?: number;
    maxResponseBytes?: number;
    maxKeysPerScope?: number;
  }) {
    const storedValues: string[] = [];
    const redis = {
      set: jest.fn().mockImplementation((_key: string, value: string) => {
        storedValues.push(value);
        return Promise.resolve('OK');
      }),
      get: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
      decr: jest.fn().mockResolvedValue(0),
      expire: jest.fn().mockResolvedValue(1),
    };
    const values: Record<string, number | undefined> = {
      IDEMPOTENCY_TTL_SECONDS: options?.ttlSeconds,
      IDEMPOTENCY_MAX_RESPONSE_BYTES: options?.maxResponseBytes,
      IDEMPOTENCY_MAX_KEYS_PER_SCOPE: options?.maxKeysPerScope,
    };
    const configService = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    const dataSource = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT')) {
          return Promise.resolve([]);
        }
        if (sql.includes('RETURNING')) {
          return Promise.resolve([{ id: 'durable-id' }]);
        }
        return Promise.resolve([]);
      }),
    };

    return {
      redis,
      storedValues,
      dataSource,
      service: new IdempotencyService(
        redis as never,
        configService,
        dataSource as never,
      ),
    };
  }

  const quotaKey = (scopeId: string): string =>
    `idempotency:quota:${createHash('sha256').update(scopeId).digest('hex')}`;

  it('limita a quantidade de chaves por escopo e remove a excedente', async () => {
    const { redis, service } = createService({ maxKeysPerScope: 1 });
    redis.incr.mockResolvedValue(2);
    redis.del.mockResolvedValue(1);

    await expect(
      service.markProcessing(
        'tenant:t:user:u',
        'POST',
        '/reports',
        'key-2',
        'a'.repeat(64),
      ),
    ).resolves.toBe('quota_exceeded');
    expect(redis.del).toHaveBeenCalledWith(
      'idempotency:tenant:t:user:u:POST:/reports:key-2',
    );
    expect(redis.decr).toHaveBeenCalledWith(quotaKey('tenant:t:user:u'));
  });

  it('devolve a quota quando remove um registro ativo', async () => {
    const { redis, service } = createService();
    redis.del.mockResolvedValue(1);

    await service.deleteRecord('tenant:t:user:u', 'POST', '/reports', 'key-1');

    expect(redis.del).toHaveBeenCalledWith(
      'idempotency:tenant:t:user:u:POST:/reports:key-1',
    );
    expect(redis.decr).toHaveBeenCalledWith(quotaKey('tenant:t:user:u'));
  });

  it('não decrementa quota se o incremento falhar antes de aplicar contador', async () => {
    const { redis, service } = createService();
    redis.incr.mockRejectedValue(new Error('redis down'));

    await expect(
      service.markProcessing(
        'tenant:t:user:u',
        'POST',
        '/reports',
        'key-3',
        'a'.repeat(64),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(redis.del).toHaveBeenCalledWith(
      'idempotency:tenant:t:user:u:POST:/reports:key-3',
    );
    expect(redis.decr).not.toHaveBeenCalled();
  });

  it('não cria contador negativo ao remover registro quando a quota expirou', async () => {
    const { redis, service } = createService();
    redis.del.mockResolvedValue(1);
    redis.exists.mockResolvedValue(0);

    await service.deleteRecord('tenant:t:user:u', 'POST', '/reports', 'key-4');

    expect(redis.exists).toHaveBeenCalledWith(quotaKey('tenant:t:user:u'));
    expect(redis.decr).not.toHaveBeenCalled();
  });

  it('não armazena corpo de resposta acima do limite configurado', async () => {
    const { redis, storedValues, service } = createService({
      maxResponseBytes: 1024,
    });

    await service.saveResponse(
      'tenant:t:user:u',
      'POST',
      '/reports',
      'key-1',
      'a'.repeat(64),
      201,
      { content: 'x'.repeat(2048) },
    );

    const serializedRecord: unknown = storedValues[0];
    expect(typeof serializedRecord).toBe('string');
    if (typeof serializedRecord !== 'string') {
      throw new Error('Registro idempotente não serializado.');
    }
    const record = JSON.parse(serializedRecord) as Record<string, unknown>;
    expect(record.responseStored).toBe(false);
    expect(record).not.toHaveProperty('body');
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'EX',
      3600,
    );
  });

  it('não avança nem atualiza o Redis quando a conclusão durável falha', async () => {
    const { dataSource, redis, service } = createService();
    dataSource.query.mockRejectedValueOnce(new Error('postgres down'));

    await expect(
      service.saveResponse(
        'tenant:t:user:u',
        'POST',
        '/reports',
        'key-pg-failure',
        'a'.repeat(64),
        201,
        { id: 'synthetic-1' },
      ),
    ).rejects.toBeInstanceOf(DurableIdempotencyPersistenceException);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('não persiste campos sensíveis no corpo de replay', async () => {
    const { dataSource, service, storedValues } = createService();

    await service.saveResponse(
      'tenant:t:user:u',
      'POST',
      '/auth/rotate',
      'key-sensitive',
      'a'.repeat(64),
      200,
      { accessToken: 'synthetic-token', result: 'ok' },
    );

    const queryMock = dataSource.query as jest.MockedFunction<
      (sql: string, ...parameters: unknown[]) => Promise<unknown[]>
    >;
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      sql.includes('UPDATE idempotency_durable_records'),
    );
    expect(updateCall?.[1]).toEqual(expect.arrayContaining([null, false]));
    const redisRecord = JSON.parse(storedValues[0]) as Record<string, unknown>;
    expect(redisRecord.responseStored).toBe(false);
    expect(redisRecord).not.toHaveProperty('body');
  });

  it('não usa registros Redis sem autoridade durável no PostgreSQL', async () => {
    const { redis, service } = createService();
    redis.get.mockResolvedValue(
      JSON.stringify({
        status: 'completed',
        body: { sensitive: true },
        createdAt: Date.now(),
      }),
    );

    await expect(
      service.getRecord('tenant:t:user:u', 'POST', '/reports', 'key-1'),
    ).resolves.toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('não aceita COMPLETED do Redis quando o PostgreSQL não possui registro durável', async () => {
    const { redis, dataSource, service } = createService();
    redis.get.mockResolvedValue(
      JSON.stringify({
        status: 'completed',
        requestHash: 'a'.repeat(64),
        statusCode: 201,
        body: { id: 'redis-only' },
        responseStored: true,
        createdAt: Date.now(),
      }),
    );
    dataSource.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await expect(
      service.getRecord('tenant:t:user:u', 'POST', '/reports', 'poisoned'),
    ).resolves.toBeNull();
  });

  it('reproduz replay durável quando Redis cai após a conclusão', async () => {
    const { redis, dataSource, service } = createService();
    const requestHash = 'a'.repeat(64);

    await expect(
      service.markProcessing(
        'tenant:t:user:u',
        'POST',
        '/reports',
        'key-after-commit',
        requestHash,
      ),
    ).resolves.toBe('acquired');

    redis.set.mockRejectedValueOnce(new Error('redis final indisponível'));
    await expect(
      service.saveResponse(
        'tenant:t:user:u',
        'POST',
        '/reports',
        'key-after-commit',
        requestHash,
        201,
        { id: 'synthetic-1' },
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    dataSource.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT')) {
        return Promise.resolve([
          {
            status: 'completed',
            request_hash: requestHash,
            response_status: 201,
            response_body: { id: 'synthetic-1' },
            response_stored: true,
            created_at: new Date(),
          },
        ]);
      }
      return Promise.resolve([]);
    });
    redis.get.mockRejectedValueOnce(new Error('redis continua indisponível'));

    await expect(
      service.getRecord(
        'tenant:t:user:u',
        'POST',
        '/reports',
        'key-after-commit',
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        requestHash,
        statusCode: 201,
        body: { id: 'synthetic-1' },
      }),
    );
    expect(redis.get).not.toHaveBeenCalled();
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE idempotency_durable_records'),
      expect.any(Array),
    );
  });

  it('falha fechada antes da operação quando a autoridade PostgreSQL não responde', async () => {
    const { dataSource, service } = createService();
    dataSource.query.mockRejectedValue(new Error('postgres down'));

    await expect(
      service.getRecord('tenant:t:user:u', 'POST', '/reports', 'pre-op'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('não executa sem reserva durável quando o Redis cai após a reserva', async () => {
    const { dataSource, redis, service } = createService();
    redis.set.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      service.markProcessing(
        'tenant:t:user:u',
        'POST',
        '/reports',
        'redis-before-domain',
        'a'.repeat(64),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM idempotency_durable_records'),
      expect.any(Array),
    );
  });

  it.each([2, 5, 10, 20])(
    'permite somente uma reserva durável concorrente para a mesma chave (%i chamadas)',
    async (concurrency) => {
      let durableExists = false;
      const redis = {
        set: jest.fn().mockResolvedValue('OK'),
        get: jest.fn().mockResolvedValue(null),
        exists: jest.fn().mockResolvedValue(1),
        del: jest.fn().mockResolvedValue(1),
        incr: jest.fn().mockResolvedValue(1),
        decr: jest.fn().mockResolvedValue(0),
        expire: jest.fn().mockResolvedValue(1),
      };
      const dataSource = {
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('INSERT')) {
            if (durableExists) return Promise.resolve([]);
            durableExists = true;
            return Promise.resolve([{ id: 'durable-id' }]);
          }
          return Promise.resolve([]);
        }),
      };
      const configService = {
        get: jest.fn().mockReturnValue(undefined),
      } as unknown as ConfigService;
      const serviceA = new IdempotencyService(
        redis as never,
        configService,
        dataSource as never,
      );
      const serviceB = new IdempotencyService(
        redis as never,
        configService,
        dataSource as never,
      );

      const results = await Promise.all(
        Array.from({ length: concurrency }, (_, index) =>
          (index % 2 === 0 ? serviceA : serviceB).markProcessing(
            'tenant:t:user:u',
            'POST',
            '/reports',
            'same',
            'a'.repeat(64),
          ),
        ),
      );
      expect(results.filter((result) => result === 'acquired')).toHaveLength(1);
      expect(results.filter((result) => result === 'exists')).toHaveLength(
        concurrency - 1,
      );
      expect(redis.set).toHaveBeenCalledTimes(1);
    },
  );

  it('mantém método e rota como parte da identidade durável', async () => {
    const identities: Array<{ method: unknown; path: unknown }> = [];
    const dataSource = {
      query: jest.fn().mockImplementation((sql: string, params: unknown[]) => {
        if (sql.includes('INSERT')) {
          identities.push({ method: params[1], path: params[2] });
          return Promise.resolve([{ id: 'durable-id' }]);
        }
        return Promise.resolve([]);
      }),
    };
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const service = new IdempotencyService(
      {
        set: jest.fn().mockResolvedValue('OK'),
        get: jest.fn().mockResolvedValue(null),
        exists: jest.fn().mockResolvedValue(1),
        del: jest.fn().mockResolvedValue(1),
        incr: jest.fn().mockResolvedValue(1),
        decr: jest.fn().mockResolvedValue(0),
        expire: jest.fn().mockResolvedValue(1),
      } as never,
      configService,
      dataSource as never,
    );

    await service.markProcessing(
      'tenant:t:user:u',
      'POST',
      '/resource-a',
      'same-key',
      'a'.repeat(64),
    );
    await service.markProcessing(
      'tenant:t:user:u',
      'POST',
      '/resource-b',
      'same-key',
      'a'.repeat(64),
    );
    await service.markProcessing(
      'tenant:t:user:u',
      'PATCH',
      '/resource-a',
      'same-key',
      'a'.repeat(64),
    );

    expect(identities).toEqual([
      { method: 'POST', path: '/resource-a' },
      { method: 'POST', path: '/resource-b' },
      { method: 'PATCH', path: '/resource-a' },
    ]);
  });

  it('isola a mesma chave por hash de tenant e usuário', async () => {
    const insertScopeHashes: string[] = [];
    const dataSource = {
      query: jest.fn().mockImplementation((sql: string, params: unknown[]) => {
        if (sql.includes('INSERT')) {
          insertScopeHashes.push(String(params[0]));
          return Promise.resolve([{ id: 'durable-id' }]);
        }
        return Promise.resolve([]);
      }),
    };
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const isolatedService = new IdempotencyService(
      {
        set: jest.fn().mockResolvedValue('OK'),
        get: jest.fn().mockResolvedValue(null),
        exists: jest.fn().mockResolvedValue(1),
        del: jest.fn().mockResolvedValue(1),
        incr: jest.fn().mockResolvedValue(1),
        decr: jest.fn().mockResolvedValue(0),
        expire: jest.fn().mockResolvedValue(1),
      } as never,
      configService,
      dataSource as never,
    );
    const requestHash = 'b'.repeat(64);

    await isolatedService.markProcessing(
      'tenant:a:user:u',
      'POST',
      '/reports',
      'same-key',
      requestHash,
    );
    await isolatedService.markProcessing(
      'tenant:b:user:u',
      'POST',
      '/reports',
      'same-key',
      requestHash,
    );

    expect(insertScopeHashes).toHaveLength(2);
    expect(insertScopeHashes[0]).not.toBe(insertScopeHashes[1]);
  });
});
