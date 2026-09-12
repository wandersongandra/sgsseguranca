"use client";

import { ElementType, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock,
  Download,
  FileCheck2,
  FileWarning,
  FileText,
  GitBranch,
  Loader2,
  Mail,
  MapPin,
  PenLine,
  Printer,
  ShieldCheck,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";
import { ActionMenu } from "@/components/ActionMenu";
import { Button, buttonVariants } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { useAuth } from "@/context/AuthContext";
import { Permission } from '@/lib/permissions';
import { cn } from "@/lib/utils";
import {
  AprListingDensity,
  AprListingRecord,
  formatAprDate,
  getAprDeadlineMeta,
  getAprPdfMeta,
  getAprResponsibleMeta,
  getAprSignatureMeta,
  getAprStatusMeta,
  getToneClasses,
} from "./aprListingUtils";

const STATUS_ICON: Record<string, ElementType> = {
  Pendente: Clock,
  Aprovada: ShieldCheck,
  Encerrada: Archive,
  Cancelada: XCircle,
};

interface AprListingRowProps {
  apr: AprListingRecord;
  density: AprListingDensity;
  onDelete: (id: string) => void;
  onPrint: (apr: AprListingRecord) => void;
  onSendEmail: (id: string) => void;
  onDownloadPdf: (id: string) => void;
  onApprove: (id: string) => void;
  onFinalize: (id: string) => void;
  onReject: (id: string) => void;
  onCreateNewVersion: (id: string) => void;
  isPending: boolean;
  onOpenSignature: (apr: AprListingRecord) => void;
  onOpenSignatures: (apr: AprListingRecord) => void;
}

export function AprListingRow({
  apr,
  density,
  onDelete,
  onPrint,
  onSendEmail,
  onDownloadPdf,
  onApprove,
  onFinalize,
  onReject,
  onCreateNewVersion,
  isPending,
  onOpenSignature,
  onOpenSignatures,
}: AprListingRowProps) {
  const { hasPermission } = useAuth();
  const router = useRouter();

  const status = getAprStatusMeta(apr);
  const deadline = getAprDeadlineMeta(apr);
  const signature = getAprSignatureMeta(apr);
  const pdf = getAprPdfMeta(apr);
  const responsible = getAprResponsibleMeta(apr);
  const statusTone = getToneClasses(status.tone);
  const deadlineTone = getToneClasses(deadline.tone);
  const signatureTone = getToneClasses(signature.tone);
  const pdfTone = getToneClasses(pdf.tone);
  const isApproved = apr.status === "Aprovada";
  const hasGovernedPdf = Boolean(apr.has_final_pdf);
  const canUpdateApr = hasPermission(Permission.CAN_UPDATE_APR);
  const canApproveApr = hasPermission(Permission.CAN_APPROVE_APR);
  const canRejectApr = hasPermission(Permission.CAN_REJECT_APR);
  const canFinalizeApr = hasPermission(Permission.CAN_FINALIZE_APR);
  const canDeleteApr = hasPermission(Permission.CAN_DELETE_APR);
  const canManageSignatures = hasPermission(Permission.CAN_MANAGE_SIGNATURES);
  const canViewSignatures = hasPermission(Permission.CAN_VIEW_SIGNATURES);
  const StatusIcon = STATUS_ICON[apr.status] ?? ShieldCheck;
  const cellPadding = density === "compact" ? "py-3" : "py-4";
  const criticalCount = apr.classificacao_resumo?.critico ?? 0;
  const substantialCount = apr.classificacao_resumo?.substancial ?? 0;

  const handleOpenPdf = useCallback(() => {
    onDownloadPdf(apr.id);
  }, [apr.id, onDownloadPdf]);

  const handlePrintClick = useCallback(() => {
    onPrint(apr);
  }, [apr, onPrint]);

  const handleApproveClick = useCallback(() => {
    if (isPending) return;
    onApprove(apr.id);
  }, [apr.id, isPending, onApprove]);

  const handleRejectClick = useCallback(() => {
    if (isPending) return;
    onReject(apr.id);
  }, [apr.id, isPending, onReject]);

  const handleCreateNewVersionClick = useCallback(() => {
    if (isPending) return;
    onCreateNewVersion(apr.id);
  }, [apr.id, isPending, onCreateNewVersion]);

  const handleFinalizeClick = useCallback(() => {
    if (isPending) return;
    onFinalize(apr.id);
  }, [apr.id, isPending, onFinalize]);

  const handleSendEmailClick = useCallback(() => {
    if (isPending) return;
    onSendEmail(apr.id);
  }, [apr.id, isPending, onSendEmail]);

  const handleOpenSignatureClick = useCallback(() => {
    if (isPending || !canManageSignatures) return;
    onOpenSignature(apr);
  }, [apr, canManageSignatures, isPending, onOpenSignature]);

  const handleOpenSignaturesClick = useCallback(() => {
    if (isPending || !canViewSignatures) return;
    onOpenSignatures(apr);
  }, [apr, canViewSignatures, isPending, onOpenSignatures]);

  const handleEditClick = useCallback(() => {
    if (isPending) return;
    router.push(`/dashboard/aprs/edit/${apr.id}`);
  }, [apr.id, isPending, router]);

  const handleDeleteClick = useCallback(() => {
    if (isPending) return;
    onDelete(apr.id);
  }, [apr.id, isPending, onDelete]);

  const primaryAction = (() => {
    if (isApproved && !hasGovernedPdf) {
      return (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="px-0 text-[13px]"
          onClick={handleOpenPdf}
          disabled={isPending}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
          ) : null}
          Emitir PDF
        </Button>
      );
    }

    if (isApproved && hasGovernedPdf) {
      return (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="px-0 text-[13px]"
          onClick={handleOpenPdf}
          disabled={isPending}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
          ) : null}
          Abrir PDF
        </Button>
      );
    }

    return (
      <Link
        href={`/dashboard/aprs/edit/${apr.id}`}
        className={cn(
          buttonVariants({ variant: "link", size: "sm" }),
          "px-0 text-[13px]",
          isPending && "pointer-events-none opacity-60",
        )}
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
        ) : null}
        Abrir
      </Link>
    );
  })();

  const actionItems = useMemo(
    () => [
      ...((canApproveApr || canRejectApr) && apr.status === "Pendente"
        ? [
            ...(canApproveApr
              ? [
                  {
                    label: "Aprovar APR",
                    icon: <CheckCircle2 className="h-4 w-4" />,
                    onClick: handleApproveClick,
                  },
                ]
              : []),
            ...(canRejectApr
              ? [
                  {
                    label: "Reprovar APR",
                    icon: <XCircle className="h-4 w-4" />,
                    onClick: handleRejectClick,
                    variant: "danger" as const,
                  },
                ]
              : []),
          ]
        : []),
      ...(canUpdateApr && isApproved
        ? [
            {
              label: "Criar nova versão",
              icon: <GitBranch className="h-4 w-4" />,
              onClick: handleCreateNewVersionClick,
            },
          ]
        : []),
      ...(canFinalizeApr && isApproved && hasGovernedPdf
        ? [
            {
              label: "Encerrar APR",
              icon: <CheckCircle2 className="h-4 w-4" />,
              onClick: handleFinalizeClick,
            },
          ]
        : []),
      {
        label: hasGovernedPdf ? "Abrir PDF final" : "PDF final indisponível",
        icon: <Download className="h-4 w-4" />,
        onClick: handleOpenPdf,
        disabled: !hasGovernedPdf,
        title: !hasGovernedPdf ? "Disponível após aprovação e geração do PDF" : undefined,
      },
      {
        label: hasGovernedPdf ? "Imprimir PDF final" : "Pré-visualizar APR",
        icon: <Printer className="h-4 w-4" />,
        onClick: handlePrintClick,
      },
      {
        label: hasGovernedPdf
          ? "Enviar PDF governado por e-mail"
          : "Envio oficial indisponível",
        icon: <Mail className="h-4 w-4" />,
        onClick: handleSendEmailClick,
      },
      ...(canManageSignatures
        ? [
            {
              label: "Assinar APR",
              icon: <PenLine className="h-4 w-4" />,
              onClick: handleOpenSignatureClick,
            },
          ]
        : []),
      ...(canViewSignatures
        ? [
            {
              label: "Ver assinaturas",
              icon: <Users className="h-4 w-4" />,
              onClick: handleOpenSignaturesClick,
            },
          ]
        : []),
      ...(canUpdateApr && !isApproved
        ? [
            {
              label: "Editar APR",
              icon: <FileText className="h-4 w-4" />,
              onClick: handleEditClick,
            },
          ]
        : []),
      ...(canDeleteApr
        ? [
            {
              label: "Excluir APR",
              icon: <Trash2 className="h-4 w-4" />,
              onClick: handleDeleteClick,
              variant: "danger" as const,
            },
          ]
        : []),
    ],
    [
      apr.status,
      canApproveApr,
      canDeleteApr,
      canFinalizeApr,
      canRejectApr,
      canUpdateApr,
      canManageSignatures,
      canViewSignatures,
      handleApproveClick,
      handleCreateNewVersionClick,
      handleDeleteClick,
      handleEditClick,
      handleFinalizeClick,
      handleOpenPdf,
      handleOpenSignatureClick,
      handleOpenSignaturesClick,
      handlePrintClick,
      handleRejectClick,
      handleSendEmailClick,
      hasGovernedPdf,
      isApproved,
    ],
  );

  return (
    <TableRow
      className={cn(
        "group",
        density === "compact" ? "h-[72px]" : "h-[92px]",
        status.tone === "danger" &&
          "border-l-2 border-l-[var(--ds-color-danger)]",
        status.tone === "warning" &&
          "border-l-2 border-l-[var(--ds-color-warning)]",
        status.tone === "success" &&
          "border-l-2 border-l-[var(--ds-color-success)]",
      )}
    >
      <TableCell className={cn("align-middle", cellPadding)}>
        <div className="min-w-[230px] space-y-2">
          <div className="flex items-center gap-2">
            <span className="rounded-[var(--ds-radius-sm)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] px-2 py-1 text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--ds-color-text-secondary)]">
              {apr.numero || "Sem número"}
            </span>
            <span className="text-[11px] font-semibold text-[var(--ds-color-text-muted)]">
              v{apr.versao || 1}
            </span>
          </div>
          <p className="max-w-[260px] text-[15px] font-bold leading-5 text-[var(--ds-color-text-primary)]">
            {apr.titulo || "APR sem título"}
          </p>
          {apr.tipo_atividade ? (
            <p className="max-w-[260px] truncate text-xs font-medium text-[var(--ds-color-text-secondary)]">
              {apr.tipo_atividade}
            </p>
          ) : null}
        </div>
      </TableCell>

      <TableCell className={cn("align-middle", cellPadding)}>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold",
            statusTone.badge,
          )}
        >
          <StatusIcon className="h-3.5 w-3.5" />
          {status.label}
        </span>
        {criticalCount > 0 || substantialCount > 0 ? (
          <p className="mt-2 text-[11px] font-semibold text-[var(--ds-color-text-secondary)]">
            {criticalCount > 0
              ? `${criticalCount} crítico(s)`
              : `${substantialCount} substancial(is)`}
          </p>
        ) : null}
      </TableCell>

      <TableCell className={cn("align-middle", cellPadding)}>
        <div className="min-w-[180px] space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
            <Building2 className="h-4 w-4 text-[var(--ds-color-text-muted)]" />
            <span className="max-w-[180px] truncate">
              {apr.company?.razao_social || "Empresa não vinculada"}
            </span>
          </div>
        </div>
      </TableCell>

      <TableCell className={cn("align-middle", cellPadding)}>
        <div className="min-w-[180px] space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
            <MapPin className="h-4 w-4 text-[var(--ds-color-text-muted)]" />
            <span className="max-w-[180px] truncate">
              {apr.site?.nome || "Obra não vinculada"}
            </span>
          </div>
          {apr.frente_trabalho || apr.area_risco ? (
            <p className="max-w-[180px] truncate pl-6 text-xs text-[var(--ds-color-text-secondary)]">
              {apr.frente_trabalho || apr.area_risco}
            </p>
          ) : null}
        </div>
      </TableCell>

      <TableCell className={cn("align-middle", cellPadding)}>
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
            <CalendarDays className="h-4 w-4 text-[var(--ds-color-text-muted)]" />
            <span>{formatAprDate(apr.data_inicio)}</span>
          </div>
          <p className={cn("pl-6 text-xs font-semibold", deadlineTone.text)}>
            {deadline.relativeLabel}
          </p>
          <p className="pl-6 text-[11px] text-[var(--ds-color-text-muted)]">
            até {deadline.absoluteLabel}
          </p>
        </div>
      </TableCell>

      <TableCell className={cn("align-middle", cellPadding)}>
        <div className="space-y-1">
          <p className="max-w-[170px] truncate text-sm font-semibold text-[var(--ds-color-text-primary)]">
            {responsible.name}
          </p>
          <p className="text-xs text-[var(--ds-color-text-secondary)]">
            {responsible.role}
          </p>
        </div>
      </TableCell>

      <TableCell className={cn("align-middle", cellPadding)}>
        <button
          type="button"
          onClick={handleOpenSignaturesClick}
          disabled={isPending || !canViewSignatures}
          className={cn(
            "inline-flex min-w-[128px] flex-col items-start rounded-[var(--ds-radius-md)] border px-3 py-2 text-left motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)] disabled:opacity-60",
            signatureTone.inline,
          )}
        >
          <span className="inline-flex items-center gap-1.5 text-xs font-bold">
            <Users className="h-3.5 w-3.5" />
            {signature.label}
          </span>
          <span className="mt-0.5 text-[11px] font-medium opacity-85">
            {signature.detail}
          </span>
        </button>
      </TableCell>

      <TableCell className={cn("align-middle", cellPadding)}>
        <button
          type="button"
          onClick={handleOpenPdf}
          disabled={isPending}
          className={cn(
            "inline-flex min-w-[126px] flex-col items-start rounded-[var(--ds-radius-md)] border px-3 py-2 text-left motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)] disabled:opacity-60",
            pdfTone.inline,
          )}
        >
          <span className="inline-flex items-center gap-1.5 text-xs font-bold">
            {hasGovernedPdf ? (
              <FileCheck2 className="h-3.5 w-3.5" />
            ) : (
              <FileWarning className="h-3.5 w-3.5" />
            )}
            {pdf.label}
          </span>
          <span className="mt-0.5 max-w-[112px] truncate text-[11px] font-medium opacity-85">
            {pdf.detail}
          </span>
        </button>
      </TableCell>

      <TableCell className={cn("align-middle text-right", cellPadding)}>
        <div className="flex items-center justify-end gap-1">
          {primaryAction}
          <div className={cn(isPending && "pointer-events-none opacity-60")}>
            <ActionMenu items={actionItems} />
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}
