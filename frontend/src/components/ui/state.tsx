import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  LoaderCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from './card';
import { PageSkeleton } from './skeleton';

type StateTone = 'neutral' | 'danger' | 'success';

type StateCardProps = {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
};

const toneClasses: Record<
  StateTone,
  { shell: string; icon: string; description: string }
> = {
  neutral: {
    shell:
      'border-[color:var(--component-empty-border)] [background:var(--component-empty-bg)] text-[var(--ds-color-text-primary)] shadow-[var(--component-empty-shadow)]',
    icon:
      'border-[color:var(--component-empty-icon-border)] bg-[color:var(--component-empty-icon-bg)] text-[var(--ds-color-action-primary)]',
    description: 'text-[var(--ds-color-text-secondary)]',
  },
  danger: {
    shell:
      'border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)]/72 text-[var(--ds-color-text-primary)] shadow-[var(--component-empty-shadow)]',
    icon:
      'border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger)]/12 text-[var(--ds-color-danger)]',
    description: 'text-[var(--ds-color-text-secondary)]',
  },
  success: {
    shell:
      'border-[var(--ds-color-success-border)] bg-[color:var(--ds-color-success-subtle)]/72 text-[var(--ds-color-text-primary)] shadow-[var(--component-empty-shadow)]',
    icon:
      'border-[var(--ds-color-success-border)] bg-[color:var(--ds-color-success)]/12 text-[var(--ds-color-success)]',
    description: 'text-[var(--ds-color-text-secondary)]',
  },
};

function StateCard({
  title,
  description,
  icon,
  action,
  className,
  compact = false,
  tone,
}: StateCardProps & { tone: StateTone }) {
  const styles = toneClasses[tone];

  return (
    <Card
      tone="elevated"
      className={cn(
        'flex flex-col items-center justify-center text-center before:bg-transparent',
        compact ? 'p-5' : 'p-8 md:p-10',
        styles.shell,
        className,
      )}
    >
      <CardHeader className="items-center gap-2.5">
        <div
          className={cn(
            'mb-1 inline-flex h-12 w-12 items-center justify-center rounded-[var(--ds-radius-md)] border',
            styles.icon,
          )}
        >
          {icon}
        </div>
        <CardTitle className="text-[1.08rem] tracking-[-0.02em]">{title}</CardTitle>
        {description ? (
          <CardDescription className={cn('max-w-md leading-6', styles.description)}>
            {description}
          </CardDescription>
        ) : null}
      </CardHeader>
      {action ? (
        <CardFooter className="mt-6 justify-center border-t-0 pt-0">{action}</CardFooter>
      ) : null}
    </Card>
  );
}

export function EmptyState(props: StateCardProps) {
  return <StateCard tone="neutral" icon={props.icon ?? <Inbox size={22} />} {...props} />;
}

export function ErrorState(props: StateCardProps) {
  return (
    <StateCard
      tone="danger"
      icon={props.icon ?? <AlertTriangle size={22} />}
      {...props}
    />
  );
}

export function SuccessState(props: StateCardProps) {
  return (
    <StateCard
      tone="success"
      icon={props.icon ?? <CheckCircle2 size={22} />}
      {...props}
    />
  );
}

export function InlineLoadingState({
  label = 'Carregando dados',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex min-h-24 items-center justify-center gap-3 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-base)] px-4 text-sm text-[var(--ds-color-text-muted)]',
        className,
      )}
    >
      <LoaderCircle className="h-5 w-5 text-[var(--ds-color-action-primary)]" />
      <span>{label}</span>
    </div>
  );
}

export function PageLoadingState({
  title = 'Carregando conteudo',
  description = 'Carregando as informações desta tela.',
  cards = 4,
  tableRows = 5,
}: {
  title?: string;
  description?: string;
  cards?: number;
  tableRows?: number;
}) {
  return (
    <section role="status" aria-live="polite" aria-label={title} className="space-y-6">
      <Card tone="muted" padding="md">
        <CardHeader>
          <div className="flex items-center gap-3">
            <LoaderCircle
              className="h-5 w-5 animate-spin text-[var(--ds-color-action-primary)]"
              aria-hidden="true"
            />
            <div>
              <CardTitle>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>
      <PageSkeleton cards={cards} tableRows={tableRows} />
    </section>
  );
}
