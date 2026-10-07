import React from 'react';
import { Search, Download, Columns3, Save, Trash2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  checklistColumnOptions,
  ChecklistColumnKey,
  ChecklistSavedView,
} from '../columns';

const inputClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]';

interface ChecklistsFiltersProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  modelFilter: 'all' | 'model' | 'regular';
  onModelFilterChange: (value: 'all' | 'model' | 'regular') => void;
  onExportCsv: () => void;
  visibleColumns: ChecklistColumnKey[];
  onToggleColumn: (column: ChecklistColumnKey) => void;
  onResetColumns: () => void;
  savedViews: ChecklistSavedView[];
  activeViewId: string | null;
  onApplyView: (viewId: string) => void;
  onSaveCurrentView: () => void;
  onDeleteActiveView: () => void;
}

export const ChecklistsFilters = React.memo(({
  searchTerm,
  onSearchChange,
  modelFilter,
  onModelFilterChange,
  onExportCsv,
  visibleColumns,
  onToggleColumn,
  onResetColumns,
  savedViews,
  activeViewId,
  onApplyView,
  onSaveCurrentView,
  onDeleteActiveView,
}: ChecklistsFiltersProps) => {
  return (
    <div className="checklists-filters space-y-3 border-b border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/18 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
          <input
            type="text"
            placeholder="Pesquisar checklists..."
            aria-label="Pesquisar checklists"
            className={cn(inputClassName, 'pl-10')}
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <div className="checklists-filters__primary flex flex-wrap items-center gap-3">
          <div className="checklists-filters__model flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--ds-color-text-muted)]">
              Filtro
            </span>
            <select
              aria-label="Filtro de checklists"
              className={inputClassName}
              value={modelFilter}
              onChange={(e) => onModelFilterChange(e.target.value as 'all' | 'model' | 'regular')}
            >
              <option value="regular">Registros</option>
              <option value="model">Modelos</option>
              <option value="all">Todos</option>
            </select>
          </div>
          <details className="checklists-filters__columns relative hidden md:block">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]">
              <Columns3 className="h-4 w-4" />
              Colunas
            </summary>
            <div className="checklists-filters__columns-menu absolute right-0 z-20 mt-2 w-64 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-3 shadow-[var(--ds-shadow-lg)]">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ds-color-text-muted)]">
                  Exibição
                </p>
                <button
                  type="button"
                  onClick={onResetColumns}
                  className="text-xs text-[var(--ds-color-action-primary)] hover:text-[var(--ds-color-action-primary-hover)]"
                >
                  Padrão
                </button>
              </div>
              <div className="space-y-2">
                {checklistColumnOptions.map((column) => (
                  <label
                    key={column.key}
                    className="flex items-center gap-2 text-sm text-[var(--ds-color-text-secondary)]"
                  >
                    <input
                      type="checkbox"
                      checked={visibleColumns.includes(column.key)}
                      onChange={() => onToggleColumn(column.key)}
                      className="h-4 w-4 rounded border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-action-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]"
                    />
                    {column.label}
                  </label>
                ))}
              </div>
            </div>
          </details>
          <Button
            type="button"
            onClick={onExportCsv}
            variant="outline"
            leftIcon={<Download className="h-4 w-4" />}
          >
            Exportar CSV
          </Button>
        </div>
      </div>
      <div className="checklists-filters__views flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--ds-color-text-muted)]">
          Vistas
        </span>
        <select
          aria-label="Vistas salvas de checklist"
          className={cn(inputClassName, 'w-full py-2 sm:max-w-[260px]')}
          value={activeViewId || ''}
          onChange={(event) => onApplyView(event.target.value)}
        >
          <option value="">Vista atual (não salva)</option>
          {savedViews.map((view) => (
            <option key={view.id} value={view.id}>
              {view.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          leftIcon={<Save className="h-3.5 w-3.5" />}
          onClick={onSaveCurrentView}
        >
          Salvar vista
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
          onClick={onResetColumns}
        >
          Resetar colunas
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          leftIcon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={onDeleteActiveView}
          disabled={!activeViewId}
        >
          Excluir vista
        </Button>
      </div>
    </div>
  );
});

ChecklistsFilters.displayName = 'ChecklistsFilters';
