'use client';

import React, { useMemo } from 'react';
import { useFormContext } from 'react-hook-form';
import { Sparkles, Loader2, FileLock2 } from 'lucide-react';
import type { Company } from '@/services/companiesService';
import type { Site } from '@/services/sitesService';
import type { Apr } from '@/services/aprsService';
import type { User } from '@/services/usersService';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { PtFormData } from './pt-schema-and-data';
import { isAiEnabled } from '@/lib/featureFlags';

type BasicInfoSectionProps = {
  companies: Company[];
  filteredSites: Site[];
  filteredAprs: Apr[];
  filteredUsers: User[];
  analyzing: boolean;
  onAiAnalysis: () => void;
  onCompanyChange?: (companyId: string) => void;
  onAprChange?: (aprId: string) => void;
};

export function BasicInfoSection({
  companies,
  filteredSites,
  filteredAprs,
  filteredUsers,
  analyzing,
  onAiAnalysis,
  onCompanyChange,
  onAprChange,
}: BasicInfoSectionProps) {
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<PtFormData>();

  const companyId = watch('company_id');
  const siteId = watch('site_id');
  const currentStatus = watch('status') || 'Pendente';
  const statusOptions = useMemo(() => [currentStatus], [currentStatus]);

  const responsaveis = useMemo(() => {
    if (!companyId) return [];
    return filteredUsers || [];
  }, [companyId, filteredUsers]);

  const getErrorMessage = (fieldName: keyof PtFormData) => {
    const fieldError = errors[fieldName];
    if (!fieldError || typeof fieldError !== 'object' || !('message' in fieldError)) {
      return undefined;
    }
    const message = fieldError.message;
    return typeof message === 'string' ? message : undefined;
  };

  return (
    <div className="ds-form-section">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--ds-color-text-primary)]">
            Dados Básicos da PT
            <span className="h-2 w-2 rounded-full bg-[var(--ds-color-action-primary)]"></span>
          </h2>
          <p className="mt-1 text-sm text-[var(--ds-color-text-primary)]">
            Preencha os dados principais para emissão da Permissão de Trabalho.
          </p>
        </div>

        {isAiEnabled() && (
          <Button
            type="button"
            onClick={onAiAnalysis}
            disabled={analyzing}
            variant="outline"
            leftIcon={analyzing ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" /> : <Sparkles className="h-4 w-4" />}
          >
            SGS
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="pt-numero" className="block text-sm font-semibold text-[var(--ds-color-text-primary)] mb-1">
            Número <span className="text-[var(--ds-color-danger)]">*</span>
          </label>
          <input
            id="pt-numero"
            {...register('numero')}
            maxLength={80}
            aria-invalid={errors.numero ? 'true' : undefined}
            placeholder="Ex: PT-001"
            className={cn(
              'w-full rounded-lg border px-3 py-2 text-sm motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none',
              errors.numero ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]' : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
            )}
          />
          {errors.numero && (
            <p className="mt-1 text-xs text-[var(--ds-color-danger)]">{getErrorMessage('numero')}</p>
          )}
        </div>

        <div>
          <label htmlFor="pt-status" className="block text-sm font-semibold text-[var(--ds-color-text-primary)] mb-1">
            Status <span className="text-[var(--ds-color-danger)]">*</span>
          </label>
          <select
            id="pt-status"
            {...register('status')}
            aria-invalid={errors.status ? 'true' : undefined}
            className={cn(
              'w-full rounded-lg border px-3 py-2 text-sm motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none',
              errors.status ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]' : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
            )}
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-[var(--ds-color-text-secondary)]">
            Aprovação e cancelamento usam o fluxo operacional dedicado da PT. Aqui o status é apenas informativo.
          </p>
        </div>

        <div className="md:col-span-2">
          <label htmlFor="pt-titulo" className="block text-sm font-semibold text-[var(--ds-color-text-primary)] mb-1">
            Título <span className="text-[var(--ds-color-danger)]">*</span>
          </label>
          <input
            id="pt-titulo"
            {...register('titulo')}
            maxLength={200}
            aria-invalid={errors.titulo ? 'true' : undefined}
            placeholder="Descreva o trabalho a ser executado"
            className={cn(
              'w-full rounded-lg border px-3 py-2 text-sm motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none',
              errors.titulo ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]' : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
            )}
          />
          {errors.titulo && (
            <p className="mt-1 text-xs text-[var(--ds-color-danger)]">{getErrorMessage('titulo')}</p>
          )}
        </div>

        <div className="md:col-span-2">
          <label htmlFor="pt-descricao" className="block text-sm font-semibold text-[var(--ds-color-text-primary)] mb-1">
            Descrição
          </label>
          <textarea
            id="pt-descricao"
            {...register('descricao')}
            maxLength={5000}
            aria-label="Descrição da permissão de trabalho"
            rows={3}
            placeholder="Detalhe a atividade, riscos e controles"
            className={cn(
              'w-full rounded-lg border px-3 py-2 text-sm motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none',
              errors.descricao ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]' : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
            )}
          />
          {errors.descricao && (
            <p className="mt-1 text-xs text-[var(--ds-color-danger)]">{getErrorMessage('descricao')}</p>
          )}
        </div>

        <div>
          <label htmlFor="pt-data-hora-inicio" className="block text-sm font-semibold text-[var(--ds-color-text-primary)] mb-1">
            Início <span className="text-[var(--ds-color-danger)]">*</span>
          </label>
          <input
            id="pt-data-hora-inicio"
            type="datetime-local"
            {...register('data_hora_inicio')}
            aria-invalid={errors.data_hora_inicio ? 'true' : undefined}
            className={cn(
              'w-full rounded-lg border px-3 py-2 text-sm motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none',
              errors.data_hora_inicio ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]' : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
            )}
          />
        </div>

        <div>
          <label htmlFor="pt-data-hora-fim" className="block text-sm font-semibold text-[var(--ds-color-text-primary)] mb-1">
            Fim <span className="text-[var(--ds-color-danger)]">*</span>
          </label>
          <input
            id="pt-data-hora-fim"
            type="datetime-local"
            {...register('data_hora_fim')}
            aria-invalid={errors.data_hora_fim ? 'true' : undefined}
            className={cn(
              'w-full rounded-lg border px-3 py-2 text-sm motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none',
              errors.data_hora_fim ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]' : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
            )}
          />
        </div>

        <div>
          <label htmlFor="pt-company-id" className="block text-sm font-semibold text-[var(--ds-color-text-primary)] mb-1">
            Empresa <span className="text-[var(--ds-color-danger)]">*</span>
          </label>
          <select
            id="pt-company-id"
            {...register('company_id')}
            onChange={(e) => {
              setValue('company_id', e.target.value, { shouldValidate: true });
              setValue('site_id', '', { shouldValidate: true });
              setValue('apr_id', '', { shouldValidate: true });
              setValue('responsavel_id', '', { shouldValidate: true });
              onCompanyChange?.(e.target.value);
            }}
            aria-invalid={errors.company_id ? 'true' : undefined}
            className={cn(
              'w-full rounded-lg border px-3 py-2 text-sm motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none',
              errors.company_id ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]' : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
            )}
          >
            <option value="">Selecione...</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.razao_social}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="pt-site-id" className="block text-sm font-semibold text-[var(--ds-color-text-primary)] mb-1">
            Obra / Site <span className="text-[var(--ds-color-danger)]">*</span>
          </label>
          <select
            id="pt-site-id"
            {...register('site_id')}
            disabled={!companyId}
            aria-invalid={errors.site_id ? 'true' : undefined}
            className={cn(
              'w-full rounded-lg border px-3 py-2 text-sm motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none disabled:bg-[color:var(--ds-color-surface-muted)]',
              errors.site_id ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]' : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
            )}
          >
            <option value="">{companyId ? 'Selecione...' : 'Selecione a empresa'}</option>
            {filteredSites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nome}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="pt-apr-id" className="block text-sm font-semibold text-[var(--ds-color-text-primary)] mb-1">
            APR (opcional)
          </label>
          <select
            id="pt-apr-id"
            {...register('apr_id')}
            onChange={(e) => {
              setValue('apr_id', e.target.value, { shouldValidate: true });
              onAprChange?.(e.target.value);
            }}
            disabled={!companyId}
            aria-label="APR vinculada"
            className="w-full rounded-lg border border-[var(--ds-color-border-default)] px-3 py-2 text-sm motion-safe:transition-all focus:border-[var(--ds-color-focus)] focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none disabled:bg-[color:var(--ds-color-surface-muted)]"
          >
            <option value="">{companyId ? 'Selecione...' : 'Selecione a empresa'}</option>
            {filteredAprs.map((a) => (
              <option key={a.id} value={a.id}>
                {a.numero}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-[var(--ds-color-text-secondary)]">
            Ao vincular uma APR, a PT pode herdar contexto operacional e sugestões de grupos críticos.
          </p>
        </div>

        <div>
          <label htmlFor="pt-responsavel-id" className="block text-sm font-semibold text-[var(--ds-color-text-primary)] mb-1">
            Responsável <span className="text-[var(--ds-color-danger)]">*</span>
          </label>
          <select
            id="pt-responsavel-id"
            {...register('responsavel_id')}
            disabled={!companyId}
            aria-invalid={errors.responsavel_id ? 'true' : undefined}
            className={cn(
              'w-full rounded-lg border px-3 py-2 text-sm motion-safe:transition-all focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] focus:outline-none disabled:bg-[color:var(--ds-color-surface-muted)]',
              errors.responsavel_id ? 'border-[var(--ds-color-danger)] bg-[color:var(--ds-color-danger-subtle)]' : 'border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-focus)]',
            )}
          >
            <option value="">{companyId ? 'Selecione...' : 'Selecione a empresa'}</option>
            {responsaveis.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nome}
              </option>
            ))}
          </select>
          {errors.responsavel_id && (
            <p className="mt-1 text-xs text-[var(--ds-color-danger)]">{getErrorMessage('responsavel_id')}</p>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-[var(--ds-color-border-default)] p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-[color:var(--ds-color-info)]/12 p-2 text-[var(--ds-color-info)]">
            <FileLock2 className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-bold text-[var(--ds-color-text-primary)]">PDF final governado</p>
            <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
              O formulário salva os dados operacionais da PT. O PDF final oficial
              é emitido somente depois da aprovação, pelo fluxo documental da lista
              de PTs e do storage semanal.
            </p>
            {siteId ? (
              <p className="mt-2 text-[11px] text-[var(--ds-color-text-secondary)]">
                Site selecionado: {String(siteId).slice(0, 8)}…
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
