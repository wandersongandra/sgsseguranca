import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import { RedisService } from './redis.service';

type WorkerHeartbeatPayload = {
  source: string;
  nodeEnv: string;
  hostname: string;
  pid: number;
  updatedAt: string;
};

export type WorkerHeartbeatStatus =
  | {
      status: 'disabled';
      required: boolean;
      message: string;
    }
  | {
      status: 'up';
      required: boolean;
      lastSeenAt: string;
      ageMs: number;
      source: string;
      hostname: string;
      pid: number;
    }
  | {
      status: 'down';
      required: boolean;
      message: string;
      lastSeenAt?: string;
      ageMs?: number;
    };

@Injectable()
export class WorkerHeartbeatService {
  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  async touch(source = 'worker'): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const payload: WorkerHeartbeatPayload = {
      source,
      nodeEnv: this.configService.get<string>('NODE_ENV', 'development'),
      hostname: hostname(),
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    };

    await this.redisService
      .getClient()
      .set(this.getKey(), JSON.stringify(payload), 'EX', this.getTtlSeconds());
  }

  async getStatus(): Promise<WorkerHeartbeatStatus> {
    const required = this.isRequired();

    if (!this.isEnabled()) {
      return {
        status: 'disabled',
        required,
        message: 'Worker heartbeat disabled by configuration or REDIS_DISABLED',
      };
    }

    try {
      const raw = await this.redisService.getClient().get(this.getKey());
      if (!raw) {
        return {
          status: 'down',
          required,
          message: 'No active worker heartbeat found',
        };
      }

      const parsed = JSON.parse(raw) as Partial<WorkerHeartbeatPayload>;
      const lastSeenAt =
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '';
      const lastSeenMs = Date.parse(lastSeenAt);
      if (!this.isFresh(lastSeenMs)) {
        return {
          status: 'down',
          required,
          message: 'Worker heartbeat is stale or invalid',
        };
      }
      const ageMs = Date.now() - lastSeenMs;

      return {
        status: 'up',
        required,
        lastSeenAt,
        ageMs,
        source:
          typeof parsed.source === 'string' ? parsed.source : 'worker-unknown',
        hostname:
          typeof parsed.hostname === 'string'
            ? parsed.hostname
            : 'unknown-host',
        pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      };
    } catch (error) {
      return {
        status: 'down',
        required,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  isEnabled(): boolean {
    if (
      /^true$/i.test(this.configService.get<string>('REDIS_DISABLED', 'false'))
    ) {
      return false;
    }

    return !/^false$/i.test(
      this.configService.get<string>('WORKER_HEARTBEAT_ENABLED', 'true'),
    );
  }

  isFresh(timestamp: number): boolean {
    const ageMs = Date.now() - timestamp;
    return (
      Number.isFinite(ageMs) &&
      ageMs >= 0 &&
      ageMs < this.getTtlSeconds() * 1000
    );
  }

  private isRequired(): boolean {
    const explicit = this.configService.get<string>(
      'WORKER_HEARTBEAT_REQUIRED',
    );
    if (typeof explicit === 'string' && explicit.length > 0) {
      return /^true$/i.test(explicit);
    }

    return (
      this.configService.get<string>('NODE_ENV', 'development') ===
        'production' && this.isEnabled()
    );
  }

  private getKey(): string {
    return (
      this.configService.get<string>(
        'WORKER_HEARTBEAT_KEY',
        'worker:heartbeat:queue-runtime',
      ) || 'worker:heartbeat:queue-runtime'
    );
  }

  private getTtlSeconds(): number {
    const raw = Number(
      this.configService.get<string>('WORKER_HEARTBEAT_TTL_SECONDS', '90'),
    );
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 90;
  }
}
