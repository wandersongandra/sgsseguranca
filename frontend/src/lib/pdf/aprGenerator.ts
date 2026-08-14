import type { Apr } from "@/services/aprsService";
import type { Signature } from "@/services/signaturesService";
import { pdfDocToBase64, type PdfOutputDoc } from "./pdfBase64";
import { blobToDataUrl } from "./pdfFile";
import { resolveCompanyLogoDataUrl } from "./companyLogo";
import {
  applyFooterGovernance,
  applyInstitutionalDocumentHeader,
  buildDocumentCode,
  buildPdfFilename,
  buildValidationUrl,
  createPdfContext,
  drawAprBlueprint,
  formatDateTime,
  sanitize,
} from "@/lib/pdf-system";
import { logger } from "@/lib/logger";

type AprPdfEvidence = {
  id: string;
  apr_risk_item_id: string;
  original_name?: string;
  uploaded_at: string;
  captured_at?: string;
  url?: string;
  watermarked_url?: string;
  risk_item_ordem?: number;
};

type PdfOptions = {
  save?: boolean;
  output?: "base64";
  evidences?: AprPdfEvidence[];
  draftWatermark?: boolean;
};

export async function generateAprPdf(
  apr: Apr,
  signatures: Signature[],
  options?: PdfOptions,
): Promise<void | { base64: string; filename: string }> {
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const ctx = createPdfContext(doc, "compliance");

  const code = buildDocumentCode(
    "APR",
    apr.id || apr.numero || apr.titulo,
    apr.data_inicio,
  );

  // Fetch company logo if available
  const logoUrl = await resolveCompanyLogoDataUrl(apr.company);

  ctx.y = applyInstitutionalDocumentHeader(ctx, {
    title: "ANÁLISE PRELIMINAR DE RISCO",
    subtitle: "Documento técnico de avaliação preventiva em SST",
    code,
    date: apr.data_inicio,
    status: sanitize(apr.status),
    version: sanitize(apr.versao ?? 1),
    company: sanitize(apr.company?.razao_social || apr.company_id),
    site: sanitize(apr.site?.nome || apr.site_id),
    logoUrl,
  });

  await drawAprBlueprint(
    ctx,
    autoTable,
    apr,
    signatures,
    code,
    buildValidationUrl(code),
    options?.evidences,
    async (item) => {
      const sources = [item.watermarked_url, item.url].filter(
        (source): source is string => Boolean(source),
      );
      for (const source of sources) {
        try {
          const response = await fetch(source);
          if (!response.ok) {
            logger.warn(
              "[APR PDF] Falha ao carregar evidência (HTTP %s): %s",
              response.status,
              source,
            );
            continue;
          }
          const blob = await response.blob();
          return blobToDataUrl(blob);
        } catch (err) {
          logger.warn("[APR PDF] Erro ao buscar evidência: %s", source, err);
          continue;
        }
      }
      if (sources.length > 0) {
        logger.warn(
          "[APR PDF] Evidência %s não pôde ser carregada de nenhuma fonte. O PDF será gerado sem essa imagem.",
          item.id ?? "desconhecida",
        );
      }
      return null;
    },
  );

  applyFooterGovernance(ctx, {
    code,
    generatedAt: formatDateTime(new Date().toISOString()),
    draft: options?.draftWatermark ?? false,
  });

  const filename = buildPdfFilename(
    "APR",
    `${sanitize(apr.numero || code)}_v${apr.versao ?? 1}`,
    apr.data_inicio,
  );
  if (options?.save === false && options?.output === "base64") {
    const output = doc as unknown as PdfOutputDoc;
    return { base64: pdfDocToBase64(output), filename };
  }
  doc.save(filename);
}
