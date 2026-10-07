import type { AutoTableFn, PdfContext } from "../core/types";
import { decorateCurrentPage, ensureSpace } from "../core/grid";
import type { CellHookData } from "jspdf-autotable";

export type SemanticTableTone = "default" | "risk" | "action" | "attendance";
export type SemanticProfile = "default" | "apr" | "pt" | "nc" | "audit" | "checklist";

type SemanticRiskThresholds = {
  moderate: number;
  high: number;
  critical: number;
};

type SemanticDateThresholds = {
  warningDays: number;
  infoDays: number;
};

type SemanticKeywords = {
  danger: string[];
  warning: string[];
  success: string[];
};

export type SemanticRulesConfig = {
  columns?: number[];
  now?: Date;
  profile?: SemanticProfile;
  riskThresholds?: Partial<SemanticRiskThresholds>;
  dateThresholds?: Partial<SemanticDateThresholds>;
  keywordOverrides?: Partial<SemanticKeywords>;
};

type SemanticTableOptions = {
  title: string;
  head: string[][];
  body: Array<Array<string | number>>;
  autoTable: AutoTableFn;
  tone?: SemanticTableTone;
  semanticRules?: boolean | SemanticRulesConfig;
  repeatTitleOnPageBreak?: boolean;
  overrides?: Record<string, unknown>;
};

const APR_NORMATIVE_COLORS = {
  acceptable: {
    fill: [46, 125, 50] as [number, number, number], // #2E7D32
    text: [255, 255, 255] as [number, number, number],
  },
  attention: {
    fill: [249, 168, 37] as [number, number, number], // #F9A825
    text: [17, 24, 39] as [number, number, number],
  },
  substantial: {
    fill: [239, 108, 0] as [number, number, number], // #EF6C00
    text: [17, 24, 39] as [number, number, number],
  },
  critical: {
    fill: [198, 40, 40] as [number, number, number], // #C62828
    text: [255, 255, 255] as [number, number, number],
  },
};

function paletteForTone(ctx: PdfContext, tone: SemanticTableTone) {
  if (tone === "risk") {
    return { header: ctx.theme.tone.brandStrong, accent: ctx.theme.tone.warning };
  }
  if (tone === "action") {
    return { header: ctx.theme.tone.info, accent: ctx.theme.tone.success };
  }
  if (tone === "attendance") {
    return { header: ctx.theme.tone.brand, accent: ctx.theme.tone.info };
  }
  return { header: ctx.theme.tone.brand, accent: ctx.theme.tone.brandStrong };
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

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
          if (
            !segment ||
            /^\s+$/.test(segment) ||
            segment.length <= maxTokenLength
          ) {
            return segment;
          }
          return splitIntoChunks(segment).join(" ");
        })
        .join(""),
    )
    .join("\n");
}

function shouldApplySemantic(header: string, columnIndex: number, rules?: boolean | SemanticRulesConfig) {
  if (rules === false) return false;
  if (typeof rules === "object" && Array.isArray(rules.columns)) {
    return rules.columns.includes(columnIndex);
  }
  const h = normalize(header);
  return (
    h.includes("status") ||
    h.includes("nivel") ||
    h.includes("classific") ||
    h.includes("prazo") ||
    h.includes("vencimento") ||
    h.includes("resposta") ||
    h.includes("risco") ||
    h.includes("criticidade")
  );
}

function parseDateValue(value: string): Date | null {
  const normalized = value.trim();
  if (!normalized) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/;

  const isoMatch = normalized.match(iso);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const brMatch = normalized.match(br);
  if (brMatch) {
    const [, d, m, y] = brMatch;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function normalizeDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(from: Date, to: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((to.getTime() - from.getTime()) / msPerDay);
}

function profileDefaults(profile: SemanticProfile) {
  const base: { risk: SemanticRiskThresholds; dates: SemanticDateThresholds; keywords: SemanticKeywords } = {
    risk: { moderate: 5, high: 10, critical: 17 },
    dates: { warningDays: 3, infoDays: 7 },
    keywords: {
      danger: [
        "critico",
        "critical",
        "alto risco",
        "risco alto",
        "nao conforme",
        "bloqueado",
        "atrasado",
        "expirado",
        "interditado",
        "interdicao",
        "vencido",
        "reprov",
      ],
      warning: [
        "alto",
        "moderad",
        "medio",
        "em validacao",
        "parcial",
        "parcialmente",
        "vence hoje",
        "vence em",
        "pendente",
        "em andamento",
        "aguardando",
      ],
      success: ["conforme", "aprovad", "encerrad", "baixo", "risco baixo", "regularizado", "ok", "sim", "valido", "concluid"],
    },
  };

  if (profile === "apr") {
    return {
      ...base,
      keywords: {
        ...base.keywords,
        warning: [...base.keywords.warning, "atencao", "substancial"],
        danger: [...base.keywords.danger, "intoleravel"],
      },
    };
  }
  if (profile === "pt") {
    return {
      ...base,
      dates: { warningDays: 1, infoDays: 3 },
      keywords: {
        ...base.keywords,
        danger: [...base.keywords.danger, "cancelada", "cancelado", "negada"],
        warning: [...base.keywords.warning, "condicionada", "condicionado"],
        success: [...base.keywords.success, "liberada", "liberado"],
      },
    };
  }
  if (profile === "nc") {
    return {
      ...base,
      dates: { warningDays: 5, infoDays: 10 },
      keywords: {
        ...base.keywords,
        warning: [...base.keywords.warning, "parcialmente conforme"],
        success: [...base.keywords.success, "efetiva", "efetivo"],
      },
    };
  }
  if (profile === "audit") {
    return {
      ...base,
      dates: { warningDays: 7, infoDays: 14 },
      keywords: {
        ...base.keywords,
        danger: [...base.keywords.danger, "nao atendido"],
        warning: [...base.keywords.warning, "oportunidade de melhoria"],
        success: [...base.keywords.success, "atendido"],
      },
    };
  }
  if (profile === "checklist") {
    return {
      ...base,
      risk: { moderate: 4, high: 8, critical: 15 },
      keywords: {
        ...base.keywords,
        danger: [...base.keywords.danger, "nao"],
        success: [...base.keywords.success, "satisfatorio"],
      },
    };
  }
  return base;
}

function resolveSemanticConfig(rules?: boolean | SemanticRulesConfig) {
  if (rules === false) return null;
  const profile = typeof rules === "object" && rules.profile ? rules.profile : "default";
  const base = profileDefaults(profile);
  return {
    profile,
    now: typeof rules === "object" && rules.now ? rules.now : new Date(),
    thresholds: {
      moderate: typeof rules === "object" && rules.riskThresholds?.moderate ? rules.riskThresholds.moderate : base.risk.moderate,
      high: typeof rules === "object" && rules.riskThresholds?.high ? rules.riskThresholds.high : base.risk.high,
      critical: typeof rules === "object" && rules.riskThresholds?.critical ? rules.riskThresholds.critical : base.risk.critical,
    },
    dates: {
      warningDays: typeof rules === "object" && rules.dateThresholds?.warningDays ? rules.dateThresholds.warningDays : base.dates.warningDays,
      infoDays: typeof rules === "object" && rules.dateThresholds?.infoDays ? rules.dateThresholds.infoDays : base.dates.infoDays,
    },
    keywords: {
      danger: [...base.keywords.danger, ...((typeof rules === "object" && rules.keywordOverrides?.danger) || [])],
      warning: [...base.keywords.warning, ...((typeof rules === "object" && rules.keywordOverrides?.warning) || [])],
      success: [...base.keywords.success, ...((typeof rules === "object" && rules.keywordOverrides?.success) || [])],
    },
  };
}

function semanticCellStyle(
  ctx: PdfContext,
  value: string,
  headerValue: string,
  rules?: boolean | SemanticRulesConfig,
) {
  const config = resolveSemanticConfig(rules);
  if (!config) return null;

  const v = normalize(value);
  const header = normalize(headerValue);

  const aprBadgeStyle = (
    kind: "acceptable" | "attention" | "substantial" | "critical",
  ) => ({
    textColor: APR_NORMATIVE_COLORS[kind].text,
    fillColor: APR_NORMATIVE_COLORS[kind].fill,
    fontStyle: "bold" as const,
  });

  if (config.profile === "apr") {
    if (
      v.includes("critico") ||
      v.includes("crítico") ||
      v.includes("intoleravel") ||
      v.includes("intolerável")
    ) {
      return aprBadgeStyle("critical");
    }
    if (v.includes("substancial") || v.includes("substantial")) {
      return aprBadgeStyle("substantial");
    }
    if (v.includes("atencao") || v.includes("atenção")) {
      return aprBadgeStyle("attention");
    }
    if (v.includes("aceitavel") || v.includes("aceitável")) {
      return aprBadgeStyle("acceptable");
    }
  }

  if (header.includes("prazo") || header.includes("vencimento")) {
    const parsed = parseDateValue(value);
    if (parsed) {
      const today = normalizeDate(config.now);
      const due = normalizeDate(parsed);
      const delta = daysBetween(today, due);
      if (delta < 0) {
        return { textColor: ctx.theme.tone.danger, fillColor: [254, 242, 242] as [number, number, number], fontStyle: "bold" as const };
      }
      if (delta === 0 || delta <= config.dates.warningDays) {
        return { textColor: ctx.theme.tone.warning, fillColor: [255, 247, 237] as [number, number, number], fontStyle: "bold" as const };
      }
      if (delta <= config.dates.infoDays) {
        return { textColor: ctx.theme.tone.info, fillColor: [239, 246, 255] as [number, number, number], fontStyle: "bold" as const };
      }
      return { textColor: ctx.theme.tone.success, fillColor: [240, 253, 244] as [number, number, number], fontStyle: "bold" as const };
    }
  }

  if (config.keywords.danger.some((token) => v.includes(normalize(token)))) {
    return { textColor: ctx.theme.tone.danger, fillColor: [254, 242, 242] as [number, number, number], fontStyle: "bold" as const };
  }
  if (config.keywords.warning.some((token) => v.includes(normalize(token)))) {
    return { textColor: ctx.theme.tone.warning, fillColor: [255, 247, 237] as [number, number, number], fontStyle: "bold" as const };
  }
  if (config.keywords.success.some((token) => v.includes(normalize(token)))) {
    return { textColor: ctx.theme.tone.success, fillColor: [240, 253, 244] as [number, number, number], fontStyle: "bold" as const };
  }

  if (v === "n/a" || v === "na" || v === "-") {
    return { textColor: ctx.theme.tone.textMuted, fillColor: [248, 250, 252] as [number, number, number], fontStyle: "normal" as const };
  }

  if (header.includes("risco") && /^\d+$/.test(v)) {
    const score = Number(v);
    if (config.profile === "apr") {
      if (score >= config.thresholds.critical) return aprBadgeStyle("critical");
      if (score >= config.thresholds.high) return aprBadgeStyle("substantial");
      if (score >= config.thresholds.moderate) return aprBadgeStyle("attention");
      return aprBadgeStyle("acceptable");
    }
    if (score >= config.thresholds.critical) {
      return { textColor: ctx.theme.tone.danger, fillColor: [254, 242, 242] as [number, number, number], fontStyle: "bold" as const };
    }
    if (score >= config.thresholds.high) {
      return { textColor: ctx.theme.tone.warning, fillColor: [255, 247, 237] as [number, number, number], fontStyle: "bold" as const };
    }
    if (score >= config.thresholds.moderate) {
      return { textColor: ctx.theme.tone.info, fillColor: [239, 246, 255] as [number, number, number], fontStyle: "bold" as const };
    }
    return { textColor: ctx.theme.tone.success, fillColor: [240, 253, 244] as [number, number, number], fontStyle: "bold" as const };
  }

  return null;
}

export function drawSemanticTable(ctx: PdfContext, options: SemanticTableOptions): number {
  const { doc, margin, contentWidth, theme } = ctx;
  const tone = paletteForTone(ctx, options.tone || "default");
  const drawTitleBar = (title: string, y: number) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(theme.typography.headingSm);
    doc.setTextColor(...theme.tone.textPrimary);
    doc.text(title, margin, y + 5.8);

    doc.setDrawColor(...tone.accent);
    doc.setLineWidth(0.45);
    doc.line(margin, y + 8.4, margin + 30, y + 8.4);
    doc.setDrawColor(...theme.tone.border);
    doc.setLineWidth(0.18);
    doc.line(margin + 32, y + 8.4, margin + contentWidth, y + 8.4);
  };
  const normalizedHead = options.head.map((row) =>
    row.map((cell) => softWrapLongTokens(String(cell))),
  );
  const normalizedBody = options.body.map((row) =>
    row.map((cell) =>
      typeof cell === "string" ? softWrapLongTokens(cell) : cell,
    ),
  );
  // Keep the section title together with the table header and at least one body row.
  ensureSpace(ctx, 34);

  drawTitleBar(options.title, ctx.y);

  options.autoTable(doc, {
    startY: ctx.y + 10.5,
    margin: {
      left: margin,
      right: margin,
      top: (ctx.pageTop ?? margin) + 10.5,
    },
    head: normalizedHead,
    body: normalizedBody,
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 8.2,
      textColor: theme.tone.textPrimary,
      lineColor: theme.tone.border,
      lineWidth: 0.16,
      cellPadding: 2.25,
      overflow: "linebreak",
      valign: "top",
    },
    headStyles: {
      fillColor: theme.tone.brandStrong,
      textColor: theme.tone.brandOn,
      fontStyle: "bold",
      fontSize: 7.5,
      cellPadding: 2.15,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    willDrawPage: (data: { pageNumber?: number }) => {
      if ((data.pageNumber || 1) <= 1) return;
      decorateCurrentPage(ctx);
      if (options.repeatTitleOnPageBreak !== false) {
        drawTitleBar(`${options.title} (continuação)`, ctx.pageTop ?? margin);
      }
    },
    didParseCell: (data: CellHookData) => {
      if (data.section !== "body") return;
      const headerValue = String(options.head?.[0]?.[data.column.index] || "");
      if (!shouldApplySemantic(headerValue, data.column.index, options.semanticRules)) return;
      const raw = String(data.cell.raw || "");
      const style = semanticCellStyle(ctx, raw, headerValue, options.semanticRules);
      if (!style) return;
      data.cell.styles.textColor = style.textColor;
      data.cell.styles.fillColor = style.fillColor;
      data.cell.styles.fontStyle = style.fontStyle;
    },
    ...options.overrides,
  });

  const withTable = doc as typeof doc & { lastAutoTable?: { finalY?: number } };
  ctx.y = (withTable.lastAutoTable?.finalY || ctx.y + 20) + theme.spacing.sectionGap;
  return ctx.y;
}
