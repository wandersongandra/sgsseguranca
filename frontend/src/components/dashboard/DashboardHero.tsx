"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { DailyReportPdfSource } from "@/lib/pdf/dailyReportGenerator";
import { cn } from "@/lib/utils";
import { DailyReportButton } from "./DailyReportButton";
import { LastUpdatedLabel } from "./LastUpdatedLabel";

type DashboardHeroTone = "success" | "warning" | "danger" | "neutral";

const HERO_STATUS_STYLES: Record<
  DashboardHeroTone,
  {
    container: string;
    icon: string;
    Icon: typeof CheckCircle2;
    label: string;
  }
> = {
  success: {
    container:
      "border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] text-[var(--ds-color-success-fg)]",
    icon: "text-[var(--ds-color-success)]",
    Icon: CheckCircle2,
    label: "Operação estável",
  },
  warning: {
    container:
      "border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] text-[var(--ds-color-warning-fg)]",
    icon: "text-[var(--ds-color-warning)]",
    Icon: AlertTriangle,
    label: "Atenção operacional",
  },
  danger: {
    container:
      "border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] text-[var(--ds-color-danger-fg)]",
    icon: "text-[var(--ds-color-danger)]",
    Icon: AlertTriangle,
    label: "Ação imediata",
  },
  neutral: {
    container:
      "border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)]",
    icon: "text-[var(--ds-color-text-secondary)]",
    Icon: Loader2,
    label: "Atualizando operação",
  },
};

export interface DashboardHeroProps {
  greeting: string;
  firstName: string;
  dateLabel: string;
  statusTone: DashboardHeroTone;
  statusTitle: string;
  statusDescription: string;
  queueTotal: number;
  criticalCount: number;
  highCount: number;
  slaBreached: number;
  slaDueToday: number;
  complianceScore: number | null;
  complianceLabel: string;
  loadError?: string | null;
  actionsDisabled?: boolean;
  buildDailyReportPayload: () => DailyReportPdfSource;
  lastUpdatedAt: Date | null;
}

export function DashboardHero({
  greeting,
  firstName,
  dateLabel,
  statusTone,
  statusTitle,
  statusDescription,
  queueTotal,
  criticalCount,
  highCount,
  slaBreached,
  slaDueToday,
  complianceScore,
  complianceLabel,
  loadError,
  actionsDisabled,
  buildDailyReportPayload,
  lastUpdatedAt,
}: DashboardHeroProps) {
  const statusConfig = HERO_STATUS_STYLES[statusTone];
  const StatusIcon = statusConfig.Icon;

  return (
    <section
      aria-label="Resumo operacional do dashboard"
      className="ds-dashboard-hero rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--component-card-bg)] px-3.5 py-3.5 shadow-none sm:rounded-lg sm:px-5 sm:py-4 sm:shadow-[var(--ds-shadow-xs)]"
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] xl:items-start">
        <div className="min-w-0 space-y-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--ds-color-text-secondary)]">
              Visão geral
            </p>
            <h1 className="mt-1 text-[22px] font-bold leading-tight text-[var(--title)] sm:text-[26px]">
              Segurança do Trabalho
            </h1>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              {greeting}, {firstName} · {dateLabel}
            </p>
          </div>

          <div
            className={cn(
              "rounded-[var(--ds-radius-md)] border px-3 py-3 sm:rounded-lg sm:px-4",
              statusConfig.container,
            )}
            aria-live="polite"
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  "mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-current/20 bg-[var(--component-card-bg-elevated)]",
                  statusConfig.icon,
                )}
                aria-hidden="true"
              >
                <StatusIcon
                  className={cn("h-4 w-4", statusTone === "neutral" && "animate-none")}
                />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-[0.02em] opacity-90">
                  {statusConfig.label}
                </p>
                <p className="mt-1 text-sm font-semibold">{statusTitle}</p>
                <p className="mt-1 text-sm opacity-90">{statusDescription}</p>
              </div>
            </div>
          </div>

          {loadError ? (
            <p
              role="alert"
              className="rounded-lg border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] px-4 py-3 text-sm text-[var(--ds-color-warning-fg)]"
            >
              {loadError}
            </p>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <DailyReportButton
              disabled={actionsDisabled}
              buildPayload={buildDailyReportPayload}
            />
            <LastUpdatedLabel lastFetchedAt={lastUpdatedAt} />
          </div>

          <div
            className="grid grid-cols-2 gap-1.5 min-[390px]:gap-2 sm:grid-cols-4 xl:grid-cols-2"
            role="list"
            aria-label="Indicadores operacionais"
          >
            <article className="ds-dashboard-status-metric" role="listitem">
              <p>Fila</p>
              <strong>{queueTotal}</strong>
              <span>{criticalCount} críticos</span>
            </article>
            <article className="ds-dashboard-status-metric" role="listitem">
              <p>Altos</p>
              <strong>{highCount}</strong>
              <span>risco operacional</span>
            </article>
            <article className="ds-dashboard-status-metric" role="listitem">
              <p>SLA</p>
              <strong>{slaBreached > 0 ? slaBreached : slaDueToday}</strong>
              <span>{slaBreached > 0 ? "vencidos" : "vencem hoje"}</span>
            </article>
            <article className="ds-dashboard-status-metric" role="listitem">
              <p>Conformidade</p>
              <strong>{complianceScore == null ? "—" : `${complianceScore}%`}</strong>
              <span>{complianceLabel}</span>
            </article>
          </div>
        </div>
      </div>
    </section>
  );
}
