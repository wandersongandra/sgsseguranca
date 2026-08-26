import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as openAiRequestUtil from '../openai-request.util';
import { AiAnalysisService } from './ai-analysis.service';
import { AprsService } from '../../aprs/aprs.service';
import { PtsService } from '../../pts/pts.service';
import { DocumentStorageService } from '../../../shared/services/document-storage.service';
import { IntegrationResilienceService } from '../../../shared/resilience/integration-resilience.service';
import { OpenAiCircuitBreakerService } from '../../../shared/resilience/openai-circuit-breaker.service';
import { MetricsService } from '../../../shared/observability/metrics.service';

describe('AiAnalysisService', () => {
  let service: AiAnalysisService;
  let aprsService: jest.Mocked<Pick<AprsService, 'findOne'>>;
  let ptsService: jest.Mocked<Pick<PtsService, 'findOne'>>;
  let documentStorageService: jest.Mocked<
    Pick<DocumentStorageService, 'downloadFileBuffer'>
  >;
  let metricsService: jest.Mocked<
    Pick<
      MetricsService,
      'incrementAiInteraction' | 'recordAiResponseTime' | 'addAiTokensUsed'
    >
  >;

  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'OPENAI_API_KEY') return 'test-openai-key';
      if (key === 'OPENAI_MODEL') return 'gpt-5-mini';
      if (key === 'OPENAI_REASONING_EFFORT') return 'medium';
      return undefined;
    }),
  } as unknown as ConfigService;

  const integration = {} as IntegrationResilienceService;
  const circuitBreaker = {} as OpenAiCircuitBreakerService;

  function buildOpenAiJsonResponse(payload: unknown): Response {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(payload),
            },
          },
        ],
        usage: {
          prompt_tokens: 25,
          completion_tokens: 12,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    aprsService = {
      findOne: jest.fn(),
    };
    ptsService = {
      findOne: jest.fn(),
    };
    documentStorageService = {
      downloadFileBuffer: jest.fn(),
    };
    metricsService = {
      incrementAiInteraction: jest.fn(),
      recordAiResponseTime: jest.fn(),
      addAiTokensUsed: jest.fn(),
    };

    service = new AiAnalysisService(
      configService,
      integration,
      circuitBreaker,
      aprsService as unknown as AprsService,
      ptsService as unknown as PtsService,
      documentStorageService as unknown as DocumentStorageService,
      metricsService as unknown as MetricsService,
    );
  });

  it('analyzeAprDescription retorna contrato normalizado e registra métricas', async () => {
    jest
      .spyOn(openAiRequestUtil, 'requestOpenAiChatCompletionResponse')
      .mockResolvedValue(
        buildOpenAiJsonResponse({
          risks: ['queda_altura'],
          epis: ['cinto_paraquedista'],
          explanation: 'Risco principal de queda durante atividade em altura.',
          confidence: 'high',
          notes: ['priorizar linha de vida'],
        }),
      );

    const response = await service.analyzeAprDescription(
      'Montagem em telhado metálico',
      'tenant-a',
    );

    expect(response.risks).toEqual(['queda_altura']);
    expect(response.epis).toEqual(['cinto_paraquedista']);
    expect(response.confidence).toBe('high');
    expect(metricsService.incrementAiInteraction).toHaveBeenCalledWith(
      'tenant-a',
      'apr',
    );
    expect(metricsService.addAiTokensUsed).toHaveBeenCalled();
  });

  it('analyzeApr por id carrega APR do tenant e delega para análise de descrição', async () => {
    aprsService.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'tenant-a',
      descricao: 'Inspeção em plataforma elevada',
    } as never);
    const spy = jest.spyOn(service, 'analyzeAprDescription').mockResolvedValue({
      risks: ['queda'],
      epis: ['capacete'],
      explanation: 'Teste',
    });

    const result = await service.analyzeApr('apr-1', 'tenant-a');

    expect(aprsService.findOne).toHaveBeenCalledWith('apr-1');
    expect(spy).toHaveBeenCalledWith(
      'Inspeção em plataforma elevada',
      'tenant-a',
    );
    expect(result).toMatchObject({
      explanation: 'Teste',
    });
  });

  it('analyzePtPayload normaliza resposta com decisão de automação', async () => {
    jest
      .spyOn(openAiRequestUtil, 'requestOpenAiChatCompletionResponse')
      .mockResolvedValue(
        buildOpenAiJsonResponse({
          summary: 'Atividade com energia isolada e risco moderado.',
          riskLevel: 'Médio',
          suggestions: ['bloqueio elétrico', 'sinalização da área'],
          confidence: 'medium',
        }),
      );

    const response = await service.analyzePtPayload(
      {
        titulo: 'Intervenção em painel',
        descricao: 'Substituição de componente elétrico',
        eletricidade: true,
      },
      'tenant-b',
    );

    expect(response.riskLevel).toBe('Médio');
    expect(response.automation).toBeDefined();
    expect(response.automation?.phase).toBe('phase2');
    expect(metricsService.incrementAiInteraction).toHaveBeenCalledWith(
      'tenant-b',
      'pt',
    );
  });

  it('analyzeImage processa imagem e retorna resposta estruturada', async () => {
    jest
      .spyOn(openAiRequestUtil, 'requestOpenAiChatCompletionResponse')
      .mockResolvedValue(
        buildOpenAiJsonResponse({
          summary: 'Risco de queda sem guarda-corpo.',
          riskLevel: 'Alto',
          imminentRisks: ['queda de altura'],
          immediateActions: ['isolar área'],
          ppeRecommendations: ['cinto de segurança'],
          confidence: 'high',
        }),
      );

    const response = await service.analyzeImage(
      Buffer.from('fake-image-buffer'),
      'atividade em andaime',
      'tenant-c',
    );

    expect(response).toMatchObject({
      riskLevel: 'Alto',
      confidence: 'high',
    });
    expect(metricsService.incrementAiInteraction).toHaveBeenCalledWith(
      'tenant-c',
      'image-analysis',
    );
  });

  it('rejeita imagem vazia sem resolver chave de storage a partir do contexto', async () => {
    await expect(
      service.analyzeImage(
        Buffer.alloc(0),
        JSON.stringify({ storageKey: 'documents/tenant-c/forged.jpg' }),
        'tenant-c',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(documentStorageService.downloadFileBuffer).not.toHaveBeenCalled();
  });

  it('bloqueia imagem antes de enviar ao GPT-OSS textual da NVIDIA', async () => {
    const nvidiaConfig = {
      get: jest.fn((key: string) => {
        if (key === 'AI_PROVIDER') return 'nvidia';
        if (key === 'NVIDIA_API_KEY') return 'nvapi-test-key';
        return undefined;
      }),
    } as unknown as ConfigService;
    const nvidiaService = new AiAnalysisService(
      nvidiaConfig,
      integration,
      circuitBreaker,
      aprsService as unknown as AprsService,
      ptsService as unknown as PtsService,
      documentStorageService as unknown as DocumentStorageService,
      metricsService as unknown as MetricsService,
    );
    const requestSpy = jest.spyOn(
      openAiRequestUtil,
      'requestOpenAiChatCompletionResponse',
    );

    await expect(
      nvidiaService.analyzeImage(
        Buffer.from('fake-image-buffer'),
        'atividade em andaime',
        'tenant-c',
      ),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(requestSpy).not.toHaveBeenCalled();
  });
});
