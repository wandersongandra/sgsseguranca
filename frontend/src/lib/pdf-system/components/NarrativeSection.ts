import type { PdfContext } from "../core/types";
import { ensureSpace, getRemainingHeight, moveY } from "../core/grid";
import { sanitize } from "../core/format";

type NarrativeSectionOptions = {
  title: string;
  content?: string | null;
};

export function drawNarrativeSection(
  ctx: PdfContext,
  options: NarrativeSectionOptions,
) {
  if (!options.content) return;
  const { doc, margin, contentWidth, theme } = ctx;

  const lines = (
    doc.splitTextToSize(sanitize(options.content), contentWidth - 10) as unknown[]
  ).map((line) => String(line));
  const lineHeight = 4.6;
  const titleGap = 11.2;
  const bottomPadding = 4.2;
  const minHeight = titleGap + lineHeight + bottomPadding;
  let cursor = 0;
  let isContinuation = false;

  while (cursor < lines.length) {
    ensureSpace(ctx, minHeight + 4);
    const availableHeight = getRemainingHeight(ctx);
    const maxLines = Math.max(
      1,
      Math.floor((availableHeight - titleGap - bottomPadding) / lineHeight),
    );
    const chunk = lines.slice(cursor, cursor + maxLines);
    const height = titleGap + chunk.length * lineHeight + bottomPadding;
    const title = isContinuation
      ? `${options.title} (continuação)`
      : options.title;

    doc.setFillColor(...theme.tone.surface);
    doc.setDrawColor(...theme.tone.border);
    doc.setLineWidth(0.22);
    doc.rect(margin, ctx.y, contentWidth, height, "FD");
    doc.setFillColor(...theme.tone.brand);
    doc.rect(margin, ctx.y, 1.5, height, "F");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.headingSm);
    doc.setTextColor(...theme.tone.textPrimary);
    doc.text(title, margin + 4.5, ctx.y + 6.1);

    doc.setDrawColor(...theme.tone.border);
    doc.setLineWidth(0.16);
    doc.line(
      margin + 4.5,
      ctx.y + 8.7,
      margin + contentWidth - 4,
      ctx.y + 8.7,
    );

    doc.setFont("helvetica", "normal");
    doc.setFontSize(theme.typography.body);
    doc.setTextColor(...theme.tone.textPrimary);
    doc.text(chunk, margin + 4.5, ctx.y + 14.1);

    moveY(ctx, height + theme.spacing.sectionGap);
    cursor += chunk.length;
    isContinuation = true;
  }
}
