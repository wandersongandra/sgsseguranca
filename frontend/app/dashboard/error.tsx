'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { logger } from '@/lib/logger';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      logger.error('[DashboardError]', error);
    }
  }, [error]);

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[var(--ds-color-bg-canvas)] px-6 text-center text-[var(--ds-color-text-primary)]">
      <div className="w-full max-w-md rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-xs)]">
        <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-[var(--ds-radius-md)] bg-[var(--ds-color-danger-subtle)] text-[var(--ds-color-danger)]">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        </span>
        <h2 className="mt-4 text-lg font-semibold">Não foi possível carregar esta área</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--ds-color-text-secondary)]">
          Tente carregar novamente. Se o problema continuar, informe ao suporte o horário em que ocorreu.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="secondary" className="flex-1" onClick={reset}>
            Tentar novamente
          </Button>
          <Button type="button" className="flex-1" onClick={() => window.location.reload()}>
            Recarregar página
          </Button>
        </div>
      </div>
    </div>
  );
}
