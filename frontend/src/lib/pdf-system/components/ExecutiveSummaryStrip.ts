import type { PdfContext } from "../core/types";
import { ensureSpace, moveY } from "../core/grid";
import { sanitize } from "../core/format";

export type ExecutiveMetric = {
  label: string;
  value: string | number;
  tone?: "default" | "success" | "warning" | "danger" | "info";
};

export type ExecutiveSummaryOptions = {
  title: string;
  summary?: string;
  metrics: ExecutiveMetric[];
};

function toneColor(ctx: PdfContext, tone: ExecutiveMetric["tone"]) {
  if (tone === "success") return ctx.theme.tone.success;
  if (tone === "warning") return ctx.theme.tone.warning;
  if (tone === "danger") return ctx.theme.tone.danger;
  if (tone === "info") return ctx.theme.tone.info;
  return ctx.theme.tone.brand;
}

function clampLines(lines: string[], maxLines: number) {
  if (lines.length <= maxLines) return lines;
  const next = lines.slice(0, maxLines);
  next[next.length - 1] = `${next[next.length - 1]}...`;
  return next;
}

export function drawExecutiveSummaryStrip(
  ctx: PdfContext,
  options: ExecutiveSummaryOptions,
) {
  const { doc, margin, contentWidth, theme } = ctx;
  const columns = options.metrics.length <= 4 ? 2 : 3;
  const colWidth = contentWidth / columns;
  const labelLineHeight = 3.1;
  const valueLineHeight = 4.8;
  const summaryLines = options.summary
    ? clampLines(
        doc.splitTextToSize(
          sanitize(options.summary),
          contentWidth - 10,
        ) as string[],
        4,
      )
    : [];

  const metricBlocks = options.metrics.map((metric) => {
    const labelLines = clampLines(
      doc.splitTextToSize(metric.label.toUpperCase(), colWidth - 9) as string[],
      2,
    );
    const valueLines = clampLines(
      doc.splitTextToSize(sanitize(metric.value), colWidth - 9) as string[],
      3,
    );
    const height =
      8.3 +
      labelLines.length * labelLineHeight +
      valueLines.length * valueLineHeight;
    return { metric, labelLines, valueLines, height };
  });

  const rowHeights: number[] = [];
  for (let i = 0; i < metricBlocks.length; i += columns) {
    rowHeights.push(
      Math.max(...metricBlocks.slice(i, i + columns).map((item) => item.height), 16),
    );
  }

  const headingHeight = 11;
  const summaryHeight = summaryLines.length
    ? summaryLines.length * 4.1 + 6
    : 1.5;
  const metricsHeight = rowHeights.reduce((sum, height) => sum + height, 0);
  const totalHeight = headingHeight + summaryHeight + metricsHeight;

  ensureSpace(ctx, totalHeight + 5);

  doc.setFillColor(...theme.tone.surface);
  doc.setDrawColor(...theme.tone.borderStrong);
  doc.setLineWidth(0.25);
  doc.rect(margin, ctx.y, contentWidth, totalHeight, "FD");

  doc.setFillColor(...theme.tone.brandStrong);
  doc.rect(margin, ctx.y, contentWidth, 2.2, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text(options.title, margin + 4, ctx.y + 7.4);

  let cursorY = ctx.y + headingHeight;

  if (summaryLines.length) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(theme.typography.bodySm);
    doc.setTextColor(...theme.tone.textSecondary);
    doc.text(summaryLines, margin + 4, cursorY + 1);
    cursorY += summaryHeight;
  } else {
    cursorY += summaryHeight;
  }

  let blockIndex = 0;
  rowHeights.forEach((rowHeight, rowIndex) => {
    if (rowIndex > 0) {
      doc.setDrawColor(...theme.tone.border);
      doc.setLineWidth(0.18);
      doc.line(margin, cursorY, margin + contentWidth, cursorY);
    }

    for (let col = 0; col < columns; col += 1) {
      const entry = metricBlocks[blockIndex];
      if (!entry) break;
      const x = margin + col * colWidth;

      if (col > 0) {
        doc.setDrawColor(...theme.tone.border);
        doc.setLineWidth(0.18);
        doc.line(x, cursorY + 3, x, cursorY + rowHeight - 3);
      }

      const marker = toneColor(ctx, entry.metric.tone);
      doc.setFillColor(...marker);
      doc.rect(x + 3.2, cursorY + 3.2, 1.2, rowHeight - 6.4, "F");

      doc.setFont("helvetica", "bold");
      doc.setFontSize(theme.typography.caption);
      doc.setTextColor(...theme.tone.textMuted);
      doc.text(entry.labelLines, x + 7, cursorY + 6.4);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(theme.typography.headingSm);
      doc.setTextColor(...theme.tone.textPrimary);
      const valueY =
        cursorY +
        7.2 +
        entry.labelLines.length * labelLineHeight +
        3.3;
      doc.text(entry.valueLines, x + 7, valueY);

      blockIndex += 1;
    }

    cursorY += rowHeight;
  });

  moveY(ctx, totalHeight + theme.spacing.sectionGap);
}
