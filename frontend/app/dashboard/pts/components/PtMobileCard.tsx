'use client';

import Link from 'next/link';
import { ArrowRight, Download, FileText, Mail, Pencil, Printer, Trash2 } from 'lucide-react';
import { ptBR } from 'date-fns/locale';
import { Pt, PtApprovalBlockedPayload } from '@/services/ptsService';
import { useAuth } from '@/context/AuthContext';
import { Permission } from '@/lib/permissions';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { safeFormatDate } from '@/lib/date/safeFormat';
import {
  PtApprovalChecklistState,
  PtApprovalReview,
  PtApprovalReviewPanel,
} from './PtApprovalReviewPanel';
import { PtSignatureActions } from './PtSignatureActions';
import { buildPtEditFocusHref } from './pt-approval-focus';

type Props = {
  pt: Pt;
  onDelete: (id: string) => void;
  onPrint: (id: string) => void;
  onSendEmail: (id: string) => void;
  onDownloadPdf: (id: string) => void;
  onPrepareApproval: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onFinalize: (id: string) => void;
  preparing: boolean;
  approving: boolean;
  rejecting: boolean;
  finalizing: boolean;
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
};

const statusClass: Record<string, string> = {
  Aprovada: 'bg-[var(--ds-color-success)] text-white',
  Pendente: 'bg-[var(--ds-color-warning)] text-white',
  Cancelada: 'bg-[var(--ds-color-danger)] text-white',
  Encerrada: 'bg-[var(--ds-color-text-muted)] text-white',
  Expirada: 'bg-[color:var(--ds-color-warning-hover)] text-white',
};

export function PtMobileCard({
  pt,
  onDelete,
  onPrint,
  onSendEmail,
  onDownloadPdf,
  onPrepareApproval,
  onApprove,
  onReject,
  onFinalize,
  preparing,
  approving,
  rejecting,
  finalizing,
  approvalIssue,
  approvalReview,
  approvalChecklist,
  onDismissApprovalIssue,
  onDismissApprovalReview,
  onUpdateApprovalChecklist,
  onEmitGovernedPdf,
  emittingPdfId,
}: Props) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.CAN_MANAGE_PT);
  const canMail = hasPermission(Permission.CAN_MANAGE_MAIL);
  const canApprove = hasPermission(Permission.CAN_APPROVE_PT);
  const pending = pt.status === 'Pendente';
  const finalizable = pt.status === 'Aprovada' || pt.status === 'Expirada';

  return (
    <article
      className="min-w-0 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 shadow-sm"
      aria-label={`PT ${pt.numero}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold text-[var(--ds-color-action-primary)]">{pt.numero}</p>
          <h3 className="mt-1 line-clamp-2 font-semibold">{pt.titulo}</h3>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium',
            statusClass[pt.status] || 'bg-[var(--ds-color-surface-muted)]',
          )}
        >
          {pt.status}
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-[var(--ds-color-text-secondary)]">Início</dt>
          <dd>{safeFormatDate(pt.data_hora_inicio, 'dd/MM/yyyy HH:mm', { locale: ptBR })}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--ds-color-text-secondary)]">Fim</dt>
          <dd>{safeFormatDate(pt.data_hora_fim, 'dd/MM/yyyy HH:mm', { locale: ptBR })}</dd>
        </div>
      </dl>

      {approvalIssue ? (
        <div className="mt-3 space-y-3 rounded-md bg-[color:var(--ds-color-warning)]/10 p-3 text-sm">
          <p>
            <strong>Aprovação bloqueada:</strong> {approvalIssue.message}
          </p>
          {approvalIssue.reasons?.length ? (
            <ul className="space-y-1">
              {approvalIssue.reasons.map((reason) => (
                <li key={reason}>• {reason}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Link
              href={buildPtEditFocusHref(
                pt.id,
                approvalIssue.reasons?.[0] || approvalIssue.message,
              )}
              className={cn(buttonVariants({ size: 'sm' }), 'inline-flex items-center')}
            >
              Corrigir PT <ArrowRight className="h-4 w-4" />
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
      ) : null}

      <div
        className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3"
        aria-label={`Ações da PT ${pt.numero}`}
      >
        <Button type="button" variant="outline" className="min-h-11" onClick={() => onPrint(pt.id)}>
          <Printer className="h-4 w-4" /> Imprimir
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => onDownloadPdf(pt.id)}
        >
          <Download className="h-4 w-4" /> PDF
        </Button>
        {pt.status === 'Aprovada' && !pt.pdf_file_key && onEmitGovernedPdf ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            loading={emittingPdfId === pt.id}
            onClick={() => onEmitGovernedPdf(pt.id)}
          >
            <FileText className="h-4 w-4" /> Emitir PDF
          </Button>
        ) : null}
        {canMail ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => onSendEmail(pt.id)}
          >
            <Mail className="h-4 w-4" /> E-mail
          </Button>
        ) : null}
        {pending && canApprove ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            loading={preparing}
            onClick={() => onPrepareApproval(pt.id)}
          >
            {approvalReview ? 'Atualizar pré-liberação' : 'Pré-liberação'}
          </Button>
        ) : null}
        {pending && canApprove ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 text-[var(--ds-color-danger)]"
            loading={rejecting}
            onClick={() => onReject(pt.id)}
          >
            Reprovar
          </Button>
        ) : null}
        {finalizable && canApprove ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            loading={finalizing}
            onClick={() => onFinalize(pt.id)}
          >
            Encerrar
          </Button>
        ) : null}
        {canManage ? (
          <Link
            href={`/dashboard/pts/edit/${pt.id}`}
            aria-disabled={!pending}
            className={cn(
              buttonVariants({ variant: 'outline' }),
              'min-h-11',
              !pending && 'pointer-events-none opacity-40',
            )}
          >
            <Pencil className="h-4 w-4" /> Editar
          </Link>
        ) : null}
        {canManage ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 text-[var(--ds-color-danger)]"
            onClick={() => onDelete(pt.id)}
          >
            <Trash2 className="h-4 w-4" /> Excluir
          </Button>
        ) : null}
        <PtSignatureActions
          ptId={pt.id}
          companyId={pt.company_id}
          buttonClassName="min-h-11"
          onSignatureSaved={() => {
            onDismissApprovalIssue(pt.id);
            if (pending && approvalReview) {
              onPrepareApproval(pt.id);
            }
          }}
        />
      </div>

      {pending && canApprove && approvalReview ? (
        <div className="mt-4">
          <PtApprovalReviewPanel
            ptId={pt.id}
            review={approvalReview}
            checklist={approvalChecklist}
            confirming={approving}
            onChecklistChange={(key, checked) => onUpdateApprovalChecklist(pt.id, key, checked)}
            onConfirm={() => onApprove(pt.id)}
            onDismiss={() => onDismissApprovalReview(pt.id)}
          />
        </div>
      ) : null}
    </article>
  );
}
