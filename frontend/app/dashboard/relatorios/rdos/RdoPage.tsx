"use client";
import { logger } from "@/lib/logger";

import dynamic from "next/dynamic";
import {
  useState,
  useEffect,
  useCallback,
  useDeferredValue,
  useRef,
} from "react";
import { toast } from "sonner";
import {
  rdosService,
  Rdo,
  MaoDeObraItem,
  EquipamentoItem,
  MaterialItem,
  ServicoItem,
  OcorrenciaItem,
  RDO_ACTIVITY_GOVERNED_PHOTO_REF_PREFIX,
  RDO_STATUS_LABEL,
  RDO_STATUS_COLORS,
  RDO_ALLOWED_TRANSITIONS,
} from "@/services/rdosService";
import { exportCurrentRdoExcel } from "./rdoExcelExport";
import {
  Plus,
  Search,
  FileSpreadsheet,
  ClipboardList,
  Trash2,
  AlertTriangle,
  Users,
  Wrench,
  Package,
  CheckSquare,
  CloudRain,
  Eye,
  Pencil,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginationControls } from "@/components/PaginationControls";
import { ResponsiveDataList } from "@/components/ui/responsive-data-list";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  EmptyState,
  ErrorState,
  InlineLoadingState,
} from "@/components/ui/state";
import { InlineCallout } from "@/components/ui/inline-callout";
import { ListPageLayout } from "@/components/layout";
import { cn } from "@/lib/utils";
import { openPdfForPrint } from "@/lib/print-utils";
import { openSafeExternalUrlInNewTab } from "@/lib/security/safe-external-url";
import { useDocumentVideos } from "@/hooks/useDocumentVideos";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { base64ToPdfBlob, base64ToPdfFile } from "@/lib/pdf/pdfFile";
import { useAuth } from "@/context/AuthContext";
import { Permission } from '@/lib/permissions';
import { isUserVisibleForSite } from "@/lib/site-scoped-user-visibility";
import {
  safeToLocaleDateString,
  toInputDateValue,
} from "@/lib/date/safeFormat";
import { isSafeImagePreviewUrl } from "@/lib/security/is-safe-image-preview-url";
import { RdoEditorModal } from "@/components/rdos/RdoEditorModal";
import { RdoViewerModal } from "@/components/rdos/RdoViewerModal";
import { RdoActionModals } from "@/components/rdos/RdoActionModals";
import {
  PendingActivityPhoto,
  RdoEquipamentoItem,
  RdoFormState,
  RdoMaoDeObraItem,
  RdoMaterialItem,
  RdoOcorrenciaItem,
  RdoSignModalState,
  RdoServicoItem,
} from "@/components/rdos/rdo-modal-types";
import { useRdoTenantReferenceData } from "./useRdoTenantReferenceData";
import {
  useRdoTenantPageIsolation,
  type RdoTenantOperation,
} from "./useRdoTenantPageIsolation";
const StoredFilesPanel = dynamic(
  () =>
    import("@/components/StoredFilesPanel").then(
      (module) => module.StoredFilesPanel,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="mt-6 h-40 motion-safe:animate-pulse rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/60" />
    ),
  },
);
const loadRdoPdfGenerator = async () => import("@/lib/pdf/rdoGenerator");

const inputClassName =
  "h-11 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-4 text-base text-[var(--ds-color-text-primary)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]";

const formInputClassName =
  "w-full min-h-[2.875rem] rounded-xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-4 py-2.5 text-base leading-6 text-[var(--ds-color-text-primary)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] motion-safe:transition-all";

const formInputSmClassName =
  "w-full min-h-[2.625rem] rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-base text-[var(--ds-color-text-primary)] focus:border-[var(--ds-color-focus)] focus:outline-none motion-safe:transition-all";

const STEPS = [
  { label: "Dados Básicos", icon: ClipboardList },
  { label: "Clima", icon: CloudRain },
  { label: "Mão de Obra", icon: Users },
  { label: "Equipamentos", icon: Wrench },
  { label: "Materiais", icon: Package },
  { label: "Serviços", icon: CheckSquare },
  { label: "Ocorrências", icon: AlertTriangle },
];

function isGovernedActivityPhotoReference(value?: string | null) {
  return (
    typeof value === "string" &&
    value.startsWith(RDO_ACTIVITY_GOVERNED_PHOTO_REF_PREFIX)
  );
}

function createRdoRowKey() {
  return crypto.randomUUID();
}

function withRdoRowKey<T extends object>(item: T): T & { __rowKey: string } {
  return {
    ...item,
    __rowKey: createRdoRowKey(),
  };
}

function stripRdoRowKey<T extends { __rowKey: string }>(
  item: T,
): Omit<T, "__rowKey"> {
  const { __rowKey, ...payloadItem } = item;
  void __rowKey;
  return payloadItem;
}

const defaultForm: RdoFormState = {
  data: new Date().toISOString().slice(0, 10),
  site_id: "",
  responsavel_id: "",
  clima_manha: "",
  clima_tarde: "",
  temperatura_min: "",
  temperatura_max: "",
  condicao_terreno: "",
  mao_de_obra: [],
  equipamentos: [],
  materiais_recebidos: [],
  servicos_executados: [],
  ocorrencias: [],
  houve_acidente: false,
  houve_paralisacao: false,
  motivo_paralisacao: "",
  observacoes: "",
  programa_servicos_amanha: "",
};

function rdoToForm(rdo: Rdo): RdoFormState {
  return {
    data: toInputDateValue(rdo.data, toInputDateValue(new Date())),
    site_id: rdo.site_id ?? "",
    responsavel_id: rdo.responsavel_id ?? "",
    clima_manha: rdo.clima_manha ?? "",
    clima_tarde: rdo.clima_tarde ?? "",
    temperatura_min:
      rdo.temperatura_min != null ? String(rdo.temperatura_min) : "",
    temperatura_max:
      rdo.temperatura_max != null ? String(rdo.temperatura_max) : "",
    condicao_terreno: rdo.condicao_terreno ?? "",
    mao_de_obra: (rdo.mao_de_obra ?? []).map(withRdoRowKey),
    equipamentos: (rdo.equipamentos ?? []).map(withRdoRowKey),
    materiais_recebidos: (rdo.materiais_recebidos ?? []).map(withRdoRowKey),
    servicos_executados: (rdo.servicos_executados ?? []).map((item) =>
      withRdoRowKey({
        ...item,
        observacao: item.observacao ?? "",
        fotos: item.fotos ?? [],
      }),
    ),
    ocorrencias: (rdo.ocorrencias ?? []).map(withRdoRowKey),
    houve_acidente: rdo.houve_acidente,
    houve_paralisacao: rdo.houve_paralisacao,
    motivo_paralisacao: rdo.motivo_paralisacao ?? "",
    observacoes: rdo.observacoes ?? "",
    programa_servicos_amanha: rdo.programa_servicos_amanha ?? "",
  };
}

export default function RdosPage() {
  const { hasPermission } = useAuth();
  const canManageRdo = hasPermission(Permission.CAN_MANAGE_RDOS);
  const [rdos, setRdos] = useState<Rdo[]>([]);
  const timerRef = useRef<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const handleReferenceDataError = useCallback((message: string) => {
    setLoadError(message);
  }, []);
  const [saving, setSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [form, setForm] = useState<RdoFormState>(defaultForm);
  const [pendingActivityPhotos, setPendingActivityPhotos] = useState<
    Record<number, PendingActivityPhoto[]>
  >({});
  const [resolvedActivityPhotoUrls, setResolvedActivityPhotoUrls] = useState<
    Record<string, string>
  >({});
  const pendingActivityPhotosRef = useRef<
    Record<number, PendingActivityPhoto[]>
  >({});

  const revokePendingActivityEntries = useCallback(
    (entries?: Record<number, PendingActivityPhoto[]>) => {
      Object.values(entries ?? {}).forEach((photos) => {
        photos.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
      });
    },
    [],
  );

  useEffect(() => {

    const timer = timerRef.current;


    return () => {

      if (timer) {

        clearTimeout(timer);

      }

    };

  }, []);

useEffect(() => {
    pendingActivityPhotosRef.current = pendingActivityPhotos;
  }, [pendingActivityPhotos]);

  useEffect(() => {
    return () => {
      revokePendingActivityEntries(pendingActivityPhotosRef.current);
    };
  }, [revokePendingActivityEntries]);

  const resetPendingActivityPhotos = useCallback(() => {
    revokePendingActivityEntries(pendingActivityPhotosRef.current);
    pendingActivityPhotosRef.current = {};
    setPendingActivityPhotos({});
  }, [revokePendingActivityEntries]);

  const closeEditorModal = useCallback(() => {
    resetPendingActivityPhotos();
    setShowModal(false);
  }, [resetPendingActivityPhotos]);

  // View modal
  const [viewRdo, setViewRdo] = useState<Rdo | null>(null);

  // Sign modal
  const [signModal, setSignModal] = useState<RdoSignModalState>(null);
  const [signForm, setSignForm] = useState({
    nome: "",
    cpf: "",
    tipo: "responsavel" as "responsavel" | "engenheiro",
  });
  const [signing, setSigning] = useState(false);

  // Email modal
  const [emailModal, setEmailModal] = useState<Rdo | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);

  // Delete confirm modal
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(deleteDialogRef, deleteConfirmId !== null, () => setDeleteConfirmId(null));

  // Cancel RDO modal
  const [cancelTarget, setCancelTarget] = useState<Rdo | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);
  const cancelDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cancelDialogRef, cancelTarget !== null, () => { setCancelTarget(null); setCancelReason(""); });

  // Paginação + filtros
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, [setPage]);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage, setPage]);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSiteId, setFilterSiteId] = useState("");
  const [filterDataInicio, setFilterDataInicio] = useState("");
  const [filterDataFim, setFilterDataFim] = useState("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  // Resumo
  const [summary, setSummary] = useState({
    total: 0,
    rascunho: 0,
    enviado: 0,
    aprovado: 0,
    cancelado: 0,
  });
  const clearTenantOwnedPageState = useCallback(() => {
    setRdos([]);
    setTotal(0);
    setLastPage(1);
    setSummary({
      total: 0,
      rascunho: 0,
      enviado: 0,
      aprovado: 0,
      cancelado: 0,
    });
    setLoading(true);
    setLoadError(null);
    setViewRdo(null);
    setShowModal(false);
    setEditingId(null);
    setCurrentStep(0);
    setForm(defaultForm);
    resetPendingActivityPhotos();
    setResolvedActivityPhotoUrls({});
    setSignModal(null);
    setSignForm({ nome: "", cpf: "", tipo: "responsavel" });
    setSigning(false);
    setEmailModal(null);
    setEmailTo("");
    setSendingEmail(false);
    setFilterSiteId("");
    setPage(1);
  }, [resetPendingActivityPhotos]);
  const tenantPageIsolation = useRdoTenantPageIsolation(
    clearTenantOwnedPageState,
  );
  const { activeCompanyId, sites, users, ensureUsersLoaded } =
    useRdoTenantReferenceData({
      canManageRdo,
      onReferenceDataError: handleReferenceDataError,
    });
  const viewRdoLocked =
    Boolean(viewRdo?.pdf_file_key) ||
    viewRdo?.status === "aprovado" ||
    viewRdo?.status === "cancelado";
  const viewRdoLockMessage = viewRdo?.pdf_file_key
    ? "O RDO já possui PDF final emitido."
    : viewRdo?.status === "aprovado"
      ? "O RDO está aprovado."
      : viewRdo?.status === "cancelado"
        ? "O RDO está cancelado."
        : null;
  const viewRdoVideos = useDocumentVideos({
    documentId: viewRdo?.id,
    enabled: Boolean(viewRdo?.id),
    operationKey: `${activeCompanyId ?? "none"}:${viewRdo?.id ?? "closed"}`,
    loadVideos: rdosService.listVideoAttachments,
    uploadVideo: rdosService.uploadVideoAttachment,
    removeVideo: rdosService.removeVideoAttachment,
    getVideoAccess: rdosService.getVideoAttachmentAccess,
    labels: {
      loadError: "Não foi possível carregar os vídeos do RDO.",
      uploadSuccess: "Vídeo anexado ao RDO.",
      uploadError: "Não foi possível anexar o vídeo ao RDO.",
      removeSuccess: "Vídeo removido do RDO.",
      removeError: "Não foi possível remover o vídeo do RDO.",
      accessError: "Não foi possível abrir o vídeo do RDO.",
    },
  });

  const getApiErrorMessage = useCallback((error: unknown) => {
    const message = (
      error as
        | { response?: { data?: { message?: string | string[] } } }
        | undefined
    )?.response?.data?.message;

    if (Array.isArray(message)) {
      return message.join(" ");
    }
    if (typeof message === "string" && message.trim()) {
      return message;
    }
    return null;
  }, []);

  const getAllowedStatusTransitions = useCallback((rdo: Rdo) => {
    if (rdo.pdf_file_key) {
      return [];
    }

    return (RDO_ALLOWED_TRANSITIONS[rdo.status] ?? []).filter((status) => {
      if (status !== "aprovado") {
        return true;
      }
      return Boolean(rdo.assinatura_responsavel && rdo.assinatura_engenheiro);
    });
  }, []);

  const refreshOverview = useCallback(async () => {
    if (!activeCompanyId) {
      setSummary({
        total: 0,
        rascunho: 0,
        enviado: 0,
        aprovado: 0,
        cancelado: 0,
      });
      return;
    }

    const companyId = activeCompanyId;
    const requestToken = tenantPageIsolation.start("overview", companyId);
    try {
      const overviewResult = await rdosService.getAnalyticsOverview();
      if (
        !tenantPageIsolation.isCurrent("overview", requestToken, companyId)
      ) {
        return;
      }
      setSummary({
        total: overviewResult.totalRdos,
        rascunho: overviewResult.rascunho,
        enviado: overviewResult.enviado,
        aprovado: overviewResult.aprovado,
        cancelado: overviewResult.cancelado,
      });
    } catch (error) {
      if (
        !tenantPageIsolation.isCurrent("overview", requestToken, companyId)
      ) {
        return;
      }
      throw error;
    }
  }, [activeCompanyId, tenantPageIsolation]);

  const loadRdoPageData = useCallback(async () => {
    if (!activeCompanyId) {
      setRdos([]);
      setTotal(0);
      setLastPage(1);
      setSummary({
        total: 0,
        rascunho: 0,
        enviado: 0,
        aprovado: 0,
        cancelado: 0,
      });
      setLoading(false);
      return;
    }

    const companyId = activeCompanyId;
    const requestToken = tenantPageIsolation.start("list", companyId);
    try {
      setLoading(true);
      setLoadError(null);
      const rdosResult = await rdosService.findPaginated({
        page,
        limit,
        search: deferredSearch || undefined,
        status: filterStatus || undefined,
        site_id: filterSiteId || undefined,
        data_inicio: filterDataInicio || undefined,
        data_fim: filterDataFim || undefined,
      });

      if (!tenantPageIsolation.isCurrent("list", requestToken, companyId)) {
        return;
      }
      setRdos(rdosResult.data);
      setTotal(rdosResult.total);
      setLastPage(rdosResult.lastPage);
    } catch (error) {
      if (!tenantPageIsolation.isCurrent("list", requestToken, companyId)) {
        return;
      }
      logger.error("Erro ao carregar RDOs:", error);
      setLoadError("Não foi possível carregar os RDOs.");
      toast.error("Erro ao carregar RDOs.");
    } finally {
      if (tenantPageIsolation.isCurrent("list", requestToken, companyId)) {
        setLoading(false);
      }
    }
  }, [
    activeCompanyId,
    page,
    limit,
    filterStatus,
    filterSiteId,
    filterDataInicio,
    filterDataFim,
    deferredSearch,
    tenantPageIsolation,
  ]);

  const refreshRdoDashboard = useCallback(async () => {
    await loadRdoPageData();
    void refreshOverview();
  }, [loadRdoPageData, refreshOverview]);

  useEffect(() => {
    void loadRdoPageData();
  }, [loadRdoPageData]);

  useEffect(() => {
    void refreshOverview().catch((error) => {
      logger.error("Erro ao carregar overview analítico de RDOs:", error);
    });
  }, [refreshOverview]);

  const hydrateActivityPhotoUrls = useCallback(
    async (documentId: string, activities: ServicoItem[]) => {
      const missing = activities.flatMap((activity, activityIndex) =>
        (activity.fotos ?? [])
          .map((photo, photoIndex) => ({ photo, photoIndex, activityIndex }))
          .filter(
            ({ photo }) =>
              isGovernedActivityPhotoReference(photo) &&
              !resolvedActivityPhotoUrls[photo],
          ),
      );

      if (!missing.length || !activeCompanyId) {
        return;
      }

      const companyId = activeCompanyId;
      // Editor e viewer podem hidratar documentos diferentes em paralelo.
      const photoChannel = `photos:${documentId}`;
      const requestToken = tenantPageIsolation.start(photoChannel, companyId);
      const resolvedEntries = await Promise.all(
        missing.map(async ({ photo, activityIndex, photoIndex }) => {
          try {
            const access = await rdosService.getActivityPhotoAccess(
              documentId,
              activityIndex,
              photoIndex,
            );
            return access.url ? ([photo, access.url] as const) : null;
          } catch (error) {
            if (
              tenantPageIsolation.isCurrent(photoChannel, requestToken, companyId)
            ) {
              logger.error("Erro ao resolver foto da atividade do RDO:", error);
            }
            return null;
          }
        }),
      );

      const nextEntries = Object.fromEntries(
        resolvedEntries.filter((entry): entry is readonly [string, string] =>
          Boolean(entry),
        ),
      );

      if (
        Object.keys(nextEntries).length &&
        tenantPageIsolation.isCurrent(photoChannel, requestToken, companyId)
      ) {
        setResolvedActivityPhotoUrls((current) => ({
          ...current,
          ...nextEntries,
        }));
      }
    },
    [activeCompanyId, resolvedActivityPhotoUrls, tenantPageIsolation],
  );

  useEffect(() => {
    if (!showModal || !editingId) {
      return;
    }

    void hydrateActivityPhotoUrls(editingId, form.servicos_executados);
  }, [
    editingId,
    form.servicos_executados,
    hydrateActivityPhotoUrls,
    showModal,
  ]);

  useEffect(() => {
    if (!viewRdo?.id) {
      return;
    }

    void hydrateActivityPhotoUrls(
      viewRdo.id,
      viewRdo.servicos_executados ?? [],
    );
  }, [hydrateActivityPhotoUrls, viewRdo]);

  const getGovernedPdfAccess = useCallback(
    async (rdoId: string, operation: RdoTenantOperation) => {
      if (!tenantPageIsolation.isOperationCurrent(operation)) return null;
      const access = await rdosService.getPdfAccess(rdoId);
      if (!tenantPageIsolation.isOperationCurrent(operation)) return null;
      return access.hasFinalPdf ? access : null;
    },
    [tenantPageIsolation],
  );

  const ensureGovernedPdf = useCallback(
    async (rdo: Rdo, operation: RdoTenantOperation) => {
      if (!tenantPageIsolation.isOperationCurrent(operation)) return null;
      const existingAccess = await getGovernedPdfAccess(rdo.id, operation);
      if (!tenantPageIsolation.isOperationCurrent(operation)) return null;
      if (existingAccess) return existingAccess;
      if (rdo.status !== "aprovado") return null;

      const fullRdo = await rdosService.findOne(rdo.id);
      if (!tenantPageIsolation.isOperationCurrent(operation)) return null;
      const { generateRdoPdf } = await loadRdoPdfGenerator();
      if (!tenantPageIsolation.isOperationCurrent(operation)) return null;
      const result = (await generateRdoPdf(fullRdo, {
        save: false,
        output: "base64",
        draftWatermark: false,
      })) as { base64: string; filename: string } | undefined;
      if (!tenantPageIsolation.isOperationCurrent(operation)) return null;

      if (!result?.base64) {
        throw new Error("Falha ao gerar o PDF oficial do RDO.");
      }

      const pdfFile = base64ToPdfFile(result.base64, result.filename);
      await rdosService.attachFile(rdo.id, pdfFile);
      if (!tenantPageIsolation.isOperationCurrent(operation)) return null;
      await refreshRdoDashboard();
      if (!tenantPageIsolation.isOperationCurrent(operation)) return null;
      toast.success("PDF final do RDO emitido e registrado com sucesso.");
      const access = await rdosService.getPdfAccess(rdo.id);
      return tenantPageIsolation.isOperationCurrent(operation) ? access : null;
    },
    [getGovernedPdfAccess, refreshRdoDashboard, tenantPageIsolation],
  );

  const handleOpenCreate = async () => {
    if (!canManageRdo) {
      toast.error("Você não tem permissão para criar RDOs.");
      return;
    }

    if (!activeCompanyId) {
      return;
    }
    const companyId = activeCompanyId;
    const requestToken = tenantPageIsolation.start("openEditor", companyId);
    try {
      await ensureUsersLoaded();
      if (
        !tenantPageIsolation.isCurrent("openEditor", requestToken, companyId)
      ) {
        return;
      }
      resetPendingActivityPhotos();
      setEditingId(null);
      setForm(defaultForm);
      setCurrentStep(0);
      setShowModal(true);
    } catch {
      return;
    }
  };

  const handleOpenEdit = async (rdo: Rdo) => {
    if (!tenantPageIsolation.isActiveCompany(rdo.company_id)) {
      return;
    }
    if (!canManageRdo) {
      toast.error("Você não tem permissão para editar RDOs.");
      return;
    }
    if (rdo.status === "cancelado") {
      toast.error("RDO cancelado está bloqueado para edição.");
      return;
    }
    if (rdo.pdf_file_key) {
      toast.error(
        "RDO com PDF final emitido esta bloqueado para edicao. Gere um novo documento para alterar o conteudo.",
      );
      return;
    }

    if (!activeCompanyId) {
      return;
    }
    const companyId = activeCompanyId;
    const requestToken = tenantPageIsolation.start("openEditor", companyId);
    try {
      await ensureUsersLoaded();
      if (
        !tenantPageIsolation.isCurrent("openEditor", requestToken, companyId)
      ) {
        return;
      }
      resetPendingActivityPhotos();
      setEditingId(rdo.id);
      setForm(rdoToForm(rdo));
      setCurrentStep(0);
      setShowModal(true);
    } catch {
      return;
    }
  };

  const handlePrintAfterSave = useCallback(
    async (rdo: Rdo, operation: RdoTenantOperation) => {
      const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
      if (!isCurrent()) return;
      toast.info("Preparando impressão do RDO...");

      const shouldUseGovernedPdf =
        Boolean(rdo.pdf_file_key) || rdo.status === "aprovado";

      if (shouldUseGovernedPdf) {
        const access = await ensureGovernedPdf(rdo, operation);
        if (!isCurrent()) return;
        if (access?.hasFinalPdf && access.url) {
          openPdfForPrint(access.url, () => {
            if (isCurrent()) {
              toast.info(
                "Pop-up bloqueado. Permita pop-ups para imprimir o PDF final do RDO.",
              );
            }
          });
          return;
        }

        if (access?.hasFinalPdf) {
          toast.warning(
            access.message ||
              "O PDF final do RDO foi emitido, mas a URL segura não está disponível agora. Abrimos o download oficial do arquivo para impressão.",
          );
          const officialBlob = await rdosService.downloadPdf(rdo.id);
          if (!isCurrent()) return;
          const officialFileUrl = URL.createObjectURL(officialBlob);
          openPdfForPrint(officialFileUrl, () => {
            if (isCurrent()) {
              toast.info(
                "Pop-up bloqueado. Permita pop-ups para imprimir o PDF final do RDO.",
              );
            }
          });
          setTimeout(() => URL.revokeObjectURL(officialFileUrl), 60_000);
          return;
        }

        throw new Error(
          "O RDO aprovado precisa do PDF final governado antes da impressão.",
        );
      }

      const fullRdo = await rdosService.findOne(rdo.id);
      if (!isCurrent()) return;
      const { generateRdoPdf } = await loadRdoPdfGenerator();
      if (!isCurrent()) return;
      const result = (await generateRdoPdf(fullRdo, {
        save: false,
        output: "base64",
        draftWatermark: true,
      })) as { base64: string } | undefined;
      if (!isCurrent()) return;

      if (!result?.base64) {
        throw new Error("Falha ao gerar PDF do RDO para impressão.");
      }

      const fileURL = URL.createObjectURL(base64ToPdfBlob(result.base64));
      openPdfForPrint(fileURL, () => {
        if (isCurrent()) {
          toast.info(
            "Pop-up bloqueado. Permita pop-ups para imprimir o PDF final do RDO.",
          );
        }
      });
      setTimeout(() => URL.revokeObjectURL(fileURL), 60_000);
    },
    [ensureGovernedPdf, tenantPageIsolation],
  );

  const validateRdoForm = () => {
    if (!form.data) {
      return "Informe a data do RDO.";
    }

    if (form.site_id && form.responsavel_id) {
      const selectedResponsavel = users.find((user) => user.id === form.responsavel_id);
      if (!selectedResponsavel || !isUserVisibleForSite(selectedResponsavel, selectedResponsavel.company_id || "", form.site_id)) {
        return "O responsável selecionado não pertence à obra atual.";
      }
    }

    const temperaturaMin =
      form.temperatura_min !== "" ? Number(form.temperatura_min) : null;
    const temperaturaMax =
      form.temperatura_max !== "" ? Number(form.temperatura_max) : null;

    if (
      temperaturaMin != null &&
      temperaturaMax != null &&
      temperaturaMin > temperaturaMax
    ) {
      return "A temperatura mínima não pode ser maior que a máxima.";
    }

    if (form.houve_paralisacao && !form.motivo_paralisacao.trim()) {
      return "Informe o motivo da paralisação.";
    }

    const invalidMaoDeObra = form.mao_de_obra.findIndex(
      (item) => !item.funcao.trim(),
    );
    if (invalidMaoDeObra >= 0) {
      return `Preencha a função da mão de obra #${invalidMaoDeObra + 1}.`;
    }

    const invalidEquipamento = form.equipamentos.findIndex(
      (item) => !item.nome.trim(),
    );
    if (invalidEquipamento >= 0) {
      return `Preencha o nome do equipamento #${invalidEquipamento + 1}.`;
    }

    const invalidMaterial = form.materiais_recebidos.findIndex(
      (item) => !item.descricao.trim() || !item.unidade.trim(),
    );
    if (invalidMaterial >= 0) {
      return `Preencha descrição e unidade do material #${invalidMaterial + 1}.`;
    }

    const invalidServico = form.servicos_executados.findIndex(
      (item) => !item.descricao.trim(),
    );
    if (invalidServico >= 0) {
      return `Preencha a descrição da atividade #${invalidServico + 1}.`;
    }

    const invalidOcorrencia = form.ocorrencias.findIndex(
      (item) => !item.descricao.trim(),
    );
    if (invalidOcorrencia >= 0) {
      return `Preencha a descrição da ocorrência #${invalidOcorrencia + 1}.`;
    }

    const activityWithTooManyPhotos = form.servicos_executados.findIndex(
      (item, activityIndex) =>
        (item.fotos?.length ?? 0) +
          getPendingActivityPhotos(activityIndex).length >
        10,
    );
    if (activityWithTooManyPhotos >= 0) {
      return `A atividade #${activityWithTooManyPhotos + 1} excedeu o limite de 10 fotos.`;
    }

    return null;
  };

  const uploadQueuedActivityPhotos = async (
    rdoId: string,
    operation: RdoTenantOperation,
  ) => {
    const queuedEntries = Object.entries(pendingActivityPhotosRef.current)
      .map(([activityIndex, photos]) => ({
        activityIndex: Number(activityIndex),
        photos,
      }))
      .filter(({ photos }) => photos.length > 0)
      .sort((left, right) => left.activityIndex - right.activityIndex);

    let uploadedCount = 0;
    let signaturesReset = false;

    for (const entry of queuedEntries) {
      for (const photo of entry.photos) {
        if (!tenantPageIsolation.isOperationCurrent(operation)) {
          return { uploadedCount, signaturesReset, stale: true };
        }
        const result = await rdosService.attachActivityPhoto(
          rdoId,
          entry.activityIndex,
          photo.file,
        );
        if (!tenantPageIsolation.isOperationCurrent(operation)) {
          return { uploadedCount, signaturesReset, stale: true };
        }
        uploadedCount += 1;
        signaturesReset = signaturesReset || result.signaturesReset;
      }
    }

    return { uploadedCount, signaturesReset, stale: false };
  };

  const handleSave = async (options?: { printAfterSave?: boolean }) => {
    const shouldPrintAfterSave = options?.printAfterSave ?? false;
    const validationMessage = validateRdoForm();
    if (validationMessage) {
      toast.error(validationMessage);
      return;
    }
    if (!activeCompanyId) return;
    const operation = tenantPageIsolation.beginOperation(
      `save:${editingId ?? "new"}`,
      activeCompanyId,
    );
    const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
    if (!isCurrent()) return;
    setSaving(true);
    const payload = {
      data: form.data,
      site_id: form.site_id || undefined,
      responsavel_id: form.responsavel_id || undefined,
      clima_manha: form.clima_manha || undefined,
      clima_tarde: form.clima_tarde || undefined,
      temperatura_min: form.temperatura_min
        ? Number(form.temperatura_min)
        : undefined,
      temperatura_max: form.temperatura_max
        ? Number(form.temperatura_max)
        : undefined,
      condicao_terreno: form.condicao_terreno.trim() || undefined,
      mao_de_obra: form.mao_de_obra.map((item) => {
        const payloadItem = stripRdoRowKey(item);
        return {
          ...payloadItem,
          funcao: payloadItem.funcao.trim(),
        };
      }),
      equipamentos: form.equipamentos.map((item) => {
        const payloadItem = stripRdoRowKey(item);
        return {
          ...payloadItem,
          nome: payloadItem.nome.trim(),
          observacao: payloadItem.observacao?.trim() || undefined,
        };
      }),
      materiais_recebidos: form.materiais_recebidos.map((item) => {
        const payloadItem = stripRdoRowKey(item);
        return {
          ...payloadItem,
          descricao: payloadItem.descricao.trim(),
          unidade: payloadItem.unidade.trim(),
          fornecedor: payloadItem.fornecedor?.trim() || undefined,
        };
      }),
      servicos_executados: form.servicos_executados.map((item) => {
        const payloadItem = stripRdoRowKey(item);
        return {
          ...payloadItem,
          descricao: payloadItem.descricao.trim(),
          observacao: payloadItem.observacao?.trim() || undefined,
          fotos: payloadItem.fotos ?? [],
        };
      }),
      ocorrencias: form.ocorrencias.map((item) => {
        const payloadItem = stripRdoRowKey(item);
        return {
          ...payloadItem,
          descricao: payloadItem.descricao.trim(),
          hora: payloadItem.hora?.trim() || undefined,
        };
      }),
      houve_acidente: form.houve_acidente,
      houve_paralisacao: form.houve_paralisacao,
      motivo_paralisacao: form.motivo_paralisacao.trim() || undefined,
      observacoes: form.observacoes.trim() || undefined,
      programa_servicos_amanha:
        form.programa_servicos_amanha.trim() || undefined,
    };
    try {
      let savedRdo: Rdo;
      if (editingId) {
        savedRdo = await rdosService.update(editingId, payload);
      } else {
        savedRdo = await rdosService.create(payload);
      }
      if (!isCurrent()) return;
      toast.success(editingId ? "RDO atualizado com sucesso!" : "RDO criado com sucesso!");

      try {
        const queuedUploadResult = await uploadQueuedActivityPhotos(
          savedRdo.id,
          operation,
        );
        if (!isCurrent() || queuedUploadResult.stale) return;
        if (queuedUploadResult.uploadedCount > 0) {
          savedRdo = await rdosService.findOne(savedRdo.id);
          if (!isCurrent()) return;
          if (queuedUploadResult.signaturesReset) {
            toast.warning(
              "RDO salvo e fotos anexadas, mas as assinaturas foram invalidadas pela mudança de conteúdo.",
            );
          } else {
            toast.success(
              `${queuedUploadResult.uploadedCount} foto(s) de atividade anexada(s) com governança.`,
            );
          }
        }
      } catch (uploadError) {
        if (!isCurrent()) return;
        logger.error(
          "Erro ao enviar fotos pendentes das atividades do RDO:",
          uploadError,
        );
        toast.warning(
          getApiErrorMessage(uploadError) ||
            "O RDO foi salvo, mas uma ou mais fotos da atividade não puderam ser enviadas.",
        );
      }

      if (!isCurrent()) return;
      closeEditorModal();
      try {
        await refreshRdoDashboard();
        if (!isCurrent()) return;
      } catch (refreshError) {
        if (!isCurrent()) return;
        logger.error("Erro ao atualizar a lista de RDOs após salvar:", refreshError);
        toast.warning(
          "RDO salvo, mas a atualização da lista falhou. Recarregue a tela para ver o conteúdo atualizado.",
        );
      }

      if (shouldPrintAfterSave && isCurrent()) {
        try {
          await handlePrintAfterSave(savedRdo, operation);
        } catch (printError) {
          if (!isCurrent()) return;
          logger.error(
            "Erro ao preparar impressão automática do RDO:",
            printError,
          );
          toast.warning(
            "RDO salvo, mas não foi possível abrir a impressão automática.",
          );
        }
      }
    } catch (error) {
      if (!isCurrent()) return;
      logger.error("Erro ao salvar RDO:", error);
      toast.error(getApiErrorMessage(error) || "Erro ao salvar RDO.");
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };

  const handleStatusChange = async (id: string, newStatus: string) => {
    if (!canManageRdo) {
      toast.error("Você não tem permissão para alterar o status do RDO.");
      return;
    }
    if (!activeCompanyId) return;
    const operation = tenantPageIsolation.beginOperation(
      `status:${id}`,
      activeCompanyId,
    );
    const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
    try {
      if (!isCurrent()) return;
      const updated = await rdosService.updateStatus(id, newStatus);
      if (!isCurrent()) return;
      setRdos((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...updated } : r)),
      );
      if (viewRdo?.id === id) {
        setViewRdo((v) => (v ? { ...v, ...updated } : v));
      }
      void refreshOverview().catch((error) => {
        if (isCurrent()) {
          logger.error("Erro ao atualizar overview após mudança de status:", error);
        }
      });
      toast.success(`Status atualizado para "${RDO_STATUS_LABEL[newStatus]}"`);
    } catch (error) {
      if (!isCurrent()) return;
      logger.error("Erro ao atualizar status:", error);
      toast.error(
        getApiErrorMessage(error) || "Erro ao atualizar status do RDO.",
      );
    }
  };

  const handleCancelRdo = (rdo: Rdo) => {
    if (!tenantPageIsolation.isActiveCompany(rdo.company_id)) return;
    if (!canManageRdo) {
      toast.error("Você não tem permissão para cancelar RDOs.");
      return;
    }
    if (rdo.status === "cancelado") {
      toast.error("Este RDO já está cancelado.");
      return;
    }
    if (rdo.pdf_file_key) {
      toast.error("RDO com PDF final emitido não pode ser cancelado.");
      return;
    }
    setCancelTarget(rdo);
    setCancelReason("");
  };

  const confirmCancelRdo = async () => {
    if (!cancelTarget || !cancelReason.trim() || !activeCompanyId) return;
    const rdo = cancelTarget;
    setCancelTarget(null);
    setCancelReason("");
    setIsCancelling(true);
    const operation = tenantPageIsolation.beginOperation(
      `cancel:${rdo.id}`,
      activeCompanyId,
    );
    const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
    try {
      if (!isCurrent()) return;
      const updated = await rdosService.cancel(rdo.id, cancelReason.trim());
      if (!isCurrent()) return;
      setRdos((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (viewRdo?.id === updated.id) {
        setViewRdo(updated);
      }
      void refreshOverview();
      toast.success("RDO cancelado com sucesso.");
    } catch (error) {
      if (!isCurrent()) return;
      logger.error("Erro ao cancelar RDO:", error);
      toast.error(
        getApiErrorMessage(error) || "Não foi possível cancelar o RDO.",
      );
    } finally {
      setIsCancelling(false);
    }
  };

  const handleDelete = (id: string) => {
    if (!canManageRdo) {
      toast.error("Você não tem permissão para excluir RDOs.");
      return;
    }
    setDeleteConfirmId(id);
  };

  const confirmDelete = async () => {
    if (!deleteConfirmId || !activeCompanyId) return;
    const id = deleteConfirmId;
    setDeleteConfirmId(null);
    const operation = tenantPageIsolation.beginOperation(
      `delete:${id}`,
      activeCompanyId,
    );
    const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
    try {
      if (!isCurrent()) return;
      await rdosService.delete(id);
      if (!isCurrent()) return;
      toast.success("RDO excluído.");
      await refreshRdoDashboard();
    } catch (error) {
      if (!isCurrent()) return;
      logger.error("Erro ao excluir RDO:", error);
      toast.error("Erro ao excluir RDO.");
    }
  };

  // Helpers para arrays do formulário
  const addMaoDeObra = () =>
    setForm((f) => ({
      ...f,
      mao_de_obra: [
        ...f.mao_de_obra,
        withRdoRowKey({
          funcao: "",
          quantidade: 1,
          turno: "manha",
          horas: 8,
        }),
      ],
    }));
  const removeMaoDeObra = (i: number) =>
    setForm((f) => ({
      ...f,
      mao_de_obra: f.mao_de_obra.filter((_, idx) => idx !== i),
    }));
  const updateMaoDeObra = (
    i: number,
    field: keyof MaoDeObraItem,
    value: string | number,
  ) =>
    setForm((f) => {
      const arr = [...f.mao_de_obra];
      arr[i] = { ...arr[i], [field]: value } as RdoMaoDeObraItem;
      return { ...f, mao_de_obra: arr };
    });

  const addEquipamento = () =>
    setForm((f) => ({
      ...f,
      equipamentos: [
        ...f.equipamentos,
        withRdoRowKey({
          nome: "",
          quantidade: 1,
          horas_trabalhadas: 0,
          horas_ociosas: 0,
        }),
      ],
    }));
  const removeEquipamento = (i: number) =>
    setForm((f) => ({
      ...f,
      equipamentos: f.equipamentos.filter((_, idx) => idx !== i),
    }));
  const updateEquipamento = (
    i: number,
    field: keyof EquipamentoItem,
    value: string | number,
  ) =>
    setForm((f) => {
      const arr = [...f.equipamentos];
      arr[i] = { ...arr[i], [field]: value } as RdoEquipamentoItem;
      return { ...f, equipamentos: arr };
    });

  const addMaterial = () =>
    setForm((f) => ({
      ...f,
      materiais_recebidos: [
        ...f.materiais_recebidos,
        withRdoRowKey({
          descricao: "",
          unidade: "un",
          quantidade: 0,
        }),
      ],
    }));
  const removeMaterial = (i: number) =>
    setForm((f) => ({
      ...f,
      materiais_recebidos: f.materiais_recebidos.filter((_, idx) => idx !== i),
    }));
  const updateMaterial = (
    i: number,
    field: keyof MaterialItem,
    value: string | number,
  ) =>
    setForm((f) => {
      const arr = [...f.materiais_recebidos];
      arr[i] = { ...arr[i], [field]: value } as RdoMaterialItem;
      return { ...f, materiais_recebidos: arr };
    });

  const addServico = () =>
    setForm((f) => ({
      ...f,
      servicos_executados: [
        ...f.servicos_executados,
        withRdoRowKey({
          descricao: "",
          percentual_concluido: 0,
          observacao: "",
          fotos: [],
        }),
      ],
    }));
  const removeServico = (i: number) => {
    setForm((f) => ({
      ...f,
      servicos_executados: f.servicos_executados.filter((_, idx) => idx !== i),
    }));
    setPendingActivityPhotos((current) => {
      const next: Record<number, PendingActivityPhoto[]> = {};
      Object.entries(current).forEach(([rawIndex, photos]) => {
        const currentIndex = Number(rawIndex);
        if (currentIndex === i) {
          photos.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
          return;
        }

        next[currentIndex > i ? currentIndex - 1 : currentIndex] = photos;
      });
      return next;
    });
  };
  const updateServico = (
    i: number,
    field: keyof ServicoItem,
    value: string | number | string[],
  ) =>
    setForm((f) => {
      const arr = [...f.servicos_executados];
      arr[i] = { ...arr[i], [field]: value } as RdoServicoItem;
      return { ...f, servicos_executados: arr };
    });

  const resolveActivityPhotoSrc = useCallback(
    (photo: string) => {
      const resolvedPhoto = isGovernedActivityPhotoReference(photo)
        ? resolvedActivityPhotoUrls[photo] || ""
        : photo;

      return isSafeImagePreviewUrl(resolvedPhoto) ? resolvedPhoto : "";
    },
    [resolvedActivityPhotoUrls],
  );

  const getPendingActivityPhotos = useCallback(
    (activityIndex: number) => pendingActivityPhotos[activityIndex] ?? [],
    [pendingActivityPhotos],
  );

  const handleAddActivityPhotos = async (
    activityIndex: number,
    files: FileList | null,
  ) => {
    const selectedFiles = Array.from(files ?? []);
    if (!selectedFiles.length) {
      return;
    }

    if (editingId) {
      if (!activeCompanyId) return;
      const documentId = editingId;
      const operation = tenantPageIsolation.beginOperation(
        `upload:${documentId}:${activityIndex}`,
        activeCompanyId,
      );
      const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
      try {
        const uploaded: Array<{
          photoReference: string;
          signaturesReset: boolean;
        }> = [];

        for (const file of selectedFiles) {
          if (!isCurrent()) return;
          const result = await rdosService.attachActivityPhoto(
            documentId,
            activityIndex,
            file,
          );
          if (!isCurrent()) return;
          uploaded.push(result);
        }

        if (!isCurrent()) return;
        const appendedReferences = uploaded.map((entry) => entry.photoReference);
        setForm((current) => {
          const nextActivities = [...current.servicos_executados];
          const currentActivity = nextActivities[activityIndex];
          if (!currentActivity) {
            return current;
          }

          nextActivities[activityIndex] = {
            ...currentActivity,
            fotos: [...(currentActivity.fotos ?? []), ...appendedReferences],
          };

          return { ...current, servicos_executados: nextActivities };
        });

        const refreshedRdo = await rdosService.findOne(documentId);
        if (!isCurrent()) return;
        setRdos((current) =>
          current.map((item) =>
            item.id === refreshedRdo.id ? refreshedRdo : item,
          ),
        );
        if (viewRdo?.id === refreshedRdo.id) {
          setViewRdo(refreshedRdo);
        }

        if (uploaded.some((entry) => entry.signaturesReset)) {
          toast.warning(
            "As assinaturas do RDO foram invalidadas porque o conteúdo da atividade foi alterado.",
          );
        } else {
          toast.success("Foto(s) da atividade anexada(s) ao RDO.");
        }
      } catch (error) {
        if (!isCurrent()) return;
        logger.error("Erro ao anexar fotos da atividade do RDO:", error);
        toast.error(
          getApiErrorMessage(error) ||
            "Não foi possível anexar as fotos da atividade.",
        );
      }
      return;
    }

    const nextPendingPhotos = selectedFiles.map((file) => ({
      file,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
    }));

    setPendingActivityPhotos((current) => {
      const existing = current[activityIndex] ?? [];
      return {
        ...current,
        [activityIndex]: [...existing, ...nextPendingPhotos],
      };
    });
    toast.info(
      "As fotos da atividade serão enviadas ao storage governado após salvar o RDO.",
    );
  };

  const handleRemoveActivityPhoto = async (
    activityIndex: number,
    photoIndex: number,
    photo: string,
  ) => {
    if (!isGovernedActivityPhotoReference(photo)) {
      setPendingActivityPhotos((current) => {
        const currentPhotos = current[activityIndex] ?? [];
        const photoToRemove = currentPhotos[photoIndex];
        if (photoToRemove) {
          URL.revokeObjectURL(photoToRemove.previewUrl);
        }

        const nextActivityPhotos = currentPhotos.filter(
          (_, currentIndex) => currentIndex !== photoIndex,
        );
        return {
          ...current,
          [activityIndex]: nextActivityPhotos,
        };
      });
      return;
    }

    if (!editingId || !activeCompanyId) {
      return;
    }
    const documentId = editingId;
    const operation = tenantPageIsolation.beginOperation(
      `remove-photo:${documentId}:${activityIndex}`,
      activeCompanyId,
    );
    const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);

    try {
      if (!isCurrent()) return;
      const result = await rdosService.removeActivityPhoto(
        documentId,
        activityIndex,
        photoIndex,
      );
      if (!isCurrent()) return;
      setForm((current) => {
        const nextActivities = [...current.servicos_executados];
        const currentActivity = nextActivities[activityIndex];
        if (!currentActivity) {
          return current;
        }

        nextActivities[activityIndex] = {
          ...currentActivity,
          fotos: (currentActivity.fotos ?? []).filter(
            (_, currentIndex) => currentIndex !== photoIndex,
          ),
        };

        return { ...current, servicos_executados: nextActivities };
      });
      setResolvedActivityPhotoUrls((current) => {
        const next = { ...current };
        delete next[photo];
        return next;
      });

      const refreshedRdo = await rdosService.findOne(documentId);
      if (!isCurrent()) return;
      setRdos((current) =>
        current.map((item) =>
          item.id === refreshedRdo.id ? refreshedRdo : item,
        ),
      );
      if (viewRdo?.id === refreshedRdo.id) {
        setViewRdo(refreshedRdo);
      }

      if (result.signaturesReset) {
        toast.warning(
          "Foto removida. As assinaturas do RDO foram invalidadas pela alteração do conteúdo.",
        );
      } else {
        toast.success("Foto da atividade removida.");
      }
    } catch (error) {
      if (!isCurrent()) return;
      logger.error("Erro ao remover foto da atividade do RDO:", error);
      toast.error(
        getApiErrorMessage(error) ||
          "Não foi possível remover a foto da atividade.",
      );
    }
  };

  const addOcorrencia = () =>
    setForm((f) => ({
      ...f,
      ocorrencias: [
        ...f.ocorrencias,
        withRdoRowKey({ tipo: "outro", descricao: "" }),
      ],
    }));
  const removeOcorrencia = (i: number) =>
    setForm((f) => ({
      ...f,
      ocorrencias: f.ocorrencias.filter((_, idx) => idx !== i),
    }));
  const updateOcorrencia = (
    i: number,
    field: keyof OcorrenciaItem,
    value: string,
  ) =>
    setForm((f) => {
      const arr = [...f.ocorrencias];
      arr[i] = { ...arr[i], [field]: value } as RdoOcorrenciaItem;
      return { ...f, ocorrencias: arr };
    });

  const printGeneratedRdoPdf = useCallback(
    async (
      fullRdo: Rdo,
      draftWatermark: boolean,
      operation: RdoTenantOperation,
    ) => {
      const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
      if (!isCurrent()) return;
      const { generateRdoPdf } = await loadRdoPdfGenerator();
      if (!isCurrent()) return;
      const result = (await generateRdoPdf(fullRdo, {
        save: false,
        output: "base64",
        draftWatermark,
      })) as { base64: string } | undefined;
      if (!isCurrent()) return;

      if (!result?.base64) {
        throw new Error("Falha ao gerar o PDF do RDO para impressão.");
      }

      const fileURL = URL.createObjectURL(base64ToPdfBlob(result.base64));
      openPdfForPrint(fileURL, () => {
        if (isCurrent()) {
          toast.info(
            "Pop-up bloqueado. Permita pop-ups para imprimir o PDF final do RDO.",
          );
        }
      });
      setTimeout(() => URL.revokeObjectURL(fileURL), 60_000);
    },
    [tenantPageIsolation],
  );

  const handlePrint = (rdo: Rdo) => {
    if (!activeCompanyId || !tenantPageIsolation.isActiveCompany(rdo.company_id)) {
      return;
    }
    const operation = tenantPageIsolation.beginOperation(
      `print:${rdo.id}`,
      activeCompanyId,
    );
    const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
    void (async () => {
      try {
        if (!isCurrent()) return;
        const shouldUseGovernedPdf =
          Boolean(rdo.pdf_file_key) || rdo.status === "aprovado";

        if (shouldUseGovernedPdf) {
          const access =
            canManageRdo && !rdo.pdf_file_key
              ? await ensureGovernedPdf(rdo, operation)
              : await getGovernedPdfAccess(rdo.id, operation);
          if (!isCurrent()) return;
          if (access?.hasFinalPdf && access.url) {
            openPdfForPrint(access.url, () => {
              if (isCurrent()) {
                toast.info(
                  "Pop-up bloqueado. Permita pop-ups para imprimir o PDF final do RDO.",
                );
              }
            });
            return;
          }

          if (access?.hasFinalPdf) {
            toast.warning(
              access.message ||
                "O PDF final do RDO foi emitido, mas a URL segura não está disponível agora. Abrimos o download oficial do arquivo para impressão.",
            );
            const officialBlob = await rdosService.downloadPdf(rdo.id);
            if (!isCurrent()) return;
            const fileURL = URL.createObjectURL(officialBlob);
            openPdfForPrint(fileURL, () => {
              if (isCurrent()) {
                toast.info(
                  "Pop-up bloqueado. Permita pop-ups para imprimir o PDF final do RDO.",
                );
              }
            });
            setTimeout(() => URL.revokeObjectURL(fileURL), 60_000);
            return;
          }

          throw new Error(
            "O RDO aprovado precisa do PDF final governado antes da impressão.",
          );
        }

        const fullRdo = await rdosService.findOne(rdo.id);
        if (!isCurrent()) return;
        await printGeneratedRdoPdf(fullRdo, true, operation);
      } catch (error) {
        if (!isCurrent()) return;
        logger.error("Erro ao imprimir RDO:", error);
        toast.error("Não foi possível preparar a impressão do RDO.");
      }
    })();
  };

  const handleOpenGovernedPdf = useCallback(
    async (rdo: Rdo) => {
      if (
        !activeCompanyId ||
        !tenantPageIsolation.isActiveCompany(rdo.company_id)
      ) {
        return;
      }
      const operation = tenantPageIsolation.beginOperation(
        `open-pdf:${rdo.id}`,
        activeCompanyId,
      );
      const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
      try {
        if (!isCurrent()) return;
        toast.info("Preparando PDF final governado...");
        if (!canManageRdo && !rdo.pdf_file_key) {
          toast.error(
            "Você não tem permissão para emitir o PDF final deste RDO.",
          );
          return;
        }

        const access =
          canManageRdo && !rdo.pdf_file_key
            ? await ensureGovernedPdf(rdo, operation)
            : await getGovernedPdfAccess(rdo.id, operation);
        if (!isCurrent()) return;
        if (!access) {
          toast.error(
            "O RDO precisa estar aprovado e assinado pelo responsável e engenheiro antes da emissão final.",
          );
          return;
        }

        if (!access.hasFinalPdf) {
          toast.error(
            "O RDO ainda não possui PDF final governado disponível.",
          );
          return;
        }

        if (!access.url) {
          toast.warning(
            access.message ||
              "PDF final emitido, mas a URL segura não está disponível no momento. Abrimos o download oficial do arquivo.",
          );
          const officialBlob = await rdosService.downloadPdf(rdo.id);
          if (!isCurrent()) return;
          const fileUrl = URL.createObjectURL(officialBlob);
          const openedWindow = window.open(
            fileUrl,
            "_blank",
            "noopener,noreferrer",
          );
          if (!openedWindow) {
            toast.error(
              "Não foi possível abrir o PDF final em uma nova janela. Permita pop-ups para continuar.",
            );
            URL.revokeObjectURL(fileUrl);
            return;
          }
          setTimeout(() => URL.revokeObjectURL(fileUrl), 60_000);
          return;
        }

        const opened = openSafeExternalUrlInNewTab(access.url, () => {
          if (isCurrent()) {
            toast.error(
              "Não foi possível abrir o PDF final em uma nova janela. Permita pop-ups para continuar.",
            );
          }
        });
        if (!opened) {
          return;
        }
      } catch (error) {
        if (!isCurrent()) return;
        logger.error("Erro ao emitir/abrir PDF final do RDO:", error);
        toast.error("Não foi possível emitir ou abrir o PDF final do RDO.");
      }
    },
    [
      activeCompanyId,
      canManageRdo,
      ensureGovernedPdf,
      getGovernedPdfAccess,
      tenantPageIsolation,
    ],
  );

  const handleSign = async () => {
    if (!signModal) return;
    if (!tenantPageIsolation.isActiveCompany(signModal.rdo.company_id)) return;
    if (!canManageRdo) {
      toast.error("Você não tem permissão para assinar RDOs.");
      return;
    }
    if (signModal.rdo.status === "rascunho") {
      toast.error("Envie o RDO para revisão antes de coletar assinaturas.");
      return;
    }
    const cpfDigits = signForm.cpf.replace(/\D/g, "");
    if (!signForm.nome || cpfDigits.length !== 11) {
      toast.error("Preencha nome e CPF.");
      return;
    }
    const normalizedCpf = cpfDigits.replace(
      /^(\d{3})(\d{3})(\d{3})(\d{2})$/,
      "$1.$2.$3-$4",
    );
    if (!activeCompanyId) return;
    const signingRdoId = signModal.rdo.id;
    const signingType = signModal.tipo;
    const operation = tenantPageIsolation.beginOperation(
      `sign:${signingRdoId}:${signingType}`,
      activeCompanyId,
    );
    const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
    if (!isCurrent()) return;
    setSigning(true);
    try {
      const updated = await rdosService.sign(signingRdoId, {
        tipo: signingType,
        nome: signForm.nome,
        cpf: normalizedCpf,
      });
      if (!isCurrent()) return;
      setRdos((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      if (viewRdo?.id === updated.id) setViewRdo(updated);
      toast.success("RDO assinado com sucesso!");
      setSignModal(null);
      setSignForm({ nome: "", cpf: "", tipo: "responsavel" });
    } catch {
      if (!isCurrent()) return;
      toast.error("Erro ao assinar RDO.");
    } finally {
      if (isCurrent()) setSigning(false);
    }
  };

  const handleSendEmail = async () => {
    if (!emailModal) return;
    if (!tenantPageIsolation.isActiveCompany(emailModal.company_id)) return;
    if (!canManageRdo) {
      toast.error("Você não tem permissão para enviar RDOs por e-mail.");
      return;
    }
    const emails = emailTo
      .split(/[,;\s]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (emails.length === 0) {
      toast.error("Informe pelo menos um e-mail.");
      return;
    }
    if (!activeCompanyId) return;
    const emailRdoId = emailModal.id;
    const operation = tenantPageIsolation.beginOperation(
      `email:${emailRdoId}`,
      activeCompanyId,
    );
    const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
    if (!isCurrent()) return;
    setSendingEmail(true);
    try {
      const access = await rdosService.getPdfAccess(emailRdoId);
      if (!isCurrent()) return;
      if (!access.hasFinalPdf) {
        toast.info(
          access.message ||
            "Emita o PDF final governado antes de enviar este RDO por e-mail.",
        );
        return;
      }

      if (access.message) {
        toast.info(
          `${access.message} O envio oficial continuará usando o PDF final governado do RDO.`,
        );
      }

      if (!isCurrent()) return;
      const result = await rdosService.sendEmail(emailRdoId, emails);
      if (!isCurrent()) return;
      toast.success(result.message);
      setEmailModal(null);
      setEmailTo("");
    } catch (error) {
      if (!isCurrent()) return;
      toast.error(getApiErrorMessage(error) || "Erro ao enviar e-mail.");
    } finally {
      if (isCurrent()) setSendingEmail(false);
    }
  };

  const handleExportExcel = async () => {
    if (!activeCompanyId) return;
    const operation = tenantPageIsolation.beginOperation(
      "export:excel",
      activeCompanyId,
    );
    const isCurrent = () => tenantPageIsolation.isOperationCurrent(operation);
    try {
      await exportCurrentRdoExcel({
        url: "/rdos/export/excel",
        filename: "rdos.xlsx",
        isCurrent,
      });
    } catch (error) {
      if (!isCurrent()) return;
      logger.error("Erro ao exportar RDOs para Excel:", error);
      toast.error("Não foi possível exportar os RDOs para Excel.");
    }
  };

  const filteredRdos = rdos;

  const totalTrabalhadores = (rdo: Rdo) =>
    (rdo.mao_de_obra ?? []).reduce((sum, m) => sum + (m.quantidade ?? 0), 0);

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar RDOs"
        description={loadError}
        action={
          <Button type="button" onClick={refreshRdoDashboard}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <>
      <ListPageLayout
        eyebrow="Diário de obra"
        title="Relatórios Diários de Obras"
        description="Controle produção diária, clima, mão de obra, ocorrências e status do canteiro."
        icon={<ClipboardList className="h-5 w-5" />}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              data-offline-action="read"
              leftIcon={<FileSpreadsheet className="h-4 w-4" />}
              onClick={() => void handleExportExcel()}
            >
              Exportar Excel
            </Button>
            {canManageRdo ? (
              <Button
                type="button"
                data-offline-action="write"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={handleOpenCreate}
              >
                Novo RDO
              </Button>
            ) : null}
          </div>
        }
        metrics={[
          {
            label: "Total de RDOs",
            value: summary.total,
            note: "Registros visíveis no recorte atual.",
          },
          {
            label: "Rascunhos",
            value: summary.rascunho,
            note: "Pendentes de envio ou revisão final.",
            tone: "warning",
          },
          {
            label: "Enviados",
            value: summary.enviado,
            note: "Aguardando leitura e decisão.",
            tone: "primary",
          },
          {
            label: "Aprovados",
            value: summary.aprovado,
            note: "Com ciclo operacional concluído.",
            tone: "success",
          },
          {
            label: "Cancelados",
            value: summary.cancelado,
            note: "Registros encerrados sem emissão.",
            tone: "danger",
          },
        ]}
        toolbarTitle="Base de RDOs"
        toolbarDescription={`${total} registro(s) no recorte atual com filtros por status, obra e período.`}
        toolbarContent={
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-secondary)]" />
              <input
                type="text"
                placeholder="Buscar número, obra ou responsável..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className={cn(inputClassName, "w-full pl-9")}
              />
            </div>
            <select
              aria-label="Filtrar por status"
              value={filterStatus}
              onChange={(e) => {
                setFilterStatus(e.target.value);
                setPage(1);
              }}
              className={cn(inputClassName, "w-full")}
            >
              <option value="">Todos os status</option>
              <option value="rascunho">Rascunho</option>
              <option value="enviado">Enviado</option>
              <option value="aprovado">Aprovado</option>
              <option value="cancelado">Cancelado</option>
            </select>
            <select
              aria-label="Filtrar por obra"
              value={filterSiteId}
              onChange={(e) => {
                setFilterSiteId(e.target.value);
                setPage(1);
              }}
              className={cn(inputClassName, "w-full")}
            >
              <option value="">Todas as obras</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nome}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={filterDataInicio}
              onChange={(e) => {
                setFilterDataInicio(e.target.value);
                setPage(1);
              }}
              className={cn(inputClassName, "w-full")}
              title="Data início"
            />
            <input
              type="date"
              value={filterDataFim}
              onChange={(e) => {
                setFilterDataFim(e.target.value);
                setPage(1);
              }}
              className={cn(inputClassName, "w-full")}
              title="Data fim"
            />
          </div>
        }
        footer={
          filteredRdos.length > 0 ? (
            <PaginationControls
              page={page}
              lastPage={lastPage}
              total={total}
              onPrev={handlePrevPage}
              onNext={handleNextPage}
            />
          ) : null
        }
      >
        <div className="space-y-4">
          {summary.rascunho > 0 ? (
            <InlineCallout
              tone="warning"
              icon={<AlertTriangle className="h-4 w-4" />}
              title="Há RDOs pendentes de envio"
              description={`${summary.rascunho} relatório(s) ainda estão em rascunho. Feche o ciclo diário e encaminhe para aprovação.`}
            />
          ) : null}

          {loading ? (
            <InlineLoadingState label="Atualizando RDOs..." />
          ) : null}

          {loading && filteredRdos.length === 0 ? null : filteredRdos.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="Nenhum RDO encontrado"
                description={
                  deferredSearch
                    ? "Nenhum resultado corresponde ao filtro aplicado."
                    : "Ainda não existem RDOs registrados para este tenant."
                }
                action={
                  !deferredSearch && canManageRdo ? (
                    <button
                      type="button"
                      onClick={handleOpenCreate}
                      className={cn(
                        buttonVariants(),
                        "inline-flex items-center",
                      )}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Novo RDO
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <ResponsiveDataList
              items={filteredRdos}
              getKey={(rdo) => rdo.id}
              mobileClassName="grid min-w-0 gap-3 p-3"
              desktop={() => (
            <Table className="min-w-[980px]" aria-label="RDOs em tabela">
              <TableHeader>
                <TableRow>
                  <TableHead>Número</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead>Obra/Setor</TableHead>
                  <TableHead>Responsável</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Trabalhadores</TableHead>
                  <TableHead>Acidente</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRdos.map((rdo) => {
                  const statusTransitions = getAllowedStatusTransitions(rdo);
                  return (
                    <TableRow key={rdo.id}>
                      <TableCell className="font-mono text-sm font-medium text-[var(--ds-color-action-primary)]">
                        {rdo.numero}
                      </TableCell>
                      <TableCell className="text-sm">
                        {safeToLocaleDateString(
                          rdo.data,
                          "pt-BR",
                          undefined,
                          "—",
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {rdo.site?.nome ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {rdo.responsavel?.nome ?? "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${RDO_STATUS_COLORS[rdo.status] ?? "border-[color:var(--ds-color-text-secondary)]/30 bg-[color:var(--ds-color-text-secondary)]/12 text-[var(--ds-color-text-secondary)]"}`}
                          >
                            {RDO_STATUS_LABEL[rdo.status] ?? rdo.status}
                          </span>
                          {canManageRdo && statusTransitions.length > 0 && (
                            <select
                              aria-label="Mover status do RDO"
                              value=""
                              onChange={(e) => {
                                if (e.target.value)
                                  handleStatusChange(rdo.id, e.target.value);
                              }}
                              className="rounded border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-1 py-0.5 text-xs text-[var(--ds-color-text-secondary)]"
                            >
                              <option value="">Mover para...</option>
                              {statusTransitions.map((s) => (
                                <option key={s} value={s}>
                                  {RDO_STATUS_LABEL[s]}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {totalTrabalhadores(rdo) > 0 ? (
                          <span className="font-medium">
                            {totalTrabalhadores(rdo)}
                          </span>
                        ) : (
                          <span className="text-[var(--ds-color-text-secondary)]">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {rdo.houve_acidente ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--ds-color-danger)]/10 px-2 py-0.5 text-xs font-medium text-[var(--ds-color-danger)]">
                            <AlertTriangle className="h-3 w-3" /> Sim
                          </span>
                        ) : (
                          <span className="text-xs text-[var(--ds-color-text-secondary)]">
                            Não
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            data-offline-action="read"
                            onClick={() => {
                              if (
                                tenantPageIsolation.isActiveCompany(
                                  rdo.company_id,
                                )
                              ) {
                                setViewRdo(rdo);
                              }
                            }}
                            title="Visualizar"
                            aria-label={`Visualizar RDO ${rdo.numero}`}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          {canManageRdo ? (
                            <>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                data-offline-action="write"
                                onClick={() => handleOpenEdit(rdo)}
                                className={cn(
                                  "",
                                  (rdo.pdf_file_key ||
                                    rdo.status === "cancelado") &&
                                    "opacity-40",
                                )}
                                aria-label={`Editar RDO ${rdo.numero}`}
                                title={
                                  rdo.status === "cancelado"
                                    ? "RDO cancelado: edição bloqueada"
                                    : rdo.pdf_file_key
                                      ? "RDO com PDF final: edição bloqueada"
                                      : "Editar"
                                }
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                data-offline-action="write"
                                onClick={() => {
                                  if (
                                    rdo.status === "aprovado" ||
                                    rdo.status === "cancelado"
                                  ) {
                                    toast.error(
                                      "RDO aprovado ou cancelado não pode ser excluído.",
                                    );
                                    return;
                                  }
                                  handleDelete(rdo.id);
                                }}
                                className={cn(
                                  "text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]",
                                  (rdo.status === "aprovado" ||
                                    rdo.status === "cancelado") &&
                                    "opacity-40",
                                )}
                                aria-label={`Excluir RDO ${rdo.numero}`}
                                title={
                                  rdo.status === "aprovado" ||
                                  rdo.status === "cancelado"
                                    ? "RDO aprovado ou cancelado não pode ser excluído"
                                    : "Excluir"
                                }
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
              )}
              mobile={(rdo) => {
                const statusTransitions = getAllowedStatusTransitions(rdo);
                const deletionBlocked = rdo.status === "aprovado" || rdo.status === "cancelado";
                const editBlocked = Boolean(rdo.pdf_file_key) || rdo.status === "cancelado";
                return (
                  <article className="min-w-0 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 shadow-sm" aria-label={`RDO ${rdo.numero}`}>
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-sm font-semibold text-[var(--ds-color-action-primary)]">{rdo.numero}</p>
                        <h3 className="mt-1 truncate font-semibold text-[var(--ds-color-text-primary)]">{rdo.site?.nome ?? "Obra não informada"}</h3>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${RDO_STATUS_COLORS[rdo.status] ?? "border-[color:var(--ds-color-text-secondary)]/30 bg-[color:var(--ds-color-text-secondary)]/12 text-[var(--ds-color-text-secondary)]"}`}>
                        {RDO_STATUS_LABEL[rdo.status] ?? rdo.status}
                      </span>
                    </div>
                    <dl className="mt-4 grid min-w-0 grid-cols-2 gap-3 text-sm">
                      <div><dt className="text-xs text-[var(--ds-color-text-secondary)]">Data</dt><dd>{safeToLocaleDateString(rdo.data, "pt-BR", undefined, "—")}</dd></div>
                      <div className="min-w-0"><dt className="text-xs text-[var(--ds-color-text-secondary)]">Responsável</dt><dd className="truncate">{rdo.responsavel?.nome ?? "—"}</dd></div>
                      <div><dt className="text-xs text-[var(--ds-color-text-secondary)]">Trabalhadores</dt><dd>{totalTrabalhadores(rdo) || "—"}</dd></div>
                      <div><dt className="text-xs text-[var(--ds-color-text-secondary)]">Acidente</dt><dd className={rdo.houve_acidente ? "font-medium text-[var(--ds-color-danger)]" : ""}>{rdo.houve_acidente ? "Sim" : "Não"}</dd></div>
                    </dl>
                    {canManageRdo && statusTransitions.length > 0 ? (
                      <select aria-label={`Mover status do RDO ${rdo.numero}`} value="" onChange={(event) => event.target.value && handleStatusChange(rdo.id, event.target.value)} className="mt-4 min-h-11 w-full rounded-md border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 text-sm">
                        <option value="">Mover para...</option>
                        {statusTransitions.map((status) => <option key={status} value={status}>{RDO_STATUS_LABEL[status]}</option>)}
                      </select>
                    ) : null}
                    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label={`Ações do RDO ${rdo.numero}`}>
                      <Button type="button" variant="outline" className="min-h-11" data-offline-action="read" onClick={() => tenantPageIsolation.isActiveCompany(rdo.company_id) && setViewRdo(rdo)}><Eye className="h-4 w-4" /> Visualizar</Button>
                      {canManageRdo ? <Button type="button" variant="outline" className="min-h-11" data-offline-action="write" disabled={editBlocked} onClick={() => handleOpenEdit(rdo)}><Pencil className="h-4 w-4" /> Editar</Button> : null}
                      {canManageRdo ? <Button type="button" variant="outline" className="min-h-11 text-[var(--ds-color-danger)]" data-offline-action="write" disabled={deletionBlocked} onClick={() => handleDelete(rdo.id)}><Trash2 className="h-4 w-4" /> Excluir</Button> : null}
                    </div>
                  </article>
                );
              }}
            />
          )}
        </div>
      </ListPageLayout>

      <StoredFilesPanel
        title="Storage semanal de RDO"
        description="Acompanhe os PDFs finais governados dos RDOs emitidos por semana e baixe o pacote consolidado quando precisar."
        listStoredFiles={rdosService.listFiles}
        getPdfAccess={rdosService.getPdfAccess}
        downloadWeeklyBundle={rdosService.downloadWeeklyBundle}
      />

      <RdoEditorModal
        open={showModal}
        editingId={editingId}
        currentStep={currentStep}
        steps={STEPS}
        form={form}
        setForm={setForm}
        sites={sites}
        users={users}
        saving={saving}
        formInputClassName={formInputClassName}
        formInputSmClassName={formInputSmClassName}
        onClose={closeEditorModal}
        onSave={handleSave}
        setCurrentStep={setCurrentStep}
        addMaoDeObra={addMaoDeObra}
        removeMaoDeObra={removeMaoDeObra}
        updateMaoDeObra={updateMaoDeObra}
        addEquipamento={addEquipamento}
        removeEquipamento={removeEquipamento}
        updateEquipamento={updateEquipamento}
        addMaterial={addMaterial}
        removeMaterial={removeMaterial}
        updateMaterial={updateMaterial}
        addServico={addServico}
        removeServico={removeServico}
        updateServico={updateServico}
        addOcorrencia={addOcorrencia}
        removeOcorrencia={removeOcorrencia}
        updateOcorrencia={updateOcorrencia}
        getPendingActivityPhotos={getPendingActivityPhotos}
        onAddActivityPhotos={handleAddActivityPhotos}
        onRemoveActivityPhoto={handleRemoveActivityPhoto}
        resolveActivityPhotoSrc={resolveActivityPhotoSrc}
      />

      <RdoViewerModal
        open={Boolean(viewRdo)}
        viewRdo={viewRdo}
        canManageRdo={canManageRdo}
        viewRdoLocked={viewRdoLocked}
        viewRdoLockMessage={viewRdoLockMessage}
        viewRdoVideos={viewRdoVideos}
        getAllowedStatusTransitions={getAllowedStatusTransitions}
        resolveActivityPhotoSrc={resolveActivityPhotoSrc}
        onClose={() => setViewRdo(null)}
        onEdit={(rdo) => {
          setViewRdo(null);
          handleOpenEdit(rdo);
        }}
        onPrint={handlePrint}
        onOpenGovernedPdf={handleOpenGovernedPdf}
        onCancelRdo={handleCancelRdo}
        onOpenSign={(rdo) => {
          if (rdo.pdf_file_key) {
            toast.error(
              "RDO com PDF final emitido esta bloqueado para novas assinaturas.",
            );
            return;
          }
          if (rdo.status === "rascunho") {
            toast.error(
              "Envie o RDO para revisão antes de coletar assinaturas.",
            );
            return;
          }
          if (rdo.status === "cancelado") {
            toast.error("RDO cancelado não pode ser assinado.");
            return;
          }
          setSignModal({ rdo, tipo: "responsavel" });
          setSignForm({ nome: "", cpf: "", tipo: "responsavel" });
        }}
        onOpenEmail={(rdo) => {
          setEmailModal(rdo);
          setEmailTo("");
        }}
        onChangeStatus={handleStatusChange}
      />

      <RdoActionModals
        signModal={signModal}
        setSignModal={setSignModal}
        signForm={signForm}
        setSignForm={setSignForm}
        signing={signing}
        onSign={handleSign}
        emailModal={emailModal}
        setEmailModal={setEmailModal}
        emailTo={emailTo}
        setEmailTo={setEmailTo}
        sendingEmail={sendingEmail}
        onSendEmail={handleSendEmail}
        formInputClassName={formInputClassName}
      />

      {deleteConfirmId && (
        <div
          ref={deleteDialogRef}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rdo-delete-title"
          aria-describedby="rdo-delete-desc"
        >
          <div className="w-full max-w-sm rounded-2xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-lg)]">
            <div className="flex items-center justify-between border-b border-[var(--ds-color-border-subtle)] px-5 py-4">
              <h2 id="rdo-delete-title" className="text-base font-semibold text-[var(--ds-color-text-primary)]">
                Excluir RDO
              </h2>
              <button
                type="button"
                aria-label="Fechar"
                onClick={() => setDeleteConfirmId(null)}
                className="rounded-lg p-1.5 text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)]"
              >
                <span aria-hidden="true" className="text-lg leading-none">×</span>
              </button>
            </div>
            <div className="p-5">
              <p id="rdo-delete-desc" className="text-sm text-[var(--ds-color-text-primary)]">
                Tem certeza que deseja excluir este RDO?
              </p>
              <p className="mt-2 text-sm font-semibold text-[var(--ds-color-danger)]">
                Esta ação é irreversível e apagará todo o histórico de auditoria vinculado.
              </p>
            </div>
            <div className="flex justify-end gap-3 border-t border-[var(--ds-color-border-subtle)] px-5 py-4">
              <button
                type="button"
                onClick={() => setDeleteConfirmId(null)}
                className="rounded-xl border border-[var(--ds-color-border-default)] px-4 py-2 text-sm font-semibold text-[var(--ds-color-text-primary)] hover:bg-[color:var(--ds-color-surface-muted)]/40"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                className="rounded-xl bg-[var(--ds-color-danger)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                Excluir RDO
              </button>
            </div>
          </div>
        </div>
      )}

      {cancelTarget && (
        <div
          ref={cancelDialogRef}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rdo-cancel-title"
        >
          <div className="w-full max-w-sm rounded-2xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-lg)]">
            <div className="flex items-center justify-between border-b border-[var(--ds-color-border-subtle)] px-5 py-4">
              <h2 id="rdo-cancel-title" className="text-base font-semibold text-[var(--ds-color-text-primary)]">
                Cancelar RDO
              </h2>
              <button
                type="button"
                aria-label="Fechar"
                onClick={() => { setCancelTarget(null); setCancelReason(""); }}
                className="rounded-lg p-1.5 text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)]"
              >
                <span aria-hidden="true" className="text-lg leading-none">×</span>
              </button>
            </div>
            <div className="p-5">
              <label htmlFor="rdo-cancel-reason" className="mb-2 block text-sm font-semibold text-[var(--ds-color-text-primary)]">
                Motivo do cancelamento <span className="text-[var(--ds-color-danger)]">*</span>
              </label>
              <textarea
                id="rdo-cancel-reason"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                rows={3}
                aria-required="true"
                placeholder="Informe o motivo do cancelamento do RDO."
                className={`${formInputClassName} resize-none`}
              />
            </div>
            <div className="flex justify-end gap-3 border-t border-[var(--ds-color-border-subtle)] px-5 py-4">
              <button
                type="button"
                onClick={() => { setCancelTarget(null); setCancelReason(""); }}
                className="rounded-xl border border-[var(--ds-color-border-default)] px-4 py-2 text-sm font-semibold text-[var(--ds-color-text-primary)] hover:bg-[color:var(--ds-color-surface-muted)]/40"
              >
                Voltar
              </button>
              <button
                type="button"
                disabled={!cancelReason.trim() || isCancelling}
                onClick={() => void confirmCancelRdo()}
                className="rounded-xl bg-[var(--ds-color-warning)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCancelling ? "Cancelando…" : "Confirmar cancelamento"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
