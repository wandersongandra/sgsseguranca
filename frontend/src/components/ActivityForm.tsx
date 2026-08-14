'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { activitiesService } from '@/services/activitiesService';
import { companiesService, Company } from '@/services/companiesService';
import { useForm } from 'react-hook-form';
import type { FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { ArrowLeft, Save } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { getFormErrorMessage } from '@/lib/error-handler';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout';
import { InlineLoadingState } from '@/components/ui/state';
import { StatusPill } from '@/components/ui/status-pill';

const fieldClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] transition-all duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-action-primary)] focus:outline-none focus:shadow-[var(--ds-shadow-sm)]';
const errorFieldClassName = 'border-[var(--ds-color-danger)] focus:border-[var(--ds-color-danger)]';
const labelClassName = 'text-sm font-medium text-[var(--ds-color-text-secondary)]';
const helperClassName = 'text-xs text-[var(--ds-color-text-muted)]';
const errorClassName = 'text-xs text-[var(--ds-color-danger)]';
const sectionCardClassName =
  'rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-5 shadow-[var(--ds-shadow-xs)]';

const activitySchema = z.object({
  nome: z.string().min(3, 'O nome deve ter pelo menos 3 caracteres'),
  descricao: z.string().optional(),
  company_id: z.string().min(1, 'Selecione uma empresa'),
});

type ActivityFormData = z.infer<typeof activitySchema>;

interface ActivityFormProps {
  id?: string;
}

export function ActivityForm({ id }: ActivityFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors, isValid, isSubmitting },
  } = useForm<ActivityFormData>({
    resolver: zodResolver(activitySchema),
    mode: 'onBlur',
    reValidateMode: 'onBlur',
    defaultValues: {
      nome: '',
      descricao: '',
      company_id: '',
    },
  });

  useEffect(() => {
    async function loadData() {
      try {
        let companiesData: Company[] = [];
        try {
          const companiesPage = await companiesService.findPaginated({
            page: 1,
            limit: 100,
          });
          companiesData = companiesPage.data;
          if (companiesPage.lastPage > 1) {
            toast.warning(
              'A lista de empresas foi limitada aos primeiros 100 registros.',
            );
          }
        } catch {
          // sem permissão para listar empresas — seguir com lista vazia
        }
        setCompanies(companiesData);

        if (id) {
          const data = await activitiesService.findOne(id);
          reset({
            nome: data.nome,
            descricao: data.descricao || '',
            company_id: data.company_id || '',
          });
        }
      } catch (error) {
        logger.error('Erro ao carregar dados:', error);
        toast.error('Erro ao carregar dados do formulário.');
        if (id) router.push('/dashboard/activities');
      } finally {
        setFetching(false);
      }
    }

    loadData();
  }, [id, reset, router]);

  async function onSubmit(data: ActivityFormData) {
    try {
      setLoading(true);
      setSubmitError(null);
      if (id) {
        await activitiesService.update(id, data);
        toast.success('Atividade atualizada com sucesso!');
      } else {
        await activitiesService.create(data);
        toast.success('Atividade cadastrada com sucesso!');
      }
      router.push('/dashboard/activities');
      router.refresh();
    } catch (error) {
      logger.error('Erro ao salvar atividade:', error);
      const errorMessage = getFormErrorMessage(error, {
        badRequest: 'Dados inválidos. Revise os campos obrigatórios.',
        unauthorized: 'Sessão expirada. Faça login novamente.',
        forbidden: 'Você não tem permissão para salvar atividades.',
        server: 'Erro interno do servidor ao salvar atividade.',
        fallback: 'Erro ao salvar atividade. Tente novamente.',
      });
      setSubmitError(errorMessage);
      toast.error('Erro ao salvar atividade. Verifique os dados e tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  const onInvalid = (formErrors: FieldErrors<ActivityFormData>) => {
    if (formErrors.company_id) {
      setFocus('company_id');
    } else if (formErrors.nome) {
      setFocus('nome');
    }
    toast.error('Revise os campos obrigatórios antes de salvar.');
  };

  return (
    <div className="ds-form-page mx-auto max-w-2xl space-y-6">
      {fetching ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
          <InlineLoadingState
            label={id ? 'Carregando atividade' : 'Preparando atividade'}
          />
        </div>
      ) : null}

      <PageHeader
        eyebrow="Cadastro de atividades"
        title={id ? 'Editar atividade' : 'Nova atividade'}
        description="Defina o tenant e a descrição operacional da atividade para padronizar uso em SST e operação."
        icon={
          <Link
            href="/dashboard/activities"
            className="rounded-full p-2 text-[var(--ds-color-text-muted)] transition-colors hover:bg-[var(--ds-color-primary-subtle)] hover:text-[var(--ds-color-text-primary)]"
            title="Voltar"
            aria-label="Voltar para a lista de atividades"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="info">Atividade</StatusPill>
            <StatusPill tone={id ? 'warning' : 'success'}>
              {id ? 'Edição' : 'Novo cadastro'}
            </StatusPill>
          </div>
        }
      />
      <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/22 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
          Cadastro guiado
        </p>
        <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
          Estruture a atividade com vínculo empresarial e descrição objetiva para uso em APR, DID e relatórios.
        </p>
        <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
          Revise empresa e nome da atividade antes de salvar para evitar duplicidade operacional.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="space-y-5 rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
        {submitError && (
          <div
            role="alert"
            className="rounded-lg border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] px-4 py-3 text-sm text-[var(--ds-color-danger)]"
          >
            <p className="font-semibold">Não foi possível salvar a atividade</p>
            <p className="mt-1 text-[color:var(--ds-color-danger)]/90">{submitError}</p>
          </div>
        )}
        <section className={sectionCardClassName}>
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
              Contexto e identificação
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              Defina tenant, nome e descrição base para reaproveitar a atividade em diferentes fluxos do sistema.
            </p>
          </div>
        <div className="space-y-4">
          <div>
            <label htmlFor="company_id" className={labelClassName}>Empresa</label>
            <select
              id="company_id"
              {...register('company_id')}
              className={`${fieldClassName} ${
                errors.company_id ? errorFieldClassName : ''
              }`}
              aria-invalid={errors.company_id ? 'true' : undefined}
            >
              <option value="">Selecione uma empresa</option>
              {companies.map(company => (
                <option key={company.id} value={company.id}>{company.razao_social}</option>
              ))}
            </select>
            {errors.company_id ? (
              <p className={errorClassName}>{errors.company_id.message}</p>
            ) : (
              <p className={helperClassName}>A empresa define o tenant da biblioteca de atividades.</p>
            )}
          </div>

          <div>
            <label htmlFor="nome" className={labelClassName}>Nome da Atividade</label>
            <input
              id="nome"
              type="text"
              {...register('nome')}
              className={`${fieldClassName} ${
                errors.nome ? errorFieldClassName : ''
              }`}
              aria-invalid={errors.nome ? 'true' : undefined}
              placeholder="Ex: Trabalho em Altura"
            />
            {errors.nome ? (
              <p className={errorClassName}>{errors.nome.message}</p>
            ) : (
              <p className={helperClassName}>Use um nome claro e reutilizável para busca, APR e registros operacionais.</p>
            )}
          </div>

          <div>
            <label htmlFor="descricao" className={labelClassName}>Descrição</label>
            <textarea
              id="descricao"
              {...register('descricao')}
              rows={4}
              className={fieldClassName}
              placeholder="Descreva brevemente a atividade..."
            />
            <p className={helperClassName}>Use para objetivo, escopo ou observações que ajudem a contextualizar a atividade.</p>
          </div>
        </div>
        </section>

        <div className="flex justify-end space-x-3 border-t pt-6">
          <Link
            href="/dashboard/activities"
            className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] px-4 py-2 text-sm font-medium text-[var(--ds-color-text-secondary)] hover:bg-[var(--ds-color-surface-muted)]"
          >
            Cancelar
          </Link>
          <button
            type="submit"
            disabled={loading || isSubmitting || !isValid}
            className="flex items-center rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-medium text-[var(--ds-color-action-primary-foreground)] hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50"
          >
            {loading ? (
              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-[var(--ds-color-action-primary-foreground)] border-t-transparent"></div>
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {id ? 'Salvar alterações' : 'Criar atividade'}
          </button>
        </div>
      </form>
    </div>
  );
}
