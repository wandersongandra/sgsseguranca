"use client";

import dynamic from "next/dynamic";
import {
  ChangeEvent,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import type {
  Apr,
  AprActivityTemplate,
  AprExcelImportPreview,
  AprRiskItemInput,
} from "@/services/aprsService";
import { aprsService } from "@/services/aprsService";
import type { Activity } from "@/services/activitiesService";
import type { Risk } from "@/services/risksService";
import type { Epi } from "@/services/episService";
import type { Tool } from "@/services/toolsService";
import type { Machine } from "@/services/machinesService";
import type { Site } from "@/services/sitesService";
import type { Company } from "@/services/companiesService";
import type { User } from "@/services/usersService";
import { useForm, useFieldArray, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Save,
  ArrowLeft,
  Sparkles,
  Loader2,
  Plus,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  ClipboardList,
  ShieldCheck,
  FileText,
  Printer,
  Upload,
  Download,
  Minimize2,
  Maximize2,
  Lock,
  ChevronRight,
  FileDown,
  History,
  Building2,
  CalendarDays,
  MapPin,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { aiService } from "@/services/aiService";
import { isAiEnabled } from "@/lib/featureFlags";
import { logger } from "@/lib/logger";
import { signaturesService } from "@/services/signaturesService";
import { useFormSubmit } from "@/hooks/useFormSubmit";
import { siteStore } from "@/lib/siteStore";
import { AuditSection } from "@/components/AuditSection";
import { InlineLoadingState } from "@/components/ui/state";
import { MobileActionBar } from "@/components/ui/mobile-action-bar";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";
import { downloadExcel } from "@/lib/download-excel";
import type { AprLogEntry } from "./AprTimeline";
import { useAuth } from "@/context/AuthContext";
import { Permission } from '@/lib/permissions';
import type {
  SophieDraftChecklistSuggestion,
  SophieDraftRiskSuggestion,
} from "@/lib/sophie-draft-storage";
import { applyAprImportPreview } from "@/lib/apr-import";
import { aprSchema, type AprFormData } from "./aprForm.schema";
import { useAprCalculations } from "./useAprCalculations";
import { AprActionModal } from "./AprActionModal";
import { useAprCatalogs } from "../hooks/useAprCatalogs";
import { useAprDraft } from "../hooks/useAprDraft";
import { useAprInitialData } from "../hooks/useAprInitialData";
import { useAprPdfWorkflow } from "../hooks/useAprPdfWorkflow";
import { useAprWorkflowActions } from "../hooks/useAprWorkflowActions";
import { useApiStatus } from "@/hooks/useApiStatus";
import {
  type AprOfflineSyncStatus,
  type AprDraftPendingOfflineSync,
  createAprDraftMetadata,
} from "./aprDraftStorage";
import { trackAprOfflineTelemetry } from "./aprOfflineTelemetry";
import { AprApprovalPanel } from "./AprApprovalPanel";
import { AprCompliancePanel } from "./AprCompliancePanel";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import type { AprValidationResult } from "@/services/aprsService";
import {
  getOfflineQueueSnapshot,
  removeOfflineQueueItem,
  retryOfflineQueueItem,
} from "@/lib/offline-sync";
import { safeToLocaleString } from "@/lib/date/safeFormat";
import { isUserVisibleForSite } from "@/lib/site-scoped-user-visibility";
import { safeExternalArtifactUrl } from "@/lib/security/safe-external-url";
import {
  createEmptyRiskRow,
  hasText,
  inferAprDocumentRiskLevel,
  splitDocumentTokens,
  uniqueDocumentTokens,
  formatDocumentDate,
  formatDocumentPeriod,
  normalizeRiskRow,
  buildRiskRowKey,
  isUuidLike,
  type AprDocumentRiskLevel,
  type AprDocumentRiskSummary,
} from "./aprFormUtils";
import {
  APR_DOCUMENT_RISK_LEVELS,
  DocumentInfoCell,
  DocumentRiskSummaryList,
  DocumentSignatureCard,
  AprRiskGridHeader,
  AprRiskReferencePanel,
  LegendItem,
  MiniStat,
  SectionGrid,
  SummaryMetaCard,
  WizardMetric,
} from "./AprFormPresentation";

const SignatureModal = dynamic(
  () =>
    import("../../checklists/components/SignatureModal").then(
      (module) => module.SignatureModal,
    ),
  { ssr: false },
);

const AprTimeline = dynamic(
  () => import("./AprTimeline").then((module) => module.AprTimeline),
  {
    loading: () => (
      <div className="rounded-[var(--ds-radius-xl)] border border-[var(--component-card-border)] bg-[color:var(--component-card-bg)] p-4 text-sm text-[var(--ds-color-text-secondary)]">
        Carregando histórico da APR...
      </div>
    ),
  },
);

const AprRiskRow = dynamic(() =>
  import("./AprRiskRow").then((module) => module.AprRiskRow),
);

const AprExecutiveSummary = dynamic(() =>
  import("./AprExecutiveSummary").then((module) => module.AprExecutiveSummary),
);

/* Schema movido para ./aprForm.schema.ts
   (mantemos o nome `aprSchema` via import para o zodResolver)
  // Campo interno: indica que o usuário anexou uma APR já preenchida e assinada (PDF).
  // Usado somente para validação/UX do wizard; não deve ser enviado para a API.
  pdf_signed: z.boolean().optional(),
  numero: z.string().min(1, "O número é obrigatório"),
  titulo: z.string().min(5, "O título deve ter pelo menos 5 caracteres"),
  descricao: z.string().optional(),
  data_inicio: z.string(),
  data_fim: z.string(),
  status: z.enum(["Pendente", "Aprovada", "Cancelada", "Encerrada"]),
  is_modelo: z.boolean().optional(),
  is_modelo_padrao: z.boolean().optional(),
  company_id: z.string().min(1, "Selecione uma empresa"),
  site_id: z.string().min(1, "Selecione um site"),
  elaborador_id: z.string().min(1, "Selecione um elaborador"),
  activities: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  epis: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  machines: z.array(z.string()).optional(),
  participants: z.array(z.string()).optional(),
  itens_risco: z
    .array(
      z.object({
        atividade_processo: z.string().optional(),
        agente_ambiental: z.string().optional(),
        condicao_perigosa: z.string().optional(),
        fontes_circunstancias: z.string().optional(),
        possiveis_lesoes: z.string().optional(),
        probabilidade: z.string().optional(),
        severidade: z.string().optional(),
        categoria_risco: z.string().optional(),
        medidas_prevencao: z.string().optional(),
        responsavel: z.string().optional(),
        prazo: z.string().optional(),
        status_acao: z.string().optional(),
      }),
    )
    .optional(),
  auditado_por_id: z.string().optional(),
  data_auditoria: z.string().optional(),
  resultado_auditoria: z.string().optional(),
  notas_auditoria: z.string().optional(),
});

type AprFormData = z.infer<typeof aprSchema>;
*/
type AprMutationPayload = Omit<AprFormData, "pdf_signed">;
type AprSubmitResult = {
  aprId?: string;
  offlineQueued?: boolean;
  offlineQueueItemId?: string;
  offlineQueueDeduplicated?: boolean;
};

interface AprFormProps {
  id?: string;
}

const APR_STEPS = [
  {
    id: 1,
    title: "Dados básicos",
    description: "Identificação, contexto, responsável e escopo.",
    icon: FileText,
  },
  {
    id: 2,
    title: "Riscos, participantes e assinaturas",
    description: "Matriz de riscos, participantes, EPIs, ferramentas e assinaturas.",
    icon: ClipboardList,
  },
  {
    id: 3,
    title: "Revisão final",
    description: "Validação final e emissão governada.",
    icon: ShieldCheck,
  },
] as const;

const aprBackButtonClass =
  "group rounded-full p-2 text-[var(--ds-color-text-secondary)] transition-none hover:bg-transparent hover:text-[var(--ds-color-text-secondary)]";
const aprSectionTitleClass =
  "mb-3 text-sm font-bold text-[var(--ds-color-text-primary)]";
const aprLabelClass =
  "mb-1.5 block text-[13px] font-semibold text-[var(--ds-color-text-secondary)]";
const AprRequiredMark = () => (
  <span aria-hidden="true" className="ml-0.5 text-[var(--color-danger)]">*</span>
);
const aprLabelCompactClass =
  "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]";
const aprFieldClass =
  "w-full min-h-[2.875rem] rounded-[var(--ds-radius-md)] border border-[var(--component-field-border)] bg-[color:var(--component-field-bg)] px-4 py-2.5 text-base leading-6 text-[var(--component-field-text)] shadow-[var(--component-field-shadow)] motion-safe:transition-all focus:border-[var(--component-field-border-focus)] focus:outline-none focus:shadow-[var(--component-field-shadow-focus)]";
const aprFileFieldClass =
  "block w-full rounded-[var(--ds-radius-md)] border border-[var(--component-field-border)] bg-[color:var(--component-field-bg)] px-4 py-2.5 text-base text-[var(--component-field-text)] shadow-[var(--component-field-shadow)] motion-safe:transition-all focus:border-[var(--component-field-border-focus)] focus:outline-none focus:shadow-[var(--component-field-shadow-focus)] file:mr-4 file:rounded-[var(--ds-radius-sm)] file:border-0 file:bg-[color:var(--color-card-muted)] file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-[var(--color-text-secondary)] hover:file:bg-[color:var(--ds-color-primary-subtle)]";
const aprFieldErrorClass =
  "border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)]";
const aprFieldDisabledClass =
  "disabled:bg-[color:var(--color-card-muted)]/60 disabled:cursor-not-allowed disabled:opacity-60";
const aprCheckboxClass =
  "h-5 w-5 rounded border-[var(--component-field-border)] text-[var(--ds-color-action-primary)] motion-safe:transition-all focus:ring-[var(--ds-color-action-primary)]";
const aprErrorTextClass = "mt-1 text-xs text-[var(--ds-color-danger)]";
const aprSuccessButtonCompactClass =
  "rounded-[var(--ds-radius-md)] bg-[var(--component-button-success-bg)] px-3 py-2 text-xs font-semibold text-[var(--component-button-success-text)] shadow-[var(--ds-shadow-sm)] transition-none hover:translate-y-0 hover:shadow-[var(--ds-shadow-sm)] disabled:opacity-60";
const aprPrimaryCompactButtonClass =
  "rounded-[var(--ds-radius-md)] bg-[var(--component-button-primary-bg)] px-3 py-2 text-xs font-semibold text-[var(--color-text-inverse)] shadow-[var(--ds-shadow-sm)] transition-none hover:translate-y-0 hover:shadow-[var(--ds-shadow-sm)] disabled:opacity-60";
const aprSuccessButtonClass =
  "rounded-[var(--ds-radius-md)] bg-[var(--component-button-success-bg)] px-4 py-2 text-sm font-semibold text-[var(--component-button-success-text)] shadow-[var(--ds-shadow-sm)] transition-none hover:translate-y-0 hover:shadow-[var(--ds-shadow-sm)] disabled:opacity-60";
const aprNeutralButtonClass =
  "rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-secondary-active)] px-4 py-2 text-sm font-semibold text-[var(--ds-color-action-secondary-foreground)] shadow-[var(--ds-shadow-sm)] transition-none hover:bg-[var(--ds-color-action-secondary-active)] disabled:opacity-60";
const aprSoftPrimaryButtonClass =
  "rounded-[var(--ds-radius-md)] border border-[var(--ds-color-primary-border)] bg-[color:var(--ds-color-primary-subtle)] px-3 py-2 text-xs font-semibold text-[var(--color-primary)] transition-none hover:bg-[color:var(--ds-color-primary-subtle)] disabled:opacity-60";
const aprInteractivePanelClass =
  "rounded-[var(--ds-radius-xl)] border border-[var(--component-card-border)] bg-[color:var(--component-card-bg)] p-6 shadow-[var(--component-card-shadow)] motion-safe:transition-shadow hover:shadow-[var(--component-card-shadow-elevated)]";
const aprSubtleMetaCardClass =
  "flex flex-col gap-1 rounded-[var(--ds-radius-lg)] border border-[var(--color-border-subtle)] bg-[color:var(--color-card)] p-3 text-sm text-[var(--color-text-secondary)]";
const aprWarningInlineClass =
  "rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)] px-3 py-2 text-xs text-[var(--color-warning)]";
const aprDangerInlineClass =
  "rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] px-4 py-3 text-sm text-[var(--color-danger)]";
const aprGhostActionClass =
  "rounded-[var(--ds-radius-md)] border border-[var(--component-button-secondary-border)] px-4 py-2.5 text-sm font-medium text-[var(--color-text-secondary)] transition-none hover:bg-transparent";
const aprPrimaryActionClass =
  "flex items-center justify-center space-x-2 rounded-[var(--ds-radius-md)] bg-[var(--component-button-primary-bg)] px-6 py-2.5 text-sm font-bold text-[var(--color-text-inverse)] shadow-[var(--ds-shadow-md)] transition-none hover:translate-y-0 hover:shadow-[var(--ds-shadow-md)] disabled:opacity-60";
const aprPrimarySubmitActionClass =
  "flex items-center justify-center space-x-2 rounded-[var(--ds-radius-md)] bg-[var(--component-button-primary-bg)] px-8 py-2.5 text-sm font-bold text-[var(--color-text-inverse)] shadow-[var(--ds-shadow-md)] transition-none hover:translate-y-0 hover:shadow-[var(--ds-shadow-md)] disabled:opacity-50";
const aprFieldStatCardClass =
  "rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/28 px-3 py-3";
const renderLegacyAprContext = false;


/* function getCategoriaBadgeClass(categoria?: string) {
  switch (categoria) {
    case "Aceitável":
      return "risk-badge-acceptable";
    case "Atenção":
      return "risk-badge-attention";
    case "Substancial":
      return "risk-badge-substantial";
    case "Crítico":
      return "risk-badge-critical";
    default:
      return "bg-[var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)]";
  }
}
*/

export function AprForm({ id }: AprFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, hasPermission } = useAuth();
  const canCreate = hasPermission(Permission.CAN_CREATE_APR);
  const canUpdate = hasPermission(Permission.CAN_UPDATE_APR);
  const canApprove = hasPermission(Permission.CAN_APPROVE_APR);
  const canGenerateAprPdf = hasPermission(Permission.CAN_GENERATE_APR_PDF);
  const canView = hasPermission(Permission.CAN_VIEW_APR);
  const canViewSignatures = hasPermission(Permission.CAN_VIEW_SIGNATURES);
  const canManageSignatures = hasPermission(Permission.CAN_MANAGE_SIGNATURES);
  const isCreateMode = !id;
  const canWriteApr = isCreateMode ? canCreate : canUpdate;
  const lacksWritePermission = !canWriteApr;
  const isUnauthorized =
    (!canView && !canCreate && !canUpdate) || (isCreateMode && !canCreate);

  // Guard de acesso sem quebrar a ordem dos hooks.
  useEffect(() => {
    if (isUnauthorized) {
      router.replace(canView ? "/dashboard/aprs" : "/dashboard");
    }
  }, [canView, isUnauthorized, router]);
  const { isOffline } = useApiStatus();
  const { getActionCriteriaText } = useAprCalculations();
  const prefillCompanyIdParam = searchParams.get("company_id");
  const prefillSiteIdParam = searchParams.get("site_id");
  const prefillUserIdParam =
    searchParams.get("elaborador_id") || searchParams.get("user_id");
  const prefillCompanyId = isUuidLike(prefillCompanyIdParam)
    ? String(prefillCompanyIdParam)
    : "";
  const prefillSiteId = isUuidLike(prefillSiteIdParam)
    ? String(prefillSiteIdParam)
    : "";
  const prefillUserId = isUuidLike(prefillUserIdParam)
    ? String(prefillUserIdParam)
    : "";
  const prefillTitle = searchParams.get("title") || "";
  const prefillDescription = searchParams.get("description") || "";
  const isFieldMode = searchParams.get("field") === "1";
  const [fetching, setFetching] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [emittingGovernedPdf, setEmittingGovernedPdf] = useState(false);
  const [closingApr, setClosingApr] = useState(false);
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [loadingTimeline, setLoadingTimeline] = useState(false);
  const [currentApr, setCurrentApr] = useState<Apr | null>(null);
  const [aprLogs, setAprLogs] = useState<AprLogEntry[]>([]);
  const [versionHistory, setVersionHistory] = useState<
    Array<{ id: string; numero: string; versao: number; status: string }>
  >([]);
  const [compareTargetId, setCompareTargetId] = useState("");
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<{
    summary: {
      totalBase: number;
      totalTarget: number;
      added: number;
      removed: number;
      changed: number;
    };
  } | null>(null);
  const [selectedRiskItemEvidence, setSelectedRiskItemEvidence] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [evidenceLatitude, setEvidenceLatitude] = useState<string>("");
  const [evidenceLongitude, setEvidenceLongitude] = useState<string>("");
  const [evidenceAccuracy, setEvidenceAccuracy] = useState<string>("");
  const [aprEvidences, setAprEvidences] = useState<
    Array<{
      id: string;
      apr_risk_item_id: string;
      original_name?: string;
      hash_sha256: string;
      watermarked_hash_sha256?: string;
      uploaded_at: string;
      captured_at?: string;
      url?: string;
      watermarked_url?: string;
      integrity_flags?: Record<string, unknown>;
    }>
  >([]);
  const [suggestingControls, setSuggestingControls] = useState(false);
  const [importingExcel, setImportingExcel] = useState(false);
  const [excelPreview, setExcelPreview] =
    useState<AprExcelImportPreview | null>(null);
  const [activityTemplates, setActivityTemplates] = useState<
    Array<Pick<AprActivityTemplate, "tipo_atividade" | "label" | "descricao">>
  >([]);
  const [selectedActivityTemplate, setSelectedActivityTemplate] =
    useState<AprActivityTemplate | null>(null);
  const [loadingActivityTemplate, setLoadingActivityTemplate] = useState(false);

  const [, setActivities] = useState<Activity[]>([]);
  const [, setRisks] = useState<Risk[]>([]);
  const [epis, setEpis] = useState<Epi[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [, setTools] = useState<Tool[]>([]);
  const [, setMachines] = useState<Machine[]>([]);

  // Signature States
  const [isSignatureModalOpen, setIsSignatureModalOpen] = useState(false);
  const [currentSigningUser, setCurrentSigningUser] = useState<User | null>(
    null,
  );
  const [signatures, setSignatures] = useState<
    Record<string, { data: string; type: string }>
  >({});
  const [persistedSignatures, setPersistedSignatures] = useState<
    Record<string, { id?: string; data: string; type: string }>
  >({});
  const [currentStep, setCurrentStep] = useState(1);
  const submitIntentRef = useRef<"save" | "save_and_print">("save");
  const excelInputRef = useRef<HTMLInputElement | null>(null);
  const compliancePanelRef = useRef<HTMLDivElement | null>(null);
  const [complianceResult, setComplianceResult] =
    useState<AprValidationResult | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [formActionModal, setFormActionModal] = useState<
    "approve" | "finalize" | null
  >(null);
  const [formActionModalLoading, setFormActionModalLoading] = useState(false);
  // C01 — Confirmar descarte de sync offline
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  // C03 — Confirmar troca de empresa com dados preenchidos
  const [confirmCompanyChangeOpen, setConfirmCompanyChangeOpen] = useState(false);
  const [pendingCompanyId, setPendingCompanyId] = useState<string | null>(null);
  // C09 — Confirmar aplicação de template
  const [confirmTemplateOpen, setConfirmTemplateOpen] = useState(false);
  // C10 — Steps visitados pelo usuário
  const [visitedSteps, setVisitedSteps] = useState<Set<number>>(new Set([1]));
  // M03 — Tick para timestamp relativo do draft
  const [, setDraftRelativeTick] = useState(0);

  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    watch,
    getValues,
    setError,
    clearErrors,
    trigger,
    formState: { errors, isDirty },
  } = useForm<AprFormData>({
    resolver: zodResolver(aprSchema),
    defaultValues: {
      pdf_signed: false,
      numero: "",
      titulo: prefillTitle,
      descricao: prefillDescription,
      tipo_atividade: "",
      frente_trabalho: "",
      area_risco: "",
      turno: "",
      local_execucao_detalhado: "",
      responsavel_tecnico_nome: "",
      responsavel_tecnico_registro: "",
      status: "Pendente",
      is_modelo: false,
      is_modelo_padrao: false,
      data_inicio: new Date().toISOString().split("T")[0],
      data_fim: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0],
      company_id: prefillCompanyId,
      site_id: prefillSiteId,
      elaborador_id: prefillUserId,
      activities: [],
      risks: [],
      epis: [],
      tools: [],
      machines: [],
      participants: prefillUserId ? [prefillUserId] : [],
      itens_risco: [],
    },
  });

  const getValuesRef = useRef(getValues);
  useEffect(() => {
    getValuesRef.current = getValues;
  }, [getValues]);

  const {
    ensureGovernedPdf,
    reloadAprWorkflowTimeline,
    reloadAprWorkflowContext,
    handlePrintAfterSave,
  } = useAprPdfWorkflow({
    canViewSignatures,
    setCurrentApr,
    setAprLogs,
    setAprEvidences,
    setVersionHistory,
    setValue,
  });

  const watchedStatus = useWatch({
    control,
    name: "status",
    defaultValue: "Pendente",
  });
  const isModelo = watch("is_modelo");
  const approvalSteps = currentApr?.approval_steps || [];
  const pendingApprovalStep =
    approvalSteps.find((step) => step.status === "pending") || null;
  const approvalProgressStarted = approvalSteps.some(
    (step) => step.status !== "pending",
  );
  const isApproved = currentApr?.status === "Aprovada";
  const hasFinalPdf = Boolean(currentApr?.has_final_pdf);
  const isReadOnly =
    lacksWritePermission ||
    watchedStatus === "Aprovada" ||
    watchedStatus === "Cancelada" ||
    watchedStatus === "Encerrada" ||
    hasFinalPdf ||
    approvalProgressStarted;
  const readOnlyReason = useMemo(() => {
    if (!isReadOnly) return null;
    return lacksWritePermission
      ? "Seu perfil permite visualizar APRs, mas não permite criar ou editar análises."
      : hasFinalPdf
        ? "APR bloqueada para edição porque já possui PDF final emitido."
        : watchedStatus === "Aprovada"
          ? "APR bloqueada para edição porque já foi aprovada."
          : watchedStatus === "Cancelada"
            ? "APR cancelada. Gere uma nova APR se o trabalho precisar ser reavaliado."
            : watchedStatus === "Encerrada"
              ? "APR encerrada e bloqueada para edição."
              : approvalProgressStarted
                ? `APR bloqueada para edição porque a aprovação foi iniciada${pendingApprovalStep ? `. Próxima etapa: ${pendingApprovalStep.title}.` : "."}`
                : "APR bloqueada para edição pelo fluxo formal.";
  }, [
    approvalProgressStarted,
    hasFinalPdf,
    isReadOnly,
    lacksWritePermission,
    pendingApprovalStep,
    watchedStatus,
  ]);

  const selectedCompanyId = watch("company_id");
  const selectedSiteId = watch("site_id");
  const activeSite = siteStore.get();
  const selectedElaboradorId = watch("elaborador_id");
  const selectedSite = sites.find((site) => site.id === selectedSiteId);
  const selectedTipoAtividade = watch("tipo_atividade");
  const tituloApr = watch("titulo");
  const descricaoApr = watch("descricao");
  const turnoApr = watch("turno");
  const frenteTrabalhoApr = watch("frente_trabalho");
  const areaRiscoApr = watch("area_risco");
  const localExecucaoApr = watch("local_execucao_detalhado");
  const responsavelTecnicoApr = watch("responsavel_tecnico_nome");
  const dataInicioApr = watch("data_inicio");
  const dataFimApr = watch("data_fim");
  const draftTenantId = isUuidLike(selectedCompanyId)
    ? selectedCompanyId
    : isUuidLike(user?.company_id)
      ? String(user?.company_id)
      : undefined;
  const {
    draftId,
    setDraftId,
    draftRestored,
    setDraftRestored,
    draftPendingOfflineSync,
    setDraftPendingOfflineSync,
    draftSecurityNotice,
    setDraftSecurityNotice,
    sophieSuggestedRisks,
    setSophieSuggestedRisks,
    sophieMandatoryChecklists,
    setSophieMandatoryChecklists,
    draftStorageKey,
    legacyDraftStorageKey,
    draftMetadata,
    clearDraft: clearDraftState,
    scheduleDraftPersist,
    persistPendingOfflineSync,
    draftSaving,
    draftLastSavedAt,
    draftSaveError,
    retryDraftPersist,
  } = useAprDraft({
    id,
    companyId: draftTenantId,
    isReadOnly,
    fetching,
    currentStep,
    getValues: () => getValues(),
  });
  const filteredSites = sites.filter(
    (site) => site.company_id === selectedCompanyId,
  );
  const filteredUsers = users.filter((user) =>
    isUserVisibleForSite(user, selectedCompanyId, selectedSiteId),
  );
  const signatureChanges = useMemo(() => {
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

    return {
      signaturesToDelete,
      signaturesToCreate,
      hasPendingChanges:
        signaturesToDelete.length > 0 || signaturesToCreate.length > 0,
    };
  }, [persistedSignatures, signatures]);
  const offlineSyncIdentity = useMemo(() => {
    if (id) {
      return {
        correlationId: `apr:update:${id}`,
        dedupeKey: `apr:update:${id}`,
      };
    }

    if (!draftId) {
      return null;
    }

    return {
      correlationId: `apr:draft:${draftId}`,
      dedupeKey: `apr:create:${draftId}`,
    };
  }, [draftId, id]);

  const selectedRiskIdsRaw = useWatch({
    control,
    name: "risks",
    defaultValue: [],
  });
  const selectedEpiIdsRaw = useWatch({
    control,
    name: "epis",
    defaultValue: [],
  });
  const selectedParticipantIdsRaw = useWatch({
    control,
    name: "participants",
    defaultValue: [],
  });
  const selectedRiskIds = useMemo(
    () => selectedRiskIdsRaw ?? [],
    [selectedRiskIdsRaw],
  );
  const selectedEpiIds = useMemo(
    () => selectedEpiIdsRaw ?? [],
    [selectedEpiIdsRaw],
  );
  const selectedParticipantIds = useMemo(
    () => selectedParticipantIdsRaw ?? [],
    [selectedParticipantIdsRaw],
  );
  const pendingOfflineSyncUi = useMemo(() => {
    if (!draftPendingOfflineSync) {
      return null;
    }

    switch (draftPendingOfflineSync.status) {
      case "syncing":
        return {
          badge: "Sincronizando base",
          summary:
            "A APR base já foi salva localmente e está em sincronização com o servidor.",
          nextStep:
            "Aguarde a confirmação da sincronização para continuar assinaturas, PDF final e emissão governada.",
        };
      case "failed":
        return {
          badge: "Falha na sincronização",
          summary:
            "A APR base segue salva localmente, mas a sincronização falhou e exige ação do operador.",
          nextStep:
            "Tente sincronizar novamente ou descarte este envio local antes de reenviar.",
        };
      case "synced_base":
        return {
          badge: "Base sincronizada",
          summary:
            "A APR base já alcançou o servidor. O que falta agora é concluir assinaturas e emissão final online.",
          nextStep:
            "Libere o rascunho para continuar a conclusão operacional com conexão ativa.",
        };
      case "orphaned":
        return {
          badge: "Estado local órfão",
          summary:
            "O navegador não localizou mais o envio correspondente na fila offline. A APR base pode ter sincronizado, sido removida ou perdido a referência local.",
          nextStep:
            "Valide a listagem antes de liberar ou reenviar, para evitar duplicidade operacional.",
        };
      default:
        return {
          badge: "Base enfileirada",
          summary:
            "A APR base foi salva localmente e está aguardando sincronização com o servidor.",
          nextStep:
            "Assinaturas, PDF final e emissão governada permanecem bloqueados até a conclusão online.",
        };
    }
  }, [draftPendingOfflineSync]);
  const notifyReadOnly = useCallback(
    (action?: string) => {
      if (!readOnlyReason) return;
      toast.warning("APR em modo somente leitura", {
        description: action ? `${readOnlyReason} ${action}` : readOnlyReason,
      });
    },
    [readOnlyReason],
  );
  const aiEnabled = isAiEnabled();
  const selectedCompany = companies.find(
    (company) => company.id === selectedCompanyId,
  );
  const selectedElaborador = users.find(
    (user) => user.id === selectedElaboradorId,
  );
  const selectedActivityTemplateSummary =
    activityTemplates.find(
      (template) => template.tipo_atividade === selectedTipoAtividade,
    ) || null;
  const selectedActivityTypeLabel =
    selectedActivityTemplateSummary?.label ||
    (hasText(selectedTipoAtividade)
      ? String(selectedTipoAtividade).replace(/_/g, " ")
      : "Não definido");
  const canApproveCurrentApr = Boolean(
    id &&
    currentApr &&
    currentApr.status === "Pendente" &&
    !hasFinalPdf &&
    (!approvalSteps.length || pendingApprovalStep),
  );
  const isRiskRowStarted = useCallback(
    (item: NonNullable<AprFormData["itens_risco"]>[number] | undefined) => {
      if (!item) return false;
      return [
        item.atividade_processo,
        item.etapa,
        item.agente_ambiental,
        item.condicao_perigosa,
        item.fontes_circunstancias,
        item.possiveis_lesoes,
        item.probabilidade,
        item.severidade,
        item.medidas_prevencao,
        item.epc,
        item.epi,
        item.permissao_trabalho,
        item.normas_relacionadas,
        item.responsavel,
        item.prazo,
        item.status_acao,
      ].some((value) => hasText(value));
    },
    [],
  );
  const isRiskRowMateriallyComplete = useCallback(
    (item: NonNullable<AprFormData["itens_risco"]>[number] | undefined) => {
      if (!item) return false;
      const hasIdentification =
        hasText(item.atividade_processo) ||
        hasText(item.etapa) ||
        hasText(item.condicao_perigosa) ||
        hasText(item.agente_ambiental);
      const hasEvaluation =
        hasText(item.probabilidade) && hasText(item.severidade);
      const hasControl =
        hasText(item.medidas_prevencao) ||
        hasText(item.epc) ||
        hasText(item.epi) ||
        hasText(item.permissao_trabalho) ||
        hasText(item.normas_relacionadas);
      return hasIdentification && hasEvaluation && hasControl;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    aprsService
      .listActivityTemplates()
      .then((templates) => {
        if (active) {
          setActivityTemplates(templates);
        }
      })
      .catch((error) => {
        logger.error("Erro ao carregar templates de atividade da APR:", error);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedTipoAtividade) {
      setSelectedActivityTemplate(null);
      return;
    }

    let active = true;
    setLoadingActivityTemplate(true);
    aprsService
      .getActivityTemplate(selectedTipoAtividade)
      .then((template) => {
        if (active) {
          setSelectedActivityTemplate(template);
          if (selectedTipoAtividade !== template.tipo_atividade) {
            setValue("tipo_atividade", template.tipo_atividade, {
              shouldDirty: false,
              shouldTouch: false,
            });
          }
        }
      })
      .catch((error) => {
        logger.error(
          "Erro ao carregar detalhes do template de atividade da APR:",
          error,
        );
        if (active) {
          setSelectedActivityTemplate(null);
        }
      })
      .finally(() => {
        if (active) {
          setLoadingActivityTemplate(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedTipoAtividade, setValue]);

  useEffect(() => {
    if (!selectedElaborador?.nome) {
      return;
    }
    if (hasText(getValuesRef.current("responsavel_tecnico_nome"))) {
      return;
    }
    setValue("responsavel_tecnico_nome", selectedElaborador.nome, {
      shouldDirty: false,
    });
  }, [selectedElaborador?.nome, setValue]);

  const buildChecklistSuggestionHref = useCallback(
    (suggestion: SophieDraftChecklistSuggestion) => {
      const params = new URLSearchParams();
      params.set("templateId", suggestion.id);
      if (selectedCompanyId) params.set("company_id", selectedCompanyId);
      if (selectedSiteId) params.set("site_id", selectedSiteId);
      if (tituloApr) params.set("title", `${tituloApr} • ${suggestion.label}`);
      if (watch("descricao")) {
        params.set("description", String(watch("descricao")));
      }
      return `/dashboard/checklists/new?${params.toString()}`;
    },
    [selectedCompanyId, selectedSiteId, tituloApr, watch],
  );

  const {
    fields: riskFields,
    append: appendRisk,
    remove: removeRisk,
    replace: replaceRisk,
    move: moveRisk,
  } = useFieldArray({
    control,
    name: "itens_risco",
  });
  const watchedRiskRows = useWatch({
    control,
    name: "itens_risco",
  }) as AprFormData["itens_risco"];
  const materiallyCompleteRiskCount = useMemo(
    () =>
      (watchedRiskRows || []).filter((item) =>
        isRiskRowMateriallyComplete(item),
      ).length,
    [isRiskRowMateriallyComplete, watchedRiskRows],
  );
  const totalRiskLines = riskFields.length;
  const completedSignatures = Object.keys(signatures).length;
  const [compactMode, setCompactMode] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const riskFieldsRef = useRef(riskFields);
  const pendingRiskRemovalTimeoutsRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const registerOfflineBlocked = useCallback(
    (reason: string) => {
      trackAprOfflineTelemetry("offline_blocked", {
        draftId: draftId || undefined,
        queueItemId: draftPendingOfflineSync?.queueItemId,
        dedupeKey: draftPendingOfflineSync?.dedupeKey,
        syncStatus: draftPendingOfflineSync?.status,
        intent: submitIntentRef.current,
        reason,
        source: "apr_form",
      });
    },
    [draftId, draftPendingOfflineSync],
  );
  const hiddenCompactDetailsCount = useMemo(() => {
    if (!compactMode) return 0;
    return (watchedRiskRows || []).reduce((count, item, index) => {
      if (expandedRows.has(index)) return count;
      const missingGovernanceData =
        !String(item?.medidas_prevencao || "").trim() ||
        !String(item?.responsavel || "").trim() ||
        !String(item?.prazo || "").trim() ||
        !String(item?.status_acao || "").trim();
      return missingGovernanceData ? count + 1 : count;
    }, 0);
  }, [compactMode, expandedRows, watchedRiskRows]);
  const selectedEpiCatalog = useMemo(
    () => epis.filter((epi) => selectedEpiIds.includes(epi.id)),
    [epis, selectedEpiIds],
  );
  const requiredEpiLabels = useMemo(() => {
    const catalogLabels = selectedEpiCatalog.map((epi) =>
      epi.ca ? `${epi.nome} CA ${epi.ca}` : epi.nome,
    );
    const rowLabels = (watchedRiskRows || []).flatMap((item) =>
      splitDocumentTokens(item?.epi),
    );

    return uniqueDocumentTokens([...catalogLabels, ...rowLabels]).slice(0, 7);
  }, [selectedEpiCatalog, watchedRiskRows]);
  const relatedNormLabels = useMemo(() => {
    const norms = (watchedRiskRows || []).flatMap((item) =>
      splitDocumentTokens(item?.normas_relacionadas),
    );

    return uniqueDocumentTokens(norms).slice(0, 6);
  }, [watchedRiskRows]);
  const aprDocumentRiskSummary = useMemo<AprDocumentRiskSummary>(() => {
    const counts = APR_DOCUMENT_RISK_LEVELS.reduce(
      (acc, level) => ({ ...acc, [level.key]: 0 }),
      {} as Record<AprDocumentRiskLevel, number>,
    );
    const startedRows = (watchedRiskRows || []).filter((item) =>
      isRiskRowStarted(item),
    );

    startedRows.forEach((item) => {
      counts[inferAprDocumentRiskLevel(item)] += 1;
    });

    const highestLevel =
      [...APR_DOCUMENT_RISK_LEVELS]
        .reverse()
        .find((level) => counts[level.key] > 0)?.label || "Sem risco mapeado";

    return {
      counts,
      total: startedRows.length,
      highestLabel: highestLevel,
      criticalCount: counts.alto + counts.critico,
    };
  }, [isRiskRowStarted, watchedRiskRows]);
  const aprDocumentNumber =
    watch("numero") || currentApr?.numero || (id ? "APR" : "Nova APR");
  const aprDocumentTitle =
    tituloApr || currentApr?.titulo || "Atividade ainda não definida";
  const aprDocumentDescription =
    descricaoApr ||
    currentApr?.descricao ||
    "Descreva o escopo, a atividade e as condições relevantes para orientar a análise.";
  const aprDocumentStatus = watchedStatus || currentApr?.status || "Pendente";
  const aprDocumentStatusTone =
    aprDocumentStatus === "Aprovada"
      ? "success"
      : aprDocumentStatus === "Cancelada"
        ? "danger"
        : aprDocumentStatus === "Encerrada"
          ? "neutral"
          : "warning";
  const aprDocumentValidity = formatDocumentPeriod(dataInicioApr, dataFimApr);

  const duplicateRiskRow = useCallback(
    (index: number) => {
      if (isReadOnly) {
        notifyReadOnly("Não é possível duplicar linhas em uma APR bloqueada.");
        return;
      }
      const source = getValues(`itens_risco.${index}` as const);
      appendRisk({
        ...createEmptyRiskRow(),
        ...source,
      });
    },
    [appendRisk, getValues, isReadOnly, notifyReadOnly],
  );

  const moveRiskRow = useCallback(
    (from: number, to: number) => {
      if (isReadOnly) {
        notifyReadOnly("Não é possível reordenar linhas em uma APR bloqueada.");
        return;
      }
      if (to < 0 || to >= riskFields.length) return;
      moveRisk(from, to);
    },
    [isReadOnly, moveRisk, notifyReadOnly, riskFields.length],
  );

  const handleRemoveRiskRow = useCallback(
    (index: number, fieldId: string) => {
      if (isReadOnly) {
        notifyReadOnly("Não é possível remover linhas em uma APR bloqueada.");
        return;
      }
      const hasLine = index >= 0 && index < riskFields.length;
      if (!hasLine) return;

      const pendingKey = `apr-risk-remove-${fieldId}`;
      if (pendingRiskRemovalTimeoutsRef.current.has(pendingKey)) {
        return;
      }

      const finalizeRemoval = () => {
        pendingRiskRemovalTimeoutsRef.current.delete(pendingKey);
        const currentIndex = riskFieldsRef.current.findIndex(
          (field) => field.id === fieldId,
        );
        if (currentIndex < 0) return;

        removeRisk(currentIndex);
        setExpandedRows((prev) => {
          if (prev.size === 0) return prev;
          const next = new Set<number>();
          prev.forEach((rowIndex) => {
            if (rowIndex === currentIndex) return;
            next.add(rowIndex > currentIndex ? rowIndex - 1 : rowIndex);
          });
          return next;
        });
      };

      const timeoutId = setTimeout(finalizeRemoval, 5000);
      pendingRiskRemovalTimeoutsRef.current.set(pendingKey, timeoutId);

      toast.warning("Linha de risco marcada para remoção.", {
        id: pendingKey,
        duration: 5000,
        description:
          "Você pode desfazer esta ação antes da remoção definitiva.",
        action: {
          label: "Desfazer",
          onClick: () => {
            const pendingTimeout =
              pendingRiskRemovalTimeoutsRef.current.get(pendingKey);
            if (pendingTimeout) {
              clearTimeout(pendingTimeout);
              pendingRiskRemovalTimeoutsRef.current.delete(pendingKey);
            }
          },
        },
      });
    },
    [isReadOnly, notifyReadOnly, removeRisk, riskFields.length],
  );

  const toggleExpandedRow = useCallback((index: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  useEffect(() => {
    riskFieldsRef.current = riskFields;
  }, [riskFields]);

  useEffect(() => {
    const pendingRemovals = pendingRiskRemovalTimeoutsRef.current;
    return () => {
      pendingRemovals.forEach((timeoutId) => {
        clearTimeout(timeoutId);
      });
      pendingRemovals.clear();
    };
  }, []);

  // (refatorado) Critério de ação e resumo executivo agora são calculados em componentes isolados.
  /* const ACTION_CRITERIA: Record<string, string> = useMemo(
    () => ({
      Aceitável: "Não são requeridos controles adicionais.",
      Atenção: "Reavaliar e adotar medidas complementares.",
      Substancial: "Não iniciar sem redução de risco.",
      Crítico: "Interromper e agir imediatamente.",
    }),
    [],
  );

  const riskSummary = useMemo(() => {
    const summary = { total: 0, aceitavel: 0, atencao: 0, substancial: 0, critico: 0, incompletas: 0 };
    (watchedRiskItems ?? []).forEach((item) => {
      summary.total += 1;
      const p = String(item?.probabilidade || "");
      const s = String(item?.severidade || "");
      if (!p || !s) {
        summary.incompletas += 1;
        return;
      }
      const calc = calculateAprRiskEvaluation(p, s);
      switch (calc.categoria) {
        case "Aceitável": summary.aceitavel += 1; break;
        case "Atenção": summary.atencao += 1; break;
        case "Substancial": summary.substancial += 1; break;
        case "Crítico": summary.critico += 1; break;
      }
    });
    return summary;
  }, [watchedRiskItems]);

  const getRiskRowCompleteness = useCallback(
    (item: NonNullable<AprFormData["itens_risco"]>[number] | undefined) => {
      if (!item) return "empty";
      const hasIdentification = Boolean(
        item.atividade_processo || item.condicao_perigosa || item.agente_ambiental,
      );
      const hasEvaluation = Boolean(item.probabilidade && item.severidade);
      const hasControl = Boolean(item.medidas_prevencao);
      if (hasIdentification && hasEvaluation && hasControl) return "complete";
      if (hasIdentification || hasEvaluation) return "partial";
      return "empty";
    },
    [],
  );
  */

  // Increment formVersion on dirty to re-trigger compliance debounce
  useEffect(() => {
    if (isDirty) setFormVersion((v) => v + 1);
  }, [isDirty]);

  // Unsaved changes warning
  useEffect(() => {
    if (!isDirty && !signatureChanges.hasPendingChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty, signatureChanges.hasPendingChanges]);

  const applyExcelPreviewToForm = useCallback(
    (preview: AprExcelImportPreview) => {
      if (isReadOnly) {
        notifyReadOnly("Importação não está disponível em uma APR bloqueada.");
        return;
      }
      const applied = applyAprImportPreview(preview, {
        companies,
        sites,
        users,
        selectedCompanyId,
      });

      Object.entries(applied.fieldValues).forEach(([field, value]) => {
        if (!value) {
          return;
        }

        setValue(field as keyof AprFormData, value, {
          shouldDirty: true,
          shouldValidate: true,
        });
      });

      replaceRisk(
        applied.riskItems.length > 0
          ? applied.riskItems.map((item) => normalizeRiskRow(item))
          : [createEmptyRiskRow()],
      );

      if (applied.unresolved.length > 0) {
        toast.warning(
          `Preview aplicado com pendência de vínculo: ${applied.unresolved.join(", ")}.`,
        );
      }

      toast.success(
        `${preview.importedRows} linha(s) da planilha aplicadas ao formulário.`,
      );
    },
    [
      companies,
      isReadOnly,
      notifyReadOnly,
      replaceRisk,
      selectedCompanyId,
      setValue,
      sites,
      users,
    ],
  );

  const handleExcelFileSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      if (isReadOnly) {
        notifyReadOnly("Importação não está disponível em uma APR bloqueada.");
        if (event.target) {
          event.target.value = "";
        }
        return;
      }
      const selectedFile = event.target.files?.[0];
      if (!selectedFile) {
        return;
      }

      try {
        setImportingExcel(true);
        const preview = await aprsService.previewExcelImport(selectedFile);
        setExcelPreview(preview);

        if (preview.errors.length > 0) {
          toast.error(
            preview.errors[0] ||
              "A planilha possui inconsistências de importação.",
          );
          return;
        }

        toast.success(
          `Preview da planilha concluído: ${preview.importedRows} linha(s) pronta(s) para revisão.`,
        );
      } catch (error) {
        logger.error("Erro ao importar planilha APR:", error);
        const message =
          typeof error === "object" &&
          error !== null &&
          "response" in error &&
          typeof (error as { response?: { data?: { message?: string } } })
            .response?.data?.message === "string"
            ? (error as { response?: { data?: { message?: string } } })
                .response!.data!.message
            : "Não foi possível interpretar a planilha APR.";
        toast.error(message);
      } finally {
        setImportingExcel(false);
        if (event.target) {
          event.target.value = "";
        }
      }
    },
    [isReadOnly, notifyReadOnly],
  );

  const hasSuggestedRiskInMatrix = useCallback(
    (suggestion: SophieDraftRiskSuggestion) =>
      (getValuesRef.current("itens_risco") ?? []).some(
        (item) =>
          String(item?.condicao_perigosa || "")
            .trim()
            .toLowerCase() === suggestion.label.trim().toLowerCase(),
      ),
    [],
  );

  const applySuggestedAprRisk = useCallback(
    (suggestion: SophieDraftRiskSuggestion) => {
      if (isReadOnly) {
        notifyReadOnly(
          "Não é possível aplicar sugestões em uma APR bloqueada.",
        );
        return;
      }
      let appliedSelection = false;

      if (suggestion.id && !selectedRiskIds.includes(suggestion.id)) {
        setValue("risks", [...selectedRiskIds, suggestion.id], {
          shouldDirty: true,
          shouldValidate: true,
        });
        appliedSelection = true;
      }

      if (!hasSuggestedRiskInMatrix(suggestion)) {
        appendRisk({
          ...createEmptyRiskRow(),
          atividade_processo: tituloApr || "Atividade assistida pela SOPHIE",
          agente_ambiental: suggestion.category || "",
          condicao_perigosa: suggestion.label,
        });
        appliedSelection = true;
      }

      if (appliedSelection) {
        toast.success(`Sugestão aplicada: ${suggestion.label}`);
      } else {
        toast.info(`A sugestão ${suggestion.label} já está refletida na APR.`);
      }
    },
    [
      appendRisk,
      hasSuggestedRiskInMatrix,
      isReadOnly,
      notifyReadOnly,
      selectedRiskIds,
      setValue,
      tituloApr,
    ],
  );

  const applyAllSuggestedAprRisks = useCallback(() => {
    if (isReadOnly) {
      notifyReadOnly("Não é possível aplicar sugestões em uma APR bloqueada.");
      return;
    }
    let appliedCount = 0;
    const nextSelectedRiskIds = [...selectedRiskIds];
    sophieSuggestedRisks.forEach((suggestion) => {
      const shouldSelect =
        suggestion.id && !nextSelectedRiskIds.includes(suggestion.id);
      const shouldAppend = !hasSuggestedRiskInMatrix(suggestion);

      if (shouldSelect || shouldAppend) {
        if (shouldSelect) {
          nextSelectedRiskIds.push(suggestion.id as string);
        }

        if (shouldAppend) {
          appendRisk({
            ...createEmptyRiskRow(),
            atividade_processo: tituloApr || "Atividade assistida pela SOPHIE",
            agente_ambiental: suggestion.category || "",
            condicao_perigosa: suggestion.label,
          });
        }
        appliedCount += 1;
      }
    });

    if (nextSelectedRiskIds.length !== selectedRiskIds.length) {
      setValue("risks", Array.from(new Set(nextSelectedRiskIds)), {
        shouldDirty: true,
        shouldValidate: true,
      });
    }

    if (appliedCount > 0) {
      toast.success(
        `${appliedCount} sugestão(ões) da SOPHIE aplicadas na APR.`,
      );
    } else {
      toast.info("As sugestões da SOPHIE já foram refletidas na APR.");
    }
  }, [
    appendRisk,
    hasSuggestedRiskInMatrix,
    isReadOnly,
    notifyReadOnly,
    selectedRiskIds,
    setValue,
    sophieSuggestedRisks,
    tituloApr,
  ]);

  const applySelectedActivityTemplate = useCallback(() => {
    if (isReadOnly) {
      notifyReadOnly(
        "Não é possível aplicar template de atividade em uma APR bloqueada.",
      );
      return;
    }
    if (!selectedActivityTemplate) {
      toast.warning("Selecione um tipo de atividade com template disponível.");
      return;
    }

    const templateRows = selectedActivityTemplate.risk_items.map((item) =>
      normalizeRiskRow({
        atividade_processo:
          item.atividade || selectedActivityTemplate.label || tituloApr || "",
        etapa: item.etapa || "",
        agente_ambiental: item.agente_ambiental || "",
        condicao_perigosa: item.condicao_perigosa || "",
        fontes_circunstancias: item.fonte_circunstancia || "",
        possiveis_lesoes: item.lesao || "",
        probabilidade:
          item.probabilidade !== undefined ? String(item.probabilidade) : "",
        severidade:
          item.severidade !== undefined ? String(item.severidade) : "",
        medidas_prevencao: item.medidas_prevencao || "",
        responsavel: item.responsavel || "",
        status_acao: item.status_acao || "Pendente",
      }),
    );

    const currentRows = (getValues("itens_risco") || []).map((item) =>
      normalizeRiskRow(item),
    );
    const existingKeys = new Set(
      currentRows.filter((item) => isRiskRowStarted(item)).map(buildRiskRowKey),
    );
    const uniqueTemplateRows = templateRows.filter(
      (row) => !existingKeys.has(buildRiskRowKey(row)),
    );

    if (uniqueTemplateRows.length === 0) {
      toast.info(
        "Os riscos principais deste template já estão refletidos na grade da APR.",
      );
      return;
    }

    const nextRows = currentRows.some((item) => isRiskRowStarted(item))
      ? [...currentRows, ...uniqueTemplateRows]
      : uniqueTemplateRows;
    replaceRisk(nextRows);
    clearErrors("itens_risco");
    toast.success(
      `${uniqueTemplateRows.length} linha(s) do template ${selectedActivityTemplate.label} aplicadas à APR.`,
    );
  }, [
    clearErrors,
    getValues,
    isReadOnly,
    isRiskRowStarted,
    notifyReadOnly,
    replaceRisk,
    selectedActivityTemplate,
    tituloApr,
  ]);

  const { handleSubmit: onSubmit, loading } = useFormSubmit(
    async (data: AprFormData) => {
      if (id && isReadOnly) {
        throw new Error(
          hasFinalPdf
            ? "APR com PDF final emitido está bloqueada. Crie uma nova versão."
            : readOnlyReason ||
                "APR bloqueada para edição. Utilize o fluxo formal ou gere nova versão quando aplicável.",
        );
      }
      // A fila offline usa dedupeKey para manter um único envio por rascunho.
      // Só bloqueamos quando a sincronização está efetivamente em andamento,
      // evitando que um estado "queued/failed" prenda o usuário sem conseguir reenviar.
      if (draftPendingOfflineSync?.status === "syncing") {
        registerOfflineBlocked("pending_sync_lock");
        throw new Error(
          "A sincronização desta APR está em andamento. Aguarde concluir ou use a listagem para acompanhar o envio.",
        );
      }
      // Se o usuário está online e existe estado pendente em "queued/failed/orphaned",
      // limpamos a fila local antes de enviar o submit atual, evitando duplicidade
      // (um item antigo sincronizando depois) e removendo estados travados.
      if (!isOffline && draftPendingOfflineSync) {
        try {
          if (
            draftPendingOfflineSync.status === "queued" ||
            draftPendingOfflineSync.status === "failed" ||
            draftPendingOfflineSync.status === "orphaned"
          ) {
            if (draftPendingOfflineSync.queueItemId) {
              await removeOfflineQueueItem(draftPendingOfflineSync.queueItemId);
            } else if (draftPendingOfflineSync.dedupeKey) {
              const queue = await getOfflineQueueSnapshot();
              const queuedItem = queue.find(
                (item) => item.dedupeKey === draftPendingOfflineSync.dedupeKey,
              );
              if (queuedItem?.id) {
                await removeOfflineQueueItem(queuedItem.id);
              }
            }

            persistPendingOfflineSync(null);
            trackAprOfflineTelemetry("offline_discarded", {
              draftId: draftPendingOfflineSync.draftId,
              queueItemId: draftPendingOfflineSync.queueItemId,
              dedupeKey: draftPendingOfflineSync.dedupeKey,
              syncStatus: draftPendingOfflineSync.status,
              source: "auto_discard_on_online_submit",
            });
          }
        } catch {
          // Best-effort: se falhar a limpeza, não bloqueia o envio online.
        }
      }
      if (!canManageSignatures && signatureChanges.hasPendingChanges) {
        throw new Error(
          "Seu perfil não permite gerenciar assinaturas da APR. Salve apenas a APR base e solicite as assinaturas a um perfil autorizado.",
        );
      }
      if (isOffline && signatureChanges.hasPendingChanges) {
        registerOfflineBlocked("signature_requires_online");
        throw new Error(
          "Assinaturas da APR só podem ser concluídas online. Reconecte-se para enviar as assinaturas ou remova as alterações de assinatura antes de salvar offline.",
        );
      }
      if (isOffline && submitIntentRef.current === "save_and_print") {
        registerOfflineBlocked("save_and_print_requires_online");
        throw new Error(
          'Salvar e imprimir exige conexão ativa. Use apenas "Salvar" para enfileirar a APR base e finalize a impressão quando estiver online.',
        );
      }

      let aprId = id;
      let offlineQueued = false;
      let offlineQueueItemId: string | undefined;
      let offlineQueueDeduplicated = false;
      const basePayload = Object.fromEntries(
        Object.entries(data).filter(
          ([key]) => key !== "pdf_signed" && key !== "itens_risco",
        ),
      ) as AprMutationPayload;
      const normalizeOptionalString = (value: unknown): string | undefined => {
        if (typeof value !== "string") {
          return undefined;
        }
        const trimmed = value.trim();
        return trimmed ? trimmed : undefined;
      };
      const normalizedRiskItems: AprRiskItemInput[] = (
        data.itens_risco || []
      ).map((item) => ({
        atividade_processo: normalizeOptionalString(item.atividade_processo),
        etapa: normalizeOptionalString(item.etapa),
        agente_ambiental: normalizeOptionalString(item.agente_ambiental),
        condicao_perigosa: normalizeOptionalString(item.condicao_perigosa),
        fonte_circunstancia: normalizeOptionalString(
          item.fontes_circunstancias,
        ),
        possiveis_lesoes: normalizeOptionalString(item.possiveis_lesoes),
        probabilidade: item.probabilidade
          ? Number(item.probabilidade)
          : undefined,
        severidade: item.severidade ? Number(item.severidade) : undefined,
        categoria_risco: normalizeOptionalString(item.categoria_risco),
        medidas_prevencao: normalizeOptionalString(item.medidas_prevencao),
        epc: normalizeOptionalString(item.epc),
        epi: normalizeOptionalString(item.epi),
        permissao_trabalho: normalizeOptionalString(item.permissao_trabalho),
        normas_relacionadas: normalizeOptionalString(item.normas_relacionadas),
        hierarquia_controle: normalizeOptionalString(
          item.hierarquia_controle,
        ) as AprRiskItemInput["hierarquia_controle"] | undefined,
        responsavel: normalizeOptionalString(item.responsavel),
        prazo: normalizeOptionalString(item.prazo),
        status_acao: normalizeOptionalString(item.status_acao),
      }));
      const payload = {
        ...basePayload,
        risk_items: normalizedRiskItems,
      } as AprMutationPayload & {
        risk_items: AprRiskItemInput[];
      };

      if (id && isApproved) {
        throw new Error(
          "APR aprovada está bloqueada para edição. Emita o PDF final na listagem ou crie uma nova versão para alterar o documento.",
        );
      }

      const allowOfflineQueue = !signatureChanges.hasPendingChanges;

      if (id) {
        const updated = await aprsService.update(id, payload, {
          allowOfflineQueue,
          offlineSync: {
            correlationId: offlineSyncIdentity?.correlationId,
            dedupeKey: offlineSyncIdentity?.dedupeKey,
            draftId: draftId || undefined,
            source: "apr_form",
            // Passa o updated_at do registro carregado para detecção de conflito
            // no servidor caso a APR seja editada simultaneamente por outro usuário
            conflictGuardUpdatedAt: currentApr?.updated_at
              ? String(currentApr.updated_at)
              : undefined,
          },
        });
        offlineQueued = Boolean(
          (
            updated as Apr & {
              offlineQueued?: boolean;
              offlineQueueItemId?: string;
              offlineQueueDeduplicated?: boolean;
            }
          ).offlineQueued,
        );
        offlineQueueItemId = (
          updated as Apr & {
            offlineQueued?: boolean;
            offlineQueueItemId?: string;
            offlineQueueDeduplicated?: boolean;
          }
        ).offlineQueueItemId;
        offlineQueueDeduplicated = Boolean(
          (
            updated as Apr & {
              offlineQueued?: boolean;
              offlineQueueItemId?: string;
              offlineQueueDeduplicated?: boolean;
            }
          ).offlineQueueDeduplicated,
        );
      } else {
        const newApr = await aprsService.create(payload, {
          allowOfflineQueue,
          offlineSync: {
            correlationId: offlineSyncIdentity?.correlationId,
            dedupeKey: offlineSyncIdentity?.dedupeKey,
            draftId: draftId || undefined,
            source: "apr_form",
          },
        });
        aprId = newApr.id;
        offlineQueued = Boolean(
          (
            newApr as Apr & {
              offlineQueued?: boolean;
              offlineQueueItemId?: string;
              offlineQueueDeduplicated?: boolean;
            }
          ).offlineQueued,
        );
        offlineQueueItemId = (
          newApr as Apr & {
            offlineQueued?: boolean;
            offlineQueueItemId?: string;
            offlineQueueDeduplicated?: boolean;
          }
        ).offlineQueueItemId;
        offlineQueueDeduplicated = Boolean(
          (
            newApr as Apr & {
              offlineQueued?: boolean;
              offlineQueueItemId?: string;
              offlineQueueDeduplicated?: boolean;
            }
          ).offlineQueueDeduplicated,
        );
      }

      if (aprId && !offlineQueued) {
        if (signatureChanges.hasPendingChanges && !canManageSignatures) {
          throw new Error(
            "Seu perfil não permite gerenciar assinaturas da APR.",
          );
        }

        if (canManageSignatures) {
          const signatureIdsToDelete = signatureChanges.signaturesToDelete
            .map(([, persisted]) => persisted.id)
            .filter((signatureId): signatureId is string =>
              Boolean(signatureId),
            );

          if (signatureIdsToDelete.length > 0) {
            await Promise.all(
              signatureIdsToDelete.map((signatureId) =>
                signaturesService.deleteById(signatureId),
              ),
            );
          }

          if (signatureChanges.signaturesToCreate.length > 0) {
            await Promise.all(
              signatureChanges.signaturesToCreate.map(([userId, sig]) =>
                signaturesService.create({
                  user_id: userId,
                  document_id: aprId as string,
                  document_type: "APR",
                  signature_data: sig.data,
                  type: sig.type,
                }),
              ),
            );
          }
        }
      }

      if (id && !offlineQueued) {
        const updatedApr = await aprsService.findOne(id);
        setCurrentApr(updatedApr);
        setValue("status", updatedApr.status);
        void reloadAprWorkflowTimeline(id);
      }

      return {
        aprId: aprId || undefined,
        offlineQueued,
        offlineQueueItemId,
        offlineQueueDeduplicated,
      } as AprSubmitResult;
    },
    {
      successMessage: (result) => {
        const submitResult = (result as AprSubmitResult | undefined) || {};
        if (submitResult.offlineQueued) {
          return "APR base enfileirada para sincronização. Assinaturas e emissão final continuam bloqueadas até o retorno da conexão.";
        }
        return id
          ? "APR atualizada com sucesso!"
          : "APR cadastrada com sucesso!";
      },
      redirectTo: "/dashboard/aprs",
      skipRedirect: (result) => {
        const submitResult = (result as AprSubmitResult | undefined) || {};
        return (
          submitIntentRef.current === "save_and_print" ||
          Boolean(submitResult.offlineQueued)
        );
      },
      context: "APR",
      onSuccess: (result) => {
        const submitResult = (result as AprSubmitResult | undefined) || {};

        if (submitResult.offlineQueued) {
          const resolvedDraftId = draftId || createAprDraftMetadata().draftId;
          if (!draftId) {
            setDraftId(resolvedDraftId);
          }
          const pendingSync: AprDraftPendingOfflineSync = {
            draftId: resolvedDraftId,
            queuedAt: new Date().toISOString(),
            lastUpdatedAt: new Date().toISOString(),
            queueItemId: submitResult.offlineQueueItemId,
            dedupeKey: offlineSyncIdentity?.dedupeKey,
            aprId: submitResult.aprId,
            intent: submitIntentRef.current,
            status: "queued",
          };
          persistPendingOfflineSync(pendingSync);
          trackAprOfflineTelemetry(
            submitResult.offlineQueueDeduplicated
              ? "offline_deduplicated"
              : "offline_enqueued",
            {
              draftId: pendingSync.draftId,
              queueItemId: pendingSync.queueItemId,
              dedupeKey: pendingSync.dedupeKey,
              aprId: pendingSync.aprId,
              syncStatus: pendingSync.status,
              intent: pendingSync.intent,
              source: "apr_submit_success",
            },
          );
          toast.info(
            submitResult.offlineQueueDeduplicated
              ? "A APR base já estava enfileirada. Atualizamos o envio local existente sem criar duplicidade."
              : "A APR base foi salva localmente e enfileirada para sincronização. Assinaturas e emissão final continuam pendentes.",
          );
          return;
        }

        clearDraftState();

        if (submitIntentRef.current !== "save_and_print") {
          return;
        }

        const finishRedirect = () => {
          router.push("/dashboard/aprs");
          router.refresh();
        };

        if (!submitResult.aprId || submitResult.offlineQueued) {
          toast.info(
            "APR salva em modo offline. A impressão ficará disponível após sincronização.",
          );
          finishRedirect();
          return;
        }

        void (async () => {
          let didNavigateToPdf = false;
          let usedPopup = false;
          try {
            const result = await handlePrintAfterSave(
              submitResult.aprId as string,
            );
            didNavigateToPdf = result.didNavigateToPdf;
            usedPopup = result.usedPopup;
          } catch (printError) {
            logger.error(
              "Erro ao preparar impressão automática da APR:",
              printError,
            );
            toast.warning(
              "APR salva, mas não foi possível abrir a impressão automática.",
            );
          } finally {
            // Se o pop-up foi bloqueado, caímos para abrir o PDF na mesma aba
            // (window.location.assign). Nesse cenário, redirecionar aqui pode
            // interromper a navegação e o usuário não vê o PDF para imprimir.
            if (!didNavigateToPdf || usedPopup) {
              finishRedirect();
            }
          }
        })();
      },
    },
  );

  useEffect(() => {
    if (!isModelo) {
      setValue("is_modelo_padrao", false);
    }
  }, [isModelo, setValue]);

  const handleAiAnalysis = async () => {
    if (isReadOnly) {
      notifyReadOnly(
        "Ações de sugestão/análise não estão disponíveis em modo somente leitura.",
      );
      return;
    }
    if (!isAiEnabled()) {
      toast.error("IA desativada neste ambiente.");
      return;
    }
    const titulo = watch("titulo");
    const descricao = watch("descricao");

    if (!titulo && !descricao) {
      toast.error("Preencha o título ou descrição para a análise do SGS.");
      return;
    }

    try {
      setAnalyzing(true);
      const result = await aiService.analyzeApr(
        titulo + " " + (descricao || ""),
      );

      if (result.risks.length > 0) {
        setValue("risks", [...new Set([...selectedRiskIds, ...result.risks])]);
      }

      if (result.epis.length > 0) {
        setValue("epis", [...new Set([...selectedEpiIds, ...result.epis])]);
      }

      toast.success("SGS analisou a atividade e sugeriu riscos e EPIs!", {
        description: result.explanation,
        duration: 5000,
      });
    } catch (error) {
      logger.error("Erro na análise do SGS:", error);
      toast.error("Não foi possível realizar a análise no momento.");
    } finally {
      setAnalyzing(false);
    }
  };

  const {
    capturingGps,
    gpsReady,
    handleSuggestControls,
    handleApproveApr,
    handleEmitGovernedPdf,
    handleCloseApr,
    confirmFormAction,
    handleOpenGovernedPdf,
    handleCreateVersion,
    handleCompareVersions,
    handleCaptureLocation,
    handleUploadEvidence,
  } = useAprWorkflowActions({
    id,
    currentApr,
    isReadOnly,
    isOffline,
    canApproveCurrentApr,
    riskRowCount: riskFields.length,
    tituloApr,
    compareTargetId,
    selectedRiskItemEvidence,
    evidenceFile,
    evidenceLatitude,
    evidenceLongitude,
    evidenceAccuracy,
    formActionModal,
    watch,
    setValue,
    notifyReadOnly,
    registerOfflineBlocked,
    ensureGovernedPdf,
    reloadAprWorkflowContext,
    navigateToApr: (aprId) => router.push(`/dashboard/aprs/edit/${aprId}`),
    setSuggestingControls,
    setEmittingGovernedPdf,
    setClosingApr,
    setCreatingVersion,
    setComparing,
    setCompareResult,
    setEvidenceFile,
    setEvidenceLatitude,
    setEvidenceLongitude,
    setEvidenceAccuracy,
    setUploadingEvidence,
    setAprEvidences,
    setFormActionModal,
    setFormActionModalLoading,
    setFinalizing,
  });

  useAprInitialData({
    id,
    user,
    canViewSignatures,
    draftStorageKey,
    legacyDraftStorageKey,
    getValuesRef,
    reset,
    setValue,
    replaceRisk,
    setFetching,
    setLoadingTimeline,
    setCurrentApr,
    setAprLogs,
    setVersionHistory,
    setAprEvidences,
    setActivities,
    setRisks,
    setEpis,
    setTools,
    setMachines,
    setSites,
    setUsers,
    setCompanies,
    setSignatures,
    setPersistedSignatures,
    setCurrentStep,
    setDraftId,
    setDraftRestored,
    setDraftPendingOfflineSync,
    setDraftSecurityNotice,
    setSophieSuggestedRisks,
    setSophieMandatoryChecklists,
  });

  useEffect(() => {
    if (draftSecurityNotice.corrupted) {
      toast.warning(
        "Um rascunho local inválido foi descartado para proteger a integridade da APR.",
      );
      setDraftSecurityNotice((prev) => ({ ...prev, corrupted: false }));
    }

    if (draftSecurityNotice.sensitiveDataRemoved) {
      toast.warning(
        "Assinaturas antigas não foram restauradas do navegador por segurança. Recolha-as novamente quando estiver online.",
      );
      setDraftSecurityNotice((prev) => ({
        ...prev,
        sensitiveDataRemoved: false,
      }));
    }
  }, [draftSecurityNotice, setDraftSecurityNotice]);

  useEffect(() => {
    if (!draftPendingOfflineSync) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const queue = await getOfflineQueueSnapshot();
      if (cancelled) {
        return;
      }

      const queuedItem = queue.find(
        (item) =>
          item.id === draftPendingOfflineSync.queueItemId ||
          (draftPendingOfflineSync.dedupeKey &&
            item.dedupeKey === draftPendingOfflineSync.dedupeKey),
      );

      if (queuedItem) {
        const nextStatus: AprOfflineSyncStatus =
          queuedItem.state === "retry_waiting" ? "failed" : "queued";
        const nextError =
          queuedItem.state === "retry_waiting"
            ? queuedItem.lastError
            : undefined;

        if (
          draftPendingOfflineSync.queueItemId !== queuedItem.id ||
          draftPendingOfflineSync.status !== nextStatus ||
          draftPendingOfflineSync.lastError !== nextError
        ) {
          persistPendingOfflineSync({
            ...draftPendingOfflineSync,
            queueItemId: queuedItem.id,
            dedupeKey: queuedItem.dedupeKey,
            draftId: draftPendingOfflineSync.draftId,
            status: nextStatus,
            lastError: nextError,
            lastUpdatedAt: new Date().toISOString(),
          });
        }

        return;
      }

      if (
        draftPendingOfflineSync.status !== "synced_base" &&
        draftPendingOfflineSync.status !== "orphaned"
      ) {
        const nextPending = {
          ...draftPendingOfflineSync,
          status: "orphaned" as const,
          lastError:
            draftPendingOfflineSync.lastError ||
            "O envio local não foi encontrado na fila offline atual.",
          lastUpdatedAt: new Date().toISOString(),
        };
        persistPendingOfflineSync(nextPending);
        trackAprOfflineTelemetry("offline_orphaned", {
          draftId: draftPendingOfflineSync.draftId,
          queueItemId: draftPendingOfflineSync.queueItemId,
          dedupeKey: draftPendingOfflineSync.dedupeKey,
          syncStatus: "orphaned",
          source: "apr_form_reconcile",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftPendingOfflineSync, persistPendingOfflineSync]);

  useEffect(() => {
    if (!draftPendingOfflineSync) {
      return;
    }

    const handleOfflineSyncItem = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          status?: string;
          error?: string;
          item?: {
            id?: string;
            dedupeKey?: string;
          };
        }>
      ).detail;
      const itemId = detail?.item?.id;
      const dedupeKey = detail?.item?.dedupeKey;
      const matchesCurrentDraft =
        itemId === draftPendingOfflineSync.queueItemId ||
        (draftPendingOfflineSync.dedupeKey &&
          dedupeKey === draftPendingOfflineSync.dedupeKey);

      if (!matchesCurrentDraft) {
        return;
      }

      const now = new Date().toISOString();

      if (detail.status === "syncing") {
        persistPendingOfflineSync({
          ...draftPendingOfflineSync,
          status: "syncing",
          lastUpdatedAt: now,
        });
        trackAprOfflineTelemetry("offline_syncing", {
          draftId: draftPendingOfflineSync.draftId,
          queueItemId: draftPendingOfflineSync.queueItemId,
          dedupeKey: draftPendingOfflineSync.dedupeKey,
          syncStatus: "syncing",
          source: "offline_queue_event",
        });
        return;
      }

      if (detail.status === "sent") {
        persistPendingOfflineSync({
          ...draftPendingOfflineSync,
          status: "synced_base",
          lastError: undefined,
          lastUpdatedAt: now,
        });
        trackAprOfflineTelemetry("offline_synced", {
          draftId: draftPendingOfflineSync.draftId,
          queueItemId: draftPendingOfflineSync.queueItemId,
          dedupeKey: draftPendingOfflineSync.dedupeKey,
          syncStatus: "synced_base",
          source: "offline_queue_event",
        });
        return;
      }

      if (detail.status === "retry_scheduled") {
        persistPendingOfflineSync({
          ...draftPendingOfflineSync,
          status: "failed",
          lastError: detail.error,
          lastUpdatedAt: now,
        });
        trackAprOfflineTelemetry("offline_failed", {
          draftId: draftPendingOfflineSync.draftId,
          queueItemId: draftPendingOfflineSync.queueItemId,
          dedupeKey: draftPendingOfflineSync.dedupeKey,
          syncStatus: "failed",
          reason: detail.error,
          source: "offline_queue_event",
        });
        return;
      }

      if (detail.status === "deduplicated") {
        persistPendingOfflineSync({
          ...draftPendingOfflineSync,
          status: "queued",
          lastError: undefined,
          lastUpdatedAt: now,
        });
        trackAprOfflineTelemetry("offline_deduplicated", {
          draftId: draftPendingOfflineSync.draftId,
          queueItemId: draftPendingOfflineSync.queueItemId,
          dedupeKey: draftPendingOfflineSync.dedupeKey,
          syncStatus: "queued",
          source: "offline_queue_event",
        });
        return;
      }

      if (detail.status === "conflict") {
        toast.error(
          "Conflito de edição: a APR foi modificada por outro usuário enquanto você estava offline. Recarregue a página e aplique suas alterações novamente.",
          { duration: 8000 },
        );
        persistPendingOfflineSync({
          ...draftPendingOfflineSync,
          status: "failed",
          lastError: detail.error ?? "Conflito de edição simultânea.",
          lastUpdatedAt: now,
        });
        trackAprOfflineTelemetry("offline_conflict", {
          draftId: draftPendingOfflineSync.draftId,
          queueItemId: draftPendingOfflineSync.queueItemId,
          dedupeKey: draftPendingOfflineSync.dedupeKey,
          syncStatus: "failed",
          source: "offline_queue_event",
        });
        return;
      }

      if (
        detail.status === "removed" &&
        draftPendingOfflineSync.status !== "synced_base"
      ) {
        persistPendingOfflineSync({
          ...draftPendingOfflineSync,
          status: "orphaned",
          lastError: "O envio local foi removido da fila offline.",
          lastUpdatedAt: now,
        });
        trackAprOfflineTelemetry("offline_orphaned", {
          draftId: draftPendingOfflineSync.draftId,
          queueItemId: draftPendingOfflineSync.queueItemId,
          dedupeKey: draftPendingOfflineSync.dedupeKey,
          syncStatus: "orphaned",
          source: "offline_queue_event",
        });
      }
    };

    window.addEventListener(
      "app:offline-sync-item",
      handleOfflineSyncItem as EventListener,
    );

    return () => {
      window.removeEventListener(
        "app:offline-sync-item",
        handleOfflineSyncItem as EventListener,
      );
    };
  }, [draftPendingOfflineSync, persistPendingOfflineSync]);

  useAprCatalogs({
    id,
    selectedCompanyId,
    selectedSiteId,
    user,
    setValue,
    setActivities,
    setRisks,
    setEpis,
    setTools,
    setMachines,
    setSites,
    setUsers,
  });

  useEffect(() => {
    if (isReadOnly) return;
    if (fetching) return;
    if (!draftStorageKey || typeof window === "undefined" || id) {
      return;
    }

    const subscription = watch(() => {
      scheduleDraftPersist();
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [draftStorageKey, fetching, id, isReadOnly, scheduleDraftPersist, watch]);

  useEffect(() => {
    if (isReadOnly) return;
    if (fetching) return;
    if (!draftStorageKey || typeof window === "undefined" || id) {
      return;
    }

    scheduleDraftPersist();
  }, [
    currentStep,
    draftMetadata,
    draftStorageKey,
    fetching,
    id,
    isReadOnly,
    scheduleDraftPersist,
  ]);

  // M01 — Auto-seleciona empresa/site quando há apenas uma opção (nova APR)
  useEffect(() => {
    if (id || isReadOnly) return;
    const onlyCompany = companies[0];
    if (companies.length === 1 && !selectedCompanyId && onlyCompany) {
      setValue("company_id", onlyCompany.id, { shouldDirty: false });
    }
  }, [companies, id, isReadOnly, selectedCompanyId, setValue]);

  useEffect(() => {
    if (id || isReadOnly) return;
    if (!activeSite?.siteId) return;
    if (selectedSiteId !== activeSite.siteId) {
      setValue("site_id", activeSite.siteId, { shouldDirty: false, shouldValidate: true });
    }
  }, [activeSite?.siteId, id, isReadOnly, selectedSiteId, setValue]);

  useEffect(() => {
    if (!activeSite?.siteId && !id) {
      setValue("site_id", "", { shouldDirty: false, shouldValidate: true });
    }
  }, [activeSite?.siteId, id, setValue]);

  useEffect(() => {
    if (id || !activeSite?.siteId) return;
    if (selectedSiteId !== activeSite.siteId) {
      setValue("site_id", activeSite.siteId, { shouldDirty: false, shouldValidate: true });
    }
  }, [activeSite?.siteId, id, selectedSiteId, setValue]);

  // M03 — Força re-render a cada 10s para manter o timestamp relativo do draft atualizado
  useEffect(() => {
    if (!draftLastSavedAt) return;
    const timer = setInterval(() => setDraftRelativeTick((t) => t + 1), 10000);
    return () => clearInterval(timer);
  }, [draftLastSavedAt]);

  const toggleSelection = useCallback(
    (
      field:
        | "activities"
        | "risks"
        | "epis"
        | "tools"
        | "machines"
        | "participants",
      value: string,
    ) => {
      if (isReadOnly) {
        notifyReadOnly(
          "Não é possível alterar seleções/assinaturas em uma APR bloqueada.",
        );
        return;
      }
      const current = watch(field) || [];
      const isSelected = current.includes(value);

      if (field === "participants") {
        if (draftPendingOfflineSync) {
          registerOfflineBlocked("pending_sync_signature_lock");
          toast.warning(
            "Libere o rascunho pendente antes de alterar participantes ou assinaturas.",
          );
          return;
        }
        if (isSelected) {
          const updated = current.filter((id: string) => id !== value);
          setValue(field, updated, { shouldValidate: true });
          if (canManageSignatures) {
            const newSignatures = { ...signatures };
            delete newSignatures[value];
            setSignatures(newSignatures);
          }
        } else {
          if (!canManageSignatures) {
            const updated = [...current, value];
            setValue(field, updated, { shouldValidate: true });
            toast.info(
              "Participante adicionado. A assinatura da APR deve ser coletada por um perfil autorizado.",
            );
            return;
          }
          if (isOffline) {
            registerOfflineBlocked("signature_capture_requires_online");
            toast.warning(
              "A captura de assinaturas da APR exige conexão ativa. Salve a APR base offline e conclua as assinaturas quando estiver online.",
            );
            return;
          }
          const user = users.find((u) => u.id === value);
          if (user) {
            setCurrentSigningUser(user);
            setIsSignatureModalOpen(true);
          }
        }
      } else {
        const updated = isSelected
          ? current.filter((id: string) => id !== value)
          : [...current, value];
        setValue(field, updated, { shouldValidate: true });
      }
    },
    [
      canManageSignatures,
      draftPendingOfflineSync,
      isOffline,
      isReadOnly,
      notifyReadOnly,
      registerOfflineBlocked,
      setValue,
      signatures,
      users,
      watch,
    ],
  );

  const handleSaveSignature = useCallback(
    (signatureData: string, type: string) => {
      if (isReadOnly) {
        notifyReadOnly(
          "Não é possível salvar assinaturas em uma APR bloqueada.",
        );
        return;
      }
      if (!canManageSignatures) {
        toast.warning("Seu perfil não permite gerenciar assinaturas da APR.");
        return;
      }
      if (currentSigningUser) {
        setSignatures((prev) => ({
          ...prev,
          [currentSigningUser.id]: { data: signatureData, type },
        }));

        const current = watch("participants") || [];
        const updated = Array.from(
          new Set([...current, currentSigningUser.id]),
        );
        setValue("participants", updated, { shouldValidate: true });
        toast.success(`Assinatura de ${currentSigningUser.nome} capturada!`);
      }
    },
    [
      canManageSignatures,
      currentSigningUser,
      isReadOnly,
      notifyReadOnly,
      setValue,
      watch,
    ],
  );
  const handleReleasePendingOfflineState = useCallback(() => {
    if (!draftPendingOfflineSync) {
      return;
    }

    persistPendingOfflineSync(null);
    trackAprOfflineTelemetry("offline_released", {
      draftId: draftPendingOfflineSync.draftId,
      queueItemId: draftPendingOfflineSync.queueItemId,
      dedupeKey: draftPendingOfflineSync.dedupeKey,
      syncStatus: draftPendingOfflineSync.status,
      source: "manual_release",
    });
    toast.info(
      draftPendingOfflineSync.status === "synced_base"
        ? "A APR base já sincronizou. Agora você pode concluir assinaturas e emissão final online."
        : "O estado pendente foi liberado. Verifique a listagem antes de reenviar para evitar duplicidade operacional.",
    );
  }, [draftPendingOfflineSync, persistPendingOfflineSync]);
  const handleDiscardPendingOfflineSync = useCallback(() => {
    if (!draftPendingOfflineSync) {
      return;
    }
    setConfirmDiscardOpen(true);
  }, [draftPendingOfflineSync]);

  const handleConfirmDiscardPendingOfflineSync = useCallback(async () => {
    if (!draftPendingOfflineSync) {
      setConfirmDiscardOpen(false);
      return;
    }
    if (draftPendingOfflineSync.queueItemId) {
      await removeOfflineQueueItem(draftPendingOfflineSync.queueItemId);
    }
    persistPendingOfflineSync(null);
    trackAprOfflineTelemetry("offline_discarded", {
      draftId: draftPendingOfflineSync.draftId,
      queueItemId: draftPendingOfflineSync.queueItemId,
      dedupeKey: draftPendingOfflineSync.dedupeKey,
      syncStatus: draftPendingOfflineSync.status,
      source: "manual_discard",
    });
    setConfirmDiscardOpen(false);
    toast.info(
      "O envio local foi descartado. O rascunho sanitizado continua disponível para novo envio controlado.",
    );
  }, [draftPendingOfflineSync, persistPendingOfflineSync]);
  // C03 — Confirma troca de empresa descartando dados preenchidos
  const handleConfirmCompanyChange = useCallback(() => {
    if (!pendingCompanyId) return;
    setValue("company_id", pendingCompanyId);
    setValue("site_id", "");
    setValue("elaborador_id", "");
    setValue("activities", []);
    setValue("risks", []);
    setValue("epis", []);
    setValue("tools", []);
    setValue("machines", []);
    setValue("participants", []);
    replaceRisk([]);
    setConfirmCompanyChangeOpen(false);
    setPendingCompanyId(null);
  }, [pendingCompanyId, replaceRisk, setValue]);

  const handleRetryPendingOfflineSync = useCallback(async () => {
    if (!draftPendingOfflineSync?.queueItemId) {
      return;
    }

    const result = await retryOfflineQueueItem(
      draftPendingOfflineSync.queueItemId,
    );
    if (result.status === "sent") {
      toast.success(
        "A APR base foi sincronizada. Conclua as assinaturas e a emissão final online.",
      );
      return;
    }

    if (result.status === "pending") {
      toast.info(
        "A sincronização foi tentada novamente. O envio local continua em acompanhamento.",
      );
      return;
    }

    toast.warning(
      "A retentativa não pôde concluir a sincronização agora. Revise o estado da fila ou descarte o envio local.",
    );
  }, [draftPendingOfflineSync?.queueItemId]);
  const canReleasePendingOfflineState =
    draftPendingOfflineSync?.status === "synced_base" ||
    draftPendingOfflineSync?.status === "orphaned";
  const canRetryPendingOfflineState =
    draftPendingOfflineSync?.status === "failed" &&
    Boolean(draftPendingOfflineSync.queueItemId);
  const isDraftSyncInFlight = draftPendingOfflineSync?.status === "syncing";
  const saveAndPrintBlockReason = isOffline
    ? "Salvar e imprimir exige conexão ativa."
    : isDraftSyncInFlight
      ? "Sincronização em andamento para este rascunho."
      : null;
  const saveBlockReason = isDraftSyncInFlight
    ? "Sincronização em andamento para este rascunho."
    : null;

  const nextStep = useCallback(async () => {
    let fields: (keyof AprFormData)[] = [];
    let hasBlockingError = false;

    if (currentStep === 1) {
      fields = [
        "numero",
        "titulo",
        "tipo_atividade",
        "frente_trabalho",
        "turno",
        "local_execucao_detalhado",
        "responsavel_tecnico_nome",
        "responsavel_tecnico_registro",
        "company_id",
        "site_id",
        "elaborador_id",
        "data_inicio",
        "data_fim",
      ];
    } else if (currentStep === 2) {
      fields = ["participants", "itens_risco"];
    }

    const isValid = await trigger(fields);
    hasBlockingError = !isValid;

    if (currentStep === 1) {
      const requiredStepOneFields: Array<keyof AprFormData> = [
        "tipo_atividade",
        "frente_trabalho",
        "turno",
        "local_execucao_detalhado",
        "responsavel_tecnico_nome",
        "responsavel_tecnico_registro",
      ];

      const fieldMessages: Partial<Record<keyof AprFormData, string>> = {
        tipo_atividade: "Selecione o tipo de atividade da APR.",
        frente_trabalho: "Informe a frente de trabalho.",
        turno: "Informe o turno previsto.",
        local_execucao_detalhado:
          "Informe o local detalhado de execução da APR.",
        responsavel_tecnico_nome: "Informe o responsável técnico pela APR.",
        responsavel_tecnico_registro:
          "Informe o registro profissional do responsável técnico.",
      };

      requiredStepOneFields.forEach((field) => {
        if (hasText(getValues(field))) {
          clearErrors(field);
          return;
        }
        setError(field, {
          type: "manual",
          message: fieldMessages[field] || "Campo obrigatório.",
        });
        hasBlockingError = true;
      });
    } else if (currentStep === 2) {
      if (selectedParticipantIds.length === 0) {
        setError("participants", {
          type: "manual",
          message: "Selecione ao menos um participante assinante para avançar.",
        });
        hasBlockingError = true;
      } else {
        clearErrors("participants");
      }

      if (materiallyCompleteRiskCount === 0) {
        setError("itens_risco", {
          type: "manual",
          message:
            "Inclua pelo menos uma linha de risco com identificação, avaliação e controles para revisar a APR.",
        });
        hasBlockingError = true;
      } else {
        clearErrors("itens_risco");
      }
    }

    if (hasBlockingError) return;

    setCurrentStep((prev) => {
      const next = prev + 1;
      setVisitedSteps((vs) => new Set([...vs, next]));
      return next;
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [
    clearErrors,
    currentStep,
    getValues,
    materiallyCompleteRiskCount,
    selectedParticipantIds.length,
    setError,
    trigger,
  ]);

  const prevStep = useCallback(() => {
    setCurrentStep((prev) => prev - 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleHeaderSave = useCallback(() => {
    submitIntentRef.current = "save";
    void handleSubmit(onSubmit)();
  }, [handleSubmit, onSubmit]);

  const handleHeaderPdfAction = useCallback(() => {
    if (hasFinalPdf) {
      void handleOpenGovernedPdf();
      return;
    }

    if (isApproved) {
      void handleEmitGovernedPdf();
      return;
    }

    submitIntentRef.current = "save_and_print";
    void handleSubmit(onSubmit)();
  }, [
    handleEmitGovernedPdf,
    handleOpenGovernedPdf,
    handleSubmit,
    hasFinalPdf,
    isApproved,
    onSubmit,
  ]);

  const handleHeaderHistory = useCallback(() => {
    const historyElement = document.getElementById("apr-history");
    if (!historyElement) {
      toast.info("O histórico será exibido depois que a APR for salva.");
      return;
    }

    historyElement.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div
      className={cn(
        "ds-form-page mx-auto w-full max-w-[min(96vw,1880px)] space-y-6 pb-12 font-sans motion-safe:animate-in fade-in slide-in-from-bottom-4 motion-safe:duration-500",
        isFieldMode && "pb-28",
      )}
    >
      {fetching ? (
        <div className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)] print:hidden">
          <InlineLoadingState
            label={id ? "Carregando APR..." : "Preparando APR..."}
          />
        </div>
      ) : null}

      <div className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-sm)]">
        <div className="flex flex-col gap-4 border-b border-[var(--ds-color-border-subtle)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ds-color-text-secondary)]">
              <Link
                href="/dashboard/aprs"
                className={cn(aprBackButtonClass, "-ml-2")}
                title="Voltar para APRs"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <span>SGS</span>
              <ChevronRight className="h-3.5 w-3.5" />
              <span>Segurança</span>
              <ChevronRight className="h-3.5 w-3.5" />
              <span>APR</span>
              <ChevronRight className="h-3.5 w-3.5" />
              <span className="font-bold text-[var(--ds-color-text-primary)]">
                {aprDocumentNumber}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex lg:items-center">
            <button
              type="button"
              onClick={handleHeaderPdfAction}
              disabled={loading || emittingGovernedPdf || isOffline}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-4 py-2.5 text-sm font-semibold text-[var(--ds-color-text-primary)] transition-none hover:bg-[var(--ds-color-surface-base)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {emittingGovernedPdf ? (
                <Loader2 className="h-4 w-4" />
              ) : (
                <FileDown className="h-4 w-4" />
              )}
              Exportar PDF
            </button>
            <button
              type="button"
              onClick={handleHeaderHistory}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-4 py-2.5 text-sm font-semibold text-[var(--ds-color-text-primary)] transition-none hover:bg-[var(--ds-color-surface-base)]"
            >
              <History className="h-4 w-4" />
              Histórico
            </button>
            <button
              type="button"
              onClick={handleHeaderSave}
              disabled={loading || isReadOnly}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--component-button-primary-bg)] px-4 py-2.5 text-sm font-bold text-[var(--color-text-inverse)] shadow-[var(--ds-shadow-sm)] transition-none hover:translate-y-0 hover:shadow-[var(--ds-shadow-sm)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <Loader2 className="h-4 w-4" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Salvar APR
            </button>
          </div>
        </div>
      </div>

      {isFieldMode ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-success)]">
                APR em campo
              </p>
              <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                Registre atividade, riscos e controles no local da operação. O
                rascunho continua salvo enquanto você avança no wizard.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center md:w-[260px]">
              <div className={aprFieldStatCardClass}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                  Rascunho
                </p>
                <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                  Automático
                </p>
              </div>
              <div className={aprFieldStatCardClass}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                  Uso
                </p>
                <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                  Obra / celular
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {id && currentApr && (
        <div className="sst-card p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-[var(--color-text)]">
                {currentApr.numero} | Versão {currentApr.versao || 1}
              </p>
              <p className="text-xs text-[var(--color-text-secondary)]">
                Status: {currentApr.status}
                {currentApr.aprovado_em
                  ? ` | Aprovada em ${safeToLocaleString(currentApr.aprovado_em, "pt-BR", undefined, "data indisponível")}`
                  : ""}
                {currentApr.status === "Pendente" && pendingApprovalStep
                  ? ` | Próxima etapa: ${pendingApprovalStep.title}`
                  : ""}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {canApproveCurrentApr && (
                <button
                  type="button"
                  onClick={handleApproveApr}
                  disabled={finalizing}
                  className={aprSuccessButtonCompactClass}
                >
                  {finalizing ? "Aprovando..." : "Aprovar APR"}
                </button>
              )}
              {isApproved && !hasFinalPdf && (
                <button
                  type="button"
                  onClick={handleEmitGovernedPdf}
                  disabled={emittingGovernedPdf || isOffline}
                  className={aprSuccessButtonCompactClass}
                >
                  {emittingGovernedPdf ? "Emitindo PDF..." : "Emitir PDF final"}
                </button>
              )}
              {isApproved && hasFinalPdf && (
                <button
                  type="button"
                  onClick={handleCloseApr}
                  disabled={closingApr}
                  className={aprSuccessButtonCompactClass}
                >
                  {closingApr ? "Encerrando..." : "Encerrar APR"}
                </button>
              )}
              {isApproved && (
                <button
                  type="button"
                  onClick={handleCreateVersion}
                  disabled={creatingVersion}
                  className={aprPrimaryCompactButtonClass}
                >
                  {creatingVersion ? "Criando..." : "Criar nova versão"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {id && (
        <div id="apr-history" className="sst-card scroll-mt-24 p-4">
          <h2 className={aprSectionTitleClass}>Timeline da APR</h2>
          <AprTimeline logs={aprLogs} loading={loadingTimeline} />
        </div>
      )}

      {id && approvalProgressStarted && (
        <AprApprovalPanel
          aprId={id}
          onStatusChange={() => reloadAprWorkflowContext(id)}
        />
      )}

      {id && !isReadOnly && (
        <div ref={compliancePanelRef}>
          <AprCompliancePanel
            aprId={id}
            formVersion={formVersion}
            onValidationChange={setComplianceResult}
          />
        </div>
      )}

      {id && versionHistory.length > 1 && (
        <div className="sst-card p-4">
          <h2 className={aprSectionTitleClass}>Comparação entre versões</h2>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className={aprLabelCompactClass}>Comparar com</label>
              <select
                value={compareTargetId}
                onChange={(e) => setCompareTargetId(e.target.value)}
                className={aprFieldClass}
              >
                <option value="">Selecione uma versão</option>
                {versionHistory
                  .filter((item) => item.id !== id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.numero} | v{item.versao} | {item.status}
                    </option>
                  ))}
              </select>
            </div>
            <button
              type="button"
              onClick={handleCompareVersions}
              disabled={!compareTargetId || comparing}
              className={aprNeutralButtonClass}
            >
              {comparing ? "Comparando..." : "Comparar"}
            </button>
          </div>

          {compareResult && (
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-5">
              <MiniStat label="Base" value={compareResult.summary.totalBase} />
              <MiniStat
                label="Alvo"
                value={compareResult.summary.totalTarget}
              />
              <MiniStat
                label="Adicionados"
                value={compareResult.summary.added}
              />
              <MiniStat
                label="Removidos"
                value={compareResult.summary.removed}
              />
              <MiniStat
                label="Alterados"
                value={compareResult.summary.changed}
              />
            </div>
          )}
        </div>
      )}

      {id && currentApr?.risk_items && currentApr.risk_items.length > 0 && (
        <div className="sst-card p-4">
          <h2 className={aprSectionTitleClass}>
            Evidência fotográfica da equipe
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className={aprLabelCompactClass}>Item de risco</label>
              <select
                value={selectedRiskItemEvidence}
                onChange={(e) => setSelectedRiskItemEvidence(e.target.value)}
                disabled={isReadOnly}
                className={aprFieldClass}
              >
                <option value="">Selecione</option>
                {currentApr.risk_items
                  .slice()
                  .sort((a, b) => a.ordem - b.ordem)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      #{item.ordem + 1}{" "}
                      {item.atividade || item.condicao_perigosa || "Risco"}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className={aprLabelCompactClass}>Foto da evidência</label>
              <input
                type="file"
                accept="image/*"
                aria-label="Selecionar foto da evidência da APR"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  if (file) {
                    if (!file.type.startsWith("image/")) {
                      toast.error("Apenas imagens são aceitas como evidência.");
                      e.target.value = "";
                      return;
                    }
                    const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;
                    if (file.size > MAX_EVIDENCE_BYTES) {
                      toast.error("A imagem não pode ultrapassar 15 MB.");
                      e.target.value = "";
                      return;
                    }
                  }
                  setEvidenceFile(file);
                }}
                disabled={isReadOnly}
                className={aprFileFieldClass}
              />
            </div>
            <div className="flex gap-2">
              <input
                type="number"
                step="any"
                min={-90}
                max={90}
                value={evidenceLatitude}
                onChange={(e) => setEvidenceLatitude(e.target.value)}
                placeholder="Latitude (-90 a 90)"
                aria-label="Latitude da evidência"
                disabled={isReadOnly}
                className={aprFieldClass}
              />
              <input
                type="number"
                step="any"
                min={-180}
                max={180}
                value={evidenceLongitude}
                onChange={(e) => setEvidenceLongitude(e.target.value)}
                placeholder="Longitude (-180 a 180)"
                aria-label="Longitude da evidência"
                disabled={isReadOnly}
                className={aprFieldClass}
              />
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={evidenceAccuracy}
                onChange={(e) => setEvidenceAccuracy(e.target.value)}
                placeholder="Precisão (m)"
                aria-label="Precisão do GPS da evidência"
                disabled={isReadOnly}
                className={aprFieldClass}
              />
              <button
                type="button"
                onClick={handleCaptureLocation}
                disabled={isReadOnly || capturingGps}
                className={aprSoftPrimaryButtonClass}
              >
                {capturingGps ? "Capturando..." : gpsReady ? "Atualizar GPS" : "Capturar GPS"}
              </button>
            </div>
          </div>

          <div className="mt-3">
            <button
              type="button"
              onClick={handleUploadEvidence}
              disabled={
                isReadOnly ||
                uploadingEvidence ||
                !selectedRiskItemEvidence ||
                !evidenceFile
              }
              className={aprSuccessButtonClass}
            >
              {uploadingEvidence ? "Enviando..." : "Enviar evidência"}
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {aprEvidences
              .filter((item) =>
                selectedRiskItemEvidence
                  ? item.apr_risk_item_id === selectedRiskItemEvidence
                  : true,
              )
              .slice(0, 6)
              .map((item) => (
                <div key={item.id} className={aprSubtleMetaCardClass}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-[var(--ds-color-text-primary)]">
                      {item.original_name || "Evidência"}
                    </span>
                    <span>
                      {safeToLocaleString(
                        item.uploaded_at,
                        "pt-BR",
                        undefined,
                        "data indisponível",
                      )}
                    </span>
                  </div>
                  <span>Hash SHA-256: {item.hash_sha256}</span>
                  {item.watermarked_hash_sha256 && (
                    <span>Hash watermark: {item.watermarked_hash_sha256}</span>
                  )}
                  {safeExternalArtifactUrl(item.url) && (
                    <div className="flex gap-3">
                      <a
                        href={safeExternalArtifactUrl(item.url) as string}
                        target="_blank"
                        rel="noreferrer"
                        className="font-semibold text-[var(--ds-color-text-primary)] hover:underline"
                      >
                        Abrir original
                      </a>
                      {safeExternalArtifactUrl(item.watermarked_url) && (
                        <a
                          href={
                            safeExternalArtifactUrl(item.watermarked_url) as string
                          }
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-[var(--color-success)] hover:underline"
                        >
                          Abrir com watermark
                        </a>
                      )}
                    </div>
                  )}
                </div>
              ))}
          </div>

        </div>
      )}

      {isReadOnly && readOnlyReason && (
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/22 p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-[var(--ds-radius-lg)] bg-[color:var(--color-card-muted)]/30 p-2 text-[var(--ds-color-text-secondary)]">
              <Lock className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-[var(--ds-color-text-primary)]">
                APR bloqueada para edição
              </p>
              <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                {readOnlyReason}
              </p>
            </div>
          </div>
        </div>
      )}

      <form
        onSubmit={handleSubmit((data) => {
          submitIntentRef.current = "save";
          return onSubmit(data);
        })}
        className="space-y-6"
      >
        <div className="overflow-hidden rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-sm)]">
          <div className="grid min-h-[320px] xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="px-5 py-5 lg:px-7 lg:py-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-2xl font-black tracking-[-0.01em] text-[var(--ds-color-text-primary)]">
                      {aprDocumentNumber}
                    </h1>
                    <StatusPill tone={aprDocumentStatusTone}>
                      {aprDocumentStatus}
                    </StatusPill>
                    {isFieldMode ? (
                      <StatusPill tone="success">Modo campo</StatusPill>
                    ) : null}
                    {draftRestored ? (
                      <StatusPill tone="warning">Rascunho ativo</StatusPill>
                    ) : null}
                    {id && currentApr?.versao ? (
                      <StatusPill tone="primary">
                        Versão {currentApr.versao}
                      </StatusPill>
                    ) : null}
                  </div>
                  <p className="mt-2 max-w-4xl text-base font-semibold text-[var(--ds-color-text-primary)]">
                    {aprDocumentTitle}
                  </p>
                  <p className="mt-2 max-w-5xl text-sm leading-6 text-[var(--ds-color-text-secondary)]">
                    {aprDocumentDescription}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 text-center sm:flex sm:min-w-[360px] sm:justify-end">
                  <WizardMetric
                    label="Riscos"
                    value={String(aprDocumentRiskSummary.total)}
                    tone="warning"
                  />
                  <WizardMetric
                    label="Assinaturas"
                    value={`${completedSignatures}/${selectedParticipantIds.length}`}
                    tone="success"
                  />
                  <WizardMetric
                    label="Evidências"
                    value={String(aprEvidences.length)}
                    tone="info"
                  />
                </div>
              </div>

              <div className="mt-6 overflow-hidden rounded-lg border border-[var(--ds-color-border-subtle)]">
                <div className="grid md:grid-cols-2 xl:grid-cols-3">
                  <DocumentInfoCell
                    icon={UserRound}
                    label="Responsável técnico"
                    value={
                      responsavelTecnicoApr ||
                      selectedElaborador?.nome ||
                      "Não definido"
                    }
                  />
                  <DocumentInfoCell
                    icon={Building2}
                    label="Empresa / unidade"
                    value={selectedCompany?.razao_social || "Não definida"}
                    helper={selectedSite?.nome || undefined}
                  />
                  <DocumentInfoCell
                    icon={MapPin}
                    label="Local de trabalho"
                    value={
                      localExecucaoApr ||
                      frenteTrabalhoApr ||
                      selectedSite?.nome ||
                      "Não definido"
                    }
                    helper={areaRiscoApr || undefined}
                  />
                  <DocumentInfoCell
                    icon={CalendarDays}
                    label="Data de emissão"
                    value={formatDocumentDate(currentApr?.created_at)}
                  />
                  <DocumentInfoCell
                    icon={CalendarDays}
                    label="Validade / execução"
                    value={aprDocumentValidity}
                  />
                  <DocumentInfoCell
                    icon={ClipboardList}
                    label="Turno"
                    value={turnoApr || currentApr?.turno || "Não definido"}
                    helper={selectedActivityTypeLabel}
                  />
                </div>
              </div>

              <div className="mt-6 border-t border-[var(--ds-color-border-subtle)] pt-5">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ds-color-text-secondary)]">
                      Matriz de riscos
                    </p>
                    <h2 className="mt-1 text-lg font-black text-[var(--ds-color-text-primary)]">
                      Análise operacional simples, auditável e direta
                    </h2>
                  </div>
                  {!isReadOnly ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (currentStep !== 2) {
                          setCurrentStep(2);
                        }
                        appendRisk(createEmptyRiskRow());
                      }}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[var(--ds-color-primary-border)] bg-[color:var(--ds-color-primary-subtle)] px-4 py-2 text-sm font-bold text-[var(--color-primary)] transition-none hover:bg-[color:var(--ds-color-primary-subtle)]"
                    >
                      <Plus className="h-4 w-4" />
                      Adicionar risco
                    </button>
                  ) : null}
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <DocumentSignatureCard
                    title="Elaborador"
                    name={selectedElaborador?.nome || "Não definido"}
                    detail={
                      completedSignatures > 0
                        ? "Assinatura capturada"
                        : "Aguardando assinatura"
                    }
                    state={completedSignatures > 0 ? "done" : "pending"}
                  />
                  <DocumentSignatureCard
                    title="Responsável SST"
                    name={pendingApprovalStep?.title || "Fluxo SST"}
                    detail={
                      isApproved
                        ? "APR aprovada"
                        : pendingApprovalStep
                          ? "Aguardando aprovação"
                          : "Sem etapa pendente"
                    }
                    state={isApproved ? "done" : "pending"}
                  />
                  <DocumentSignatureCard
                    title="Supervisor de campo"
                    name={`${selectedParticipantIds.length} participante(s)`}
                    detail={
                      selectedParticipantIds.length > 0
                        ? `${completedSignatures} assinatura(s) registradas`
                        : "Defina participantes"
                    }
                    state={
                      selectedParticipantIds.length > 0 &&
                      completedSignatures >= selectedParticipantIds.length
                        ? "done"
                        : "pending"
                    }
                  />
                </div>
              </div>

              <nav
                aria-label="Etapas da APR"
                className="mt-6 grid gap-2 lg:grid-cols-3"
              >
                {APR_STEPS.map((step) => {
                  const Icon = step.icon;
                  const isActive = currentStep === step.id;
                  const isCompleted = currentStep > step.id;

                  const canNavigate = visitedSteps.has(step.id);
                  return (
                    <button
                      key={step.id}
                      type="button"
                      aria-current={isActive ? "step" : undefined}
                      onClick={() => {
                        if (canNavigate) {
                          setCurrentStep(step.id);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }
                      }}
                      className={cn(
                        "min-h-[76px] rounded-lg border px-4 py-3 text-left motion-safe:transition-all",
                        isActive
                          ? "border-[var(--ds-color-action-primary)] bg-[color:var(--ds-color-info-subtle)] shadow-[var(--ds-shadow-xs)]"
                          : isCompleted
                            ? "border-[var(--ds-color-success-border)] bg-[color:var(--ds-color-success-subtle)]/55"
                            : visitedSteps.has(step.id)
                              ? "border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/18 hover:border-[var(--ds-color-action-primary)]/40"
                              : "border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/18 cursor-default",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={cn(
                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                            isActive
                              ? "bg-[var(--color-info)] text-[var(--color-text-inverse)]"
                              : isCompleted
                                ? "bg-[color:var(--ds-color-success-subtle)] text-[var(--color-success)]"
                                : "bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-secondary)]",
                          )}
                        >
                          {isCompleted ? (
                            <CheckCircle2 className="h-4 w-4" />
                          ) : (
                            <Icon className="h-4 w-4" />
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-black text-[var(--ds-color-text-primary)]">
                            {step.title}
                          </span>
                          <span className="mt-0.5 block text-xs leading-5 text-[var(--ds-color-text-secondary)]">
                            {step.description}
                          </span>
                        </span>
                      </div>
                    </button>
                  );
                })}
              </nav>
            </section>

            <aside className="border-t border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/16 px-5 py-5 xl:border-l xl:border-t-0">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ds-color-text-secondary)]">
                    Resumo de riscos
                  </p>
                  <p className="mt-1 text-sm font-black text-[var(--ds-color-text-primary)]">
                    {aprDocumentRiskSummary.highestLabel}
                  </p>
                </div>
                <span
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-bold",
                    aprDocumentRiskSummary.criticalCount > 0
                      ? "bg-ds-danger-subtle text-[var(--ds-color-danger-fg)]"
                      : "bg-ds-success-subtle text-[var(--ds-color-success-fg)]",
                  )}
                >
                  {aprDocumentRiskSummary.total} mapeado(s)
                </span>
              </div>

              <DocumentRiskSummaryList
                summary={aprDocumentRiskSummary}
                levels={APR_DOCUMENT_RISK_LEVELS}
              />

              <div className="mt-6 border-t border-[var(--ds-color-border-subtle)] pt-5">
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ds-color-text-secondary)]">
                  EPI requeridos
                </p>
                {requiredEpiLabels.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {requiredEpiLabels.map((epi) => (
                      <li
                        key={epi}
                        className="flex items-start gap-2 text-sm text-[var(--ds-color-text-primary)]"
                      >
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-info)]" />
                        <span>{epi}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm leading-6 text-[var(--ds-color-text-secondary)]">
                    Selecione EPIs ou preencha a coluna EPI na matriz para
                    alimentar este resumo.
                  </p>
                )}
              </div>

              <div className="mt-6 border-t border-[var(--ds-color-border-subtle)] pt-5">
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ds-color-text-secondary)]">
                  Informações
                </p>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-[var(--ds-color-text-secondary)]">
                      Versão
                    </dt>
                    <dd className="font-semibold text-[var(--ds-color-text-primary)]">
                      v{currentApr?.versao || 1}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-[var(--ds-color-text-secondary)]">
                      Validade
                    </dt>
                    <dd className="text-right font-semibold text-[var(--ds-color-text-primary)]">
                      {aprDocumentValidity}
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-[var(--ds-color-text-secondary)]">
                      Normas
                    </dt>
                    <dd className="text-right font-semibold text-[var(--ds-color-text-primary)]">
                      {relatedNormLabels.length > 0
                        ? relatedNormLabels.join(" · ")
                        : "Não informadas"}
                    </dd>
                  </div>
                </dl>

                <button
                  type="button"
                  onClick={handleAiAnalysis}
                  disabled={!aiEnabled || analyzing || isReadOnly}
                  className="mt-5 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-[var(--ds-color-primary-border)] bg-[color:var(--ds-color-primary-subtle)] px-4 py-2 text-sm font-bold text-[var(--color-primary)] transition-none hover:bg-[color:var(--ds-color-primary-subtle)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {analyzing ? (
                    <Loader2 className="h-4 w-4" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  Consultar Sophie IA
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </aside>
          </div>
        </div>

        {draftPendingOfflineSync && pendingOfflineSyncUi ? (
          <div
            role="alert"
            className="rounded-lg border border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)] px-4 py-4 text-sm text-[var(--color-warning)]"
          >
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-2">
                <span className="inline-flex rounded-full border border-[var(--ds-color-warning-border)] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em]">
                  {pendingOfflineSyncUi.badge}
                </span>
                <p className="font-semibold">{pendingOfflineSyncUi.summary}</p>
                <p className="text-[var(--color-warning)]/90">
                  {pendingOfflineSyncUi.nextStep}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {canRetryPendingOfflineState ? (
                  <button
                    type="button"
                    onClick={() => void handleRetryPendingOfflineSync()}
                    className="rounded-lg border border-[var(--ds-color-warning-border)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] transition-none hover:bg-transparent"
                  >
                    Tentar sincronizar
                  </button>
                ) : null}
                {canReleasePendingOfflineState ? (
                  <button
                    type="button"
                    onClick={handleReleasePendingOfflineState}
                    className="rounded-lg border border-[var(--ds-color-warning-border)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] transition-none hover:bg-transparent"
                  >
                    Liberar rascunho
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleDiscardPendingOfflineSync()}
                  className="rounded-lg border border-[var(--ds-color-danger-border)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-danger)] transition-none hover:bg-transparent"
                >
                  Descartar envio local
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {signatureChanges.hasPendingChanges ? (
          <div
            role="alert"
            className="rounded-lg border border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] px-4 py-3 text-sm text-[var(--color-danger)]"
          >
            <p className="font-semibold">
              Assinaturas capturadas ficam somente na memória desta sessão.
            </p>
            <p className="mt-1 text-[var(--color-danger)]/90">
              Reconecte-se para concluir o envio das assinaturas antes de sair
              da tela.
            </p>
          </div>
        ) : null}

        {materiallyCompleteRiskCount === 0 && (
          <div className={aprDangerInlineClass}>
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-semibold">Revisão final obrigatória</p>
                <p className="mt-1 text-[var(--color-danger)]/90">
                  Não finalize a APR sem revisar a matriz de risco, controles
                  sugeridos e evidências associadas ao trabalho.
                </p>
              </div>
            </div>
          </div>
        )}

        {renderLegacyAprContext ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.22fr)_minmax(320px,0.78fr)]">
            <div className="ds-dashboard-panel overflow-hidden">
              <div className="flex flex-col gap-3 border-b border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/12 px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ds-color-text-secondary)]">
                    Fluxo operacional
                  </p>
                  <h2 className="mt-1 text-base font-bold text-[var(--ds-color-text-primary)]">
                    Emissão da APR por etapas
                  </h2>
                </div>
                <div className="inline-flex items-center gap-2 rounded-full border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-1.5 text-xs font-semibold text-[var(--ds-color-text-secondary)]">
                  <span className="rounded-full bg-[color:var(--ds-color-info-subtle)] px-2 py-0.5 text-[var(--color-info)]">
                    Etapa {currentStep}/3
                  </span>
                  <span>{APR_STEPS[currentStep - 1]?.title}</span>
                </div>
              </div>
              <nav aria-label="Etapas da APR">
                <div
                  className="grid gap-3 px-5 py-4 lg:grid-cols-3"
                  role="list"
                >
                  {APR_STEPS.map((step) => {
                    const Icon = step.icon;
                    const isActive = currentStep === step.id;
                    const isCompleted = currentStep > step.id;

                    const canNavigateMobile = visitedSteps.has(step.id);
                    return (
                      <button
                        key={step.id}
                        type="button"
                        role="listitem"
                        aria-current={isActive ? "step" : undefined}
                        aria-label={`Etapa ${step.id}: ${step.title}${isCompleted ? " (concluída)" : isActive ? " (em edição)" : canNavigateMobile ? " (visitada)" : ""}`}
                        onClick={() => {
                          if (canNavigateMobile) {
                            setCurrentStep(step.id);
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          }
                        }}
                        className={`w-full rounded-[var(--ds-radius-lg)] border px-3.5 py-3 text-left motion-safe:transition-all ${
                          isActive
                            ? "border-[var(--ds-color-action-primary)] bg-[color:var(--ds-color-info-subtle)] shadow-[var(--ds-shadow-xs)]"
                            : isCompleted
                              ? "border-[var(--ds-color-success-border)] bg-[color:var(--ds-color-success-subtle)]/55 hover:border-[var(--ds-color-success)]/50"
                              : "border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ds-radius-md)] ${
                              isActive
                                ? "bg-[var(--color-info)] text-[var(--color-text-inverse)]"
                                : isCompleted
                                  ? "bg-[color:var(--ds-color-success-subtle)] text-[var(--color-success)]"
                                  : "bg-[var(--ds-color-surface-muted)]/22 text-[var(--ds-color-text-secondary)]"
                            }`}
                          >
                            {isCompleted ? (
                              <CheckCircle2 className="h-4 w-4" />
                            ) : (
                              <Icon className="h-4 w-4" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                                {step.title}
                              </p>
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                                {isCompleted
                                  ? "Concluída"
                                  : isActive
                                    ? "Em edição"
                                    : `Etapa ${step.id}`}
                              </span>
                            </div>
                            <p className="mt-0.5 text-xs leading-5 text-[var(--ds-color-text-secondary)]">
                              {step.description}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </nav>
              <div className="border-t border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-5 py-2.5">
                <p className="text-xs text-[var(--ds-color-text-secondary)]">
                  <span className="font-semibold text-[var(--ds-color-text-primary)]">
                    Etapa atual:
                  </span>{" "}
                  {APR_STEPS[currentStep - 1]?.description}
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="ds-dashboard-panel px-4 py-3.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
                      Contexto da APR
                    </p>
                    <p className="mt-1 truncate text-sm font-semibold text-[var(--ds-color-text-primary)]">
                      {tituloApr || "Título ainda não definido"}
                    </p>
                  </div>
                  {draftStorageKey && draftRestored ? (
                    <span className="shrink-0 rounded-full border border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-warning)]">
                      Rascunho
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <SummaryMetaCard
                    label="Empresa"
                    value={selectedCompany?.razao_social || "Não definida"}
                  />
                  <SummaryMetaCard
                    label="Obra"
                    value={selectedSite?.nome || "Não definida"}
                  />
                  <SummaryMetaCard
                    label="Elaborador"
                    value={selectedElaborador?.nome || "Não definido"}
                  />
                  <SummaryMetaCard
                    label="Tipo de atividade"
                    value={selectedActivityTypeLabel}
                  />
                  <SummaryMetaCard
                    label="Turno"
                    value={watch("turno") || "Não definido"}
                  />
                  <SummaryMetaCard
                    label="Status"
                    value={watch("status") || "Pendente"}
                  />
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
                  <WizardMetric
                    label="Linhas"
                    value={String(totalRiskLines)}
                    tone="default"
                  />
                  <WizardMetric
                    label="Participantes"
                    value={String(selectedParticipantIds.length)}
                    tone="info"
                  />
                  <WizardMetric
                    label="Assinaturas"
                    value={String(completedSignatures)}
                    tone="success"
                  />
                  <WizardMetric
                    label="Evidências"
                    value={String(aprEvidences.length)}
                    tone="warning"
                  />
                </div>

                <AprExecutiveSummary control={control} variant="badges" />

                {selectedParticipantIds.length > 0 ? (
                  <div className="mt-3 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/18 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                        Participantes no fluxo
                      </p>
                      <span className="text-[11px] font-semibold text-[var(--ds-color-text-secondary)]">
                        {selectedParticipantIds.length} selecionado(s)
                      </span>
                    </div>
                    <div className="mt-2 space-y-1.5">
                      {selectedParticipantIds
                        .slice(0, 4)
                        .map((participantId) => {
                          const hasSignature = Boolean(
                            signatures[participantId],
                          );
                          const participant = filteredUsers.find(
                            (item) => item.id === participantId,
                          );
                          return (
                            <div
                              key={participantId}
                              className="flex items-center justify-between gap-3 text-xs"
                            >
                              <span className="truncate font-medium text-[var(--ds-color-text-primary)]">
                                {participant?.nome || "Participante"}
                              </span>
                              <span
                                className={cn(
                                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]",
                                  hasSignature
                                    ? "border border-[var(--ds-color-success-border)] bg-[color:var(--ds-color-success-subtle)] text-[var(--color-success)]"
                                    : "border border-[var(--ds-color-info-border)] bg-[color:var(--ds-color-info-subtle)] text-[var(--color-info)]",
                                )}
                              >
                                {hasSignature ? "Assinado" : "Pendente"}
                              </span>
                            </div>
                          );
                        })}
                      {selectedParticipantIds.length > 4 ? (
                        <p className="pt-1 text-[11px] font-medium text-[var(--ds-color-text-secondary)]">
                          +{selectedParticipantIds.length - 4} participante(s)
                          no fluxo.
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div role="alert" className={`mt-3 ${aprWarningInlineClass}`}>
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <p className="font-semibold">
                          Fluxo de assinatura ainda incompleto.
                        </p>
                        <p className="mt-1 text-[11px] leading-5 text-[var(--color-warning)]/90">
                          Defina participantes e assinaturas antes de concluir a
                          APR.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {draftPendingOfflineSync && pendingOfflineSyncUi ? (
                <div
                  role="alert"
                  className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)] px-4 py-4 text-sm text-[var(--color-warning)]"
                >
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-[var(--ds-color-warning-border)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]">
                            {pendingOfflineSyncUi.badge}
                          </span>
                          <span className="text-xs uppercase tracking-[0.1em] text-[var(--color-warning)]/80">
                            Draft {draftPendingOfflineSync.draftId.slice(0, 8)}
                          </span>
                        </div>
                        <p className="font-semibold">
                          {pendingOfflineSyncUi.summary}
                        </p>
                        <p className="text-[var(--color-warning)]/90">
                          {pendingOfflineSyncUi.nextStep}
                        </p>
                      </div>
                    </div>

                    <div className="grid gap-2 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-warning-border)]/60 bg-[color:var(--ds-color-surface-overlay)]/50 p-3 text-xs text-[var(--color-warning)]/90 md:grid-cols-2">
                      <p>
                        Base da APR:{" "}
                        {draftPendingOfflineSync.status === "synced_base"
                          ? "sincronizada no servidor"
                          : "salva localmente neste navegador"}
                      </p>
                      <p>
                        Assinaturas finais: pendentes e obrigatoriamente online
                      </p>
                      <p>PDF final: bloqueado até a conclusão online</p>
                      <p>Emissão governada: bloqueada até a conclusão online</p>
                    </div>

                    {draftPendingOfflineSync.lastError ? (
                      <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] px-3 py-2 text-xs text-[var(--color-danger)]">
                        Última ocorrência: {draftPendingOfflineSync.lastError}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      {canRetryPendingOfflineState ? (
                        <button
                          type="button"
                          onClick={() => void handleRetryPendingOfflineSync()}
                          className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-warning-border)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] transition-none hover:bg-transparent"
                        >
                          Tentar sincronizar agora
                        </button>
                      ) : null}
                      {canReleasePendingOfflineState ? (
                        <button
                          type="button"
                          onClick={handleReleasePendingOfflineState}
                          className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-warning-border)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] transition-none hover:bg-transparent"
                        >
                          Liberar rascunho
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void handleDiscardPendingOfflineSync()}
                        className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-danger-border)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-danger)] transition-none hover:bg-transparent"
                      >
                        Descartar envio local
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {signatureChanges.hasPendingChanges ? (
                <div
                  role="alert"
                  className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] px-4 py-3 text-sm text-[var(--color-danger)]"
                >
                  <p className="font-semibold">
                    Assinaturas capturadas ficam somente na memória desta
                    sessão.
                  </p>
                  <p className="mt-1 text-[var(--color-danger)]/90">
                    Elas não são gravadas localmente nem entram na fila offline.
                    Reconecte-se para concluir o envio das assinaturas antes de
                    sair da tela.
                  </p>
                </div>
              ) : null}

              {materiallyCompleteRiskCount === 0 && (
                <div className={aprDangerInlineClass}>
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="font-semibold">Revisão final obrigatória</p>
                      <p className="mt-1 text-[var(--color-danger)]/90">
                        Não finalize a APR sem revisar a matriz de risco,
                        controles sugeridos e evidências associadas ao trabalho.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}

        <div className="space-y-8">
          {currentStep === 2 && isReadOnly && (
            <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 shadow-[var(--ds-shadow-sm)]">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
                    Ações seguras em somente leitura
                  </p>
                  <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                    Exportação e navegação visual continuam disponíveis sem
                    reabrir edição da APR.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      downloadExcel(
                        "/aprs/export/excel/template",
                        "apr-template-importacao.xlsx",
                      )
                    }
                    className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm font-semibold text-[var(--ds-color-text-secondary)] transition-none hover:bg-[var(--ds-color-surface-base)]"
                  >
                    <Download className="h-4 w-4" />
                    Template
                  </button>
                  {id ? (
                    <button
                      type="button"
                      onClick={() =>
                        downloadExcel(
                          `/aprs/${id}/export/excel`,
                          `apr-${id}.xlsx`,
                        )
                      }
                      className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm font-semibold text-[var(--ds-color-text-secondary)] transition-none hover:bg-[var(--ds-color-surface-base)]"
                    >
                      <Download className="h-4 w-4" />
                      Exportar Excel
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setCompactMode((v) => !v);
                      setExpandedRows(new Set());
                    }}
                    className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm font-semibold text-[var(--ds-color-text-secondary)] transition-none hover:bg-[var(--ds-color-surface-base)]"
                  >
                    {compactMode ? (
                      <Maximize2 className="h-4 w-4" />
                    ) : (
                      <Minimize2 className="h-4 w-4" />
                    )}
                    {compactMode ? "Expandir linhas" : "Modo compacto"}
                  </button>
                </div>
              </div>
            </div>
          )}

          <fieldset
            disabled={isReadOnly}
            className="border-none p-0 m-0 min-w-0"
          >
            {currentStep === 1 && (
              <div className={aprInteractivePanelClass}>
                <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--color-text)]">
                    Informações Básicas
                    <span className="h-2 w-2 rounded-full bg-[var(--ds-color-action-primary)]"></span>
                  </h2>
                  {aiEnabled && (
                    <button
                      type="button"
                      onClick={handleAiAnalysis}
                      disabled={analyzing}
                      className="group flex items-center justify-center space-x-2 rounded-[var(--ds-radius-md)] bg-[var(--component-button-primary-bg)] px-4 py-2.5 text-sm font-bold text-[var(--color-text-inverse)] shadow-[var(--ds-shadow-md)] transition-none hover:translate-y-0 hover:shadow-[var(--ds-shadow-md)] disabled:opacity-50"
                    >
                      {analyzing ? (
                        <Loader2 className="h-4 w-4" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                      <span>Analisar com SGS</span>
                    </button>
                  )}
                </div>
                <p className="text-xs text-[var(--ds-color-text-secondary)]">
                  Campos marcados com{" "}
                  <span className="text-[var(--color-danger)]">*</span> são obrigatórios
                </p>
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div>
                    <label htmlFor="apr-numero" className={aprLabelClass}>
                      Número da APR<AprRequiredMark />
                    </label>
                    <input
                      id="apr-numero"
                      type="text"
                      {...register("numero")}
                      className={cn(
                        aprFieldClass,
                        errors.numero && aprFieldErrorClass,
                      )}
                      placeholder="Ex: 2024/001"
                    />
                    {errors.numero && (
                      <p className={aprErrorTextClass}>
                        {errors.numero.message}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="apr-titulo" className={aprLabelClass}>
                      Título da APR<AprRequiredMark />
                    </label>
                    <input
                      id="apr-titulo"
                      type="text"
                      {...register("titulo")}
                      className={cn(
                        aprFieldClass,
                        errors.titulo && aprFieldErrorClass,
                      )}
                      placeholder="Ex: Instalação de Painéis Solares"
                    />
                    {errors.titulo && (
                      <p className={aprErrorTextClass}>
                        {errors.titulo.message}
                      </p>
                    )}
                  </div>

                  <div className="md:col-span-2">
                    <label htmlFor="apr-descricao" className={aprLabelClass}>
                      Descrição/Escopo
                    </label>
                    <textarea
                      id="apr-descricao"
                      {...register("descricao")}
                      rows={3}
                      maxLength={2000}
                      className={aprFieldClass}
                      placeholder="Descreva o escopo do trabalho..."
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="apr-tipo-atividade"
                      className={aprLabelClass}
                    >
                      Tipo de atividade<AprRequiredMark />
                    </label>
                    <select
                      id="apr-tipo-atividade"
                      {...register("tipo_atividade")}
                      className={cn(
                        aprFieldClass,
                        errors.tipo_atividade && aprFieldErrorClass,
                      )}
                    >
                      <option value="">Selecione um tipo de atividade</option>
                      {activityTemplates.map((template) => (
                        <option
                          key={template.tipo_atividade}
                          value={template.tipo_atividade}
                        >
                          {template.label}
                        </option>
                      ))}
                    </select>
                    {errors.tipo_atividade && (
                      <p className={aprErrorTextClass}>
                        {errors.tipo_atividade.message}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="apr-turno" className={aprLabelClass}>
                      Turno<AprRequiredMark />
                    </label>
                    <select
                      id="apr-turno"
                      {...register("turno")}
                      className={cn(
                        aprFieldClass,
                        errors.turno && aprFieldErrorClass,
                      )}
                    >
                      <option value="">Selecione o turno</option>
                      <option value="Diurno">Diurno</option>
                      <option value="Noturno">Noturno</option>
                      <option value="Integral">Integral</option>
                      <option value="Revezamento">Revezamento</option>
                    </select>
                    {errors.turno && (
                      <p className={aprErrorTextClass}>
                        {errors.turno.message}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="apr-frente-trabalho"
                      className={aprLabelClass}
                    >
                      Frente de trabalho
                    </label>
                    <input
                      id="apr-frente-trabalho"
                      {...register("frente_trabalho")}
                      className={cn(
                        aprFieldClass,
                        errors.frente_trabalho && aprFieldErrorClass,
                      )}
                      placeholder="Ex: Linha 02, setor de manutenção, área quente"
                    />
                    {errors.frente_trabalho && (
                      <p className={aprErrorTextClass}>
                        {errors.frente_trabalho.message}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="apr-area-risco" className={aprLabelClass}>
                      Área / setor de risco
                    </label>
                    <input
                      id="apr-area-risco"
                      {...register("area_risco")}
                      className={aprFieldClass}
                      placeholder="Ex: Subestação, cobertura, galpão A"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-primary-border)] bg-[color:var(--ds-color-primary-subtle)]/45 px-4 py-3">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-primary)]">
                            Template técnico
                          </p>
                          <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                            {selectedActivityTemplate?.label ||
                              selectedActivityTemplateSummary?.label ||
                              "Selecione um tipo de atividade para carregar riscos base"}
                          </p>
                          <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                            {loadingActivityTemplate
                              ? "Carregando referência técnica do tipo de atividade..."
                              : selectedActivityTemplate?.descricao ||
                                "Use templates reutilizáveis para pré-carregar riscos, etapas e controles recorrentes da operação."}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setConfirmTemplateOpen(true)}
                          disabled={
                            loadingActivityTemplate || !selectedActivityTemplate
                          }
                          className={aprSoftPrimaryButtonClass}
                        >
                          {loadingActivityTemplate
                            ? "Carregando..."
                            : "Aplicar template à grade"}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="md:col-span-2">
                    <label
                      htmlFor="apr-local-detalhado"
                      className={aprLabelClass}
                    >
                      Local detalhado de execução<AprRequiredMark />
                    </label>
                    <textarea
                      id="apr-local-detalhado"
                      {...register("local_execucao_detalhado")}
                      rows={2}
                      className={cn(
                        aprFieldClass,
                        errors.local_execucao_detalhado && aprFieldErrorClass,
                      )}
                      placeholder="Ex: Cobertura do bloco administrativo, face leste, acesso por plataforma elevatória"
                    />
                    {errors.local_execucao_detalhado && (
                      <p className={aprErrorTextClass}>
                        {errors.local_execucao_detalhado.message}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="apr-responsavel-tecnico"
                      className={aprLabelClass}
                    >
                      Responsável técnico<AprRequiredMark />
                    </label>
                    <input
                      id="apr-responsavel-tecnico"
                      {...register("responsavel_tecnico_nome")}
                      className={cn(
                        aprFieldClass,
                        errors.responsavel_tecnico_nome && aprFieldErrorClass,
                      )}
                      placeholder="Nome do responsável técnico"
                    />
                    {errors.responsavel_tecnico_nome && (
                      <p className={aprErrorTextClass}>
                        {errors.responsavel_tecnico_nome.message}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="apr-responsavel-registro"
                      className={aprLabelClass}
                    >
                      Registro profissional
                    </label>
                    <input
                      id="apr-responsavel-registro"
                      {...register("responsavel_tecnico_registro")}
                      className={cn(
                        aprFieldClass,
                        errors.responsavel_tecnico_registro &&
                          aprFieldErrorClass,
                      )}
                      placeholder="Ex: CREA 000000 / TST 00000"
                    />
                    {errors.responsavel_tecnico_registro && (
                      <p className={aprErrorTextClass}>
                        {errors.responsavel_tecnico_registro.message}
                      </p>
                    )}
                  </div>

                  <div className="md:col-span-2">
                    <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-primary-border)] bg-[color:var(--ds-color-primary-subtle)]/45 px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-primary)]">
                        Governança documental
                      </p>
                      <p className="mt-2 text-sm text-[var(--ds-color-text-secondary)]">
                        O PDF final não faz parte do preenchimento básico desta
                        etapa. Depois da aprovação, use o fluxo oficial da APR
                        para emitir, abrir ou compartilhar o documento
                        governado.
                      </p>
                      {hasFinalPdf ? (
                        <p className="mt-2 text-sm font-semibold text-[var(--color-success)]">
                          Esta APR já possui PDF final emitido e está bloqueada
                          para edição.
                        </p>
                      ) : isApproved ? (
                        <p className="mt-2 text-sm font-semibold text-[var(--color-warning)]">
                          APR aprovada. O próximo passo é emitir o PDF final
                          governado antes do encerramento.
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {isApproved && !hasFinalPdf ? (
                          <button
                            type="button"
                            onClick={handleEmitGovernedPdf}
                            disabled={emittingGovernedPdf || isOffline}
                            className={aprPrimaryCompactButtonClass}
                          >
                            {emittingGovernedPdf
                              ? "Emitindo PDF..."
                              : "Emitir PDF final"}
                          </button>
                        ) : null}
                        {hasFinalPdf ? (
                          <button
                            type="button"
                            onClick={handleOpenGovernedPdf}
                            disabled={isOffline}
                            className={aprGhostActionClass}
                          >
                            Abrir PDF governado
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="apr-company" className={aprLabelClass}>
                      Empresa<AprRequiredMark />
                    </label>
                    <select
                      id="apr-company"
                      {...register("company_id")}
                      className={cn(
                        aprFieldClass,
                        errors.company_id && aprFieldErrorClass,
                      )}
                      onChange={(e) => {
                        const companyId = e.target.value;
                        const hasFilledData =
                          riskFields.length > 0 ||
                          selectedParticipantIds.length > 0;
                        if (hasFilledData) {
                          setPendingCompanyId(companyId);
                          setConfirmCompanyChangeOpen(true);
                          return;
                        }
                        setValue("company_id", companyId);
                        setValue("site_id", "");
                        setValue("elaborador_id", "");
                        setValue("activities", []);
                        setValue("risks", []);
                        setValue("epis", []);
                        setValue("tools", []);
                        setValue("machines", []);
                        setValue("participants", []);
                      }}
                    >
                      <option value="">Selecione uma empresa</option>
                      {companies.map((company) => (
                        <option key={company.id} value={company.id}>
                          {company.razao_social}
                        </option>
                      ))}
                    </select>
                    {errors.company_id && (
                      <p className={aprErrorTextClass}>
                        {errors.company_id.message}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="apr-site" className={aprLabelClass}>
                      Site/Obra<AprRequiredMark />
                    </label>
                    <select
                      id="apr-site"
                      {...register("site_id")}
                      disabled={!selectedCompanyId}
                      className={cn(
                        aprFieldClass,
                        errors.site_id && aprFieldErrorClass,
                        !selectedCompanyId && aprFieldDisabledClass,
                      )}
                    >
                      <option value="">
                        {selectedCompanyId
                          ? "Selecione um site"
                          : "Selecione uma empresa primeiro"}
                      </option>
                      {filteredSites.map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.nome}
                        </option>
                      ))}
                    </select>
                    {errors.site_id && (
                      <p className={aprErrorTextClass}>
                        {errors.site_id.message}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="apr-elaborador" className={aprLabelClass}>
                      Elaborador<AprRequiredMark />
                    </label>
                    <select
                      id="apr-elaborador"
                      {...register("elaborador_id")}
                      disabled={!selectedCompanyId}
                      className={cn(
                        aprFieldClass,
                        errors.elaborador_id && aprFieldErrorClass,
                        !selectedCompanyId && aprFieldDisabledClass,
                      )}
                    >
                      <option value="">
                        {selectedCompanyId
                          ? "Selecione um elaborador"
                          : "Selecione uma empresa primeiro"}
                      </option>
                      {filteredUsers.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.nome}
                        </option>
                      ))}
                    </select>
                    {errors.elaborador_id && (
                      <p className={aprErrorTextClass}>
                        {errors.elaborador_id.message}
                      </p>
                    )}
                  </div>

                  <div>
                    <p className={aprLabelClass}>Status</p>
                    <div className="flex min-h-[2.875rem] items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)] px-4 py-2.5">
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-0.5 text-xs font-semibold",
                          watch("status") === "Aprovada" &&
                            "bg-[color:var(--ds-color-success-subtle)] text-[var(--ds-color-success-fg)] border border-[var(--ds-color-success-border)]",
                          watch("status") === "Pendente" &&
                            "bg-[color:var(--ds-color-warning-subtle)] text-[var(--ds-color-warning-fg)] border border-[var(--ds-color-warning-border)]",
                          watch("status") === "Cancelada" &&
                            "bg-[color:var(--ds-color-danger-subtle)] text-[var(--ds-color-danger-fg)] border border-[var(--ds-color-danger-border)]",
                          watch("status") === "Encerrada" &&
                            "bg-[color:var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)] border border-[var(--ds-color-border-subtle)]",
                        )}
                      >
                        {watch("status") || "Pendente"}
                      </span>
                      <span className="text-xs text-[var(--ds-color-text-muted)]">
                        Controlado pelo fluxo formal
                      </span>
                    </div>
                    <input type="hidden" {...register("status")} />
                  </div>

                  <div>
                    <label htmlFor="apr-data-inicio" className={aprLabelClass}>
                      Data Início<AprRequiredMark />
                    </label>
                    <input
                      id="apr-data-inicio"
                      type="date"
                      {...register("data_inicio")}
                      className={cn(
                        aprFieldClass,
                        errors.data_inicio && aprFieldErrorClass,
                      )}
                    />
                    {errors.data_inicio && (
                      <p className={aprErrorTextClass}>
                        {errors.data_inicio.message}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="apr-data-fim" className={aprLabelClass}>
                      Data Fim<AprRequiredMark />
                    </label>
                    <input
                      id="apr-data-fim"
                      type="date"
                      {...register("data_fim")}
                      min={dataInicioApr || undefined}
                      className={cn(
                        aprFieldClass,
                        errors.data_fim && aprFieldErrorClass,
                      )}
                    />
                    {errors.data_fim && (
                      <p className={aprErrorTextClass}>
                        {errors.data_fim.message}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col space-y-3 md:flex-row md:space-x-6 md:space-y-0 md:col-span-2 pt-2">
                    <label
                      htmlFor="apr-is-modelo"
                      className="flex items-center space-x-3 cursor-pointer group"
                    >
                      <input
                        id="apr-is-modelo"
                        type="checkbox"
                        {...register("is_modelo")}
                        className={aprCheckboxClass}
                      />
                      <span className="text-sm font-semibold text-[var(--color-text-secondary)] motion-safe:transition-colors group-hover:text-[var(--color-text)]">
                        Salvar como Modelo
                      </span>
                    </label>

                    {isModelo && (
                      <label
                        htmlFor="apr-is-modelo-padrao"
                        className="flex items-center space-x-3 cursor-pointer group motion-safe:animate-in slide-in-from-left-2 motion-safe:duration-300"
                      >
                        <input
                          id="apr-is-modelo-padrao"
                          type="checkbox"
                          {...register("is_modelo_padrao")}
                          className={aprCheckboxClass}
                        />
                        <span className="text-sm font-semibold text-[var(--color-text-secondary)] motion-safe:transition-colors group-hover:text-[var(--color-text)]">
                          Definir como Modelo Padrão
                        </span>
                      </label>
                    )}
                  </div>
                </div>
              </div>
            )}

            {currentStep === 2 && (
              <>
                <div className="space-y-6">
                  {(sophieSuggestedRisks.length > 0 ||
                    sophieMandatoryChecklists.length > 0) && (
                    <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-primary-border)] bg-[color:var(--ds-color-primary-subtle)]/45 p-5">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-primary)]">
                            Sugestões da SOPHIE
                          </p>
                          <h3 className="mt-2 text-lg font-bold text-[var(--color-text)]">
                            Aplicações rápidas para esta APR
                          </h3>
                          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                            Use um clique para refletir os riscos sugeridos na
                            seleção e na planilha, ou abrir os checklists
                            operacionais recomendados.
                          </p>
                        </div>
                        {sophieSuggestedRisks.length > 0 ? (
                          <button
                            type="button"
                            onClick={applyAllSuggestedAprRisks}
                            className={aprSoftPrimaryButtonClass}
                          >
                            Aplicar todos os riscos
                          </button>
                        ) : null}
                      </div>

                      {sophieSuggestedRisks.length > 0 ? (
                        <div className="mt-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
                            Riscos sugeridos
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {sophieSuggestedRisks.map((suggestion, index) => {
                              const alreadySelected =
                                (suggestion.id &&
                                  selectedRiskIds.includes(suggestion.id)) ||
                                hasSuggestedRiskInMatrix(suggestion);
                              return (
                                <button
                                  key={`${suggestion.label}-${index}`}
                                  type="button"
                                  onClick={() =>
                                    applySuggestedAprRisk(suggestion)
                                  }
                                  className={cn(
                                    "rounded-full border px-3 py-1.5 text-xs font-semibold motion-safe:transition-colors",
                                    alreadySelected
                                      ? "border-[var(--ds-color-success-border)] bg-[color:var(--ds-color-success-subtle)] text-[var(--color-success)]"
                                      : "border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] text-[var(--color-danger)] hover:bg-[color:var(--ds-color-danger-subtle)]/70",
                                  )}
                                >
                                  {suggestion.label}
                                  {suggestion.category
                                    ? ` • ${suggestion.category}`
                                    : ""}
                                  {alreadySelected
                                    ? " • Aplicado"
                                    : " • Aplicar"}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}

                      {sophieMandatoryChecklists.length > 0 ? (
                        <div className="mt-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
                            Checklists de apoio recomendados
                          </p>
                          <div className="mt-3 grid gap-3 md:grid-cols-2">
                            {sophieMandatoryChecklists.map((suggestion) => (
                              <div
                                key={suggestion.id}
                                className="rounded-[var(--ds-radius-lg)] border border-[var(--color-border-subtle)] bg-[color:var(--color-card)] p-3"
                              >
                                <p className="text-sm font-semibold text-[var(--color-text)]">
                                  {suggestion.label}
                                </p>
                                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                                  {suggestion.reason}
                                </p>
                                <Link
                                  href={buildChecklistSuggestionHref(
                                    suggestion,
                                  )}
                                  className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-[var(--color-primary)] hover:underline"
                                >
                                  Abrir checklist recomendado
                                  <ArrowRight className="h-3.5 w-3.5" />
                                </Link>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                  {isOffline ? (
                    <div
                      role="alert"
                      className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)] px-4 py-3 text-sm text-[var(--color-warning)]"
                    >
                      As assinaturas da APR ficam bloqueadas offline. Continue a
                      APR base e volte online para capturar ou reenviar as
                      assinaturas.
                    </div>
                  ) : null}
                  <SectionGrid
                    title="Participantes e Assinaturas"
                    items={filteredUsers}
                    selectedIds={selectedParticipantIds}
                    onToggle={(id) => toggleSelection("participants", id)}
                    signatures={signatures}
                    helperText="Selecione os participantes da APR e acompanhe quem ainda precisa concluir a assinatura obrigatória."
                  />
                  {errors.participants && (
                    <div className={aprDangerInlineClass}>
                      {errors.participants.message}
                    </div>
                  )}
                </div>

                <div className="space-y-6">
                  <div className="overflow-hidden rounded-[calc(var(--ds-radius-xl)+4px)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-sm)]">
                    <input
                      ref={excelInputRef}
                      type="file"
                      accept=".xlsx,.xls"
                      className="hidden"
                      onChange={handleExcelFileSelection}
                    />
                    <div className="sticky top-24 z-20 border-b border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/96 px-4 py-3 backdrop-blur">
                      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                        <div className="max-w-3xl">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ds-color-text-secondary)]">
                            Grade operacional da APR
                          </p>
                          <h2 className="mt-1 text-xl font-black leading-tight text-[var(--ds-color-text-primary)]">
                            Matriz operacional de riscos e governança
                          </h2>
                          <p className="mt-1 text-xs leading-5 text-[var(--ds-color-text-secondary)]">
                            Lance riscos, revise pendências e mantenha a
                            rastreabilidade sem sair da grade principal.
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                          <button
                            type="button"
                            onClick={() => excelInputRef.current?.click()}
                            disabled={importingExcel || isReadOnly}
                            className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-xs font-semibold text-[var(--ds-color-text-secondary)] transition-none hover:bg-[var(--ds-color-surface-base)] disabled:opacity-60"
                          >
                            {importingExcel ? (
                              <Loader2 className="h-4 w-4" />
                            ) : (
                              <Upload className="h-4 w-4" />
                            )}
                            Importar Excel
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              downloadExcel(
                                "/aprs/export/excel/template",
                                "apr-template-importacao.xlsx",
                              )
                            }
                            className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-xs font-semibold text-[var(--ds-color-text-secondary)] transition-none hover:bg-[var(--ds-color-surface-base)]"
                          >
                            <Download className="h-4 w-4" />
                            Template
                          </button>
                          {id ? (
                            <button
                              type="button"
                              onClick={() =>
                                downloadExcel(
                                  `/aprs/${id}/export/excel`,
                                  `apr-${id}.xlsx`,
                                )
                              }
                              className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-xs font-semibold text-[var(--ds-color-text-secondary)] transition-none hover:bg-[var(--ds-color-surface-base)]"
                            >
                              <Download className="h-4 w-4" />
                              Exportar Excel
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => {
                              setCompactMode((v) => !v);
                              setExpandedRows(new Set());
                            }}
                            className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-xs font-semibold text-[var(--ds-color-text-secondary)] transition-none hover:bg-[var(--ds-color-surface-base)]"
                            title={
                              compactMode
                                ? "Expandir todas as linhas"
                                : "Modo compacto"
                            }
                          >
                            {compactMode ? (
                              <Maximize2 className="h-4 w-4" />
                            ) : (
                              <Minimize2 className="h-4 w-4" />
                            )}
                            {compactMode ? "Expandir linhas" : "Modo compacto"}
                          </button>
                          <button
                            type="button"
                            onClick={handleSuggestControls}
                            disabled={suggestingControls || isReadOnly}
                            className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-primary-border)] bg-[color:var(--ds-color-primary-subtle)] px-3 py-2 text-xs font-semibold text-[var(--color-primary)] transition-none hover:bg-[color:var(--ds-color-primary-subtle)] disabled:opacity-60"
                          >
                            {suggestingControls ? (
                              <Loader2 className="h-4 w-4" />
                            ) : (
                              <Sparkles className="h-4 w-4" />
                            )}
                            Sugerir Controles
                          </button>
                          {!isReadOnly ? (
                            <button
                              type="button"
                              onClick={() => appendRisk(createEmptyRiskRow())}
                              className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] bg-[var(--component-button-primary-bg)] px-3 py-2 text-xs font-semibold text-[var(--color-text-inverse)] shadow-[var(--ds-shadow-sm)] transition-none hover:translate-y-0 hover:shadow-[var(--ds-shadow-sm)]"
                            >
                              <Plus className="h-4 w-4" />
                              Adicionar linha
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    {excelPreview ? (
                      <div className="mx-5 mt-5 rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/18 p-4 shadow-[var(--ds-shadow-xs)]">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                              Preview da planilha
                            </p>
                            <h3 className="mt-1 text-sm font-bold text-[var(--ds-color-text-primary)]">
                              {excelPreview.fileName}
                            </h3>
                            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                              {excelPreview.importedRows} linha(s) pronta(s) ·{" "}
                              {excelPreview.ignoredRows} ignorada(s)
                            </p>
                          </div>
                          {excelPreview.errors.length === 0 && !isReadOnly ? (
                            <button
                              type="button"
                              onClick={() =>
                                applyExcelPreviewToForm(excelPreview)
                              }
                              className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] bg-[var(--component-button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--color-text-inverse)] shadow-[var(--ds-shadow-sm)] transition-none hover:translate-y-0 hover:shadow-[var(--ds-shadow-sm)]"
                            >
                              <CheckCircle2 className="h-4 w-4" />
                              Aplicar ao formulário
                            </button>
                          ) : null}
                        </div>

                        {excelPreview.warnings.length > 0 ? (
                          <div className="mt-3 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)] px-3 py-2 text-sm text-[var(--color-warning)]">
                            {excelPreview.warnings[0]}
                          </div>
                        ) : null}

                        {excelPreview.errors.length > 0 ? (
                          <div className="mt-3 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] px-3 py-2 text-sm text-[var(--color-danger)]">
                            {excelPreview.errors[0]}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="mx-5 mt-3 overflow-hidden rounded-[calc(var(--ds-radius-xl)+2px)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/68">
                      <div className="flex flex-col gap-2 border-b border-[var(--ds-color-border-subtle)] px-4 py-2.5 md:flex-row md:items-center md:justify-between">
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ds-color-text-secondary)]">
                            Contexto da APR
                          </p>
                          <p className="mt-1 truncate text-sm font-bold text-[var(--ds-color-text-primary)]">
                            {tituloApr || "APR sem descrição operacional"}
                          </p>
                          <p className="mt-0.5 text-[11px] leading-5 text-[var(--ds-color-text-secondary)]">
                            Contexto mínimo para orientar a grade e a revisão.
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-1.5 text-xs font-semibold text-[var(--ds-color-text-secondary)]">
                            <ClipboardList className="h-3.5 w-3.5" />
                            {totalRiskLines} linha(s) em edição
                          </div>
                          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-1.5 text-xs font-semibold text-[var(--ds-color-text-secondary)]">
                            Revisão {currentApr?.versao || 1}
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-2 px-4 py-2.5 md:grid-cols-2 xl:grid-cols-6">
                        <SummaryMetaCard
                          label="Descrição"
                          value={tituloApr || "-"}
                        />
                        <SummaryMetaCard
                          label="Empresa"
                          value={selectedCompany?.razao_social || "-"}
                        />
                        <SummaryMetaCard
                          label="Site / obra"
                          value={selectedSite?.nome || "-"}
                        />
                        <SummaryMetaCard
                          label="Data"
                          value={dataInicioApr || "-"}
                        />
                        <SummaryMetaCard
                          label="Revisão / versão"
                          value={`${new Date().toLocaleDateString("pt-BR")} / v${currentApr?.versao || 1}`}
                        />
                        <SummaryMetaCard
                          label="Responsável"
                          value={selectedElaborador?.nome || "-"}
                        />
                      </div>
                    </div>

                    {/* Executive Summary Panel */}
                    <div className="mx-5 mt-3">
                      <AprExecutiveSummary
                        control={control}
                        variant="panel"
                        compactMode={compactMode}
                        showCompactToggle={false}
                        onToggleCompactMode={() => {
                          setCompactMode((v) => !v);
                          setExpandedRows(new Set());
                        }}
                      />
                    </div>

                    <div className="mx-5 mt-3">
                      {errors.itens_risco && (
                        <div className="mb-4 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] px-3 py-2 text-sm text-[var(--color-danger)]">
                          {errors.itens_risco.message}
                        </div>
                      )}

                      <div className="overflow-hidden rounded-[calc(var(--ds-radius-xl)+2px)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]">
                        {riskFields.length === 0 ? (
                          <div className="px-6 py-10 text-center">
                            <p className="text-base font-semibold text-[var(--ds-color-text-primary)]">
                              Nenhuma linha adicionada ainda.
                            </p>
                            <p className="mt-2 text-sm text-[var(--ds-color-text-secondary)]">
                              Comece pela primeira atividade crítica ou traga
                              uma planilha existente para acelerar a matriz.
                            </p>
                            <div className="mt-4 flex flex-col items-center justify-center gap-2 sm:flex-row">
                              {!isReadOnly ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    appendRisk(createEmptyRiskRow())
                                  }
                                  className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] bg-[var(--component-button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--color-text-inverse)] shadow-[var(--ds-shadow-sm)] transition-none hover:translate-y-0 hover:shadow-[var(--ds-shadow-sm)]"
                                >
                                  <Plus className="h-4 w-4" />
                                  Adicionar primeira linha
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => excelInputRef.current?.click()}
                                disabled={importingExcel || isReadOnly}
                                className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-4 py-2 text-sm font-semibold text-[var(--ds-color-text-secondary)] transition-none hover:bg-[var(--ds-color-surface-base)] disabled:opacity-60"
                              >
                                {importingExcel ? (
                                  <Loader2 className="h-4 w-4 " />
                                ) : (
                                  <Upload className="h-4 w-4" />
                                )}
                                Importar Excel
                              </button>
                            </div>
                            <div className="mt-4 inline-flex max-w-2xl items-start gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-info-border)] bg-[color:var(--ds-color-info-subtle)] px-3 py-2 text-left text-xs text-[var(--color-info)]">
                              <ClipboardList className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              <span>
                                Use importação quando a APR já existir em
                                planilha. Use adição manual quando a análise
                                estiver sendo construída direto no sistema.
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="overflow-x-auto">
                            <AprRiskGridHeader
                              hiddenCompactDetailsCount={
                                hiddenCompactDetailsCount
                              }
                            />
                            <div className="space-y-3 p-3">
                              {riskFields.map((field, index) => {
                                return (
                                  <AprRiskRow
                                    key={field.id}
                                    fieldId={field.id}
                                    index={index}
                                    totalRows={riskFields.length}
                                    readOnly={isReadOnly}
                                    compactMode={compactMode}
                                    expanded={expandedRows.has(index)}
                                    onToggleExpanded={toggleExpandedRow}
                                    onMove={moveRiskRow}
                                    onDuplicate={duplicateRiskRow}
                                    onRemove={handleRemoveRiskRow}
                                    control={control}
                                    register={register}
                                    setValue={setValue}
                                    aprFieldClass={aprFieldClass}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 xl:grid-cols-[minmax(0,1.16fr)_minmax(320px,0.84fr)]">
                    <AprRiskReferencePanel
                      getActionCriteriaText={getActionCriteriaText}
                    />
                    <div className="rounded-[calc(var(--ds-radius-xl)+2px)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 shadow-[var(--ds-shadow-xs)]">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
                        Feedback visual
                      </p>
                      <h3 className="mt-1.5 text-sm font-black text-[var(--ds-color-text-primary)]">
                        Leitura rápida da grade
                      </h3>
                      <div className="mt-3 space-y-1.5 text-sm text-[var(--ds-color-text-secondary)]">
                        <LegendItem
                          tone="critical"
                          label="Crítico"
                          description="Exige ação imediata e aparece com destaque máximo."
                        />
                        <LegendItem
                          tone="incomplete"
                          label="Incompleta / sem medida"
                          description="Linha com matriz parcial ou controle ainda indefinido."
                        />
                        <LegendItem
                          tone="ready"
                          label="Pronta"
                          description="Identificação, avaliação e medidas já estão coerentes."
                        />
                        <LegendItem
                          tone="priority"
                          label="Alta prioridade"
                          description="Risco substancial ou máximo antes do fechamento."
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

            {currentStep === 3 && (
              <>
                {/* M02 — Checklist de completude antes da revisão */}
                {(() => {
                  const watchedNumero = watch("numero");
                  const watchedTitulo = watch("titulo");
                  const watchedDataInicio = watch("data_inicio");
                  const items = [
                    { label: "Número da APR preenchido", ok: Boolean(watchedNumero) },
                    { label: "Título da APR preenchido", ok: Boolean(watchedTitulo) },
                    { label: "Data de início definida", ok: Boolean(watchedDataInicio) },
                    { label: "Ao menos 1 linha de risco completa", ok: materiallyCompleteRiskCount > 0 },
                    { label: "Ao menos 1 participante selecionado", ok: selectedParticipantIds.length > 0 },
                  ];
                  const allOk = items.every((i) => i.ok);
                  return (
                    <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-5 py-4 shadow-[var(--ds-shadow-sm)]">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
                        Checklist de completude
                      </p>
                      <ul className="mt-3 space-y-2">
                        {items.map((item) => (
                          <li key={item.label} className="flex items-center gap-2.5 text-sm">
                            {item.ok ? (
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--color-success)]" />
                            ) : (
                              <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-warning)]" />
                            )}
                            <span className={item.ok ? "text-[var(--ds-color-text-primary)]" : "text-[var(--ds-color-text-secondary)]"}>
                              {item.label}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {allOk && (
                        <p className="mt-3 text-xs font-semibold text-[var(--color-success)]">
                          APR pronta para revisão e envio.
                        </p>
                      )}
                    </div>
                  );
                })()}

                <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-5 shadow-[var(--ds-shadow-sm)]">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ds-color-text-secondary)]">
                    Revisão operacional
                  </p>
                  <h3 className="mt-2 text-lg font-bold text-[var(--ds-color-text-primary)]">
                    Validação final da APR
                  </h3>
                  <p className="mt-2 text-sm text-[var(--ds-color-text-secondary)]">
                    Revise a coerência da matriz de risco, os participantes
                    assinantes e os anexos antes de persistir a análise.
                  </p>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/18 px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                        Matriz de risco
                      </p>
                      <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                        {totalRiskLines > 0
                          ? `${materiallyCompleteRiskCount}/${totalRiskLines} linha(s) materialmente completas`
                          : "Nenhuma linha cadastrada"}
                      </p>
                    </div>
                    <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/18 px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                        Participantes
                      </p>
                      <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                        {selectedParticipantIds.length} selecionado(s) ·{" "}
                        {completedSignatures} assinatura(s)
                      </p>
                      {selectedParticipantIds.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setCurrentStep(2)}
                          className="mt-1 text-xs text-[var(--ds-color-action-primary)] hover:underline"
                        >
                          Ver todos os {selectedParticipantIds.length} participantes →
                        </button>
                      )}
                    </div>
                    <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/18 px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                        Evidência documental
                      </p>
                      <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                        {currentApr?.has_final_pdf
                          ? "PDF final governado emitido"
                          : isApproved
                            ? "Aguardando emissão final governada"
                            : "Ainda não elegível para emissão final"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 xl:grid-cols-3">
                    <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                        Contexto SST
                      </p>
                      <div className="mt-3 space-y-1.5 text-sm text-[var(--ds-color-text-secondary)]">
                        <p>
                          <span className="font-semibold text-[var(--ds-color-text-primary)]">
                            Tipo:
                          </span>{" "}
                          {selectedActivityTypeLabel}
                        </p>
                        <p>
                          <span className="font-semibold text-[var(--ds-color-text-primary)]">
                            Frente:
                          </span>{" "}
                          {watch("frente_trabalho") || "-"}
                        </p>
                        <p>
                          <span className="font-semibold text-[var(--ds-color-text-primary)]">
                            Turno:
                          </span>{" "}
                          {watch("turno") || "-"}
                        </p>
                        <p>
                          <span className="font-semibold text-[var(--ds-color-text-primary)]">
                            Local:
                          </span>{" "}
                          {watch("local_execucao_detalhado") || "-"}
                        </p>
                        <p>
                          <span className="font-semibold text-[var(--ds-color-text-primary)]">
                            Resp. técnico:
                          </span>{" "}
                          {watch("responsavel_tecnico_nome") || "-"}
                          {watch("responsavel_tecnico_registro")
                            ? ` · ${watch("responsavel_tecnico_registro")}`
                            : ""}
                        </p>
                      </div>
                    </div>

                    <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                        Fluxo de aprovação
                      </p>
                      <div className="mt-3 space-y-2">
                        {approvalSteps.length > 0 ? (
                          approvalSteps.map((step) => (
                            <div
                              key={step.id}
                              className="flex items-center justify-between gap-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] px-3 py-2"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-[var(--ds-color-text-primary)]">
                                  {step.title}
                                </p>
                                <p className="text-xs text-[var(--ds-color-text-secondary)]">
                                  {step.approver_role}
                                </p>
                              </div>
                              <span
                                className={cn(
                                  "shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]",
                                  step.status === "approved" &&
                                    "border-[var(--ds-color-success-border)] bg-[color:var(--ds-color-success-subtle)] text-[var(--color-success)]",
                                  step.status === "pending" &&
                                    "border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)] text-[var(--color-warning)]",
                                  step.status === "rejected" &&
                                    "border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] text-[var(--color-danger)]",
                                  step.status === "skipped" &&
                                    "border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)]",
                                )}
                              >
                                {step.status === "approved"
                                  ? "Aprovado"
                                  : step.status === "pending"
                                    ? "Pendente"
                                    : step.status === "rejected"
                                      ? "Reprovado"
                                      : "Ignorado"}
                              </span>
                            </div>
                          ))
                        ) : (
                          <p className="text-sm text-[var(--ds-color-text-secondary)]">
                            O fluxo de aprovação será exibido após o primeiro
                            carregamento da APR.
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                        Autenticidade
                      </p>
                      <div className="mt-3 space-y-1.5 text-sm text-[var(--ds-color-text-secondary)]">
                        <p>
                          <span className="font-semibold text-[var(--ds-color-text-primary)]">
                            Código:
                          </span>{" "}
                          {currentApr?.verification_code ||
                            "Gerado na emissão final"}
                        </p>
                        <p>
                          <span className="font-semibold text-[var(--ds-color-text-primary)]">
                            Hash:
                          </span>{" "}
                          {currentApr?.final_pdf_hash_sha256 ||
                            "Gerado na emissão final"}
                        </p>
                        <p>
                          <span className="font-semibold text-[var(--ds-color-text-primary)]">
                            PDF emitido em:
                          </span>{" "}
                          {currentApr?.pdf_generated_at
                            ? safeToLocaleString(
                                currentApr.pdf_generated_at,
                                "pt-BR",
                                undefined,
                                "data indisponível",
                              )
                            : "Ainda não emitido"}
                        </p>
                      </div>
                    </div>
                  </div>

                  <AprExecutiveSummary control={control} variant="breakdown" />
                </div>

                {canApprove && (
                  <details className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4">
                    <summary className="cursor-pointer list-none text-sm font-semibold text-[var(--ds-color-text-primary)]">
                      Auditoria avançada (opcional)
                    </summary>
                    <p className="mt-2 text-sm text-[var(--ds-color-text-secondary)]">
                      Utilize este bloco apenas quando o processo exigir registro
                      formal de auditoria interna.
                    </p>
                    <div className="mt-4">
                      <AuditSection
                        register={register}
                        auditors={filteredUsers}
                      />
                    </div>
                  </details>
                )}
              </>
            )}
          </fieldset>

          <MobileActionBar
            aria-label="Ações da APR"
            className="flex flex-col gap-4"
          >
            {!id && draftStorageKey && !isReadOnly ? (
              <div
                role="status"
                className="ds-mobile-form-status flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--ds-color-border-subtle)] pb-3 text-sm"
              >
                <div className="min-w-0 font-semibold text-[var(--ds-color-text-primary)]">
                  {draftSaving
                    ? "Salvando…"
                    : draftSaveError
                      ? "Falha ao salvar"
                      : draftLastSavedAt
                        ? (() => {
                            const diffMin = Math.floor(
                              (Date.now() - draftLastSavedAt.getTime()) / 60000,
                            );
                            if (diffMin < 1) return "Salvo agora";
                            if (diffMin < 60) return `Salvo há ${diffMin} min`;
                            return `Salvo às ${draftLastSavedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
                          })()
                        : "Salvo"}
                </div>
                {draftSaveError ? (
                  <button
                    type="button"
                    onClick={retryDraftPersist}
                    className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] px-3 py-1.5 text-xs font-semibold text-[var(--color-danger)] transition-none hover:bg-transparent/80"
                  >
                    Tentar novamente
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
              {currentStep > 1 ? (
                <button
                  type="button"
                  onClick={prevStep}
                  className={aprGhostActionClass}
                >
                  Voltar
                </button>
              ) : (
                <Link href="/dashboard/aprs" className={aprGhostActionClass}>
                  Cancelar
                </Link>
              )}
              {(isApproved || hasFinalPdf) && (
                <span className="hidden rounded-full border border-[var(--ds-color-border-subtle)] bg-[color:var(--color-card-muted)]/20 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-secondary)] sm:inline-flex sm:items-center sm:gap-1">
                  <Lock className="h-3 w-3" />
                  {hasFinalPdf ? "PDF emitido" : "Aprovada"}
                </span>
              )}
            </div>

              <div
                className={cn(
                  "flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-0 sm:space-x-4",
                  isFieldMode &&
                    "grid grid-cols-2 gap-3 sm:flex-none sm:space-x-0",
                )}
              >
              {currentStep >= 3 ? (
                hasFinalPdf ? (
                  <div
                    className={cn(
                      "flex flex-col gap-3 sm:flex-row sm:items-center",
                      isFieldMode && "col-span-2",
                    )}
                  >
                    {isApproved ? (
                      <button
                        type="button"
                        onClick={handleCloseApr}
                        disabled={closingApr}
                        className={cn(
                          aprPrimarySubmitActionClass,
                          isFieldMode && "min-h-12",
                        )}
                      >
                        {closingApr ? (
                          <Loader2 className="h-4 w-4 " />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" />
                        )}
                        <span>
                          {closingApr ? "Encerrando APR..." : "Encerrar APR"}
                        </span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={handleOpenGovernedPdf}
                      disabled={isOffline}
                      className={cn(
                        aprGhostActionClass,
                        "inline-flex items-center justify-center gap-2",
                        isOffline && "cursor-not-allowed opacity-60",
                        isFieldMode && "min-h-12",
                      )}
                    >
                      <FileText className="h-4 w-4" />
                      <span>Abrir PDF final</span>
                    </button>
                  </div>
                ) : isApproved ? (
                  <button
                    type="button"
                    onClick={handleEmitGovernedPdf}
                    disabled={
                      !canGenerateAprPdf || emittingGovernedPdf || isOffline
                    }
                    className={cn(
                      aprPrimarySubmitActionClass,
                      isOffline && "cursor-not-allowed opacity-60",
                      isFieldMode && "min-h-12",
                    )}
                  >
                    {emittingGovernedPdf ? (
                      <Loader2 className="h-4 w-4 " />
                    ) : (
                      <FileText className="h-4 w-4" />
                    )}
                    <span>Emitir PDF final governado</span>
                  </button>
                ) : isReadOnly ? (
                  <div
                    className={cn(
                      "flex flex-col gap-2 sm:items-end",
                      isFieldMode && "col-span-2",
                    )}
                  >
                    {canApprove && canApproveCurrentApr ? (
                      <button
                        type="button"
                        onClick={handleApproveApr}
                        disabled={finalizing}
                        className={cn(
                          aprPrimarySubmitActionClass,
                          isFieldMode && "min-h-12",
                        )}
                      >
                        {finalizing ? (
                          <Loader2 className="h-4 w-4 " />
                        ) : (
                          <ShieldCheck className="h-4 w-4" />
                        )}
                        <span>
                          {pendingApprovalStep
                            ? `Aprovar etapa: ${pendingApprovalStep.title}`
                            : "Aprovar APR"}
                        </span>
                      </button>
                    ) : null}
                    {readOnlyReason ? (
                      <p className="text-sm text-[var(--ds-color-text-secondary)] sm:max-w-md sm:text-right">
                        {readOnlyReason}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        submitIntentRef.current = "save_and_print";
                        void handleSubmit(onSubmit)();
                      }}
                      disabled={
                        !canWriteApr ||
                        loading ||
                        isOffline ||
                        isDraftSyncInFlight
                      }
                      title={saveAndPrintBlockReason || undefined}
                      className={cn(
                        aprGhostActionClass,
                        "inline-flex items-center justify-center gap-2",
                        (isOffline || isDraftSyncInFlight) &&
                          "cursor-not-allowed opacity-60",
                        isFieldMode && "min-h-12",
                      )}
                    >
                      {loading ? (
                        <Loader2 className="h-4 w-4 " />
                      ) : (
                        <Printer className="h-4 w-4" />
                      )}
                      <span>Salvar e imprimir</span>
                    </button>
                    {saveAndPrintBlockReason ? (
                      <p className="text-sm text-[var(--ds-color-text-secondary)] sm:ml-2">
                        {saveAndPrintBlockReason}
                      </p>
                    ) : null}
                    <button
                      type="submit"
                      onClick={() => {
                        submitIntentRef.current = "save";
                        if (
                          complianceResult &&
                          complianceResult.blockers.length > 0
                        ) {
                          compliancePanelRef.current?.scrollIntoView({
                            behavior: "smooth",
                            block: "start",
                          });
                        }
                      }}
                      disabled={
                        !canWriteApr ||
                        loading ||
                        isDraftSyncInFlight ||
                        Boolean(
                          id &&
                          complianceResult &&
                          complianceResult.blockers.length > 0,
                        )
                      }
                      title={
                        id &&
                        complianceResult &&
                        complianceResult.blockers.length > 0
                          ? "APR possui pendências críticas. Corrija antes de salvar."
                          : saveBlockReason || undefined
                      }
                      className={cn(
                        aprPrimarySubmitActionClass,
                        isDraftSyncInFlight && "cursor-not-allowed opacity-60",
                        isFieldMode && "min-h-12",
                      )}
                    >
                      {loading ? (
                        <Loader2 className="h-4 w-4 " />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      <span>{id ? "Atualizar APR" : "Salvar APR"}</span>
                    </button>
                    {saveBlockReason ? (
                      <p className="text-sm text-[var(--ds-color-text-secondary)] sm:ml-2">
                        {saveBlockReason}
                      </p>
                    ) : null}
                  </>
                )
              ) : (
                <button
                  type="button"
                  onClick={nextStep}
                  className={cn(
                    aprPrimaryActionClass,
                    isFieldMode && "min-h-12",
                  )}
                >
                  <span>Próximo</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
              )}
              </div>
            </div>
          </MobileActionBar>
        </div>
      </form>


      {formActionModal ? (
        <AprActionModal
          isOpen
          onClose={() => setFormActionModal(null)}
          onConfirm={confirmFormAction}
          loading={formActionModalLoading}
          title={
            formActionModal === "approve"
              ? pendingApprovalStep
                ? `Aprovar etapa: ${pendingApprovalStep.title}`
                : "Aprovar APR"
              : "Encerrar APR"
          }
          description={
            formActionModal === "approve"
              ? pendingApprovalStep
                ? `Esta ação registra a aprovação da etapa ${pendingApprovalStep.title} no fluxo oficial da APR.`
                : "A APR seguirá para o fluxo oficial de emissão do PDF final."
              : "A APR será concluída e removida da etapa de edição operacional."
          }
          impact={
            formActionModal === "approve"
              ? pendingApprovalStep
                ? "Após aprovar esta etapa, o formulário permanece bloqueado e a APR avança para o próximo nível de aprovação."
                : "Após aprovação, a edição direta fica bloqueada e o próximo passo é emitir o PDF governado."
              : "Após encerrada, a APR não poderá voltar para edição."
          }
          confirmLabel={
            formActionModal === "approve"
              ? pendingApprovalStep
                ? "Aprovar etapa"
                : "Aprovar"
              : "Encerrar APR"
          }
          aprSummary={{
            numero: currentApr?.numero || watch("numero"),
            titulo: currentApr?.titulo || watch("titulo"),
            status: currentApr?.status || watch("status"),
          }}
        />
      ) : null}

      <SignatureModal
        isOpen={canManageSignatures && isSignatureModalOpen}
        onClose={() => {
          setIsSignatureModalOpen(false);
          setCurrentSigningUser(null);
        }}
        onSave={handleSaveSignature}
        userName={currentSigningUser?.nome || ""}
      />

      {/* C01 — Confirmação de descarte de sync offline */}
      <ConfirmModal
        open={confirmDiscardOpen}
        onClose={() => setConfirmDiscardOpen(false)}
        onConfirm={() => void handleConfirmDiscardPendingOfflineSync()}
        title="Descartar envio local?"
        description="Esta ação remove permanentemente o rascunho offline da fila. O dado local será perdido. Verifique a listagem antes de confirmar para evitar duplicidade."
        confirmLabel="Descartar"
        danger
      />

      {/* C03 — Confirmação de troca de empresa com dados preenchidos */}
      <ConfirmModal
        open={confirmCompanyChangeOpen}
        onClose={() => {
          setConfirmCompanyChangeOpen(false);
          setPendingCompanyId(null);
        }}
        onConfirm={handleConfirmCompanyChange}
        title="Trocar empresa apagará dados preenchidos"
        description="A matriz de riscos e participantes serão removidos ao trocar a empresa. Esta ação não pode ser desfeita. Deseja continuar?"
        confirmLabel="Trocar empresa"
        danger
      />

      {/* C09 — Confirmação de aplicação de template */}
      <ConfirmModal
        open={confirmTemplateOpen}
        onClose={() => setConfirmTemplateOpen(false)}
        onConfirm={() => {
          applySelectedActivityTemplate();
          setConfirmTemplateOpen(false);
        }}
        title="Aplicar template à grade?"
        description={`O template "${selectedActivityTemplate?.label ?? ""}" será mesclado à matriz de riscos atual. Linhas já presentes não serão duplicadas.`}
        confirmLabel="Aplicar template"
      />
    </div>
  );
}
