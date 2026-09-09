'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { companiesService } from '@/services/companiesService';
import { useForm } from 'react-hook-form';
import type { FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { ArrowLeft, Save, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { getFormErrorMessage } from '@/lib/error-handler';
import { logger } from '@/lib/logger';
import { isValidCnpj, formatCnpj } from '@/lib/cnpj';
import { PageHeader } from '@/components/layout';
import { ErrorState, InlineLoadingState } from '@/components/ui/state';
import { StatusPill } from '@/components/ui/status-pill';
import { useAuth } from '@/context/AuthContext';
import { Permission } from '@/lib/permissions';
import { canManageCompanies as hasCompanyMutationRole } from '@/lib/role-access';

const fieldClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] transition-all duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-action-primary)] focus:outline-none focus:shadow-[var(--ds-shadow-sm)]';
const errorFieldClassName = 'border-[var(--ds-color-danger)] focus:border-[var(--ds-color-danger)]';
const labelClassName = 'text-sm font-medium text-[var(--ds-color-text-secondary)]';
const helperClassName = 'text-xs text-[var(--ds-color-text-muted)]';
const errorClassName = 'text-xs text-[var(--ds-color-danger)]';
const sectionCardClassName =
  'rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-5 shadow-[var(--ds-shadow-xs)]';

const companySchema = z.object({
  razao_social: z.string().min(3, 'A razão social deve ter pelo menos 3 caracteres'),
  cnpj: z
    .string()
    .min(14, 'CNPJ inválido')
    .refine((v) => isValidCnpj(v), 'CNPJ inválido (dígitos verificadores incorretos)'),
  endereco: z.string().min(5, 'O endereço deve ter pelo menos 5 caracteres'),
  responsavel: z.string().min(3, 'O responsável deve ter pelo menos 3 caracteres'),
  email_contato: z.union([z.string().trim().email('E-mail inválido'), z.literal('')]),
  status: z.boolean(),
});

type CompanyFormData = z.infer<typeof companySchema>;

interface CompanyFormProps {
  id?: string;
}

export function CompanyForm({ id }: CompanyFormProps) {
  const router = useRouter();
  const { hasPermission, roles } = useAuth();
  const canManageCompany =
    hasPermission(Permission.CAN_MANAGE_COMPANIES) && hasCompanyMutationRole(roles);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(!!id);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [logoChanged, setLogoChanged] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors, isValid, isSubmitting },
  } = useForm<CompanyFormData>({
    resolver: zodResolver(companySchema),
    mode: 'onBlur',
    reValidateMode: 'onBlur',
    defaultValues: {
      razao_social: '',
      cnpj: '',
      endereco: '',
      responsavel: '',
      email_contato: '',
      status: true,
    },
  });

  useEffect(() => {
    if (!canManageCompany) {
      setFetching(false);
      return;
    }

    async function loadCompany() {
      try {
        const data = await companiesService.findOne(id!);
        reset({
          razao_social: data.razao_social,
          cnpj: data.cnpj,
          endereco: data.endereco,
          responsavel: data.responsavel,
          email_contato: data.email_contato || '',
          status: data.status,
        });
        if (data.logo_url) {
          setLogoPreview(data.logo_url);
        }
      } catch (error) {
        logger.error('Erro ao carregar empresa:', error);
        toast.error('Erro ao carregar dados da empresa.');
        router.push('/dashboard/companies');
      } finally {
        setFetching(false);
      }
    }

    if (id) {
      loadCompany();
    }
  }, [canManageCompany, id, reset, router]);

  function handleLogoFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Formato não suportado. Use PNG, JPEG ou WebP.');
      e.target.value = '';
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Logo muito grande. O limite é 2 MB.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setLogoPreview(dataUrl);
      setLogoDataUrl(dataUrl);
      setLogoChanged(true);
    };
    reader.readAsDataURL(file);
  }

  function handleLogoRemove() {
    setLogoPreview(null);
    setLogoDataUrl(null);
    setLogoChanged(true);
    if (logoInputRef.current) {
      logoInputRef.current.value = '';
    }
  }

  async function onSubmit(data: CompanyFormData) {
    try {
      setLoading(true);
      setSubmitError(null);
      const payload = {
        ...data,
        ...(logoChanged ? { logo_url: logoDataUrl } : {}),
      };
      if (id) {
        await companiesService.update(id, payload);
        toast.success('Empresa atualizada com sucesso!');
      } else {
        await companiesService.create(payload);
        toast.success('Empresa cadastrada com sucesso!');
      }
      router.push('/dashboard/companies');
      router.refresh();
    } catch (error) {
      logger.error('Erro ao salvar empresa:', error);
      const errorMessage = getFormErrorMessage(error, {
        badRequest: 'Dados inválidos. Revise os campos obrigatórios.',
        unauthorized: 'Sessão expirada. Faça login novamente.',
        forbidden: 'Você não tem permissão para salvar empresas.',
        server: 'Erro interno do servidor ao salvar empresa.',
        fallback: 'Erro ao salvar empresa. Tente novamente.',
      });
      setSubmitError(errorMessage);
      toast.error('Erro ao salvar empresa. Verifique os dados e tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  const onInvalid = (formErrors: FieldErrors<CompanyFormData>) => {
    if (formErrors.razao_social) {
      setFocus('razao_social');
    } else if (formErrors.cnpj) {
      setFocus('cnpj');
    } else if (formErrors.endereco) {
      setFocus('endereco');
    } else if (formErrors.responsavel) {
      setFocus('responsavel');
    } else if (formErrors.email_contato) {
      setFocus('email_contato');
    }
    toast.error('Revise os campos obrigatórios antes de salvar.');
  };

  if (!canManageCompany) {
    return (
      <ErrorState
        title="Sem permissão para gerenciar empresas"
        description="Sua função pode consultar a empresa, mas alterações exigem o perfil de administrador da plataforma."
        action={
          <Link
            href="/dashboard/companies"
            className="inline-flex min-h-11 items-center rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-semibold text-white"
          >
            Voltar para empresas
          </Link>
        }
      />
    );
  }

  return (
    <div className="ds-form-page mx-auto max-w-2xl space-y-6">
      {fetching ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
          <InlineLoadingState label={id ? 'Carregando empresa' : 'Preparando empresa'} />
        </div>
      ) : null}

      <PageHeader
        eyebrow="Cadastro de empresas"
        title={id ? 'Editar empresa' : 'Nova empresa'}
        description="Defina dados institucionais, contato principal e estado operacional do tenant."
        icon={
          <Link
            href="/dashboard/companies"
            className="rounded-full p-2 text-[var(--ds-color-text-muted)] transition-colors hover:bg-[var(--ds-color-primary-subtle)] hover:text-[var(--ds-color-text-primary)]"
            title="Voltar"
            aria-label="Voltar para a lista de empresas"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="primary">Empresa</StatusPill>
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
          Estruture a empresa com dados institucionais, contato principal e estado operacional.
        </p>
        <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
          Revise razão social, CNPJ e contato institucional antes de salvar para evitar retrabalho
          administrativo.
        </p>
      </div>

      <form
        onSubmit={handleSubmit(onSubmit, onInvalid)}
        className="space-y-5 rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]"
      >
        {submitError && (
          <div
            role="alert"
            className="rounded-lg border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] px-4 py-3 text-sm text-[var(--ds-color-danger)]"
          >
            <p className="font-semibold">Não foi possível salvar a empresa</p>
            <p className="mt-1 text-[color:var(--ds-color-danger)]/90">{submitError}</p>
          </div>
        )}
        <section className={sectionCardClassName}>
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
              Dados institucionais
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              Identifique formalmente a empresa com os dados usados em cadastros, vínculos e
              governança.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="razao_social" className={labelClassName}>
                Razão Social
              </label>
              <input
                id="razao_social"
                type="text"
                {...register('razao_social')}
                className={`${fieldClassName} ${errors.razao_social ? errorFieldClassName : ''}`}
                aria-invalid={errors.razao_social ? 'true' : undefined}
                placeholder="Ex: Empresa de Engenharia LTDA"
              />
              {errors.razao_social ? (
                <p className={errorClassName}>{errors.razao_social.message}</p>
              ) : (
                <p className={helperClassName}>
                  Use a razão social oficial para manter consistência legal e contratual.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="cnpj" className={labelClassName}>
                CNPJ
              </label>
              <input
                id="cnpj"
                type="text"
                {...register('cnpj', {
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                    e.target.value = formatCnpj(e.target.value);
                  },
                })}
                className={`${fieldClassName} ${errors.cnpj ? errorFieldClassName : ''}`}
                aria-invalid={errors.cnpj ? 'true' : undefined}
                placeholder="00.000.000/0000-00"
                maxLength={18}
              />
              {errors.cnpj ? (
                <p className={errorClassName}>{errors.cnpj.message}</p>
              ) : (
                <p className={helperClassName}>
                  Informe um CNPJ válido para evitar inconsistência de tenant e relatórios.
                </p>
              )}
            </div>
          </div>
        </section>

        <section className={sectionCardClassName}>
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
              Identidade visual
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              A logo aparece nos PDFs emitidos pelo sistema (APRs, DDS, relatórios, checklists).
            </p>
          </div>
          <div className="flex items-start gap-5">
            {logoPreview ? (
              <div className="relative flex-shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoPreview}
                  alt="Logo da empresa"
                  className="h-20 w-32 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] object-contain p-1"
                />
                <button
                  type="button"
                  onClick={handleLogoRemove}
                  title="Remover logo"
                  className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--ds-color-danger)] text-white shadow-sm hover:opacity-90"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <div className="flex h-20 w-32 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-md)] border border-dashed border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]">
                <span className="text-xs text-[var(--ds-color-text-muted)]">Sem logo</span>
              </div>
            )}
            <div className="flex-1 space-y-2">
              <label htmlFor="logo_upload" className={labelClassName}>
                Logo da empresa
              </label>
              <label
                htmlFor="logo_upload"
                className="flex cursor-pointer items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm text-[var(--ds-color-text-secondary)] transition-colors hover:bg-[var(--ds-color-surface-muted)]"
              >
                <Upload className="h-4 w-4 flex-shrink-0" />
                {logoPreview ? 'Trocar logo' : 'Selecionar arquivo'}
              </label>
              <input
                id="logo_upload"
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                onChange={handleLogoFileChange}
              />
              <p className={helperClassName}>PNG, JPEG ou WebP · Máximo 2 MB</p>
            </div>
          </div>
        </section>

        <section className={sectionCardClassName}>
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
              Contato e operação
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              Dados usados para comunicação institucional e ativação operacional da empresa no
              sistema.
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
                className={`${fieldClassName} ${errors.endereco ? errorFieldClassName : ''}`}
                placeholder="Rua, Número, Bairro, Cidade - UF"
              />
              {errors.endereco ? (
                <p className={errorClassName}>{errors.endereco.message}</p>
              ) : (
                <p className={helperClassName}>
                  Endereço base usado como referência administrativa e operacional.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="responsavel" className={labelClassName}>
                Responsável
              </label>
              <input
                id="responsavel"
                type="text"
                {...register('responsavel')}
                className={`${fieldClassName} ${errors.responsavel ? errorFieldClassName : ''}`}
                placeholder="Nome do responsável"
              />
              {errors.responsavel ? (
                <p className={errorClassName}>{errors.responsavel.message}</p>
              ) : (
                <p className={helperClassName}>
                  Pessoa de referência institucional para gestão e validações.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="email_contato" className={labelClassName}>
                E-mail institucional
              </label>
              <input
                id="email_contato"
                type="email"
                {...register('email_contato')}
                className={`${fieldClassName} ${errors.email_contato ? errorFieldClassName : ''}`}
                aria-invalid={errors.email_contato ? 'true' : undefined}
                placeholder="contato@empresa.com.br"
              />
              <p className={helperClassName}>
                Usado como fallback dos alertas automáticos quando a lista de destinatários estiver
                vazia.
              </p>
              {errors.email_contato && (
                <p className={errorClassName}>{errors.email_contato.message}</p>
              )}
            </div>

            <div className="md:col-span-2">
              <div className="flex items-center space-x-3 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/22 px-4 py-3">
                <input
                  id="status"
                  type="checkbox"
                  {...register('status')}
                  className="h-4 w-4 rounded border-[var(--ds-color-border-default)] accent-[var(--ds-color-action-primary)]"
                />
                <div>
                  <label htmlFor="status" className={labelClassName}>
                    Empresa ativa
                  </label>
                  <p className={helperClassName}>
                    Desative apenas quando o tenant não puder mais receber novos vínculos
                    operacionais.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="flex justify-end space-x-4 border-t pt-6">
          <Link
            href="/dashboard/companies"
            className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] px-4 py-2 text-sm font-medium text-[var(--ds-color-text-secondary)] hover:bg-[var(--ds-color-surface-muted)]"
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
            {id ? 'Salvar alterações' : 'Criar empresa'}
          </button>
        </div>
      </form>
    </div>
  );
}
