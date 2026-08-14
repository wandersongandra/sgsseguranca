import {
  PhotographicReportAreaStatus,
  PhotographicReportShift,
  PhotographicReportStatus,
  PhotographicReportTone,
} from './entities/photographic-report.entity';
import { PhotographicReportExportType } from './entities/photographic-report-export.entity';
import type { PhotographicReportRegistrationType } from './photographic-reports.constants';

export type PhotographicReportDayResponse = {
  id: string;
  report_id: string;
  activity_date: string;
  day_summary: string | null;
  created_at: string;
  updated_at: string;
  image_count?: number;
};

export type PhotographicReportImageResponse = {
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
  photo_conditions: string[] | null;

  // Não conformidade
  is_nonconformity: boolean;
  recommended_action: string | null;
  action_deadline: string | null;
  action_responsible: string | null;

  // Integridade da evidência.
  //
  // `device_id` e `ip_address` são DELIBERADAMENTE omitidos desta resposta.
  // Já estão HMAC-ados/mascarados em repouso, e reemiti-los pela API para
  // qualquer usuário com can_manage_photographic_reports amplia a superfície
  // sem entregar nada de produto — eles existem só para o manifesto de
  // evidências, renderizado no servidor. Não adicione aqui.
  original_name: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  /** Âncora pública de integridade, exposta como no APR. */
  hash_sha256: string | null;
  captured_at: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  exif_datetime: string | null;
  integrity_flags: Record<string, unknown> | null;

  created_at: string;
  updated_at: string;
  day?: PhotographicReportDayResponse | null;
};

export type PhotographicReportExportResponse = {
  id: string;
  report_id: string;
  export_type: PhotographicReportExportType;
  file_url: string;
  download_url: string | null;
  generated_by: string | null;
  generated_at: string;
};

export type PhotographicReportListItemResponse = {
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
  responsible_registration_type: PhotographicReportRegistrationType | null;
  responsible_registration_number: string | null;
  responsible_registration_state: string | null;
  art_number: string | null;
  contractor_company: string;
  applicable_nrs: string[] | null;
  inspection_methodology: string | null;
  scope_and_limitations: string | null;
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

  // Governança. `pdf_file_key` e `pdf_folder_path` ficam de fora de propósito:
  // o acesso ao arquivo passa por `getPdfAccess`, que resolve pelo registry e
  // devolve URL assinada de curta duração. Expor a chave crua aqui contornaria
  // esse controle.
  verification_code: string | null;
  final_pdf_hash_sha256: string | null;
  pdf_generated_at: string | null;
};

export type PhotographicReportResponse = PhotographicReportListItemResponse & {
  days: PhotographicReportDayResponse[];
  images: PhotographicReportImageResponse[];
  exports: PhotographicReportExportResponse[];
};
