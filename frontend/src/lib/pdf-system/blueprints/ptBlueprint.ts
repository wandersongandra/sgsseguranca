import type { Pt } from "@/services/ptsService";
import type { Signature } from "@/services/signaturesService";
import type { AutoTableFn, PdfContext } from "../core/types";
import { formatDate, formatDateTime, sanitize } from "../core/format";
import {
  drawDocumentIdentityRail,
  drawEvidenceGallery,
  drawExecutiveSummaryStrip,
  drawGovernanceClosingBlock,
  drawMetadataGrid,
  drawNarrativeSection,
  drawSemanticTable,
} from "../components";
import { drawChecklistTable, drawParticipantTable } from "../tables";
import {
  resolveSignatureSignerName,
  resolveSignatureSignerRole,
  resolveSignatureTypeLabel,
} from "../signaturePresentation";

type ChecklistItem = {
  id?: string;
  pergunta?: string;
  resposta?: string;
  justificativa?: string;
  section?: string;
};

type PtChecklistGroup = {
  title: string;
  enabled: boolean;
  items?: ChecklistItem[];
};

type RapidRiskChecklistItem = {
  pergunta?: string;
  secao?: "basica" | "adicional";
  resposta?: string;
};

type PtExecutorLike = { nome?: string; funcao?: string | null };
type PtReadinessBlocker = {
  issue: string;
  action: string;
};
type PtReadinessSummary = {
  blockers: PtReadinessBlocker[];
  unanswered: number;
  adverse: number;
  pendingSignatures: number;
  requiredSignatureCount: number;
  signedCount: number;
  beforeEvidenceCount: number;
  atmosphericReadingsCount: number;
  selectedActivities: string[];
  ready: boolean;
  monitoringLabel: string;
};

const PT_EVIDENCE_FASE_LABELS: Record<string, string> = {
  antes: "Antes da atividade",
  durante: "Durante a atividade",
  depois: "Depois da atividade",
};

export type PtBlueprintOptions = {
  /**
   * Resolve a foto de evidência no índice dado para um data URL inline.
   * Ausente (ex.: rascunho offline), a galeria degrada para placeholders.
   */
  resolveEvidencePhotoDataUrl?: (photoIndex: number) => Promise<string | null>;
  /**
   * Hash SHA-256 do PDF final governado (quando já emitido). Exibido no bloco de
   * autenticidade para conferência de integridade no portal `/validar`.
   */
  finalPdfHash?: string | null;
};

function hasMeaningfulChecklistContent(items?: ChecklistItem[]) {
  return (
    items?.some(
      (item) => Boolean(item.resposta) || Boolean(item.justificativa?.trim()),
    ) ?? false
  );
}

function buildCriticality(pt: Pt): string {
  const hazardCount = [
    pt.trabalho_altura,
    pt.espaco_confinado,
    pt.trabalho_quente,
    pt.eletricidade,
    pt.escavacao,
  ].filter(Boolean).length;

  if (hazardCount >= 2) return "Crítica (atividades simultâneas)";
  if (hazardCount === 1) return "Alta";
  return "Padrão";
}

function resolveVisibleChecklistGroups(groups: PtChecklistGroup[]) {
  const hasSelectedActivity = groups.some((group) => group.enabled);

  return groups.filter((group) => {
    if (!group.items?.length) {
      return false;
    }

    if (group.enabled) {
      return true;
    }

    return !hasSelectedActivity && hasMeaningfulChecklistContent(group.items);
  });
}

function normalizeAnswer(value?: string) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isAdverseAnswer(value?: string) {
  const answer = normalizeAnswer(value);
  return answer === "nao" || answer === "nao aplicavel";
}

function summarizeChecklistAnswers(items?: ChecklistItem[]) {
  return (items || []).reduce(
    (summary, item) => {
      if (!item.resposta) {
        summary.unanswered += 1;
        return summary;
      }

      if (isAdverseAnswer(item.resposta)) {
        summary.adverse += 1;
      }

      return summary;
    },
    { unanswered: 0, adverse: 0 },
  );
}

function summarizeRapidRiskAnswers(items?: RapidRiskChecklistItem[]) {
  return (items || []).reduce(
    (summary, item) => {
      const answer = normalizeAnswer(item.resposta);
      if (!answer) {
        summary.unanswered += 1;
        return summary;
      }

      if (answer === "nao") {
        summary.adverse += 1;
      }

      return summary;
    },
    { unanswered: 0, adverse: 0 },
  );
}

function resolveAtmosphericMonitoringLabel(items?: ChecklistItem[]) {
  const checklist = items || [];
  const findAnswer = (id: string) =>
    normalizeAnswer(checklist.find((item) => item.id === id)?.resposta);

  if (findAnswer("monitoramento_continuo") === "sim") {
    return "Contínuo";
  }
  if (findAnswer("monitoramento_periodico") === "sim") {
    return "Periódico";
  }
  if (findAnswer("monitoramento_durante") === "sim") {
    return "Durante a atividade";
  }
  return "Não definido no checklist";
}

function buildReadinessSummary(
  pt: Pt,
  visibleChecklistGroups: PtChecklistGroup[],
  signatures: Signature[],
): PtReadinessSummary {
  const selectedActivities = [
    pt.trabalho_altura ? "Trabalho em altura" : null,
    pt.espaco_confinado ? "Espaço confinado" : null,
    pt.trabalho_quente ? "Trabalho a quente" : null,
    pt.eletricidade ? "Eletricidade" : null,
    pt.escavacao ? "Escavação" : null,
  ].filter(Boolean) as string[];

  const checklistSummaries = visibleChecklistGroups.map((group) =>
    summarizeChecklistAnswers(group.items),
  );
  const rapidRiskSummary = summarizeRapidRiskAnswers(
    (pt.analise_risco_rapida_checklist ?? []) as RapidRiskChecklistItem[],
  );
  const recommendationSummary = summarizeChecklistAnswers(
    (pt.recomendacoes_gerais_checklist ?? []) as ChecklistItem[],
  );

  const unanswered =
    rapidRiskSummary.unanswered +
    recommendationSummary.unanswered +
    checklistSummaries.reduce((total, item) => total + item.unanswered, 0);
  const adverse =
    rapidRiskSummary.adverse +
    recommendationSummary.adverse +
    checklistSummaries.reduce((total, item) => total + item.adverse, 0);

  const workerIds = [
    pt.responsavel_id,
    ...(pt.executantes || []).map((executante) => executante.id),
  ].filter(Boolean) as string[];
  const uniqueWorkerIds = Array.from(new Set(workerIds));
  const signedIds = new Set(
    signatures
      .map((signature) => signature.user_id)
      .filter((userId): userId is string => Boolean(userId)),
  );
  const signedCount = uniqueWorkerIds.filter((userId) => signedIds.has(userId)).length;
  const pendingSignatures = Math.max(0, uniqueWorkerIds.length - signedCount);

  const beforeEvidenceCount =
    pt.fotos_evidencia?.filter((photo) => photo.fase === "antes").length || 0;
  const atmosphericReadingsCount = pt.medicoes_atmosfericas?.length || 0;
  const blockers: PtReadinessBlocker[] = [];

  if (!String(pt.numero || "").trim()) {
    blockers.push({
      issue: "Número da PT ausente.",
      action: "Definir o número operacional antes da emissão.",
    });
  }
  if (!String(pt.titulo || "").trim()) {
    blockers.push({
      issue: "Título da atividade ausente.",
      action: "Informar um título claro para a frente de serviço.",
    });
  }
  if (!pt.site_id) {
    blockers.push({
      issue: "Obra/site não definido.",
      action: "Vincular a PT a uma obra válida do tenant.",
    });
  }
  if (!pt.responsavel_id) {
    blockers.push({
      issue: "Responsável de liberação ausente.",
      action: "Definir o responsável que autoriza a atividade.",
    });
  }
  if (selectedActivities.length === 0) {
    blockers.push({
      issue: "Nenhum tipo de trabalho crítico selecionado.",
      action: "Marcar os tipos de trabalho aplicáveis ou classificar a PT como geral.",
    });
  }
  if ((pt.executantes?.length || 0) === 0) {
    blockers.push({
      issue: "Sem executantes vinculados.",
      action: "Vincular a equipe executante antes da liberação.",
    });
  }
  if (pendingSignatures > 0) {
    blockers.push({
      issue: `${pendingSignatures} assinatura(s) pendente(s).`,
      action: "Coletar todas as assinaturas obrigatórias da equipe e do responsável.",
    });
  }
  if (beforeEvidenceCount === 0) {
    blockers.push({
      issue: "Sem evidência fotográfica da condição inicial.",
      action: "Anexar ao menos uma evidência da área antes do início.",
    });
  }
  if (pt.espaco_confinado && atmosphericReadingsCount === 0) {
    blockers.push({
      issue: "Espaço confinado sem leitura atmosférica registrada.",
      action: "Registrar medições antes da entrada e manter monitoramento durante a atividade.",
    });
  }
  if (pt.espaco_confinado && !String(pt.contato_emergencia || "").trim()) {
    blockers.push({
      issue: "Contato de emergência ausente para NR-33.",
      action: "Informar brigada, telefone ou ramal de acionamento.",
    });
  }
  if (pt.espaco_confinado && !String(pt.plano_resgate || "").trim()) {
    blockers.push({
      issue: "Plano de resgate ausente para NR-33.",
      action: "Descrever o método de resgate e a equipe de apoio.",
    });
  }
  if (pt.espaco_confinado && !String(pt.vigia?.nome || pt.vigia_nome || "").trim()) {
    blockers.push({
      issue: "Vigia NR-33 não identificado.",
      action: "Definir vigia dedicado sem atividade concorrente.",
    });
  }
  if (rapidRiskSummary.adverse > 0 && !String(pt.analise_risco_rapida_observacoes || "").trim()) {
    blockers.push({
      issue: "Há respostas críticas na análise rápida sem plano corretivo.",
      action: "Registrar observações com a medida de controle aplicável.",
    });
  }
  if (unanswered > 0) {
    blockers.push({
      issue: `${unanswered} item(ns) de checklist sem resposta.`,
      action: "Concluir os itens pendentes antes da liberação final.",
    });
  }
  if (adverse > 0) {
    blockers.push({
      issue: `${adverse} resposta(s) adversa(s) exigem justificativa ou bloqueio.`,
      action: "Revisar as respostas 'Não/Não aplicável' e anexar justificativas técnicas.",
    });
  }

  return {
    blockers,
    unanswered,
    adverse,
    pendingSignatures,
    requiredSignatureCount: uniqueWorkerIds.length,
    signedCount,
    beforeEvidenceCount,
    atmosphericReadingsCount,
    selectedActivities,
    ready: blockers.length === 0,
    monitoringLabel: resolveAtmosphericMonitoringLabel(
      pt.trabalho_espaco_confinado_checklist as ChecklistItem[] | undefined,
    ),
  };
}

function drawPtOverview(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  pt: Pt,
  aprReference: string,
  validityWindow: string,
  riskInitial: string | number,
  riskResidual: string,
  vigiaLabel: string | undefined,
  fireWatchLabel: string | undefined,
  readiness: PtReadinessSummary,
  checklistTotal: number,
) {
  const status = (pt.status || "").toLowerCase();
  const tone = status.includes("cancel")
    ? "danger"
    : status.includes("pend")
      ? "warning"
      : status.includes("aprov")
        ? "success"
        : "info";
  drawDocumentIdentityRail(ctx, {
    documentType: "PT",
    criticality: buildCriticality(pt),
    validity: validityWindow,
    documentClass: "Permissão de Trabalho",
  });
  drawExecutiveSummaryStrip(ctx, {
    title: "Liberação executiva",
    summary: "Documento de autorização para atividade crítica com requisitos mandatórios, checklist técnico e responsabilização formal.",
    metrics: [
      { label: "Número", value: sanitize(pt.numero), tone: "info" },
      { label: "Status", value: sanitize(pt.status), tone },
      { label: "Prontidão", value: readiness.ready ? "Pronta" : "Bloqueada", tone: readiness.ready ? "success" : "warning" },
      { label: "Responsável", value: sanitize(pt.responsavel?.nome), tone: "default" },
      { label: "Assinaturas", value: `${readiness.signedCount}/${readiness.requiredSignatureCount || 0}`, tone: "default" },
      { label: "Risco residual", value: riskResidual, tone: riskResidual === "HIGH" || riskResidual === "CRITICAL" ? "warning" : "info" },
      { label: "Site", value: sanitize(pt.site?.nome), tone: "info" },
    ],
  });
  drawMetadataGrid(ctx, {
    title: "Dados de liberação",
    columns: 2,
    fields: [
      { label: "Número", value: pt.numero },
      { label: "Título", value: pt.titulo },
      { label: "Responsável", value: pt.responsavel?.nome },
      { label: "Site/Obra", value: pt.site?.nome },
      { label: "APR vinculada", value: aprReference },
      { label: "Início", value: formatDateTime(pt.data_hora_inicio) },
      { label: "Fim", value: formatDateTime(pt.data_hora_fim) },
      { label: "Status", value: pt.status },
    ],
  });
  drawMetadataGrid(ctx, {
    title: "Prontidão operacional",
    columns: 3,
    fields: [
      { label: "Atividades críticas", value: readiness.selectedActivities.length ? readiness.selectedActivities.join(" • ") : "PT geral" },
      { label: "Checklist respondido", value: `${checklistTotal - readiness.unanswered}/${checklistTotal || 0}` },
      { label: "Respostas críticas", value: readiness.adverse },
      { label: "Assinaturas pendentes", value: readiness.pendingSignatures },
      { label: "Evidências fase inicial", value: readiness.beforeEvidenceCount },
      { label: "Leituras NR-33", value: readiness.atmosphericReadingsCount },
    ],
  });
  if (readiness.blockers.length) {
    drawSemanticTable(ctx, {
      title: "Bloqueios antes da liberação",
      tone: "action",
      autoTable,
      head: [["Pendência", "Ação requerida"]],
      body: readiness.blockers.map((blocker) => [blocker.issue, blocker.action]),
      semanticRules: false,
      overrides: { styles: { fontSize: 7.6, cellPadding: 2.1 }, columnStyles: { 0: { cellWidth: 58 }, 1: { cellWidth: 108 } } },
    });
  }
  drawMetadataGrid(ctx, {
    title: "Risco, APR e controles",
    columns: 2,
    fields: [
      { label: "APR vinculada", value: aprReference },
      { label: "Executantes", value: pt.executantes?.length || 0 },
      { label: "Risco inicial", value: riskInitial },
      { label: "Risco residual", value: riskResidual },
      { label: "Probabilidade", value: pt.probability ?? "-" },
      { label: "Severidade", value: pt.severity ?? "-" },
      { label: "Exposição", value: pt.exposure ?? "-" },
      { label: "Evidência de controle", value: pt.control_evidence ? "Registrada" : "Não registrada" },
      { label: "Status de liberação", value: readiness.ready ? "Sem bloqueios críticos" : "Com pendências" },
    ],
  });
  if (pt.control_description) {
    drawNarrativeSection(ctx, { title: "Controles críticos e condições de liberação", content: pt.control_description });
  }
  drawMetadataGrid(ctx, {
    title: "Categorias de trabalho autorizadas",
    columns: 3,
    fields: [
      { label: "Trabalho em altura", value: pt.trabalho_altura ? "Sim" : "Não" },
      { label: "Espaço confinado", value: pt.espaco_confinado ? "Sim" : "Não" },
      { label: "Trabalho a quente", value: pt.trabalho_quente ? "Sim" : "Não" },
      { label: "Eletricidade", value: pt.eletricidade ? "Sim" : "Não" },
      { label: "Escavação", value: pt.escavacao ? "Sim" : "Não" },
    ],
  });
  const hasEmergencyInfo = Boolean(pt.trabalho_altura || pt.contato_emergencia || pt.ponto_encontro || vigiaLabel || fireWatchLabel || pt.epis_obrigatorios?.length || pt.plano_resgate);
  if (!hasEmergencyInfo) return;
  drawMetadataGrid(ctx, {
    title: "Emergência, resgate e EPIs",
    columns: 2,
    fields: [
      { label: "Contato de emergência", value: pt.contato_emergencia },
      { label: "Ponto de encontro", value: pt.ponto_encontro },
      { label: "Vigia NR-33", value: vigiaLabel },
      { label: "Vigia de incêndio", value: fireWatchLabel },
      { label: "EPIs obrigatórios", value: pt.epis_obrigatorios?.length ? pt.epis_obrigatorios.join(" • ") : undefined },
    ],
  });
  if (pt.plano_resgate) {
    drawNarrativeSection(ctx, { title: "Plano de resgate", content: pt.plano_resgate });
  }
}

function drawPtRiskAndChecklists(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  pt: Pt,
  visibleChecklistGroups: PtChecklistGroup[],
) {
  drawNarrativeSection(ctx, { title: "Escopo da atividade autorizada", content: pt.descricao });
  const rapidRiskItems = (pt.analise_risco_rapida_checklist ?? []) as RapidRiskChecklistItem[];
  for (const section of [
    { title: "Análise de risco rápida — Verificações", secao: "basica" as const },
    { title: "Análise de risco rápida — Verificações adicionais", secao: "adicional" as const },
  ]) {
    const items = rapidRiskItems.filter((item) => item.secao === section.secao);
    if (!items.length) continue;
    drawChecklistTable(ctx, autoTable, section.title, items.map((item) => ({ question: item.pergunta, answer: item.resposta })), { semanticRules: { profile: "pt", columns: [1] } });
  }
  if (pt.analise_risco_rapida_observacoes) {
    drawNarrativeSection(ctx, { title: "Análise de risco rápida — Observações", content: pt.analise_risco_rapida_observacoes });
  }
  const recomendacoesItems = pt.recomendacoes_gerais_checklist ?? [];
  if (recomendacoesItems.length) {
    drawChecklistTable(ctx, autoTable, "Recomendações gerais", recomendacoesItems.map((item) => ({ question: item.pergunta, answer: item.resposta, justification: item.justificativa })), { semanticRules: { profile: "pt", columns: [1] } });
  }
  drawParticipantTable(ctx, autoTable, `Equipe executante (${pt.executantes?.length || 0})`, (pt.executantes || []).map((executor: PtExecutorLike) => ({ name: executor.nome, role: executor.funcao })));
  for (const group of visibleChecklistGroups) {
    const items = group.items ?? [];
    const sections = Array.from(new Set(items.map((item) => item.section).filter(Boolean))) as string[];
    if (sections.length) {
      for (const section of sections) {
        const sectionItems = items.filter((item) => item.section === section);
        drawChecklistTable(ctx, autoTable, `${group.title} — ${sanitize(section)}`, sectionItems.map((item) => ({ question: item.pergunta, answer: item.resposta, justification: item.justificativa })), { semanticRules: { profile: "pt", columns: [1] } });
      }
      const unsectioned = items.filter((item) => !item.section);
      if (unsectioned.length) {
        drawChecklistTable(ctx, autoTable, group.title, unsectioned.map((item) => ({ question: item.pergunta, answer: item.resposta, justification: item.justificativa })), { semanticRules: { profile: "pt", columns: [1] } });
      }
      continue;
    }
    drawChecklistTable(ctx, autoTable, group.title, items.map((item) => ({ question: item.pergunta, answer: item.resposta, justification: item.justificativa })), { semanticRules: { profile: "pt", columns: [1] } });
  }
}

async function drawPtEvidenceAndAtmosphere(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  pt: Pt,
  readiness: PtReadinessSummary,
  options?: PtBlueprintOptions,
) {
  if (pt.espaco_confinado && pt.medicoes_atmosfericas?.length) {
    const firstReading = pt.medicoes_atmosfericas[0];
    const lastReading = pt.medicoes_atmosfericas[pt.medicoes_atmosfericas.length - 1];
    drawMetadataGrid(ctx, {
      title: "Controle atmosférico e monitoramento",
      columns: 2,
      fields: [
        { label: "Leituras registradas", value: pt.medicoes_atmosfericas.length },
        { label: "Regime de monitoramento", value: readiness.monitoringLabel },
        { label: "Primeira leitura", value: firstReading ? `${sanitize(firstReading.hora)} • ${sanitize(firstReading.responsavel)}` : undefined },
        { label: "Última leitura", value: lastReading ? `${sanitize(lastReading.hora)} • ${sanitize(lastReading.responsavel)}` : undefined },
      ],
    });
    drawSemanticTable(ctx, {
      title: "Medições atmosféricas (NR-33)", tone: "risk", autoTable,
      head: [["#", "Hora", "O2 (%)", "LEL (%)", "CO (ppm)", "H2S (ppm)", "Instrumento", "Responsável"]],
      body: pt.medicoes_atmosfericas.map((reading, index) => [index + 1, sanitize(reading.hora), reading.oxigenio, reading.inflamaveis_lel, reading.co, reading.h2s, sanitize(reading.instrumento), sanitize(reading.responsavel)]),
      semanticRules: false,
      overrides: { tableWidth: ctx.contentWidth, styles: { fontSize: 7.4, cellPadding: 2 } },
    });
    drawNarrativeSection(ctx, { title: "Critério operacional de parada", content: "Qualquer alteração de atmosfera, perda de ventilação, falha de comunicação ou mudança relevante de cenário exige interrupção imediata, evacuação segura e revalidação da PT/APR antes do reinício." });
  }
  const evidencePhotos = pt.fotos_evidencia ?? [];
  if (evidencePhotos.length) {
    await drawEvidenceGallery(ctx, {
      title: "Evidências fotográficas da área",
      items: evidencePhotos.map((photo) => ({ title: PT_EVIDENCE_FASE_LABELS[photo.fase] ?? photo.fase, description: photo.legenda, meta: photo.uploaded_at ? formatDateTime(photo.uploaded_at) : undefined })),
      resolveImageDataUrl: options?.resolveEvidencePhotoDataUrl ? (_item, index) => options.resolveEvidencePhotoDataUrl!(index) : undefined,
    });
  }
}

async function drawPtClosing(
  ctx: PdfContext,
  pt: Pt,
  signatures: Signature[],
  code: string,
  validationUrl: string,
  options?: PtBlueprintOptions,
) {
  if (pt.status === "Encerrada") {
    drawMetadataGrid(ctx, {
      title: "Encerramento e devolução da área", columns: 2,
      fields: [
        { label: "Encerrado por", value: pt.encerrado_por?.nome },
        { label: "Término real", value: pt.data_hora_real_fim ? formatDateTime(pt.data_hora_real_fim) : undefined },
        { label: "Condição da área", value: pt.condicao_area_encerramento },
      ],
    });
    if (pt.observacoes_encerramento) drawNarrativeSection(ctx, { title: "Observações de encerramento", content: pt.observacoes_encerramento });
  }
  if (pt.aprovado_por_id || pt.reprovado_por_id) {
    const approvalFields = [
      pt.aprovado_por_id ? { label: "Aprovado por (ID)", value: pt.aprovado_por_id } : null,
      pt.aprovado_em ? { label: "Aprovado em", value: formatDateTime(pt.aprovado_em) } : null,
      pt.aprovado_motivo ? { label: "Motivo da aprovação", value: pt.aprovado_motivo } : null,
      pt.reprovado_por_id ? { label: "Reprovado por (ID)", value: pt.reprovado_por_id } : null,
      pt.reprovado_em ? { label: "Reprovado em", value: formatDateTime(pt.reprovado_em) } : null,
      pt.reprovado_motivo ? { label: "Motivo da reprovação", value: pt.reprovado_motivo } : null,
    ].filter((f): f is { label: string; value: string } => Boolean(f));
    if (approvalFields.length) drawMetadataGrid(ctx, { title: "Cadeia de aprovação", columns: 2, fields: approvalFields });
  }
  if (pt.auditado_por_id || pt.data_auditoria) {
    const auditFields = [
      pt.auditado_por?.nome || pt.auditado_por_id ? { label: "Auditado por", value: pt.auditado_por?.nome || pt.auditado_por_id } : null,
      pt.data_auditoria ? { label: "Data da auditoria", value: formatDate(pt.data_auditoria) } : null,
      pt.resultado_auditoria ? { label: "Resultado", value: pt.resultado_auditoria } : null,
    ].filter((f): f is { label: string; value: string } => Boolean(f));
    if (auditFields.length) drawMetadataGrid(ctx, { title: "Auditoria de segurança", columns: 2, fields: auditFields });
    if (pt.notas_auditoria) drawNarrativeSection(ctx, { title: "Notas de auditoria", content: pt.notas_auditoria });
  }
  await drawGovernanceClosingBlock(ctx, {
    signatures: signatures.map((signature) => ({ label: resolveSignatureTypeLabel(signature.type), name: resolveSignatureSignerName(signature), role: resolveSignatureSignerRole(signature), date: formatDate(signature.signed_at || signature.created_at), image: signature.signature_data ?? null })),
    code, hash: options?.finalPdfHash ?? undefined, url: validationUrl,
    title: "Governança, autenticidade e autorização",
    subtitle: ctx.isDraft ? "Prévia local para revisão interna. A emissão oficial exige fluxo governado no SGS." : "Documento válido para auditoria por QR code e identificador público.",
    draft: Boolean(ctx.isDraft),
  });
}

export async function drawPtBlueprint(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  pt: Pt,
  signatures: Signature[],
  code: string,
  validationUrl: string,
  options?: PtBlueprintOptions,
) {
  const status = (pt.status || "").toLowerCase();
  const tone = status.includes("cancel")
    ? "danger"
    : status.includes("pend")
      ? "warning"
      : status.includes("aprov")
        ? "success"
        : "info";
  const visibleChecklistGroups = resolveVisibleChecklistGroups([
    {
      title: "Checklist trabalho em altura",
      enabled: Boolean(pt.trabalho_altura),
      items: pt.trabalho_altura_checklist as ChecklistItem[] | undefined,
    },
    {
      title: "Checklist trabalho elétrico",
      enabled: Boolean(pt.eletricidade),
      items: pt.trabalho_eletrico_checklist as ChecklistItem[] | undefined,
    },
    {
      title: "Checklist trabalho a quente",
      enabled: Boolean(pt.trabalho_quente),
      items: pt.trabalho_quente_checklist as ChecklistItem[] | undefined,
    },
    {
      title: "Checklist espaço confinado",
      enabled: Boolean(pt.espaco_confinado),
      items: pt.trabalho_espaco_confinado_checklist as
        | ChecklistItem[]
        | undefined,
    },
    {
      title: "Checklist escavação",
      enabled: Boolean(pt.escavacao),
      items: pt.trabalho_escavacao_checklist as ChecklistItem[] | undefined,
    },
  ]);
  const checklistTotal = visibleChecklistGroups.reduce(
    (total, group) => total + (group.items?.length || 0),
    0,
  );
  const readiness = buildReadinessSummary(pt, visibleChecklistGroups, signatures);
  const aprReference = sanitize(pt.apr?.numero || pt.apr_id);
  const validityWindow = `${formatDateTime(pt.data_hora_inicio)} até ${formatDateTime(pt.data_hora_fim)}`;
  const riskInitial = pt.initial_risk ?? "-";
  const riskResidual = sanitize(pt.residual_risk);
  const vigiaLabel = pt.vigia?.nome || pt.vigia_nome;
  const fireWatchLabel = pt.trabalho_quente
    ? "Previsto pelo checklist de trabalho a quente"
    : undefined;

  drawDocumentIdentityRail(ctx, {
    documentType: "PT",
    criticality: buildCriticality(pt),
    validity: validityWindow,
    documentClass: "Permissão de Trabalho",
  });

  drawExecutiveSummaryStrip(ctx, {
    title: "Liberação executiva",
    summary:
      "Documento de autorização para atividade crítica com requisitos mandatórios, checklist técnico e responsabilização formal.",
    metrics: [
      { label: "Número", value: sanitize(pt.numero), tone: "info" },
      { label: "Status", value: sanitize(pt.status), tone },
      {
        label: "Prontidão",
        value: readiness.ready ? "Pronta" : "Bloqueada",
        tone: readiness.ready ? "success" : "warning",
      },
      {
        label: "Responsável",
        value: sanitize(pt.responsavel?.nome),
        tone: "default",
      },
      {
        label: "Assinaturas",
        value: `${readiness.signedCount}/${readiness.requiredSignatureCount || 0}`,
        tone: "default",
      },
      {
        label: "Risco residual",
        value: riskResidual,
        tone: riskResidual === "HIGH" || riskResidual === "CRITICAL" ? "warning" : "info",
      },
      { label: "Site", value: sanitize(pt.site?.nome), tone: "info" },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Dados de liberação",
    columns: 2,
    fields: [
      { label: "Número", value: pt.numero },
      { label: "Título", value: pt.titulo },
      { label: "Responsável", value: pt.responsavel?.nome },
      { label: "Site/Obra", value: pt.site?.nome },
      { label: "APR vinculada", value: aprReference },
      { label: "Início", value: formatDateTime(pt.data_hora_inicio) },
      { label: "Fim", value: formatDateTime(pt.data_hora_fim) },
      { label: "Status", value: pt.status },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Prontidão operacional",
    columns: 3,
    fields: [
      {
        label: "Atividades críticas",
        value: readiness.selectedActivities.length
          ? readiness.selectedActivities.join(" • ")
          : "PT geral",
      },
      {
        label: "Checklist respondido",
        value: `${checklistTotal - readiness.unanswered}/${checklistTotal || 0}`,
      },
      {
        label: "Respostas críticas",
        value: readiness.adverse,
      },
      {
        label: "Assinaturas pendentes",
        value: readiness.pendingSignatures,
      },
      {
        label: "Evidências fase inicial",
        value: readiness.beforeEvidenceCount,
      },
      {
        label: "Leituras NR-33",
        value: readiness.atmosphericReadingsCount,
      },
    ],
  });

  if (readiness.blockers.length) {
    drawSemanticTable(ctx, {
      title: "Bloqueios antes da liberação",
      tone: "action",
      autoTable,
      head: [["Pendência", "Ação requerida"]],
      body: readiness.blockers.map((blocker) => [
        blocker.issue,
        blocker.action,
      ]),
      semanticRules: false,
      overrides: {
        styles: { fontSize: 7.6, cellPadding: 2.1 },
        columnStyles: { 0: { cellWidth: 58 }, 1: { cellWidth: 108 } },
      },
    });
  }

  drawMetadataGrid(ctx, {
    title: "Risco, APR e controles",
    columns: 2,
    fields: [
      { label: "APR vinculada", value: aprReference },
      { label: "Executantes", value: pt.executantes?.length || 0 },
      { label: "Risco inicial", value: riskInitial },
      { label: "Risco residual", value: riskResidual },
      { label: "Probabilidade", value: pt.probability ?? "-" },
      { label: "Severidade", value: pt.severity ?? "-" },
      { label: "Exposição", value: pt.exposure ?? "-" },
      {
        label: "Evidência de controle",
        value: pt.control_evidence ? "Registrada" : "Não registrada",
      },
      {
        label: "Status de liberação",
        value: readiness.ready ? "Sem bloqueios críticos" : "Com pendências",
      },
    ],
  });

  if (pt.control_description) {
    drawNarrativeSection(ctx, {
      title: "Controles críticos e condições de liberação",
      content: pt.control_description,
    });
  }

  drawMetadataGrid(ctx, {
    title: "Categorias de trabalho autorizadas",
    columns: 3,
    fields: [
      {
        label: "Trabalho em altura",
        value: pt.trabalho_altura ? "Sim" : "Não",
      },
      { label: "Espaço confinado", value: pt.espaco_confinado ? "Sim" : "Não" },
      { label: "Trabalho a quente", value: pt.trabalho_quente ? "Sim" : "Não" },
      { label: "Eletricidade", value: pt.eletricidade ? "Sim" : "Não" },
      { label: "Escavação", value: pt.escavacao ? "Sim" : "Não" },
    ],
  });

  const hasEmergencyInfo = Boolean(
    pt.trabalho_altura ||
      pt.contato_emergencia ||
      pt.ponto_encontro ||
      vigiaLabel ||
      fireWatchLabel ||
      pt.epis_obrigatorios?.length ||
      pt.plano_resgate,
  );
  if (hasEmergencyInfo) {
    drawMetadataGrid(ctx, {
      title: "Emergência, resgate e EPIs",
      columns: 2,
      fields: [
        { label: "Contato de emergência", value: pt.contato_emergencia },
        { label: "Ponto de encontro", value: pt.ponto_encontro },
        { label: "Vigia NR-33", value: vigiaLabel },
        { label: "Vigia de incêndio", value: fireWatchLabel },
        {
          label: "EPIs obrigatórios",
          value: pt.epis_obrigatorios?.length
            ? pt.epis_obrigatorios.join(" • ")
            : undefined,
        },
      ],
    });
    if (pt.plano_resgate) {
      drawNarrativeSection(ctx, {
        title: "Plano de resgate",
        content: pt.plano_resgate,
      });
    }
  }

  drawNarrativeSection(ctx, {
    title: "Escopo da atividade autorizada",
    content: pt.descricao,
  });

  const rapidRiskItems = (pt.analise_risco_rapida_checklist ??
    []) as RapidRiskChecklistItem[];
  const rapidRiskSections: Array<{
    title: string;
    secao: "basica" | "adicional";
  }> = [
    { title: "Análise de risco rápida — Verificações", secao: "basica" },
    {
      title: "Análise de risco rápida — Verificações adicionais",
      secao: "adicional",
    },
  ];
  for (const section of rapidRiskSections) {
    const items = rapidRiskItems.filter(
      (item) => item.secao === section.secao,
    );
    if (!items.length) continue;
    drawChecklistTable(
      ctx,
      autoTable,
      section.title,
      items.map((item) => ({
        question: item.pergunta,
        answer: item.resposta,
      })),
      { semanticRules: { profile: "pt", columns: [1] } },
    );
  }
  if (pt.analise_risco_rapida_observacoes) {
    drawNarrativeSection(ctx, {
      title: "Análise de risco rápida — Observações",
      content: pt.analise_risco_rapida_observacoes,
    });
  }

  const recomendacoesItems = pt.recomendacoes_gerais_checklist ?? [];
  if (recomendacoesItems.length) {
    drawChecklistTable(
      ctx,
      autoTable,
      "Recomendações gerais",
      recomendacoesItems.map((item) => ({
        question: item.pergunta,
        answer: item.resposta,
        justification: item.justificativa,
      })),
      { semanticRules: { profile: "pt", columns: [1] } },
    );
  }

  drawParticipantTable(
    ctx,
    autoTable,
    `Equipe executante (${pt.executantes?.length || 0})`,
    (pt.executantes || []).map((executor: PtExecutorLike) => ({
      name: executor.nome,
      role: executor.funcao,
    })),
  );

  for (const group of visibleChecklistGroups) {
    const items = group.items ?? [];
    const sections = Array.from(
      new Set(items.map((item) => item.section).filter(Boolean)),
    ) as string[];

    if (sections.length) {
      for (const section of sections) {
        const sectionItems = items.filter((item) => item.section === section);
        // `section` vem de dado do usuário (item.section nos checklists de
        // espaço confinado/escavação) e é embutido no título da tabela, que
        // chega a doc.text() sem passar pela sanitização de corpo — sanitizar
        // aqui evita injeção de caracteres de controle no PDF.
        drawChecklistTable(
          ctx,
          autoTable,
          `${group.title} — ${sanitize(section)}`,
          sectionItems.map((item) => ({
            question: item.pergunta,
            answer: item.resposta,
            justification: item.justificativa,
          })),
          { semanticRules: { profile: "pt", columns: [1] } },
        );
      }
      const unsectioned = items.filter((item) => !item.section);
      if (unsectioned.length) {
        drawChecklistTable(
          ctx,
          autoTable,
          group.title,
          unsectioned.map((item) => ({
            question: item.pergunta,
            answer: item.resposta,
            justification: item.justificativa,
          })),
          { semanticRules: { profile: "pt", columns: [1] } },
        );
      }
      continue;
    }

    drawChecklistTable(
      ctx,
      autoTable,
      group.title,
      items.map((item) => ({
        question: item.pergunta,
        answer: item.resposta,
        justification: item.justificativa,
      })),
      { semanticRules: { profile: "pt", columns: [1] } },
    );
  }

  if (pt.espaco_confinado && pt.medicoes_atmosfericas?.length) {
    const firstReading = pt.medicoes_atmosfericas[0];
    const lastReading = pt.medicoes_atmosfericas[pt.medicoes_atmosfericas.length - 1];
    const atmosphericTableWidth = ctx.contentWidth;
    const atmosphericColumnWidths = {
      0: { cellWidth: 7 },
      1: { cellWidth: 13 },
      2: { cellWidth: 14 },
      3: { cellWidth: 14 },
      4: { cellWidth: 18 },
      5: { cellWidth: 18 },
      6: { cellWidth: 43 },
      7: { cellWidth: atmosphericTableWidth - 127 },
    };

    drawMetadataGrid(ctx, {
      title: "Controle atmosférico e monitoramento",
      columns: 2,
      fields: [
        {
          label: "Leituras registradas",
          value: pt.medicoes_atmosfericas.length,
        },
        {
          label: "Regime de monitoramento",
          value: readiness.monitoringLabel,
        },
        {
          label: "Primeira leitura",
          value: firstReading
            ? `${sanitize(firstReading.hora)} • ${sanitize(firstReading.responsavel)}`
            : undefined,
        },
        {
          label: "Última leitura",
          value: lastReading
            ? `${sanitize(lastReading.hora)} • ${sanitize(lastReading.responsavel)}`
            : undefined,
        },
      ],
    });

    drawSemanticTable(ctx, {
      title: "Medições atmosféricas (NR-33)",
      tone: "risk",
      autoTable,
      head: [
        [
          "#",
          "Hora",
          "O2 (%)",
          "LEL (%)",
          "CO (ppm)",
          "H2S (ppm)",
          "Instrumento",
          "Responsável",
        ],
      ],
      body: pt.medicoes_atmosfericas.map((reading, index) => [
        index + 1,
        sanitize(reading.hora),
        reading.oxigenio,
        reading.inflamaveis_lel,
        reading.co,
        reading.h2s,
        sanitize(reading.instrumento),
        sanitize(reading.responsavel),
      ]),
      semanticRules: false,
      overrides: {
        tableWidth: atmosphericTableWidth,
        styles: { fontSize: 7.4, cellPadding: 2 },
        columnStyles: atmosphericColumnWidths,
      },
    });

    drawNarrativeSection(ctx, {
      title: "Critério operacional de parada",
      content:
        "Qualquer alteração de atmosfera, perda de ventilação, falha de comunicação ou mudança relevante de cenário exige interrupção imediata, evacuação segura e revalidação da PT/APR antes do reinício.",
    });
  }

  const evidencePhotos = pt.fotos_evidencia ?? [];
  if (evidencePhotos.length) {
    await drawEvidenceGallery(ctx, {
      title: "Evidências fotográficas da área",
      items: evidencePhotos.map((photo) => ({
        title: PT_EVIDENCE_FASE_LABELS[photo.fase] ?? photo.fase,
        description: photo.legenda,
        meta: photo.uploaded_at ? formatDateTime(photo.uploaded_at) : undefined,
      })),
      resolveImageDataUrl: options?.resolveEvidencePhotoDataUrl
        ? (_item, index) => options.resolveEvidencePhotoDataUrl!(index)
        : undefined,
    });
  }

  if (pt.status === "Encerrada") {
    drawMetadataGrid(ctx, {
      title: "Encerramento e devolução da área",
      columns: 2,
      fields: [
        { label: "Encerrado por", value: pt.encerrado_por?.nome },
        {
          label: "Término real",
          value: pt.data_hora_real_fim
            ? formatDateTime(pt.data_hora_real_fim)
            : undefined,
        },
        {
          label: "Condição da área",
          value: pt.condicao_area_encerramento,
        },
      ],
    });
    if (pt.observacoes_encerramento) {
      drawNarrativeSection(ctx, {
        title: "Observações de encerramento",
        content: pt.observacoes_encerramento,
      });
    }
  }

  if (pt.aprovado_por_id || pt.reprovado_por_id) {
    const approvalFields = [
      pt.aprovado_por_id
        ? { label: "Aprovado por (ID)", value: pt.aprovado_por_id }
        : null,
      pt.aprovado_em
        ? { label: "Aprovado em", value: formatDateTime(pt.aprovado_em) }
        : null,
      pt.aprovado_motivo
        ? { label: "Motivo da aprovação", value: pt.aprovado_motivo }
        : null,
      pt.reprovado_por_id
        ? { label: "Reprovado por (ID)", value: pt.reprovado_por_id }
        : null,
      pt.reprovado_em
        ? { label: "Reprovado em", value: formatDateTime(pt.reprovado_em) }
        : null,
      pt.reprovado_motivo
        ? { label: "Motivo da reprovação", value: pt.reprovado_motivo }
        : null,
    ].filter((f): f is { label: string; value: string } => Boolean(f));

    if (approvalFields.length) {
      drawMetadataGrid(ctx, {
        title: "Cadeia de aprovação",
        columns: 2,
        fields: approvalFields,
      });
    }
  }

  if (pt.auditado_por_id || pt.data_auditoria) {
    const auditFields = [
      pt.auditado_por?.nome || pt.auditado_por_id
        ? {
            label: "Auditado por",
            value: pt.auditado_por?.nome || pt.auditado_por_id,
          }
        : null,
      pt.data_auditoria
        ? { label: "Data da auditoria", value: formatDate(pt.data_auditoria) }
        : null,
      pt.resultado_auditoria
        ? { label: "Resultado", value: pt.resultado_auditoria }
        : null,
    ].filter((f): f is { label: string; value: string } => Boolean(f));

    if (auditFields.length) {
      drawMetadataGrid(ctx, {
        title: "Auditoria de segurança",
        columns: 2,
        fields: auditFields,
      });
    }
    if (pt.notas_auditoria) {
      drawNarrativeSection(ctx, {
        title: "Notas de auditoria",
        content: pt.notas_auditoria,
      });
    }
  }

  await drawGovernanceClosingBlock(ctx, {
    signatures: signatures.map((signature) => ({
      label: resolveSignatureTypeLabel(signature.type),
      name: resolveSignatureSignerName(signature),
      role: resolveSignatureSignerRole(signature),
      date: formatDate(signature.signed_at || signature.created_at),
      image: signature.signature_data ?? null,
    })),
    code,
    hash: options?.finalPdfHash ?? undefined,
    url: validationUrl,
    title: "Governança, autenticidade e autorização",
    subtitle: ctx.isDraft
      ? "Prévia local para revisão interna. A emissão oficial exige fluxo governado no SGS."
      : "Documento válido para auditoria por QR code e identificador público.",
    draft: Boolean(ctx.isDraft),
  });
}
