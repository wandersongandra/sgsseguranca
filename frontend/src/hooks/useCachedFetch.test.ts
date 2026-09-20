import { act, renderHook } from '@testing-library/react';
import { clearCachedFetches, useCachedFetch } from './useCachedFetch';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useCachedFetch', () => {
  beforeEach(() => {
    clearCachedFetches();
  });

  it('não repovoa cache após a invalidação global de uma sessão', async () => {
    const staleResponse = deferred<{ tenant: string }>();
    const staleFetcher = jest.fn(() => staleResponse.promise);
    const staleHook = renderHook(() =>
      useCachedFetch('GET:/dashboard/summary', staleFetcher, 30_000),
    );

    let staleRequest!: Promise<{ tenant: string }>;
    await act(async () => {
      staleRequest = staleHook.result.current.fetch();
      await Promise.resolve();
    });

    clearCachedFetches();
    staleResponse.resolve({ tenant: 'tenant-a' });
    await act(async () => {
      await staleRequest;
    });

    const freshFetcher = jest.fn().mockResolvedValue({ tenant: 'tenant-b' });
    const freshHook = renderHook(() =>
      useCachedFetch('GET:/dashboard/summary', freshFetcher, 30_000),
    );

    await expect(
      act(async () => freshHook.result.current.fetch()),
    ).resolves.toEqual({ tenant: 'tenant-b' });
    expect(freshFetcher).toHaveBeenCalledTimes(1);
  });
});
