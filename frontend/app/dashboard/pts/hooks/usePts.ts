'use client';
import { logger } from '@/lib/logger';

import { useState, useRef, useEffect, useCallback, useDeferredValue } from 'react';
import {
  getPtApprovalBlockedPayload,
  Pt,
  PtApprovalBlockedPayload,
  PtApprovalRules,
  PtAnalyticsOverview,
  PtCondicaoArea,
  ptsService,
} from '@/services/ptsService';
import { aiService } from '@/services/aiService';
import { signaturesService } from '@/services/signaturesService';
import { usersService } from '@/services/usersService';
import { toast } from 'sonner';
import { handleApiError } from '@/lib/error-handler';
import { openPdfForPrint, openUrlInNewTab } from '@/lib/print-utils';
import { isAiEnabled } from '@/lib/featureFlags';
import { base64ToPdfBlob } from '@/lib/pdf/pdfFile';
import type {
  PtApprovalChecklistState,
  PtApprovalReview,
  PtApprovalWorkerReview,
} from '../components/PtApprovalReviewPanel';

interface Insight {
  type: 'warning' | 'success' | 'info';
  title: string;
  message: string;
  action: string;
}

function summarizeChecklistAnswers<T extends { resposta?: string }>(items: T[]) {
  return items.reduce(
    (acc, item) => {
      if (!item.resposta) {
        acc.unanswered += 1;
      } else if (item.resposta === 'Não' || item.resposta === 'Não aplicável') {
        acc.adverse += 1;
      }
      return acc;
    },
    { unanswered: 0, adverse: 0 },
  );
}

function createEmptyApprovalChecklist(): PtApprovalChecklistState {
  return {
    reviewedReadiness: false,
    reviewedWorkers: false,
    confirmedRelease: false,
  };
}

function buildPreApprovalAuditPayload(
  review: PtApprovalReview,
  stage: 'preview' | 'approval_requested',
  checklist?: PtApprovalChecklistState,
) {
  return {
    stage,
    readyForRelease: review.readyForRelease,
    blockers: review.blockers,
    unansweredChecklistItems: review.unansweredChecklistItems,
    adverseChecklistItems: review.adverseChecklistItems,
    pendingSignatures: review.pendingSignatures,
    hasRapidRiskBlocker: review.hasRapidRiskBlocker,
    workerStatuses: review.workerStatuses,
    warnings: review.warnings,
    rules: review.rules || undefined,
    checklist,
  };
}

async function loadPtPdfGenerator() {
  return import('@/lib/pdf/ptGenerator');
}

export function usePts() {
  const [pts, setPts] = useState<Pt[]>([]);
  const timerRef = useRef<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [statusFilter, setStatusFilter] = useState('');
  const [insights, setInsights] = useState<Insight[]>([]);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectTargetId, setRejectTargetId] = useState<string | null>(null);
  const [approvalIssuesById, setApprovalIssuesById] = useState<
    Record<string, PtApprovalBlockedPayload>
  >({});
  const [approvalRules, setApprovalRules] = useState<PtApprovalRules | null>(null);
  const [overviewMetrics, setOverviewMetrics] = useState<PtAnalyticsOverview | null>(null);
  const [approvalRulesLoading, setApprovalRulesLoading] = useState(true);
  const [approvalReviewLoadingId, setApprovalReviewLoadingId] = useState<string | null>(null);
  const [finalizingId, setFinalizingId] = useState<string | null>(null);
  const [closingPt, setClosingPt] = useState<Pt | null>(null);
  const [approvalReviewById, setApprovalReviewById] = useState<Record<string, PtApprovalReview>>(
    {},
  );
  const [approvalChecklistById, setApprovalChecklistById] = useState<
    Record<string, PtApprovalChecklistState>
  >({});

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [emittingPdfId, setEmittingPdfId] = useState<string | null>(null);

  // Estados para o modal de e-mail
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

  const buildPtFilename = useCallback(
    (pt: Pt) => `PT_${String(pt.numero || pt.titulo || pt.id).replace(/\s+/g, '_')}.pdf`,
    [],
  );

  const shouldUseGovernedPdf = useCallback(
    (pt: Pick<Pt, 'status' | 'pdf_file_key'>) =>
      Boolean(pt.pdf_file_key) ||
      pt.status === 'Aprovada' ||
      pt.status === 'Encerrada' ||
      pt.status === 'Expirada',
    [],
  );

  const loadPts = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const pageResult = await ptsService.findPaginated({
        page,
        limit,
        search: deferredSearchTerm || undefined,
        status: statusFilter || undefined,
      });

      setPts(pageResult.data);
      setTotal(pageResult.total);
      setLastPage(pageResult.lastPage);
    } catch (error) {
      setLoadError('Nao foi possivel carregar a lista de PTs.');
      handleApiError(error, 'PTs');
    } finally {
      setLoading(false);
    }
  }, [page, limit, deferredSearchTerm, statusFilter]);

  const loadOverview = useCallback(async () => {
    try {
      const overview = await ptsService.getAnalyticsOverview();
      setOverviewMetrics(overview);
    } catch (error) {
      logger.error('Erro ao carregar overview analítico de PTs:', error);
      setOverviewMetrics(null);
    }
  }, []);

  const loadInsights = useCallback(async () => {
    if (!isAiEnabled()) return;
    try {
      const result = await aiService.getInsights();
      const ptInsights = result.insights.filter(
        (i: Insight) =>
          i.action.includes('/pts') ||
          i.title.toLowerCase().includes('pt') ||
          i.title.toLowerCase().includes('risco'),
      );
      setInsights(ptInsights);
    } catch (error) {
      logger.error('Erro ao carregar insights:', error);
    }
  }, []);

  const loadApprovalRules = useCallback(async () => {
    try {
      setApprovalRulesLoading(true);
      const rules = await ptsService.getApprovalRules();
      setApprovalRules(rules);
    } catch (error) {
      logger.error('Erro ao carregar regras de aprovação da PT:', error);
      setApprovalRules(null);
    } finally {
      setApprovalRulesLoading(false);
    }
  }, []);

  // Reset page when filters change
  useEffect(() => {
    const timer = timerRef.current;

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    setPage(1);
  }, [deferredSearchTerm, statusFilter]);

  useEffect(() => {
    loadPts();
  }, [loadPts]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    loadInsights();
  }, [loadInsights]);

  useEffect(() => {
    loadApprovalRules();
  }, [loadApprovalRules]);

  const handleDelete = useCallback((id: string) => {
    setConfirmDeleteId(id);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!confirmDeleteId) return;
    setDeleteLoading(true);
    try {
      await ptsService.delete(confirmDeleteId);
      await loadPts();
      void loadOverview();
      toast.success('PT excluída com sucesso!');
      setConfirmDeleteId(null);
    } catch (error) {
      handleApiError(error, 'PTs');
    } finally {
      setDeleteLoading(false);
    }
  }, [confirmDeleteId, loadOverview, loadPts]);

  const dismissApprovalIssue = useCallback((id: string) => {
    setApprovalIssuesById((current) => {
      if (!current[id]) {
        return current;
      }

      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const dismissApprovalReview = useCallback((id: string) => {
    setApprovalReviewById((current) => {
      if (!current[id]) {
        return current;
      }

      const next = { ...current };
      delete next[id];
      return next;
    });

    setApprovalChecklistById((current) => {
      if (!current[id]) {
        return current;
      }

      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const updateApprovalChecklist = useCallback(
    (id: string, key: keyof PtApprovalChecklistState, checked: boolean) => {
      setApprovalChecklistById((current) => ({
        ...current,
        [id]: {
          ...(current[id] || createEmptyApprovalChecklist()),
          [key]: checked,
        },
      }));
    },
    [],
  );

  const buildWorkerReview = useCallback(
    async (pt: Pt): Promise<{ workers: PtApprovalWorkerReview[]; warnings: string[] }> => {
      const team = [
        pt.responsavel_id
          ? {
              id: pt.responsavel_id,
              nome: pt.responsavel?.nome || 'Responsável da PT',
              roleLabel: 'Responsável',
            }
          : null,
        ...(Array.isArray(pt.executantes)
          ? pt.executantes.map((executante) => ({
              id: executante.id,
              nome: executante.nome,
              roleLabel: 'Executante',
            }))
          : []),
      ].filter((member): member is { id: string; nome: string; roleLabel: string } =>
        Boolean(member?.id),
      );

      const uniqueTeam = Array.from(new Map(team.map((member) => [member.id, member])).values());

      if (uniqueTeam.length === 0) {
        return { workers: [], warnings: [] };
      }

      const timelineResults = await Promise.allSettled(
        uniqueTeam.map(async (member) => ({
          member,
          timeline: await usersService.getWorkerTimelineById(member.id),
        })),
      );

      const warnings: string[] = [];
      const workers = timelineResults.map((result, index) => {
        const fallback = uniqueTeam[index]!;

        if (result.status === 'fulfilled') {
          return {
            userId: result.value.member.id,
            nome: result.value.member.nome,
            roleLabel: result.value.member.roleLabel,
            blocked: result.value.timeline.status.blocked,
            reasons: result.value.timeline.status.reasons,
          } satisfies PtApprovalWorkerReview;
        }

        warnings.push(
          `Não foi possível validar a prontidão operacional de ${fallback.nome} na pré-liberação.`,
        );
        return {
          userId: fallback.id,
          nome: fallback.nome,
          roleLabel: fallback.roleLabel,
          blocked: false,
          reasons: ['Validação operacional indisponível nesta leitura.'],
          unavailable: true,
        } satisfies PtApprovalWorkerReview;
      });

      return { workers, warnings };
    },
    [],
  );

  const buildApprovalReview = useCallback(
    async (pt: Pt): Promise<PtApprovalReview> => {
      const [signatures, workerReview] = await Promise.all([
        signaturesService.findByDocument(pt.id, 'PT'),
        buildWorkerReview(pt),
      ]);
      const { workers, warnings } = workerReview;

      const generalChecklist = pt.recomendacoes_gerais_checklist ?? [];
      const workAtHeightChecklist = pt.trabalho_altura_checklist ?? [];
      const workElectricChecklist = pt.trabalho_eletrico_checklist ?? [];
      const workHotChecklist = pt.trabalho_quente_checklist ?? [];
      const workConfinedChecklist = pt.trabalho_espaco_confinado_checklist ?? [];
      const workExcavationChecklist = pt.trabalho_escavacao_checklist ?? [];
      const rapidRiskChecklist = pt.analise_risco_rapida_checklist ?? [];
      const selectedRiskTypes = [
        pt.trabalho_altura && 'Altura',
        pt.eletricidade && 'Eletricidade',
        pt.trabalho_quente && 'Trabalho a quente',
        pt.espaco_confinado && 'Espaço confinado',
        pt.escavacao && 'Escavação',
      ].filter(Boolean) as string[];
      const selectedExecutanteIds = Array.isArray(pt.executantes)
        ? pt.executantes
            .map((executante) => executante.id)
            .filter((userId): userId is string => Boolean(userId))
        : [];
      const signedExecutanteIds = new Set(
        signatures
          .map((signature) => signature.user_id)
          .filter((userId): userId is string => Boolean(userId))
          .filter((userId) => selectedExecutanteIds.includes(userId)),
      );
      const pendingSignatures = Math.max(
        0,
        selectedExecutanteIds.length - signedExecutanteIds.size,
      );

      const generalChecklistSummary = summarizeChecklistAnswers(generalChecklist);
      const workAtHeightSummary = summarizeChecklistAnswers(workAtHeightChecklist);
      const workElectricSummary = summarizeChecklistAnswers(workElectricChecklist);
      const workHotSummary = summarizeChecklistAnswers(workHotChecklist);
      const workConfinedSummary = summarizeChecklistAnswers(workConfinedChecklist);
      const workExcavationSummary = summarizeChecklistAnswers(workExcavationChecklist);

      const unansweredChecklistItems =
        generalChecklistSummary.unanswered +
        (pt.trabalho_altura ? workAtHeightSummary.unanswered : 0) +
        (pt.eletricidade ? workElectricSummary.unanswered : 0) +
        (pt.trabalho_quente ? workHotSummary.unanswered : 0) +
        (pt.espaco_confinado ? workConfinedSummary.unanswered : 0) +
        (pt.escavacao ? workExcavationSummary.unanswered : 0);

      const adverseChecklistItems =
        generalChecklistSummary.adverse +
        (pt.trabalho_altura ? workAtHeightSummary.adverse : 0) +
        (pt.eletricidade ? workElectricSummary.adverse : 0) +
        (pt.trabalho_quente ? workHotSummary.adverse : 0) +
        (pt.espaco_confinado ? workConfinedSummary.adverse : 0) +
        (pt.escavacao ? workExcavationSummary.adverse : 0);

      const hasRapidRiskBlocker = rapidRiskChecklist.some(
        (item) => item.secao === 'basica' && item.resposta === 'Não',
      );

      const blockers: string[] = [];

      if (!pt.company_id) blockers.push('Selecionar a empresa da PT.');
      if (!pt.site_id) blockers.push('Selecionar a obra/site da PT.');
      if (!pt.responsavel_id) blockers.push('Definir o responsável pela liberação.');
      if (!String(pt.titulo || '').trim()) blockers.push('Informar um título claro da atividade.');
      if (selectedRiskTypes.length === 0) {
        blockers.push(
          'Marcar pelo menos um tipo de trabalho crítico ou confirmar que a PT é geral.',
        );
      }
      if (hasRapidRiskBlocker && !String(pt.analise_risco_rapida_observacoes || '').trim()) {
        blockers.push('Registrar ações corretivas na análise de risco rápida.');
      }
      if (unansweredChecklistItems > 0) {
        blockers.push(`${unansweredChecklistItems} item(ns) de checklist ainda sem resposta.`);
      }
      if (selectedExecutanteIds.length === 0) {
        blockers.push('Selecionar ao menos um executante.');
      }
      if (pendingSignatures > 0) {
        blockers.push(`${pendingSignatures} assinatura(s) ainda pendente(s).`);
      }

      workers
        .filter((worker) => worker.blocked)
        .forEach((worker) => {
          worker.reasons.forEach((reason) =>
            blockers.push(`${worker.roleLabel} ${worker.nome}: ${reason}`),
          );
        });

      // Avisos NR-33/registro fotográfico — não bloqueiam a aprovação porque a
      // medição inicial e as fotos 'durante'/'depois' ocorrem após a liberação.
      if (pt.espaco_confinado && !pt.medicoes_atmosfericas?.length) {
        warnings.push(
          'Espaço confinado sem medição atmosférica registrada (NR-33). Registre a leitura inicial antes da entrada.',
        );
      }
      if (!pt.fotos_evidencia?.some((foto) => foto.fase === 'antes')) {
        warnings.push('Nenhuma foto "antes da atividade" anexada como evidência da área.');
      }

      return {
        readyForRelease: blockers.length === 0,
        blockers,
        unansweredChecklistItems,
        adverseChecklistItems,
        pendingSignatures,
        hasRapidRiskBlocker,
        workerStatuses: workers,
        warnings,
        rules: approvalRules,
      };
    },
    [approvalRules, buildWorkerReview],
  );

  const handlePrepareApproval = useCallback(
    async (id: string) => {
      setApprovalReviewLoadingId(id);
      dismissApprovalIssue(id);

      try {
        const pt = await ptsService.findOne(id);
        const review = await buildApprovalReview(pt);

        setApprovalReviewById((current) => ({
          ...current,
          [id]: review,
        }));
        setApprovalChecklistById((current) => ({
          ...current,
          [id]: current[id] || createEmptyApprovalChecklist(),
        }));

        try {
          await ptsService.logPreApprovalReview(
            id,
            buildPreApprovalAuditPayload(review, 'preview'),
          );
        } catch (auditError) {
          logger.error('Erro ao registrar pré-liberação da PT:', auditError);
          toast.warning(
            'A pré-liberação foi aberta, mas o registro auditável não pôde ser salvo agora.',
          );
        }
      } catch (error) {
        handleApiError(error, 'Pré-liberação da PT');
      } finally {
        setApprovalReviewLoadingId((current) => (current === id ? null : current));
      }
    },
    [buildApprovalReview, dismissApprovalIssue],
  );

  const generatePtPdfPayload = useCallback(async (pt: Pt, draftWatermark: boolean) => {
    const [fullPt, signatures] = await Promise.all([
      ptsService.findOne(pt.id),
      signaturesService.findByDocument(pt.id, 'PT'),
    ]);
    const { generatePtPdf } = await loadPtPdfGenerator();
    return (await generatePtPdf(fullPt, signatures, {
      save: false,
      output: 'base64',
      draftWatermark,
    })) as { base64: string; filename: string } | undefined;
  }, []);

  const handleEmitGovernedPdf = useCallback(
    async (id: string) => {
      setEmittingPdfId(id);
      try {
        const pt = pts.find((item) => item.id === id) || (await ptsService.findOne(id));
        const payload = await generatePtPdfPayload(pt, false);
        if (!payload?.base64) throw new Error('Falha ao gerar PDF');
        const blob = base64ToPdfBlob(payload.base64);
        const file = new File([blob], payload.filename, { type: 'application/pdf' });
        await ptsService.attachFile(pt.id, file);
        toast.success('PDF final emitido e registrado com sucesso.');
        await loadPts();
      } catch (error) {
        handleApiError(error, 'Emissão do PDF final da PT');
      } finally {
        setEmittingPdfId(null);
      }
    },
    [generatePtPdfPayload, loadPts, pts],
  );

  const handleDownloadPdf = useCallback(
    async (id: string) => {
      try {
        const pt = pts.find((item) => item.id === id) || (await ptsService.findOne(id));

        if (shouldUseGovernedPdf(pt)) {
          const access = await ptsService.getPdfAccess(pt.id);
          if (access.hasFinalPdf && access.url) {
            openUrlInNewTab(access.url);
            return;
          }

          toast.warning(
            access.message ||
              'PDF final da PT indisponível no storage. Abrimos uma cópia local sem registrar novo artefato.',
          );
          const result = await generatePtPdfPayload(pt, !access.hasFinalPdf);
          if (!result?.base64) {
            throw new Error('Falha ao gerar a cópia oficial local da PT.');
          }
          const fileURL = URL.createObjectURL(base64ToPdfBlob(result.base64));
          openUrlInNewTab(fileURL);
          setTimeout(() => URL.revokeObjectURL(fileURL), 60_000);
          return;
        }

        toast.info('Gerando PDF...');
        const result = await generatePtPdfPayload(pt, true);
        if (!result?.base64) {
          throw new Error('Falha ao gerar o PDF da PT.');
        }
        const fileURL = URL.createObjectURL(base64ToPdfBlob(result.base64));
        openUrlInNewTab(fileURL);
        setTimeout(() => URL.revokeObjectURL(fileURL), 60_000);
      } catch (error) {
        handleApiError(error, 'PDF');
      }
    },
    [generatePtPdfPayload, pts, shouldUseGovernedPdf],
  );

  const handleSendEmail = useCallback(
    async (id: string) => {
      try {
        toast.info('Preparando documento...');
        const pt = pts.find((item) => item.id === id) || (await ptsService.findOne(id));

        if (shouldUseGovernedPdf(pt)) {
          const access = await ptsService.getPdfAccess(pt.id);
          if (access?.hasFinalPdf) {
            if (access.message) {
              toast.info(
                `${access.message} O envio oficial continuará usando o PDF final governado da PT.`,
              );
            }
            setSelectedDoc({
              name: pt.titulo,
              filename: access.originalName || buildPtFilename(pt),
              storedDocument: {
                documentId: pt.id,
                documentType: 'PT',
              },
            });
            setIsMailModalOpen(true);
            return;
          }

          if (pt.status === 'Aprovada' || pt.status === 'Encerrada' || pt.status === 'Expirada') {
            toast.warning('Emita o PDF final governado antes de enviar esta PT por e-mail.');
            return;
          }
        }

        toast.warning(
          'Esta PT ainda não possui PDF final governado emitido. O envio ocorrerá com um PDF local não governado.',
        );

        const result = await generatePtPdfPayload(pt, true);

        if (result?.base64) {
          setSelectedDoc({
            name: pt.titulo,
            filename: result.filename,
            base64: result.base64,
          });
          setIsMailModalOpen(true);
        }
      } catch (error) {
        handleApiError(error, 'Email');
      }
    },
    [buildPtFilename, generatePtPdfPayload, pts, shouldUseGovernedPdf],
  );

  const handlePrint = useCallback(
    async (id: string) => {
      try {
        toast.info('Preparando impressão...');
        const pt = pts.find((item) => item.id === id) || (await ptsService.findOne(id));

        if (shouldUseGovernedPdf(pt)) {
          const access = await ptsService.getPdfAccess(pt.id);
          if (access.hasFinalPdf && access.url) {
            openPdfForPrint(access.url, () => {
              toast.info('Pop-up bloqueado. Abrimos o PDF final na mesma aba para impressão.');
            });
            return;
          }

          toast.warning(
            access.message ||
              'PDF final da PT indisponível no storage. Abrimos uma cópia local sem registrar novo artefato.',
          );
          const result = await generatePtPdfPayload(pt, !access.hasFinalPdf);
          if (!result?.base64) {
            throw new Error('Falha ao gerar a cópia oficial local da PT.');
          }
          const fileURL = URL.createObjectURL(base64ToPdfBlob(result.base64));
          openPdfForPrint(fileURL, () => {
            toast.info('Pop-up bloqueado. Abrimos o PDF na mesma aba para impressão.');
          });
          setTimeout(() => URL.revokeObjectURL(fileURL), 60_000);
          return;
        }

        const result = await generatePtPdfPayload(pt, true);
        if (result?.base64) {
          const fileURL = URL.createObjectURL(base64ToPdfBlob(result.base64));
          openPdfForPrint(fileURL, () => {
            toast.info('Pop-up bloqueado. Abrimos o PDF na mesma aba para impressão.');
          });
        }
      } catch (error) {
        handleApiError(error, 'Impressão');
      }
    },
    [generatePtPdfPayload, pts, shouldUseGovernedPdf],
  );

  const handleApprove = useCallback(
    async (id: string) => {
      const review = approvalReviewById[id];
      const checklist = approvalChecklistById[id];

      if (!review) {
        toast.info('Abra a pré-liberação da PT antes de aprovar.');
        return;
      }

      if (!review.readyForRelease) {
        toast.error('Ainda existem bloqueios operacionais antes da aprovação.');
        return;
      }

      if (!checklist || !Object.values(checklist).every(Boolean)) {
        toast.error('Conclua o checklist final do aprovador antes de liberar a PT.');
        return;
      }

      setApprovingId(id);
      dismissApprovalIssue(id);

      try {
        await ptsService.logPreApprovalReview(
          id,
          buildPreApprovalAuditPayload(review, 'approval_requested', checklist),
        );
        await ptsService.approve(id);
        await loadPts();
        void loadOverview();
        dismissApprovalReview(id);
        toast.success('PT aprovada com sucesso!');
      } catch (error) {
        const blockedPayload = getPtApprovalBlockedPayload(error);

        if (blockedPayload) {
          setApprovalIssuesById((current) => ({
            ...current,
            [id]: blockedPayload,
          }));
          toast.error('A PT foi bloqueada pelas regras de segurança.');
          return;
        }

        handleApiError(error, 'PT');
      } finally {
        setApprovingId((current) => (current === id ? null : current));
      }
    },
    [
      approvalChecklistById,
      approvalReviewById,
      dismissApprovalIssue,
      dismissApprovalReview,
      loadOverview,
      loadPts,
    ],
  );

  const handleReject = useCallback((id: string) => {
    setRejectTargetId(id);
  }, []);

  const confirmReject = useCallback(
    async (reason: string) => {
      const id = rejectTargetId;
      const normalizedReason = reason.trim();
      if (!id || !normalizedReason) return;

      setRejectingId(id);
      dismissApprovalIssue(id);

      try {
        await ptsService.reject(id, normalizedReason);
        await loadPts();
        void loadOverview();
        dismissApprovalReview(id);
        setRejectTargetId(null);
        toast.success('PT reprovada.');
      } catch (error) {
        handleApiError(error, 'PT');
      } finally {
        setRejectingId((current) => (current === id ? null : current));
      }
    },
    [dismissApprovalIssue, dismissApprovalReview, loadOverview, loadPts, rejectTargetId],
  );

  const handleFinalize = useCallback(
    (id: string) => {
      const target = pts.find((pt) => pt.id === id) ?? null;
      if (!target) {
        toast.error('PT não encontrada para encerramento.');
        return;
      }
      setClosingPt(target);
    },
    [pts],
  );

  const confirmFinalize = useCallback(
    async (payload: {
      condicao_area: PtCondicaoArea;
      data_hora_real_fim?: string;
      observacoes?: string;
    }) => {
      const target = closingPt;
      if (!target) return;

      setFinalizingId(target.id);
      try {
        await ptsService.finalize(target.id, payload);
        dismissApprovalIssue(target.id);
        dismissApprovalReview(target.id);
        toast.success('PT encerrada com sucesso.');
        setClosingPt(null);
        await loadPts();
        void loadOverview();
      } catch (error) {
        handleApiError(error, 'PT');
      } finally {
        setFinalizingId((current) => (current === target.id ? null : current));
      }
    },
    [closingPt, dismissApprovalIssue, dismissApprovalReview, loadOverview, loadPts],
  );

  // Filtering is now server-side — pts already contains the filtered page
  const filteredPts = pts;

  return {
    pts,
    loading,
    loadError,
    searchTerm,
    setSearchTerm,
    statusFilter,
    setStatusFilter,
    insights,
    page,
    setPage,
    limit,
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
    handleEmitGovernedPdf,
    emittingPdfId,
    handlePrepareApproval,
    handleApprove,
    handleReject,
    confirmReject,
    handleFinalize,
    closingPt,
    setClosingPt,
    confirmFinalize,
    loadPts,
  };
}
