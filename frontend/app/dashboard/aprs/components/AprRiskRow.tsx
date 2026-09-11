"use client";

import React, { useCallback, useMemo } from "react";
import {
  useWatch,
  type Control,
  type UseFormRegister,
  type UseFormSetValue,
} from "react-hook-form";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  GripVertical,
  Maximize2,
  Minimize2,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  APR_PROBABILITY_OPTIONS,
  APR_SEVERITY_OPTIONS,
} from "@/lib/apr-risk-matrix";
import type { AprFormData, AprRiskRowData } from "./aprForm.schema";
import { useAprCalculations } from "./useAprCalculations";

type RiskRowCompleteness = "complete" | "partial" | "empty";

type OperationalStatusTone =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral";

function getPriorityShortLabel(priority?: string) {
  switch (priority) {
    case "Prioridade básica":
      return "Basica";
    case "Prioridade preferencial":
      return "Preferencial";
    case "Prioridade máxima":
      return "Maxima";
    default:
      return "Sem prioridade";
  }
}

function getRiskRowCompleteness(
  item: AprRiskRowData | undefined,
): RiskRowCompleteness {
  if (!item) return "empty";
  const hasIdentification = Boolean(
    item.atividade_processo ||
      item.etapa ||
      item.condicao_perigosa ||
      item.agente_ambiental,
  );
  const hasEvaluation = Boolean(item.probabilidade && item.severidade);
  const hasControl = Boolean(
    item.medidas_prevencao ||
      item.epc ||
      item.epi ||
      item.permissao_trabalho ||
      item.normas_relacionadas ||
      item.hierarquia_controle,
  );
  if (hasIdentification && hasEvaluation && hasControl) return "complete";
  if (hasIdentification || hasEvaluation) return "partial";
  return "empty";
}

function getToneClass(tone: OperationalStatusTone) {
  switch (tone) {
    case "success":
      return "border-[var(--ds-color-success-border)] bg-[color:var(--ds-color-success-subtle)] text-[var(--color-success)]";
    case "warning":
      return "border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)] text-[var(--color-warning)]";
    case "danger":
      return "border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] text-[var(--color-danger)]";
    case "info":
      return "border-[var(--ds-color-info-border)] bg-[color:var(--ds-color-info-subtle)] text-[var(--color-info)]";
    default:
      return "border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)]";
  }
}

function getOperationalStatus({
  isCritical,
  isInconsistent,
  isReady,
  hasStarted,
  isIncomplete,
}: {
  isCritical: boolean;
  isInconsistent: boolean;
  isReady: boolean;
  hasStarted: boolean;
  isIncomplete: boolean;
}) {
  if (isCritical) {
    return {
      label: "Intervenção imediata",
      description: "Risco crítico. O trabalho precisa de resposta imediata.",
      tone: "danger" as const,
    };
  }

  if (isInconsistent) {
    return {
      label: "Controle pendente",
      description: "Medidas preventivas precisam ser registradas antes da liberação.",
      tone: "info" as const,
    };
  }

  if (isReady) {
    return {
      label: "Pronta para governança",
      description: "Identificação, matriz e medidas preenchidas.",
      tone: "success" as const,
    };
  }

  if (hasStarted && isIncomplete) {
    return {
      label: "Em avaliação",
      description: "Defina probabilidade e severidade para concluir a matriz.",
      tone: "warning" as const,
    };
  }

  if (hasStarted) {
    return {
      label: "Em montagem",
      description: "Complete contexto, matriz e plano de ação.",
      tone: "neutral" as const,
    };
  }

  return {
    label: "Não iniciada",
    description: "Preencha o risco para registrar a exposição e a governança.",
    tone: "neutral" as const,
  };
}

function getActionStatusPresentation(status?: string) {
  const normalized = String(status || "").trim().toLowerCase();

  if (!normalized) {
    return {
      label: "Sem status da acao",
      tone: "neutral" as const,
    };
  }

  if (
    normalized.includes("conclu") ||
    normalized.includes("finaliz") ||
    normalized.includes("encerr")
  ) {
    return { label: status || "Concluida", tone: "success" as const };
  }

  if (
    normalized.includes("bloque") ||
    normalized.includes("atras") ||
    normalized.includes("imped")
  ) {
    return { label: status || "Bloqueada", tone: "danger" as const };
  }

  if (normalized.includes("andamento") || normalized.includes("execu")) {
    return { label: status || "Em andamento", tone: "warning" as const };
  }

  if (
    normalized.includes("aberta") ||
    normalized.includes("pend") ||
    normalized.includes("aguard")
  ) {
    return { label: status || "Aberta", tone: "info" as const };
  }

  return {
    label: status || "Registrada",
    tone: "neutral" as const,
  };
}

function FieldShell({
  label,
  htmlFor,
  support,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  support?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]"
      >
        {label}
      </label>
      {children}
      {support ? (
        <p className="mt-1.5 text-xs text-[var(--ds-color-text-secondary)]">
          {support}
        </p>
      ) : null}
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
  aside,
}: {
  eyebrow: string;
  title: string;
  description: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
          {eyebrow}
        </p>
        <h4 className="mt-1 text-sm font-bold text-[var(--ds-color-text-primary)]">
          {title}
        </h4>
        <p className="mt-1 text-xs leading-5 text-[var(--ds-color-text-secondary)]">
          {description}
        </p>
      </div>
      {aside}
    </div>
  );
}

export const AprRiskRow = React.memo(function AprRiskRow({
  fieldId,
  index,
  totalRows,
  readOnly,
  compactMode,
  expanded,
  onToggleExpanded,
  onMove,
  onDuplicate,
  onRemove,
  control,
  register,
  setValue,
  aprFieldClass,
}: {
  fieldId: string;
  index: number;
  totalRows: number;
  readOnly: boolean;
  compactMode: boolean;
  expanded: boolean;
  onToggleExpanded: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number, fieldId: string) => void;
  control: Control<AprFormData>;
  register: UseFormRegister<AprFormData>;
  setValue: UseFormSetValue<AprFormData>;
  aprFieldClass: string;
}) {
  const { evaluateRisk, getCategoriaBadgeClass, getPrioridadeBadgeClass } =
    useAprCalculations();

  const item = useWatch({
    control,
    name: `itens_risco.${index}` as const,
  }) as AprRiskRowData | undefined;

  const probabilidade = String(item?.probabilidade || "");
  const severidade = String(item?.severidade || "");

  const calc = useMemo(
    () => evaluateRisk(probabilidade, severidade),
    [evaluateRisk, probabilidade, severidade],
  );

  const completeness = useMemo(() => getRiskRowCompleteness(item), [item]);

  const hasStarted = Boolean(
    item?.atividade_processo ||
      item?.etapa ||
      item?.agente_ambiental ||
      item?.condicao_perigosa ||
      item?.fontes_circunstancias ||
      item?.possiveis_lesoes ||
      item?.probabilidade ||
      item?.severidade ||
      item?.medidas_prevencao ||
      item?.epc ||
      item?.epi ||
      item?.permissao_trabalho ||
      item?.normas_relacionadas,
  );
  const isCritical = calc.categoria === "Crítico";
  const isSubstantial = calc.categoria === "Substancial";
  const isIncomplete = !probabilidade || !severidade;
  const missingMeasures =
    hasStarted &&
    ![
      item?.medidas_prevencao,
      item?.epc,
      item?.epi,
      item?.permissao_trabalho,
      item?.normas_relacionadas,
      item?.hierarquia_controle,
    ].some((value) => String(value || "").trim());
  const isInconsistent = (isCritical || isSubstantial) && missingMeasures;
  const isPriorityHigh =
    calc.prioridade === "Prioridade preferencial" ||
    calc.prioridade === "Prioridade máxima";
  const isReady = completeness === "complete";
  const isRowExpanded = !compactMode || expanded;
  const compactHiddenGovernanceIncomplete =
    compactMode &&
    !isRowExpanded &&
    (![
      item?.medidas_prevencao,
      item?.epc,
      item?.epi,
      item?.permissao_trabalho,
      item?.normas_relacionadas,
      item?.hierarquia_controle,
    ].some((value) => String(value || "").trim()) ||
      !String(item?.responsavel || "").trim() ||
      !String(item?.prazo || "").trim() ||
      !String(item?.status_acao || "").trim());

  const operationalStatus = useMemo(
    () =>
      getOperationalStatus({
        isCritical,
        isInconsistent,
        isReady,
        hasStarted,
        isIncomplete,
      }),
    [hasStarted, isCritical, isInconsistent, isIncomplete, isReady],
  );

  const actionStatus = useMemo(
    () => getActionStatusPresentation(item?.status_acao),
    [item?.status_acao],
  );

  const shellClass = isCritical
    ? "border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)]/60 shadow-[0_0_0_1px_var(--ds-color-danger-border)]"
    : isInconsistent
      ? "border-[var(--ds-color-info-border)] bg-[var(--ds-color-info-subtle)]/48"
      : isReady
        ? "border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)]/60"
        : hasStarted && isIncomplete
          ? "border-dashed border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)]/48"
          : "border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]";

  const compactFieldClass = cn(
    aprFieldClass,
    "min-h-[46px] px-3.5 py-2.5 text-[13px] leading-5 shadow-none",
  );
  const compactTextAreaClass = cn(
    compactFieldClass,
    "min-h-[164px] resize-y px-4 py-3 leading-6",
  );

  const focusNextGridField = useCallback((current: HTMLElement) => {
    const focusables = Array.from(
      document.querySelectorAll<HTMLElement>('[data-apr-nav="risk-grid"]'),
    ).filter((element) => {
      return (
        !element.hasAttribute("disabled") &&
        element.tabIndex !== -1 &&
        element.offsetParent !== null
      );
    });
    const currentIndex = focusables.indexOf(current);
    if (currentIndex >= 0) {
      focusables[currentIndex + 1]?.focus();
    }
  }, []);

  const handleAdvanceKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      event.preventDefault();
      focusNextGridField(event.currentTarget);
    },
    [focusNextGridField],
  );

  const handleProbabilityChange = useCallback(
    (value: string) => {
      if (readOnly) return;
      setValue(`itens_risco.${index}.probabilidade`, value, {
        shouldDirty: true,
        shouldValidate: true,
      });
      const next = evaluateRisk(value, String(item?.severidade || ""));
      setValue(`itens_risco.${index}.categoria_risco`, next.categoria, {
        shouldDirty: true,
        shouldValidate: true,
      });
    },
    [evaluateRisk, index, item?.severidade, readOnly, setValue],
  );

  const handleSeverityChange = useCallback(
    (value: string) => {
      if (readOnly) return;
      setValue(`itens_risco.${index}.severidade`, value, {
        shouldDirty: true,
        shouldValidate: true,
      });
      const next = evaluateRisk(String(item?.probabilidade || ""), value);
      setValue(`itens_risco.${index}.categoria_risco`, next.categoria, {
        shouldDirty: true,
        shouldValidate: true,
      });
    },
    [evaluateRisk, index, item?.probabilidade, readOnly, setValue],
  );

  const actionButtonClass =
    "inline-flex items-center justify-center rounded-[var(--ds-radius-md)] border p-2 text-[var(--ds-color-text-secondary)] motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)] disabled:cursor-not-allowed disabled:opacity-30";

  return (
    <div
      key={fieldId}
      className={cn(
        "overflow-hidden rounded-[calc(var(--ds-radius-xl)+2px)] border shadow-[var(--ds-shadow-sm)] motion-safe:transition-all motion-safe:duration-200",
        shellClass,
      )}
    >
      <div className="grid gap-3 p-3 xl:grid-cols-[124px_minmax(0,1fr)]">
        <aside className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/92 p-3">
          <div className="mb-2 inline-flex items-center gap-1 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-secondary)]">
            <GripVertical className="h-3.5 w-3.5" />
            Arraste
          </div>
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ds-color-text-secondary)]">
                Risco
              </p>
              <p className="mt-1 text-[30px] font-black leading-none text-[var(--ds-color-text-primary)]">
                {String(index + 1).padStart(2, "0")}
              </p>
            </div>
            {compactMode && (
              <button
                type="button"
                onClick={() => onToggleExpanded(index)}
                className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] p-1.5 text-[var(--ds-color-text-secondary)] motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)]"
                title={isRowExpanded ? "Recolher detalhes" : "Expandir detalhes"}
              >
                {isRowExpanded ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </div>

          <div
            className={cn(
              "mt-4 rounded-[var(--ds-radius-lg)] border px-3 py-2.5",
              getToneClass(operationalStatus.tone),
            )}
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em]">
              Estado
            </p>
            <p className="mt-1 text-sm font-bold">{operationalStatus.label}</p>
            <p className="mt-1 text-xs leading-5 opacity-90">
              {operationalStatus.description}
            </p>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {isCritical && (
              <span className="inline-flex rounded-full border border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] px-2 py-1 text-[11px] font-semibold text-[var(--color-danger)]">
                Critico
              </span>
            )}
            {isPriorityHigh && !isCritical && (
              <span className="inline-flex rounded-full border border-[var(--apr-priority-border)] bg-[var(--apr-priority-subtle)] px-2 py-1 text-[11px] font-semibold text-[var(--apr-priority-fg)]">
                Alta prioridade
              </span>
            )}
            {isInconsistent && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--apr-incomplete-border)] bg-[var(--apr-incomplete-subtle)] px-2 py-1 text-[11px] font-semibold text-[var(--apr-incomplete-fg)]">
                <AlertTriangle className="h-3 w-3" />
                Sem medida
              </span>
            )}
            {isReady && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--apr-ready-border)] bg-[var(--apr-ready-subtle)] px-2 py-1 text-[11px] font-semibold text-[var(--apr-ready-fg)]">
                <CheckCircle2 className="h-3 w-3" />
                Pronta
              </span>
            )}
            {compactHiddenGovernanceIncomplete ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-warning-subtle)] px-2 py-1 text-[11px] font-semibold text-[var(--color-warning)]">
                <AlertTriangle className="h-3 w-3" />
                Dados incompletos
              </span>
            ) : null}
          </div>

          <div className="mt-4 border-t border-[var(--ds-color-border-subtle)] pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
              Ações
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onMove(index, index - 1)}
                disabled={readOnly || index === 0}
                className={cn(
                  actionButtonClass,
                  "border-[var(--ds-color-border-subtle)]",
                )}
                title="Mover para cima"
                aria-label="Mover linha para cima"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onMove(index, index + 1)}
                disabled={readOnly || index === totalRows - 1}
                className={cn(
                  actionButtonClass,
                  "border-[var(--ds-color-border-subtle)]",
                )}
                title="Mover para baixo"
                aria-label="Mover linha para baixo"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onDuplicate(index)}
                disabled={readOnly}
                className={cn(
                  actionButtonClass,
                  "border-[var(--ds-color-primary-border)] bg-[color:var(--ds-color-primary-subtle)] text-[var(--color-primary)] hover:bg-[color:var(--ds-color-primary-subtle)]/80 disabled:opacity-40",
                )}
                title="Duplicar linha"
                aria-label="Duplicar linha"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onRemove(index, fieldId)}
                disabled={readOnly}
                className={cn(
                  actionButtonClass,
                  "border-[var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)] text-[var(--color-danger)] hover:bg-[color:var(--ds-color-danger-subtle)]/80 disabled:opacity-40",
                )}
                title="Remover linha"
                aria-label="Remover linha"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </aside>

        <div className="space-y-3">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.32fr)_minmax(360px,0.88fr)]">
            <section className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/94 p-4">
              <SectionHeader
                eyebrow="Identificação"
                title="Contexto e exposição do risco"
                description="Registre atividade, agente, condição e consequências para manter a leitura operacional consistente."
              />

              <div className="mt-4 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                <FieldShell
                  label="Atividade / processo"
                  htmlFor={`risk-${fieldId}-atividade`}
                >
                  <input
                    id={`risk-${fieldId}-atividade`}
                    {...register(`itens_risco.${index}.atividade_processo`)}
                    className={compactFieldClass}
                    placeholder="Descreva a atividade ou etapa"
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  />
                </FieldShell>

                <FieldShell label="Etapa da atividade" htmlFor={`risk-${fieldId}-etapa`}>
                  <input
                    id={`risk-${fieldId}-etapa`}
                    {...register(`itens_risco.${index}.etapa`)}
                    className={compactFieldClass}
                    placeholder="Ex.: preparação, execução, fechamento"
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  />
                </FieldShell>

                <FieldShell
                  label="Agente ambiental"
                  htmlFor={`risk-${fieldId}-agente-ambiental`}
                >
                  <input
                    id={`risk-${fieldId}-agente-ambiental`}
                    {...register(`itens_risco.${index}.agente_ambiental`)}
                    className={compactFieldClass}
                    placeholder="Agente ou exposição dominante"
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  />
                </FieldShell>

                <FieldShell
                  label="Condição perigosa"
                  htmlFor={`risk-${fieldId}-condicao-perigosa`}
                >
                  <input
                    id={`risk-${fieldId}-condicao-perigosa`}
                    {...register(`itens_risco.${index}.condicao_perigosa`)}
                    className={compactFieldClass}
                    placeholder="Condição perigosa observada"
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  />
                </FieldShell>

                <FieldShell
                  label="Fontes / circunstâncias"
                  htmlFor={`risk-${fieldId}-fontes-circunstancias`}
                >
                  <input
                    id={`risk-${fieldId}-fontes-circunstancias`}
                    {...register(`itens_risco.${index}.fontes_circunstancias`)}
                    className={compactFieldClass}
                    placeholder="Origem, condição ou circunstância"
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  />
                </FieldShell>

                <FieldShell
                  label="Possíveis lesões"
                  htmlFor={`risk-${fieldId}-possiveis-lesoes`}
                  className="lg:col-span-2 2xl:col-span-2"
                >
                  <input
                    id={`risk-${fieldId}-possiveis-lesoes`}
                    {...register(`itens_risco.${index}.possiveis_lesoes`)}
                    className={compactFieldClass}
                    placeholder="Consequências esperadas em caso de exposição"
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  />
                </FieldShell>
              </div>
            </section>

            <section className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/94 p-4">
              <SectionHeader
                eyebrow="Matriz de risco"
                title="Classificação e prioridade"
                description="Probabilidade e severidade alimentam a categoria, a prioridade e o critério de ação."
                aside={
                  <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] px-3 py-2 text-right">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                      Score
                    </p>
                    <p className="mt-1 text-2xl font-black leading-none text-[var(--ds-color-text-primary)]">
                      {calc.score || "--"}
                    </p>
                  </div>
                }
              />

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <FieldShell label="Probabilidade" htmlFor={`risk-${fieldId}-probabilidade`}>
                  <select
                    id={`risk-${fieldId}-probabilidade`}
                    {...register(`itens_risco.${index}.probabilidade`)}
                    onChange={(event) => handleProbabilityChange(event.target.value)}
                    className={compactFieldClass}
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  >
                    <option value="">Selecione</option>
                    {APR_PROBABILITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </FieldShell>

                <FieldShell label="Severidade" htmlFor={`risk-${fieldId}-severidade`}>
                  <select
                    id={`risk-${fieldId}-severidade`}
                    {...register(`itens_risco.${index}.severidade`)}
                    onChange={(event) => handleSeverityChange(event.target.value)}
                    className={compactFieldClass}
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  >
                    <option value="">Selecione</option>
                    {APR_SEVERITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </FieldShell>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/24 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                    Categoria
                  </p>
                  <span
                    className={cn(
                      "mt-3 inline-flex max-w-full truncate rounded-full px-3 py-1.5 text-xs font-semibold",
                      getCategoriaBadgeClass(calc.categoria),
                    )}
                  >
                    {calc.categoria || "Aguardando matriz"}
                  </span>
                  <p className="mt-3 text-xs leading-5 text-[var(--ds-color-text-secondary)]">
                    {calc.actionCriteria ||
                      "Defina P x S para consolidar o nível de risco."}
                  </p>
                </div>

                <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/24 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                    Prioridade
                  </p>
                  <span
                    className={cn(
                      "mt-3 inline-flex max-w-full truncate rounded-full px-3 py-1.5 text-xs font-semibold",
                      getPrioridadeBadgeClass(calc.prioridade),
                    )}
                  >
                    {getPriorityShortLabel(calc.prioridade)}
                  </span>
                  <p className="mt-3 text-xs leading-5 text-[var(--ds-color-text-secondary)]">
                    {calc.score
                      ? `Priorização operacional baseada no score ${calc.score}.`
                      : "A prioridade será liberada após o fechamento da matriz."}
                  </p>
                </div>
              </div>
            </section>
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.12fr)_minmax(360px,0.88fr)]">
            <section className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/94 p-4">
              <SectionHeader
                eyebrow="Controles preventivos"
                title="Medidas de prevenção"
                description="Registre barreiras, EPC/EPI, isolamentos, permissão, travamentos e demais controles operacionais."
              />

              <div className="mt-4">
                <FieldShell
                  label="Plano preventivo"
                  htmlFor={`risk-${fieldId}-medidas-prevencao`}
                  support="Descreva as medidas de forma acionável e verificável."
                >
                  <textarea
                    id={`risk-${fieldId}-medidas-prevencao`}
                    {...register(`itens_risco.${index}.medidas_prevencao`)}
                    rows={compactMode ? 5 : 6}
                    className={compactTextAreaClass}
                    placeholder="Ex.: isolar área, emitir permissão, sinalizar, validar EPC/EPI e definir conferência antes da execução."
                    data-apr-nav="risk-grid"
                  />
                </FieldShell>
              </div>

              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <FieldShell label="EPC" htmlFor={`risk-${fieldId}-epc`}>
                  <input
                    id={`risk-${fieldId}-epc`}
                    {...register(`itens_risco.${index}.epc`)}
                    className={compactFieldClass}
                    placeholder="Guarda-corpo, barreira, exaustão, enclausuramento..."
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  />
                </FieldShell>

                <FieldShell label="EPI" htmlFor={`risk-${fieldId}-epi`}>
                  <input
                    id={`risk-${fieldId}-epi`}
                    {...register(`itens_risco.${index}.epi`)}
                    className={compactFieldClass}
                    placeholder="Capacete, luva, respirador, cinto..."
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  />
                </FieldShell>

                <FieldShell
                  label="Permissão de trabalho"
                  htmlFor={`risk-${fieldId}-permissao-trabalho`}
                >
                  <input
                    id={`risk-${fieldId}-permissao-trabalho`}
                    {...register(`itens_risco.${index}.permissao_trabalho`)}
                    className={compactFieldClass}
                    placeholder="PT a quente, espaço confinado, elétrica..."
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  />
                </FieldShell>

                <FieldShell
                  label="NRs / normas relacionadas"
                  htmlFor={`risk-${fieldId}-normas-relacionadas`}
                >
                  <input
                    id={`risk-${fieldId}-normas-relacionadas`}
                    {...register(`itens_risco.${index}.normas_relacionadas`)}
                    className={compactFieldClass}
                    placeholder="NR-10, NR-12, NR-33, NR-35..."
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  />
                </FieldShell>
                <FieldShell
                  label="Hierarquia de controle"
                  htmlFor={`risk-${fieldId}-hierarquia-controle`}
                >
                  <select
                    id={`risk-${fieldId}-hierarquia-controle`}
                    {...register(`itens_risco.${index}.hierarquia_controle`)}
                    className={compactFieldClass}
                    data-apr-nav="risk-grid"
                    onKeyDown={handleAdvanceKeyDown}
                  >
                    <option value="">Selecione</option>
                    <option value="Eliminação">Eliminação</option>
                    <option value="Substituição">Substituição</option>
                    <option value="Controle de engenharia">Controle de engenharia</option>
                    <option value="Controle administrativo">Controle administrativo</option>
                    <option value="EPI">EPI</option>
                  </select>
                </FieldShell>
              </div>
            </section>

            <section className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/94 p-4">
              <SectionHeader
                eyebrow="Governança"
                title="Plano de ação e acompanhamento"
                description="Defina critério, responsável, prazo e estado de execução para sustentar rastreabilidade."
                aside={
                  <span
                    className={cn(
                      "inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold",
                      getToneClass(actionStatus.tone),
                    )}
                  >
                    {actionStatus.label}
                  </span>
                }
              />

              {isRowExpanded ? (
                <div className="mt-4 space-y-3">
                  <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/28 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
                      Critério de ação
                    </p>
                    <p className="mt-2 text-sm font-semibold leading-6 text-[var(--ds-color-text-primary)]">
                      {calc.actionCriteria ||
                        "Defina probabilidade e severidade para completar a matriz e liberar o critério."}
                    </p>
                  </div>

                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_152px]">
                    <FieldShell label="Responsável" htmlFor={`risk-${fieldId}-responsavel`}>
                      <input
                        id={`risk-${fieldId}-responsavel`}
                        {...register(`itens_risco.${index}.responsavel`)}
                        className={compactFieldClass}
                        placeholder="Responsável pela ação"
                        data-apr-nav="risk-grid"
                        onKeyDown={handleAdvanceKeyDown}
                      />
                    </FieldShell>

                    <FieldShell label="Prazo" htmlFor={`risk-${fieldId}-prazo`}>
                      <input
                        id={`risk-${fieldId}-prazo`}
                        type="date"
                        {...register(`itens_risco.${index}.prazo`)}
                        className={compactFieldClass}
                        data-apr-nav="risk-grid"
                        onKeyDown={handleAdvanceKeyDown}
                      />
                    </FieldShell>
                  </div>

                  <FieldShell
                    label="Status da ação"
                    htmlFor={`risk-${fieldId}-status-acao`}
                    support="Selecione o estado atual desta ação corretiva ou preventiva."
                  >
                    <select
                      id={`risk-${fieldId}-status-acao`}
                      {...register(`itens_risco.${index}.status_acao`)}
                      className={compactFieldClass}
                      data-apr-nav="risk-grid"
                      onKeyDown={handleAdvanceKeyDown}
                    >
                      <option value="">Selecione</option>
                      <option value="Aberta">Aberta</option>
                      <option value="Em andamento">Em andamento</option>
                      <option value="Concluída">Concluída</option>
                      <option value="Bloqueada">Bloqueada</option>
                      <option value="Cancelada">Cancelada</option>
                    </select>
                  </FieldShell>
                </div>
              ) : (
                <div className="mt-4 rounded-[var(--ds-radius-xl)] border border-dashed border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/24 px-3 py-3">
                  <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                    Governança resumida no modo compacto
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--ds-color-text-secondary)]">
                    Expanda a linha para editar responsável, prazo e status da
                    ação sem perder a leitura da matriz.
                  </p>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
});
