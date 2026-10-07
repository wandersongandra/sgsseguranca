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

export async function drawIntegrityValidationBlock(
  ctx: PdfContext,
  options: IntegrityValidationBlockOptions,
) {
  const { doc, margin, contentWidth, theme } = ctx;
  const title = options.title || "Validação do documento";
  const subtitle = options.subtitle || "Use o QR Code ou o identificador para conferência no portal SGS.";
  const subtitleLines = doc.splitTextToSize(subtitle, 72);
  const urlLines = doc.splitTextToSize(options.url, 72);
  const hashLines = options.hash ? doc.splitTextToSize(`Hash: ${options.hash}`, 72) : [];
  const dynamicTextHeight = subtitleLines.length * 3.8 + 6 + urlLines.length * 3.2 + hashLines.length * 3.2;
  const height = Math.max(40, 12 + dynamicTextHeight + 5);
  ensureSpace(ctx, height + 4);

  const qrDataUrl = await QRCode.toDataURL(options.url, {
    margin: 0,
    width: 256,
    color: { dark: "#0f172a", light: "#ffffff" },
  });

  doc.setFillColor(...theme.tone.surface);
  doc.setDrawColor(...theme.tone.borderStrong);
  doc.setLineWidth(0.35);
  doc.roundedRect(margin, ctx.y, contentWidth, height, 2, 2, "FD");

  doc.setFillColor(...theme.tone.brand);
  doc.rect(margin, ctx.y, 2.5, 10, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(title, margin + 5, ctx.y + 6.5);

  const qrSize = 22;
  const qrY = ctx.y + 12;
  doc.addImage(qrDataUrl, "PNG", margin + 4, qrY, qrSize, qrSize);
  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.25);
  doc.line(margin + 30, qrY, margin + 30, Math.min(ctx.y + height - 4, qrY + qrSize));

  const tx = margin + 33;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.bodySm);
  doc.setTextColor(...theme.tone.textSecondary);
  doc.text(subtitleLines, tx, ctx.y + 16);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.body);
  doc.setTextColor(...theme.tone.textPrimary);
  const codeY = ctx.y + 16 + subtitleLines.length * 3.8 + 1.5;
  doc.text(`Codigo: ${sanitize(options.code)}`, tx, codeY);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.info);
  const urlY = codeY + 4.6;
  doc.text(urlLines, tx, urlY);

  if (options.hash) {
    doc.setTextColor(...theme.tone.textMuted);
    const hashY = urlY + urlLines.length * 3.2 + 1.4;
    doc.text(hashLines, tx, hashY);
  }

  doc.setFillColor(...theme.tone.success);
  const sealX = margin + contentWidth - 8;
  const sealY = ctx.y + Math.min(height - 7, 20.5);
  doc.circle(sealX, sealY, 4.5, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.body);
  doc.setTextColor(...theme.tone.brandOn);
  doc.text("✓", sealX, sealY + 1.8, { align: "center" });

  moveY(ctx, height + 5);
}
