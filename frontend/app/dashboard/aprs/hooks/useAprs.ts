'use client';
import { logger } from "@/lib/logger";

import { useState, useEffect, useCallback, useDeferredValue, useRef } from "react";
import { isAxiosError } from "axios";
import { aprsService, Apr } from "@/services/aprsService";
import { aiService } from "@/services/aiService";
import { signaturesService } from "@/services/signaturesService";
import { toast } from "sonner";
import { handleApiError } from "@/lib/error-handler";
import { openPdfForPrint, openUrlInNewTab } from "@/lib/print-utils";
import { isAiEnabled, isAprAnalyticsEnabled } from "@/lib/featureFlags";
import { base64ToPdfBlob } from "@/lib/pdf/pdfFile";
import { AprDueFilter, AprSortOption } from "../components/aprListingUtils";
import { selectedTenantStore } from "@/lib/selectedTenantStore";
import { siteStore } from "@/lib/siteStore";
import { resolveActiveCompanyId } from "@/lib/tenant-context";
import { queryKeys } from "@/lib/query-keys";

type AprContextFilter = "minhas" | "vence-hoje" | "preciso-assinar" | "";

interface Insight {
  type: "warning" | "success" | "info";
  title: string;
  message: string;
  action: string;
}

type AprOverviewMetrics = {
  totalAprs: number;
  aprovadas: number;
  pendentes: number;
  riscosCriticos: number;
  mediaScoreRisco: number;
};

type UseAprsOptions = {
  initialSearchTerm?: string;
  initialStatusFilter?: string;
  initialSiteFilter?: string;
  initialResponsibleFilter?: string;
  initialDueFilter?: AprDueFilter;
  initialSortBy?: AprSortOption;
  initialPage?: number;
  initialContextFilter?: AprContextFilter;
};

type AprActionKind =
  | "delete"
  | "approve"
  | "reject"
  | "finalize"
  | "create_new_version";

type AprActionModalState = {
  isOpen: boolean;
  action: AprActionKind;
  aprId: string;
  aprSummary: Pick<Apr, "numero" | "titulo" | "status">;
  loading: boolean;
};

function isOptionalFeatureUnavailable(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  const status = error.response?.status;
  // 403 = feature desabilitada por flag; 404 = endpoint não existe (versão antiga)
  return status === 403 || status === 404;
}

function resolveLoadError(error: unknown): string {
  if (!isAxiosError(error)) {
    return "Erro inesperado ao carregar APRs. Recarregue a página e tente novamente.";
  }
  const status = error.response?.status;
  if (status === 401) {
    return "Sessão expirada. Faça login novamente para acessar as APRs.";
  }
  if (status === 403) {
    return "Você não tem permissão para visualizar APRs neste contexto.";
  }
  if (status === 429) {
    return "Muitas requisições em pouco tempo. Aguarde alguns segundos e tente novamente.";
  }
  if (status && status >= 500) {
    return "O servidor encontrou um erro interno. Tente novamente em instantes.";
  }
  if (!error.response) {
    return "Sem conexão com o servidor. Verifique sua internet e tente novamente.";
  }
  return "Não foi possível carregar as APRs. Verifique a conexão e tente novamente.";
}

async function loadAprPdfGenerator() {
  return import("@/lib/pdf/aprGenerator");
}

export function useAprs(options?: UseAprsOptions) {
  const [aprs, setAprs] = useState<Apr[]>([]);
  const aprsCountRef = useRef(0);
  aprsCountRef.current = aprs.length;
  const [loading, setLoading] = useState(true);
  const [refetching, setRefetching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const activeRequestIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const lastAppliedContextRef = useRef<{ companyId?: string; siteId?: string; key?: string } | null>(null);
  const [overviewMetrics, setOverviewMetrics] =
    useState<AprOverviewMetrics | null>(null);
  const [searchTerm, setSearchTerm] = useState(
    options?.initialSearchTerm || "",
  );
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [statusFilter, setStatusFilter] = useState(
    options?.initialStatusFilter || "",
  );
  const [siteFilter, setSiteFilter] = useState(
    options?.initialSiteFilter || "",
  );
  const [responsibleFilter, setResponsibleFilter] = useState(
    options?.initialResponsibleFilter || "",
  );
  const [tenantContext, setTenantContext] = useState(() => ({
    companyId: resolveActiveCompanyId(),
    siteId: siteStore.get()?.siteId || undefined,
  }));
  const activeCompanyId = tenantContext.companyId;
  const activeSiteId = tenantContext.siteId;
  const [dueFilter, setDueFilter] = useState<AprDueFilter>(
    options?.initialDueFilter || "",
  );
  const [sortBy, setSortBy] = useState<AprSortOption>(
    options?.initialSortBy || "priority",
  );
  const [contextFilter, setContextFilter] = useState<AprContextFilter>(
    options?.initialContextFilter || "",
  );
  const [insights, setInsights] = useState<Insight[]>([]);
  const [page, setPage] = useState(options?.initialPage || 1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);

  // Estados para o modal de e-mail
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
  const [pendingActionById, setPendingActionById] = useState<
    Record<string, boolean>
  >({});
  const [actionModal, setActionModal] = useState<AprActionModalState | null>(
    null,
  );

  const buildAprFilename = useCallback(
    (apr: Apr) =>
      `APR_${String(apr.numero || apr.titulo || apr.id).replace(/\s+/g, "_")}.pdf`,
    [],
  );

  const loadAprs = useCallback(async () => {
    const companyId = activeCompanyId;
    const siteId = activeSiteId;
    const requestId = ++activeRequestIdRef.current;

    // Achado real (auditoria v2, confirmado ao vivo em produção): siteId
    // vem do siteStore global ("obra ativa" do dashboard) — um seletor
    // totalmente opcional e separado, que a maioria dos usuários nunca usa
    // explicitamente. Exigi-lo aqui travava a fila de APRs inteira (0
    // resultados, sem erro visível) para qualquer usuário sem uma obra
    // ativa selecionada, mesmo com APRs reais cadastradas na empresa. O
    // backend já trata site_id como filtro opcional (`?site_id=` filtra por
    // obra quando presente); só companyId é realmente necessário.
    if (!companyId) {
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      lastAppliedContextRef.current = null;
      setAprs([]);
      setTotal(0);
      setLastPage(1);
      setLoadError(null);
      setLoading(false);
      setRefetching(false);
      return;
    }

    const controller = new AbortController();
    activeControllerRef.current?.abort();
    activeControllerRef.current = controller;

    const requestFilters = {
      page,
      limit,
      search: deferredSearchTerm || undefined,
      status: statusFilter || undefined,
      responsibleId: responsibleFilter || undefined,
      dueFilter: dueFilter || undefined,
      sort: sortBy,
      contextFilter: contextFilter || undefined,
    };
    const requestKey = JSON.stringify(
      queryKeys.aprs.list({
        companyId,
        siteId,
        ...requestFilters,
      }),
    );

    try {
      setLoading((prev) => {
        setRefetching(aprsCountRef.current > 0 && !prev);
        return true;
      });
      setLoadError(null);

      const res = await aprsService.findPaginated({
        ...requestFilters,
        companyId,
        siteId,
        signal: controller.signal,
      });

      if (controller.signal.aborted) {
        return;
      }

      const latestContext = {
        companyId,
        siteId,
        key: requestKey,
      };

      if (
        requestId !== activeRequestIdRef.current ||
        controller.signal.aborted ||
        resolveActiveCompanyId() !== companyId ||
        siteStore.get()?.siteId !== siteId ||
        lastAppliedContextRef.current?.key === latestContext.key
      ) {
        return;
      }

      lastAppliedContextRef.current = latestContext;
      setAprs(res.data);
      setTotal(res.total);
      setLastPage(res.lastPage);
    } catch (error) {
      const cancelled = controller.signal.aborted || (isAxiosError(error) && error.code === "ERR_CANCELED");
      if (!cancelled && requestId === activeRequestIdRef.current) {
        setLoadError(resolveLoadError(error));
      }
    } finally {
      if (requestId === activeRequestIdRef.current) {
        setLoading(false);
        setRefetching(false);
      }
    }
  }, [
    activeCompanyId,
    activeSiteId,
    page,
    limit,
    deferredSearchTerm,
    statusFilter,
    responsibleFilter,
    dueFilter,
    sortBy,
    contextFilter,
  ]);

  const loadOverview = useCallback(async () => {
    if (!isAprAnalyticsEnabled()) {
      setOverviewMetrics(null);
      return;
    }

    try {
      const analytics = await aprsService
        .getAnalyticsOverview()
        .catch((error) => {
          if (isOptionalFeatureUnavailable(error)) {
            return null;
          }
          throw error;
        });
      setOverviewMetrics(analytics);
    } catch (error) {
      logger.error('Erro ao carregar overview analítico de APRs:', error);
      setOverviewMetrics(null);
    }
  }, []);

useEffect(() => {
    setPage(1);
  }, [
    deferredSearchTerm,
    statusFilter,
    siteFilter,
    responsibleFilter,
    dueFilter,
    sortBy,
    contextFilter,
  ]);

  const loadInsights = useCallback(async () => {
    if (!isAiEnabled()) return;
    try {
      const result = await aiService.getInsights();
      const aprInsights = result.insights.filter(
        (i: Insight) =>
          i.action.includes("/aprs") || i.title.toLowerCase().includes("apr"),
      );
      setInsights(aprInsights);
    } catch (error) {
      if (isOptionalFeatureUnavailable(error)) {
        setInsights([]);
        return;
      }
      logger.error("Erro ao carregar insights:", error);
    }
  }, []);

  useEffect(() => {
    const unsubscribeTenant = selectedTenantStore.subscribe((tenant) => {
      const nextCompanyId = tenant?.companyId || resolveActiveCompanyId();
      const nextSiteId = siteStore.get()?.siteId || undefined;
      setTenantContext({ companyId: nextCompanyId, siteId: nextSiteId });
      activeControllerRef.current?.abort();
      activeRequestIdRef.current += 1;
      lastAppliedContextRef.current = null;
      setAprs([]);
      setTotal(0);
      setLastPage(1);
      setLoadError(null);
      setLoading(Boolean(nextCompanyId));
      setRefetching(false);
      if (!nextCompanyId) {
        return;
      }
    });

    const unsubscribeSite = siteStore.subscribe((site) => {
      const nextCompanyId = resolveActiveCompanyId();
      const nextSiteId = site?.siteId || undefined;
      setTenantContext({ companyId: nextCompanyId, siteId: nextSiteId });
      activeControllerRef.current?.abort();
      activeRequestIdRef.current += 1;
      lastAppliedContextRef.current = null;
      setAprs([]);
      setTotal(0);
      setLastPage(1);
      setLoadError(null);
      setLoading(Boolean(nextCompanyId));
      setRefetching(false);
    });

    loadAprs();
    return () => {
      unsubscribeTenant();
      unsubscribeSite();
      activeControllerRef.current?.abort();
    };
  }, [loadAprs]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    loadInsights();
  }, [loadInsights]);

  const ensureGovernedPdf = useCallback(
    async (apr: Apr) => {
      const access = await aprsService.getPdfAccess(apr.id);
      if (access.hasFinalPdf) {
        return access;
      }

      if (apr.status !== "Aprovada") {
        return null;
      }

      const generatedAccess = await aprsService.generateFinalPdf(apr.id);
      if (generatedAccess.generated) {
        await loadAprs();
        toast.success("PDF final da APR emitido e registrado com sucesso.");
      }
      return generatedAccess;
    },
    [loadAprs],
  );

  const generateLocalAprPdfBase64 = useCallback(
    async (aprId: string, draftWatermark: boolean) => {
      const [fullApr, signatures, evidences] = await Promise.all([
        aprsService.findOne(aprId),
        signaturesService.findByDocument(aprId, 'APR'),
        aprsService.listAprEvidences(aprId),
      ]);
      const { generateAprPdf } = await loadAprPdfGenerator();
      const result = (await generateAprPdf(fullApr, signatures, {
        save: false,
        output: 'base64',
        evidences,
        draftWatermark,
      })) as { base64: string } | undefined;

      if (!result?.base64) {
        throw new Error('Falha ao gerar o PDF da APR.');
      }

      return result.base64;
    },
    [],
  );

  const openActionModal = useCallback(
    (action: AprActionKind, id: string) => {
      if (pendingActionById[id]) return;
      const apr = aprs.find((item) => item.id === id);
      if (!apr) return;
      setActionModal({
        isOpen: true,
        action,
        aprId: id,
        aprSummary: {
          numero: apr.numero,
          titulo: apr.titulo,
          status: apr.status,
        },
        loading: false,
      });
    },
    [aprs, pendingActionById],
  );

  const closeActionModal = useCallback(() => {
    setActionModal(null);
  }, []);

  const handleDownloadPdf = useCallback(
    async (id: string) => {
      try {
        const apr =
          aprs.find((item) => item.id === id) ||
          (await aprsService.findOne(id));
        const shouldUseGovernedPdf =
          Boolean(apr.has_final_pdf) || apr.status === "Aprovada";

        if (shouldUseGovernedPdf) {
          const access = await ensureGovernedPdf(apr);
          if (access?.url) {
            openUrlInNewTab(access.url);
            return;
          }

          toast.warning(
            access?.message ||
              "O PDF final da APR existe, mas a URL segura não está disponível no momento. Tente novamente em instantes.",
          );
          return;
        }

        toast.warning(
          "O PDF final oficial ainda não foi gerado pelo sistema. Use a prévia apenas para conferência interna da APR.",
        );
      } catch (error) {
        handleApiError(error, "PDF");
      }
    },
    [aprs, ensureGovernedPdf],
  );

  const handlePrint = useCallback(
    async (apr: Apr) => {
      try {
        toast.info("Preparando impressão...");
        const currentApr =
          aprs.find((item) => item.id === apr.id) ||
          (await aprsService.findOne(apr.id));
        const shouldUseGovernedPdf =
          Boolean(currentApr.has_final_pdf) || currentApr.status === "Aprovada";

        if (shouldUseGovernedPdf) {
          const access = await ensureGovernedPdf(currentApr);
          if (access?.url) {
            openPdfForPrint(access.url, () => {
              toast.info(
                "Pop-up bloqueado. Abrimos o PDF final da APR na mesma aba para impressão.",
              );
            });
            return;
          }

          toast.warning(
            access?.message ||
              "O PDF final da APR foi emitido, mas a URL segura não está disponível agora. Tente novamente em instantes.",
          );
          return;
        }

        const base64 = await generateLocalAprPdfBase64(apr.id, true);

        const fileURL = URL.createObjectURL(base64ToPdfBlob(base64));
        openPdfForPrint(fileURL, () => {
          toast.info(
            "Pop-up bloqueado. Abrimos o PDF na mesma aba para impressão.",
          );
        });
        setTimeout(() => URL.revokeObjectURL(fileURL), 60_000);
      } catch (error) {
        handleApiError(error, "Impressão");
      }
    },
    [aprs, ensureGovernedPdf, generateLocalAprPdfBase64],
  );

  const handleSendEmail = useCallback(
    async (id: string) => {
      try {
        toast.info("Preparando documento...");
        const apr =
          aprs.find((item) => item.id === id) ||
          (await aprsService.findOne(id));
        const shouldUseGovernedPdf =
          Boolean(apr.has_final_pdf) || apr.status === "Aprovada";

        if (shouldUseGovernedPdf) {
          const access = await ensureGovernedPdf(apr);
          if (access?.hasFinalPdf) {
            if (access.message) {
              toast.info(
                `${access.message} O envio oficial continuará usando o PDF final governado da APR.`,
              );
            }
            setSelectedDoc({
              name: apr.titulo,
              filename: access.originalName || buildAprFilename(apr),
              storedDocument: {
                documentId: apr.id,
                documentType: "APR",
              },
            });
            setIsMailModalOpen(true);
            return;
          }

          if (apr.status === "Aprovada") {
            toast.warning(
              access?.message ||
                "O PDF final da APR foi emitido, mas a URL segura não está disponível agora.",
            );
            return;
          }
        }

        toast.warning(
          "O PDF final oficial ainda não foi gerado pelo sistema. O envio externo só é permitido com PDF final governado.",
        );
      } catch (error) {
        handleApiError(error, "Email");
      }
    },
    [aprs, buildAprFilename, ensureGovernedPdf],
  );

  // Filtering is now server-side — aprs already contains the filtered page
  const filteredAprs = aprs;

  const confirmActionModal = useCallback(
    async (reason?: string) => {
      if (!actionModal) return;
      const { action, aprId } = actionModal;
      setActionModal((prev) => (prev ? { ...prev, loading: true } : prev));
      setPendingActionById((prev) => ({ ...prev, [aprId]: true }));

      try {
        if (action === "delete") {
          await aprsService.delete(aprId);
          setAprs((prev) => prev.filter((item) => item.id !== aprId));
          toast.success("APR excluída com sucesso!");
        } else if (action === "approve") {
          const updated = await aprsService.approve(aprId);
          setAprs((prev) =>
            prev.map((item) => (item.id === updated.id ? updated : item)),
          );
          const nextPendingStep =
            updated.approval_steps?.find((step) => step.status === "pending") ||
            null;
          toast.success(
            updated.status === "Aprovada"
              ? "APR aprovada com sucesso!"
              : nextPendingStep
                ? `Etapa aprovada. Próxima aprovação: ${nextPendingStep.title}.`
                : "Etapa de aprovação concluída.",
          );
        } else if (action === "reject") {
          const rejectReason = reason?.trim() || "";
          if (rejectReason.length < 10) {
            toast.error("Informe um motivo com pelo menos 10 caracteres.");
            setActionModal((prev) =>
              prev ? { ...prev, loading: false } : prev,
            );
            return;
          }
          const updated = await aprsService.reject(aprId, rejectReason);
          setAprs((prev) =>
            prev.map((item) => (item.id === updated.id ? updated : item)),
          );
          toast.success("APR reprovada.");
        } else if (action === "finalize") {
          const updated = await aprsService.finalize(aprId);
          setAprs((prev) =>
            prev.map((item) => (item.id === updated.id ? updated : item)),
          );
          toast.success("APR encerrada com sucesso!");
        } else {
          await aprsService.createNewVersion(aprId);
          toast.success("Nova versão criada.");
          await loadAprs();
        }
        setActionModal(null);
      } catch (error) {
        handleApiError(error, "APR");
        setActionModal((prev) => (prev ? { ...prev, loading: false } : prev));
      } finally {
        setPendingActionById((prev) => {
          const next = { ...prev };
          delete next[aprId];
          return next;
        });
      }
    },
    [actionModal, loadAprs],
  );

  const handleDelete = useCallback(
    (id: string) => {
      openActionModal("delete", id);
    },
    [openActionModal],
  );

  const handleApprove = useCallback(
    (id: string) => {
      openActionModal("approve", id);
    },
    [openActionModal],
  );

  const handleReject = useCallback(
    (id: string) => {
      openActionModal("reject", id);
    },
    [openActionModal],
  );

  const handleFinalize = useCallback(
    (id: string) => {
      openActionModal("finalize", id);
    },
    [openActionModal],
  );

  const handleCreateNewVersion = useCallback(
    (id: string) => {
      openActionModal("create_new_version", id);
    },
    [openActionModal],
  );

  return {
    aprs,
    loading,
    refetching,
    loadError,
    searchTerm,
    setSearchTerm,
    statusFilter,
    setStatusFilter,
    siteFilter,
    setSiteFilter,
    responsibleFilter,
    setResponsibleFilter,
    dueFilter,
    setDueFilter,
    sortBy,
    setSortBy,
    contextFilter,
    setContextFilter,
    insights,
    overviewMetrics,
    page,
    setPage,
    limit,
    total,
    lastPage,
    isMailModalOpen,
    setIsMailModalOpen,
    selectedDoc,
    setSelectedDoc,
    pendingActionById,
    actionModal,
    closeActionModal,
    confirmActionModal,
    filteredAprs,
    handleDelete,
    handleDownloadPdf,
    handlePrint,
    handleSendEmail,
    handleApprove,
    handleReject,
    handleFinalize,
    handleCreateNewVersion,
    loadAprs,
  };
}


