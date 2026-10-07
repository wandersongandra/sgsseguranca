'use client';

import { memo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PaginationControlsProps {
  page: number;
  lastPage: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

function PaginationControlsComponent(props: PaginationControlsProps) {
  const canPrev = props.page > 1;
  const canNext = props.page < props.lastPage;

  const totalLabel = `${props.total} item${props.total !== 1 ? 's' : ''}`;

  return (
    <nav aria-label="Paginação" className="ds-pagination flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {/* Resumo de resultados — lido por leitores de tela ao navegar */}
      <p
        className="text-sm text-[var(--ds-color-text-muted)]"
        aria-live="polite"
        aria-atomic="true"
      >
        Página{' '}
        <span className="font-semibold text-[var(--ds-color-text-primary)]">{props.page}</span>
        {' '}de{' '}
        <span className="font-semibold text-[var(--ds-color-text-primary)]">{props.lastPage}</span>
        {' '}&bull;{' '}
        <span className="font-semibold text-[var(--ds-color-text-primary)]">{totalLabel}</span>
      </p>
      <div className="ds-pagination__actions flex items-center gap-2">
        <Button
          type="button"
          onClick={props.onPrev}
          disabled={!canPrev}
          variant="outline"
          size="sm"
          aria-label="Página anterior"
          leftIcon={<ChevronLeft className="h-4 w-4" aria-hidden="true" />}
        >
          Anterior
        </Button>

        {/* Indicador de pagina atual — util em mobile */}
        <span
          className="min-w-[2.75rem] text-center text-sm font-medium text-[var(--ds-color-text-secondary)]"
          aria-current="page"
        >
          {props.page}
        </span>

        <Button
          type="button"
          onClick={props.onNext}
          disabled={!canNext}
          variant="outline"
          size="sm"
          aria-label="Próxima página"
          rightIcon={<ChevronRight className="h-4 w-4" aria-hidden="true" />}
        >
          Proxima
        </Button>
      </div>
    </nav>
  );
}

export const PaginationControls = memo(PaginationControlsComponent);
