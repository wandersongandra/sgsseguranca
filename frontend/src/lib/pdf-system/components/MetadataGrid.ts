import type { PdfContext } from "../core/types";
import {
  ensureSpace,
  getRemainingHeight,
  moveY,
  PDF_SAFE_BOTTOM,
  PDF_SAFE_TOP,
  startNewPage,
} from "../core/grid";
import { sanitize } from "../core/format";

export type MetadataField = {
  label: string;
  value?: string | number | null;
};

type MetadataGridOptions = {
  title: string;
  fields: MetadataField[];
  columns?: 2 | 3;
};

const LABEL_LINE_HEIGHT = 3.6;
const VALUE_LINE_HEIGHT = 4.8;
const LABEL_TO_VALUE_GAP = 1.8;
const ROW_TOP_PADDING = 4.8;
const ROW_BOTTOM_PADDING = 4.8;
const MAX_LABEL_LINES = 4;
const MAX_VALUE_LINES = 16;

function softWrapLongTokens(value: string, maxTokenLength = 26): string {
  const splitIntoChunks = (segment: string): string[] => {
    const chunks: string[] = [];
    for (let i = 0; i < segment.length; i += maxTokenLength) {
      chunks.push(segment.slice(i, i + maxTokenLength));
    }
    return chunks;
  };

  return value
    .split("\n")
    .map((line) =>
      line
        .split(/(\s+)/)
        .map((segment) => {
          if (!segment || /^\s+$/.test(segment) || segment.length <= maxTokenLength) {
            return segment;
          }
          return splitIntoChunks(segment).join(" ");
        })
        .join(""),
    )
    .join("\n");
}

function clampLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  const limited = lines.slice(0, Math.max(1, maxLines));
  const lastIndex = limited.length - 1;
  limited[lastIndex] = `${limited[lastIndex]}...`;
  return limited;
}

export function drawMetadataGrid(ctx: PdfContext, options: MetadataGridOptions) {
  const { doc, margin, contentWidth, theme } = ctx;
  const columns = options.columns || 2;
  const colWidth = contentWidth / columns;
  const rowMetrics = options.fields.map((field) => {
    const safeLabel = softWrapLongTokens(field.label.toUpperCase());
    const safeValue = softWrapLongTokens(sanitize(field.value));
    const labelLines = clampLines(
      doc.splitTextToSize(safeLabel, colWidth - 10) as string[],
      MAX_LABEL_LINES,
    );
    const valueLines = clampLines(
      doc.splitTextToSize(safeValue, colWidth - 10) as string[],
      MAX_VALUE_LINES,
    );
    const rowHeight =
      ROW_TOP_PADDING +
      labelLines.length * LABEL_LINE_HEIGHT +
      LABEL_TO_VALUE_GAP +
      valueLines.length * VALUE_LINE_HEIGHT +
      ROW_BOTTOM_PADDING;
    return { labelLines, valueLines, rowHeight };
  });

  type RowGroup = {
    rowFields: MetadataField[];
    rowData: Array<(typeof rowMetrics)[number]>;
    rowHeight: number;
  };

  const rowGroups: RowGroup[] = [];
  for (let i = 0; i < options.fields.length; i += columns) {
    const rowFields = options.fields.slice(i, i + columns);
    const rowData = rowMetrics.slice(i, i + columns);
    rowGroups.push({
      rowFields,
      rowData,
      rowHeight: Math.max(...rowData.map((x) => x.rowHeight), 12),
    });
  }

  const renderChunk = (
    chunk: RowGroup[],
    title: string,
  ) => {
    const titleBarHeight = 10.5;
    let totalHeight = titleBarHeight;
    chunk.forEach((row) => {
      totalHeight += row.rowHeight;
    });

    doc.setFillColor(...theme.tone.surface);
    doc.setDrawColor(...theme.tone.borderStrong);
    doc.setLineWidth(0.24);
    doc.rect(margin, ctx.y, contentWidth, totalHeight, "FD");
    doc.setFillColor(...theme.tone.brandStrong);
    doc.rect(margin, ctx.y, contentWidth, 2.1, "F");
    doc.setDrawColor(...theme.tone.border);
    doc.setLineWidth(0.18);
    doc.line(
      margin,
      ctx.y + titleBarHeight,
      margin + contentWidth,
      ctx.y + titleBarHeight,
    );

    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.headingSm);
    doc.setTextColor(...theme.tone.textPrimary);
    doc.text(title, margin + 4, ctx.y + 7);

    let cursorY = ctx.y + titleBarHeight;
    chunk.forEach((row, rowIndex) => {
      row.rowFields.forEach((_, colIndex) => {
        const x = margin + colIndex * colWidth;
        const data = row.rowData[colIndex];
        if (!data) return;
        const baseX = x + 3.5;
        const baseY = cursorY + 4.2;

        if (colIndex > 0) {
          doc.setDrawColor(...theme.tone.border);
          doc.setLineWidth(0.2);
          doc.line(x, cursorY, x, cursorY + row.rowHeight);
        }

        doc.setFont("helvetica", "bold");
        doc.setFontSize(theme.typography.caption);
        doc.setTextColor(...theme.tone.textMuted);
        doc.text(data.labelLines, baseX, baseY);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(theme.typography.body);
        doc.setTextColor(...theme.tone.textPrimary);
        const valueStart =
          baseY +
          data.labelLines.length * LABEL_LINE_HEIGHT +
          LABEL_TO_VALUE_GAP;
        doc.text(data.valueLines, baseX, valueStart);
      });

      cursorY += row.rowHeight;
      if (rowIndex + 1 < chunk.length) {
        doc.setDrawColor(...theme.tone.border);
        doc.setLineWidth(0.2);
        doc.line(margin, cursorY, margin + contentWidth, cursorY);
      }
    });

    moveY(ctx, totalHeight + theme.spacing.sectionGap);
  };

  let cursor = 0;
  let isContinuation = false;
  while (cursor < rowGroups.length) {
    ensureSpace(ctx, 24);
    let availableHeight = getRemainingHeight(ctx);
    const nextRow = rowGroups[cursor];
    const freshPageAvailableHeight =
      ctx.pageHeight - PDF_SAFE_BOTTOM - Math.max(PDF_SAFE_TOP, ctx.margin);

    if (
      nextRow &&
      12 + nextRow.rowHeight > availableHeight &&
      12 + nextRow.rowHeight <= freshPageAvailableHeight &&
      ctx.y > Math.max(PDF_SAFE_TOP, ctx.margin)
    ) {
      startNewPage(ctx);
      availableHeight = getRemainingHeight(ctx);
    }

    const chunk: RowGroup[] = [];
    let consumedHeight = 12;

    while (cursor < rowGroups.length) {
      const next = rowGroups[cursor];
      if (!next) break;
      if (chunk.length > 0 && consumedHeight + next.rowHeight > availableHeight) {
        break;
      }
      chunk.push(next);
      consumedHeight += next.rowHeight;
      cursor += 1;
    }

    if (chunk.length === 0) {
      chunk.push(rowGroups[cursor]!);
      cursor += 1;
    }

    renderChunk(
      chunk,
      isContinuation ? `${options.title} (continuação)` : options.title,
    );
    isContinuation = true;
  }
}
