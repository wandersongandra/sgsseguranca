import type { PdfContext } from "../core/types";
import { ensureSpace, moveY } from "../core/grid";
import { sanitize } from "../core/format";
import { drawStatusBadge } from "./StatusBadge";
import type { RiskLevel } from "../tokens/pdfSemantics";

type RiskSummaryPanelOptions = {
  severity?: string | number;
  probability?: string | number;
  riskLevel?: RiskLevel;
  status?: string;
  priorityAction?: string;
};

export function drawRiskSummaryPanel(
  ctx: PdfContext,
  options: RiskSummaryPanelOptions,
) {
  const { doc, margin, contentWidth, theme } = ctx;
  const colW = contentWidth / 2;
  const severityLines = doc.splitTextToSize(
    sanitize(options.severity),
    colW - 9,
  ) as string[];
  const probabilityLines = doc.splitTextToSize(
    sanitize(options.probability),
    colW - 9,
  ) as string[];
  const statusLines = doc.splitTextToSize(
    sanitize(options.status),
    colW - 9,
  ) as string[];
  const actionLines = doc.splitTextToSize(
    sanitize(options.priorityAction),
    colW - 9,
  ) as string[];

  const row1Height =
    9 + Math.max(severityLines.length, probabilityLines.length) * 4;
  const row2Height = 9 + Math.max(statusLines.length, actionLines.length) * 4;
  const headingH = 11;
  const panelHeight = headingH + row1Height + row2Height;

  ensureSpace(ctx, panelHeight + 4);

  doc.setFillColor(...theme.tone.surface);
  doc.setDrawColor(...theme.tone.borderStrong);
  doc.setLineWidth(0.24);
  doc.rect(margin, ctx.y, contentWidth, panelHeight, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...theme.tone.textPrimary);
  doc.text("Resumo de risco", margin + 4, ctx.y + 6);

  doc.setDrawColor(...theme.tone.warning);
  doc.setLineWidth(0.45);
  doc.line(margin + 4, ctx.y + 8.6, margin + 29, ctx.y + 8.6);
  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.16);
  doc.line(margin + 31, ctx.y + 8.6, margin + contentWidth - 4, ctx.y + 8.6);

  if (options.riskLevel) {
    drawStatusBadge(
      ctx,
      { kind: "risk", value: options.riskLevel },
      margin + contentWidth - 37,
      ctx.y + 2,
      33,
      6.5,
    );
  }

  const drawCell = (
    x: number,
    y: number,
    height: number,
    label: string,
    lines: string[],
    isRight = false,
  ) => {
    if (isRight) {
      doc.setDrawColor(...theme.tone.border);
      doc.setLineWidth(0.16);
      doc.line(x, y + 2, x, y + height - 2);
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.caption);
    doc.setTextColor(...theme.tone.textMuted);
    doc.text(label.toUpperCase(), x + 4, y + 5);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(theme.typography.body);
    doc.setTextColor(...theme.tone.textPrimary);
    doc.text(lines, x + 4, y + 9.5);
  };

  const row1Y = ctx.y + headingH;
  drawCell(margin, row1Y, row1Height, "Severidade", severityLines);
  drawCell(
    margin + colW,
    row1Y,
    row1Height,
    "Probabilidade",
    probabilityLines,
    true,
  );

  doc.setDrawColor(...theme.tone.border);
  doc.setLineWidth(0.16);
  doc.line(
    margin,
    row1Y + row1Height,
    margin + contentWidth,
    row1Y + row1Height,
  );

  const row2Y = row1Y + row1Height;
  drawCell(margin, row2Y, row2Height, "Status", statusLines);
  drawCell(
    margin + colW,
    row2Y,
    row2Height,
    "Medida prioritária",
    actionLines,
    true,
  );

  moveY(ctx, panelHeight + theme.spacing.blockGap);
}
