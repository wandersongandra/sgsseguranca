import type { CatRecord } from "@/services/catsService";
import { pdfDocToBase64, type PdfOutputDoc } from "./pdfBase64";
import { resolveCompanyLogoDataUrl } from "./companyLogo";
import { resolveValidationContext } from "./validationContext";
import {
  applyFooterGovernance,
  applyInstitutionalDocumentHeader,
  buildPdfFilename,
  buildValidationUrl,
  createPdfContext,
  drawCatBlueprint,
  formatDate,
  formatDateTime,
  sanitize,
} from "@/lib/pdf-system";

type PdfOptions = {
  save?: boolean;
  output?: "base64";
  draftWatermark?: boolean;
};

export function buildCatDocumentCode(
  cat: Pick<CatRecord, "id" | "data_ocorrencia">,
): string {
  const date = new Date(cat.data_ocorrencia);
  const year = Number.isNaN(date.getTime())
    ? new Date().getFullYear()
    : date.getFullYear();
  return `CAT-${year}-${cat.id.slice(0, 8).toUpperCase()}`;
}

export async function generateCatPdf(
  cat: CatRecord,
  options?: PdfOptions,
): Promise<void | { base64: string; filename: string }> {
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const ctx = createPdfContext(doc, "compliance");

  const validationContext = await resolveValidationContext("cats", cat.id);
  const code = validationContext.documentCode || buildCatDocumentCode(cat);

  const logoUrl = await resolveCompanyLogoDataUrl(cat.company);

  ctx.y = applyInstitutionalDocumentHeader(ctx, {
    title: "COMUNICAÇÃO DE ACIDENTE DE TRABALHO",
    subtitle:
      "Registro do acidente de trabalho e dados da apuração.",
    code,
    date: formatDate(cat.data_ocorrencia),
    status: sanitize(cat.status),
    version: "1",
    company: sanitize(cat.company?.razao_social || cat.company_id),
    site: sanitize(cat.site?.nome || cat.local_ocorrencia),
    logoUrl,
  });

  await drawCatBlueprint(
    ctx,
    autoTable,
    cat,
    code,
    buildValidationUrl(code, validationContext.token),
  );

  applyFooterGovernance(ctx, {
    code,
    generatedAt: formatDateTime(new Date().toISOString()),
    draft: options?.draftWatermark ?? false,
  });

  const filename = buildPdfFilename(
    "CAT",
    sanitize(cat.numero || code),
    cat.data_ocorrencia,
  );
  if (options?.save === false && options?.output === "base64") {
    const output = doc as unknown as PdfOutputDoc;
    return { base64: pdfDocToBase64(output), filename };
  }

  doc.save(filename);
}
