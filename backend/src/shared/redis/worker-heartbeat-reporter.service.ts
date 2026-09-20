import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

@Injectable()
export class WorkerHeartbeatReporterService implements OnModuleInit {
  private readonly logger = new Logger(WorkerHeartbeatReporterService.name);
  private lastSuccess?: number;
  private lastAttemptFailed = true;
  private reporting?: Promise<void>;

  constructor(private readonly workerHeartbeat: WorkerHeartbeatService) {}

  async onModuleInit(): Promise<void> {
    await this.reportHeartbeat('worker-bootstrap');
  }

  @Interval(30_000)
  async refreshHeartbeat(): Promise<void> {
    await this.reportHeartbeat('worker-loop');
  }

  isHealthy(): boolean {
    return (
      this.workerHeartbeat.isEnabled() &&
      !this.lastAttemptFailed &&
      this.lastSuccess !== undefined &&
      this.workerHeartbeat.isFresh(this.lastSuccess)
    );
  }

  private async reportHeartbeat(source: string): Promise<void> {
    if (!this.workerHeartbeat.isEnabled()) {
      this.lastAttemptFailed = true;
      return;
    }

    if (this.reporting) return this.reporting;
    this.reporting = this.writeHeartbeat(source);
    try {
      await this.reporting;
    } finally {
      this.reporting = undefined;
    }
  }

  private async writeHeartbeat(source: string): Promise<void> {
    const attemptedAt = Date.now();
    try {
      await this.workerHeartbeat.touch(source);
      this.lastSuccess = attemptedAt;
      this.lastAttemptFailed = false;
    } catch (error) {
      this.lastAttemptFailed = true;
      this.logger.error({
        event: 'worker_heartbeat_failed',
        errorName: error instanceof Error ? error.name : 'HeartbeatError',
      });
    }
  }
}
