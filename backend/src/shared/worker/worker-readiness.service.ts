import { Inject, Injectable } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT_BULLMQ } from '../redis/redis.constants';
import { RedisService } from '../redis/redis.service';
import { WorkerHeartbeatReporterService } from '../redis/worker-heartbeat-reporter.service';

export const WORKER_READINESS_TIMEOUT_MS = 2_000;

@Injectable()
export class WorkerReadinessService {
  private initialized = false;
  private processors: WorkerHost[] = [];
  private probe?: Promise<boolean>;

  constructor(
    @Inject(REDIS_CLIENT_BULLMQ) private readonly queueClient: Redis,
    private readonly redisService: RedisService,
    private readonly dataSource: DataSource,
    private readonly discovery: DiscoveryService,
    private readonly heartbeat: WorkerHeartbeatReporterService,
  ) {}

  markInitialized(): void {
    this.processors = this.discovery
      .getProviders()
      .map(({ instance }: { instance: unknown }) => instance)
      .filter(
        (instance): instance is WorkerHost => instance instanceof WorkerHost,
      );
    this.initialized = true;
  }

  markShuttingDown(): void {
    this.initialized = false;
  }

  async check(): Promise<boolean> {
    if (!this.initialized || !this.heartbeat.isHealthy()) return false;

    // Keep one operation in flight even after the HTTP deadline. A disconnected
    // BullMQ client can queue commands indefinitely; probes must not accumulate.
    if (!this.probe) {
      const probe = this.checkDependencies().catch(() => false);
      this.probe = probe;
      void probe.then(() => {
        if (this.probe === probe) this.probe = undefined;
      });
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      const ready = await Promise.race([
        this.probe,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), WORKER_READINESS_TIMEOUT_MS);
        }),
      ]);
      return ready && this.initialized && this.heartbeat.isHealthy();
    } finally {
      clearTimeout(timer);
    }
  }

  private async checkDependencies(): Promise<boolean> {
    const cacheClient = this.redisService.getClient();
    if (
      !this.dataSource.isInitialized ||
      this.queueClient.status !== 'ready' ||
      cacheClient.status !== 'ready' ||
      this.processors.length === 0
    ) {
      return false;
    }

    const checks = await Promise.allSettled([
      this.queueClient.ping().then((value) => value === 'PONG'),
      cacheClient.ping().then((value) => value === 'PONG'),
      this.dataSource.query('SELECT 1').then(() => true),
      ...this.processors.map(async (processor) => {
        const worker = processor.worker;
        if (!worker.isRunning() || worker.isPaused()) return false;
        const [client, blockingClient] = await Promise.all([
          worker.client,
          worker.waitUntilReady(),
        ]);
        // Do not PING the blocking client: an idle consumer is blocked waiting
        // for jobs. Read the queue pause flag through its command connection.
        return (
          client.status === 'ready' &&
          blockingClient.status === 'ready' &&
          (await client.hexists(worker.toKey('meta'), 'paused')) === 0 &&
          worker.isRunning() &&
          !worker.isPaused()
        );
      }),
    ]);
    return checks.every((check) => check.status === 'fulfilled' && check.value);
  }
}
