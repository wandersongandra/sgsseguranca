import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { UseFormSetValue } from "react-hook-form";
import { toast } from "sonner";

import type { Apr } from "@/services/aprsService";
import { aprsService } from "@/services/aprsService";
import { signaturesService } from "@/services/signaturesService";
import type { Signature } from "@/services/signaturesService";
import { openPdfForPrint } from "@/lib/print-utils";
import { logger } from "@/lib/logger";

import type { AprFormData } from "../components/aprForm.schema";
import type { AprLogEntry } from "../components/AprTimeline";

export type AprWorkflowVersionHistoryItem = {
  id: string;
  numero: string;
  versao: number;
  status: string;
};

export type AprWorkflowEvidenceItem = {
  id: string;
  apr_risk_item_id: string;
  original_name?: string;
  hash_sha256: string;
  watermarked_hash_sha256?: string;
  uploaded_at: string;
  captured_at?: string;
  url?: string;
  watermarked_url?: string;
  integrity_flags?: Record<string, unknown>;
};

interface UseAprPdfWorkflowOptions {
  canViewSignatures: boolean;
  setCurrentApr: Dispatch<SetStateAction<Apr | null>>;
  setAprLogs: Dispatch<SetStateAction<AprLogEntry[]>>;
  setAprEvidences: Dispatch<SetStateAction<AprWorkflowEvidenceItem[]>>;
  setVersionHistory: Dispatch<SetStateAction<AprWorkflowVersionHistoryItem[]>>;
  setValue: UseFormSetValue<AprFormData>;
}

async function loadAprPdfGenerator() {
  return import("@/lib/pdf/aprGenerator");
}

async function loadPdfFileUtils() {
  return import("@/lib/pdf/pdfFile");
}

export function useAprPdfWorkflow({
  canViewSignatures,
  setCurrentApr,
  setAprLogs,
  setAprEvidences,
  setVersionHistory,
  setValue,
}: UseAprPdfWorkflowOptions) {
  const getGovernedPdfAccess = useCallback(async (aprId: string) => {
    const access = await aprsService.getPdfAccess(aprId);
    return access.hasFinalPdf ? access : null;
  }, []);

  const ensureGovernedPdf = useCallback(
    async (apr: Apr) => {
      const existingAccess = await getGovernedPdfAccess(apr.id);
      if (existingAccess) {
        return existingAccess;
      }

      if (apr.status !== "Aprovada") {
        return null;
      }

      const generatedAccess = await aprsService.generateFinalPdf(apr.id);
      if (generatedAccess.generated) {
        toast.success("PDF final da APR emitido e registrado com sucesso.");
      }
      return generatedAccess;
    },
    [getGovernedPdfAccess],
  );

  const reloadAprWorkflowTimeline = useCallback(async (aprId: string) => {
    try {
      const [logs, versions, evidences] = await Promise.all([
        aprsService.getLogs(aprId),
        aprsService.getVersionHistory(aprId),
        aprsService.listAprEvidences(aprId),
      ]);
      setAprLogs(logs);
      setAprEvidences(evidences);
      setVersionHistory(
        versions.map((item) => ({
          id: item.id,
          numero: item.numero,
          versao: item.versao,
          status: item.status,
        })),
      );
    } catch (error) {
      logger.error("Erro ao atualizar a linha do tempo da APR:", error);
    }
  }, [setAprEvidences, setAprLogs, setVersionHistory]);

  const reloadAprWorkflowContext = useCallback(
    async (aprId: string) => {
      const freshApr = await aprsService.findOne(aprId);
      setCurrentApr(freshApr);
      setValue("status", freshApr.status);
      void reloadAprWorkflowTimeline(aprId);
      return freshApr;
    },
    [reloadAprWorkflowTimeline, setCurrentApr, setValue],
  );

  const handlePrintAfterSave = useCallback(
    async (
      aprId: string,
    ): Promise<{ didNavigateToPdf: boolean; usedPopup: boolean }> => {
      toast.info("Preparando impressão da APR...");
      const current = await aprsService.findOne(aprId);
      const shouldUseGovernedPdf =
        Boolean(current.has_final_pdf) || current.status === "Aprovada";

      if (shouldUseGovernedPdf) {
        const access = await ensureGovernedPdf(current);
        if (access?.url) {
          const usedPopup = openPdfForPrint(access.url, () => {
            toast.info(
              "Pop-up bloqueado. Abrimos o PDF final da APR na mesma aba para impressão.",
            );
          });
          return { didNavigateToPdf: true, usedPopup };
        }

        toast.warning(
          access?.message ||
            "O PDF final da APR foi emitido, mas a URL segura não está disponível agora.",
        );
        return { didNavigateToPdf: false, usedPopup: false };
      }

      const [fullApr, aprSignatures, evidences] = await Promise.all([
        aprsService.findOne(aprId),
        canViewSignatures
          ? signaturesService.findByDocument(aprId, "APR")
          : Promise.resolve<Signature[]>([]),
        aprsService.listAprEvidences(aprId),
      ]);
      const [{ generateAprPdf }, { base64ToPdfBlob }] = await Promise.all([
        loadAprPdfGenerator(),
        loadPdfFileUtils(),
      ]);
      const result = (await generateAprPdf(fullApr, aprSignatures, {
        save: false,
        output: "base64",
        evidences,
        draftWatermark: true,
      })) as { base64: string } | undefined;

      if (!result?.base64) {
        throw new Error("Falha ao gerar o PDF da APR para impressão.");
      }

      const fileURL = URL.createObjectURL(base64ToPdfBlob(result.base64));
      const usedPopup = openPdfForPrint(fileURL, () => {
        toast.info(
          "Pop-up bloqueado. Abrimos o PDF na mesma aba para impressão.",
        );
      });
      setTimeout(() => URL.revokeObjectURL(fileURL), 60_000);
      return { didNavigateToPdf: true, usedPopup };
    },
    [canViewSignatures, ensureGovernedPdf],
  );

  return {
    getGovernedPdfAccess,
    ensureGovernedPdf,
    reloadAprWorkflowTimeline,
    reloadAprWorkflowContext,
    handlePrintAfterSave,
  };
}
