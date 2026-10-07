import type { Dds } from "@/services/ddsService";
import type { Signature } from "@/services/signaturesService";
import type { GovernedDocumentVideoAttachment } from "@/lib/videos/documentVideos";
import { pdfDocToBase64, type PdfOutputDoc } from "./pdfBase64";
import { resolveCompanyLogoDataUrl } from "./companyLogo";
import {
  applyFooterGovernance,
  applyInstitutionalDocumentHeader,
  buildDocumentCode,
  buildPdfFilename,
  buildValidationUrl,
  createPdfContext,
  drawDdsBlueprint,
  formatDateTime,
  sanitize,
} from "@/lib/pdf-system";

type PdfOptions = {
  save?: boolean;
  output?: "base64";
  draftWatermark?: boolean;
};

export async function generateDdsPdf(
  dds: Dds,
  signatures: Signature[],
  videoAttachments: GovernedDocumentVideoAttachment[],
  options?: PdfOptions,
): Promise<string | void> {
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const ctx = createPdfContext(doc, "operational");
  const code =
    dds.document_code || buildDocumentCode("DDS", dds.id || dds.tema, dds.data);
  const validationUrl = buildValidationUrl(code, dds.validation_token, {
    module: "dds",
    mode: "code",
  });

  // Fetch company logo if available
  const logoUrl = await resolveCompanyLogoDataUrl(dds.company);

  ctx.y = applyInstitutionalDocumentHeader(ctx, {
    title: "DIÁLOGO DIÁRIO DE SEGURANÇA",
    subtitle:
      "Tema, orientações de segurança e registro de participação",
    code,
    date: formatDateTime(dds.data),
    status: sanitize(dds.status),
    version: dds.version != null ? String(dds.version) : "1",
    company: sanitize(dds.company?.razao_social || dds.company_id),
    site: sanitize(dds.site?.nome || dds.site_id),
    logoUrl,
  });

  await drawDdsBlueprint(
    ctx,
    autoTable,
    dds,
    signatures,
    videoAttachments,
    code,
    validationUrl,
  );

  applyFooterGovernance(ctx, {
    code,
    generatedAt: formatDateTime(
      dds.pdf_generated_at || new Date().toISOString(),
    ),
    issuer: dds.emitted_by?.nome,
    draft: options?.draftWatermark ?? false,
  });

  const filename = buildPdfFilename("DDS", sanitize(dds.tema), dds.data);
  if (options?.save === false && options?.output === "base64") {
    const docOutput = doc as unknown as PdfOutputDoc;
    return pdfDocToBase64(docOutput);
  }
  doc.save(filename);
}
