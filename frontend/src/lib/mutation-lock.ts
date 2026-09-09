export type MutationLock = {
  current: boolean;
};

export async function runWithMutationLock<T>(
  lock: MutationLock,
  mutation: () => Promise<T>,
): Promise<T | undefined> {
  if (lock.current) {
    return undefined;
  }

  lock.current = true;
  try {
    return await mutation();
  } finally {
    lock.current = false;
  }
}
