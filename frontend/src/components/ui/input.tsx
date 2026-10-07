import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const inputVariants = cva(
  [
    'flex h-11 w-full rounded-[var(--ds-radius-md)] border px-3 md:h-10',
    'text-base font-medium outline-none md:text-[13px]',
    'placeholder:text-[var(--component-field-placeholder)]',
    'transition-colors duration-[120ms]',
    // Estados disabled
    'disabled:cursor-not-allowed disabled:border-[var(--disabled-border)]',
    'disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)]',
    'disabled:placeholder:text-[var(--disabled-text)] disabled:shadow-none',
    // Focus ring acessível — apenas por teclado
    'focus-visible:outline-none focus-visible:ring-2',
    'focus-visible:ring-[var(--ds-color-focus-ring)] focus-visible:ring-offset-1',
  ],
  {
    variants: {
      tone: {
        default:
          'border-[var(--component-field-border)] bg-[color:var(--component-field-bg)] text-[var(--component-field-text)] shadow-[var(--component-field-shadow)] focus:border-[var(--component-field-border-focus)] focus:shadow-[var(--component-field-shadow-focus)]',
        subtle:
          'border-[var(--component-field-border-subtle)] bg-[color:var(--component-field-bg-subtle)] text-[var(--component-field-text)] focus:border-[var(--component-field-border-focus)] focus:shadow-[var(--component-field-shadow-focus)]',
      },
      /** Estado de erro — aplica borda e cor de danger */
      hasError: {
        true: [
          'border-[var(--ds-color-danger-border)] bg-[color:var(--component-field-bg)]',
          'text-[var(--component-field-text)]',
          'focus:border-[var(--ds-color-danger)] focus:shadow-none',
          'focus-visible:ring-[var(--ds-color-danger-border)]',
        ],
        false: '',
      },
    },
    defaultVariants: {
      tone: 'default',
      hasError: false,
    },
  },
);

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {
  /** Passa true quando o campo tem erro de validação (aplica estilo danger + aria-invalid) */
  hasError?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, tone, type = 'text', hasError, 'aria-invalid': ariaInvalid, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(inputVariants({ tone, hasError: hasError ?? false }), className)}
      aria-invalid={hasError ? 'true' : ariaInvalid}
      {...props}
    />
  ),
);

Input.displayName = 'Input';

export { Input };
