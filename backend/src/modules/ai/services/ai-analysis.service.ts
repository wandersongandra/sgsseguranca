import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AprsService } from '../../aprs/aprs.service';
import { PtsService } from '../../pts/pts.service';
import { DocumentStorageService } from '../../../shared/services/document-storage.service';
import { IntegrationResilienceService } from '../../../shared/resilience/integration-resilience.service';
import { OpenAiCircuitBreakerService } from '../../../shared/resilience/openai-circuit-breaker.service';
import { requestOpenAiChatCompletionResponse } from '../openai-request.util';
import { getSophieSystemPrompt } from '../sophie.prompt-resolver';
import { SOPHIE_JSON_RUNTIME_INSTRUCTION } from '../sophie-task-prompts';
import {
  AiAnalysisResult,
  AnalyzeAprResponse,
  AnalyzePtResponse,
  SophieConfidence,
  SophieImageAnalysisJsonResponse,
  SophiePhotographicReportImageJsonResponse,
  SophiePhotographicReportSummaryJsonResponse,
  SophiePtJsonResponse,
  SophieTask,
} from '../sophie.types';
import { stripJpegExifMetadata } from '../strip-jpeg-exif.util';
import { MetricsService } from '../../../shared/observability/metrics.service';
import {
  type AiLlmRuntimeConfig,
  DEFAULT_NVIDIA_MODEL,
  DEFAULT_OPENAI_MODEL,
  isConfiguredAiLlmRuntime,
  resolveAiLlmRuntimeConfig,
  supportsReasoningEffort as modelSupportsReasoningEffort,
} from '../ai-llm.config';

const OPENAI_MODEL_RECOVERY_CANDIDATES = [DEFAULT_OPENAI_MODEL] as const;
const NVIDIA_MODEL_RECOVERY_CANDIDATES = [DEFAULT_NVIDIA_MODEL] as const;
const MAX_JSON_TOKENS = 1600;

type AnalyzePtInput = {
  titulo: string;
  descricao: string;
  trabalho_altura?: boolean;
  espaco_confinado?: boolean;
  trabalho_quente?: boolean;
  eletricidade?: boolean;
};

@Injectable()
export class AiAnalysisService {
  private readonly logger = new Logger(AiAnalysisService.name);
  private readonly llm: AiLlmRuntimeConfig;
  private readonly openaiModel: string;
  private readonly openaiFallbackModel: string | null;
  private readonly openaiReasoningEffort: 'minimal' | 'low' | 'medium' | 'high';

  constructor(
    private readonly configService: ConfigService,
    private readonly integration: IntegrationResilienceService,
    private readonly openAiCircuitBreaker: OpenAiCircuitBreakerService,
    private readonly aprsService: AprsService,
    private readonly ptsService: PtsService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly metricsService: MetricsService,
  ) {
    this.llm = resolveAiLlmRuntimeConfig(this.configService);
    this.openaiModel = this.llm.model;
    this.openaiFallbackModel = this.llm.fallbackModel;
    this.openaiReasoningEffort = this.llm.reasoningEffort;
  }

  async analyzeApr(aprId: string, tenantId: string): Promise<AiAnalysisResult> {
    const apr = await this.aprsService.findOne(aprId);
    if (apr.company_id !== tenantId) {
      throw new NotFoundException(`APR com ID ${aprId} não encontrada`);
    }

    const description = String(
      apr.descricao || apr.titulo || apr.numero || '',
    ).trim();
    if (!description) {
      throw new BadRequestException(
        'A APR não possui conteúdo suficiente para análise.',
      );
    }

    return this.analyzeAprDescription(description, tenantId);
  }

  async analyzePt(ptId: string, tenantId: string): Promise<AiAnalysisResult> {
    const pt = await this.ptsService.findOne(ptId);
    if (pt.company_id !== tenantId) {
      throw new NotFoundException(`PT com ID ${ptId} não encontrada`);
    }

    return this.analyzePtPayload(
      {
        titulo: this.toSafeString(pt.titulo || pt.numero || `PT ${pt.id}`),
        descricao:
          this.toSafeString(pt.descricao) ||
          'Sem descrição detalhada da atividade.',
        trabalho_altura: Boolean(pt.trabalho_altura),
        espaco_confinado: Boolean(pt.espaco_confinado),
        trabalho_quente: Boolean(pt.trabalho_quente),
        eletricidade: Boolean(pt.eletricidade),
      },
      tenantId,
    );
  }

  async analyzeImage(
    buffer: Buffer,
    context: string | undefined,
    tenantId: string,
  ): Promise<AiAnalysisResult> {
    const visionModel = this.requireVisionModel();
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Imagem inválida para análise.');
    }

    const startTime = Date.now();
    try {
      const contextText = String(context || '').trim();
      const prompt = this.buildAnalysisPrompt({
        task: 'image-analysis',
        sections: [
          contextText
            ? `Contexto operacional informado:\n${contextText}`
            : 'Analise a imagem e descreva os riscos de SST mais relevantes.',
          'Retorne um JSON objetivo com riscos iminentes, ações imediatas e recomendações de EPI.',
        ],
        additionalRules: [
          'não invente detalhes que não estejam visíveis na imagem',
          'não inclua dados clínicos nem suposições médicas',
          'imminentRisks e immediateActions devem ter no máximo 8 itens',
        ],
      });

      const strippedBuffer = stripJpegExifMetadata(buffer);
      const dataUrl = `data:image/jpeg;base64,${strippedBuffer.toString('base64')}`;
      const { payload, model } =
        await this.requestOpenAiChatCompletion<OpenAiChatCompletion>({
          context: 'analysis:image',
          primaryModel: visionModel,
          buildBody: (modelName) => ({
            model: modelName,
            temperature: 0.2,
            max_completion_tokens: 1000,
            reasoning_effort: this.openaiReasoningEffort,
            messages: [
              {
                role: 'developer',
                content: `${getSophieSystemPrompt('image-analysis')}\n\n${SOPHIE_JSON_RUNTIME_INSTRUCTION}`,
              },
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
          }),
        });

      const text = (payload.choices?.[0]?.message?.content ?? '').trim();
      if (!text) {
        throw new BadGatewayException(
          'Serviço de IA retornou resposta inválida. Tente novamente.',
        );
      }

      const parsed = JSON.parse(
        this.extractJsonCandidate(text),
      ) as SophieImageAnalysisJsonResponse;
      const normalized: SophieImageAnalysisJsonResponse = {
        summary:
          String(parsed.summary || '').trim() ||
          'Análise de imagem indisponível.',
        riskLevel: this.normalizeRiskLevel(parsed.riskLevel),
        imminentRisks: this.normalizeStringArray(parsed.imminentRisks, 8) || [],
        immediateActions:
          this.normalizeStringArray(parsed.immediateActions, 8) || [],
        ppeRecommendations:
          this.normalizeStringArray(parsed.ppeRecommendations, 8) || [],
        confidence: this.normalizeConfidence(parsed.confidence),
        notes: this.normalizeStringArray(parsed.notes, 8),
      };

      this.recordAiMetrics({
        tenantId,
        model,
        tool: 'image-analysis',
        durationMs: Date.now() - startTime,
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      });

      return normalized;
    } catch (error) {
      this.logger.warn(
        `[AiAnalysis] analyzeImage fallback aplicado | tenant=${tenantId} | reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        summary:
          'SOPHIE indisponível no momento para análise de imagem. Use revisão técnica manual.',
        riskLevel: 'Médio',
        imminentRisks: [],
        immediateActions: [
          'Interromper atividade em condição insegura até validação técnica.',
        ],
        ppeRecommendations: ['Validar EPI obrigatório aplicável à atividade.'],
        confidence: 'low',
        notes: [
          'Fallback local aplicado por indisponibilidade temporária da API de IA.',
        ],
      };
    }
  }

  async analyzePhotographicReportImage(
    buffer: Buffer,
    context: string | undefined,
    tenantId: string,
  ): Promise<SophiePhotographicReportImageJsonResponse> {
    const visionModel = this.requireVisionModel();
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Imagem inválida para análise.');
    }

    const startTime = Date.now();
    try {
      const contextText = String(context || '').trim();
      const prompt = this.buildAnalysisPrompt({
        task: 'photographic-report-image',
        sections: [
          contextText
            ? `Contexto operacional informado:\n${contextText}`
            : 'Analise a foto e gere texto para relatório fotográfico profissional.',
          'Considere que a atividade pode ser de obra, manutenção, instalação, organização, inspeção visual, acompanhamento operacional ou qualquer frente similar registrada por fotos.',
          'Não presuma troca de luminárias nem outro serviço específico sem base concreta.',
        ],
        additionalRules: [
          'positivePoints deve ter de 2 a 5 itens',
          'preventiveRecommendation só deve aparecer quando houver base real para isso',
          'Quando o contexto indicar loja fechada, período noturno ou área controlada, destaque isso de forma positiva',
        ],
      });

      const strippedBuffer = stripJpegExifMetadata(buffer);
      const dataUrl = `data:image/jpeg;base64,${strippedBuffer.toString('base64')}`;
      const { payload, model } =
        await this.requestOpenAiChatCompletion<OpenAiChatCompletion>({
          context: 'analysis:photographic-report-image',
          primaryModel: visionModel,
          buildBody: (modelName) => ({
            model: modelName,
            temperature: 0.2,
            max_completion_tokens: 1100,
            reasoning_effort: this.openaiReasoningEffort,
            messages: [
              {
                role: 'developer',
                content: `${getSophieSystemPrompt('photographic-report-image')}\n\n${SOPHIE_JSON_RUNTIME_INSTRUCTION}`,
              },
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
          }),
        });

      const text = (payload.choices?.[0]?.message?.content ?? '').trim();
      if (!text) {
        throw new BadGatewayException(
          'Serviço de IA retornou resposta inválida. Tente novamente.',
        );
      }

      const parsed = JSON.parse(
        this.extractJsonCandidate(text),
      ) as SophiePhotographicReportImageJsonResponse;
      const normalized: SophiePhotographicReportImageJsonResponse = {
        title: String(parsed.title || '').trim() || 'Registro fotográfico',
        description:
          String(parsed.description || '').trim() ||
          'Descrição fotográfica indisponível.',
        positivePoints:
          this.normalizeStringArray(parsed.positivePoints, 5) || [],
        technicalAssessment:
          String(parsed.technicalAssessment || '').trim() ||
          'Avaliação técnica indisponível.',
        conditionClassification: this.normalizePhotographicClassification(
          parsed.conditionClassification,
        ),
        preventiveRecommendation:
          String(parsed.preventiveRecommendation || '').trim() || undefined,
        confidence: this.normalizeConfidence(parsed.confidence),
        notes: this.normalizeStringArray(parsed.notes, 8),
      };

      this.recordAiMetrics({
        tenantId,
        model,
        tool: 'photographic-report-image',
        durationMs: Date.now() - startTime,
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      });

      return normalized;
    } catch (error) {
      this.logger.warn(
        `[AiAnalysis] analyzePhotographicReportImage fallback aplicado | tenant=${tenantId} | reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        title: 'Registro fotográfico',
        description:
          'Análise de imagem indisponível no momento. Revisão técnica manual recomendada.',
        positivePoints: [
          'Evidência visual registrada para conferência posterior.',
        ],
        technicalAssessment:
          'Fallback local aplicado por indisponibilidade temporária da API de IA.',
        conditionClassification: 'Ponto de atenção preventivo',
        preventiveRecommendation:
          'Validar a imagem e complementar manualmente a descrição antes da finalização.',
        confidence: 'low',
        notes: [
          'Fallback local aplicado por indisponibilidade temporária da API de IA.',
        ],
      };
    }
  }

  async summarizePhotographicReport(params: {
    context: string;
    tenantId: string;
  }): Promise<SophiePhotographicReportSummaryJsonResponse> {
    const startTime = Date.now();
    try {
      const { data, model, inputTokens, outputTokens } =
        await this.callOpenAiJson<SophiePhotographicReportSummaryJsonResponse>({
          task: 'photographic-report-summary',
          user: this.buildAnalysisPrompt({
            task: 'photographic-report-summary',
            sections: [params.context],
            additionalRules: [
              'generalObservations deve conectar as fotos e o contexto operacional sem repetir cada legenda',
              'finalConclusion deve ser positiva, técnica e curta',
              'quando houver loja fechada, período noturno ou área controlada, destacar o benefício operacional de forma positiva',
            ],
          }),
          maxTokens: 900,
          context: 'analysis:photographic-report-summary',
        });

      const normalized: SophiePhotographicReportSummaryJsonResponse = {
        summary:
          String(data.summary || '').trim() ||
          'Síntese do relatório indisponível.',
        generalObservations:
          this.normalizeStringArray(data.generalObservations, 8) || [],
        finalConclusion:
          String(data.finalConclusion || '').trim() ||
          'Conclusão indisponível.',
        confidence: this.normalizeConfidence(data.confidence),
        notes: this.normalizeStringArray(data.notes, 8),
      };

      this.recordAiMetrics({
        tenantId: params.tenantId,
        model,
        tool: 'photographic-report-summary',
        durationMs: Date.now() - startTime,
        inputTokens,
        outputTokens,
      });

      return normalized;
    } catch (error) {
      this.logger.warn(
        `[AiAnalysis] summarizePhotographicReport fallback aplicado | tenant=${params.tenantId} | reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        summary: 'Síntese do relatório fotográfico indisponível no momento.',
        generalObservations: [
          'Registro fotográfico organizado para revisão manual.',
        ],
        finalConclusion:
          'O relatório permanece apto para conclusão manual e ajuste editorial.',
        confidence: 'low',
        notes: [
          'Fallback local aplicado por indisponibilidade temporária da API de IA.',
        ],
      };
    }
  }

  async analyzeAprDescription(
    description: string,
    tenantId: string,
  ): Promise<AnalyzeAprResponse> {
    const startTime = Date.now();
    try {
      const { data, model, inputTokens, outputTokens } =
        await this.callOpenAiJson<AnalyzeAprResponse>({
          task: 'apr',
          user: this.buildAnalysisPrompt({
            task: 'apr',
            sections: [`Descrição da atividade/APR:\n${description}`],
            additionalRules: [
              'máximo de 8 risks e 8 epis',
              'retorne IDs somente quando houver base concreta; caso contrário, use arrays vazios',
              'priorize riscos de acidentes, físicos e químicos mais prováveis pela descrição',
            ],
          }),
          maxTokens: 800,
          context: 'analysis:apr',
        });
      const response: AnalyzeAprResponse = {
        risks: Array.isArray(data.risks)
          ? data.risks.slice(0, 8).filter(Boolean)
          : [],
        epis: Array.isArray(data.epis)
          ? data.epis.slice(0, 8).filter(Boolean)
          : [],
        explanation:
          String(data.explanation || '').trim() ||
          'Sugestão gerada pela SOPHIE.',
        confidence: this.normalizeConfidence(data.confidence),
        notes: this.normalizeStringArray(data.notes, 8),
      };

      this.recordAiMetrics({
        tenantId,
        model,
        tool: 'apr',
        durationMs: Date.now() - startTime,
        inputTokens,
        outputTokens,
      });

      return response;
    } catch (error) {
      this.logger.warn(
        `[AiAnalysis] analyzeApr fallback aplicado | tenant=${tenantId} | reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        risks: [],
        epis: [],
        explanation:
          'SOPHIE indisponível no momento para sugerir riscos e EPIs.',
        confidence: 'low',
        notes: [
          'Fallback local aplicado por indisponibilidade temporária da API de IA.',
        ],
      };
    }
  }

  async analyzePtPayload(
    data: AnalyzePtInput,
    tenantId: string,
  ): Promise<AnalyzePtResponse> {
    const startTime = Date.now();
    const flags = {
      trabalho_altura: Boolean(data.trabalho_altura),
      espaco_confinado: Boolean(data.espaco_confinado),
      trabalho_quente: Boolean(data.trabalho_quente),
      eletricidade: Boolean(data.eletricidade),
    };

    try {
      const {
        data: response,
        model,
        inputTokens,
        outputTokens,
      } = await this.callOpenAiJson<SophiePtJsonResponse>({
        task: 'pt',
        user: this.buildAnalysisPrompt({
          task: 'pt',
          sections: [
            'Analise esta Permissão de Trabalho (PT).',
            `Título: ${data.titulo}\nDescrição: ${data.descricao}\nSinais/flags: ${JSON.stringify(flags)}`,
          ],
          additionalRules: [
            'suggestions deve ter de 4 a 10 itens curtos',
            'priorize hierarquia de controle',
            'cite NRs relevantes apenas quando houver aderência clara, como NR-10, NR-12, NR-20, NR-33, NR-35, NR-06 e NR-01',
          ],
        }),
        maxTokens: 900,
        context: 'analysis:pt',
      });
      const normalizedRiskLevel = this.normalizeRiskLevel(response.riskLevel);
      const normalized: AnalyzePtResponse = {
        summary:
          String(response.summary || '').trim() || 'Resumo indisponível.',
        riskLevel: normalizedRiskLevel,
        suggestions: Array.isArray(response.suggestions)
          ? response.suggestions
              .map((suggestion) => String(suggestion).trim())
              .filter(Boolean)
              .slice(0, 12)
          : [],
        confidence: this.normalizeConfidence(response.confidence),
        notes: this.normalizeStringArray(response.notes, 8),
        automation: this.buildPtAutomationDecision(normalizedRiskLevel, flags),
      };

      this.recordAiMetrics({
        tenantId,
        model,
        tool: 'pt',
        durationMs: Date.now() - startTime,
        inputTokens,
        outputTokens,
      });

      return normalized;
    } catch (error) {
      this.logger.warn(
        `[AiAnalysis] analyzePt fallback aplicado | tenant=${tenantId} | reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        summary: 'SOPHIE indisponível no momento para analisar esta PT.',
        riskLevel: 'Médio',
        suggestions: [
          'Revisar escopo da atividade e perigos principais.',
          'Garantir controles de engenharia e procedimentos antes de EPI.',
          'Validar requisitos NR aplicáveis (NR-01/06/10/12/33/35).',
        ],
        confidence: 'low',
        notes: [
          'Fallback local aplicado por indisponibilidade temporária da API de IA.',
        ],
        automation: this.buildPtAutomationDecision('Médio', flags),
      };
    }
  }

  /**
   * TODO: Fase 3 — unificar buildAnalysisPrompt com a camada compartilhada
   * de prompts da Sophie para evitar duplicação entre análise e chat.
   */
  private buildAnalysisPrompt(params: {
    task: SophieTask;
    sections: Array<string | undefined | null>;
    additionalRules?: Array<string | undefined | null>;
  }): string {
    const sections = params.sections
      .map((section) => String(section || '').trim())
      .filter(Boolean);
    const rules = (params.additionalRules || [])
      .map((rule) => String(rule || '').trim())
      .filter(Boolean)
      .map((rule) => `- ${rule}`)
      .join('\n');

    return [
      ...sections,
      rules ? `Regras adicionais desta chamada:\n${rules}` : null,
      `Use estritamente o contrato JSON governado da task "${params.task}". Não adicione campos extras e não repita o schema em texto.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private extractJsonCandidate(raw: string): string {
    const normalized = String(raw || '').trim();
    const jsonMatch =
      normalized.match(/```json\s*([\s\S]*?)```/i) ||
      normalized.match(/```([\s\S]*?)```/i);
    return (jsonMatch?.[1] ?? normalized).trim();
  }

  private normalizeConfidence(value: unknown): SophieConfidence | undefined {
    const normalized = this.toSafeString(value).toLowerCase();
    if (
      normalized === 'low' ||
      normalized === 'medium' ||
      normalized === 'high'
    ) {
      return normalized;
    }
    return undefined;
  }

  private normalizeStringArray(
    value: unknown,
    maxItems = 10,
  ): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const result = value
      .map((item) => this.toSafeString(item))
      .filter(Boolean)
      .slice(0, Math.max(1, maxItems));
    return result.length ? result : undefined;
  }

  private normalizeRiskLevel(
    value: unknown,
  ): 'Baixo' | 'Médio' | 'Alto' | 'Crítico' {
    const normalized = this.toSafeString(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (normalized.includes('crit')) return 'Crítico';
    if (normalized.includes('alto')) return 'Alto';
    if (normalized.includes('medio') || normalized.includes('moder'))
      return 'Médio';
    return 'Baixo';
  }

  private normalizePhotographicClassification(
    value: unknown,
  ):
    | 'Satisfatória'
    | 'Positiva'
    | 'Muito satisfatória'
    | 'Ponto de atenção preventivo' {
    const normalized = this.toSafeString(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (normalized.includes('muito')) {
      return 'Muito satisfatória';
    }
    if (normalized.includes('atencao')) {
      return 'Ponto de atenção preventivo';
    }
    if (normalized.includes('positiv')) {
      return 'Positiva';
    }
    return 'Satisfatória';
  }

  private buildPtAutomationDecision(
    riskLevel: AnalyzePtResponse['riskLevel'],
    flags: {
      trabalho_altura?: boolean;
      espaco_confinado?: boolean;
      trabalho_quente?: boolean;
      eletricidade?: boolean;
    },
  ): AnalyzePtResponse['automation'] {
    const criticalFlag = Boolean(
      flags.trabalho_altura ||
      flags.espaco_confinado ||
      flags.trabalho_quente ||
      flags.eletricidade,
    );

    if (riskLevel === 'Crítico') {
      return {
        phase: 'phase2',
        riskBand: 'critical',
        requiresHumanApproval: true,
        recommendedFlow: 'review_required',
        reasons: [
          'Risco crítico identificado. Liberação automática bloqueada.',
        ],
      };
    }

    if (riskLevel === 'Alto' || criticalFlag) {
      return {
        phase: 'phase2',
        riskBand: 'high',
        requiresHumanApproval: true,
        recommendedFlow: 'review_required',
        reasons: [
          criticalFlag
            ? 'Atividade crítica (altura/espaço confinado/quente/eletricidade) exige validação humana.'
            : 'Risco alto exige validação humana antes da liberação.',
        ],
      };
    }

    if (riskLevel === 'Médio') {
      return {
        phase: 'phase2',
        riskBand: 'moderate',
        requiresHumanApproval: false,
        recommendedFlow: 'auto',
        reasons: ['Risco moderado permite fluxo assistido com monitoramento.'],
      };
    }

    return {
      phase: 'phase2',
      riskBand: 'low',
      requiresHumanApproval: false,
      recommendedFlow: 'auto',
      reasons: ['Risco baixo apto para fluxo assistido automático.'],
    };
  }

  private supportsReasoningEffort(model: string): boolean {
    return modelSupportsReasoningEffort(model);
  }

  private getOpenAiModelCandidates(primaryModel: string): string[] {
    const recovery =
      this.llm.officialProvider === 'nvidia'
        ? NVIDIA_MODEL_RECOVERY_CANDIDATES
        : OPENAI_MODEL_RECOVERY_CANDIDATES;
    return Array.from(
      new Set(
        [primaryModel, this.openaiFallbackModel, ...recovery]
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    );
  }

  private parseOpenAiErrorBody(body: string): {
    message: string;
    type?: string;
    code?: string;
  } {
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string; type?: string; code?: string };
      };
      return {
        message:
          parsed?.error?.message?.trim() ||
          body.trim() ||
          'Erro desconhecido da OpenAI.',
        type: parsed?.error?.type,
        code: parsed?.error?.code,
      };
    } catch {
      return {
        message: body.trim() || 'Erro desconhecido da OpenAI.',
      };
    }
  }

  private shouldRetryWithFallback(params: {
    status: number;
    model: string;
    candidateIndex: number;
    candidates: string[];
    errorMessage: string;
    errorCode?: string;
  }): boolean {
    if (params.candidateIndex >= params.candidates.length - 1) {
      return false;
    }

    const normalizedMessage = params.errorMessage.toLowerCase();
    const normalizedCode = String(params.errorCode || '').toLowerCase();

    if (params.status === 404) {
      return true;
    }

    if (params.status === 403) {
      return (
        normalizedMessage.includes('model') || normalizedCode.includes('model')
      );
    }

    if (params.status === 400) {
      return (
        normalizedMessage.includes('model') ||
        normalizedMessage.includes('reasoning_effort') ||
        normalizedCode.includes('model')
      );
    }

    return false;
  }

  private formatOpenAiError(params: {
    status: number;
    model: string;
    context: string;
    message: string;
    type?: string;
    code?: string;
  }): string {
    const meta = [
      `context=${params.context}`,
      `model=${params.model}`,
      params.type ? `type=${params.type}` : null,
      params.code ? `code=${params.code}` : null,
    ]
      .filter(Boolean)
      .join(' ');

    return `LLM API error ${params.status} (${meta}): ${params.message}`;
  }

  private requireVisionModel(): string {
    if (!this.llm.imageAnalysisEnabled || !this.llm.visionModel) {
      throw new ServiceUnavailableException(
        'Análise de imagem indisponível para o provedor de IA configurado.',
      );
    }

    return this.llm.visionModel;
  }

  private toSafeString(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value).trim();
    }

    return '';
  }

  private async requestOpenAiChatCompletion<T>(params: {
    context: string;
    primaryModel: string;
    buildBody: (model: string) => Record<string, unknown>;
  }): Promise<{ payload: T; model: string }> {
    const runtime = this.llm;
    if (!isConfiguredAiLlmRuntime(runtime)) {
      throw new ServiceUnavailableException(
        'Serviço de IA temporariamente indisponível.',
      );
    }

    const candidates = this.getOpenAiModelCandidates(params.primaryModel);

    for (let index = 0; index < candidates.length; index += 1) {
      const model = candidates[index];
      const body = params.buildBody(model);

      if (!this.supportsReasoningEffort(model) && 'reasoning_effort' in body) {
        delete body.reasoning_effort;
      }

      const response = await requestOpenAiChatCompletionResponse({
        runtime,
        body,
        configService: this.configService,
        integration: this.integration,
        circuitBreaker: this.openAiCircuitBreaker,
      });

      if (response.ok) {
        return {
          payload: (await response.json()) as T,
          model,
        };
      }

      const rawBody = await response.text();
      const parsedError = this.parseOpenAiErrorBody(rawBody);
      const formattedError = this.formatOpenAiError({
        status: response.status,
        model,
        context: params.context,
        message: parsedError.message,
        type: parsedError.type,
        code: parsedError.code,
      });

      this.logger.error(formattedError);

      if (
        this.shouldRetryWithFallback({
          status: response.status,
          model,
          candidateIndex: index,
          candidates,
          errorMessage: parsedError.message,
          errorCode: parsedError.code,
        })
      ) {
        const nextModel = candidates[index + 1];
        this.logger.warn(
          `[AiAnalysis] Tentando fallback OpenAI | context=${params.context} | from=${model} | to=${nextModel}`,
        );
        continue;
      }

      throw new BadGatewayException(
        'Serviço de IA retornou resposta inválida. Tente novamente.',
      );
    }

    throw new BadGatewayException(
      'Serviço de IA retornou resposta inválida. Tente novamente.',
    );
  }

  private async callOpenAiJson<T>(params: {
    task: SophieTask;
    user: string;
    context: string;
    maxTokens?: number;
  }): Promise<{
    data: T;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    const { payload, model } =
      await this.requestOpenAiChatCompletion<OpenAiChatCompletion>({
        context: params.context,
        primaryModel: this.openaiModel,
        buildBody: (modelName) => ({
          model: modelName,
          temperature: 0.2,
          max_completion_tokens: params.maxTokens ?? MAX_JSON_TOKENS,
          reasoning_effort: this.openaiReasoningEffort,
          messages: [
            {
              role: 'developer',
              content: `${getSophieSystemPrompt(params.task)}\n\n${SOPHIE_JSON_RUNTIME_INSTRUCTION}`,
            },
            { role: 'user', content: params.user },
          ],
        }),
      });
    const text = (payload.choices?.[0]?.message?.content ?? '').trim();
    if (!text) {
      throw new BadGatewayException(
        'Serviço de IA retornou resposta inválida. Tente novamente.',
      );
    }

    return {
      data: JSON.parse(this.extractJsonCandidate(text)) as T,
      model,
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
    };
  }

  private recordAiMetrics(params: {
    tenantId: string;
    model: string;
    tool: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
  }) {
    this.metricsService.incrementAiInteraction(params.tenantId, params.tool);
    this.metricsService.recordAiResponseTime(
      params.model,
      params.tool,
      params.durationMs / 1000,
    );
    this.metricsService.addAiTokensUsed(
      params.tenantId,
      params.model,
      params.inputTokens + params.outputTokens,
    );
  }
}

type OpenAiChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};
