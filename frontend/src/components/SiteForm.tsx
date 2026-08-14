'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { sitesService } from '@/services/sitesService';
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
import { useAuth } from '@/context/AuthContext';

const fieldClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] transition-all duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-action-primary)] focus:outline-none focus:shadow-[var(--ds-shadow-sm)]';
const errorFieldClassName =
  'border-[var(--ds-color-danger)] focus:border-[var(--ds-color-danger)]';
const labelClassName =
  'text-sm font-medium text-[var(--ds-color-text-secondary)]';
const helperClassName = 'text-xs text-[var(--ds-color-text-muted)]';
const errorClassName = 'text-xs text-[var(--ds-color-danger)]';
const sectionCardClassName =
  'rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-5 shadow-[var(--ds-shadow-xs)]';

const siteSchema = z.object({
  nome: z.string().min(3, 'O nome deve ter pelo menos 3 caracteres'),
  endereco: z.string().optional(),
  cidade: z.string().optional(),
  estado: z.string().optional(),
  company_id: z.string().min(1, 'Selecione uma empresa'),
});

type SiteFormData = z.infer<typeof siteSchema>;

interface SiteFormProps {
  id?: string;
}

export function SiteForm({ id }: SiteFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { user, isAdminGeral } = useAuth();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    setFocus,
    formState: { errors, isValid, isSubmitting },
  } = useForm<SiteFormData>({
    resolver: zodResolver(siteSchema),
    mode: 'onBlur',
    reValidateMode: 'onBlur',
    defaultValues: {
      nome: '',
      endereco: '',
      cidade: '',
      estado: '',
      company_id: '',
    },
  });

  useEffect(() => {
    async function loadData() {
      try {
        let companiesData: Company[] = [];
        if (isAdminGeral) {
          companiesData = await companiesService.findAll();
        } else if (user?.company_id) {
          // Non-admin-geral users can only view their own company
          // GET /companies requires ADMIN_GERAL; findOne uses can_view_companies
          const own = await companiesService.findOne(user.company_id);
          companiesData = [own];
        }
        setCompanies(companiesData);
        const sessionCompanyId = user?.company_id || companiesData[0]?.id || '';

        if (id) {
          const siteData = await sitesService.findOne(id);
          reset({
            nome: siteData.nome,
            endereco: siteData.endereco || '',
            cidade: siteData.cidade || '',
            estado: siteData.estado || '',
            company_id: siteData.company_id,
          });
        } else if (!isAdminGeral && sessionCompanyId) {
          setValue('company_id', sessionCompanyId, {
            shouldDirty: false,
            shouldValidate: true,
          });
        }
      } catch (error) {
        logger.error('Erro ao carregar dados:', error);
        toast.error('Erro ao carregar dados para o formulário.');
        router.push('/dashboard/sites');
      } finally {
        setFetching(false);
      }
    }

    loadData();
  }, [id, isAdminGeral, reset, router, setValue, user?.company_id]);

  async function onSubmit(data: SiteFormData) {
    try {
      setLoading(true);
      setSubmitError(null);
      const { company_id, ...siteData } = data;
      if (id) {
        await sitesService.update(id, siteData, company_id || undefined);
        toast.success('Obra/Setor atualizado com sucesso!');
      } else {
        await sitesService.create(siteData, company_id || undefined);
        toast.success('Obra/Setor cadastrado com sucesso!');
      }
      router.push('/dashboard/sites');
      router.refresh();
    } catch (error) {
      logger.error('Erro ao salvar obra/setor:', error);
      const errorMessage = getFormErrorMessage(error, {
        badRequest: 'Dados inválidos. Revise os campos obrigatórios.',
        unauthorized: 'Sessão expirada. Faça login novamente.',
        forbidden: 'Você não tem permissão para salvar obras/setores.',
        server: 'Erro interno do servidor ao salvar obra/setor.',
        fallback: 'Erro ao salvar obra/setor. Tente novamente.',
      });
      setSubmitError(errorMessage);
      toast.error(
        'Erro ao salvar obra/setor. Verifique os dados e tente novamente.',
      );
    } finally {
      setLoading(false);
    }
  }

  const onInvalid = (formErrors: FieldErrors<SiteFormData>) => {
    if (formErrors.company_id && isAdminGeral) {
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
            label={id ? 'Carregando obra/setor' : 'Preparando obra/setor'}
          />
        </div>
      ) : null}

      <PageHeader
        eyebrow="Cadastro de obras e setores"
        title={id ? 'Editar obra/setor' : 'Nova obra/setor'}
        description="Defina empresa, identificação operacional e localização da frente em um fluxo curto."
        icon={
          <Link
            href="/dashboard/sites"
            className="rounded-full p-2 text-[var(--ds-color-text-muted)] transition-colors hover:bg-[var(--ds-color-primary-subtle)] hover:text-[var(--ds-color-text-primary)]"
            title="Voltar"
            aria-label="Voltar para a lista de obras/setores"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="info">Obra/setor</StatusPill>
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
          Estruture a obra ou setor com vínculo claro à empresa e localização
          operacional.
        </p>
        <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
          Revise empresa, nome da frente e localização antes de salvar para
          evitar cadastros duplicados.
        </p>
      </div>

      <form
        onSubmit={handleSubmit(onSubmit, onInvalid)}
        className="space-y-5 rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]"
      >
        {!isAdminGeral ? (
          <input type="hidden" {...register('company_id')} />
        ) : null}
        {submitError && (
          <div
            role="alert"
            className="rounded-lg border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] px-4 py-3 text-sm text-[var(--ds-color-danger)]"
          >
            <p className="font-semibold">
              Não foi possível salvar a obra/setor
            </p>
            <p className="mt-1 text-[color:var(--ds-color-danger)]/90">
              {submitError}
            </p>
          </div>
        )}
        <section className={sectionCardClassName}>
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
              Contexto operacional
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              Defina o vínculo da obra ou setor com a empresa e identifique a
              frente de forma objetiva.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {isAdminGeral ? (
              <div className="space-y-2 md:col-span-2">
                <label htmlFor="company_id" className={labelClassName}>
                  Empresa
                </label>
                <select
                  id="company_id"
                  {...register('company_id')}
                  className={`${fieldClassName} ${
                    errors.company_id ? errorFieldClassName : ''
                  }`}
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
                  <p className={helperClassName}>
                    A empresa controla o escopo do cadastro e a vinculação
                    operacional.
                  </p>
                )}
              </div>
            ) : null}

            <div className="space-y-2 md:col-span-2">
              <label htmlFor="nome" className={labelClassName}>
                Nome da Obra/Setor
              </label>
              <input
                id="nome"
                type="text"
                {...register('nome')}
                className={`${fieldClassName} ${
                  errors.nome ? errorFieldClassName : ''
                }`}
                aria-invalid={errors.nome ? 'true' : undefined}
                placeholder="Ex: Obra Centro"
              />
              {errors.nome ? (
                <p className={errorClassName}>{errors.nome.message}</p>
              ) : (
                <p className={helperClassName}>
                  Use um nome curto e inequívoco para facilitar busca e
                  relatórios.
                </p>
              )}
            </div>
          </div>
        </section>

        <section className={sectionCardClassName}>
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
              Localização
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              Dados complementares para identificar fisicamente a frente
              cadastrada.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <label htmlFor="endereco" className={labelClassName}>
                Endereço
              </label>
              <input
                id="endereco"
                type="text"
                {...register('endereco')}
                className={fieldClassName}
                placeholder="Rua, Número, Bairro"
              />
              <p className={helperClassName}>
                Opcional. Ajuda a localizar a frente no mapa operacional e nos
                relatórios.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="cidade" className={labelClassName}>
                Cidade
              </label>
              <input
                id="cidade"
                type="text"
                {...register('cidade')}
                className={fieldClassName}
              />
              <p className={helperClassName}>
                Opcional. Use a cidade para facilitar filtros administrativos e
                agrupamentos.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="estado" className={labelClassName}>
                Estado (UF)
              </label>
              <input
                id="estado"
                type="text"
                maxLength={2}
                {...register('estado')}
                className={fieldClassName}
                placeholder="Ex: MG"
              />
              <p className={helperClassName}>
                Informe a UF com duas letras para manter o padrão dos
                relatórios.
              </p>
            </div>
          </div>
        </section>

        <div className="flex justify-end space-x-4 border-t pt-6">
          <Link
            href="/dashboard/sites"
            className="rounded-lg border border-[var(--ds-color-border-default)] px-4 py-2 text-sm font-medium text-[var(--ds-color-text-secondary)] hover:bg-[var(--ds-color-surface-muted)]"
          >
            Cancelar
          </Link>
          <button
            type="submit"
            disabled={loading || isSubmitting || !isValid}
            className="flex items-center rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-medium text-[var(--ds-color-action-primary-foreground)] transition-colors hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50"
          >
            {loading ? (
              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-[var(--ds-color-action-primary-foreground)] border-t-transparent"></div>
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {id ? 'Salvar alterações' : 'Criar obra/setor'}
          </button>
        </div>
      </form>
    </div>
  );
}
