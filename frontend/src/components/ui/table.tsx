import * as React from 'react';
import { cn } from '@/lib/utils';

/** Direção de ordenação para suporte a aria-sort. */
export type SortDirection = 'ascending' | 'descending' | 'none';

interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /**
   * Número total de linhas de dados (excluindo header e footer).
   * Quando fornecido, define `aria-rowcount` no <table>.
   */
  rowCount?: number;
  /**
   * Número de colunas.
   * Quando fornecido, define `aria-colcount` no <table>.
   */
  colCount?: number;
  /** Label acessível para a tabela. */
  label?: string;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, rowCount, colCount, label, 'aria-label': ariaLabel, ...props }, ref) => (
    <div
      className="
        relative w-full overflow-auto rounded-[var(--ds-radius-lg)] border
        border-[var(--component-table-shell-border)] bg-[color:var(--component-table-bg)]
        shadow-[var(--component-table-shadow)]
      "
    >
      <table
        ref={ref}
        aria-label={ariaLabel ?? label}
        aria-rowcount={rowCount}
        aria-colcount={colCount}
        className={cn('w-full caption-bottom border-separate border-spacing-0 text-[13px]', className)}
        {...props}
      />
    </div>
  ),
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead
      ref={ref}
      className={cn(
        'sticky top-0 z-[1] [&_tr]:border-b',
        className,
      )}
      {...props}
    />
  ),
);
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
  ),
);
TableBody.displayName = 'TableBody';

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot
      ref={ref}
      className={cn(
        'border-t border-[var(--component-table-row-border)] bg-[color:var(--component-table-footer-bg)] font-medium [&>tr]:last:border-b-0',
        className,
      )}
      {...props}
    />
  ),
);
TableFooter.displayName = 'TableFooter';

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        'border-b border-[var(--component-table-row-border)] transition-colors hover:bg-[color:var(--component-table-row-hover)] data-[state=selected]:bg-[color:var(--component-table-row-selected)]',
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = 'TableRow';

interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  /**
   * Direção de ordenação atual desta coluna.
   * Renderiza `aria-sort` no <th> automaticamente.
   * Use `'none'` para indicar que a coluna e ordenavel mas sem ordem ativa.
   */
  sortDirection?: SortDirection;
}

const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  ({ className, sortDirection, ...props }, ref) => (
    <th
      ref={ref}
      scope="col"
      aria-sort={sortDirection}
      className={cn(
        'h-11 border-b border-[var(--component-table-row-border)] bg-[color:var(--component-table-header-bg)] px-4 text-left align-middle text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--component-table-header-text)] [&:has([role=checkbox])]:pr-0',
        sortDirection !== undefined && 'cursor-pointer select-none',
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td
      ref={ref}
      className={cn('px-4 py-3 align-middle text-[var(--ds-color-text-secondary)] [&:has([role=checkbox])]:pr-0', className)}
      {...props}
    />
  ),
);
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption
      ref={ref}
      className={cn('mt-3 text-[13px] text-[var(--ds-color-text-muted)]', className)}
      {...props}
    />
  ),
);
TableCaption.displayName = 'TableCaption';

export { Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption };
