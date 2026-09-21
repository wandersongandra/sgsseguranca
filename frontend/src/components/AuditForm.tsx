'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import NextImage from 'next/image';
import { auditsService } from '@/services/auditsService';
import { sitesService, Site } from '@/services/sitesService';
import { usersService, User } from '@/services/usersService';
import { useForm, useFieldArray, Control, FieldValues } from 'react-hook-form';
import type { FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Camera, Save, Plus, Trash2, Loader2, ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { getFormErrorMessage } from '@/lib/error-handler';
import { logger } from '@/lib/logger';
import { attachPdfIfProvided } from '@/lib/document-upload';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { sessionStore } from '@/lib/sessionStore';
import { toInputDateValue } from '@/lib/date/safeFormat';
import { PageHeader } from '@/components/layout';
import { InlineLoadingState } from '@/components/ui/state';
import { StatusPill } from '@/components/ui/status-pill';
import { isUserVisibleForSite } from '@/lib/site-scoped-user-visibility';
import {
  AUDIT_CHECKLIST_SECTIONS,
  createDefaultAuditChecklistAnswers,
  formatAuditChecklistAnswer,
  mergeAuditChecklistAnswers,
  type AuditChecklistAnswer,
  type AuditChecklistEvidence,
} from '@/lib/auditChecklist';

const MAX_CHECKLIST_PHOTOS_PER_ITEM = 3;

const checklistEvidenceSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z.number(),
  dataUrl: z.string(),
  capturedAt: z.string(),
  hash: z.string().optional(),
});

const checklistAnswerSchema = z.object({
  sectionId: z.string(),
  sectionTitle: z.string(),
  questionId: z.string(),
  question: z.string(),
  requirement: z.string(),
  criticality: z.enum(['baixa', 'media', 'alta', 'critica']),
  answer: z.enum(['sim', 'nao', 'na']),
  observation: z.string().optional(),
  allowsPhoto: z.boolean().optional(),
  photoRequiredWhen: z.enum(['always', 'nao']).optional(),
  suggestedAction: z.string().optional(),
  evidences: z.array(checklistEvidenceSchema).optional(),
});

const auditSchema = z.object({
  titulo: z.string().min(5, 'O título deve ter pelo menos 5 caracteres'),
  data_auditoria: z.string(),
  tipo_auditoria: z.string().min(1, 'O tipo de auditoria é obrigatório'),
  site_id: z.string().min(1, 'Selecione um site'),
  auditor_id: z.string().min(1, 'Selecione um auditor'),
  representantes_empresa: z.string().optional(),
  objetivo: z.string().optional(),
  escopo: z.string().optional(),
  referencias: z.array(z.string()).optional(),
  metodologia: z.string().optional(),
  caracterizacao: z.object({
    cnae: z.string().optional(),
    grau_risco: z.string().optional(),
    num_trabalhadores: z.number().optional(),
    turnos: z.string().optional(),
    atividades_principais: z.string().optional(),
  }).optional(),
  documentos_avaliados: z.array(z.string()).optional(),
  resultados_conformidades: z.array(z.string()).optional(),
  resultados_nao_conformidades: z.array(z.object({
    descricao: z.string(),
    requisito: z.string(),
    evidencia: z.string(),
    classificacao: z.enum(['Leve', 'Moderada', 'Grave', 'Crítica']),
  })).optional(),
  resultados_observacoes: z.array(z.string()).optional(),
  resultados_oportunidades: z.array(z.string()).optional(),
  avaliacao_riscos: z.array(z.object({
    perigo: z.string(),
    classificacao: z.string(),
    impactos: z.string(),
    medidas_controle: z.string(),
  })).optional(),
  plano_acao: z.array(z.object({
    item: z.string(),
    acao: z.string(),
    responsavel: z.string(),
    prazo: z.string(),
    status: z.string(),
  })).optional(),
  checklist_respostas: z.array(checklistAnswerSchema).optional(),
  conclusao: z.string().optional(),
});

type AuditFormData = z.infer<typeof auditSchema>;
type NonComplianceClassification =
  NonNullable<AuditFormData['resultados_nao_conformidades']>[number]['classificacao'];

interface AuditFormProps {
  id?: string;
}

export function AuditForm({ id }: AuditFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [activeCompanyId, setActiveCompanyId] = useState(
    () => selectedTenantStore.get()?.companyId || sessionStore.get()?.companyId || '',
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setFocus,
    setValue,
    watch,
    formState: { errors, isValid, isSubmitting },
  } = useForm<AuditFormData>({
    resolver: zodResolver(auditSchema),
    mode: 'onBlur',
    reValidateMode: 'onBlur',
    defaultValues: {
      titulo: 'Relatório de Auditoria HSE',
      data_auditoria: new Date().toISOString().split('T')[0],
      tipo_auditoria: 'Interna',
      referencias: [''],
      documentos_avaliados: [''],
      resultados_conformidades: [''],
      resultados_nao_conformidades: [],
      resultados_observacoes: [''],
      resultados_oportunidades: [''],
      avaliacao_riscos: [],
      plano_acao: [],
      checklist_respostas: createDefaultAuditChecklistAnswers(),
    },
  });

  // Field Arrays
  const fieldArrayControl = control as unknown as Control<FieldValues>;
  const { fields: refFields, append: appendRef, remove: removeRef } = useFieldArray({ control: fieldArrayControl, name: 'referencias' });
  const { fields: docFields, append: appendDoc, remove: removeDoc } = useFieldArray({ control: fieldArrayControl, name: 'documentos_avaliados' });
  const { fields: confFields, append: appendConf, remove: removeConf } = useFieldArray({ control: fieldArrayControl, name: 'resultados_conformidades' });
  const { fields: ncFields, append: appendNC, remove: removeNC } = useFieldArray({ control, name: 'resultados_nao_conformidades' });
  const { fields: obsFields, append: appendObs, remove: removeObs } = useFieldArray({ control: fieldArrayControl, name: 'resultados_observacoes' });
  const { fields: opFields, append: appendOp, remove: removeOp } = useFieldArray({ control: fieldArrayControl, name: 'resultados_oportunidades' });
  const { fields: riskFields, append: appendRisk, remove: removeRisk } = useFieldArray({ control, name: 'avaliacao_riscos' });
  const { fields: actionFields, append: appendAction, remove: removeAction } = useFieldArray({ control, name: 'plano_acao' });
  const selectedSiteId = watch('site_id');
  const selectedAuditorId = watch('auditor_id');
  const checklistAnswers = watch('checklist_respostas') ?? [];
  const filteredUsers = useMemo(
    () =>
      users.filter((user) =>
        isUserVisibleForSite(user, activeCompanyId, selectedSiteId),
      ),
    [activeCompanyId, selectedSiteId, users],
  );

  useEffect(() => {
    if (!users.length || !selectedAuditorId) {
      return;
    }

    const isCurrentAuditorVisible = filteredUsers.some(
      (user) => user.id === selectedAuditorId,
    );

    if (!isCurrentAuditorVisible) {
      setValue('auditor_id', '', {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  }, [filteredUsers, selectedAuditorId, setValue, users.length]);

  useEffect(() => {
    const unsubscribe = selectedTenantStore.subscribe((tenant) => {
      setActiveCompanyId(tenant?.companyId || sessionStore.get()?.companyId || '');
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try {
        if (!activeCompanyId) {
          setSites([]);
          setUsers([]);
          return;
        }

        const auditPromise = id ? auditsService.findOne(id) : Promise.resolve(null);
        const [sitesData, usersData] = await Promise.all([
          sitesService.findAll(activeCompanyId),
          usersService.findAll(activeCompanyId),
        ]);

        setSites(sitesData);
        setUsers(usersData);

        void auditPromise
          .then((audit) => {
            if (audit) {
              reset({
                ...audit,
                data_auditoria: toInputDateValue(audit.data_auditoria),
                checklist_respostas: mergeAuditChecklistAnswers(
                  audit.checklist_respostas,
                ),
              });
            }
          })
          .catch((error) => {
            logger.error('Erro ao carregar auditoria:', error);
            toast.error('A auditoria não pôde ser carregada agora.');
          });
      } catch {
        toast.error('Erro ao carregar dados');
      } finally {
        setFetching(false);
      }
    };

    void fetchData();
  }, [activeCompanyId, id, reset]);

  const normalizeText = (value?: string | null) => {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
  };

  const normalizeStringArray = (values?: string[]) => {
    const normalized = (values ?? [])
      .map((value) => normalizeText(value))
      .filter((value): value is string => Boolean(value));
    return normalized.length > 0 ? normalized : undefined;
  };

  const normalizeRows = <T extends Record<string, unknown>>(
    values: T[] | undefined,
    mapper: (value: T) => T,
  ) => {
    const normalized = (values ?? [])
      .map((value) => mapper(value))
      .filter((value) =>
        Object.values(value).every((entry) => {
          if (typeof entry === 'string') {
            return entry.trim().length > 0;
          }
          return Boolean(entry);
        }),
      );

    return normalized.length > 0 ? normalized : undefined;
  };

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () =>
        reject(new Error('Não foi possível ler a foto selecionada.'));
      reader.readAsDataURL(file);
    });

  const sha256 = async (value: string) => {
    if (!globalThis.crypto?.subtle) {
      return undefined;
    }
    const data = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  };

  const resizeChecklistPhoto = async (
    file: File,
  ): Promise<AuditChecklistEvidence> => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      throw new Error('Use apenas imagens JPG, PNG ou WebP.');
    }

    const source = await fileToDataUrl(file);
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Não foi possível processar a foto.'));
      img.src = source;
    });

    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / image.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Não foi possível preparar a foto.');
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.78);

    return {
      id:
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      fileName: file.name,
      mimeType: 'image/jpeg',
      size: Math.round((dataUrl.length * 3) / 4),
      dataUrl,
      capturedAt: new Date().toISOString(),
      hash: await sha256(dataUrl),
    };
  };

  const findChecklistIndex = (questionId: string) =>
    (checklistAnswers ?? []).findIndex(
      (answer) => answer.questionId === questionId,
    );

  const handleChecklistPhotoChange = async (
    questionId: string,
    files: FileList | null,
  ) => {
    if (!files?.length) {
      return;
    }

    const answerIndex = findChecklistIndex(questionId);
    if (answerIndex < 0) {
      return;
    }

    try {
      const current =
        checklistAnswers[answerIndex]?.evidences?.slice(
          0,
          MAX_CHECKLIST_PHOTOS_PER_ITEM,
        ) ?? [];
      const remainingSlots = Math.max(
        0,
        MAX_CHECKLIST_PHOTOS_PER_ITEM - current.length,
      );
      if (remainingSlots === 0) {
        toast.warning('Limite de 3 fotos por pergunta atingido.');
        return;
      }

      const nextEvidence = await Promise.all(
        Array.from(files)
          .slice(0, remainingSlots)
          .map((file) => resizeChecklistPhoto(file)),
      );
      setValue(
        `checklist_respostas.${answerIndex}.evidences`,
        [...current, ...nextEvidence],
        { shouldDirty: true, shouldValidate: true },
      );
      toast.success(`${nextEvidence.length} foto(s) adicionada(s).`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Não foi possível anexar a foto.',
      );
    }
  };

  const removeChecklistEvidence = (questionId: string, evidenceId: string) => {
    const answerIndex = findChecklistIndex(questionId);
    if (answerIndex < 0) {
      return;
    }
    const nextEvidence = (checklistAnswers[answerIndex]?.evidences ?? []).filter(
      (evidence) => evidence.id !== evidenceId,
    );
    setValue(`checklist_respostas.${answerIndex}.evidences`, nextEvidence, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const normalizeChecklistAnswers = (
    values?: AuditChecklistAnswer[],
  ): AuditChecklistAnswer[] | undefined => {
    const normalized = mergeAuditChecklistAnswers(values).map((answer) => ({
      ...answer,
      observation: normalizeText(answer.observation),
      evidences: (answer.evidences ?? []).slice(
        0,
        MAX_CHECKLIST_PHOTOS_PER_ITEM,
      ),
    }));

    return normalized.length > 0 ? normalized : undefined;
  };

  const isGeneratedChecklistText = (value?: string) =>
    String(value || '').startsWith('[Checklist]');

  const buildChecklistDerivedFields = (answers?: AuditChecklistAnswer[]) => {
    const normalized = normalizeChecklistAnswers(answers) ?? [];
    const negatives = normalized.filter((answer) => answer.answer === 'nao');

    const classify = (
      criticality: AuditChecklistAnswer['criticality'],
    ): NonComplianceClassification => {
      if (criticality === 'critica') return 'Crítica';
      if (criticality === 'alta') return 'Grave';
      if (criticality === 'media') return 'Moderada';
      return 'Leve';
    };

    return {
      conformidades: normalized
        .filter((answer) => answer.answer === 'sim')
        .map(
          (answer) =>
            `[Checklist] ${answer.sectionTitle}: ${answer.question}`,
        ),
      naoConformidades: negatives.map((answer) => ({
        descricao: `[Checklist] ${answer.sectionTitle}: ${answer.question}`,
        requisito: answer.requirement,
        evidencia: [
          answer.observation
            ? `Observação: ${answer.observation}`
            : 'Resposta marcada como Não.',
          answer.evidences?.length
            ? `Fotos anexadas: ${answer.evidences.length}`
            : undefined,
        ]
          .filter(Boolean)
          .join(' '),
        classificacao: classify(answer.criticality),
      })),
      observacoes: normalized
        .filter((answer) => answer.answer === 'na' && answer.observation)
        .map(
          (answer) =>
            `[Checklist] ${answer.sectionTitle}: ${answer.question} - ${answer.observation}`,
        ),
      planoAcao: negatives.map((answer) => ({
        item: `CHK-${answer.questionId}`,
        acao:
          answer.suggestedAction ||
          `Tratar não conformidade do checklist: ${answer.question}`,
        responsavel: 'Responsável SST',
        prazo: 'Definir prazo',
        status: 'Pendente',
      })),
    };
  };

  const validateChecklistBeforeSubmit = (
    answers?: AuditChecklistAnswer[],
  ): string | null => {
    for (const answer of answers ?? []) {
      if (
        answer.answer === 'nao' &&
        (!answer.observation || answer.observation.trim().length < 5)
      ) {
        return `Informe uma observação para a resposta "Não": ${answer.question}`;
      }
      const photoRequired =
        answer.photoRequiredWhen === 'always' ||
        (answer.photoRequiredWhen === 'nao' && answer.answer === 'nao');
      if (photoRequired && (answer.evidences?.length ?? 0) === 0) {
        return `Anexe ao menos uma foto para: ${answer.question}`;
      }
    }

    return null;
  };

  const normalizeSubmitPayload = (data: AuditFormData): AuditFormData => {
    const checklist = normalizeChecklistAnswers(data.checklist_respostas);
    const derived = buildChecklistDerivedFields(checklist);
    const manualConformities = normalizeStringArray(
      data.resultados_conformidades?.filter(
        (item) => !isGeneratedChecklistText(item),
      ),
    );
    const manualObservations = normalizeStringArray(
      data.resultados_observacoes?.filter(
        (item) => !isGeneratedChecklistText(item),
      ),
    );
    const manualNonConformities = normalizeRows(
      data.resultados_nao_conformidades?.filter(
        (item) => !isGeneratedChecklistText(item.descricao),
      ),
      (item) => ({
        descricao: normalizeText(item.descricao) || '',
        requisito: normalizeText(item.requisito) || '',
        evidencia: normalizeText(item.evidencia) || '',
        classificacao:
          (normalizeText(item.classificacao) || '') as NonComplianceClassification,
      }),
    );
    const manualActionPlan = normalizeRows(
      data.plano_acao?.filter(
        (item) => !String(item.item || '').startsWith('CHK-'),
      ),
      (item) => ({
        item: normalizeText(item.item) || '',
        acao: normalizeText(item.acao) || '',
        responsavel: normalizeText(item.responsavel) || '',
        prazo: normalizeText(item.prazo) || '',
        status: normalizeText(item.status) || '',
      }),
    );

    return {
      ...data,
      titulo: normalizeText(data.titulo) ?? '',
      data_auditoria: normalizeText(data.data_auditoria) ?? '',
      tipo_auditoria: normalizeText(data.tipo_auditoria) ?? '',
      site_id: normalizeText(data.site_id) ?? '',
      auditor_id: normalizeText(data.auditor_id) ?? '',
      representantes_empresa: normalizeText(data.representantes_empresa),
      objetivo: normalizeText(data.objetivo),
      escopo: normalizeText(data.escopo),
      referencias: normalizeStringArray(data.referencias),
      metodologia: normalizeText(data.metodologia),
      caracterizacao: data.caracterizacao
        ? (() => {
            const normalizedCaracterizacao = {
              cnae: normalizeText(data.caracterizacao?.cnae),
              grau_risco: normalizeText(data.caracterizacao?.grau_risco),
              num_trabalhadores:
                typeof data.caracterizacao?.num_trabalhadores === 'number'
                  ? data.caracterizacao.num_trabalhadores
                  : undefined,
              turnos: normalizeText(data.caracterizacao?.turnos),
              atividades_principais: normalizeText(
                data.caracterizacao?.atividades_principais,
              ),
            };

            return Object.values(normalizedCaracterizacao).some(
              (value) => value !== undefined && value !== null && value !== '',
            )
              ? normalizedCaracterizacao
              : undefined;
          })()
        : undefined,
      documentos_avaliados: normalizeStringArray(data.documentos_avaliados),
      resultados_conformidades:
        [...(manualConformities ?? []), ...derived.conformidades].length > 0
          ? [...(manualConformities ?? []), ...derived.conformidades]
          : undefined,
      resultados_nao_conformidades:
        [...(manualNonConformities ?? []), ...derived.naoConformidades]
          .length > 0
          ? [...(manualNonConformities ?? []), ...derived.naoConformidades]
          : undefined,
      resultados_observacoes:
        [...(manualObservations ?? []), ...derived.observacoes].length > 0
          ? [...(manualObservations ?? []), ...derived.observacoes]
          : undefined,
      resultados_oportunidades: normalizeStringArray(
        data.resultados_oportunidades,
      ),
      avaliacao_riscos: normalizeRows(data.avaliacao_riscos, (item) => ({
        perigo: normalizeText(item.perigo) || '',
        classificacao: normalizeText(item.classificacao) || '',
        impactos: normalizeText(item.impactos) || '',
        medidas_controle: normalizeText(item.medidas_controle) || '',
      })),
      plano_acao: [...(manualActionPlan ?? []), ...derived.planoAcao].length > 0
        ? [...(manualActionPlan ?? []), ...derived.planoAcao]
        : undefined,
      checklist_respostas: checklist,
      conclusao: normalizeText(data.conclusao),
    };
  };

  const onSubmit = async (data: AuditFormData) => {
    setLoading(true);
    try {
      setSubmitError(null);
      const checklistError = validateChecklistBeforeSubmit(
        data.checklist_respostas,
      );
      if (checklistError) {
        setSubmitError(checklistError);
        toast.error(checklistError);
        return;
      }
      const normalizedData = normalizeSubmitPayload(data);
      if (id) {
        const updated = await auditsService.update(id, normalizedData);
        await attachPdfIfProvided(updated.id, pdfFile, auditsService.attachFile);
        toast.success('Auditoria atualizada com sucesso');
      } else {
        const created = await auditsService.create(normalizedData);
        await attachPdfIfProvided(created.id, pdfFile, auditsService.attachFile);
        toast.success('Auditoria criada com sucesso');
      }
      router.push('/dashboard/audits');
    } catch (error) {
      const errorMessage = getFormErrorMessage(error, {
        badRequest: 'Dados inválidos. Revise os campos obrigatórios.',
        unauthorized: 'Sessão expirada. Faça login novamente.',
        forbidden: 'Você não tem permissão para salvar auditorias.',
        server: 'Erro interno do servidor ao salvar auditoria.',
        fallback: 'Erro ao salvar auditoria. Tente novamente.',
      });
      setSubmitError(errorMessage);
      toast.error('Erro ao salvar auditoria');
    } finally {
      setLoading(false);
    }
  };

  const onInvalid = (formErrors: FieldErrors<AuditFormData>) => {
    if (formErrors.titulo) {
      setFocus('titulo');
    } else if (formErrors.site_id) {
      setFocus('site_id');
    } else if (formErrors.tipo_auditoria) {
      setFocus('tipo_auditoria');
    } else if (formErrors.auditor_id) {
      setFocus('auditor_id');
    }
    toast.error('Revise os campos obrigatórios antes de salvar.');
  };

  return (
    <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="ds-form-page space-y-8 pb-12">
      {fetching ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
          <InlineLoadingState
            label={id ? 'Carregando auditoria' : 'Preparando auditoria'}
          />
        </div>
      ) : null}

      <PageHeader
        eyebrow="Relatórios de auditoria e inspeção"
        title={id ? 'Editar relatório formal' : 'Novo relatório formal'}
        description="Registre avaliações formais de conformidade, inspeções HSE, achados, riscos e planos de ação em um único relatório governado."
        icon={<ClipboardCheck className="h-5 w-5" />}
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="info">Auditoria / Inspeção HSE</StatusPill>
            <StatusPill tone={id ? 'warning' : 'success'}>
              {id ? 'Edição' : 'Novo cadastro'}
            </StatusPill>
            <StatusPill tone="neutral">
              {activeCompanyId ? 'Tenant ativo' : 'Tenant pendente'}
            </StatusPill>
          </div>
        }
      />

      <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/22 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
          Relatório formal guiado
        </p>
        <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
          Registre o contexto da auditoria ou inspeção formal, consolide conformidades e feche o plano de ação com rastreabilidade.
        </p>
        <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
          Revise site, responsável, tipo de avaliação e achados críticos antes de salvar para evitar retrabalho documental.
        </p>
      </div>

      {submitError && (
        <div
          role="alert"
          className="rounded-lg border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] px-4 py-3 text-sm text-[var(--ds-color-danger)]"
        >
          <p className="font-semibold">Não foi possível salvar o relatório formal</p>
          <p className="mt-1 text-[color:var(--ds-color-danger)]/90">{submitError}</p>
        </div>
      )}
      {/* 1. Identificação */}
      <div className="sst-card p-6">
        <h2 className="mb-4 text-lg font-bold text-[var(--ds-color-text-primary)] flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5 text-[var(--ds-color-text-primary)]" />
          1. Identificação do Documento
        </h2>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="md:col-span-2">
            <label htmlFor="audit-titulo" className="mb-2 block text-sm font-bold text-[var(--ds-color-text-secondary)]">Título</label>
            <input
              id="audit-titulo"
              {...register('titulo')}
              className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none ${
                errors.titulo ? 'border-[var(--ds-color-danger)]' : ''
              }`}
              aria-invalid={errors.titulo ? 'true' : undefined}
            />
            {errors.titulo && <p className="mt-1 text-xs text-[var(--ds-color-danger)]">{errors.titulo.message}</p>}
          </div>

          <div>
            <label htmlFor="audit-site-id" className="mb-2 block text-sm font-bold text-[var(--ds-color-text-secondary)]">Unidade/Site</label>
            <select
              id="audit-site-id"
              {...register('site_id')}
              aria-label="Unidade ou site da auditoria"
              className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none ${
                errors.site_id ? 'border-[var(--ds-color-danger)]' : ''
              }`}
              aria-invalid={errors.site_id ? 'true' : undefined}
            >
              <option value="">Selecione um site</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>{site.nome}</option>
              ))}
            </select>
            {errors.site_id && <p className="mt-1 text-xs text-[var(--ds-color-danger)]">{errors.site_id.message}</p>}
          </div>

          <div>
            <label htmlFor="audit-data-auditoria" className="mb-2 block text-sm font-bold text-[var(--ds-color-text-secondary)]">Data da Auditoria</label>
            <input
              id="audit-data-auditoria"
              type="date"
              {...register('data_auditoria')}
              aria-label="Data da auditoria"
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="audit-tipo-auditoria" className="mb-2 block text-sm font-bold text-[var(--ds-color-text-secondary)]">Tipo de Auditoria</label>
            <select
              id="audit-tipo-auditoria"
              {...register('tipo_auditoria')}
              aria-label="Tipo de auditoria"
              className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none ${
                errors.tipo_auditoria ? 'border-[var(--ds-color-danger)]' : ''
              }`}
              aria-invalid={errors.tipo_auditoria ? 'true' : undefined}
            >
              <option value="Interna">Interna</option>
              <option value="Externa">Externa</option>
              <option value="Cliente">Cliente</option>
              <option value="Legal">Legal</option>
              <option value="Sistema de Gestão">Sistema de Gestão</option>
            </select>
            {errors.tipo_auditoria && <p className="mt-1 text-xs text-[var(--ds-color-danger)]">{errors.tipo_auditoria.message}</p>}
          </div>

          <div>
            <label htmlFor="audit-auditor-id" className="mb-2 block text-sm font-bold text-[var(--ds-color-text-secondary)]">Auditor Responsável</label>
            <select
              id="audit-auditor-id"
              {...register('auditor_id')}
              aria-label="Auditor responsável"
              className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none ${
                errors.auditor_id ? 'border-[var(--ds-color-danger)]' : ''
              }`}
              aria-invalid={errors.auditor_id ? 'true' : undefined}
            >
              <option value="">Selecione o auditor</option>
              {filteredUsers.map((user) => (
                <option key={user.id} value={user.id}>{user.nome}</option>
              ))}
            </select>
            {errors.auditor_id && <p className="mt-1 text-xs text-[var(--ds-color-danger)]">{errors.auditor_id.message}</p>}
          </div>

          <div className="md:col-span-2">
            <label htmlFor="audit-representantes-empresa" className="mb-2 block text-sm font-bold text-[var(--ds-color-text-secondary)]">Representantes da Empresa</label>
            <textarea
              id="audit-representantes-empresa"
              {...register('representantes_empresa')}
              rows={2}
              aria-label="Representantes da empresa"
              className="w-full rounded-md border px-3 py-2 text-sm"
              placeholder="Nomes dos representantes que acompanharam a auditoria"
            />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="audit-pdf-file" className="mb-2 block text-sm font-bold text-[var(--ds-color-text-secondary)]">Anexar PDF da Auditoria (opcional)</label>
            <input
              id="audit-pdf-file"
              type="file"
              accept="application/pdf"
              aria-label="Selecionar PDF da auditoria"
              onChange={(event) => setPdfFile(event.target.files?.[0] || null)}
              className="w-full rounded-md border px-3 py-2 text-sm file:mr-4 file:rounded-md file:border-0 file:bg-[var(--ds-color-surface-muted)] file:px-3 file:py-1.5 file:font-semibold file:text-[var(--ds-color-text-secondary)] hover:file:bg-[var(--ds-color-primary-subtle)]"
            />
          </div>
        </div>
      </div>

      {/* 2 & 3. Objetivo e Escopo */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="sst-card p-6">
          <h2 className="mb-4 text-lg font-bold text-[var(--ds-color-text-primary)]">2. Objetivo</h2>
          <textarea
            {...register('objetivo')}
            rows={4}
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
        </div>
        <div className="sst-card p-6">
          <h2 className="mb-4 text-lg font-bold text-[var(--ds-color-text-primary)]">3. Escopo</h2>
          <textarea
            {...register('escopo')}
            rows={4}
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
        </div>
      </div>

      {/* 4 & 5. Referências e Metodologia */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="sst-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-[var(--ds-color-text-primary)]">4. Referências</h2>
            <button
              type="button"
              onClick={() => appendRef('')}
              className="text-[var(--ds-color-text-primary)] hover:text-[var(--ds-color-text-primary)]"
              title="Adicionar Referência"
              aria-label="Adicionar Referência"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
          {refFields.map((field, index) => (
            <div key={field.id} className="mb-2 flex gap-2">
              <input
                {...register(`referencias.${index}` as const)}
                className="flex-1 rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => removeRef(index)}
                className="text-[var(--ds-color-danger)]"
                title="Remover Referência"
                aria-label="Remover Referência"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <div className="sst-card p-6">
          <h2 className="mb-4 text-lg font-bold text-[var(--ds-color-text-primary)]">5. Metodologia</h2>
          <textarea
            {...register('metodologia')}
            rows={4}
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
        </div>
      </div>

      {/* 6. Caracterização */}
      <div className="sst-card p-6">
        <h2 className="mb-4 text-lg font-bold text-[var(--ds-color-text-primary)]">6. Caracterização da Empresa</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">CNAE</label>
            <input {...register('caracterizacao.cnae')} className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">Grau de Risco</label>
            <input {...register('caracterizacao.grau_risco')} className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">Nº Trabalhadores</label>
            <input
              type="number"
              {...register('caracterizacao.num_trabalhadores', {
                setValueAs: (value) => {
                  if (value === '' || value === null || value === undefined) {
                    return undefined;
                  }
                  const parsed = Number(value);
                  return Number.isFinite(parsed) ? parsed : undefined;
                },
              })}
              className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm"
            />
          </div>
          <div className="md:col-span-3">
            <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">Atividades Principais</label>
            <textarea {...register('caracterizacao.atividades_principais')} rows={2} className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm" />
          </div>
        </div>
      </div>

      {/* 7. Documentos Avaliados */}
      <div className="sst-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-[var(--ds-color-text-primary)]">7. Documentos Avaliados</h2>
          <button
            type="button"
            onClick={() => appendDoc('')}
            className="text-[var(--ds-color-text-primary)] hover:text-[var(--ds-color-text-primary)]"
            title="Adicionar Documento"
            aria-label="Adicionar Documento"
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {docFields.map((field, index) => (
            <div key={field.id} className="flex gap-2">
              <input
                {...register(`documentos_avaliados.${index}` as const)}
                className="flex-1 rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => removeDoc(index)}
                className="text-[var(--ds-color-danger)]"
                title="Remover Documento"
                aria-label="Remover Documento"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 8. Checklist estruturado */}
      <div className="sst-card p-6">
        <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
              Perguntas marcadas
            </p>
            <h2 className="mt-1 text-lg font-bold text-[var(--ds-color-text-primary)]">
              8. Checklist de Auditoria HSE
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-[var(--ds-color-text-secondary)]">
              Marque Sim, Não ou N/A. Respostas &quot;Não&quot; geram não conformidade e plano de ação automaticamente; perguntas críticas podem exigir foto.
            </p>
          </div>
          <div className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] px-3 py-2 text-xs text-[var(--ds-color-text-secondary)]">
            {checklistAnswers.filter((answer) => answer.answer === 'nao').length} NC(s) gerada(s) pelo checklist
          </div>
        </div>

        <div className="space-y-6">
          {AUDIT_CHECKLIST_SECTIONS.map((section) => (
            <section
              key={section.id}
              className="rounded-xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 shadow-sm"
            >
              <div className="mb-4 flex flex-col gap-1 border-b border-[var(--ds-color-border-subtle)] pb-3 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="text-sm font-bold text-[var(--ds-color-text-primary)]">
                  {section.title}
                </h3>
                <span className="text-xs text-[var(--ds-color-text-secondary)]">
                  {section.questions.length} pergunta(s)
                </span>
              </div>

              <div className="space-y-4">
                {section.questions.map((question) => {
                  const answerIndex = findChecklistIndex(question.questionId);
                  const answer =
                    answerIndex >= 0 ? checklistAnswers[answerIndex] : null;
                  if (!answer || answerIndex < 0) {
                    return null;
                  }

                  const photoRequired =
                    answer.photoRequiredWhen === 'always' ||
                    (answer.photoRequiredWhen === 'nao' &&
                      answer.answer === 'nao');

                  return (
                    <div
                      key={question.questionId}
                      className="rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/35 p-4"
                    >
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-2">
                          <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                            {answer.question}
                          </p>
                          <div className="flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.08em]">
                            <span className="rounded-full bg-[var(--ds-color-surface-base)] px-2 py-1 text-[var(--ds-color-text-secondary)]">
                              {answer.requirement}
                            </span>
                            <span className="rounded-full bg-[var(--ds-color-warning-subtle)] px-2 py-1 text-[var(--ds-color-warning)]">
                              Criticidade: {answer.criticality}
                            </span>
                            {photoRequired ? (
                              <span className="rounded-full bg-[var(--ds-color-danger-subtle)] px-2 py-1 text-[var(--ds-color-danger)]">
                                Foto obrigatória
                              </span>
                            ) : null}
                          </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2 rounded-lg bg-[var(--ds-color-surface-base)] p-1">
                          {(['sim', 'nao', 'na'] as const).map((value) => (
                            <label
                              key={value}
                              className={`cursor-pointer rounded-md border px-3 py-2 text-center text-sm font-semibold transition ${
                                answer.answer === value
                                  ? 'border-[var(--ds-color-action-primary)] bg-[var(--ds-color-primary-subtle)] text-[var(--ds-color-action-primary)]'
                                  : 'border-[var(--ds-color-border-subtle)] text-[var(--ds-color-text-secondary)] hover:bg-[var(--ds-color-surface-muted)]'
                              }`}
                            >
                              <input
                                type="radio"
                                value={value}
                                {...register(
                                  `checklist_respostas.${answerIndex}.answer` as const,
                                )}
                                className="sr-only"
                              />
                              {formatAuditChecklistAnswer(value)}
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                        <div>
                          <label
                            htmlFor={`checklist-observation-${question.questionId}`}
                            className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]"
                          >
                            Observação {answer.answer === 'nao' ? '(obrigatória para Não)' : '(opcional)'}
                          </label>
                          <textarea
                            id={`checklist-observation-${question.questionId}`}
                            rows={2}
                            {...register(
                              `checklist_respostas.${answerIndex}.observation` as const,
                            )}
                            className="w-full rounded-md border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm"
                            placeholder="Descreva evidência, exceção, justificativa de N/A ou orientação para ação corretiva."
                          />
                        </div>

                        {answer.allowsPhoto ? (
                          <div className="rounded-lg border border-dashed border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-3">
                            <label
                              htmlFor={`checklist-photo-${question.questionId}`}
                              className="flex cursor-pointer items-center justify-center gap-2 rounded-md bg-[var(--ds-color-surface-muted)] px-3 py-2 text-sm font-semibold text-[var(--ds-color-text-primary)] hover:bg-[var(--ds-color-primary-subtle)]"
                            >
                              <Camera className="h-4 w-4" />
                              Adicionar foto
                            </label>
                            <input
                              id={`checklist-photo-${question.questionId}`}
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              multiple
                              className="sr-only"
                              onChange={(event) => {
                                const input = event.currentTarget;
                                void handleChecklistPhotoChange(
                                  question.questionId,
                                  input.files,
                                ).finally(() => {
                                  input.value = '';
                                });
                              }}
                            />
                            <p className="mt-2 text-xs text-[var(--ds-color-text-secondary)]">
                              Até 3 fotos por pergunta. As imagens são comprimidas antes do envio.
                            </p>
                          </div>
                        ) : (
                          <div className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-3 text-xs text-[var(--ds-color-text-secondary)]">
                            Evidência fotográfica não exigida para este item.
                          </div>
                        )}
                      </div>

                      {answer.evidences?.length ? (
                        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {answer.evidences.map((evidence) => (
                            <figure
                              key={evidence.id}
                              className="overflow-hidden rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]"
                            >
                              <NextImage
                                src={evidence.dataUrl}
                                alt={`Evidência fotográfica: ${evidence.fileName}`}
                                width={320}
                                height={128}
                                unoptimized
                                className="h-32 w-full object-cover"
                              />
                              <figcaption className="flex items-center justify-between gap-2 px-3 py-2">
                                <span className="truncate text-xs text-[var(--ds-color-text-secondary)]">
                                  {evidence.fileName}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    removeChecklistEvidence(
                                      question.questionId,
                                      evidence.id,
                                    )
                                  }
                                  className="text-[var(--ds-color-danger)]"
                                  aria-label={`Remover foto ${evidence.fileName}`}
                                  title="Remover foto"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </figcaption>
                            </figure>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      {/* 9. Resultados */}
      <div className="space-y-6">
        <h2 className="text-xl font-bold text-[var(--ds-color-text-primary)] border-b pb-2">9. Resultados da Auditoria</h2>
        
        {/* Conformidades */}
        <div className="rounded-xl border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-bold text-[var(--ds-color-success)]">9.1 Conformidades</h3>
            <button
              type="button"
              onClick={() => appendConf('')}
              className="text-[var(--ds-color-success)] hover:text-[var(--ds-color-success-hover)]"
              title="Adicionar Conformidade"
              aria-label="Adicionar Conformidade"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
          {confFields.map((field, index) => (
            <div key={field.id} className="mb-2 flex gap-2">
              <input
                {...register(`resultados_conformidades.${index}` as const)}
                className="flex-1 rounded-md border border-[var(--ds-color-success-border)] px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => removeConf(index)}
                className="text-[var(--ds-color-danger)]"
                title="Remover Conformidade"
                aria-label="Remover Conformidade"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>

        {/* Não Conformidades */}
        <div className="rounded-xl border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-bold text-[var(--ds-color-danger)]">9.2 Não Conformidades</h3>
            <button
              type="button"
              onClick={() => appendNC({ descricao: '', requisito: '', evidencia: '', classificacao: 'Moderada' })}
              className="flex items-center gap-1 rounded-md bg-[var(--ds-color-danger)] px-3 py-1 text-sm text-[var(--ds-color-danger-fg)]"
              title="Adicionar Não Conformidade"
              aria-label="Adicionar Não Conformidade"
            >
              <Plus className="h-4 w-4" /> Adicionar NC
            </button>
          </div>
          <div className="space-y-4">
            {ncFields.map((field, index) => (
              <div key={field.id} className="relative rounded-lg border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-surface-base)] p-4 shadow-sm">
                <button
                  type="button"
                  onClick={() => removeNC(index)}
                  className="absolute top-2 right-2 text-[var(--ds-color-danger)] hover:text-[var(--ds-color-danger-hover,var(--ds-color-danger))]"
                  title="Remover Não Conformidade"
                  aria-label="Remover Não Conformidade"
                >
                  <Trash2 className="h-5 w-5" />
                </button>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">Descrição do Desvio</label>
                    <textarea {...register(`resultados_nao_conformidades.${index}.descricao` as const)} rows={2} className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">Requisito Legal/Normativo</label>
                    <input {...register(`resultados_nao_conformidades.${index}.requisito` as const)} className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">Evidência Observada</label>
                    <input {...register(`resultados_nao_conformidades.${index}.evidencia` as const)} className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">Classificação</label>
                    <select {...register(`resultados_nao_conformidades.${index}.classificacao` as const)} className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm">
                      <option value="Leve">Leve</option>
                      <option value="Moderada">Moderada</option>
                      <option value="Grave">Grave</option>
                      <option value="Crítica">Crítica</option>
                    </select>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Observações e Oportunidades */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-bold text-[var(--ds-color-text-primary)]">9.3 Observações</h3>
              <button
                type="button"
                onClick={() => appendObs('')}
                className="text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]"
                title="Adicionar Observação"
                aria-label="Adicionar Observação"
              >
                <Plus className="h-5 w-5" />
              </button>
            </div>
            {obsFields.map((field, index) => (
              <div key={field.id} className="mb-2 flex gap-2">
                <input {...register(`resultados_observacoes.${index}` as const)} className="flex-1 rounded-md border px-3 py-2 text-sm" />
                <button
                  type="button"
                  onClick={() => removeObs(index)}
                  className="text-[var(--ds-color-danger)]"
                  title="Remover Observação"
                  aria-label="Remover Observação"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-bold text-[var(--ds-color-warning)]">9.4 Oportunidades de Melhoria</h3>
              <button
                type="button"
                onClick={() => appendOp('')}
                className="text-[var(--ds-color-warning)] hover:text-[var(--ds-color-warning)]"
                title="Adicionar Oportunidade"
                aria-label="Adicionar Oportunidade"
              >
                <Plus className="h-5 w-5" />
              </button>
            </div>
            {opFields.map((field, index) => (
              <div key={field.id} className="mb-2 flex gap-2">
                <input {...register(`resultados_oportunidades.${index}` as const)} className="flex-1 rounded-md border border-[var(--ds-color-warning-border)] px-3 py-2 text-sm" />
                <button
                  type="button"
                  onClick={() => removeOp(index)}
                  className="text-[var(--ds-color-danger)]"
                  title="Remover Oportunidade"
                  aria-label="Remover Oportunidade"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 10. Avaliação de Riscos */}
      <div className="sst-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-[var(--ds-color-text-primary)]">10. Avaliação de Riscos Identificados</h2>
          <button
            type="button"
            onClick={() => appendRisk({ perigo: '', classificacao: '', impactos: '', medidas_controle: '' })}
            className="flex items-center gap-1 rounded-md bg-[var(--ds-color-action-primary)] px-3 py-1 text-sm text-[var(--ds-color-action-primary-foreground)] hover:bg-[var(--ds-color-action-primary-hover)]"
            title="Adicionar Avaliação de Risco"
            aria-label="Adicionar Avaliação de Risco"
          >
            <Plus className="h-4 w-4" /> Adicionar Risco
          </button>
        </div>
        <div className="space-y-4">
          {riskFields.map((field, index) => (
            <div key={field.id} className="rounded-lg border border-[var(--ds-color-border-default)] p-4 relative">
              <button
                type="button"
                onClick={() => removeRisk(index)}
                className="absolute top-2 right-2 text-[var(--ds-color-danger)]"
                title="Remover Avaliação de Risco"
                aria-label="Remover Avaliação de Risco"
              >
                <Trash2 className="h-5 w-5" />
              </button>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">Perigo/Risco</label>
                  <input {...register(`avaliacao_riscos.${index}.perigo` as const)} className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">Classificação</label>
                  <input {...register(`avaliacao_riscos.${index}.classificacao` as const)} className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">Impactos</label>
                  <input {...register(`avaliacao_riscos.${index}.impactos` as const)} className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-bold text-[var(--ds-color-text-muted)]">Medidas de Controle</label>
                  <input {...register(`avaliacao_riscos.${index}.medidas_controle` as const)} className="w-full rounded-md border border-[var(--ds-color-border-default)] px-3 py-2 text-sm" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 11. Plano de Ação */}
      <div className="sst-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-[var(--ds-color-text-primary)]">11. Plano de Ação</h2>
          <button
            type="button"
            onClick={() => appendAction({ item: '', acao: '', responsavel: '', prazo: '', status: 'Pendente' })}
            className="flex items-center gap-1 rounded-md bg-[var(--ds-color-action-primary)] px-3 py-1 text-sm text-[var(--ds-color-action-primary-foreground)] hover:bg-[var(--ds-color-action-primary-hover)]"
            title="Adicionar Ação ao Plano de Ação"
            aria-label="Adicionar Ação ao Plano de Ação"
          >
            <Plus className="h-4 w-4" /> Adicionar Ação
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-[var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)] font-bold">
              <tr>
                <th className="px-3 py-2">NC/Oportunidade</th>
                <th className="px-3 py-2">Ação</th>
                <th className="px-3 py-2">Responsável</th>
                <th className="px-3 py-2">Prazo</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {actionFields.map((field, index) => (
                <tr key={field.id} className="border-t">
                  <td className="p-2"><input {...register(`plano_acao.${index}.item` as const)} className="w-full border rounded px-2 py-1" /></td>
                  <td className="p-2"><input {...register(`plano_acao.${index}.acao` as const)} className="w-full border rounded px-2 py-1" /></td>
                  <td className="p-2"><input {...register(`plano_acao.${index}.responsavel` as const)} className="w-full border rounded px-2 py-1" /></td>
                  <td className="p-2"><input {...register(`plano_acao.${index}.prazo` as const)} className="w-full border rounded px-2 py-1" /></td>
                  <td className="p-2">
                    <select {...register(`plano_acao.${index}.status` as const)} className="w-full border rounded px-2 py-1">
                      <option value="Pendente">Pendente</option>
                      <option value="Em Andamento">Em Andamento</option>
                      <option value="Concluído">Concluído</option>
                    </select>
                  </td>
                  <td className="p-2 text-center">
                    <button
                      type="button"
                      onClick={() => removeAction(index)}
                      className="text-[var(--ds-color-danger)]"
                      title="Remover Ação"
                      aria-label="Remover Ação"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 12. Conclusão */}
      <div className="sst-card p-6">
        <h2 className="mb-4 text-lg font-bold text-[var(--ds-color-text-primary)]">12. Conclusão da Auditoria</h2>
        <textarea
          {...register('conclusao')}
          rows={6}
          className="w-full rounded-md border px-3 py-2 text-sm"
          placeholder="Síntese geral do nível de conformidade HSE, principais pontos críticos e grau de maturidade..."
        />
      </div>

      {/* Ações do Formulário */}
      <div className="flex justify-end space-x-4 border-t pt-6">
        <Link
          href="/dashboard/audits"
          className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] px-6 py-2 text-sm font-medium text-[var(--ds-color-text-secondary)] hover:bg-[var(--ds-color-surface-muted)]"
        >
          Cancelar
        </Link>
        <button
          type="submit"
          disabled={loading || isSubmitting || !isValid}
          className="flex items-center space-x-2 rounded-lg bg-[var(--ds-color-action-primary)] px-10 py-2 text-sm font-bold text-[var(--ds-color-action-primary-foreground)] shadow-lg transition-all hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50 active:scale-95"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          <span>{id ? 'Salvar alterações' : 'Criar relatório formal'}</span>
        </button>
      </div>
    </form>
  );
}
