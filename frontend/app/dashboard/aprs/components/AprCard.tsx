"use client";

import React, { useCallback, useMemo } from "react";
import { Apr } from "@/services/aprsService";
import {
  Building2,
  Calendar,
  Download,
  FileCheck2,
  FileWarning,
  GitBranch,
  Mail,
  MapPin,
  PenLine,
  Pencil,
  Printer,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { Permission } from '@/lib/permissions';
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionMenu } from "@/components/ActionMenu";
import { safeToLocaleDateString } from "@/lib/date/safeFormat";
import {
  getAprPdfMeta,
  getAprResponsibleMeta,
  getAprSignatureMeta,
  getAprStatusMeta,
  getToneClasses,
} from "./aprListingUtils";

interface AprCardProps {
  apr: Apr;
  onDelete: (id: string) => void;
  onPrint: (apr: Apr) => void;
  onSendEmail: (id: string) => void;
  onDownloadPdf: (id: string) => void;
  onApprove: (id: string) => void;
  onFinalize: (id: string) => void;
  onReject: (id: string) => void;
  onCreateNewVersion: (id: string) => void;
  onOpenSignature: (apr: Apr) => void;
  onOpenSignatures: (apr: Apr) => void;
}

export const AprCard = React.memo(
  ({
    apr,
    onDelete,
    onPrint,
    onSendEmail,
    onDownloadPdf,
    onApprove,
    onFinalize,
    onReject,
    onCreateNewVersion,
    onOpenSignature,
    onOpenSignatures,
  }: AprCardProps) => {
    const { hasPermission } = useAuth();

    const isApproved = apr.status === "Aprovada";
    const isPending = apr.status === "Pendente";
    const isLocked = apr.status === "Cancelada" || apr.status === "Encerrada";
    const hasGovernedPdf = Boolean(apr.has_final_pdf);
    const canUpdateApr = hasPermission(Permission.CAN_UPDATE_APR);
    const canApproveApr = hasPermission(Permission.CAN_APPROVE_APR);
    const canRejectApr = hasPermission(Permission.CAN_REJECT_APR);
    const canFinalizeApr = hasPermission(Permission.CAN_FINALIZE_APR);
    const canDeleteApr = hasPermission(Permission.CAN_DELETE_APR);
    const canManageSignatures = hasPermission(Permission.CAN_MANAGE_SIGNATURES);
    const canViewSignatures = hasPermission(Permission.CAN_VIEW_SIGNATURES);
    const hasCriticalRisk = (apr.classificacao_resumo?.critico || 0) > 0;
    const hasSubstantialRisk = (apr.classificacao_resumo?.substancial || 0) > 0;
    const status = getAprStatusMeta(apr);
    const statusTone = getToneClasses(status.tone);
    const responsible = getAprResponsibleMeta(apr);
    const signature = getAprSignatureMeta(apr);
    const signatureTone = getToneClasses(signature.tone);
    const pdf = getAprPdfMeta(apr);
    const pdfTone = getToneClasses(pdf.tone);
    const riskHighlightClass = hasCriticalRisk
      ? "border-[color:var(--ds-color-danger)]/30"
      : hasSubstantialRisk
        ? "border-[color:var(--ds-color-warning)]/30"
        : "";

    const handleCreateNewVersion = useCallback(() => {
      onCreateNewVersion(apr.id);
    }, [apr.id, onCreateNewVersion]);

    const handleFinalize = useCallback(() => {
      onFinalize(apr.id);
    }, [apr.id, onFinalize]);

    const handleApprove = useCallback(() => {
      onApprove(apr.id);
    }, [apr.id, onApprove]);

    const handleReject = useCallback(() => {
      onReject(apr.id);
    }, [apr.id, onReject]);

    const handlePrintClick = useCallback(() => {
      onPrint(apr);
    }, [apr, onPrint]);

    const handleDownloadClick = useCallback(() => {
      onDownloadPdf(apr.id);
    }, [apr.id, onDownloadPdf]);

    const handleSendEmailClick = useCallback(() => {
      onSendEmail(apr.id);
    }, [apr.id, onSendEmail]);

    const handleOpenSignModal = useCallback(() => {
      if (!canManageSignatures) return;
      onOpenSignature(apr);
    }, [apr, canManageSignatures, onOpenSignature]);

    const handleOpenSignaturesPanel = useCallback(() => {
      if (!canViewSignatures) return;
      onOpenSignatures(apr);
    }, [apr, canViewSignatures, onOpenSignatures]);

    const handleDeleteClick = useCallback(() => {
      onDelete(apr.id);
    }, [apr.id, onDelete]);

    const actionItems = useMemo(
      () => [
        {
          label: hasGovernedPdf
            ? "Enviar PDF governado por e-mail"
            : "Enviar pré-visualização por e-mail",
          icon: <Mail className="h-4 w-4" />,
          onClick: handleSendEmailClick,
        },
        ...(canManageSignatures
          ? [
              {
                label: "Assinar APR",
                icon: <PenLine className="h-4 w-4" />,
                onClick: handleOpenSignModal,
              },
            ]
          : []),
        ...(canViewSignatures
          ? [
              {
                label: "Ver assinaturas",
                icon: <Users className="h-4 w-4" />,
                onClick: handleOpenSignaturesPanel,
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
        canManageSignatures,
        canDeleteApr,
        canViewSignatures,
        handleDeleteClick,
        handleOpenSignModal,
        handleOpenSignaturesPanel,
        handleSendEmailClick,
        hasGovernedPdf,
      ],
    );

    return (
      <Card
        tone="elevated"
        padding="none"
        className={cn(
          "group flex h-full overflow-hidden border-[var(--ds-color-border-default)] shadow-[var(--ds-shadow-sm)] motion-safe:transition-shadow motion-safe:duration-[var(--ds-motion-base)] hover:shadow-[var(--ds-shadow-md)]",
          riskHighlightClass,
        )}
      >
        <div
          className={cn(
            "h-1.5",
            status.tone === "success" && "bg-[var(--ds-color-success)]",
            status.tone === "warning" && "bg-[var(--ds-color-warning)]",
            status.tone === "danger" && "bg-[var(--ds-color-danger)]",
            status.tone === "info" && "bg-[var(--ds-color-info)]",
            status.tone === "neutral" && "bg-[var(--ds-color-border-strong)]",
          )}
        />

        <CardHeader className="gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-[var(--ds-radius-sm)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--ds-color-text-secondary)]">
                  {apr.numero || "Sem número"}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ds-color-surface-muted)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ds-color-text-secondary)]">
                  <GitBranch className="h-3.5 w-3.5" />v{apr.versao || 1}
                </span>
              </div>
            </div>
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold",
                statusTone.badge,
              )}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>{status.label}</span>
            </span>
          </div>

          <div className="space-y-2">
            <CardTitle className="text-lg leading-6 text-[var(--ds-color-text-primary)]">
              {apr.titulo}
            </CardTitle>
            <p className="line-clamp-2 text-sm text-[var(--ds-color-text-secondary)]">
              {apr.descricao || "Sem descrição."}
            </p>
          </div>
        </CardHeader>

        <CardContent className="mt-0 flex flex-1 flex-col px-5 pb-5">
          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <AprCardMetric
              icon={<Building2 className="h-4 w-4" />}
              label="Empresa"
              value={apr.company?.razao_social || "Não vinculada"}
            />
            <AprCardMetric
              icon={<MapPin className="h-4 w-4" />}
              label="Obra"
              value={apr.site?.nome || "Não vinculada"}
            />
            <AprCardMetric
              icon={<Calendar className="h-4 w-4" />}
              label="Data"
              value={safeToLocaleDateString(
                apr.data_inicio,
                "pt-BR",
                undefined,
                "—",
              )}
              detail={
                apr.data_fim
                  ? `até ${safeToLocaleDateString(apr.data_fim, "pt-BR", undefined, "—")}`
                  : undefined
              }
            />
            <AprCardMetric
              icon={<Users className="h-4 w-4" />}
              label="Responsável"
              value={responsible.name}
              detail={responsible.role}
            />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={handleOpenSignaturesPanel}
              disabled={!canViewSignatures}
              className={cn(
                "rounded-[var(--ds-radius-md)] border px-3 py-3 text-left motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)]",
                !canViewSignatures && "cursor-default opacity-70",
                signatureTone.inline,
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-bold">
                <Users className="h-3.5 w-3.5" />
                {signature.label}
              </span>
              <span className="mt-1 block text-[11px] font-medium opacity-85">
                {signature.detail}
              </span>
            </button>
            <button
              type="button"
              onClick={handleDownloadClick}
              className={cn(
                "rounded-[var(--ds-radius-md)] border px-3 py-3 text-left motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)]",
                pdfTone.inline,
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-bold">
                {hasGovernedPdf ? (
                  <FileCheck2 className="h-3.5 w-3.5" />
                ) : (
                  <FileWarning className="h-3.5 w-3.5" />
                )}
                {pdf.label}
              </span>
              <span className="mt-1 block truncate text-[11px] font-medium opacity-85">
                {pdf.detail}
              </span>
            </button>
          </div>

          {hasCriticalRisk || hasSubstantialRisk ? (
            <div
              className={cn(
                "mt-4 rounded-[var(--ds-radius-md)] border px-3 py-2 text-xs font-semibold",
                hasCriticalRisk
                  ? "border-[color:var(--ds-color-danger)]/20 bg-[color:var(--ds-color-danger)]/8 text-[var(--ds-color-danger)]"
                  : "border-[color:var(--ds-color-warning)]/20 bg-[color:var(--ds-color-warning)]/10 text-[var(--ds-color-warning)]",
              )}
            >
              {hasCriticalRisk
                ? `${apr.classificacao_resumo?.critico} risco(s) crítico(s) nesta APR`
                : `${apr.classificacao_resumo?.substancial} risco(s) substancial(is) nesta APR`}
            </div>
          ) : null}

          <div className="mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-[var(--ds-color-border-subtle)] pt-4">
            {isApproved && canUpdateApr ? (
              <>
                <Button
                  type="button"
                  onClick={handleCreateNewVersion}
                  variant="outline"
                  size="md"
                  title="Criar nova versão"
                >
                  Nova versão
                </Button>
                {hasGovernedPdf && canFinalizeApr ? (
                  <Button
                    type="button"
                    onClick={handleFinalize}
                    variant="outline"
                    size="md"
                    title="Encerrar APR"
                  >
                    Encerrar
                  </Button>
                ) : null}
              </>
            ) : isPending && (canApproveApr || canRejectApr) ? (
              <>
                {canApproveApr ? (
                  <Button
                    type="button"
                    onClick={handleApprove}
                    variant="outline"
                    size="md"
                    title="Aprovar APR"
                  >
                    Aprovar
                  </Button>
                ) : null}
                {canRejectApr ? (
                  <Button
                    type="button"
                    onClick={handleReject}
                    variant="outline"
                    size="md"
                    className="border-[color:var(--ds-color-danger)]/30 text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10"
                    title="Reprovar APR"
                  >
                    Reprovar
                  </Button>
                ) : null}
              </>
            ) : null}

            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={handlePrintClick}
              title={
                hasGovernedPdf
                  ? "Imprimir PDF final governado da APR"
                  : "Pré-visualizar rascunho da APR"
              }
              aria-label={
                hasGovernedPdf
                  ? "Imprimir PDF final governado da APR"
                  : "Pré-visualizar rascunho da APR"
              }
            >
              <Printer className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={handleDownloadClick}
              title={
                hasGovernedPdf
                  ? "Abrir PDF final governado da APR"
                  : "PDF final oficial ainda não gerado"
              }
              aria-label={
                hasGovernedPdf
                  ? "Abrir PDF final governado da APR"
                  : "PDF final oficial ainda não gerado"
              }
            >
              <Download className="h-4 w-4" />
            </Button>
            <Link
              href={`/dashboard/aprs/edit/${apr.id}`}
              className={cn(
                buttonVariants({ size: "icon", variant: "ghost" }),
                isApproved || isLocked
                  ? "pointer-events-none text-[var(--ds-color-text-muted)] opacity-40"
                  : "",
              )}
              title={
                isApproved
                  ? "APR aprovada: edição bloqueada"
                  : isLocked
                    ? `APR ${apr.status.toLowerCase()}: edição bloqueada`
                    : "Editar APR"
              }
              aria-label={
                isApproved
                  ? "APR aprovada: edição bloqueada"
                  : isLocked
                    ? `APR ${apr.status.toLowerCase()}: edição bloqueada`
                    : "Editar APR"
              }
            >
              <Pencil className="h-4 w-4" />
            </Link>
            <ActionMenu items={actionItems} triggerAriaLabel="Mais ações" />
          </div>
        </CardContent>
      </Card>
    );
  },
);

AprCard.displayName = "AprCard";

function AprCardMetric({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/32 px-3 py-3">
      <div className="flex items-center gap-2 text-[var(--ds-color-text-muted)]">
        {icon}
        <span className="text-[11px] font-bold uppercase tracking-[0.04em]">
          {label}
        </span>
      </div>
      <p className="mt-1 truncate text-sm font-semibold text-[var(--ds-color-text-primary)]">
        {value}
      </p>
      {detail ? (
        <p className="mt-0.5 truncate text-xs text-[var(--ds-color-text-secondary)]">
          {detail}
        </p>
      ) : null}
    </div>
  );
}
