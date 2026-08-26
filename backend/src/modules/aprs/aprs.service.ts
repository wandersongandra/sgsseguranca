import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  FindOptionsWhere,
  In,
  IsNull,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { jsonToExcelBuffer } from '../../shared/utils/excel.util';
import { Apr, AprStatus } from './entities/apr.entity';
import { AprLog } from './entities/apr-log.entity';
import {
  AprApprovalStep,
  AprApprovalStepStatus,
} from './entities/apr-approval-step.entity';
import { AprRiskEvidence } from './entities/apr-risk-evidence.entity';
import { AprRiskItem } from './entities/apr-risk-item.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import { CreateAprDto } from './dto/create-apr.dto';
import { UpdateAprDto } from './dto/update-apr.dto';
import { Role } from '../auth/enums/roles.enum';
import { normalizeRoleName } from '../auth/role-normalization.util';
import { Activity } from '../activities/entities/activity.entity';
import { Risk } from '../risks/entities/risk.entity';
import { Epi } from '../epis/entities/epi.entity';
import { Tool } from '../tools/entities/tool.entity';
import { Machine } from '../machines/entities/machine.entity';
import { User } from '../users/entities/user.entity';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { DocumentBundleService } from '../../shared/services/document-bundle.service';
import { plainToClass } from 'class-transformer';
import { AprListItemDto } from './dto/apr-list-item.dto';
import { RiskCalculationService } from '../../shared/services/risk-calculation.service';
import { WeeklyBundleFilters } from '../../shared/services/document-bundle.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { PdfService } from '../../shared/services/pdf.service';
import { MetricsService } from '../../shared/observability/metrics.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { SignaturesService } from '../signatures/signatures.service';
import { Site } from '../sites/entities/site.entity';
import {
  AprRiskCategory,
  AprRiskMatrixService,
} from './apr-risk-matrix.service';
import { AprRiskItemInputDto } from './dto/apr-risk-item-input.dto';
import { AprExcelService } from './apr-excel.service';
import { AprExcelImportPreviewDto } from './dto/apr-excel-import-preview.dto';
import { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import { AprsPdfService } from './services/aprs-pdf.service';
import { AprsEvidenceService } from './services/aprs-evidence.service';
import { AprWorkflowService } from './aprs-workflow.service';
import { CacheService } from '../../shared/cache/cache.service';
import { storageKeyFingerprint } from '../../shared/storage/storage-compensation.util';
import {
  AprMetricsService,
  CreateAprMetricDto as AprMetricPayload,
} from './services/apr-metrics.service';
import { AprMetricEventType } from './entities/apr-metric.entity';
import {
  AprRulesEngineService,
  AprValidationResult,
} from './services/apr-rules-engine.service';
import { AprFeatureFlagService } from './services/apr-feature-flag.service';
import { normalizeOptionalSearchQuery } from '../../shared/utils/query-normalization.util';
import { escapeLikePattern } from '../../shared/utils/sql.util';

const APR_OVERVIEW_CACHE_PREFIX = 'apr:overview';
const APR_OVERVIEW_CACHE_TTL_DEFAULT_SECONDS = 30;
const APR_OVERVIEW_CACHE_TTL_MIN_SECONDS = 10;
const APR_OVERVIEW_CACHE_TTL_MAX_SECONDS = 300;
import {
  APR_ACTIVITY_TEMPLATES,
  AprActivityTemplate,
  findAprActivityTemplate,
  listAprActivityTemplateTypes,
} from './apr-activity-templates.catalog';
import { APR_DEFAULT_APPROVAL_STEP_TEMPLATES } from './apr-permissions.constants';

const APR_LOG_ACTIONS = {
  CREATED: 'APR_CRIADA',
  UPDATED: 'APR_ATUALIZADA',
  APPROVED: 'APR_APROVADA',
  REJECTED: 'APR_REPROVADA',
  FINALIZED: 'APR_ENCERRADA',
  PDF_ATTACHED: 'APR_PDF_ANEXADO',
  PDF_GENERATED: 'APR_PDF_GERADO',
  NEW_VERSION_GENERATED: 'APR_NOVA_VERSAO_GERADA',
  CREATED_FROM_VERSION: 'APR_CRIADA_POR_VERSAO',
  EVIDENCE_ATTACHED: 'APR_EVIDENCIA_ENVIADA',
  REMOVED: 'APR_REMOVIDA',
} as const;

type AprLogAction = (typeof APR_LOG_ACTIONS)[keyof typeof APR_LOG_ACTIONS];
import { GovernedPdfAccessAvailability } from '../../shared/dto/governed-pdf-access-response.dto';
type AprPdfAccessAvailability = GovernedPdfAccessAvailability;

type AprRiskItemSnapshot = {
  atividade: string | null;
  etapa: string | null;
  agente_ambiental: string | null;
  condicao_perigosa: string | null;
  fonte_circunstancia: string | null;
  lesao: string | null;
  probabilidade: number | null;
  severidade: number | null;
  score_risco: number | null;
  categoria_risco: AprRiskCategory | null;
  prioridade: string | null;
  medidas_prevencao: string | null;
  epc: string | null;
  epi: string | null;
  permissao_trabalho: string | null;
  normas_relacionadas: string | null;
  hierarquia_controle: string | null;
  residual_probabilidade: number | null;
  residual_severidade: number | null;
  residual_score: number | null;
  residual_categoria: string | null;
  responsavel: string | null;
  prazo: string | null;
  status_acao: string | null;
  ordem: number;
};

type AprAiContextSummary = {
  id: string;
  codigo: string;
  status: string;
  created_at: Date;
  company_id: string;
};

@Injectable()
export class AprsService {
  private readonly logger = new Logger(AprsService.name);

  constructor(
    @InjectRepository(Apr)
    private aprsRepository: Repository<Apr>,
    @InjectRepository(AprLog)
    private aprLogsRepository: Repository<AprLog>,
    private tenantService: TenantService,
    private readonly riskCalculationService: RiskCalculationService,
    private readonly aprRiskMatrixService: AprRiskMatrixService,
    private readonly aprExcelService: AprExcelService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly pdfService: PdfService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly documentBundleService: DocumentBundleService,
    @Inject(forwardRef(() => SignaturesService))
    private readonly signaturesService: SignaturesService,
    private readonly forensicTrailService: ForensicTrailService,
    private readonly aprsPdfService: AprsPdfService,
    private readonly aprsEvidenceService: AprsEvidenceService,
    private readonly aprWorkflowService: AprWorkflowService,
    private readonly cacheService: CacheService,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() private readonly aprMetricsService?: AprMetricsService,
    @Optional() private readonly aprRulesEngine?: AprRulesEngineService,
    @Optional() private readonly aprFeatureFlagService?: AprFeatureFlagService,
  ) {}

  private recordAprMetric(payload: AprMetricPayload): void {
    this.aprMetricsService?.record(payload);
  }

  private getAprOverviewCacheTtlSeconds(): number {
    const raw = process.env.APR_OVERVIEW_CACHE_TTL_SECONDS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return APR_OVERVIEW_CACHE_TTL_DEFAULT_SECONDS;
    }
    const clamped = Math.min(
      Math.max(Math.floor(parsed), APR_OVERVIEW_CACHE_TTL_MIN_SECONDS),
      APR_OVERVIEW_CACHE_TTL_MAX_SECONDS,
    );
    if (clamped !== Math.floor(parsed)) {
      this.logger.warn(
        `APR_OVERVIEW_CACHE_TTL_SECONDS=${raw} ajustado para ${clamped}s (limites: ${APR_OVERVIEW_CACHE_TTL_MIN_SECONDS}–${APR_OVERVIEW_CACHE_TTL_MAX_SECONDS})`,
      );
    }
    return clamped;
  }

  private buildAprOverviewCacheKey(tenantId: string): string {
    return `${APR_OVERVIEW_CACHE_PREFIX}:${tenantId}`;
  }

  private async invalidateAprOverviewCache(tenantId: string): Promise<void> {
    try {
      await this.cacheService.del(this.buildAprOverviewCacheKey(tenantId));
    } catch (err) {
      this.logger.warn({
        event: 'apr_overview_cache_invalidate_failed',
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private assertAprDocumentMutable(apr: Pick<Apr, 'pdf_file_key'>) {
    if (apr.pdf_file_key) {
      throw new BadRequestException(
        'APR assinada anexada. Edição bloqueada. Crie uma nova versão para alterar.',
      );
    }
  }

  /**
   * Detecta violação do índice único de número da APR
   * (UQ_aprs_company_numero_active) — código 23505 do Postgres — para
   * traduzir uma corrida de criação no 409 amigável em vez de 500.
   */
  private isDuplicateAprNumeroError(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driverError = error.driverError as
      { code?: string; constraint?: string } | undefined;
    return (
      driverError?.code === '23505' &&
      (driverError.constraint ?? '').includes('aprs_company_numero')
    );
  }

  private assertAprEditableStatus(status: string) {
    if (this.ensureAprStatus(status) !== AprStatus.PENDENTE) {
      throw new BadRequestException(
        'Somente APRs pendentes podem ser editadas pelo formulário. Use os fluxos formais de aprovação, cancelamento, encerramento ou nova versão.',
      );
    }
  }

  private assertAprFormMutable(apr: Apr): void {
    this.aprWorkflowService.assertAprFormMutable(apr);
  }

  private async assertAprReadyForFinalPdf(
    apr: Pick<
      Apr,
      'id' | 'status' | 'pdf_file_key' | 'is_modelo' | 'participants'
    >,
  ) {
    this.assertAprDocumentMutable(apr);

    if (this.ensureAprStatus(apr.status) !== AprStatus.APROVADA) {
      throw new BadRequestException(
        'A APR precisa estar aprovada antes do anexo do PDF final.',
      );
    }

    if (apr.is_modelo) {
      throw new BadRequestException(
        'Modelos de APR não podem receber PDF final. Gere uma APR operacional a partir do modelo.',
      );
    }

    const participantIds = Array.isArray(apr.participants)
      ? apr.participants
          .map((participant) => participant.id)
          .filter((participantId): participantId is string =>
            Boolean(participantId),
          )
      : [];

    if (participantIds.length === 0) {
      throw new BadRequestException(
        'A APR precisa ter participantes definidos antes do PDF final.',
      );
    }

    const signatures = await this.signaturesService.findByDocument(
      apr.id,
      'APR',
    );
    const participantSigners = new Set(
      signatures
        .map((signature) => signature.user_id)
        .filter(
          (userId): userId is string =>
            Boolean(userId) && participantIds.includes(userId),
        ),
    );

    const missingParticipants = participantIds.filter(
      (participantId) => !participantSigners.has(participantId),
    );

    if (missingParticipants.length > 0) {
      throw new BadRequestException(
        'Todos os participantes precisam assinar a APR antes do PDF final.',
      );
    }
  }

  private buildAprDocumentCode(
    apr: Pick<Apr, 'id' | 'numero' | 'titulo' | 'data_inicio' | 'created_at'>,
  ): string {
    const candidateDate = apr.data_inicio
      ? new Date(apr.data_inicio)
      : apr.created_at
        ? new Date(apr.created_at)
        : new Date();
    const year = Number.isNaN(candidateDate.getTime())
      ? new Date().getFullYear()
      : candidateDate.getFullYear();
    const reference = String(apr.id || apr.numero || apr.titulo || 'APR')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-8)
      .toUpperCase();

    return `APR-${year}-${reference || String(Date.now()).slice(-6)}`;
  }

  private buildAprFinalPdfOriginalName(
    apr: Pick<Apr, 'numero' | 'versao' | 'id'>,
  ): string {
    const reference = String(apr.numero || apr.id || 'apr')
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const version = Number(apr.versao ?? 1);

    return `${reference || 'apr'}_v${version}.pdf`;
  }

  private isEmptyRiskItemSnapshot(item: AprRiskItemSnapshot): boolean {
    return ![
      item.atividade,
      item.etapa,
      item.agente_ambiental,
      item.condicao_perigosa,
      item.fonte_circunstancia,
      item.lesao,
      item.probabilidade,
      item.severidade,
      item.medidas_prevencao,
      item.epc,
      item.epi,
      item.permissao_trabalho,
      item.normas_relacionadas,
      item.responsavel,
      item.prazo,
      item.status_acao,
    ].some((value) => {
      if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0;
      }

      return Boolean(value);
    });
  }

  private getTenantContextOrThrow(): {
    companyId: string;
    siteId?: string;
    siteIds: string[];
    siteScope: 'single' | 'all';
    isSuperAdmin: boolean;
  } {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'APR',
    );

    return {
      companyId: scope.companyId,
      siteId: scope.siteId,
      siteIds: scope.siteIds,
      siteScope: scope.siteScope,
      isSuperAdmin: scope.isSuperAdmin,
    };
  }

  private async getAllowedAprIdsForCurrentScope(): Promise<Set<string> | null> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();

    if (isSuperAdmin || siteScope === 'all') {
      return null;
    }

    // Teto de segurança: lista de IDs permitidos usada só como allow-list em
    // memória para filtrar documentos (document_registry não tem site_id).
    // Não deveria ser atingido na prática — mesma técnica de
    // ProfilesService.findAll / findAllForExport.
    const scopedAprs = await this.aprsRepository.find({
      select: ['id'],
      where: { company_id: companyId, site_id: In(siteIds) },
      take: 50000,
    });

    return new Set(scopedAprs.map((apr) => apr.id));
  }

  private getRiskItemApprovalIssues(item: AprRiskItemSnapshot): string[] {
    const issues: string[] = [];

    if (!item.atividade) {
      issues.push('atividade/processo');
    }
    if (!item.condicao_perigosa) {
      issues.push('condição perigosa');
    }
    if (!item.probabilidade) {
      issues.push('probabilidade');
    }
    if (!item.severidade) {
      issues.push('severidade');
    }

    // Riscos classificados como "Aceitável" não exigem medidas de controle adicionais
    // conforme critério da matriz (NÃO PRIORITÁRIO). Para demais categorias, ao menos
    // um campo de controle deve estar preenchido.
    const isAcceptable =
      item.categoria_risco === 'Aceitável' ||
      (item.probabilidade !== null &&
        item.severidade !== null &&
        (item.probabilidade ?? 0) * (item.severidade ?? 0) <= 3);

    if (!isAcceptable) {
      const hasAnyControl = Boolean(
        item.medidas_prevencao ||
        item.epc ||
        item.epi ||
        item.permissao_trabalho ||
        item.normas_relacionadas ||
        item.hierarquia_controle,
      );
      if (!hasAnyControl) {
        issues.push('medidas de prevenção ou controle');
      }
    }

    return issues;
  }

  private assertAprDateRange(
    start?: Date | string | null,
    end?: Date | string | null,
  ): void {
    if (!start || !end) {
      return;
    }

    const startDate = start instanceof Date ? start : new Date(start);
    const endDate = end instanceof Date ? end : new Date(end);

    if (
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(endDate.getTime()) ||
      endDate < startDate
    ) {
      throw new BadRequestException(
        'A validade/data fim da APR não pode ser anterior à data de início.',
      );
    }
  }

  private assertAprDraftIntegrity(input: {
    status?: string | null;
    dataInicio?: Date | string | null;
    dataFim?: Date | string | null;
    participants?: string[] | User[];
    riskItems: AprRiskItemSnapshot[];
  }): void {
    if (
      input.status &&
      this.ensureAprStatus(input.status) !== AprStatus.PENDENTE
    ) {
      throw new BadRequestException(
        'Novas APRs ou edições de formulário devem permanecer pendentes. Use os fluxos formais de aprovação, cancelamento ou encerramento para mudar o estado.',
      );
    }

    this.assertAprDateRange(input.dataInicio, input.dataFim);

    const participantIds = (
      Array.isArray(input.participants) ? input.participants : []
    )
      .map((participant): string | null => {
        if (typeof participant === 'string') {
          return participant;
        }

        if (
          participant &&
          typeof participant === 'object' &&
          'id' in participant
        ) {
          const participantRecord = participant as { id?: unknown };
          return typeof participantRecord.id === 'string'
            ? participantRecord.id
            : null;
        }

        return null;
      })
      .filter((participantId): participantId is string =>
        Boolean(participantId),
      );
    if (
      participantIds.length > 0 &&
      new Set(participantIds).size !== participantIds.length
    ) {
      throw new BadRequestException(
        'A lista de participantes da APR contém registros duplicados.',
      );
    }
  }

  private assertAprReadyForApproval(
    apr: Pick<
      Apr,
      | 'id'
      | 'status'
      | 'pdf_file_key'
      | 'participants'
      | 'risk_items'
      | 'data_inicio'
      | 'data_fim'
    >,
  ): void {
    this.assertAprWorkflowTransitionAllowed(apr);
    this.assertAprDateRange(apr.data_inicio, apr.data_fim);

    if (this.ensureAprStatus(apr.status) !== AprStatus.PENDENTE) {
      throw new BadRequestException(
        'Somente APRs pendentes podem seguir para aprovação.',
      );
    }

    const participantIds = Array.isArray(apr.participants)
      ? apr.participants
          .map((participant) => participant.id)
          .filter((participantId): participantId is string =>
            Boolean(participantId),
          )
      : [];

    if (participantIds.length === 0) {
      throw new BadRequestException(
        'A APR precisa ter participantes definidos antes da aprovação.',
      );
    }

    const normalizedRiskItems = Array.isArray(apr.risk_items)
      ? apr.risk_items.map((item) => this.mapPersistedRiskItemToSnapshot(item))
      : [];

    if (normalizedRiskItems.length === 0) {
      throw new BadRequestException(
        'A APR precisa ter ao menos um item de risco válido antes da aprovação.',
      );
    }

    const incompleteItem = normalizedRiskItems.find(
      (item) => this.getRiskItemApprovalIssues(item).length > 0,
    );

    if (incompleteItem) {
      throw new BadRequestException(
        `A APR não pode ser aprovada com itens de risco incompletos. Revise a linha ${incompleteItem.ordem + 1} e preencha: ${this.getRiskItemApprovalIssues(incompleteItem).join(', ')}.`,
      );
    }
  }

  private assertAprReadyForFinalization(
    apr: Pick<Apr, 'status' | 'pdf_file_key'>,
  ): void {
    // Mantém a regra de "PDF lock": quando o PDF final existe, nenhuma transição de status
    // deve ocorrer no documento. Isso evita inconsistência operacional e bypass de workflow.
    this.assertAprWorkflowTransitionAllowed(apr);

    if (this.ensureAprStatus(apr.status) !== AprStatus.APROVADA) {
      throw new BadRequestException(
        'Somente APRs aprovadas podem ser encerradas.',
      );
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async addLog(
    aprId: string,
    userId: string | undefined,
    acao: AprLogAction,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const log = this.aprLogsRepository.create({
        apr_id: aprId,
        usuario_id: userId ?? undefined,
        acao,
        metadata: metadata ?? undefined,
      });
      await this.aprLogsRepository.save(log);
    } catch {
      this.logger.warn(`Falha ao gravar log de APR (${aprId}): ${acao}`);
    }
  }

  private normalizeAprRiskText(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const sanitized = value.trim();
    return sanitized ? sanitized : null;
  }

  private normalizeAprRiskNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private toLegacyRiskItemPayload(
    items: AprRiskItemSnapshot[],
  ): Array<Record<string, string>> {
    return items.map((item) => ({
      atividade_processo: item.atividade ?? '',
      etapa: item.etapa ?? '',
      agente_ambiental: item.agente_ambiental ?? '',
      condicao_perigosa: item.condicao_perigosa ?? '',
      fontes_circunstancias: item.fonte_circunstancia ?? '',
      possiveis_lesoes: item.lesao ?? '',
      probabilidade:
        item.probabilidade !== null && item.probabilidade !== undefined
          ? String(item.probabilidade)
          : '',
      severidade:
        item.severidade !== null && item.severidade !== undefined
          ? String(item.severidade)
          : '',
      categoria_risco: item.categoria_risco ?? '',
      medidas_prevencao: item.medidas_prevencao ?? '',
      epc: item.epc ?? '',
      epi: item.epi ?? '',
      permissao_trabalho: item.permissao_trabalho ?? '',
      normas_relacionadas: item.normas_relacionadas ?? '',
      hierarquia_controle: item.hierarquia_controle ?? '',
      residual_probabilidade:
        item.residual_probabilidade !== null &&
        item.residual_probabilidade !== undefined
          ? String(item.residual_probabilidade)
          : '',
      residual_severidade:
        item.residual_severidade !== null &&
        item.residual_severidade !== undefined
          ? String(item.residual_severidade)
          : '',
      residual_score:
        item.residual_score !== null && item.residual_score !== undefined
          ? String(item.residual_score)
          : '',
      residual_categoria: item.residual_categoria ?? '',
      responsavel: item.responsavel ?? '',
      prazo: item.prazo ?? '',
      status_acao: item.status_acao ?? '',
    }));
  }

  private normalizeAprRiskItemInput(
    item: Partial<AprRiskItemInputDto & Record<string, unknown>>,
    index: number,
  ): AprRiskItemSnapshot {
    const probabilidade = this.normalizeAprRiskNumber(item.probabilidade);
    const severidade = this.normalizeAprRiskNumber(item.severidade);
    const evaluation = this.aprRiskMatrixService.evaluate(
      probabilidade,
      severidade,
    );

    const residualProbabilidade = this.normalizeAprRiskNumber(
      item.residual_probabilidade,
    );
    const residualSeveridade = this.normalizeAprRiskNumber(
      item.residual_severidade,
    );
    const residualEvaluation = this.aprRiskMatrixService.evaluate(
      residualProbabilidade,
      residualSeveridade,
    );

    return {
      atividade: this.normalizeAprRiskText(
        item.atividade_processo ?? item.atividade,
      ),
      etapa: this.normalizeAprRiskText(item.etapa),
      agente_ambiental: this.normalizeAprRiskText(item.agente_ambiental),
      condicao_perigosa: this.normalizeAprRiskText(item.condicao_perigosa),
      fonte_circunstancia: this.normalizeAprRiskText(
        item.fonte_circunstancia ?? item.fontes_circunstancias,
      ),
      lesao: this.normalizeAprRiskText(item.possiveis_lesoes ?? item.lesao),
      probabilidade,
      severidade,
      score_risco: evaluation.score,
      categoria_risco: evaluation.categoria,
      prioridade: evaluation.prioridade,
      medidas_prevencao: this.normalizeAprRiskText(item.medidas_prevencao),
      epc: this.normalizeAprRiskText(item.epc),
      epi: this.normalizeAprRiskText(item.epi),
      permissao_trabalho: this.normalizeAprRiskText(item.permissao_trabalho),
      normas_relacionadas: this.normalizeAprRiskText(item.normas_relacionadas),
      hierarquia_controle: this.normalizeAprRiskText(item.hierarquia_controle),
      residual_probabilidade: residualProbabilidade,
      residual_severidade: residualSeveridade,
      residual_score: residualEvaluation.score,
      residual_categoria: residualEvaluation.categoria,
      responsavel: this.normalizeAprRiskText(item.responsavel),
      prazo: this.normalizeAprRiskText(item.prazo),
      status_acao: this.normalizeAprRiskText(item.status_acao),
      ordem: index,
    };
  }

  private buildAprRiskItemSnapshots(input: {
    itens_risco?: Array<Record<string, unknown>>;
    risk_items?: AprRiskItemInputDto[];
  }): AprRiskItemSnapshot[] {
    const source: Array<
      Partial<AprRiskItemInputDto & Record<string, unknown>>
    > = Array.isArray(input.risk_items)
      ? input.risk_items.map((item) => ({
          ...item,
        }))
      : Array.isArray(input.itens_risco)
        ? input.itens_risco
        : [];

    return source
      .map((item, index) => this.normalizeAprRiskItemInput(item, index))
      .filter((item) => !this.isEmptyRiskItemSnapshot(item))
      .map((item, index) => ({
        ...item,
        ordem: index,
      }));
  }

  private buildAprClassificationSummary(items: AprRiskItemSnapshot[]) {
    return this.aprRiskMatrixService.summarize(
      items.map((item) => item.categoria_risco),
    );
  }

  private mapPersistedRiskItemToSnapshot(
    item: AprRiskItem,
  ): AprRiskItemSnapshot {
    return {
      atividade: item.atividade,
      etapa: item.etapa,
      agente_ambiental: item.agente_ambiental,
      condicao_perigosa: item.condicao_perigosa,
      fonte_circunstancia: item.fonte_circunstancia,
      lesao: item.lesao,
      probabilidade: item.probabilidade,
      severidade: item.severidade,
      score_risco: item.score_risco,
      categoria_risco: this.aprRiskMatrixService.normalizeCategory(
        item.categoria_risco,
      ),
      prioridade: item.prioridade,
      medidas_prevencao: item.medidas_prevencao,
      epc: item.epc,
      epi: item.epi,
      permissao_trabalho: item.permissao_trabalho,
      normas_relacionadas: item.normas_relacionadas,
      hierarquia_controle: item.hierarquia_controle,
      residual_probabilidade: item.residual_probabilidade,
      residual_severidade: item.residual_severidade,
      residual_score: item.residual_score,
      residual_categoria: item.residual_categoria,
      responsavel: item.responsavel,
      prazo: this.normalizeDateOnly(item.prazo),
      status_acao: item.status_acao,
      ordem: item.ordem,
    };
  }

  private normalizeDateOnly(value: unknown): string | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? null
        : value.toISOString().slice(0, 10);
    }

    const normalized =
      typeof value === 'string'
        ? value.trim()
        : typeof value === 'number'
          ? String(value).trim()
          : null;
    if (!normalized) {
      return null;
    }

    const directDate = normalized.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (directDate) {
      return directDate;
    }

    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime())
      ? null
      : parsed.toISOString().slice(0, 10);
  }

  private hasRiskItemChanged(
    existing: AprRiskItem,
    next: AprRiskItemSnapshot,
  ): boolean {
    return (
      existing.atividade !== next.atividade ||
      existing.etapa !== next.etapa ||
      existing.agente_ambiental !== next.agente_ambiental ||
      existing.condicao_perigosa !== next.condicao_perigosa ||
      existing.fonte_circunstancia !== next.fonte_circunstancia ||
      existing.lesao !== next.lesao ||
      existing.probabilidade !== next.probabilidade ||
      existing.severidade !== next.severidade ||
      existing.score_risco !== next.score_risco ||
      existing.categoria_risco !== next.categoria_risco ||
      existing.prioridade !== next.prioridade ||
      existing.medidas_prevencao !== next.medidas_prevencao ||
      existing.epc !== next.epc ||
      existing.epi !== next.epi ||
      existing.permissao_trabalho !== next.permissao_trabalho ||
      existing.normas_relacionadas !== next.normas_relacionadas ||
      existing.hierarquia_controle !== next.hierarquia_controle ||
      existing.residual_probabilidade !== next.residual_probabilidade ||
      existing.residual_severidade !== next.residual_severidade ||
      existing.residual_score !== next.residual_score ||
      existing.residual_categoria !== next.residual_categoria ||
      existing.responsavel !== next.responsavel ||
      this.normalizeDateOnly(existing.prazo) !== next.prazo ||
      existing.status_acao !== next.status_acao ||
      existing.ordem !== next.ordem
    );
  }

  private async loadRiskItemsForSync(
    aprId: string,
    manager?: EntityManager,
    opts?: { withEvidences?: boolean },
  ): Promise<AprRiskItem[]> {
    const withEvidences = Boolean(opts?.withEvidences);
    // withDeleted: false é o padrão com DeleteDateColumn — apenas itens ativos
    return (manager ?? this.aprsRepository.manager)
      .getRepository(AprRiskItem)
      .find({
        where: { apr_id: aprId },
        relations: withEvidences ? ['evidences'] : [],
        order: { ordem: 'ASC', created_at: 'ASC' },
        withDeleted: false,
      });
  }

  private async assertRiskItemSyncAllowed(
    aprId: string,
    items?: AprRiskItemSnapshot[],
    manager?: EntityManager,
  ): Promise<void> {
    const effectiveManager = manager ?? this.aprsRepository.manager;
    // Fast path: a maioria das APRs não possui evidências anexadas.
    // Se não houver nenhuma evidência para esta APR, não há restrição extra
    // e evitamos carregar relations pesadas (risk_item -> evidences).
    const evidenceCount = await effectiveManager
      .getRepository(AprRiskEvidence)
      .count({ where: { apr_id: aprId } });
    if (evidenceCount === 0) {
      return;
    }

    const desired = items ?? [];
    const existing = await this.loadRiskItemsForSync(aprId, effectiveManager, {
      withEvidences: true,
    });

    for (const [index, row] of existing.entries()) {
      const hasEvidence =
        Array.isArray(row.evidences) && row.evidences.length > 0;
      if (!hasEvidence) {
        continue;
      }

      const target = desired[index];
      if (!target) {
        throw new BadRequestException(
          `Item de risco na posição ${index + 1} possui evidências anexadas e não pode ser removido. Gere uma nova versão da APR para reorganizar a matriz de riscos.`,
        );
      }

      if (this.hasRiskItemChanged(row, target)) {
        throw new BadRequestException(
          `Item de risco na posição ${index + 1} possui evidências anexadas e não pode ser alterado nem reordenado. Gere uma nova versão da APR para reorganizar ou editar a matriz de riscos.`,
        );
      }
    }
  }

  private async syncRiskItems(
    manager: EntityManager,
    aprId: string,
    items?: AprRiskItemSnapshot[],
  ): Promise<void> {
    const desired = items ?? [];
    const riskItemsRepository = manager.getRepository(AprRiskItem);
    const existing = await this.loadRiskItemsForSync(aprId, manager, {
      withEvidences: false,
    });

    const upserts: AprRiskItem[] = [];
    desired.forEach((item, index) => {
      const current = existing[index];
      if (current) {
        Object.assign(current, item);
        current.prazo = item.prazo ? new Date(item.prazo) : null;
        upserts.push(current);
        return;
      }

      upserts.push(
        riskItemsRepository.create({
          apr_id: aprId,
          ...item,
          hierarquia_controle:
            item.hierarquia_controle as AprRiskItem['hierarquia_controle'],
          prazo: item.prazo ? new Date(item.prazo) : null,
        }),
      );
    });

    const extras = existing.slice(desired.length);

    if (upserts.length > 0) {
      // Evita queries gigantes em APRs com muitas linhas (melhor para estabilidade
      // sob latencia/CPU em produção).
      await riskItemsRepository.save(upserts, { chunk: 50 });
    }

    // Soft delete para rastreabilidade forense: itens removidos ficam com
    // deleted_at preenchido e não aparecem nas consultas normais, mas
    // permanecem auditáveis no histórico.
    if (extras.length > 0) {
      await riskItemsRepository.softDelete(extras.map((row) => row.id));
    }
  }

  private async ensureDefaultApprovalSteps(
    manager: EntityManager,
    aprId: string,
  ): Promise<void> {
    const approvalStepRepository = manager.getRepository(AprApprovalStep);
    const existing = await approvalStepRepository.find({
      where: { apr_id: aprId },
      select: ['id'],
    });

    if (existing.length > 0) {
      return;
    }

    await approvalStepRepository.save(
      APR_DEFAULT_APPROVAL_STEP_TEMPLATES.map((step) =>
        approvalStepRepository.create({
          apr_id: aprId,
          level_order: step.level_order,
          title: step.title,
          approver_role: step.approver_role,
          status: AprApprovalStepStatus.PENDING,
        }),
      ),
    );
  }

  private materializeMissingRiskItems(apr: Apr): Apr {
    apr.risk_items = Array.isArray(apr.risk_items)
      ? apr.risk_items.slice().sort((left, right) => left.ordem - right.ordem)
      : [];
    // Compatibilidade de API/formulário: o payload legado é sintetizado em
    // memória a partir de apr_risk_items. O banco não recebe mais esse JSONB.
    apr.itens_risco = this.toLegacyRiskItemPayload(
      apr.risk_items.map((item) => this.mapPersistedRiskItemToSnapshot(item)),
    );
    return apr;
  }

  private async assertCompanyScopedEntityId<
    T extends { id: string; company_id: string },
  >(
    manager: EntityManager,
    entity: { new (): T },
    companyId: string,
    id: string | null | undefined,
    label: string,
  ): Promise<void> {
    if (!id) {
      return;
    }

    const exists = await manager.getRepository(entity).exist({
      where: { id, company_id: companyId } as never,
    });

    if (!exists) {
      throw new BadRequestException(
        `${label} inválido para a empresa/tenant atual.`,
      );
    }
  }

  private async assertCompanyScopedEntityIds<
    T extends { id: string; company_id: string },
  >(
    manager: EntityManager,
    entity: { new (): T },
    companyId: string,
    ids: string[] | undefined,
    label: string,
  ): Promise<void> {
    const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));
    if (uniqueIds.length === 0) {
      return;
    }

    const count = await manager.getRepository(entity).count({
      where: { id: In(uniqueIds), company_id: companyId } as never,
    });

    if (count !== uniqueIds.length) {
      throw new BadRequestException(
        `${label} contém vínculo(s) inválido(s) para a empresa/tenant atual.`,
      );
    }
  }

  private async assertUsersScopedToSite(
    manager: EntityManager,
    companyId: string,
    siteId: string | null | undefined,
    ids: Array<string | null | undefined>,
    label: string,
  ): Promise<void> {
    if (!siteId) {
      return;
    }

    const uniqueIds = Array.from(
      new Set(
        ids.filter((id): id is string => Boolean(String(id || '').trim())),
      ),
    );
    if (uniqueIds.length === 0) {
      return;
    }

    const userRepository = manager.getRepository(User);
    const count =
      typeof userRepository.createQueryBuilder === 'function'
        ? await userRepository
            .createQueryBuilder('user')
            .leftJoin('user.site_links', 'siteLink')
            .where('user.id IN (:...uniqueIds)', { uniqueIds })
            .andWhere('user.company_id = :companyId', { companyId })
            .andWhere('user.deleted_at IS NULL')
            .andWhere(
              '(user.site_id = :siteId OR siteLink.site_id = :siteId OR user.site_id IS NULL)',
              { siteId },
            )
            .getCount()
        : await userRepository.count({
            where: [
              {
                id: In(uniqueIds),
                company_id: companyId,
                site_id: siteId,
              },
              {
                id: In(uniqueIds),
                company_id: companyId,
                site_id: IsNull(),
              },
            ] as never,
          });

    if (count !== uniqueIds.length) {
      throw new BadRequestException(
        `${label} contém vínculo(s) inválido(s) para a obra/setor selecionada.`,
      );
    }
  }

  private async validateRelatedEntityScope(input: {
    manager?: EntityManager;
    companyId: string;
    siteId?: string | null;
    elaboradorId?: string | null;
    auditadoPorId?: string | null;
    activities?: string[];
    risks?: string[];
    epis?: string[];
    tools?: string[];
    machines?: string[];
    participants?: string[];
  }): Promise<void> {
    const manager = input.manager ?? this.aprsRepository.manager;
    await this.assertCompanyScopedEntityId(
      manager,
      Site,
      input.companyId,
      input.siteId,
      'Site',
    );
    await this.assertCompanyScopedEntityId(
      manager,
      User,
      input.companyId,
      input.elaboradorId,
      'Elaborador',
    );
    await this.assertCompanyScopedEntityId(
      manager,
      User,
      input.companyId,
      input.auditadoPorId,
      'Auditado por',
    );
    await this.assertCompanyScopedEntityIds(
      manager,
      Activity,
      input.companyId,
      input.activities,
      'Atividades',
    );
    await this.assertCompanyScopedEntityIds(
      manager,
      Risk,
      input.companyId,
      input.risks,
      'Riscos',
    );
    await this.assertCompanyScopedEntityIds(
      manager,
      Epi,
      input.companyId,
      input.epis,
      'EPIs',
    );
    await this.assertCompanyScopedEntityIds(
      manager,
      Tool,
      input.companyId,
      input.tools,
      'Ferramentas',
    );
    await this.assertCompanyScopedEntityIds(
      manager,
      Machine,
      input.companyId,
      input.machines,
      'Máquinas',
    );
    await this.assertCompanyScopedEntityIds(
      manager,
      User,
      input.companyId,
      input.participants,
      'Participantes',
    );
    await this.assertUsersScopedToSite(
      manager,
      input.companyId,
      input.siteId,
      [input.elaboradorId, input.auditadoPorId, ...(input.participants ?? [])],
      'Usuários do documento',
    );
  }

  private buildAprTraceMetadata(apr: Apr): Record<string, unknown> {
    return {
      companyId: apr.company_id,
      status: apr.status,
      versao: apr.versao ?? 1,
      siteId: apr.site_id,
      participantCount: Array.isArray(apr.participants)
        ? apr.participants.length
        : 0,
      riskItemCount: Array.isArray(apr.risk_items) ? apr.risk_items.length : 0,
    };
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  /**
   * Definir o modelo-padrão da empresa (`is_modelo_padrao`) substitui o template
   * default de TODOS os usuários do tenant. É uma ação administrativa e não deve
   * ser permitida a papéis operacionais (Supervisor/Colaborador), ainda que
   * tenham permissão de criar/editar APRs.
   */
  private assertCanManageCompanyTemplate(
    roleNames?: Array<string | null | undefined>,
  ): void {
    // Usa a mesma normalização canônica do RolesGuard (aliases, acentos, maiúsculas)
    // e considera todos os sinais de papel disponíveis (profile.nome + roles
    // resolvidos via RBAC), evitando bloquear admins legítimos com grafia divergente
    // ou perfil não carregado no token.
    const privilegedRoles = new Set<Role>([
      Role.SUPER_ADMIN,
      Role.ADMIN_GERAL,
      Role.ADMIN_EMPRESA,
      Role.TST,
    ]);
    const isPrivileged = (roleNames ?? []).some((name) => {
      const normalized = normalizeRoleName(name ?? undefined);
      return normalized != null && privilegedRoles.has(normalized);
    });
    if (!isPrivileged) {
      throw new ForbiddenException(
        'Apenas Administrador Geral, Administrador da Empresa ou TST podem definir o modelo-padrão da empresa.',
      );
    }
  }

  async create(
    createAprDto: CreateAprDto,
    userId?: string,
    actor?: { roleNames?: Array<string | null | undefined> },
  ): Promise<Apr> {
    const {
      activities,
      risks,
      epis,
      tools,
      machines,
      participants,
      risk_items,
      itens_risco,
      ...rest
    } = createAprDto;
    const companyId = this.tenantService.getTenantId();
    if (!companyId) {
      throw new BadRequestException(
        'Tenant/empresa não identificado para criação da APR.',
      );
    }
    const normalizedRiskItems = this.buildAprRiskItemSnapshots({
      itens_risco: itens_risco,
      risk_items,
    });
    this.assertAprDraftIntegrity({
      dataInicio: createAprDto.data_inicio,
      dataFim: createAprDto.data_fim,
      participants,
      riskItems: normalizedRiskItems,
    });

    // Definir o modelo-padrão da empresa é ação administrativa (afeta todos os
    // usuários do tenant). Falha rápido antes de abrir a transação.
    if (createAprDto.is_modelo_padrao) {
      this.assertCanManageCompanyTemplate(actor?.roleNames);
    }

    let savedId: string;
    try {
      savedId = await this.aprsRepository.manager.transaction(
        async (manager) => {
          const duplicate = await manager.getRepository(Apr).findOne({
            where: { numero: createAprDto.numero, company_id: companyId },
            select: ['id'],
          });
          if (duplicate) {
            throw new ConflictException(
              `Já existe uma APR com o número "${createAprDto.numero}" nesta empresa.`,
            );
          }

          await this.validateRelatedEntityScope({
            manager,
            companyId,
            siteId: createAprDto.site_id,
            elaboradorId: createAprDto.elaborador_id,
            auditadoPorId: createAprDto.auditado_por_id ?? null,
            activities,
            risks,
            epis,
            tools,
            machines,
            participants,
          });
          const initialRisk = this.riskCalculationService.calculateScore(
            rest.probability,
            rest.severity,
            rest.exposure,
          );
          const residualRisk =
            rest.residual_risk ||
            this.riskCalculationService.classifyByScore(initialRisk) ||
            null;

          if (rest.is_modelo_padrao) {
            rest.is_modelo = true;
          }

          const aprRepository = manager.getRepository(Apr);
          const apr = aprRepository.create({
            ...rest,
            status: AprStatus.PENDENTE,
            initial_risk: initialRisk,
            residual_risk: residualRisk,
            control_evidence: Boolean(rest.control_evidence),
            classificacao_resumo:
              this.buildAprClassificationSummary(normalizedRiskItems),
            company_id: companyId,
            activities: activities?.map(
              (id) => ({ id }) as unknown as Activity,
            ),
            risks: risks?.map((id) => ({ id }) as unknown as Risk),
            epis: epis?.map((id) => ({ id }) as unknown as Epi),
            tools: tools?.map((id) => ({ id }) as unknown as Tool),
            machines: machines?.map((id) => ({ id }) as unknown as Machine),
            participants: participants?.map(
              (id) => ({ id }) as unknown as User,
            ),
          });

          const saved = await aprRepository.save(apr);
          await this.syncRiskItems(manager, saved.id, normalizedRiskItems);
          await this.ensureDefaultApprovalSteps(manager, saved.id);
          if (saved.is_modelo_padrao) {
            // Operação atômica: desativa todos os modelos padrão da empresa
            // e ativa apenas este, dentro da mesma transação.
            // Isso elimina a race condition dos dois UPDATEs separados e
            // é compatível com o índice parcial único UQ_aprs_modelo_padrao_per_company.
            await manager.query(
              `UPDATE aprs
             SET is_modelo_padrao = CASE WHEN id = $1 THEN true ELSE false END,
                 is_modelo        = CASE WHEN id = $1 THEN true ELSE is_modelo END
             WHERE company_id = $2 AND deleted_at IS NULL AND (is_modelo_padrao = true OR id = $1)`,
              [saved.id, saved.company_id],
            );
          }

          return saved.id;
        },
      );
    } catch (error) {
      // A checagem in-transaction cobre o caso comum, mas duas criações
      // concorrentes com o mesmo número passam pela checagem e colidem no
      // índice único UQ_aprs_company_numero_active. Traduz o 23505 cru do
      // Postgres (que viraria 500) no mesmo 409 amigável.
      if (this.isDuplicateAprNumeroError(error)) {
        throw new ConflictException(
          `Já existe uma APR com o número "${createAprDto.numero}" nesta empresa.`,
        );
      }
      throw error;
    }

    // Único findOne pós-transação: carrega todas as relações para o retorno HTTP
    // e reutiliza o mesmo objeto para logging/auditoria — elimina o double-fetch
    // que existia antes (2× findOne com 12 relações = ~200ms extras por criação).
    const result = await this.findOne(savedId);
    this.logger.log({
      event: 'apr_created',
      aprId: result.id,
      companyId: result.company_id,
    });
    this.metricsService?.incrementAprCreated(result.company_id, result.status);
    // Fire-and-forget: auditoria não bloqueia resposta ao cliente.
    // Falhas são logadas internamente; o APR já foi persistido com sucesso.
    void this.addLog(
      result.id,
      userId ?? result.elaborador_id,
      APR_LOG_ACTIONS.CREATED,
      this.buildAprTraceMetadata(result),
    ).catch((err: unknown) => {
      this.logger.error({
        event: 'apr_create_log_failed',
        aprId: result.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    void this.invalidateAprOverviewCache(result.company_id);
    this.recordAprMetric({
      aprId: result.id,
      tenantId: result.company_id,
      eventType: AprMetricEventType.APR_SAVED,
    });
    return result;
  }

  /**
   * Retorna APRs completas com todas as relações carregadas.
   *
   * **ATENÇÃO:** use apenas em contextos internos controlados onde o volume
   * de registros é conhecido e pequeno (ex.: geração de PDF, exportação
   * unitária). NUNCA chame este método em loops ou a partir de contextos de IA.
   */
  async findAll(): Promise<Apr[]> {
    const tenantId = this.tenantService.getTenantId();
    if (!tenantId) {
      throw new InternalServerErrorException(
        'Tenant context ausente em consulta de APR (findAll)',
      );
    }
    return this.aprsRepository.find({
      where: { company_id: tenantId },
      relations: ['company', 'site', 'elaborador'],
      order: { created_at: 'DESC' },
      take: 100,
    });
  }

  /**
   * Retorna um snapshot leve das APRs para uso em contexto de IA.
   *
   * Limitado a 300 registros mais recentes, sem relações e com apenas os
   * campos necessários para enriquecer prompts (`id`, `codigo`, `status`,
   * `created_at`, `company_id`). Use este método em vez de `findAll()`
   * sempre que o destino for um modelo de linguagem ou pipeline de IA.
   *
   * @param tenantId ID da empresa — obrigatório para garantir isolamento multi-tenant.
   */
  async findAllForAiContext(tenantId: string): Promise<AprAiContextSummary[]> {
    const rows = await this.aprsRepository.find({
      where: { company_id: tenantId },
      // `numero` é o código interno persistido; expomos como `codigo` no snapshot de IA.
      select: ['id', 'numero', 'status', 'created_at', 'company_id'],
      order: { created_at: 'DESC' },
      take: 300,
    });

    return rows.map((apr) => ({
      id: apr.id,
      codigo: apr.numero,
      status: apr.status,
      created_at: apr.created_at,
      company_id: apr.company_id,
    }));
  }

  async findPaginated(opts?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    siteId?: string;
    responsibleId?: string;
    dueFilter?: string;
    sort?: 'priority' | 'updated-desc' | 'deadline-asc' | 'title-asc';
    companyId?: string;
    isModeloPadrao?: boolean;
    contextFilter?: 'minhas' | 'vence-hoje' | 'preciso-assinar';
    userId?: string;
  }): Promise<OffsetPage<AprListItemDto>> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const qb = this.aprsRepository
      .createQueryBuilder('apr')
      .leftJoin('apr.company', 'company')
      .leftJoin('apr.site', 'site')
      .leftJoin('apr.elaborador', 'elaborador')
      .leftJoin('apr.auditado_por', 'auditado_por')
      .leftJoin('apr.aprovado_por', 'aprovado_por')
      .select([
        'apr.id',
        'apr.numero',
        'apr.titulo',
        'apr.descricao',
        'apr.tipo_atividade',
        'apr.frente_trabalho',
        'apr.area_risco',
        'apr.data_inicio',
        'apr.data_fim',
        'apr.status',
        'apr.versao',
        'apr.is_modelo',
        'apr.is_modelo_padrao',
        'apr.company_id',
        'apr.site_id',
        'apr.elaborador_id',
        'apr.auditado_por_id',
        'apr.aprovado_por_id',
        'apr.pdf_file_key',
        'apr.pdf_original_name',
        'apr.classificacao_resumo',
        'apr.itens_risco',
        'apr.created_at',
        'apr.updated_at',
        'company.id',
        'company.razao_social',
        'site.id',
        'site.nome',
        'elaborador.id',
        'elaborador.nome',
        'elaborador.funcao',
        'auditado_por.id',
        'auditado_por.nome',
        'auditado_por.funcao',
        'aprovado_por.id',
        'aprovado_por.nome',
        'aprovado_por.funcao',
      ])
      .skip(skip)
      .take(limit);

    if (companyId) {
      qb.where('apr.company_id = :companyId', { companyId });
    } else if (opts?.companyId) {
      qb.where('apr.company_id = :companyId', { companyId: opts.companyId });
    }

    // APR tem soft-delete (deleted_at, incluído no gdpr_delete_user_data).
    // createQueryBuilder não filtra deleted_at automaticamente — sem isto,
    // APRs de titular anonimizado por GDPR apareceriam na listagem e
    // inflariam o total.
    qb.andWhere('apr.deleted_at IS NULL');

    if (!isSuperAdmin && siteScope !== 'all') {
      qb.andWhere('apr.site_id IN (:...siteIds)', { siteIds });
    } else if (opts?.siteId) {
      qb.andWhere('apr.site_id = :siteId', { siteId: opts.siteId });
    }

    const searchTerm = normalizeOptionalSearchQuery(opts?.search);
    if (searchTerm) {
      qb.andWhere(
        `(apr.numero ILIKE :search ESCAPE '\\'
          OR apr.titulo ILIKE :search ESCAPE '\\'
          OR apr.tipo_atividade ILIKE :search ESCAPE '\\'
          OR apr.frente_trabalho ILIKE :search ESCAPE '\\'
          OR apr.area_risco ILIKE :search ESCAPE '\\'
          OR site.nome ILIKE :search ESCAPE '\\'
          OR elaborador.nome ILIKE :search ESCAPE '\\'
          OR auditado_por.nome ILIKE :search ESCAPE '\\'
          OR aprovado_por.nome ILIKE :search ESCAPE '\\')`,
        { search: `%${escapeLikePattern(searchTerm)}%` },
      );
    }

    if (opts?.status) {
      qb.andWhere('apr.status = :status', { status: opts.status });
    }

    if (opts?.siteId) {
      qb.andWhere('apr.site_id = :siteId', { siteId: opts.siteId });
    }

    if (opts?.responsibleId) {
      qb.andWhere(
        `CASE
          WHEN apr.status IN (:...approvedStates) AND apr.aprovado_por_id IS NOT NULL THEN apr.aprovado_por_id
          WHEN apr.auditado_por_id IS NOT NULL THEN apr.auditado_por_id
          ELSE apr.elaborador_id
        END = :responsibleId`,
        {
          approvedStates: [AprStatus.APROVADA, AprStatus.ENCERRADA],
          responsibleId: opts.responsibleId,
        },
      );
    }

    if (opts?.dueFilter) {
      switch (opts.dueFilter) {
        case 'today':
          qb.andWhere('apr.data_fim = CURRENT_DATE');
          break;
        case 'next-7-days':
          qb.andWhere(
            "apr.data_fim >= CURRENT_DATE AND apr.data_fim <= CURRENT_DATE + INTERVAL '7 days'",
          );
          break;
        case 'expired':
          qb.andWhere('apr.data_fim < CURRENT_DATE');
          break;
        case 'upcoming':
          qb.andWhere("apr.data_fim > CURRENT_DATE + INTERVAL '7 days'");
          break;
        case 'no-deadline':
          qb.andWhere('apr.data_fim IS NULL');
          break;
        default:
          break;
      }
    }

    if (opts?.isModeloPadrao !== undefined) {
      qb.andWhere('apr.is_modelo_padrao = :isModeloPadrao', {
        isModeloPadrao: opts.isModeloPadrao,
      });
    }

    if (opts?.contextFilter && opts.userId) {
      switch (opts.contextFilter) {
        case 'minhas':
          qb.andWhere('apr.elaborador_id = :ctxUserId', {
            ctxUserId: opts.userId,
          });
          break;
        case 'vence-hoje':
          qb.andWhere('apr.data_fim::date = CURRENT_DATE');
          break;
        case 'preciso-assinar':
          // APRs pendentes em que o usuário é participante mas ainda não assinou
          qb.andWhere(
            `EXISTS (
              SELECT 1 FROM "apr_participants" apu
              WHERE apu."apr_id" = apr.id AND apu."user_id" = :ctxUserId
            )`,
            { ctxUserId: opts.userId },
          )
            .andWhere(
              `NOT EXISTS (
              SELECT 1 FROM "signatures" s
              WHERE s."document_id" = apr.id
                AND s."document_type" = 'APR'
                AND s."user_id" = :ctxUserId
            )`,
              { ctxUserId: opts.userId },
            )
            .andWhere('apr.status = :pendingStatus', {
              pendingStatus: AprStatus.PENDENTE,
            });
          break;
        default:
          break;
      }
    }

    const priorityOrderExpression = `CASE
      WHEN apr.status = '${AprStatus.PENDENTE}' AND apr.data_fim < CURRENT_DATE THEN 0
      WHEN apr.status = '${AprStatus.PENDENTE}' AND apr.data_fim = CURRENT_DATE THEN 1
      WHEN apr.status = '${AprStatus.PENDENTE}' AND apr.data_fim <= CURRENT_DATE + INTERVAL '7 days' THEN 2
      WHEN apr.status = '${AprStatus.APROVADA}' AND apr.pdf_file_key IS NULL THEN 3
      WHEN apr.status = '${AprStatus.PENDENTE}' THEN 4
      WHEN apr.status = '${AprStatus.APROVADA}' THEN 5
      WHEN apr.status = '${AprStatus.ENCERRADA}' THEN 6
      ELSE 7
    END`;

    switch (opts?.sort) {
      case 'updated-desc':
        qb.orderBy('apr.updated_at', 'DESC');
        break;
      case 'deadline-asc':
        qb.orderBy('apr.data_fim', 'ASC', 'NULLS LAST').addOrderBy(
          'apr.updated_at',
          'DESC',
        );
        break;
      case 'title-asc':
        qb.orderBy('apr.titulo', 'ASC').addOrderBy('apr.created_at', 'DESC');
        break;
      case 'priority':
      default:
        qb
          // TypeORM perde a referencia do alias quando o ORDER BY recebe a
          // expressao CASE crua em consultas paginadas com getManyAndCount().
          // Materializamos a prioridade como select nomeado e ordenamos pelo alias.
          .addSelect(priorityOrderExpression, 'apr_priority_order')
          .orderBy('apr_priority_order', 'ASC')
          .addOrderBy('apr.data_fim', 'ASC', 'NULLS LAST')
          .addOrderBy('apr.updated_at', 'DESC');
        break;
    }

    const [rows, total] = await qb.getManyAndCount();
    const rowIds = rows.map((row) => row.id);
    type ParticipantCountRow = { apr_id: string; count: number | string };
    type SignatureCountRow = {
      apr_id: string;
      participant_count: number | string;
      total_count: number | string;
    };

    const [participantCountRows, signatureCountRows]: [
      ParticipantCountRow[],
      SignatureCountRow[],
    ] =
      rowIds.length > 0
        ? await Promise.all([
            this.aprsRepository.manager.query<ParticipantCountRow[]>(
              `
                SELECT apr_id, COUNT(*)::int AS count
                FROM apr_participants
                WHERE apr_id = ANY($1::uuid[])
                GROUP BY apr_id
              `,
              [rowIds],
            ),
            this.aprsRepository.manager.query<SignatureCountRow[]>(
              `
                SELECT
                  s.document_id AS apr_id,
                  COUNT(DISTINCT s.user_id) FILTER (WHERE ap.user_id IS NOT NULL)::int AS participant_count,
                  COUNT(DISTINCT s.user_id)::int AS total_count
                FROM signatures s
                LEFT JOIN apr_participants ap
                  ON ap.apr_id = s.document_id::uuid
                  AND ap.user_id = s.user_id
                WHERE s.document_type = 'APR'
                  AND s.document_id = ANY($1::text[])
                  AND s.company_id = $2::uuid
                GROUP BY s.document_id
              `,
              [rowIds, companyId],
            ),
          ])
        : [[], []];

    const participantCountByApr = new Map(
      participantCountRows.map((row) => [row.apr_id, Number(row.count ?? 0)]),
    );
    const signatureCountByApr = new Map(
      signatureCountRows.map((row) => [
        row.apr_id,
        {
          participant: Number(row.participant_count ?? 0),
          total: Number(row.total_count ?? 0),
        },
      ]),
    );

    const data = rows.map((row) => {
      const participantCount = participantCountByApr.get(row.id) ?? 0;
      const signatureCount = signatureCountByApr.get(row.id);

      return plainToClass(AprListItemDto, {
        ...row,
        participant_count: participantCount,
        signature_count:
          participantCount > 0
            ? (signatureCount?.participant ?? 0)
            : (signatureCount?.total ?? 0),
      });
    });
    return toOffsetPage(data, total, page, limit);
  }

  /**
   * Constrói o filtro WHERE com isolamento de tenant e, quando o usuário
   * possui siteScope='single', adiciona restrição de site_id.
   * Previne IDOR cross-site dentro do mesmo tenant.
   */
  private buildAprWhere(id: string): FindOptionsWhere<Apr> {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'APR',
    );
    const where: FindOptionsWhere<Apr> = { id, company_id: scope.companyId };
    if (!scope.hasCompanyWideAccess) {
      where.site_id = In(scope.siteIds);
    }
    return where;
  }

  async findOne(id: string): Promise<Apr> {
    const apr = await this.aprsRepository.findOne({
      where: this.buildAprWhere(id),
      relations: [
        'company',
        'site',
        'elaborador',
        'activities',
        'risks',
        'epis',
        'tools',
        'machines',
        'participants',
        'auditado_por',
        'aprovado_por',
        'reprovado_por',
        'approval_steps',
        'approval_steps.approver_user',
        'risk_items',
      ],
    });
    if (!apr) {
      throw new NotFoundException(`APR com ID ${id} não encontrada`);
    }
    return this.materializeMissingRiskItems(apr);
  }

  /** Busca sem eager-load de relações — usar em operações de escrita (approve, reject, update...) */
  private async findOneForWrite(id: string): Promise<Apr> {
    const apr = await this.aprsRepository.findOne({
      where: this.buildAprWhere(id),
      relations: ['approval_steps'],
    });
    if (!apr) {
      throw new NotFoundException(`APR com ID ${id} não encontrada`);
    }
    return apr;
  }

  /**
   * Carrega somente o necessário para a decisão de aprovação.
   * Mantém o write path explícito e evita depender do findOne() genérico
   * com eager-load amplo de relações não usadas no fluxo crítico.
   */
  private async findOneForApproval(id: string): Promise<Apr> {
    const apr = await this.aprsRepository.findOne({
      where: this.buildAprWhere(id),
      relations: ['participants', 'risk_items'],
    });
    if (!apr) {
      throw new NotFoundException(`APR com ID ${id} não encontrada`);
    }
    return apr;
  }

  async update(
    id: string,
    updateAprDto: UpdateAprDto,
    userId?: string,
    actor?: { roleNames?: Array<string | null | undefined> },
  ): Promise<Apr> {
    // Verifica privilégio ao promover (true) OU rebaixar (false) o template da empresa.
    // is_modelo: false aciona o mesmo efeito via coerção na linha abaixo — ambos os
    // vetores são bloqueados aqui, antes de qualquer mutação.
    if (
      updateAprDto.is_modelo_padrao !== undefined ||
      updateAprDto.is_modelo === false
    ) {
      this.assertCanManageCompanyTemplate(actor?.roleNames);
    }
    if ('status' in updateAprDto && updateAprDto.status !== undefined) {
      throw new BadRequestException(
        'Use os endpoints /approve, /reject ou /finalize para alterar o status da APR.',
      );
    }
    const apr = await this.findOneForWrite(id);
    this.assertAprDocumentMutable(apr);
    this.assertAprFormMutable(apr);

    // Detecção de conflito otimista: rejeita apenas se o registro no banco está
    // MAIS NOVO que o snapshot que o cliente carregou — sinal de que outro
    // usuário salvou nesse meio-tempo. A comparação é direcional: um guardTs
    // adiantado (relógio do cliente à frente) não é conflito, evitando o
    // falso-positivo do antigo Math.abs. Tolerância cobre rounding de ms.
    if (updateAprDto._conflict_guard_updated_at) {
      const guardTs = new Date(
        updateAprDto._conflict_guard_updated_at,
      ).getTime();
      const currentTs = new Date(apr.updated_at).getTime();
      if (!Number.isNaN(guardTs) && currentTs - guardTs > 1000) {
        throw new ConflictException(
          'A APR foi modificada por outro usuário enquanto você estava offline. Recarregue e aplique suas alterações novamente.',
        );
      }
    }
    const {
      activities,
      risks,
      epis,
      tools,
      machines,
      participants,
      risk_items,
      itens_risco,
      ...rest
    } = updateAprDto;
    const persistedRiskItems = await this.loadRiskItemsForSync(id);

    const next = { ...rest };
    if (next.is_modelo_padrao) next.is_modelo = true;
    if (next.is_modelo === false) next.is_modelo_padrao = false;
    const nextRiskItems = this.buildAprRiskItemSnapshots({
      itens_risco:
        itens_risco !== undefined
          ? itens_risco
          : risk_items === undefined && persistedRiskItems.length > 0
            ? this.toLegacyRiskItemPayload(
                persistedRiskItems.map((item) =>
                  this.mapPersistedRiskItemToSnapshot(item),
                ),
              )
            : undefined,
      risk_items: risk_items !== undefined ? risk_items : undefined,
    });
    this.assertAprDraftIntegrity({
      status: apr.status,
      dataInicio: next.data_inicio ?? apr.data_inicio,
      dataFim: next.data_fim ?? apr.data_fim,
      participants:
        participants ??
        (Array.isArray(apr.participants)
          ? apr.participants.map((participant) => participant.id)
          : []),
      riskItems: nextRiskItems,
    });

    const initialRisk = this.riskCalculationService.calculateScore(
      next.probability ?? apr.probability,
      next.severity ?? apr.severity,
      next.exposure ?? apr.exposure,
    );
    const residualRisk =
      next.residual_risk ||
      this.riskCalculationService.classifyByScore(initialRisk) ||
      apr.residual_risk ||
      null;

    await this.aprsRepository.manager.transaction(async (manager) => {
      await this.validateRelatedEntityScope({
        manager,
        companyId: apr.company_id,
        siteId: next.site_id ?? apr.site_id,
        elaboradorId: next.elaborador_id ?? apr.elaborador_id,
        auditadoPorId:
          next.auditado_por_id !== undefined
            ? next.auditado_por_id
            : apr.auditado_por_id,
        activities,
        risks,
        epis,
        tools,
        machines,
        participants,
      });

      Object.assign(apr, {
        ...next,
        initial_risk: initialRisk,
        residual_risk: residualRisk,
        classificacao_resumo: this.buildAprClassificationSummary(nextRiskItems),
        control_evidence:
          next.control_evidence !== undefined
            ? Boolean(next.control_evidence)
            : Boolean(apr.control_evidence),
      });
      apr.itens_risco = undefined;

      if (activities) {
        apr.activities = activities.map((itemId) => ({
          id: itemId,
        })) as unknown as Activity[];
      }
      if (risks) {
        apr.risks = risks.map((itemId) => ({
          id: itemId,
        })) as unknown as Risk[];
      }
      if (epis) {
        apr.epis = epis.map((itemId) => ({ id: itemId })) as unknown as Epi[];
      }
      if (tools) {
        apr.tools = tools.map((itemId) => ({
          id: itemId,
        })) as unknown as Tool[];
      }
      if (machines) {
        apr.machines = machines.map((itemId) => ({
          id: itemId,
        })) as unknown as Machine[];
      }
      if (participants) {
        apr.participants = participants.map((itemId) => ({
          id: itemId,
        })) as unknown as User[];
      }

      const aprRepository = manager.getRepository(Apr);
      const saved = await aprRepository.save(apr);
      await this.assertRiskItemSyncAllowed(saved.id, nextRiskItems, manager);
      await this.syncRiskItems(manager, saved.id, nextRiskItems);

      // Aviso antecipado: detecta itens com campos obrigatórios ausentes para
      // que o usuário corrija antes de tentar aprovar (o bloqueio real ocorre na aprovação).
      const incompleteItems = nextRiskItems.filter(
        (item) => this.getRiskItemApprovalIssues(item).length > 0,
      );
      if (incompleteItems.length > 0) {
        this.logger.warn({
          event: 'apr_update_incomplete_risk_items',
          aprId: saved.id,
          count: incompleteItems.length,
          message:
            'APR salva com itens de risco incompletos. A aprovação será bloqueada até que todos os campos obrigatórios sejam preenchidos.',
        });
      }

      if (saved.is_modelo_padrao) {
        await manager.query(
          `UPDATE aprs
           SET is_modelo_padrao = CASE WHEN id = $1 THEN true ELSE false END,
               is_modelo        = CASE WHEN id = $1 THEN true ELSE is_modelo END
           WHERE company_id = $2 AND deleted_at IS NULL AND (is_modelo_padrao = true OR id = $1)`,
          [saved.id, saved.company_id],
        );
      }
    });

    const saved = await this.findOne(id);
    this.logger.log({
      event: 'apr_updated',
      aprId: saved.id,
      companyId: saved.company_id,
    });
    await this.addLog(
      saved.id,
      userId ?? saved.elaborador_id,
      APR_LOG_ACTIONS.UPDATED,
      this.buildAprTraceMetadata(saved),
    );
    void this.invalidateAprOverviewCache(saved.company_id);
    this.recordAprMetric({
      aprId: saved.id,
      tenantId: saved.company_id,
      eventType: AprMetricEventType.APR_SAVED,
    });
    return saved;
  }

  async remove(id: string, userId?: string): Promise<void> {
    const apr = await this.findOneForWrite(id);
    this.assertAprRemovable(apr);
    await this.documentGovernanceService.removeFinalDocumentReference({
      companyId: apr.company_id,
      module: 'apr',
      entityId: apr.id,
      trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
      trailMetadata: {
        removalMode: 'soft_delete',
      },
      removeEntityState: async (manager) => {
        await manager.getRepository(Apr).softDelete(id);
      },
      cleanupStoredFile: (fileKey) =>
        this.documentStorageService.deleteFile(
          this.documentStorageService.referenceForExistingObject(
            fileKey,
            { resourceType: 'apr', resourceId: id },
            'p1-document-storage-deleteFile',
          ),
        ),
    });

    // Limpar evidências órfãs: com a APR soft-deletada, os registros de
    // apr_risk_evidences ficam órfãos no storage. Removemos os arquivos S3 e
    // os registros do DB de forma assíncrona (fire-and-forget com log de erro).
    this.cleanupAprEvidences(id).catch((err) => {
      this.logger.error({
        event: 'apr_evidence_cleanup_failed',
        aprId: id,
        errorName: err instanceof Error ? err.name : 'unknown_error',
      });
    });

    await this.addLog(id, userId, APR_LOG_ACTIONS.REMOVED, {
      companyId: apr.company_id,
    });
    this.logger.log({
      event: 'apr_soft_deleted',
      aprId: apr.id,
      companyId: apr.company_id,
    });
    void this.invalidateAprOverviewCache(apr.company_id);
  }

  private async cleanupAprEvidences(aprId: string): Promise<void> {
    const evidenceRepository =
      this.aprsRepository.manager.getRepository(AprRiskEvidence);
    const evidences = await evidenceRepository.find({
      where: { apr_id: aprId },
      select: ['id', 'file_key', 'watermarked_file_key'],
    });

    if (evidences.length === 0) {
      return;
    }

    let deleted = 0;
    let failed = 0;

    for (const evidence of evidences) {
      const files = [
        evidence.file_key
          ? { key: evidence.file_key, resourceType: 'apr-evidence' }
          : null,
        evidence.watermarked_file_key
          ? {
              key: evidence.watermarked_file_key,
              resourceType: 'apr-evidence-watermarked',
            }
          : null,
      ].filter(
        (file): file is { key: string; resourceType: string } => file !== null,
      );
      for (const file of files) {
        const { key, resourceType } = file;
        try {
          await this.documentStorageService.deleteFile(
            this.documentStorageService.referenceForExistingObject(
              key,
              { resourceType, resourceId: evidence.id },
              'p1-document-storage-deleteFile',
            ),
          );
        } catch (err) {
          failed += 1;
          this.logger.warn({
            event: 'apr_evidence_file_delete_failed',
            aprId,
            evidenceId: evidence.id,
            keyFingerprint: storageKeyFingerprint(key),
            errorName: err instanceof Error ? err.name : 'unknown_error',
          });
        }
      }
      deleted += 1;
    }

    await evidenceRepository.delete(evidences.map((e) => e.id));
    this.logger.log({
      event: 'apr_evidence_cleanup_done',
      aprId,
      total: evidences.length,
      deleted,
      storageFailures: failed,
    });
  }

  // ─── Rules engine ────────────────────────────────────────────────────────────

  async validateCompliance(id: string): Promise<AprValidationResult> {
    const apr = await this.findOneWithRiskItems(id);
    if (!this.aprRulesEngine) {
      return {
        isValid: true,
        score: 100,
        blockers: [],
        warnings: [],
        appliedRuleSnapshot: '[]',
      };
    }
    return this.aprRulesEngine.validate(apr);
  }

  async submit(
    id: string,
    userId: string,
    reason?: string,
    actor?: {
      roleName?: string | null;
      roleNames?: Array<string | null | undefined>;
      ipAddress?: string | null;
    },
  ): Promise<Apr> {
    const tenantId = this.tenantService.getTenantId();
    const engineEnabled =
      this.aprFeatureFlagService && this.aprRulesEngine
        ? await this.aprFeatureFlagService.isEnabled(
            'APR_RULES_ENGINE',
            tenantId,
          )
        : false;

    if (engineEnabled && this.aprRulesEngine) {
      const apr = await this.findOneWithRiskItems(id);
      const result = await this.aprRulesEngine.validate(apr);

      if (!result.isValid) {
        this.recordAprMetric({
          aprId: id,
          tenantId,
          eventType: AprMetricEventType.APR_STEP_ERROR,
          errorStep: 'submit_rules_validation',
          metadata: { blockerCount: result.blockers.length },
        });
        throw new UnprocessableEntityException({
          message: 'APR bloqueada pelo motor de regras SST.',
          blockers: result.blockers,
          score: result.score,
        });
      }

      await this.aprsRepository
        .createQueryBuilder()
        .update(Apr)
        .set({
          rulesSnapshot: () =>
            `'${result.appliedRuleSnapshot.replace(/'/g, "''")}'::jsonb`,
          complianceScore: result.score,
        })
        .where('id = :id', { id })
        .execute();
    }

    return this.approve(id, userId, reason, actor);
  }

  private async findOneWithRiskItems(id: string): Promise<Apr> {
    const tenantId = this.tenantService.getTenantId();
    return this.aprsRepository.findOneOrFail({
      where: { id, company_id: tenantId },
      relations: ['risk_items'],
    });
  }

  // ─── Workflow ────────────────────────────────────────────────────────────────

  async approve(
    id: string,
    userId: string,
    reason?: string,
    actor?: {
      roleName?: string | null;
      roleNames?: Array<string | null | undefined>;
      ipAddress?: string | null;
    },
  ): Promise<Apr> {
    const tenantId = this.tenantService.getTenantId();
    const engineEnabled =
      this.aprFeatureFlagService && this.aprRulesEngine
        ? await this.aprFeatureFlagService.isEnabled(
            'APR_RULES_ENGINE',
            tenantId,
          )
        : false;

    if (engineEnabled && this.aprRulesEngine) {
      const aprForValidation = await this.findOneWithRiskItems(id);
      const result = await this.aprRulesEngine.validate(aprForValidation);
      if (!result.isValid) {
        throw new UnprocessableEntityException({
          message:
            'APR bloqueada pelo motor de regras SST na verificação de aprovação.',
          blockers: result.blockers,
          score: result.score,
        });
      }
    }

    await this.aprWorkflowService.approve(id, userId, reason, actor);
    const apr = await this.findOne(id);
    void this.invalidateAprOverviewCache(apr.company_id);
    this.recordAprMetric({
      aprId: apr.id,
      tenantId: apr.company_id,
      eventType: AprMetricEventType.APR_APPROVED,
      metadata: { userId },
    });
    return apr;
  }

  async reject(
    id: string,
    userId: string,
    reason: string,
    actor?: {
      roleName?: string | null;
      roleNames?: Array<string | null | undefined>;
      ipAddress?: string | null;
    },
  ): Promise<Apr> {
    await this.aprWorkflowService.reject(id, userId, reason, actor);
    const apr = await this.findOne(id);
    void this.invalidateAprOverviewCache(apr.company_id);
    this.recordAprMetric({
      aprId: apr.id,
      tenantId: apr.company_id,
      eventType: AprMetricEventType.APR_REJECTED,
      metadata: { userId },
    });
    return apr;
  }

  async finalize(
    id: string,
    userId: string,
    actor?: {
      roleName?: string | null;
      roleNames?: Array<string | null | undefined>;
      ipAddress?: string | null;
    },
  ): Promise<Apr> {
    await this.aprWorkflowService.finalize(id, userId, actor);
    const apr = await this.findOne(id);
    void this.invalidateAprOverviewCache(apr.company_id);
    return apr;
  }

  async verifyFinalPdfPublic(
    code: string,
    companyId?: string,
  ): Promise<{
    valid: boolean;
    message?: string;
    apr?: {
      id: string;
      numero: string;
      titulo: string;
      status: string;
      versao: number;
      verification_code: string | null;
      final_pdf_hash_sha256: string | null;
      pdf_generated_at: string | null;
      company_name?: string | null;
      site_name?: string | null;
      aprovado_em?: string | null;
      approval_steps: Array<{
        level_order: number;
        title: string;
        status: string;
        approver_role: string;
        approver_name?: string | null;
        decided_at?: string | null;
      }>;
    };
    integrity?: {
      hash: string;
      valid: boolean;
      originalName?: string | null;
      documentCode?: string | null;
    };
  }> {
    const normalizedCode = String(code || '')
      .trim()
      .toUpperCase();

    if (!normalizedCode) {
      return {
        valid: false,
        message: 'Código de verificação ausente.',
      };
    }

    // O companyId vem de um token de validação ASSINADO (PublicValidationGrantService).
    // Sem ele o contexto de tenant seria indeterminado numa rota @Public — falha segura.
    if (!companyId) {
      this.logger.warn(
        `verifyFinalPdfPublic: companyId ausente para código ${normalizedCode} — retornando inválido.`,
      );
      return {
        valid: false,
        message: 'APR não localizada para o código informado.',
      };
    }

    return this.tenantService.run(
      { companyId, isSuperAdmin: false, siteScope: 'all' },
      () => this.resolveFinalPdfVerification(normalizedCode, companyId),
    );
  }

  private async resolveFinalPdfVerification(
    normalizedCode: string,
    companyId?: string,
  ) {
    const apr = await this.aprsRepository.findOne({
      where: {
        verification_code: normalizedCode,
        ...(companyId ? { company_id: companyId } : {}),
      },
      relations: [
        'company',
        'site',
        'approval_steps',
        'approval_steps.approver_user',
      ],
    });

    if (!apr || !apr.pdf_file_key) {
      return {
        valid: false,
        message: 'APR não localizada para o código informado.',
      };
    }

    const integrity =
      apr.final_pdf_hash_sha256 != null
        ? await this.pdfService.verifyForCompany(
            apr.final_pdf_hash_sha256,
            apr.company_id,
          )
        : null;

    return {
      valid: true,
      apr: {
        id: apr.id,
        numero: apr.numero,
        titulo: apr.titulo,
        status: apr.status,
        versao: apr.versao ?? 1,
        verification_code: apr.verification_code ?? null,
        final_pdf_hash_sha256: apr.final_pdf_hash_sha256 ?? null,
        pdf_generated_at: apr.pdf_generated_at?.toISOString() ?? null,
        company_name: apr.company?.razao_social ?? null,
        site_name: apr.site?.nome ?? null,
        aprovado_em: apr.aprovado_em?.toISOString() ?? null,
        approval_steps: (apr.approval_steps || [])
          .slice()
          .sort((left, right) => left.level_order - right.level_order)
          .map((step) => ({
            level_order: step.level_order,
            title: step.title,
            status: step.status,
            approver_role: step.approver_role,
            approver_name: step.approver_user?.nome ?? null,
            decided_at: step.decided_at?.toISOString() ?? null,
          })),
      },
      integrity: integrity
        ? {
            hash: integrity.hash,
            valid: integrity.valid,
            originalName: integrity.originalName ?? null,
            documentCode: integrity.document?.documentCode ?? null,
          }
        : undefined,
    };
  }

  private ensureAprStatus(status: unknown): AprStatus {
    return this.aprWorkflowService.ensureAprStatus(status);
  }

  private assertAprWorkflowTransitionAllowed(
    apr: Pick<Apr, 'status' | 'pdf_file_key'>,
  ): void {
    this.aprWorkflowService.assertAprWorkflowTransitionAllowed(apr);
  }

  private assertAprRemovable(apr: Pick<Apr, 'status' | 'pdf_file_key'>): void {
    this.aprWorkflowService.assertAprRemovable(apr);
  }

  async createNewVersion(id: string, userId: string): Promise<Apr> {
    const original = await this.findOne(id);
    if (this.ensureAprStatus(original.status) !== AprStatus.APROVADA) {
      throw new BadRequestException(
        `Somente APRs Aprovadas podem gerar nova versão. Status atual: ${original.status}`,
      );
    }

    const rootId = original.parent_apr_id ?? original.id;
    const maxVersionRow = await this.aprsRepository
      .createQueryBuilder('apr')
      .select('MAX(apr.versao)', 'max')
      .where('(apr.id = :rootId OR apr.parent_apr_id = :rootId)', { rootId })
      .getRawOne<{ max: string }>();
    const nextVersion = Number(maxVersionRow?.max ?? original.versao) + 1;
    const normalizedRiskItems = Array.isArray(original.risk_items)
      ? original.risk_items.map((item) =>
          this.mapPersistedRiskItemToSnapshot(item),
        )
      : [];

    const novo = this.aprsRepository.create({
      titulo: original.titulo,
      descricao: original.descricao,
      tipo_atividade: original.tipo_atividade,
      frente_trabalho: original.frente_trabalho,
      area_risco: original.area_risco,
      turno: original.turno,
      local_execucao_detalhado: original.local_execucao_detalhado,
      responsavel_tecnico_nome: original.responsavel_tecnico_nome,
      responsavel_tecnico_registro: original.responsavel_tecnico_registro,
      data_inicio: original.data_inicio,
      data_fim: original.data_fim,
      status: AprStatus.PENDENTE,
      is_modelo: original.is_modelo,
      is_modelo_padrao: false,
      probability: original.probability,
      severity: original.severity,
      exposure: original.exposure,
      initial_risk: original.initial_risk,
      residual_risk: original.residual_risk,
      control_description: original.control_description,
      control_evidence: original.control_evidence,
      classificacao_resumo:
        this.buildAprClassificationSummary(normalizedRiskItems),
      company_id: original.company_id,
      site_id: original.site_id,
      elaborador_id: userId,
      versao: nextVersion,
      parent_apr_id: rootId,
      numero: `${original.numero}-v${nextVersion}`,
      activities: (original.activities || []).map((item) => ({ id: item.id })),
      risks: (original.risks || []).map((item) => ({ id: item.id })),
      epis: (original.epis || []).map((item) => ({ id: item.id })),
      tools: (original.tools || []).map((item) => ({ id: item.id })),
      machines: (original.machines || []).map((item) => ({ id: item.id })),
      participants: (original.participants || []).map((item) => ({
        id: item.id,
      })),
    });

    const saved = await this.aprsRepository.save(novo);
    await this.syncRiskItems(
      this.aprsRepository.manager,
      saved.id,
      normalizedRiskItems,
    );
    await this.ensureDefaultApprovalSteps(
      this.aprsRepository.manager,
      saved.id,
    );
    await this.addLog(id, userId, APR_LOG_ACTIONS.NEW_VERSION_GENERATED, {
      novaAprId: saved.id,
      versao: nextVersion,
      sourceAprId: id,
    });
    await this.addLog(saved.id, userId, APR_LOG_ACTIONS.CREATED_FROM_VERSION, {
      ...this.buildAprTraceMetadata(saved),
      sourceAprId: id,
      versao: nextVersion,
    });
    this.logger.log({
      event: 'apr_new_version',
      originalId: id,
      newId: saved.id,
      versao: nextVersion,
    });

    // Regenera o PDF da APR original com marca d'água de versão supersedida.
    // Feito em background — não bloqueia a resposta.
    void this.aprsPdfService
      .regeneratePdfWithSupersededWatermark(id, userId)
      .catch((err) =>
        this.logger.warn(
          `Falha ao aplicar marca d'água em APR supersedida ${id}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );

    void this.invalidateAprOverviewCache(saved.company_id);
    return this.findOne(saved.id);
  }

  // ─── PDF Storage ─────────────────────────────────────────────────────────────

  async attachPdf(
    id: string,
    file: Express.Multer.File,
    userId?: string,
  ): Promise<{ fileKey: string; folderPath: string; originalName: string }> {
    return this.aprsPdfService.attachPdf(id, file, userId);
  }

  async generateFinalPdf(
    id: string,
    userId?: string,
  ): Promise<{
    entityId: string;
    generated: boolean;
    hasFinalPdf: boolean;
    availability: AprPdfAccessAvailability;
    message: string | null;
    fileKey: string | null;
    folderPath: string | null;
    originalName: string | null;
    url: string | null;
  }> {
    const result = await this.aprsPdfService.generateFinalPdf(id, userId);
    if (result.generated) {
      const tenantId = this.tenantService.getTenantId();
      this.recordAprMetric({
        aprId: id,
        tenantId: tenantId ?? null,
        eventType: AprMetricEventType.APR_PDF_GENERATED,
        metadata: {
          userId: userId ?? null,
          keyFingerprint: result.fileKey
            ? storageKeyFingerprint(result.fileKey)
            : null,
        },
      });
    }
    return result;
  }

  async uploadRiskEvidence(
    aprId: string,
    riskItemId: string,
    file: Express.Multer.File,
    metadata: {
      captured_at?: string;
      latitude?: number;
      longitude?: number;
      accuracy_m?: number;
      device_id?: string;
      exif_datetime?: string;
    },
    userId?: string,
    ipAddress?: string,
  ): Promise<{
    id: string;
    fileKey: string;
    originalName: string;
    hashSha256: string;
  }> {
    return this.aprsEvidenceService.uploadRiskEvidence(
      aprId,
      riskItemId,
      file,
      metadata,
      userId,
      ipAddress,
    );
  }

  async verifyEvidenceByHashPublic(hash: string): Promise<{
    verified: boolean;
    matchedIn?: 'original' | 'watermarked';
    message?: string;
    evidence?: {
      apr_numero?: string;
      apr_versao?: number;
      risk_item_ordem?: number;
      uploaded_at?: string;
      original_hash?: string;
      watermarked_hash?: string | null;
      integrity_flags?: Record<string, unknown> | null;
    };
  }> {
    return this.aprsEvidenceService.verifyEvidenceByHashPublic(hash);
  }

  async listAprEvidences(id: string) {
    return this.aprsEvidenceService.listAprEvidences(id);
  }

  async getPdfAccess(id: string): Promise<{
    entityId: string;
    hasFinalPdf: boolean;
    availability: AprPdfAccessAvailability;
    message?: string;
    fileKey: string | null;
    folderPath: string | null;
    originalName: string | null;
    url: string | null;
  }> {
    const apr = await this.findOneForWrite(id);
    if (!apr.pdf_file_key) {
      return {
        entityId: apr.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message: 'A APR ainda não possui PDF final emitido.',
        fileKey: null,
        folderPath: apr.pdf_folder_path ?? null,
        originalName: apr.pdf_original_name ?? null,
        url: null,
      };
    }

    let url: string | null;
    let availability: AprPdfAccessAvailability = 'ready';
    let message: string | undefined;
    try {
      url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          apr.pdf_file_key,
          {
            resourceType: 'apr',
            resourceId: apr.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
        3600,
      );
    } catch {
      url = null;
      availability = 'registered_without_signed_url';
      message =
        'O PDF final está registrado, mas a URL segura não está disponível no momento.';
    }

    return {
      entityId: apr.id,
      hasFinalPdf: true,
      availability,
      message,
      fileKey: apr.pdf_file_key,
      folderPath: apr.pdf_folder_path ?? null,
      originalName: apr.pdf_original_name ?? null,
      url,
    };
  }

  // ─── Logs & History ──────────────────────────────────────────────────────────

  async getLogs(id: string): Promise<AprLog[]> {
    await this.findOneForWrite(id);
    return this.aprLogsRepository.find({
      where: { apr_id: id },
      order: { data_hora: 'DESC' },
    });
  }

  async getVersionHistory(id: string): Promise<Apr[]> {
    const apr = await this.findOneForWrite(id);
    const rootId = apr.parent_apr_id ?? apr.id;
    const tenantId = this.tenantService.getTenantId();
    if (!tenantId) {
      throw new InternalServerErrorException(
        'Tenant context ausente em consulta de APR (getVersionHistory)',
      );
    }

    return this.aprsRepository
      .createQueryBuilder('apr')
      .select([
        'apr.id',
        'apr.numero',
        'apr.versao',
        'apr.status',
        'apr.parent_apr_id',
        'apr.aprovado_em',
        'apr.updated_at',
        'apr.classificacao_resumo',
      ])
      .where('(apr.id = :rootId OR apr.parent_apr_id = :rootId)', { rootId })
      .andWhere('apr.company_id = :tenantId', { tenantId })
      .andWhere('apr.deleted_at IS NULL')
      .orderBy('apr.versao', 'ASC')
      .getMany();
  }

  async compareVersions(
    baseId: string,
    targetId: string,
  ): Promise<{
    base: { id: string; numero: string; versao: number };
    target: { id: string; numero: string; versao: number };
    summary: {
      totalBase: number;
      totalTarget: number;
      added: number;
      removed: number;
      changed: number;
    };
    added: Array<Record<string, string>>;
    removed: Array<Record<string, string>>;
    changed: Array<{
      index: number;
      before: Record<string, string>;
      after: Record<string, string>;
      changedFields: string[];
    }>;
  }> {
    const [base, target] = await Promise.all([
      this.findOne(baseId),
      this.findOne(targetId),
    ]);

    const baseRootId = base.parent_apr_id ?? base.id;
    const targetRootId = target.parent_apr_id ?? target.id;

    if (baseRootId !== targetRootId) {
      throw new BadRequestException(
        'Só é possível comparar versões da mesma linha documental APR.',
      );
    }

    const baseSnapshots =
      Array.isArray(base.risk_items) && base.risk_items.length > 0
        ? base.risk_items.map((item) =>
            this.mapPersistedRiskItemToSnapshot(item),
          )
        : [];
    const targetSnapshots =
      Array.isArray(target.risk_items) && target.risk_items.length > 0
        ? target.risk_items.map((item) =>
            this.mapPersistedRiskItemToSnapshot(item),
          )
        : [];

    const maxLength = Math.max(baseSnapshots.length, targetSnapshots.length);
    const changed: Array<{
      index: number;
      before: Record<string, string>;
      after: Record<string, string>;
      changedFields: string[];
    }> = [];
    const added: Array<Record<string, string>> = [];
    const removed: Array<Record<string, string>> = [];

    for (let index = 0; index < maxLength; index += 1) {
      const before = baseSnapshots[index];
      const after = targetSnapshots[index];

      if (!before && after) {
        added.push(this.toLegacyRiskItemPayload([{ ...after, ordem: 0 }])[0]);
        continue;
      }

      if (before && !after) {
        removed.push(
          this.toLegacyRiskItemPayload([{ ...before, ordem: 0 }])[0],
        );
        continue;
      }

      if (!before || !after) {
        continue;
      }

      const changedFields = Object.entries({
        atividade_processo: before.atividade !== after.atividade,
        agente_ambiental: before.agente_ambiental !== after.agente_ambiental,
        condicao_perigosa: before.condicao_perigosa !== after.condicao_perigosa,
        fontes_circunstancias:
          before.fonte_circunstancia !== after.fonte_circunstancia,
        possiveis_lesoes: before.lesao !== after.lesao,
        probabilidade: before.probabilidade !== after.probabilidade,
        severidade: before.severidade !== after.severidade,
        categoria_risco: before.categoria_risco !== after.categoria_risco,
        prioridade: before.prioridade !== after.prioridade,
        medidas_prevencao: before.medidas_prevencao !== after.medidas_prevencao,
        responsavel: before.responsavel !== after.responsavel,
        prazo: before.prazo !== after.prazo,
        status_acao: before.status_acao !== after.status_acao,
      })
        .filter(([, hasChanged]) => hasChanged)
        .map(([field]) => field);

      if (changedFields.length > 0) {
        changed.push({
          index,
          before: this.toLegacyRiskItemPayload([{ ...before, ordem: 0 }])[0],
          after: this.toLegacyRiskItemPayload([{ ...after, ordem: 0 }])[0],
          changedFields,
        });
      }
    }

    return {
      base: {
        id: base.id,
        numero: base.numero,
        versao: base.versao ?? 1,
      },
      target: {
        id: target.id,
        numero: target.numero,
        versao: target.versao ?? 1,
      },
      summary: {
        totalBase: baseSnapshots.length,
        totalTarget: targetSnapshots.length,
        added: added.length,
        removed: removed.length,
        changed: changed.length,
      },
      added,
      removed,
      changed,
    };
  }

  // ─── Analytics ────────────────────────────────────────────────────────────────

  async getAnalyticsOverview(): Promise<{
    totalAprs: number;
    aprovadas: number;
    pendentes: number;
    riscosCriticos: number;
    mediaScoreRisco: number;
  }> {
    const tenantId = this.tenantService.getTenantId();
    if (!tenantId) {
      throw new InternalServerErrorException(
        'Tenant context ausente em consulta de APR (analytics)',
      );
    }

    return this.cacheService.getOrSet(
      this.buildAprOverviewCacheKey(tenantId),
      async () => {
        const baseWhere: FindOptionsWhere<Apr> = { company_id: tenantId };
        const approvedWhere: FindOptionsWhere<Apr> = {
          ...baseWhere,
          status: AprStatus.APROVADA,
        };
        const pendingWhere: FindOptionsWhere<Apr> = {
          ...baseWhere,
          status: AprStatus.PENDENTE,
        };

        const [totalAprs, aprovadas, pendentes] = await Promise.all([
          this.aprsRepository.count({ where: baseWhere }),
          this.aprsRepository.count({ where: approvedWhere }),
          this.aprsRepository.count({ where: pendingWhere }),
        ]);

        const riskStats = await this.aprsRepository
          .createQueryBuilder('apr')
          .innerJoin('apr.risk_items', 'ri')
          .select('AVG(ri.score_risco)', 'avg')
          .addSelect(
            `COUNT(CASE WHEN UPPER(ri.categoria_risco) IN ('CRÍTICO', 'CRITICO') THEN 1 END)`,
            'criticos',
          )
          .where('apr.company_id = :tenantId', { tenantId })
          .andWhere('apr.deleted_at IS NULL')
          .andWhere('ri.deleted_at IS NULL')
          .getRawOne<{ avg: string; criticos: string }>();

        return {
          totalAprs,
          aprovadas,
          pendentes,
          riscosCriticos: Number(riskStats?.criticos ?? 0),
          mediaScoreRisco: Math.round(Number(riskStats?.avg ?? 0)),
        };
      },
      this.getAprOverviewCacheTtlSeconds(),
    );
  }

  // ─── Misc ────────────────────────────────────────────────────────────────────

  async count(options?: { where?: Record<string, unknown> }): Promise<number> {
    const tenantId = this.tenantService.getTenantId();
    if (!tenantId) {
      throw new InternalServerErrorException(
        'Tenant context ausente em consulta de APR (count)',
      );
    }
    const where = options?.where || {};
    return this.aprsRepository.count({
      where: { ...where, company_id: tenantId } as Record<string, unknown>,
    });
  }

  async listStoredFiles(filters: WeeklyBundleFilters) {
    const files = await this.documentGovernanceService.listFinalDocuments(
      'apr',
      filters,
    );
    const allowedIds = await this.getAllowedAprIdsForCurrentScope();
    if (!allowedIds) {
      return files;
    }

    return files.filter((file) => allowedIds.has(file.entityId));
  }

  async getWeeklyBundle(filters: WeeklyBundleFilters) {
    const files = await this.listStoredFiles(filters);
    return this.documentBundleService.buildWeeklyPdfBundle(
      'APR',
      filters,
      files.map((file) => ({
        fileKey: file.fileKey,
        resourceType: 'apr',
        resourceId: file.entityId,
        title: file.title,
        originalName: file.originalName,
        date: file.date,
      })),
    );
  }

  async previewExcelImport(
    buffer: Buffer,
    fileName: string,
  ): Promise<AprExcelImportPreviewDto> {
    return this.aprExcelService.previewImport(buffer, fileName);
  }

  async exportExcelTemplate(): Promise<Buffer> {
    return this.aprExcelService.buildTemplateWorkbook();
  }

  async exportAprExcel(
    id: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const apr = await this.findOne(id);
    return {
      buffer: await this.aprExcelService.buildDetailWorkbook(apr),
      fileName: `apr-${String(apr.numero || apr.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.xlsx`,
    };
  }

  async exportExcel(): Promise<Buffer> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    const qb = this.aprsRepository
      .createQueryBuilder('apr')
      .select([
        'apr.numero',
        'apr.titulo',
        'apr.status',
        'apr.data_inicio',
        'apr.data_fim',
        'apr.versao',
        'apr.created_at',
      ])
      .orderBy('apr.created_at', 'DESC');
    if (companyId) qb.where('apr.company_id = :companyId', { companyId });
    qb.andWhere('apr.deleted_at IS NULL');
    if (!isSuperAdmin && siteScope !== 'all') {
      qb.andWhere('apr.site_id IN (:...siteIds)', { siteIds });
    }
    const aprs = await qb.getMany();

    const rows = aprs.map((a) => ({
      Número: a.numero,
      Título: a.titulo,
      Status: a.status,
      'Data Início': a.data_inicio
        ? new Date(a.data_inicio).toLocaleDateString('pt-BR')
        : '',
      'Data Fim': a.data_fim
        ? new Date(a.data_fim).toLocaleDateString('pt-BR')
        : '',
      Versão: a.versao ?? 1,
      'Criado em': new Date(a.created_at).toLocaleDateString('pt-BR'),
    }));

    return jsonToExcelBuffer(rows, 'APRs');
  }

  listActivityTemplates(): Array<{
    tipo_atividade: string;
    label: string;
    descricao: string;
  }> {
    return listAprActivityTemplateTypes();
  }

  async getCapabilities(): Promise<{ rulesEngine: boolean }> {
    const { companyId } = this.getTenantContextOrThrow();

    if (!this.aprFeatureFlagService) {
      return { rulesEngine: false };
    }

    try {
      return {
        rulesEngine: await this.aprFeatureFlagService.isEnabled(
          'APR_RULES_ENGINE',
          companyId,
        ),
      };
    } catch (error) {
      this.logger.warn(
        `Não foi possível consultar a capacidade APR_RULES_ENGINE para o tenant atual: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { rulesEngine: false };
    }
  }

  getActivityTemplate(tipoAtividade: string): AprActivityTemplate {
    const template = findAprActivityTemplate(tipoAtividade);
    if (!template) {
      throw new NotFoundException(
        `Template de atividade não encontrado: ${tipoAtividade}. Tipos disponíveis: ${APR_ACTIVITY_TEMPLATES.map((t) => t.tipo_atividade).join(', ')}`,
      );
    }
    return template;
  }

  async getRiskMatrix(siteId?: string): Promise<{
    matrix: { categoria: string; prob: number; sev: number; count: number }[];
  }> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    const qb = this.aprsRepository
      .createQueryBuilder('apr')
      .innerJoin('apr.risk_items', 'ri')
      .select('ri.categoria_risco', 'categoria')
      .addSelect('ri.probabilidade', 'prob')
      .addSelect('ri.severidade', 'sev')
      .addSelect('COUNT(*)', 'count')
      .where('ri.deleted_at IS NULL')
      .andWhere('ri.probabilidade IS NOT NULL')
      .andWhere('ri.severidade IS NOT NULL')
      .groupBy('ri.categoria_risco')
      .addGroupBy('ri.probabilidade')
      .addGroupBy('ri.severidade');

    if (companyId) qb.andWhere('apr.company_id = :companyId', { companyId });
    if (!isSuperAdmin && siteScope !== 'all') {
      qb.andWhere('apr.site_id IN (:...siteIds)', { siteIds });
    } else if (siteId) {
      qb.andWhere('apr.site_id = :siteId', { siteId });
    }

    const raw = await qb.getRawMany<{
      categoria: string;
      prob: string | number;
      sev: string | number;
      count: string | number;
    }>();
    return {
      matrix: raw.map((r) => ({
        categoria: r.categoria,
        prob: Number(r.prob),
        sev: Number(r.sev),
        count: Number(r.count),
      })),
    };
  }

  getControlSuggestions(payload: {
    probability?: number;
    severity?: number;
    exposure?: number;
    activity?: string;
    condition?: string;
  }) {
    const score = this.riskCalculationService.calculateScore(
      payload.probability,
      payload.severity,
      payload.exposure,
    );
    const riskLevel = this.riskCalculationService.classifyByScore(score);
    return {
      score,
      riskLevel,
      suggestions: this.riskCalculationService.suggestControls({
        riskLevel,
        activity: payload.activity,
        condition: payload.condition,
      }),
    };
  }
}
