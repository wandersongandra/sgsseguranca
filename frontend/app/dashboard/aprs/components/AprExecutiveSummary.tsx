"use client";

import { useEffect, useMemo, useRef } from "react";
import { useWatch, type Control } from "react-hook-form";
import {
  AlertTriangle,
  Info,
  Maximize2,
  Minimize2,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MetricCard } from "@/components/ui/metric-card";
import type { AprFormData } from "./aprForm.schema";
import { useAprCalculations } from "./useAprCalculations";

export type AprExecutiveSummaryVariant = "panel" | "badges" | "breakdown";

export function AprExecutiveSummary({
  control,
  variant,
  compactMode,
  onToggleCompactMode,
  showCompactToggle = true,
}: {
  control: Control<AprFormData>;
  variant: AprExecutiveSummaryVariant;
  compactMode?: boolean;
  onToggleCompactMode?: () => void;
  showCompactToggle?: boolean;
}) {
  const { computeRiskSummary } = useAprCalculations();
  const riskItems = useWatch({
    control,
    name: "itens_risco",
    defaultValue: [],
  });

  const riskSummary = useMemo(
    () => computeRiskSummary(riskItems ?? []),
    [computeRiskSummary, riskItems],
  );
  const previousRiskSummaryRef = useRef(riskSummary);

  useEffect(() => {
    previousRiskSummaryRef.current = riskSummary;
  }, [riskSummary]);

  const deltaMap = useMemo(() => {
    const previous = previousRiskSummaryRef.current;
    return {
      total: riskSummary.total - previous.total,
      aceitavel: riskSummary.aceitavel - previous.aceitavel,
      atencao: riskSummary.atencao - previous.atencao,
      substancial: riskSummary.substancial - previous.substancial,
      critico: riskSummary.critico - previous.critico,
      incompletas: riskSummary.incompletas - previous.incompletas,
      semMedidasPreventivas:
        riskSummary.semMedidasPreventivas - previous.semMedidasPreventivas,
      prontas: riskSummary.prontas - previous.prontas,
    };
  }, [riskSummary]);

  if (riskSummary.total <= 0) return null;

  if (variant === "badges") {
    return (
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-muted)]">
          Matriz
        </span>
        {riskSummary.aceitavel > 0 && (
          <span className="risk-badge-acceptable rounded-full px-2.5 py-1 text-[10px] font-semibold">
            {riskSummary.aceitavel} Aceitável
          </span>
        )}
        {riskSummary.atencao > 0 && (
          <span className="risk-badge-attention rounded-full px-2.5 py-1 text-[10px] font-semibold">
            {riskSummary.atencao} Atenção
          </span>
        )}
        {riskSummary.substancial > 0 && (
          <span className="risk-badge-substantial rounded-full px-2.5 py-1 text-[10px] font-semibold">
            {riskSummary.substancial} Substancial
          </span>
        )}
        {riskSummary.critico > 0 && (
          <span className="risk-badge-critical rounded-full px-2.5 py-1 text-[10px] font-semibold">
            {riskSummary.critico} Crítico
          </span>
        )}
        {riskSummary.incompletas > 0 && (
          <span className="rounded-full border border-[var(--apr-incomplete-border)] bg-[var(--apr-incomplete-subtle)] px-2.5 py-1 text-[10px] font-semibold text-[var(--apr-incomplete-fg)]">
            {riskSummary.incompletas} Incompletas
          </span>
        )}
        {riskSummary.semMedidasPreventivas > 0 && (
          <span className="rounded-full border border-[var(--ds-color-info-border)] bg-[color:var(--ds-color-info-subtle)] px-2.5 py-1 text-[10px] font-semibold text-[var(--color-info)]">
            {riskSummary.semMedidasPreventivas} sem medidas
          </span>
        )}
      </div>
    );
  }

  if (variant === "breakdown") {
    return (
      <div className="mt-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] px-3 py-3 shadow-none sm:px-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-muted)]">
              Distribuição de riscos
            </p>
            <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
              {riskSummary.total} linha(s) na matriz
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-1.5 text-xs font-semibold text-[var(--ds-color-text-secondary)]">
            <ShieldCheck className="h-3.5 w-3.5" />
            {riskSummary.prontas} linha(s) pronta(s)
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 lg:grid-cols-7">
          <MetricCard
            density="compact"
            label="Total"
            value={riskSummary.total}
            tone="neutral"
            delta={{ value: deltaMap.total }}
          />
          <MetricCard
            density="compact"
            label="Aceitável"
            value={riskSummary.aceitavel}
            tone="success"
            delta={{ value: deltaMap.aceitavel }}
          />
          <MetricCard
            density="compact"
            label="Atenção"
            value={riskSummary.atencao}
            tone="warning"
            delta={{ value: deltaMap.atencao }}
          />
          <MetricCard
            density="compact"
            label="Substancial"
            value={riskSummary.substancial}
            tone="orange"
            delta={{ value: deltaMap.substancial }}
          />
          <MetricCard
            density="compact"
            label="Crítico"
            value={riskSummary.critico}
            tone="danger"
            delta={{ value: deltaMap.critico }}
          />
          <MetricCard
            density="compact"
            label="Incompletas"
            value={riskSummary.incompletas}
            tone="muted"
            delta={{ value: deltaMap.incompletas }}
          />
          <MetricCard
            density="compact"
            label="Sem medidas"
            value={riskSummary.semMedidasPreventivas}
            tone="info"
            delta={{ value: deltaMap.semMedidasPreventivas }}
          />
        </div>
      </div>
    );
  }

  const isCompact = Boolean(compactMode);
  const hasPriorityAlerts =
    riskSummary.critico > 0 ||
    riskSummary.incompletas > 0 ||
    riskSummary.semMedidasPreventivas > 0;

  return (
    <div className="mb-3 overflow-hidden rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] shadow-none">
      <div className="flex flex-col gap-2 border-b border-[var(--ds-color-border-subtle)] px-4 py-2.5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ds-color-text-muted)]">
            Resumo operacional da grade
          </p>
          <h3 className="mt-1 text-sm font-black text-[var(--ds-color-text-primary)]">
            Prioridades e prontidão da matriz
          </h3>
          <p className="mt-0.5 max-w-2xl text-[11px] leading-5 text-[var(--ds-color-text-secondary)]">
            Ataque primeiro riscos críticos, linhas incompletas e lacunas de controle.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-1.5 text-xs font-semibold text-[var(--ds-color-text-secondary)]">
            <Info className="h-3.5 w-3.5" />
            {riskSummary.total} linha(s)
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--apr-ready-border)] bg-[var(--apr-ready-subtle)] px-3 py-1.5 text-xs font-semibold text-[var(--apr-ready-fg)]">
            <ShieldCheck className="h-3.5 w-3.5" />
            {riskSummary.prontas} pronta(s)
          </div>
          {showCompactToggle ? (
            <button
              type="button"
              onClick={onToggleCompactMode}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-xs font-semibold text-[var(--ds-color-text-secondary)] motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)]"
              title={isCompact ? "Expandir todas as linhas" : "Modo compacto"}
            >
              {isCompact ? (
                <Maximize2 className="h-3.5 w-3.5" />
              ) : (
                <Minimize2 className="h-3.5 w-3.5" />
              )}
              {isCompact ? "Expandir linhas" : "Modo compacto"}
            </button>
          ) : null}
        </div>
      </div>

      {hasPriorityAlerts ? (
        <div className="grid gap-2 px-4 py-2.5 md:grid-cols-2 xl:grid-cols-3">
          {riskSummary.critico > 0 && (
            <div className="flex items-start gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] px-3 py-2.5 text-xs font-semibold text-[var(--color-danger)]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {riskSummary.critico} risco(s) crítico(s) exigem ação imediata.
            </div>
          )}
          {riskSummary.incompletas > 0 && (
            <div className="flex items-start gap-2 rounded-[var(--ds-radius-md)] border border-[var(--apr-incomplete-border)] bg-[var(--apr-incomplete-subtle)] px-3 py-2.5 text-xs font-semibold text-[var(--apr-incomplete-fg)]">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {riskSummary.incompletas} linha(s) ainda sem matriz completa.
            </div>
          )}
          {riskSummary.semMedidasPreventivas > 0 && (
            <div className="flex items-start gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-info-border)] bg-[color:var(--ds-color-info-subtle)] px-3 py-2.5 text-xs font-semibold text-[var(--color-info)]">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {riskSummary.semMedidasPreventivas} linha(s) sem medida preventiva descrita.
            </div>
          )}
        </div>
      ) : null}

      <div
        className={cn(
          "grid gap-2 px-4 py-2.5 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7",
          hasPriorityAlerts ? "border-t border-[var(--ds-color-border-subtle)]" : "",
        )}
      >
        <MetricCard
          density="compact"
          label="Críticos"
          value={riskSummary.critico}
          tone="danger"
          delta={{ value: deltaMap.critico }}
        />
        <MetricCard
          density="compact"
          label="Incompletas"
          value={riskSummary.incompletas}
          tone="muted"
          delta={{ value: deltaMap.incompletas }}
        />
        <MetricCard
          density="compact"
          label="Sem medidas"
          value={riskSummary.semMedidasPreventivas}
          tone="info"
          delta={{ value: deltaMap.semMedidasPreventivas }}
        />
        <MetricCard
          density="compact"
          label="Aceitáveis"
          value={riskSummary.aceitavel}
          tone="success"
          delta={{ value: deltaMap.aceitavel }}
        />
        <MetricCard
          density="compact"
          label="Atenção"
          value={riskSummary.atencao}
          tone="warning"
          delta={{ value: deltaMap.atencao }}
        />
        <MetricCard
          density="compact"
          label="Substanciais"
          value={riskSummary.substancial}
          tone="orange"
          delta={{ value: deltaMap.substancial }}
        />
        <MetricCard
          density="compact"
          label="Prontas"
          value={riskSummary.prontas}
          tone="primary"
          delta={{ value: deltaMap.prontas }}
        />
      </div>
    </div>
  );
}
