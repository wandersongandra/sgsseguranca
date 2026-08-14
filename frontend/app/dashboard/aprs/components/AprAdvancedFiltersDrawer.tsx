"use client";

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import {
  AprDueFilter,
  AprListingDensity,
  AprSortOption,
} from "./aprListingUtils";

type SelectOption = {
  value: string;
  label: string;
};

interface AprAdvancedFiltersDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  searchTerm: string;
  statusFilter: string;
  siteFilter: string;
  responsibleFilter: string;
  dueFilter: AprDueFilter;
  sortBy: AprSortOption;
  density: AprListingDensity;
  siteOptions: SelectOption[];
  responsibleOptions: SelectOption[];
  onApply: (payload: {
    searchTerm: string;
    statusFilter: string;
    siteFilter: string;
    responsibleFilter: string;
    dueFilter: AprDueFilter;
    sortBy: AprSortOption;
    density: AprListingDensity;
  }) => void;
  onClear: () => void;
}

const inputClassName =
  "w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] motion-safe:transition-colors focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]";

const statusOptions = [
  { value: "", label: "Todos os status" },
  { value: "Pendente", label: "Pendente" },
  { value: "Aprovada", label: "Aprovada" },
  { value: "Cancelada", label: "Cancelada" },
  { value: "Encerrada", label: "Encerrada" },
];

const dueOptions: Array<{ value: AprDueFilter; label: string }> = [
  { value: "", label: "Todos os prazos" },
  { value: "today", label: "Vence hoje" },
  { value: "next-7-days", label: "Vence em 7 dias" },
  { value: "expired", label: "Atrasadas" },
  { value: "upcoming", label: "Futuras" },
  { value: "no-deadline", label: "Sem prazo" },
];

const sortOptions: Array<{ value: AprSortOption; label: string }> = [
  { value: "priority", label: "Prioridade operacional" },
  { value: "updated-desc", label: "Atualizadas recentemente" },
  { value: "deadline-asc", label: "Prazo mais próximo" },
  { value: "title-asc", label: "Título A-Z" },
];

export function AprAdvancedFiltersDrawer({
  isOpen,
  onClose,
  searchTerm,
  statusFilter,
  siteFilter,
  responsibleFilter,
  dueFilter,
  sortBy,
  density,
  siteOptions,
  responsibleOptions,
  onApply,
  onClear,
}: AprAdvancedFiltersDrawerProps) {
  const [draft, setDraft] = useState({
    searchTerm,
    statusFilter,
    siteFilter,
    responsibleFilter,
    dueFilter,
    sortBy,
    density,
  });

  const drawerRef = useRef<HTMLElement>(null);

  useFocusTrap(drawerRef, isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;

    setDraft({
      searchTerm,
      statusFilter,
      siteFilter,
      responsibleFilter,
      dueFilter,
      sortBy,
      density,
    });
  }, [
    isOpen,
    searchTerm,
    statusFilter,
    siteFilter,
    responsibleFilter,
    dueFilter,
    sortBy,
    density,
  ]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[120] bg-[color:var(--component-overlay)]/45" onClick={onClose}>
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Filtros avançados de APR"
        className="ml-auto flex h-full w-full max-w-md flex-col border-l border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-md)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--ds-color-border-default)] px-5 py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[var(--ds-color-text-primary)]">
              <SlidersHorizontal className="h-4 w-4" />
              <h2 className="text-base font-semibold">Filtros avançados</h2>
            </div>
            <p className="text-sm text-[var(--ds-color-text-secondary)]">
              Ajuste o recorte da fila e salve esse estado diretamente na URL.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-[var(--ds-color-text-muted)] motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)] hover:text-[var(--ds-color-text-primary)]"
            aria-label="Fechar filtros avançados"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div className="space-y-2">
            <label htmlFor="apr-advanced-search">Busca operacional</label>
            <input
              id="apr-advanced-search"
              type="search"
              className={inputClassName}
              placeholder="Número, título, obra ou responsável"
              value={draft.searchTerm}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  searchTerm: event.target.value,
                }))
              }
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="apr-advanced-status">Status</label>
              <select
                id="apr-advanced-status"
                className={inputClassName}
                value={draft.statusFilter}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    statusFilter: event.target.value,
                  }))
                }
              >
                {statusOptions.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="apr-advanced-due">Vencimento</label>
              <select
                id="apr-advanced-due"
                className={inputClassName}
                value={draft.dueFilter}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    dueFilter: event.target.value as AprDueFilter,
                  }))
                }
              >
                {dueOptions.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="apr-advanced-site">Obra</label>
            <select
              id="apr-advanced-site"
              className={inputClassName}
              value={draft.siteFilter}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  siteFilter: event.target.value,
                }))
              }
            >
              <option value="">Todas as obras</option>
              {siteOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label htmlFor="apr-advanced-responsible">Responsável</label>
            <select
              id="apr-advanced-responsible"
              className={inputClassName}
              value={draft.responsibleFilter}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  responsibleFilter: event.target.value,
                }))
              }
            >
              <option value="">Todos os responsáveis</option>
              {responsibleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label htmlFor="apr-advanced-sort">Ordenação</label>
            <select
              id="apr-advanced-sort"
              className={inputClassName}
              value={draft.sortBy}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  sortBy: event.target.value as AprSortOption,
                }))
              }
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label>Densidade da tabela</label>
            <div className="inline-flex rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] p-1">
              <button
                type="button"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    density: "comfortable",
                  }))
                }
                className={cn(
                  "rounded-[calc(var(--ds-radius-md)-2px)] px-3 py-1.5 text-xs font-semibold motion-safe:transition-colors",
                  draft.density === "comfortable"
                    ? "bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-primary)] shadow-[var(--ds-shadow-xs)]"
                    : "text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]",
                )}
              >
                Confortável
              </button>
              <button
                type="button"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    density: "compact",
                  }))
                }
                className={cn(
                  "rounded-[calc(var(--ds-radius-md)-2px)] px-3 py-1.5 text-xs font-semibold motion-safe:transition-colors",
                  draft.density === "compact"
                    ? "bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-primary)] shadow-[var(--ds-shadow-xs)]"
                    : "text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]",
                )}
              >
                Compacta
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--ds-color-border-default)] px-5 py-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onClear();
              onClose();
            }}
          >
            Limpar tudo
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => {
                onApply(draft);
                onClose();
              }}
            >
              Aplicar filtros
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}
