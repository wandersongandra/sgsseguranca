import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  icon,
  actions,
  className,
  contentClassName,
}: PageHeaderProps) {
  return (
    <section
      aria-label={eyebrow ? `${eyebrow}: ${title}` : title}
      className={cn('ds-page-header', className)}
    >
      <div className="ds-page-header__main md:flex-row md:items-start md:justify-between">
        <div className="ds-page-header__lead">
          {icon ? (
            <div className="ds-page-header__icon">
              {icon}
            </div>
          ) : null}
          <div className={cn('ds-page-header__copy', contentClassName)}>
            {eyebrow ? (
              <span className="ds-page-header__eyebrow" aria-hidden="true">
                {eyebrow}
              </span>
            ) : null}
            <h1 className="ds-page-header__title">{title}</h1>
            {description ? (
              <p className="ds-page-header__description">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className="ds-page-header__actions" role="group" aria-label="Ações da página">
            {actions}
          </div>
        ) : null}
      </div>
    </section>
  );
}
