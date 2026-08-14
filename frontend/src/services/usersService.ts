import api from "@/lib/api";
import { fetchAllPages, PaginatedResponse } from "./pagination";

const MAX_USERS_PAGE_LIMIT = 100;
const MAX_USERS_FETCH_ALL_PAGES = 500;

export const UserIdentityType = {
  SYSTEM_USER: "system_user",
  EMPLOYEE_SIGNER: "employee_signer",
} as const;

export type UserIdentityType =
  (typeof UserIdentityType)[keyof typeof UserIdentityType];

export const UserAccessStatus = {
  CREDENTIALED: "credentialed",
  NO_LOGIN: "no_login",
  MISSING_CREDENTIALS: "missing_credentials",
} as const;

export type UserAccessStatus =
  (typeof UserAccessStatus)[keyof typeof UserAccessStatus];

function normalizeUsersLimit(limit?: number) {
  if (!Number.isFinite(limit)) {
    return 20;
  }
  return Math.min(Math.max(Math.floor(limit || 20), 1), MAX_USERS_PAGE_LIMIT);
}

export interface Company {
  id: string;
  razao_social: string;
  cnpj: string;
  endereco: string;
  responsavel: string;
  status: boolean;
}

export interface UserCompanySummary {
  id: string;
  razao_social: string;
}

export interface Profile {
  id: string;
  nome: string;
  permissoes: string[];
}

export interface UserModuleAccessOption {
  key: string;
  label: string;
  description: string;
  permissions: string[];
}

export interface UserModuleAccessOptionsResponse {
  modules: UserModuleAccessOption[];
}

export interface User {
  id: string;
  nome: string;
  email: string;
  cpf: string | null;
  funcao?: string;
  role: string;
  company_id: string;
  company?: UserCompanySummary;
  site_id?: string;
  site_ids?: string[];
  sites?: Array<{ id: string; nome: string }>;
  site?: { id: string; nome: string };
  profile_id: string;
  profile?: Profile;
  isAdminGeral?: boolean;
  roles?: string[];
  permissions?: string[];
  module_access_keys?: string[];
  /** Consentimento explícito para processamento por IA (LGPD). */
  ai_processing_consent?: boolean;
  identity_type?: UserIdentityType;
  access_status?: UserAccessStatus;
  /** true quando a senha foi gerada pelo sistema e precisa ser trocada no próximo login. */
  must_change_password?: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkerOperationalStatus {
  user: {
    id: string;
    nome: string;
    cpf: string | null;
    funcao?: string | null;
    company_id: string;
  };
  operationalStatus: "APTO" | "BLOQUEADO";
  blocked: boolean;
  reasons: string[];
  medicalExam: {
    status: "VALIDO" | "VENCIDO" | "INAPTO" | "AUSENTE";
    data_realizacao?: string | null;
    data_vencimento?: string | null;
    resultado?: string | null;
  };
  trainings: {
    total: number;
    expiredBlocking: Array<{
      id: string;
      nome: string;
      data_vencimento: string;
    }>;
  };
  epis: {
    totalActive: number;
    expiringCa: Array<{
      id: string;
      epiNome?: string;
      validade_ca?: string;
    }>;
  };
}

export interface WorkerTimelineResponse {
  worker: {
    id: string;
    nome: string;
    cpf: string | null;
    email: string | null;
    funcao: string | null;
    companyId: string;
    companyName: string | null;
    siteId: string | null;
    siteName: string | null;
    createdAt: string;
    updatedAt: string;
  };
  status: WorkerOperationalStatus;
  summary: {
    trainingsTotal: number;
    expiredTrainings: number;
    activeEpis: number;
    expiringEpis: number;
    medicalExamStatus: WorkerOperationalStatus["medicalExam"]["status"];
    relatedDocuments: number;
  };
  documents: Array<{
    id: string;
    module: string;
    title: string;
    documentCode: string | null;
    documentDate: string | null;
    originalName: string | null;
  }>;
  timeline: Array<{
    id: string;
    type:
      | "worker_created"
      | "medical_exam"
      | "training"
      | "epi_assignment"
      | "document";
    title: string;
    description: string;
    status: "info" | "success" | "warning" | "danger";
    date: string;
  }>;
}

export interface ExportMyDataResponse {
  exportedAt?: string;
  subject?: Record<string, unknown>;
  account?: Record<string, unknown>;
  consents?: unknown[];
  processingSummary?: unknown[];
  limitations?: unknown[];
  [key: string]: unknown;
}

export const usersService = {
  findPaginated: async (opts?: {
    page?: number;
    limit?: number;
    search?: string;
    companyId?: string;
    siteId?: string;
    identityType?: UserIdentityType;
    accessStatus?: UserAccessStatus;
    signal?: AbortSignal;
  }): Promise<PaginatedResponse<User>> => {
    const params = {
      page: opts?.page ?? 1,
      limit: normalizeUsersLimit(opts?.limit),
      ...(opts?.search ? { search: opts.search } : {}),
      ...(opts?.siteId ? { site_id: opts.siteId } : {}),
      ...(opts?.identityType ? { identity_type: opts.identityType } : {}),
      ...(opts?.accessStatus ? { access_status: opts.accessStatus } : {}),
    };
    const headers = opts?.companyId ? { "x-company-id": opts.companyId } : {};
    try {
      const response = await api.get<PaginatedResponse<User>>("/users", {
        params,
        headers,
        signal: opts?.signal,
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  },

  findAll: async (companyId?: string, siteId?: string) => {
    try {
      const data = await fetchAllPages({
        fetchPage: (page, limit) =>
          usersService.findPaginated({ page, limit, companyId, siteId }),
        limit: 100,
        maxPages: MAX_USERS_FETCH_ALL_PAGES,
        batchSize: 3,
        cacheKey: `GET:/users?page=*&limit=100&company_id=${
          companyId || "all"
        }&site_id=${siteId || "all"}`,
      });
      return data;
    } catch (error) {
      throw error;
    }
  },

  findOne: async (id: string, companyId?: string) => {
    try {
      const response = await api.get<User>(`/users/${id}`, {
        headers: companyId ? { "x-company-id": companyId } : {},
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  },

  getModuleAccessOptions:
    async (): Promise<UserModuleAccessOptionsResponse> => {
      const response = await api.get<UserModuleAccessOptionsResponse>(
        "/users/module-access-options",
      );
      return response.data;
    },

  getWorkerStatusByCpf: async (cpf: string) => {
    const response = await api.post<WorkerOperationalStatus>(
      "/users/worker-status/by-cpf",
      { cpf },
    );
    return response.data;
  },

  getWorkerTimelineByCpf: async (cpf: string) => {
    const response = await api.post<WorkerTimelineResponse>(
      "/users/worker-status/by-cpf/timeline",
      { cpf },
    );
    return response.data;
  },

  getWorkerTimelineById: async (id: string) => {
    const response = await api.get<WorkerTimelineResponse>(
      `/users/${id}/timeline`,
    );
    return response.data;
  },

  create: async (data: Partial<User>) => {
    const { company_id, ...body } = data;
    const headers = company_id ? { "x-company-id": company_id } : {};
    const response = await api.post<User>("/users", body, { headers });
    return response.data;
  },

  update: async (id: string, data: Partial<User>) => {
    const { company_id, ...body } = data;
    const headers = company_id ? { "x-company-id": company_id } : {};
    const response = await api.patch<User>(`/users/${id}`, body, { headers });
    return response.data;
  },

  updateModuleAccess: async (
    id: string,
    moduleKeys: string[],
    stepUpToken: string,
    companyId?: string,
  ) => {
    const headers = {
      "x-step-up-token": stepUpToken,
      ...(companyId ? { "x-company-id": companyId } : {}),
    };
    const response = await api.patch<User>(
      `/users/${id}/module-access`,
      { module_keys: moduleKeys },
      {
        headers,
      },
    );
    return response.data;
  },

  gdprErasure: async (id: string, stepUpToken: string, companyId?: string) => {
    const headers = {
      "x-step-up-token": stepUpToken,
      ...(companyId ? { "x-company-id": companyId } : {}),
    };
    await api.patch(`/users/${id}/gdpr-erasure`, undefined, { headers });
  },

  exportMyData: async (): Promise<ExportMyDataResponse> => {
    const { data } = await api.get<ExportMyDataResponse>("/users/me/export");
    return data;
  },

  delete: async (id: string, stepUpToken: string, companyId?: string) => {
    const headers = {
      "x-step-up-token": stepUpToken,
      ...(companyId ? { "x-company-id": companyId } : {}),
    };
    await api.delete(`/users/${id}`, { headers });
  },

  /** Atualiza o consentimento do usuário autenticado para processamento por IA (LGPD). */
  updateAiConsent: async (
    consent: boolean,
  ): Promise<{ ai_processing_consent: boolean }> => {
    const { data } = await api.patch<{ ai_processing_consent: boolean }>(
      "/users/me/ai-consent",
      { consent },
    );
    return data;
  },
};
