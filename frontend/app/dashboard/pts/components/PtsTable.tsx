'use client';

import React from 'react';
import { Pt, PtApprovalBlockedPayload } from '@/services/ptsService';
import type { PtApprovalChecklistState, PtApprovalReview } from './PtApprovalReviewPanel';
import { PtsTableRow } from './PtsTableRow';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/state';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import { PtMobileCard } from './PtMobileCard';

interface PtsTableProps {
  pts: Pt[];
  loading: boolean;
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
  approvalIssuesById: Record<string, PtApprovalBlockedPayload>;
  approvalReviewById: Record<string, PtApprovalReview>;
  approvalChecklistById: Record<string, PtApprovalChecklistState>;
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

const EMPTY_APPROVAL_CHECKLIST: PtApprovalChecklistState = {
  reviewedReadiness: false,
  reviewedWorkers: false,
  confirmedRelease: false,
};

export const PtsTable = React.memo(
  ({
    pts,
    loading,
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
    approvalIssuesById,
    approvalReviewById,
    approvalChecklistById,
    onDismissApprovalIssue,
    onDismissApprovalReview,
    onUpdateApprovalChecklist,
    onEmitGovernedPdf,
    emittingPdfId,
  }: PtsTableProps) => {
    const row = (pt: Pt) => (
      <PtsTableRow
        key={pt.id}
        pt={pt}
        onDelete={onDelete}
        onPrint={onPrint}
        onSendEmail={onSendEmail}
        onDownloadPdf={onDownloadPdf}
        onPrepareApproval={onPrepareApproval}
        onApprove={onApprove}
        onReject={onReject}
        onFinalize={onFinalize}
        approvingId={approvingId}
        rejectingId={rejectingId}
        finalizingId={finalizingId}
        approvalReviewLoadingId={approvalReviewLoadingId}
        approvalIssue={approvalIssuesById[pt.id]}
        approvalReview={approvalReviewById[pt.id]}
        approvalChecklist={approvalChecklistById[pt.id] || EMPTY_APPROVAL_CHECKLIST}
        onDismissApprovalIssue={onDismissApprovalIssue}
        onDismissApprovalReview={onDismissApprovalReview}
        onUpdateApprovalChecklist={onUpdateApprovalChecklist}
        onEmitGovernedPdf={onEmitGovernedPdf}
        emittingPdfId={emittingPdfId}
      />
    );

    if (loading || pts.length === 0) {
      return (
        <div className="p-6">
          {loading ? (
            <div
              className="h-24 animate-pulse rounded-lg bg-[var(--ds-color-surface-muted)]"
              aria-label="Carregando PTs"
            />
          ) : (
            <EmptyState
              title="Nenhuma PT encontrada"
              description="Tente ajustar os filtros ou crie uma nova permissão de trabalho."
              compact
            />
          )}
        </div>
      );
    }

    return (
      <ResponsiveDataList
        items={pts}
        getKey={(pt) => pt.id}
        mobileClassName="grid min-w-0 gap-3 p-3"
        desktop={() => (
          <div className="overflow-x-auto" aria-label="PTs em tabela">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Número / Título</TableHead>
                  <TableHead>Início</TableHead>
                  <TableHead>Fim</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{pts.map(row)}</TableBody>
            </Table>
          </div>
        )}
        mobile={(pt) => (
          <PtMobileCard
            pt={pt}
            onDelete={onDelete}
            onPrint={onPrint}
            onSendEmail={onSendEmail}
            onDownloadPdf={onDownloadPdf}
            onPrepareApproval={onPrepareApproval}
            onApprove={onApprove}
            onReject={onReject}
            onFinalize={onFinalize}
            preparing={approvalReviewLoadingId === pt.id}
            approving={approvingId === pt.id}
            rejecting={rejectingId === pt.id}
            finalizing={finalizingId === pt.id}
            approvalIssue={approvalIssuesById[pt.id]}
            approvalReview={approvalReviewById[pt.id]}
            approvalChecklist={approvalChecklistById[pt.id] || EMPTY_APPROVAL_CHECKLIST}
            onDismissApprovalIssue={onDismissApprovalIssue}
            onDismissApprovalReview={onDismissApprovalReview}
            onUpdateApprovalChecklist={onUpdateApprovalChecklist}
          />
        )}
      />
    );
  },
);

PtsTable.displayName = 'PtsTable';
