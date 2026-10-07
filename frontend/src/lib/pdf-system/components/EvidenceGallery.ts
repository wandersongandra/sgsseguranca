import type { PdfContext } from "../core/types";
import { ensureSpace, moveY } from "../core/grid";
import { sanitize } from "../core/format";

export type EvidenceGalleryItem = {
  title?: string;
  description?: string;
  meta?: string;
  source?: string;
};

type EvidenceGalleryOptions = {
  title: string;
  items: EvidenceGalleryItem[];
  resolveImageDataUrl?: (item: EvidenceGalleryItem, index: number) => Promise<string | null>;
  strict?: boolean;
};

type EvidenceCardLayout = {
  x?: number;
  w?: number;
  skipEnsureSpace?: boolean;
};

function normalizeInlineImageDataUrl(value?: string | null): string | null {
  const source = String(value || "").trim();
  if (!source.startsWith("data:image/")) {
    return null;
  }
  return source.replace(/\s+/g, "");
}

function inferImageFormat(dataUrl: string): "PNG" | "JPEG" | "WEBP" | "GIF" | "BMP" | "UNKNOWN" {
  const mimeMatch = dataUrl.match(/^data:image\/([a-z0-9.+-]+);base64,/i);
  const mime = mimeMatch?.[1]?.toLowerCase();
  if (!mime) {
    return "UNKNOWN";
  }
  if (mime.includes("png")) return "PNG";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "JPEG";
  if (mime.includes("webp")) return "WEBP";
  if (mime.includes("gif")) return "GIF";
  if (mime.includes("bmp")) return "BMP";
  return "UNKNOWN";
}

async function drawOneEvidence(
  ctx: PdfContext,
  item: EvidenceGalleryItem,
  index: number,
  resolveImageDataUrl?: (item: EvidenceGalleryItem, index: number) => Promise<string | null>,
  strict = false,
  layout?: EvidenceCardLayout,
) {
  const { doc, theme } = ctx;
  const cardX = layout?.x ?? ctx.margin;
  const cardW = layout?.w ?? ctx.contentWidth;
  const scale = cardW / ctx.contentWidth;

  let dataUrl: string | null = null;
  let imageState: "loaded" | "missing" | "error" = "missing";

  if (resolveImageDataUrl) {
    try {
      dataUrl = normalizeInlineImageDataUrl(await resolveImageDataUrl(item, index));
      imageState = dataUrl ? "loaded" : "missing";
    } catch {
      if (strict) {
        throw new Error(
          `Evidência fotográfica ${index + 1} indisponível para emissão oficial.`,
        );
      }
      imageState = "error";
    }
  } else {
    dataUrl = normalizeInlineImageDataUrl(item.source);
    if (dataUrl) {
      imageState = "loaded";
    }
  }

  if (!dataUrl && item.source?.startsWith("data:")) {
    dataUrl = normalizeInlineImageDataUrl(item.source);
    imageState = "loaded";
  }

  const hasImage = imageState === "loaded" && Boolean(dataUrl);
  // Scale image dimensions proportionally to card width
  const imageWrapW = hasImage
    ? Math.max(24, Math.round(74 * scale))
    : Math.max(18, Math.round(52 * scale));
  const imageWrapH = hasImage
    ? Math.max(20, Math.round(66 * scale))
    : Math.max(14, Math.round(36 * scale));
  const detailsW = cardW - imageWrapW - 16;
  const titleLines = doc.splitTextToSize(
    sanitize(item.title || "Registro fotográfico"),
    detailsW,
  );
  const descLines = doc.splitTextToSize(sanitize(item.description), detailsW);
  const metaLines = doc.splitTextToSize(sanitize(item.meta), detailsW);
  const titleHeight = Math.max(4.8, titleLines.length * 4.8);
  const contentTextHeight =
    8 + titleHeight + 6 + descLines.length * 4 + 5 + metaLines.length * 3.4;
  const cardInnerH = Math.max(imageWrapH, contentTextHeight + (hasImage ? 8 : 5));
  const cardH = cardInnerH + 12;

  if (!layout?.skipEnsureSpace) {
    ensureSpace(ctx, cardH + 6);
  }

  doc.setFillColor(...theme.tone.surface);
  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.22);
  doc.rect(cardX, ctx.y, cardW, cardH, "FD");

  doc.setFillColor(...theme.tone.surfaceMuted);
  doc.rect(cardX + 5, ctx.y + 6, imageWrapW, cardInnerH, "F");
  doc.setDrawColor(...theme.tone.borderStrong);
  doc.setLineWidth(0.18);
  doc.rect(cardX + 5, ctx.y + 6, imageWrapW, cardInnerH, "S");

  const textX = cardX + imageWrapW + 11;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.textMuted);
  doc.text(`EVIDÊNCIA ${index + 1}`, textX, ctx.y + 12);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(titleLines, textX, ctx.y + 18);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.bodySm);
  doc.setTextColor(...theme.tone.textSecondary);
  const descriptionY = ctx.y + 18 + titleLines.length * 4.8 + 1.2;
  doc.text(descLines, textX, descriptionY);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.textMuted);
  const metaY = descriptionY + descLines.length * 4 + 6;
  doc.text(metaLines, textX, metaY);

  if (hasImage && dataUrl) {
    try {
      const format = inferImageFormat(dataUrl);
      let w = imageWrapW - 4;
      let h = cardInnerH - 4;
      let x = cardX + 5 + 2;
      let y = ctx.y + 6 + 2;

      try {
        const props = doc.getImageProperties(dataUrl as unknown as string);
        const ratio = Math.min(
          (imageWrapW - 4) / props.width,
          (cardInnerH - 4) / props.height,
          1,
        );
        w = props.width * ratio;
        h = props.height * ratio;
        x = cardX + 5 + (imageWrapW - w) / 2;
        y = ctx.y + 6 + (cardInnerH - h) / 2;
      } catch {
        // Mantém um encaixe seguro mesmo quando o parser de imagem não extrai metadados.
      }

      doc.addImage(dataUrl, format === "UNKNOWN" ? "PNG" : format, x, y, w, h);
    } catch {
      imageState = "error";
    }
  }

  if (!hasImage || imageState === "error") {
    if (strict && !hasImage) {
      throw new Error(`Evidência fotográfica ${index + 1} indisponível para emissão oficial.`);
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.caption);
    doc.setTextColor(...theme.tone.textMuted);
    doc.text(
      imageState === "error" ? "FOTO INDISPONÍVEL" : "SEM FOTO",
      cardX + 5 + imageWrapW / 2,
      ctx.y + 20,
      { align: "center" },
    );

    doc.setFont("helvetica", "normal");
    doc.setFontSize(theme.typography.bodySm);
    if (imageState === "error") {
      doc.setTextColor(...theme.tone.danger);
    } else {
      doc.setTextColor(...theme.tone.textSecondary);
    }
    doc.text(
      imageState === "error"
        ? "Registro visual não pôde ser carregado."
        : "Evidência textual preservada no documento.",
      cardX + 5 + imageWrapW / 2,
      ctx.y + 25.5,
      { align: "center", maxWidth: imageWrapW - 6 },
    );

    doc.setDrawColor(...theme.tone.border);
    doc.setLineWidth(0.2);
    doc.line(cardX + 11, ctx.y + 31, cardX + imageWrapW - 1, ctx.y + 31);
  }

  moveY(ctx, cardH + 5);
}

export async function drawEvidenceGallery(ctx: PdfContext, options: EvidenceGalleryOptions) {
  if (!options.items.length) return;
  const { doc, margin, contentWidth, theme } = ctx;
  const useDoubleColumn = options.items.length >= 2;
  // Keep the gallery heading together with the first evidence row and away from the footer.
  ensureSpace(ctx, useDoubleColumn ? 102 : 82);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(options.title, margin, ctx.y + 5.8);
  doc.setDrawColor(...theme.tone.info);
  doc.setLineWidth(0.45);
  doc.line(margin, ctx.y + 8.4, margin + 30, ctx.y + 8.4);
  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.16);
  doc.line(margin + 32, ctx.y + 8.4, margin + contentWidth, ctx.y + 8.4);
  moveY(ctx, 11);

  // Use 2-per-row layout when 2+ items to maximise page space and produce a
  // polished grid view consistent with the document design system.
  if (!useDoubleColumn) {
    for (const [index, item] of options.items.entries()) {
      await drawOneEvidence(ctx, item, index, options.resolveImageDataUrl, options.strict ?? false);
    }
    return;
  }

  const gap = 5;
  const halfW = (contentWidth - gap) / 2;

  for (let i = 0; i < options.items.length; i += 2) {
    const leftItem = options.items[i];
    const rightItem = options.items[i + 1];
    if (!leftItem) {
      break;
    }

    // Reserve enough vertical space for the taller card in the pair before drawing.
    ensureSpace(ctx, 88);
    const pairStartY = ctx.y;

    // Left card
    await drawOneEvidence(
      ctx,
      leftItem,
      i,
      options.resolveImageDataUrl,
      options.strict ?? false,
      { x: margin, w: halfW, skipEnsureSpace: true },
    );
    const leftEndY = ctx.y;

    // Right card — reset cursor to pair start, then advance past the taller card
    if (rightItem) {
      ctx.y = pairStartY;
      await drawOneEvidence(
        ctx,
        rightItem,
        i + 1,
        options.resolveImageDataUrl,
        options.strict ?? false,
        { x: margin + halfW + gap, w: halfW, skipEnsureSpace: true },
      );
      ctx.y = Math.max(leftEndY, ctx.y);
    }
  }
}
