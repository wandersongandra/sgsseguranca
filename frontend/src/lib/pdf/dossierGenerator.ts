import type { DossierContext } from "@/services/dossiersService";
import { pdfDocToBase64, type PdfOutputDoc } from "./pdfBase64";
import { resolveCompanyLogoDataUrl } from "./companyLogo";
import {
  applyFooterGovernance,
  applyInstitutionalDocumentHeader,
  buildPdfFilename,
  buildValidationUrl,
  createPdfContext,
  drawDossierBlueprint,
  formatDateTime,
  sanitize,
} from "@/lib/pdf-system";

type PdfOptions = {
  save?: boolean;
  output?: "base64";
  draftWatermark?: boolean;
};

function buildDossierDocumentCode(context: DossierContext): string {
  if (context.code) {
    return context.code;
  }

  return context.kind === "employee"
    ? `DOS-EMP-${context.id.slice(0, 8).toUpperCase()}`
    : `DOS-SIT-${context.id.slice(0, 8).toUpperCase()}`;
}

function buildDossierTitle(context: DossierContext) {
  return context.kind === "employee"
    ? "DOSSIÊ DE SST - COLABORADOR"
    : "DOSSIÊ DE SST - OBRA/SETOR";
}

function buildDossierSubtitle(context: DossierContext) {
  return context.kind === "employee"
    ? "Resumo do colaborador: capacitações, EPIs, permissões e documentos relacionados."
    : "Resumo do efetivo: capacitações, EPIs, permissões e documentos relacionados.";
}

function buildDossierSiteLabel(context: DossierContext) {
  if (context.kind === "employee") {
    return sanitize(context.subject.siteName || "-");
  }

  return sanitize(
    [context.subject.nome, context.subject.cidade, context.subject.estado]
      .filter(Boolean)
      .join(" - "),
  );
}

export async function generateDossierPdf(
  context: DossierContext,
  options?: PdfOptions,
): Promise<void | { base64: string; filename: string }> {
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const ctx = createPdfContext(doc, "compliance");

  const code = buildDossierDocumentCode(context);

  const logoUrl = await resolveCompanyLogoDataUrl({
    logo_url: context.companyLogoUrl,
  });

  ctx.y = applyInstitutionalDocumentHeader(ctx, {
    title: buildDossierTitle(context),
    subtitle: buildDossierSubtitle(context),
    code,
    date: context.generatedAt,
    status:
      context.kind === "employee"
        ? context.subject.status
          ? "Ativo"
          : "Inativo"
        : context.subject.status
          ? "Ativo"
          : "Inativo",
    version: "1",
    company: sanitize(context.companyName || context.companyId),
    site: buildDossierSiteLabel(context),
    logoUrl,
  });

  await drawDossierBlueprint(
    ctx,
    autoTable,
    context,
    code,
    buildValidationUrl(code),
  );

  applyFooterGovernance(ctx, {
    code,
    generatedAt: formatDateTime(new Date().toISOString()),
    draft: options?.draftWatermark ?? false,
  });

  const filename = buildPdfFilename(
    "DOSSIE",
    sanitize(
      context.kind === "employee"
        ? `COLABORADOR_${context.subject.nome}`
        : `UNIDADE_${context.subject.nome}`,
    ),
    context.generatedAt,
  );

  if (options?.save === false && options?.output === "base64") {
    const output = doc as unknown as PdfOutputDoc;
    return { base64: pdfDocToBase64(output), filename };
  }

  doc.save(filename);
}
