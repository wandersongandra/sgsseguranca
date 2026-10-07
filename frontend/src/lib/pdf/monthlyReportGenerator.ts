import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { ptBR } from "date-fns/locale";
import {
  applyFooterGovernance,
  applyInstitutionalDocumentHeader,
  buildDocumentCode,
  createPdfContext,
  drawDocumentIdentityRail,
  drawExecutiveSummaryStrip,
  drawMetadataGrid,
  drawNarrativeSection,
  drawSemanticTable,
} from "@/lib/pdf-system";
import { pdfDocToBase64, type PdfOutputDoc } from "./pdfBase64";
import { safeFormatDate } from "@/lib/date/safeFormat";

export interface MonthlyReportPdfSource {
  id: string;
  titulo: string;
  mes: number;
  ano: number;
  companyName?: string | null;
  estatisticas: {
    aprs_count: number;
    pts_count: number;
    dds_count: number;
    checklists_count: number;
    trainings_count: number;
    epis_expired_count?: number;
  };
  analise_gandra: string;
  created_at: string;
}

type MetricTone = "info" | "success" | "warning" | "danger";

export interface MonthlyReportMetadataItem {
  label: string;
  value: string;
}

function buildReportPeriod(report: MonthlyReportPdfSource) {
  return `${String(report.mes).padStart(2, "0")}/${report.ano}`;
}

function buildGeneratedAt(value: string) {
  return safeFormatDate(value, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR }, "-");
}

function buildMonthlyReportFilename(report: MonthlyReportPdfSource) {
  return `Relatorio_SGS_Gestao_Seguranca_Trabalho_${report.mes}_${report.ano}.pdf`;
}

function resolveStatusSignal(report: MonthlyReportPdfSource) {
  const expiredEpis = report.estatisticas.epis_expired_count ?? 0;
  const totalRecords =
    report.estatisticas.aprs_count +
    report.estatisticas.pts_count +
    report.estatisticas.dds_count +
    report.estatisticas.checklists_count;

  if (expiredEpis > 0) {
    return {
      label: "Atenção",
      tone: "danger" as MetricTone,
      criticality: "moderate",
      message:
        "Há itens vencidos que exigem tratamento prioritário e acompanhamento executivo.",
    };
  }

  if (totalRecords >= 25) {
    return {
      label: "Ativa",
      tone: "success" as MetricTone,
      criticality: "controlled",
      message:
        "O período registrou boa tração operacional e volume consistente de evidências.",
    };
  }

  return {
    label: "Estável",
    tone: "info" as MetricTone,
    criticality: "monitorado",
    message:
      "O período manteve operação regular, com volume controlado e sem alertas críticos.",
  };
}

function resolveOperationalTone(totalRecords: number): MetricTone {
  if (totalRecords <= 0) {
    return "danger";
  }

  if (totalRecords < 10) {
    return "warning";
  }

  if (totalRecords >= 25) {
    return "success";
  }

  return "info";
}

function buildIndicatorRows(report: MonthlyReportPdfSource) {
  const expiredEpis = report.estatisticas.epis_expired_count ?? 0;
  return [
    {
      indicador: "APRs emitidas",
      quantidade: report.estatisticas.aprs_count,
      leitura:
        report.estatisticas.aprs_count > 0
          ? "Operação com análise preventiva registrada"
          : "Sem emissão no período",
    },
    {
      indicador: "PTs emitidas",
      quantidade: report.estatisticas.pts_count,
      leitura:
        report.estatisticas.pts_count > 0
          ? "Liberações críticas registradas"
          : "Sem liberações críticas no período",
    },
    {
      indicador: "DDS realizados",
      quantidade: report.estatisticas.dds_count,
      leitura:
        report.estatisticas.dds_count > 0
          ? "Alinhamentos preventivos executados"
          : "Sem DDS no período",
    },
    {
      indicador: "Checklists executados",
      quantidade: report.estatisticas.checklists_count,
      leitura:
        report.estatisticas.checklists_count > 0
          ? "Inspeções e verificações registradas"
          : "Sem checklists no período",
    },
    {
      indicador: "Treinamentos",
      quantidade: report.estatisticas.trainings_count,
      leitura:
        report.estatisticas.trainings_count > 0
          ? "Capacitação com evidências ativas"
          : "Sem novos treinamentos no período",
    },
    {
      indicador: "EPIs vencidos",
      quantidade: expiredEpis,
      leitura:
        expiredEpis > 0
          ? "Há bloqueio potencial por vencimento"
          : "Sem alertas de vencimento",
    },
  ];
}

export function buildMonthlyReportMetadata(
  report: MonthlyReportPdfSource,
  generatedAt: string,
): MonthlyReportMetadataItem[] {
  return [
    {
      label: "Empresa",
      value: report.companyName?.trim() || "Empresa não informada",
    },
    {
      label: "Documento",
      value: report.titulo || "Fechamento mensal de conformidade",
    },
    { label: "Período", value: buildReportPeriod(report) },
    { label: "Emissão", value: generatedAt },
  ];
}

export function paginateMonthlyReportLines(
  lines: string[],
  firstPageLineCapacity: number,
  nextPageLineCapacity: number,
) {
  const safeFirstCapacity = Math.max(1, firstPageLineCapacity);
  const safeNextCapacity = Math.max(1, nextPageLineCapacity);
  const pages: string[][] = [];
  let cursor = 0;
  let capacity = safeFirstCapacity;

  while (cursor < lines.length) {
    pages.push(lines.slice(cursor, cursor + capacity));
    cursor += capacity;
    capacity = safeNextCapacity;
  }

  if (pages.length === 0) {
    pages.push(["-"]);
  }

  return pages;
}

export function generateMonthlyReportPdf(
  report: MonthlyReportPdfSource,
  options: {
    save?: boolean;
    output?: "base64";
    draftWatermark?: boolean;
  } = { save: true },
) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const ctx = createPdfContext(doc, "compliance");
  const code = buildDocumentCode(
    "REL",
    report.id || report.titulo,
    `${report.ano}-${String(report.mes).padStart(2, "0")}-01`,
  );
  const generatedAt = buildGeneratedAt(report.created_at);
  const companyName = report.companyName?.trim() || "Empresa não informada";
  const statusSignal = resolveStatusSignal(report);
  const totalRecords =
    report.estatisticas.aprs_count +
    report.estatisticas.pts_count +
    report.estatisticas.dds_count +
    report.estatisticas.checklists_count;

  ctx.y = applyInstitutionalDocumentHeader(ctx, {
    title: "RELATÓRIO EXECUTIVO MENSAL",
    subtitle:
      "Documento institucional de desempenho documental, conformidade e leitura gerencial do período.",
    code,
    date: buildReportPeriod(report),
    status: statusSignal.label,
    version: "1",
    company: companyName,
    site: "Consolidado gerencial",
  });

  drawDocumentIdentityRail(ctx, {
    documentType: "Relatório Executivo",
    criticality: statusSignal.criticality,
    validity: buildReportPeriod(report),
    documentClass: "executive",
  });

  drawExecutiveSummaryStrip(ctx, {
    title: "Leitura executiva do período",
    summary: statusSignal.message,
    metrics: [
      { label: "Período", value: buildReportPeriod(report), tone: "info" },
      { label: "Status", value: statusSignal.label, tone: statusSignal.tone },
      {
        label: "Registros",
        value: totalRecords,
        tone: resolveOperationalTone(totalRecords),
      },
      {
        label: "Treinamentos",
        value: report.estatisticas.trainings_count,
        tone:
          report.estatisticas.trainings_count > 0 ? "success" : "warning",
      },
      {
        label: "EPIs vencidos",
        value: report.estatisticas.epis_expired_count ?? 0,
        tone:
          (report.estatisticas.epis_expired_count ?? 0) > 0
            ? "danger"
            : "success",
      },
      { label: "Empresa", value: companyName, tone: "default" },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Contexto do relatório",
    columns: 2,
    fields: buildMonthlyReportMetadata(report, generatedAt).map((item) => ({
      label: item.label,
      value: item.value,
    })),
  });

  drawSemanticTable(ctx, {
    title: "Indicadores consolidados do período",
    tone: "action",
    autoTable,
    head: [["Indicador", "Quantidade", "Leitura executiva"]],
    body: buildIndicatorRows(report).map((row) => [
      row.indicador,
      String(row.quantidade),
      row.leitura,
    ]),
    semanticRules: { profile: "audit", columns: [2] },
    overrides: {
      styles: { fontSize: 8, cellPadding: 2.3 },
      columnStyles: {
        0: { cellWidth: 48 },
        1: { cellWidth: 24 },
      },
    },
  });

  drawNarrativeSection(ctx, {
    title: "Análise executiva",
    content: report.analise_gandra,
  });

  drawNarrativeSection(ctx, {
    title: "Emissão do relatório",
    content: `Relatório ${code} emitido para ${companyName}, referente ao período ${buildReportPeriod(report)}.`,
  });

  applyFooterGovernance(ctx, {
    code,
    generatedAt,
    draft: options.draftWatermark ?? false,
  });

  const filename = buildMonthlyReportFilename(report);

  if (options.save) {
    doc.save(filename);
  }

  if (options.output === "base64") {
    return {
      filename,
      base64: pdfDocToBase64(doc as unknown as PdfOutputDoc),
    };
  }

  return null;
}
