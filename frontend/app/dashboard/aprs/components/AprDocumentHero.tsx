"use client";

import {
  Archive,
  Clock3,
  FileCheck2,
  FileText,
  GitBranch,
  MapPin,
  ShieldCheck,
  UserRound,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

type AprStatus = "Pendente" | "Aprovada" | "Cancelada" | "Encerrada";
type AprStatusTone = "warning" | "success" | "danger" | "neutral";

type AprDocumentHeroProps = {
  number: string;
  title: string;
  status: AprStatus;
  version: number;
  company: string;
  site: string;
  responsible: string;
  updatedAt?: string;
  hasPdfHash: boolean;
  readOnly?: boolean;
};

const STATUS_META: Record<
  AprStatus,
  { label: string; description: string; icon: typeof Clock3; tone: AprStatusTone }
> = {
  Pendente: {
    label: "Em elaboração",
    description: "Aguardando revisão e aprovação",
    icon: Clock3,
    tone: "warning",
  },
  Aprovada: {
    label: "Aprovada",
    description: "Documento validado no fluxo oficial",
    icon: ShieldCheck,
    tone: "success",
  },
  Encerrada: {
    label: "Encerrada",
    description: "Documento final emitido e protegido",
    icon: Archive,
    tone: "neutral",
  },
  Cancelada: {
    label: "Cancelada",
    description: "Fluxo interrompido com registro no histórico",
    icon: XCircle,
    tone: "danger",
  },
};

const TONE_CLASSES = {
  warning: {
    shell: "border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)]/45",
    icon: "bg-[var(--ds-color-warning)] text-white",
    text: "text-[var(--ds-color-warning-fg)]",
  },
  success: {
    shell: "border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)]/45",
    icon: "bg-[var(--ds-color-success)] text-white",
    text: "text-[var(--ds-color-success-fg)]",
  },
  danger: {
    shell: "border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)]/45",
    icon: "bg-[var(--ds-color-danger)] text-white",
    text: "text-[var(--ds-color-danger-fg)]",
  },
  neutral: {
    shell: "border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/45",
    icon: "bg-[var(--ds-color-text-secondary)] text-white",
    text: "text-[var(--ds-color-text-secondary)]",
  },
} as const;

function formatUpdatedAt(value?: string) {
  if (!value) return "Sem atualização registrada";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Atualização não disponível";
  return parsed.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AprDocumentHero({
  number,
  title,
  status,
  version,
  company,
  site,
  responsible,
  updatedAt,
  hasPdfHash,
  readOnly = false,
}: AprDocumentHeroProps) {
  const meta = STATUS_META[status];
  const tone = TONE_CLASSES[meta.tone];
  const StatusIcon = meta.icon;

  return (
    <section
      aria-labelledby="apr-document-title"
      className="overflow-hidden rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-sm)]"
    >
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.38fr)] lg:p-7">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
            <span className="inline-flex items-center gap-1.5 text-[var(--ds-color-action-primary)]">
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
              Documento operacional
            </span>
            <span aria-hidden="true">/</span>
            <span>{number || "APR sem número"}</span>
          </div>
          <h1
            id="apr-document-title"
            className="mt-3 max-w-3xl text-2xl font-black tracking-[-0.02em] text-[var(--ds-color-text-primary)] sm:text-3xl"
          >
            {title || "Nova análise preliminar de risco"}
          </h1>
          <div className="mt-5 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <MetaItem icon={MapPin} label="Obra / site" value={site} />
            <MetaItem icon={FileCheck2} label="Empresa" value={company} />
            <MetaItem icon={UserRound} label="Responsável" value={responsible} />
            <MetaItem icon={GitBranch} label="Revisão" value={`Versão ${version}`} />
          </div>
        </div>

        <div className="flex flex-col justify-between gap-4">
          <div className={cn("rounded-[var(--ds-radius-lg)] border p-4", tone.shell)}>
            <div className="flex items-start gap-3">
              <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ds-radius-md)]", tone.icon)}>
                <StatusIcon className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className={cn("text-[11px] font-black uppercase tracking-[0.14em]", tone.text)}>
                  Status do documento
                </p>
                <p className="mt-1 text-lg font-black text-[var(--ds-color-text-primary)]">{meta.label}</p>
                <p className="mt-1 text-xs leading-5 text-[var(--ds-color-text-secondary)]">{meta.description}</p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--ds-color-border-subtle)] pt-4 text-xs text-[var(--ds-color-text-secondary)]">
            <span>
              Última atualização: <strong className="font-semibold text-[var(--ds-color-text-primary)]">{formatUpdatedAt(updatedAt)}</strong>
            </span>
            {hasPdfHash ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--ds-color-success)]">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Hash do PDF registrado
              </span>
            ) : readOnly ? (
              <span className="font-semibold text-[var(--ds-color-text-secondary)]">Somente leitura</span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function MetaItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof MapPin;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/35 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[var(--ds-color-text-secondary)]">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="text-[10px] font-bold uppercase tracking-[0.12em]">{label}</span>
      </div>
      <p className="mt-1 truncate font-semibold text-[var(--ds-color-text-primary)]">{value || "Não definido"}</p>
    </div>
  );
}
