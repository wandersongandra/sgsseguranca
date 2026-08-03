'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileLock2, FileSpreadsheet, Plus } from 'lucide-react';
import Link from 'next/link';
import { downloadExcel } from '@/lib/download-excel';
import { usePts } from './hooks/usePts';
import { PtsFilters } from './components/PtsFilters';
import { PtsTable } from './components/PtsTable';
import { PtsInsights } from './components/PtsInsights';
import { PtApprovalRulesPanel } from './components/PtApprovalRulesPanel';
import { PtClosureModal } from './components/PtClosureModal';
import { PtRejectModal } from './components/PtRejectModal';
import { ptsService } from '@/services/ptsService';
import { companiesService } from '@/services/companiesService';
import { PaginationControls } from '@/components/PaginationControls';
import { Button, buttonVariants } from '@/components/ui/button';
import { ErrorState, InlineLoadingState } from '@/components/ui/state';
import { ListPageLayout } from '@/components/layout';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import { Permission } from '@/lib/permissions';
import { logger } from '@/lib/logger';

const SendMailModal = dynamic(
  () => import('@/components/SendMailModal').then((module) => module.SendMailModal),
  { ssr: false },
);
const StoredFilesPanel = dynamic(
  () => import('@/components/StoredFilesPanel').then((module) => module.StoredFilesPanel),
  {
    ssr: false,
    loading: () => (
      <div className="mt-6 h-40 motion-safe:animate-pulse rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/60" />
    ),
  },
);

export default function PtsPage() {
  const { hasPermission } = useAuth();
  const [hasDraft, setHasDraft] = useState(false);
  const [storedFileCompanyOptions, setStoredFileCompanyOptions] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const {
    loading,
    loadError,
    searchTerm,
    setSearchTerm,
    statusFilter,
    setStatusFilter,
    insights,
    page,
    setPage,
    total,
    lastPage,
    isMailModalOpen,
    setIsMailModalOpen,
    selectedDoc,
    setSelectedDoc,
    filteredPts,
    approvalRules,
    approvalRulesLoading,
    overviewMetrics,
    approvingId,
    rejectingId,
    rejectTargetId,
    setRejectTargetId,
    finalizingId,
    approvalIssuesById,
    approvalReviewLoadingId,
    approvalReviewById,
    approvalChecklistById,
    dismissApprovalIssue,
    dismissApprovalReview,
    updateApprovalChecklist,
    handleDelete,
    confirmDelete,
    confirmDeleteId,
    setConfirmDeleteId,
    deleteLoading,
    handleDownloadPdf,
    handleSendEmail,
    handlePrint,
    handlePrepareApproval,
    handleApprove,
    handleReject,
    confirmReject,
    handleFinalize,
    closingPt,
    setClosingPt,
    confirmFinalize,
    loadPts,
    handleEmitGovernedPdf,
    emittingPdfId,
  } = usePts();

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, [setPage]);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage, setPage]);

  const companyOptions = useMemo(() => {
    const optionsMap = new Map<string, string>();

    storedFileCompanyOptions.forEach((item) => {
      if (item.id) {
        optionsMap.set(item.id, item.name);
      }
    });

    filteredPts.forEach((item) => {
      if (item.company_id && !optionsMap.has(item.company_id)) {
        optionsMap.set(item.company_id, item.company_id);
      }
    });

    return Array.from(optionsMap.entries()).map(([id, name]) => ({ id, name }));
  }, [filteredPts, storedFileCompanyOptions]);

  useEffect(() => {
    let mounted = true;

    async function loadCompanyOptions() {
      try {
        const companies = await companiesService.findAll();
        if (!mounted) {
          return;
        }

        setStoredFileCompanyOptions(
          Array.from(
            new Map(
              companies
                .filter((company) => company.id)
                .map((company) => [company.id, company.razao_social || company.id]),
            ).entries(),
          ).map(([id, name]) => ({ id, name })),
        );
      } catch (error) {
        logger.error('Falha ao carregar empresas para o filtro de arquivos da PT:', error);
        if (mounted) {
          setStoredFileCompanyOptions([]);
        }
      }
    }

    void loadCompanyOptions();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const keys = Object.keys(window.localStorage);
    setHasDraft(
      keys.some(
        (key) =>
          key.startsWith('gst.pt.wizard.draft.') || key.startsWith('compliancex.pt.wizard.draft.'),
      ),
    );
  }, []);

  const metrics = useMemo(
    () =>
      overviewMetrics || {
        totalPts: 0,
        aprovadas: 0,
        pendentes: 0,
        canceladas: 0,
        encerradas: 0,
        expiradas: 0,
      },
    [overviewMetrics],
  );
  const canManagePt = hasPermission(Permission.CAN_MANAGE_PT);

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar PTs"
        description={loadError}
        action={
          <Button type="button" onClick={loadPts}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <>
      <ListPageLayout
        eyebrow="Permissão operacional"
        title="Permissão de Trabalho (PT)"
        description="Gerencie permissões emitidas, acompanhe aprovações e rastreie documentos operacionais em uma visão mais limpa e direta."
        icon={<FileLock2 className="h-5 w-5" />}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<FileSpreadsheet className="h-4 w-4 text-[var(--ds-color-success)]" />}
              onClick={() => downloadExcel('/pts/export/excel', 'pts.xlsx')}
            >
              Exportar Excel
            </Button>
            {canManagePt && hasDraft ? (
              <Link
                href="/dashboard/pts/new"
                className={cn(buttonVariants({ variant: 'outline' }), 'inline-flex items-center')}
              >
                Retomar rascunho
              </Link>
            ) : null}
            {canManagePt ? (
              <>
                <Link
                  href="/dashboard/pts/new?field=1"
                  className={cn(buttonVariants({ variant: 'outline' }), 'inline-flex items-center')}
                >
                  PT em campo
                </Link>
                <Link
                  href="/dashboard/pts/new"
                  className={cn(buttonVariants(), 'inline-flex items-center')}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Nova PT
                </Link>
              </>
            ) : null}
          </>
        }
        metrics={
          loading && filteredPts.length === 0
            ? []
            : [
                {
                  label: 'Pendentes',
                  value: metrics.pendentes,
                  note: 'Base consolidada da empresa.',
                  tone: 'warning',
                },
                {
                  label: 'Aprovadas',
                  value: metrics.aprovadas,
                  note: 'Prontas para governança final ou encerramento.',
                  tone: 'success',
                },
                {
                  label: 'Encerradas',
                  value: metrics.encerradas,
                  note: 'Fluxo formalmente concluído.',
                  tone: 'neutral',
                },
                {
                  label: 'Expiradas',
                  value: metrics.expiradas,
                  note: 'Validade operacional vencida.',
                  tone: 'danger',
                },
              ]
        }
        toolbarContent={
          <PtsFilters
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            statusFilter={statusFilter}
            onStatusChange={setStatusFilter}
          />
        }
        footer={
          filteredPts.length > 0 ? (
            <PaginationControls
              page={page}
              lastPage={lastPage}
              total={total}
              onPrev={handlePrevPage}
              onNext={handleNextPage}
            />
          ) : null
        }
      >
        <div className="space-y-4">
          {loading && filteredPts.length === 0 ? (
            <div className="p-6">
              <InlineLoadingState label="Carregando PTs..." />
            </div>
          ) : null}

          {insights.length > 0 ? <PtsInsights insights={insights} /> : null}

          <PtApprovalRulesPanel rules={approvalRules} loading={approvalRulesLoading} />

          <PtsTable
            pts={filteredPts}
            loading={loading}
            onDelete={handleDelete}
            onPrint={handlePrint}
            onSendEmail={handleSendEmail}
            onDownloadPdf={handleDownloadPdf}
            onPrepareApproval={handlePrepareApproval}
            onApprove={handleApprove}
            onReject={handleReject}
            onFinalize={handleFinalize}
            approvingId={approvingId}
            rejectingId={rejectingId}
            finalizingId={finalizingId}
            approvalReviewLoadingId={approvalReviewLoadingId}
            approvalIssuesById={approvalIssuesById}
            approvalReviewById={approvalReviewById}
            approvalChecklistById={approvalChecklistById}
            onDismissApprovalIssue={dismissApprovalIssue}
            onDismissApprovalReview={dismissApprovalReview}
            onUpdateApprovalChecklist={updateApprovalChecklist}
            onEmitGovernedPdf={handleEmitGovernedPdf}
            emittingPdfId={emittingPdfId}
          />
        </div>
      </ListPageLayout>

      <StoredFilesPanel
        title="Arquivos PT (Storage)"
        description="PDFs salvos automaticamente por empresa, ano e semana."
        listStoredFiles={ptsService.listStoredFiles}
        getPdfAccess={ptsService.getPdfAccess}
        downloadWeeklyBundle={ptsService.downloadWeeklyBundle}
        companyOptions={companyOptions}
      />

      {selectedDoc ? (
        <SendMailModal
          isOpen={isMailModalOpen}
          onClose={() => {
            setIsMailModalOpen(false);
            setSelectedDoc(null);
          }}
          documentName={selectedDoc.name}
          filename={selectedDoc.filename}
          base64={selectedDoc.base64}
          storedDocument={selectedDoc.storedDocument}
        />
      ) : null}

      <ConfirmModal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => void confirmDelete()}
        title="Excluir PT"
        description="Esta ação é irreversível. A Permissão de Trabalho e todos os dados associados serão removidos permanentemente."
        confirmLabel="Excluir"
        loading={deleteLoading}
      />

      <PtClosureModal
        pt={closingPt}
        loading={Boolean(finalizingId)}
        onClose={() => setClosingPt(null)}
        onConfirm={(payload) => void confirmFinalize(payload)}
      />

      <PtRejectModal
        isOpen={Boolean(rejectTargetId)}
        loading={Boolean(rejectingId)}
        onClose={() => {
          if (!rejectingId) setRejectTargetId(null);
        }}
        onConfirm={(reason) => void confirmReject(reason)}
      />
    </>
  );
}
