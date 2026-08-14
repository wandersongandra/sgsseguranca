import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import {
  DistributedLockHandle,
  DistributedLockService,
} from '../../../shared/redis/distributed-lock.service';
import { NonConformityWorkflowLockService } from './nonconformity-workflow-lock.service';

describe('NonConformityWorkflowLockService', () => {
  const handle: DistributedLockHandle = {
    key: 'lock:nonconformity:workflow:nc-1',
    token: 'token-1',
  };

  function createService(): {
    service: NonConformityWorkflowLockService;
    tryAcquire: jest.Mock;
    extend: jest.Mock;
    release: jest.Mock;
  } {
    const tryAcquire = jest.fn().mockResolvedValue(handle);
    const extend = jest.fn().mockResolvedValue(true);
    const release = jest.fn().mockResolvedValue(true);
    const distributedLock = {
      tryAcquire,
      extend,
      release,
    } as unknown as DistributedLockService;

    return {
      service: new NonConformityWorkflowLockService(distributedLock),
      tryAcquire,
      extend,
      release,
    };
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('adquire uma única vez com chave Redis completa e libera por token', async () => {
    const { service, tryAcquire, release } = createService();
    const operation = jest.fn(() => Promise.resolve('done'));

    await expect(service.runExclusive('nc-1', operation)).resolves.toBe('done');

    expect(tryAcquire).toHaveBeenCalledWith(
      'lock:nonconformity:workflow:nc-1',
      600_000,
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(handle);
  });

  it('falha rápido com conflito quando outra operação já possui a NC', async () => {
    const { service, tryAcquire, release } = createService();
    tryAcquire.mockResolvedValue(null);
    const operation = jest.fn(() => Promise.resolve('should-not-run'));

    await expect(
      service.runExclusive('nc-1', operation),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(operation).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('falha fechada com 503 se Redis estiver indisponível na aquisição', async () => {
    const { service, tryAcquire, release } = createService();
    tryAcquire.mockRejectedValue(new Error('redis offline'));
    const operation = jest.fn(() => Promise.resolve('should-not-run'));

    await expect(
      service.runExclusive('nc-1', operation),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(operation).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('renova o lease durante operação longa e o libera ao final', async () => {
    jest.useFakeTimers();
    const { service, extend, release } = createService();
    let resolveOperation!: (value: string) => void;
    const operation = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveOperation = resolve;
        }),
    );

    const pending = service.runExclusive('nc-1', operation);
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(60_000);
    expect(extend).toHaveBeenCalledWith(handle, 600_000);

    resolveOperation('done');
    await expect(pending).resolves.toBe('done');
    expect(release).toHaveBeenCalledWith(handle);
  });

  it('bloqueia a persistência quando a renovação perde a posse do token', async () => {
    jest.useFakeTimers();
    const { service, extend, release } = createService();
    extend.mockResolvedValue(false);
    let finishOperation!: () => void;
    const pending = service.runExclusive(
      'nc-1',
      (assertLeaseHealthy) =>
        new Promise<string>((resolve, reject) => {
          finishOperation = () => {
            try {
              // Representa o ponto imediatamente anterior à escrita no banco.
              assertLeaseHealthy();
              resolve('done');
            } catch (error) {
              reject(
                error instanceof Error ? error : new Error('Lease inválido'),
              );
            }
          };
        }),
    );
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(60_000);
    finishOperation();

    await expect(pending).rejects.toBeInstanceOf(ConflictException);
    expect(release).toHaveBeenCalledWith(handle);
  });
});
