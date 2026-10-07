'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { loadBrowserSentry } from '@/lib/sentry/browser-client';
import { logger } from '@/lib/logger';

interface State {
  hasError: boolean;
}

export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: string },
  State
> {
  constructor(props: { children: React.ReactNode; resetKey?: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    void loadBrowserSentry().then((Sentry) => {
      Sentry?.captureException(error, {
        contexts: { react: { componentStack: errorInfo.componentStack } },
      });
    });

    if (process.env.NODE_ENV !== 'production') {
      logger.error('[UI Boundary Error]', error, errorInfo);
    }
  }

  componentDidUpdate(prevProps: Readonly<{ resetKey?: string }>) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          aria-live="assertive"
          className="mx-auto mt-10 max-w-lg rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-surface-base)] p-5 text-center shadow-[var(--ds-shadow-xs)]"
        >
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-[var(--ds-radius-md)] bg-[var(--ds-color-danger-subtle)] text-[var(--ds-color-danger)]">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2 className="mt-3 text-base font-semibold text-[var(--ds-color-text-primary)]">
            A interface encontrou um erro
          </h2>
          <p className="mt-2 text-[13px] leading-5 text-[var(--ds-color-text-secondary)]">
            Recarregue a página. Se o erro continuar, informe ao suporte o horário em que ocorreu.
          </p>
          <Button
            type="button"
            variant="danger"
            className="mt-4"
            onClick={() => window.location.reload()}
          >
            Recarregar página
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
