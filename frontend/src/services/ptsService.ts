import api from '@/lib/api';
import type { GovernedPdfAccessResponse } from "@/lib/api/generated/governed-contracts.client";
import { AxiosError } from 'axios';
import { User } from './usersService';
import { CursorPaginatedResponse, PaginatedResponse } from './pagination';
import { enqueueOfflineMutation } from '@/lib/offline-sync';
import {
  omitCompanyId,
  tenantConfigFromPayload,
  tenantHeadersFromPayload,
} from './tenantWriteScope';

type PtOfflineSignatureErrorPayload = {
  code: 'PT_OFFLINE_SIGNATURES_NOT_SUPPORTED';
  message: string;
};

const PT_OFFLINE_SIGNATURE_MESSAGE =
  'Assinaturas da PT exigem conexão ativa. Salve como rascunho e sincronize online antes de concluir.';

function createPtOfflineSignatureBlockedError(): AxiosError<PtOfflineSignatureErrorPayload> {
  const error = new Error(PT_OFFLINE_SIGNATURE_MESSAGE) as AxiosError<PtOfflineSignatureErrorPayload>;
  error.name = 'AxiosError';
  Object.assign(error, {
    isAxiosError: true,
    response: {
      status: 400,
      data: {
        code: 'PT_OFFLINE_SIGNATURES_NOT_SUPPORTED',
        message: PT_OFFLINE_SIGNATURE_MESSAGE,
      },
    },
  });
  return error;
}

export function isPtOfflineSignatureBlockedError(
  error: unknown,
): error is AxiosError<PtOfflineSignatureErrorPayload> {
  const payload = (error as AxiosError<PtOfflineSignatureErrorPayload>)?.response?.data;
  return payload?.code === 'PT_OFFLINE_SIGNATURES_NOT_SUPPORTED';
}

type PtOfflineUploadErrorPayload = {
  code: 'PT_OFFLINE_UPLOAD_NOT_SUPPORTED';
  message: string;
};

const PT_OFFLINE_UPLOAD_MESSAGE =
  'Envio de fotos, anexos e encerramento da PT exigem conexão ativa. Tente novamente quando estiver online.';

function createPtOfflineUploadBlockedError(): AxiosError<PtOfflineUploadErrorPayload> {
  const error = new Error(PT_OFFLINE_UPLOAD_MESSAGE) as AxiosError<PtOfflineUploadErrorPayload>;
  error.name = 'AxiosError';
  Object.assign(error, {
    isAxiosError: true,
    response: {
      status: 400,
      data: {
        code: 'PT_OFFLINE_UPLOAD_NOT_SUPPORTED',
        message: PT_OFFLINE_UPLOAD_MESSAGE,
      },
    },
  });
  return error;
}

export function isPtOfflineUploadBlockedError(
  error: unknown,
): error is AxiosError<PtOfflineUploadErrorPayload> {
  const payload = (error as AxiosError<PtOfflineUploadErrorPayload>)?.response?.data;
  return payload?.code === 'PT_OFFLINE_UPLOAD_NOT_SUPPORTED';
}

async function rethrowOfflineUploadAware<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const axiosError = error as AxiosError;
    if (axiosError.code === 'ERR_NETWORK') {
      throw createPtOfflineUploadBlockedError();
    }
    throw error;
  }
}

export type PtEvidencePhotoFase = 'antes' | 'durante' | 'depois';

export const PT_EVIDENCE_FASE_LABELS: Record<PtEvidencePhotoFase, string> = {
  antes: 'Antes da atividade',
  durante: 'Durante a atividade',
  depois: 'Depois da atividade',
};

export type PtCondicaoArea =
  | 'Limpa e liberada'
  | 'Isolada com pendências'
  | 'Outro';

export const PT_CONDICOES_AREA: PtCondicaoArea[] = [
  'Limpa e liberada',
  'Isolada com pendências',
  'Outro',
];

export interface PtEvidencePhoto {
  ref: string;
  legenda?: string;
  fase: PtEvidencePhotoFase;
  uploaded_by_id?: string;
  uploaded_at: string;
}

export interface PtSignatureInput {
  user_id: string;
  signature_data: string;
  type: string;
}

export interface PtAtmosphericReading {
  id: string;
  hora: string;
  oxigenio: number;
  inflamaveis_lel: number;
  co: number;
  h2s: number;
  instrumento: string;
  responsavel: string;
}

export type PtChecklistAttachmentField =
  | 'trabalho_altura_checklist'
  | 'trabalho_eletrico_checklist'
  | 'trabalho_quente_checklist'
  | 'trabalho_espaco_confinado_checklist'
  | 'trabalho_escavacao_checklist';

export interface PtEvidencePhotoAccessResponse {
  entityId: string;
  photoIndex: number;
  fase: PtEvidencePhotoFase;
  legenda?: string;
  originalName: string;
  mimeType: string;
  url: string | null;
  degraded: boolean;
}

export interface PtChecklistAttachmentAccessResponse {
  entityId: string;
  checklistField: PtChecklistAttachmentField;
  itemIndex: number;
  originalName: string;
  mimeType: string;
  url: string | null;
  degraded: boolean;
}

export interface Pt {
  id: string;
  numero: string;
  titulo: string;
  descricao?: string;
  data_hora_inicio: string;
  data_hora_fim: string;
  status: 'Pendente' | 'Aprovada' | 'Cancelada' | 'Encerrada' | 'Expirada';
  company_id: string;
  site_id: string;
  apr_id?: string;
  responsavel_id: string;
  executantes: User[];
  trabalho_altura: boolean;
  espaco_confinado: boolean;
  trabalho_quente: boolean;
  eletricidade: boolean;
  escavacao: boolean;
  probability?: number;
  severity?: number;
  exposure?: number;
  initial_risk?: number;
  residual_risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  evidence_photo?: string;
  evidence_document?: string;
  control_description?: string;
  control_evidence?: boolean;
  trabalho_altura_checklist?: Array<{
    id: string;
    pergunta: string;
    resposta?: 'Sim' | 'Não' | 'Não aplicável';
    justificativa?: string;
    anexo_nome?: string;
    anexo_ref?: string;
  }>;
  trabalho_eletrico_checklist?: Array<{
    id: string;
    pergunta: string;
    resposta?: 'Sim' | 'Não' | 'Não aplicável';
    justificativa?: string;
    anexo_nome?: string;
    anexo_ref?: string;
  }>;
  trabalho_quente_checklist?: Array<{
    id: string;
    pergunta: string;
    resposta?: 'Sim' | 'Não' | 'Não aplicável';
    justificativa?: string;
    anexo_nome?: string;
    anexo_ref?: string;
  }>;
  trabalho_espaco_confinado_checklist?: Array<{
    id: string;
    pergunta: string;
    section?: string;
    resposta?: 'Sim' | 'Não' | 'Não aplicável';
    justificativa?: string;
    anexo_nome?: string;
    anexo_ref?: string;
  }>;
  trabalho_escavacao_checklist?: Array<{
    id: string;
    pergunta: string;
    section?: string;
    resposta?: 'Sim' | 'Não' | 'Não aplicável';
    justificativa?: string;
    anexo_nome?: string;
    anexo_ref?: string;
  }>;
  recomendacoes_gerais_checklist?: Array<{
    id: string;
    pergunta: string;
    resposta?: 'Ciente' | 'Não';
    justificativa?: string;
  }>;
  analise_risco_rapida_checklist?: Array<{
    id: string;
    pergunta: string;
    secao: 'basica' | 'adicional';
    resposta?: 'Sim' | 'Não';
  }>;
  analise_risco_rapida_observacoes?: string;
  fotos_evidencia?: PtEvidencePhoto[];
  medicoes_atmosfericas?: PtAtmosphericReading[];
  epis_obrigatorios?: string[];
  contato_emergencia?: string;
  plano_resgate?: string;
  ponto_encontro?: string;
  vigia_user_id?: string;
  vigia_nome?: string;
  vigia?: { nome: string };
  encerrado_por_id?: string;
  encerrado_por?: { nome: string };
  data_hora_real_fim?: string;
  condicao_area_encerramento?: PtCondicaoArea;
  observacoes_encerramento?: string;
  auditado_por_id?: string;
  data_auditoria?: string;
  resultado_auditoria?: string;
  notas_auditoria?: string;
  pdf_file_key?: string;
  pdf_folder_path?: string;
  pdf_original_name?: string;
  final_pdf_hash_sha256?: string | null;
  pdf_generated_at?: string | null;
  created_at: string;
  updated_at: string;
  site?: { nome: string };
  responsavel?: { nome: string };
  apr?: { numero: string };
  auditado_por?: { nome: string };
  aprovado_por_id?: string;
  aprovado_em?: string;
  aprovado_motivo?: string;
  reprovado_por_id?: string;
  reprovado_em?: string;
  reprovado_motivo?: string;
}

export interface PtApprovalRules {
  blockCriticalRiskWithoutEvidence: boolean;
  blockWorkerWithoutValidMedicalExam: boolean;
  blockWorkerWithExpiredBlockingTraining: boolean;
  requireAtLeastOneExecutante: boolean;
}

export type PtPdfAccessResponse = GovernedPdfAccessResponse;

export interface PtValidationContext {
  documentCode: string;
  finalPdfHash: string | null;
  token: string | null;
}

export interface PtAnalyticsOverview {
  totalPts: number;
  aprovadas: number;
  pendentes: number;
  canceladas: number;
  encerradas: number;
  expiradas: number;
}

export interface PtApprovalBlockedPayload {
  code: 'PT_APPROVAL_BLOCKED';
  message: string;
  reasons: string[];
  rules: PtApprovalRules;
}

export interface PtPreApprovalWorkerReviewPayload {
  userId: string;
  nome: string;
  roleLabel: string;
  blocked: boolean;
  unavailable?: boolean;
  reasons: string[];
}

export interface PtPreApprovalChecklistPayload {
  reviewedReadiness: boolean;
  reviewedWorkers: boolean;
  confirmedRelease: boolean;
}

export interface PtPreApprovalReviewPayload {
  stage: 'preview' | 'approval_requested';
  readyForRelease: boolean;
  blockers: string[];
  unansweredChecklistItems: number;
  adverseChecklistItems: number;
  pendingSignatures: number;
  hasRapidRiskBlocker: boolean;
  workerStatuses: PtPreApprovalWorkerReviewPayload[];
  warnings: string[];
  rules?: PtApprovalRules;
  checklist?: PtPreApprovalChecklistPayload;
}

export interface PtPreApprovalHistoryEntry {
  id: string;
  action: 'PRE_APPROVAL';
  userId: string | null;
  createdAt: string;
  stage: 'preview' | 'approval_requested' | null;
  readyForRelease: boolean | null;
  blockers: string[];
  unansweredChecklistItems: number;
  adverseChecklistItems: number;
  pendingSignatures: number;
  hasRapidRiskBlocker: boolean;
  warnings: string[];
  checklist: PtPreApprovalChecklistPayload | null;
}

export function getPtApprovalBlockedPayload(
  error: unknown,
): PtApprovalBlockedPayload | null {
  const axiosError = error as AxiosError<Partial<PtApprovalBlockedPayload>>;
  const payload = axiosError.response?.data;

  if (
    payload?.code !== 'PT_APPROVAL_BLOCKED' ||
    !Array.isArray(payload.reasons)
  ) {
    return null;
  }

  return {
    code: 'PT_APPROVAL_BLOCKED',
    message:
      typeof payload.message === 'string'
        ? payload.message
        : 'PT bloqueada pelas regras de segurança da empresa.',
    reasons: payload.reasons.filter(
      (reason): reason is string => typeof reason === 'string' && reason.trim().length > 0,
    ),
    rules: {
      blockCriticalRiskWithoutEvidence:
        payload.rules?.blockCriticalRiskWithoutEvidence ?? true,
      blockWorkerWithoutValidMedicalExam:
        payload.rules?.blockWorkerWithoutValidMedicalExam ?? false,
      blockWorkerWithExpiredBlockingTraining:
        payload.rules?.blockWorkerWithExpiredBlockingTraining ?? true,
      requireAtLeastOneExecutante:
        payload.rules?.requireAtLeastOneExecutante ?? false,
    },
  };
}

export const ptsService = {
  findPaginated: async (opts?: { page?: number; limit?: number; search?: string; status?: string }) => {
    const params = {
      page: opts?.page ?? 1,
      limit: opts?.limit ?? 20,
      ...(opts?.search ? { search: opts.search } : {}),
      ...(opts?.status ? { status: opts.status } : {}),
    };
    const response = await api.get<PaginatedResponse<Pt>>('/pts', { params });
    return response.data;
  },

  findByCursor: async (opts?: {
    cursor?: string;
    limit?: number;
    search?: string;
    status?: string;
  }) => {
    const params = {
      cursor: opts?.cursor,
      limit: opts?.limit ?? 20,
      ...(opts?.search ? { search: opts.search } : {}),
      ...(opts?.status ? { status: opts.status } : {}),
    };

    const response = await api.get<CursorPaginatedResponse<Pt>>('/pts', {
      params,
    });
    return response.data;
  },

  findAll: async () => {
    const response = await api.get<Pt[]>('/pts/export/all');
    return response.data;
  },

  findOne: async (id: string) => {
    const response = await api.get<Pt>(`/pts/${id}`);
    return response.data;
  },

  create: async (
    data: Omit<Partial<Pt>, 'executantes'> & { executantes?: string[] },
    options?: { allowOfflineQueue?: boolean },
  ) => {
    const payload = omitCompanyId(data);
    const config = tenantConfigFromPayload(data);
    const tenantHeaders = tenantHeadersFromPayload(data);
    const localCompanyId = data.company_id;
    try {
      const response = config
        ? await api.post<Pt>('/pts', payload, config)
        : await api.post<Pt>('/pts', payload);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.code !== 'ERR_NETWORK') {
        throw error;
      }
      if (options?.allowOfflineQueue === false) {
        throw createPtOfflineSignatureBlockedError();
      }

      const queued = await enqueueOfflineMutation({
        url: '/pts',
        method: 'post',
        data: payload,
        ...(tenantHeaders ? { headers: tenantHeaders } : {}),
        label: 'PT',
      });

      return {
        ...(payload as unknown as Partial<Pt>),
        ...(localCompanyId ? { company_id: localCompanyId } : {}),
        id: queued.id,
        status: ((payload as unknown as Partial<Pt>)?.status || 'Pendente') as Pt['status'],
        created_at: queued.createdAt,
        updated_at: queued.createdAt,
        offlineQueued: true,
      } as Pt & { offlineQueued: true };
    }
  },

  update: async (
    id: string,
    data: Omit<Partial<Pt>, 'executantes'> & { executantes?: string[] },
    options?: { allowOfflineQueue?: boolean },
  ) => {
    const payload = omitCompanyId(data);
    const config = tenantConfigFromPayload(data);
    const tenantHeaders = tenantHeadersFromPayload(data);
    const localCompanyId = data.company_id;
    try {
      const response = config
        ? await api.patch<Pt>(`/pts/${id}`, payload, config)
        : await api.patch<Pt>(`/pts/${id}`, payload);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.code !== 'ERR_NETWORK') {
        throw error;
      }
      if (options?.allowOfflineQueue === false) {
        throw createPtOfflineSignatureBlockedError();
      }

      const queued = await enqueueOfflineMutation({
        url: `/pts/${id}`,
        method: 'patch',
        data: payload,
        ...(tenantHeaders ? { headers: tenantHeaders } : {}),
        label: 'PT',
      });

      return {
        ...(payload as unknown as Partial<Pt>),
        ...(localCompanyId ? { company_id: localCompanyId } : {}),
        id,
        created_at: queued.createdAt,
        updated_at: queued.createdAt,
        offlineQueued: true,
      } as Pt & { offlineQueued: true };
    }
  },

  replaceSignatures: async (
    id: string,
    signatures: PtSignatureInput[],
  ): Promise<{ entityId: string; replaced: number }> => {
    const response = await api.put<{ entityId: string; replaced: number }>(
      `/pts/${id}/signatures`,
      { signatures },
    );
    return response.data;
  },

  createSignature: async (
    id: string,
    signature: Pick<PtSignatureInput, 'signature_data' | 'type'> & {
      pin?: string;
    },
  ): Promise<{ entityId: string; created: true }> => {
    const response = await api.post<{ entityId: string; created: true }>(
      `/pts/${id}/signatures`,
      signature,
    );
    return response.data;
  },

  approve: async (id: string, reason?: string) => {
    const response = await api.post<Pt>(`/pts/${id}/approve`, { reason });
    return response.data;
  },

  logPreApprovalReview: async (
    id: string,
    payload: PtPreApprovalReviewPayload,
  ) => {
    const response = await api.post<{ logged: true }>(
      `/pts/${id}/pre-approval-review`,
      payload,
    );
    return response.data;
  },

  getPreApprovalHistory: async (id: string) => {
    const response = await api.get<PtPreApprovalHistoryEntry[]>(
      `/pts/${id}/pre-approval-history`,
    );
    return response.data;
  },

  reject: async (id: string, reason: string) => {
    const response = await api.post<Pt>(`/pts/${id}/reject`, { reason });
    return response.data;
  },

  finalize: async (
    id: string,
    payload: {
      condicao_area: PtCondicaoArea;
      data_hora_real_fim?: string;
      observacoes?: string;
    },
  ) => {
    return rethrowOfflineUploadAware(async () => {
      const response = await api.post<Pt>(`/pts/${id}/finalize`, payload);
      return response.data;
    });
  },

  attachEvidencePhoto: async (
    id: string,
    file: File,
    meta: { fase: PtEvidencePhotoFase; legenda?: string },
  ) => {
    return rethrowOfflineUploadAware(async () => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('fase', meta.fase);
      if (meta.legenda?.trim()) {
        formData.append('legenda', meta.legenda.trim());
      }
      const response = await api.post(`/pts/${id}/photos`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return response.data as {
        entityId: string;
        photoIndex: number;
        photoReference: string;
        fase: PtEvidencePhotoFase;
        legenda?: string;
        photo: { originalName: string; mimeType: string };
      };
    });
  },

  getEvidencePhotoAccess: async (id: string, photoIndex: number) => {
    const response = await api.get<PtEvidencePhotoAccessResponse>(
      `/pts/${id}/photos/${photoIndex}/access`,
    );
    return response.data;
  },

  removeEvidencePhoto: async (id: string, photoIndex: number) => {
    return rethrowOfflineUploadAware(async () => {
      const response = await api.delete(`/pts/${id}/photos/${photoIndex}`);
      return response.data as {
        entityId: string;
        removed: true;
        remaining: number;
      };
    });
  },

  attachChecklistItemFile: async (
    id: string,
    checklistField: PtChecklistAttachmentField,
    itemIndex: number,
    file: File,
  ) => {
    return rethrowOfflineUploadAware(async () => {
      const formData = new FormData();
      formData.append('file', file);
      const response = await api.post(
        `/pts/${id}/checklists/${checklistField}/items/${itemIndex}/attachment`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      return response.data as {
        entityId: string;
        checklistField: PtChecklistAttachmentField;
        itemIndex: number;
        anexoReference: string;
        anexoNome: string;
      };
    });
  },

  getChecklistItemAttachmentAccess: async (
    id: string,
    checklistField: PtChecklistAttachmentField,
    itemIndex: number,
  ) => {
    const response = await api.get<PtChecklistAttachmentAccessResponse>(
      `/pts/${id}/checklists/${checklistField}/items/${itemIndex}/attachment/access`,
    );
    return response.data;
  },

  appendAtmosphericReading: async (
    id: string,
    reading: PtAtmosphericReading,
  ) => {
    return rethrowOfflineUploadAware(async () => {
      const response = await api.post<Pt>(
        `/pts/${id}/atmospheric-readings`,
        reading,
      );
      return response.data;
    });
  },

  attachFile: async (id: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post(`/pts/${id}/file`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  getPdfAccess: async (id: string) => {
    const response = await api.get<PtPdfAccessResponse>(`/pts/${id}/pdf`);
    return response.data;
  },

  getValidationContext: async (id: string) => {
    const response = await api.get<PtValidationContext>(
      `/pts/${id}/validation-context`,
    );
    return response.data;
  },

  getAnalyticsOverview: async () => {
    const response = await api.get<PtAnalyticsOverview>(
      '/pts/analytics/overview',
    );
    return response.data;
  },

  listStoredFiles: async (filters?: {
    company_id?: string;
    year?: number;
    week?: number;
  }) => {
    const response = await api.get('/pts/files/list', { params: filters });
    return response.data;
  },

  downloadWeeklyBundle: async (filters: {
    company_id?: string;
    year: number;
    week: number;
  }) => {
    const response = await api.get('/pts/files/weekly-bundle', {
      params: filters,
      responseType: 'blob',
    });
    return response.data as Blob;
  },

  delete: async (id: string) => {
    await api.delete(`/pts/${id}`);
  },

  getApprovalRules: async () => {
    const response = await api.get<PtApprovalRules>('/pts/approval-rules');
    return response.data;
  },

  updateApprovalRules: async (payload: Partial<PtApprovalRules>) => {
    const response = await api.patch<PtApprovalRules>(
      '/pts/approval-rules',
      payload,
    );
    return response.data;
  },
};
