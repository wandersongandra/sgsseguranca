import type { Rdo } from "@/services/rdosService";
import { pdfDocToBase64, type PdfOutputDoc } from "./pdfBase64";
import { fetchImageAsDataUrl } from "./pdfFile";
import { resolveCompanyLogoDataUrl } from "./companyLogo";
import { resolveValidationContext } from "./validationContext";
import { RDO_ACTIVITY_GOVERNED_PHOTO_REF_PREFIX, rdosService } from "@/services/rdosService";
import {
  applyFooterGovernance,
  applyInstitutionalDocumentHeader,
  buildPdfFilename,
  buildValidationUrl,
  createPdfContext,
  drawRdoBlueprint,
  formatDateTime,
  sanitize,
} from "@/lib/pdf-system";

type PdfOptions = {
  save?: boolean;
  output?: "base64";
  draftWatermark?: boolean;
};

type ParsedSignature = {
  nome?: string;
  cpf?: string;
  signed_at?: string;
};

type GovernanceSignature = {
  label: string;
  name: string;
  role: string;
  date: string | undefined;
  image: null;
};

export function maskCpfForPdf(value?: string | null): string {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 11) {
    return "-";
  }

  return `***.***.***-${digits.slice(-2)}`;
}

function parseSignature(raw?: string): ParsedSignature | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const nome =
      typeof parsed.nome === "string"
        ? parsed.nome
        : typeof parsed.aceite_por === "string"
          ? parsed.aceite_por
          : undefined;
    const cpf = typeof parsed.cpf === "string" ? parsed.cpf : undefined;
    const signed_at =
      typeof parsed.signed_at === "string"
        ? parsed.signed_at
        : typeof parsed.realizado_em === "string"
          ? parsed.realizado_em
          : undefined;

    if (!nome || !cpf) {
      return null;
    }

    return { nome, cpf, signed_at };
  } catch {
    return null;
  }
}

function parseRdoDocumentDate(value?: string | Date | null): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const looksLikeDateColumn =
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0;

    if (looksLikeDateColumn) {
      return new Date(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate(),
      );
    }

    return new Date(value.getTime());
  }

  if (typeof value === "string") {
    const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnlyMatch) {
      const [, year, month, day] = dateOnlyMatch;
      return new Date(Number(year), Number(month) - 1, Number(day));
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

function getIsoYear(date: Date): number {
  const target = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  return target.getUTCFullYear();
}

function getIsoWeekNumber(date: Date): number {
  const target = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
}

async function resolveActivityPhotoImageDataUrl(
  rdoId: string,
  activityIndex: number,
  photoIndex: number,
  photoReference?: string | null,
): Promise<string | null> {
  const normalized = typeof photoReference === "string" ? photoReference.trim() : "";
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("data:") || /^https?:\/\//i.test(normalized)) {
    return fetchImageAsDataUrl(normalized);
  }

  if (!normalized.startsWith(RDO_ACTIVITY_GOVERNED_PHOTO_REF_PREFIX)) {
    return null;
  }

  try {
    const access = await rdosService.getActivityPhotoAccess(
      rdoId,
      activityIndex,
      photoIndex,
    );

    return access.url ? fetchImageAsDataUrl(access.url) : null;
  } catch {
    return null;
  }
}

export function buildRdoDocumentCode(
  reference?: string | number | null,
  dateValue?: string | Date | null,
): string {
  const documentDate = parseRdoDocumentDate(dateValue);
  const ref = sanitize(reference)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8)
    .toUpperCase();

  return `RDO-${getIsoYear(documentDate)}-${String(
    getIsoWeekNumber(documentDate),
  ).padStart(2, "0")}-${ref || `${Date.now()}`.slice(-8)}`;
}

export async function generateRdoPdf(
  rdo: Rdo,
  options?: PdfOptions,
): Promise<void | { base64: string; filename: string }> {
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const ctx = createPdfContext(doc, "operational");

  const validationContext = await resolveValidationContext('rdos', rdo.id);
  const code =
    validationContext.documentCode ||
    buildRdoDocumentCode(rdo.id || rdo.numero, rdo.data);

  // Fetch company logo if available
  const logoUrl = await resolveCompanyLogoDataUrl(rdo.company);

  const validationUrl = buildValidationUrl(code, validationContext.token);
  const responsavelSignature = parseSignature(
    rdo.assinatura_responsavel ?? undefined,
  );
  const engineerSignature = parseSignature(
    rdo.assinatura_engenheiro ?? undefined,
  );
  ctx.y = applyInstitutionalDocumentHeader(ctx, {
    title: "RELATÓRIO DIÁRIO DE OBRA",
    subtitle:
      "Registro diário de atividades, recursos, ocorrências e condições de campo.",
    code,
    date:
      typeof rdo.data === "string"
        ? rdo.data
        : parseRdoDocumentDate(rdo.data).toISOString(),
    status: sanitize(rdo.status),
    version: rdo.version != null ? String(rdo.version) : "1",
    company: sanitize(rdo.company?.razao_social || rdo.company_id),
    site: sanitize(
      [rdo.site?.nome, rdo.site?.cidade, rdo.site?.estado]
        .filter(Boolean)
        .join(" - "),
    ),
    logoUrl,
  });

  await drawRdoBlueprint(
    ctx,
    autoTable,
    rdo,
    [
      responsavelSignature
        ? {
            label: "Responsável pela obra",
            name: sanitize(responsavelSignature.nome || "-"),
            role: `Responsável pela obra • CPF ${sanitize(
              maskCpfForPdf(responsavelSignature.cpf),
            )}`,
            date: responsavelSignature.signed_at,
            image: null,
          }
        : null,
      engineerSignature
        ? {
            label: "Engenheiro responsável",
            name: sanitize(engineerSignature.nome || "-"),
            role: `Engenheiro responsável • CPF ${sanitize(
              maskCpfForPdf(engineerSignature.cpf),
            )}`,
            date: engineerSignature.signed_at,
            image: null,
          }
        : null,
    ].filter((signature): signature is GovernanceSignature =>
      Boolean(signature),
    ),
    code,
    validationUrl,
    async (
      activityIndex: number,
      photoIndex: number,
      photoReference: string | null,
    ) =>
      resolveActivityPhotoImageDataUrl(
        rdo.id,
        activityIndex,
        photoIndex,
        photoReference,
      ),
    !(options?.draftWatermark ?? false),
  );

  applyFooterGovernance(ctx, {
    code,
    generatedAt: formatDateTime(new Date().toISOString()),
    draft: options?.draftWatermark ?? false,
  });

  const filename = buildPdfFilename(
    "RDO",
    sanitize(rdo.numero || code),
    typeof rdo.data === "string"
      ? rdo.data
      : parseRdoDocumentDate(rdo.data).toISOString(),
  );

  if (options?.save === false && options?.output === "base64") {
    const output = doc as unknown as PdfOutputDoc;
    return { base64: pdfDocToBase64(output), filename };
  }

  doc.save(filename);
}
