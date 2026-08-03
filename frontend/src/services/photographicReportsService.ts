import api from '@/lib/api';
import { PaginatedResponse, fetchAllPages } from './pagination';

export type PhotographicReportTone = 'Positivo' | 'Técnico' | 'Preventivo';
export type PhotographicReportAreaStatus =
  | 'Loja aberta'
  | 'Loja fechada'
  | 'Área controlada'
  | 'Área isolada';
export type PhotographicReportShift = 'Diurno' | 'Noturno' | 'Integral';
export type PhotographicReportStatus =
  | 'Rascunho'
  | 'Aguardando fotos'
  | 'Aguardando análise'
  | 'Analisado'
  | 'Em edição'
  | 'Finalizado'
  | 'Exportado'
  | 'Cancelado';
export type PhotographicReportExportType = 'word' | 'pdf';

export interface PhotographicReportDay {
  id: string;
  report_id: string;
  activity_date: string;
  day_summary: string | null;
  created_at: string;
  updated_at: string;
  image_count?: number;
}

export interface PhotographicReportImage {
  id: string;
  report_id: string;
  report_day_id: string | null;
  image_url: string;
  download_url: string | null;
  image_order: number;
  manual_caption: string | null;
  ai_title: string | null;
  ai_description: string | null;
  ai_positive_points: string[] | null;
  ai_technical_assessment: string | null;
  ai_condition_classification: string | null;
  ai_recommendations: string[] | null;
  created_at: string;
  updated_at: string;
  day?: PhotographicReportDay | null;
}

export interface PhotographicReportExport {
  id: string;
  report_id: string;
  export_type: PhotographicReportExportType;
  file_url: string;
  download_url: string | null;
  generated_by: string | null;
  generated_at: string;
}

export interface PhotographicReportListItem {
  id: string;
  company_id: string;
  client_id: string | null;
  project_id: string | null;
  client_name: string;
  project_name: string;
  unit_name: string | null;
  location: string | null;
  activity_type: string;
  report_tone: PhotographicReportTone;
  area_status: PhotographicReportAreaStatus;
  shift: PhotographicReportShift;
  start_date: string;
  end_date: string | null;
  start_time: string;
  end_time: string;
  responsible_name: string;
  contractor_company: string;
  general_observations: string | null;
  ai_summary: string | null;
  final_conclusion: string | null;
  status: PhotographicReportStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  day_count: number;
  image_count: number;
  export_count: number;
  last_exported_at: string | null;
}

export interface PhotographicReport extends PhotographicReportListItem {
  days: PhotographicReportDay[];
  images: PhotographicReportImage[];
  exports: PhotographicReportExport[];
}

export interface CreatePhotographicReportDto {
  client_id?: string | null;
  project_id?: string | null;
  client_name: string;
  project_name: string;
  unit_name?: string | null;
  location?: string | null;
  activity_type: string;
  report_tone?: PhotographicReportTone;
  area_status?: PhotographicReportAreaStatus;
  shift?: PhotographicReportShift;
  start_date: string;
  end_date?: string | null;
  start_time: string;
  end_time: string;
  responsible_name: string;
  contractor_company: string;
  general_observations?: string | null;
  created_by?: string | null;
}

export type UpdatePhotographicReportDto = Partial<CreatePhotographicReportDto> & {
  ai_summary?: string | null;
  final_conclusion?: string | null;
  status?: PhotographicReportStatus;
};

export interface CreatePhotographicReportDayDto {
  activity_date: string;
  day_summary?: string | null;
}

export interface UpdatePhotographicReportDayDto {
  activity_date?: string;
  day_summary?: string | null;
}

export interface UpdatePhotographicReportImageDto {
  report_day_id?: string | null;
  manual_caption?: string | null;
  image_order?: number;
  ai_title?: string | null;
  ai_description?: string | null;
  ai_positive_points?: string[] | null;
  ai_technical_assessment?: string | null;
  ai_condition_classification?: string | null;
  ai_recommendations?: string[] | null;
}

export interface ReorderPhotographicReportImagesDto {
  imageIds: string[];
}

export interface UploadPhotographicReportImagesDto {
  report_day_id?: string | null;
  activity_date?: string | null;
  manual_caption?: string | null;
}

export interface PhotographicReportPdfAccess {
  entityId: string;
  hasFinalPdf: boolean;
  availability: string;
  message: string;
  fileKey: string | null;
  folderPath: string | null;
  originalName: string | null;
  url: string | null;
}

function buildFormData(
  files: File[],
  dto?: UploadPhotographicReportImagesDto,
): FormData {
  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });
  if (dto?.report_day_id) {
    formData.append('report_day_id', dto.report_day_id);
  }
  if (dto?.activity_date) {
    formData.append('activity_date', dto.activity_date);
  }
  if (dto?.manual_caption) {
    formData.append('manual_caption', dto.manual_caption);
  }
  return formData;
}

export const photographicReportsService = {
  findPaginated: async (opts?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: PhotographicReportStatus;
  }): Promise<PaginatedResponse<PhotographicReportListItem>> => {
    const response = await api.get<PaginatedResponse<PhotographicReportListItem>>(
      '/photographic-reports',
      {
        params: {
          page: opts?.page ?? 1,
          limit: opts?.limit ?? 20,
          ...(opts?.search ? { search: opts.search } : {}),
          ...(opts?.status ? { status: opts.status } : {}),
        },
      },
    );
    return response.data;
  },

  findAll: async (): Promise<PhotographicReportListItem[]> => {
    return fetchAllPages({
      fetchPage: (page, limit) =>
        photographicReportsService.findPaginated({ page, limit }),
      limit: 100,
      maxPages: 50,
    });
  },

  findOne: async (id: string): Promise<PhotographicReport> => {
    const response = await api.get<PhotographicReport>(`/photographic-reports/${id}`);
    return response.data;
  },

  create: async (data: CreatePhotographicReportDto): Promise<PhotographicReport> => {
    const response = await api.post<PhotographicReport>('/photographic-reports', data);
    return response.data;
  },

  update: async (
    id: string,
    data: UpdatePhotographicReportDto,
  ): Promise<PhotographicReport> => {
    const response = await api.patch<PhotographicReport>(`/photographic-reports/${id}`, data);
    return response.data;
  },

  saveDraft: async (
    id: string,
    data: UpdatePhotographicReportDto,
  ): Promise<PhotographicReport> => {
    const response = await api.post<PhotographicReport>(
      `/photographic-reports/${id}/draft`,
      data,
    );
    return response.data;
  },

  remove: async (id: string): Promise<void> => {
    await api.delete(`/photographic-reports/${id}`);
  },

  createDay: async (
    reportId: string,
    data: CreatePhotographicReportDayDto,
  ): Promise<PhotographicReport> => {
    const response = await api.post<PhotographicReport>(
      `/photographic-reports/${reportId}/days`,
      data,
    );
    return response.data;
  },

  updateDay: async (
    reportId: string,
    dayId: string,
    data: UpdatePhotographicReportDayDto,
  ): Promise<PhotographicReport> => {
    const response = await api.patch<PhotographicReport>(
      `/photographic-reports/${reportId}/days/${dayId}`,
      data,
    );
    return response.data;
  },

  removeDay: async (
    reportId: string,
    dayId: string,
  ): Promise<PhotographicReport> => {
    const response = await api.delete<PhotographicReport>(
      `/photographic-reports/${reportId}/days/${dayId}`,
    );
    return response.data;
  },

  uploadImages: async (
    reportId: string,
    files: File[],
    data?: UploadPhotographicReportImagesDto,
  ): Promise<PhotographicReport> => {
    const response = await api.post<PhotographicReport>(
      `/photographic-reports/${reportId}/images`,
      buildFormData(files, data),
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
    return response.data;
  },

  updateImage: async (
    reportId: string,
    imageId: string,
    data: UpdatePhotographicReportImageDto,
  ): Promise<PhotographicReportImage> => {
    const response = await api.patch<PhotographicReportImage>(
      `/photographic-reports/${reportId}/images/${imageId}`,
      data,
    );
    return response.data;
  },

  removeImage: async (
    reportId: string,
    imageId: string,
  ): Promise<PhotographicReport> => {
    const response = await api.delete<PhotographicReport>(
      `/photographic-reports/${reportId}/images/${imageId}`,
    );
    return response.data;
  },

  reorderImages: async (
    reportId: string,
    data: ReorderPhotographicReportImagesDto,
  ): Promise<PhotographicReport> => {
    const response = await api.post<PhotographicReport>(
      `/photographic-reports/${reportId}/images/reorder`,
      data,
    );
    return response.data;
  },

  analyzeImage: async (
    reportId: string,
    imageId: string,
  ): Promise<PhotographicReportImage> => {
    const response = await api.post<PhotographicReportImage>(
      `/photographic-reports/${reportId}/images/${imageId}/analyze`,
    );
    return response.data;
  },

  analyzeAllImages: async (reportId: string): Promise<PhotographicReport> => {
    const response = await api.post<PhotographicReport>(
      `/photographic-reports/${reportId}/images/analyze`,
    );
    return response.data;
  },

  generateReportSummary: async (reportId: string): Promise<PhotographicReport> => {
    const response = await api.post<PhotographicReport>(
      `/photographic-reports/${reportId}/analyze`,
    );
    return response.data;
  },

  finalize: async (reportId: string): Promise<PhotographicReport> => {
    const response = await api.post<PhotographicReport>(
      `/photographic-reports/${reportId}/finalize`,
    );
    return response.data;
  },

  exportPdf: async (reportId: string): Promise<Blob> => {
    const response = await api.post<Blob>(
      `/photographic-reports/${reportId}/export/pdf`,
      undefined,
      { responseType: 'blob' },
    );
    return response.data;
  },

  exportWord: async (reportId: string): Promise<Blob> => {
    const response = await api.post<Blob>(
      `/photographic-reports/${reportId}/export/word`,
      undefined,
      { responseType: 'blob' },
    );
    return response.data;
  },

  listExports: async (reportId: string): Promise<PhotographicReportExport[]> => {
    const response = await api.get<PhotographicReportExport[]>(
      `/photographic-reports/${reportId}/exports`,
    );
    return response.data;
  },

  downloadExport: async (
    reportId: string,
    exportId: string,
  ): Promise<Blob> => {
    const response = await api.get<Blob>(
      `/photographic-reports/${reportId}/exports/${exportId}/file`,
      { responseType: 'blob' },
    );
    return response.data;
  },

  getPdfAccess: async (reportId: string): Promise<PhotographicReportPdfAccess> => {
    const response = await api.get<PhotographicReportPdfAccess>(
      `/photographic-reports/${reportId}/pdf`,
    );
    return response.data;
  },

  sendEmail: async (reportId: string, to: string[]): Promise<void> => {
    await api.post(`/photographic-reports/${reportId}/send-email`, { to });
  },
};
