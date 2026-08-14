import type { Apr } from "@/services/aprsService";
import type { Signature } from "@/services/signaturesService";
import type { CellHookData, HookData } from "jspdf-autotable";
import type { AutoTableFn, PdfContext } from "../core/types";
import { formatDate, sanitize } from "../core/format";
import { ensureSpace, moveY } from "../core/grid";
import { drawEvidenceGallery, drawGovernanceClosingBlock } from "../components";
import { drawRiskTable } from "../tables";
import {
  resolveSignatureSignerName,
  resolveSignatureSignerRole,
  resolveSignatureTypeLabel,
} from "../signaturePresentation";

type AprPdfEvidence = {
  id: string;
  apr_risk_item_id: string;
  original_name?: string;
  uploaded_at: string;
  captured_at?: string;
  url?: string;
  watermarked_url?: string;
  risk_item_ordem?: number;
};

type AprRiskRowSource = {
  atividade?: string;
  atividade_processo?: string;
  agente_ambiental?: string;
  condicao_perigosa?: string;
  fonte_circunstancia?: string;
  fontes_circunstancias?: string;
  lesao?: string;
  possiveis_lesoes?: string;
  medidas_prevencao?: string;
  responsavel?: string;
  prazo?: string;
  status_acao?: string;
  probabilidade?: string | number;
  severidade?: string | number;
  score_risco?: string | number;
  categoria_risco?: string;
  prioridade?: string;
};

type AprStructuredRiskRow = {
  atividade?: string | null;
  etapa?: string | null;
  agente_ambiental?: string | null;
  condicao_perigosa?: string | null;
  fonte_circunstancia?: string | null;
  lesao?: string | null;
  probabilidade?: string | number;
  severidade?: string | number;
  score_risco?: string | number;
  categoria_risco?: string | null;
  prioridade?: string | null;
  medidas_prevencao?: string | null;
  epc?: string | null;
  epi?: string | null;
  permissao_trabalho?: string | null;
  normas_relacionadas?: string | null;
  hierarquia_controle?: string | null;
  responsavel?: string | null;
  prazo?: string | null;
  status_acao?: string | null;
};

type AprParticipantLike = { id?: string; nome?: string; funcao?: string | null };

const APR_TEAL: [number, number, number] = [31, 78, 121];
const APR_TEAL_SOFT: [number, number, number] = [248, 250, 252];
const APR_HEADER_GRAY: [number, number, number] = [226, 232, 240];
const APR_ACCEPTABLE: [number, number, number] = [22, 101, 52];
const APR_ATTENTION: [number, number, number] = [31, 95, 149];
const APR_SUBSTANTIAL: [number, number, number] = [180, 83, 9];
const APR_CRITICAL: [number, number, number] = [185, 28, 28];
const APR_DARK: [number, number, number] = [15, 23, 42];
const APR_WHITE: [number, number, number] = [255, 255, 255];

function normalizeRiskLabel(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function optionalText(value?: string | null) {
  return value || undefined;
}

function drawAprOperationalHeader(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  apr: Apr,
) {
  const { doc, margin, contentWidth } = ctx;
  const titleHeight = 18;
  const tableWidth = contentWidth - 4;
  const title = "APR - ANÁLISE PRELIMINAR DE RISCO";
  const responsible =
    apr.aprovado_por?.nome || apr.elaborador?.nome || apr.elaborador_id || "-";
  const activityDescription = [
    apr.titulo,
    apr.descricao ? `- ${apr.descricao}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const responsavelTecnico =
    [
      apr.responsavel_tecnico_nome,
      apr.responsavel_tecnico_registro
        ? `(${apr.responsavel_tecnico_registro})`
        : "",
    ]
      .filter(Boolean)
      .join(" ") || responsible;

  ensureSpace(ctx, 34);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.18);
  doc.rect(margin, ctx.y, tableWidth + 4, titleHeight);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(20, 20, 20);
  doc.text(title, margin + (tableWidth + 4) / 2, ctx.y + 11.2, {
    align: "center",
  });

  const rows: string[][] = [
    [
      "Nº / Título:",
      sanitize(
        [apr.numero, apr.titulo].filter(Boolean).join(" — ") ||
          activityDescription,
      ),
      "Empresa:",
      sanitize(apr.company?.razao_social || apr.company_id),
    ],
    [
      "Descrição:",
      sanitize(apr.descricao || "-"),
      "CNPJ:",
      sanitize(apr.company?.cnpj),
    ],
    [
      "Data elaboração:",
      formatDate(apr.created_at || apr.data_inicio),
      "Responsável técnico:",
      sanitize(responsavelTecnico),
    ],
    [
      "Versão / revisão:",
      `${formatDate(apr.updated_at || apr.data_inicio)} / v${apr.versao ?? 1}`,
      "Elaborador:",
      sanitize(apr.elaborador?.nome || apr.elaborador_id || "-"),
    ],
    [
      "Site / obra:",
      sanitize(apr.site?.nome || apr.site_id),
      "Validade:",
      `${formatDate(apr.data_inicio)} a ${formatDate(apr.data_fim)}`,
    ],
  ];

  // Campos operacionais extras — só inclui linhas com valor
  const extraPairs: [string, string][] = [
    ["Tipo de atividade:", sanitize(apr.tipo_atividade)],
    ["Frente de trabalho:", sanitize(apr.frente_trabalho)],
    ["Área de risco:", sanitize(apr.area_risco)],
    ["Turno:", sanitize(apr.turno)],
    ["Local detalhado:", sanitize(apr.local_execucao_detalhado)],
  ].filter(([, v]) => Boolean(v)) as [string, string][];

  // Empacota aos pares em linhas de 4 colunas
  for (let i = 0; i < extraPairs.length; i += 2) {
    const left = extraPairs[i]!;
    const right = extraPairs[i + 1] ?? ["", ""];
    rows.push([left[0], left[1], right[0], right[1]]);
  }

  autoTable(doc, {
    startY: ctx.y + titleHeight,
    margin: {
      left: margin,
      right: margin,
      top: ctx.pageTop ?? margin,
    },
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 8,
      cellPadding: 1.8,
      lineColor: [0, 0, 0],
      lineWidth: 0.12,
      textColor: [20, 20, 20],
      overflow: "linebreak",
      valign: "middle",
    },
    body: rows,
    columnStyles: {
      0: {
        cellWidth: 40,
        fillColor: APR_TEAL,
        textColor: APR_WHITE,
        fontStyle: "bold",
      },
      1: { cellWidth: 111 },
      2: {
        cellWidth: 38,
        fillColor: APR_TEAL,
        textColor: APR_WHITE,
        fontStyle: "bold",
      },
      3: { cellWidth: tableWidth + 4 - 40 - 111 - 38 },
    },
    didDrawPage: (hookData: HookData) => {
      ctx.y = hookData.cursor?.y ? hookData.cursor.y + 5 : ctx.y + 5;
    },
  });
}

function drawSectionBanner(ctx: PdfContext, label: string) {
  const { doc, margin, contentWidth, theme } = ctx;
  ensureSpace(ctx, 14);
  doc.setDrawColor(120, 120, 120);
  doc.setFillColor(...APR_TEAL_SOFT);
  doc.roundedRect(margin, ctx.y, contentWidth, 8.6, 1.6, 1.6, "FD");
  doc.setFillColor(...APR_TEAL);
  doc.rect(margin, ctx.y, 2.3, 8.6, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...APR_DARK);
  doc.text(label, margin + 4, ctx.y + 5.7);
  moveY(ctx, 9.6);
}

function drawAprComplementaryInfo(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  apr: Apr,
) {
  const { doc, margin, contentWidth } = ctx;

  // ── Campos complementares globais ────────────────────────────────────────
  const notes = [
    apr.control_description
      ? `Controles globais: ${apr.control_description}`
      : "",
    apr.residual_risk ? `Risco residual: ${apr.residual_risk}` : "",
    apr.evidence_document
      ? `Evidência documental: ${apr.evidence_document}`
      : "",
    apr.evidence_photo ? `Evidência fotográfica: ${apr.evidence_photo}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  if (notes) {
    drawSectionBanner(ctx, "Informações complementares");
    autoTable(doc, {
      startY: ctx.y,
      margin: { left: margin, right: margin, top: ctx.pageTop ?? margin },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 7.6,
        cellPadding: 1.8,
        lineColor: [0, 0, 0],
        lineWidth: 0.12,
        textColor: [20, 20, 20],
        overflow: "linebreak",
      },
      body: [[sanitize(notes)]],
      columnStyles: { 0: { cellWidth: contentWidth } },
      didDrawPage: (hookData: HookData) => {
        ctx.y = hookData.cursor?.y ? hookData.cursor.y + 4 : ctx.y + 4;
      },
    });
  }

  // ── Participantes ─────────────────────────────────────────────────────────
  const participants = Array.isArray(apr.participants) ? apr.participants : [];
  if (participants.length > 0) {
    drawSectionBanner(ctx, `Participantes (${participants.length})`);
    autoTable(doc, {
      startY: ctx.y,
      margin: { left: margin, right: margin, top: ctx.pageTop ?? margin },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 7.6,
        cellPadding: 1.8,
        lineColor: [0, 0, 0],
        lineWidth: 0.12,
        textColor: [20, 20, 20],
        overflow: "linebreak",
      },
      head: [["#", "Nome do participante", "Função"]],
      body: participants.map((p: AprParticipantLike, i: number) => [
        String(i + 1),
        sanitize(p.nome || "-"),
        sanitize(p.funcao),
      ]),
      headStyles: {
        fillColor: APR_TEAL,
        textColor: APR_WHITE,
        fontStyle: "bold",
        fontSize: 7.6,
      },
      columnStyles: {
        0: { cellWidth: 12 },
        1: { cellWidth: contentWidth - 62 },
        2: { cellWidth: 50 },
      },
      didDrawPage: (hookData: HookData) => {
        ctx.y = hookData.cursor?.y ? hookData.cursor.y + 4 : ctx.y + 4;
      },
    });
  }

  // ── Atividades previstas ──────────────────────────────────────────────────
  const activities = Array.isArray(apr.activities) ? apr.activities : [];
  if (activities.length > 0) {
    drawSectionBanner(ctx, `Atividades previstas (${activities.length})`);
    autoTable(doc, {
      startY: ctx.y,
      margin: { left: margin, right: margin, top: ctx.pageTop ?? margin },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 7.6,
        cellPadding: 1.8,
        lineColor: [0, 0, 0],
        lineWidth: 0.12,
        textColor: [20, 20, 20],
        overflow: "linebreak",
      },
      head: [["#", "Atividade", "Descrição"]],
      body: activities.map(
        (a: { nome?: string; descricao?: string }, i: number) => [
          String(i + 1),
          sanitize(a.nome || "-"),
          sanitize(a.descricao || "-"),
        ],
      ),
      headStyles: {
        fillColor: APR_TEAL,
        textColor: APR_WHITE,
        fontStyle: "bold",
        fontSize: 7.6,
      },
      columnStyles: {
        0: { cellWidth: 12 },
        1: { cellWidth: 70 },
        2: { cellWidth: contentWidth - 82 },
      },
      didDrawPage: (hookData: HookData) => {
        ctx.y = hookData.cursor?.y ? hookData.cursor.y + 4 : ctx.y + 4;
      },
    });
  }

  // ── EPIs ──────────────────────────────────────────────────────────────────
  const epis = Array.isArray(apr.epis) ? apr.epis : [];
  if (epis.length > 0) {
    drawSectionBanner(
      ctx,
      `Equipamentos de Proteção Individual — EPIs (${epis.length})`,
    );
    autoTable(doc, {
      startY: ctx.y,
      margin: { left: margin, right: margin, top: ctx.pageTop ?? margin },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 7.6,
        cellPadding: 1.8,
        lineColor: [0, 0, 0],
        lineWidth: 0.12,
        textColor: [20, 20, 20],
        overflow: "linebreak",
      },
      head: [["#", "EPI", "CA", "Validade CA", "Descrição"]],
      body: epis.map((e, i) => [
        String(i + 1),
        sanitize(e.nome || "-"),
        sanitize(e.ca || "-"),
        sanitize(e.validade_ca ? formatDate(e.validade_ca) : "-"),
        sanitize(e.descricao || "-"),
      ]),
      headStyles: {
        fillColor: APR_TEAL,
        textColor: APR_WHITE,
        fontStyle: "bold",
        fontSize: 7.6,
      },
      columnStyles: {
        0: { cellWidth: 12 },
        1: { cellWidth: 55 },
        2: { cellWidth: 20 },
        3: { cellWidth: 26 },
        4: { cellWidth: contentWidth - 113 },
      },
      didDrawPage: (hookData: HookData) => {
        ctx.y = hookData.cursor?.y ? hookData.cursor.y + 4 : ctx.y + 4;
      },
    });
  }

  // ── Ferramentas ───────────────────────────────────────────────────────────
  const tools = Array.isArray(apr.tools) ? apr.tools : [];
  if (tools.length > 0) {
    drawSectionBanner(ctx, `Ferramentas (${tools.length})`);
    autoTable(doc, {
      startY: ctx.y,
      margin: { left: margin, right: margin, top: ctx.pageTop ?? margin },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 7.6,
        cellPadding: 1.8,
        lineColor: [0, 0, 0],
        lineWidth: 0.12,
        textColor: [20, 20, 20],
        overflow: "linebreak",
      },
      head: [["#", "Ferramenta", "Nº de série", "Descrição"]],
      body: tools.map(
        (
          t: { nome?: string; numero_serie?: string; descricao?: string },
          i: number,
        ) => [
          String(i + 1),
          sanitize(t.nome || "-"),
          sanitize(t.numero_serie || "-"),
          sanitize(t.descricao || "-"),
        ],
      ),
      headStyles: {
        fillColor: APR_TEAL,
        textColor: APR_WHITE,
        fontStyle: "bold",
        fontSize: 7.6,
      },
      columnStyles: {
        0: { cellWidth: 12 },
        1: { cellWidth: 60 },
        2: { cellWidth: 35 },
        3: { cellWidth: contentWidth - 107 },
      },
      didDrawPage: (hookData: HookData) => {
        ctx.y = hookData.cursor?.y ? hookData.cursor.y + 4 : ctx.y + 4;
      },
    });
  }

  // ── Máquinas e equipamentos ───────────────────────────────────────────────
  const machines = Array.isArray(apr.machines) ? apr.machines : [];
  if (machines.length > 0) {
    drawSectionBanner(ctx, `Máquinas e equipamentos (${machines.length})`);
    autoTable(doc, {
      startY: ctx.y,
      margin: { left: margin, right: margin, top: ctx.pageTop ?? margin },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 7.6,
        cellPadding: 1.8,
        lineColor: [0, 0, 0],
        lineWidth: 0.12,
        textColor: [20, 20, 20],
        overflow: "linebreak",
      },
      head: [["#", "Máquina", "Placa / ID", "Requisitos de segurança"]],
      body: machines.map(
        (
          m: { nome?: string; placa?: string; requisitos_seguranca?: string },
          i: number,
        ) => [
          String(i + 1),
          sanitize(m.nome || "-"),
          sanitize(m.placa || "-"),
          sanitize(m.requisitos_seguranca || "-"),
        ],
      ),
      headStyles: {
        fillColor: APR_TEAL,
        textColor: APR_WHITE,
        fontStyle: "bold",
        fontSize: 7.6,
      },
      columnStyles: {
        0: { cellWidth: 12 },
        1: { cellWidth: 60 },
        2: { cellWidth: 35 },
        3: { cellWidth: contentWidth - 107 },
      },
      didDrawPage: (hookData: HookData) => {
        ctx.y = hookData.cursor?.y ? hookData.cursor.y + 4 : ctx.y + 4;
      },
    });
  }
}

function drawAprRiskMatrixReference(ctx: PdfContext, autoTable: AutoTableFn) {
  const { doc, margin, contentWidth, theme } = ctx;
  ensureSpace(ctx, 86);

  // Larguras calculadas para preencher o contentWidth em paisagem (A4: ~265mm)
  const sevHdrLabelW = 30;
  const sevHdrColW = Number(((contentWidth - sevHdrLabelW) / 5).toFixed(2));
  const matProbLabelW = 14;
  const matDescW = 45;
  const matCellW = Number(((contentWidth - matProbLabelW - matDescW) / 5).toFixed(2));

  doc.setDrawColor(120, 120, 120);
  doc.setFillColor(...APR_TEAL_SOFT);
  doc.roundedRect(margin, ctx.y, contentWidth, 8.6, 1.6, 1.6, "FD");
  doc.setFillColor(...APR_TEAL);
  doc.rect(margin, ctx.y, 2.3, 8.6, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...APR_DARK);
  doc.text("Matriz de risco e critério de ação", margin + 4, ctx.y + 5.7);
  moveY(ctx, 9.8);

  autoTable(doc, {
    startY: ctx.y,
    margin: { left: margin, right: margin, top: ctx.pageTop ?? margin },
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 7.2,
      cellPadding: 1.5,
      lineColor: [0, 0, 0],
      lineWidth: 0.12,
      textColor: [20, 20, 20],
      halign: "center",
      valign: "middle",
    },
    head: [
      [
        "",
        "1\nInsignificante\nSem lesão relevante.",
        "2\nMenor\nPrimeiros socorros.",
        "3\nModerada\nAfastamento reversível.",
        "4\nGrave\nLesão permanente parcial.",
        "5\nCatastrófica\nMorte ou múltiplas vítimas.",
      ],
    ],
    body: [["Severidade", "1", "2", "3", "4", "5"]],
    columnStyles: {
      0: { cellWidth: sevHdrLabelW, fillColor: APR_HEADER_GRAY, fontStyle: "bold" },
      1: {
        cellWidth: sevHdrColW,
        fillColor: [44, 184, 162],
        textColor: APR_DARK,
        fontStyle: "bold",
      },
      2: {
        cellWidth: sevHdrColW,
        fillColor: [39, 183, 163],
        textColor: APR_DARK,
        fontStyle: "bold",
      },
      3: {
        cellWidth: sevHdrColW,
        fillColor: [35, 182, 164],
        textColor: APR_DARK,
        fontStyle: "bold",
      },
      4: {
        cellWidth: sevHdrColW,
        fillColor: [31, 179, 162],
        textColor: APR_DARK,
        fontStyle: "bold",
      },
      5: {
        cellWidth: sevHdrColW,
        fillColor: [26, 176, 160],
        textColor: APR_DARK,
        fontStyle: "bold",
      },
    },
    didDrawPage: (hookData: HookData) => {
      ctx.y = hookData.cursor?.y ? hookData.cursor.y + 3 : ctx.y + 3;
    },
  });

  autoTable(doc, {
    startY: ctx.y,
    margin: { left: margin, right: margin, top: ctx.pageTop ?? margin },
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 7.2,
      cellPadding: 1.5,
      lineColor: [0, 0, 0],
      lineWidth: 0.12,
      textColor: [20, 20, 20],
      halign: "center",
      valign: "middle",
    },
    head: [["Probabilidade", "Descrição", "1", "2", "3", "4", "5"]],
    body: [
      [
        "1",
        "Improvável\nRaramente esperada",
        "Aceitável",
        "Aceitável",
        "Aceitável",
        "Aceitável",
        "Atenção",
      ],
      [
        "2",
        "Remota\nSituação excepcional",
        "Aceitável",
        "Aceitável",
        "Atenção",
        "Atenção",
        "Substancial",
      ],
      [
        "3",
        "Ocasional\nPode ocorrer",
        "Aceitável",
        "Atenção",
        "Atenção",
        "Substancial",
        "Substancial",
      ],
      [
        "4",
        "Provável\nTendência de ocorrência",
        "Aceitável",
        "Atenção",
        "Substancial",
        "Substancial",
        "Crítico",
      ],
      [
        "5",
        "Frequente\nOcorrência repetida",
        "Atenção",
        "Substancial",
        "Substancial",
        "Crítico",
        "Crítico",
      ],
    ],
    columnStyles: {
      0: { cellWidth: matProbLabelW, fillColor: APR_HEADER_GRAY, fontStyle: "bold" },
      1: { cellWidth: matDescW, fillColor: [245, 245, 245], fontStyle: "bold" },
      2: { cellWidth: matCellW },
      3: { cellWidth: matCellW },
      4: { cellWidth: matCellW },
      5: { cellWidth: matCellW },
      6: { cellWidth: matCellW },
    },
    didParseCell: (hookData: CellHookData) => {
      if (hookData.section !== "body") return;
      const value = normalizeRiskLabel(hookData.cell.raw);
      if (value.includes("aceit")) {
        hookData.cell.styles.fillColor = APR_ACCEPTABLE;
        hookData.cell.styles.textColor = APR_WHITE;
        hookData.cell.styles.fontStyle = "bold";
      } else if (value.includes("aten")) {
        hookData.cell.styles.fillColor = APR_ATTENTION;
        hookData.cell.styles.textColor = APR_WHITE;
        hookData.cell.styles.fontStyle = "bold";
      } else if (value.includes("subst")) {
        hookData.cell.styles.fillColor = APR_SUBSTANTIAL;
        hookData.cell.styles.textColor = APR_DARK;
        hookData.cell.styles.fontStyle = "bold";
      } else if (value.includes("crit")) {
        hookData.cell.styles.fillColor = APR_CRITICAL;
        hookData.cell.styles.textColor = APR_DARK;
        hookData.cell.styles.fontStyle = "bold";
      }
    },
    didDrawPage: (hookData: HookData) => {
      ctx.y = hookData.cursor?.y ? hookData.cursor.y + 3 : ctx.y + 3;
    },
  });

  autoTable(doc, {
    startY: ctx.y,
    margin: { left: margin, right: margin, top: ctx.pageTop ?? margin },
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 7.2,
      cellPadding: 1.5,
      lineColor: [0, 0, 0],
      lineWidth: 0.12,
      textColor: [20, 20, 20],
      overflow: "linebreak",
    },
    body: [
      [
        "Aceitável",
        "NÃO PRIORITÁRIO - Não são requeridos controles adicionais. A condição pode permanecer dentro dos parâmetros verificados.",
      ],
      [
        "Atenção",
        "PRIORIDADE BÁSICA - Reavaliar os meios de controle e, quando necessário, adotar medidas complementares.",
      ],
      [
        "Substancial",
        "PRIORIDADE PREFERENCIAL - O trabalho não deve ser iniciado até que o risco tenha sido reduzido.",
      ],
      [
        "Crítico",
        "PRIORIDADE MÁXIMA - Interromper o processo ou atividade e estabelecer ações imediatas de controle.",
      ],
    ],
    columnStyles: {
      0: { cellWidth: 36, fontStyle: "bold", halign: "center" },
      1: { cellWidth: contentWidth - 36 },
    },
    didParseCell: (hookData: CellHookData) => {
      if (hookData.section !== "body" || hookData.column.index !== 0) return;
      const value = normalizeRiskLabel(hookData.cell.raw);
      if (value.includes("aceit")) {
        hookData.cell.styles.fillColor = APR_ACCEPTABLE;
        hookData.cell.styles.textColor = APR_WHITE;
      } else if (value.includes("aten")) {
        hookData.cell.styles.fillColor = APR_ATTENTION;
        hookData.cell.styles.textColor = APR_WHITE;
      } else if (value.includes("subst")) {
        hookData.cell.styles.fillColor = APR_SUBSTANTIAL;
        hookData.cell.styles.textColor = APR_DARK;
      } else if (value.includes("crit")) {
        hookData.cell.styles.fillColor = APR_CRITICAL;
        hookData.cell.styles.textColor = APR_DARK;
      }
    },
    didDrawPage: (hookData: HookData) => {
      ctx.y = hookData.cursor?.y ? hookData.cursor.y + 5 : ctx.y + 5;
    },
  });
}

function drawAprParticipantRoster(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  participants: Array<{ name?: string; role?: string | null; userId?: string }>,
  signedUserIds?: Set<string>,
) {
  if (!participants.length) return;
  const { doc, margin, contentWidth, theme } = ctx;
  const showSigned = signedUserIds !== undefined && signedUserIds.size > 0;
  ensureSpace(ctx, 26);

  doc.setDrawColor(120, 120, 120);
  doc.setFillColor(...APR_TEAL_SOFT);
  doc.roundedRect(margin, ctx.y, contentWidth, 8.6, 1.6, 1.6, "FD");
  doc.setFillColor(...APR_ATTENTION);
  doc.rect(margin, ctx.y, 2.3, 8.6, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...APR_DARK);
  doc.text(
    `Equipe participante (${participants.length})`,
    margin + 4,
    ctx.y + 5.7,
  );
  moveY(ctx, 9.8);

  const signedColW = 20;
  const roleColW = showSigned ? 40 : 52;
  const nameColW = showSigned
    ? contentWidth - 12 - roleColW - signedColW
    : contentWidth - 64;

  autoTable(doc, {
    startY: ctx.y,
    margin: {
      left: margin,
      right: margin,
      top: ctx.pageTop ?? margin,
    },
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 8,
      cellPadding: 1.8,
      lineColor: [0, 0, 0],
      lineWidth: 0.12,
      textColor: APR_DARK,
      overflow: "linebreak",
      valign: "middle",
    },
    head: [showSigned ? ["#", "Nome do participante", "Função", "Assinou"] : ["#", "Nome do participante", "Função"]],
    body: participants.map((participant, index) => {
      const signed = participant.userId && signedUserIds?.has(participant.userId) ? "Sim" : "Não";
      return showSigned
        ? [index + 1, sanitize(participant.name), sanitize(participant.role), signed]
        : [index + 1, sanitize(participant.name), sanitize(participant.role)];
    }),
    headStyles: {
      fillColor: APR_ATTENTION,
      textColor: APR_WHITE,
      fontStyle: "bold",
      halign: "left",
    },
    alternateRowStyles: {
      fillColor: [244, 249, 255],
    },
    columnStyles: showSigned
      ? {
          0: { cellWidth: 12, halign: "center", fontStyle: "bold" },
          1: { cellWidth: nameColW },
          2: { cellWidth: roleColW },
          3: { cellWidth: signedColW, halign: "center" },
        }
      : {
          0: { cellWidth: 12, halign: "center", fontStyle: "bold" },
          1: { cellWidth: nameColW },
          2: { cellWidth: roleColW },
        },
    didParseCell: showSigned
      ? (hookData: CellHookData) => {
          if (hookData.section !== "body" || hookData.column.index !== 3) return;
          const val = String(hookData.cell.raw ?? "").toLowerCase();
          if (val === "sim") {
            hookData.cell.styles.fillColor = APR_ACCEPTABLE;
            hookData.cell.styles.textColor = APR_WHITE;
            hookData.cell.styles.fontStyle = "bold";
          } else if (val === "não" || val === "nao") {
            hookData.cell.styles.fillColor = APR_CRITICAL;
            hookData.cell.styles.textColor = APR_WHITE;
            hookData.cell.styles.fontStyle = "bold";
          }
        }
      : undefined,
    didDrawPage: (hookData: HookData) => {
      ctx.y = hookData.cursor?.y ? hookData.cursor.y + 5 : ctx.y + 5;
    },
  });
}

type AprApprovalStepPdf = {
  level_order?: number;
  title?: string;
  approver_role?: string;
  status?: string;
  decided_at?: string | Date | null;
  decision_reason?: string | null;
};

const APR_STEP_STATUS_LABEL: Record<string, string> = {
  pending: "Aguardando",
  approved: "Aprovado",
  rejected: "Reprovado",
  skipped: "Ignorado",
  PENDING: "Aguardando",
  APPROVED: "Aprovado",
  REJECTED: "Reprovado",
  SKIPPED: "Ignorado",
};

function drawAprApprovalStepsHistory(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  steps: AprApprovalStepPdf[],
) {
  if (!steps.length) return;
  const { doc, margin, contentWidth, theme } = ctx;
  const stepTextColW = Number(((contentWidth - 70) / 2).toFixed(2)); // 70 = cols 0+3+4 fixos
  ensureSpace(ctx, 26);

  doc.setDrawColor(120, 120, 120);
  doc.setFillColor(...APR_TEAL_SOFT);
  doc.roundedRect(margin, ctx.y, contentWidth, 8.6, 1.6, 1.6, "FD");
  doc.setFillColor(...APR_TEAL);
  doc.rect(margin, ctx.y, 2.3, 8.6, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.headingSm);
  doc.setTextColor(...APR_DARK);
  doc.text("Histórico de aprovação", margin + 4, ctx.y + 5.7);
  moveY(ctx, 9.8);

  autoTable(doc, {
    startY: ctx.y,
    margin: { left: margin, right: margin, top: ctx.pageTop ?? margin },
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 7.6,
      cellPadding: 1.8,
      lineColor: [0, 0, 0],
      lineWidth: 0.12,
      textColor: APR_DARK,
      overflow: "linebreak",
      valign: "middle",
    },
    head: [["Nível", "Etapa", "Papel aprovador", "Status", "Decisão em"]],
    body: steps.map((step) => [
      String(step.level_order ?? ""),
      sanitize(step.title),
      sanitize(step.approver_role),
      APR_STEP_STATUS_LABEL[step.status ?? ""] ?? sanitize(step.status),
      step.decided_at ? formatDate(String(step.decided_at)) : "—",
    ]),
    headStyles: {
      fillColor: APR_TEAL,
      textColor: APR_WHITE,
      fontStyle: "bold",
      fontSize: 7.6,
    },
    columnStyles: {
      0: { cellWidth: 14, halign: "center" },
      1: { cellWidth: stepTextColW },
      2: { cellWidth: stepTextColW },
      3: { cellWidth: 28, halign: "center" },
      4: { cellWidth: 28, halign: "center" },
    },
    didParseCell: (hookData: CellHookData) => {
      if (hookData.section !== "body" || hookData.column.index !== 3) return;
      const val = String(hookData.cell.raw ?? "").toLowerCase();
      if (val.includes("aprovad")) {
        hookData.cell.styles.fillColor = APR_ACCEPTABLE;
        hookData.cell.styles.textColor = APR_WHITE;
        hookData.cell.styles.fontStyle = "bold";
      } else if (val.includes("reprovad") || val.includes("cancelad")) {
        hookData.cell.styles.fillColor = APR_CRITICAL;
        hookData.cell.styles.textColor = APR_WHITE;
        hookData.cell.styles.fontStyle = "bold";
      } else if (val.includes("aguard")) {
        hookData.cell.styles.fillColor = APR_SUBSTANTIAL;
        hookData.cell.styles.textColor = APR_DARK;
        hookData.cell.styles.fontStyle = "bold";
      }
    },
    didDrawPage: (hookData: HookData) => {
      ctx.y = hookData.cursor?.y ? hookData.cursor.y + 4 : ctx.y + 4;
    },
  });
}
export function resolveAprRiskRows(apr: Apr) {
  const structuredRows = Array.isArray(apr.risk_items) ? apr.risk_items : [];
  if (structuredRows.length > 0) {
    return structuredRows.map((item: AprStructuredRiskRow) => {
      // Suporta tanto campo `atividade` (entidade persistida) quanto `atividade_processo` (legado)
      const activityLabel =
        (item.atividade as string | undefined) ||
        (item as AprRiskRowSource).atividade_processo ||
        "";
      return {
        activity: [activityLabel, item.etapa ? `(${item.etapa})` : ""]
          .filter(Boolean)
          .join(" "),
        agent: optionalText(item.agente_ambiental),
        condition: optionalText(item.condicao_perigosa),
        hazard: [
          item.agente_ambiental ? `Agente: ${item.agente_ambiental}` : "",
          item.condicao_perigosa ? `Condição: ${item.condicao_perigosa}` : "",
        ]
          .filter(Boolean)
          .join(" • "),
        source: optionalText(
          item.fonte_circunstancia ||
            (item as AprRiskRowSource).fontes_circunstancias,
        ),
        injuries: optionalText(
          item.lesao || (item as AprRiskRowSource).possiveis_lesoes,
        ),
        probability: item.probabilidade,
        severity: item.severidade,
        score: item.score_risco,
        level: item.categoria_risco || item.prioridade || undefined,
        control: [
          item.medidas_prevencao ? `Medidas: ${item.medidas_prevencao}` : "",
          item.hierarquia_controle
            ? `Hierarquia: ${item.hierarquia_controle}`
            : "",
          item.epc ? `EPC: ${item.epc}` : "",
          item.epi ? `EPI: ${item.epi}` : "",
          item.permissao_trabalho
            ? `Permissão: ${item.permissao_trabalho}`
            : "",
          item.normas_relacionadas ? `Normas: ${item.normas_relacionadas}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        owner: optionalText(item.responsavel),
        dueAndStatus: [
          item.prazo ? formatDate(item.prazo as string) : "",
          item.status_acao as string | undefined,
        ]
          .filter(Boolean)
          .join(" • "),
      };
    });
  }

  const matrixRows = Array.isArray(apr.itens_risco)
    ? (apr.itens_risco as AprRiskRowSource[])
    : [];

  return matrixRows.map((item) => ({
    activity: [item.atividade || item.atividade_processo]
      .filter(Boolean)
      .join(" | "),
    agent: item.agente_ambiental,
    condition: item.condicao_perigosa,
    hazard: [
      item.agente_ambiental ? `Agente: ${item.agente_ambiental}` : "",
      item.condicao_perigosa ? `Condição: ${item.condicao_perigosa}` : "",
    ]
      .filter(Boolean)
      .join(" • "),
    source: item.fonte_circunstancia || item.fontes_circunstancias,
    injuries: item.lesao || item.possiveis_lesoes,
    probability: item.probabilidade,
    severity: item.severidade,
    score:
      item.score_risco ||
      (item.probabilidade && item.severidade
        ? Number(item.probabilidade) * Number(item.severidade)
        : ""),
    level: item.categoria_risco || item.prioridade,
    control: [
      item.medidas_prevencao ? `Medidas: ${item.medidas_prevencao}` : "",
      item.responsavel ? `Responsável: ${item.responsavel}` : "",
      item.prazo ? `Prazo: ${formatDate(String(item.prazo))}` : "",
      item.status_acao ? `Status: ${item.status_acao}` : "",
    ]
      .filter(Boolean)
      .join(" • "),
    owner: item.responsavel,
    dueAndStatus: [
      item.prazo ? formatDate(String(item.prazo)) : "",
      item.status_acao,
    ]
      .filter(Boolean)
      .join(" • "),
  }));
}

export async function drawAprBlueprint(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  apr: Apr,
  signatures: Signature[],
  code: string,
  validationUrl: string,
  evidences: AprPdfEvidence[] = [],
  resolveImageDataUrl?: (
    item: AprPdfEvidence,
    index: number,
  ) => Promise<string | null>,
) {
  const riskRows = resolveAprRiskRows(apr);
  drawAprOperationalHeader(ctx, autoTable, apr);

  drawRiskTable(ctx, autoTable, riskRows, {
    semanticRules: { profile: "apr" },
    layout: "cards",
  });

  drawAprComplementaryInfo(ctx, autoTable, apr);
  drawAprRiskMatrixReference(ctx, autoTable);
  const signedUserIds = new Set<string>(
    signatures.filter((s) => Boolean(s.user_id)).map((s) => s.user_id as string),
  );
  drawAprParticipantRoster(
    ctx,
    autoTable,
    (apr.participants ?? []).map((participant: AprParticipantLike) => ({
      name: participant.nome,
      role: participant.funcao,
      userId: participant.id,
    })),
    signedUserIds.size > 0 ? signedUserIds : undefined,
  );


  // Historico de etapas de aprovacao
  const approvalSteps = Array.isArray(apr.approval_steps)
    ? (apr.approval_steps as AprApprovalStepPdf[])
    : [];
  const decidedSteps = approvalSteps.filter(
    (s) => s.status && s.status !== "pending" && s.status !== "PENDING",
  );
  drawAprApprovalStepsHistory(ctx, autoTable, decidedSteps.length > 0 ? approvalSteps : []);

  await drawEvidenceGallery(ctx, {
    title: "Evidências visuais",
    items: evidences.map((item) => ({
      title:
        item.original_name || `Evidência ${item.risk_item_ordem ?? ""}`.trim(),
      description:
        item.risk_item_ordem !== undefined
          ? `Registro associado ao item de risco #${item.risk_item_ordem + 1}.`
          : "Registro visual anexado à APR.",
      meta: [
        item.captured_at
          ? `Capturada em: ${formatDate(item.captured_at)}`
          : undefined,
        item.uploaded_at
          ? `Upload: ${formatDate(item.uploaded_at)}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" | "),
      source: item.url || item.watermarked_url,
    })),
    resolveImageDataUrl: resolveImageDataUrl
      ? async (_item: unknown, index: number) =>
          resolveImageDataUrl(evidences[index]!, index)
      : undefined,
  });

  await drawGovernanceClosingBlock(ctx, {
    signatures: signatures.map((signature) => ({
      label: resolveSignatureTypeLabel(signature.type),
      name: resolveSignatureSignerName(signature),
      role: resolveSignatureSignerRole(signature),
      date: formatDate(signature.signed_at || signature.created_at),
      image: signature.signature_data ?? null,
    })),
    code,
    url: validationUrl,
    title: "Governança, autenticidade e rastreabilidade",
    subtitle: "Valide por QR Code ou código no portal público.",
    accentColor: APR_TEAL,
    accentSoftColor: [240, 249, 248],
  });
}

