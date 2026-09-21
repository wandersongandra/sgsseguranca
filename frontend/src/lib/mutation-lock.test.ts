import { runWithMutationLock } from './mutation-lock';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('runWithMutationLock', () => {
  it('bloqueia a chamada síncrona concorrente e libera após falha', async () => {
    const pending = deferred<void>();
    const lock = { current: false };
    const mutation = jest
      .fn<Promise<void>, []>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(undefined);

    const first = runWithMutationLock(lock, mutation);
    const second = runWithMutationLock(lock, mutation);

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(await second).toBeUndefined();

    pending.reject(new Error('mutation failed'));
    await expect(first).rejects.toThrow('mutation failed');

    await runWithMutationLock(lock, mutation);
    expect(mutation).toHaveBeenCalledTimes(2);
  });
});
