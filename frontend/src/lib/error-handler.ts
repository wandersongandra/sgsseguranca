import axios from 'axios';
import { toast } from 'sonner';

export interface FormErrorMessages {
  badRequest?: string;
  unauthorized?: string;
  forbidden?: string;
  notFound?: string;
  server?: string;
  fallback?: string;
}

function normalizeValidationDetails(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const entry = item as Record<string, unknown>;
    const field =
      typeof entry.field === 'string' && entry.field.trim().length > 0
        ? entry.field.trim()
        : undefined;
    const errors = Array.isArray(entry.errors)
      ? entry.errors.filter(
          (error): error is string =>
            typeof error === 'string' && error.trim().length > 0,
        )
      : [];

    if (errors.length > 0) {
      return field ? `${field}: ${errors[0]}` : errors[0];
    }
  }

  return undefined;
}

function normalizeUnknownMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeUnknownMessage(item);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    if ('details' in obj) {
      const normalizedDetails = normalizeValidationDetails(obj.details);
      if (normalizedDetails) {
        return normalizedDetails;
      }

      const normalized = normalizeUnknownMessage(obj.details);
      if (normalized) {
        return normalized;
      }
    }

    if ('errors' in obj) {
      const normalizedErrors = normalizeValidationDetails(obj.errors);
      if (normalizedErrors) {
        return normalizedErrors;
      }
    }

    if ('message' in obj) {
      const normalized = normalizeUnknownMessage(obj.message);
      if (normalized) {
        return normalized;
      }
    }

    if ('error' in obj) {
      const normalized = normalizeUnknownMessage(obj.error);
      if (normalized) {
        return normalized;
      }
    }
  }

  return undefined;
}

async function normalizeBlobMessage(value: Blob): Promise<string | undefined> {
  try {
    const rawText = (await value.text()).trim();
    if (!rawText) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(rawText) as unknown;
      return normalizeUnknownMessage(parsed) || rawText;
    } catch {
      return rawText;
    }
  } catch {
    return undefined;
  }
}

async function normalizeAsyncApiMessage(value: unknown): Promise<string | undefined> {
  if (
    value &&
    typeof value === 'object' &&
    'text' in value &&
    typeof (value as { text?: unknown }).text === 'function'
  ) {
    return normalizeBlobMessage(value as Blob);
  }

  return normalizeUnknownMessage(value);
}

export function getFormErrorMessage(
  error: unknown,
  messages: FormErrorMessages,
): string {
  if (!axios.isAxiosError(error)) {
    return messages.fallback || 'Erro inesperado. Tente novamente.';
  }

  const status = error.response?.status;
  const normalizedMessage = normalizeUnknownMessage(error.response?.data);

  switch (status) {
    case 400:
    case 422:
      return normalizedMessage || messages.badRequest || messages.fallback || 'Dados inválidos.';
    case 401:
      return messages.unauthorized || messages.fallback || 'Sessão expirada.';
    case 403:
      return messages.forbidden || messages.fallback || 'Sem permissão para esta operação.';
    case 404:
      return messages.notFound || messages.fallback || 'Registro não encontrado.';
    case 500:
      return messages.server || messages.fallback || 'Erro interno do servidor.';
    default:
      return messages.fallback || 'Falha na operação. Tente novamente.';
  }
}

export async function extractApiErrorMessage(
  error: unknown,
  fallback = 'Falha na operação. Tente novamente.',
): Promise<string> {
  if (!axios.isAxiosError(error)) {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    return fallback;
  }

  const status = error.response?.status;
  const normalizedMessage = await normalizeAsyncApiMessage(error.response?.data);

  switch (status) {
    case 400:
    case 422:
      return normalizedMessage || 'Dados inválidos. Verifique as informações enviadas.';
    case 401:
      return 'Sessão expirada. Faça login novamente.';
    case 403:
      return 'Você não tem permissão para realizar esta ação.';
    case 404:
      return normalizedMessage || 'O recurso solicitado não foi encontrado.';
    case 409:
      return normalizedMessage || 'A operação entrou em conflito com o estado atual do documento.';
    case 429: {
      if (normalizedMessage) return normalizedMessage;
      const retryHeader = error.response?.headers?.['retry-after'];
      const retryAfter =
        typeof retryHeader === 'string' ? parseInt(retryHeader, 10) : NaN;
      return !Number.isNaN(retryAfter) && retryAfter > 0
        ? `Muitas requisições. Tente novamente em ${retryAfter}s.`
        : 'Muitas requisições. Aguarde alguns instantes e tente novamente.';
    }
    case 500:
      return normalizedMessage || 'Erro interno no servidor. Tente novamente em instantes.';
    case 502:
    case 503:
    case 504:
      return normalizedMessage || 'O serviço está temporariamente indisponível. Tente novamente em breve.';
    default:
      return (
        normalizedMessage ||
        error.message ||
        fallback
      );
  }
}

/**
 * Centralizador de tratamento de erros de API.
 * Fornece mensagens amigáveis ao usuário baseadas no status code e contexto.
 */
export function handleApiError(error: unknown, context: string) {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data;
    const message = normalizeUnknownMessage(data);

    if (process.env.NODE_ENV !== 'production') {
      console.error(
        "[API Error] %s: status=%s message=%s",
        context,
        status ?? "unknown",
        message || "sem mensagem legível",
        {
          status,
          message,
          data,
          url: error.config?.url,
        },
      );
    }

    // Timeout: ECONNABORTED sem resposta do servidor
    if (error.code === 'ECONNABORTED' && !status) {
      toast.error('A operação está demorando mais que o esperado. Tente novamente.');
      return;
    }

    switch (status) {
      case 401:
        toast.error('Sessão expirada. Faça login novamente.');
        if (typeof window !== 'undefined') {
          window.location.replace('/login');
        }
        break;
      case 403:
        toast.error('Você não tem permissão para realizar esta ação.');
        break;
      case 404:
        toast.error(`${context} não encontrado(a).`);
        break;
      case 422:
      case 400:
        toast.error(message || 'Dados inválidos. Verifique os campos.');
        break;
      case 429: {
        const retryAfterRaw =
          error.response?.headers?.['retry-after'] ??
          (error.response?.data as Record<string, unknown> | undefined)
            ?.retryAfter;
        const retryAfter =
          typeof retryAfterRaw === 'number'
            ? retryAfterRaw
            : typeof retryAfterRaw === 'string'
              ? parseInt(retryAfterRaw, 10)
              : NaN;
        const waitMsg =
          !Number.isNaN(retryAfter) && retryAfter > 0
            ? ` Tente novamente em ${retryAfter}s.`
            : ' Aguarde alguns instantes.';
        toast.error(`Muitas requisições.${waitMsg}`);
        break;
      }
      case 500:
        toast.error('Erro interno no servidor. Nossa equipe já foi notificada.');
        break;
      default:
        toast.error(`Erro ao processar ${context.toLowerCase()}. Tente novamente.`);
    }
  } else {
    if (process.env.NODE_ENV !== 'production') {
      console.error("[Unexpected Error] %s:", context, error);
    }
    toast.error('Erro de conexão ou erro inesperado. Verifique sua internet.');
  }
}
