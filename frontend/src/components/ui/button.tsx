import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

const buttonVariants = cva(
  [
    'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap md:min-h-0 md:min-w-0',
    'rounded-[var(--ds-radius-md)] border text-[13px] font-semibold leading-none',
    'shadow-none transition-colors duration-[100ms] ease-out',
    'focus-visible:outline-none focus-visible:ring-2',
    'focus-visible:ring-[var(--ds-color-focus-ring)] focus-visible:ring-offset-2',
    'focus-visible:ring-offset-[var(--ds-color-bg-canvas)]',
    'disabled:pointer-events-none disabled:shadow-none',
    'aria-disabled:pointer-events-none aria-disabled:shadow-none',
  ],
  {
    variants: {
      variant: {
        default:
          'border-[var(--component-button-primary-bg)] bg-[var(--component-button-primary-bg)] text-[var(--component-button-primary-text)] hover:bg-[var(--component-button-primary-hover-bg)] hover:border-[var(--component-button-primary-hover-bg)] active:bg-[var(--ds-color-action-primary-active)] active:border-[var(--ds-color-action-primary-active)] disabled:border-[var(--disabled-border)] disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)] aria-disabled:border-[var(--disabled-border)] aria-disabled:bg-[var(--disabled-bg)] aria-disabled:text-[var(--disabled-text)]',
        primary:
          'border-[var(--component-button-primary-bg)] bg-[var(--component-button-primary-bg)] text-[var(--component-button-primary-text)] hover:bg-[var(--component-button-primary-hover-bg)] hover:border-[var(--component-button-primary-hover-bg)] active:bg-[var(--ds-color-action-primary-active)] active:border-[var(--ds-color-action-primary-active)] disabled:border-[var(--disabled-border)] disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)] aria-disabled:border-[var(--disabled-border)] aria-disabled:bg-[var(--disabled-bg)] aria-disabled:text-[var(--disabled-text)]',
        secondary:
          'border-[var(--component-button-secondary-border)] bg-[var(--component-button-secondary-bg)] text-[var(--component-button-secondary-text)] hover:border-[var(--ds-color-border-strong)] hover:bg-[var(--component-button-secondary-bg-hover)] active:bg-[var(--ds-color-action-secondary-active)] disabled:border-[var(--disabled-border)] disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)] aria-disabled:border-[var(--disabled-border)] aria-disabled:bg-[var(--disabled-bg)] aria-disabled:text-[var(--disabled-text)]',
        outline:
          'border-[var(--component-button-outline-border)] bg-transparent text-[var(--ds-color-text-primary)] hover:border-[var(--ds-color-border-strong)] hover:bg-[var(--component-button-ghost-bg-hover)] active:bg-[var(--ds-color-primary-subtle)] disabled:border-[var(--disabled-border)] disabled:bg-transparent disabled:text-[var(--disabled-text)] aria-disabled:border-[var(--disabled-border)] aria-disabled:bg-transparent aria-disabled:text-[var(--disabled-text)]',
        ghost:
          'border-transparent bg-transparent text-[var(--component-button-ghost-text)] hover:bg-[var(--component-button-ghost-bg-hover)] hover:text-[var(--ds-color-text-primary)] active:bg-[var(--ds-color-primary-subtle)] disabled:bg-transparent disabled:text-[var(--disabled-text)] aria-disabled:bg-transparent aria-disabled:text-[var(--disabled-text)]',
        danger:
          'border-[var(--component-button-danger-bg)] bg-[var(--component-button-danger-bg)] text-[var(--component-button-danger-text)] hover:bg-[var(--ds-color-danger-hover)] hover:border-[var(--ds-color-danger-hover)] active:bg-[var(--ds-color-danger-hover)] disabled:border-[var(--disabled-border)] disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)] aria-disabled:border-[var(--disabled-border)] aria-disabled:bg-[var(--disabled-bg)] aria-disabled:text-[var(--disabled-text)]',
        /** @deprecated Usar `danger` — mantido para retrocompatibilidade */
        destructive:
          'border-[var(--component-button-danger-bg)] bg-[var(--component-button-danger-bg)] text-[var(--component-button-danger-text)] hover:bg-[var(--ds-color-danger-hover)] hover:border-[var(--ds-color-danger-hover)] active:bg-[var(--ds-color-danger-hover)] disabled:border-[var(--disabled-border)] disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)] aria-disabled:border-[var(--disabled-border)] aria-disabled:bg-[var(--disabled-bg)] aria-disabled:text-[var(--disabled-text)]',
        success:
          'border-[var(--component-button-success-bg)] bg-[var(--component-button-success-bg)] text-[var(--component-button-success-text)] hover:bg-[var(--ds-color-success-hover)] hover:border-[var(--ds-color-success-hover)] active:bg-[var(--ds-color-success-hover)] disabled:border-[var(--disabled-border)] disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)] aria-disabled:border-[var(--disabled-border)] aria-disabled:bg-[var(--disabled-bg)] aria-disabled:text-[var(--disabled-text)]',
        warning:
          'border-[var(--component-button-warning-bg)] bg-[var(--component-button-warning-bg)] text-[var(--component-button-warning-text)] hover:bg-[var(--ds-color-warning-hover)] hover:border-[var(--ds-color-warning-hover)] active:bg-[var(--ds-color-warning-hover)] disabled:border-[var(--disabled-border)] disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)] aria-disabled:border-[var(--disabled-border)] aria-disabled:bg-[var(--disabled-bg)] aria-disabled:text-[var(--disabled-text)]',
        info:
          'border-[var(--component-button-info-bg,var(--ds-color-info))] bg-[var(--component-button-info-bg,var(--ds-color-info))] text-[var(--component-button-info-text,var(--ds-color-text-inverse))] hover:bg-[var(--ds-color-info-hover)] hover:border-[var(--ds-color-info-hover)] active:bg-[var(--ds-color-info-hover)] disabled:border-[var(--disabled-border)] disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)] aria-disabled:border-[var(--disabled-border)] aria-disabled:bg-[var(--disabled-bg)] aria-disabled:text-[var(--disabled-text)]',
        link:
          '!h-auto !rounded-none !border-transparent !bg-transparent !px-0 !py-0 text-[var(--ds-color-action-primary)] hover:underline hover:text-[var(--ds-color-action-primary-hover)] disabled:text-[var(--disabled-text)] disabled:no-underline aria-disabled:text-[var(--disabled-text)] aria-disabled:no-underline',
      },
      size: {
        sm: 'h-8 px-3 text-[11px]',
        md: 'h-9 px-4 text-[13px]',
        lg: 'h-10 px-5 text-sm',
        icon: 'h-9 w-9 p-0',
        'icon-sm': 'h-7 w-7 p-0',
        'icon-lg': 'h-10 w-10 p-0',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  loadingLabel?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      loading,
      loadingLabel,
      leftIcon,
      rightIcon,
      children,
      disabled,
      type = 'button',
      ...props
    },
    ref,
  ) => {
    const isDisabled = loading || disabled;

    return (
      <button
        {...props}
        type={type}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={isDisabled}
        aria-busy={loading ? true : undefined}
        aria-disabled={isDisabled ? true : undefined}
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {loadingLabel ? (
              <span>{loadingLabel}</span>
            ) : (
              <span className="sr-only">Aguardando...</span>
            )}
          </>
        ) : (
          <>
            {leftIcon ? <span aria-hidden="true">{leftIcon}</span> : null}
            {children}
            {rightIcon ? <span aria-hidden="true">{rightIcon}</span> : null}
          </>
        )}
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
