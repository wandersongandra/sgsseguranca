import type { Checklist } from "@/services/checklistsService";
import type { Signature } from "@/services/signaturesService";
import { pdfDocToBase64, type PdfOutputDoc } from "./pdfBase64";
import { resolveCompanyLogoDataUrl } from "./companyLogo";
import { resolveValidationContext } from "./validationContext";
import {
  applyFooterGovernance,
  applyInstitutionalDocumentHeader,
  buildDocumentCode,
  buildPdfFilename,
  buildValidationUrl,
  createPdfContext,
  drawChecklistBlueprint,
  formatDateTime,
  sanitize,
} from "@/lib/pdf-system";

type PdfOptions = {
  save?: boolean;
  output?: "base64";
  draftWatermark?: boolean;
};

export async function generateChecklistPdf(
  checklist: Checklist,
  signatures: Signature[],
  options?: PdfOptions,
): Promise<void | { base64: string; filename: string }> {
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const ctx = createPdfContext(doc, "operational");

  const validationContext = await resolveValidationContext(
    "checklists",
    checklist.id,
  );
  const code =
    validationContext.documentCode ||
    buildDocumentCode("CHK", checklist.id || checklist.titulo, checklist.data);

  const logoUrl = await resolveCompanyLogoDataUrl(checklist.company);

  ctx.y = applyInstitutionalDocumentHeader(ctx, {
    title: "CHECKLIST DE INSPEÇÃO",
    subtitle:
      "Itens verificados e resultado da inspeção",
    code,
    date: checklist.data,
    status: sanitize(checklist.status),
    version: "1",
    company: sanitize(checklist.company?.razao_social),
    site: sanitize(checklist.site?.nome),
    logoUrl,
  });
  await drawChecklistBlueprint(
    ctx,
    autoTable,
    checklist,
    signatures,
    code,
    buildValidationUrl(code, validationContext.token),
  );

  applyFooterGovernance(ctx, {
    code,
    generatedAt: formatDateTime(new Date().toISOString()),
    draft: options?.draftWatermark ?? false,
  });

  const filename = buildPdfFilename("CHECKLIST", checklist.titulo, checklist.data);
  if (options?.output === "base64") {
    const output = doc as unknown as PdfOutputDoc;
    return { base64: pdfDocToBase64(output), filename };
  }
  doc.save(filename);
}
