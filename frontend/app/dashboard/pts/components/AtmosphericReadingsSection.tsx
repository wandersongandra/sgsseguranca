import React, { useRef, useState } from 'react';
import { useFieldArray, useFormContext } from 'react-hook-form';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ptsService, type PtAtmosphericReading } from '@/services/ptsService';
import type { PtFormData } from './pt-schema-and-data';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';

type AtmosphericReadingsSectionProps = {
  /** PT persistida — habilita o modo append-only pós-aprovação. */
  ptId?: string;
  /** true quando o formulário está em modo somente leitura (status ≠ Pendente). */
  readOnly: boolean;
  /** true quando ainda é possível registrar medições (Pendente/Aprovada, sem PDF final). */
  canAppendReadings: boolean;
  onReadingAppended?: () => void;
};

const READING_COLUMNS = [
  { key: 'hora', label: 'Hora', placeholder: '08:30' },
  { key: 'oxigenio', label: 'O2 (%)', placeholder: '20.9' },
  { key: 'inflamaveis_lel', label: 'LEL (%)', placeholder: '0' },
  { key: 'co', label: 'CO (ppm)', placeholder: '0' },
  { key: 'h2s', label: 'H2S (ppm)', placeholder: '0' },
  { key: 'instrumento', label: 'Instrumento', placeholder: 'Detector XYZ-4' },
  { key: 'responsavel', label: 'Responsável', placeholder: 'Nome' },
] as const;

const cellInputClass = (hasError: boolean) =>
  cn(
    'block w-full rounded-md border px-2 py-1.5 text-xs motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none',
    hasError
      ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]'
      : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
  );

const buildEmptyReading = (): PtAtmosphericReading => ({
  id:
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `reading-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  hora: '',
  oxigenio: Number.NaN,
  inflamaveis_lel: Number.NaN,
  co: Number.NaN,
  h2s: Number.NaN,
  instrumento: '',
  responsavel: '',
});

export const AtmosphericReadingsSection = ({
  ptId,
  readOnly,
  canAppendReadings,
  onReadingAppended,
}: AtmosphericReadingsSectionProps) => {
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<PtFormData>();
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'medicoes_atmosfericas',
  });

  const [draft, setDraft] = useState<PtAtmosphericReading>(buildEmptyReading);
  const [appending, setAppending] = useState(false);
  const appendLockRef = useRef(false);

  const getCellError = (index: number, key: string): string | undefined => {
    const rowErrors = errors.medicoes_atmosfericas;
    if (!Array.isArray(rowErrors)) return undefined;
    const cell = (rowErrors[index] as Record<string, { message?: unknown }>)?.[
      key
    ];
    return typeof cell?.message === 'string' ? cell.message : undefined;
  };

  const submitAppendOnly = async () => {
    if (!ptId) return;
    if (appendLockRef.current) return;
    if (
      !draft.hora ||
      !draft.instrumento.trim() ||
      !draft.responsavel.trim() ||
      [draft.oxigenio, draft.inflamaveis_lel, draft.co, draft.h2s].some((v) =>
        Number.isNaN(v),
      )
    ) {
      toast.error('Preencha todos os campos da medição antes de registrar.');
      return;
    }
    appendLockRef.current = true;
    setAppending(true);
    try {
      await ptsService.appendAtmosphericReading(ptId, {
        ...draft,
        instrumento: draft.instrumento.trim(),
        responsavel: draft.responsavel.trim(),
      });
      toast.success('Medição atmosférica registrada.');
      setDraft(buildEmptyReading());
      onReadingAppended?.();
    } catch (error) {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response
          ?.data?.message || 'Erro ao registrar medição.';
      toast.error(message);
    } finally {
      appendLockRef.current = false;
      setAppending(false);
    }
  };

  return (
    <div className="ds-form-section">
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold text-[var(--ds-color-text-primary)]">
        Medições Atmosféricas (NR-33)
        <span className="h-2 w-2 rounded-full bg-[var(--ds-color-warning)]"></span>
      </h2>
      <p className="mb-6 text-sm text-[var(--ds-color-text-primary)]">
        Registre os valores medidos antes da entrada e periodicamente durante a
        ocupação do espaço confinado: oxigênio, inflamáveis (LEL), CO e H2S.
      </p>

      {!readOnly ? (
        <div className="space-y-3">
          <ResponsiveDataList
            items={fields}
            getKey={(field) => field.id}
            mobileClassName="grid min-w-0 gap-3"
            desktop={() => (
          <div className="overflow-x-auto" aria-label="Medições atmosféricas em tabela">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead>
                <tr className="text-[var(--ds-color-text-secondary)]">
                  {READING_COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      id={`pt-atmospheric-column-${column.key}`}
                      scope="col"
                      className="px-2 py-1.5 font-semibold"
                    >
                      {column.label}
                    </th>
                  ))}
                  <th className="w-10 px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {fields.map((field, index) => (
                  <tr key={field.id}>
                    {READING_COLUMNS.map((column) => {
                      const isNumeric =
                        column.key !== 'hora' &&
                        column.key !== 'instrumento' &&
                        column.key !== 'responsavel';
                      return (
                        <td key={column.key} className="px-2 py-1.5 align-top">
                          <input
                            {...register(
                              `medicoes_atmosfericas.${index}.${column.key}`,
                              isNumeric ? { valueAsNumber: true } : undefined,
                            )}
                            type={isNumeric ? 'number' : 'text'}
                            step={isNumeric ? 'any' : undefined}
                            aria-labelledby={`pt-atmospheric-column-${column.key}`}
                            placeholder={column.placeholder}
                            className={cellInputClass(
                              Boolean(getCellError(index, column.key)),
                            )}
                          />
                          {getCellError(index, column.key) && (
                            <p className="mt-1 text-[10px] text-[var(--ds-color-danger)]">
                              {getCellError(index, column.key)}
                            </p>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5 align-top">
                      <button
                        type="button"
                        onClick={() => remove(index)}
                        aria-label="Remover medição"
                        className="rounded-md px-2 py-1 text-sm text-[var(--ds-color-text-muted)] hover:text-[var(--ds-color-danger)]"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            )}
            mobile={(field, index) => (
              <article className="min-w-0 rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-3" aria-label={`Medição atmosférica ${index + 1}`}>
                <div className="grid grid-cols-2 gap-3">
                  {READING_COLUMNS.map((column) => {
                    const isNumeric = column.key !== 'hora' && column.key !== 'instrumento' && column.key !== 'responsavel';
                    return (
                      <label key={`${field.id}-${column.key}`} className={cn('min-w-0 text-xs font-semibold text-[var(--ds-color-text-secondary)]', (column.key === 'instrumento' || column.key === 'responsavel') && 'col-span-2')}>
                        {column.label}
                        <input {...register(`medicoes_atmosfericas.${index}.${column.key}`, isNumeric ? { valueAsNumber: true } : undefined)} type={isNumeric ? 'number' : 'text'} step={isNumeric ? 'any' : undefined} placeholder={column.placeholder} className={cn(cellInputClass(Boolean(getCellError(index, column.key))), 'mt-1 min-h-11 text-base')} />
                        {getCellError(index, column.key) ? <span className="mt-1 block text-[10px] text-[var(--ds-color-danger)]">{getCellError(index, column.key)}</span> : null}
                      </label>
                    );
                  })}
                </div>
                <button type="button" onClick={() => remove(index)} className="mt-3 min-h-11 w-full rounded-md border border-[color:var(--ds-color-danger)]/30 px-3 text-sm font-semibold text-[var(--ds-color-danger)]">Remover medição</button>
              </article>
            )}
          />
          {fields.length === 0 && (
            <p className="text-xs text-[var(--ds-color-text-muted)]">
              Nenhuma medição registrada até o momento.
            </p>
          )}
          <button
            type="button"
            onClick={() => append(buildEmptyReading())}
            className="rounded-lg border border-[var(--ds-color-border-default)] px-4 py-2 text-sm font-semibold text-[var(--ds-color-text-primary)] hover:bg-[color:var(--ds-color-surface-muted)]/40"
          >
            + Adicionar medição
          </button>
        </div>
      ) : canAppendReadings && ptId ? (
        <div className="rounded-lg border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/14 p-4">
          <p className="mb-3 text-sm font-semibold text-[var(--ds-color-text-primary)]">
            Registrar nova medição (a PT aprovada aceita apenas acréscimos)
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {READING_COLUMNS.map((column) => (
              <div key={column.key}>
                <label htmlFor={`pt-draft-${column.key}`} className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                  {column.label}
                </label>
                <input
                  id={`pt-draft-${column.key}`}
                  value={
                    typeof draft[column.key] === 'number'
                      ? Number.isNaN(draft[column.key] as number)
                        ? ''
                        : String(draft[column.key])
                      : (draft[column.key] as string)
                  }
                  onChange={(event) => {
                    const raw = event.target.value;
                    setDraft((current) => ({
                      ...current,
                      [column.key]:
                        column.key === 'hora' ||
                        column.key === 'instrumento' ||
                        column.key === 'responsavel'
                          ? raw
                          : raw === ''
                            ? Number.NaN
                            : Number(raw),
                    }));
                  }}
                  placeholder={column.placeholder}
                  className={cellInputClass(false)}
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void submitAppendOnly()}
            disabled={appending}
            className="mt-4 rounded-lg bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {appending ? 'Registrando...' : 'Registrar medição'}
          </button>
        </div>
      ) : (
        <p className="text-sm text-[var(--ds-color-text-muted)]">
          As medições desta PT não aceitam mais alterações.
        </p>
      )}
    </div>
  );
};

export default AtmosphericReadingsSection;
