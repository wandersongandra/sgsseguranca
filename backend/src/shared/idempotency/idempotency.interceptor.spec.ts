import {
  BadRequestException,
  ConflictException,
  type ExecutionContext,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { DurableIdempotencyPersistenceException } from './idempotency.service';
import { TenantService } from '../tenant/tenant.service';

describe('IdempotencyInterceptor', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createContext(input: {
    method?: string;
    headers?: Record<string, string>;
    user?: { userId?: string; id?: string };
    body?: unknown;
    query?: unknown;
    params?: unknown;
    path?: string;
  }): ExecutionContext {
    const request = {
      method: input.method ?? 'POST',
      path: input.path ?? '/auth/login',
      headers: input.headers ?? {},
      user: input.user,
      body: input.body,
      query: input.query,
      params: input.params,
    };
    const response = {
      statusCode: 201,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
  }

  it('não compartilha cache idempotente entre requisições públicas anônimas', async () => {
    jest.spyOn(TenantService, 'currentTenantId').mockReturnValue(undefined);
    const idempotencyService = {
      getRecord: jest.fn(),
      markProcessing: jest.fn(),
      saveResponse: jest.fn(),
      deleteRecord: jest.fn(),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);

    const result = await lastValueFrom(
      interceptor.intercept(
        createContext({
          headers: { 'x-idempotency-key': 'same-public-key' },
        }),
        { handle: () => of({ accessToken: 'sensitive' }) },
      ),
    );

    expect(result).toEqual({ accessToken: 'sensitive' });
    expect(idempotencyService.getRecord).not.toHaveBeenCalled();
    expect(idempotencyService.saveResponse).not.toHaveBeenCalled();
  });

  it('isola a chave pelo tenant e pelo usuário autenticado', async () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    const idempotencyService = {
      getRecord: jest.fn().mockResolvedValue(null),
      markProcessing: jest.fn().mockResolvedValue('acquired'),
      saveResponse: jest.fn().mockResolvedValue(undefined),
      deleteRecord: jest.fn().mockResolvedValue(undefined),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);

    await lastValueFrom(
      interceptor.intercept(
        createContext({
          headers: { 'X-Idempotency-Key': 'request-123' },
          user: { userId: '22222222-2222-4222-8222-222222222222' },
        }),
        { handle: () => of({ ok: true }) },
      ),
    );

    expect(idempotencyService.getRecord).toHaveBeenCalledWith(
      'tenant:11111111-1111-4111-8111-111111111111:user:22222222-2222-4222-8222-222222222222',
      'POST',
      '/auth/login',
      'request-123',
    );
    expect(idempotencyService.saveResponse).toHaveBeenCalledWith(
      'tenant:11111111-1111-4111-8111-111111111111:user:22222222-2222-4222-8222-222222222222',
      'POST',
      '/auth/login',
      'request-123',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      201,
      { ok: true },
    );
  });

  it('reutiliza o replay quando a ordem das propriedades JSON muda', async () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    let record: {
      status: 'processing' | 'completed';
      requestHash: string;
      statusCode?: number;
      body?: unknown;
      responseStored?: boolean;
      createdAt: number;
    } | null = null;
    let sideEffects = 0;
    const idempotencyService = {
      getRecord: jest.fn().mockImplementation(() => Promise.resolve(record)),
      markProcessing: jest
        .fn()
        .mockImplementation(
          (
            _scopeId: string,
            _method: string,
            _path: string,
            _idempotencyKey: string,
            requestHash: string,
          ) => {
            if (record) return Promise.resolve('exists');
            record = {
              status: 'processing',
              requestHash,
              createdAt: Date.now(),
            };
            return Promise.resolve('acquired');
          },
        ),
      saveResponse: jest
        .fn()
        .mockImplementation(
          (
            _scopeId: string,
            _method: string,
            _path: string,
            _idempotencyKey: string,
            requestHash: string,
            statusCode: number,
            body: unknown,
          ) => {
            record = {
              status: 'completed',
              requestHash,
              statusCode,
              body,
              responseStored: true,
              createdAt: Date.now(),
            };
            return Promise.resolve();
          },
        ),
      deleteRecord: jest.fn().mockResolvedValue(undefined),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);
    const first = {
      headers: { 'x-idempotency-key': 'canonical-order' },
      user: { userId: '22222222-2222-4222-8222-222222222222' },
      body: { alpha: 1, nested: { first: true, second: 'value' } },
    };
    const second = {
      ...first,
      body: { nested: { second: 'value', first: true }, alpha: 1 },
    };

    const handler = {
      handle: () => {
        sideEffects += 1;
        return of({ created: true });
      },
    };
    await expect(
      lastValueFrom(interceptor.intercept(createContext(first), handler)),
    ).resolves.toEqual({ created: true });
    await expect(
      lastValueFrom(interceptor.intercept(createContext(second), handler)),
    ).resolves.toEqual({ created: true });

    expect(sideEffects).toBe(1);
    expect(idempotencyService.saveResponse).toHaveBeenCalledTimes(1);
  });

  it.each([2, 5, 10, 20])(
    'executa o efeito uma vez sob concorrência de %i chamadas',
    async (concurrency) => {
      jest
        .spyOn(TenantService, 'currentTenantId')
        .mockReturnValue('11111111-1111-4111-8111-111111111111');
      let record: {
        status: 'processing' | 'completed';
        requestHash: string;
        statusCode?: number;
        body?: unknown;
        responseStored?: boolean;
        createdAt: number;
      } | null = null;
      let sideEffects = 0;
      const idempotencyService = {
        getRecord: jest.fn().mockImplementation(() => Promise.resolve(record)),
        markProcessing: jest
          .fn()
          .mockImplementation(
            (
              _scopeId: string,
              _method: string,
              _path: string,
              _idempotencyKey: string,
              requestHash: string,
            ) => {
              if (record) return Promise.resolve('exists');
              record = {
                status: 'processing',
                requestHash,
                createdAt: Date.now(),
              };
              return Promise.resolve('acquired');
            },
          ),
        saveResponse: jest
          .fn()
          .mockImplementation(
            (
              _scopeId: string,
              _method: string,
              _path: string,
              _idempotencyKey: string,
              requestHash: string,
              statusCode: number,
              body: unknown,
            ) => {
              record = {
                status: 'completed',
                requestHash,
                statusCode,
                body,
                responseStored: true,
                createdAt: Date.now(),
              };
              return Promise.resolve();
            },
          ),
        deleteRecord: jest.fn().mockResolvedValue(undefined),
      };
      const first = new IdempotencyInterceptor(idempotencyService as never);
      const second = new IdempotencyInterceptor(idempotencyService as never);
      const handler = {
        handle: () => {
          sideEffects += 1;
          return of({ created: true });
        },
      };
      const outcomes = await Promise.allSettled(
        Array.from({ length: concurrency }, (_, index) =>
          lastValueFrom(
            (index % 2 === 0 ? first : second).intercept(
              createContext({
                headers: { 'x-idempotency-key': 'concurrent-key' },
                user: { userId: '22222222-2222-4222-8222-222222222222' },
                body: { amount: 100 },
              }),
              handler,
            ),
          ),
        ),
      );

      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<unknown> =>
          outcome.status === 'fulfilled',
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(concurrency - 1);
      expect(
        rejected.every(
          (outcome) => outcome.reason instanceof ConflictException,
        ),
      ).toBe(true);
      expect(sideEffects).toBe(1);
      expect(idempotencyService.saveResponse).toHaveBeenCalledTimes(1);
    },
  );

  it('não cria cache apenas com contexto tenant quando não há usuário autenticado', async () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    const idempotencyService = {
      getRecord: jest.fn(),
      markProcessing: jest.fn(),
      saveResponse: jest.fn(),
      deleteRecord: jest.fn(),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);

    await lastValueFrom(
      interceptor.intercept(
        createContext({
          headers: { 'x-idempotency-key': 'tenant-public-key' },
        }),
        { handle: () => of({ ok: true }) },
      ),
    );

    expect(idempotencyService.getRecord).not.toHaveBeenCalled();
    expect(idempotencyService.saveResponse).not.toHaveBeenCalled();
  });

  it('rejeita chave com caracteres que alterariam o namespace Redis', () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    const interceptor = new IdempotencyInterceptor({} as never);

    expect(() =>
      interceptor.intercept(
        createContext({
          headers: { 'x-idempotency-key': 'invalid key with spaces' },
          user: { userId: '22222222-2222-4222-8222-222222222222' },
        }),
        { handle: () => of({ ok: true }) },
      ),
    ).toThrow(BadRequestException);
  });

  it('rejeita reutilização da chave com payload diferente', async () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    const idempotencyService = {
      getRecord: jest.fn().mockResolvedValue({
        status: 'completed',
        requestHash: '0'.repeat(64),
        responseStored: true,
        body: { ok: true },
        createdAt: Date.now(),
      }),
      markProcessing: jest.fn(),
      saveResponse: jest.fn(),
      deleteRecord: jest.fn(),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);

    await expect(
      lastValueFrom(
        interceptor.intercept(
          createContext({
            headers: { 'x-idempotency-key': 'request-123' },
            user: { userId: '22222222-2222-4222-8222-222222222222' },
            body: { amount: 200 },
          }),
          { handle: () => of({ ok: true }) },
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(idempotencyService.markProcessing).not.toHaveBeenCalled();
  });

  it('preserva o sucesso da operação quando a persistência da resposta falha', async () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    const idempotencyService = {
      getRecord: jest.fn().mockResolvedValue(null),
      markProcessing: jest.fn().mockResolvedValue('acquired'),
      saveResponse: jest
        .fn()
        .mockRejectedValue(new Error('redis indisponível')),
      deleteRecord: jest.fn().mockResolvedValue(undefined),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);
    const context = createContext({
      headers: { 'x-idempotency-key': 'request-123' },
      user: { userId: '22222222-2222-4222-8222-222222222222' },
      body: { amount: 100 },
    });

    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => of({ created: true }),
        }),
      ),
    ).resolves.toEqual({ created: true });

    const response = context.switchToHttp().getResponse<{
      setHeader: jest.Mock;
    }>();
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Idempotency-Status',
      'persistence-degraded',
    );
    expect(idempotencyService.deleteRecord).not.toHaveBeenCalled();
  });

  it('não mascara falha ao persistir a conclusão durável no PostgreSQL', async () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    let sideEffects = 0;
    const idempotencyService = {
      getRecord: jest.fn().mockResolvedValue(null),
      markProcessing: jest.fn().mockResolvedValue('acquired'),
      saveResponse: jest
        .fn()
        .mockRejectedValue(new DurableIdempotencyPersistenceException()),
      deleteRecord: jest.fn().mockResolvedValue(undefined),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);
    const context = createContext({
      headers: { 'x-idempotency-key': 'durable-write-failure' },
      user: { userId: '22222222-2222-4222-8222-222222222222' },
      body: { amount: 100 },
    });

    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => {
            sideEffects += 1;
            return of({ created: true });
          },
        }),
      ),
    ).rejects.toBeInstanceOf(DurableIdempotencyPersistenceException);

    expect(sideEffects).toBe(1);
    const response = context
      .switchToHttp()
      .getResponse<{ setHeader: jest.Mock }>();
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('não repete o efeito quando o Redis falha após o commit durável', async () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');

    let durableRecord: unknown = null;
    let sideEffects = 0;
    const idempotencyService = {
      getRecord: jest
        .fn()
        .mockImplementation(() => Promise.resolve(durableRecord)),
      markProcessing: jest.fn().mockResolvedValue('acquired'),
      saveResponse: jest
        .fn()
        .mockImplementationOnce(
          (
            _scopeId: string,
            _method: string,
            _path: string,
            _idempotencyKey: string,
            requestHash: string,
            statusCode: number,
            body: unknown,
          ) => {
            durableRecord = {
              status: 'completed',
              requestHash,
              statusCode,
              body,
              responseStored: true,
              createdAt: Date.now(),
            };
            return Promise.reject(new Error('redis indisponível'));
          },
        )
        .mockResolvedValue(undefined),
      deleteRecord: jest.fn().mockResolvedValue(undefined),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);
    const request = createContext({
      headers: { 'x-idempotency-key': 'be-006-retry' },
      user: { userId: '22222222-2222-4222-8222-222222222222' },
      body: { amount: 100 },
    });
    const handler = {
      handle: () => {
        sideEffects += 1;
        return of({ created: true, sideEffects });
      },
    };

    await expect(
      lastValueFrom(interceptor.intercept(request, handler)),
    ).resolves.toEqual({
      created: true,
      sideEffects: 1,
    });

    await expect(
      lastValueFrom(interceptor.intercept(request, handler)),
    ).resolves.toEqual({
      created: true,
      sideEffects: 1,
    });

    expect(durableRecord).toEqual(
      expect.objectContaining({ status: 'completed', responseStored: true }),
    );
    expect(sideEffects).toBe(1);
  });

  it('bloqueia retry quando a finalização durável falha e deixa a reserva em processing', async () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');

    let record: unknown = null;
    let sideEffects = 0;
    const idempotencyService = {
      getRecord: jest.fn().mockImplementation(() => Promise.resolve(record)),
      markProcessing: jest.fn().mockImplementation(() => {
        record = {
          status: 'processing',
          requestHash: 'a'.repeat(64),
          createdAt: Date.now(),
        };
        return Promise.resolve('acquired');
      }),
      saveResponse: jest
        .fn()
        .mockRejectedValue(new DurableIdempotencyPersistenceException()),
      deleteRecord: jest.fn().mockResolvedValue(undefined),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);
    const request = createContext({
      headers: { 'x-idempotency-key': 'durable-finalization-failure' },
      user: { userId: '22222222-2222-4222-8222-222222222222' },
      body: { amount: 101 },
    });
    const handler = {
      handle: () => {
        sideEffects += 1;
        return of({ created: true });
      },
    };

    await expect(
      lastValueFrom(interceptor.intercept(request, handler)),
    ).rejects.toBeInstanceOf(DurableIdempotencyPersistenceException);
    await expect(
      lastValueFrom(interceptor.intercept(request, handler)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(sideEffects).toBe(1);
  });

  it('libera a chave quando a própria operação falha', async () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    const operationError = new Error('falha da operação');
    const idempotencyService = {
      getRecord: jest.fn().mockResolvedValue(null),
      markProcessing: jest.fn().mockResolvedValue('acquired'),
      saveResponse: jest.fn(),
      deleteRecord: jest.fn().mockResolvedValue(undefined),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);

    await expect(
      lastValueFrom(
        interceptor.intercept(
          createContext({
            headers: { 'x-idempotency-key': 'request-123' },
            user: { userId: '22222222-2222-4222-8222-222222222222' },
          }),
          { handle: () => throwError(() => operationError) },
        ),
      ),
    ).rejects.toBe(operationError);
    expect(idempotencyService.deleteRecord).toHaveBeenCalledTimes(1);
    expect(idempotencyService.saveResponse).not.toHaveBeenCalled();
  });

  it('não reexecuta operação concluída cuja resposta excedeu o limite', async () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    let capturedRequestHash = '';
    const idempotencyService = {
      getRecord: jest.fn().mockImplementation(() => {
        if (!capturedRequestHash) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          status: 'completed' as const,
          requestHash: capturedRequestHash,
          responseStored: false,
          createdAt: Date.now(),
        });
      }),
      markProcessing: jest
        .fn()
        .mockImplementation(
          (...args: [string, string, string, string, string]) => {
            const requestHash = args[4];
            capturedRequestHash = requestHash;
            return Promise.resolve('acquired');
          },
        ),
      saveResponse: jest.fn().mockResolvedValue(undefined),
      deleteRecord: jest.fn(),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);
    const input = {
      headers: { 'x-idempotency-key': 'request-123' },
      user: { userId: '22222222-2222-4222-8222-222222222222' },
      body: { amount: 100 },
    };

    await lastValueFrom(
      interceptor.intercept(createContext(input), {
        handle: () => of({ created: true }),
      }),
    );

    await expect(
      lastValueFrom(
        interceptor.intercept(createContext(input), {
          handle: () => of({ duplicated: true }),
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('ignora idempotência para upload multipart', async () => {
    jest
      .spyOn(TenantService, 'currentTenantId')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    const idempotencyService = {
      getRecord: jest.fn(),
      markProcessing: jest.fn(),
      saveResponse: jest.fn(),
      deleteRecord: jest.fn(),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService as never);

    await lastValueFrom(
      interceptor.intercept(
        createContext({
          headers: {
            'x-idempotency-key': 'upload-123',
            'content-type': 'multipart/form-data; boundary=test',
          },
          user: { userId: '22222222-2222-4222-8222-222222222222' },
        }),
        { handle: () => of({ ok: true }) },
      ),
    );

    expect(idempotencyService.getRecord).not.toHaveBeenCalled();
  });
});
