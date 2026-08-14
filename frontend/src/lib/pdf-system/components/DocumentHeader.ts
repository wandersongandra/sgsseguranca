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
  if (lines.length <= maxLines) {
    return lines;
  }

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
  const compactHeight = 14.5;
  const infoY = compactHeight + 2.1;
  const codeW = 52;
  const codeX = margin + contentWidth - codeW;
  const textMaxWidth = codeX - margin - 5;
  const compactMeta = [
    sanitize(options.company),
    sanitize(options.site),
    sanitize(options.date),
  ]
    .filter((value) => value !== "-")
    .join("  |  ");

  doc.setFillColor(...theme.tone.brand);
  doc.rect(0, 0, ctx.pageWidth, compactHeight, "F");
  doc.setFillColor(...theme.tone.brandStrong);
  doc.rect(0, compactHeight - 1.1, ctx.pageWidth, 1.1, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.brandOn);
  doc.text(clampLines(doc.splitTextToSize(options.title, textMaxWidth) as string[], 1), margin, 7.4);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(223, 231, 239);
  doc.text(
    clampLines(doc.splitTextToSize(options.subtitle, textMaxWidth) as string[], 1),
    margin,
    11.4,
  );

  doc.setFillColor(...theme.tone.surface);
  doc.setDrawColor(...theme.tone.borderStrong);
  doc.setLineWidth(0.3);
  doc.roundedRect(
    codeX,
    3.1,
    codeW,
    8.4,
    theme.spacing.radius / 1.4,
    theme.spacing.radius / 1.4,
    "FD",
  );
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(
    clampLines(doc.splitTextToSize(sanitize(options.code), codeW - 8) as string[], 1),
    codeX + codeW / 2,
    7.4,
    { align: "center" },
  );
  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.textSecondary);
  doc.text(
    clampLines(
      doc.splitTextToSize(
        `${sanitize(options.codeLabel || "ID")} | ${sanitize(options.status)}`,
        codeW - 8,
      ) as string[],
      1,
    ),
    codeX + codeW / 2,
    10.3,
    { align: "center" },
  );

  if (compactMeta) {
    doc.setFillColor(...theme.tone.surface);
    doc.setDrawColor(...theme.tone.border);
    doc.setLineWidth(0.22);
    doc.roundedRect(
      margin,
      infoY,
      contentWidth,
      6.8,
      theme.spacing.radius / 1.8,
      theme.spacing.radius / 1.8,
      "FD",
    );
    doc.setFont("helvetica", "normal");
    doc.setFontSize(theme.typography.caption);
    doc.setTextColor(...theme.tone.textMuted);
    doc.text(
      clampLines(doc.splitTextToSize(compactMeta, contentWidth - 8) as string[], 1),
      margin + 3,
      infoY + 4.4,
    );
  }

  ctx.y = Math.max(ctx.y, infoY + 10.2);
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
  const codeW = 58;
  const codeX = margin + contentWidth - codeW;

  const hasLogo = Boolean(options.logoUrl);
  const logoMaxW = 32;
  const logoMaxH = 20;
  const logoMarginRight = 6;

  const textX = hasLogo ? margin + logoMaxW + logoMarginRight : margin;
  const textMaxWidth = codeX - textX - 5;
  const boxY = 5.5;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingLg);
  const titleLines = clampLines(
    doc.splitTextToSize(options.title, textMaxWidth) as string[],
    2,
  );

  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.bodySm);
  const subtitleLines = clampLines(
    doc.splitTextToSize(options.subtitle, textMaxWidth) as string[],
    2,
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

  const titleHeight = titleLines.length * 5.2;
  const subtitleHeight = subtitleLines.length * 3.8;
  const topBandHeight = Math.max(24.5, 7 + titleHeight + subtitleHeight + 4);
  const statusText = `Status: ${sanitize(options.status)} | V${sanitize(options.version || "1")}`;
  const codeLines = doc.splitTextToSize(options.code, codeW - 4) as string[];
  const statusLines = doc.splitTextToSize(statusText, codeW - 4) as string[];
  const boxH = Math.max(
    20,
    7 + codeLines.length * 4.2 + statusLines.length * 3.2 + 3.5,
  );

  const metaColumns = Math.max(1, metadata.length);
  const metaGap = 2.4;
  const metaWidth =
    metaColumns > 0
      ? (contentWidth - metaGap * Math.max(0, metaColumns - 1)) / metaColumns
      : contentWidth;
  const metaHeight =
    metadata.length > 0
      ? Math.max(
          ...metadata.map((entry) => {
            const valueLines = clampLines(
              doc.splitTextToSize(
                sanitize(entry.value),
                metaWidth - 8,
              ) as string[],
              2,
            );
            return 6 + valueLines.length * 4;
          }),
          12,
        )
      : 0;
  const metaY = topBandHeight + 2.6;
  const headerHeight = Math.max(
    topBandHeight + (metadata.length > 0 ? metaHeight + 7.2 : 4.5),
    boxY + boxH + 6,
  );

  doc.setFillColor(...theme.tone.brand);
  doc.rect(0, 0, ctx.pageWidth, topBandHeight, "F");
  doc.setFillColor(...theme.tone.brandStrong);
  doc.rect(0, topBandHeight - 1.4, ctx.pageWidth, 1.4, "F");

  // Draw Logo if available
  if (hasLogo && options.logoUrl) {
    try {
      const imgProps = doc.getImageProperties(options.logoUrl);
      const ratio = Math.min(logoMaxW / imgProps.width, logoMaxH / imgProps.height);
      const w = imgProps.width * ratio;
      const h = imgProps.height * ratio;
      const lx = margin + (logoMaxW - w) / 2;
      const ly = 6 + (logoMaxH - h) / 2;

      doc.addImage(options.logoUrl, imgProps.fileType, lx, ly, w, h);
    } catch {
      logger.warn("[PDF] Failed to add logo to header.");
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingLg);
  doc.setTextColor(...theme.tone.brandOn);
  doc.text(titleLines, textX, 10.2);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.bodySm);
  doc.setTextColor(223, 231, 239);
  const subtitleY = 10.5 + titleHeight + 0.5;
  doc.text(subtitleLines, textX, subtitleY);

  doc.setFillColor(...theme.tone.surface);
  doc.roundedRect(
    codeX,
    boxY,
    codeW,
    boxH,
    theme.spacing.radius,
    theme.spacing.radius,
    "F",
  );
  doc.setDrawColor(...theme.tone.borderStrong);
  doc.setLineWidth(0.35);
  doc.roundedRect(
    codeX,
    boxY,
    codeW,
    boxH,
    theme.spacing.radius,
    theme.spacing.radius,
    "S",
  );
  doc.setFillColor(...theme.tone.info);
  doc.roundedRect(
    codeX + 1.8,
    boxY + 1.6,
    codeW - 3.6,
    4.2,
    theme.spacing.radius / 2,
    theme.spacing.radius / 2,
    "F",
  );

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.brandOn);
  doc.text(sanitize(options.codeLabel || "IDENTIFICADOR").toUpperCase(), codeX + codeW / 2, boxY + 4.8, {
    align: "center",
  });

  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(codeLines, codeX + codeW / 2, boxY + 11.6, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.caption);
  doc.text(statusLines, codeX + codeW / 2, boxY + boxH - 5, {
    align: "center",
    maxWidth: codeW - 4,
  });

  metadata.forEach((entry, index) => {
    const cardX = margin + index * (metaWidth + metaGap);
    const valueLines = clampLines(
      doc.splitTextToSize(sanitize(entry.value), metaWidth - 8) as string[],
      2,
    );

    doc.setFillColor(...theme.tone.surface);
    doc.setDrawColor(...theme.tone.border);
    doc.setLineWidth(0.24);
    doc.roundedRect(
      cardX,
      metaY,
      metaWidth,
      metaHeight,
      theme.spacing.radius,
      theme.spacing.radius,
      "FD",
    );
    doc.setFillColor(...theme.tone.brand);
    doc.rect(cardX, metaY, 2.2, metaHeight, "F");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.caption);
    doc.setTextColor(...theme.tone.textMuted);
    doc.text(entry.label.toUpperCase(), cardX + 4.5, metaY + 4.7);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.bodySm);
    doc.setTextColor(...theme.tone.textPrimary);
    doc.text(valueLines, cardX + 4.5, metaY + 9.1);
  });

  // headerHeight is measured from the page top, so do not add the page margin twice.
  ctx.y = Math.max(ctx.y, headerHeight + 4.5);
}
