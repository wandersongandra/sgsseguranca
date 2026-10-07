import QRCode from "qrcode";
import type { PdfContext } from "../core/types";
import { ensureSpace, getRemainingHeight, moveY } from "../core/grid";
import { formatDate, sanitize } from "../core/format";
import type { AuthoritySignature } from "./AuthoritySignatureBlock";

type PdfRgb = [number, number, number];

type GovernanceClosingBlockOptions = {
  code: string;
  url: string;
  hash?: string;
  title?: string;
  subtitle?: string;
  signatures?: AuthoritySignature[];
  accentColor?: PdfRgb;
  accentSoftColor?: PdfRgb;
  draft?: boolean;
};

type ClosingPalette = {
  accent: PdfRgb;
  accentSoft: PdfRgb;
};

const SIGNATURE_ROW_HEIGHT = 14.5;

function wrapLongToken(value: string, chunk = 34): string {
  const source = String(value || "").trim();
  if (!source) return "";
  return source
    .split(/(\s+)/)
    .map((part) => {
      if (!part || /^\s+$/.test(part) || part.length <= chunk) return part;
      const slices: string[] = [];
      for (let i = 0; i < part.length; i += chunk) {
        slices.push(part.slice(i, i + chunk));
      }
      return slices.join(" ");
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function estimateSignaturePanelHeight(signatures: AuthoritySignature[]) {
  if (!signatures.length) return 0;
  return 8 + signatures.length * SIGNATURE_ROW_HEIGHT + 2;
}

function estimateValidationPanelHeight(
  ctx: PdfContext,
  width: number,
  subtitle: string,
  code: string,
  hash?: string,
) {
  const textWidth = Math.max(35, width - 32);
  const subtitleLines = ctx.doc.splitTextToSize(subtitle, textWidth) as string[];
  const codeLines = ctx.doc.splitTextToSize(
    `Código: ${wrapLongToken(sanitize(code), 24)}`,
    textWidth,
  ) as string[];
  const hashLines = hash
    ? (ctx.doc.splitTextToSize(
        `Hash: ${wrapLongToken(hash, 28)}`,
        textWidth,
      ) as string[])
    : [];

  return Math.max(
    36,
    13 +
      subtitleLines.length * 3.4 +
      codeLines.length * 3.4 +
      hashLines.length * 3 +
      9,
  );
}

function getMaxSignatureRows(availableBodyHeight: number) {
  return Math.max(
    1,
    Math.floor((Math.max(availableBodyHeight, 32) - 10) / SIGNATURE_ROW_HEIGHT),
  );
}

function drawSignaturePanel(
  ctx: PdfContext,
  x: number,
  y: number,
  width: number,
  height: number,
  signatures: AuthoritySignature[],
  palette: ClosingPalette,
  heading = "RESPONSABILIDADES E ASSINATURAS",
) {
  const { doc, theme } = ctx;

  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.2);
  doc.rect(x, y, width, height, "S");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.textMuted);
  doc.text(heading, x + 3, y + 4.8);

  signatures.forEach((signature, index) => {
    const rowY = y + 7 + index * SIGNATURE_ROW_HEIGHT;
    const separatorY = rowY + SIGNATURE_ROW_HEIGHT - 1.2;

    if (index > 0) {
      doc.setDrawColor(...theme.tone.border);
      doc.setLineWidth(0.16);
      doc.line(x + 3, rowY - 1.5, x + width - 3, rowY - 1.5);
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.caption);
    doc.setTextColor(...theme.tone.textMuted);
    doc.text(sanitize(signature.label).toUpperCase(), x + 3, rowY + 2.8);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.bodySm);
    doc.setTextColor(...theme.tone.textPrimary);
    doc.text(sanitize(signature.name), x + 3, rowY + 6.8, {
      maxWidth: width - 28,
    });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(theme.typography.caption);
    doc.setTextColor(...theme.tone.textSecondary);
    const details = [sanitize(signature.role), formatDate(signature.date)]
      .filter((value) => value && value !== "-")
      .join(" · ");
    if (details) {
      doc.text(details, x + 3, rowY + 10.3, { maxWidth: width - 28 });
    }

    const isHmac =
      signature.signatureType === "hmac" ||
      (signature.image != null &&
        !signature.image.startsWith("data:image") &&
        /^[a-f0-9]{64}$/i.test(signature.image));

    const proofX = x + width - 22;
    const proofW = 18;

    if (isHmac) {
      const hmacPreview = signature.image
        ? signature.image.slice(0, 8).toUpperCase()
        : "--------";
      doc.setDrawColor(...palette.accent);
      doc.setLineWidth(0.2);
      doc.rect(proofX, rowY + 2.1, proofW, 8.2, "S");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(5.2);
      doc.setTextColor(...palette.accent);
      doc.text("ASSINATURA HMAC", proofX + proofW / 2, rowY + 5.1, {
        align: "center",
      });
      doc.setFont("courier", "normal");
      doc.setFontSize(4.7);
      doc.text(hmacPreview, proofX + proofW / 2, rowY + 8.5, {
        align: "center",
      });
    } else if (signature.image && signature.image.startsWith("data:image")) {
      try {
        doc.addImage(
          signature.image,
          "PNG",
          proofX,
          rowY + 1.4,
          proofW,
          9.5,
        );
      } catch {
        doc.setDrawColor(...theme.tone.borderStrong);
        doc.line(proofX, rowY + 9.6, proofX + proofW, rowY + 9.6);
      }
    } else {
      doc.setDrawColor(...theme.tone.borderStrong);
      doc.setLineWidth(0.2);
      doc.line(proofX, rowY + 9.6, proofX + proofW, rowY + 9.6);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(4.8);
      doc.setTextColor(...theme.tone.textMuted);
      doc.text("assinatura", proofX + proofW / 2, rowY + 12, {
        align: "center",
      });
    }

    if (index === signatures.length - 1) {
      doc.setDrawColor(...theme.tone.border);
      doc.setLineWidth(0.14);
      doc.line(x + 3, separatorY, x + width - 3, separatorY);
    }
  });
}

function drawValidationPanel(
  ctx: PdfContext,
  x: number,
  y: number,
  width: number,
  height: number,
  subtitle: string,
  code: string,
  hash: string | undefined,
  qrDataUrl: string,
  draft: boolean,
  palette: ClosingPalette,
) {
  const { doc, theme } = ctx;

  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.2);
  doc.rect(x, y, width, height, "S");

  doc.setFillColor(...palette.accent);
  doc.rect(x, y, 1.8, height, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.textMuted);
  doc.text("VERIFICAÇÃO DO DOCUMENTO", x + 4.5, y + 4.8);

  const qrSize = 23;
  const qrX = x + 4.5;
  const qrY = y + 8;
  doc.addImage(qrDataUrl, "PNG", qrX, qrY, qrSize, qrSize);
  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.16);
  doc.rect(qrX - 0.8, qrY - 0.8, qrSize + 1.6, qrSize + 1.6, "S");

  const textX = qrX + qrSize + 4;
  const textWidth = width - (textX - x) - 4;
  const subtitleLines = doc.splitTextToSize(subtitle, textWidth) as string[];
  const codeLines = doc.splitTextToSize(
    `Código: ${wrapLongToken(sanitize(code), 24)}`,
    textWidth,
  ) as string[];
  const hashLines = hash
    ? (doc.splitTextToSize(
        `Hash: ${wrapLongToken(hash, 28)}`,
        textWidth,
      ) as string[])
    : [];

  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.bodySm);
  doc.setTextColor(...theme.tone.textSecondary);
  doc.text(subtitleLines, textX, qrY + 2.6);

  const codeY = qrY + 3 + subtitleLines.length * 3.5 + 3;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.bodySm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(codeLines, textX, codeY);

  if (hashLines.length) {
    const hashY = codeY + codeLines.length * 3.5 + 2;
    doc.setFont("courier", "normal");
    doc.setFontSize(5.8);
    doc.setTextColor(...theme.tone.textMuted);
    doc.text(hashLines, textX, hashY);
  }

  const badgeLabel = draft ? "RASCUNHO" : "DOCUMENTO VÁLIDO";
  const badgeColor: PdfRgb = draft ? [180, 83, 9] : [22, 101, 52];
  const badgeW = draft ? 21 : 31;

  doc.setFillColor(...badgeColor);
  doc.rect(x + width - badgeW - 4, y + height - 8.2, badgeW, 5.2, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(255, 255, 255);
  doc.text(badgeLabel, x + width - badgeW / 2 - 4, y + height - 4.6, {
    align: "center",
  });
}

export async function drawGovernanceClosingBlock(
  ctx: PdfContext,
  options: GovernanceClosingBlockOptions,
) {
  const { doc, margin, contentWidth, theme } = ctx;
  const palette: ClosingPalette = {
    accent: options.accentColor ?? theme.tone.brand,
    accentSoft: options.accentSoftColor ?? theme.tone.surfaceMuted,
  };
  const title = options.title || "Validação do documento";
  const subtitle =
    options.subtitle ||
    "Use o QR Code ou o código do documento para conferência no portal SGS.";
  const signatures = (options.signatures || []).filter(
    (signature) => signature.name || signature.role || signature.image,
  );

  const qrDataUrl = await QRCode.toDataURL(options.url, {
    margin: 0,
    width: 256,
    color: { dark: "#0f172a", light: "#ffffff" },
  });

  const hasSignatures = signatures.length > 0;
  const gap = 5;
  const validationW = hasSignatures
    ? Math.max(62, Math.round(contentWidth * 0.37))
    : contentWidth - 6;
  const signatureW = hasSignatures
    ? contentWidth - validationW - gap - 6
    : 0;

  const validationH = estimateValidationPanelHeight(
    ctx,
    validationW,
    subtitle,
    options.code,
    options.hash,
  );

  let availableFirstBodyHeight = Math.max(32, getRemainingHeight(ctx) - 18);
  let firstSignatureCount = hasSignatures
    ? Math.min(signatures.length, getMaxSignatureRows(availableFirstBodyHeight))
    : 0;
  let firstSignatures = signatures.slice(0, firstSignatureCount);
  let remainingSignatures = signatures.slice(firstSignatureCount);
  let bodyHeight = Math.max(
    estimateSignaturePanelHeight(firstSignatures),
    validationH,
    36,
  );
  let totalHeight = bodyHeight + 15;

  const yBeforeSpace = ctx.y;
  ensureSpace(ctx, totalHeight + 4);

  if (ctx.y < yBeforeSpace && hasSignatures) {
    availableFirstBodyHeight = Math.max(32, getRemainingHeight(ctx) - 18);
    firstSignatureCount = Math.min(
      signatures.length,
      getMaxSignatureRows(availableFirstBodyHeight),
    );
    firstSignatures = signatures.slice(0, firstSignatureCount);
    remainingSignatures = signatures.slice(firstSignatureCount);
    bodyHeight = Math.max(
      estimateSignaturePanelHeight(firstSignatures),
      validationH,
      36,
    );
    totalHeight = bodyHeight + 15;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(title, margin, ctx.y + 5.8);

  doc.setDrawColor(...palette.accent);
  doc.setLineWidth(0.45);
  doc.line(margin, ctx.y + 8.5, margin + 30, ctx.y + 8.5);
  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.18);
  doc.line(margin + 32, ctx.y + 8.5, margin + contentWidth, ctx.y + 8.5);

  const innerY = ctx.y + 11.5;
  if (hasSignatures) {
    drawSignaturePanel(
      ctx,
      margin,
      innerY,
      signatureW,
      bodyHeight,
      firstSignatures,
      palette,
    );
  }

  const validationX = hasSignatures
    ? margin + signatureW + gap
    : margin;
  drawValidationPanel(
    ctx,
    validationX,
    innerY,
    hasSignatures ? validationW : contentWidth,
    bodyHeight,
    subtitle,
    options.code,
    options.hash,
    qrDataUrl,
    options.draft ?? Boolean(ctx.isDraft),
    palette,
  );

  moveY(ctx, totalHeight + theme.spacing.sectionGap);

  let cursor = 0;
  while (cursor < remainingSignatures.length) {
    ensureSpace(ctx, 36);
    const availableBodyHeight = Math.max(32, getRemainingHeight(ctx) - 14);
    const chunkSize = getMaxSignatureRows(availableBodyHeight);
    const chunk = remainingSignatures.slice(cursor, cursor + chunkSize);
    const continuationBodyHeight = Math.max(
      estimateSignaturePanelHeight(chunk),
      34,
    );
    const continuationTotalHeight = continuationBodyHeight + 15;

    ensureSpace(ctx, continuationTotalHeight + 4);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.headingSm);
    doc.setTextColor(...theme.tone.textPrimary);
    doc.text(
      `${title} - assinaturas complementares`,
      margin,
      ctx.y + 5.8,
    );
    doc.setDrawColor(...palette.accent);
    doc.setLineWidth(0.45);
    doc.line(margin, ctx.y + 8.5, margin + 30, ctx.y + 8.5);
    doc.setDrawColor(...theme.tone.border);
    doc.setLineWidth(0.18);
    doc.line(margin + 32, ctx.y + 8.5, margin + contentWidth, ctx.y + 8.5);

    drawSignaturePanel(
      ctx,
      margin,
      ctx.y + 11.5,
      contentWidth,
      continuationBodyHeight,
      chunk,
      palette,
      "RESPONSABILIDADES E ASSINATURAS (CONT.)",
    );

    moveY(ctx, continuationTotalHeight + theme.spacing.sectionGap);
    cursor += chunk.length;
  }
}
