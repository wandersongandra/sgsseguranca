import type { CatRecord } from "@/services/catsService";
import type { AutoTableFn, PdfContext } from "../core/types";
import { formatDateTime, sanitize } from "../core/format";
import {
  type AuthoritySignature,
  drawDocumentIdentityRail,
  drawExecutiveSummaryStrip,
  drawGovernanceClosingBlock,
  drawMetadataGrid,
  drawNarrativeSection,
  drawSemanticTable,
} from "../components";

type CatAttachmentLike = {
  file_name?: string;
  category?: string;
  file_type?: string;
  uploaded_at?: string;
};

const CAT_STATUS_LABEL: Record<string, string> = {
  aberta: "Aberta",
  investigacao: "Em Investigação",
  fechada: "Fechada",
};

const CAT_GRAVIDADE_LABEL: Record<string, string> = {
  leve: "Leve",
  moderada: "Moderada",
  grave: "Grave",
  fatal: "Fatal",
};

function catStatusTone(status?: string): "danger" | "warning" | "success" | "default" {
  if (status === "aberta") return "danger";
  if (status === "investigacao") return "warning";
  if (status === "fechada") return "success";
  return "default";
}

function resolveCriticality(gravidade?: string) {
  const value = sanitize(gravidade).toLowerCase();
  if (value.includes("fatal")) return "critical";
  if (value.includes("grave")) return "high";
  if (value.includes("moderada")) return "moderate";
  return "low";
}

function buildResponsibilitySignatures(cat: CatRecord): AuthoritySignature[] {
  const signatures: Array<AuthoritySignature | null> = [
    cat.opened_by?.nome
      ? {
          label: "Abertura",
          name: sanitize(cat.opened_by.nome),
          role: "Registro inicial da CAT",
          date: cat.opened_at || undefined,
          image: null,
        }
      : null,
    cat.investigated_by?.nome
      ? {
          label: "Investigação",
          name: sanitize(cat.investigated_by.nome),
          role: "Responsável pela investigação",
          date: cat.investigated_at || undefined,
          image: null,
        }
      : null,
    cat.closed_by?.nome
      ? {
          label: "Fechamento",
          name: sanitize(cat.closed_by.nome),
          role: "Responsável pelo encerramento",
          date: cat.closed_at || undefined,
          image: null,
        }
      : null,
  ];

  return signatures.filter((signature): signature is AuthoritySignature =>
    Boolean(signature),
  );
}

export async function drawCatBlueprint(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  cat: CatRecord,
  code: string,
  validationUrl: string,
) {
  drawDocumentIdentityRail(ctx, {
    documentType: "CAT",
    criticality: resolveCriticality(cat.gravidade),
    validity: formatDateTime(cat.data_ocorrencia),
    documentClass: "compliance",
  });

  drawExecutiveSummaryStrip(ctx, {
    title: "Leitura executiva da CAT",
    summary:
      "Documento institucional de registro de acidente, evolução da apuração, medidas adotadas e rastreabilidade operacional.",
    metrics: [
      { label: "Status", value: CAT_STATUS_LABEL[cat.status] ?? sanitize(cat.status), tone: catStatusTone(cat.status) },
      { label: "Tipo", value: sanitize(cat.tipo), tone: "info" },
      { label: "Gravidade", value: CAT_GRAVIDADE_LABEL[cat.gravidade] ?? sanitize(cat.gravidade), tone: "danger" },
      {
        label: "Trabalhador",
        value: sanitize(cat.worker?.nome),
        tone: "default",
      },
      {
        label: "Local",
        value: sanitize(cat.site?.nome || cat.local_ocorrencia),
        tone: "info",
      },
      {
        label: "Anexos",
        value: cat.attachments?.length || 0,
        tone: (cat.attachments?.length || 0) > 0 ? "success" : "default",
      },
    ],
  });

  drawMetadataGrid(ctx, {
    title: "Identificação da CAT",
    columns: 2,
    fields: [
      { label: "Número", value: cat.numero },
      {
        label: "Data da ocorrência",
        value: formatDateTime(cat.data_ocorrencia),
      },
      { label: "Empresa", value: cat.company?.razao_social || cat.company_id },
      { label: "Obra/Setor", value: cat.site?.nome || "-" },
      { label: "Colaborador", value: cat.worker?.nome || "-" },
      { label: "Local", value: cat.local_ocorrencia || "-" },
      { label: "Tipo", value: cat.tipo },
      { label: "Gravidade", value: CAT_GRAVIDADE_LABEL[cat.gravidade] ?? sanitize(cat.gravidade) },
      {
        label: "Aberta em",
        value: cat.opened_at ? formatDateTime(cat.opened_at) : "-",
      },
      {
        label: "Em investigação em",
        value: cat.investigated_at ? formatDateTime(cat.investigated_at) : "-",
      },
      {
        label: "Fechada em",
        value: cat.closed_at ? formatDateTime(cat.closed_at) : "-",
      },
      { label: "Status atual", value: CAT_STATUS_LABEL[cat.status] ?? sanitize(cat.status) },
    ],
  });

  drawNarrativeSection(ctx, {
    title: "Descrição da ocorrência",
    content: cat.descricao,
  });

  if ((cat.pessoas_envolvidas || []).length) {
    drawNarrativeSection(ctx, {
      title: "Pessoas envolvidas",
      content: (cat.pessoas_envolvidas || []).join(", "),
    });
  }

  drawNarrativeSection(ctx, {
    title: "Ação imediata",
    content: cat.acao_imediata || "Não informada.",
  });

  if (cat.investigacao_detalhes || cat.causa_raiz) {
    drawNarrativeSection(ctx, {
      title: "Investigação e causa raiz",
      content: [cat.investigacao_detalhes, cat.causa_raiz]
        .filter(Boolean)
        .join("\n\n"),
    });
  }

  if (cat.plano_acao_fechamento || cat.licoes_aprendidas) {
    drawNarrativeSection(ctx, {
      title: "Fechamento e lições aprendidas",
      content: [cat.plano_acao_fechamento, cat.licoes_aprendidas]
        .filter(Boolean)
        .join("\n\n"),
    });
  }

  if ((cat.attachments || []).length) {
    drawSemanticTable(ctx, {
      title: "Anexos e evidências",
      tone: "action",
      autoTable,
      head: [["Arquivo", "Categoria", "Tipo", "Data de upload"]],
      body: (cat.attachments || []).map((item: CatAttachmentLike) => [
        sanitize(item.file_name),
        sanitize(item.category),
        sanitize(item.file_type),
        formatDateTime(item.uploaded_at),
      ]),
      semanticRules: { profile: "audit", columns: [1, 2] },
      overrides: {
        styles: { fontSize: 8, cellPadding: 2.2 },
      },
    });
  }

  await drawGovernanceClosingBlock(ctx, {
    code,
    url: validationUrl,
    signatures: buildResponsibilitySignatures(cat),
    title: "Governança e autenticidade",
    subtitle:
      "Valide a CAT por QR Code ou código público no portal institucional.",
  });
}
