import {
  DEFAULT_NVIDIA_MODEL,
  isConfiguredAiLlmRuntime,
  resolveAiLlmRuntimeConfig,
} from './ai-llm.config';

function config(values: Record<string, string | undefined>) {
  return {
    get<T = string>(key: string): T | undefined {
      return values[key] as T | undefined;
    },
  };
}

describe('ai-llm.config', () => {
  it.each(['openai', 'nvidia', 'anthropic', 'gemini'])(
    'não carrega credenciais nem habilita runtime %s quando IA está desligada',
    (provider) => {
      const runtime = resolveAiLlmRuntimeConfig(
        config({
          FEATURE_AI_ENABLED: 'false',
          AI_PROVIDER: provider,
          OPENAI_API_KEY: 'synthetic-not-a-credential',
          NVIDIA_API_KEY: 'synthetic-not-a-credential',
          ANTHROPIC_API_KEY: 'synthetic-not-a-credential',
          GEMINI_API_KEY: 'synthetic-not-a-credential',
        }),
      );
      expect(runtime).toMatchObject({
        configured: false,
        apiKey: null,
        imageAnalysisEnabled: false,
        runtimeMode: 'degraded',
      });
    },
  );
  it('resolve NVIDIA NIM com chave, modelo e endpoint próprios', () => {
    const runtime = resolveAiLlmRuntimeConfig(
      config({
        AI_PROVIDER: 'nvidia',
        NVIDIA_API_KEY: 'nvapi-test-key',
        NVIDIA_MODEL: 'openai/gpt-oss-120b',
        NVIDIA_REASONING_EFFORT: 'high',
      }),
    );

    expect(isConfiguredAiLlmRuntime(runtime)).toBe(true);
    expect(runtime).toMatchObject({
      provider: 'nvidia',
      apiKey: 'nvapi-test-key',
      model: 'openai/gpt-oss-120b',
      systemRole: 'system',
      imageAnalysisEnabled: false,
      visionModel: null,
      reasoningEffort: 'high',
      chatCompletionsUrl:
        'https://integrate.api.nvidia.com/v1/chat/completions',
    });
  });

  it('nunca reutiliza chave, modelo ou URL OpenAI para NVIDIA', () => {
    const runtime = resolveAiLlmRuntimeConfig(
      config({
        AI_PROVIDER: 'nvidia',
        OPENAI_API_KEY: 'openai-secret',
        OPENAI_MODEL: 'gpt-4o-2024-11-20',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_VISION_MODEL: 'gpt-4o-2024-11-20',
      }),
    );

    expect(isConfiguredAiLlmRuntime(runtime)).toBe(false);
    expect(runtime.apiKey).toBeNull();
    expect(runtime.model).toBe(DEFAULT_NVIDIA_MODEL);
    expect(runtime.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(runtime.visionModel).toBeNull();
  });

  it('rejeita URL NVIDIA fora do host HTTPS oficial', () => {
    expect(() =>
      resolveAiLlmRuntimeConfig(
        config({
          AI_PROVIDER: 'nvidia',
          NVIDIA_API_KEY: 'nvapi-test-key',
          NVIDIA_API_BASE_URL: 'https://example.invalid/v1',
        }),
      ),
    ).toThrow('URL base não confiável para o provedor nvidia');
  });

  it('mantém OpenAI funcional com runtime próprio', () => {
    const runtime = resolveAiLlmRuntimeConfig(
      config({
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: 'openai-test-key',
        OPENAI_MODEL: 'gpt-5-mini',
      }),
    );

    expect(isConfiguredAiLlmRuntime(runtime)).toBe(true);
    expect(runtime).toMatchObject({
      provider: 'openai',
      apiKey: 'openai-test-key',
      model: 'gpt-5-mini',
      systemRole: 'developer',
    });
  });
});
