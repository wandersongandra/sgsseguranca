import api, { TIMEOUT_PDF } from "@/lib/api";
import type { GovernedPdfAccessResponse, GovernedPdfAccessAvailability } from "@/lib/api/generated/governed-contracts.client";
import { Site } from "./sitesService";
import { fetchAllPages, PaginatedResponse } from "./pagination";
import { assertNonConformityActionAvailable } from "@/lib/offline-capabilities";

export interface NonConformity {
  id: string;
  codigo_nc: string;
  tipo: string;
  data_identificacao: string;
  local_setor_area: string;
  checklist_id?: string | null; // linkage opcional para rastreabilidade de inspeção/checklist
  atividade_envolvida: string;
  responsavel_area: string;
  auditor_responsavel: string;
  classificacao?: string[];
  descricao: string;
  evidencia_observada: string;
  condicao_insegura: string;
  ato_inseguro?: string;
  requisito_nr: string;
  requisito_item: string;
  requisito_procedimento?: string;
  requisito_politica?: string;
  risco_perigo: string;
  risco_associado: string;
  risco_consequencias?: string[];
  risco_nivel: string;
  causa?: string[];
  causa_outro?: string;
  acao_imediata_descricao?: string;
  acao_imediata_data?: string;
  acao_imediata_responsavel?: string;
  acao_imediata_status?: string;
  acao_definitiva_descricao?: string;
  acao_definitiva_prazo?: string;
  acao_definitiva_responsavel?: string;
  acao_definitiva_recursos?: string;
  acao_definitiva_data_prevista?: string;
  acao_preventiva_medidas?: string;
  acao_preventiva_treinamento?: string;
  acao_preventiva_revisao_procedimento?: string;
  acao_preventiva_melhoria_processo?: string;
  acao_preventiva_epc_epi?: string;
  verificacao_resultado?: string;
  verificacao_evidencias?: string;
  verificacao_data?: string;
  verificacao_responsavel?: string;
  status: string;
  observacoes_gerais?: string;
  anexos?: string[];
  assinatura_responsavel_area?: string;
  assinatura_tecnico_auditor?: string;
  assinatura_gestao?: string;
  company_id: string;
  // SECURITY NOTE: pdf_file_key, pdf_folder_path, pdf_original_name are NEVER present in main responses.
  // They are internal only. Use /pdf and /attachments/:index/access for governed signed access.
  site_id?: string;
  site?: Site;
  created_at: string;
  updated_at: string;
}

export type NonConformityPdfAccessAvailability = GovernedPdfAccessAvailability;
export type NonConformityPdfAccessResponse = GovernedPdfAccessResponse;

export interface NonConformityAnalyticsOverview {
  totalNonConformities: number;
  abertas: number;
  emAndamento: number;
  aguardandoValidacao: number;
  encerradas: number;
}

export type NonConformityAttachmentAccessAvailability =
  | "ready"
  | "registered_without_signed_url";

export interface GovernedNonConformityAttachmentReference {
  v: 1;
  kind: "governed-storage";
  fileKey: string;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  sizeBytes?: number | null;
}

export interface NonConformityAttachmentAccessResponse {
  entityId: string;
  index: number;
  hasGovernedAttachment: true;
  availability: NonConformityAttachmentAccessAvailability;
  fileKey: string;
  originalName: string;
  mimeType: string;
  url: string | null;
  degraded: boolean;
  message: string | null;
}

export interface NonConformityAttachmentAttachResponse {
  entityId: string;
  attachments: string[];
  attachmentCount: number;
  storageMode: "governed-storage";
  degraded: false;
  message: string;
  // Use attachmentReference (governed ref like photoReference in checklists) + attachments[] for refs.
  // Raw fileKey is never returned in attach responses; use /attachments/:index/access for signed URL.
  attachmentReference: string;
  attachment: {
    index: number;
    originalName: string;
    mimeType: string;
  };
}

export interface NonConformityAttachmentRemoveResponse {
  entityId: string;
  attachments: string[];
  attachmentCount: number;
  removedAttachmentReference: string;
  storageCleanup: "removed" | "pending";
  message: string;
}

export enum NcStatus {
  ABERTA = "ABERTA",
  EM_ANDAMENTO = "EM_ANDAMENTO",
  AGUARDANDO_VALIDACAO = "AGUARDANDO_VALIDACAO",
  ENCERRADA = "ENCERRADA",
}

export const NC_STATUS_LABEL: Record<NcStatus, string> = {
  [NcStatus.ABERTA]: "Aberta",
  [NcStatus.EM_ANDAMENTO]: "Em Andamento",
  [NcStatus.AGUARDANDO_VALIDACAO]: "Aguard. Validação",
  [NcStatus.ENCERRADA]: "Encerrada",
};

export const NC_STATUS_COLORS: Record<NcStatus, string> = {
  [NcStatus.ABERTA]: "bg-[var(--ds-color-danger-subtle)] text-[var(--ds-color-danger)] border-[var(--ds-color-danger-border)]",
  [NcStatus.EM_ANDAMENTO]: "bg-[var(--ds-color-warning-subtle)] text-[var(--ds-color-warning)] border-[var(--ds-color-warning-border)]",
  [NcStatus.AGUARDANDO_VALIDACAO]: "bg-[var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)] border-[var(--ds-color-border-default)]",
  [NcStatus.ENCERRADA]: "bg-[var(--ds-color-success-subtle)] text-[var(--ds-color-success)] border-[var(--ds-color-success-border)]",
};

export const NC_ALLOWED_TRANSITIONS: Record<NcStatus, NcStatus[]> = {
  [NcStatus.ABERTA]: [NcStatus.EM_ANDAMENTO],
  [NcStatus.EM_ANDAMENTO]: [NcStatus.AGUARDANDO_VALIDACAO, NcStatus.ABERTA],
  [NcStatus.AGUARDANDO_VALIDACAO]: [NcStatus.ENCERRADA, NcStatus.ABERTA],
  [NcStatus.ENCERRADA]: [NcStatus.ABERTA],
};

const GOVERNED_ATTACHMENT_REF_PREFIX = "gst:nc-attachment:";

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4 || 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

export function parseGovernedNcAttachmentReference(
  value?: string | null,
): GovernedNonConformityAttachmentReference | null {
  const normalized = String(value || "").trim();
  if (!normalized.startsWith(GOVERNED_ATTACHMENT_REF_PREFIX)) {
    return null;
  }

  const encodedPayload = normalized.slice(GOVERNED_ATTACHMENT_REF_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      decodeBase64Url(encodedPayload),
    ) as Partial<GovernedNonConformityAttachmentReference>;
    if (
      parsed?.v !== 1 ||
      parsed.kind !== "governed-storage" ||
      typeof parsed.fileKey !== "string" ||
      typeof parsed.originalName !== "string" ||
      typeof parsed.mimeType !== "string" ||
      typeof parsed.uploadedAt !== "string"
    ) {
      return null;
    }

    return parsed as GovernedNonConformityAttachmentReference;
  } catch {
    return null;
  }
}

export function isGovernedNcAttachmentReference(
  value?: string | null,
): boolean {
  return Boolean(parseGovernedNcAttachmentReference(value));
}

export function normalizeNcStatus(value?: string | null): NcStatus {
  const normalized =
    value
      ?.trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || "";

  switch (normalized) {
    case NcStatus.ABERTA:
    case "ABERTA":
      return NcStatus.ABERTA;
    case NcStatus.EM_ANDAMENTO:
    case "EM_TRATAMENTO":
      return NcStatus.EM_ANDAMENTO;
    case NcStatus.AGUARDANDO_VALIDACAO:
      return NcStatus.AGUARDANDO_VALIDACAO;
    case NcStatus.ENCERRADA:
    case "FINALIZADA":
    case "CONCLUIDA":
      return NcStatus.ENCERRADA;
    default:
      return NcStatus.ABERTA;
  }
}

function normalizeNonConformity(item: NonConformity): NonConformity {
  return {
    ...item,
    status: normalizeNcStatus(item.status),
  };
}

export const nonConformitiesService = {
  findPaginated: async (opts?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }): Promise<PaginatedResponse<NonConformity>> => {
    const response = await api.get<PaginatedResponse<NonConformity>>(
      "/nonconformities",
      {
        params: {
          page: opts?.page ?? 1,
          limit: opts?.limit ?? 20,
          ...(opts?.search ? { search: opts.search } : {}),
          ...(opts?.status ? { status: opts.status } : {}),
        },
      },
    );
    return {
      ...response.data,
      data: response.data.data.map(normalizeNonConformity),
    };
  },

  findAll: async () => {
    return fetchAllPages({
      fetchPage: (page, limit) =>
        nonConformitiesService.findPaginated({
          page,
          limit,
        }),
      limit: 100,
      maxPages: 50,
    });
  },

  findOne: async (id: string) => {
    const response = await api.get<NonConformity>(`/nonconformities/${id}`);
    return normalizeNonConformity(response.data);
  },

  create: async (data: Partial<NonConformity>) => {
    assertNonConformityActionAvailable("create");
    const response = await api.post<NonConformity>("/nonconformities", data);
    return normalizeNonConformity(response.data);
  },

  update: async (id: string, data: Partial<NonConformity>) => {
    assertNonConformityActionAvailable("update");
    const response = await api.patch<NonConformity>(
      `/nonconformities/${id}`,
      data,
    );
    return normalizeNonConformity(response.data);
  },

  getPdfAccess: async (id: string) => {
    const response = await api.get<NonConformityPdfAccessResponse>(
      `/nonconformities/${id}/pdf`,
    );
    return response.data;
  },

  generateFinalPdf: async (id: string) => {
    assertNonConformityActionAvailable("generate-pdf");
    const response = await api.post<NonConformityPdfAccessResponse & { generated: boolean }>(
      `/nonconformities/${id}/generate-final-pdf`,
      undefined,
      { timeout: TIMEOUT_PDF },
    );
    return response.data;
  },

  attachAttachment: async (
    id: string,
    file: File,
  ): Promise<NonConformityAttachmentAttachResponse> => {
    assertNonConformityActionAvailable("upload");
    const formData = new FormData();
    formData.append("file", file);
    const response = await api.post<NonConformityAttachmentAttachResponse>(
      `/nonconformities/${id}/attachments`,
      formData,
      {
        headers: { "Content-Type": "multipart/form-data" },
      },
    );
    return response.data;
  },

  removeAttachment: async (
    id: string,
    index: number,
  ): Promise<NonConformityAttachmentRemoveResponse> => {
    assertNonConformityActionAvailable("remove");
    const response = await api.delete<NonConformityAttachmentRemoveResponse>(
      `/nonconformities/${id}/attachments/${index}`,
    );
    return response.data;
  },

  getAttachmentAccess: async (
    id: string,
    index: number,
  ): Promise<NonConformityAttachmentAccessResponse> => {
    const response = await api.get<NonConformityAttachmentAccessResponse>(
      `/nonconformities/${id}/attachments/${index}/access`,
    );
    return response.data;
  },

  listStoredFiles: async (filters?: {
    company_id?: string;
    year?: number;
    week?: number;
  }) => {
    const response = await api.get("/nonconformities/files/list", {
      params: filters,
    });
    return response.data;
  },

  downloadWeeklyBundle: async (filters: {
    company_id?: string;
    year: number;
    week: number;
  }) => {
    const response = await api.get("/nonconformities/files/weekly-bundle", {
      params: filters,
      responseType: "blob",
    });
    return response.data as Blob;
  },

  updateStatus: async (id: string, status: NcStatus) => {
    assertNonConformityActionAvailable("update-status");
    const response = await api.patch<NonConformity>(
      `/nonconformities/${id}/status`,
      { status },
    );
    return normalizeNonConformity(response.data);
  },

  getMonthlyAnalytics: async (): Promise<{ mes: string; total: number }[]> => {
    const response = await api.get<{ mes: string; total: number }[]>(
      "/nonconformities/analytics/monthly",
    );
    return response.data;
  },

  getAnalyticsOverview: async (): Promise<NonConformityAnalyticsOverview> => {
    const response = await api.get<NonConformityAnalyticsOverview>(
      "/nonconformities/analytics/overview",
    );
    return response.data;
  },

  remove: async (id: string) => {
    assertNonConformityActionAvailable("remove");
    await api.delete(`/nonconformities/${id}`);
  },
};
