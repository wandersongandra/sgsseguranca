import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { IntegrationResilienceService } from '../../shared/resilience/integration-resilience.service';
import { requestOpenAiChatCompletionResponse } from './openai-request.util';
import { OpenAiCircuitBreakerService } from '../../shared/resilience/openai-circuit-breaker.service';
import { type ConfiguredAiLlmRuntimeConfig } from './ai-llm.config';

describe('openai-request.util', () => {
  const openAiRuntime: ConfiguredAiLlmRuntimeConfig = {
    provider: 'openai',
    configuredProvider: 'openai',
    configured: true,
    apiKey: 'key-1',
    baseUrl: 'https://api.openai.com/v1',
    chatCompletionsUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-5-mini',
    visionModel: 'gpt-5-mini',
    fallbackModel: null,
    reasoningEffort: 'medium',
    systemRole: 'developer',
    imageAnalysisEnabled: true,
    officialProvider: 'openai',
    runtimeMode: 'online',
  };

  const nvidiaRuntime: ConfiguredAiLlmRuntimeConfig = {
    provider: 'nvidia',
    configuredProvider: 'nvidia',
    configured: true,
    apiKey: 'nvapi-key-1',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    chatCompletionsUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'openai/gpt-oss-120b',
    visionModel: null,
    fallbackModel: null,
    reasoningEffort: 'medium',
    systemRole: 'system',
    imageAnalysisEnabled: false,
    officialProvider: 'nvidia',
    runtimeMode: 'online',
  };

  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'OPENAI_CHAT_COMPLETION_TIMEOUT_MS') return '250';
      return undefined;
    }),
  } as unknown as ConfigService;

  function createIntegrationMock(): {
    execute: jest.MockedFunction<IntegrationResilienceService['execute']>;
  } {
    return {
      execute: jest.fn(
        async <T>(_name: string, fn: () => Promise<T>, _opts?: unknown) => fn(),
      ) as unknown as jest.MockedFunction<
        IntegrationResilienceService['execute']
      >,
    };
  }

  function createCircuitBreakerMock(): jest.Mocked<
    Pick<
      OpenAiCircuitBreakerService,
      | 'assertRequestAllowed'
      | 'recordSuccess'
      | 'recordFailure'
      | 'isCountableFailureStatus'
      | 'isCountableFailureError'
    >
  > {
    return {
      assertRequestAllowed: jest.fn().mockResolvedValue(undefined),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
      isCountableFailureStatus: jest
        .fn()
        .mockImplementation((status: number) =>
          [500, 502, 503].includes(status),
        ),
      isCountableFailureError: jest.fn().mockReturnValue(false),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('revalida a flag antes do transporte quando o retry comeÃ§a apÃ³s desativaÃ§Ã£o', async () => {
    let enabled = true;
    const runtimeConfig = {
      get: (key: string) =>
        key === 'FEATURE_AI_ENABLED' ? enabled : undefined,
    } as unknown as ConfigService;
    const integration = createIntegrationMock();
    integration.execute.mockImplementationOnce(
      <T>(_name: string, callback: () => Promise<T>) => {
        enabled = false;
        return callback();
      },
    );
    const circuitBreaker = createCircuitBreakerMock();
    const fetchImpl: typeof fetch = jest
      .fn()
      .mockResolvedValue(new Response('{}'));
    await expect(
      requestOpenAiChatCompletionResponse({
        runtime: openAiRuntime,
        body: { model: openAiRuntime.model },
        configService: runtimeConfig,
        integration: integration as unknown as IntegrationResilienceService,
        circuitBreaker:
          circuitBreaker as unknown as OpenAiCircuitBreakerService,
        fetchImpl,
      }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([openAiRuntime, nvidiaRuntime])(
    'bloqueia outbound de $provider quando IA estÃ¡ desabilitada',
    async (runtime) => {
      const integration = createIntegrationMock();
      const circuitBreaker = createCircuitBreakerMock();
      const fetchImpl: typeof fetch = jest
        .fn()
        .mockResolvedValue(new Response('{}'));
      const disabledConfig = new ConfigService({ FEATURE_AI_ENABLED: false });

      await expect(
        requestOpenAiChatCompletionResponse({
          runtime,
          body: {
            model: runtime.model,
            messages: [{ role: 'user', content: 'synthetic' }],
          },
          configService: disabledConfig,
          integration: integration as unknown as IntegrationResilienceService,
          circuitBreaker:
            circuitBreaker as unknown as OpenAiCircuitBreakerService,
          fetchImpl,
        }),
      ).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(integration.execute).not.toHaveBeenCalled();
      expect(circuitBreaker.assertRequestAllowed).not.toHaveBeenCalled();
    },
  );

  it('usa o wrapper de resiliencia para chamar a OpenAI', async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchImpl: typeof fetch = jest.fn().mockResolvedValue(response);
    const integration = createIntegrationMock();
    const circuitBreaker = createCircuitBreakerMock();

    const result = await requestOpenAiChatCompletionResponse({
      runtime: openAiRuntime,
      body: { model: 'gpt-5-mini' },
      configService,
      integration: integration as unknown as IntegrationResilienceService,
      circuitBreaker: circuitBreaker as unknown as OpenAiCircuitBreakerService,
      fetchImpl,
    });

    expect(result).toBe(response);
    expect(circuitBreaker.assertRequestAllowed).toHaveBeenCalledTimes(1);
    expect(circuitBreaker.recordSuccess).toHaveBeenCalledTimes(1);
    expect(integration.execute).toHaveBeenCalledTimes(1);
    const [, integrationCallback, integrationOptions] = integration.execute.mock
      .calls[0] as [
      string,
      () => Promise<Response>,
      { timeoutMs: number; retry: { attempts: number; mode: string } },
    ];
    expect(typeof integrationCallback).toBe('function');
    expect(integrationOptions.timeoutMs).toBe(250);
    expect(integrationOptions.retry).toMatchObject({
      attempts: 2,
      mode: 'safe',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = (fetchImpl as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(fetchUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect(fetchOptions.method).toBe('POST');
    expect(fetchOptions.headers).toMatchObject({
      Authorization: 'Bearer key-1',
    });
  });

  it('usa credencial, URL e normalizaÃ§Ã£o prÃ³prias do runtime NVIDIA', async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchImpl: typeof fetch = jest.fn().mockResolvedValue(response);
    const integration = createIntegrationMock();
    const circuitBreaker = createCircuitBreakerMock();

    await requestOpenAiChatCompletionResponse({
      runtime: nvidiaRuntime,
      body: {
        model: 'openai/gpt-oss-120b',
        max_completion_tokens: 600,
        messages: [
          { role: 'developer', content: 'InstruÃ§Ãµes do sistema.' },
          { role: 'user', content: 'Liste riscos de SST.' },
        ],
      },
      configService,
      integration: integration as unknown as IntegrationResilienceService,
      circuitBreaker: circuitBreaker as unknown as OpenAiCircuitBreakerService,
      fetchImpl,
    });

    const [fetchUrl, fetchOptions] = (fetchImpl as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(fetchUrl).toBe(
      'https://integrate.api.nvidia.com/v1/chat/completions',
    );
    expect(fetchOptions.headers).toMatchObject({
      Authorization: 'Bearer nvapi-key-1',
    });

    if (typeof fetchOptions.body !== 'string') {
      throw new Error('O payload NVIDIA deveria ser serializado em JSON.');
    }

    const body = JSON.parse(fetchOptions.body) as {
      max_tokens?: number;
      max_completion_tokens?: number;
      messages?: Array<{ role: string }>;
    };
    expect(body.max_tokens).toBe(600);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.messages?.[0]?.role).toBe('system');
  });

  it('sanitiza PII e contexto sensÃ­vel antes de enviar para a OpenAI', async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchImpl: typeof fetch = jest.fn().mockResolvedValue(response);
    const integration = createIntegrationMock();
    const circuitBreaker = createCircuitBreakerMock();

    await requestOpenAiChatCompletionResponse({
      runtime: openAiRuntime,
      body: {
        model: 'gpt-5-mini',
        metadata: {
          name: 'Wanderson',
          role: 'TST',
        },
        tools: [
          {
            type: 'function',
            function: {
              name: 'buscar_treinamentos_pendentes',
              description: 'Consulta treinamentos pendentes no tenant atual.',
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                },
              },
            },
          },
        ],
        messages: [
          {
            role: 'user',
            content:
              'Participantes: {"nome":"Wanderson","funcao":"TST","site":"Obra Alfa","email":"w@sgs.com"} CPF 123.456.789-00',
          },
        ],
      },
      configService,
      integration: integration as unknown as IntegrationResilienceService,
      circuitBreaker: circuitBreaker as unknown as OpenAiCircuitBreakerService,
      fetchImpl,
    });

    const [, fetchOptions] = (fetchImpl as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const rawBody =
      typeof fetchOptions.body === 'string' ? fetchOptions.body : '{}';
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    const tools = body.tools as Array<{
      function: { name: string };
    }>;

    expect(messages[0].role).toBe('user');
    expect(tools[0].function.name).toBe('buscar_treinamentos_pendentes');
    expect(JSON.stringify(body)).not.toContain('Wanderson');
    expect(JSON.stringify(body)).not.toContain('Obra Alfa');
    expect(JSON.stringify(body)).not.toContain('TST');
    expect(JSON.stringify(body)).not.toContain('123.456.789-00');
    expect(JSON.stringify(body)).toContain('[REDACTED_NAME]');
    expect(JSON.stringify(body)).toContain('[REDACTED_ROLE]');
    expect(JSON.stringify(body)).toContain('[REDACTED_SITE]');
    expect(JSON.stringify(body)).toContain('[EMAIL]');
    expect(JSON.stringify(body)).toContain('[CPF]');
  });

  it('transforma abort local em erro de timeout legivel', async () => {
    jest.useFakeTimers();
    const fetchImpl: typeof fetch = jest.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const integration = createIntegrationMock();
    const circuitBreaker = createCircuitBreakerMock();
    circuitBreaker.isCountableFailureError.mockReturnValue(true);

    const handled = requestOpenAiChatCompletionResponse({
      runtime: openAiRuntime,
      body: { model: 'gpt-5-mini' },
      configService,
      integration: integration as unknown as IntegrationResilienceService,
      circuitBreaker: circuitBreaker as unknown as OpenAiCircuitBreakerService,
      fetchImpl,
    }).catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(260);

    const error = await handled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'LLM request timeout after 250ms',
    );
    expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });

  it('falha imediatamente quando o circuit breaker esta aberto', async () => {
    const integration = createIntegrationMock();
    const circuitBreaker = createCircuitBreakerMock();
    const fetchImpl: typeof fetch = jest.fn();
    circuitBreaker.assertRequestAllowed.mockRejectedValue(
      new ServiceUnavailableException(
        'ServiÃ§o de IA temporariamente indisponÃ­vel. Tente novamente em alguns instantes.',
      ),
    );

    await expect(
      requestOpenAiChatCompletionResponse({
        runtime: openAiRuntime,
        body: { model: 'gpt-5-mini' },
        configService,
        integration: integration as unknown as IntegrationResilienceService,
        circuitBreaker:
          circuitBreaker as unknown as OpenAiCircuitBreakerService,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(integration.execute).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('registra falha countable para status 503', async () => {
    const response = new Response(JSON.stringify({ error: 'upstream down' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchImpl: typeof fetch = jest.fn().mockResolvedValue(response);
    const integration = createIntegrationMock();
    const circuitBreaker = createCircuitBreakerMock();

    const result = await requestOpenAiChatCompletionResponse({
      runtime: openAiRuntime,
      body: { model: 'gpt-5-mini' },
      configService,
      integration: integration as unknown as IntegrationResilienceService,
      circuitBreaker: circuitBreaker as unknown as OpenAiCircuitBreakerService,
      fetchImpl,
    });

    expect(result.status).toBe(503);
    expect(circuitBreaker.recordFailure).toHaveBeenCalledWith({ status: 503 });
    expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
  });
});
