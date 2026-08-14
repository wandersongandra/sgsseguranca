import type { NonConformity } from "@/services/nonConformitiesService";
import { NC_STATUS_LABEL, NcStatus } from "@/services/nonConformitiesService";
import type { AutoTableFn, PdfContext } from "../core/types";
import { formatDate, sanitize } from "../core/format";
import {
  drawDocumentIdentityRail,
  drawExecutiveSummaryStrip,
  drawGovernanceClosingBlock,
  drawMetadataGrid,
  drawNarrativeSection,
} from "../components";
import { drawActionPlanTable, drawComplianceTable } from "../tables";
import type { ActionPlanRow } from "../tables/actionPlanTable";

const NC_RISCO_NIVEL_LABEL: Record<string, string> = {
  critico: "Crítico",
  alto: "Alto",
  medio: "Médio",
  baixo: "Baixo",
};

function ncStatusTone(status: string): "danger" | "warning" | "info" | "success" | "default" {
  if (status === NcStatus.ENCERRADA) return "success";
  if (status === NcStatus.AGUARDANDO_VALIDACAO) return "info";
  if (status === NcStatus.EM_ANDAMENTO) return "warning";
  if (status === NcStatus.ABERTA) return "danger";
  return "default";
}

function buildNcActionRows(nc: NonConformity, statusLabel: string): ActionPlanRow[] {
  const rows: ActionPlanRow[] = [];
  if (nc.acao_imediata_descricao) {
    rows.push({
      action: `Imediata: ${sanitize(nc.acao_imediata_descricao)}`,
      owner: sanitize(nc.acao_imediata_responsavel),
      dueDate: formatDate(nc.acao_imediata_data),
      status: sanitize(nc.acao_imediata_status || "Pendente"),
    });
  }
  if (nc.acao_definitiva_descricao) {
    const definitiveLines = [
      `Definitiva: ${sanitize(nc.acao_definitiva_descricao)}`,
      nc.acao_definitiva_recursos ? `Recursos: ${sanitize(nc.acao_definitiva_recursos)}` : "",
      nc.acao_definitiva_prazo && nc.acao_definitiva_data_prevista
        ? `Previsão: ${formatDate(nc.acao_definitiva_data_prevista)}`
        : "",
    ].filter(Boolean);
    rows.push({
      action: definitiveLines.join("\n"),
      owner: sanitize(nc.acao_definitiva_responsavel),
      dueDate: formatDate(nc.acao_definitiva_prazo || nc.acao_definitiva_data_prevista),
      status: statusLabel,
    });
  }
  const preventiveLines = [
    nc.acao_preventiva_medidas ? `Medidas: ${sanitize(nc.acao_preventiva_medidas)}` : "",
    nc.acao_preventiva_treinamento ? `Treinamento: ${sanitize(nc.acao_preventiva_treinamento)}` : "",
    nc.acao_preventiva_revisao_procedimento ? `Revisão procedimento: ${sanitize(nc.acao_preventiva_revisao_procedimento)}` : "",
    nc.acao_preventiva_melhoria_processo ? `Melhoria processo: ${sanitize(nc.acao_preventiva_melhoria_processo)}` : "",
    nc.acao_preventiva_epc_epi ? `EPC/EPI: ${sanitize(nc.acao_preventiva_epc_epi)}` : "",
  ].filter(Boolean);
  if (preventiveLines.length > 0) {
    rows.push({ action: preventiveLines.join("\n"), owner: "-", dueDate: "-", status: "Preventiva" });
  }
  return rows;
}

export async function drawNcBlueprint(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  nc: NonConformity,
  code: string,
  validationUrl: string,
) {
  const statusLabel = NC_STATUS_LABEL[nc.status as NcStatus] ?? sanitize(nc.status);
  const riscoLabel = NC_RISCO_NIVEL_LABEL[nc.risco_nivel?.toLowerCase()] ?? sanitize(nc.risco_nivel);

  drawDocumentIdentityRail(ctx, {
    documentType: "NC",
    criticality: riscoLabel,
    validity: sanitize(nc.verificacao_data ? formatDate(nc.verificacao_data) : "Em aberto"),
    documentClass: "Conformidade",
  });

  drawExecutiveSummaryStrip(ctx, {
    title: "Resumo executivo da NC",
    summary: "Documento de compliance com foco em desvio identificado, requisito violado, plano corretivo e evidências de verificação.",
    metrics: [
      { label: "Código", value: sanitize(nc.codigo_nc), tone: "info" },
      { label: "Status", value: statusLabel, tone: ncStatusTone(nc.status) },
      { label: "Risco", value: riscoLabel, tone: "danger" },
      { label: "Responsável área", value: sanitize(nc.responsavel_area), tone: "default" },
      { label: "Auditor", value: sanitize(nc.auditor_responsavel), tone: "default" },
      { label: "Setor", value: sanitize(nc.local_setor_area), tone: "info" },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Identificação da não conformidade",
    columns: 2,
    fields: [
      { label: "Código", value: nc.codigo_nc },
      { label: "Tipo", value: nc.tipo },
      { label: "Data identificação", value: formatDate(nc.data_identificacao) },
      { label: "Local/Setor", value: nc.local_setor_area },
      { label: "Atividade", value: nc.atividade_envolvida },
      { label: "Responsável área", value: nc.responsavel_area },
      { label: "Auditor", value: nc.auditor_responsavel },
      { label: "Status", value: statusLabel },
    ],
  });

  drawNarrativeSection(ctx, { title: "Descrição do desvio", content: nc.descricao });
  drawNarrativeSection(ctx, { title: "Evidência observada", content: nc.evidencia_observada });
  drawNarrativeSection(ctx, { title: "Risco/Perigo", content: `${sanitize(nc.risco_perigo)} | ${sanitize(nc.risco_associado)}` });

  drawComplianceTable(ctx, autoTable, "Requisito violado e classificação", [
    {
      item: sanitize(nc.tipo),
      requirement: [sanitize(nc.requisito_nr), sanitize(nc.requisito_item), sanitize(nc.requisito_procedimento)].filter((x) => x !== "-").join(" | "),
      evidence: sanitize(nc.evidencia_observada),
      classification: sanitize((nc.classificacao || []).join(", ") || riscoLabel),
    },
  ], { semanticRules: { profile: "nc", columns: [3] } });

  const actionRows = buildNcActionRows(nc, statusLabel);
  drawActionPlanTable(ctx, autoTable, actionRows, { semanticRules: { profile: "nc" } });

  drawNarrativeSection(ctx, { title: "Verificação e resultado", content: nc.verificacao_resultado });
  drawNarrativeSection(ctx, { title: "Observações finais", content: nc.observacoes_gerais });

  await drawGovernanceClosingBlock(ctx, {
    signatures: [
      { label: "Responsável da área", name: sanitize(nc.responsavel_area), role: "Responsável", image: nc.assinatura_responsavel_area || null },
      { label: "Técnico/Auditor", name: sanitize(nc.auditor_responsavel), role: "TST/Auditor", image: nc.assinatura_tecnico_auditor || null },
      { label: "Gestão", name: "Gestão", role: "Gestão", image: nc.assinatura_gestao || null },
    ],
    code,
    url: validationUrl,
    title: "Governança e autenticidade",
    subtitle: "Valide por QR Code ou código no portal público.",
  });
}
