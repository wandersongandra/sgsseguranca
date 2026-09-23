'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ConfirmModal } from './confirm-modal';

type ConfirmActionOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type PendingConfirmation = ConfirmActionOptions & {
  resolve: (confirmed: boolean) => void;
};

type ConfirmActionContextValue = {
  confirmAction: (options: ConfirmActionOptions) => Promise<boolean>;
};

const ConfirmActionContext = createContext<ConfirmActionContextValue | null>(null);

export function ConfirmActionProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);

  const close = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(confirmed);
  }, []);

  const confirmAction = useCallback(
    (options: ConfirmActionOptions) =>
      new Promise<boolean>((resolve) => {
        if (pendingRef.current) {
          pendingRef.current.resolve(false);
        }

        const next = { ...options, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  useEffect(() => {
    return () => {
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  return (
    <ConfirmActionContext.Provider value={{ confirmAction }}>
      {children}
      <ConfirmModal
        open={Boolean(pending)}
        onClose={() => close(false)}
        onConfirm={() => close(true)}
        title={pending?.title ?? ''}
        description={pending?.description ?? ''}
        confirmLabel={pending?.confirmLabel}
        cancelLabel={pending?.cancelLabel}
      />
    </ConfirmActionContext.Provider>
  );
}

export function useConfirmAction() {
  const context = useContext(ConfirmActionContext);

  if (!context) {
    throw new Error('useConfirmAction must be used within ConfirmActionProvider.');
  }

  return context;
}
