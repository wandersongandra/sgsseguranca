"use client";
import { logger } from "@/lib/logger";

import dynamic from "next/dynamic";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  useState,
  useEffect,
  useCallback,
  useDeferredValue,
  useMemo,
  useRef,
} from "react";
import { useDebounce } from "@/hooks/useDebounce";
import {
  ddsService,
  Dds,
  DdsObservabilityAlertsPreview,
  DdsObservabilityOverview,
  DdsStatus,
  DDS_STATUS_LABEL,
  DDS_STATUS_COLORS,
  DDS_ALLOWED_TRANSITIONS,
} from "@/services/ddsService";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileSpreadsheet,
  Folder,
  Activity,
  Link2,
  Mail,
  Pencil,
  Plus,
  Printer,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  AlertTriangle,
} from "lucide-react";
import Link from "next/link";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { base64ToPdfBlob, base64ToPdfFile } from "@/lib/pdf/pdfFile";
import { buildPdfFilename } from "@/lib/pdf-system/core/format";
import { openPdfForPrint, openUrlInNewTab } from "@/lib/print-utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { ActionMenu } from "@/components/ActionMenu";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  EmptyState,
  ErrorState,
  InlineLoadingState,
} from "@/components/ui/state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginationControls } from "@/components/PaginationControls";
import { cn } from "@/lib/utils";
import { extractApiErrorMessage, getFormErrorMessage } from "@/lib/error-handler";
import { usePermissions } from "@/hooks/usePermissions";
import { Permission } from '@/lib/permissions';
import { resolveDdsPdfSource } from "@/lib/ddsPdfSource";
import { safeFormatDate } from "@/lib/date/safeFormat";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { ResponsiveDataList } from "@/components/ui/responsive-data-list";
import { getDdsActionPolicy } from "../components/documentActionPolicy";
import { useSingleFlightGuard } from "@/hooks/useSingleFlightGuard";
const SendMailModal = dynamic(
  () =>
    import("@/components/SendMailModal").then((module) => module.SendMailModal),
  { ssr: false },
);
const loadDdsPdfGenerator = async () => import("@/lib/pdf/ddsGenerator");

type StoredFile = {
  ddsId: string;
  tema: string;
  data: string;
  companyId: string;
  siteId: string | null;
  siteName: string | null;
  fileKey: string;
  folderPath: string;
  originalName: string;
};

const inputClassName =
  "w-full rounded-[var(--ds-radius-md)] border border-[var(--component-field-border-subtle)] bg-[color:var(--component-field-bg-subtle)] px-3 py-2.5 text-sm text-[var(--component-field-text)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--component-field-border-focus)] focus:outline-none focus:shadow-[var(--component-field-shadow-focus)]";

function parseYearFilter(value: string) {
  if (!value || !/^\d{4}$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 2020 || parsed > 2100) {
    return undefined;
  }
  return parsed;
}


function parseWeekFilter(value: string) {
  if (!value || !/^\d{1,2}$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 53) {
    return undefined;
  }
  return parsed;
}

function getEffectiveStatus(dds: Dds): DdsStatus {
  const currentStatus: DdsStatus = dds.status ?? "rascunho";
  if (dds.pdf_file_key && currentStatus === "rascunho") {
    return "publicado";
  }
  return currentStatus;
}

function formatObservabilityOutcome(outcome: string) {
  switch (outcome) {
    case "success":
      return "Sucesso";
    case "legacy":
      return "Legado sem token";
    case "invalid_token":
      return "Token inválido";
    case "module_mismatch":
      return "Código inconsistente";
    case "blocked":
      return "Bloqueado";
    default:
      return outcome;
  }
}

function resolveSignatureInviteUrl(invite: {
  signingUrl: string | null;
  signingPath: string | null;
}) {
  if (invite.signingUrl) {
    return invite.signingUrl;
  }
  if (invite.signingPath && typeof window !== "undefined") {
    return `${window.location.origin}${invite.signingPath}`;
  }
  return null;
}

function getDdsParticipantCount(dds: Dds) {
  return dds.participant_count ?? dds.participants?.length ?? 0;
}

export default function DdsPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "SGS | DDS";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { hasPermission } = usePermissions();
  const canViewDds = hasPermission(Permission.CAN_VIEW_DDS);
  const canManageDds = hasPermission(Permission.CAN_MANAGE_DDS);
  const [ddsList, setDdsList] = useState<Dds[]>([]);
  const timerRef = useRef<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [refetching, setRefetching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isFirstLoad = useRef(true);
  const ddsRequestSeqRef = useRef(0);
  // Inicializar filtros a partir de URL params — permite bookmark e compartilhamento de links
  const [searchTerm, setSearchTerm] = useState(
    () => searchParams.get("q") ?? "",
  );
  const debouncedSearchTerm = useDebounce(searchTerm, 300);
  const deferredSearchTerm = useDeferredValue(debouncedSearchTerm);
  const [modelFilter, setModelFilter] = useState<"all" | "model" | "regular">(
    () => {
      const v = searchParams.get("kind");
      return v === "model" || v === "regular" ? v : "regular";
    },
  );
  const [statusFilter, setStatusFilter] = useState<
    "all" | "rascunho" | "publicado" | "auditado" | "arquivado"
  >(() => {
    const v = searchParams.get("status");
    return v === "rascunho" || v === "publicado" || v === "auditado" || v === "arquivado"
      ? (v as "rascunho" | "publicado" | "auditado" | "arquivado")
      : "all";
  });
  const hasActiveDdsFilters = useMemo(
    () =>
      searchTerm.trim().length > 0 ||
      modelFilter !== "regular" ||
      statusFilter !== "all",
    [modelFilter, searchTerm, statusFilter],
  );
  const activeDdsFilters = useMemo(() => {
    const filters: string[] = [];
    const query = searchTerm.trim();
    if (query) {
      filters.push(
        query.length > 28 ? `Busca: ${query.slice(0, 28)}...` : `Busca: ${query}`,
      );
    }
    if (modelFilter === "model") {
      filters.push("Somente modelos");
    } else if (modelFilter === "all") {
      filters.push("Todos os tipos");
    }
    if (statusFilter !== "all") {
      filters.push(`Status: ${DDS_STATUS_LABEL[statusFilter]}`);
    }
    return filters;
  }, [modelFilter, searchTerm, statusFilter]);
  const [page, setPage] = useState(() => {
    const p = Number(searchParams.get("page"));
    return p > 0 ? p : 1;
  });
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const [observability, setObservability] =
    useState<DdsObservabilityOverview | null>(null);
  const [observabilityAlerts, setObservabilityAlerts] =
    useState<DdsObservabilityAlertsPreview | null>(null);
  const [observabilityOverviewLoading, setObservabilityOverviewLoading] =
    useState(true);
  const [observabilityAlertsLoading, setObservabilityAlertsLoading] =
    useState(true);
  const observabilityLoading = observabilityOverviewLoading;
  const [observabilityAlertsDispatching, setObservabilityAlertsDispatching] =
    useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [operationalizeTarget, setOperationalizeTarget] = useState<Dds | null>(null);
  const [issuingSignatureLinksId, setIssuingSignatureLinksId] = useState<
    string | null
  >(null);
  const deleteGuard = useSingleFlightGuard();
  const operationalizeGuard = useSingleFlightGuard();
  const statusChangeGuard = useSingleFlightGuard();
  const signatureLinksGuard = useSingleFlightGuard();
  const observabilityDispatchGuard = useSingleFlightGuard();

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, [setPage]);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage, setPage]);

  const clearDdsFilters = useCallback(() => {
    setSearchTerm("");
    setModelFilter("regular");
    setStatusFilter("all");
    setPage(1);
  }, []);

  // Sincronizar filtros com URL — permite bookmark e voltar ao mesmo estado
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedSearchTerm) params.set("q", debouncedSearchTerm);
    if (modelFilter !== "regular") params.set("kind", modelFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [debouncedSearchTerm, modelFilter, statusFilter, page, router, pathname]);

  const [storedFiles, setStoredFiles] = useState<StoredFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [fileYear, setFileYear] = useState<string>("");
  const [fileWeek, setFileWeek] = useState<string>("");
  const [fileCompanyId, setFileCompanyId] = useState<string>("");
  const [filesPage, setFilesPage] = useState(1);
  const [filesPageSize, setFilesPageSize] = useState(10);
  const filesRequestSequenceRef = useRef(0);
  const deferredFileYear = useDeferredValue(fileYear);
  const deferredFileWeek = useDeferredValue(fileWeek);
  const deferredFileCompanyId = useDeferredValue(fileCompanyId);
  const parsedFileYear = useMemo(
    () => parseYearFilter(deferredFileYear),
    [deferredFileYear],
  );
  const parsedFileWeek = useMemo(
    () => parseWeekFilter(deferredFileWeek),
    [deferredFileWeek],
  );

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

  const loadDds = useCallback(async () => {
    if (!canViewDds) {
      setDdsList([]);
      setTotal(0);
      setLastPage(1);
      setLoadError(null);
      setLoading(false);
      setRefetching(false);
      return;
    }

    const seq = ++ddsRequestSeqRef.current;
    try {
      if (isFirstLoad.current) {
        setLoading(true);
      } else {
        setRefetching(true);
      }
      setLoadError(null);
      const response = await ddsService.findPaginated({
        page,
        limit: 10,
        search: deferredSearchTerm || undefined,
        kind: modelFilter,
        status: statusFilter,
      });
      if (seq !== ddsRequestSeqRef.current) return;
      setDdsList(response.data);
      setTotal(response.total);
      setLastPage(response.lastPage);
    } catch (error) {
      if (seq !== ddsRequestSeqRef.current) return;
      logger.error("Erro ao carregar DDS:", error);
      setLoadError("Nao foi possivel carregar a lista de DDS.");
      toast.error("Erro ao carregar lista de DDS.");
    } finally {
      if (seq !== ddsRequestSeqRef.current) return;
      if (isFirstLoad.current) {
        isFirstLoad.current = false;
        setLoading(false);
      } else {
        setRefetching(false);
      }
    }
  }, [canViewDds, deferredSearchTerm, modelFilter, page, statusFilter]);

  const loadStoredFiles = useCallback(async () => {
    if (!canViewDds) {
      setStoredFiles([]);
      setLoadingFiles(false);
      return;
    }

    const requestId = ++filesRequestSequenceRef.current;
    try {
      setLoadingFiles(true);
      const data = await ddsService.listStoredFiles({
        company_id: deferredFileCompanyId || undefined,
        year: parsedFileYear,
        week: parsedFileWeek,
      });
      if (requestId === filesRequestSequenceRef.current) {
        setStoredFiles(data);
      }
    } catch (error) {
      if (requestId === filesRequestSequenceRef.current) {
        logger.error("Erro ao carregar arquivos DDS:", error);
        toast.error("Erro ao carregar arquivos salvos de DDS.");
      }
    } finally {
      if (requestId === filesRequestSequenceRef.current) {
        setLoadingFiles(false);
      }
    }
  }, [canViewDds, deferredFileCompanyId, parsedFileWeek, parsedFileYear]);

  const loadObservabilityOverview = useCallback(async () => {
    if (!canViewDds) {
      setObservability(null);
      setObservabilityOverviewLoading(false);
      return;
    }

    try {
      setObservabilityOverviewLoading(true);
      const overview = await ddsService.getObservabilityOverview();
      setObservability(overview);
    } catch (error) {
      logger.error("Erro ao carregar observabilidade DDS:", error);
      setObservability(null);
      toast.error(
        "Não foi possível carregar a observabilidade interna do DDS.",
      );
    } finally {
      setObservabilityOverviewLoading(false);
    }
  }, [canViewDds]);

  const loadObservabilityAlerts = useCallback(async () => {
    if (!canViewDds) {
      setObservabilityAlerts(null);
      setObservabilityAlertsLoading(false);
      return;
    }

    try {
      setObservabilityAlertsLoading(true);
      const alerts = await ddsService.getObservabilityAlertsPreview();
      setObservabilityAlerts(alerts);
    } catch (error) {
      logger.error("Erro ao carregar alertas DDS:", error);
      setObservabilityAlerts(null);
      toast.error(
        "Não foi possível carregar os alertas operacionais do DDS.",
      );
    } finally {
      setObservabilityAlertsLoading(false);
    }
  }, [canViewDds]);

  useEffect(() => {

    const timer = timerRef.current;


    return () => {

      if (timer) {

        clearTimeout(timer);

      }

    };

  }, []);

useEffect(() => {
    loadDds();
  }, [loadDds]);

  useEffect(() => {
    setPage(1);
  }, [deferredSearchTerm, modelFilter, statusFilter]);

  useEffect(() => {
    loadStoredFiles();
  }, [loadStoredFiles]);

  useEffect(() => {
    void loadObservabilityOverview();
    void loadObservabilityAlerts();
  }, [loadObservabilityAlerts, loadObservabilityOverview]);

  useEffect(() => {
    setFilesPage(1);
  }, [
    deferredFileCompanyId,
    deferredFileYear,
    deferredFileWeek,
    filesPageSize,
  ]);

  function handleDelete(id: string) {
    if (!canManageDds) {
      toast.error("Você não tem permissão para excluir DDS.");
      return;
    }
    setConfirmDeleteId(id);
  }

  async function confirmDelete() {
    if (!confirmDeleteId || !deleteGuard.tryStart()) return;
    setDeleteLoading(true);
    try {
      await ddsService.delete(confirmDeleteId);
      toast.success("DDS excluído com sucesso.");
      setConfirmDeleteId(null);
      if (ddsList.length === 1 && page > 1) {
        setPage((current) => current - 1);
        void loadObservabilityOverview();
        return;
      }
      await loadDds();
      void loadObservabilityOverview();
    } catch (error) {
      logger.error("Erro ao excluir DDS:", error);
      toast.error(
        "Erro ao excluir DDS. Verifique dependências e tente novamente.",
      );
    } finally {
      deleteGuard.finish();
      setDeleteLoading(false);
    }
  }

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

  const getAllowedStatusTransitions = useCallback((dds: Dds): DdsStatus[] => {
    if (dds.pdf_file_key) {
      return [];
    }

    const currentStatus = getEffectiveStatus(dds);
    const transitions = DDS_ALLOWED_TRANSITIONS[currentStatus] ?? [];
    if (!dds.is_modelo) {
      return transitions;
    }

    return transitions.filter(
      (status) => status !== "publicado" && status !== "auditado",
    );
  }, []);

  const buildDdsFilename = (dds: Dds) =>
    buildPdfFilename("DDS", dds.tema || "dds", dds.data);

  const generateLocalDdsPdfBase64 = async (
    dds: Dds,
    options?: { requireApprovedFlow?: boolean },
  ) => {
    const approvalFlow = await ddsService
      .getApprovalFlow(dds.id)
      .catch((error) => {
        if (options?.requireApprovedFlow) {
          throw error;
        }
        logger.error(
          "Erro ao carregar fluxo de aprovação DDS para PDF:",
          error,
        );
        return null;
      });
    if (options?.requireApprovedFlow && approvalFlow?.status !== "approved") {
      throw new Error(
        "O PDF final exige fluxo de aprovação DDS concluído e rastreável.",
      );
    }
    const signatures = await ddsService.listSignatures(dds.id);
    const videos = await ddsService.listVideoAttachments(dds.id);
    const { generateDdsPdf } = await loadDdsPdfGenerator();
    // Marca d'água aparece apenas quando o DDS ainda é rascunho (preview).
    // PDFs gerados para emissão/impressão de documentos publicados ou auditados
    // saem limpos, sem watermark.
    const base64 = await generateDdsPdf(
      {
        ...dds,
        approval_flow: approvalFlow,
      },
      signatures,
      videos,
      {
        save: false,
        output: "base64",
        draftWatermark: dds.status === "rascunho",
      },
    );

    if (!base64) {
      throw new Error("Falha ao gerar o PDF do DDS.");
    }

    return String(base64);
  };

  const syncDdsInList = useCallback((latest: Dds) => {
    setDdsList((prev) =>
      prev.map((current) =>
        current.id === latest.id ? { ...current, ...latest } : current,
      ),
    );
  }, []);

  const resolveLatestDdsForPdf = useCallback(
    async (dds: Dds) =>
      resolveDdsPdfSource(dds, {
        fetchLatest: (id) => ddsService.findOne(id),
        syncCached: syncDdsInList,
      }),
    [syncDdsInList],
  );

  const ensureGovernedPdf = async (dds: Dds) => {
    if (!dds.pdf_file_key && !canManageDds) {
      throw new Error(
        "Você não tem permissão para emitir o PDF final deste DDS.",
      );
    }
    const existingAccess = await ddsService.getPdfAccess(dds.id);
    if (existingAccess.hasFinalPdf) {
      return existingAccess;
    }

    const latestDds = await resolveLatestDdsForPdf(dds);
    if (latestDds.status !== "auditado") {
      throw new Error(
        "Conclua o fluxo de aprovação do DDS antes de emitir o PDF final governado.",
      );
    }
    const validationContext = await ddsService.getValidationContext(
      latestDds.id,
    );
    const ddsForPdf: Dds = {
      ...latestDds,
      document_code: validationContext.documentCode,
      validation_token: validationContext.token,
    };
    const base64 = await generateLocalDdsPdfBase64(ddsForPdf, {
      requireApprovedFlow: true,
    });
    const file = base64ToPdfFile(base64, buildDdsFilename(ddsForPdf));
    const attachResult = await ddsService.attachFile(dds.id, file);
    await loadDds();
    void loadStoredFiles();
    void loadObservabilityOverview();
    if (attachResult.degraded) {
      toast.warning(attachResult.message);
    } else {
      toast.success(attachResult.message);
    }
    return ddsService.getPdfAccess(dds.id);
  };

  const handlePrint = async (dds: Dds) => {
    try {
      toast.info("Preparando impressão...");
      if (dds.pdf_file_key) {
        const access = await ddsService.getPdfAccess(dds.id);
        if (access.availability === "ready" && access.url) {
          openPdfForPrint(access.url, () => {
            toast.info("Pop-up bloqueado. Abrimos o PDF final na mesma aba.");
          });
          return;
        }
        toast.warning(access.message);
      }

      const latestDds = await resolveLatestDdsForPdf(dds);
      const base64 = await generateLocalDdsPdfBase64(latestDds);
      const fileURL = URL.createObjectURL(base64ToPdfBlob(base64));

      openPdfForPrint(fileURL, () => {
        toast.info(
          "Pop-up bloqueado. Abrimos o PDF na mesma aba para impressão.",
        );
      });
      setTimeout(() => URL.revokeObjectURL(fileURL), 60_000);
    } catch (error) {
      logger.error("Erro ao gerar PDF:", error);
      toast.error("Erro ao gerar PDF para impressão.");
    }
  };

  const handleEmail = async (dds: Dds) => {
    try {
      if (dds.pdf_file_key) {
        const access = await ddsService.getPdfAccess(dds.id);
        if (access.hasFinalPdf) {
          setSelectedDoc({
            name: `DDS - ${dds.tema}`,
            filename: access.originalName || buildDdsFilename(dds),
            storedDocument: {
              documentId: dds.id,
              documentType: "DDS",
            },
          });
          if (access.availability !== "ready" && access.message) {
            toast.warning(
              `${access.message} O envio oficial continuará usando o PDF final governado do DDS.`,
            );
          }
          setIsMailModalOpen(true);
          return;
        }
        if (access.message) {
          toast.warning(access.message);
        }
      }

      const latestDds = await resolveLatestDdsForPdf(dds);
      const base64 = await generateLocalDdsPdfBase64(latestDds);

      setSelectedDoc({
        name: `DDS - ${latestDds.tema}`,
        filename: buildDdsFilename(latestDds),
        base64,
      });
      setIsMailModalOpen(true);
    } catch (error) {
      logger.error("Erro ao preparar e-mail:", error);
      toast.error("Erro ao preparar e-mail com o documento.");
    }
  };

  const handleOperationalize = (dds: Dds) => {
    setOperationalizeTarget(dds);
  };

  const confirmOperationalize = async () => {
    if (!operationalizeTarget || !operationalizeGuard.tryStart()) return;
    const dds = operationalizeTarget;
    setOperationalizeTarget(null);

    try {
      toast.info("Operacionalizando modelo...");
      const newDds = await ddsService.operationalizeTemplate(dds.id, {});
      toast.success(
        `Modelo operacionalizado. Abrindo novo DDS para edição...`,
      );
      router.push(`/dashboard/dds/edit/${newDds.id}`);
    } catch (error) {
      logger.error("Erro ao operacionalizar template:", error);
      toast.error(
        "Erro ao operacionalizar modelo. Verifique se o modelo está válido.",
      );
    } finally {
      operationalizeGuard.finish();
    }
  };

  const handleOpenGovernedPdf = async (dds: Dds) => {
    try {
      toast.info(
        dds.pdf_file_key
          ? "Abrindo PDF final governado..."
          : "Emitindo PDF final governado...",
      );
      const access = await ensureGovernedPdf(dds);
      if (access.availability === "ready" && access.url) {
        openUrlInNewTab(access.url);
        return;
      }

      toast.warning(
        access.message ||
          "PDF final emitido, mas a URL segura não está disponível agora. Abrimos a cópia oficial local.",
      );
      const latestDds = await resolveLatestDdsForPdf(dds);
      const validationContext = await ddsService.getValidationContext(
        latestDds.id,
      );
      const ddsForPdf: Dds = {
        ...latestDds,
        document_code: validationContext.documentCode,
        validation_token: validationContext.token,
      };
      const base64 = await generateLocalDdsPdfBase64(ddsForPdf, {
        requireApprovedFlow: true,
      });
      const fileUrl = URL.createObjectURL(base64ToPdfBlob(base64));
      openUrlInNewTab(fileUrl);
      setTimeout(() => URL.revokeObjectURL(fileUrl), 60_000);
    } catch (error) {
      logger.error("Erro ao emitir/abrir PDF final do DDS:", error);
      const message = getFormErrorMessage(error, {
        badRequest:
          "Não foi possível emitir o PDF final. Verifique status, participantes e assinaturas do DDS.",
        unauthorized: "Sessão expirada. Faça login novamente.",
        forbidden: "Você não tem permissão para emitir o PDF final deste DDS.",
        notFound:
          "DDS não encontrado ou sem dados válidos para emissão do PDF final.",
        server: "Erro interno ao emitir o PDF final do DDS.",
        fallback: "Não foi possível emitir ou abrir o PDF final do DDS.",
      });
      toast.error(message);
    }
  };

  const handleDownloadStoredPdf = async (ddsId: string) => {
    try {
      const access = await ddsService.getPdfAccess(ddsId);
      if (access.availability !== "ready" || !access.url) {
        toast.info(access.message);
        return;
      }
      openUrlInNewTab(access.url);
    } catch (error) {
      logger.error("Erro ao obter link do PDF:", error);
      toast.error("Não foi possível abrir o PDF armazenado.");
    }
  };

  const handleStatusChange = async (dds: Dds, newStatus: DdsStatus) => {
    if (!canManageDds) {
      toast.error("Você não tem permissão para alterar o status do DDS.");
      return;
    }
    if (!statusChangeGuard.tryStart()) return;
    try {
      const updated = await ddsService.updateStatus(dds.id, newStatus);
      setDdsList((prev) =>
        prev.map((d) =>
          d.id === dds.id ? { ...d, status: updated.status } : d,
        ),
      );
      void loadObservabilityOverview();
      toast.success(`DDS movido para "${DDS_STATUS_LABEL[updated.status]}".`);
    } catch (error) {
      logger.error("Erro ao atualizar status do DDS:", error);
      toast.error(
        getApiErrorMessage(error) || "Não foi possível atualizar o status.",
      );
    } finally {
      statusChangeGuard.finish();
    }
  };

  const handleCopyFolderPath = async (folderPath: string) => {
    try {
      await navigator.clipboard.writeText(folderPath);
      toast.success("Caminho da pasta copiado.");
    } catch (error) {
      logger.error("Erro ao copiar caminho:", error);
      toast.error("Não foi possível copiar o caminho da pasta.");
    }
  };

  const handleExportStoredFilesCsv = () => {
    if (storedFiles.length === 0) {
      toast.error("Não há arquivos para exportar.");
      return;
    }

    const headers = [
      "dds_id",
      "data",
      "tema",
      "company_id",
      "site_id",
      "obra",
      "folder_path",
      "file_key",
      "original_name",
    ];
    const escapeCsv = (value: string) => `"${value.replace(/"/g, '""')}"`;

    const rows = storedFiles.map((file) =>
      [
        file.ddsId,
        safeFormatDate(file.data, "yyyy-MM-dd"),
        file.tema,
        file.companyId,
        file.siteId,
        file.siteName,
        file.folderPath,
        file.fileKey,
        file.originalName,
      ]
        .map((item) => escapeCsv(String(item ?? "")))
        .join(","),
    );

    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `dds-files-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    toast.success("CSV exportado com sucesso.");
  };

  const handleCopyPdfLink = async (ddsId: string) => {
    try {
      const access = await ddsService.getPdfAccess(ddsId);
      if (access.availability !== "ready" || !access.url) {
        toast.info(access.message);
        return;
      }
      await navigator.clipboard.writeText(access.url);
      toast.success("Link do PDF copiado.");
    } catch (error) {
      logger.error("Erro ao copiar link do PDF:", error);
      toast.error("Não foi possível copiar o link do PDF.");
    }
  };

  const handleCopySignatureLinks = async (dds: Dds) => {
    if (!canManageDds) {
      toast.error("Você não tem permissão para gerar links de assinatura.");
      return;
    }
    if (dds.is_modelo) {
      toast.error("Modelos de DDS não recebem link público de assinatura.");
      return;
    }
    if (dds.pdf_file_key) {
      toast.error(
        "DDS com PDF final emitido está bloqueado para novas assinaturas.",
      );
      return;
    }
    if (getEffectiveStatus(dds) === "arquivado" || dds.status === "arquivado") {
      toast.error("DDS arquivado não recebe link público de assinatura.");
      return;
    }
    if (getDdsParticipantCount(dds) === 0) {
      toast.error(
        "Adicione participantes ao DDS antes de gerar links de assinatura.",
      );
      return;
    }
    if (!signatureLinksGuard.tryStart()) return;

    try {
      setIssuingSignatureLinksId(dds.id);
      const result = await ddsService.issueSignatureInvites(
        dds.id,
        undefined,
        { companyId: dds.company_id },
      );

      const pendingInvites = result.invites.filter(
        (invite) => invite.status === "pending",
      );
      if (pendingInvites.length === 0) {
        toast.info("Todos os participantes deste DDS já assinaram.");
        return;
      }

      const lines = pendingInvites
        .map((invite) => {
          const url = resolveSignatureInviteUrl(invite);
          return url ? `${invite.participantName}: ${url}` : null;
        })
        .filter((line): line is string => Boolean(line));

      if (lines.length === 0) {
        toast.error(
          "Não foi possível montar URLs públicas. Verifique NEXT_PUBLIC_APP_URL/FRONTEND_URL.",
        );
        return;
      }

      await navigator.clipboard.writeText(lines.join("\n"));
      toast.success(
        lines.length === 1
          ? "Link de assinatura copiado."
          : "Links de assinatura copiados.",
      );
    } catch (err) {
      logger.error("Erro ao gerar links de assinatura DDS:", err);
      const message = await extractApiErrorMessage(
        err,
        "Não foi possível gerar os links de assinatura no momento.",
      );
      toast.error(message);
    } finally {
      signatureLinksGuard.finish();
      setIssuingSignatureLinksId(null);
    }
  };

  const handleDispatchObservabilityAlerts = async () => {
    if (!observabilityDispatchGuard.tryStart()) return;
    try {
      setObservabilityAlertsDispatching(true);
      const result = await ddsService.dispatchObservabilityAlerts();
      if (!result.dispatched) {
        toast.info(
          result.alerts.length
            ? "Os alertas já foram disparados recentemente para este tenant."
            : "Nenhum alerta ativo exige disparo neste momento.",
        );
      } else {
        toast.success(
          `Alertas DDS enviados: ${result.notificationsCreated} notificações, e-mail ${result.emailSent ? "enviado" : "não enviado"} e webhook ${result.webhookSent ? "ok" : "não configurado"}.`,
        );
      }
      await loadObservabilityAlerts();
    } catch (error) {
      logger.error("Erro ao disparar alertas DDS:", error);
      toast.error("Não foi possível disparar os alertas operacionais DDS.");
    } finally {
      observabilityDispatchGuard.finish();
      setObservabilityAlertsDispatching(false);
    }
  };

  const handleDownloadWeeklyBundle = async () => {
    if (!fileYear || !fileWeek) {
      toast.error("Selecione ano e semana para gerar o pacote.");
      return;
    }

    try {
      const blob = await ddsService.downloadWeeklyBundle({
        company_id: fileCompanyId || undefined,
        year: Number(fileYear),
        week: Number(fileWeek),
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dds-semana-${fileYear}-${String(fileWeek).padStart(2, "0")}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      toast.success("Pacote semanal gerado com sucesso.");
    } catch (error) {
      logger.error("Erro ao gerar pacote semanal DDS:", error);
      toast.error("Não foi possível gerar o pacote semanal de DDS.");
    }
  };

  const handlePrintWeeklyBundle = async () => {
    if (!fileYear || !fileWeek) {
      toast.error("Selecione ano e semana para imprimir o pacote.");
      return;
    }

    try {
      const blob = await ddsService.downloadWeeklyBundle({
        company_id: fileCompanyId || undefined,
        year: Number(fileYear),
        week: Number(fileWeek),
      });
      const url = URL.createObjectURL(blob);
      openPdfForPrint(url, () => {
        toast.info("Pop-up bloqueado. Abrimos o pacote na mesma aba.");
      });
    } catch (error) {
      logger.error("Erro ao imprimir pacote semanal DDS:", error);
      toast.error("Não foi possível abrir o pacote semanal de DDS.");
    }
  };

  const companyOptions = useMemo(
    () =>
      Array.from(
        new Map(
          ddsList
            .filter((item) => item.company_id)
            .map((item) => [
              item.company_id,
              item.company?.razao_social || item.company_id,
            ]),
        ).entries(),
      ).map(([id, name]) => ({ id, name })),
    [ddsList],
  );

  const ddsSummary = useMemo(
    () => ({
      total,
      registros: ddsList.filter((item) => !item.is_modelo).length,
      arquivos: storedFiles.length,
    }),
    [ddsList, storedFiles.length, total],
  );

  const moduleHighlights = useMemo(
    () => [
      {
        label: "DDS cadastrados",
        value: ddsSummary.total,
        detail: "visão total do tenant",
        accent:
          "border-[color:var(--ds-color-info)]/20 bg-[color:var(--ds-color-info)]/8 text-[var(--ds-color-info)]",
      },
      {
        label: "Nesta página",
        value: ddsSummary.registros,
        detail: "registros em destaque",
        accent:
          "border-[color:var(--ds-color-action-primary)]/20 bg-[color:var(--ds-color-action-primary)]/8 text-[var(--ds-color-action-primary)]",
      },
      {
        label: "PDFs armazenados",
        value: ddsSummary.arquivos,
        detail: "storage governado",
        accent:
          "border-[color:var(--ds-color-success)]/20 bg-[color:var(--ds-color-success)]/8 text-[var(--ds-color-success)]",
      },
      {
        label: "Consultas 7d",
        value: observabilityLoading
          ? "..."
          : (observability?.publicValidation.totalLast7d ?? 0),
        detail: "portal público monitorado",
        accent:
          "border-[color:var(--ds-color-warning)]/20 bg-[color:var(--ds-color-warning)]/8 text-[var(--ds-color-warning)]",
      },
    ],
    [
      ddsSummary.arquivos,
      ddsSummary.registros,
      ddsSummary.total,
      observability?.publicValidation.totalLast7d,
      observabilityLoading,
    ],
  );

  const totalFilesPages = useMemo(
    () => Math.max(1, Math.ceil(storedFiles.length / filesPageSize)),
    [storedFiles.length, filesPageSize],
  );
  const pagedStoredFiles = useMemo(
    () =>
      storedFiles.slice(
        (filesPage - 1) * filesPageSize,
        filesPage * filesPageSize,
      ),
    [storedFiles, filesPage, filesPageSize],
  );

  if (!canViewDds) {
    return (
      <ErrorState
        title="Acesso ao DDS indisponível"
        description="Seu perfil não possui permissão para visualizar o módulo DDS."
      />
    );
  }

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar DDS"
        description={loadError}
        action={
          <Button type="button" onClick={loadDds}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      {loading && ddsList.length === 0 ? (
        <Card tone="default" padding="lg">
          <InlineLoadingState label="Carregando DDS..." />
        </Card>
      ) : null}

      <section className="relative overflow-hidden rounded-[var(--ds-radius-2xl)] border border-[var(--ds-color-border-subtle)] bg-[linear-gradient(135deg,var(--ds-color-surface-base),var(--ds-color-surface-muted))] p-6 shadow-[var(--ds-shadow-sm)]">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_top_right,rgba(21,94,117,0.14),transparent_62%)]" />
        <div className="pointer-events-none absolute -right-12 top-8 h-40 w-40 rounded-full bg-[color:var(--ds-color-action-primary)]/10 blur-3xl" />
        <div className="pointer-events-none absolute left-6 top-6 h-12 w-12 rounded-full bg-[color:var(--ds-color-success)]/10 blur-2xl" />
        <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-[color:var(--ds-color-action-primary)]/20 bg-[color:var(--ds-color-action-primary)]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-action-primary)]">
                Cockpit DDS
              </span>
              <span className="rounded-full border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-secondary)]">
                {observability?.tenantScope === "global" ? "Escopo global" : "Escopo tenant"}
              </span>
              <span className="rounded-full border border-[color:var(--ds-color-success)]/20 bg-[color:var(--ds-color-success)]/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-success)]">
                {observabilityLoading
                  ? "Telemetria em carga"
                  : `${observability?.publicValidation.totalLast7d ?? 0} consultas públicas`}
              </span>
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-[-0.04em] text-[var(--ds-color-text-primary)] sm:text-4xl">
                Diálogo Diário de Segurança
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-[var(--ds-color-text-secondary)] sm:text-[0.96rem]">
                Gestão de registros, evidências e PDFs governados em uma superfície única, com foco em leitura rápida, rastreabilidade e emissão segura.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {moduleHighlights.map((item) => (
                <div
                  key={item.label}
                  className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/85 p-4 shadow-[var(--ds-shadow-sm)]"
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-muted)]">
                    {item.label}
                  </p>
                  <p className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-[var(--ds-color-text-primary)]">
                    {item.value}
                  </p>
                  <p className={`mt-2 inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${item.accent}`}>
                    {item.detail}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <Card tone="elevated" padding="lg" className="relative overflow-hidden">
            <div className="pointer-events-none absolute right-0 top-0 h-28 w-28 rounded-full bg-[color:var(--ds-color-action-primary)]/10 blur-3xl" />
            <CardHeader className="relative gap-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[var(--ds-color-action-primary)]" />
                <CardTitle className="text-base">Ações rápidas</CardTitle>
              </div>
              <CardDescription>
                Entrada operacional para criar, revisar e navegar no módulo.
              </CardDescription>
            </CardHeader>
            <CardContent className="relative mt-0 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/85 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-muted)]">
                    Registros
                  </p>
                  <p className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-[var(--ds-color-text-primary)]">
                    {ddsSummary.total}
                  </p>
                  <p className="mt-1 text-xs text-[var(--ds-color-text-secondary)]">
                    DDS visíveis no tenant.
                  </p>
                </div>
                <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/85 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-muted)]">
                    PDFs
                  </p>
                  <p className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-[var(--ds-color-success)]">
                    {ddsSummary.arquivos}
                  </p>
                  <p className="mt-1 text-xs text-[var(--ds-color-text-secondary)]">
                    Arquivos armazenados com trilha governada.
                  </p>
                </div>
              </div>
              <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/20 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-muted)]">
                  Snapshot do módulo
                </p>
                <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                  {observabilityLoading
                    ? "Atualizando snapshot..."
                    : safeFormatDate(
                        observability?.generatedAt ?? new Date().toISOString(),
                        "dd/MM/yyyy HH:mm",
                        { locale: ptBR },
                      )}
                </p>
                <p className="mt-1 text-xs text-[var(--ds-color-text-secondary)]">
                  Visão do tenant com foco em emissão, governança e validação pública.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {canManageDds ? (
                  <Link
                    href="/dashboard/dds/new"
                    className={cn(buttonVariants(), "inline-flex items-center")}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Novo DDS
                  </Link>
                ) : null}
                <a
                  href="#registros-dds"
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "inline-flex items-center",
                  )}
                >
                  Ver registros
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card tone="info" padding="md">
          <CardHeader className="gap-2">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[var(--ds-color-action-primary)]" />
              <CardTitle>Governança operacional</CardTitle>
            </div>
            <CardDescription>
              Funil interno de aprovação e emissão governada do DDS.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm text-[var(--ds-color-text-secondary)] md:grid-cols-2">
            <p>
              <strong className="text-[var(--ds-color-text-primary)]">
                Escopo:
              </strong>{" "}
              {observability?.tenantScope === "global" ? "Global" : "Tenant"}
            </p>
            <p>
              <strong className="text-[var(--ds-color-text-primary)]">
                DDS sem governança:
              </strong>{" "}
              {observabilityLoading
                ? "..."
                : (observability?.portfolio.pendingGovernance ?? "-")}
            </p>
            <p>
              <strong className="text-[var(--ds-color-text-primary)]">
                Fluxo não iniciado:
              </strong>{" "}
              {observabilityLoading
                ? "..."
                : (observability?.approvals.notStarted ?? "-")}
            </p>
            <p>
              <strong className="text-[var(--ds-color-text-primary)]">
                Fluxo pendente:
              </strong>{" "}
              {observabilityLoading
                ? "..."
                : (observability?.approvals.pending ?? "-")}
            </p>
            <p>
              <strong className="text-[var(--ds-color-text-primary)]">
                Aprovações 7d:
              </strong>{" "}
              {observabilityLoading
                ? "..."
                : (observability?.approvals.approvedLast7d ?? "-")}
            </p>
            <p>
              <strong className="text-[var(--ds-color-text-primary)]">
                Reaberturas 7d:
              </strong>{" "}
              {observabilityLoading
                ? "..."
                : (observability?.approvals.reopenedLast7d ?? "-")}
            </p>
          </CardContent>
        </Card>

        <Card tone="warning" padding="md">
          <CardHeader className="gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-[var(--ds-color-warning)]" />
              <CardTitle>Antifraude público</CardTitle>
            </div>
            <CardDescription>
              Telemetria persistida das consultas públicas DDS nos últimos 7
              dias.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm text-[var(--ds-color-text-secondary)] md:grid-cols-2">
            <p>
              <strong className="text-[var(--ds-color-text-primary)]">
                Consultas 7d:
              </strong>{" "}
              {observabilityLoading
                ? "..."
                : (observability?.publicValidation.totalLast7d ?? "-")}
            </p>
            <p>
              <strong className="text-[var(--ds-color-text-primary)]">
                Consultas suspeitas:
              </strong>{" "}
              {observabilityLoading
                ? "..."
                : (observability?.publicValidation.suspiciousLast7d ?? "-")}
            </p>
            <p>
              <strong className="text-[var(--ds-color-text-primary)]">
                Bloqueios:
              </strong>{" "}
              {observabilityLoading
                ? "..."
                : (observability?.publicValidation.blockedLast7d ?? "-")}
            </p>
            <p>
              <strong className="text-[var(--ds-color-text-primary)]">
                IPs únicos:
              </strong>{" "}
              {observabilityLoading
                ? "..."
                : (observability?.publicValidation.uniqueIpsLast7d ?? "-")}
            </p>
            <p className="md:col-span-2">
              <strong className="text-[var(--ds-color-text-primary)]">
                Motivos líderes:
              </strong>{" "}
              {observabilityLoading
                ? "..."
                : observability?.publicValidation.topReasons.length
                  ? observability.publicValidation.topReasons
                      .map((item) => `${item.reason} (${item.total})`)
                      .join(" • ")
                  : "Sem ocorrências relevantes"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card tone="default" padding="none">
          <CardHeader className="border-b border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/18 px-5 py-4">
            <CardTitle>Documentos mais consultados</CardTitle>
            <CardDescription>
              Ranking interno de códigos DDS observados no portal público.
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-0">
            {observabilityLoading ? (
              <InlineLoadingState label="Carregando ranking de validações DDS" />
            ) : observability?.publicValidation.topDocuments.length ? (
              <ResponsiveDataList
                items={observability.publicValidation.topDocuments}
                getKey={(item) => item.documentRef}
                mobileClassName="space-y-3"
                mobile={(item) => (
                  <article className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] p-3">
                    <h3 className="font-semibold text-[var(--ds-color-text-primary)]">{item.documentRef}</h3>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-sm" role="list" aria-label={`Indicadores de ${item.documentRef}`}>
                      <div role="listitem"><span className="block text-xs text-[var(--ds-color-text-muted)]">Consultas</span><span>{item.total}</span></div>
                      <div role="listitem"><span className="block text-xs text-[var(--ds-color-text-muted)]">Suspeitas</span><span>{item.suspicious}</span></div>
                      <div className="col-span-2" role="listitem"><span className="block text-xs text-[var(--ds-color-text-muted)]">Última consulta</span><span>{item.lastSeenAt ? safeFormatDate(item.lastSeenAt, "dd/MM/yyyy HH:mm", { locale: ptBR }) : "-"}</span></div>
                    </div>
                  </article>
                )}
                desktop={() => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Código</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Suspeitas</TableHead>
                    <TableHead>Última consulta</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {observability.publicValidation.topDocuments.map((item) => (
                    <TableRow key={item.documentRef}>
                      <TableCell className="font-medium text-[var(--ds-color-text-primary)]">
                        {item.documentRef}
                      </TableCell>
                      <TableCell>{item.total}</TableCell>
                      <TableCell>{item.suspicious}</TableCell>
                      <TableCell>
                        {item.lastSeenAt
                          ? safeFormatDate(
                              item.lastSeenAt,
                              "dd/MM/yyyy HH:mm",
                              {
                                locale: ptBR,
                              },
                            )
                          : "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
                )}
              />
            ) : (
              <EmptyState
                title="Sem telemetria pública suficiente"
                description="Ainda não há validações DDS persistidas para compor o ranking."
                compact
              />
            )}
          </CardContent>
        </Card>

        <Card tone="default" padding="none">
          <CardHeader className="border-b border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/18 px-5 py-4">
            <CardTitle>Eventos recentes do portal</CardTitle>
            <CardDescription>
              Últimas consultas públicas DDS com sinalização antifraude.
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-0">
            {observabilityLoading ? (
              <InlineLoadingState label="Carregando eventos do portal DDS" />
            ) : observability?.publicValidation.recentEvents.length ? (
              <div className="space-y-3 py-1">
                {observability.publicValidation.recentEvents.map(
                  (event, index) => (
                    <div
                      key={`${event.documentRef}-${event.occurredAt ?? index}`}
                      className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] px-3 py-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-[var(--ds-color-text-primary)]">
                          {event.documentRef}
                        </span>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                            event.blocked || event.suspicious
                              ? "border-[color:var(--ds-color-warning)]/35 bg-[color:var(--ds-color-warning)]/12 text-[var(--ds-color-warning)]"
                              : "border-[color:var(--ds-color-success)]/35 bg-[color:var(--ds-color-success)]/12 text-[var(--ds-color-success)]",
                          )}
                        >
                          {formatObservabilityOutcome(event.outcome)}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-1 text-[var(--ds-color-text-secondary)] md:grid-cols-2">
                        <p>
                          Data/hora:{" "}
                          {event.occurredAt
                            ? safeFormatDate(
                                event.occurredAt,
                                "dd/MM/yyyy HH:mm",
                                { locale: ptBR },
                              )
                            : "-"}
                        </p>
                        <p>IP: {event.ip || "-"}</p>
                        <p>Sensível: {event.suspicious ? "Sim" : "Não"}</p>
                        <p>Bloqueado: {event.blocked ? "Sim" : "Não"}</p>
                        <p className="md:col-span-2">
                          Motivos:{" "}
                          {event.reasons.length
                            ? event.reasons.join(" • ")
                            : "Sem sinalização"}
                        </p>
                      </div>
                    </div>
                  ),
                )}
              </div>
            ) : (
              <EmptyState
                title="Nenhum evento recente"
                description="O portal público ainda não registrou consultas DDS no período monitorado."
                compact
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card tone="default" padding="none">
        <CardHeader className="gap-3 border-b border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/18 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-[var(--ds-color-warning)]" />
              <CardTitle>Alertas operacionais DDS</CardTitle>
            </div>
            <CardDescription>
              Disparo assistido para compliance com fila sugerida de
              investigação.
            </CardDescription>
          </div>
          {canManageDds ? (
            <Button
              type="button"
              variant="outline"
              leftIcon={<AlertTriangle className="h-4 w-4" />}
              onClick={handleDispatchObservabilityAlerts}
              disabled={
                observabilityAlertsLoading || observabilityAlertsDispatching
              }
            >
              {observabilityAlertsDispatching
                ? "Disparando..."
                : "Disparar alertas"}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="mt-0 grid gap-4 py-5 xl:grid-cols-[1.2fr,0.8fr]">
          <div className="space-y-4">
            <div className="grid gap-3 text-sm text-[var(--ds-color-text-secondary)] md:grid-cols-3">
              <p>
                <strong className="text-[var(--ds-color-text-primary)]">
                  Automação:
                </strong>{" "}
                {observabilityAlertsLoading
                  ? "..."
                  : observabilityAlerts?.automationEnabled
                    ? "Habilitada"
                    : "Desabilitada"}
              </p>
              <p>
                <strong className="text-[var(--ds-color-text-primary)]">
                  Notificados:
                </strong>{" "}
                {observabilityAlertsLoading
                  ? "..."
                  : (observabilityAlerts?.recipients.notificationUsers ?? 0)}
              </p>
              <p>
                <strong className="text-[var(--ds-color-text-primary)]">
                  E-mails:
                </strong>{" "}
                {observabilityAlertsLoading
                  ? "..."
                  : (observabilityAlerts?.recipients.emailRecipients.length ??
                    0)}
              </p>
            </div>

            {observabilityAlertsLoading ? (
              <InlineLoadingState label="Carregando alertas operacionais DDS" />
            ) : observabilityAlerts?.alerts.length ? (
              <div className="space-y-3">
                {observabilityAlerts.alerts.map((alert) => (
                  <div
                    key={alert.code}
                    className={cn(
                      "rounded-[var(--ds-radius-md)] border px-4 py-3 text-sm",
                      alert.severity === "critical"
                        ? "border-[color:var(--ds-color-danger)]/30 bg-[color:var(--ds-color-danger)]/8"
                        : "border-[color:var(--ds-color-warning)]/30 bg-[color:var(--ds-color-warning)]/8",
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="text-[var(--ds-color-text-primary)]">
                        {alert.title}
                      </strong>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.08em]",
                          alert.severity === "critical"
                            ? "border-[color:var(--ds-color-danger)]/35 bg-[color:var(--ds-color-danger)]/12 text-[var(--ds-color-danger)]"
                            : "border-[color:var(--ds-color-warning)]/35 bg-[color:var(--ds-color-warning)]/12 text-[var(--ds-color-warning)]",
                        )}
                      >
                        {alert.severity === "critical" ? "Crítico" : "Atenção"}
                      </span>
                    </div>
                    <p className="mt-2 text-[var(--ds-color-text-secondary)]">
                      {alert.message}
                    </p>
                    <p className="mt-2 text-xs text-[var(--ds-color-text-muted)]">
                      Métrica atual: {alert.metric} • Limite: {alert.threshold}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Sem alertas ativos"
                description="Nenhum limiar operacional DDS foi excedido no momento."
                compact
              />
            )}
          </div>

          <div className="space-y-4">
            <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/16 p-4 text-sm">
              <p className="font-semibold text-[var(--ds-color-text-primary)]">
                Canais de compliance
              </p>
              <p className="mt-2 text-[var(--ds-color-text-secondary)]">
                {observabilityAlertsLoading
                  ? "Carregando destinatários..."
                  : observabilityAlerts?.recipients.emailRecipients.length
                    ? observabilityAlerts.recipients.emailRecipients.join(" • ")
                    : "Nenhum destinatário de e-mail configurado para este tenant."}
              </p>
            </div>

            <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] p-4">
              <p className="font-semibold text-[var(--ds-color-text-primary)]">
                Fila de investigação
              </p>
              <div className="mt-3 space-y-3 text-sm">
                {observabilityAlertsLoading ? (
                  <InlineLoadingState label="Carregando fila sugerida" />
                ) : observabilityAlerts?.investigationQueue.length ? (
                  observabilityAlerts.investigationQueue.map((item) => (
                    <div
                      key={item.documentRef}
                      className="rounded-[var(--ds-radius-sm)] border border-[var(--ds-color-border-subtle)] px-3 py-3"
                    >
                      <p className="font-medium text-[var(--ds-color-text-primary)]">
                        {item.documentRef}
                      </p>
                      <p className="mt-1 text-[var(--ds-color-text-secondary)]">
                        Suspeitas: {item.suspicious} • Bloqueios: {item.blocked}
                      </p>
                      <p className="mt-1 text-xs text-[var(--ds-color-text-muted)]">
                        Último evento:{" "}
                        {item.lastSeenAt
                          ? safeFormatDate(
                              item.lastSeenAt,
                              "dd/MM/yyyy HH:mm",
                              {
                                locale: ptBR,
                              },
                            )
                          : "sem data"}
                      </p>
                    </div>
                  ))
                ) : (
                  <EmptyState
                    title="Fila vazia"
                    description="Não há documentos DDS sugeridos para investigação manual."
                    compact
                  />
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card tone="default" padding="none">
        <CardHeader className="gap-4 border-b border-[var(--ds-color-border-subtle)] bg-[linear-gradient(180deg,rgba(15,23,42,0.02),rgba(15,23,42,0))] px-5 py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Folder className="h-4 w-4 text-[var(--ds-color-action-primary)]" />
              <CardTitle>Arquivos DDS (Storage)</CardTitle>
            </div>
            <CardDescription>
              PDFs salvos automaticamente por empresa, obra, ano e semana operacional.
            </CardDescription>
          </div>
          <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/80 p-3 shadow-[var(--ds-shadow-sm)]">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
              <select
                value={fileCompanyId}
                onChange={(event) => setFileCompanyId(event.target.value)}
                className={inputClassName}
                aria-label="Filtro empresa"
              >
                <option value="">Todas empresas</option>
                {companyOptions.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={2020}
                max={2100}
                placeholder="Ano"
                aria-label="Filtro por ano"
                value={fileYear}
                onChange={(event) => setFileYear(event.target.value)}
                className={inputClassName}
              />
              <input
                type="number"
                min={1}
                max={53}
                placeholder="Semana ISO"
                aria-label="Filtro por semana ISO"
                value={fileWeek}
                onChange={(event) => setFileWeek(event.target.value)}
                className={inputClassName}
              />
              <select
                value={filesPageSize}
                onChange={(event) => setFilesPageSize(Number(event.target.value))}
                className={inputClassName}
                aria-label="Itens por página"
              >
                <option value={10}>10 / página</option>
                <option value={25}>25 / página</option>
                <option value={50}>50 / página</option>
              </select>
              <div className="flex flex-wrap gap-2 sm:col-span-2 xl:col-span-1">
                <Button
                  type="button"
                  variant="outline"
                  leftIcon={
                    <FileSpreadsheet className="h-4 w-4 text-[var(--ds-color-success)]" />
                  }
                  onClick={handleExportStoredFilesCsv}
                >
                  Exportar CSV
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  leftIcon={<Download className="h-4 w-4" />}
                  onClick={handleDownloadWeeklyBundle}
                  disabled={!fileYear || !fileWeek}
                >
                  Baixar semana
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  leftIcon={<Printer className="h-4 w-4" />}
                  onClick={handlePrintWeeklyBundle}
                  disabled={!fileYear || !fileWeek}
                >
                  Imprimir semana
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="mt-0">
          {loadingFiles ? (
            <InlineLoadingState label="Carregando arquivos DDS armazenados" />
          ) : storedFiles.length === 0 ? (
            <EmptyState
              title="Nenhum PDF de DDS encontrado"
              description="Não há arquivos armazenados para o filtro aplicado."
              compact
            />
          ) : (
            <>
              <ResponsiveDataList
                items={pagedStoredFiles}
                getKey={(file) => `${file.ddsId}-${file.fileKey}`}
                mobileClassName="space-y-3"
                mobile={(file) => (
                  <article className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] p-4">
                    <h3 className="font-semibold text-[var(--ds-color-text-primary)]">{file.tema}</h3><p className="mt-1 text-sm text-[var(--ds-color-text-muted)]">{safeFormatDate(file.data, "dd/MM/yyyy", { locale: ptBR })} · {file.siteName || file.siteId || "Obra não identificada"}</p><p className="mt-2 break-all text-xs text-[var(--ds-color-text-secondary)]">{file.folderPath}/{file.originalName}</p>
                    <div className="mt-3 grid grid-cols-2 gap-2"><Button type="button" size="sm" variant="outline" onClick={() => handleDownloadStoredPdf(file.ddsId)} leftIcon={<Download className="h-4 w-4" />}>Baixar</Button><Button type="button" size="sm" variant="ghost" onClick={() => handleCopyPdfLink(file.ddsId)} leftIcon={<Link2 className="h-4 w-4" />}>Copiar link</Button></div>
                  </article>
                )}
                desktop={() => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Tema</TableHead>
                    <TableHead>Obra</TableHead>
                    <TableHead>Pasta</TableHead>
                    <TableHead>Arquivo</TableHead>
                    <TableHead>Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedStoredFiles.map((file) => (
                    <TableRow key={`${file.ddsId}-${file.fileKey}`}>
                      <TableCell>
                        {safeFormatDate(file.data, "dd/MM/yyyy", {
                          locale: ptBR,
                        })}
                      </TableCell>
                      <TableCell className="font-medium text-[var(--ds-color-text-primary)]">
                        {file.tema}
                      </TableCell>
                      <TableCell className="text-[var(--ds-color-text-secondary)]">
                        {file.siteName || file.siteId || "Obra não identificada"}
                      </TableCell>
                      <TableCell>
                        <div className="inline-flex items-center gap-2 rounded-[var(--ds-radius-sm)] bg-[color:var(--ds-color-surface-muted)]/45 px-2 py-1 text-xs text-[var(--ds-color-text-secondary)]">
                          <Folder className="h-3 w-3" />
                          <span>{file.folderPath}</span>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() =>
                              handleCopyFolderPath(file.folderPath)
                            }
                            aria-label="Copiar caminho da pasta"
                            title="Copiar caminho da pasta"
                            className="h-6 w-6"
                          >
                            <Copy className="h-3 w-3" aria-hidden="true" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="text-[var(--ds-color-text-secondary)]">
                        {file.originalName}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            leftIcon={<Download className="h-3.5 w-3.5" />}
                            onClick={() => handleDownloadStoredPdf(file.ddsId)}
                          >
                            Baixar
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            leftIcon={<Link2 className="h-3.5 w-3.5" />}
                            onClick={() => handleCopyPdfLink(file.ddsId)}
                            title="Copiar link do PDF"
                          >
                            Copiar link
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
                )}
              />

              <div className="mt-4 flex items-center justify-between text-sm text-[var(--ds-color-text-muted)]">
                <span>
                  Página{" "}
                  <span className="font-semibold text-[var(--ds-color-text-primary)]">
                    {filesPage}
                  </span>{" "}
                  de{" "}
                  <span className="font-semibold text-[var(--ds-color-text-primary)]">
                    {totalFilesPages}
                  </span>{" "}
                  • {storedFiles.length} arquivo(s)
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    leftIcon={<ChevronLeft className="h-4 w-4" />}
                    onClick={() =>
                      setFilesPage((current) => Math.max(1, current - 1))
                    }
                    disabled={filesPage <= 1}
                  >
                    Anterior
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    rightIcon={<ChevronRight className="h-4 w-4" />}
                    onClick={() =>
                      setFilesPage((current) =>
                        Math.min(totalFilesPages, current + 1),
                      )
                    }
                    disabled={filesPage >= totalFilesPages}
                  >
                    Próxima
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card id="registros-dds" tone="default" padding="none">
        <CardHeader className="gap-4 border-b border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/18 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <CardTitle>Registros de DDS</CardTitle>
              {refetching && <InlineLoadingState label="" />}
            </div>
            <CardDescription>
              {total} registro(s) encontrados com filtros por tema e tipo.
            </CardDescription>
          </div>
        </CardHeader>
        <div className="border-b border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/10 px-5 py-4">
          <div className="rounded-2xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/90 p-3 shadow-sm">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ds-color-text-muted)]">
                  Filtros operacionais
                </p>
                <p className="text-sm text-[var(--ds-color-text-secondary)]">
                  Ajuste a busca e reduza o escopo da lista antes de agir.
                </p>
              </div>
              {hasActiveDdsFilters ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={clearDdsFilters}
                >
                  Limpar filtros
                </Button>
              ) : null}
            </div>
            <div className="mb-3 flex flex-wrap gap-2">
              {activeDdsFilters.length ? (
                activeDdsFilters.map((filter) => (
                  <span
                    key={filter}
                    className="inline-flex items-center rounded-full border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/28 px-3 py-1 text-xs font-semibold text-[var(--ds-color-text-secondary)]"
                  >
                    {filter}
                  </span>
                ))
              ) : (
                <span className="inline-flex items-center rounded-full border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/18 px-3 py-1 text-xs font-semibold text-[var(--ds-color-text-muted)]">
                  Nenhum filtro adicional aplicado
                </span>
              )}
            </div>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(180px,0.8fr)_minmax(160px,0.8fr)]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
                <input
                  type="text"
                  placeholder="Pesquisar DDS"
                  aria-label="Pesquisar DDS"
                  className={cn(inputClassName, "pl-10")}
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
              </div>
              <select
                aria-label="Filtro de DDS"
                className={inputClassName}
                value={modelFilter}
                onChange={(event) =>
                  setModelFilter(
                    event.target.value as "all" | "model" | "regular",
                  )
                }
              >
                <option value="all">Todos</option>
                <option value="regular">Registros</option>
                <option value="model">Modelos</option>
              </select>
              <select
                aria-label="Filtro de status"
                className={inputClassName}
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(
                    event.target.value as
                      | "all"
                      | "rascunho"
                      | "publicado"
                      | "auditado"
                      | "arquivado",
                  )
                }
              >
                <option value="all">Todos os status</option>
                <option value="rascunho">Rascunho</option>
                <option value="publicado">Publicado</option>
                <option value="auditado">Auditado</option>
                <option value="arquivado">Arquivado</option>
              </select>
            </div>
          </div>
        </div>

        <CardContent className="mt-0">
          {ddsList.length === 0 ? (
            <EmptyState
              title="Nenhum DDS encontrado"
              description={
                hasActiveDdsFilters
                  ? "Nenhum resultado corresponde aos filtros aplicados."
                  : "Ainda não existem registros de DDS para este tenant."
              }
              action={
                canManageDds ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {hasActiveDdsFilters ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={clearDdsFilters}
                      >
                        Limpar filtros
                      </Button>
                    ) : null}
                    <Link
                      href="/dashboard/dds/new"
                      className={cn(buttonVariants(), "inline-flex items-center")}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Novo DDS
                    </Link>
                  </div>
                ) : hasActiveDdsFilters ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={clearDdsFilters}
                  >
                    Limpar filtros
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ResponsiveDataList
              items={ddsList}
              getKey={(dds) => dds.id}
              mobileClassName="space-y-3 p-3"
              mobile={(dds) => {
                const status = getEffectiveStatus(dds);
                const locked = Boolean(dds.pdf_file_key) || status === "auditado" || status === "arquivado";
                const transitions = getAllowedStatusTransitions(dds);
                const participantCount = getDdsParticipantCount(dds);
                const actions = getDdsActionPolicy({
                  canManage: canManageDds,
                  hasFinalPdf: Boolean(dds.pdf_file_key),
                  status,
                  isModel: Boolean(dds.is_modelo),
                  participantCount,
                  hasStatusTransitions: transitions.length > 0,
                });
                return (
                  <article className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-[var(--ds-color-text-primary)]">{dds.tema}</h3><p className="mt-1 text-sm text-[var(--ds-color-text-muted)]">{safeFormatDate(dds.data, "dd/MM/yyyy", { locale: ptBR })} · {dds.is_modelo ? "Modelo" : "DDS padrão"}</p></div><span className={cn("shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold", DDS_STATUS_COLORS[status])}>{DDS_STATUS_LABEL[status]}</span></div>
                    <p className="mt-3 text-sm"><Users className="mr-1 inline h-4 w-4" />{participantCount} participantes</p>
                    {actions.canChangeStatus ? <select aria-label={`Mover status de ${dds.tema}`} className={cn(inputClassName, "mt-3")} value="" onChange={(event) => event.target.value && void handleStatusChange(dds, event.target.value as DdsStatus)}><option value="">Mover para...</option>{transitions.map((nextStatus) => <option key={nextStatus} value={nextStatus}>{DDS_STATUS_LABEL[nextStatus]}</option>)}</select> : null}
                    <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3"><Button type="button" size="sm" variant="outline" onClick={() => handleOpenGovernedPdf(dds)} disabled={!actions.canOpenOrEmitFinalPdf} leftIcon={<ShieldCheck className="h-4 w-4" />}>{dds.pdf_file_key ? "Abrir PDF final" : "Emitir PDF final"}</Button><Button type="button" size="sm" variant="outline" onClick={() => handlePrint(dds)} leftIcon={<Printer className="h-4 w-4" />}>Imprimir</Button><Button type="button" size="sm" variant="outline" onClick={() => handleEmail(dds)} leftIcon={<Mail className="h-4 w-4" />}>Enviar</Button>{actions.canCopySignatureLinks ? <Button type="button" size="sm" variant="outline" onClick={() => handleCopySignatureLinks(dds)} disabled={issuingSignatureLinksId === dds.id} leftIcon={<Link2 className="h-4 w-4" />}>Links de assinatura</Button> : null}{actions.canOperationalizeModel ? <Button type="button" size="sm" variant="outline" onClick={() => handleOperationalize(dds)} leftIcon={<Copy className="h-4 w-4" />}>Operacionalizar</Button> : null}{actions.canEdit && !locked ? <Link href={`/dashboard/dds/edit/${dds.id}`} className={cn(buttonVariants({ size: "sm", variant: "outline" }), "justify-center")}><Pencil className="mr-2 h-4 w-4" />Editar</Link> : null}{actions.canDelete ? <Button type="button" size="sm" variant="destructive" onClick={() => handleDelete(dds.id)} leftIcon={<Trash2 className="h-4 w-4" />}>Excluir</Button> : null}</div>
                  </article>
                );
              }}
              desktop={() => (
            <Table>
              <TableHeader>
                <TableRow className="bg-[color:var(--ds-color-surface-muted)]/40">
                  <TableHead>Data</TableHead>
                  <TableHead>Tema</TableHead>
                  <TableHead>Participantes</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              {/* Skeleton de carregamento durante refetch — preserva layout sem flash branco */}
              {refetching && ddsList.length > 0 ? (
                <TableBody aria-busy="true" aria-label="Atualizando lista de DDS">
                  {Array.from({ length: Math.min(ddsList.length, 5) }).map((_, i) => (
                    <TableRow key={`skeleton-${i}`} className="animate-pulse">
                      <TableCell><div className="h-4 w-20 rounded bg-[var(--ds-color-surface-muted)]" /></TableCell>
                      <TableCell><div className="h-4 w-48 rounded bg-[var(--ds-color-surface-muted)]" /></TableCell>
                      <TableCell><div className="h-4 w-10 rounded bg-[var(--ds-color-surface-muted)]" /></TableCell>
                      <TableCell><div className="h-5 w-24 rounded-full bg-[var(--ds-color-surface-muted)]" /></TableCell>
                      <TableCell className="text-right"><div className="ml-auto h-7 w-28 rounded bg-[var(--ds-color-surface-muted)]" /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              ) : (
              <TableBody>
                {ddsList.map((dds) => {
                  const currentStatus = getEffectiveStatus(dds);
                  const transitions = getAllowedStatusTransitions(dds);
                  const participantCount = getDdsParticipantCount(dds);
                  const isLockedByFinalPdf = Boolean(dds.pdf_file_key);
                  const isWorkflowLocked =
                    isLockedByFinalPdf ||
                    currentStatus === "auditado" ||
                    currentStatus === "arquivado";
                  const actions = getDdsActionPolicy({
                    canManage: canManageDds,
                    hasFinalPdf: isLockedByFinalPdf,
                    status: currentStatus,
                    isModel: Boolean(dds.is_modelo),
                    participantCount,
                    hasStatusTransitions: transitions.length > 0,
                  });
                  return (
                    <TableRow
                      key={dds.id}
                      className="group transition-colors hover:bg-[color:var(--ds-color-surface-muted)]/35"
                    >
                      <TableCell>
                        <div className="space-y-1">
                          <p className="font-medium text-[var(--ds-color-text-primary)]">
                            {safeFormatDate(dds.data, "dd/MM/yyyy", {
                              locale: ptBR,
                            })}
                          </p>
                          <p className="text-xs text-[var(--ds-color-text-muted)]">
                            {dds.is_modelo ? "Modelo operacional" : "Registro operacional"}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="font-medium text-[var(--ds-color-text-primary)]">
                            {dds.tema}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {dds.is_modelo ? (
                              <span className="rounded-full bg-[color:var(--ds-color-action-primary)]/12 px-2.5 py-1 text-xs font-semibold text-[var(--ds-color-action-primary)]">
                                Modelo
                              </span>
                            ) : (
                              <span className="rounded-full bg-[color:var(--ds-color-text-muted)]/8 px-2.5 py-1 text-xs font-semibold text-[var(--ds-color-text-muted)]">
                                DDS padrão
                              </span>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-[var(--ds-color-text-secondary)]">
                          <Users className="h-4 w-4" />
                          <span className="font-medium text-[var(--ds-color-text-primary)]">
                            {participantCount}
                          </span>
                          <span>participantes</span>
                          {/* Indicadores de governança: PDF emitido e fluxo aprovado */}
                          {dds.pdf_file_key ? (
                            <span
                              title="PDF final emitido"
                              className="ml-1 inline-flex items-center rounded-full bg-[color:var(--ds-color-action-primary)]/12 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--ds-color-action-primary)]"
                            >
                              PDF
                            </span>
                          ) : null}
                          {dds.status === "auditado" ? (
                            <span
                              title="Fluxo de aprovação concluído"
                              className="ml-1 inline-flex items-center rounded-full bg-[color:var(--ds-color-success-muted)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--ds-color-success-default)]"
                            >
                              ✓
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                              DDS_STATUS_COLORS[currentStatus],
                            )}
                          >
                            {DDS_STATUS_LABEL[currentStatus]}
                          </span>
                          {actions.canChangeStatus && (
                            <select
                              aria-label="Mover status"
                              className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-2 py-1 text-xs text-[var(--ds-color-text-muted)] motion-safe:transition-colors hover:border-[var(--ds-color-border-strong)] focus:outline-none"
                              value=""
                              onChange={(e) => {
                                if (e.target.value)
                                  handleStatusChange(
                                    dds,
                                    e.target.value as DdsStatus,
                                  );
                              }}
                            >
                              <option value="">Mover para...</option>
                              {transitions.map((s) => (
                                <option key={s} value={s}>
                                  {DDS_STATUS_LABEL[s]}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => handleOpenGovernedPdf(dds)}
                            title={
                              dds.pdf_file_key
                                ? "Abrir PDF final governado"
                                : currentStatus !== "auditado"
                                  ? "Conclua a aprovação do DDS antes de emitir o PDF final"
                                  : canManageDds
                                    ? "Emitir PDF final governado"
                                    : "Somente usuários com gestão podem emitir o PDF final"
                            }
                            disabled={!actions.canOpenOrEmitFinalPdf}
                          >
                            <ShieldCheck className="h-4 w-4 text-[var(--ds-color-success)]" />
                          </Button>
                          {canManageDds ? (
                            <Link
                              href={`/dashboard/dds/edit/${dds.id}`}
                              aria-disabled={isWorkflowLocked || undefined}
                              className={cn(
                                buttonVariants({
                                  size: "icon",
                                  variant: "ghost",
                                }),
                                isWorkflowLocked
                                  ? "cursor-not-allowed opacity-45"
                                  : "",
                              )}
                              title={
                                isLockedByFinalPdf
                                  ? "DDS com PDF final emitido: edição bloqueada"
                                  : currentStatus === "auditado"
                                    ? "DDS auditado: edição bloqueada"
                                    : currentStatus === "arquivado"
                                      ? "DDS arquivado: edição bloqueada"
                                      : "Editar DDS"
                              }
                              onClick={(event) => {
                                if (isWorkflowLocked) {
                                  event.preventDefault();
                                  toast.error(
                                    isLockedByFinalPdf
                                      ? "DDS com PDF final emitido. Gere um novo DDS para alterações."
                                      : currentStatus === "auditado"
                                        ? "DDS auditado. Gere um novo DDS para um novo ciclo operacional."
                                        : "DDS arquivado. Gere um novo DDS para retomar o fluxo.",
                                  );
                                }
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Link>
                          ) : null}
                          <ActionMenu
                            triggerAriaLabel={`Ações do DDS ${dds.tema}`}
                            items={[
                              {
                                label: "Imprimir",
                                icon: <Printer className="h-4 w-4" />,
                                onClick: () => handlePrint(dds),
                              },
                              {
                                label: "Enviar por e-mail",
                                icon: <Mail className="h-4 w-4" />,
                                onClick: () => handleEmail(dds),
                              },
                              {
                                label: "Copiar links de assinatura",
                                icon: <Link2 className="h-4 w-4" />,
                                onClick: () => handleCopySignatureLinks(dds),
                                disabled:
                                  !actions.canCopySignatureLinks ||
                                  issuingSignatureLinksId === dds.id,
                                title:
                                  dds.is_modelo
                                    ? "Modelos não recebem link público de assinatura"
                                    : dds.pdf_file_key
                                      ? "DDS com PDF final emitido não recebe novas assinaturas"
                                      : currentStatus === "arquivado"
                                        ? "DDS arquivado não recebe link público de assinatura"
                                        : participantCount === 0
                                          ? "Adicione participantes antes de gerar links"
                                          : "Gerar e copiar links públicos de assinatura",
                              },
                              ...(actions.canOperationalizeModel
                                ? [
                                    {
                                      label: "Operacionalizar modelo",
                                      icon: (
                                        <Copy className="h-4 w-4 text-[var(--ds-color-action-success)]" />
                                      ),
                                      onClick: () => handleOperationalize(dds),
                                    },
                                  ]
                                : []),
                              ...(canManageDds
                                ? [
                                    {
                                      label: "Excluir",
                                      icon: (
                                        <Trash2 className="h-4 w-4" />
                                      ),
                                      onClick: () => handleDelete(dds.id),
                                      variant: "danger" as const,
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              )}
            </Table>
              )}
            />
          )}
        </CardContent>
        {!loading && total > 0 ? (
          <PaginationControls
            page={page}
            lastPage={lastPage}
            total={total}
            onPrev={handlePrevPage}
            onNext={handleNextPage}
          />
        ) : null}
      </Card>

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

      <ConfirmModal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => void confirmDelete()}
        title="Excluir DDS"
        description="Esta ação é irreversível. O DDS e todos os dados associados serão removidos permanentemente."
        confirmLabel="Excluir"
        loading={deleteLoading}
      />

      <ConfirmModal
        open={!!operationalizeTarget}
        onClose={() => setOperationalizeTarget(null)}
        onConfirm={() => void confirmOperationalize()}
        title="Operacionalizar modelo"
        description={`Criar novo DDS com base no modelo "${operationalizeTarget?.tema ?? ''}"? Um novo registro será gerado com os mesmos participantes e conteúdo.`}
        confirmLabel="Criar DDS"
        danger={false}
      />
    </div>
  );
}
