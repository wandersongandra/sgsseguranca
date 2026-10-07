import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const cardVariants = cva(
  ['relative overflow-hidden rounded-[var(--ds-radius-lg)] border'],
  {
    variants: {
      tone: {
        default:
          'border-[var(--component-card-border)] bg-[color:var(--component-card-bg)] shadow-[var(--component-card-shadow)]',
        elevated:
          'border-[var(--component-card-border)] bg-[color:var(--component-card-bg-elevated)] shadow-[var(--component-card-shadow-elevated)]',
        muted:
          'border-[var(--component-card-border)] bg-[color:var(--component-card-bg-muted)] shadow-[var(--component-card-shadow)]',
        accent:
          'border-[var(--component-card-border)] bg-[color:var(--component-card-bg-elevated)] shadow-[var(--component-card-shadow)] border-l-[3px] border-l-[var(--ds-color-action-primary)]',
        ghost:
          'border-[var(--component-card-border)]/60 bg-transparent shadow-none',
        stat:
          'border-[var(--component-card-border)] bg-[color:var(--component-card-bg-elevated)] shadow-[var(--component-card-shadow)]',
        /** Variante de sucesso — borda esquerda verde */
        success:
          'border-[var(--ds-color-success-border)] bg-[color:var(--ds-color-success-subtle)] shadow-[var(--component-card-shadow)] border-l-[3px] border-l-[var(--ds-color-success)]',
        /** Variante de aviso — borda esquerda amarela */
        warning:
          'border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)] shadow-[var(--component-card-shadow)] border-l-[3px] border-l-[var(--ds-color-warning)]',
        /** Variante de perigo — borda esquerda vermelha */
        danger:
          'border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] shadow-[var(--component-card-shadow)] border-l-[3px] border-l-[var(--ds-color-danger)]',
        /** Variante de info — borda esquerda azul */
        info:
          'border-[var(--ds-color-info-border)] bg-[color:var(--ds-color-info-subtle)] shadow-[var(--component-card-shadow)] border-l-[3px] border-l-[var(--ds-color-info)]',
      },
      interactive: {
        true: [
          'cursor-pointer select-none transition-colors duration-[120ms]',
          'hover:border-[var(--component-card-hover-border)]',
          'hover:bg-[color:var(--component-card-bg-elevated)]',
          // Focus ring para cards clicáveis via teclado
          'focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-[var(--ds-color-focus-ring)] focus-visible:ring-offset-2',
          'focus-visible:ring-offset-[var(--ds-color-bg-canvas)]',
        ],
        false: '',
      },
      padding: {
        none: '',
        xs: 'p-3',
        sm: 'p-4',
        md: 'p-5',
        lg: 'p-6',
        xl: 'p-8',
      },
    },
    defaultVariants: {
      tone: 'default',
      interactive: false,
      padding: 'sm',
    },
  },
);

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, tone, interactive, padding, tabIndex, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(cardVariants({ tone, interactive, padding }), className)}
      // Quando interativo e sem tabIndex definido, torna focável por teclado
      tabIndex={interactive && tabIndex === undefined ? 0 : tabIndex}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

/** Cabeçalho do card — suporta layout coluna (padrão) ou linha (md:flex-row) */
const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex flex-col gap-1.5', className)}
      {...props}
    />
  ),
);
CardHeader.displayName = 'CardHeader';

/** Eyebrow — rótulo curto de contexto acima do título. */
const CardEyebrow = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn(
        'text-[0.6875rem] font-semibold uppercase tracking-[0.03em] text-[var(--ds-color-action-primary)]',
        className,
      )}
      {...props}
    />
  ),
);
CardEyebrow.displayName = 'CardEyebrow';

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn(
        'text-[1rem] font-semibold leading-tight tracking-[-0.02em] text-[var(--ds-color-text-primary)]',
        className,
      )}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('text-[0.8125rem] leading-[1.45] text-[var(--ds-color-text-muted)]', className)}
    {...props}
  />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('mt-4', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

/** Divisor interno — separa seções dentro do card */
const CardDivider = React.forwardRef<HTMLHRElement, React.HTMLAttributes<HTMLHRElement>>(
  ({ className, ...props }, ref) => (
    <hr
      ref={ref}
      className={cn('my-4 border-0 border-t border-[var(--ds-color-border-subtle)]', className)}
      {...props}
    />
  ),
);
CardDivider.displayName = 'CardDivider';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'mt-5 flex items-center gap-2.5 border-t border-[var(--ds-color-border-subtle)] pt-4',
        className,
      )}
      {...props}
    />
  ),
);
CardFooter.displayName = 'CardFooter';

export {
  Card,
  CardHeader,
  CardEyebrow,
  CardTitle,
  CardDescription,
  CardContent,
  CardDivider,
  CardFooter,
};
