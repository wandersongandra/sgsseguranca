import React, { useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { cn } from '@/lib/utils';
import type { PtFormData } from './pt-schema-and-data';

type EmergencyRescueSectionProps = {
  users: Array<{ id: string; nome: string }>;
};

const inputClassName = (hasError: boolean) =>
  cn(
    'block w-full rounded-lg border px-3 py-2 text-sm motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none',
    hasError
      ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]'
      : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
  );

export const EmergencyRescueSection = ({
  users,
}: EmergencyRescueSectionProps) => {
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<PtFormData>();

  const espacoConfinado = watch('espaco_confinado');
  const vigiaUserId = watch('vigia_user_id') || '';
  const vigiaNome = watch('vigia_nome') || '';
  const episObrigatorios = watch('epis_obrigatorios') || [];
  const [epiDraft, setEpiDraft] = useState('');

  const fieldError = (field: keyof PtFormData): string | undefined => {
    const message = errors[field]?.message;
    return typeof message === 'string' ? message : undefined;
  };

  const addEpi = () => {
    const value = epiDraft.trim();
    if (!value) return;
    if (episObrigatorios.some((epi) => epi.toLowerCase() === value.toLowerCase())) {
      setEpiDraft('');
      return;
    }
    setValue('epis_obrigatorios', [...episObrigatorios, value], {
      shouldValidate: true,
    });
    setEpiDraft('');
  };

  const removeEpi = (index: number) => {
    setValue(
      'epis_obrigatorios',
      episObrigatorios.filter((_, i) => i !== index),
      { shouldValidate: true },
    );
  };

  return (
    <div className="ds-form-section">
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold text-[var(--ds-color-text-primary)]">
        Emergência, Resgate e EPIs
        <span className="h-2 w-2 rounded-full bg-[var(--ds-color-danger)]"></span>
      </h2>
      <p className="mb-6 text-sm text-[var(--ds-color-text-primary)]">
        Dados exigidos pelas NRs 33/35: contato de emergência, plano de resgate
        e equipamentos de proteção obrigatórios para a atividade.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="pt-contato_emergencia" className="mb-1 block text-sm font-semibold text-[var(--ds-color-text-primary)]">
            Contato de emergência
            {espacoConfinado && (
              <span className="text-[var(--ds-color-danger)]"> *</span>
            )}
          </label>
          <input
            {...register('contato_emergencia')}
            id="pt-contato_emergencia"
            maxLength={200}
            aria-required={espacoConfinado}
            placeholder="Ex: Brigada interna — (11) 99999-0000 / ramal 220"
            className={inputClassName(Boolean(fieldError('contato_emergencia')))}
          />
          {fieldError('contato_emergencia') && (
            <p className="mt-1 text-xs text-[var(--ds-color-danger)]">
              {fieldError('contato_emergencia')}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="pt-ponto_encontro" className="mb-1 block text-sm font-semibold text-[var(--ds-color-text-primary)]">
            Ponto de encontro
          </label>
          <input
            {...register('ponto_encontro')}
            id="pt-ponto_encontro"
            maxLength={300}
            placeholder="Ex: Portaria principal — área de concentração"
            className={inputClassName(false)}
          />
        </div>

        <div className="md:col-span-2">
          <label htmlFor="pt-plano_resgate" className="mb-1 block text-sm font-semibold text-[var(--ds-color-text-primary)]">
            Plano de resgate
            {espacoConfinado && (
              <span className="text-[var(--ds-color-danger)]"> *</span>
            )}
          </label>
          <textarea
            {...register('plano_resgate')}
            id="pt-plano_resgate"
            maxLength={2000}
            aria-required={espacoConfinado}
            rows={3}
            placeholder="Descreva o plano/equipe de resgate, equipamentos disponíveis e tempo de resposta."
            className={inputClassName(Boolean(fieldError('plano_resgate')))}
          />
          {fieldError('plano_resgate') && (
            <p className="mt-1 text-xs text-[var(--ds-color-danger)]">
              {fieldError('plano_resgate')}
            </p>
          )}
        </div>
      </div>

      {espacoConfinado && (
        <div className="mt-4 rounded-lg border border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)]/40 p-4">
          <p className="mb-3 text-sm font-semibold text-[var(--ds-color-text-primary)]">
            Vigia designado (NR-33)
            <span className="text-[var(--ds-color-danger)]"> *</span>
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="pt-vigia_user_id" className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                Usuário do sistema
              </label>
              <select
                id="pt-vigia_user_id"
                value={vigiaUserId}
                onChange={(event) => {
                  setValue('vigia_user_id', event.target.value, {
                    shouldValidate: true,
                  });
                  if (event.target.value) {
                    setValue('vigia_nome', '', { shouldValidate: true });
                  }
                }}
                className={inputClassName(false)}
              >
                <option value="">Selecione o vigia...</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.nome}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="pt-vigia_nome" className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                Ou nome do vigia (externo)
              </label>
              <input
                id="pt-vigia_nome"
                value={vigiaNome}
                onChange={(event) => {
                  setValue('vigia_nome', event.target.value, {
                    shouldValidate: true,
                  });
                  if (event.target.value.trim()) {
                    setValue('vigia_user_id', '', { shouldValidate: true });
                  }
                }}
                maxLength={200}
                placeholder="Nome completo do vigia"
                className={inputClassName(Boolean(fieldError('vigia_nome')))}
              />
            </div>
          </div>
          {fieldError('vigia_nome') && (
            <p className="mt-2 text-xs text-[var(--ds-color-danger)]">
              {fieldError('vigia_nome')}
            </p>
          )}
        </div>
      )}

      <div className="mt-4">
        <label htmlFor="pt-epi_draft" className="mb-1 block text-sm font-semibold text-[var(--ds-color-text-primary)]">
          EPIs obrigatórios
        </label>
        <div className="flex gap-2">
          <input
            id="pt-epi_draft"
            value={epiDraft}
            onChange={(event) => setEpiDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addEpi();
              }
            }}
            placeholder="Ex: Cinto paraquedista — pressione Enter para adicionar"
            className={inputClassName(false)}
          />
          <button
            type="button"
            onClick={addEpi}
            className="shrink-0 rounded-lg border border-[var(--ds-color-border-default)] px-4 py-2 text-sm font-semibold text-[var(--ds-color-text-primary)] hover:bg-[color:var(--ds-color-surface-muted)]/40"
          >
            Adicionar
          </button>
        </div>
        {episObrigatorios.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {episObrigatorios.map((epi, index) => (
              <span
                key={`${epi}-${index}`}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/30 px-3 py-1 text-xs font-semibold text-[var(--ds-color-text-primary)]"
              >
                {epi}
                <button
                  type="button"
                  onClick={() => removeEpi(index)}
                  aria-label={`Remover ${epi}`}
                  className="text-[var(--ds-color-text-muted)] hover:text-[var(--ds-color-danger)]"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default EmergencyRescueSection;
