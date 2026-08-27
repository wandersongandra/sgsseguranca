import { captureException } from '../../shared/monitoring/sentry';

export class JobTimeoutError extends Error {
  readonly jobName: string;
  readonly jobId: string | undefined;
  readonly timeoutMs: number;

  constructor(jobName: string, jobId: string | undefined, timeoutMs: number) {
    super(
      `Job "${jobName}" (id=${jobId ?? 'sem-id'}) timeout apos ${timeoutMs}ms`,
    );
    this.name = 'JobTimeoutError';
    this.jobName = jobName;
    this.jobId = jobId;
    this.timeoutMs = timeoutMs;
  }
}

interface JobTimeoutLogger {
  error: (message: unknown, ...args: unknown[]) => void;
}

export interface JobTimeoutOptions {
  /**
   * Permite que o callback finalize cleanup cooperativo antes de liberar o
   * lock do worker e permitir que BullMQ inicie a próxima tentativa.
   */
  waitForSettledOnTimeoutMs?: number;
}

/**
 * Executa fn() com um deadline absoluto e sinaliza cancelamento cooperativo.
 *
 * Uso nos processors de BullMQ para substituir o campo `timeout` que foi
 * removido no BullMQ v5 e era silenciosamente ignorado.
 *
 * Ao estourar o prazo: aborta o sinal, loga erro estruturado e dispara Sentry.
 * Se uma janela de encerramento foi configurada, uma conclusão bem-sucedida
 * dentro dela é preservada para evitar retry depois de uma publicação tardia;
 * caso contrário, ou se a operação não se recuperar, rejeita com
 * JobTimeoutError. O callback precisa observar o sinal antes de efeitos
 * externos e depois de cada await relevante.
 */
export function withJobTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  context: {
    jobName: string;
    jobId: string | undefined;
    logger: JobTimeoutLogger;
  },
  options?: JobTimeoutOptions,
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const waitForSettledMs = Math.max(
    0,
    Math.floor(options?.waitForSettledOnTimeoutMs ?? 0),
  );
  const controller = new AbortController();
  const operationPromise = Promise.resolve().then(() => fn(controller.signal));
  const operationSettlement: Promise<
    { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }
  > = operationPromise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );

  const timeoutPromise = new Promise<T>((resolve, reject) => {
    handle = setTimeout(() => {
      const error = new JobTimeoutError(
        context.jobName,
        context.jobId,
        timeoutMs,
      );
      controller.abort(error);
      context.logger.error(
        `[Job ${context.jobId ?? 'sem-id'}] Timeout de ${timeoutMs}ms excedido para "${context.jobName}" — job abortado`,
      );
      captureException(error, {
        tags: { 'job.timeout': 'true', jobName: context.jobName },
        extra: { jobId: context.jobId, timeoutMs },
      });

      void (async () => {
        if (waitForSettledMs > 0) {
          let settleHandle: ReturnType<typeof setTimeout> | undefined;
          try {
            const outcome = await Promise.race([
              operationSettlement,
              new Promise<'grace_elapsed'>((resolve) => {
                settleHandle = setTimeout(
                  () => resolve('grace_elapsed'),
                  waitForSettledMs,
                );
              }),
            ]);
            if (outcome !== 'grace_elapsed' && outcome.status === 'fulfilled') {
              resolve(outcome.value);
              return;
            }
          } finally {
            clearTimeout(settleHandle);
          }
        }
        reject(error);
      })().catch(reject);
    }, timeoutMs);
  });

  return Promise.race([operationPromise, timeoutPromise]).finally(() => {
    clearTimeout(handle);
  });
}
