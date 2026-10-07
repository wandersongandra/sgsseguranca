import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const textareaVariants = cva(
  [
    'flex min-h-24 w-full rounded-[var(--ds-radius-md)] border px-3 py-2.5',
    'text-base font-medium outline-none md:text-[13px]',
    'placeholder:text-[var(--component-field-placeholder)]',
    'transition-colors duration-[120ms]',
    'resize-y',
    // Estados disabled
    'disabled:cursor-not-allowed disabled:border-[var(--disabled-border)]',
    'disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)]',
    'disabled:placeholder:text-[var(--disabled-text)] disabled:shadow-none disabled:resize-none',
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
      /** Estado de erro — aplica borda danger */
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

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {
  /** Passa true quando o campo tem erro de validação (aplica estilo danger + aria-invalid) */
  hasError?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, tone, hasError, 'aria-invalid': ariaInvalid, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(textareaVariants({ tone, hasError: hasError ?? false }), className)}
      aria-invalid={hasError ? 'true' : ariaInvalid}
      {...props}
    />
  ),
);

Textarea.displayName = 'Textarea';

export { Textarea };
