import React, { useMemo } from 'react';
import { useFormContext } from 'react-hook-form';
import { cn } from '@/lib/utils';
import { initialChecklists, type PtFormData } from './pt-schema-and-data';

type RapidRiskChecklistAnswer = 'Sim' | 'Não';
type RapidRiskChecklistItem = PtFormData['analise_risco_rapida_checklist'][number];

export const RapidRiskAnalysisSection = () => {
  const { watch, setValue, formState: { errors } } = useFormContext<PtFormData>();
  
  const rapidRiskChecklist =
    watch('analise_risco_rapida_checklist') ??
    initialChecklists.analise_risco_rapida_checklist;
  const rapidRiskObservacoes = watch('analise_risco_rapida_observacoes') ?? '';

  const hasRapidRiskBasicNo = useMemo(
    () =>
      rapidRiskChecklist.some((item) => item.secao === 'basica' && item.resposta === 'Não'),
    [rapidRiskChecklist],
  );

  const setRapidRiskChecklistAnswer = (index: number, resposta: RapidRiskChecklistAnswer) => {
      const item = rapidRiskChecklist[index]!;
      const updated = [...rapidRiskChecklist];
      updated[index] = { ...item, resposta };
      setValue('analise_risco_rapida_checklist', updated, {
        shouldValidate: true,
      });
  };

  const getRapidRiskAnswerError = (index: number) => {
    const checklistErrors = errors.analise_risco_rapida_checklist;
    if (!Array.isArray(checklistErrors)) return undefined;
    const itemError = checklistErrors[index];
    if (!itemError || typeof itemError !== 'object') return undefined;
    const message = (itemError as { resposta?: { message?: unknown } }).resposta?.message;
    return typeof message === 'string' ? message : undefined;
  };

  const rapidRiskObservacoesErrorMessage =
    typeof errors.analise_risco_rapida_observacoes?.message === 'string'
      ? errors.analise_risco_rapida_observacoes.message
      : undefined;

  return (
    <div className="ds-form-section">
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold text-[var(--ds-color-text-primary)]">
        Análise de Risco Rápida
        <span className="h-2 w-2 rounded-full bg-[var(--ds-color-info)]"></span>
      </h2>
      <p className="mb-4 text-sm text-[var(--ds-color-text-primary)]">
        Se respondeu &quot;Não&quot; em alguma verificação básica, o trabalho não deve
        começar sem medidas corretivas implementadas.
      </p>
      <p className="mb-6 text-sm text-[var(--ds-color-text-primary)]">
        Documente e comprove as medidas no campo de observações deste
        formulário (ou formalize por e-mail).
      </p>

      {hasRapidRiskBasicNo && (
        <div className="mb-4 rounded-lg border border-[color:var(--ds-color-danger)]/18 bg-[color:var(--ds-color-danger-subtle)] p-4 text-sm text-[var(--ds-color-danger)]">
          Foi identificado pelo menos um &quot;Não&quot; nas verificações básicas.
          Registre as ações corretivas em observações antes de continuar.
        </div>
      )}

      <div className="space-y-6">
        {(['basica', 'adicional'] as const).map((secao) => {
          const tituloSecao =
            secao === 'basica'
              ? 'Verificações'
              : 'Verificações adicionais';
          
          const sectionItems = rapidRiskChecklist
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => item.secao === secao);

          return (
            <div key={secao} className="space-y-3">
              <h3 className="text-sm font-bold uppercase tracking-wide text-[var(--ds-color-text-primary)]">
                {tituloSecao}
              </h3>

              {sectionItems.map(({ item, index }: { item: RapidRiskChecklistItem; index: number }) => {
                const answerError = getRapidRiskAnswerError(index);

                return (
                  <fieldset
                    key={item.id}
                    className="rounded-lg border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/14 p-4"
                    aria-required="true"
                    aria-describedby={answerError ? `pt-arr-error-${item.id}` : undefined}
                  >
                    <legend className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                      {item.pergunta}{' '}
                      <span className="text-[var(--ds-color-danger)]" aria-hidden="true">
                        *
                      </span>
                    </legend>

                    <div className="mt-3 flex flex-wrap gap-4">
                      {(['Sim', 'Não'] as RapidRiskChecklistAnswer[]).map(
                        (option) => (
                          <label
                            key={`${item.id}-${option}`}
                            className="flex items-center gap-2 text-sm text-[var(--ds-color-text-primary)]"
                          >
                            <input
                              type="radio"
                              name={`arr-${item.id}`}
                              checked={item.resposta === option}
                              required
                              aria-describedby={answerError ? `pt-arr-error-${item.id}` : undefined}
                              onChange={() =>
                                setRapidRiskChecklistAnswer(index, option)
                              }
                              className="h-4 w-4 text-[var(--ds-color-text-primary)] focus:ring-[var(--ds-color-focus)]"
                            />
                            <span>{option}</span>
                          </label>
                        ),
                      )}
                    </div>

                    {answerError && (
                      <p
                        id={`pt-arr-error-${item.id}`}
                        role="alert"
                        className="mt-2 text-xs text-[var(--ds-color-danger)]"
                      >
                        {String(answerError)}
                      </p>
                    )}
                  </fieldset>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        <label
          htmlFor="pt-arr-observacoes"
          className="mb-1 block text-sm font-semibold text-[var(--ds-color-text-primary)]"
        >
          Observações e evidências
          {hasRapidRiskBasicNo && <span className="text-[var(--ds-color-danger)]"> *</span>}
        </label>
        <textarea
          id="pt-arr-observacoes"
          value={rapidRiskObservacoes || ''}
          maxLength={5000}
          aria-invalid={Boolean(rapidRiskObservacoesErrorMessage)}
          aria-describedby={
            rapidRiskObservacoesErrorMessage ? 'pt-arr-observacoes-error' : undefined
          }
          onChange={(event) =>
            setValue(
              'analise_risco_rapida_observacoes',
              event.target.value,
              { shouldValidate: true },
            )
          }
          rows={4}
          placeholder="Descreva ações adicionais, medidas corretivas e evidências adotadas."
          className={cn(
            'block w-full rounded-lg border px-3 py-2 text-sm motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none',
            rapidRiskObservacoesErrorMessage
              ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]'
              : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
          )}
        />
        {rapidRiskObservacoesErrorMessage && (
          <p
            id="pt-arr-observacoes-error"
            role="alert"
            className="mt-1 text-xs text-[var(--ds-color-danger)]"
          >
            {rapidRiskObservacoesErrorMessage}
          </p>
        )}
      </div>
    </div>
  );
};
