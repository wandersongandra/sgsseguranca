import type { Audit } from "@/services/auditsService";
import type { AutoTableFn, PdfContext } from "../core/types";
import { formatDate, sanitize } from "../core/format";
import {
  drawDocumentIdentityRail,
  drawExecutiveSummaryStrip,
  drawEvidenceGallery,
  drawGovernanceClosingBlock,
  drawMetadataGrid,
  drawNarrativeSection,
} from "../components";
import { drawActionPlanTable, drawComplianceTable } from "../tables";

type AuditNonComplianceLike = {
  descricao?: string;
  requisito?: string;
  evidencia?: string;
  classificacao?: string;
};

type AuditActionPlanLike = {
  item?: string;
  acao?: string;
  responsavel?: string;
  prazo?: string;
  status?: string;
};

type AuditRiskLike = {
  perigo?: string;
  classificacao?: string;
  impactos?: string;
  medidas_controle?: string;
};

type AuditChecklistEvidenceLike = {
  fileName?: string;
  dataUrl?: string;
  capturedAt?: string;
  hash?: string;
};

type AuditChecklistAnswerLike = {
  sectionTitle?: string;
  question?: string;
  requirement?: string;
  criticality?: string;
  answer?: string;
  observation?: string;
  evidences?: AuditChecklistEvidenceLike[];
};

function joinBulletedList(values?: Array<string | null | undefined>) {
  const normalized = (values ?? [])
    .map((value) => sanitize(value).trim())
    .filter(Boolean);

  return normalized.length > 0
    ? normalized.map((value, index) => `${index + 1}. ${value}`).join("\n")
    : undefined;
}

function formatRiskEntries(values?: AuditRiskLike[]) {
  const normalized = (values ?? [])
    .map((item, index) => {
      const risk = {
        perigo: sanitize(item.perigo).trim(),
        classificacao: sanitize(item.classificacao).trim(),
        impactos: sanitize(item.impactos).trim(),
        medidas_controle: sanitize(item.medidas_controle).trim(),
      };
      return { index, risk };
    })
    .filter(({ risk }) =>
      Object.values(risk).some((value) => value.trim().length > 0),
    )
    .map(({ index, risk }) =>
      [
        `${index + 1}. Perigo: ${risk.perigo}`,
        `Classificação: ${risk.classificacao}`,
        `Impactos: ${risk.impactos}`,
        `Medidas de controle: ${risk.medidas_controle}`,
      ].join("\n"),
    );

  return normalized.length > 0 ? normalized.join("\n\n") : undefined;
}

function formatChecklistAnswer(value?: string) {
  if (value === "sim") return "Sim";
  if (value === "nao") return "Não";
  return "N/A";
}

function formatChecklistCriticality(value?: string) {
  if (value === "critica") return "Crítica";
  if (value === "alta") return "Alta";
  if (value === "media") return "Média";
  if (value === "baixa") return "Baixa";
  return sanitize(value);
}

function buildChecklistRows(values?: AuditChecklistAnswerLike[]) {
  return (values ?? [])
    .filter((answer) => sanitize(answer.question).trim().length > 0)
    .map((answer, index) => ({
      item: `${index + 1}. ${sanitize(answer.sectionTitle)}: ${sanitize(answer.question)}`,
      requirement: answer.requirement,
      evidence: [
        `Resposta: ${formatChecklistAnswer(answer.answer)}`,
        answer.observation ? `Observação: ${answer.observation}` : undefined,
        answer.evidences?.length ? `Fotos anexadas: ${answer.evidences.length}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      classification: formatChecklistCriticality(answer.criticality),
    }));
}

function buildChecklistEvidenceItems(values?: AuditChecklistAnswerLike[]) {
  return (values ?? []).flatMap((answer) =>
    (answer.evidences ?? [])
      .filter((evidence) => sanitize(evidence.dataUrl).startsWith("data:image/"))
      .map((evidence) => ({
        title: `${sanitize(answer.sectionTitle)} - ${sanitize(answer.question)}`,
        description: [
          `Resposta: ${formatChecklistAnswer(answer.answer)}`,
          answer.observation ? `Obs.: ${answer.observation}` : undefined,
        ]
          .filter(Boolean)
          .join(" | "),
        meta: [
          sanitize(evidence.fileName),
          sanitize(answer.requirement),
          evidence.capturedAt ? `Capturada em: ${formatDate(evidence.capturedAt)}` : undefined,
        ]
          .filter(Boolean)
          .join(" | "),
        source: evidence.dataUrl,
      })),
  );
}

export async function drawAuditBlueprint(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  audit: Audit,
  code: string,
  validationUrl: string,
) {
  drawDocumentIdentityRail(ctx, {
    documentType: "Auditoria",
    criticality: sanitize(audit.tipo_auditoria),
    validity: formatDate(audit.data_auditoria),
    documentClass: "compliance",
  });

  drawExecutiveSummaryStrip(ctx, {
    title: "Resumo executivo de auditoria",
    summary: "Síntese de escopo, critério, achados e plano de ação para suporte à decisão gerencial.",
    metrics: [
      { label: "Tipo", value: sanitize(audit.tipo_auditoria), tone: "info" },
      { label: "Auditor", value: sanitize(audit.auditor?.nome), tone: "default" },
      { label: "Não conformidades", value: audit.resultados_nao_conformidades?.length || 0, tone: (audit.resultados_nao_conformidades?.length || 0) > 0 ? "warning" : "success" },
      { label: "Plano de ação", value: audit.plano_acao?.length || 0, tone: "info" },
      { label: "Site", value: sanitize(audit.site?.nome), tone: "info" },
      { label: "Data", value: formatDate(audit.data_auditoria), tone: "default" },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Contexto da auditoria",
    columns: 2,
    fields: [
      { label: "Título", value: audit.titulo },
      { label: "Tipo", value: audit.tipo_auditoria },
      { label: "Data", value: formatDate(audit.data_auditoria) },
      { label: "Auditor", value: audit.auditor?.nome },
      { label: "Site/Obra", value: audit.site?.nome },
      { label: "Representantes", value: audit.representantes_empresa },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Caracterização operacional",
    columns: 2,
    fields: [
      { label: "CNAE", value: audit.caracterizacao?.cnae },
      { label: "Grau de risco", value: audit.caracterizacao?.grau_risco },
      {
        label: "Número de trabalhadores",
        value: audit.caracterizacao?.num_trabalhadores ?? null,
      },
      { label: "Turnos", value: audit.caracterizacao?.turnos },
      {
        label: "Atividades principais",
        value: audit.caracterizacao?.atividades_principais,
      },
    ],
  });

  drawNarrativeSection(ctx, { title: "Objetivo", content: audit.objetivo });
  drawNarrativeSection(ctx, { title: "Escopo", content: audit.escopo });
  drawNarrativeSection(ctx, { title: "Metodologia", content: audit.metodologia });
  drawNarrativeSection(ctx, {
    title: "Referências consultadas",
    content: joinBulletedList(audit.referencias),
  });
  drawNarrativeSection(ctx, {
    title: "Documentos avaliados",
    content: joinBulletedList(audit.documentos_avaliados),
  });

  const checklistRows = buildChecklistRows(
    audit.checklist_respostas as AuditChecklistAnswerLike[] | undefined,
  );
  if (checklistRows.length > 0) {
    drawComplianceTable(
      ctx,
      autoTable,
      "Checklist de auditoria (Sim/Não/N/A)",
      checklistRows,
      { semanticRules: { profile: "audit", columns: [2, 3] } },
    );
  }

  await drawEvidenceGallery(ctx, {
    title: "Evidências fotográficas do checklist",
    items: buildChecklistEvidenceItems(
      audit.checklist_respostas as AuditChecklistAnswerLike[] | undefined,
    ).slice(0, 24),
    strict: false,
  });

  drawNarrativeSection(ctx, {
    title: "Conformidades identificadas",
    content: joinBulletedList(audit.resultados_conformidades),
  });

  drawComplianceTable(
    ctx,
    autoTable,
    "Não conformidades identificadas",
    (audit.resultados_nao_conformidades || []).map(
      (item: AuditNonComplianceLike, index: number) => ({
      item: `NC ${index + 1}: ${item.descricao}`,
      requirement: item.requisito,
      evidence: item.evidencia,
      classification: item.classificacao,
      }),
    ),
    { semanticRules: { profile: "audit", columns: [3] } },
  );

  drawNarrativeSection(ctx, {
    title: "Observações",
    content: joinBulletedList(audit.resultados_observacoes),
  });
  drawNarrativeSection(ctx, {
    title: "Oportunidades de melhoria",
    content: joinBulletedList(audit.resultados_oportunidades),
  });
  drawNarrativeSection(ctx, {
    title: "Avaliação de riscos",
    content: formatRiskEntries(audit.avaliacao_riscos),
  });

  drawActionPlanTable(
    ctx,
    autoTable,
    (audit.plano_acao || []).map((item: AuditActionPlanLike) => ({
      action: `${sanitize(item.item)} - ${sanitize(item.acao)}`,
      owner: sanitize(item.responsavel),
      dueDate: sanitize(item.prazo),
      status: sanitize(item.status),
    })),
    { semanticRules: { profile: "audit" } },
  );

  drawNarrativeSection(ctx, { title: "Parecer final", content: audit.conclusao });

  await drawGovernanceClosingBlock(ctx, {
    code,
    url: validationUrl,
    title: "Validação do documento",
    subtitle: "Use o QR Code ou o código do documento para conferência no portal SGS.",
  });
}
