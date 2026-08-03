'use client';
import { logger } from '@/lib/logger';

import dynamic from 'next/dynamic';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { isPtOfflineSignatureBlockedError } from '@/services/ptsService';
import type {
  PtPreApprovalHistoryEntry,
  Pt,
} from '@/services/ptsService';
import { ptsService } from '@/services/ptsService';
import { aprsService } from '@/services/aprsService';
import { sitesService } from '@/services/sitesService';
import { companiesService } from '@/services/companiesService';
import { usersService } from '@/services/usersService';
import { signaturesService } from '@/services/signaturesService';
import { aiService } from '@/services/aiService';
import { mailService } from '@/services/mailService';
import type { Apr } from '@/services/aprsService';
import type { Site } from '@/services/sitesService';
import type { Company } from '@/services/companiesService';
import type { User } from '@/services/usersService';
import { useForm, FormProvider } from 'react-hook-form';
import {
  ArrowLeft,
  Save,
  CheckCircle2,
  Mail,
  ArrowRight,
  ClipboardCheck,
  FileText,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { Permission } from '@/lib/permissions';
import { AuditSection } from '@/components/AuditSection';
import { Button, buttonVariants } from '@/components/ui/button';
import { InlineLoadingState } from '@/components/ui/state';
import { StatusPill } from '@/components/ui/status-pill';
import { MobileActionBar } from '@/components/ui/mobile-action-bar';
import { PageHeader } from '@/components/layout';
import { useFormSubmit } from '@/hooks/useFormSubmit';
import { toast } from 'sonner';
import { zodResolver } from '@hookform/resolvers/zod';
import { isAiEnabled } from '@/lib/featureFlags';
import { cn } from '@/lib/utils';
import { extractApiErrorMessage } from '@/lib/error-handler';
import {
  getPtFocusLabel,
  PtFocusTarget,
} from './pt-approval-focus';
import type {
  SophieDraftChecklistSuggestion,
  SophieDraftRiskSuggestion,
  SophieWizardDraft,
} from '@/lib/sophie-draft-storage';
import {
  ptSchema,
  PtFormData,
  initialChecklists,
  alturaQuestions,
  quenteQuestions,
  confinadoQuestions,
  escavacaoQuestions,
  eletricoQuestions,
  recomendacoesQuestions,
} from './pt-schema-and-data';
import { toInputDateTimeValue, toInputDateValue } from '@/lib/date/safeFormat';
import { isUserVisibleForSite } from '@/lib/site-scoped-user-visibility';
import {
  getSensitiveDraftExpiresAt,
  isSensitiveDraftExpired,
  sanitizeSensitiveDraftValue,
} from '@/lib/sensitive-draft-sanitizer';

const SignatureModal = dynamic(
  () =>
    import('../../checklists/components/SignatureModal').then(
      (module) => module.SignatureModal,
    ),
  { ssr: false },
);

const DocumentEmailModal = dynamic(
  () =>
    import('@/components/DocumentEmailModal').then(
      (module) => module.DocumentEmailModal,
    ),
  { ssr: false },
);

const BasicInfoSection = dynamic(
  () => import('./BasicInfoSection').then((module) => module.BasicInfoSection),
);

const RiskTypesSection = dynamic(
  () => import('./RiskTypesSection').then((module) => module.RiskTypesSection),
);

const RapidRiskAnalysisSection = dynamic(
  () =>
    import('./RapidRiskAnalysisSection').then(
      (module) => module.RapidRiskAnalysisSection,
    ),
);

const ResponsibleExecutorsSection = dynamic(
  () =>
    import('./ResponsibleExecutorsSection').then(
      (module) => module.ResponsibleExecutorsSection,
    ),
);

const ChecklistSection = dynamic(() => import('./ChecklistSection'));

const EmergencyRescueSection = dynamic(
  () =>
    import('./EmergencyRescueSection').then(
      (module) => module.EmergencyRescueSection,
    ),
);

const AtmosphericReadingsSection = dynamic(
  () =>
    import('./AtmosphericReadingsSection').then(
      (module) => module.AtmosphericReadingsSection,
    ),
);

const PtEvidencePhotosSection = dynamic(
  () =>
    import('./PtEvidencePhotosSection').then(
      (module) => module.PtEvidencePhotosSection,
    ),
);

const PtPreApprovalHistoryPanel = dynamic(
  () =>
    import('./PtPreApprovalHistoryPanel').then(
      (module) => module.PtPreApprovalHistoryPanel,
    ),
);

const PtReadinessPanel = dynamic(
  () => import('./PtReadinessPanel').then((module) => module.PtReadinessPanel),
);

interface PtFormProps {
  id?: string;
}

const PT_STEPS = [
  {
    id: 1,
    title: 'Dados básicos',
    description: 'Identificação, período, empresa, obra e responsável.',
    icon: FileText,
  },
  {
    id: 2,
    title: 'Checklists',
    description: 'Bloqueios técnicos e validações obrigatórias por tipo de trabalho.',
    icon: ClipboardCheck,
  },
  {
    id: 3,
    title: 'Finalização',
    description: 'Executantes, assinaturas e fechamento operacional.',
    icon: ShieldCheck,
  },
] as const;

const PT_CHECKLIST_FLAG_FIELD_MAP = {
  trabalho_altura_checklist: 'trabalho_altura',
  trabalho_eletrico_checklist: 'eletricidade',
  trabalho_quente_checklist: 'trabalho_quente',
  trabalho_espaco_confinado_checklist: 'espaco_confinado',
  trabalho_escavacao_checklist: 'escavacao',
} as const;

const PT_FOCUS_STEP_MAP: Record<PtFocusTarget, number> = {
  'basic-info': 1,
  'risk-analysis': 1,
  checklists: 2,
  team: 3,
};

const SOPHIE_PT_CRITICAL_CHECKPOINTS = {
  trabalho_altura_checklist: ['protecao_area', 'linha_vida', 'ancoragem', 'plano_resgate'],
  trabalho_eletrico_checklist: ['profissionais_autorizados_nr10', 'nr10_verificacoes', 'loto', 'plano_emergencia'],
  trabalho_quente_checklist: ['area_livre_combustiveis', 'riscos_incendio_15m', 'extintores_adequados', 'plano_resgate'],
  trabalho_espaco_confinado_checklist: ['atmosfera_testada_antes', 'monitoramento_durante', 'isolamento_sistemas', 'procedimentos_resgate_disponiveis'],
  trabalho_escavacao_checklist: ['servicos_publicos_notificados', 'responsavel_tecnico_escavacao', 'escoramento_nr18', 'riscos_espaco_confinado_considerados'],
} as const;

const OPTIONAL_EXCAVATION_QUESTION_IDS = new Set(
  escavacaoQuestions.filter((question) => question.optional).map((question) => question.id),
);

function buildCriticalChecklistJustification(
  _label: string,
  riskLevel: string,
  title?: string,
) {
  const activityLabel = title?.trim() || 'atividade';
  return `Validação crítica pendente para ${activityLabel}. A SOPHIE marcou este item como barreira obrigatória antes da liberação devido ao risco ${riskLevel.toLowerCase()}.`;
}

function applySophieCriticalPtDefaults(
  values: Partial<PtFormData>,
  metadata?: SophieWizardDraft['metadata'],
) {
  const riskLevel = String(metadata?.riskLevel || '').trim();
  if (riskLevel !== 'Alto' && riskLevel !== 'Crítico') {
    return values;
  }

  const nextValues: Partial<PtFormData> = {
    ...values,
  };

  const title = String(values.titulo || '').trim();
  const hasSpecificPermit =
    Boolean(values.trabalho_altura) ||
    Boolean(values.eletricidade) ||
    Boolean(values.trabalho_quente) ||
    Boolean(values.espaco_confinado) ||
    Boolean(values.escavacao);

  nextValues.recomendacoes_gerais_checklist = (
    values.recomendacoes_gerais_checklist || initialChecklists.recomendacoes_gerais_checklist
  ).map((item) => ({
    ...item,
    resposta: item.resposta || 'Ciente',
  }));

  nextValues.analise_risco_rapida_checklist = (
    values.analise_risco_rapida_checklist || initialChecklists.analise_risco_rapida_checklist
  ).map((item) => {
    if (item.id === 'requer_permissao_especifica') {
      return { ...item, resposta: hasSpecificPermit ? 'Sim' : item.resposta || 'Não' };
    }
    if (item.id === 'condicao_incomum_detectada') {
      return { ...item, resposta: 'Sim' };
    }
    if (item.id === 'outra_autorizacao_especifica') {
      return { ...item, resposta: riskLevel === 'Crítico' ? 'Sim' : item.resposta };
    }
    return { ...item, resposta: item.resposta || 'Sim' };
  });

  nextValues.analise_risco_rapida_observacoes =
    values.analise_risco_rapida_observacoes?.trim() ||
    [
      `SOPHIE classificou esta PT como risco ${riskLevel.toLowerCase()}.`,
      'Realizar dupla checagem dos bloqueios críticos, confirmar permissões específicas e registrar evidências antes da liberação.',
    ].join(' ');

  (
    Object.keys(SOPHIE_PT_CRITICAL_CHECKPOINTS) as Array<
      keyof typeof SOPHIE_PT_CRITICAL_CHECKPOINTS
    >
  ).forEach((fieldName) => {
    const relatedFlag = PT_CHECKLIST_FLAG_FIELD_MAP[fieldName];
    if (!values[relatedFlag]) {
      return;
    }

    const checklistItems = (
      values[fieldName] || initialChecklists[fieldName]
    ).map((item) => {
      const criticalIds = SOPHIE_PT_CRITICAL_CHECKPOINTS[fieldName] as readonly string[];
      if (!criticalIds.includes(item.id)) {
        return item;
      }

      const response = item.resposta || 'Não';
      return {
        ...item,
        resposta: response,
        justificativa:
          item.justificativa ||
          buildCriticalChecklistJustification(item.pergunta, riskLevel, title),
      };
    });

    nextValues[fieldName] = checklistItems as PtFormData[typeof fieldName];
  });

  return nextValues;
}

type PtMutationPayload = Parameters<typeof ptsService.create>[0];

function normalizePtGenericStatus(
  value?: string | null,
): PtFormData['status'] {
  return value === 'Pendente' ? value : 'Pendente';
}

function normalizeDraftValuesForGenericPt(
  values: Partial<PtFormData>,
): Partial<PtFormData> {
  return {
    ...values,
    status: normalizePtGenericStatus(values.status),
  };
}

function normalizeOptionalUuid(value?: string | null) {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function normalizeOptionalDate(value?: string | null) {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function buildPtMutationPayload(values: PtFormData): PtMutationPayload {
  const rest = { ...values };

  return {
    ...rest,
    apr_id: normalizeOptionalUuid(rest.apr_id),
    auditado_por_id: normalizeOptionalUuid(rest.auditado_por_id),
    data_auditoria: normalizeOptionalDate(rest.data_auditoria),
    vigia_user_id: normalizeOptionalUuid(rest.vigia_user_id),
    contato_emergencia: rest.contato_emergencia?.trim() || undefined,
    plano_resgate: rest.plano_resgate?.trim() || undefined,
    ponto_encontro: rest.ponto_encontro?.trim() || undefined,
    vigia_nome: rest.vigia_nome?.trim() || undefined,
    epis_obrigatorios: rest.epis_obrigatorios?.length
      ? rest.epis_obrigatorios
      : undefined,
    medicoes_atmosfericas: rest.medicoes_atmosfericas?.length
      ? rest.medicoes_atmosfericas
      : undefined,
    executantes: (rest.executantes || []).filter((executanteId) =>
      Boolean(String(executanteId || '').trim()),
    ),
  };
}

function extractPtKeywordsFromApr(apr?: Apr | null) {
  if (!apr) return '';

  const parts = [
    apr.titulo,
    apr.descricao,
    ...(apr.risks || []).map((risk) => risk.nome),
    ...(apr.activities || []).map((activity) => activity.nome),
    ...(apr.tools || []).map((tool) => tool.nome),
    ...(apr.machines || []).map((machine) => machine.nome),
    ...(apr.risk_items || []).flatMap((item) => [
      item.atividade,
      item.agente_ambiental,
      item.condicao_perigosa,
      item.fonte_circunstancia,
      item.categoria_risco,
      item.prioridade,
    ]),
  ];

  return parts.filter(Boolean).join(' ');
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

function normalizeEmbeddedPtAprSeed(pt: Pt): Apr | null {
  const apr = pt.apr;
  if (
    !pt.apr_id ||
    !isEntityWithId<{ id: string; numero?: string; titulo?: string }>(apr) ||
    apr.id !== pt.apr_id
  ) {
    return null;
  }

  const numero = apr.numero?.trim() || pt.apr_id;
  return {
    ...apr,
    numero,
    titulo: apr.titulo?.trim() || numero,
    // A relação APR no DTO da PT não repete o tenant. O vínculo da própria
    // PT é a fonte segura do escopo para preservar a opção durante o offline.
    company_id: pt.company_id,
  } as Apr;
}

function mergeTenantScopedEntities<T extends { id: string; company_id: string }>(
  companyId: string,
  current: T[],
  incoming: T[],
): T[] {
  return dedupeById([
    ...current.filter((entity) => entity.company_id === companyId),
    ...incoming.filter((entity) => entity.company_id === companyId),
  ]);
}

function summarizeChecklistAnswers<T extends { id?: string; resposta?: string }>(
  items: T[],
  optionalIds: ReadonlySet<string> = new Set<string>(),
) {
  return items.reduce(
    (acc, item) => {
      const isOptional = item.id ? optionalIds.has(item.id) : false;
      if (!item.resposta) {
        if (isOptional) {
          return acc;
        }
        acc.unanswered += 1;
      } else if (item.resposta === 'Não' || item.resposta === 'Não aplicável') {
        acc.adverse += 1;
      }
      return acc;
    },
    { unanswered: 0, adverse: 0 },
  );
}

function hasPtSignatureChanges(
  current: Record<string, { data: string; type: string }>,
  persisted: Record<string, { id?: string; data: string; type: string }>,
) {
  const currentEntries = Object.entries(current);
  const persistedEntries = Object.entries(persisted);

  if (currentEntries.length !== persistedEntries.length) {
    return true;
  }

  return currentEntries.some(([userId, signature]) => {
    const persistedSignature = persisted[userId];
    return (
      !persistedSignature ||
      persistedSignature.data !== signature.data ||
      persistedSignature.type !== signature.type
    );
  });
}

export function PtForm({ id }: PtFormProps) {
  const { user, hasPermission } = useAuth();
  const searchParams = useSearchParams();
  const prefillCompanyId = searchParams.get('company_id') || '';
  const prefillSiteId = searchParams.get('site_id') || '';
  const prefillResponsibleId =
    searchParams.get('responsavel_id') ||
    searchParams.get('user_id') ||
    '';
  const prefillTitle = searchParams.get('title') || '';
  const prefillDescription = searchParams.get('description') || '';
  const isFieldMode = searchParams.get('field') === '1';
  const focusTarget = searchParams.get('focus') as PtFocusTarget | null;
  const [fetching, setFetching] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  
  const [aprs, setAprs] = useState<Apr[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  // Email modal
  const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);

  // Signature States
  const [isSignatureModalOpen, setIsSignatureModalOpen] = useState(false);
  const [currentSigningUser, setCurrentSigningUser] = useState<User | null>(null);
  const [signatures, setSignatures] = useState<Record<string, { data: string; type: string }>>({});
  const [persistedSignatures, setPersistedSignatures] = useState<
    Record<string, { id?: string; data: string; type: string }>
  >({});
  const [currentPt, setCurrentPt] = useState<Pt | null>(null);
  const [currentStep, setCurrentStep] = useState(1);
  const [emittingPdf, setEmittingPdf] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [sophieSuggestedRisks, setSophieSuggestedRisks] = useState<SophieDraftRiskSuggestion[]>([]);
  const [sophieMandatoryChecklists, setSophieMandatoryChecklists] = useState<SophieDraftChecklistSuggestion[]>([]);
  const [sophieRiskLevel, setSophieRiskLevel] = useState<string>('');
  const [draftSavedAt, setDraftSavedAt] = useState<string>('');
  const [preApprovalHistory, setPreApprovalHistory] = useState<PtPreApprovalHistoryEntry[]>([]);
  const [preApprovalHistoryLoading, setPreApprovalHistoryLoading] = useState(false);
  const lastHandledAprIdRef = useRef<string>('');
  const draftAutosaveTimerRef = useRef<number | undefined>(undefined);
  const aprTenantRef = useRef<string | undefined>(undefined);
  const siteTenantRef = useRef<string | undefined>(undefined);
  const userTenantRef = useRef<string | undefined>(undefined);
  const getFocusHighlightClass = useCallback(
    (target: PtFocusTarget) =>
      focusTarget === target
        ? 'scroll-mt-28 rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-action-primary)]/35 bg-[var(--ds-color-action-primary)]/8 p-3 shadow-[var(--ds-shadow-sm)]'
        : '',
    [focusTarget],
  );

  const methods = useForm<PtFormData>({
    resolver: zodResolver(ptSchema),
    defaultValues: {
      numero: '',
      titulo: prefillTitle,
      descricao: prefillDescription,
      status: 'Pendente',
      data_hora_inicio: new Date().toISOString().slice(0, 16),
      data_hora_fim: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
      company_id: prefillCompanyId,
      site_id: prefillSiteId,
      apr_id: '',
      responsavel_id: prefillResponsibleId,
      trabalho_altura: false,
      espaco_confinado: false,
      trabalho_quente: false,
      eletricidade: false,
      escavacao: false,
      ...initialChecklists,
      executantes: prefillResponsibleId ? [prefillResponsibleId] : [],
      auditado_por_id: '',
      data_auditoria: '',
      resultado_auditoria: '',
      notas_auditoria: '',
      contato_emergencia: '',
      plano_resgate: '',
      ponto_encontro: '',
      vigia_user_id: '',
      vigia_nome: '',
      epis_obrigatorios: [],
      medicoes_atmosfericas: [],
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    trigger,
  } = methods;

  const draftStorageKey = useMemo(
    () => (id ? null : `gst.pt.wizard.draft.${user?.company_id || 'default'}`),
    [id, user?.company_id],
  );

  useEffect(() => {
    if (!focusTarget) return;

    const nextStep = PT_FOCUS_STEP_MAP[focusTarget];
    if (nextStep) {
      setCurrentStep(nextStep);
    }
  }, [focusTarget]);

  useEffect(() => {
    if (!focusTarget) return;

    const timeout = window.setTimeout(() => {
      const targetElement = document.querySelector<HTMLElement>(
        `[data-pt-focus-target="${focusTarget}"]`,
      );

      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 80);

    return () => window.clearTimeout(timeout);
  }, [currentStep, focusTarget]);
  const legacyDraftStorageKey = useMemo(
    () => (id ? null : `compliancex.pt.wizard.draft.${user?.company_id || 'default'}`),
    [id, user?.company_id],
  );

  const selectedCompanyId = watch('company_id');
  const selectedSiteId = watch('site_id');
  const selectedResponsavelId = watch('responsavel_id');
  const selectedAprId = watch('apr_id');
  const selectedAuditadoPorId = watch('auditado_por_id');
  const selectedTitle = watch('titulo');
  const workAtHeight = watch('trabalho_altura');
  const workElectric = watch('eletricidade');
  const workHot = watch('trabalho_quente');
  const workConfined = watch('espaco_confinado');
  const workExcavation = watch('escavacao');
  const filteredSites = sites.filter(site => site.company_id === selectedCompanyId);
  const filteredAprs = aprs.filter(apr => apr.company_id === selectedCompanyId);
  const filteredUsers = users.filter(
    user => isUserVisibleForSite(user, selectedCompanyId, selectedSiteId),
  );
  const watchedExecutanteIds = watch('executantes');
  const selectedExecutanteIds = useMemo(
    () => watchedExecutanteIds ?? [],
    [watchedExecutanteIds],
  );
  const selectedCompany = companies.find((company) => company.id === selectedCompanyId);
  const selectedSite = filteredSites.find((site) => site.id === selectedSiteId);
  const selectedResponsavel = filteredUsers.find((responsavel) => responsavel.id === selectedResponsavelId);
  const selectedApr = filteredAprs.find((apr) => apr.id === selectedAprId);
  const isPtReadOnly =
    Boolean(currentPt?.pdf_file_key) ||
    (Boolean(id) && currentPt?.status !== 'Pendente');
  const ptReadOnlyMessage = currentPt?.pdf_file_key
    ? 'Esta PT já possui PDF final governado e entrou em modo somente leitura.'
    : currentPt?.status && currentPt.status !== 'Pendente'
      ? `A PT está com status ${currentPt.status} e não aceita mais alterações por fluxo comum.`
      : null;
  // Evidências (fotos/medições) seguem regra própria: mutáveis em
  // Pendente/Aprovada/Expirada enquanto não houver PDF final governado.
  const canUploadPhotos =
    Boolean(id) &&
    !currentPt?.pdf_file_key &&
    ['Pendente', 'Aprovada', 'Expirada'].includes(currentPt?.status ?? '');
  const canAppendReadings =
    Boolean(id) &&
    !currentPt?.pdf_file_key &&
    ['Pendente', 'Aprovada'].includes(currentPt?.status ?? '');
  const refetchCurrentPt = useCallback(async () => {
    if (!id) return;
    try {
      const fresh = await ptsService.findOne(id);
      setCurrentPt(fresh);
    } catch (error) {
      logger.error('Erro ao atualizar PT após mutação de evidência:', error);
    }
  }, [id]);
  const canManageMail = hasPermission(Permission.CAN_MANAGE_MAIL);
  const rapidRiskChecklist =
    watch('analise_risco_rapida_checklist') ?? initialChecklists.analise_risco_rapida_checklist;
  const rapidRiskObservacoes = watch('analise_risco_rapida_observacoes') ?? '';
  const generalChecklist =
    watch('recomendacoes_gerais_checklist') ?? initialChecklists.recomendacoes_gerais_checklist;
  const workAtHeightChecklist =
    watch('trabalho_altura_checklist') ?? initialChecklists.trabalho_altura_checklist;
  const workElectricChecklist =
    watch('trabalho_eletrico_checklist') ?? initialChecklists.trabalho_eletrico_checklist;
  const workHotChecklist =
    watch('trabalho_quente_checklist') ?? initialChecklists.trabalho_quente_checklist;
  const workConfinedChecklist =
    watch('trabalho_espaco_confinado_checklist') ?? initialChecklists.trabalho_espaco_confinado_checklist;
  const workExcavationChecklist =
    watch('trabalho_escavacao_checklist') ?? initialChecklists.trabalho_escavacao_checklist;
  const selectedRiskTypes = [
    workAtHeight && 'Altura',
    workElectric && 'Eletricidade',
    workHot && 'Trabalho a quente',
    workConfined && 'Espaço confinado',
    workExcavation && 'Escavação',
  ].filter(Boolean) as string[];
  const checklistGroupsEnabled = [
    true,
    workAtHeight,
    workElectric,
    workHot,
    workConfined,
    workExcavation,
  ].filter(Boolean).length;
  const completedSignatures = Object.keys(signatures).length;
  const pendingSignatures = Math.max(0, selectedExecutanteIds.length - completedSignatures);
  const hasPendingSignatureChanges = useMemo(
    () => hasPtSignatureChanges(signatures, persistedSignatures),
    [persistedSignatures, signatures],
  );

  const generalChecklistSummary = useMemo(
    () => summarizeChecklistAnswers(generalChecklist),
    [generalChecklist],
  );
  const workAtHeightSummary = useMemo(
    () => summarizeChecklistAnswers(workAtHeightChecklist),
    [workAtHeightChecklist],
  );
  const workElectricSummary = useMemo(
    () => summarizeChecklistAnswers(workElectricChecklist),
    [workElectricChecklist],
  );
  const workHotSummary = useMemo(
    () => summarizeChecklistAnswers(workHotChecklist),
    [workHotChecklist],
  );
  const workConfinedSummary = useMemo(
    () => summarizeChecklistAnswers(workConfinedChecklist),
    [workConfinedChecklist],
  );
  const workExcavationSummary = useMemo(
    () => summarizeChecklistAnswers(workExcavationChecklist, OPTIONAL_EXCAVATION_QUESTION_IDS),
    [workExcavationChecklist],
  );
  const unansweredChecklistItems =
    generalChecklistSummary.unanswered +
    (workAtHeight ? workAtHeightSummary.unanswered : 0) +
    (workElectric ? workElectricSummary.unanswered : 0) +
    (workHot ? workHotSummary.unanswered : 0) +
    (workConfined ? workConfinedSummary.unanswered : 0) +
    (workExcavation ? workExcavationSummary.unanswered : 0);
  const adverseChecklistItems =
    generalChecklistSummary.adverse +
    (workAtHeight ? workAtHeightSummary.adverse : 0) +
    (workElectric ? workElectricSummary.adverse : 0) +
    (workHot ? workHotSummary.adverse : 0) +
    (workConfined ? workConfinedSummary.adverse : 0) +
    (workExcavation ? workExcavationSummary.adverse : 0);
  const hasRapidRiskBasicNo = rapidRiskChecklist.some(
    (item) => item.secao === 'basica' && item.resposta === 'Não',
  );
  const readinessBlockers = useMemo(() => {
    const blockers: string[] = [];

    if (!selectedCompanyId) blockers.push('Selecionar a empresa da PT.');
    if (!selectedSiteId) blockers.push('Selecionar a obra/site da PT.');
    if (!selectedResponsavelId) blockers.push('Definir o responsável pela liberação.');
    if (!String(selectedTitle || '').trim()) blockers.push('Informar um título claro da atividade.');
    if (selectedRiskTypes.length === 0) blockers.push('Marcar pelo menos um tipo de trabalho crítico ou confirmar que a PT é geral.');
    if (hasRapidRiskBasicNo && !String(rapidRiskObservacoes || '').trim()) {
      blockers.push('Registrar ações corretivas na análise de risco rápida.');
    }
    if (unansweredChecklistItems > 0) {
      blockers.push(`${unansweredChecklistItems} item(ns) de checklist ainda sem resposta.`);
    }
    if (selectedExecutanteIds.length === 0) {
      blockers.push('Selecionar ao menos um executante.');
    }
    if (pendingSignatures > 0) {
      blockers.push(`${pendingSignatures} assinatura(s) ainda pendente(s).`);
    }

    return blockers;
  }, [
    hasRapidRiskBasicNo,
    pendingSignatures,
    rapidRiskObservacoes,
    selectedCompanyId,
    selectedExecutanteIds.length,
    selectedResponsavelId,
    selectedRiskTypes.length,
    selectedSiteId,
    selectedTitle,
    unansweredChecklistItems,
  ]);
  const readyForRelease = readinessBlockers.length === 0;
  const currentStepConfig = PT_STEPS.find((step) => step.id === currentStep) ?? PT_STEPS[0];
  const currentStepHighlights =
    currentStep === 1
      ? [
          { label: 'Empresa', value: selectedCompany?.razao_social || 'Definir contexto' },
          { label: 'Riscos', value: `${selectedRiskTypes.length} marcados` },
        ]
      : currentStep === 2
        ? [
            { label: 'Checklists', value: `${checklistGroupsEnabled} ativos` },
            { label: 'Pendências', value: `${unansweredChecklistItems} respostas pendentes` },
          ]
        : [
            { label: 'Executantes', value: `${selectedExecutanteIds.length} vinculados` },
            { label: 'Assinaturas', value: `${pendingSignatures} pendentes` },
          ];
  const currentStepSidebarTitle =
    currentStep === 1
      ? 'Contexto da emissão'
      : currentStep === 2
        ? 'Leitura dos checklists'
        : 'Fechamento da liberação';
  const currentStepSidebarDescription =
    currentStep === 1
      ? 'Defina empresa, obra e responsável antes de aprofundar os riscos.'
      : currentStep === 2
        ? 'Use esta lateral para enxergar rapidamente bloqueios e respostas críticas.'
        : 'Confirme executantes, assinaturas e bloqueios finais antes de salvar.';
  const sidebarSummaryRows =
    currentStep === 1
      ? [
          { label: 'Empresa', value: selectedCompany?.razao_social || 'Não definida' },
          { label: 'Obra', value: selectedSite?.nome || 'Não definida' },
          { label: 'Responsável', value: selectedResponsavel?.nome || 'Não definido' },
          ...(selectedApr?.numero
            ? [{ label: 'APR vinculada', value: selectedApr.numero }]
            : []),
        ]
      : currentStep === 2
        ? [
            { label: 'Tipos de trabalho', value: selectedRiskTypes.length > 0 ? `${selectedRiskTypes.length} ativos` : 'Nenhum marcado' },
            { label: 'Checklists', value: `${checklistGroupsEnabled} habilitados` },
            { label: 'Pendências', value: `${unansweredChecklistItems} resposta(s)` },
            { label: 'Respostas críticas', value: `${adverseChecklistItems} item(ns)` },
          ]
        : [
            { label: 'Responsável', value: selectedResponsavel?.nome || 'Não definido' },
            { label: 'Executantes', value: `${selectedExecutanteIds.length} vinculados` },
            { label: 'Assinaturas', value: `${completedSignatures} registradas` },
            { label: 'Situação', value: readyForRelease ? 'Liberável' : 'Com bloqueios' },
          ];
  const sidebarMetrics =
    currentStep === 1
      ? [
          { label: 'Riscos marcados', value: String(selectedRiskTypes.length), tone: 'info' as const },
          { label: 'Checklists ativos', value: String(checklistGroupsEnabled), tone: 'warning' as const },
        ]
      : currentStep === 2
        ? [
            { label: 'Respostas pendentes', value: String(unansweredChecklistItems), tone: 'warning' as const },
            { label: 'Críticas sinalizadas', value: String(adverseChecklistItems), tone: 'default' as const },
          ]
        : [
            { label: 'Executantes', value: String(selectedExecutanteIds.length), tone: 'success' as const },
            { label: 'Assinaturas', value: String(completedSignatures), tone: 'default' as const },
          ];
  const currentStepSupportingNote =
    currentStep === 1
      ? 'Uma base bem definida evita retrabalho e bloqueios nas etapas seguintes.'
      : currentStep === 2
        ? adverseChecklistItems > 0 || unansweredChecklistItems > 0
          ? 'Respostas críticas ou pendentes precisam ser resolvidas antes do fechamento.'
          : 'Os checklists estão consistentes para seguir ao fechamento.'
        : readyForRelease
          ? 'A PT está consistente para salvamento final e emissão do documento.'
          : 'Revise o painel de prontidão para remover os bloqueios antes de salvar.';
  const currentStepSupportingNoteToneClass =
    currentStep === 2
      ? adverseChecklistItems > 0 || unansweredChecklistItems > 0
        ? 'border-[color:var(--ds-color-warning)]/20 bg-[color:var(--ds-color-warning-subtle)] text-[color:var(--ds-color-warning)]'
        : 'border-[color:var(--ds-color-success)]/20 bg-[color:var(--ds-color-success-subtle)] text-[color:var(--ds-color-success)]'
      : currentStep === 3
        ? readyForRelease
          ? 'border-[color:var(--ds-color-success)]/20 bg-[color:var(--ds-color-success-subtle)] text-[color:var(--ds-color-success)]'
          : 'border-[color:var(--ds-color-warning)]/20 bg-[color:var(--ds-color-warning-subtle)] text-[color:var(--ds-color-warning)]'
        : 'border-[color:var(--ds-color-info)]/18 bg-[color:var(--ds-color-info-subtle)] text-[color:var(--ds-color-info)]';

  const normalizeSuggestionText = useCallback(
    (value: string) =>
      String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase(),
    [],
  );

  const buildChecklistSuggestionHref = useCallback(
    (suggestion: SophieDraftChecklistSuggestion) => {
      const params = new URLSearchParams();
      params.set('templateId', suggestion.id);
      if (selectedCompanyId) params.set('company_id', selectedCompanyId);
      if (selectedSiteId) params.set('site_id', selectedSiteId);
      if (selectedTitle) params.set('title', `${selectedTitle} • ${suggestion.label}`);
      if (methods.getValues('descricao')) {
        params.set('description', String(methods.getValues('descricao')));
      }
      return `/dashboard/checklists/new?${params.toString()}`;
    },
    [methods, selectedCompanyId, selectedSiteId, selectedTitle],
  );

  const resolvePtRiskFlagsFromText = useCallback(
    (value: string) => {
      const normalized = normalizeSuggestionText(value);
      return {
        trabalho_altura:
          /altura|queda|escada|andaime|telhado|linha de vida/.test(normalized),
        eletricidade:
          /eletric|choque|arco|painel|subestacao|energiz/.test(normalized),
        trabalho_quente:
          /quente|solda|fumos|faisca|incend|queimad|oxicorte/.test(normalized),
        espaco_confinado:
          /confinado|atmosfera|asfix|resgate|tanque|silo|galeria/.test(normalized),
        escavacao:
          /escava|vala|talude|soterr|subterr/.test(normalized),
      };
    },
    [normalizeSuggestionText],
  );

  const applyPtFlags = useCallback(
    (flags: Partial<Record<(typeof PT_CHECKLIST_FLAG_FIELD_MAP)[keyof typeof PT_CHECKLIST_FLAG_FIELD_MAP], boolean>>) => {
      const changedLabels: string[] = [];

      if (flags.trabalho_altura && !workAtHeight) {
        setValue('trabalho_altura', true, { shouldDirty: true, shouldValidate: true });
        changedLabels.push('Altura');
      }
      if (flags.eletricidade && !workElectric) {
        setValue('eletricidade', true, { shouldDirty: true, shouldValidate: true });
        changedLabels.push('Eletricidade');
      }
      if (flags.trabalho_quente && !workHot) {
        setValue('trabalho_quente', true, { shouldDirty: true, shouldValidate: true });
        changedLabels.push('Trabalho a quente');
      }
      if (flags.espaco_confinado && !workConfined) {
        setValue('espaco_confinado', true, { shouldDirty: true, shouldValidate: true });
        changedLabels.push('Espaço confinado');
      }
      if (flags.escavacao && !workExcavation) {
        setValue('escavacao', true, { shouldDirty: true, shouldValidate: true });
        changedLabels.push('Escavação');
      }

      return changedLabels;
    },
    [setValue, workAtHeight, workConfined, workElectric, workExcavation, workHot],
  );

  const applySuggestedPtRisk = useCallback(
    (suggestion: SophieDraftRiskSuggestion) => {
      const changes = applyPtFlags(resolvePtRiskFlagsFromText(`${suggestion.label} ${suggestion.category || ''}`));
      if (changes.length > 0) {
        toast.success(`SOPHIE ativou os grupos: ${changes.join(', ')}.`);
        return;
      }

      toast.info(`O risco ${suggestion.label} já está refletido na PT ou não exige um grupo adicional.`);
    },
    [applyPtFlags, resolvePtRiskFlagsFromText],
  );

  const applyAllSuggestedPtRisks = useCallback(() => {
    const allFlags = sophieSuggestedRisks.reduce(
      (acc, suggestion) => {
        const current = resolvePtRiskFlagsFromText(`${suggestion.label} ${suggestion.category || ''}`);
        return {
          trabalho_altura: acc.trabalho_altura || current.trabalho_altura,
          eletricidade: acc.eletricidade || current.eletricidade,
          trabalho_quente: acc.trabalho_quente || current.trabalho_quente,
          espaco_confinado: acc.espaco_confinado || current.espaco_confinado,
          escavacao: acc.escavacao || current.escavacao,
        };
      },
      {
        trabalho_altura: false,
        eletricidade: false,
        trabalho_quente: false,
        espaco_confinado: false,
        escavacao: false,
      },
    );

    const changes = applyPtFlags(allFlags);
    if (changes.length > 0) {
      toast.success(`Grupos ativados na PT: ${changes.join(', ')}.`);
    } else {
      toast.info('Os grupos sugeridos pela SOPHIE já estão ativos nesta PT.');
    }
  }, [applyPtFlags, resolvePtRiskFlagsFromText, sophieSuggestedRisks]);

  const applyMandatoryChecklistSuggestion = useCallback(
    (suggestion: SophieDraftChecklistSuggestion) => {
      const mappedField =
        PT_CHECKLIST_FLAG_FIELD_MAP[
          suggestion.id as keyof typeof PT_CHECKLIST_FLAG_FIELD_MAP
        ];

      if (!mappedField) {
        toast.info('Este checklist sugerido deve ser aberto como checklist operacional complementar.');
        return;
      }

      const changes = applyPtFlags({ [mappedField]: true });
      if (changes.length > 0) {
        toast.success(`Checklist mandatório aplicado: ${suggestion.label}.`);
      } else {
        toast.info(`O checklist ${suggestion.label} já está ativo na PT.`);
      }
    },
    [applyPtFlags],
  );

  const applyAllMandatoryChecklistSuggestions = useCallback(() => {
    const allFlags = sophieMandatoryChecklists.reduce(
      (acc, suggestion) => {
        const mappedField =
          PT_CHECKLIST_FLAG_FIELD_MAP[
            suggestion.id as keyof typeof PT_CHECKLIST_FLAG_FIELD_MAP
          ];
        if (mappedField) {
          acc[mappedField] = true;
        }
        return acc;
      },
      {} as Partial<Record<(typeof PT_CHECKLIST_FLAG_FIELD_MAP)[keyof typeof PT_CHECKLIST_FLAG_FIELD_MAP], boolean>>,
    );

    const changes = applyPtFlags(allFlags);
    if (changes.length > 0) {
      toast.success(`Checklists mandatórios ativados: ${changes.join(', ')}.`);
      setCurrentStep(2);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      toast.info('Os checklists mandatórios sugeridos já estão ativos nesta PT.');
    }
  }, [applyPtFlags, sophieMandatoryChecklists]);

  const handleCompanyChange = useCallback(
    (companyId: string) => {
      setValue('site_id', '', { shouldDirty: true, shouldValidate: true });
      setValue('apr_id', '', { shouldDirty: true, shouldValidate: false });
      setValue('responsavel_id', '', { shouldDirty: true, shouldValidate: true });
      setValue('auditado_por_id', '', { shouldDirty: true, shouldValidate: false });
      setValue('executantes', [], { shouldDirty: true, shouldValidate: true });
      setSignatures({});
      setPersistedSignatures({});
      lastHandledAprIdRef.current = '';

      if (companyId) {
        toast.info('Empresa alterada. Obra, APR, responsável, executantes e assinaturas foram limpos para evitar inconsistências.');
      }
    },
    [setValue],
  );

  const handleAprLinked = useCallback(
    async (aprId: string) => {
      if (aprId && lastHandledAprIdRef.current === aprId) {
        return;
      }
      lastHandledAprIdRef.current = aprId;

      if (!aprId) {
        toast.info('APR desvinculada. A PT mantém os dados já preenchidos.');
        return;
      }

      try {
        const apr = filteredAprs.find((currentApr) => currentApr.id === aprId) || (await aprsService.findOne(aprId));
        const currentValues = methods.getValues();

        if (!currentValues.company_id) {
          setValue('company_id', apr.company_id, { shouldDirty: true, shouldValidate: true });
        }
        if (!currentValues.site_id && apr.site_id) {
          setValue('site_id', apr.site_id, { shouldDirty: true, shouldValidate: true });
        }
        if (!String(currentValues.titulo || '').trim()) {
          setValue('titulo', apr.titulo, { shouldDirty: true, shouldValidate: true });
        }
        if (!String(currentValues.descricao || '').trim() && apr.descricao) {
          setValue('descricao', apr.descricao, { shouldDirty: true, shouldValidate: false });
        }

        const eligibleResponsibleId =
          apr.elaborador?.id && apr.elaborador.company_id === apr.company_id
            ? apr.elaborador.id
            : '';
        if (!currentValues.responsavel_id && eligibleResponsibleId) {
          setValue('responsavel_id', eligibleResponsibleId, {
            shouldDirty: true,
            shouldValidate: true,
          });
        }

        if ((currentValues.executantes || []).length === 0 && apr.participants?.length > 0) {
          const participantIds = apr.participants
            .filter((participant) => participant.company_id === apr.company_id)
            .map((participant) => participant.id);
          if (participantIds.length > 0) {
            setValue('executantes', participantIds, {
              shouldDirty: true,
              shouldValidate: true,
            });
          }
        }

        const aprFlagChanges = applyPtFlags(
          resolvePtRiskFlagsFromText(extractPtKeywordsFromApr(apr)),
        );

        toast.success('APR vinculada com sucesso.', {
          description:
            aprFlagChanges.length > 0
              ? `A SOPHIE ativou grupos coerentes com a APR: ${aprFlagChanges.join(', ')}.`
              : 'Título, descrição e contexto operacional foram reaproveitados quando estavam em branco.',
        });
      } catch (error) {
        logger.error('Erro ao aplicar contexto da APR na PT:', error);
        toast.error('Não foi possível aproveitar automaticamente o contexto da APR.');
      }
    },
    [applyPtFlags, filteredAprs, methods, resolvePtRiskFlagsFromText, setValue],
  );

  const persistDraftSnapshot = useCallback(
    (
      options: {
        values?: Partial<PtFormData>;
        step?: number;
        showToast?: boolean;
      } = {},
    ) => {
      if (!draftStorageKey || typeof window === 'undefined' || id) {
        return;
      }

      const savedAt = new Date().toISOString();
      const snapshotValues = options.values ?? methods.getValues();
      const snapshotStep = options.step ?? currentStep;

      window.localStorage.setItem(
        draftStorageKey,
        JSON.stringify({
          savedAt,
          expiresAt: getSensitiveDraftExpiresAt(savedAt),
          step: snapshotStep,
          values: sanitizeSensitiveDraftValue(snapshotValues),
          signatures: {},
          metadata: {
            suggestedRisks: sophieSuggestedRisks,
            mandatoryChecklists: sophieMandatoryChecklists,
            riskLevel: sophieRiskLevel,
          },
        }),
      );
      setDraftSavedAt(savedAt);

      if (options.showToast) {
        toast.success('Rascunho local da PT atualizado.');
      }
    },
    [
      currentStep,
      draftStorageKey,
      id,
      methods,
      sophieMandatoryChecklists,
      sophieRiskLevel,
      sophieSuggestedRisks,
    ],
  );

  const saveDraftSnapshot = useCallback(() => {
    persistDraftSnapshot({ showToast: true });
  }, [persistDraftSnapshot]);

  const { handleSubmit: onSubmit, loading } = useFormSubmit(
    async (data: PtFormData) => {
      let ptId = id;
      let queuedOffline = false;
      const payload = buildPtMutationPayload({
        ...data,
        status: id ? data.status : normalizePtGenericStatus(data.status),
      });
      const allowOfflineQueue = !hasPendingSignatureChanges;

      try {
        if (id) {
          const updatedPt = await ptsService.update(id, payload, {
            allowOfflineQueue,
          });
          queuedOffline =
            'offlineQueued' in updatedPt && Boolean(updatedPt.offlineQueued);
        } else {
          const newPt = await ptsService.create(payload, { allowOfflineQueue });
          ptId = newPt.id;
          queuedOffline =
            'offlineQueued' in newPt && Boolean(newPt.offlineQueued);
        }
      } catch (error) {
        if (isPtOfflineSignatureBlockedError(error)) {
          saveDraftSnapshot();
        }
        throw error;
      }

      if (queuedOffline) {
        return { offlineQueued: true, ptId };
      }

      // Persist signatures only after the PT entity exists.
      if (ptId) {
        const signaturesToDelete = Object.entries(persistedSignatures).filter(
          ([userId, persisted]) => {
            const current = signatures[userId];
            return (
              !current ||
              current.data !== persisted.data ||
              current.type !== persisted.type
            );
          },
        );
        const signaturesToCreate = Object.entries(signatures).filter(
          ([userId, current]) => {
            const persisted = persistedSignatures[userId];
            return (
              !persisted ||
              current.data !== persisted.data ||
              current.type !== persisted.type
            );
          },
        );

        const signatureIdsToDelete = signaturesToDelete
          .map(([, persisted]) => persisted.id)
          .filter((signatureId): signatureId is string => Boolean(signatureId));

        if (signatureIdsToDelete.length > 0) {
          await Promise.all(
            signatureIdsToDelete.map((signatureId) =>
              signaturesService.deleteById(signatureId),
            ),
          );
        }

        if (signaturesToCreate.length > 0) {
          await Promise.all(
            signaturesToCreate.map(([userId, sig]) =>
              signaturesService.create({
                user_id: userId,
                document_id: ptId as string,
                document_type: 'PT',
                signature_data: sig.data,
                type: sig.type,
              }),
            ),
          );
        }
      }

      return { offlineQueued: false, ptId };
    },
    {
      successMessage: (result) => {
        const queuedOffline =
          typeof result === 'object' &&
          result !== null &&
          'offlineQueued' in result &&
          Boolean(result.offlineQueued);

        if (queuedOffline) {
          return 'PT salva na fila offline. Vamos sincronizar quando a conexão voltar.';
        }

        return id
          ? 'Permissão de Trabalho atualizada com sucesso!'
          : 'Permissão de Trabalho cadastrada com sucesso!';
      },
      redirectTo: '/dashboard/pts',
      context: 'PT',
      skipRedirect: (result) =>
        typeof result === 'object' &&
        result !== null &&
        'offlineQueued' in result &&
        Boolean(result.offlineQueued),
      onSuccess: (result) => {
        const queuedOffline =
          typeof result === 'object' &&
          result !== null &&
          'offlineQueued' in result &&
          Boolean(result.offlineQueued);

        if (queuedOffline) {
          saveDraftSnapshot();
          return;
        }

        if (draftStorageKey && typeof window !== 'undefined') {
          window.localStorage.removeItem(draftStorageKey);
        }
        if (legacyDraftStorageKey && typeof window !== 'undefined') {
          window.localStorage.removeItem(legacyDraftStorageKey);
        }
        setDraftSavedAt('');
      },
    }
  );

  useEffect(() => {
    async function loadData() {
      try {
        let companySeedId = user?.company_id || '';

        const loadCompanies = async (currentCompanyId?: string) => {
          let nextCompanies: Company[] = [];

          if (user?.profile?.nome === 'Administrador Geral') {
            try {
              const companiesPage = await companiesService.findPaginated({
                page: 1,
                limit: 100,
              });
              nextCompanies = companiesPage.data;
            } catch {
              // sem permissão para listar todas as empresas — seguir com lista vazia
            }

            if (
              currentCompanyId &&
              !nextCompanies.some((company) => company.id === currentCompanyId)
            ) {
              try {
                const currentCompany =
                  await companiesService.findOne(currentCompanyId);
                nextCompanies = dedupeById([currentCompany, ...nextCompanies]);
              } catch {
                nextCompanies = dedupeById(nextCompanies);
              }
            }
          } else if (currentCompanyId) {
            try {
              const currentCompany =
                await companiesService.findOne(currentCompanyId);
              nextCompanies = [currentCompany];
            } catch {
              nextCompanies = [];
            }
          }

          setCompanies(dedupeById(nextCompanies));
        };

        if (id) {
          setPreApprovalHistoryLoading(true);
          const [ptResult, sigsResult, historyResult] = await Promise.allSettled([
            ptsService.findOne(id),
            signaturesService.findByDocument(id, 'PT'),
            ptsService.getPreApprovalHistory(id),
          ]);
          if (ptResult.status !== 'fulfilled') {
            throw ptResult.reason;
          }
          const pt = ptResult.value;
          const sigs = sigsResult.status === 'fulfilled' ? sigsResult.value : [];
          const history =
            historyResult.status === 'fulfilled' ? historyResult.value : [];
          if (sigsResult.status === 'rejected') {
            toast.warning(
              await extractApiErrorMessage(
                sigsResult.reason,
                'As assinaturas existentes não puderam ser carregadas agora. A PT foi aberta com dados parciais.',
              ),
            );
          }
          if (historyResult.status === 'rejected') {
            toast.warning(
              await extractApiErrorMessage(
                historyResult.reason,
                'O histórico de pré-aprovação não pôde ser carregado agora.',
              ),
            );
          }
          setPreApprovalHistory(history);
          setCurrentPt(pt);

          // Pre-populate signatures state from backend
          const sigMap: Record<string, { data: string; type: string }> = {};
          const persistedSigMap: Record<
            string,
            { id?: string; data: string; type: string }
          > = {};
          sigs.forEach(s => {
            if (!s.user_id) return;
            sigMap[s.user_id] = { data: s.signature_data, type: s.type };
            persistedSigMap[s.user_id] = {
              id: s.id,
              data: s.signature_data,
              type: s.type,
            };
          });
          setSignatures(sigMap);
          setPersistedSignatures(persistedSigMap);
          companySeedId = pt.company_id;
          // Embedded relations are trusted seeds for the PT being edited. Record
          // their owner before reset changes the watched company, so initialization
          // is not mistaken for a real tenant switch.
          aprTenantRef.current = pt.company_id;
          siteTenantRef.current = pt.company_id;
          userTenantRef.current = pt.company_id;
          const embeddedAprSeed = normalizeEmbeddedPtAprSeed(pt);
          setAprs(embeddedAprSeed ? [embeddedAprSeed] : []);
          setSites(
            dedupeById(
              isEntityWithId<Site>(pt.site) ? [pt.site] : [],
            ),
          );
          setUsers(
            dedupeById([
              ...(isEntityWithId<User>(pt.responsavel) ? [pt.responsavel] : []),
              ...((pt.executantes || []) as User[]),
              ...(isEntityWithId<User>(pt.auditado_por) ? [pt.auditado_por] : []),
            ]),
          );

          reset({
            ...initialChecklists,
            numero: pt.numero,
            titulo: pt.titulo,
            descricao: pt.descricao || '',
            data_hora_inicio: toInputDateTimeValue(pt.data_hora_inicio),
            data_hora_fim: toInputDateTimeValue(pt.data_hora_fim),
            status: pt.status,
            company_id: pt.company_id,
            site_id: pt.site_id,
            apr_id: pt.apr_id,
            responsavel_id: pt.responsavel_id,
            trabalho_altura: pt.trabalho_altura,
            espaco_confinado: pt.espaco_confinado,
            trabalho_quente: pt.trabalho_quente,
            eletricidade: pt.eletricidade,
            escavacao: pt.escavacao || false,
            analise_risco_rapida_checklist:
              pt.analise_risco_rapida_checklist &&
              pt.analise_risco_rapida_checklist.length > 0 ? pt.analise_risco_rapida_checklist : initialChecklists.analise_risco_rapida_checklist,
            analise_risco_rapida_observacoes:
              pt.analise_risco_rapida_observacoes || '',
            recomendacoes_gerais_checklist: pt.recomendacoes_gerais_checklist?.length ? pt.recomendacoes_gerais_checklist : initialChecklists.recomendacoes_gerais_checklist,
            trabalho_altura_checklist: pt.trabalho_altura_checklist?.length ? pt.trabalho_altura_checklist : initialChecklists.trabalho_altura_checklist,
            trabalho_eletrico_checklist: pt.trabalho_eletrico_checklist?.length ? pt.trabalho_eletrico_checklist : initialChecklists.trabalho_eletrico_checklist,
            trabalho_quente_checklist: pt.trabalho_quente_checklist?.length ? pt.trabalho_quente_checklist : initialChecklists.trabalho_quente_checklist,
            trabalho_espaco_confinado_checklist: pt.trabalho_espaco_confinado_checklist?.length ? pt.trabalho_espaco_confinado_checklist : initialChecklists.trabalho_espaco_confinado_checklist,
            trabalho_escavacao_checklist: pt.trabalho_escavacao_checklist?.length ? pt.trabalho_escavacao_checklist : initialChecklists.trabalho_escavacao_checklist,
            executantes: pt.executantes.map((e: User) => e.id),
            auditado_por_id: pt.auditado_por_id || '',
            data_auditoria: toInputDateValue(pt.data_auditoria),
            resultado_auditoria: pt.resultado_auditoria || '',
            notas_auditoria: pt.notas_auditoria || '',
            contato_emergencia: pt.contato_emergencia || '',
            plano_resgate: pt.plano_resgate || '',
            ponto_encontro: pt.ponto_encontro || '',
            vigia_user_id: pt.vigia_user_id || '',
            vigia_nome: pt.vigia_nome || '',
            epis_obrigatorios: pt.epis_obrigatorios || [],
            medicoes_atmosfericas: pt.medicoes_atmosfericas || [],
          });
          setSophieSuggestedRisks([]);
          setSophieMandatoryChecklists([]);
          setSophieRiskLevel('');
        } else if (draftStorageKey && typeof window !== 'undefined') {
          setCurrentPt(null);
          setPreApprovalHistory([]);
          setPersistedSignatures({});
          const rawDraft =
            window.localStorage.getItem(draftStorageKey) ||
            (legacyDraftStorageKey
              ? window.localStorage.getItem(legacyDraftStorageKey)
              : null);
          if (rawDraft) {
            const parsedDraft = JSON.parse(rawDraft) as SophieWizardDraft & {
              savedAt?: string | number;
              expiresAt?: string | number;
              values?: Partial<PtFormData>;
            };

            if (
              isSensitiveDraftExpired({
                savedAt: parsedDraft.savedAt,
                expiresAt: parsedDraft.expiresAt,
              })
            ) {
              window.localStorage.removeItem(draftStorageKey);
              if (legacyDraftStorageKey) {
                window.localStorage.removeItem(legacyDraftStorageKey);
              }
              setSophieSuggestedRisks([]);
              setSophieMandatoryChecklists([]);
              setSophieRiskLevel('');
            } else {
              const sanitizedDraftValues = sanitizeSensitiveDraftValue(
                parsedDraft.values || {},
              ) as Partial<PtFormData>;
              const savedAt = parsedDraft.savedAt || new Date().toISOString();

              window.localStorage.setItem(
                draftStorageKey,
                JSON.stringify({
                  savedAt,
                  expiresAt: getSensitiveDraftExpiresAt(savedAt),
                  step: parsedDraft.step,
                  values: sanitizedDraftValues,
                  signatures: {},
                  metadata: parsedDraft.metadata || {},
                }),
              );
              if (legacyDraftStorageKey) {
                window.localStorage.removeItem(legacyDraftStorageKey);
              }

              if (Object.keys(sanitizedDraftValues).length > 0) {
                const preparedValues = applySophieCriticalPtDefaults(
                  normalizeDraftValuesForGenericPt(sanitizedDraftValues),
                  parsedDraft.metadata,
                );
                reset({
                  ...methods.getValues(),
                  ...preparedValues,
                });
                companySeedId = preparedValues.company_id || companySeedId;
              }

              if (parsedDraft.step && parsedDraft.step >= 1 && parsedDraft.step <= 3) {
                setCurrentStep(parsedDraft.step);
              }

              setSophieSuggestedRisks(parsedDraft.metadata?.suggestedRisks || []);
              setSophieMandatoryChecklists(parsedDraft.metadata?.mandatoryChecklists || []);
              setSophieRiskLevel(String(parsedDraft.metadata?.riskLevel || ''));
              setDraftRestored(true);
              setDraftSavedAt(
                typeof savedAt === 'number'
                  ? new Date(savedAt).toISOString()
                  : savedAt,
              );
            }
          } else {
            setSophieSuggestedRisks([]);
            setSophieMandatoryChecklists([]);
            setSophieRiskLevel('');
          }
        }

        await loadCompanies(companySeedId);
      } catch (error) {
        logger.error('Erro ao carregar dados:', error);
        toast.error('Erro ao carregar dados para o formulário.');
      } finally {
        setPreApprovalHistoryLoading(false);
        setFetching(false);
      }
    }
    loadData();
  }, [draftStorageKey, id, legacyDraftStorageKey, methods, reset, user?.company_id, user?.profile?.nome]);

  useEffect(() => {
    let active = true;
    const requestCompanyId = selectedCompanyId;

    if (aprTenantRef.current !== requestCompanyId) {
      aprTenantRef.current = requestCompanyId;
      setAprs([]);
    }

    async function loadCompanyScopedAprs() {
      if (!requestCompanyId) {
        setAprs([]);
        return;
      }

      try {
        const aprResult = await aprsService.findPaginated({
          page: 1,
          limit: 100,
          companyId: requestCompanyId,
        });
        if (!active) return;

        let nextAprs = aprResult.data;
        if (selectedAprId && !nextAprs.some((apr) => apr.id === selectedAprId)) {
          try {
            const currentApr = await aprsService.findOne(selectedAprId);
            if (!active) return;
            if (currentApr.company_id === requestCompanyId) {
              nextAprs = dedupeById([currentApr, ...nextAprs]);
            }
          } catch (error) {
            if (!active || isAbortError(error)) return;
            logger.warn('Falha ao carregar APR selecionada para fallback da PT:', error);
          }
        }

        if (!active) return;
        setAprs((current) =>
          mergeTenantScopedEntities(requestCompanyId, current, nextAprs),
        );
      } catch (error) {
        if (!active || isAbortError(error)) return;
        logger.error('Erro ao carregar APRs da PT:', error);
        const message = await extractApiErrorMessage(
          error,
          'Não foi possível carregar as APRs da PT.',
        );
        if (!active) return;
        toast.error(message);
      }
    }

    void loadCompanyScopedAprs();
    return () => {
      active = false;
    };
  }, [selectedAprId, selectedCompanyId]);

  useEffect(() => {
    let active = true;
    const requestCompanyId = selectedCompanyId;

    if (siteTenantRef.current !== requestCompanyId) {
      siteTenantRef.current = requestCompanyId;
      setSites([]);
    }

    async function loadCompanyScopedSites() {
      if (!requestCompanyId) {
        setSites([]);
        return;
      }

      try {
        const siteResult = await sitesService.findPaginated({
          page: 1,
          limit: 100,
          companyId: requestCompanyId,
        });
        if (!active) return;

        let nextSites = siteResult.data;
        if (
          selectedSiteId &&
          !nextSites.some((site) => site.id === selectedSiteId)
        ) {
          try {
            const currentSite = await sitesService.findOne(selectedSiteId);
            if (!active) return;
            if (currentSite.company_id === requestCompanyId) {
              nextSites = dedupeById([currentSite, ...nextSites]);
            }
          } catch (error) {
            if (!active || isAbortError(error)) return;
            logger.warn('Falha ao carregar site selecionado para fallback da PT:', error);
          }
        }

        if (!active) return;
        setSites((current) =>
          mergeTenantScopedEntities(requestCompanyId, current, nextSites),
        );
      } catch (error) {
        if (!active || isAbortError(error)) return;
        logger.error('Erro ao carregar obras da PT:', error);
        const message = await extractApiErrorMessage(
          error,
          'Não foi possível carregar as obras da PT.',
        );
        if (!active) return;
        toast.error(message);
      }
    }

    void loadCompanyScopedSites();
    return () => {
      active = false;
    };
  }, [selectedCompanyId, selectedSiteId]);

  useEffect(() => {
    let active = true;
    const requestCompanyId = selectedCompanyId;

    if (userTenantRef.current !== requestCompanyId) {
      userTenantRef.current = requestCompanyId;
      setUsers([]);
    }

    async function loadCompanyScopedUsers() {
      if (!requestCompanyId) {
        setUsers([]);
        return;
      }

      try {
        const userPage = await usersService.findPaginated({
          page: 1,
          limit: 100,
          companyId: requestCompanyId,
          siteId: selectedSiteId || undefined,
        });
        if (!active) return;

        let nextUsers = userPage.data;

        const requiredUserIds = Array.from(
          new Set(
            [
              selectedResponsavelId,
              selectedAuditadoPorId,
              ...selectedExecutanteIds,
            ].filter(Boolean),
          ),
        ) as string[];
        const missingUserIds = requiredUserIds.filter(
          (userId) => !nextUsers.some((currentUser) => currentUser.id === userId),
        );

        if (missingUserIds.length > 0) {
          const fetchedUsers = await Promise.all(
            missingUserIds.map((userId) =>
              usersService.findOne(userId).catch(() => null),
            ),
          );
          if (!active) return;
          const presentUsers = fetchedUsers.filter(
            (currentUser): currentUser is User => currentUser !== null,
          );
          nextUsers = dedupeById([
            ...presentUsers.filter(
              (currentUser) => currentUser.company_id === requestCompanyId,
            ),
            ...nextUsers,
          ]);
        }

        if (!active) return;
        setUsers((current) =>
          mergeTenantScopedEntities(requestCompanyId, current, nextUsers),
        );
      } catch (error) {
        if (!active || isAbortError(error)) return;
        logger.error('Erro ao carregar usuários da PT:', error);
        const message = await extractApiErrorMessage(
          error,
          'Não foi possível carregar os usuários da PT.',
        );
        if (!active) return;
        toast.error(message);
      }
    }

    void loadCompanyScopedUsers();
    return () => {
      active = false;
    };
  }, [
    selectedAuditadoPorId,
    selectedCompanyId,
    selectedExecutanteIds,
    selectedResponsavelId,
    selectedSiteId,
  ]);

  useEffect(() => {
    if (id) return;
    if (selectedCompanyId) return;
    const companyId = user?.company_id;
    if (!companyId) return;
    setValue('company_id', companyId);
    if (user?.site_id) {
      setValue('site_id', user.site_id);
    }
  }, [id, selectedCompanyId, setValue, user?.company_id, user?.site_id]);

  // APR auto-fill: propaga site_id e responsavel_id quando o usuário seleciona uma APR
  useEffect(() => {
    if (!selectedAprId || filteredAprs.length === 0) return;
    const apr = filteredAprs.find((a) => a.id === selectedAprId);
    if (!apr) return;

    const changes: string[] = [];
    if (!selectedSiteId && apr.site_id) {
      setValue('site_id', apr.site_id, { shouldDirty: true, shouldValidate: true });
      changes.push('obra');
    }

    const responsibleId = apr.elaborador_id || apr.elaborador?.id;
    if (!selectedResponsavelId && responsibleId) {
      setValue('responsavel_id', responsibleId, { shouldDirty: true, shouldValidate: true });
      changes.push('responsável');
    }
    if (changes.length > 0) {
      toast.info(`Preenchido automaticamente a partir da APR: ${changes.join(', ')}.`);
    }
  }, [filteredAprs, selectedAprId, selectedResponsavelId, selectedSiteId, setValue]);

  useEffect(() => {
    if (!draftStorageKey || typeof window === 'undefined' || id || fetching) {
      return;
    }

    const subscription = methods.watch((values) => {
      if (draftAutosaveTimerRef.current !== undefined) {
        window.clearTimeout(draftAutosaveTimerRef.current);
      }

      draftAutosaveTimerRef.current = window.setTimeout(() => {
        persistDraftSnapshot({
          values: values as Partial<PtFormData>,
          step: currentStep,
        });
      }, 350);
    });

    return () => {
      subscription.unsubscribe();
      if (draftAutosaveTimerRef.current !== undefined) {
        window.clearTimeout(draftAutosaveTimerRef.current);
        draftAutosaveTimerRef.current = undefined;
      }
    };
  }, [currentStep, draftStorageKey, fetching, id, methods, persistDraftSnapshot]);

  useEffect(() => {
    if (!draftStorageKey || typeof window === 'undefined' || id || fetching) {
      return;
    }

    persistDraftSnapshot({ step: currentStep });
  }, [currentStep, draftStorageKey, fetching, id, persistDraftSnapshot]);

  const toggleExecutante = useCallback((userId: string) => {
    const selectedExecutanteIds = methods.getValues('executantes') || [];
    const isSelected = selectedExecutanteIds.includes(userId);

    if (isSelected) {
      const updated = selectedExecutanteIds.filter(id => id !== userId);
      setValue('executantes', updated, { shouldValidate: true });
      const newSignatures = { ...signatures };
      delete newSignatures[userId];
      setSignatures(newSignatures);
    } else {
      const user = users.find(u => u.id === userId);
      if (user) {
        setCurrentSigningUser(user);
        setIsSignatureModalOpen(true);
      }
    }
  }, [methods, setValue, signatures, users]);

  const handleSaveSignature = useCallback((signatureData: string, type: string) => {
    if (currentSigningUser) {
      setSignatures(prev => ({
        ...prev,
        [currentSigningUser.id]: { data: signatureData, type }
      }));
      
      const current = watch('executantes') || [];
      const updated = [...current, currentSigningUser.id];
      setValue('executantes', updated, { shouldValidate: true });
      toast.success(`Assinatura de ${currentSigningUser.nome} capturada!`);
    }
  }, [currentSigningUser, setValue, watch]);

  const handleAiAnalysis = async () => {
    if (!isAiEnabled()) {
      toast.error('IA desativada neste ambiente.');
      return;
    }
    const data = watch();
    if (!data.titulo) {
      toast.error('Preencha pelo menos o título para a análise do SGS.');
      return;
    }

    try {
      setAnalyzing(true);
      const result = await aiService.analyzePt({
        titulo: data.titulo,
        descricao: data.descricao || '',
        trabalho_altura: !!data.trabalho_altura,
        espaco_confinado: !!data.espaco_confinado,
        trabalho_quente: !!data.trabalho_quente,
        eletricidade: !!data.eletricidade,
      });

      toast.success('SGS analisou os riscos da PT!', {
        description: (
          <div className="mt-2 space-y-2">
            <p className="font-bold text-[var(--ds-color-text-primary)]">{result.summary}</p>
            <ul className="list-inside list-disc text-xs">
              {result.suggestions.map((s: string, i: number) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            <p className="text-xs italic text-[var(--ds-color-text-primary)]">Nível de Risco Identificado: {result.riskLevel}</p>
          </div>
        ),
        duration: 8000,
      });
    } catch (error) {
      logger.error('Erro na análise do SGS:', error);
      toast.error('Não foi possível realizar a análise no momento.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSendEmail = () => {
    if (!id) return;
    setIsEmailModalOpen(true);
  };

  const handleEmitGovernedPdfFromForm = async () => {
    if (!id || !currentPt) return;
    setEmittingPdf(true);
    try {
      const [fullPt, ptSignatures] = await Promise.all([
        ptsService.findOne(id),
        signaturesService.findByDocument(id, 'PT'),
      ]);
      const { generatePtPdf } = await import('@/lib/pdf/ptGenerator');
      const result = (await generatePtPdf(fullPt, ptSignatures, {
        save: false,
        output: 'base64',
        draftWatermark: false,
      })) as { base64: string; filename: string } | undefined;
      if (!result?.base64) throw new Error('Falha ao gerar PDF');
      const { base64ToPdfBlob } = await import('@/lib/pdf/pdfFile');
      const blob = base64ToPdfBlob(result.base64);
      const file = new File([blob], result.filename, { type: 'application/pdf' });
      await ptsService.attachFile(id, file);
      toast.success('PDF final emitido e registrado com sucesso.');
      await refetchCurrentPt();
    } catch (err) {
      const msg = extractApiErrorMessage(err) || 'Falha ao emitir PDF final da PT.';
      toast.error(msg);
    } finally {
      setEmittingPdf(false);
    }
  };

  const handleConfirmSendEmail = async (email: string) => {
    if (!id || !email.trim()) return;
    return await mailService.sendStoredDocument(id, 'PT', email.trim());
  };

  const nextStep = async () => {
    let fields: (keyof PtFormData)[] = [];
    if (currentStep === 1) {
      fields = ['numero', 'titulo', 'data_hora_inicio', 'data_hora_fim', 'company_id', 'site_id', 'apr_id', 'responsavel_id'];
      if (workConfined) {
        fields.push('contato_emergencia', 'plano_resgate', 'vigia_nome');
      }
    } else if (currentStep === 2) {
      fields = ['recomendacoes_gerais_checklist'];
      if (workAtHeight) fields.push('trabalho_altura_checklist');
      if (workElectric) fields.push('trabalho_eletrico_checklist');
      if (workHot) fields.push('trabalho_quente_checklist');
      if (workConfined)
        fields.push(
          'trabalho_espaco_confinado_checklist',
          'medicoes_atmosfericas',
        );
      if (workExcavation) fields.push('trabalho_escavacao_checklist');
    }

    const isValid = await trigger(fields);
    if (isValid) {
      setCurrentStep((prev) => prev + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const prevStep = () => {
    setCurrentStep((prev) => prev - 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className={cn(
      "ds-form-page mx-auto max-w-7xl space-y-6 pb-12 motion-safe:animate-in fade-in slide-in-from-bottom-4 motion-safe:duration-500",
      isFieldMode && "pb-28",
    )}>
      {fetching ? (
        <div className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)] print:hidden">
          <InlineLoadingState label={id ? 'Carregando PT' : 'Preparando PT'} />
        </div>
      ) : null}

      <PageHeader
        eyebrow={isFieldMode ? 'Modo campo' : 'Permissão de trabalho'}
        title={id ? 'Editar PT' : isFieldMode ? 'Nova PT em campo' : 'Nova PT'}
        description={
          isFieldMode
            ? 'Liberação operacional adaptada para obra, com rascunho automático e navegação reduzida para celular.'
            : `Preencha os campos abaixo para ${id ? 'atualizar' : 'criar'} a Permissão de Trabalho.`
        }
        icon={<ShieldCheck className="h-5 w-5" />}
        actions={
          <Link
            href="/dashboard/pts"
            className={cn(buttonVariants({ variant: 'outline' }), 'inline-flex items-center')}
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Link>
        }
      />

      {isFieldMode ? (
        <div className="ds-form-section">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-success)]">
                PT em campo
              </p>
              <p className="mt-2 text-sm text-[var(--ds-color-text-secondary)]">
                Wizard pensado para liberação rápida, com retomada automática e foco em checklists críticos da operação.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center md:w-[260px]">
              <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/28 px-3 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">Rascunho</p>
                <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">Automático</p>
              </div>
              <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/28 px-3 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">Operação</p>
                <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">Campo / obra</p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <FormProvider {...methods}>
        <form
          onSubmit={handleSubmit(onSubmit, (errors) => {
            const step1Fields = ['numero', 'titulo', 'data_hora_inicio', 'data_hora_fim', 'company_id', 'site_id', 'responsavel_id', 'contato_emergencia', 'plano_resgate', 'ponto_encontro', 'vigia_user_id', 'vigia_nome', 'epis_obrigatorios'];
            const step2Fields = ['recomendacoes_gerais_checklist', 'trabalho_altura_checklist', 'trabalho_eletrico_checklist', 'trabalho_quente_checklist', 'trabalho_espaco_confinado_checklist', 'trabalho_escavacao_checklist', 'medicoes_atmosfericas'];
            const errorKeys = Object.keys(errors);
            if (errorKeys.some((k) => step1Fields.includes(k))) {
              setCurrentStep(1);
              toast.error('Corrija os campos obrigatórios na etapa 1 antes de continuar.');
            } else if (errorKeys.some((k) => step2Fields.includes(k))) {
              setCurrentStep(2);
              toast.error('Há itens de checklist pendentes na etapa 2.');
            } else if (errors.executantes) {
              setCurrentStep(3);
              toast.error('Adicione pelo menos um executante antes de salvar.');
            }
            window.scrollTo({ top: 0, behavior: 'smooth' });
          })}
          className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]"
        >
          {ptReadOnlyMessage ? (
            <div
              role="alert"
              className="xl:col-span-2 rounded-[var(--ds-radius-xl)] border border-[color:var(--ds-color-warning)]/25 bg-[color:var(--ds-color-warning-subtle)] px-5 py-4 text-sm text-[color:var(--ds-color-warning)]"
            >
              <p className="font-semibold text-[color:var(--ds-color-warning)]">
                Documento travado para edição
              </p>
              <p className="mt-1 text-[color:var(--ds-color-warning)]/90">
                {ptReadOnlyMessage} Use o PDF final, a validação pública ou uma nova versão quando aplicável.
              </p>
            </div>
          ) : null}
          <aside className="space-y-3 xl:sticky xl:top-28 xl:self-start">
            <div className="ds-form-section overflow-hidden p-0">
              <div className="border-b border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/16 px-5 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--ds-color-text-secondary)]">
                  fluxo guiado
                </p>
                <h2 className="mt-2 text-lg font-bold text-[var(--ds-color-text-primary)]">
                  Emissão guiada de PT
                </h2>
                <p className="mt-2 text-sm text-[color:var(--ds-color-text-secondary)]">
                  Uma etapa por vez para reduzir falhas de liberação e manter rastreabilidade.
                </p>
              </div>
              <nav aria-label="Etapas da PT">
              <div className="space-y-2.5 px-4 py-4" role="list">
                {PT_STEPS.map((step) => {
                  const Icon = step.icon;
                  const isActive = currentStep === step.id;
                  const isCompleted = currentStep > step.id;

                  return (
                    <button
                      key={step.id}
                      type="button"
                      role="listitem"
                      aria-current={isActive ? 'step' : undefined}
                      aria-label={`Etapa ${step.id}: ${step.title}${isCompleted ? ' (concluída)' : isActive ? ' (em edição)' : ''}`}
                      onClick={() => {
                        if (step.id <= currentStep) {
                          setCurrentStep(step.id);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }
                      }}
                      className={`w-full rounded-[var(--ds-radius-lg)] border px-4 py-3 text-left motion-safe:transition-all ${
                        isActive
                          ? 'border-[var(--ds-color-action-primary)] bg-[var(--ds-color-action-primary)]/12 shadow-[var(--ds-shadow-sm)]'
                          : isCompleted
                            ? 'border-[color:var(--ds-color-success)]/20 bg-[color:var(--ds-color-success-subtle)] hover:border-[color:var(--ds-color-success)]/28'
                            : 'border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)]/75'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={`flex h-10 w-10 items-center justify-center rounded-2xl ${
                            isActive
                              ? 'bg-[var(--ds-color-action-primary)] text-[var(--ds-color-action-primary-foreground)]'
                              : isCompleted
                                ? 'bg-[color:var(--ds-color-success-subtle)] text-[var(--ds-color-success)]'
                                : 'bg-[var(--ds-color-surface-muted)]/22 text-[var(--ds-color-text-secondary)]'
                          }`}
                        >
                          {isCompleted ? <CheckCircle2 className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                            {step.title}
                          </p>
                          <p className="mt-1 text-xs text-[var(--ds-color-text-secondary)]">{step.description}</p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              </nav>
            </div>

            <div className="ds-form-section px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ds-color-text-secondary)]">
                    {currentStepSidebarTitle}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                    {selectedTitle || 'Título ainda não definido'}
                  </p>
                  <p className="mt-1 text-xs text-[var(--ds-color-text-secondary)]">
                    {currentStepSidebarDescription}
                  </p>
                </div>
                {draftStorageKey && draftRestored ? (
                  <StatusPill tone="warning">
                    Rascunho restaurado
                  </StatusPill>
                ) : null}
              </div>

              <div className="mt-4 space-y-3 text-sm text-[var(--ds-color-text-primary)]">
                {sidebarSummaryRows.map((item) => (
                  <SummaryRow key={item.label} label={item.label} value={item.value} />
                ))}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                {sidebarMetrics.map((item) => (
                  <WizardMetric key={item.label} label={item.label} value={item.value} tone={item.tone} />
                ))}
              </div>

              {selectedRiskTypes.length > 0 && currentStep !== 3 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {selectedRiskTypes.slice(0, 4).map((risk) => (
                    <StatusPill key={risk}>
                      {risk}
                    </StatusPill>
                  ))}
                  {selectedRiskTypes.length > 4 ? (
                    <StatusPill tone="neutral">
                      +{selectedRiskTypes.length - 4} tipos
                    </StatusPill>
                  ) : null}
                </div>
              ) : selectedRiskTypes.length === 0 ? (
                <div className="mt-4 rounded-[var(--ds-radius-lg)] border border-[color:var(--ds-color-warning)]/20 bg-[color:var(--ds-color-warning-subtle)] px-3 py-2 text-xs text-[var(--ds-color-warning)]">
                  Marque os tipos de trabalho para habilitar os checklists específicos.
                </div>
              ) : null}

              {draftSavedAt ? (
                <p className="mt-4 text-xs font-medium uppercase tracking-[0.14em] text-[color:var(--ds-color-text-secondary)]">
                  Último rascunho salvo às{' '}
                  {new Date(draftSavedAt).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              ) : null}

              <div
                className={cn(
                  'mt-4 rounded-[var(--ds-radius-lg)] px-3 py-3 text-xs font-medium',
                  currentStepSupportingNoteToneClass,
                )}
              >
                {currentStepSupportingNote}
              </div>
            </div>

            {currentStep === 3 ? (
              <PtReadinessPanel
                readyForRelease={readyForRelease}
                blockers={readinessBlockers}
                unansweredChecklistItems={unansweredChecklistItems}
                adverseChecklistItems={adverseChecklistItems}
                pendingSignatures={pendingSignatures}
                hasRapidRiskBlocker={hasRapidRiskBasicNo}
              />
            ) : null}
          </aside>

          <fieldset
            disabled={isPtReadOnly}
            className={cn('space-y-6', isPtReadOnly && 'opacity-80')}
          >
            <div className="ds-form-section">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
                    Etapa {currentStepConfig.id} de {PT_STEPS.length}
                  </p>
                  <h2 className="mt-2 text-xl font-bold text-[var(--ds-color-text-primary)]">
                    {currentStepConfig.title}
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm text-[color:var(--ds-color-text-secondary)]">
                    {currentStepConfig.description}
                  </p>
                  {focusTarget ? (
                    <p className="mt-3 text-sm text-[color:var(--ds-color-text-secondary)]">
                      Esta PT foi aberta com foco em <strong>{getPtFocusLabel(focusTarget)}</strong> a partir da pré-liberação.
                    </p>
                  ) : null}
                </div>
                <StatusPill tone={currentStep === 3 ? (readyForRelease ? 'success' : 'warning') : 'neutral'} size="md">
                  {currentStep === 3 ? (readyForRelease ? 'Pronta para liberar' : 'Há bloqueios de fechamento') : 'Fluxo em andamento'}
                </StatusPill>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {currentStepHighlights.map((item) => (
                  <div
                    key={item.label}
                    className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/18 px-4 py-3"
                  >
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--ds-color-text-secondary)]">
                      {item.label}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">{item.value}</p>
                  </div>
                ))}
              </div>
            </div>

            {currentStep !== 3 && (sophieSuggestedRisks.length > 0 || sophieMandatoryChecklists.length > 0) && (
              <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-action-primary)]/25 bg-[var(--ds-color-action-primary)]/8 p-5">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-action-primary)]">
                      Sugestões da SOPHIE
                    </p>
                    <h3 className="mt-2 text-lg font-bold text-[var(--ds-color-text-primary)]">
                      Aplicações rápidas para esta PT
                    </h3>
                    <p className="mt-2 text-sm text-[color:var(--ds-color-text-secondary)]">
                      Ative grupos de risco e checklists mandatórios com um clique para deixar a liberação coerente com a atividade e o site.
                    </p>
                    {sophieRiskLevel === 'Alto' || sophieRiskLevel === 'Crítico' ? (
                      <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-warning)]">
                        SOPHIE já pré-preencheu observações e checkpoints críticos porque o risco sugerido foi {sophieRiskLevel}.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {sophieSuggestedRisks.length > 0 ? (
                      <button
                        type="button"
                        onClick={applyAllSuggestedPtRisks}
                        className="rounded-[var(--ds-radius-md)] border border-[color:var(--ds-color-info)]/22 bg-[color:var(--ds-color-info-subtle)] px-3 py-2 text-xs font-semibold text-[var(--ds-color-info)] motion-safe:transition-colors hover:bg-[color:var(--ds-color-info-subtle)]/80"
                      >
                        Aplicar grupos de risco
                      </button>
                    ) : null}
                    {sophieMandatoryChecklists.length > 0 ? (
                      <button
                        type="button"
                        onClick={applyAllMandatoryChecklistSuggestions}
                        className="rounded-[var(--ds-radius-md)] border border-[color:var(--ds-color-warning)]/22 bg-[color:var(--ds-color-warning-subtle)] px-3 py-2 text-xs font-semibold text-[var(--ds-color-warning)] motion-safe:transition-colors hover:bg-[color:var(--ds-color-warning-subtle)]/80"
                      >
                        Ativar checklists mandatórios
                      </button>
                    ) : null}
                  </div>
                </div>

                {sophieSuggestedRisks.length > 0 ? (
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-secondary)]">
                      Riscos sugeridos
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {sophieSuggestedRisks.map((suggestion, index) => (
                        <button
                          key={`${suggestion.label}-${index}`}
                          type="button"
                          onClick={() => applySuggestedPtRisk(suggestion)}
                          className="rounded-full border border-[color:var(--ds-color-info)]/22 bg-[color:var(--ds-color-info-subtle)] px-3 py-1.5 text-xs font-semibold text-[var(--ds-color-info)] motion-safe:transition-colors hover:bg-[color:var(--ds-color-info-subtle)]/80"
                        >
                          {suggestion.label}
                          {suggestion.category ? ` • ${suggestion.category}` : ''}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {sophieMandatoryChecklists.length > 0 ? (
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-secondary)]">
                      Checklists mandatórios e complementares
                    </p>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      {sophieMandatoryChecklists.map((suggestion) => {
                        const canApplyInline = suggestion.source === 'pt-group';
                        return (
                          <div
                            key={suggestion.id}
                            className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-4 py-3"
                          >
                            <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                              {suggestion.label}
                            </p>
                            <p className="mt-1 text-xs text-[color:var(--ds-color-text-secondary)]">
                              {suggestion.reason}
                            </p>
                            <div className="mt-3 flex flex-wrap gap-3">
                              {canApplyInline ? (
                                <button
                                  type="button"
                                  onClick={() => applyMandatoryChecklistSuggestion(suggestion)}
                                  className="text-xs font-semibold text-[var(--ds-color-warning)] hover:text-[var(--ds-color-warning-hover)]"
                                >
                                  Ativar no wizard
                                </button>
                              ) : (
                                <Link
                                  href={buildChecklistSuggestionHref(suggestion)}
                                  className="text-xs font-semibold text-[var(--ds-color-info)] hover:text-[var(--ds-color-info-hover)]"
                                >
                                  Abrir checklist recomendado
                                </Link>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {currentStep === 1 && (
              <div className="space-y-4">
                <div
                  data-pt-focus-target="basic-info"
                  className={getFocusHighlightClass('basic-info')}
                >
                  <BasicInfoSection
                    companies={companies}
                    filteredSites={filteredSites}
                    filteredAprs={filteredAprs}
                    filteredUsers={filteredUsers}
                    analyzing={analyzing}
                    onAiAnalysis={handleAiAnalysis}
                    onCompanyChange={handleCompanyChange}
                    onAprChange={handleAprLinked}
                  />
                </div>
                <div
                  data-pt-focus-target="risk-analysis"
                  className={cn('space-y-4', getFocusHighlightClass('risk-analysis'))}
                >
                  <RiskTypesSection />
                  <RapidRiskAnalysisSection />
                  <EmergencyRescueSection users={filteredUsers} />
                </div>
              </div>
            )}

            {currentStep === 2 && (
              <div
                data-pt-focus-target="checklists"
                className={cn('space-y-4', getFocusHighlightClass('checklists'))}
              >
                <ChecklistSection
                  name="recomendacoes_gerais_checklist"
                  title="Recomendações Gerais"
                  description="Esta verificação é obrigatória em toda emissão de PT."
                  questions={recomendacoesQuestions}
                  baseResponses={['Ciente', 'Não']}
                  showJustificationOn={['Não']}
                />
                {workAtHeight && (
                  <ChecklistSection
                    name="trabalho_altura_checklist"
                    title="Trabalhos em Altura - Verificação das Condições"
                    description="Todos os itens devem ser verificados e devidamente organizados. Caso não aplicável, marque como N/A antes da emissão desta PT."
                    questions={alturaQuestions}
                    baseResponses={['Sim', 'Não', 'Não aplicável']}
                    showJustificationOn={['Não', 'Não aplicável']}
                    ptId={id}
                  />
                )}
                {workElectric && (
                  <ChecklistSection
                    name="trabalho_eletrico_checklist"
                    title="Trabalhos Elétricos - Verificação das Condições"
                    description="Todos os itens devem ser verificados antes da emissão da PT."
                    questions={eletricoQuestions}
                    baseResponses={['Sim', 'Não', 'Não aplicável']}
                    showJustificationOn={['Não']}
                    ptId={id}
                  />
                )}
                {workHot && (
                  <ChecklistSection
                    name="trabalho_quente_checklist"
                    title="Trabalhos a Quente - Verificação das Condições"
                    description="Todos os itens devem ser verificados antes da emissão da PT."
                    questions={quenteQuestions}
                    baseResponses={['Sim', 'Não', 'Não aplicável']}
                    showJustificationOn={['Não']}
                    ptId={id}
                  />
                )}
                {workConfined && (
                  <>
                    <ChecklistSection
                      name="trabalho_espaco_confinado_checklist"
                      title="Espaço Confinado - Verificação das Condições"
                      description="Todos os itens devem ser verificados antes da emissão da PT."
                      questions={confinadoQuestions}
                      baseResponses={['Sim', 'Não', 'Não aplicável']}
                      showJustificationOn={['Não']}
                      ptId={id}
                    />
                    <AtmosphericReadingsSection
                      ptId={id}
                      readOnly={isPtReadOnly}
                      canAppendReadings={canAppendReadings}
                      onReadingAppended={() => void refetchCurrentPt()}
                    />
                  </>
                )}
                {workExcavation && (
                  <ChecklistSection
                    name="trabalho_escavacao_checklist"
                    title="Escavação - Verificação das Condições"
                    description="Todos os itens devem ser verificados antes da emissão da PT."
                    questions={escavacaoQuestions}
                    baseResponses={['Sim', 'Não', 'Não aplicável']}
                    showJustificationOn={['Não']}
                    ptId={id}
                  />
                )}
              </div>
            )}

            {currentStep === 3 && (
              <div
                data-pt-focus-target="team"
                className={cn('space-y-4', getFocusHighlightClass('team'))}
              >
                <ResponsibleExecutorsSection
                  filteredUsers={filteredUsers}
                  selectedCompanyId={selectedCompanyId}
                  signatures={signatures}
                  onToggleExecutante={toggleExecutante}
                />
                <PtEvidencePhotosSection
                  ptId={id}
                  ptStatus={currentPt?.status}
                  photos={currentPt?.fotos_evidencia ?? []}
                  canUploadPhotos={canUploadPhotos}
                  onPhotosChanged={() => void refetchCurrentPt()}
                />
                <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/18 px-4 py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                        Fechamento da liberação
                      </p>
                      <p className="mt-1 text-sm text-[color:var(--ds-color-text-secondary)]">
                        Use o painel lateral para revisar bloqueios, assinaturas pendentes e confirmar se a PT já pode seguir para o salvamento final.
                      </p>
                    </div>
                    <StatusPill tone={readyForRelease ? 'success' : 'warning'}>
                      {readyForRelease ? 'Liberável' : `${readinessBlockers.length} bloqueio(s)`}
                    </StatusPill>
                  </div>
                </div>
                {hasPendingSignatureChanges ? (
                  <div
                    role="alert"
                    className="rounded-[var(--ds-radius-lg)] border border-[color:var(--ds-color-warning)]/25 bg-[color:var(--ds-color-warning-subtle)] px-4 py-3 text-sm text-[color:var(--ds-color-warning)]"
                  >
                    As assinaturas capturadas nesta PT exigem conexão ativa para salvar e sincronizar o documento.
                    Se estiver sem rede, use <strong>Salvar rascunho</strong> e conclua o envio quando a conexão voltar.
                  </div>
                ) : null}
                {id && (
                  <div className="ds-form-section">
                    <h2 className="mb-6 flex items-center gap-2 text-lg font-semibold text-[var(--ds-color-text-primary)]">
                      Auditoria do Trabalho
                      <span className="h-2 w-2 rounded-full bg-[var(--ds-color-action-primary)]"></span>
                    </h2>
                    <AuditSection<PtFormData>
                      register={register}
                      auditors={filteredUsers}
                    />
                  </div>
                )}
                {id && (
                  <PtPreApprovalHistoryPanel
                    entries={preApprovalHistory}
                    users={filteredUsers}
                    loading={preApprovalHistoryLoading}
                  />
                )}
              </div>
            )}

            <MobileActionBar
              aria-label="Ações da Permissão de Trabalho"
              className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex gap-2">
                {currentStep > 1 ? (
                  <Button type="button" variant="outline" onClick={prevStep}>
                    Voltar
                  </Button>
                ) : (
                  <Link
                    href="/dashboard/pts"
                    className={buttonVariants({ variant: 'outline' })}
                  >
                    Cancelar
                  </Link>
                )}
              </div>

              <div className={cn(
                "flex flex-col gap-3 sm:flex-row sm:items-center sm:space-x-4 sm:gap-0",
                isFieldMode && "grid grid-cols-2 gap-3 sm:flex-none sm:space-x-0",
              )}>
                {!id && draftStorageKey ? (
                  <Button
                    type="button"
                    variant="outline"
                    leftIcon={<Save className="h-4 w-4" />}
                    onClick={saveDraftSnapshot}
                    disabled={isPtReadOnly}
                    className={cn(isFieldMode && "min-h-12")}
                  >
                    Salvar rascunho
                  </Button>
                ) : null}
                {id && currentPt?.status === 'Aprovada' && !currentPt?.pdf_file_key ? (
                  <Button
                    type="button"
                    variant="outline"
                    leftIcon={<FileText className="h-4 w-4" />}
                    onClick={handleEmitGovernedPdfFromForm}
                    loading={emittingPdf}
                    className={cn(isFieldMode && "min-h-12")}
                    title="Gera o PDF oficial governado e registra na PT"
                  >
                    Emitir PDF final
                  </Button>
                ) : null}
                {id && canManageMail ? (
                  <Button
                    type="button"
                    variant="outline"
                    leftIcon={<Mail className="h-4 w-4" />}
                    onClick={handleSendEmail}
                    disabled={isPtReadOnly && !currentPt?.pdf_file_key}
                    className={cn(isFieldMode && "min-h-12")}
                  >
                    Enviar por e-mail
                  </Button>
                ) : null}
                
                {currentStep < 3 ? (
                  <Button
                    type="button"
                    rightIcon={<ArrowRight className="h-4 w-4" />}
                    onClick={nextStep}
                    disabled={isPtReadOnly}
                    className={cn(isFieldMode && "min-h-12")}
                  >
                    Próximo
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    loading={loading}
                    disabled={isPtReadOnly || (currentStep === 3 && selectedExecutanteIds.length === 0)}
                    title={currentStep === 3 && selectedExecutanteIds.length === 0 ? 'Selecione e assine ao menos um executante antes de salvar' : undefined}
                    leftIcon={!loading ? <Save className="h-4 w-4" /> : undefined}
                    className={cn(isFieldMode && "min-h-12")}
                  >
                    {id ? 'Salvar alterações' : isFieldMode ? 'Salvar PT em campo' : 'Criar Permissão de Trabalho'}
                  </Button>
                )}
              </div>
            </MobileActionBar>
          </fieldset>
        </form>
      </FormProvider>

      <DocumentEmailModal
        isOpen={isEmailModalOpen}
        onClose={() => setIsEmailModalOpen(false)}
        documentName={selectedTitle || 'Permissão de Trabalho'}
        onSend={handleConfirmSendEmail}
      />

      <SignatureModal
        isOpen={isSignatureModalOpen}
        onClose={() => {
          setIsSignatureModalOpen(false);
          setCurrentSigningUser(null);
        }}
        onSave={handleSaveSignature}
        userName={currentSigningUser?.nome || ''}
      />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--ds-color-text-secondary)]">
        {label}
      </span>
      <span className="max-w-[13rem] truncate text-right text-sm font-medium text-[color:var(--ds-color-text-primary)]">
        {value}
      </span>
    </div>
  );
}

function WizardMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'default' | 'info' | 'warning' | 'success';
}) {
  const tones = {
    default: {
      container: 'bg-[var(--ds-color-surface-muted)]/18 text-[color:var(--ds-color-text-primary)]',
      label: 'text-[color:var(--ds-color-text-secondary)]',
    },
    info: {
      container: 'bg-[color:var(--ds-color-info-subtle)] text-[color:var(--ds-color-info)]',
      label: 'text-[color:var(--ds-color-info)] opacity-80',
    },
    warning: {
      container: 'bg-[color:var(--ds-color-warning-subtle)] text-[color:var(--ds-color-warning)]',
      label: 'text-[color:var(--ds-color-warning)] opacity-80',
    },
    success: {
      container: 'bg-[color:var(--ds-color-success-subtle)] text-[color:var(--ds-color-success)]',
      label: 'text-[color:var(--ds-color-success)] opacity-80',
    },
  };

  return (
    <div className={`rounded-[var(--ds-radius-lg)] px-3 py-3 ${tones[tone].container}`}>
      <p className={`text-xs font-semibold uppercase tracking-[0.14em] ${tones[tone].label}`}>{label}</p>
      <p className="mt-2 text-lg font-semibold">{value}</p>
    </div>
  );
}

function dedupeById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function isEntityWithId<T extends { id: string }>(value: unknown): value is T {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return (
    'id' in value &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}
