'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { episService } from '@/services/episService';
import { useForm } from 'react-hook-form';
import type { FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { ArrowLeft, Save } from 'lucide-react';
import Link from 'next/link';

import { toast } from 'sonner';
import { getFormErrorMessage } from '@/lib/error-handler';
import { logger } from '@/lib/logger';
import { toInputDateValue } from '@/lib/date/safeFormat';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout';
import { InlineLoadingState } from '@/components/ui/state';
import { StatusPill } from '@/components/ui/status-pill';

const epiSchema = z.object({
  nome: z.string().min(3, 'O nome deve ter pelo menos 3 caracteres'),
  ca: z.string().optional(),
  validade_ca: z.string().optional(),
  descricao: z.string().optional(),
  company_id: z.string().min(1, 'Selecione uma empresa'),
});

type EpiFormData = z.infer<typeof epiSchema>;

interface EpiFormProps {
  id?: string;
}

import { companiesService, Company } from '@/services/companiesService';

const fieldClassName =
  'mt-1 block w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] focus:border-[var(--ds-color-action-primary)] focus:outline-none';
const errorFieldClassName = 'border-[var(--ds-color-danger)] focus:border-[var(--ds-color-danger)]';
const labelClassName = 'block text-sm font-medium text-[var(--ds-color-text-secondary)]';
const helperClassName = 'mt-1 text-xs text-[var(--ds-color-text-muted)]';
const errorClassName = 'mt-1 text-xs text-[var(--ds-color-danger)]';
const sectionHeaderClassName = 'space-y-1';
const sectionEyebrowClassName =
  'text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-muted)]';
const sectionDescriptionClassName = 'text-sm text-[var(--ds-color-text-secondary)]';

export function EpiForm({ id }: EpiFormProps) {
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
  } = useForm<EpiFormData>({
    resolver: zodResolver(epiSchema),
    mode: 'onBlur',
    reValidateMode: 'onBlur',
    defaultValues: {
      nome: '',
      ca: '',
      validade_ca: '',
      descricao: '',
      company_id: '',
    },
  });

  useEffect(() => {
    async function loadData() {
      try {
        const companiesData = await companiesService.findAll();
        setCompanies(companiesData);

        if (id) {
          const data = await episService.findOne(id);
          reset({
            nome: data.nome,
            ca: data.ca || '',
            validade_ca: toInputDateValue(data.validade_ca),
            descricao: data.descricao || '',
            company_id: data.company_id,
          });
        }
      } catch (error) {
        logger.error('Erro ao carregar dados:', error);
        toast.error('Erro ao carregar dados para o formulário.');
      } finally {
        setFetching(false);
      }
    }

    loadData();
  }, [id, reset]);

  async function onSubmit(data: EpiFormData) {
    try {
      setLoading(true);
      setSubmitError(null);
      if (id) {
        await episService.update(id, data);
        toast.success('EPI atualizado com sucesso!');
      } else {
        await episService.create(data);
        toast.success('EPI cadastrado com sucesso!');
      }
      router.push('/dashboard/epis');
      router.refresh();
    } catch (error) {
      logger.error('Erro ao salvar EPI:', error);
      const errorMessage = getFormErrorMessage(error, {
        badRequest: 'Dados inválidos. Revise os campos obrigatórios.',
        unauthorized: 'Sessão expirada. Faça login novamente.',
        forbidden: 'Você não tem permissão para salvar EPIs.',
        server: 'Erro interno do servidor ao salvar EPI.',
        fallback: 'Erro ao salvar EPI. Tente novamente.',
      });
      setSubmitError(errorMessage);
      toast.error('Erro ao salvar EPI. Verifique os dados e tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  const onInvalid = (formErrors: FieldErrors<EpiFormData>) => {
    if (formErrors.company_id) {
      setFocus('company_id');
    } else if (formErrors.nome) {
      setFocus('nome');
    }
    toast.error('Revise os campos obrigatórios antes de salvar.');
  };

  return (
    <div className="ds-form-page mx-auto max-w-4xl space-y-6">
      {fetching ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
          <InlineLoadingState
            label={id ? 'Carregando EPI' : 'Preparando EPI'}
          />
        </div>
      ) : null}

      <PageHeader
        eyebrow="Cadastro de EPIs"
        title={id ? 'Editar EPI' : 'Novo EPI'}
        description="Defina vínculo com empresa, identificação regulatória e informações de uso do equipamento."
        icon={
          <Link
            href="/dashboard/epis"
            className="rounded-full p-2 text-[var(--ds-color-text-muted)] transition-colors hover:bg-[var(--ds-color-primary-subtle)] hover:text-[var(--ds-color-text-primary)]"
            title="Voltar"
            aria-label="Voltar para a lista de EPIs"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="info">EPI</StatusPill>
            <StatusPill tone={id ? 'warning' : 'success'}>
              {id ? 'Edição' : 'Novo cadastro'}
            </StatusPill>
          </div>
        }
      />
      <form
        onSubmit={handleSubmit(onSubmit, onInvalid)}
        className="space-y-5 rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]"
      >
        {submitError && (
          <div
            role="alert"
            className="rounded-lg border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] px-4 py-3 text-sm text-[var(--ds-color-danger)]"
          >
            <p className="font-semibold">Não foi possível salvar o EPI</p>
            <p className="mt-1 text-[color:var(--ds-color-danger)]/90">{submitError}</p>
          </div>
        )}
        <section>
          <div className={sectionHeaderClassName}>
            <p className={sectionEyebrowClassName}>
              Contexto e identificação
            </p>
            <p className={sectionDescriptionClassName}>
              Defina o tenant do EPI e o nome principal usado em entregas, inspeções e controle de estoque.
            </p>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <label htmlFor="company_id" className={labelClassName}>Empresa</label>
              <select
                id="company_id"
                {...register('company_id')}
                className={cn(fieldClassName, errors.company_id && errorFieldClassName)}
                aria-invalid={errors.company_id ? 'true' : undefined}
              >
                <option value="">Selecione uma empresa</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>{company.razao_social}</option>
                ))}
              </select>
              {errors.company_id ? (
                <p className={errorClassName}>{errors.company_id.message}</p>
              ) : (
                <p className={helperClassName}>A empresa controla o escopo de distribuição e rastreabilidade do EPI.</p>
              )}
            </div>

            <div className="space-y-2 md:col-span-2">
              <label htmlFor="nome" className={labelClassName}>Nome do EPI</label>
              <input
                id="nome"
                type="text"
                {...register('nome')}
                className={cn(fieldClassName, errors.nome && errorFieldClassName)}
                aria-invalid={errors.nome ? 'true' : undefined}
                placeholder="Ex: Capacete de Segurança"
              />
              {errors.nome ? (
                <p className={errorClassName}>{errors.nome.message}</p>
              ) : (
                <p className={helperClassName}>Use uma nomenclatura objetiva para facilitar busca e distribuição em campo.</p>
              )}
            </div>
          </div>
        </section>

        <section>
          <div className={sectionHeaderClassName}>
            <p className={sectionEyebrowClassName}>
              Conformidade e detalhes
            </p>
            <p className={sectionDescriptionClassName}>
              Registre certificação, validade e observações relevantes para uso e auditoria.
            </p>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="ca" className={labelClassName}>Certificado de Aprovação (C.A.)</label>
              <input
                id="ca"
                type="text"
                {...register('ca')}
                className={fieldClassName}
                placeholder="Ex: 12345"
              />
              <p className={helperClassName}>Opcional, mas recomendado para evidência regulatória e auditoria.</p>
            </div>

            <div className="space-y-2">
              <label htmlFor="validade_ca" className={labelClassName}>Validade do C.A.</label>
              <input
                id="validade_ca"
                type="date"
                {...register('validade_ca')}
                className={fieldClassName}
              />
              <p className={helperClassName}>Opcional. Preencha quando a validade do certificado impactar entrega e conformidade.</p>
            </div>

            <div className="space-y-2 md:col-span-2">
              <label htmlFor="descricao" className={labelClassName}>Descrição</label>
              <textarea
                id="descricao"
                {...register('descricao')}
                rows={5}
                className={fieldClassName}
                placeholder="Descreva brevemente o EPI..."
              />
              <p className={helperClassName}>Use este campo para material, aplicação, restrições ou observações de uso.</p>
            </div>
          </div>
        </section>

        <div className="flex flex-col-reverse gap-3 border-t border-[var(--ds-color-border-subtle)] pt-6 md:flex-row md:justify-end">
          <Link
            href="/dashboard/epis"
            className="inline-flex items-center justify-center rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] px-4 py-2.5 text-sm font-semibold text-[var(--ds-color-text-secondary)] hover:bg-[var(--ds-color-surface-muted)]"
          >
            Cancelar
          </Link>
          <button
            type="submit"
            disabled={loading || isSubmitting || !isValid}
            className="inline-flex items-center justify-center rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--ds-color-action-primary-foreground)] hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50"
          >
            <Save className="mr-2 h-4 w-4" />
            {id ? 'Salvar alterações' : 'Criar EPI'}
          </button>
        </div>
      </form>
    </div>
  );
}
