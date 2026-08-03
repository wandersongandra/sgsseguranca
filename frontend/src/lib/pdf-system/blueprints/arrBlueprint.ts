import type { Arr } from "@/services/arrsService";
import type { AutoTableFn, PdfContext } from "../core/types";
import { formatDate, formatDateTime, sanitize } from "../core/format";
import {
  drawDocumentIdentityRail,
  drawExecutiveSummaryStrip,
  drawGovernanceClosingBlock,
  drawMetadataGrid,
  drawNarrativeSection,
} from "../components";
import { drawParticipantTable } from "../tables";

type ArrParticipantLike = { nome?: string; funcao?: string | null };

const ARR_STATUS_LABEL: Record<string, string> = {
  tratada: "Tratada",
  analisada: "Analisada",
  rascunho: "Rascunho",
  arquivada: "Arquivada",
};

const ARR_RISCO_LABEL: Record<string, string> = {
  critico: "Crítico",
  alto: "Alto",
  medio: "Médio",
  baixo: "Baixo",
};

const ARR_PROBABILITY_LABEL: Record<string, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};

const ARR_SEVERITY_LABEL: Record<string, string> = {
  leve: "Leve",
  moderada: "Moderada",
  grave: "Grave",
  critica: "Crítica",
};

function buildStatusTone(status: string) {
  if (status === "tratada") return "success" as const;
  if (status === "analisada") return "info" as const;
  if (status === "rascunho") return "warning" as const;
  return "default" as const;
}

function buildCriticality(arr: Arr) {
  if (arr.status === "arquivada") return "Arquivado";
  return ARR_RISCO_LABEL[arr.nivel_risco] ?? "Baixo";
}

export async function drawArrBlueprint(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  arr: Arr,
  code: string,
  validationUrl: string,
) {
  const participantCount = arr.participants?.length ?? 0;
  const hasFinalPdfMetadata = Boolean(
    arr.document_code ||
    arr.final_pdf_hash_sha256 ||
    arr.pdf_generated_at ||
    arr.emitted_by,
  );

  drawDocumentIdentityRail(ctx, {
    documentType: "ARR",
    criticality: buildCriticality(arr),
    documentClass: "Operacional",
  });

  drawExecutiveSummaryStrip(ctx, {
    title: "Síntese executiva",
    summary:
      "Registro enxuto para formalizar uma análise rápida de risco, a condição observada em campo e o tratamento imediato definido pela equipe.",
    metrics: [
      {
        label: "Atividade principal",
        value: sanitize(arr.atividade_principal),
        tone: "info",
      },
      {
        label: "Nível de risco",
        value: ARR_RISCO_LABEL[arr.nivel_risco] ?? sanitize(arr.nivel_risco),
        tone:
          arr.nivel_risco === "critico" || arr.nivel_risco === "alto"
            ? "warning"
            : "default",
      },
      {
        label: "Probabilidade",
        value: ARR_PROBABILITY_LABEL[arr.probabilidade] ?? sanitize(arr.probabilidade),
        tone: "default",
      },
      {
        label: "Severidade",
        value: ARR_SEVERITY_LABEL[arr.severidade] ?? sanitize(arr.severidade),
        tone: "default",
      },
      {
        label: "Status",
        value: ARR_STATUS_LABEL[arr.status] ?? sanitize(arr.status),
        tone: buildStatusTone(arr.status),
      },
      {
        label: "Participantes",
        value: participantCount,
        tone: participantCount > 0 ? "success" : "warning",
      },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Contexto documental",
    columns: 2,
    fields: [
      { label: "Título", value: arr.titulo },
      { label: "Empresa", value: arr.company?.razao_social || arr.company_id },
      { label: "Data", value: formatDate(arr.data) },
      { label: "Site / Obra", value: arr.site?.nome || arr.site_id },
      { label: "Frente de trabalho", value: arr.frente_trabalho },
      {
        label: "Responsável",
        value: arr.responsavel?.nome || arr.responsavel_id,
      },
      { label: "Criado em", value: formatDateTime(arr.created_at) },
      { label: "Última atualização", value: formatDateTime(arr.updated_at) },
    ],
  });

  if (hasFinalPdfMetadata) {
    drawMetadataGrid(ctx, {
      title: "Rastreabilidade do PDF final",
      columns: 2,
      fields: [
        { label: "Código documental", value: code },
        {
          label: "Hash SHA-256 do PDF",
          value: arr.final_pdf_hash_sha256
            ? `${arr.final_pdf_hash_sha256.slice(0, 32)}...`
            : "Gerado no registro governado após emissão",
        },
        { label: "PDF gerado em", value: formatDateTime(arr.pdf_generated_at) },
        { label: "Emitido por", value: arr.emitted_by?.nome },
      ],
    });
  }

  drawNarrativeSection(ctx, {
    title: "Descrição / contexto",
    content: arr.descricao,
  });

  drawNarrativeSection(ctx, {
    title: "Condição observada",
    content: arr.condicao_observada,
  });

  drawNarrativeSection(ctx, {
    title: "Risco identificado",
    content: arr.risco_identificado,
  });

  drawNarrativeSection(ctx, {
    title: "Controles imediatos",
    content: arr.controles_imediatos,
  });

  drawNarrativeSection(ctx, {
    title: "Ação recomendada",
    content: arr.acao_recomendada,
  });

  drawNarrativeSection(ctx, {
    title: "EPIs e EPCs aplicáveis",
    content: arr.epi_epc_aplicaveis,
  });

  drawNarrativeSection(ctx, {
    title: "Observações",
    content: arr.observacoes,
  });

  drawParticipantTable(
    ctx,
    autoTable,
    `Participantes (${participantCount})`,
    (arr.participants || []).map((participant: ArrParticipantLike) => ({
      name: participant.nome,
      role: participant.funcao,
    })),
  );

  await drawGovernanceClosingBlock(ctx, {
    signatures: [],
    code,
    url: validationUrl,
    hash: arr.final_pdf_hash_sha256 || undefined,
    title: "Governança e autenticidade",
    subtitle: "Valide o documento pelo QR Code ou pelo código público.",
  });
}
