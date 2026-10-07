import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type MetricTone =
  | 'neutral'
  | 'primary'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  /** Degrau entre warning e danger — backed by --ds-color-elevated-*. */
  | 'orange'
  /** Neutro "pendente", mais escuro que neutral puro — backed by --apr-incomplete-*. */
  | 'muted';

const toneMap: Record<
  MetricTone,
  { container: string; dot: string; label: string; value: string; note: string }
> = {
  neutral: {
    container:
      'border-[var(--component-card-border)] bg-[color:var(--component-card-bg)]',
    dot: 'bg-[var(--ds-color-border-strong)]',
    label: 'text-[var(--ds-color-text-secondary)]',
    value: 'text-[var(--ds-color-text-primary)]',
    note: 'text-[var(--ds-color-text-muted)]',
  },
  primary: {
    container:
      'border-[var(--ds-color-primary-border)] bg-[color:color-mix(in_srgb,var(--ds-color-primary-subtle)_70%,var(--component-card-bg-elevated)_30%)]',
    dot: 'bg-[var(--ds-color-action-primary)]',
    label: 'text-[var(--ds-color-action-primary)]',
    value: 'text-[var(--ds-color-text-primary)]',
    note: 'text-[var(--ds-color-text-secondary)]',
  },
  info: {
    container:
      'border-[var(--ds-color-info-border)] bg-[color:color-mix(in_srgb,var(--ds-color-info-subtle)_84%,var(--component-card-bg-elevated)_16%)]',
    dot: 'bg-[var(--ds-color-info)]',
    label: 'text-[var(--ds-color-info-fg)]',
    value: 'text-[var(--ds-color-info-fg)]',
    note: 'text-[color:var(--ds-color-info-fg)]/88',
  },
  success: {
    container:
      'border-[var(--ds-color-success-border)] bg-[color:color-mix(in_srgb,var(--ds-color-success-subtle)_84%,var(--component-card-bg-elevated)_16%)]',
    dot: 'bg-[var(--ds-color-success)]',
    label: 'text-[var(--ds-color-success-fg)]',
    value: 'text-[var(--ds-color-success-fg)]',
    note: 'text-[color:var(--ds-color-success-fg)]/88',
  },
  warning: {
    container:
      'border-[var(--ds-color-warning-border)] bg-[color:color-mix(in_srgb,var(--ds-color-warning-subtle)_84%,var(--component-card-bg-elevated)_16%)]',
    dot: 'bg-[var(--ds-color-warning)]',
    label: 'text-[var(--ds-color-warning-fg)]',
    value: 'text-[var(--ds-color-warning-fg)]',
    note: 'text-[color:var(--ds-color-warning-fg)]/88',
  },
  danger: {
    container:
      'border-[var(--ds-color-danger-border)] bg-[color:color-mix(in_srgb,var(--ds-color-danger-subtle)_84%,var(--component-card-bg-elevated)_16%)]',
    dot: 'bg-[var(--ds-color-danger)]',
    label: 'text-[var(--ds-color-danger-fg)]',
    value: 'text-[var(--ds-color-danger-fg)]',
    note: 'text-[color:var(--ds-color-danger-fg)]/88',
  },
  orange: {
    container:
      'border-[var(--ds-color-elevated-border)] bg-[color:color-mix(in_srgb,var(--ds-color-elevated-subtle)_84%,var(--component-card-bg-elevated)_16%)]',
    dot: 'bg-[var(--ds-color-elevated)]',
    label: 'text-[var(--ds-color-elevated-fg)]',
    value: 'text-[var(--ds-color-elevated-fg)]',
    note: 'text-[color:var(--ds-color-elevated-fg)]/88',
  },
  muted: {
    container:
      'border-[var(--apr-incomplete-border)] bg-[var(--apr-incomplete-subtle)]',
    dot: 'bg-[var(--apr-incomplete)]',
    label: 'text-[var(--apr-incomplete-fg)]',
    value: 'text-[var(--apr-incomplete-fg)]',
    note: 'text-[color:var(--apr-incomplete-fg)]/88',
  },
};

/** Estilos de densidade "compact" — chip menor, sem dot/topline, usado em
 * painéis de resumo com muitos cards lado a lado (ex.: resumo executivo). */
const compactToneMap: Record<
  MetricTone,
  { container: string; label: string; value: string }
> = {
  neutral: {
    container:
      'border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/22',
    label: 'text-[var(--ds-color-text-muted)]',
    value: 'text-[var(--ds-color-text-primary)]',
  },
  primary: {
    container:
      'border-[var(--ds-color-primary-border)] bg-[color:var(--ds-color-primary-subtle)]/72',
    label: 'text-[var(--ds-color-action-primary)]',
    value: 'text-[var(--ds-color-action-primary)]',
  },
  info: {
    container:
      'border-[var(--ds-color-info-border)] bg-[color:var(--ds-color-info-subtle)]/72',
    label: 'text-[var(--color-info)]',
    value: 'text-[var(--color-info)]',
  },
  success: {
    container:
      'border-[var(--ds-color-success-border)] bg-[color:var(--ds-color-success-subtle)]/72',
    label: 'text-[var(--color-success)]',
    value: 'text-[var(--color-success)]',
  },
  warning: {
    container:
      'border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)]/72',
    label: 'text-[var(--color-warning)]',
    value: 'text-[var(--color-warning)]',
  },
  danger: {
    container:
      'border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)]/72',
    label: 'text-[var(--color-danger)]',
    value: 'text-[var(--color-danger)]',
  },
  orange: {
    container:
      'border-[var(--ds-color-elevated-border)] bg-[color:var(--ds-color-elevated-subtle)]/72',
    label: 'text-[var(--ds-color-elevated-fg)]',
    value: 'text-[var(--ds-color-elevated-fg)]',
  },
  muted: {
    container:
      'border-[var(--apr-incomplete-border)] bg-[var(--apr-incomplete-subtle)]',
    label: 'text-[var(--apr-incomplete-fg)]',
    value: 'text-[var(--apr-incomplete-fg)]',
  },
};

export interface MetricCardDelta {
  value: number;
  /** Default: "↑ N vs. período anterior" / "↓ N vs. período anterior" / "= sem alteração". */
  format?: (delta: number) => string;
}

function formatDelta(delta: MetricCardDelta): string {
  if (delta.format) return delta.format(delta.value);
  if (delta.value === 0) return '= sem alteração';
  return delta.value > 0
    ? `↑ ${delta.value} vs. período anterior`
    : `↓ ${Math.abs(delta.value)} vs. período anterior`;
}

/** Tones com classe CSS dedicada em .ds-metric-item (variant="strip"). */
const STRIP_TONES = new Set<MetricTone>(['primary', 'success', 'warning', 'danger']);

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: MetricTone;
  className?: string;
  /**
   * Variação de tendência exibida abaixo do valor. Quando presente e `note`
   * é omitido, o texto formatado do delta ocupa o lugar da nota.
   */
  delta?: MetricCardDelta | null;
  /**
   * 'card' (padrão) — visual rico do design system, use em código novo.
   * 'strip' — modo de compatibilidade que emite as classes CSS legadas
   * `.ds-metric-item*`, usado internamente pelo ListPageLayout. Não usar
   * em código novo.
   */
  variant?: 'card' | 'strip';
  /**
   * 'md' (padrão) — densidade normal, com indicador de ponto colorido.
   * 'compact' — chip menor sem ponto/topline, para painéis com muitos
   * cards lado a lado. Ignorado quando `variant="strip"`.
   */
  density?: 'md' | 'compact';
}

/**
 * Card compacto de métrica/resumo do design system — label + valor + nota
 * opcional, com indicador de cor por tone semântico.
 */
export function MetricCard({
  label,
  value,
  note,
  tone = 'neutral',
  className,
  delta,
  variant = 'card',
  density = 'md',
}: MetricCardProps) {
  const resolvedNote = note ?? (delta ? formatDelta(delta) : undefined);

  if (variant === 'strip') {
    return (
      <article
        className={cn(
          'ds-metric-item',
          STRIP_TONES.has(tone) ? `ds-metric-item--${tone}` : null,
          className,
        )}
      >
        <p className="ds-metric-item__label">{label}</p>
        <div className="ds-metric-item__value" aria-label={`${label}: ${value}`}>
          {value}
        </div>
        {resolvedNote ? (
          <p className="ds-metric-item__note">{resolvedNote}</p>
        ) : null}
      </article>
    );
  }

  if (density === 'compact') {
    const compactStyles = compactToneMap[tone];

    return (
      <div
        className={cn(
          'rounded-[var(--ds-radius-md)] border px-2.5 py-2 shadow-[var(--ds-shadow-xs)]',
          compactStyles.container,
          className,
        )}
      >
        <p
          className={cn(
            'text-[11px] font-semibold uppercase tracking-[0.06em]',
            compactStyles.label,
          )}
        >
          {label}
        </p>
        <p
          className={cn(
            'mt-1.5 text-lg font-bold leading-none',
            compactStyles.value,
          )}
        >
          {value}
        </p>
        {resolvedNote ? (
          <p className="mt-1 text-[11px] font-medium text-[var(--ds-color-text-secondary)]">
            {resolvedNote}
          </p>
        ) : null}
      </div>
    );
  }

  const styles = toneMap[tone];

  return (
    <div
      className={cn(
        [
          'relative overflow-hidden rounded-[var(--ds-radius-xl)] border px-4 py-3.5',
          'shadow-[var(--component-card-shadow)]',
          "before:content-[''] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-[var(--component-card-topline)]",
        ],
        styles.container,
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('h-2.5 w-2.5 rounded-full', styles.dot)} aria-hidden="true" />
        <p
          className={cn(
            'text-[10px] font-semibold uppercase tracking-[0.16em]',
            styles.label,
          )}
        >
          {label}
        </p>
      </div>
      <div
        className={cn(
          'mt-2.5 text-base font-semibold leading-tight break-words',
          styles.value,
        )}
      >
        {value}
      </div>
      {resolvedNote ? (
        <p className={cn('mt-1.5 text-xs leading-5', styles.note)}>{resolvedNote}</p>
      ) : null}
    </div>
  );
}
