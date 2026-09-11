"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AprListingPaginationProps {
  page: number;
  limit: number;
  total: number;
  lastPage: number;
  onPrev: () => void;
  onNext: () => void;
}

export function AprListingPagination({
  page,
  limit,
  total,
  lastPage,
  onPrev,
  onNext,
}: AprListingPaginationProps) {
  const canPrev = page > 1;
  const canNext = page < lastPage;
  const rangeStart = total === 0 ? 0 : (page - 1) * limit + 1;
  const rangeEnd = total === 0 ? 0 : Math.min(page * limit, total);

  return (
    <nav
      aria-label="Paginação de APRs"
      className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"
    >
      <div
        className="text-sm text-[var(--ds-color-text-secondary)]"
        aria-live="polite"
        aria-atomic="true"
      >
        Mostrando{" "}
        <span className="font-semibold text-[var(--ds-color-text-primary)]">
          {rangeStart}-{rangeEnd}
        </span>{" "}
        de{" "}
        <span className="font-semibold text-[var(--ds-color-text-primary)]">
          {total}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 lg:justify-center">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onPrev}
          disabled={!canPrev}
          leftIcon={<ChevronLeft className="h-4 w-4" />}
        >
          Anterior
        </Button>
        <span
          aria-current="page"
          className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-1.5 text-xs font-semibold text-[var(--ds-color-text-secondary)]"
        >
          Página {page} de {lastPage}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={!canNext}
          rightIcon={<ChevronRight className="h-4 w-4" />}
        >
          Próxima
        </Button>
      </div>

      <div className="text-sm text-[var(--ds-color-text-secondary)]">
        {limit} por página
      </div>
    </nav>
  );
}
