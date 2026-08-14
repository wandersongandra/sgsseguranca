import type { Rdo } from "@/services/rdosService";
import type { AutoTableFn, PdfContext } from "../core/types";
import { formatDate, sanitize } from "../core/format";
import {
  drawDocumentIdentityRail,
  drawEvidenceGallery,
  drawExecutiveSummaryStrip,
  drawGovernanceClosingBlock,
  drawMetadataGrid,
  drawNarrativeSection,
  drawSemanticTable,
} from "../components";

type RdoSignature = {
  label: string;
  name: string;
  role: string;
  date?: string;
  image?: string | null;
};

type RdoLaborLike = {
  quantidade?: number | null;
  funcao?: string;
  turno?: string;
  horas?: number | string | null;
};

type RdoEquipmentLike = {
  nome?: string;
  quantidade?: number | null;
  horas_trabalhadas?: number | null;
  horas_ociosas?: number | null;
  observacao?: string;
};

type RdoMaterialLike = {
  descricao?: string;
  unidade?: string;
  quantidade?: number | null;
  fornecedor?: string;
};

type RdoServiceLike = {
  descricao?: string;
  percentual_concluido?: number | string | null;
  observacao?: string;
  fotos?: unknown[] | null;
};

type RdoActivityPhotoGalleryResolver = (
  activityIndex: number,
  photoIndex: number,
  photoReference: string | null,
) => Promise<string | null>;

type RdoOccurrenceLike = {
  tipo?: string;
  descricao?: string;
  hora?: string;
};

function buildClimateLabel(value?: string | null) {
  const labels: Record<string, string> = {
    ensolarado: "Ensolarado",
    nublado: "Nublado",
    chuvoso: "Chuvoso",
    parcialmente_nublado: "Parcialmente nublado",
  };

  return sanitize(labels[value || ""] || value || "-");
}

function buildLocationLabel(rdo: Rdo) {
  const city = rdo.site?.cidade?.trim();
  const state = rdo.site?.estado?.trim();

  if (city && state) return `${city}/${state}`;
  if (city) return city;
  if (state) return state;
  return "-";
}

function buildSiteLine(rdo: Rdo) {
  const site = rdo.site?.nome?.trim();
  const location = buildLocationLabel(rdo);

  if (site && location !== "-") {
    return `${site} - ${location}`;
  }

  return site || location;
}

const RDO_STATUS_LABEL: Record<string, string> = {
  rascunho: "Rascunho",
  enviado: "Enviado",
  aprovado: "Aprovado",
  cancelado: "Cancelado",
};

function buildStatusTone(status?: string) {
  const normalized = String(status || "").toLowerCase();
  if (normalized.includes("aprov")) return "success" as const;
  if (normalized.includes("envi")) return "info" as const;
  if (normalized.includes("rascun")) return "warning" as const;
  return "default" as const;
}

function buildCriticality(rdo: Rdo) {
  if (rdo.houve_acidente) return "Alta";
  if (rdo.houve_paralisacao) return "Moderada";
  if (String(rdo.status || "").toLowerCase() === "aprovado") return "Controlada";
  return "Monitorado";
}

function buildTemperatureRange(rdo: Rdo) {
  if (rdo.temperatura_min == null && rdo.temperatura_max == null) {
    return "-";
  }

  const min = rdo.temperatura_min != null ? `${rdo.temperatura_min}°C` : "-";
  const max = rdo.temperatura_max != null ? `${rdo.temperatura_max}°C` : "-";
  return `${min} a ${max}`;
}

function buildOperationalSummary(rdo: Rdo) {
  const segments = [
    `Registro operacional do dia ${formatDate(rdo.data)} para ${sanitize(buildSiteLine(rdo))}.`,
    `Status atual: ${sanitize(rdo.status)}.`,
    `Responsável principal: ${sanitize(rdo.responsavel?.nome)}.`,
    `Mobilização registrada com ${(rdo.mao_de_obra || []).reduce((sum: number, item: RdoLaborLike) => sum + (item.quantidade || 0), 0)} trabalhador(es), ${(rdo.equipamentos || []).length} equipamento(s), ${(rdo.servicos_executados || []).length} serviço(s) executado(s) e ${(rdo.servicos_executados || []).reduce((sum: number, item: RdoServiceLike) => sum + (item.fotos?.length || 0), 0)} evidência(s) fotográfica(s).`,
  ];

  if (rdo.houve_acidente) {
    segments.push("Há registro de acidente e o fechamento deste documento exige leitura prioritária.");
  }

  if (rdo.houve_paralisacao) {
    segments.push(
      `Houve paralisação operacional${rdo.motivo_paralisacao ? ` por ${sanitize(rdo.motivo_paralisacao)}` : ""}.`,
    );
  }

  return segments.join(" ");
}

export async function drawRdoBlueprint(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  rdo: Rdo,
  signatures: RdoSignature[],
  code: string,
  validationUrl: string,
  resolveActivityPhotoImageDataUrl?: RdoActivityPhotoGalleryResolver,
  strictEvidence = false,
) {
  const totalWorkers = (rdo.mao_de_obra || []).reduce(
    (sum: number, item: RdoLaborLike) => sum + (item.quantidade || 0),
    0,
  );
  const totalEquipment = (rdo.equipamentos || []).length;
  const totalMaterials = (rdo.materiais_recebidos || []).length;
  const totalServices = (rdo.servicos_executados || []).length;
  const totalActivityPhotos = (rdo.servicos_executados || []).reduce(
    (sum: number, item: RdoServiceLike) => sum + (item.fotos?.length || 0),
    0,
  );
  const totalOccurrences = (rdo.ocorrencias || []).length;
  const statusTone = buildStatusTone(rdo.status);

  drawDocumentIdentityRail(ctx, {
    documentType: "RDO",
    criticality: buildCriticality(rdo),
    validity: formatDate(rdo.data),
    documentClass: "Operacional",
  });

  drawExecutiveSummaryStrip(ctx, {
    title: "Leitura executiva do dia",
    summary:
      "Painel sintético para acompanhamento rápido da obra, com status, liderança responsável e volume operacional registrado no período.",
    metrics: [
      { label: "Status", value: RDO_STATUS_LABEL[rdo.status] ?? sanitize(rdo.status), tone: statusTone },
      {
        label: "Responsável",
        value: sanitize(rdo.responsavel?.nome),
        tone: "default",
      },
      { label: "Trabalhadores", value: totalWorkers, tone: totalWorkers > 0 ? "success" : "warning" },
      { label: "Equipamentos", value: totalEquipment, tone: totalEquipment > 0 ? "info" : "default" },
      { label: "Serviços", value: totalServices, tone: totalServices > 0 ? "success" : "default" },
      {
        label: "Fotos",
        value: totalActivityPhotos,
        tone: totalActivityPhotos > 0 ? "info" : "default",
      },
      {
        label: "Ocorrências",
        value: totalOccurrences,
        tone: totalOccurrences > 0 || rdo.houve_acidente ? "warning" : "default",
      },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Identificação do documento",
    columns: 2,
    fields: [
      { label: "Número do RDO", value: rdo.numero },
      { label: "Data do registro", value: formatDate(rdo.data) },
      { label: "Obra / Unidade", value: rdo.site?.nome || rdo.site_id },
      { label: "Cidade / UF", value: buildLocationLabel(rdo) },
      { label: "Empresa", value: rdo.company?.razao_social || rdo.company_id },
      { label: "Responsável", value: rdo.responsavel?.nome || rdo.responsavel_id },
      { label: "Status operacional", value: RDO_STATUS_LABEL[rdo.status] ?? sanitize(rdo.status) },
      { label: "Condição do terreno", value: rdo.condicao_terreno || "-" },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Condições operacionais do dia",
    columns: 3,
    fields: [
      { label: "Clima manhã", value: buildClimateLabel(rdo.clima_manha) },
      { label: "Clima tarde", value: buildClimateLabel(rdo.clima_tarde) },
      { label: "Temperatura", value: buildTemperatureRange(rdo) },
      { label: "Acidente registrado", value: rdo.houve_acidente ? "Sim" : "Não" },
      { label: "Paralisação", value: rdo.houve_paralisacao ? "Sim" : "Não" },
      { label: "Motivo da paralisação", value: rdo.motivo_paralisacao || "-" },
      { label: "Materiais recebidos", value: totalMaterials },
      { label: "Serviços executados", value: totalServices },
      { label: "Fotos em atividades", value: totalActivityPhotos },
      { label: "Ocorrências", value: totalOccurrences },
    ],
  });

  drawNarrativeSection(ctx, {
    title: "Síntese operacional do dia",
    content: buildOperationalSummary(rdo),
  });

  if ((rdo.mao_de_obra || []).length > 0) {
    drawSemanticTable(ctx, {
      title: `Mão de obra mobilizada (${totalWorkers} trabalhador(es))`,
      autoTable,
      tone: "attendance",
      head: [["Função", "Quantidade", "Turno", "Horas"]],
      body: (rdo.mao_de_obra || []).map((item: RdoLaborLike) => [
        sanitize(item.funcao),
        String(item.quantidade ?? 0),
        sanitize(item.turno),
        `${sanitize(item.horas ?? 0)} h`,
      ]),
      overrides: {
        tableWidth: ctx.contentWidth - 8,
        styles: { fontSize: 7.6, cellPadding: 2 },
        columnStyles: {
          0: { cellWidth: 56 },
          1: { cellWidth: 18 },
          2: { cellWidth: 28 },
          3: { cellWidth: ctx.contentWidth - 8 - 56 - 18 - 28 },
        },
      },
    });
  }

  if ((rdo.equipamentos || []).length > 0) {
    drawSemanticTable(ctx, {
      title: `Equipamentos e disponibilidade (${totalEquipment})`,
      autoTable,
      tone: "default",
      head: [["Equipamento", "Qtd.", "H. trab.", "H. ociosas", "Observação"]],
      body: (rdo.equipamentos || []).map((item: RdoEquipmentLike) => [
        sanitize(item.nome),
        String(item.quantidade ?? 0),
        String(item.horas_trabalhadas ?? 0),
        String(item.horas_ociosas ?? 0),
        sanitize(item.observacao || "-"),
      ]),
      overrides: {
        tableWidth: ctx.contentWidth - 8,
        styles: { fontSize: 7.6, cellPadding: 2 },
        columnStyles: {
          0: { cellWidth: 48 },
          1: { cellWidth: 14 },
          2: { cellWidth: 18 },
          3: { cellWidth: 18 },
          4: { cellWidth: ctx.contentWidth - 8 - 48 - 14 - 18 - 18 },
        },
      },
    });
  }

  if ((rdo.materiais_recebidos || []).length > 0) {
    drawSemanticTable(ctx, {
      title: `Materiais recebidos (${totalMaterials})`,
      autoTable,
      tone: "action",
      head: [["Descrição", "Unidade", "Quantidade", "Fornecedor"]],
      body: (rdo.materiais_recebidos || []).map((item: RdoMaterialLike) => [
        sanitize(item.descricao),
        sanitize(item.unidade),
        String(item.quantidade ?? 0),
        sanitize(item.fornecedor || "-"),
      ]),
      overrides: {
        tableWidth: ctx.contentWidth - 8,
        styles: { fontSize: 7.6, cellPadding: 2 },
        columnStyles: {
          0: { cellWidth: 64 },
          1: { cellWidth: 18 },
          2: { cellWidth: 20 },
          3: { cellWidth: ctx.contentWidth - 8 - 64 - 18 - 20 },
        },
      },
    });
  }

  if ((rdo.servicos_executados || []).length > 0) {
    drawSemanticTable(ctx, {
      title: `Frentes e serviços executados (${totalServices})`,
      autoTable,
      tone: "action",
      head: [["Serviço executado", "% concl.", "Observação", "Fotos"]],
      body: (rdo.servicos_executados || []).map((item: RdoServiceLike) => [
        sanitize(item.descricao),
        `${sanitize(item.percentual_concluido ?? 0)}%`,
        sanitize(item.observacao || "-"),
        String(item.fotos?.length ?? 0),
      ]),
      overrides: {
        tableWidth: ctx.contentWidth - 8,
        styles: { fontSize: 7.6, cellPadding: 2 },
        columnStyles: {
          0: { cellWidth: 62 },
          1: { cellWidth: 18 },
          2: { cellWidth: 44 },
          3: { cellWidth: ctx.contentWidth - 8 - 62 - 18 - 44 },
        },
      },
    });
  }

  if ((rdo.ocorrencias || []).length > 0) {
    drawSemanticTable(ctx, {
      title: `Ocorrências e registros do dia (${totalOccurrences})`,
      autoTable,
      tone: "risk",
      head: [["Tipo", "Descrição", "Hora"]],
      body: (rdo.ocorrencias || []).map((item: RdoOccurrenceLike) => [
        sanitize(item.tipo),
        sanitize(item.descricao),
        sanitize(item.hora || "-"),
      ]),
      semanticRules: { columns: [0] },
      overrides: {
        tableWidth: ctx.contentWidth - 8,
        styles: { fontSize: 7.6, cellPadding: 2 },
        columnStyles: {
          0: { cellWidth: 30 },
          1: { cellWidth: 110 },
          2: { cellWidth: ctx.contentWidth - 8 - 30 - 110 },
        },
      },
    });
  }

  const evidenceReferences = (rdo.servicos_executados || []).flatMap(
    (service: RdoServiceLike, activityIndex: number) =>
      (service.fotos || []).map((photoReference, photoIndex) => ({
        activityIndex,
        photoIndex,
        reference:
          typeof photoReference === "string" ? photoReference : "",
        service,
      })),
  );
  const evidenceItems = evidenceReferences.map(
    ({ activityIndex, photoIndex, reference, service }) => ({
      title: `Atividade ${activityIndex + 1} - Foto ${photoIndex + 1}`,
      description: sanitize(
        service.descricao || "Registro fotográfico de atividade.",
      ),
      meta: `Atividade ${activityIndex + 1} • Foto ${photoIndex + 1} • ${service.percentual_concluido ?? 0}% concluído`,
      source: reference || undefined,
    }),
  );

  if (evidenceItems.length > 0) {
    await drawEvidenceGallery(ctx, {
      title: `Galeria fotográfica das atividades (${evidenceItems.length})`,
      items: evidenceItems,
      strict: strictEvidence,
      resolveImageDataUrl: resolveActivityPhotoImageDataUrl
        ? async (_item, index) => {
            const target = evidenceReferences[index];
            if (!target) {
              return null;
            }

            return resolveActivityPhotoImageDataUrl(
              target.activityIndex,
              target.photoIndex,
              target.reference,
            );
          }
        : undefined,
    });
  }

  drawNarrativeSection(ctx, {
    title: "Observações gerais",
    content: rdo.observacoes,
  });

  drawNarrativeSection(ctx, {
    title: "Programação prevista para o próximo dia",
    content: rdo.programa_servicos_amanha,
  });

  await drawGovernanceClosingBlock(ctx, {
    signatures,
    code,
    url: validationUrl,
    title: "Fechamento oficial, assinaturas e autenticidade",
    subtitle:
      "Documento oficial de obra com validação pública por QR Code e identificador documental.",
  });
}
