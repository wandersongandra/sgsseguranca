import type {
  PhotographicReportAreaStatus,
  PhotographicReportRegistrationType,
  PhotographicReportShift,
  PhotographicReportStatus,
  PhotographicReportTone,
} from '@/services/photographicReportsService';
import type { ProcessedMobileImage } from '@/lib/images/process-mobile-image';

export type WizardStep = 1 | 2 | 3;

export type ReportFormState = {
  client_id: string;
  project_id: string;
  client_name: string;
  project_name: string;
  unit_name: string;
  location: string;
  activity_type: string;
  report_tone: PhotographicReportTone;
  area_status: PhotographicReportAreaStatus;
  shift: PhotographicReportShift;
  start_date: string;
  end_date: string;
  start_time: string;
  end_time: string;
  responsible_name: string;
  responsible_registration_type: PhotographicReportRegistrationType | '';
  responsible_registration_number: string;
  responsible_registration_state: string;
  art_number: string;
  contractor_company: string;
  applicable_nrs: string[];
  inspection_methodology: string;
  scope_and_limitations: string;
  general_observations: string;
  ai_summary: string;
  final_conclusion: string;
  status: PhotographicReportStatus;
};

export type PendingPhoto = {
  id: string;
  original: File;
  processed?: ProcessedMobileImage;
  previewUrl?: string;
  status: 'processing' | 'ready' | 'error' | 'cancelled';
  error?: string;
  /**
   * Data de captura, lida de `original.lastModified` ANTES do processamento.
   * O `processMobileImage` re-encoda via canvas e destrói o EXIF, mas
   * `lastModified` sobrevive — em câmera de celular, é a hora da foto.
   */
  capturedAt?: string;
};

/**
 * Posição do operador no momento do envio — uma por lote, não por foto.
 * Vazio quando o navegador nega ou não suporta geolocalização.
 */
export type UploadGeoContext = {
  latitude?: number;
  longitude?: number;
  accuracy_m?: number;
  /** Distingue "negado/indisponível" de "ainda não tentado". */
  denied?: boolean;
};
