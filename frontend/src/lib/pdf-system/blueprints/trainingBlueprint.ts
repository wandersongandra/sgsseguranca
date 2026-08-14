import type { Training } from "@/services/trainingsService";
import type { Signature } from "@/services/signaturesService";
import type { AutoTableFn, PdfContext } from "../core/types";
import { formatDate, sanitize } from "../core/format";
import {
  drawDocumentIdentityRail,
  drawExecutiveSummaryStrip,
  drawGovernanceClosingBlock,
  drawMetadataGrid,
  drawNarrativeSection,
  drawSemanticTable,
} from "../components";
import {
  resolveSignatureSignerName,
  resolveSignatureSignerRole,
  resolveSignatureTypeLabel,
} from "../signaturePresentation";

export async function drawTrainingBlueprint(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  training: Training,
  signatures: Signature[],
  code: string,
  validationUrl: string,
) {
  const expiryDate = training.data_vencimento
    ? new Date(training.data_vencimento)
    : null;
  const now = new Date();
  const remainingDays = expiryDate
    ? Math.ceil((expiryDate.getTime() - now.getTime()) / 86400000)
    : null;
  const isExpired = remainingDays !== null && remainingDays < 0;
  const isExpiringSoon =
    remainingDays !== null && remainingDays >= 0 && remainingDays <= 30;
  const statusLabel = isExpired
    ? "Vencido"
    : isExpiringSoon
      ? `Vence em ${remainingDays} dias`
      : "Válido";

  drawDocumentIdentityRail(ctx, {
    documentType: "Treinamento",
    criticality: isExpired ? "high" : isExpiringSoon ? "moderate" : "low",
    validity: formatDate(training.data_vencimento),
    documentClass: "training",
  });

  drawExecutiveSummaryStrip(ctx, {
    title: "Resumo de conformidade",
    summary:
      "Leitura objetiva da validade do treinamento, colaborador impactado e potencial bloqueio operacional associado.",
    metrics: [
      {
        label: "Status",
        value: statusLabel,
        tone: isExpired ? "danger" : isExpiringSoon ? "warning" : "success",
      },
      {
        label: "Colaborador",
        value: sanitize(training.user?.nome),
        tone: "default",
      },
      { label: "NR/Código", value: sanitize(training.nr_codigo), tone: "info" },
      {
        label: "Carga horária",
        value: training.carga_horaria ? `${training.carga_horaria}h` : "-",
        tone: "default",
      },
      {
        label: "Obrigatório",
        value: training.obrigatorio_para_funcao ? "Sim" : "Não",
        tone: training.obrigatorio_para_funcao ? "warning" : "default",
      },
      {
        label: "Bloqueia operação",
        value: training.bloqueia_operacao_quando_vencido ? "Sim" : "Não",
        tone: training.bloqueia_operacao_quando_vencido ? "danger" : "default",
      },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Identificação do treinamento",
    columns: 2,
    fields: [
      { label: "Treinamento", value: training.nome },
      { label: "Colaborador", value: training.user?.nome },
      { label: "NR/Código", value: training.nr_codigo },
      { label: "Empresa", value: training.company?.razao_social || training.company_id },
      { label: "Conclusão", value: formatDate(training.data_conclusao) },
      { label: "Vencimento", value: formatDate(training.data_vencimento) },
      {
        label: "Carga horária",
        value: training.carga_horaria ? `${training.carga_horaria}h` : "-",
      },
      { label: "Auditor", value: training.auditado_por?.nome || "-" },
      { label: "Data auditoria", value: formatDate(training.data_auditoria) },
      {
        label: "Obrigatório para função",
        value: training.obrigatorio_para_funcao ? "Sim" : "Não",
      },
    ],
  });

  drawSemanticTable(ctx, {
    title: "Controle de validade e bloqueio",
    tone: "attendance",
    autoTable,
    head: [
      ["Status", "Conclusão", "Vencimento", "Bloqueio operacional", "Restante"],
    ],
    body: [
      [
        statusLabel,
        formatDate(training.data_conclusao),
        formatDate(training.data_vencimento),
        training.bloqueia_operacao_quando_vencido ? "Sim" : "Não",
        remainingDays === null ? "-" : `${remainingDays} dias`,
      ],
    ],
    semanticRules: { profile: "audit", columns: [0, 2, 3, 4] },
  });

  drawNarrativeSection(ctx, {
    title: "Certificado / referência",
    content: training.certificado_url || "Não informado.",
  });

  if (training.notas_auditoria) {
    drawNarrativeSection(ctx, {
      title: "Notas de auditoria",
      content: training.notas_auditoria,
    });
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
    url: validationUrl,
    title: "Governança e comprovação documental",
    subtitle: "Valide a autenticidade por QR Code ou código no portal público.",
  });
}
