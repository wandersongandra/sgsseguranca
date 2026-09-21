import { WorkerHost } from '@nestjs/bullmq';
import { DiscoveryService } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { WorkerHeartbeatReporterService } from '../redis/worker-heartbeat-reporter.service';
import {
  WorkerReadinessService,
  WORKER_READINESS_TIMEOUT_MS,
} from './worker-readiness.service';

class TestProcessor extends WorkerHost {
  process(): Promise<void> {
    return Promise.resolve();
  }
}

function setup() {
  const queue = { status: 'ready', ping: jest.fn().mockResolvedValue('PONG') };
  const cache = { status: 'ready', ping: jest.fn().mockResolvedValue('PONG') };
  const client = { status: 'ready', hexists: jest.fn().mockResolvedValue(0) };
  const blockingClient = { status: 'ready' };
  const worker = {
    client: Promise.resolve(client),
    toKey: jest.fn(() => 'bull:synthetic:meta'),
    waitUntilReady: jest.fn().mockResolvedValue(blockingClient),
    isRunning: jest.fn().mockReturnValue(true),
    isPaused: jest.fn().mockReturnValue(false),
  };
  const processor = new TestProcessor();
  Object.defineProperty(processor, 'worker', {
    configurable: true,
    get: () => worker,
  });
  const discovery = { getProviders: jest.fn(() => [{ instance: processor }]) };
  const database = {
    isInitialized: true,
    query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
  const heartbeat = { isHealthy: jest.fn().mockReturnValue(true) };
  const service = new WorkerReadinessService(
    queue as unknown as Redis,
    { getClient: () => cache } as unknown as RedisService,
    database as unknown as DataSource,
    discovery as unknown as DiscoveryService,
    heartbeat as unknown as WorkerHeartbeatReporterService,
  );
  return {
    service,
    queue,
    cache,
    client,
    blockingClient,
    worker,
    processor,
    discovery,
    database,
    heartbeat,
  };
}

describe('WorkerReadinessService', () => {
  afterEach(() => jest.useRealTimers());

  it('requires application initialization without probing dependencies during startup', async () => {
    const { service, queue } = setup();
    await expect(service.check()).resolves.toBe(false);
    expect(queue.ping).not.toHaveBeenCalled();
  });

  it('accepts initialized consumers with healthy dependencies and a fresh local heartbeat', async () => {
    const { service, database, client } = setup();
    service.markInitialized();
    await expect(service.check()).resolves.toBe(true);
    expect(database.query).toHaveBeenCalledWith('SELECT 1');
    expect(client.hexists).toHaveBeenCalledWith(
      'bull:synthetic:meta',
      'paused',
    );
  });

  it.each([
    [
      'queue Redis disconnected',
      (s: ReturnType<typeof setup>) => {
        s.queue.status = 'reconnecting';
      },
    ],
    [
      'cache Redis unavailable',
      (s: ReturnType<typeof setup>) => {
        s.cache.ping.mockRejectedValue(new Error('synthetic'));
      },
    ],
    [
      'queue commands rejected',
      (s: ReturnType<typeof setup>) => {
        s.queue.ping.mockRejectedValue(new Error('synthetic'));
      },
    ],
    [
      'queue invalid response',
      (s: ReturnType<typeof setup>) => {
        s.queue.ping.mockResolvedValue('INVALID');
      },
    ],
    [
      'database unavailable',
      (s: ReturnType<typeof setup>) => {
        s.database.query.mockRejectedValue(new Error('synthetic'));
      },
    ],
    [
      'database startup incomplete',
      (s: ReturnType<typeof setup>) => {
        s.database.isInitialized = false;
      },
    ],
    [
      'consumer stopped',
      (s: ReturnType<typeof setup>) => {
        s.worker.isRunning.mockReturnValue(false);
      },
    ],
    [
      'consumer paused',
      (s: ReturnType<typeof setup>) => {
        s.worker.isPaused.mockReturnValue(true);
      },
    ],
    [
      'consumer connection down',
      (s: ReturnType<typeof setup>) => {
        s.client.status = 'end';
      },
    ],
    [
      'consumer commands rejected',
      (s: ReturnType<typeof setup>) => {
        s.client.hexists.mockRejectedValue(new Error('synthetic'));
      },
    ],
    [
      'blocking connection down',
      (s: ReturnType<typeof setup>) => {
        s.blockingClient.status = 'reconnecting';
      },
    ],
    [
      'consumer initialization failed',
      (s: ReturnType<typeof setup>) => {
        s.worker.waitUntilReady.mockRejectedValue(new Error('synthetic'));
      },
    ],
    [
      'processor not initialized',
      (s: ReturnType<typeof setup>) => {
        Object.defineProperty(s.processor, 'worker', {
          get: () => {
            throw new Error('uninitialized');
          },
        });
      },
    ],
    [
      'heartbeat stale or failed',
      (s: ReturnType<typeof setup>) => {
        s.heartbeat.isHealthy.mockReturnValue(false);
      },
    ],
    [
      'no registered consumers',
      (s: ReturnType<typeof setup>) => {
        s.discovery.getProviders.mockReturnValue([]);
      },
    ],
  ])('fails closed: %s', async (_name, breakDependency) => {
    const state = setup();
    breakDependency(state);
    state.service.markInitialized();
    await expect(state.service.check()).resolves.toBe(false);
  });

  it('bounds hanging probes and does not accumulate Redis commands after timeout', async () => {
    jest.useFakeTimers();
    const { service, queue } = setup();
    let finish!: (value: string) => void;
    queue.ping.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    service.markInitialized();
    const first = service.check();
    await jest.advanceTimersByTimeAsync(WORKER_READINESS_TIMEOUT_MS);
    await expect(first).resolves.toBe(false);
    const second = service.check();
    await jest.advanceTimersByTimeAsync(WORKER_READINESS_TIMEOUT_MS);
    await expect(second).resolves.toBe(false);
    expect(queue.ping).toHaveBeenCalledTimes(1);
    finish('PONG');
    await jest.advanceTimersByTimeAsync(0);
    queue.ping.mockResolvedValue('PONG');
    await expect(service.check()).resolves.toBe(true);
  });

  it('does not report ready if shutdown begins while a probe is running', async () => {
    const { service } = setup();
    service.markInitialized();
    const result = service.check();
    service.markShuttingDown();
    await expect(result).resolves.toBe(false);
  });
});
