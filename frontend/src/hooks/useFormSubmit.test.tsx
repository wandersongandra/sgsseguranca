import { act, renderHook } from '@testing-library/react';
import { useFormSubmit } from './useFormSubmit';

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

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

describe('useFormSubmit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ignora um segundo submit enquanto a mutação anterior está em andamento', async () => {
    const pending = deferred<{ id: string }>();
    const submitFn = jest.fn(() => pending.promise);
    const { result } = renderHook(() => useFormSubmit(submitFn));

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = result.current.handleSubmit({ value: 'first' });
      second = result.current.handleSubmit({ value: 'second' });
      await Promise.resolve();
    });

    expect(submitFn).toHaveBeenCalledTimes(1);
    expect(await second).toBeUndefined();

    pending.resolve({ id: 'mutation-1' });
    await act(async () => {
      await first;
    });
    expect(submitFn).toHaveBeenCalledWith({ value: 'first' });
  });
});
