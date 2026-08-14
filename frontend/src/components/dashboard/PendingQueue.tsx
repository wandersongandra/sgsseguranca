"use client";

import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { differenceInDays, format, isToday, isTomorrow, startOfDay, subDays } from "date-fns";
import { ptBR } from "date-fns/locale";
import Link from "next/link";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  ChevronDown,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useDashboardData, type PendingQueueFilters as DashboardQueueFilters } from "@/hooks/useDashboardData";
import { useCachedFetch } from "@/hooks/useCachedFetch";
import { sitesService, type Site } from "@/services/sitesService";
import { CACHE_KEYS, DASHBOARD_CACHE_TTL_MS } from "@/lib/cache/cacheKeys";
import { selectedTenantStore } from "@/lib/selectedTenantStore";
import { DashboardSectionBoundary } from "@/components/dashboard/DashboardSectionBoundary";
import { safeInternalHref } from "@/lib/security/safe-internal-href";
import { parseValidDate } from "@/lib/dashboard/utils";

type Period = "today" | "7d" | "30d";

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
];

function periodToDates(period: Period): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const dateTo = format(now, "yyyy-MM-dd");
  const dateFrom =
    period === "today"
      ? dateTo
      : period === "7d"
        ? format(subDays(startOfDay(now), 6), "yyyy-MM-dd")
        : format(subDays(startOfDay(now), 29), "yyyy-MM-dd");
  return { dateFrom, dateTo };
}

function formatDueDate(dateStr: string | null): { label: string; overdue: boolean } {
  if (!dateStr) return { label: "—", overdue: false };
  const date = parseValidDate(dateStr);
  if (!date) return { label: "—", overdue: false };
  const now = new Date();
  const overdue = date.getTime() < now.getTime();
  const diff = differenceInDays(date, now);
  if (overdue) return { label: `Venceu há ${Math.abs(diff)}d`, overdue: true };
  if (isToday(date)) return { label: "Vence hoje", overdue: false };
  if (isTomorrow(date)) return { label: "Amanhã", overdue: false };
  if (diff <= 7) return { label: `${diff}d restantes`, overdue: false };
  return { label: format(date, "dd/MM/yy", { locale: ptBR }), overdue: false };
}

const MODULE_LABELS: Record<string, string> = {
  apr: "APR",
  pt: "PT",
  dds: "DDS",
  checklist: "Checklist",
  nonconformity: "NC",
  audit: "Auditoria",
  medical_exam: "Exame",
  training: "Treinamento",
  rdo: "RDO",
};

const PRIORITY_CONFIG = {
  critical: {
    badge:
      "bg-[var(--ds-color-danger-subtle)] text-[var(--ds-color-danger-fg)] border border-[var(--ds-color-danger-border)]",
    dot: "bg-[var(--ds-color-danger)]",
    label: "Crítico",
  },
  high: {
    badge:
      "bg-[var(--ds-color-warning-subtle)] text-[var(--ds-color-warning-fg)] border border-[var(--ds-color-warning-border)]",
    dot: "bg-[var(--ds-color-warning)]",
    label: "Alto",
  },
  medium: {
    badge:
      "bg-[var(--ds-color-info-subtle)] text-[var(--ds-color-info-fg)] border border-[var(--ds-color-info-border)]",
    dot: "bg-[var(--ds-color-info)]",
    label: "Médio",
  },
} as const;

const SLA_CONFIG = {
  breached: {
    label: "SLA vencido",
    className:
      "bg-[var(--ds-color-danger-subtle)] text-[var(--ds-color-danger-fg)] border border-[var(--ds-color-danger-border)]",
  },
  due_today: {
    label: "Vence hoje",
    className:
      "bg-[var(--ds-color-warning-subtle)] text-[var(--ds-color-warning-fg)] border border-[var(--ds-color-warning-border)]",
  },
  due_soon: {
    label: "Vence em breve",
    className:
      "bg-[var(--ds-color-info-subtle)] text-[var(--ds-color-info-fg)] border border-[var(--ds-color-info-border)]",
  },
  on_track: {
    label: "Dentro do SLA",
    className:
      "bg-[var(--ds-color-success-subtle)] text-[var(--ds-color-success-fg)] border border-[var(--ds-color-success-border)]",
  },
  unscheduled: {
    label: "Sem SLA",
    className:
      "bg-[var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)] border border-[var(--ds-color-border-default)]",
  },
} as const;

type QueueFiltersContextValue = {
  period: Period;
  setPeriod: (period: Period) => void;
  selectedSite: Site | null;
  setSelectedSite: (site: Site | null) => void;
  tenantCompanyId: string | null;
  sites: Site[];
  sitesLoading: boolean;
  ensureSitesLoaded: () => Promise<void>;
  queueFilters: DashboardQueueFilters;
};

const QueueFiltersContext = createContext<QueueFiltersContextValue | null>(null);

function useQueueFiltersContext() {
  const ctx = useContext(QueueFiltersContext);
  if (!ctx) {
    throw new Error("useQueueFiltersContext must be used within PendingQueueProvider");
  }
  return ctx;
}

export function PendingQueueProvider({ children }: { children: ReactNode }) {
  const [period, setPeriodState] = useState<Period>("today");
  const [selectedSite, setSelectedSiteState] = useState<Site | null>(null);
  const [tenantCompanyId, setTenantCompanyId] = useState<string | null>(() => {
    return selectedTenantStore.get()?.companyId ?? null;
  });
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const sitesLookupInitializedRef = useRef(false);
  const sitesLookupGenerationRef = useRef(0);
  const sitesLookupCache = useCachedFetch(
    CACHE_KEYS.dashboardPendingQueueSites,
    () => sitesService.findPaginated({ limit: 100 }),
    DASHBOARD_CACHE_TTL_MS,
  );

  const periodDates = useMemo(() => periodToDates(period), [period]);
  const queueFilters = useMemo<DashboardQueueFilters>(
    () => ({
      ...periodDates,
      ...(selectedSite ? { siteId: selectedSite.id } : {}),
    }),
    [periodDates, selectedSite],
  );

  const setPeriod = useCallback((value: Period) => {
    setPeriodState(value);
  }, []);

  const setSelectedSite = useCallback((site: Site | null) => {
    setSelectedSiteState(site);
  }, []);

  useEffect(() => {
    const unsubscribe = selectedTenantStore.subscribe((tenant) => {
      setTenantCompanyId(tenant?.companyId ?? null);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    sitesLookupGenerationRef.current += 1;
    sitesLookupInitializedRef.current = false;
    setSites([]);
    setSelectedSiteState(null);
    setSitesLoading(false);
  }, [tenantCompanyId]);

  const ensureSitesLoaded = useCallback(async () => {
    if (sitesLookupInitializedRef.current || sitesLoading) {
      return;
    }

    const requestGeneration = sitesLookupGenerationRef.current;
    sitesLookupInitializedRef.current = true;
    setSitesLoading(true);
    let loadedSuccessfully = false;

    try {
      const response = await sitesLookupCache.fetch();
      if (sitesLookupGenerationRef.current !== requestGeneration) {
        return;
      }
      setSites(response.data ?? []);
      loadedSuccessfully = true;
    } catch {
      if (sitesLookupGenerationRef.current === requestGeneration) {
        setSites([]);
      }
    } finally {
      if (sitesLookupGenerationRef.current === requestGeneration) {
        setSitesLoading(false);
        if (!loadedSuccessfully) {
          sitesLookupInitializedRef.current = false;
        }
      }
    }
  }, [sitesLoading, sitesLookupCache]);

  const value = useMemo<QueueFiltersContextValue>(
    () => ({
      period,
      setPeriod,
      selectedSite,
      setSelectedSite,
      tenantCompanyId,
      sites,
      sitesLoading,
      ensureSitesLoaded,
      queueFilters,
    }),
    [
      period,
      setPeriod,
      selectedSite,
      setSelectedSite,
      tenantCompanyId,
      sites,
      sitesLoading,
      ensureSitesLoaded,
      queueFilters,
    ],
  );

  return (
    <QueueFiltersContext.Provider value={value}>{children}</QueueFiltersContext.Provider>
  );
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("rounded-lg bg-[var(--ds-color-border-subtle)]", className)}
      aria-hidden="true"
    />
  );
}

const SectionHeader = memo(function SectionHeader({
  overline,
  title,
  trailing,
  children,
}: {
  overline: string;
  title: string;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] px-4 py-3.5 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--ds-color-text-secondary)]">
            {overline}
          </p>
          <h2 className="text-[14px] font-bold text-[var(--title)]">{title}</h2>
        </div>
        {trailing}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
});

function PendingQueueFiltersComponent({
  queueLoading,
  pendingQueue,
}: {
  queueLoading: boolean;
  pendingQueue: ReturnType<typeof useDashboardData>["pendingQueue"]["data"];
}) {
  const {
    period,
    setPeriod,
    selectedSite,
    setSelectedSite,
    tenantCompanyId,
    sites,
    sitesLoading,
    ensureSitesLoaded,
  } = useQueueFiltersContext();

  const [siteDropdownOpen, setSiteDropdownOpen] = useState(false);
  const [siteSearchQuery, setSiteSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filteredSites = useMemo(() => {
    const q = siteSearchQuery.trim().toLowerCase();
    if (!q) return sites;
    return sites.filter((site) => (site.nome ?? '').toLowerCase().includes(q));
  }, [sites, siteSearchQuery]);
  const siteDropdownId = "site-filter-dropdown";

  useEffect(() => {
    if (!siteDropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setSiteDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [siteDropdownOpen]);

  useEffect(() => {
    if (!siteDropdownOpen) {
      return;
    }

    void ensureSitesLoaded();
    setSiteSearchQuery("");
  }, [ensureSitesLoaded, siteDropdownOpen, tenantCompanyId]);

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Filtros do dashboard"
      >
        <div
          className="ds-segmented-control"
          role="group"
          aria-label="Filtrar por período"
        >
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setPeriod(opt.value)}
              data-state={period === opt.value ? "active" : "inactive"}
              aria-label={`Filtrar: ${opt.label}`}
              aria-pressed={period === opt.value}
              className="ds-segmented-control__item focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-color-action-primary)]"
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setSiteDropdownOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={siteDropdownOpen}
            aria-controls={siteDropdownId}
            aria-label={
              selectedSite
                ? `Obra selecionada: ${selectedSite.nome}. Clique para trocar`
                : "Filtrar por obra"
            }
            className="flex items-center gap-2 rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-1.5 text-[12px] font-semibold text-[var(--ds-color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-color-action-primary)]"
          >
            <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
            {selectedSite ? selectedSite.nome : "Todas as obras"}
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5",
                siteDropdownOpen && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>
          {siteDropdownOpen && (
            <div
              id={siteDropdownId}
              className="absolute left-0 top-full z-50 mt-1 max-h-80 min-w-[240px] overflow-hidden rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-lg)] focus:outline-none"
            >
              <div className="border-b border-[var(--ds-color-border-subtle)] p-2 bg-[var(--ds-color-surface-muted)]/30">
                <input
                  type="text"
                  placeholder="Filtrar obras..."
                  value={siteSearchQuery}
                  onChange={(e) => setSiteSearchQuery(e.target.value)}
                  className="w-full rounded-md border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-[13px] text-[var(--ds-color-text-primary)] outline-none placeholder:text-[var(--ds-color-text-muted)] focus:border-[var(--ds-color-focus)] focus:ring-1 focus:ring-[var(--ds-color-focus)]"
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              </div>
              <ul
                role="listbox"
                aria-label="Selecionar obra"
                className="max-h-60 overflow-y-auto overflow-x-hidden"
              >
                <li role="option" aria-selected={!selectedSite}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSite(null);
                      setSiteDropdownOpen(false);
                      setSiteSearchQuery("");
                    }}
                    className={cn(
                      "w-full px-4 py-2.5 text-left text-[13px] hover:bg-[var(--ds-color-surface-muted)] focus-visible:bg-[var(--ds-color-surface-muted)] focus-visible:outline-none",
                      !selectedSite
                        ? "font-bold text-[var(--ds-color-action-primary)]"
                        : "text-[var(--ds-color-text-secondary)]",
                    )}
                  >
                    Todas as obras
                  </button>
                </li>
                {sitesLoading ? (
                  <li className="px-4 py-3 text-center text-[12px] text-[var(--ds-color-text-muted)]">
                    Carregando obras...
                  </li>
                ) : filteredSites.length === 0 ? (
                  <li className="px-4 py-3 text-center text-[12px] text-[var(--ds-color-text-muted)]">
                    Nenhuma obra encontrada.
                  </li>
                ) : (
                  filteredSites.map((site) => (
                    <li key={site.id} role="option" aria-selected={selectedSite?.id === site.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSite(site);
                          setSiteDropdownOpen(false);
                          setSiteSearchQuery("");
                        }}
                        className={cn(
                          "w-full px-4 py-2.5 text-left text-[13px] hover:bg-[var(--ds-color-surface-muted)] focus-visible:bg-[var(--ds-color-surface-muted)] focus-visible:outline-none",
                          selectedSite?.id === site.id
                            ? "font-bold text-[var(--ds-color-action-primary)]"
                            : "text-[var(--ds-color-text-secondary)]",
                        )}
                      >
                        {site.nome}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}
        </div>

        {(period !== "today" || selectedSite) && (
          <button
            type="button"
            onClick={() => {
              setPeriod("today");
              setSelectedSite(null);
            }}
            aria-label="Remover todos os filtros ativos"
            className="flex items-center gap-1.5 rounded-lg border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] px-3 py-1.5 text-[12px] font-semibold text-[var(--ds-color-warning-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-color-warning)]"
          >
            Limpar filtros ×
          </button>
        )}
      </div>

      {!queueLoading && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="ds-dashboard-queue-stat">
            <dt>Total</dt>
            <dd>{pendingQueue.summary.total}</dd>
          </div>
          <div className="ds-dashboard-queue-stat">
            <dt>Críticos</dt>
            <dd>{pendingQueue.summary.critical}</dd>
          </div>
          <div className="ds-dashboard-queue-stat">
            <dt>Altos</dt>
            <dd>{pendingQueue.summary.high}</dd>
          </div>
          <div className="ds-dashboard-queue-stat">
            <dt>SLA vencido</dt>
            <dd>{pendingQueue.summary.slaBreached}</dd>
          </div>
        </dl>
      )}

      {!queueLoading && pendingQueue.summary.critical > 0 && (
        <div
          role="alert"
          aria-live="assertive"
          className="relative flex flex-col gap-3 overflow-hidden rounded-lg border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div
            className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-[var(--ds-color-danger)]"
            aria-hidden="true"
          />
          <div className="flex items-center gap-3 pl-2">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-danger)]"
              aria-hidden="true"
            >
              <ShieldAlert className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-bold text-[var(--ds-color-text-primary)]">
                {pendingQueue.summary.critical}{" "}
                {pendingQueue.summary.critical === 1
                  ? "item crítico requer"
                  : "itens críticos requerem"}{" "}
                atenção imediata
              </p>
              <p className="text-xs text-[var(--ds-color-text-secondary)]">
                Revise os itens abaixo antes de prosseguir com a operação.
              </p>
            </div>
          </div>
          <a
            href="#priority-table"
            aria-label="Ir para a fila de prioridades"
            className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-xs font-bold text-[var(--ds-color-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-color-danger)] focus-visible:ring-offset-2"
          >
            Ver agora <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      )}

      {!queueLoading && pendingQueue.degraded && (
        <div
          role="status"
          className="rounded-lg border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] px-4 py-3 text-sm text-[var(--ds-color-warning-fg)]"
        >
          A fila operacional foi carregada com ressalvas.
          {pendingQueue.failedSources?.length
            ? ` Fontes indisponíveis: ${pendingQueue.failedSources.join(", ")}.`
            : ""}
        </div>
      )}
    </>
  );
}

function PendingQueueComponent() {
  const { queueFilters } = useQueueFiltersContext();
  const dashboardData = useDashboardData({
    queueFilters,
    includeSummary: false,
  });
  const queueLoading = dashboardData.pendingQueue.loading;
  const pendingQueue = dashboardData.pendingQueue.data;

  const priorityItems = useMemo(
    () =>
      pendingQueue.items
        .filter((i) => i.priority === "critical" || i.priority === "high")
        .slice(0, 10),
    [pendingQueue.items],
  );

  return (
    <DashboardSectionBoundary fallbackTitle="Itens Pendentes">
      <section
        id="priority-table"
        aria-label="Fila de prioridades operacionais"
        className="overflow-hidden rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-xs)]"
      >
        <SectionHeader
          overline="Fila de Prioridades"
          title="Fila crítica e SLA"
          trailing={
            pendingQueue.summary.hasMore ? (
              <span className="rounded-lg bg-[var(--ds-color-surface-muted)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ds-color-text-secondary)]">
                {pendingQueue.summary.totalFound} encontrados
              </span>
            ) : pendingQueue.summary.total > 10 ? (
              <span className="rounded-lg bg-[var(--ds-color-surface-muted)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ds-color-text-secondary)]">
                +{pendingQueue.summary.total - 10} na fila
              </span>
            ) : null
          }
        >
          <PendingQueueFiltersComponent
            queueLoading={queueLoading}
            pendingQueue={pendingQueue}
          />
        </SectionHeader>

        {queueLoading ? (
          <div className="space-y-px p-1">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-start gap-3 px-5 py-4">
                <Skeleton className="mt-1 h-10 w-1 rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="flex gap-1.5">
                    <Skeleton className="h-4 w-12 rounded" />
                    <Skeleton className="h-4 w-16 rounded" />
                  </div>
                  <Skeleton className="h-4 w-3/4 rounded" />
                  <Skeleton className="h-3 w-1/2 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : priorityItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <span
              className="flex h-14 w-14 items-center justify-center rounded-lg bg-[var(--ds-color-success-subtle)]"
              aria-hidden="true"
            >
              <CheckCircle2 className="h-8 w-8 text-[var(--ds-color-success)]" />
            </span>
            <div>
              <p className="text-sm font-bold text-[var(--ds-color-text-primary)]">
                Nenhuma pendência crítica ou alta
              </p>
              <p className="mt-0.5 text-xs text-[var(--ds-color-text-secondary)]">
                Operação dentro dos parâmetros. Mantenha o ritmo.
              </p>
            </div>
          </div>
        ) : (
          <ul>
            {priorityItems.map((item) => {
              const pCfg = PRIORITY_CONFIG[item.priority] ?? PRIORITY_CONFIG.medium;
              const slaCfg = SLA_CONFIG[item.slaStatus] ?? SLA_CONFIG.unscheduled;
              const due = formatDueDate(item.dueDate);
              const itemHref = safeInternalHref(item.href) ?? "/dashboard";
              return (
                <li key={item.id} className="border-b border-[var(--ds-color-border-subtle)] last:border-0">
                  <Link
                    href={itemHref}
                    aria-label={`${pCfg.label}: ${item.title}. ${due.label !== "—" ? due.label : ""}`}
                    className="group relative flex flex-col gap-3 px-4 py-4 hover:bg-[var(--ds-color-surface-muted)] focus-visible:bg-[var(--ds-color-surface-muted)] focus-visible:outline-none sm:flex-row sm:items-start sm:px-5"
                  >
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0 w-[3px] rounded-r-full",
                        pCfg.dot,
                      )}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
                            pCfg.badge,
                          )}
                        >
                          {pCfg.label}
                        </span>
                        <span className="inline-flex items-center rounded-md bg-[var(--ds-color-surface-muted)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--ds-color-text-secondary)]">
                          {MODULE_LABELS[item.module] ?? item.module}
                        </span>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
                            slaCfg.className,
                          )}
                        >
                          {slaCfg.label}
                        </span>
                        {item.site && (
                          <span className="text-[11px] text-[var(--ds-color-text-secondary)]">
                            {item.site}
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 line-clamp-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                        {item.title}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-[var(--ds-color-text-secondary)]">
                        {item.description}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center justify-between gap-3 text-left sm:block sm:text-right">
                      <div>
                        {due.label !== "—" && (
                          <p
                            className={cn(
                              "text-[11px] font-semibold",
                              due.overdue
                                ? "text-[var(--ds-color-danger)]"
                                : "text-[var(--ds-color-text-secondary)]",
                            )}
                          >
                            {due.label}
                          </p>
                        )}
                        {item.overdueByDays != null && (
                          <p className="mt-0.5 text-[11px] font-bold text-[var(--ds-color-danger)]">
                            {item.overdueByDays}d fora do SLA
                          </p>
                        )}
                        {item.responsible && (
                          <p className="mt-0.5 text-[11px] text-[var(--ds-color-text-secondary)]">
                            {item.responsible}
                          </p>
                        )}
                      </div>
                      <ArrowRight
                        className="h-3.5 w-3.5 text-[var(--ds-color-border-strong)] sm:mt-1.5 sm:ml-auto"
                        aria-hidden="true"
                      />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </DashboardSectionBoundary>
  );
}

export const PendingQueue = memo(PendingQueueComponent);
