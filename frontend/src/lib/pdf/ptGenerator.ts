import { ptsService, type Pt } from "@/services/ptsService";
import type { Signature } from "@/services/signaturesService";
import { pdfDocToBase64, type PdfOutputDoc } from "./pdfBase64";
import { fetchImageAsDataUrl } from "./pdfFile";
import { resolveCompanyLogoDataUrl } from "./companyLogo";
import {
  applyFooterGovernance,
  applyInstitutionalDocumentHeader,
  buildDocumentCode,
  buildPdfFilename,
  buildValidationUrl,
  createPdfContext,
  drawPtBlueprint,
  formatDate,
  formatDateTime,
  sanitize,
} from "@/lib/pdf-system";

type PdfOptions = {
  save?: boolean;
  output?: "base64";
  draftWatermark?: boolean;
};

export async function generatePtPdf(
  pt: Pt,
  signatures: Signature[],
  options?: PdfOptions,
): Promise<void | { base64: string; filename: string }> {
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const ctx = createPdfContext(doc, "compliance");
  ctx.isDraft = options?.draftWatermark ?? false;

  const code =
    String(pt.numero || "").trim() ||
    buildDocumentCode("PT", pt.id || pt.titulo, pt.data_hora_inicio);

  // Contexto de validação governado (best-effort): hash de integridade do PDF
  // final + token público para o QR. Falha degrada graciosamente — o PDF ainda
  // é gerado, apenas sem token/hash. Não buscamos para rascunhos (draftWatermark):
  // uma prévia local não deve carregar QR/token de validação oficial.
  let validationToken: string | null = null;
  let finalPdfHash: string | null = pt.final_pdf_hash_sha256 ?? null;
  if (pt.id && !ctx.isDraft) {
    try {
      const context = await ptsService.getValidationContext(pt.id);
      validationToken = context.token ?? null;
      finalPdfHash = context.finalPdfHash ?? finalPdfHash;
    } catch {
      // silencioso: mantém geração resiliente
    }
  }
  const validationUrl = buildValidationUrl(code, validationToken, {
    module: "pt",
    mode: "code",
  });

  // Fetch company logo if available
  const company = (pt as Pt & { company?: { logo_url?: string } }).company;
  const logoUrl = await resolveCompanyLogoDataUrl(company);

  ctx.y = applyInstitutionalDocumentHeader(ctx, {
    title: "PERMISSÃO DE TRABALHO",
    subtitle: "Liberação de atividade e controles de segurança",
    code,
    codeLabel: "Número da PT",
    date: formatDate(pt.data_hora_inicio),
    status: sanitize(pt.status),
    version: "1",
    company: sanitize(
      (pt as Pt & { company?: { razao_social?: string } }).company
        ?.razao_social || pt.company_id,
    ),
    site: sanitize(pt.site?.nome),
    logoUrl,
    compactOnRepeat: true,
  });
  // Resolve fotos de evidência via URL assinada → data URL inline no PDF.
  // Falhas individuais degradam para placeholder (modo não-strict da galeria).
  const resolveEvidencePhotoDataUrl = async (
    photoIndex: number,
  ): Promise<string | null> => {
    if (!pt.id) return null;
    try {
      const access = await ptsService.getEvidencePhotoAccess(pt.id, photoIndex);
      if (!access.url) return null;
      return await fetchImageAsDataUrl(access.url);
    } catch {
      return null;
    }
  };

  await drawPtBlueprint(ctx, autoTable, pt, signatures, code, validationUrl, {
    resolveEvidencePhotoDataUrl,
    finalPdfHash,
  });

  applyFooterGovernance(ctx, {
    code,
    generatedAt: formatDateTime(new Date().toISOString()),
    draft: options?.draftWatermark ?? false,
  });

  const filename = buildPdfFilename("PT", sanitize(pt.numero || code), pt.data_hora_inicio);
  if (options?.save === false && options?.output === "base64") {
    const output = doc as unknown as PdfOutputDoc;
    return { base64: pdfDocToBase64(output), filename };
  }
  doc.save(filename);
}
