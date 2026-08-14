'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toolsService } from '@/services/toolsService';
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
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout';
import { InlineLoadingState } from '@/components/ui/state';
import { StatusPill } from '@/components/ui/status-pill';

const fieldClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] focus:border-[var(--ds-color-action-primary)] focus:outline-none focus:shadow-[var(--ds-shadow-sm)]';
const errorFieldClassName = 'border-[var(--ds-color-danger)] focus:border-[var(--ds-color-danger)]';
const labelClassName = 'text-sm font-medium text-[var(--ds-color-text-secondary)]';
const helperClassName = 'text-xs text-[var(--ds-color-text-muted)]';
const errorClassName = 'text-xs text-[var(--ds-color-danger)]';

const toolSchema = z.object({
  nome: z.string().min(3, 'O nome deve ter pelo menos 3 caracteres'),
  descricao: z.string().optional(),
  numero_serie: z.string().optional(),
  company_id: z.string().min(1, 'Selecione uma empresa'),
});

type ToolFormData = z.infer<typeof toolSchema>;

interface ToolFormProps {
  id?: string;
}

export function ToolForm({ id }: ToolFormProps) {
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
  } = useForm<ToolFormData>({
    resolver: zodResolver(toolSchema),
    mode: 'onBlur',
    reValidateMode: 'onBlur',
    defaultValues: {
      nome: '',
      descricao: '',
      numero_serie: '',
      company_id: '',
    },
  });

  useEffect(() => {
    async function loadData() {
      try {
        const companiesData = await companiesService.findAll();
        setCompanies(companiesData);

        if (id) {
          const toolData = await toolsService.findOne(id);
          reset({
            nome: toolData.nome,
            descricao: toolData.descricao || '',
            numero_serie: toolData.numero_serie || '',
            company_id: toolData.company_id,
          });
        }
      } catch (error) {
        logger.error('Erro ao carregar dados:', error);
        toast.error('Erro ao carregar dados para o formulário.');
        router.push('/dashboard/tools');
      } finally {
        setFetching(false);
      }
    }

    loadData();
  }, [id, reset, router]);

  async function onSubmit(data: ToolFormData) {
    try {
      setLoading(true);
      setSubmitError(null);
      if (id) {
        await toolsService.update(id, data);
        toast.success('Ferramenta atualizada com sucesso!');
      } else {
        await toolsService.create(data);
        toast.success('Ferramenta cadastrada com sucesso!');
      }
      router.push('/dashboard/tools');
      router.refresh();
    } catch (error) {
      logger.error('Erro ao salvar ferramenta:', error);
      const errorMessage = getFormErrorMessage(error, {
        badRequest: 'Dados inválidos. Revise os campos obrigatórios.',
        unauthorized: 'Sessão expirada. Faça login novamente.',
        forbidden: 'Você não tem permissão para salvar ferramentas.',
        server: 'Erro interno do servidor ao salvar ferramenta.',
        fallback: 'Erro ao salvar ferramenta. Tente novamente.',
      });
      setSubmitError(errorMessage);
      toast.error('Erro ao salvar ferramenta. Verifique os dados e tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  const onInvalid = (formErrors: FieldErrors<ToolFormData>) => {
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
            label={id ? 'Carregando ferramenta' : 'Preparando ferramenta'}
          />
        </div>
      ) : null}

      <PageHeader
        eyebrow="Cadastro de ferramentas"
        title={id ? 'Editar ferramenta' : 'Nova ferramenta'}
        description="Defina vínculo empresarial, identificação do ativo e informações de rastreabilidade."
        icon={
          <Link
            href="/dashboard/tools"
            className="rounded-full p-2 text-[var(--ds-color-text-muted)] transition-colors hover:bg-[var(--ds-color-primary-subtle)] hover:text-[var(--ds-color-text-primary)]"
            title="Voltar"
            aria-label="Voltar para a lista de ferramentas"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="info">Ferramenta</StatusPill>
            <StatusPill tone={id ? 'warning' : 'success'}>
              {id ? 'Edição' : 'Novo cadastro'}
            </StatusPill>
          </div>
        }
      />
      <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="space-y-5 rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
        {submitError && (
          <div
            role="alert"
            className="rounded-lg border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] px-4 py-3 text-sm text-[var(--ds-color-danger)]"
          >
            <p className="font-semibold">Não foi possível salvar a ferramenta</p>
            <p className="mt-1 text-[color:var(--ds-color-danger)]/90">{submitError}</p>
          </div>
        )}
        <section>
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
              Contexto e identificação
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              Defina tenant e nome principal da ferramenta para cadastro, verificação e controle de uso.
            </p>
          </div>
        <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <label htmlFor="company_id" className={labelClassName}>
              Empresa
            </label>
            <select
              id="company_id"
              {...register('company_id')}
              className={cn(fieldClassName, errors.company_id && errorFieldClassName)}
              aria-invalid={errors.company_id ? 'true' : undefined}
            >
              <option value="">Selecione uma empresa</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.razao_social}
                </option>
              ))}
            </select>
            {errors.company_id ? (
              <p className={errorClassName}>{errors.company_id.message}</p>
            ) : (
              <p className={helperClassName}>A empresa define o escopo operacional e de inventário da ferramenta.</p>
            )}
          </div>

          <div className="space-y-2 md:col-span-2">
            <label htmlFor="nome" className={labelClassName}>
              Nome da Ferramenta
            </label>
            <input
              id="nome"
              type="text"
              {...register('nome')}
              className={cn(fieldClassName, errors.nome && errorFieldClassName)}
              aria-invalid={errors.nome ? 'true' : undefined}
              placeholder="Ex: Furadeira Bosch"
            />
            {errors.nome ? (
              <p className={errorClassName}>{errors.nome.message}</p>
            ) : (
              <p className={helperClassName}>Use um nome simples e rastreável para facilitar inventário e alocação.</p>
            )}
          </div>
        </div>
        </section>

        <section>
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
              Rastreabilidade
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              Dados complementares para identificar a ferramenta em estoque, inspeções e manutenções.
            </p>
          </div>
        <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="numero_serie" className={labelClassName}>
              Número de Série
            </label>
            <input
              id="numero_serie"
              type="text"
              {...register('numero_serie')}
              className={fieldClassName}
              placeholder="Ex: SN123456"
            />
            <p className={helperClassName}>Opcional. Pode ser número de série, patrimônio ou identificador interno.</p>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label htmlFor="descricao" className={labelClassName}>
              Descrição
            </label>
            <textarea
              id="descricao"
              rows={3}
              {...register('descricao')}
              className={fieldClassName}
              placeholder="Opcional"
            />
            <p className={helperClassName}>Use para modelo, finalidade, restrições ou observações relevantes de uso.</p>
          </div>
        </div>
        </section>

        <div className="flex justify-end space-x-4 border-t pt-6">
          <Link
            href="/dashboard/tools"
            className="rounded-lg border border-[var(--ds-color-border-default)] px-4 py-2 text-sm font-medium text-[var(--ds-color-text-secondary)] hover:bg-[var(--ds-color-surface-muted)]"
          >
            Cancelar
          </Link>
          <button
            type="submit"
            disabled={loading || isSubmitting || !isValid}
            className="flex items-center rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-medium text-[var(--ds-color-action-primary-foreground)] transition-colors hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50"
          >
            <Save className="mr-2 h-4 w-4" />
            {id ? 'Salvar alterações' : 'Criar ferramenta'}
          </button>
        </div>
      </form>
    </div>
  );
}
