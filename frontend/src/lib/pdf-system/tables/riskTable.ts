import type { AutoTableFn, PdfContext } from "../core/types";
import type { CellHookData, HookData } from "jspdf-autotable";
import type { SemanticRulesConfig } from "../components/SemanticTable";
import { sanitize } from "../core/format";

export type RiskRow = {
  activity?: string;
  agent?: string;
  condition?: string;
  hazard?: string;
  source?: string;
  injuries?: string;
  probability?: string | number;
  severity?: string | number;
  score?: string | number;
  level?: string;
  control?: string;
  owner?: string;
  dueAndStatus?: string;
};

export function drawRiskTable(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  rows: RiskRow[],
  options?: {
    semanticRules?: boolean | SemanticRulesConfig;
    layout?: "matrix" | "cards";
  },
) {
  if (!rows.length) return;
  if (options?.layout === "cards") {
    drawAprRiskCards(ctx, autoTable, rows);
    return;
  }
  const { doc, margin, theme } = ctx;
  const tableWidth = ctx.contentWidth - 4;
  const weight = [15, 12, 14, 14, 14, 5, 5, 8, 23];
  const weightSum = weight.reduce((sum, value) => sum + value, 0);
  const toCellWidth = (index: number) =>
    Number(((tableWidth * weight[index]!) / weightSum).toFixed(2));
  const teal: [number, number, number] = [0, 128, 128];
  const paleYellow: [number, number, number] = [255, 230, 153];
  const headerGray: [number, number, number] = [217, 217, 217];
  const acceptable: [number, number, number] = [0, 176, 80];
  const attention: [number, number, number] = [0, 112, 192];
  const substantial: [number, number, number] = [255, 192, 0];
  const critical: [number, number, number] = [255, 0, 0];
  const white: [number, number, number] = [255, 255, 255];
  const dark: [number, number, number] = [0, 0, 0];
  const softBlue: [number, number, number] = [244, 249, 255];
  const softGreen: [number, number, number] = [238, 247, 238];
  const softYellow: [number, number, number] = [255, 248, 220];

  doc.setDrawColor(120, 120, 120);
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(margin, ctx.y, tableWidth + 4, 9.5, 1.6, 1.6, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...dark);
  doc.text("APR - Reconhecimento, avaliação de riscos e medidas de prevenção", margin + 4, ctx.y + 6.2);

  autoTable(doc, {
    startY: ctx.y + 10.8,
    margin: {
      left: margin,
      right: margin,
      top: ctx.pageTop ?? margin,
    },
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 7,
      cellPadding: 1.8,
      lineColor: [0, 0, 0],
      lineWidth: 0.12,
      textColor: [26, 26, 26],
      valign: "middle",
      overflow: "linebreak",
    },
    head: [
      [
        {
          content: "Atividades /\nProcessos",
          rowSpan: 2,
          styles: {
            fillColor: paleYellow,
            halign: "center",
            valign: "middle",
            fontStyle: "bold",
          },
        },
        {
          content: "Reconhecimento de Riscos",
          colSpan: 4,
          styles: {
            fillColor: teal,
            textColor: [255, 255, 255],
            halign: "center",
            fontStyle: "bold",
          },
        },
        {
          content: "Avaliação de Riscos",
          colSpan: 3,
          styles: {
            fillColor: paleYellow,
            halign: "center",
            fontStyle: "bold",
          },
        },
        {
          content: "Medidas de Prevenção",
          rowSpan: 2,
          styles: {
            fillColor: teal,
            textColor: [255, 255, 255],
            halign: "center",
            valign: "middle",
            fontStyle: "bold",
          },
        },
      ],
      [
        { content: "Agente\nAmbiental", styles: { fillColor: headerGray, halign: "center", fontStyle: "bold" } },
        { content: "Condição perigosa", styles: { fillColor: headerGray, halign: "center", fontStyle: "bold" } },
        { content: "Fontes ou\ncircunstâncias", styles: { fillColor: headerGray, halign: "center", fontStyle: "bold" } },
        { content: "Possíveis lesões ou\nagravos à saúde", styles: { fillColor: headerGray, halign: "center", fontStyle: "bold" } },
        { content: "Probabilidade", styles: { fillColor: headerGray, halign: "center", fontStyle: "bold" } },
        { content: "Severidade", styles: { fillColor: headerGray, halign: "center", fontStyle: "bold" } },
        { content: "Categoria\nde Risco", styles: { fillColor: headerGray, halign: "center", fontStyle: "bold" } },
      ],
    ],
    body: rows.map((r) => [
      sanitize(r.activity),
      sanitize(r.agent || r.hazard),
      sanitize(r.condition),
      sanitize(r.source),
      sanitize(r.injuries),
      sanitize(r.probability),
      sanitize(r.severity),
      sanitize(r.level),
      sanitize(
        [
          r.control,
          r.owner ? `Responsável: ${r.owner}` : "",
          r.dueAndStatus ? `Prazo/Status: ${r.dueAndStatus}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ]),
    columnStyles: {
      0: { cellWidth: toCellWidth(0), halign: "center", fontStyle: "bold" },
      1: { cellWidth: toCellWidth(1) },
      2: { cellWidth: toCellWidth(2) },
      3: { cellWidth: toCellWidth(3) },
      4: { cellWidth: toCellWidth(4) },
      5: { cellWidth: toCellWidth(5), halign: "center" },
      6: { cellWidth: toCellWidth(6), halign: "center" },
      7: { cellWidth: toCellWidth(7), halign: "center", fontStyle: "bold" },
      8: { cellWidth: toCellWidth(8) },
    },
    alternateRowStyles: {
      fillColor: softBlue,
    },
    didParseCell: (hookData: CellHookData) => {
      if (hookData.section !== "body") return;
      if (hookData.column.index === 0) {
        hookData.cell.styles.fillColor = [249, 247, 240];
      }
      if (hookData.column.index === 8) {
        hookData.cell.styles.fillColor = softGreen;
      }
      if (hookData.column.index === 5 || hookData.column.index === 6) {
        hookData.cell.styles.fontStyle = "bold";
        hookData.cell.styles.fillColor = softYellow;
      }
      if (hookData.column.index === 7) {
        const value = String(hookData.cell.raw || "").toLowerCase();
        if (value.includes("aceit")) {
          hookData.cell.styles.fillColor = acceptable;
          hookData.cell.styles.textColor = white;
        } else if (value.includes("aten")) {
          hookData.cell.styles.fillColor = attention;
          hookData.cell.styles.textColor = white;
        } else if (value.includes("subst")) {
          hookData.cell.styles.fillColor = substantial;
          hookData.cell.styles.textColor = dark;
        } else if (value.includes("crit")) {
          hookData.cell.styles.fillColor = critical;
          hookData.cell.styles.textColor = dark;
        }
      }
      if (hookData.column.index === 5 || hookData.column.index === 6) {
        const value = Number(String(hookData.cell.raw || "").replace(",", "."));
        if (Number.isFinite(value)) {
          if (value <= 1) hookData.cell.styles.textColor = acceptable;
          if (value === 2) hookData.cell.styles.textColor = attention;
          if (value >= 3) hookData.cell.styles.textColor = critical;
        }
      }
      if (hookData.column.index === 1) {
        const value = String(hookData.cell.raw || "").toLowerCase();
        if (value.includes("fís")) hookData.cell.styles.textColor = [0, 166, 81];
        if (value.includes("quím")) hookData.cell.styles.textColor = [220, 20, 60];
        if (value.includes("biológ")) hookData.cell.styles.textColor = [102, 51, 0];
        if (value.includes("acidente")) hookData.cell.styles.textColor = attention;
      }
    },
    didDrawPage: (hookData: HookData) => {
      ctx.y = hookData.cursor?.y ? hookData.cursor.y + 4 : ctx.y + 4;
    },
  });
}

function drawAprRiskCards(ctx: PdfContext, autoTable: AutoTableFn, rows: RiskRow[]) {
  const { doc, margin, contentWidth, theme } = ctx;
  const navy: [number, number, number] = [16, 32, 51];
  const blue: [number, number, number] = [31, 78, 121];
  const surface: [number, number, number] = [248, 250, 252];
  const border: [number, number, number] = [203, 213, 225];
  const muted: [number, number, number] = [100, 116, 139];
  const white: [number, number, number] = [255, 255, 255];

  ensureCardSpace(ctx, 31);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...navy);
  doc.text("Riscos, controles e risco residual", margin, ctx.y);
  ctx.y += 5;

  rows.forEach((row, index) => {
    ensureCardSpace(ctx, 30);
    const score = row.score ? String(row.score) : "-";
    const level = sanitize(row.level || "Não classificado");
    const title = sanitize(row.activity || row.condition || `Risco ${index + 1}`);
    const levelTone = resolveLevelTone(level);

    doc.setFillColor(...blue);
    doc.roundedRect(margin, ctx.y, contentWidth, 8, 1.5, 1.5, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...white);
    doc.text(`RISCO ${String(index + 1).padStart(2, "0")}  ${title}`, margin + 3, ctx.y + 5.3);
    doc.setFillColor(...levelTone.fill);
    doc.roundedRect(margin + contentWidth - 33, ctx.y + 1.4, 30, 5.2, 1, 1, "F");
    doc.setFontSize(7.2);
    doc.setTextColor(...levelTone.text);
    doc.text(level.toUpperCase(), margin + contentWidth - 18, ctx.y + 4.9, { align: "center" });
    ctx.y += 8;

    autoTable(doc, {
      startY: ctx.y,
      margin: { left: margin, right: margin, top: ctx.pageTop ?? margin },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 8.2,
        cellPadding: 2,
        lineColor: border,
        lineWidth: 0.12,
        textColor: navy,
        overflow: "linebreak",
        valign: "top",
      },
      body: [
        ["Perigo / condição", sanitize(row.hazard || row.condition || "Não informado")],
        ["Consequência", sanitize(row.injuries || "Não informada")],
        ["Avaliação", `Probabilidade: ${sanitize(row.probability || "-")}  |  Severidade: ${sanitize(row.severity || "-")}  |  Score: ${score}`],
        ["Medidas de prevenção", sanitize(row.control || "Não informadas")],
        ["Responsável / prazo", sanitize([row.owner, row.dueAndStatus].filter(Boolean).join(" | ") || "Não informado")],
      ],
      columnStyles: {
        0: { cellWidth: 40, fillColor: surface, textColor: muted, fontStyle: "bold" },
        1: { cellWidth: contentWidth - 40 },
      },
      didDrawPage: (hookData: HookData) => {
        ctx.y = hookData.cursor?.y ? hookData.cursor.y + 5 : ctx.y + 5;
      },
    });
  });
}

function ensureCardSpace(ctx: PdfContext, requiredHeight: number) {
  const bottom = ctx.pageHeight - ctx.margin;
  if (ctx.y + requiredHeight <= bottom) return;
  ctx.doc.addPage();
  ctx.y = ctx.pageTop ?? ctx.margin;
}

function resolveLevelTone(level: string): {
  fill: [number, number, number];
  text: [number, number, number];
} {
  const normalized = level.toLowerCase();
  if (normalized.includes("crit")) return { fill: [254, 226, 226], text: [153, 27, 27] };
  if (normalized.includes("subst") || normalized.includes("alto")) return { fill: [255, 237, 213], text: [154, 52, 18] };
  if (normalized.includes("aten") || normalized.includes("médio") || normalized.includes("medio")) return { fill: [254, 249, 195], text: [133, 77, 14] };
  return { fill: [220, 252, 231], text: [22, 101, 52] };
}
