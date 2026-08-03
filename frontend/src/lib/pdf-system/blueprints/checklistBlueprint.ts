import type { Checklist } from "@/services/checklistsService";
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

type ChecklistSubitemLike = { texto?: string };
type ChecklistItemLike = {
  topico_id?: string;
  topico_titulo?: string;
  status?: boolean | string;
  subitens?: ChecklistSubitemLike[];
  ordem_item?: number;
  item?: string;
  tipo_resposta?: string;
  observacao?: string;
};
type ChecklistTopicLike = {
  titulo?: string;
  itens?: ChecklistItemLike[];
};
type ChecklistGroupLike = {
  titulo: string;
  itens: ChecklistItemLike[];
};

function toAlphabeticalLabel(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let current = Math.max(index, 0);
  let label = "";

  do {
    label = alphabet[current % 26] + label;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);

  return `${label})`;
}

function groupChecklistItems(checklist: Checklist) {
  if (Array.isArray(checklist.topicos) && checklist.topicos.length > 0) {
    return checklist.topicos.map((topico: ChecklistTopicLike) => ({
      titulo: sanitize(topico.titulo || "Tópico"),
      itens: Array.isArray(topico.itens) ? topico.itens : [],
    }));
  }

  const items: ChecklistItemLike[] = Array.isArray(checklist.itens)
    ? checklist.itens
    : [];
  const groups = new Map<string, ChecklistGroupLike>();

  items.forEach((item: ChecklistItemLike) => {
    const key = item.topico_id || item.topico_titulo || "legacy-topic";
    if (!groups.has(key)) {
      groups.set(key, {
        titulo: sanitize(item.topico_titulo || "Estrutura principal"),
        itens: [],
      });
    }
    groups.get(key)?.itens.push(item);
  });

  return Array.from(groups.values());
}

function isConforme(status: unknown): boolean {
  return (
    status === true ||
    status === "ok" ||
    status === "sim" ||
    status === "conforme"
  );
}

function isNaoConforme(status: unknown): boolean {
  return status === false || status === "nok" || status === "nao";
}

function statusLabel(status: boolean | string | undefined): string {
  if (
    status === true ||
    status === "ok" ||
    status === "sim" ||
    status === "conforme"
  )
    return "Conforme";
  if (status === false || status === "nok" || status === "nao")
    return "Não Conforme";
  if (status === "na") return "N/A";
  return sanitize(status as string);
}

export async function drawChecklistBlueprint(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  checklist: Checklist,
  signatures: Signature[],
  code: string,
  validationUrl: string,
) {
  const groupedItems = groupChecklistItems(checklist);
  const flattenedItems = groupedItems.flatMap(
    (group: ChecklistGroupLike) => group.itens,
  );
  const totalItems = flattenedItems.length;
  const conformes =
    flattenedItems.filter((item: ChecklistItemLike) => isConforme(item.status))
      .length ?? 0;
  const naoConformes =
    flattenedItems.filter((item: ChecklistItemLike) =>
      isNaoConforme(item.status),
    ).length ?? 0;
  const score = totalItems > 0 ? Math.round((conformes / totalItems) * 100) : 0;

  drawDocumentIdentityRail(ctx, {
    documentType: "Checklist",
    criticality: naoConformes > 0 ? "Alta" : "Baixa",
    validity: formatDate(checklist.data),
    documentClass: "Operacional",
  });

  drawExecutiveSummaryStrip(ctx, {
    title: "Resumo executivo de conformidade",
    summary:
      "Leitura rápida para operação e gestão, com destaque para score, pendências e não conformidades.",
    metrics: [
      {
        label: "Status",
        value: sanitize(checklist.status),
        tone: naoConformes > 0 ? "warning" : "success",
      },
      {
        label: "Score",
        value: `${score}%`,
        tone: score >= 90 ? "success" : score >= 70 ? "warning" : "danger",
      },
      { label: "Itens", value: totalItems, tone: "info" },
      { label: "Conformes", value: conformes, tone: "success" },
      {
        label: "Não conformes",
        value: naoConformes,
        tone: naoConformes > 0 ? "danger" : "success",
      },
      {
        label: "Inspetor",
        value: sanitize(checklist.inspetor?.nome),
        tone: "default",
      },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Contexto do checklist",
    columns: 2,
    fields: [
      { label: "Título", value: checklist.titulo },
      { label: "Categoria", value: checklist.categoria },
      { label: "Data", value: formatDate(checklist.data) },
      { label: "Inspetor", value: checklist.inspetor?.nome },
      { label: "Site/Obra", value: checklist.site?.nome },
      {
        label: "Equipamento",
        value: checklist.equipamento || checklist.maquina,
      },
      { label: "Periodicidade", value: checklist.periodicidade },
      { label: "Tópicos", value: groupedItems.length || 1 },
      { label: "Indicadores", value: `${conformes}/${totalItems} conformes` },
    ],
  });

  drawNarrativeSection(ctx, {
    title: "Escopo e observações gerais",
    content: checklist.descricao,
  });

  if (flattenedItems.length) {
    groupedItems.forEach((group: ChecklistGroupLike, groupIndex: number) => {
      const groupItems = Array.isArray(group.itens) ? group.itens : [];
      if (!groupItems.length) {
        return;
      }

      const groupConformes = groupItems.filter((item: ChecklistItemLike) =>
        isConforme(item.status),
      ).length;
      const groupNaoConformes = groupItems.filter((item: ChecklistItemLike) =>
        isNaoConforme(item.status),
      ).length;

      drawSemanticTable(ctx, {
        title: `${group.titulo || `Tópico ${groupIndex + 1}`} (${groupConformes}/${groupItems.length} conformes)`,
        tone: groupNaoConformes > 0 ? "risk" : "default",
        autoTable,
        head: [["Item avaliado", "Tipo", "Status", "Observação"]],
        body: groupItems.map((item: ChecklistItemLike, index: number) => {
          const subitems = Array.isArray(item.subitens) ? item.subitens : [];
          const itemLabel = [
            `${item.ordem_item || index + 1}. ${sanitize(item.item)}`,
            ...subitems.map(
              (subitem: ChecklistSubitemLike, subitemIndex: number) =>
                `${toAlphabeticalLabel(subitemIndex)} ${sanitize(subitem.texto)}`,
            ),
          ]
            .filter((value) => value.trim().length > 0)
            .join("\n");

          return [
            itemLabel,
            sanitize(item.tipo_resposta?.replace(/_/g, " / ") ?? "Sim / Não"),
            statusLabel(item.status),
            sanitize(item.observacao),
          ];
        }),
        semanticRules: { profile: "checklist", columns: [2] },
        overrides: {
          tableWidth: ctx.contentWidth - 8,
          styles: { fontSize: 7.7, cellPadding: 2.1 },
          columnStyles: {
            0: { cellWidth: 80 },
            1: { cellWidth: 20 },
            2: { cellWidth: 22 },
            3: { cellWidth: 48 },
          },
        },
      });
    });
  }

  await drawGovernanceClosingBlock(ctx, {
    signatures: signatures.map((signature) => ({
      label: resolveSignatureTypeLabel(signature.type),
      name: resolveSignatureSignerName(signature),
      role: resolveSignatureSignerRole(signature),
      date: formatDate(signature.signed_at || signature.created_at),
      // For HMAC, signature_data is a hex string — mark it so GovernanceClosingBlock handles it correctly
      image: signature.signature_data ?? null,
      signatureType: signature.type,
    })),
    code,
    url: validationUrl,
    title: "Governança e autenticidade",
    subtitle: "Valide por QR Code ou código no portal público.",
  });
}
