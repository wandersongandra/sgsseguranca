import axios from 'axios';
import api from '@/lib/api';
import { extractApiErrorMessage } from '@/lib/error-handler';
import type {
  DocumentMailDispatchResponse as GeneratedMailDispatchResponse,
  DocumentMailArtifactType as GeneratedMailArtifactType,
  DocumentMailDeliveryMode as GeneratedMailDeliveryMode,
} from '@/lib/api/generated/governed-contracts.client';

export type DocumentMailArtifactType = GeneratedMailArtifactType;
export type DocumentMailDeliveryMode = GeneratedMailDeliveryMode;
export type DocumentMailDispatchResponse = GeneratedMailDispatchResponse;
export type DispatchAlertsResponse = {
  success: boolean;
  recipients: string[];
  previewUrl?: string;
  usingTestAccount?: boolean;
  whatsappSent?: boolean;
};
export type AlertSettingsResponse = {
  enabled: boolean;
  recipients: string[];
  includeWhatsapp: boolean;
  lookaheadDays: number;
  includeComplianceSummary: boolean;
  includeOperationsSummary: boolean;
  includeOccurrencesSummary: boolean;
  deliveryHour: number;
  weekdaysOnly: boolean;
  cadenceDays: number;
  skipWhenNoPending: boolean;
  minimumPendingItems: number;
  subjectPrefix?: string | null;
  snoozeUntil?: string | null;
  lastScheduledDispatchAt?: string | null;
  nextScheduledDispatchAt?: string | null;
  fallbackRecipients: string[];
  providerConfigured: boolean;
};
export type AlertPreviewResponse = {
  generatedAt: string;
  lookaheadDays: number;
  pendingItemsCount: number;
  compliancePendingCount: number;
  operationsPendingCount: number;
  occurrencesPendingCount: number;
  summary: string;
};

type MailDispatchErrorPayload = {
  message?: unknown;
  code?: unknown;
  retryAfterSeconds?: unknown;
};

export const mailService = {
  async sendStoredDocument(
    documentId: string,
    documentType: string,
    email: string,
  ): Promise<DocumentMailDispatchResponse> {
    const response = await api.post('/mail/send-stored-document', {
      documentId,
      documentType,
      email,
    });
    return response.data as DocumentMailDispatchResponse;
  },

  async sendUploadedDocument(
    file: Blob,
    filename: string,
    email: string,
    docName: string,
    subject?: string,
  ): Promise<DocumentMailDispatchResponse> {
    const formData = new FormData();
    formData.append('file', file, filename);
    formData.append('email', email);
    formData.append('docName', docName);
    if (subject?.trim()) {
      formData.append('subject', subject.trim());
    }

    const response = await api.post('/mail/send-uploaded-document', formData);
    return response.data as DocumentMailDispatchResponse;
  },

  async dispatchAlerts(payload: {
    to?: string;
    includeWhatsapp?: boolean;
  }): Promise<DispatchAlertsResponse> {
    const response = await api.post<DispatchAlertsResponse>(
      '/mail/alerts/dispatch',
      payload,
    );
    return response.data;
  },

  async getAlertSettings(): Promise<AlertSettingsResponse> {
    const response = await api.get<AlertSettingsResponse>('/mail/alerts/settings');
    return response.data;
  },

  async updateAlertSettings(payload: {
    enabled?: boolean;
    recipients?: string[];
    includeWhatsapp?: boolean;
    lookaheadDays?: number;
    includeComplianceSummary?: boolean;
    includeOperationsSummary?: boolean;
    includeOccurrencesSummary?: boolean;
    deliveryHour?: number;
    weekdaysOnly?: boolean;
    cadenceDays?: number;
    skipWhenNoPending?: boolean;
    subjectPrefix?: string | null;
    minimumPendingItems?: number;
    snoozeUntil?: string | null;
  }): Promise<AlertSettingsResponse> {
    const response = await api.patch<AlertSettingsResponse>('/mail/alerts/settings', payload);
    return response.data;
  },

  async getAlertPreview(): Promise<AlertPreviewResponse> {
    const response = await api.get<AlertPreviewResponse>('/mail/alerts/preview');
    return response.data;
  },
};

export async function extractMailDispatchErrorMessage(
  error: unknown,
): Promise<string> {
  const fallback =
    'Nao foi possivel enviar o e-mail agora. Tente novamente em instantes.';
  const message = await extractApiErrorMessage(error, fallback);

  if (!axios.isAxiosError(error)) {
    return message;
  }

  const data = (error.response?.data ?? null) as MailDispatchErrorPayload | null;
  const code = typeof data?.code === 'string' ? data.code : undefined;
  const retryAfterSeconds =
    typeof data?.retryAfterSeconds === 'number'
      ? data.retryAfterSeconds
      : undefined;

  if (code === 'MAIL_PROVIDER_CIRCUIT_OPEN') {
    return retryAfterSeconds
      ? `O envio de e-mail esta temporariamente pausado apos falhas recentes no provedor. Aguarde cerca de ${retryAfterSeconds}s e tente novamente.`
      : message;
  }

  return message;
}
