import api, { TIMEOUT_PDF } from "@/lib/api";
import type { GovernedPdfAccessResponse } from "@/lib/api/generated/governed-contracts.client";
import { AxiosError } from "axios";
import { Activity } from "./activitiesService";
import { Risk } from "./risksService";
import { Epi } from "./episService";
import { Tool } from "./toolsService";
import { Machine } from "./machinesService";
import { User } from "./usersService";

import { Site } from "./sitesService";
import { Company } from "./companiesService";
import { fetchAllPages, PaginatedResponse } from "./pagination";
import { enqueueOfflineMutation } from "@/lib/offline-sync";
import {
  consumeOfflineCache,
  createOfflineCacheContext,
  isOfflineRequestError,
  setOfflineCache,
  CACHE_TTL,
} from "@/lib/offline-cache";
import { queryKeys, normalizeQueryFilters } from "@/lib/query-keys";
import {
  tenantConfigFromPayload,
  tenantHeadersFromPayload,
} from "./tenantWriteScope";

// Salvar APR pode envolver payload grande (risk_items) e transações pesadas no backend.
// O timeout default do axios (30s) pode estourar em produção e virar ECONNABORTED.
// Damos um timeout específico maior e, se ainda assim falhar por erro de rede,
// permitimos fallback para fila offline.
const TIMEOUT_APR_SAVE = 120_000; // 2 min

export interface AprRiskItemInput {
  atividade_processo?: string;
  atividade?: string;
  etapa?: string;
  agente_ambiental?: string;
  condicao_perigosa?: string;
  fonte_circunstancia?: string;
  fontes_circunstancias?: string;
  lesao?: string;
  possiveis_lesoes?: string;
  probabilidade?: number;
  severidade?: number;
  categoria_risco?: string;
  medidas_prevencao?: string;
  epc?: string;
  epi?: string;
  permissao_trabalho?: string;
  normas_relacionadas?: string;
  hierarquia_controle?: string;
  residual_probabilidade?: number;
  residual_severidade?: number;
  responsavel?: string;
  prazo?: string;
  status_acao?: string;
}

export interface AprActivityTemplate {
  tipo_atividade: string;
  label: string;
  descricao: string;
  risk_items: AprRiskItemInput[];
}

export interface AprCapabilities {
  rulesEngine: boolean;
}

export interface AprExcelImportPreview {
  fileName: string;
  sheetName: string;
  importedRows: number;
  ignoredRows: number;
  warnings: string[];
  errors: string[];
  matchedColumns: Record<string, string>;
  draft: {
    numero?: string;
    titulo?: string;
    descricao?: string;
    data_inicio?: string;
    data_fim?: string;
    company_name?: string;
    cnpj?: string;
    site_name?: string;
    unidade_setor?: string;
    local_atividade?: string;
    elaborador_name?: string;
    aprovador_name?: string;
    risk_items: AprRiskItemInput[];
  };
}

export interface Apr {
  id: string;
  numero: string;
  titulo: string;
  descricao?: string;
  tipo_atividade?: string | null;
  frente_trabalho?: string | null;
  area_risco?: string | null;
  turno?: string | null;
  local_execucao_detalhado?: string | null;
  responsavel_tecnico_nome?: string | null;
  responsavel_tecnico_registro?: string | null;
  data_inicio: string;
  data_fim: string;
  status: "Pendente" | "Aprovada" | "Cancelada" | "Encerrada";
  is_modelo?: boolean;
  is_modelo_padrao?: boolean;
  itens_risco?: Array<Record<string, string>>;
  probability?: number;
  severity?: number;
  exposure?: number;
  initial_risk?: number;
  residual_risk?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  evidence_photo?: string;
  evidence_document?: string;
  control_description?: string;
  control_evidence?: boolean;
  company_id: string;
  company?: Company;
  site_id: string;
  site?: Site;
  elaborador_id: string;
  elaborador?: User;
  activities: Activity[];
  risks: Risk[];
  epis: Epi[];
  tools: Tool[];
  machines: Machine[];
  participants: User[];
  auditado_por_id?: string;
  auditado_por?: User;
  data_auditoria?: string;
  resultado_auditoria?: string;
  notas_auditoria?: string;
  has_final_pdf?: boolean;
  pdf_folder_path?: string;
  pdf_original_name?: string;
  final_pdf_hash_sha256?: string | null;
  verification_code?: string | null;
  pdf_generated_at?: string | null;
  workflowConfigId?: string | null;
  versao?: number;
  parent_apr_id?: string;
  aprovado_por_id?: string;
  aprovado_por?: User;
  aprovado_em?: string;
  classificacao_resumo?: {
    total: number;
    aceitavel: number;
    atencao: number;
    substancial: number;
    critico: number;
  };
  participant_count?: number;
  signature_count?: number;
  risk_items?: Array<{
    id: string;
    apr_id: string;
    atividade?: string;
    etapa?: string;
    agente_ambiental?: string;
    condicao_perigosa?: string;
    fonte_circunstancia?: string;
    lesao?: string;
    probabilidade?: number;
    severidade?: number;
    score_risco?: number;
    categoria_risco?: string;
    prioridade?: string;
    medidas_prevencao?: string;
    epc?: string | null;
    epi?: string | null;
    permissao_trabalho?: string | null;
    normas_relacionadas?: string | null;
    hierarquia_controle?: string | null;
    residual_probabilidade?: number | null;
    residual_severidade?: number | null;
    residual_score?: number | null;
    residual_categoria?: string | null;
    responsavel?: string;
    prazo?: string;
    status_acao?: string;
    ordem: number;
    created_at: string;
    updated_at: string;
  }>;
  approval_steps?: Array<{
    id: string;
    apr_id: string;
    level_order: number;
    title: string;
    approver_role: string;
    status: "pending" | "approved" | "rejected" | "skipped";
    approver_user_id?: string | null;
    decision_reason?: string | null;
    decided_at?: string | null;
    approver_user?: { id: string; nome: string } | null;
    created_at: string;
    updated_at: string;
  }>;
  risk_evidences?: Array<{
    id: string;
    apr_id: string;
    apr_risk_item_id: string;
    uploaded_by_id?: string;
    original_name?: string;
    hash_sha256: string;
    watermarked_hash_sha256?: string;
    captured_at?: string;
    uploaded_at: string;
    integrity_flags?: Record<string, unknown>;
    risk_item_ordem?: number;
    url?: string;
    watermarked_url?: string;
  }>;
  created_at: string;
  updated_at: string;
}

export interface CreateAprDto {
  numero: string;
  titulo: string;
  descricao?: string;
  tipo_atividade?: string;
  frente_trabalho?: string;
  area_risco?: string;
  turno?: string;
  local_execucao_detalhado?: string;
  responsavel_tecnico_nome?: string;
  responsavel_tecnico_registro?: string;
  data_inicio: string;
  data_fim: string;
  status?: "Pendente" | "Aprovada" | "Cancelada" | "Encerrada";
  is_modelo?: boolean;
  is_modelo_padrao?: boolean;
  itens_risco?: Array<Record<string, string>>;
  risk_items?: AprRiskItemInput[];
  probability?: number;
  severity?: number;
  exposure?: number;
  residual_risk?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  evidence_photo?: string;
  evidence_document?: string;
  control_description?: string;
  control_evidence?: boolean;
  company_id?: string;
  site_id: string;
  elaborador_id: string;
  activities?: string[];
  risks?: string[];
  epis?: string[];
  tools?: string[];
  machines?: string[];
  participants?: string[];
  auditado_por_id?: string;
  data_auditoria?: string;
  resultado_auditoria?: string;
  notas_auditoria?: string;
}

type AprWriteOptions = {
  allowOfflineQueue?: boolean;
  offlineSync?: {
    correlationId?: string;
    dedupeKey?: string;
    draftId?: string;
    source?: string;
    /** updated_at do registro no momento em que foi carregado — usado para detecção de conflito */
    conflictGuardUpdatedAt?: string;
  };
};

export type AprPdfAccessResponse = Omit<
  GovernedPdfAccessResponse,
  "fileKey" | "folderPath"
> & {
  contentType: "application/pdf" | null;
  expiresAt: string | null;
};
export type AprFinalPdfGenerationResponse = AprPdfAccessResponse & {
  generated: boolean;
};

function sanitizeAprWritePayload(
  data: Partial<CreateAprDto>,
): Partial<CreateAprDto> {
  const {
    company_id,
    status,
    activities,
    risks,
    epis,
    tools,
    machines,
    participants,
    ...rest
  } = data;
  void company_id;
  void status;

  const normalizeOptionalString = (value?: string) => {
    const normalized = String(value || "").trim();
    return normalized || undefined;
  };

  const dedupe = (values?: string[]) =>
    Array.isArray(values)
      ? Array.from(
          new Set(
            values.filter((value) => Boolean(String(value || "").trim())),
          ),
        )
      : values;

  const normalizeRiskItems = (items?: AprRiskItemInput[]) =>
    Array.isArray(items)
      ? items.map((item) => ({
          ...item,
          prazo: normalizeOptionalString(item.prazo),
        }))
      : items;

  return {
    ...rest,
    auditado_por_id: normalizeOptionalString(rest.auditado_por_id),
    data_auditoria: normalizeOptionalString(rest.data_auditoria),
    activities: dedupe(activities),
    risks: dedupe(risks),
    epis: dedupe(epis),
    tools: dedupe(tools),
    machines: dedupe(machines),
    participants: dedupe(participants),
    risk_items: normalizeRiskItems(rest.risk_items),
  };
}

export const aprsService = {
  findPaginated: async (opts?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    siteId?: string;
    responsibleId?: string;
    dueFilter?: string;
    sort?: "priority" | "updated-desc" | "deadline-asc" | "title-asc";
    companyId?: string;
    isModeloPadrao?: boolean;
    contextFilter?: "minhas" | "vence-hoje" | "preciso-assinar";
    signal?: AbortSignal;
  }) => {
    const activeCompanyId = opts?.companyId;
    const activeSiteId = opts?.siteId;
    if (!activeCompanyId || !activeSiteId) {
      throw new Error('companyId e siteId são obrigatórios para listar APRs.');
    }
    const normalizedFilters = normalizeQueryFilters({
      search: opts?.search,
      status: opts?.status,
      responsibleId: opts?.responsibleId,
      dueFilter: opts?.dueFilter,
      sort: opts?.sort,
      isModeloPadrao: opts?.isModeloPadrao,
      contextFilter: opts?.contextFilter,
    });
    const params = {
      page: opts?.page ?? 1,
      limit: opts?.limit ?? 20,
      ...(opts?.search ? { search: opts.search } : {}),
      ...(opts?.status ? { status: opts.status } : {}),
      ...(activeSiteId ? { site_id: activeSiteId } : {}),
      ...(opts?.responsibleId ? { responsible_id: opts.responsibleId } : {}),
      ...(opts?.dueFilter ? { due_filter: opts.dueFilter } : {}),
      ...(opts?.sort ? { sort: opts.sort } : {}),
      ...(activeCompanyId ? { company_id: activeCompanyId } : {}),
      ...(opts?.isModeloPadrao !== undefined
        ? { is_modelo_padrao: opts.isModeloPadrao }
        : {}),
      ...(opts?.contextFilter ? { context_filter: opts.contextFilter } : {}),
    };
    const cacheKey = JSON.stringify(queryKeys.aprs.list({
      companyId: activeCompanyId,
      siteId: activeSiteId,
      page: params.page,
      limit: params.limit,
      filters: { normalizedFilters },
    }));
    const cacheContext = createOfflineCacheContext();


    try {
      const response = await api.get<PaginatedResponse<Apr>>("/aprs", {
        params,
        signal: opts?.signal,
      });
      setOfflineCache(cacheKey, response.data, CACHE_TTL.CRITICAL, cacheContext);
      return response.data;
    } catch (error) {
      if (!isOfflineRequestError(error)) {
        throw error;
      }
      const cached = consumeOfflineCache<PaginatedResponse<Apr>>(cacheKey, cacheContext);
      if (cached) return cached;
      throw error;
    }
  },

  findAll: async (companyId?: string, siteId?: string) => {
    if (!companyId || !siteId) {
      throw new Error('companyId e siteId são obrigatórios para listar APRs.');
    }
    const cacheKey = JSON.stringify(queryKeys.aprs.list({
      companyId,
      siteId,
      filters: { normalizedFilters: normalizeQueryFilters({ scope: 'all' }) },
    }));
    const aggregateCacheKey = cacheKey;
    const cacheContext = createOfflineCacheContext();
    try {
      const data = await fetchAllPages({
        fetchPage: (page, limit) =>
          aprsService.findPaginated({ page, limit, companyId, siteId }),
        limit: 100,
        maxPages: 20,
        batchSize: 3,
        cacheKey,
      });
      setOfflineCache(aggregateCacheKey, data, CACHE_TTL.CRITICAL, cacheContext);
      return data;
    } catch (error) {
      if (!isOfflineRequestError(error)) {
        throw error;
      }
      const cached = consumeOfflineCache<Apr[]>(cacheKey, cacheContext);
      if (cached) return cached;
      throw error;
    }
  },

  findOne: async (id: string, scope?: { companyId?: string; siteId?: string }) => {
    const cacheKey = JSON.stringify(queryKeys.aprs.detail({
      aprId: id,
      companyId: scope?.companyId,
      siteId: scope?.siteId,
    }));
    const cacheContext = createOfflineCacheContext();
    try {
      const response = await api.get<Apr>(`/aprs/${id}`);
      setOfflineCache(cacheKey, response.data, CACHE_TTL.RECORD, cacheContext);
      return response.data;
    } catch (error) {
      if (!isOfflineRequestError(error)) {
        throw error;
      }
      const cached = consumeOfflineCache<Apr>(cacheKey, cacheContext);
      if (cached) return cached;
      throw error;
    }
  },

  create: async (data: CreateAprDto, options?: AprWriteOptions) => {
    const payload = sanitizeAprWritePayload(data) as CreateAprDto;
    const localCompanyId = data.company_id;
    const requestConfig = tenantConfigFromPayload(data, {
      timeout: TIMEOUT_APR_SAVE,
    });
    const tenantHeaders = tenantHeadersFromPayload(data);
    try {
      const response = await api.post<Apr>("/aprs", payload, requestConfig);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      if (!isOfflineRequestError(axiosError)) {
        throw error;
      }
      if (options?.allowOfflineQueue === false) {
        throw error;
      }

      const queued = await enqueueOfflineMutation({
        url: "/aprs",
        method: "post",
        data: payload,
        ...(tenantHeaders ? { headers: tenantHeaders } : {}),
        label: "APR",
        correlationId: options?.offlineSync?.correlationId,
        dedupeKey: options?.offlineSync?.dedupeKey,
        meta: {
          module: "apr",
          entityType: "apr_base",
          draftId: options?.offlineSync?.draftId,
          source: options?.offlineSync?.source || "apr_form",
        },
      });

      return {
        ...(payload as unknown as Partial<Apr>),
        company_id: localCompanyId || "",
        id: queued.id,
        status: "Pendente" as Apr["status"],
        created_at: queued.createdAt,
        updated_at: queued.createdAt,
        offlineQueued: true,
        offlineQueueItemId: queued.id,
        offlineQueueDeduplicated: Boolean(
          (queued as { deduplicated?: boolean }).deduplicated,
        ),
      } as Apr & { offlineQueued: true };
    }
  },

  update: async (
    id: string,
    data: Partial<CreateAprDto>,
    options?: AprWriteOptions,
  ) => {
    const payload = sanitizeAprWritePayload(data);
    const localCompanyId = data.company_id;
    const requestConfig = tenantConfigFromPayload(data, {
      timeout: TIMEOUT_APR_SAVE,
    });
    const tenantHeaders = tenantHeadersFromPayload(data);
    // Inclui o guard de conflito no payload para detecção server-side
    const payloadWithGuard = options?.offlineSync?.conflictGuardUpdatedAt
      ? {
          ...payload,
          _conflict_guard_updated_at:
            options.offlineSync.conflictGuardUpdatedAt,
        }
      : payload;
    try {
      const response = await api.patch<Apr>(
        `/aprs/${id}`,
        payloadWithGuard,
        requestConfig,
      );
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      if (!isOfflineRequestError(axiosError)) {
        throw error;
      }
      if (options?.allowOfflineQueue === false) {
        throw error;
      }

      const queued = await enqueueOfflineMutation({
        url: `/aprs/${id}`,
        method: "patch",
        data: payloadWithGuard,
        ...(tenantHeaders ? { headers: tenantHeaders } : {}),
        label: "APR",
        correlationId: options?.offlineSync?.correlationId,
        dedupeKey: options?.offlineSync?.dedupeKey,
        meta: {
          module: "apr",
          entityType: "apr_base",
          draftId: options?.offlineSync?.draftId,
          source: options?.offlineSync?.source || "apr_form",
        },
      });

      return {
        ...(payload as unknown as Partial<Apr>),
        ...(localCompanyId ? { company_id: localCompanyId } : {}),
        id,
        created_at: queued.createdAt,
        updated_at: queued.createdAt,
        offlineQueued: true,
        offlineQueueItemId: queued.id,
        offlineQueueDeduplicated: Boolean(
          (queued as { deduplicated?: boolean }).deduplicated,
        ),
      } as Apr & { offlineQueued: true };
    }
  },

  attachFile: async (id: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const response = await api.post(`/aprs/${id}/file`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    return response.data;
  },

  getPdfAccess: async (id: string) => {
    const response = await api.get<AprPdfAccessResponse>(`/aprs/${id}/pdf`);
    return response.data;
  },

  generateFinalPdf: async (id: string) => {
    const response = await api.post<AprFinalPdfGenerationResponse>(
      `/aprs/${id}/generate-final-pdf`,
      undefined,
      { timeout: TIMEOUT_PDF },
    );
    return response.data;
  },

  listActivityTemplates: async () => {
    const response = await api.get<
      Array<Pick<AprActivityTemplate, "tipo_atividade" | "label" | "descricao">>
    >("/aprs/activity-templates");
    return response.data;
  },

  getActivityTemplate: async (tipoAtividade: string) => {
    const response = await api.get<AprActivityTemplate>(
      `/aprs/activity-templates/${tipoAtividade}`,
    );
    return response.data;
  },

  previewExcelImport: async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const response = await api.post<AprExcelImportPreview>(
      "/aprs/import/excel/preview",
      formData,
    );
    return response.data;
  },

  listStoredFiles: async (filters?: {
    company_id?: string;
    year?: number;
    week?: number;
  }) => {
    const response = await api.get("/aprs/files/list", { params: filters });
    return response.data;
  },

  downloadWeeklyBundle: async (filters: {
    company_id?: string;
    year: number;
    week: number;
  }) => {
    const response = await api.get("/aprs/files/weekly-bundle", {
      params: filters,
      responseType: "blob",
    });
    return response.data as Blob;
  },

  finalize: async (id: string) => {
    const response = await api.patch<Apr>(`/aprs/${id}/finalize`);
    return response.data;
  },

  approve: async (id: string, reason?: string) => {
    const response = await api.patch<Apr>(`/aprs/${id}/approve`, { reason });
    return response.data;
  },

  reject: async (id: string, reason: string) => {
    const response = await api.patch<Apr>(`/aprs/${id}/reject`, { reason });
    return response.data;
  },

  createNewVersion: async (id: string) => {
    const response = await api.post<Apr>(`/aprs/${id}/new-version`);
    return response.data;
  },

  getLogs: async (id: string) => {
    const response = await api.get<
      Array<{
        id: string;
        apr_id: string;
        usuario_id?: string;
        acao: string;
        metadata?: Record<string, unknown>;
        data_hora: string;
      }>
    >(`/aprs/${id}/logs`);
    return response.data;
  },

  getAnalyticsOverview: async () => {
    const response = await api.get<{
      totalAprs: number;
      aprovadas: number;
      pendentes: number;
      riscosCriticos: number;
      mediaScoreRisco: number;
    }>("/aprs/analytics/overview");
    return response.data;
  },

  getControlSuggestions: async (payload: {
    probability?: number;
    severity?: number;
    exposure?: number;
    activity?: string;
    condition?: string;
  }) => {
    const response = await api.post<{
      score: number | null;
      riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
      suggestions: Array<{
        hierarchy:
          | "ELIMINATION"
          | "SUBSTITUTION"
          | "ENGINEERING"
          | "ADMINISTRATIVE"
          | "PPE";
        title: string;
        description: string;
      }>;
    }>("/aprs/risk-controls/suggestions", payload);
    return response.data;
  },

  getVersionHistory: async (id: string) => {
    const response = await api.get<
      Array<{
        id: string;
        numero: string;
        versao: number;
        status: string;
        parent_apr_id?: string;
        aprovado_em?: string;
        updated_at: string;
        classificacao_resumo?: {
          total: number;
          aceitavel: number;
          atencao: number;
          substancial: number;
          critico: number;
        };
      }>
    >(`/aprs/${id}/versions`);
    return response.data;
  },

  compareVersions: async (baseId: string, targetId: string) => {
    const response = await api.get<{
      base: { id: string; numero: string; versao: number };
      target: { id: string; numero: string; versao: number };
      summary: {
        totalBase: number;
        totalTarget: number;
        added: number;
        removed: number;
        changed: number;
      };
      added: Array<Record<string, string>>;
      removed: Array<Record<string, string>>;
      changed: Array<{
        index: number;
        before: Record<string, string>;
        after: Record<string, string>;
        changedFields: string[];
      }>;
    }>(`/aprs/${baseId}/compare/${targetId}`);
    return response.data;
  },

  uploadRiskEvidence: async (
    aprId: string,
    riskItemId: string,
    file: File,
    metadata?: {
      captured_at?: string;
      latitude?: number;
      longitude?: number;
      accuracy_m?: number;
      device_id?: string;
      exif_datetime?: string;
    },
  ) => {
    const formData = new FormData();
    formData.append("file", file);
    if (metadata?.captured_at)
      formData.append("captured_at", metadata.captured_at);
    if (typeof metadata?.latitude === "number")
      formData.append("latitude", String(metadata.latitude));
    if (typeof metadata?.longitude === "number")
      formData.append("longitude", String(metadata.longitude));
    if (typeof metadata?.accuracy_m === "number")
      formData.append("accuracy_m", String(metadata.accuracy_m));
    if (metadata?.device_id) formData.append("device_id", metadata.device_id);
    if (metadata?.exif_datetime)
      formData.append("exif_datetime", metadata.exif_datetime);

    const response = await api.post(
      `/aprs/${aprId}/risk-items/${riskItemId}/evidence`,
      formData,
      { headers: { "Content-Type": "multipart/form-data" } },
    );
    return response.data;
  },

  listAprEvidences: async (aprId: string) => {
    const response = await api.get<
      Array<{
        id: string;
        apr_id: string;
        apr_risk_item_id: string;
        uploaded_by_id?: string;
        uploaded_by_name?: string;
        original_name?: string;
        hash_sha256: string;
        watermarked_hash_sha256?: string;
        captured_at?: string;
        uploaded_at: string;
        integrity_flags?: Record<string, unknown>;
        risk_item_ordem?: number;
        url?: string;
        watermarked_url?: string;
      }>
    >(`/aprs/${aprId}/evidence`);
    return response.data;
  },


  delete: async (id: string) => {
    await api.delete(`/aprs/${id}`);
  },

  getWorkflowStatus: async (id: string) => {
    const response = await api.get<{
      currentStep: {
        stepOrder: number;
        roleName: string;
        isRequired: boolean;
      } | null;
      nextStep: { stepOrder: number; roleName: string } | null;
      history: Array<{
        id: string;
        aprId: string;
        stepOrder: number;
        roleName: string;
        approverId: string;
        action: "APROVADO" | "REPROVADO" | "REABERTO" | "DELEGADO";
        reason: string | null;
        occurredAt: string;
        metadata?: Record<string, unknown> | null;
      }>;
      canEdit: boolean;
      canApprove: boolean;
    }>(`/aprs/${id}/workflow-status`);
    return response.data;
  },

  workflowApprove: async (id: string, reason?: string) => {
    const response = await api.post<Apr>(`/aprs/${id}/submit`, { reason });
    return response.data;
  },

  workflowReject: async (id: string, reason: string) => {
    const response = await api.patch<Apr>(`/aprs/${id}/reject`, { reason });
    return response.data;
  },

  workflowReopen: async (id: string, reason: string) => {
    const response = await api.post<{ id: string; status: string }>(
      `/aprs/${id}/reopen`,
      { reason },
    );
    return response.data;
  },

  validateCompliance: async (id: string) => {
    const response = await api.get<AprValidationResult>(`/aprs/${id}/validate`);
    return response.data;
  },

  getCapabilities: async () => {
    const response = await api.get<AprCapabilities>('/aprs/capabilities');
    return response.data;
  },

};

export interface AprRuleViolation {
  ruleCode: string;
  severity: "BLOQUEANTE" | "ADVERTENCIA";
  title: string;
  operationalMessage: string;
  remediation: string;
  nrReference?: string;
}

export interface AprValidationResult {
  isValid: boolean;
  score: number;
  blockers: AprRuleViolation[];
  warnings: AprRuleViolation[];
  appliedRuleSnapshot: string;
}
