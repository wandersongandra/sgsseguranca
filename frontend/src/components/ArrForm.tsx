'use client';

import dynamic from 'next/dynamic';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarDays,
  Mail,
  Printer,
  Save,
  ShieldAlert,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { MetricCard } from '@/components/ui/metric-card';
import { StatusPill } from '@/components/ui/status-pill';
import { InlineLoadingState } from '@/components/ui/state';
import { InlineCallout } from '@/components/ui/inline-callout';
import { useFormAutosave } from '@/hooks/useFormAutosave';
import {
  FormFieldGroup,
  FormGrid,
  FormPageLayout,
  FormSection,
} from '@/components/layout';
import { companiesService, type Company } from '@/services/companiesService';
import {
  ARR_PROBABILITY_LABEL,
  ARR_RISK_LEVEL_LABEL,
  ARR_SEVERITY_LABEL,
  ARR_STATUS_LABEL,
  arrsService,
  type Arr,
  type ArrMutationInput,
} from '@/services/arrsService';
import { sitesService, type Site } from '@/services/sitesService';
import { usersService, type User } from '@/services/usersService';
import { getFormErrorMessage } from '@/lib/error-handler';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { sessionStore } from '@/lib/sessionStore';
import { isUserVisibleForSite } from '@/lib/site-scoped-user-visibility';
import { usePermissions } from '@/hooks/usePermissions';
import { Permission } from '@/lib/permissions';
import { isAdminGeralAccount } from '@/lib/auth-session-state';
import { cn } from '@/lib/utils';
import { openPdfForPrint } from '@/lib/print-utils';

const SendMailModal = dynamic(
  () => import('@/components/SendMailModal').then((module) => module.SendMailModal),
  { ssr: false },
);

const arrSchema = z.object({
  titulo: z.string().min(5, 'Informe um título com pelo menos 5 caracteres.'),
  descricao: z.string().optional(),
  data: z.string().min(1, 'Informe a data da análise rápida.'),
  turno: z.string().optional(),
  frente_trabalho: z.string().optional(),
  atividade_principal: z
    .string()
    .min(5, 'Informe a atividade principal relacionada ao risco.'),
  condicao_observada: z
    .string()
    .min(10, 'Descreva a condição observada em campo.'),
  risco_identificado: z.string().min(10, 'Descreva o risco identificado.'),
  nivel_risco: z.enum(['baixo', 'medio', 'alto', 'critico']),
  probabilidade: z.enum(['baixa', 'media', 'alta']),
  severidade: z.enum(['leve', 'moderada', 'grave', 'critica']),
  controles_imediatos: z
    .string()
    .min(10, 'Descreva os controles imediatos definidos.'),
  acao_recomendada: z.string().optional(),
  epi_epc_aplicaveis: z.string().optional(),
  observacoes: z.string().optional(),
  company_id: z.string().min(1, 'Selecione uma empresa.'),
  site_id: z.string().min(1, 'Selecione um site.'),
  responsavel_id: z.string().min(1, 'Selecione o responsável.'),
  participants: z
    .array(z.string())
    .min(1, 'Selecione pelo menos um participante.'),
});

type ArrFormData = z.infer<typeof arrSchema>;

type ArrFormProps = {
  id?: string;
};

const inputClassName =
  'mt-1 block w-full rounded-[var(--ds-radius-md)] border border-[var(--component-field-border-subtle)] bg-[var(--component-field-bg)] px-3 py-2.5 text-sm text-[var(--component-field-text)] transition-colors duration-[var(--ds-motion-fast)] focus:border-[var(--component-field-border-focus)] focus:outline-none focus:shadow-[var(--component-field-shadow-focus)]';

const textareaClassName = `${inputClassName} min-h-[128px]`;
const labelClassName =
  'text-sm font-medium text-[var(--ds-color-text-secondary)]';
const helperClassName = 'mt-1 text-xs text-[var(--ds-color-text-muted)]';
const errorClassName = 'mt-1 text-xs text-[var(--ds-color-danger)]';

const TURNO_LABEL: Record<string, string> = {
  manha: 'Manhã',
  tarde: 'Tarde',
  noite: 'Noite',
  integral: 'Integral',
};

function getInitialCompanyId() {
  const selectedTenantCompanyId = selectedTenantStore.get()?.companyId || null;
  const sessionCompanyId = sessionStore.get()?.companyId || null;
  return selectedTenantCompanyId || sessionCompanyId || '';
}

function getLocalDateInputValue(date = new Date()) {
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offset * 60_000);
  return localDate.toISOString().slice(0, 10);
}

function getUserInitials(name?: string | null) {
  if (!name) {
    return '??';
  }

  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
}

export function ArrForm({ id }: ArrFormProps) {
  const router = useRouter();
  const { hasPermission } = usePermissions();
  const canManageArrs = hasPermission(Permission.CAN_MANAGE_ARRS);
  const [fetching, setFetching] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [currentArr, setCurrentArr] = useState<Arr | null>(null);
  const [isMailModalOpen, setIsMailModalOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<{
    name: string;
    filename: string;
    base64?: string;
    storedDocument?: {
      documentId: string;
      documentType: string;
    };
  } | null>(null);
  const isAdminGeral = isAdminGeralAccount(sessionStore.get());

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isValid, isSubmitting },
  } = useForm<ArrFormData>({
    resolver: zodResolver(arrSchema),
    mode: 'onBlur',
    defaultValues: {
      titulo: '',
      descricao: '',
      data: getLocalDateInputValue(),
      turno: '',
      frente_trabalho: '',
      atividade_principal: '',
      condicao_observada: '',
      risco_identificado: '',
      nivel_risco: 'medio',
      probabilidade: 'media',
      severidade: 'moderada',
      controles_imediatos: '',
      acao_recomendada: '',
      epi_epc_aplicaveis: '',
      observacoes: '',
      company_id: getInitialCompanyId(),
      site_id: '',
      responsavel_id: '',
      participants: [],
    },
  });

  const selectedCompanyId = watch('company_id');
  const selectedSiteId = watch('site_id');
  const selectedParticipantIds = watch('participants') || [];
  const selectedTurno = watch('turno');
  const selectedTitle = watch('titulo');
  const selectedMainActivity = watch('atividade_principal');

  const currentValues = watch();
  const { hasDraft, restoreDraft, discardDraft, clearDraft } =
    useFormAutosave<ArrFormData>({
      formId: id ? `edit-${id}` : 'new-arr',
      currentValues,
      onRestore: (draft) => {
        reset(draft);
      },
    });
  const selectedRiskLevel = watch('nivel_risco');
  const selectedProbability = watch('probabilidade');
  const selectedSeverity = watch('severidade');

  const filteredSites = useMemo(
    () => sites.filter((site) => site.company_id === selectedCompanyId),
    [selectedCompanyId, sites],
  );
  const filteredUsers = useMemo(
    () =>
      users.filter(
        (user) => isUserVisibleForSite(user, selectedCompanyId, selectedSiteId),
      ),
    [selectedCompanyId, selectedSiteId, users],
  );

  const isReadOnly =
    Boolean(currentArr?.pdf_file_key) || currentArr?.status === 'arquivada';
  const readOnlyMessage = currentArr?.pdf_file_key
    ? 'Esta ARR já possui PDF final governado e não aceita edição.'
    : currentArr?.status === 'arquivada'
      ? 'Esta ARR está arquivada e não aceita edição.'
      : null;
  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) || null,
    [companies, selectedCompanyId],
  );
  const selectedSite = useMemo(
    () => filteredSites.find((site) => site.id === selectedSiteId) || null,
    [filteredSites, selectedSiteId],
  );

  const buildArrFilename = (arr: Arr) =>
    `ARR_${String(arr.titulo || arr.id).replace(/\s+/g, '_')}.pdf`;

  const handlePrintArchivedPdf = async () => {
    if (!currentArr?.pdf_file_key) {
      toast.warning('Esta ARR não possui PDF final governado disponível para impressão.');
      return;
    }

    try {
      const access = await arrsService.getPdfAccess(currentArr.id);
      if (access.availability === 'ready' && access.url) {
        openPdfForPrint(access.url, () => {
          toast.info('Pop-up bloqueado. O PDF foi aberto na mesma aba.');
        });
        return;
      }

      if (access.message) {
        toast.warning(access.message);
      }
      toast.error(
        'A impressão foi bloqueada porque o PDF governado não está acessível. Gere ou recupere o documento oficial antes de tentar novamente.',
      );
    } catch (error) {
      toast.error(
        getFormErrorMessage(error, {
          fallback: 'Não foi possível preparar a impressão da ARR.',
        }),
      );
    }
  };

  const handleGenerateFinalPdf = async () => {
    if (!currentArr || !id || currentArr.pdf_file_key) {
      return;
    }

    setGeneratingPdf(true);
    try {
      const access = await arrsService.generateFinalPdf(currentArr.id);
      const refreshed = await arrsService.findOne(currentArr.id);
      setCurrentArr(refreshed);
      if (access.hasFinalPdf) {
        toast.success('PDF final governado emitido e registrado com sucesso.');
      } else {
        toast.warning(
          access.message || 'O PDF final ainda não está disponível para acesso.',
        );
      }
    } catch (error) {
      toast.error(
        getFormErrorMessage(error, {
          fallback: 'Não foi possível emitir o PDF final governado.',
        }),
      );
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleEmailArchivedPdf = async () => {
    if (!currentArr?.pdf_file_key) {
      toast.warning('Esta ARR não possui PDF final governado disponível para envio.');
      return;
    }

    try {
      const access = await arrsService.getPdfAccess(currentArr.id);
      if (!access.hasFinalPdf) {
        toast.warning(
          access.message ||
            'O PDF final governado desta ARR ainda não está disponível para envio.',
        );
        return;
      }

      if (access.availability !== 'ready' && access.message) {
        toast.warning(
          `${access.message} O envio oficial continuará usando o PDF final governado da ARR.`,
        );
      }

      setSelectedDoc({
        name: `ARR - ${currentArr.titulo}`,
        filename: access.originalName || buildArrFilename(currentArr),
        storedDocument: {
          documentId: currentArr.id,
          documentType: 'ARR',
        },
      });
      setIsMailModalOpen(true);
    } catch (error) {
      toast.error(
        getFormErrorMessage(error, {
          fallback: 'Não foi possível preparar o envio por e-mail da ARR.',
        }),
      );
    }
  };

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
        } catch {
          companiesData = [];
        }

        setCompanies(companiesData);

        if (!id) {
          const initialCompanyId = getInitialCompanyId();
          if (!initialCompanyId && companiesData.length === 1) {
            setValue('company_id', companiesData[0]!.id, {
              shouldValidate: true,
            });
          }
          return;
        }

        const arr = await arrsService.findOne(id);
        setCurrentArr(arr);
        reset({
          titulo: arr.titulo,
          descricao: arr.descricao || '',
          data: String(arr.data).slice(0, 10),
          turno: arr.turno || '',
          frente_trabalho: arr.frente_trabalho || '',
          atividade_principal: arr.atividade_principal,
          condicao_observada: arr.condicao_observada,
          risco_identificado: arr.risco_identificado,
          nivel_risco: arr.nivel_risco,
          probabilidade: arr.probabilidade,
          severidade: arr.severidade,
          controles_imediatos: arr.controles_imediatos,
          acao_recomendada: arr.acao_recomendada || '',
          epi_epc_aplicaveis: arr.epi_epc_aplicaveis || '',
          observacoes: arr.observacoes || '',
          company_id: arr.company_id,
          site_id: arr.site_id,
          responsavel_id: arr.responsavel_id,
          participants: (arr.participants || []).map((participant) => participant.id),
        });
      } catch (error) {
        toast.error(
          getFormErrorMessage(error, {
            fallback:
              'Nao foi possivel carregar os dados da Análise de Risco Rápida.',
          }),
        );
      } finally {
        setFetching(false);
      }
    }

    void loadData();
  }, [id, reset, setValue]);

  useEffect(() => {
    let cancelled = false;

    async function loadCompanySites() {
      if (!selectedCompanyId) {
        setSites([]);
        return;
      }

      const selectedCompanyData = companies.find(
        (company) => company.id === selectedCompanyId,
      );

      if (isAdminGeral) {
        selectedTenantStore.set({
          companyId: selectedCompanyId,
          companyName:
            selectedCompanyData?.razao_social || 'Empresa selecionada',
        });
      }

      const sitesResult = await sitesService.findPaginated({
        page: 1,
        limit: 100,
        companyId: selectedCompanyId,
      });

      if (cancelled) {
        return;
      }

      setSites(sitesResult.data);
    }

    void loadCompanySites();

    return () => {
      cancelled = true;
    };
  }, [companies, isAdminGeral, selectedCompanyId]);

  useEffect(() => {
    let cancelled = false;

    async function loadCompanyUsers() {
      if (!selectedCompanyId) {
        setUsers([]);
        return;
      }

      const usersResult = await usersService.findPaginated({
        page: 1,
        limit: 100,
        companyId: selectedCompanyId,
        siteId: selectedSiteId || undefined,
      });

      if (cancelled) {
        return;
      }

      setUsers(usersResult.data);
    }

    void loadCompanyUsers();

    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId, selectedSiteId]);

  const toggleParticipant = (userId: string) => {
    const current = selectedParticipantIds || [];
    const next = current.includes(userId)
      ? current.filter((item) => item !== userId)
      : [...current, userId];

    setValue('participants', next, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
  };

  const handleCompanyChange = (companyId: string) => {
    if (isAdminGeral && companyId) {
      const company = companies.find((item) => item.id === companyId);
      selectedTenantStore.set({
        companyId,
        companyName: company?.razao_social || 'Empresa selecionada',
      });
    }
    setValue('company_id', companyId, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
    setValue('site_id', '', { shouldValidate: true });
    setValue('responsavel_id', '', { shouldValidate: true });
    setValue('participants', [], { shouldValidate: true });
  };

  const onSubmit = async (data: ArrFormData) => {
    const payload: ArrMutationInput = {
      ...data,
      descricao: data.descricao || undefined,
      turno: data.turno || undefined,
      frente_trabalho: data.frente_trabalho || undefined,
      acao_recomendada: data.acao_recomendada || undefined,
      epi_epc_aplicaveis: data.epi_epc_aplicaveis || undefined,
      observacoes: data.observacoes || undefined,
    };

    try {
      setSaving(true);

      if (id) {
        await arrsService.update(id, payload);
        toast.success('Análise de Risco Rápida atualizada com sucesso.');
      } else {
        await arrsService.create(payload);
        toast.success('Análise de Risco Rápida criada com sucesso.');
      }

      await clearDraft();
      router.push('/dashboard/arrs');
      router.refresh();
    } catch (error) {
      toast.error(
        getFormErrorMessage(error, {
          fallback:
            'Nao foi possivel salvar a Análise de Risco Rápida.',
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  if (!canManageArrs) {
    return (
      <div
        role="alert"
        className="mx-auto max-w-4xl rounded-[var(--ds-radius-xl)] border border-[color:var(--ds-color-danger)]/20 bg-[color:var(--ds-color-danger)]/8 px-5 py-4"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--ds-color-danger)]/12 text-[var(--ds-color-danger)]">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
              Acesso indisponível para ARR
            </p>
            <p className="text-sm text-[var(--ds-color-text-secondary)]">
              Voce nao tem permissao para criar ou editar Análises de Risco Rápida.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="mx-auto max-w-6xl pb-10">
      {hasDraft && !fetching ? (
        <InlineCallout
          title="Rascunho não salvo encontrado"
          description="Existe um rascunho salvo localmente para este formulário de ARR. Deseja recuperar os dados preenchidos anteriormente?"
          tone="info"
          icon={<Save className="h-4 w-4" />}
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={restoreDraft}>
                Recuperar
              </Button>
              <Button size="sm" variant="outline" onClick={discardDraft}>
                Descartar
              </Button>
            </div>
          }
        />
      ) : null}

      {fetching ? (
        <div className="mx-auto mb-6 max-w-4xl rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
          <InlineLoadingState
            label={id ? 'Carregando ARR' : 'Preparando ARR'}
          />
        </div>
      ) : null}

      <FormPageLayout
        className="space-y-7"
        eyebrow="Formalização rápida"
        title={id ? 'Editar ARR' : 'Nova ARR'}
        description="Registro rápido para condição observada, risco identificado e tratamento imediato."
        icon={<ShieldAlert className="h-5 w-5" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone="info">ARR</StatusPill>
            <StatusPill tone={id ? 'warning' : 'success'}>
              {id ? 'Edição' : 'Novo registro'}
            </StatusPill>
            <StatusPill tone={isReadOnly ? 'warning' : 'success'}>
              {isReadOnly ? 'Somente leitura' : 'Fluxo ativo'}
            </StatusPill>
            <Button
              type="button"
              variant="secondary"
              onClick={() => router.push('/dashboard/arrs')}
            >
              <ArrowLeft className="h-4 w-4" />
              Voltar para ARRs
            </Button>
            {id &&
            currentArr &&
            canManageArrs &&
            !currentArr.pdf_file_key &&
            (currentArr.status === 'analisada' || currentArr.status === 'tratada') ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleGenerateFinalPdf()}
                disabled={generatingPdf}
              >
                <ShieldCheck className="h-4 w-4" />
                {generatingPdf ? 'Emitindo PDF...' : 'Emitir PDF oficial'}
              </Button>
            ) : null}
            {id && isReadOnly ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handlePrintArchivedPdf()}
                  disabled={!currentArr?.pdf_file_key}
                >
                  <Printer className="h-4 w-4" />
                  Imprimir PDF
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleEmailArchivedPdf()}
                  disabled={!currentArr?.pdf_file_key}
                >
                  <Mail className="h-4 w-4" />
                  Enviar por e-mail
                </Button>
              </>
            ) : null}
          </div>
        }
        summary={
          <>
            <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] px-5 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.05em] text-[var(--ds-color-text-secondary)]">
                Preparação da ARR
              </p>
              <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                Confirme risco, probabilidade, severidade e equipe antes de concluir a análise.
              </p>
              <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                Registre a condição observada, os controles imediatos e a ação recomendada de forma objetiva.
              </p>
            </div>
            {readOnlyMessage ? (
              <div
                role="alert"
                className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)] px-5 py-4 text-sm text-[var(--ds-color-text-secondary)]"
              >
                <p className="font-semibold text-[var(--ds-color-text-primary)]">
                  Documento travado para edição
                </p>
                <p className="mt-1">{readOnlyMessage}</p>
              </div>
            ) : null}
            <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Status visual"
                value={currentArr ? ARR_STATUS_LABEL[currentArr.status] : 'Rascunho'}
                tone="primary"
              />
              <MetricCard
                label="Risco"
                value={ARR_RISK_LEVEL_LABEL[selectedRiskLevel]}
                note={`${ARR_PROBABILITY_LABEL[selectedProbability]} / ${ARR_SEVERITY_LABEL[selectedSeverity]}`}
                tone="warning"
              />
              <MetricCard
                label="Equipe"
                value={selectedParticipantIds.length}
                tone="success"
              />
              <MetricCard
                label="Local / atividade"
                value={selectedSite?.nome || currentArr?.site?.nome || 'Local pendente'}
                note={selectedMainActivity || currentArr?.atividade_principal || selectedTitle || 'Defina o foco da ARR'}
              />
            </section>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusPill tone="info">
                {selectedCompany?.razao_social || 'Empresa pendente'}
              </StatusPill>
              <StatusPill tone="warning">
                {selectedTurno
                  ? TURNO_LABEL[selectedTurno] || selectedTurno
                  : 'Turno pendente'}
              </StatusPill>
              <StatusPill tone="success">
                {selectedParticipantIds.length} participante(s)
              </StatusPill>
            </div>
          </>
        }
        footer={
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                ARR com leitura objetiva e registro mais ágil
              </p>
              <p className="text-sm text-[var(--ds-color-text-muted)]">
                Revise risco, controles e equipe antes de salvar.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="w-full sm:w-auto"
                onClick={() => router.push('/dashboard/arrs')}
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                size="lg"
                className="w-full sm:w-auto"
                loading={saving || isSubmitting}
                disabled={isReadOnly || !isValid}
              >
                {!saving && !isSubmitting ? <Save className="h-4 w-4" /> : null}
                {id ? 'Salvar alterações' : 'Salvar ARR'}
              </Button>
            </div>
          </div>
        }
      >
        <fieldset
          disabled={isReadOnly || saving || isSubmitting}
          className={cn('space-y-6', isReadOnly && 'opacity-90')}
        >
          <FormSection
            title="Contexto da análise"
            description="Defina o básico do registro com leitura clara para campo."
            icon={<CalendarDays className="h-4 w-4" />}
            badge="Etapa 1"
            className="border-l-4 border-l-[var(--ds-color-info)]"
          >
            <FormGrid cols={2}>
              <div className="md:col-span-2">
                <label htmlFor="arr-titulo" className={labelClassName}>
                  Título
                </label>
                <input
                  id="arr-titulo"
                  type="text"
                  {...register('titulo')}
                  className={inputClassName}
                  placeholder="Ex.: ARR de acesso em área de carga"
                />
                {errors.titulo ? (
                  <p className={errorClassName}>{errors.titulo.message}</p>
                ) : (
                  <p className={helperClassName}>
                    Use um título curto que identifique a situação analisada.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="arr-data" className={labelClassName}>
                  Data
                </label>
                <input
                  id="arr-data"
                  type="date"
                  {...register('data')}
                  className={inputClassName}
                />
              </div>

              <div>
                <label htmlFor="arr-turno" className={labelClassName}>
                  Turno
                </label>
                <select id="arr-turno" {...register('turno')} className={inputClassName}>
                  <option value="">Selecione</option>
                  <option value="manha">Manhã</option>
                  <option value="tarde">Tarde</option>
                  <option value="noite">Noite</option>
                  <option value="integral">Integral</option>
                </select>
              </div>

              {isAdminGeral ? (
                <div>
                  <label htmlFor="arr-company" className={labelClassName}>
                    Empresa
                  </label>
                  <select
                    id="arr-company"
                    {...register('company_id')}
                    onChange={(event) => handleCompanyChange(event.target.value)}
                    className={inputClassName}
                  >
                    <option value="">Selecione a empresa</option>
                    {companies.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.razao_social}
                      </option>
                    ))}
                  </select>
                  {errors.company_id ? (
                    <p className={errorClassName}>{errors.company_id.message}</p>
                  ) : null}
                </div>
              ) : (
                <input type="hidden" {...register('company_id')} />
              )}

              <div>
                <label htmlFor="arr-site" className={labelClassName}>
                  Site / frente
                </label>
                <select
                  id="arr-site"
                  {...register('site_id')}
                  className={inputClassName}
                  disabled={!selectedCompanyId}
                >
                  <option value="">
                    {selectedCompanyId ? 'Selecione o site' : 'Selecione uma empresa primeiro'}
                  </option>
                  {filteredSites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.nome}
                    </option>
                  ))}
                </select>
                {errors.site_id ? <p className={errorClassName}>{errors.site_id.message}</p> : null}
              </div>
              <div>
                <label htmlFor="arr-responsavel" className={labelClassName}>
                  Responsável
                </label>
                <select
                  id="arr-responsavel"
                  {...register('responsavel_id')}
                  className={inputClassName}
                  disabled={!selectedCompanyId}
                >
                  <option value="">
                    {selectedCompanyId ? 'Selecione o responsável' : 'Selecione uma empresa primeiro'}
                  </option>
                  {filteredUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.nome}
                    </option>
                  ))}
                </select>
                {errors.responsavel_id ? (
                  <p className={errorClassName}>{errors.responsavel_id.message}</p>
                ) : null}
              </div>

              <div>
                <label htmlFor="arr-frente" className={labelClassName}>
                  Frente de trabalho
                </label>
                <input
                  id="arr-frente"
                  type="text"
                  {...register('frente_trabalho')}
                  className={inputClassName}
                  placeholder="Ex.: Pátio, área externa, setor B"
                />
              </div>

              <div className="md:col-span-2">
                <label htmlFor="arr-descricao" className={labelClassName}>
                  Descrição / contexto
                </label>
                <textarea
                  id="arr-descricao"
                  {...register('descricao')}
                  className={textareaClassName}
                  placeholder="Explique rapidamente o contexto da situação ou da análise."
                />
              </div>
            </FormGrid>
          </FormSection>

          <FormSection
            title="Análise rápida"
            description="Organize condição, risco e tratamento em blocos curtos e legíveis."
            icon={<AlertTriangle className="h-4 w-4" />}
            badge="Etapa 2"
            className="border-l-4 border-l-[var(--ds-color-warning)]"
          >
            <div className="space-y-5">
              <FormFieldGroup
                tone="warning"
                label="Condição e risco"
                description="Registre a condição observada e o risco identificado com objetividade."
                className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)] px-4 py-4"
              >
                <FormGrid cols={1}>
                  <div>
                    <label htmlFor="arr-atividade-principal" className={labelClassName}>
                      Atividade principal
                    </label>
                    <input
                      id="arr-atividade-principal"
                      type="text"
                      {...register('atividade_principal')}
                      className={inputClassName}
                      placeholder="Ex.: Içamento, acesso em altura, movimentação de carga"
                    />
                    {errors.atividade_principal ? (
                      <p className={errorClassName}>{errors.atividade_principal.message}</p>
                    ) : null}
                  </div>

                  <div>
                    <label htmlFor="arr-condicao-observada" className={labelClassName}>
                      Condição observada
                    </label>
                    <textarea
                      id="arr-condicao-observada"
                      {...register('condicao_observada')}
                      className={cn(textareaClassName, 'min-h-[140px]')}
                    />
                    {errors.condicao_observada ? (
                      <p className={errorClassName}>{errors.condicao_observada.message}</p>
                    ) : null}
                  </div>

                  <div>
                    <label htmlFor="arr-risco-identificado" className={labelClassName}>
                      Risco identificado
                    </label>
                    <textarea
                      id="arr-risco-identificado"
                      {...register('risco_identificado')}
                      className={cn(textareaClassName, 'min-h-[140px]')}
                    />
                    {errors.risco_identificado ? (
                      <p className={errorClassName}>{errors.risco_identificado.message}</p>
                    ) : null}
                  </div>
                </FormGrid>
              </FormFieldGroup>

              <FormFieldGroup
                tone="primary"
                label="Classificação e resposta"
                description="Defina o nível do risco e a resposta imediata da equipe."
                className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)] px-4 py-4"
              >
                <FormGrid cols={3}>
                  <div>
                    <label htmlFor="arr-nivel-risco" className={labelClassName}>
                      Nível de risco
                    </label>
                    <select id="arr-nivel-risco" {...register('nivel_risco')} className={inputClassName}>
                      <option value="baixo">Baixo</option>
                      <option value="medio">Médio</option>
                      <option value="alto">Alto</option>
                      <option value="critico">Crítico</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="arr-probabilidade" className={labelClassName}>
                      Probabilidade
                    </label>
                    <select id="arr-probabilidade" {...register('probabilidade')} className={inputClassName}>
                      <option value="baixa">Baixa</option>
                      <option value="media">Média</option>
                      <option value="alta">Alta</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="arr-severidade" className={labelClassName}>
                      Severidade
                    </label>
                    <select id="arr-severidade" {...register('severidade')} className={inputClassName}>
                      <option value="leve">Leve</option>
                      <option value="moderada">Moderada</option>
                      <option value="grave">Grave</option>
                      <option value="critica">Crítica</option>
                    </select>
                  </div>

                  <div className="md:col-span-3">
                    <label htmlFor="arr-controles-imediatos" className={labelClassName}>
                      Controles imediatos
                    </label>
                    <textarea
                      id="arr-controles-imediatos"
                      {...register('controles_imediatos')}
                      className={cn(textareaClassName, 'min-h-[140px]')}
                    />
                    {errors.controles_imediatos ? (
                      <p className={errorClassName}>{errors.controles_imediatos.message}</p>
                    ) : null}
                  </div>

                  <div className="md:col-span-3">
                    <label htmlFor="arr-acao-recomendada" className={labelClassName}>
                      Ação recomendada
                    </label>
                    <textarea
                      id="arr-acao-recomendada"
                      {...register('acao_recomendada')}
                      className={textareaClassName}
                    />
                  </div>

                  <div>
                    <label htmlFor="arr-epi-epc" className={labelClassName}>
                      EPIs / EPCs aplicáveis
                    </label>
                    <textarea
                      id="arr-epi-epc"
                      {...register('epi_epc_aplicaveis')}
                      className={textareaClassName}
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label htmlFor="arr-observacoes" className={labelClassName}>
                      Observações
                    </label>
                    <textarea
                      id="arr-observacoes"
                      {...register('observacoes')}
                      className={textareaClassName}
                    />
                  </div>
                </FormGrid>
              </FormFieldGroup>
            </div>
          </FormSection>

          <FormSection
            title="Participantes"
            description="Selecione quem participou da análise rápida em campo."
            icon={<Users className="h-4 w-4" />}
            badge="Etapa 3"
            actions={<StatusPill tone="info">{selectedParticipantIds.length} selecionado(s)</StatusPill>}
            className="border-l-4 border-l-[var(--ds-color-action-primary)]"
          >
            {!selectedCompanyId ? (
              <div className="rounded-[var(--ds-radius-xl)] border border-dashed border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)] px-5 py-8 text-center text-sm text-[var(--ds-color-text-muted)]">
                Selecione uma empresa para listar os participantes.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {filteredUsers.map((user) => {
                  const selected = selectedParticipantIds.includes(user.id);
                  return (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => toggleParticipant(user.id)}
                      className={cn(
                        'flex min-h-[86px] items-center justify-between rounded-[var(--ds-radius-lg)] border px-4 py-3 text-left text-sm transition-colors duration-[var(--ds-motion-fast)]',
                        selected
                          ? 'border-[var(--ds-color-action-primary)] bg-[var(--ds-color-primary-subtle)] text-[var(--ds-color-text-primary)] shadow-[var(--component-card-shadow)]'
                          : 'border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-secondary)] hover:border-[var(--ds-color-border-default)] hover:bg-[var(--ds-color-surface-muted)]',
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={cn(
                            'flex h-11 w-11 items-center justify-center rounded-full border text-xs font-semibold tracking-[0.08em]',
                            selected
                              ? 'border-[var(--ds-color-action-primary)] bg-white text-[var(--ds-color-action-primary)]'
                              : 'border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)]',
                          )}
                        >
                          {getUserInitials(user.nome)}
                        </div>
                        <div className="space-y-1">
                          <p className="font-medium">{user.nome}</p>
                          <p className="text-xs text-[var(--ds-color-text-muted)]">
                            Participante disponível para esta ARR
                          </p>
                        </div>
                      </div>
                      <div
                        className={cn(
                          'flex h-9 w-9 items-center justify-center rounded-full border',
                          selected
                            ? 'border-[var(--ds-color-action-primary)] bg-[var(--ds-color-action-primary)] text-[var(--ds-color-action-primary-foreground)]'
                            : 'border-[var(--ds-color-border-default)] text-[var(--ds-color-text-muted)]',
                        )}
                      >
                        {selected ? (
                          <ShieldCheck className="h-4 w-4" />
                        ) : (
                          <Building2 className="h-4 w-4" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {errors.participants ? (
              <p className={errorClassName}>{errors.participants.message}</p>
            ) : null}
          </FormSection>
        </fieldset>
      </FormPageLayout>

      {selectedDoc ? (
        <SendMailModal
          isOpen={isMailModalOpen}
          onClose={() => {
            setIsMailModalOpen(false);
            setSelectedDoc(null);
          }}
          documentName={selectedDoc.name}
          filename={selectedDoc.filename}
          base64={selectedDoc.base64}
          storedDocument={selectedDoc.storedDocument}
        />
      ) : null}
    </form>
  );
}
