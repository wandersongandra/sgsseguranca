import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';
import { WorkerHeartbeatService } from './worker-heartbeat.service';
import { WorkerHeartbeatReporterService } from './worker-heartbeat-reporter.service';

describe('WorkerHeartbeatReporterService', () => {
  const createReporter = () => {
    const client = { set: jest.fn().mockResolvedValue('OK') };
    const heartbeat = new WorkerHeartbeatService(
      new ConfigService({ WORKER_HEARTBEAT_TTL_SECONDS: '90' }),
      { getClient: () => client } as unknown as RedisService,
    );
    return {
      heartbeat,
      client,
      reporter: new WorkerHeartbeatReporterService(heartbeat),
    };
  };

  afterEach(() => jest.useRealTimers());

  it('requires a successful heartbeat from this process', async () => {
    const { reporter } = createReporter();
    expect(reporter.isHealthy()).toBe(false);
    await reporter.onModuleInit();
    expect(reporter.isHealthy()).toBe(true);
  });

  it('fails immediately on a write failure and recovers after a successful write', async () => {
    const { reporter, client } = createReporter();
    await reporter.onModuleInit();
    client.set.mockRejectedValueOnce(new Error('synthetic Redis failure'));
    await reporter.refreshHeartbeat();
    expect(reporter.isHealthy()).toBe(false);
    await reporter.refreshHeartbeat();
    expect(reporter.isHealthy()).toBe(true);
  });

  it('expires a heartbeat even if the shared Redis key was refreshed by another worker', async () => {
    jest.useFakeTimers();
    const { reporter } = createReporter();
    await reporter.onModuleInit();
    jest.advanceTimersByTime(90_000);
    expect(reporter.isHealthy()).toBe(false);
  });

  it('does not accumulate writes while Redis is hanging', async () => {
    jest.useFakeTimers();
    const { reporter, client } = createReporter();
    await reporter.onModuleInit();
    let finish!: () => void;
    client.set.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = reporter.refreshHeartbeat();
    const second = reporter.refreshHeartbeat();
    jest.advanceTimersByTime(90_000);
    expect(reporter.isHealthy()).toBe(false);
    expect(client.set).toHaveBeenCalledTimes(2);
    finish();
    await Promise.all([first, second]);
    expect(reporter.isHealthy()).toBe(false);
  });

  it('fails closed when heartbeat reporting is disabled', async () => {
    const { reporter, heartbeat, client } = createReporter();
    jest.spyOn(heartbeat, 'isEnabled').mockReturnValue(false);
    await reporter.onModuleInit();
    expect(reporter.isHealthy()).toBe(false);
    expect(client.set).not.toHaveBeenCalled();
  });
});
