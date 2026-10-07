import type { PdfContext } from "../core/types";
import { ensureSpace, moveY } from "../core/grid";
import { sanitize } from "../core/format";

type DocumentIdentityRailOptions = {
  documentType: string;
  criticality?: string;
  validity?: string;
  documentClass?: string;
};

function criticalityColor(ctx: PdfContext, value: unknown) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (
    normalized.includes("crit") ||
    normalized.includes("alto") ||
    normalized.includes("intoler")
  ) {
    return ctx.theme.tone.danger;
  }
  if (
    normalized.includes("moder") ||
    normalized.includes("aten") ||
    normalized.includes("subst")
  ) {
    return ctx.theme.tone.warning;
  }
  if (
    normalized.includes("baixo") ||
    normalized.includes("aceit") ||
    normalized.includes("regular")
  ) {
    return ctx.theme.tone.success;
  }
  return ctx.theme.tone.textPrimary;
}

export function drawDocumentIdentityRail(
  ctx: PdfContext,
  options: DocumentIdentityRailOptions,
) {
  const { doc, margin, contentWidth, theme } = ctx;
  const fields = [
    { label: "Tipo documental", value: options.documentType, semantic: false },
    { label: "Criticidade", value: options.criticality, semantic: true },
    { label: "Validade", value: options.validity, semantic: false },
    { label: "Classe", value: options.documentClass, semantic: false },
  ].filter(
    (field) =>
      field.value !== undefined &&
      field.value !== null &&
      String(field.value).trim() !== "",
  );

  if (!fields.length) return;

  const colWidth = contentWidth / fields.length;
  const lineHeight = 4.1;
  const wrapped = fields.map((field) => ({
    ...field,
    lines: (doc.splitTextToSize(
      sanitize(field.value),
      colWidth - 8,
    ) as string[]).slice(0, 2),
  }));
  const maxLines = Math.max(...wrapped.map((field) => field.lines.length), 1);
  const height = 12.8 + maxLines * lineHeight;

  ensureSpace(ctx, height + 5);

  doc.setFillColor(...theme.tone.surface);
  doc.setDrawColor(...theme.tone.borderStrong);
  doc.setLineWidth(0.24);
  doc.rect(margin, ctx.y, contentWidth, height, "FD");

  doc.setFillColor(...theme.tone.brand);
  doc.rect(margin, ctx.y, 2.1, height, "F");

  wrapped.forEach((field, index) => {
    const x = margin + index * colWidth;
    if (index > 0) {
      doc.setDrawColor(...theme.tone.border);
      doc.setLineWidth(0.18);
      doc.line(x, ctx.y + 3, x, ctx.y + height - 3);
    }

    const textX = x + (index === 0 ? 5 : 3.5);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.caption);
    doc.setTextColor(...theme.tone.textMuted);
    doc.text(field.label.toUpperCase(), textX, ctx.y + 5.4);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.bodySm);
    doc.setTextColor(
      ...(field.semantic
        ? criticalityColor(ctx, field.value)
        : theme.tone.textPrimary),
    );
    doc.text(field.lines, textX, ctx.y + 10.4);
  });

  moveY(ctx, height + theme.spacing.blockGap);
}
