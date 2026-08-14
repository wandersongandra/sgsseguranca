"use client";
import { logger } from "@/lib/logger";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  FileWarning,
  Filter,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthContext";
import { selectedTenantStore } from "@/lib/selectedTenantStore";
import { companiesService, type Company } from "@/services/companiesService";
import { sitesService, type Site } from "@/services/sitesService";
import {
  dashboardService,
  type DashboardDocumentPendencyAllowedAction,
  type DashboardDocumentPendenciesResponse,
  type DashboardDocumentPendencyItem,
  type DocumentPendencyCriticality,
} from "@/services/dashboardService";
import { ListPageLayout } from "@/components/layout";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { ResponsiveDataList } from "@/components/ui/responsive-data-list";
import { cn } from "@/lib/utils";
import { extractApiErrorMessage } from "@/lib/error-handler";
import { safeFormatDate } from "@/lib/date/safeFormat";
import { safeExternalArtifactUrl } from "@/lib/security/safe-external-url";
import { safeInternalHref } from "@/lib/security/safe-internal-href";

const inputClassName =
  "min-h-11 w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]";

const criticalityOptions: Array<{
  value: DocumentPendencyCriticality;
  label: string;
}> = [
  { value: "critical", label: "Crítico" },
  { value: "high", label: "Alto" },
  { value: "medium", label: "Médio" },
  { value: "low", label: "Baixo" },
];

const moduleOptions = [
  { value: "apr", label: "APR" },
  { value: "pt", label: "PT" },
  { value: "dds", label: "DDS" },
  { value: "checklist", label: "Checklist" },
  { value: "rdo", label: "RDO" },
  { value: "cat", label: "CAT" },
  { value: "audit", label: "Auditoria" },
  { value: "nonconformity", label: "Não conformidade" },
  { value: "document-import", label: "Importação documental" },
];

type PendencyQueryFilters = {
  companyId: string;
  siteId: string;
  module: string;
  status: string;
  criticality: string;
  dateFrom: string;
  dateTo: string;
  page: number;
};

function getCriticalityBadgeVariant(criticality: DocumentPendencyCriticality) {
  switch (criticality) {
    case "critical":
      return "danger" as const;
    case "high":
      return "warning" as const;
    case "medium":
      return "info" as const;
    default:
      return "neutral" as const;
  }
}

function getTypeBadgeVariant(type: DashboardDocumentPendencyItem["type"]) {
  switch (type) {
    case "missing_final_pdf":
    case "failed_import":
      return "danger" as const;
    case "missing_required_signature":
    case "unavailable_governed_video":
      return "warning" as const;
    case "degraded_document_availability":
    case "unavailable_governed_attachment":
      return "info" as const;
    default:
      return "neutral" as const;
  }
}

function getActionButtonVariant(
  action: DashboardDocumentPendencyAllowedAction,
) {
  if (action.key === "retry_import") {
    return "secondary" as const;
  }

  if (
    action.key === "open_final_pdf" ||
    action.key === "open_governed_video" ||
    action.key === "open_governed_attachment"
  ) {
    return "outline" as const;
  }

  return "ghost" as const;
}

function formatRelevantDate(value: string | null) {
  if (!value) {
    return "Sem data operacional";
  }

  return safeFormatDate(value, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR }, "Data inválida");
}

export default function DocumentPendenciesPage() {
  const router = useRouter();
  const { isAdminGeral } = useAuth();
  const [data, setData] = useState<DashboardDocumentPendenciesResponse | null>(
    null,
  );
  const [companies, setCompanies] = useState<Company[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  const [loadingSites, setLoadingSites] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companySearch, setCompanySearch] = useState("");
  const [companyId, setCompanyId] = useState(
    () => selectedTenantStore.get()?.companyId || "",
  );
  const [siteId, setSiteId] = useState("");
  const [module, setModule] = useState("");
  const [status, setStatus] = useState("");
  const [criticality, setCriticality] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [runningActionId, setRunningActionId] = useState<string | null>(null);
  const deferredCompanySearch = useDeferredValue(companySearch);
  const requestSequenceRef = useRef(0);
  const queryFilters = useMemo<PendencyQueryFilters>(
    () => ({
      companyId,
      siteId,
      module,
      status,
      criticality,
      dateFrom,
      dateTo,
      page,
    }),
    [companyId, siteId, module, status, criticality, dateFrom, dateTo, page],
  );
  const deferredQueryFilters = useDeferredValue(queryFilters);

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, []);

  const handleNextPage = useCallback(() => {
    setPage((current) => {
      const lastAvailablePage = data?.pagination.lastPage ?? 1;
      return Math.min(lastAvailablePage, current + 1);
    });
  }, [data?.pagination.lastPage]);

  const loadCompanies = useCallback(async () => {
    if (!isAdminGeral) {
      setCompanies([]);
      return;
    }

    try {
      setLoadingCompanies(true);
      const response = await companiesService.findPaginated({
        page: 1,
        limit: 25,
        search: deferredCompanySearch.trim() || undefined,
      });
      setCompanies(response.data);
    } catch (loadError) {
      logger.error(
        "Erro ao carregar empresas da central documental:",
        loadError,
      );
      toast.error(
        await extractApiErrorMessage(
          loadError,
          "Não foi possível carregar as empresas disponíveis.",
        ),
      );
    } finally {
      setLoadingCompanies(false);
    }
  }, [deferredCompanySearch, isAdminGeral]);

  const loadSites = useCallback(async () => {
    if (!companyId) {
      setSites([]);
      setSiteId("");
      return;
    }

    try {
      setLoadingSites(true);
      const sitesPage = await sitesService.findPaginated({
        page: 1,
        limit: 100,
        companyId,
      });
      setSites(sitesPage.data);
      if (sitesPage.lastPage > 1) {
        toast.warning(
          "A lista de obras/setores foi limitada aos primeiros 100 registros.",
        );
      }
    } catch (loadError) {
      logger.error(
        "Erro ao carregar obras/setores da central documental:",
        loadError,
      );
      toast.error(
        await extractApiErrorMessage(
          loadError,
          "Não foi possível carregar obras e setores.",
        ),
      );
    } finally {
      setLoadingSites(false);
    }
  }, [companyId]);

  const loadPendencies = useCallback(async (filters: PendencyQueryFilters) => {
    const requestId = ++requestSequenceRef.current;
    const timeoutMs = 5000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('Timeout loading pendencies')),
        timeoutMs,
      );
    });
    try {
      setLoading(true);
      setError(null);
      const response = await Promise.race([
        dashboardService.getDocumentPendencies({
          ...(filters.companyId ? { companyId: filters.companyId } : {}),
          ...(filters.siteId ? { siteId: filters.siteId } : {}),
          ...(filters.module ? { module: filters.module } : {}),
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.criticality
            ? { criticality: filters.criticality as DocumentPendencyCriticality }
            : {}),
          ...(filters.dateFrom ? { dateFrom: filters.dateFrom } : {}),
          ...(filters.dateTo ? { dateTo: filters.dateTo } : {}),
          page: filters.page,
          limit: 20,
        }),
        timeoutPromise,
      ]);
      if (requestId === requestSequenceRef.current) {
        setData(response);
      }
    } catch (loadError) {
      if (requestId === requestSequenceRef.current) {
        logger.error(
          "Erro ao carregar central de pendências documentais:",
          loadError,
        );
        setError(
          await extractApiErrorMessage(
            loadError,
            "Não foi possível carregar a central de pendências documentais.",
          ),
        );
      }
    } finally {
      clearTimeout(timeoutId);
      if (requestId === requestSequenceRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadPendencies(deferredQueryFilters);
  }, [deferredQueryFilters, loadPendencies]);

  useEffect(() => {
    void loadCompanies();
  }, [loadCompanies]);

  useEffect(() => {
    void loadSites();
  }, [loadSites]);

  useEffect(() => {
    const unsubscribe = selectedTenantStore.subscribe((tenant) => {
      setCompanyId(tenant?.companyId || "");
      setSiteId("");
      setPage(1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const metrics = useMemo(() => {
    return [
      {
        label: "Pendências totais",
        value: data?.summary.total ?? 0,
        note: "Pendências operacionais no recorte aplicado.",
      },
      {
        label: "Críticas",
        value: data?.summary.byCriticality.critical ?? 0,
        note: "Impactam fechamento oficial ou conformidade imediata.",
        tone: "danger" as const,
      },
      {
        label: "Altas",
        value: data?.summary.byCriticality.high ?? 0,
        note: "Exigem ação prioritária da operação.",
        tone: "warning" as const,
      },
      {
        label: "Médias",
        value: data?.summary.byCriticality.medium ?? 0,
        note: "Precisam de acompanhamento antes do fechamento.",
        tone: "neutral" as const,
      },
    ];
  }, [data]);

  const topTypeCards = useMemo(
    () => (data?.summary.byType || []).slice(0, 6),
    [data],
  );

  const availableStatuses = useMemo(() => {
    const values = new Set<string>();
    for (const item of data?.items || []) {
      if (item.status) {
        values.add(item.status);
      }
    }
    return Array.from(values).sort((left, right) => left.localeCompare(right));
  }, [data]);

  const activeCompanyName = useMemo(() => {
    if (!companyId) {
      return isAdminGeral
        ? "Todas as empresas autorizadas"
        : selectedTenantStore.get()?.companyName || "Empresa atual";
    }
    return (
      companies.find((item) => item.id === companyId)?.razao_social ||
      selectedTenantStore.get()?.companyName ||
      "Empresa filtrada"
    );
  }, [companies, companyId, isAdminGeral]);

  const handleClearFilters = () => {
    setSiteId("");
    setModule("");
    setStatus("");
    setCriticality("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
    if (isAdminGeral) {
      setCompanyId(selectedTenantStore.get()?.companyId || "");
    }
  };

  const handleOperationalAction = useCallback(
    async (
      item: DashboardDocumentPendencyItem,
      action: DashboardDocumentPendencyAllowedAction,
    ) => {
      if (!action.enabled) {
        toast.error(action.reason || "Ação indisponível para esta pendência.");
        return;
      }

      const actionRunId = `${item.id}:${action.key}`;
      setRunningActionId(actionRunId);

      try {
        if (action.kind === "route" && action.href) {
          const safeHref =
            action.key === "open_public_validation"
              ? safeExternalArtifactUrl(action.href)
              : safeInternalHref(action.href);
          if (!safeHref) {
            toast.error("Link bloqueado pela política de segurança.");
            return;
          }

          if (action.key === "open_public_validation") {
            window.open(safeHref, "_blank", "noopener,noreferrer");
            return;
          }

          router.push(safeHref);
          return;
        }

        if (action.key === "retry_import") {
          if (!item.documentId) {
            throw new Error("Importação sem identificador válido para retry.");
          }

          const response = await dashboardService.retryDocumentPendencyImport(
            item.documentId,
          );
          toast.success(
            response?.message ||
              "Importação reenfileirada com sucesso para nova tentativa.",
          );
          await loadPendencies(queryFilters);
          return;
        }

        if (
          action.key === "open_final_pdf" ||
          action.key === "open_governed_video" ||
          action.key === "open_governed_attachment"
        ) {
          if (!item.documentId) {
            throw new Error(
              "Documento sem identificador válido para resolver o artefato oficial.",
            );
          }

          const resolved = await dashboardService.resolveDocumentPendencyAction(
            {
              actionKey: action.key,
              module: item.module,
              documentId: item.documentId,
              attachmentId:
                typeof item.metadata.attachmentId === "string"
                  ? item.metadata.attachmentId
                  : undefined,
              attachmentIndex:
                typeof item.metadata.attachmentIndex === "number"
                  ? item.metadata.attachmentIndex
                  : undefined,
            },
          );

          if (!resolved.url) {
            toast.error(
              resolved.message ||
                "O artefato oficial ainda não está disponível para abertura segura.",
            );
            await loadPendencies(queryFilters);
            return;
          }

          const safeResolvedUrl = safeExternalArtifactUrl(resolved.url);
          if (!safeResolvedUrl) {
            toast.error("Artefato bloqueado pela política de segurança.");
            return;
          }

          window.open(safeResolvedUrl, "_blank", "noopener,noreferrer");
          if (resolved.message) {
            toast.success(resolved.message);
          }
          return;
        }

        toast.error("Ação operacional ainda não suportada pela central.");
      } catch (actionError) {
        logger.error(
          "Erro ao executar ação operacional da pendência:",
          actionError,
        );
        const message = await extractApiErrorMessage(
          actionError,
          "Não foi possível concluir a ação operacional.",
        );
        toast.error(message);
      } finally {
        setRunningActionId((current) =>
          current === actionRunId ? null : current,
        );
      }
    },
    [loadPendencies, queryFilters, router],
  );

  if (error && !data) {
    return (
      <ErrorState
        title="Falha ao carregar central documental"
        description={error}
        action={
          <Button type="button" onClick={() => void loadPendencies(queryFilters)}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <ListPageLayout
      eyebrow="Operação documental"
      title="Central de pendências documentais"
      description="Visão centralizada do que está impedindo o fechamento operacional e a conformidade documental."
      icon={<ShieldAlert className="h-5 w-5" />}
      actions={
        <Button
          type="button"
          variant="outline"
          leftIcon={<RefreshCw className="h-4 w-4" />}
          onClick={() => void loadPendencies(queryFilters)}
          disabled={loading}
        >
          Atualizar
        </Button>
      }
      metrics={metrics}
      toolbarTitle="Filtro operacional"
      toolbarDescription={`Monitorando ${activeCompanyName}. Ajuste o recorte por empresa, site, módulo, criticidade e período.`}
      toolbarActions={
        <Button
          type="button"
          variant="ghost"
          leftIcon={<Filter className="h-4 w-4" />}
          onClick={handleClearFilters}
        >
          Limpar filtros
        </Button>
      }
      toolbarContent={
        <div className="grid w-full grid-cols-1 gap-3 xl:grid-cols-6">
          <div className="space-y-2 xl:col-span-2">
            {isAdminGeral ? (
              <>
                <input
                  type="text"
                  value={companySearch}
                  onChange={(event) => setCompanySearch(event.target.value)}
                  placeholder="Buscar empresa"
                  aria-label="Buscar empresa"
                  className={inputClassName}
                />
                <select
                  value={companyId}
                  onChange={(event) => {
                    setCompanyId(event.target.value);
                    setSiteId("");
                    setPage(1);
                  }}
                  className={inputClassName}
                >
                  <option value="">Todas as empresas</option>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.razao_social}
                    </option>
                  ))}
                </select>
                {loadingCompanies ? (
                  <p className="text-xs text-[var(--ds-color-text-muted)]">
                    Atualizando lista de empresas...
                  </p>
                ) : null}
              </>
            ) : (
              <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] px-3 py-3 text-sm text-[var(--ds-color-text-secondary)]">
                <p className="font-semibold text-[var(--ds-color-text-primary)]">
                  Empresa em foco
                </p>
                <p>{activeCompanyName}</p>
              </div>
            )}
          </div>

          <select
            value={siteId}
            onChange={(event) => {
              setSiteId(event.target.value);
              setPage(1);
            }}
            className={inputClassName}
            disabled={loadingSites || (!companyId && isAdminGeral)}
          >
            <option value="">Todos os sites</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.nome}
              </option>
            ))}
          </select>

          <select
            value={module}
            onChange={(event) => {
              setModule(event.target.value);
              setPage(1);
            }}
            className={inputClassName}
          >
            <option value="">Todos os módulos</option>
            {moduleOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <select
            value={criticality}
            onChange={(event) => {
              setCriticality(event.target.value);
              setPage(1);
            }}
            className={inputClassName}
          >
            <option value="">Todas as criticidades</option>
            {criticalityOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            className={inputClassName}
          >
            <option value="">Todos os status</option>
            {availableStatuses.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>

          <div className="grid grid-cols-2 gap-3 xl:col-span-2">
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => {
                setDateFrom(event.target.value);
                setPage(1);
              }}
              className={inputClassName}
            />
            <input
              type="date"
              value={dateTo}
              onChange={(event) => {
                setDateTo(event.target.value);
                setPage(1);
              }}
              className={inputClassName}
            />
          </div>
        </div>
      }
      footer={
        data ? (
          <PaginationControls
            page={data.pagination.page}
            lastPage={data.pagination.lastPage}
            total={data.pagination.total}
            onPrev={handlePrevPage}
            onNext={handleNextPage}
          />
        ) : null
      }
    >
      <div className="space-y-4">
        {data?.degraded ? (
          <div className="alert-warning rounded-[var(--ds-radius-lg)] px-4 py-3 text-sm">
            A central foi carregada com ressalvas. Fontes parcialmente
            indisponíveis: {data.failedSources.join(", ")}.
          </div>
        ) : null}

        {topTypeCards.length > 0 ? (
          <div className="grid gap-3 xl:grid-cols-3">
            {topTypeCards.map((item) => (
              <article
                key={item.type}
                className="card-enterprise flex items-start justify-between gap-3 p-4"
              >
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ds-color-text-muted)]">
                    Tipo de pendência
                  </p>
                  <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                    {item.label}
                  </h3>
                  <p className="text-xs text-[var(--ds-color-text-secondary)]">
                    Itens ativos no recorte atual.
                  </p>
                </div>
                <div className="rounded-[var(--ds-radius-lg)] bg-[var(--ds-color-surface-muted)] px-3 py-2 text-right">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ds-color-text-muted)]">
                    Total
                  </p>
                  <p className="text-2xl font-semibold text-[var(--ds-color-text-primary)]">
                    {item.total}
                  </p>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        {loading && !data ? (
          <InlineLoadingState label="Carregando central documental..." />
        ) : null}

        {loading && data ? (
          <InlineLoadingState label="Atualizando pendências documentais..." />
        ) : null}

        {!loading && !data?.items.length ? (
          <EmptyState
            title="Nenhuma pendência encontrada"
            description="O recorte atual não possui pendências documentais abertas. Ajuste os filtros se precisar ampliar a busca."
            icon={<FileWarning className="h-5 w-5" />}
          />
        ) : data ? (
          <ResponsiveDataList
            items={data.items}
            getKey={(item) => item.id}
            mobileClassName="space-y-3"
            mobile={(item) => {
              const actions = [...item.allowedActions];
              if (item.publicValidationUrl && !actions.some((action) => action.key === "open_public_validation")) actions.push({ key: "open_public_validation", label: "Validar documento", kind: "route", enabled: true, href: item.publicValidationUrl });
              return <article className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 shadow-sm">
                <div className="flex flex-wrap items-center gap-2"><Badge variant={getTypeBadgeVariant(item.type)}>{item.typeLabel}</Badge>{item.documentCode ? <Badge variant="neutral">{item.documentCode}</Badge> : null}<Badge variant={getCriticalityBadgeVariant(item.criticality)}>{criticalityOptions.find((option) => option.value === item.criticality)?.label || item.criticality}</Badge></div>
                <h3 className="mt-3 font-semibold">{item.title || "Documento sem título operacional"}</h3><p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">{item.message}</p>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Módulo</dt><dd>{item.moduleLabel}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Status</dt><dd>{item.status || "Sem status"}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Empresa / site</dt><dd>{item.companyName || item.companyId}<br />{item.siteName || "Sem site vinculado"}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Data relevante</dt><dd>{formatRelevantDate(item.relevantDate)}</dd></div></dl>
                <div className="mt-4 grid gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3">{actions.map((action) => {
                  const key = `${item.id}:${action.key}`;
                  const safeHref = action.key === "open_public_validation" ? safeExternalArtifactUrl(action.href) : safeInternalHref(action.href);
                  if (action.kind === "route" && safeHref && action.enabled) return <Link key={key} href={safeHref} target={action.key === "open_public_validation" ? "_blank" : undefined} rel={action.key === "open_public_validation" ? "noopener noreferrer" : undefined} className={cn(buttonVariants({ variant: getActionButtonVariant(action) }), "min-h-11 justify-center")}>{action.label}<ArrowUpRight className="ml-2 h-4 w-4" /></Link>;
                  return <Button key={key} type="button" className="min-h-11" variant={getActionButtonVariant(action)} loading={runningActionId === key} disabled={!action.enabled || runningActionId === key} title={action.reason || undefined} onClick={() => void handleOperationalAction(item, action)}>{action.label}</Button>;
                })}{actions.length === 0 ? <span className="text-sm text-[var(--ds-color-text-muted)]">Sem ação direta</span> : null}</div>
              </article>;
            }}
            desktop={() => <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pendência</TableHead>
                <TableHead>Módulo</TableHead>
                <TableHead>Empresa / site</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Criticidade</TableHead>
                <TableHead>Data relevante</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.items || []).map((item) => {
                const rowActions = [...item.allowedActions];
                const hasPublicValidationAction = rowActions.some(
                  (action) => action.key === "open_public_validation",
                );

                if (item.publicValidationUrl && !hasPublicValidationAction) {
                  rowActions.push({
                    key: "open_public_validation",
                    label: "Validar documento",
                    kind: "route",
                    enabled: true,
                    href: item.publicValidationUrl,
                  });
                }

                return (
                  <TableRow key={item.id}>
                    <TableCell className="align-top">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={getTypeBadgeVariant(item.type)}>
                            {item.typeLabel}
                          </Badge>
                          {item.documentCode ? (
                            <Badge variant="neutral">{item.documentCode}</Badge>
                          ) : null}
                        </div>
                        <div>
                          <p className="font-semibold text-[var(--ds-color-text-primary)]">
                            {item.title || "Documento sem título operacional"}
                          </p>
                          <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                            {item.message}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="space-y-2">
                        <Badge variant="info">{item.moduleLabel}</Badge>
                        <div className="text-xs text-[var(--ds-color-text-muted)]">
                          <p>
                            Disponibilidade: {item.availabilityStatus || "n/a"}
                          </p>
                          <p>Assinatura: {item.signatureStatus || "n/a"}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="space-y-1">
                        <p className="font-medium text-[var(--ds-color-text-primary)]">
                          {item.companyName || item.companyId}
                        </p>
                        <p className="text-sm text-[var(--ds-color-text-secondary)]">
                          {item.siteName || "Sem site vinculado"}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="space-y-1 text-sm">
                        <p className="font-medium text-[var(--ds-color-text-primary)]">
                          {item.status || "Sem status"}
                        </p>
                        <p className="text-[var(--ds-color-text-secondary)]">
                          {item.documentStatus || "Sem status documental"}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge
                        variant={getCriticalityBadgeVariant(item.criticality)}
                      >
                        {criticalityOptions.find(
                          (option) => option.value === item.criticality,
                        )?.label || item.criticality}
                      </Badge>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex items-start gap-2 text-sm text-[var(--ds-color-text-secondary)]">
                        <TriangleAlert className="mt-0.5 h-4 w-4 text-[var(--ds-color-warning)]" />
                        <span>{formatRelevantDate(item.relevantDate)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="align-top text-right">
                      {rowActions.length > 0 ? (
                        <div className="flex flex-wrap justify-end gap-2">
                          {rowActions.map((action) => {
                            const key = `${item.id}:${action.key}`;
                            const isRunning = runningActionId === key;
                            const safeRouteHref =
                              action.key === "open_public_validation"
                                ? safeExternalArtifactUrl(action.href)
                                : safeInternalHref(action.href);

                            if (
                              action.kind === "route" &&
                              safeRouteHref &&
                              action.enabled
                            ) {
                              const openInNewTab =
                                action.key === "open_public_validation";

                              return (
                                <Link
                                  key={key}
                                  href={safeRouteHref}
                                  target={openInNewTab ? "_blank" : undefined}
                                  rel={
                                    openInNewTab
                                      ? "noopener noreferrer"
                                      : undefined
                                  }
                                  className={cn(
                                    buttonVariants({
                                      variant: getActionButtonVariant(action),
                                      size: "sm",
                                    }),
                                    "inline-flex items-center gap-2 whitespace-nowrap",
                                  )}
                                >
                                  <span>{action.label}</span>
                                  <ArrowUpRight className="h-4 w-4" />
                                </Link>
                              );
                            }

                            return (
                              <Button
                                key={key}
                                type="button"
                                size="sm"
                                variant={getActionButtonVariant(action)}
                                loading={isRunning}
                                disabled={!action.enabled || isRunning}
                                title={action.reason || undefined}
                                leftIcon={
                                  action.key === "retry_import" ? (
                                    <RotateCcw className="h-4 w-4" />
                                  ) : (
                                    <ArrowUpRight className="h-4 w-4" />
                                  )
                                }
                                onClick={() =>
                                  void handleOperationalAction(item, action)
                                }
                              >
                                {action.label}
                              </Button>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-sm text-[var(--ds-color-text-muted)]">
                          Sem ação direta
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>}
          />
        ) : null}
      </div>
    </ListPageLayout>
  );
}
