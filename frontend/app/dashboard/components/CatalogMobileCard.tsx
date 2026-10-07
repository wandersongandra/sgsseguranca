import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface CatalogMobileCardField {
  label: string;
  value: ReactNode;
}

interface CatalogMobileCardProps {
  title: ReactNode;
  description?: ReactNode;
  fields?: readonly CatalogMobileCardField[];
  actions: ReactNode;
  actionsLabel: string;
  className?: string;
}

/** Shared, overflow-safe presentation for the small catalog screens. */
export function CatalogMobileCard({
  title,
  description,
  fields = [],
  actions,
  actionsLabel,
  className,
}: CatalogMobileCardProps) {
  return (
    <article
      className={cn(
        'ds-mobile-card min-w-0',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="break-words text-base font-semibold text-[var(--ds-color-text-primary)]">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 break-words text-sm text-[var(--ds-color-text-secondary)]">
            {description}
          </p>
        ) : null}
      </div>

      {fields.length > 0 ? (
        <dl className="ds-mobile-detail-grid mt-4 grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          {fields.map((field) => (
            <div key={field.label} className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--ds-color-text-muted)]">
                {field.label}
              </dt>
              <dd className="mt-1 break-words text-sm text-[var(--ds-color-text-primary)]">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div
        className="ds-mobile-card__actions mt-4 flex min-w-0 flex-wrap gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3"
        role="group"
        aria-label={actionsLabel}
      >
        {actions}
      </div>
    </article>
  );
}

export const catalogMobileActionClassName =
  'min-h-10 min-w-0 flex-1 basis-full justify-center gap-2 px-3 sm:basis-[calc(50%-0.25rem)]';
