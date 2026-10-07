import type { PdfContext } from "../core/types";
import { sanitize } from "../core/format";
import { logger } from "../../logger";

export type DocumentHeaderOptions = {
  title: string;
  subtitle: string;
  code: string;
  codeLabel?: string;
  date?: string;
  version?: string;
  status?: string;
  company?: string;
  site?: string;
  logoUrl?: string | null;
  compactOnRepeat?: boolean;
};

function clampLines(lines: string[], maxLines: number) {
  if (lines.length <= maxLines) return lines;
  const limited = lines.slice(0, Math.max(1, maxLines));
  limited[limited.length - 1] = `${limited[limited.length - 1]}...`;
  return limited;
}

function resolveCurrentPage(doc: PdfContext["doc"]): number {
  const pdfDoc = doc as PdfContext["doc"] & {
    getCurrentPageInfo?: () => { pageNumber?: number };
    internal?: { getCurrentPageInfo?: () => { pageNumber?: number } };
  };

  return (
    pdfDoc.getCurrentPageInfo?.()?.pageNumber ||
    pdfDoc.internal?.getCurrentPageInfo?.()?.pageNumber ||
    1
  );
}

function drawCompactDocumentHeader(
  ctx: PdfContext,
  options: DocumentHeaderOptions,
) {
  const { doc, margin, contentWidth, theme } = ctx;
  const top = 6;
  const codeW = 50;
  const codeX = margin + contentWidth - codeW;
  const copyW = Math.max(40, codeX - margin - 6);

  doc.setFillColor(...theme.tone.brandStrong);
  doc.rect(0, 0, ctx.pageWidth, 2.4, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(
    clampLines(doc.splitTextToSize(sanitize(options.title), copyW) as string[], 1),
    margin,
    top + 4,
  );

  const context = [sanitize(options.company), sanitize(options.site), sanitize(options.date)]
    .filter((value) => value !== "-")
    .join("  ·  ");

  if (context) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(theme.typography.caption);
    doc.setTextColor(...theme.tone.textMuted);
    doc.text(
      clampLines(doc.splitTextToSize(context, copyW) as string[], 1),
      margin,
      top + 8.3,
    );
  }

  doc.setDrawColor(...theme.tone.borderStrong);
  doc.setLineWidth(0.28);
  doc.rect(codeX, top - 1.5, codeW, 11.5, "S");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.textMuted);
  doc.text(
    sanitize(options.codeLabel || "IDENTIFICADOR").toUpperCase(),
    codeX + 3,
    top + 2,
  );

  doc.setFontSize(theme.typography.bodySm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(
    clampLines(doc.splitTextToSize(sanitize(options.code), codeW - 6) as string[], 1),
    codeX + 3,
    top + 6.2,
  );

  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.textSecondary);
  doc.text(
    `${sanitize(options.status)} · v${sanitize(options.version || "1")}`,
    codeX + 3,
    top + 9.2,
  );

  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.2);
  doc.line(margin, top + 13.5, margin + contentWidth, top + 13.5);
  ctx.y = Math.max(ctx.y, top + 17.5);
}

export function drawDocumentHeader(
  ctx: PdfContext,
  options: DocumentHeaderOptions,
) {
  if (options.compactOnRepeat && resolveCurrentPage(ctx.doc) > 1) {
    drawCompactDocumentHeader(ctx, options);
    return;
  }

  const { doc, margin, contentWidth, theme } = ctx;
  const top = 6;
  const codeW = 52;
  const codeX = margin + contentWidth - codeW;
  const logoW = 29;
  const logoH = 15;
  const hasLogo = Boolean(options.logoUrl);
  const textX = hasLogo ? margin + logoW + 5 : margin;
  const textW = Math.max(45, codeX - textX - 7);

  doc.setFillColor(...theme.tone.brandStrong);
  doc.rect(0, 0, ctx.pageWidth, 2.8, "F");
  doc.setFillColor(...theme.tone.brand);
  doc.rect(0, 2.8, ctx.pageWidth, 0.8, "F");

  if (hasLogo && options.logoUrl) {
    try {
      const imgProps = doc.getImageProperties(options.logoUrl);
      const ratio = Math.min(logoW / imgProps.width, logoH / imgProps.height);
      const w = imgProps.width * ratio;
      const h = imgProps.height * ratio;
      doc.addImage(
        options.logoUrl,
        imgProps.fileType,
        margin + (logoW - w) / 2,
        top + (logoH - h) / 2,
        w,
        h,
      );
    } catch {
      logger.warn("[PDF] Failed to add logo to header.");
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingLg);
  doc.setTextColor(...theme.tone.textPrimary);
  const titleLines = clampLines(
    doc.splitTextToSize(sanitize(options.title), textW) as string[],
    2,
  );
  doc.text(titleLines, textX, top + 5.5);

  const titleHeight = titleLines.length * 5.2;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.bodySm);
  doc.setTextColor(...theme.tone.textSecondary);
  const subtitleLines = clampLines(
    doc.splitTextToSize(sanitize(options.subtitle), textW) as string[],
    2,
  );
  doc.text(subtitleLines, textX, top + 6.5 + titleHeight);

  doc.setDrawColor(...theme.tone.borderStrong);
  doc.setLineWidth(0.3);
  doc.rect(codeX, top, codeW, 19, "S");
  doc.setFillColor(...theme.tone.surfaceMuted);
  doc.rect(codeX, top, codeW, 5.2, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.textSecondary);
  doc.text(
    sanitize(options.codeLabel || "IDENTIFICADOR").toUpperCase(),
    codeX + 3,
    top + 3.5,
  );

  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(
    clampLines(doc.splitTextToSize(sanitize(options.code), codeW - 6) as string[], 2),
    codeX + 3,
    top + 9.6,
  );

  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.textSecondary);
  doc.text(
    `${sanitize(options.status)} · v${sanitize(options.version || "1")}`,
    codeX + 3,
    top + 16.2,
  );

  const metadata = [
    { label: "Empresa", value: options.company },
    { label: "Site/Obra", value: options.site },
    { label: "Data de referência", value: options.date },
  ].filter(
    (entry) =>
      entry.value !== undefined &&
      entry.value !== null &&
      String(entry.value).trim().length > 0,
  );

  const metaY = top + 24;
  const metaH = 14;
  if (metadata.length > 0) {
    const width = contentWidth / metadata.length;
    doc.setDrawColor(...theme.tone.border);
    doc.setLineWidth(0.22);
    doc.rect(margin, metaY, contentWidth, metaH, "S");

    metadata.forEach((entry, index) => {
      const x = margin + index * width;
      if (index > 0) doc.line(x, metaY, x, metaY + metaH);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(theme.typography.caption);
      doc.setTextColor(...theme.tone.textMuted);
      doc.text(entry.label.toUpperCase(), x + 3.5, metaY + 4);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(theme.typography.bodySm);
      doc.setTextColor(...theme.tone.textPrimary);
      doc.text(
        clampLines(
          doc.splitTextToSize(sanitize(entry.value), width - 7) as string[],
          2,
        ),
        x + 3.5,
        metaY + 8.6,
      );
    });
  }

  const endY = metadata.length > 0 ? metaY + metaH : top + 22;
  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.2);
  doc.line(margin, endY + 3.2, margin + contentWidth, endY + 3.2);
  ctx.y = Math.max(ctx.y, endY + 7);
}
