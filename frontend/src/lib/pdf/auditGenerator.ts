import type { Audit } from "@/services/auditsService";
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
  drawAuditBlueprint,
  formatDateTime,
  sanitize,
} from "@/lib/pdf-system";

type PdfOptions = {
  save?: boolean;
  output?: "base64";
  draftWatermark?: boolean;
};

export async function generateAuditPdf(
  audit: Audit,
  options?: PdfOptions,
): Promise<void | { base64: string; filename: string }> {
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const ctx = createPdfContext(doc, "compliance");

  const validationContext = await resolveValidationContext("audits", audit.id);
  const code =
    validationContext.documentCode ||
    buildDocumentCode("AUD", audit.id || audit.titulo);

  const logoUrl = await resolveCompanyLogoDataUrl(audit.company);

  ctx.y = applyInstitutionalDocumentHeader(ctx, {
    title: "RELATÓRIO DE AUDITORIA",
    subtitle: "Achados, evidências e conclusão da auditoria",
    code,
    date: audit.data_auditoria,
    status: "Emitido",
    version: "1",
    company: sanitize(
      audit.company?.razao_social || audit.company_id,
    ),
    site: sanitize(audit.site?.nome),
    logoUrl,
  });
  await drawAuditBlueprint(
    ctx,
    autoTable,
    audit,
    code,
    buildValidationUrl(code, validationContext.token),
  );

  applyFooterGovernance(ctx, {
    code,
    generatedAt: formatDateTime(new Date().toISOString()),
    draft: options?.draftWatermark ?? false,
  });

  const filename = buildPdfFilename("AUDITORIA", audit.titulo, audit.data_auditoria);
  if (options?.save === false && options?.output === "base64") {
    const output = doc as unknown as PdfOutputDoc;
    return { base64: pdfDocToBase64(output), filename };
  }
  doc.save(filename);
}
