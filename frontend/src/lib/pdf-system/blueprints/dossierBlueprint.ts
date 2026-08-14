import type {
  DossierContext,
  EmployeeDossierContext,
  SiteDossierContext,
} from "@/services/dossiersService";
import type { AutoTableFn, PdfContext } from "../core/types";
import { formatDate, formatDateTime, sanitize } from "../core/format";

const DOSSIER_CAT_STATUS_LABEL: Record<string, string> = {
  aberta: "Aberta",
  investigacao: "Em Investigação",
  fechada: "Fechada",
};

const DOSSIER_CAT_GRAVIDADE_LABEL: Record<string, string> = {
  leve: "Leve",
  moderada: "Moderada",
  grave: "Grave",
  fatal: "Fatal",
};
import {
  drawDocumentIdentityRail,
  drawExecutiveSummaryStrip,
  drawGovernanceClosingBlock,
  drawMetadataGrid,
  drawNarrativeSection,
  drawSemanticTable,
} from "../components";

function isEmployeeContext(
  context: DossierContext,
): context is EmployeeDossierContext {
  return context.kind === "employee";
}

function buildExecutiveSummary(context: DossierContext) {
  if (isEmployeeContext(context)) {
    return {
      title: "Leitura executiva do dossiê do colaborador",
      summary:
        "Consolidação institucional de capacitações, entregas de EPI, liberações críticas, CATs e rastreabilidade documental do trabalhador.",
      metrics: [
        {
          label: "Colaborador",
          value: sanitize(context.subject.nome),
          tone: "default" as const,
        },
        {
          label: "Treinamentos",
          value: context.summary.trainings,
          tone: "info" as const,
        },
        {
          label: "EPIs",
          value: context.summary.assignments,
          tone: "success" as const,
        },
        { label: "PTs", value: context.summary.pts, tone: "warning" as const },
        { label: "CATs", value: context.summary.cats, tone: "danger" as const },
        {
          label: "Oficiais",
          value: context.summary.officialDocuments,
          tone: "info" as const,
        },
        {
          label: "Pendências",
          value: context.summary.pendingOfficialDocuments,
          tone: "warning" as const,
        },
      ],
    };
  }

  return {
    title: "Leitura executiva do dossiê da obra/setor",
    summary:
      "Consolidação institucional de efetivo, treinamentos, EPIs, permissões e CATs vinculados ao escopo operacional da unidade.",
    metrics: [
      {
        label: "Obra/Setor",
        value: sanitize(context.subject.nome),
        tone: "default" as const,
      },
      {
        label: "Colaboradores",
        value: context.workers.length,
        tone: "info" as const,
      },
      {
        label: "Treinamentos",
        value: context.summary.trainings,
        tone: "info" as const,
      },
      {
        label: "EPIs",
        value: context.summary.assignments,
        tone: "success" as const,
      },
      {
        label: "Oficiais",
        value: context.summary.officialDocuments,
        tone: "info" as const,
      },
      {
        label: "Pendências",
        value: context.summary.pendingOfficialDocuments,
        tone: "warning" as const,
      },
    ],
  };
}

function drawEmployeeSections(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  context: EmployeeDossierContext,
) {
  drawMetadataGrid(ctx, {
    title: "Identificação do colaborador",
    columns: 2,
    fields: [
      { label: "Nome", value: context.subject.nome },
      { label: "CPF", value: context.subject.cpf || "-" },
      { label: "Função", value: context.subject.funcao || "-" },
      { label: "Perfil", value: context.subject.profileName || "-" },
      { label: "Obra/Setor", value: context.subject.siteName || "-" },
      { label: "Empresa", value: context.companyName || context.companyId },
      { label: "Status", value: context.subject.status ? "Ativo" : "Inativo" },
      { label: "Emitido em", value: formatDateTime(context.generatedAt) },
    ],
  });

  drawSemanticTable(ctx, {
    title: "Treinamentos e validade",
    tone: "attendance",
    autoTable,
    head: [["Treinamento", "NR/Código", "Conclusão", "Vencimento", "Status"]],
    body:
      context.trainings.length > 0
        ? context.trainings.map((item) => [
            sanitize(item.nome),
            sanitize(item.nrCodigo),
            formatDate(item.dataConclusao),
            formatDate(item.dataVencimento),
            sanitize(item.status),
          ])
        : [["-", "-", "-", "-", "Nenhum treinamento encontrado"]],
    semanticRules: { profile: "audit", columns: [4] },
  });

  drawSemanticTable(ctx, {
    title: "Controle de EPIs",
    tone: "action",
    autoTable,
    head: [["EPI", "CA", "Validade CA", "Status", "Entrega", "Devolução"]],
    body:
      context.assignments.length > 0
        ? context.assignments.map((item) => [
            sanitize(item.epiNome),
            sanitize(item.ca),
            formatDate(item.validadeCa),
            sanitize(item.status),
            formatDate(item.entregueEm),
            formatDate(item.devolvidoEm),
          ])
        : [["-", "-", "-", "-", "-", "Nenhuma ficha de EPI encontrada"]],
    semanticRules: { profile: "checklist", columns: [3] },
  });

  drawSemanticTable(ctx, {
    title: "Permissões de trabalho relacionadas",
    tone: "default",
    autoTable,
    head: [["Número", "Título", "Status", "Responsável", "Período"]],
    body:
      context.pts.length > 0
        ? context.pts.map((item) => [
            sanitize(item.numero),
            sanitize(item.titulo),
            sanitize(item.status),
            sanitize(item.responsavel),
            `${formatDateTime(item.dataInicio)} até ${formatDateTime(item.dataFim)}`,
          ])
        : [["-", "-", "-", "-", "Nenhuma PT relacionada"]],
    semanticRules: { profile: "pt", columns: [2] },
  });

  drawSemanticTable(ctx, {
    title: "CATs relacionadas",
    tone: "risk",
    autoTable,
    head: [["Número", "Status", "Gravidade", "Data", "Descrição"]],
    body:
      context.cats.length > 0
        ? context.cats.map((item) => [
            sanitize(item.numero),
            DOSSIER_CAT_STATUS_LABEL[item.status] ?? sanitize(item.status),
            DOSSIER_CAT_GRAVIDADE_LABEL[item.gravidade] ?? sanitize(item.gravidade),
            formatDateTime(item.dataOcorrencia),
            sanitize(item.descricao),
          ])
        : [["-", "-", "-", "-", "Nenhuma CAT relacionada"]],
    semanticRules: { profile: "audit", columns: [1, 2] },
    overrides: {
      styles: { fontSize: 8, cellPadding: 2.1 },
      columnStyles: {
        4: { cellWidth: 58 },
      },
    },
  });
}

function drawSiteSections(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  context: SiteDossierContext,
) {
  drawMetadataGrid(ctx, {
    title: "Identificação da obra/setor",
    columns: 2,
    fields: [
      { label: "Nome", value: context.subject.nome },
      { label: "Empresa", value: context.companyName || context.companyId },
      { label: "Endereço", value: context.subject.endereco || "-" },
      {
        label: "Cidade/UF",
        value:
          [context.subject.cidade, context.subject.estado]
            .filter(Boolean)
            .join(" - ") || "-",
      },
      { label: "Status", value: context.subject.status ? "Ativo" : "Inativo" },
      { label: "Emitido em", value: formatDateTime(context.generatedAt) },
    ],
  });

  drawSemanticTable(ctx, {
    title: "Equipe vinculada",
    tone: "attendance",
    autoTable,
    head: [["Colaborador", "Função", "Perfil", "Status"]],
    body:
      context.workers.length > 0
        ? context.workers.map((item) => [
            sanitize(item.nome),
            sanitize(item.funcao),
            sanitize(item.profileName),
            item.status ? "Ativo" : "Inativo",
          ])
        : [["-", "-", "-", "Nenhum colaborador vinculado"]],
    semanticRules: { profile: "audit", columns: [3] },
  });

  drawSemanticTable(ctx, {
    title: "Treinamentos do escopo",
    tone: "attendance",
    autoTable,
    head: [["Treinamento", "Colaborador", "Conclusão", "Vencimento", "Status"]],
    body:
      context.trainings.length > 0
        ? context.trainings.map((item) => [
            sanitize(item.nome),
            sanitize(item.workerName),
            formatDate(item.dataConclusao),
            formatDate(item.dataVencimento),
            sanitize(item.status),
          ])
        : [["-", "-", "-", "-", "Nenhum treinamento encontrado"]],
    semanticRules: { profile: "audit", columns: [4] },
  });

  drawSemanticTable(ctx, {
    title: "Entregas de EPI do escopo",
    tone: "action",
    autoTable,
    head: [["Colaborador", "EPI", "Status", "Entrega", "Devolução"]],
    body:
      context.assignments.length > 0
        ? context.assignments.map((item) => [
            sanitize(item.workerName),
            sanitize(item.epiNome),
            sanitize(item.status),
            formatDate(item.entregueEm),
            formatDate(item.devolvidoEm),
          ])
        : [["-", "-", "-", "-", "Nenhuma ficha de EPI encontrada"]],
    semanticRules: { profile: "checklist", columns: [2] },
  });

  drawSemanticTable(ctx, {
    title: "PTs e CATs vinculadas",
    tone: "default",
    autoTable,
    head: [["Tipo", "Número", "Status", "Responsável/Colaborador", "Data"]],
    body:
      context.pts.length > 0 || context.cats.length > 0
        ? [
            ...context.pts.map((item) => [
              "PT",
              sanitize(item.numero),
              sanitize(item.status),
              sanitize(item.responsavel),
              formatDateTime(item.dataInicio),
            ]),
            ...context.cats.map((item) => [
              "CAT",
              sanitize(item.numero),
              DOSSIER_CAT_STATUS_LABEL[item.status] ?? sanitize(item.status),
              sanitize(item.workerName),
              formatDateTime(item.dataOcorrencia),
            ]),
          ]
        : [["-", "-", "-", "-", "Nenhum documento relacionado"]],
    semanticRules: { profile: "audit", columns: [2] },
  });
}

export async function drawDossierBlueprint(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  context: DossierContext,
  code: string,
  validationUrl: string,
) {
  drawDocumentIdentityRail(ctx, {
    documentType:
      context.kind === "employee"
        ? "Dossiê do colaborador"
        : "Dossiê da obra/setor",
    criticality: "controlled",
    validity: formatDateTime(context.generatedAt),
    documentClass: "executive",
  });

  drawExecutiveSummaryStrip(ctx, buildExecutiveSummary(context));

  if (isEmployeeContext(context)) {
    drawEmployeeSections(ctx, autoTable, context);
  } else {
    drawSiteSections(ctx, autoTable, context);
  }

  drawSemanticTable(ctx, {
    title: "Índice de documentos oficiais governados",
    tone: "default",
    autoTable,
    head: [["Módulo", "Referência", "Código", "Arquivo", "Disponibilidade"]],
    body:
      context.governedDocumentLines.length > 0
        ? context.governedDocumentLines.map(
            (item) => [
            sanitize(item.modulo_label),
            sanitize(item.referencia),
            sanitize(item.codigo_documento),
            sanitize(item.arquivo),
            item.disponibilidade === "ready"
              ? "Pronto"
              : "Registrado sem URL assinada",
            ],
          )
        : [["-", "-", "-", "-", "Nenhum documento oficial governado relacionado"]],
    semanticRules: { profile: "audit", columns: [0, 4] },
    overrides: {
      styles: { fontSize: 7.6, cellPadding: 2 },
      columnStyles: {
        2: { cellWidth: 38 },
        3: { cellWidth: 48 },
      },
    },
  });

  drawSemanticTable(ctx, {
    title: "Pendências documentais oficiais",
    tone: "risk",
    autoTable,
    head: [["Módulo", "Referência", "Status atual", "Pendência"]],
    body:
      context.pendingGovernedDocumentLines.length > 0
        ? context.pendingGovernedDocumentLines.map(
            (item) => [
            sanitize(item.modulo_label),
            sanitize(item.referencia),
            sanitize(item.status_atual),
            sanitize(item.pendencia),
            ],
          )
        : [["-", "-", "-", "Nenhuma pendência documental oficial identificada"]],
    semanticRules: { profile: "audit", columns: [0, 2] },
    overrides: {
      styles: { fontSize: 7.6, cellPadding: 2 },
      columnStyles: {
        3: { cellWidth: 62 },
      },
    },
  });

  drawSemanticTable(ctx, {
    title: "Índice de anexos de apoio e referências complementares",
    tone: "default",
    autoTable,
    head: [["Tipo", "Referência", "Arquivo", "URL/Chave"]],
    body:
      context.attachmentLines.length > 0
        ? context.attachmentLines.map((item) => [
            sanitize(item.tipo),
            sanitize(item.referencia),
            sanitize(item.arquivo),
            sanitize(item.url),
          ])
        : [["-", "-", "-", "Nenhum anexo complementar relacionado"]],
    semanticRules: { profile: "audit", columns: [0] },
    overrides: {
      styles: { fontSize: 7.6, cellPadding: 2 },
      columnStyles: {
        2: { cellWidth: 40 },
        3: { cellWidth: 78 },
      },
    },
  });

  drawNarrativeSection(ctx, {
    title: "Síntese institucional",
    content:
      context.kind === "employee"
        ? `Dossiê consolidado do colaborador ${context.subject.nome}, distinguindo documentos oficiais governados, pendências documentais e anexos complementares sob trilha institucional.`
        : `Dossiê consolidado da unidade ${context.subject.nome}, distinguindo documentos oficiais governados, pendências documentais e anexos complementares do escopo operacional.`,
  });

  await drawGovernanceClosingBlock(ctx, {
    code,
    url: validationUrl,
    signatures: isEmployeeContext(context)
      ? [
          {
            label: "Titular do dossiê",
            name: sanitize(context.subject.nome),
            role: sanitize(context.subject.funcao || "Colaborador"),
            date: context.generatedAt,
            image: null,
          },
        ]
      : [
          {
            label: "Escopo validado",
            name: sanitize(context.subject.nome),
            role: "Obra/Setor",
            date: context.generatedAt,
            image: null,
          },
        ],
    title: "Governança e autenticidade",
    subtitle:
      "Valide o código público do dossiê para confirmar o escopo institucional desta emissão sob demanda.",
  });
}
