import type { PdfContext } from "../core/types";
import { ensureSpace, moveY } from "../core/grid";
import { formatDate, sanitize } from "../core/format";

export type AuthoritySignature = {
  label: string;
  name?: string;
  role?: string;
  date?: string;
  image?: string | null;
  signatureType?: string;
};

type AuthoritySignatureBlockOptions = {
  title?: string;
  signatures: AuthoritySignature[];
};

export function drawAuthoritySignatureBlock(
  ctx: PdfContext,
  options: AuthoritySignatureBlockOptions,
) {
  const signatures = options.signatures.filter(
    (signature) => signature.name || signature.role || signature.image,
  );
  if (!signatures.length) return;

  const { doc, margin, contentWidth, theme } = ctx;
  const title = options.title || "Responsabilidade técnica e assinaturas";
  const columns = signatures.length === 1 ? 1 : 2;
  const gap = columns === 2 ? 7 : 0;
  const cardW = (contentWidth - gap) / columns;
  const cardH = 36;
  const rows = Math.ceil(signatures.length / columns);
  const totalHeight = 11 + rows * cardH + Math.max(0, rows - 1) * 5 + 2;

  ensureSpace(ctx, totalHeight + 5);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(title, margin, ctx.y + 5.8);
  doc.setDrawColor(...theme.tone.brand);
  doc.setLineWidth(0.45);
  doc.line(margin, ctx.y + 8.5, margin + 28, ctx.y + 8.5);
  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.18);
  doc.line(margin + 30, ctx.y + 8.5, margin + contentWidth, ctx.y + 8.5);

  signatures.forEach((signature, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const x = margin + col * (cardW + gap);
    const y = ctx.y + 12 + row * (cardH + 5);

    doc.setDrawColor(...theme.tone.border);
    doc.setLineWidth(0.18);
    doc.rect(x, y, cardW, cardH, "S");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.caption);
    doc.setTextColor(...theme.tone.textMuted);
    doc.text(sanitize(signature.label).toUpperCase(), x + 3, y + 4.8);

    const signatureAreaY = y + 7;
    const signatureAreaH = 13;

    if (signature.image && signature.image.startsWith("data:image")) {
      try {
        doc.addImage(
          signature.image,
          "PNG",
          x + 7,
          signatureAreaY,
          cardW - 14,
          signatureAreaH - 1,
        );
      } catch {
        // A linha de assinatura continua disponível mesmo sem a imagem.
      }
    }

    doc.setDrawColor(...theme.tone.borderStrong);
    doc.setLineWidth(0.24);
    doc.line(x + 4, y + 22, x + cardW - 4, y + 22);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.bodySm);
    doc.setTextColor(...theme.tone.textPrimary);
    doc.text(sanitize(signature.name), x + cardW / 2, y + 26.5, {
      align: "center",
      maxWidth: cardW - 8,
    });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(theme.typography.caption);
    doc.setTextColor(...theme.tone.textSecondary);
    const details = [sanitize(signature.role), formatDate(signature.date)]
      .filter((value) => value && value !== "-")
      .join(" · ");
    if (details) {
      doc.text(details, x + cardW / 2, y + 31, {
        align: "center",
        maxWidth: cardW - 8,
      });
    }
  });

  moveY(ctx, totalHeight + theme.spacing.sectionGap);
}
