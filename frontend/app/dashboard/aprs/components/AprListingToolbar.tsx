"use client";

import { Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AprDueFilter, AprListingDensity, AprSortOption } from "./aprListingUtils";

type SelectOption = {
  value: string;
  label: string;
};

type ActiveFilterChip = {
  key: string;
  label: string;
};

interface AprListingToolbarProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
  siteFilter: string;
  onSiteChange: (value: string) => void;
  responsibleFilter: string;
  onResponsibleChange: (value: string) => void;
  dueFilter: AprDueFilter;
  onDueChange: (value: AprDueFilter) => void;
  sortBy: AprSortOption;
  onSortChange: (value: AprSortOption) => void;
  density: AprListingDensity;
  onDensityChange: (value: AprListingDensity) => void;
  totalLabel: string;
  siteOptions: SelectOption[];
  responsibleOptions: SelectOption[];
  activeFilters: ActiveFilterChip[];
  onClearFilters: () => void;
  onExport: () => void;
  onOpenAdvancedFilters: () => void;
}

const APR_STATUS_OPTIONS = [
  { value: "", label: "Todos os status" },
  { value: "Pendente", label: "Pendente" },
  { value: "Aprovada", label: "Aprovada" },
  { value: "Cancelada", label: "Cancelada" },
  { value: "Encerrada", label: "Encerrada" },
];

const DUE_FILTER_OPTIONS: Array<{ value: AprDueFilter; label: string }> = [
  { value: "", label: "Todos os prazos" },
  { value: "today", label: "Vence hoje" },
  { value: "next-7-days", label: "Vence em 7 dias" },
  { value: "expired", label: "Atrasadas" },
  { value: "upcoming", label: "Futuras" },
  { value: "no-deadline", label: "Sem prazo" },
];

const SORT_OPTIONS: Array<{ value: AprSortOption; label: string }> = [
  { value: "priority", label: "Prioridade operacional" },
  { value: "updated-desc", label: "Atualizadas recentemente" },
  { value: "deadline-asc", label: "Prazo mais próximo" },
  { value: "title-asc", label: "Título A-Z" },
];

const inputClassName =
  "h-11 min-w-0 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 text-sm font-medium text-[var(--ds-color-text-primary)] shadow-none motion-safe:transition-colors focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]";

export function AprListingToolbar({
  searchTerm,
  onSearchChange,
  statusFilter,
  onStatusChange,
  siteFilter,
  onSiteChange,
  responsibleFilter,
  onResponsibleChange,
  dueFilter,
  onDueChange,
  sortBy,
  onSortChange,
  density,
  onDensityChange,
  totalLabel,
  siteOptions,
  responsibleOptions,
  activeFilters,
  onClearFilters,
  onExport,
  onOpenAdvancedFilters,
}: AprListingToolbarProps) {
  const hasFilters = activeFilters.length > 0;

  return (
    <div className="apr-listing-toolbar space-y-0">
      <div className="border-b border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="apr-listing-toolbar__filters grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:flex xl:flex-wrap xl:items-center">
            <div className="relative min-w-0 sm:col-span-2 lg:col-span-1 xl:w-[340px]">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[var(--ds-color-text-muted)]">
                <Search className="h-4 w-4" />
              </span>
              <input
                type="search"
                aria-label="Buscar APRs"
                placeholder="Buscar por número, título, obra ou responsável"
                className={cn(inputClassName, "w-full pl-10")}
                value={searchTerm}
                onChange={(event) => onSearchChange(event.target.value)}
              />
            </div>

            <select
              title="Filtrar APRs por status"
              aria-label="Filtrar APRs por status"
              value={statusFilter}
              onChange={(event) => onStatusChange(event.target.value)}
              className={inputClassName}
            >
              {APR_STATUS_OPTIONS.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              title="Filtrar APRs por obra"
              aria-label="Filtrar APRs por obra"
              value={siteFilter}
              onChange={(event) => onSiteChange(event.target.value)}
              className={inputClassName}
            >
              <option value="">Todas as obras</option>
              {siteOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              title="Filtrar APRs por responsável"
              aria-label="Filtrar APRs por responsável"
              value={responsibleFilter}
              onChange={(event) => onResponsibleChange(event.target.value)}
              className={inputClassName}
            >
              <option value="">Todos os responsáveis</option>
              {responsibleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              title="Filtrar APRs por vencimento"
              aria-label="Filtrar APRs por vencimento"
              value={dueFilter}
              onChange={(event) => onDueChange(event.target.value as AprDueFilter)}
              className={inputClassName}
            >
              {DUE_FILTER_OPTIONS.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<SlidersHorizontal className="h-4 w-4" />}
              onClick={onOpenAdvancedFilters}
              className="h-11 justify-center"
            >
              Mais filtros
            </Button>
          </div>

          <div className="apr-listing-toolbar__actions grid grid-cols-1 gap-3 sm:grid-cols-[minmax(210px,1fr)_auto_auto] sm:items-center xl:w-auto xl:justify-end">
            <select
              title="Ordenar APRs"
              aria-label="Ordenar APRs"
              value={sortBy}
              onChange={(event) => onSortChange(event.target.value as AprSortOption)}
              className={cn(inputClassName, "w-full sm:min-w-[210px]")}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <div className="ds-segmented-control">
              <button
                type="button"
                onClick={() => onDensityChange("comfortable")}
                data-state={density === "comfortable" ? "active" : "inactive"}
                className="ds-segmented-control__item sm:flex-none"
              >
                Confortável
              </button>
              <button
                type="button"
                onClick={() => onDensityChange("compact")}
                data-state={density === "compact" ? "active" : "inactive"}
                className="ds-segmented-control__item sm:flex-none"
              >
                Compacta
              </button>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 justify-center"
              onClick={onExport}
            >
              Exportar
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-b border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/70 px-4 py-3 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-[var(--ds-color-text-primary)]">
            {totalLabel}
          </span>
          {activeFilters.map((filter) => (
            <span key={filter.key} className="ds-toolbar-chip">
              {filter.label}
            </span>
          ))}
        </div>

        {hasFilters ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            leftIcon={<X className="h-3.5 w-3.5" />}
            onClick={onClearFilters}
          >
            Limpar filtros
          </Button>
        ) : null}
      </div>
    </div>
  );
}
