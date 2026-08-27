import { JobTimeoutError, withJobTimeout } from './job-timeout.util';

describe('withJobTimeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborta o sinal no deadline, mesmo que o callback ainda esteja pendente', async () => {
    jest.useFakeTimers();

    let resolveWork!: () => void;
    let completed = false;
    let receivedSignal!: AbortSignal;
    const logger = { error: jest.fn() };
    const work = new Promise<void>((resolve) => {
      resolveWork = () => {
        completed = true;
        resolve();
      };
    });

    const timed = withJobTimeout(
      (signal) => {
        receivedSignal = signal;
        return work;
      },
      20,
      { jobName: 'pdf-generation', jobId: 'attempt-1', logger },
    );

    jest.advanceTimersByTime(20);

    await expect(timed).rejects.toBeInstanceOf(JobTimeoutError);
    expect(receivedSignal.aborted).toBe(true);
    expect(completed).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);

    resolveWork();
    await work;
    expect(completed).toBe(true);
  });

  it('aceita conclusão cooperativa dentro da janela de encerramento', async () => {
    jest.useFakeTimers();

    let resolveWork!: () => void;
    const work = new Promise<string>((resolve) => {
      resolveWork = () => resolve('completed-during-grace');
    });
    const timed = withJobTimeout(
      () => work,
      20,
      {
        jobName: 'pdf-generation',
        jobId: 'attempt-2',
        logger: { error: jest.fn() },
      },
      { waitForSettledOnTimeoutMs: 10 },
    );

    jest.advanceTimersByTime(20);
    await Promise.resolve();
    resolveWork();

    await expect(timed).resolves.toBe('completed-during-grace');
  });
});
