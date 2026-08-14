import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { UseFormSetValue, UseFormWatch } from "react-hook-form";
import { toast } from "sonner";

import {
  aprsService,
  type Apr,
  type AprFinalPdfGenerationResponse,
  type AprPdfAccessResponse,
} from "@/services/aprsService";
import { openUrlInNewTab } from "@/lib/print-utils";
import { extractApiErrorMessage, handleApiError } from "@/lib/error-handler";
import { logger } from "@/lib/logger";

import type { AprFormData } from "../components/aprForm.schema";
import type { AprWorkflowEvidenceItem } from "./useAprPdfWorkflow";

export type AprCompareResult = {
  summary: {
    totalBase: number;
    totalTarget: number;
    added: number;
    removed: number;
    changed: number;
  };
};

type AprFormAction = "approve" | "finalize";

interface UseAprWorkflowActionsOptions {
  id?: string;
  currentApr: Apr | null;
  isReadOnly: boolean;
  isOffline: boolean;
  canApproveCurrentApr: boolean;
  riskRowCount: number;
  tituloApr?: string;
  compareTargetId: string;
  selectedRiskItemEvidence: string;
  evidenceFile: File | null;
  evidenceLatitude: string;
  evidenceLongitude: string;
  evidenceAccuracy: string;
  formActionModal: AprFormAction | null;
  watch: UseFormWatch<AprFormData>;
  setValue: UseFormSetValue<AprFormData>;
  notifyReadOnly: (action?: string) => void;
  registerOfflineBlocked: (reason: string) => void;
  ensureGovernedPdf: (
    apr: Apr,
  ) => Promise<AprPdfAccessResponse | AprFinalPdfGenerationResponse | null>;
  reloadAprWorkflowContext: (aprId: string) => Promise<Apr>;
  navigateToApr: (aprId: string) => void;
  setSuggestingControls: Dispatch<SetStateAction<boolean>>;
  setEmittingGovernedPdf: Dispatch<SetStateAction<boolean>>;
  setClosingApr: Dispatch<SetStateAction<boolean>>;
  setCreatingVersion: Dispatch<SetStateAction<boolean>>;
  setComparing: Dispatch<SetStateAction<boolean>>;
  setCompareResult: Dispatch<SetStateAction<AprCompareResult | null>>;
  setEvidenceFile: Dispatch<SetStateAction<File | null>>;
  setEvidenceLatitude: Dispatch<SetStateAction<string>>;
  setEvidenceLongitude: Dispatch<SetStateAction<string>>;
  setEvidenceAccuracy: Dispatch<SetStateAction<string>>;
  setUploadingEvidence: Dispatch<SetStateAction<boolean>>;
  setAprEvidences: Dispatch<SetStateAction<AprWorkflowEvidenceItem[]>>;
  setFormActionModal: Dispatch<SetStateAction<AprFormAction | null>>;
  setFormActionModalLoading: Dispatch<SetStateAction<boolean>>;
  setFinalizing: Dispatch<SetStateAction<boolean>>;
}

export function useAprWorkflowActions({
  id,
  currentApr,
  isReadOnly,
  isOffline,
  canApproveCurrentApr,
  riskRowCount,
  tituloApr,
  compareTargetId,
  selectedRiskItemEvidence,
  evidenceFile,
  evidenceLatitude,
  evidenceLongitude,
  evidenceAccuracy,
  formActionModal,
  watch,
  setValue,
  notifyReadOnly,
  registerOfflineBlocked,
  ensureGovernedPdf,
  reloadAprWorkflowContext,
  navigateToApr,
  setSuggestingControls,
  setEmittingGovernedPdf,
  setClosingApr,
  setCreatingVersion,
  setComparing,
  setCompareResult,
  setEvidenceFile,
  setEvidenceLatitude,
  setEvidenceLongitude,
  setEvidenceAccuracy,
  setUploadingEvidence,
  setAprEvidences,
  setFormActionModal,
  setFormActionModalLoading,
  setFinalizing,
}: UseAprWorkflowActionsOptions) {
  const [capturingGps, setCapturingGps] = useState(false);

  const handleSuggestControls = useCallback(async () => {
    if (isReadOnly) {
      notifyReadOnly("Não é possível sugerir controles em uma APR bloqueada.");
      return;
    }
    if (riskRowCount === 0) {
      toast.error("Adicione ao menos uma linha de risco para gerar sugestões.");
      return;
    }

    try {
      setSuggestingControls(true);
      const rows = watch("itens_risco") || [];
      await Promise.all(
        rows.map(async (row, index) => {
          const result = await aprsService.getControlSuggestions({
            probability: row?.probabilidade
              ? Number(row.probabilidade)
              : undefined,
            severity: row?.severidade ? Number(row.severidade) : undefined,
            exposure: 1,
            activity: row?.atividade_processo || tituloApr,
            condition: row?.condicao_perigosa,
          });

          const suggestionText = result.suggestions
            .map((item) => `${item.title}: ${item.description}`)
            .join(" | ");

          if (suggestionText) {
            const existing = (row?.medidas_prevencao ?? "").trim();
            const finalValue = existing
              ? `${existing}\n---\n${suggestionText}`
              : suggestionText;
            setValue(
              `itens_risco.${index}.medidas_prevencao`,
              finalValue,
              {
                shouldDirty: true,
                shouldValidate: true,
              },
            );
          }
        }),
      );

      toast.success("Sugestões de controles aplicadas nas linhas de risco.");
    } catch (error) {
      logger.error("Erro ao sugerir controles:", error);
      toast.error("Não foi possível gerar sugestões de controles.");
    } finally {
      setSuggestingControls(false);
    }
  }, [
    isReadOnly,
    notifyReadOnly,
    riskRowCount,
    setSuggestingControls,
    setValue,
    tituloApr,
    watch,
  ]);

  const handleApproveApr = useCallback(async () => {
    if (!id) return;
    if (!canApproveCurrentApr) {
      toast.warning(
        "Aprovação indisponível para esta APR no estado atual do fluxo.",
      );
      return;
    }
    setFormActionModal("approve");
  }, [canApproveCurrentApr, id, setFormActionModal]);

  const handleEmitGovernedPdf = useCallback(async () => {
    if (!id || !currentApr) return;
    if (isOffline) {
      registerOfflineBlocked("final_pdf_requires_online");
      toast.warning(
        "A emissão do PDF final governado exige conexão ativa com o servidor.",
      );
      return;
    }
    if (currentApr.status !== "Aprovada") {
      toast.warning(
        "Somente APRs aprovadas podem emitir o PDF final governado.",
      );
      return;
    }

    try {
      setEmittingGovernedPdf(true);
      const access = await ensureGovernedPdf(currentApr);
      await reloadAprWorkflowContext(id);

      if (access?.url) {
        openUrlInNewTab(access.url);
        return;
      }

      toast.warning(
        access?.message ||
          "O PDF final foi emitido, mas a URL segura ainda não está disponível.",
      );
    } catch (error) {
      logger.error("Erro ao emitir PDF governado da APR:", error);
      toast.error(
        await extractApiErrorMessage(
          error,
          "Não foi possível emitir o PDF final governado.",
        ),
      );
    } finally {
      setEmittingGovernedPdf(false);
    }
  }, [
    currentApr,
    ensureGovernedPdf,
    id,
    isOffline,
    registerOfflineBlocked,
    reloadAprWorkflowContext,
    setEmittingGovernedPdf,
  ]);

  const handleCloseApr = useCallback(async () => {
    if (!id || !currentApr) return;
    if (currentApr.status !== "Aprovada") {
      toast.warning("Somente APRs aprovadas podem ser encerradas.");
      return;
    }
    if (!currentApr.has_final_pdf) {
      toast.warning(
        "Emita o PDF final governado da APR antes de encerrar o documento.",
      );
      return;
    }
    setFormActionModal("finalize");
  }, [currentApr, id, setFormActionModal]);

  const confirmFormAction = useCallback(async () => {
    if (!id || !formActionModal) return;
    setFormActionModalLoading(true);

    try {
      if (formActionModal === "approve") {
        setFinalizing(true);
        await aprsService.approve(id);
        const refreshedApr = await reloadAprWorkflowContext(id);
        const nextPendingStep =
          refreshedApr.approval_steps?.find(
            (step) => step.status === "pending",
          ) || null;
        if (refreshedApr.status === "Aprovada") {
          toast.success("APR aprovada com sucesso.");
        } else {
          toast.success(
            nextPendingStep
              ? `Etapa aprovada. Próxima aprovação: ${nextPendingStep.title}.`
              : "Etapa de aprovação concluída.",
          );
        }
      } else {
        setClosingApr(true);
        await aprsService.finalize(id);
        await reloadAprWorkflowContext(id);
        toast.success("APR encerrada com sucesso.");
      }
      setFormActionModal(null);
    } catch (error) {
      const contextLabel =
        formActionModal === "approve"
          ? "Aprovação de APR"
          : "Encerramento de APR";
      handleApiError(error, contextLabel);
    } finally {
      setFormActionModalLoading(false);
      setFinalizing(false);
      setClosingApr(false);
    }
  }, [
    formActionModal,
    id,
    reloadAprWorkflowContext,
    setClosingApr,
    setFinalizing,
    setFormActionModal,
    setFormActionModalLoading,
  ]);

  const handleOpenGovernedPdf = useCallback(async () => {
    if (!id || !currentApr) return;
    if (isOffline) {
      registerOfflineBlocked("open_final_pdf_requires_online");
      toast.warning(
        "O PDF final governado só pode ser aberto enquanto houver conexão ativa.",
      );
      return;
    }

    try {
      const access = await aprsService.getPdfAccess(id);
      if (access.url) {
        openUrlInNewTab(access.url);
        return;
      }

      if (currentApr.status === "Aprovada") {
        await handleEmitGovernedPdf();
        return;
      }

      toast.warning(
        access.message ||
          "O PDF final governado não está disponível para abertura agora.",
      );
    } catch (error) {
      logger.error("Erro ao abrir PDF governado da APR:", error);
      toast.error("Não foi possível abrir o PDF final governado.");
    }
  }, [
    currentApr,
    handleEmitGovernedPdf,
    id,
    isOffline,
    registerOfflineBlocked,
  ]);

  const handleCreateVersion = useCallback(async () => {
    if (!id) return;
    try {
      setCreatingVersion(true);
      const newApr = await aprsService.createNewVersion(id);
      toast.success(`Nova versão criada: ${newApr.numero}`);
      navigateToApr(newApr.id);
    } catch (error) {
      logger.error("Erro ao criar nova versão:", error);
      toast.error("Não foi possível criar nova versão.");
    } finally {
      setCreatingVersion(false);
    }
  }, [id, navigateToApr, setCreatingVersion]);

  const handleCompareVersions = useCallback(async () => {
    if (!id || !compareTargetId) return;
    try {
      setComparing(true);
      const result = await aprsService.compareVersions(id, compareTargetId);
      setCompareResult({ summary: result.summary });
      toast.success("Comparação de versões concluída.");
    } catch (error) {
      logger.error("Erro ao comparar versões:", error);
      toast.error("Não foi possível comparar as versões.");
    } finally {
      setComparing(false);
    }
  }, [compareTargetId, id, setCompareResult, setComparing]);

  const handleCaptureLocation = useCallback(() => {
    if (isReadOnly) {
      notifyReadOnly(
        "Captura de localização não está disponível em uma APR bloqueada.",
      );
      return;
    }
    if (!navigator.geolocation) {
      toast.error("Geolocalização não suportada neste navegador.");
      return;
    }
    setCapturingGps(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setEvidenceLatitude(String(position.coords.latitude));
        setEvidenceLongitude(String(position.coords.longitude));
        setEvidenceAccuracy(String(position.coords.accuracy));
        setCapturingGps(false);
        toast.success("Localização capturada.");
      },
      () => {
        setCapturingGps(false);
        toast.error("Não foi possível capturar a localização.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [
    isReadOnly,
    notifyReadOnly,
    setCapturingGps,
    setEvidenceAccuracy,
    setEvidenceLatitude,
    setEvidenceLongitude,
  ]);

  const handleUploadEvidence = useCallback(async () => {
    if (isReadOnly) {
      notifyReadOnly(
        "Envio de evidências não está disponível em uma APR bloqueada.",
      );
      return;
    }
    if (isOffline) {
      registerOfflineBlocked("risk_evidence_requires_online");
      toast.warning(
        "O envio de evidências da APR exige conexão ativa com o servidor.",
      );
      return;
    }
    if (!id || !selectedRiskItemEvidence || !evidenceFile) {
      toast.error("Selecione item de risco e imagem.");
      return;
    }
    if (!evidenceLatitude || !evidenceLongitude) {
      toast.error("Capture a geolocalização antes de enviar a evidência.");
      return;
    }
    if (!evidenceFile.type.startsWith("image/")) {
      toast.error("Envie uma imagem válida para manter a trilha de evidência.");
      return;
    }
    const maxEvidenceBytes = 15 * 1024 * 1024;
    if (evidenceFile.size > maxEvidenceBytes) {
      toast.error(
        `A imagem excede o limite de 15 MB (${(evidenceFile.size / 1024 / 1024).toFixed(1)} MB). Compacte a imagem antes de enviar.`,
      );
      return;
    }
    try {
      setUploadingEvidence(true);
      await aprsService.uploadRiskEvidence(
        id,
        selectedRiskItemEvidence,
        evidenceFile,
        {
          captured_at: new Date().toISOString(),
          latitude: evidenceLatitude ? Number(evidenceLatitude) : undefined,
          longitude: evidenceLongitude ? Number(evidenceLongitude) : undefined,
          accuracy_m: evidenceAccuracy ? Number(evidenceAccuracy) : undefined,
          device_id:
            typeof window !== "undefined"
              ? window.navigator.userAgent.slice(0, 110)
              : undefined,
        },
      );
      const evidences = await aprsService.listAprEvidences(id);
      setAprEvidences(evidences);
      setEvidenceFile(null);
      toast.success("Evidência enviada com hash de integridade.");
    } catch (error) {
      logger.error("Erro ao enviar evidência:", error);
      toast.error("Falha ao enviar evidência.");
    } finally {
      setUploadingEvidence(false);
    }
  }, [
    id,
    isOffline,
    isReadOnly,
    notifyReadOnly,
    registerOfflineBlocked,
    selectedRiskItemEvidence,
    evidenceFile,
    evidenceLatitude,
    evidenceLongitude,
    evidenceAccuracy,
    setAprEvidences,
    setEvidenceFile,
    setUploadingEvidence,
  ]);

  const gpsReady = !!evidenceLatitude && !!evidenceLongitude;

  return {
    capturingGps,
    gpsReady,
    handleSuggestControls,
    handleApproveApr,
    handleEmitGovernedPdf,
    handleCloseApr,
    confirmFormAction,
    handleOpenGovernedPdf,
    handleCreateVersion,
    handleCompareVersions,
    handleCaptureLocation,
    handleUploadEvidence,
  };
}
