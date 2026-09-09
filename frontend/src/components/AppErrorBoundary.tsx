'use client';

import React from 'react';
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
        <div role="alert" aria-live="assertive" className="mx-auto mt-10 max-w-lg rounded-2xl border border-[color:var(--ds-color-danger)]/20 bg-[color:var(--ds-color-danger-subtle)] p-5 text-center shadow-[var(--ds-shadow-sm)]">
          <h2 className="text-base font-semibold text-[var(--ds-color-danger)]">
            Ocorreu um erro inesperado na interface.
          </h2>
          <p className="mt-2 text-[13px] text-[var(--ds-color-text-secondary)]">
            Recarregue a página. Se persistir, contate o suporte com o horário
            do erro.
          </p>
          <button
            type="button"
            className="mt-4 rounded-xl bg-[var(--ds-color-danger)] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[var(--ds-color-danger-hover)]"
            onClick={() => window.location.reload()}
          >
            Recarregar
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
