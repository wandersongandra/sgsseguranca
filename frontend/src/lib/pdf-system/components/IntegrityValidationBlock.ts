import QRCode from "qrcode";
import type { PdfContext } from "../core/types";
import { ensureSpace, moveY } from "../core/grid";
import { sanitize } from "../core/format";

type IntegrityValidationBlockOptions = {
  code: string;
  url: string;
  hash?: string;
  title?: string;
  subtitle?: string;
};

function wrapLongToken(value: string, chunk = 32) {
  const source = String(value || "").trim();
  if (!source) return "";
  return source.replace(new RegExp(`(.{${chunk}})`, "g"), "$1 ").trim();
}

export async function drawIntegrityValidationBlock(
  ctx: PdfContext,
  options: IntegrityValidationBlockOptions,
) {
  const { doc, margin, contentWidth, theme } = ctx;
  const title = options.title || "Validação do documento";
  const subtitle =
    options.subtitle ||
    "Use o QR Code ou o identificador para conferência no portal SGS.";
  const textWidth = Math.max(60, contentWidth - 40);
  const subtitleLines = doc.splitTextToSize(subtitle, textWidth) as string[];
  const urlLines = doc.splitTextToSize(options.url, textWidth) as string[];
  const hashLines = options.hash
    ? (doc.splitTextToSize(
        `Hash: ${wrapLongToken(options.hash, 28)}`,
        textWidth,
      ) as string[])
    : [];
  const dynamicTextHeight =
    subtitleLines.length * 3.8 +
    6 +
    urlLines.length * 3.2 +
    hashLines.length * 3.2;
  const height = Math.max(39, 12 + dynamicTextHeight + 5);
  ensureSpace(ctx, height + 4);

  const qrDataUrl = await QRCode.toDataURL(options.url, {
    margin: 0,
    width: 256,
    color: { dark: "#0f172a", light: "#ffffff" },
  });

  doc.setFillColor(...theme.tone.surface);
  doc.setDrawColor(...theme.tone.borderStrong);
  doc.setLineWidth(0.24);
  doc.rect(margin, ctx.y, contentWidth, height, "FD");
  doc.setFillColor(...theme.tone.brand);
  doc.rect(margin, ctx.y, 1.8, height, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(title, margin + 4.5, ctx.y + 6);

  doc.setDrawColor(...theme.tone.brand);
  doc.setLineWidth(0.4);
  doc.line(margin + 4.5, ctx.y + 8.7, margin + 29, ctx.y + 8.7);
  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.16);
  doc.line(margin + 31, ctx.y + 8.7, margin + contentWidth - 4, ctx.y + 8.7);

  const qrSize = 22;
  const qrX = margin + 4.5;
  const qrY = ctx.y + 12;
  doc.addImage(qrDataUrl, "PNG", qrX, qrY, qrSize, qrSize);
  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.18);
  doc.rect(qrX - 0.8, qrY - 0.8, qrSize + 1.6, qrSize + 1.6, "S");

  const tx = margin + 31;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.bodySm);
  doc.setTextColor(...theme.tone.textSecondary);
  doc.text(subtitleLines, tx, ctx.y + 15.5);

  const codeY = ctx.y + 16 + subtitleLines.length * 3.8 + 1.5;
  doc.setFont("courier", "bold");
  doc.setFontSize(theme.typography.bodySm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(
    `Código: ${wrapLongToken(sanitize(options.code), 24)}`,
    tx,
    codeY,
    { maxWidth: textWidth },
  );

  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.info);
  const urlY = codeY + 4.6;
  doc.text(urlLines, tx, urlY);

  if (hashLines.length) {
    doc.setFont("courier", "normal");
    doc.setTextColor(...theme.tone.textMuted);
    const hashY = urlY + urlLines.length * 3.2 + 1.4;
    doc.text(hashLines, tx, hashY);
  }

  const sealW = 30;
  doc.setFillColor(...theme.tone.success);
  doc.rect(
    margin + contentWidth - sealW - 4,
    ctx.y + height - 8,
    sealW,
    5.2,
    "F",
  );
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.brandOn);
  doc.text(
    "DOCUMENTO VÁLIDO",
    margin + contentWidth - sealW / 2 - 4,
    ctx.y + height - 4.4,
    { align: "center" },
  );

  moveY(ctx, height + 5);
}
