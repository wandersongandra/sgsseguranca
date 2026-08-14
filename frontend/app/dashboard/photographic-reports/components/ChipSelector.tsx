'use client';

interface ChipSelectorProps<T extends string> {
  options: readonly T[];
  value: T | null | undefined;
  onChange: (value: T) => void;
  disabled?: boolean;
  label?: string;
}

export function ChipSelector<T extends string>({
  options,
  value,
  onChange,
  disabled,
  label,
}: ChipSelectorProps<T>) {
  return (
    <div>
      {label && (
        <p className="mb-1.5 text-xs font-medium text-[var(--ds-color-text-muted)] uppercase tracking-wide">
          {label}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = opt === value;
          return (
            <button
              key={opt}
              type="button"
              disabled={disabled}
              onClick={() => onChange(opt)}
              className={[
                'px-3 py-1.5 rounded-full text-sm font-medium transition-all border',
                active
                  ? 'bg-[var(--ds-color-action-primary)] text-[var(--ds-color-action-primary-foreground)] border-[var(--ds-color-action-primary)] shadow-sm'
                  : 'bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-muted)] border-[var(--ds-color-border-subtle)] hover:border-[var(--ds-color-action-primary)]/60 hover:text-[var(--ds-color-text-primary)]',
                disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
              ].join(' ')}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface MultiChipSelectorProps<T extends string> {
  options: readonly T[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  label?: string;
  description?: string;
  /** Rótulo de apoio por opção, ex.: NR-35 → "Trabalho em altura". */
  optionLabels?: Record<string, string>;
}

/**
 * Variante de seleção múltipla, usada para as NRs aplicáveis.
 *
 * Mostra o rótulo de apoio (o que a norma trata) junto do código: ninguém
 * memoriza as 18 NRs, e uma lista só de códigos leva a marcação errada.
 */
export function MultiChipSelector<T extends string>({
  options,
  values,
  onChange,
  disabled,
  label,
  description,
  optionLabels,
}: MultiChipSelectorProps<T>) {
  const selected = new Set(values);

  function toggle(option: T) {
    const next = new Set(selected);
    if (next.has(option)) {
      next.delete(option);
    } else {
      next.add(option);
    }
    // Preserva a ordem do catálogo em vez da ordem de clique — o PDF fica
    // previsível e dois relatórios com as mesmas NRs saem iguais.
    onChange(options.filter((item) => next.has(item)));
  }

  return (
    <div>
      {label && (
        <p className="mb-1 text-xs font-medium text-[var(--ds-color-text-muted)] uppercase tracking-wide">
          {label}
        </p>
      )}
      {description && (
        <p className="mb-2 text-xs text-[var(--ds-color-text-muted)]">
          {description}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = selected.has(opt);
          const hint = optionLabels?.[opt];
          return (
            <button
              key={opt}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => toggle(opt)}
              title={hint}
              className={[
                'px-3 py-1.5 rounded-full text-sm font-medium transition-all border text-left',
                active
                  ? 'bg-[var(--ds-color-action-primary)] text-[var(--ds-color-action-primary-foreground)] border-[var(--ds-color-action-primary)] shadow-sm'
                  : 'bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-muted)] border-[var(--ds-color-border-subtle)] hover:border-[var(--ds-color-action-primary)]/60 hover:text-[var(--ds-color-text-primary)]',
                disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
              ].join(' ')}
            >
              <span className="font-semibold">{opt}</span>
              {hint && (
                <span
                  className={[
                    'ml-1.5 text-xs font-normal',
                    active ? 'opacity-80' : 'opacity-70',
                  ].join(' ')}
                >
                  {hint}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
