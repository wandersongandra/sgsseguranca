'use client';

import React from 'react';
import { Pt, PtApprovalBlockedPayload } from '@/services/ptsService';
import { ptBR } from 'date-fns/locale';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  Clock,
  Download,
  FileText,
  Mail,
  Pencil,
  Printer,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import { Permission } from '@/lib/permissions';

import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { TableCell, TableRow } from '@/components/ui/table';
import {
  PtApprovalChecklistState,
  PtApprovalReview,
  PtApprovalReviewPanel,
} from './PtApprovalReviewPanel';
import { buildPtEditFocusHref } from './pt-approval-focus';
import { safeFormatDate } from '@/lib/date/safeFormat';
import { PtSignatureActions } from './PtSignatureActions';

interface PtsTableRowProps {
  pt: Pt;
  onDelete: (id: string) => void;
  onPrint: (id: string) => void;
  onSendEmail: (id: string) => void;
  onDownloadPdf: (id: string) => void;
  onPrepareApproval: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onFinalize: (id: string) => void;
  approvingId: string | null;
  rejectingId: string | null;
  finalizingId: string | null;
  approvalReviewLoadingId: string | null;
  approvalIssue?: PtApprovalBlockedPayload;
  approvalReview?: PtApprovalReview;
  approvalChecklist: PtApprovalChecklistState;
  onDismissApprovalIssue: (id: string) => void;
  onDismissApprovalReview: (id: string) => void;
  onUpdateApprovalChecklist: (
    id: string,
    key: keyof PtApprovalChecklistState,
    checked: boolean,
  ) => void;
  onEmitGovernedPdf?: (id: string) => void;
  emittingPdfId?: string | null;
}

const approvalRuleLabels: Array<{
  key: keyof PtApprovalBlockedPayload['rules'];
  label: string;
}> = [
  {
    key: 'blockCriticalRiskWithoutEvidence',
    label: 'Bloquear risco crítico sem evidência',
  },
  {
    key: 'blockWorkerWithoutValidMedicalExam',
    label: 'Bloquear ASO inválido ou vencido',
  },
  {
    key: 'blockWorkerWithExpiredBlockingTraining',
    label: 'Bloquear treinamento crítico vencido',
  },
  {
    key: 'requireAtLeastOneExecutante',
    label: 'Exigir ao menos um executante',
  },
];

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'Aprovada':
      return <CheckCircle className="h-4 w-4 text-white" />;
    case 'Pendente':
      return <Clock className="h-4 w-4 text-white" />;
    case 'Cancelada':
      return <AlertTriangle className="h-4 w-4 text-white" />;
    case 'Encerrada':
      return <CheckCircle className="h-4 w-4 text-white" />;
    case 'Expirada':
      return <AlertTriangle className="h-4 w-4 text-white" />;
    default:
      return null;
  }
};

const getStatusClass = (status: string) => {
  switch (status) {
    case 'Aprovada':
      return 'bg-[var(--ds-color-success)] text-white';
    case 'Pendente':
      return 'bg-[var(--ds-color-warning)] text-white';
    case 'Cancelada':
      return 'bg-[var(--ds-color-danger)] text-white';
    case 'Encerrada':
      return 'bg-[var(--ds-color-text-muted)] text-white';
    case 'Expirada':
      return 'bg-[color:var(--ds-color-warning-hover)] text-white';
    default:
      return 'bg-[color:var(--ds-color-surface-muted)] text-[var(--ds-color-text-primary)]';
  }
};

export const PtsTableRow = React.memo(
  ({
    pt,
    onDelete,
    onPrint,
    onSendEmail,
    onDownloadPdf,
    onPrepareApproval,
    onApprove,
    onReject,
    onFinalize,
    approvingId,
    rejectingId,
    finalizingId,
    approvalReviewLoadingId,
    approvalIssue,
    approvalReview,
    approvalChecklist,
    onDismissApprovalIssue,
    onDismissApprovalReview,
    onUpdateApprovalChecklist,
    onEmitGovernedPdf,
    emittingPdfId,
  }: PtsTableRowProps) => {
    const { hasPermission } = useAuth();
    const isApproved = pt.status === 'Aprovada';
    const isAwaitingApproval = pt.status === 'Pendente';
    const isFinalizable = pt.status === 'Aprovada' || pt.status === 'Expirada';
    const isEditable = pt.status === 'Pendente';
    const canManagePt = hasPermission(Permission.CAN_MANAGE_PT);
    const canManageMail = hasPermission(Permission.CAN_MANAGE_MAIL);

    const canApprovePt = hasPermission(Permission.CAN_APPROVE_PT);
    const activeApprovalRules = approvalRuleLabels.filter(({ key }) => approvalIssue?.rules[key]);
    const isApproving = approvingId === pt.id;
    const isRejecting = rejectingId === pt.id;
    const isFinalizing = finalizingId === pt.id;
    const isPreparingApproval = approvalReviewLoadingId === pt.id;

    return (
      <>
        <TableRow>
          <TableCell>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="font-medium text-[var(--ds-color-text-primary)]">{pt.numero}</div>
                {approvalIssue ? <Badge variant="warning">Aprovação bloqueada</Badge> : null}
              </div>
              <div className="text-[var(--ds-color-text-primary)]">{pt.titulo}</div>
            </div>
          </TableCell>
          <TableCell className="text-[var(--ds-color-text-primary)]">
            {safeFormatDate(pt.data_hora_inicio, 'dd/MM/yyyy HH:mm', { locale: ptBR })}
          </TableCell>
          <TableCell className="text-[var(--ds-color-text-primary)]">
            {safeFormatDate(pt.data_hora_fim, 'dd/MM/yyyy HH:mm', { locale: ptBR })}
          </TableCell>
          <TableCell>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
                getStatusClass(pt.status),
              )}
            >
              {getStatusIcon(pt.status)}
              {pt.status}
            </span>
          </TableCell>
          <TableCell className="text-right">
            <div className="flex items-center justify-end gap-1">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => onPrint(pt.id)}
                title={
                  pt.pdf_file_key || isApproved
                    ? 'Imprimir PDF final governado'
                    : 'Imprimir pré-visualização'
                }
              >
                <Printer className="h-4 w-4" />
              </Button>
              {canManageMail ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => onSendEmail(pt.id)}
                  title={
                    pt.pdf_file_key || isApproved
                      ? 'Enviar PDF final governado por e-mail'
                      : 'Enviar pré-visualização por e-mail'
                  }
                >
                  <Mail className="h-4 w-4" />
                </Button>
              ) : null}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => onDownloadPdf(pt.id)}
                title={pt.pdf_file_key || isApproved ? 'Abrir PDF final governado' : 'Baixar PDF'}
              >
                <Download className="h-4 w-4" />
              </Button>
              {isApproved && !pt.pdf_file_key && onEmitGovernedPdf ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  loading={emittingPdfId === pt.id}
                  onClick={() => onEmitGovernedPdf(pt.id)}
                  title="Emitir PDF final governado"
                >
                  <FileText className="h-4 w-4" />
                </Button>
              ) : null}
              {isAwaitingApproval && canApprovePt ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={isPreparingApproval}
                    onClick={() => onPrepareApproval(pt.id)}
                    title="Abrir pré-liberação da PT"
                  >
                    {approvalReview ? 'Atualizar pré-liberação' : 'Pré-liberação'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={isRejecting}
                    onClick={() => onReject(pt.id)}
                    className="border-[color:var(--ds-color-danger)]/30 text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10"
                    title="Reprovar PT"
                  >
                    Reprovar
                  </Button>
                </>
              ) : null}
              {isFinalizable && canApprovePt ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={isFinalizing}
                  onClick={() => onFinalize(pt.id)}
                  title="Encerrar PT"
                >
                  Encerrar
                </Button>
              ) : null}
              {canManagePt ? (
                <>
                  <Link
                    href={`/dashboard/pts/edit/${pt.id}`}
                    className={cn(
                      buttonVariants({ size: 'icon', variant: 'ghost' }),
                      !isEditable
                        ? 'pointer-events-none text-[var(--ds-color-text-muted)] opacity-40'
                        : '',
                    )}
                    title={isEditable ? 'Editar PT' : 'Somente PTs pendentes podem ser editadas'}
                  >
                    <Pencil className="h-4 w-4" />
                  </Link>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => onDelete(pt.id)}
                    className="text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]"
                    title="Excluir PT"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              ) : null}
              <PtSignatureActions
                ptId={pt.id}
                companyId={pt.company_id}
                iconOnly
                onSignatureSaved={() => {
                  onDismissApprovalIssue(pt.id);
                  if (isAwaitingApproval && approvalReview) {
                    onPrepareApproval(pt.id);
                  }
                }}
              />
            </div>
          </TableCell>
        </TableRow>

        {approvalReview ? (
          <TableRow>
            <TableCell colSpan={5} className="bg-[color:var(--ds-color-action-primary)]/6">
              <PtApprovalReviewPanel
                ptId={pt.id}
                review={approvalReview}
                checklist={approvalChecklist}
                confirming={isApproving}
                onChecklistChange={(key, checked) => onUpdateApprovalChecklist(pt.id, key, checked)}
                onConfirm={() => onApprove(pt.id)}
                onDismiss={() => onDismissApprovalReview(pt.id)}
              />
            </TableCell>
          </TableRow>
        ) : null}

        {approvalIssue ? (
          <TableRow>
            <TableCell colSpan={5} className="bg-[color:var(--ds-color-warning-subtle)]/20">
              <div className="rounded-[var(--ds-radius-lg)] border border-[color:var(--ds-color-warning)]/30 bg-[color:var(--ds-color-warning)]/10 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-warning)]">
                      <AlertTriangle className="h-4 w-4" />
                      Bloqueio de aprovação
                    </div>
                    <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                      {approvalIssue.message}
                    </p>
                    <p className="text-sm text-[var(--ds-color-text-primary)]">
                      Corrija os itens abaixo antes de tentar liberar a permissão.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {activeApprovalRules.map((rule) => (
                      <Badge key={rule.key} variant="neutral">
                        {rule.label}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div className="mt-4 grid gap-2 md:grid-cols-2">
                  {approvalIssue.reasons.map((reason) => (
                    <div
                      key={reason}
                      className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/40 px-3 py-2 text-sm text-[var(--ds-color-text-primary)]"
                    >
                      {reason}
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Link
                    href={buildPtEditFocusHref(
                      pt.id,
                      approvalIssue.reasons[0] || approvalIssue.message,
                    )}
                    className={cn(buttonVariants({ size: 'sm' }), 'inline-flex items-center')}
                  >
                    Abrir PT para corrigir
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onDismissApprovalIssue(pt.id)}
                  >
                    Dispensar aviso
                  </Button>
                </div>
              </div>
            </TableCell>
          </TableRow>
        ) : null}
      </>
    );
  },
);

PtsTableRow.displayName = 'PtsTableRow';
