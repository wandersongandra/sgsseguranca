/**
 * Resolução do runtime LLM da Sophie.
 *
 * Cada runtime reúne credencial, endpoint, modelo e capacidades do mesmo
 * provedor. Eles não podem ser combinados entre provedores: uma chave OpenAI
 * nunca deve ser usada em uma URL NVIDIA, nem o inverso.
 */

import { InternalServerErrorException } from '@nestjs/common';
import { isAiFeatureEnabled } from '../../shared/config/ai-feature-policy';

export type AiLlmProviderName =
  'openai' | 'nvidia' | 'stub' | 'local' | 'anthropic' | 'gemini';

export type OpenAiCompatibleProviderName = 'openai' | 'nvidia';
export type AiReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export type AiLlmRuntimeConfig = {
  /** Provedor efetivo em runtime (após resolução). */
  provider: AiLlmProviderName;
  /** Provedor solicitado via AI_PROVIDER. */
  configuredProvider: string;
  configured: boolean;
  apiKey: string | null;
  baseUrl: string;
  chatCompletionsUrl: string;
  model: string;
  visionModel: string | null;
  fallbackModel: string | null;
  reasoningEffort: AiReasoningEffort;
  /** Papel de sistema enviado no payload (developer = OpenAI moderno). */
  systemRole: 'developer' | 'system';
  imageAnalysisEnabled: boolean;
  officialProvider: string;
  runtimeMode: 'online' | 'degraded';
};

export type ConfiguredAiLlmRuntimeConfig = AiLlmRuntimeConfig & {
  provider: OpenAiCompatibleProviderName;
  configured: true;
  apiKey: string;
  runtimeMode: 'online';
};

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-2024-11-20';
export const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_NVIDIA_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_REASONING_EFFORT: AiReasoningEffort = 'medium';

type ConfigGetter = {
  get<T = string>(key: string): T | undefined;
};

function readString(config: ConfigGetter, key: string): string {
  const value = config.get<string>(key);
  return typeof value === 'string' ? value.trim() : '';
}

function parseReasoningEffort(
  rawValue: string,
  allowed: readonly AiReasoningEffort[],
): AiReasoningEffort | null {
  const raw = rawValue.toLowerCase();
  return allowed.includes(raw as AiReasoningEffort)
    ? (raw as AiReasoningEffort)
    : null;
}

function resolveOpenAiReasoningEffort(config: ConfigGetter): AiReasoningEffort {
  return (
    parseReasoningEffort(readString(config, 'OPENAI_REASONING_EFFORT'), [
      'minimal',
      'low',
      'medium',
      'high',
    ]) ?? DEFAULT_REASONING_EFFORT
  );
}

function resolveNvidiaReasoningEffort(config: ConfigGetter): AiReasoningEffort {
  // O endpoint do GPT-OSS na NVIDIA aceita low, medium e high; não envia
  // "minimal", que é específico de alguns modelos OpenAI.
  return (
    parseReasoningEffort(readString(config, 'NVIDIA_REASONING_EFFORT'), [
      'low',
      'medium',
      'high',
    ]) ?? DEFAULT_REASONING_EFFORT
  );
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function joinChatCompletionsUrl(baseUrl: string): string {
  const base = stripTrailingSlash(baseUrl);
  if (base.endsWith('/chat/completions')) {
    return base;
  }
  return `${base}/chat/completions`;
}

/**
 * Credenciais só podem sair para o endpoint oficial do provedor. Isso evita
 * SSRF e exfiltração por uma URL de ambiente apontada para host arbitrário.
 */
function resolveTrustedBaseUrl(params: {
  rawValue: string;
  defaultValue: string;
  hostname: string;
  provider: string;
}): string {
  const candidate = params.rawValue || params.defaultValue;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InternalServerErrorException(
      `URL base inválida para o provedor ${params.provider}.`,
    );
  }

  const pathname = stripTrailingSlash(parsed.pathname);
  const validPath = pathname === '/v1' || pathname === '/v1/chat/completions';
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== params.hostname ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !validPath
  ) {
    throw new InternalServerErrorException(
      `URL base não confiável para o provedor ${params.provider}. Use o endpoint oficial HTTPS.`,
    );
  }

  return `${parsed.origin}${pathname}`;
}

function resolveDegradedRuntime(params: {
  configuredProvider: AiLlmProviderName;
  officialProvider: string;
}): AiLlmRuntimeConfig {
  return {
    provider: params.configuredProvider === 'local' ? 'local' : 'stub',
    configuredProvider: params.configuredProvider,
    configured: false,
    apiKey: null,
    baseUrl: DEFAULT_OPENAI_BASE_URL,
    chatCompletionsUrl: joinChatCompletionsUrl(DEFAULT_OPENAI_BASE_URL),
    model: 'stub',
    visionModel: null,
    fallbackModel: null,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    systemRole: 'system',
    imageAnalysisEnabled: false,
    officialProvider: params.officialProvider,
    runtimeMode: 'degraded',
  };
}

export function resolveAiLlmRuntimeConfig(
  config: ConfigGetter,
): AiLlmRuntimeConfig {
  if (!isAiFeatureEnabled(config)) {
    return resolveDegradedRuntime({
      configuredProvider: 'stub',
      officialProvider: 'disabled',
    });
  }
  const configuredProvider = (
    readString(config, 'AI_PROVIDER') || 'openai'
  ).toLowerCase() as AiLlmProviderName;

  if (configuredProvider === 'nvidia') {
    const apiKey = readString(config, 'NVIDIA_API_KEY') || null;
    const baseUrl = resolveTrustedBaseUrl({
      rawValue: readString(config, 'NVIDIA_API_BASE_URL'),
      defaultValue: DEFAULT_NVIDIA_BASE_URL,
      hostname: 'integrate.api.nvidia.com',
      provider: 'nvidia',
    });
    const model = readString(config, 'NVIDIA_MODEL') || DEFAULT_NVIDIA_MODEL;
    const fallbackModel = readString(config, 'NVIDIA_FALLBACK_MODEL') || null;
    const configured = Boolean(apiKey);

    return {
      provider: configured ? 'nvidia' : 'stub',
      configuredProvider: 'nvidia',
      configured,
      apiKey,
      baseUrl,
      chatCompletionsUrl: joinChatCompletionsUrl(baseUrl),
      model,
      // gpt-oss-120b é text-only. Um modelo visual NVIDIA deve ser integrado
      // explicitamente em uma mudança futura, com revisão LGPD própria.
      visionModel: null,
      fallbackModel,
      reasoningEffort: resolveNvidiaReasoningEffort(config),
      systemRole: 'system',
      imageAnalysisEnabled: false,
      officialProvider: 'nvidia',
      runtimeMode: configured ? 'online' : 'degraded',
    };
  }

  if (configuredProvider === 'openai') {
    const apiKey = readString(config, 'OPENAI_API_KEY') || null;
    const baseUrl = resolveTrustedBaseUrl({
      rawValue: readString(config, 'OPENAI_BASE_URL'),
      defaultValue: DEFAULT_OPENAI_BASE_URL,
      hostname: 'api.openai.com',
      provider: 'openai',
    });
    const model = readString(config, 'OPENAI_MODEL') || DEFAULT_OPENAI_MODEL;
    const visionModel =
      readString(config, 'OPENAI_VISION_MODEL') ||
      model ||
      DEFAULT_OPENAI_MODEL;
    const fallbackModel = readString(config, 'OPENAI_FALLBACK_MODEL') || null;
    const configured = Boolean(apiKey);

    return {
      provider: configured ? 'openai' : 'stub',
      configuredProvider: 'openai',
      configured,
      apiKey,
      baseUrl,
      chatCompletionsUrl: joinChatCompletionsUrl(baseUrl),
      model,
      visionModel,
      fallbackModel,
      reasoningEffort: resolveOpenAiReasoningEffort(config),
      systemRole: 'developer',
      imageAnalysisEnabled: configured,
      officialProvider: 'openai',
      runtimeMode: configured ? 'online' : 'degraded',
    };
  }

  if (configuredProvider === 'stub' || configuredProvider === 'local') {
    return resolveDegradedRuntime({
      configuredProvider,
      officialProvider: configuredProvider,
    });
  }

  // Anthropic/Gemini não compartilham este cliente OpenAI-compatible. Nunca
  // recair silenciosamente para OpenAI, pois isso mudaria o destinatário dos
  // dados e da credencial sem uma configuração explícita.
  return resolveDegradedRuntime({
    configuredProvider,
    officialProvider: configuredProvider,
  });
}

export function isConfiguredAiLlmRuntime(
  runtime: AiLlmRuntimeConfig,
): runtime is ConfiguredAiLlmRuntimeConfig {
  return (
    (runtime.provider === 'openai' || runtime.provider === 'nvidia') &&
    runtime.configured &&
    typeof runtime.apiKey === 'string' &&
    runtime.apiKey.length > 0 &&
    runtime.runtimeMode === 'online'
  );
}

export function supportsReasoningEffort(model: string): boolean {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  return (
    normalized.startsWith('gpt-5') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4') ||
    normalized.includes('gpt-oss')
  );
}

/**
 * Normaliza roles/campos do body para o provedor alvo.
 * NVIDIA espera `system` como primeira mensagem e usa `max_tokens`.
 */
export function normalizeChatCompletionBodyForProvider(
  body: Record<string, unknown>,
  runtime: Pick<ConfiguredAiLlmRuntimeConfig, 'provider' | 'systemRole'>,
  model: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };

  if (Array.isArray(next.messages) && runtime.systemRole === 'system') {
    next.messages = next.messages.map((message): unknown => {
      if (
        message &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        (message as { role?: unknown }).role === 'developer'
      ) {
        return { ...(message as Record<string, unknown>), role: 'system' };
      }
      return message;
    });
  }

  if (runtime.provider === 'nvidia' && 'max_completion_tokens' in next) {
    if (!('max_tokens' in next)) {
      next.max_tokens = next.max_completion_tokens;
    }
    delete next.max_completion_tokens;
  }

  if (!supportsReasoningEffort(model) && 'reasoning_effort' in next) {
    delete next.reasoning_effort;
  }

  return next;
}
