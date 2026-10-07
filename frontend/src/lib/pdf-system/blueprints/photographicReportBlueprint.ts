import type {
  PhotographicReport,
  PhotographicReportDay,
  PhotographicReportImage,
} from "@/services/photographicReportsService";
import type { AutoTableFn, PdfContext } from "../core/types";
import { formatDate, sanitize } from "../core/format";
import {
  drawDocumentIdentityRail,
  drawEvidenceGallery,
  drawExecutiveSummaryStrip,
  drawGovernanceClosingBlock,
  drawMetadataGrid,
  drawNarrativeSection,
} from "../components";

export type ResolveEvidenceImage = (
  item: { source?: string },
  index: number,
) => Promise<string | null>;

type PhotographicReportGroup = {
  day: PhotographicReportDay | null;
  images: PhotographicReportImage[];
};

function formatRange(startDate?: string | null, endDate?: string | null) {
  const start = formatDate(startDate);
  const end = formatDate(endDate);

  if (!start && !end) return "-";
  if (start && end && start !== end) return `${start} a ${end}`;
  return start || end || "-";
}

function formatClockRange(startTime?: string | null, endTime?: string | null) {
  const start = sanitize(startTime);
  const end = sanitize(endTime);

  if (start && end && start !== end) {
    return `${start} às ${end}`;
  }

  return start || end || "-";
}

function buildPeriodLabel(report: PhotographicReport) {
  const range = formatRange(report.start_date, report.end_date);
  const timeRange = formatClockRange(report.start_time, report.end_time);

  if (range === "-" && timeRange === "-") {
    return "-";
  }

  if (range !== "-" && timeRange !== "-") {
    return `${range} • ${timeRange}`;
  }

  return range !== "-" ? range : timeRange;
}

function buildActivityTone(report: PhotographicReport) {
  const tone = String(report.report_tone || "").toLowerCase();
  const area = String(report.area_status || "").toLowerCase();

  if (tone.includes("prevent")) return "Preventivo";
  if (tone.includes("téc") || tone.includes("tec")) return "Técnico";
  if (area.includes("fechada") || area.includes("controlada")) return "Controlado";
  return "Operacional";
}

function buildExecutiveSummary(report: PhotographicReport, totalPhotos: number, totalDays: number) {
  const areaStatus = sanitize(report.area_status);
  const shift = sanitize(report.shift);
  const activity = sanitize(report.activity_type);

  const base =
    `Relatório fotográfico de ${activity}, com ${totalPhotos} foto(s) distribuída(s) em ${totalDays} data(s) de registro.`;
  const controlNote =
    areaStatus === "Loja fechada" || areaStatus === "Área controlada" || shift === "Noturno"
      ? "Área interna registrada nas imagens, com menor exposição a interferências externas."
      : "Área operacional registrada durante a execução das atividades.";

  return `${base} ${controlNote}`;
}

function buildGeneralConditions(report: PhotographicReport) {
  const conditions: string[] = [];

  conditions.push(
    `Condição da área: ${sanitize(report.area_status)}. Turno: ${sanitize(report.shift)}.`,
  );

  if (
    report.area_status === "Loja fechada" ||
    report.area_status === "Área controlada" ||
    report.area_status === "Área isolada" ||
    report.shift === "Noturno"
  ) {
    conditions.push(
      "Considerando o ambiente com controle operacional ampliado, a atividade apresentou menor interferência externa e favoreceu a execução organizada do trabalho.",
    );
  } else {
    conditions.push(
      "A atividade ocorreu em cenário operacional regular, com acompanhamento visual suficiente para registrar o andamento das frentes de serviço.",
    );
  }

  if (report.general_observations) {
    conditions.push(`Observações do cadastro: ${sanitize(report.general_observations)}.`);
  }

  return conditions.join(" ");
}

function buildReportObjective(report: PhotographicReport) {
  return [
    `Registrar de forma fotográfica a atividade de ${sanitize(report.activity_type)} executada para ${sanitize(report.client_name)}.`,
    `Obra: ${sanitize(report.project_name)}.`,
    report.unit_name ? `Unidade: ${sanitize(report.unit_name)}.` : "",
    report.location ? `Local específico: ${sanitize(report.location)}.` : "",
    `Responsável: ${sanitize(report.responsible_name)}.`,
    `Empresa executora: ${sanitize(report.contractor_company)}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildConsolidatedAssessment(report: PhotographicReport, totalPhotos: number) {
  if (report.ai_summary) {
    return sanitize(report.ai_summary);
  }

  const plural = totalPhotos > 1 ? "registros fotográficos" : "registro fotográfico";
  return `Foram incluídos ${plural}, vinculados à atividade informada: ${sanitize(report.activity_type)}.`;
}

function buildTechnicalOpinion(report: PhotographicReport) {
  const activity = sanitize(report.activity_type);
  const area = sanitize(report.area_status);
  const tone = sanitize(report.report_tone);

  return [
    `O parecer técnico considera a atividade de ${activity} com abordagem compatível ao contexto informado pelo usuário.`,
    `A condição da área foi registrada como ${area}, com tom editorial ${tone}.`,
    "Os textos gerados e a seleção fotográfica podem ser ajustados manualmente antes da emissão final, mantendo linguagem objetiva e profissional.",
  ].join(" ");
}

function buildFinalConclusion(report: PhotographicReport) {
  if (report.final_conclusion) {
    return sanitize(report.final_conclusion);
  }

  return [
    `Conclui-se que o relatório fotográfico da atividade de ${sanitize(report.activity_type)} foi estruturado com organização, rastreabilidade e leitura técnica adequada.`,
    `O material reúne dados da obra, período, responsáveis e evidências visuais para apoiar o acompanhamento operacional e documental.`,
  ].join(" ");
}

function buildPhotoDescription(image: PhotographicReportImage) {
  const positivePoints = (image.ai_positive_points || []).filter(Boolean);
  const recommendations = (image.ai_recommendations || []).filter(Boolean);

  const parts = [
    image.manual_caption ? `Legenda manual: ${sanitize(image.manual_caption)}` : "",
    image.ai_description ? `Descrição: ${sanitize(image.ai_description)}` : "",
    positivePoints.length ? `Pontos positivos: ${positivePoints.map((point) => sanitize(point)).join("; ")}` : "",
    image.ai_technical_assessment
      ? `Avaliação técnica: ${sanitize(image.ai_technical_assessment)}`
      : "",
    image.ai_condition_classification
      ? `Classificação: ${sanitize(image.ai_condition_classification)}`
      : "",
    recommendations.length
      ? `Recomendação preventiva: ${recommendations.map((item) => sanitize(item)).join("; ")}`
      : "",
  ].filter(Boolean);

  if (!parts.length) {
    return "Registro fotográfico da atividade executada em campo.";
  }

  return parts.join(" ");
}

function buildDaySummary(day: PhotographicReportDay | null, images: PhotographicReportImage[], report: PhotographicReport) {
  if (day?.day_summary) {
    return sanitize(day.day_summary);
  }

  const photoCount = images.length;
  const area = sanitize(report.area_status);
  return `Data com ${photoCount} foto(s) vinculada(s) à atividade de ${sanitize(report.activity_type)}, registrada sob condição ${area}.`;
}

function groupImagesByDay(report: PhotographicReport): PhotographicReportGroup[] {
  const dayMap = new Map<string, PhotographicReportGroup>();
  const unassigned: PhotographicReportImage[] = [];

  report.days.forEach((day) => {
    dayMap.set(day.id, { day, images: [] });
  });

  report.images.forEach((image) => {
    if (image.report_day_id && dayMap.has(image.report_day_id)) {
      dayMap.get(image.report_day_id)!.images.push(image);
      return;
    }

    unassigned.push(image);
  });

  const groups = report.days
    .map((day) => dayMap.get(day.id))
    .filter((group): group is PhotographicReportGroup => Boolean(group));

  if (unassigned.length) {
    groups.push({ day: null, images: unassigned });
  }

  return groups.filter((group) => group.images.length > 0);
}

export async function drawPhotographicReportBlueprint(
  ctx: PdfContext,
  _autoTable: AutoTableFn,
  report: PhotographicReport,
  code: string,
  validationUrl: string,
  resolveEvidenceImage: ResolveEvidenceImage,
) {
  const totalPhotos = report.images.length;
  const totalDays = report.days.length || (totalPhotos > 0 ? 1 : 0);
  const groups = groupImagesByDay(report);

  drawDocumentIdentityRail(ctx, {
    documentType: "Relatório Fotográfico",
    criticality: buildActivityTone(report),
    validity: buildPeriodLabel(report),
    documentClass: "Fotográfico",
  });

  drawExecutiveSummaryStrip(ctx, {
    title: "Leitura executiva",
    summary: buildExecutiveSummary(report, totalPhotos, totalDays || 1),
    metrics: [
      { label: "Cliente", value: sanitize(report.client_name), tone: "info" },
      { label: "Obra", value: sanitize(report.project_name), tone: "default" },
      { label: "Fotos", value: totalPhotos, tone: totalPhotos > 0 ? "success" : "warning" },
      { label: "Datas", value: totalDays, tone: totalDays > 0 ? "info" : "warning" },
      { label: "Turno", value: sanitize(report.shift), tone: "default" },
      { label: "Condição", value: sanitize(report.area_status), tone: "default" },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Dados da obra e atividade",
    columns: 2,
    fields: [
      { label: "Cliente", value: report.client_name },
      { label: "Obra", value: report.project_name },
      { label: "Unidade", value: report.unit_name || "-" },
      { label: "Local específico", value: report.location || "-" },
      { label: "Data inicial", value: formatDate(report.start_date) },
      { label: "Data final", value: formatDate(report.end_date) || "-" },
      { label: "Horário", value: formatClockRange(report.start_time, report.end_time) },
      { label: "Turno", value: report.shift },
      { label: "Condição da área", value: report.area_status },
      { label: "Tipo de atividade", value: report.activity_type },
      { label: "Responsável", value: report.responsible_name },
      { label: "Empresa executora", value: report.contractor_company },
      { label: "Status", value: report.status },
    ],
  });

  drawNarrativeSection(ctx, {
    title: "Objetivo do relatório",
    content: buildReportObjective(report),
  });

  drawNarrativeSection(ctx, {
    title: "Descrição geral da atividade",
    content: buildGeneralConditions(report),
  });

  if (report.general_observations) {
    drawNarrativeSection(ctx, {
      title: "Observações gerais",
      content: report.general_observations,
    });
  }

  drawNarrativeSection(ctx, {
    title: "Avaliação consolidada",
    content: buildConsolidatedAssessment(report, totalPhotos),
  });

  drawNarrativeSection(ctx, {
    title: "Parecer técnico",
    content: buildTechnicalOpinion(report),
  });

  for (const [index, group] of groups.entries()) {
    const label = group.day?.activity_date
      ? `Registro fotográfico - ${formatDate(group.day.activity_date)}`
      : "Registro fotográfico - sem data vinculada";

    drawNarrativeSection(ctx, {
      title: label,
      content: buildDaySummary(group.day, group.images, report),
    });

    await drawEvidenceGallery(ctx, {
      title: `Fotos da data ${group.day?.activity_date ? formatDate(group.day.activity_date) : "sem data"}`,
      items: group.images.map((image, imageIndex) => ({
        source: image.download_url || image.image_url,
        title:
          sanitize(image.ai_title) ||
          sanitize(image.manual_caption) ||
          `Foto ${imageIndex + 1}`,
        description: buildPhotoDescription(image),
        meta: [
          `Ordem ${image.image_order}`,
          group.day?.activity_date ? formatDate(group.day.activity_date) : "Data não vinculada",
        ].join(" • "),
      })),
      resolveImageDataUrl: resolveEvidenceImage,
    });

    if (index + 1 < groups.length) {
      drawNarrativeSection(ctx, {
        title: "Separação de data",
        content:
          "O relatório organiza o conjunto fotográfico por data de execução para manter rastreabilidade visual e leitura cronológica do serviço.",
      });
    }
  }

  drawNarrativeSection(ctx, {
    title: "Conclusão final",
    content: buildFinalConclusion(report),
  });

  await drawGovernanceClosingBlock(ctx, {
    code,
    url: validationUrl,
    title: "Validação do documento",
    subtitle:
      "Use o QR Code ou o código do relatório para conferência no portal SGS.",
  });
}
