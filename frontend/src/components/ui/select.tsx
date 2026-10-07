import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

const selectVariants = cva(
  [
    'peer flex h-10 w-full appearance-none rounded-[var(--ds-radius-md)] border px-3 pr-9',
    'text-base font-medium outline-none md:text-[13px]',
    'transition-colors duration-[120ms]',
    // Estados disabled
    'disabled:cursor-not-allowed disabled:border-[var(--disabled-border)]',
    'disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)] disabled:shadow-none',
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

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement>,
    VariantProps<typeof selectVariants> {
  /** Passa true quando o campo tem erro de validação (aplica estilo danger + aria-invalid) */
  hasError?: boolean;
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, tone, hasError, children, style, 'aria-invalid': ariaInvalid, ...props }, ref) => (
    <div className="relative w-full">
      <select
        ref={ref}
        style={{ ...style, backgroundImage: 'none' }}
        className={cn(selectVariants({ tone, hasError: hasError ?? false }), className)}
        aria-invalid={hasError ? 'true' : ariaInvalid}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--component-field-placeholder)] peer-disabled:text-[var(--disabled-text)]"
        aria-hidden="true"
      />
    </div>
  ),
);

Select.displayName = 'Select';

export { Select };
