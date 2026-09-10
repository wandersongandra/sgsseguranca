import { useState, useRef, useEffect, useMemo, useCallback, useDeferredValue } from 'react';
import { checklistsService, Checklist } from '@/services/checklistsService';
import { signaturesService } from '@/services/signaturesService';
import { aiService } from '@/services/aiService';
import { handleApiError } from '@/lib/error-handler';
import { toast } from 'sonner';
import { ptBR } from 'date-fns/locale';
import React from 'react';
import { openPdfForPrint, openUrlInNewTab } from '@/lib/print-utils';
import { runWithMutationLock } from '@/lib/mutation-lock';
import { useConfirmAction } from '@/components/ui/confirm-action-provider';
import { isAiEnabled } from '@/lib/featureFlags';
import { resolveGovernedPdfConsumption } from '@/lib/governedPdfFallback';
import { safeFormatDate } from '@/lib/date/safeFormat';
import { base64ToPdfBlob } from '@/lib/pdf/pdfFile';
import type { ChecklistRecordsArea } from '@/lib/checklist-modules';
import {
  ChecklistColumnKey,
  checklistColumnLabels,
  defaultChecklistColumns,
  getChecklistColumnValue,
} from '../columns';

const loadChecklistPdfGenerator = async () =>
  import('@/lib/pdf/checklistGenerator');

export interface ExportCsvOptions {
  ids?: string[];
  columns?: ChecklistColumnKey[];
}

export function useChecklists(options?: { area?: ChecklistRecordsArea }) {
  const { confirmAction } = useConfirmAction();
  const area = options?.area;
  const [checklists, setChecklists] = useState<Checklist[]>([]);
const timerRef = useRef<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [modelFilter, setModelFilter] = useState<'all' | 'model' | 'regular'>('regular');
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const deleteMutationLock = useRef(false);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [isMailModalOpen, setIsMailModalOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<{
    name: string;
    filename: string;
    base64?: string;
    storedDocument?: {
      documentId: string;
      documentType: string;
    };
  } | null>(null);

  const loadChecklists = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const res = await checklistsService.findPaginated({
        onlyTemplates: modelFilter === 'model',
        excludeTemplates: modelFilter === 'regular',
        category: area?.category,
        segment: area?.segment,
        page,
        limit,
      });
      setChecklists(res.data);
      setTotal(res.total);
      setLastPage(res.lastPage);
    } catch (error) {
      setLoadError('Nao foi possivel carregar os checklists.');
      handleApiError(error, 'Checklists');
    } finally {
      setLoading(false);
    }
  }, [area?.category, area?.segment, modelFilter, page, limit]);

  const setModelFilterAndReset = useCallback(
    (value: 'all' | 'model' | 'regular') => {
      setPage(1);
      setModelFilter(value);
    },
    [],
  );

  useEffect(() => {

    const timer = timerRef.current;


    return () => {

      if (timer) {

        clearTimeout(timer);

      }

    };

  }, []);

useEffect(() => {
    loadChecklists();
  }, [loadChecklists]);

  const generateChecklistPdfPayload = useCallback(async (checklist: Checklist, draftWatermark: boolean) => {
    const signatures = await signaturesService.findByChecklist(checklist.id);
    const { generateChecklistPdf } = await loadChecklistPdfGenerator();
    return (await generateChecklistPdf(checklist, signatures, {
      save: false,
      output: 'base64',
      draftWatermark,
    })) as { base64: string; filename: string } | undefined;
  }, []);

  const handleDownloadPdf = useCallback(async (checklist: Checklist) => {
    try {
      setPrintingId(checklist.id);
      // Always attempt governed access first (supports backend hiding pdf_file_key)
      const access = await checklistsService.getPdfAccess(checklist.id);
      const resolution = resolveGovernedPdfConsumption(access, {
        action: 'download',
        documentLabel: 'checklist',
      });
      if (resolution.mode === 'governed_url') {
        openUrlInNewTab(resolution.url);
        toast.success('PDF aberto com sucesso!');
        return;
      }
      toast.info(resolution.message);
      const result = await generateChecklistPdfPayload(
        checklist,
        resolution.mode === 'local_generation',
      );
      if (!result?.base64) {
        throw new Error('Falha ao gerar o PDF do checklist.');
      }
      const fileURL = URL.createObjectURL(base64ToPdfBlob(result.base64));
      openUrlInNewTab(fileURL);
      setTimeout(() => URL.revokeObjectURL(fileURL), 60_000);
      toast.success('PDF aberto com sucesso!');
    } catch (error) {
      handleApiError(error, 'Gerar PDF');
    } finally {
      setPrintingId(null);
    }
  }, [generateChecklistPdfPayload]);

  const handleSendEmail = useCallback(async (checklist: Checklist) => {
    try {
      setPrintingId(checklist.id);
      // Use governed access (pdf_file_key may be hidden in response)
      const access = await checklistsService.getPdfAccess(checklist.id);
      if (!access.hasFinalPdf) {
        toast.info(access.message || 'Emita o PDF final antes de enviar este checklist por e-mail.');
        return;
      }
      if (access.availability !== 'ready' && access.message) {
        toast.info(
          `${access.message} O envio oficial continuará usando o PDF final governado do checklist.`,
        );
      }

      setSelectedDoc({
        name: checklist.titulo,
        filename: checklist.pdf_original_name || `checklist-${checklist.id}.pdf`,
        storedDocument: {
          documentId: checklist.id,
          documentType: 'CHECKLIST',
        },
      });
      setIsMailModalOpen(true);
    } catch (error) {
      handleApiError(error, 'Preparar e-mail');
    } finally {
      setPrintingId(null);
    }
  }, []);

  const handlePrint = useCallback(async (checklist: Checklist) => {
    try {
      setPrintingId(checklist.id);
      // Always use governed access endpoint first (pdf_file_key may be hidden)
      const access = await checklistsService.getPdfAccess(checklist.id);
      const resolution = resolveGovernedPdfConsumption(access, {
        action: 'print',
        documentLabel: 'checklist',
      });
      if (resolution.mode === 'governed_url') {
        openPdfForPrint(resolution.url, () => {
          toast.info('Pop-up bloqueado. Abrimos o PDF na mesma aba para impressão.');
        });
        return;
      }
      toast.info(resolution.message);
      const result = await generateChecklistPdfPayload(
        checklist,
        resolution.mode === 'local_generation',
      );
      if (result?.base64) {
        const fileURL = URL.createObjectURL(base64ToPdfBlob(result.base64));
        openPdfForPrint(fileURL, () => {
          toast.info('Pop-up bloqueado. Abrimos o PDF na mesma aba para impressão.');
        });
        setTimeout(() => URL.revokeObjectURL(fileURL), 60_000);
      }
    } catch (error) {
      handleApiError(error, 'Imprimir');
    } finally {
      setPrintingId(null);
    }
  }, [generateChecklistPdfPayload]);

  const handleAiAnalysis = useCallback(async (id: string) => {
    if (!isAiEnabled()) return;
    try {
      setAnalyzingId(id);
      const result = await aiService.analyzeChecklist(id);
      
      toast.success('Análise do SGS concluída!', {
        description: (
          <div className="mt-2 space-y-2 max-h-[300px] overflow-y-auto pr-2">
            <p className="font-bold text-[var(--ds-color-text-primary)]">{result.summary}</p>
            <div className="space-y-1">
              {result.suggestions.map((s: string, i: number) => (
                <div
                  key={i}
                  className="rounded-r-[var(--ds-radius-sm)] border-l-2 border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)]/55 px-2 py-1 text-xs text-[var(--ds-color-text-secondary)]"
                >
                  {s}
                </div>
              ))}
            </div>
          </div>
        ),
        duration: 8000,
      });
    } catch (error) {
      handleApiError(error, 'Análise SGS');
    } finally {
      setAnalyzingId(null);
    }
  }, []);

  const handleDeleteMany = useCallback(async (ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids));
    if (!uniqueIds.length) return;

    await runWithMutationLock(deleteMutationLock, async () => {
    const results = await Promise.allSettled(
      uniqueIds.map((id) => checklistsService.delete(id)),
    );
    const successfulIds = uniqueIds.filter(
      (_, index) => results[index]!.status === 'fulfilled',
    );
    const failedCount = uniqueIds.length - successfulIds.length;

    if (successfulIds.length) {
      setChecklists((prev) => prev.filter((checklist) => !successfulIds.includes(checklist.id)));
      toast.success(
        successfulIds.length === 1
          ? 'Checklist excluído com sucesso!'
          : `${successfulIds.length} checklists excluídos com sucesso!`,
      );
    }

    if (failedCount > 0) {
      handleApiError(
        new Error(`${failedCount} exclusões falharam.`),
        'Excluir checklists',
      );
      }
    });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const confirmed = await confirmAction({
      title: 'Excluir checklist',
      description: 'Tem certeza que deseja excluir este checklist? Esta ação não pode ser desfeita.',
      confirmLabel: 'Excluir checklist',
    });
    if (!confirmed) return;
    await handleDeleteMany([id]);
  }, [confirmAction, handleDeleteMany]);

  const filteredChecklists = useMemo(() => {
    return checklists.filter((checklist) => {
      const term = deferredSearchTerm.toLowerCase();
      const matchesTerm = (
        checklist.titulo.toLowerCase().includes(term) ||
        (checklist.descricao || '').toLowerCase().includes(term) ||
        (checklist.equipamento || '').toLowerCase().includes(term) ||
        (checklist.maquina || '').toLowerCase().includes(term)
      );
      if (!matchesTerm) return false;
      if (modelFilter === 'model') return Boolean(checklist.is_modelo);
      if (modelFilter === 'regular') return !checklist.is_modelo;
      return true;
    });
  }, [checklists, deferredSearchTerm, modelFilter]);

  const insights = useMemo(() => {
    return {
      total,
      conforme: checklists.filter(c => c.status === 'Conforme').length,
      pendente: checklists.filter(c => c.status === 'Pendente').length,
      naoConforme: checklists.filter(c => c.status === 'Não Conforme').length,
    };
  }, [checklists, total]);

  const handleExportCsv = useCallback((options?: ExportCsvOptions) => {
    const selectedIds = options?.ids ? new Set(options.ids) : null;
    const columns = options?.columns?.length
      ? options.columns
      : defaultChecklistColumns;
    const rowsSource = selectedIds
      ? filteredChecklists.filter((checklist) => selectedIds.has(checklist.id))
      : filteredChecklists;

    if (!rowsSource.length) {
      toast.info('Nenhum checklist disponível para exportação.');
      return;
    }

    const escapeCsv = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const header = columns.map((column) => checklistColumnLabels[column]);
    const rows = rowsSource.map((checklist) =>
      columns.map((column) => {
        if (column === 'data') {
          return safeFormatDate(checklist.data, 'dd/MM/yyyy', { locale: ptBR });
        }
        return getChecklistColumnValue(checklist, column);
      }),
    );
    const csv = [header, ...rows].map((row) => row.map(escapeCsv).join(';')).join('\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `checklists_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [filteredChecklists]);

  return {
    checklists,
    loading,
    loadError,
    searchTerm,
    setSearchTerm,
    deferredSearchTerm,
    modelFilter,
    setModelFilter: setModelFilterAndReset,
    page,
    setPage,
    limit,
    total,
    lastPage,
    analyzingId,
    printingId,
    isMailModalOpen,
    setIsMailModalOpen,
    selectedDoc,
    setSelectedDoc,
    filteredChecklists,
    insights,
    handleDownloadPdf,
    handleSendEmail,
    handlePrint,
    handleAiAnalysis,
    handleDelete,
    handleDeleteMany,
    handleExportCsv,
    loadChecklists,
  };
}
