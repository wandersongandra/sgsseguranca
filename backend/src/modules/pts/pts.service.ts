import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  FindManyOptions,
  FindOptionsWhere,
  In,
  IsNull,
  LessThan,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { jsonToExcelBuffer } from '../../shared/utils/excel.util';
import { escapeLikePattern } from '../../shared/utils/sql.util';
import {
  Pt,
  PtStatus,
  PT_ALLOWED_TRANSITIONS,
  PtEvidencePhoto,
  PtEvidencePhotoFase,
} from './entities/pt.entity';
import {
  cleanupUploadedFile,
  storageKeyFingerprint,
} from '../../shared/storage/storage-compensation.util';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import { CreatePtDto, PtAtmosphericReadingDto } from './dto/create-pt.dto';
import { UpdatePtDto } from './dto/update-pt.dto';
import { FinalizePtDto } from './dto/finalize-pt.dto';
import { LogPreApprovalReviewDto } from './dto/log-pre-approval-review.dto';
import { User } from '../users/entities/user.entity';
import { Company } from '../companies/entities/company.entity';
import { Site } from '../sites/entities/site.entity';
import { Apr } from '../aprs/entities/apr.entity';
import { RiskCalculationService } from '../../shared/services/risk-calculation.service';
import { AuditService } from '../audit-trail/audit.service';
import { AuditAction } from '../audit-trail/enums/audit-action.enum';
import { AuditLog } from '../audit-trail/entities/audit-log.entity';
import { RequestContext } from '../../shared/middleware/request-context.middleware';
import { WorkerOperationalStatusService } from '../users/worker-operational-status.service';
import { UpdatePtApprovalRulesDto } from './dto/update-pt-approval-rules.dto';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { DocumentBundleService } from '../../shared/services/document-bundle.service';
import {
  CursorPaginatedResponse,
  decodeCursorToken,
  toCursorPaginatedResponse,
} from '../../shared/utils/cursor-pagination.util';
import { WeeklyBundleFilters } from '../../shared/services/document-bundle.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { SignaturesService } from '../signatures/signatures.service';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';
import { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import { MetricsService } from '../../shared/observability/metrics.service';
import { Counter } from '@opentelemetry/api';

export const PTS_DOMAIN_METRICS = 'PTS_DOMAIN_METRICS';

// Throttle: evita UPDATE desnecessário quando múltiplas requests chegam simultaneamente.
// Valor em ms. Em produção com 2 instâncias cada uma tem seu próprio throttle
// — redundância intencional (ambas podem expirar, mas no máximo 1×/60s por instância).
const EXPIRE_REFRESH_THROTTLE_MS = 60_000;

import { GovernedPdfAccessAvailability } from '../../shared/dto/governed-pdf-access-response.dto';

type PreApprovalChecklist = Record<string, unknown>;
type PtPdfAccessAvailability = GovernedPdfAccessAvailability;
type PreApprovalReviewPayload = {
  stage?: string;
  readyForRelease?: boolean;
  blockers?: unknown;
  unansweredChecklistItems?: number;
  adverseChecklistItems?: number;
  pendingSignatures?: number;
  hasRapidRiskBlocker?: boolean;
  warnings?: unknown;
  checklist?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

// Coordenação de concorrência das transições de PT (espelha o módulo APR).
// FOR UPDATE NOWAIT falha imediatamente com 55P03 quando a linha já está
// travada; reprocessamos com backoff curto e, esgotadas as tentativas,
// devolvemos um 409 amigável em vez do erro cru do Postgres (500).
const POSTGRES_LOCK_NOT_AVAILABLE_CODE = '55P03';
const PT_ROW_LOCK_RETRY_DELAYS_MS = [50, 100, 200] as const;

const PT_FINAL_PDF_ALLOWED_STATUSES = new Set<PtStatus>([
  PtStatus.APROVADA,
  PtStatus.ENCERRADA,
  PtStatus.EXPIRADA,
]);

// Fotos 'durante'/'depois' acontecem após a aprovação — por isso evidências
// continuam mutáveis em Aprovada/Expirada. O PDF final é o congelamento único.
const PT_EVIDENCE_MUTABLE_STATUSES = new Set<PtStatus>([
  PtStatus.PENDENTE,
  PtStatus.APROVADA,
  PtStatus.EXPIRADA,
]);

const GOVERNED_PT_PHOTO_REF_PREFIX = 'gst:pt-photo:';
const GOVERNED_PT_CHECKLIST_ANEXO_REF_PREFIX = 'gst:pt-checklist-anexo:';

type GovernedPtFileReferencePayload = {
  v: 1;
  kind: 'governed-storage';
  scope: 'evidence' | 'checklist-anexo';
  fileKey: string;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  sizeBytes?: number;
};

export const PT_CHECKLIST_ATTACHMENT_FIELDS = [
  'trabalho_altura_checklist',
  'trabalho_eletrico_checklist',
  'trabalho_quente_checklist',
  'trabalho_espaco_confinado_checklist',
  'trabalho_escavacao_checklist',
] as const;

export type PtChecklistAttachmentField =
  (typeof PT_CHECKLIST_ATTACHMENT_FIELDS)[number];

const isPtChecklistAttachmentField = (
  value: string,
): value is PtChecklistAttachmentField =>
  (PT_CHECKLIST_ATTACHMENT_FIELDS as readonly string[]).includes(value);

@Injectable()
export class PtsService {
  private readonly logger = new Logger(PtsService.name);
  private readonly defaultApprovalRules = {
    blockCriticalRiskWithoutEvidence: true,
    blockWorkerWithoutValidMedicalExam: false,
    blockWorkerWithExpiredBlockingTraining: true,
    requireAtLeastOneExecutante: false,
    // Conformidade NR-33 — opt-in, default false para não quebrar fluxos atuais.
    blockConfinedSpaceWithoutAtmosphericReadings: false,
    blockConfinedSpaceWithoutWatch: false,
    blockConfinedSpaceWithoutRescuePlan: false,
    blockWithoutBeforeEvidence: false,
  };

  // Throttle map: companyId → timestamp do último refresh bem-sucedido
  private readonly expireRefreshThrottle = new Map<string, number>();

  constructor(
    @InjectRepository(Pt)
    private ptsRepository: Repository<Pt>,
    @InjectRepository(Company)
    private readonly companiesRepository: Repository<Company>,
    @InjectRepository(AuditLog)
    private readonly auditLogsRepository: Repository<AuditLog>,
    private tenantService: TenantService,
    private readonly riskCalculationService: RiskCalculationService,
    private readonly auditService: AuditService,
    private readonly workerOperationalStatusService: WorkerOperationalStatusService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly documentBundleService: DocumentBundleService,
    private readonly signaturesService: SignaturesService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
    private readonly forensicTrailService: ForensicTrailService,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional()
    @Inject(PTS_DOMAIN_METRICS)
    private readonly domainMetrics?: Record<string, Counter>,
  ) {}

  private assertPtDocumentMutable(pt: Pick<Pt, 'pdf_file_key'>) {
    if (pt.pdf_file_key) {
      throw new BadRequestException(
        'PT com PDF final anexado. Edição bloqueada. Gere uma nova PT para alterar o documento.',
      );
    }
  }

  /**
   * Detecta violação do índice único de número da PT (UQ_pts_company_numero)
   * — código 23505 do Postgres — para devolver um 409 amigável em vez do erro
   * cru (500). Cobre tanto reenvio simples do mesmo número quanto corrida.
   */
  private isDuplicatePtNumeroError(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driverError = error.driverError as
      { code?: string; constraint?: string } | undefined;
    return (
      driverError?.code === '23505' &&
      (driverError.constraint ?? '').includes('pts_company_numero')
    );
  }

  private assertPtEditableStatus(status: string) {
    if (status !== PtStatus.PENDENTE.toString()) {
      throw new BadRequestException(
        'Somente PTs pendentes podem ser editadas pelo formulário. Use os fluxos formais de aprovação, cancelamento e encerramento.',
      );
    }
  }

  private assertPtReadyForFinalPdf(pt: Pick<Pt, 'status' | 'pdf_file_key'>) {
    this.assertPtDocumentMutable(pt);

    if (!PT_FINAL_PDF_ALLOWED_STATUSES.has(pt.status as PtStatus)) {
      throw new BadRequestException(
        'A PT precisa estar aprovada, encerrada ou expirada antes do anexo do PDF final.',
      );
    }
  }

  private assertPtEvidenceMutable(pt: Pick<Pt, 'status' | 'pdf_file_key'>) {
    this.assertPtDocumentMutable(pt);

    if (!PT_EVIDENCE_MUTABLE_STATUSES.has(pt.status as PtStatus)) {
      throw new BadRequestException(
        'Evidências só podem ser alteradas enquanto a PT está pendente, aprovada ou expirada.',
      );
    }
  }

  private encodeBase64Url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  private decodeBase64Url(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf8');
  }

  private buildGovernedPtFileReference(
    payload: GovernedPtFileReferencePayload,
  ): string {
    const prefix =
      payload.scope === 'evidence'
        ? GOVERNED_PT_PHOTO_REF_PREFIX
        : GOVERNED_PT_CHECKLIST_ANEXO_REF_PREFIX;
    return `${prefix}${this.encodeBase64Url(JSON.stringify(payload))}`;
  }

  private parseGovernedPtFileReference(
    value: string | null | undefined,
    expectedScope: GovernedPtFileReferencePayload['scope'],
  ): GovernedPtFileReferencePayload | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    const prefix =
      expectedScope === 'evidence'
        ? GOVERNED_PT_PHOTO_REF_PREFIX
        : GOVERNED_PT_CHECKLIST_ANEXO_REF_PREFIX;
    if (!normalized || !normalized.startsWith(prefix)) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        this.decodeBase64Url(normalized.slice(prefix.length)),
      );
    } catch {
      throw new BadRequestException(
        'Referência de arquivo governado inválida.',
      );
    }

    const candidate = parsed as GovernedPtFileReferencePayload;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      candidate.v !== 1 ||
      candidate.kind !== 'governed-storage' ||
      candidate.scope !== expectedScope ||
      typeof candidate.fileKey !== 'string' ||
      typeof candidate.originalName !== 'string' ||
      typeof candidate.mimeType !== 'string' ||
      typeof candidate.uploadedAt !== 'string'
    ) {
      throw new BadRequestException(
        'Referência de arquivo governado inválida.',
      );
    }

    return candidate;
  }

  /**
   * Referências governadas de anexo são server-authoritative: o valor
   * persistido sempre vence o enviado pelo cliente (item casado por id) —
   * impede forjar `anexo_ref` apontando para arquivos de outros documentos.
   */
  private preservePersistedChecklistAnexoRefs(
    existing: Pt,
    incoming: Partial<Pick<Pt, PtChecklistAttachmentField>>,
  ): void {
    for (const field of PT_CHECKLIST_ATTACHMENT_FIELDS) {
      const incomingItems = incoming[field];
      if (!Array.isArray(incomingItems)) {
        continue;
      }
      const persistedByItemId = new Map(
        (existing[field] ?? []).map((item) => [item.id, item.anexo_ref]),
      );
      for (const item of incomingItems) {
        const persistedRef = persistedByItemId.get(item.id);
        if (persistedRef) {
          item.anexo_ref = persistedRef;
        } else {
          delete item.anexo_ref;
        }
      }
    }
  }

  /**
   * Gera o código de documento canônico da PT.
   *
   * IMPORTANTE: precisa produzir EXATAMENTE o mesmo código que o frontend
   * imprime no QR/PDF (`frontend/src/lib/pdf/ptGenerator.ts` + `buildDocumentCode`
   * em `frontend/src/lib/pdf-system/core/format.ts`). Caso contrário, o código do
   * QR não bate com o `document_code` do registry e o `/validar` retorna
   * "inválido" para uma PT legítima. Regra espelhada:
   *   - Se `pt.numero` está presente → usa o número cru (trimado) como código.
   *   - Senão → `PT-{ano}-{últimos 8 alfanuméricos de id||titulo, uppercase}`.
   */
  private buildPtDocumentCode(
    pt: Pick<
      Pt,
      'id' | 'numero' | 'titulo' | 'data_hora_inicio' | 'created_at'
    >,
  ): string {
    const numero = String(pt.numero ?? '').trim();
    if (numero) {
      return numero;
    }

    const candidateDate = pt.data_hora_inicio
      ? new Date(pt.data_hora_inicio)
      : pt.created_at
        ? new Date(pt.created_at)
        : new Date();
    const year = Number.isNaN(candidateDate.getTime())
      ? new Date().getFullYear()
      : candidateDate.getFullYear();
    const reference = String(pt.id || pt.titulo || 'PT')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-8)
      .toUpperCase();

    return `PT-${year}-${reference || String(Date.now()).slice(-6)}`;
  }

  private isMissingFinalPdfMetadataColumnsError(error: unknown): boolean {
    if (error instanceof QueryFailedError) {
      const driverError = (
        error as QueryFailedError & { driverError?: unknown }
      ).driverError as
        | {
            code?: string;
            column?: string;
            message?: string;
            detail?: string;
          }
        | undefined;
      const normalized = [
        driverError?.column,
        driverError?.message,
        driverError?.detail,
        error.message,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      if (driverError?.code === '42703') {
        return (
          normalized.includes('final_pdf_hash_sha256') ||
          normalized.includes('pdf_generated_at')
        );
      }
    }

    const message =
      error instanceof Error
        ? error.message.toLowerCase()
        : typeof error === 'string'
          ? error.toLowerCase()
          : '';

    return (
      message.includes('does not exist') &&
      (message.includes('final_pdf_hash_sha256') ||
        message.includes('pdf_generated_at'))
    );
  }

  private async persistFinalPdfMetadata(
    manager: EntityManager,
    pt: Pick<Pt, 'id' | 'company_id'>,
    file: { key: string; folderPath: string; originalName: string },
    hash: string,
  ): Promise<void> {
    const repository = manager.getRepository(Pt);
    const fallbackUpdate = {
      pdf_file_key: file.key,
      pdf_folder_path: file.folderPath,
      pdf_original_name: file.originalName,
    };

    try {
      await repository.update(pt.id, {
        ...fallbackUpdate,
        // Mantém o hash de integridade e o timestamp quando a base já está
        // migrada. Em produção antiga, degradamos para os metadados mínimos.
        final_pdf_hash_sha256: hash,
        pdf_generated_at: new Date(),
      });
    } catch (error) {
      if (!this.isMissingFinalPdfMetadataColumnsError(error)) {
        throw error;
      }

      this.logger.warn({
        event: 'pt_final_pdf_metadata_columns_missing',
        ptId: pt.id,
        companyId: pt.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      await repository.update(pt.id, fallbackUpdate);
    }
  }

  private resolveStatusForGenericCreate(
    requestedStatus?: string | null,
  ): PtStatus {
    if (!requestedStatus || requestedStatus === PtStatus.PENDENTE.toString()) {
      return PtStatus.PENDENTE;
    }

    throw new BadRequestException(
      'O status da PT é controlado pelos fluxos formais de aprovação e cancelamento.',
    );
  }

  private resolveStatusForGenericUpdate(
    currentStatus: string,
    requestedStatus?: string | null,
  ): string {
    if (!requestedStatus || requestedStatus === currentStatus) {
      return currentStatus;
    }

    throw new BadRequestException(
      'O status da PT é controlado pelos fluxos formais de aprovação e cancelamento.',
    );
  }

  private async assertCompanyScopedEntityId<
    T extends { id: string; company_id: string },
  >(
    entity: { new (): T },
    companyId: string,
    id: string | null | undefined,
    label: string,
  ): Promise<void> {
    if (!id) {
      return;
    }

    const exists = await this.ptsRepository.manager
      .getRepository(entity)
      .exist({
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
    entity: { new (): T },
    companyId: string,
    ids: string[] | undefined,
    label: string,
  ): Promise<void> {
    const uniqueIds = Array.from(
      new Set(
        (ids || []).filter((id): id is string =>
          Boolean(String(id || '').trim()),
        ),
      ),
    );

    if (uniqueIds.length === 0) {
      return;
    }

    const count = await this.ptsRepository.manager.getRepository(entity).count({
      where: { id: In(uniqueIds), company_id: companyId } as never,
    });

    if (count !== uniqueIds.length) {
      throw new BadRequestException(
        `${label} contém vínculo(s) inválido(s) para a empresa/tenant atual.`,
      );
    }
  }

  private async assertUsersScopedToSite(
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

    const count = await this.ptsRepository.manager.getRepository(User).count({
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
    companyId: string;
    siteId?: string | null;
    aprId?: string | null;
    responsavelId?: string | null;
    auditadoPorId?: string | null;
    executantes?: string[];
    vigiaUserId?: string | null;
  }): Promise<void> {
    await Promise.all([
      this.assertCompanyScopedEntityId(
        Site,
        input.companyId,
        input.siteId,
        'Site',
      ),
      this.assertCompanyScopedEntityId(
        Apr,
        input.companyId,
        input.aprId,
        'APR vinculada',
      ),
      this.assertCompanyScopedEntityId(
        User,
        input.companyId,
        input.responsavelId,
        'Responsável',
      ),
      this.assertCompanyScopedEntityId(
        User,
        input.companyId,
        input.auditadoPorId,
        'Auditado por',
      ),
      this.assertCompanyScopedEntityIds(
        User,
        input.companyId,
        input.executantes,
        'Executantes',
      ),
      // Valida vigia designado contra o tenant — impede cross-tenant (SGS-PT-SEC-007).
      this.assertCompanyScopedEntityId(
        User,
        input.companyId,
        input.vigiaUserId,
        'Vigia designado',
      ),
    ]);

    await this.assertUsersScopedToSite(
      input.companyId,
      input.siteId,
      [input.responsavelId, input.auditadoPorId, ...(input.executantes ?? [])],
      'Usuários da PT',
    );
  }

  private async refreshExpiredStatuses(companyId?: string): Promise<void> {
    const { siteIds, siteScope, isSuperAdmin } = this.getTenantContextOrThrow();
    // Throttle key inclui escopo de obra para evitar que uma requisição de obra A
    // impeça a expiração de obra B dentro da mesma empresa (SGS-PT-CON-009).
    const throttleKey = [
      companyId ?? '*',
      ...(!isSuperAdmin && siteScope !== 'all' ? siteIds : []),
    ].join(':');
    const lastRun = this.expireRefreshThrottle.get(throttleKey) ?? 0;

    if (Date.now() - lastRun < EXPIRE_REFRESH_THROTTLE_MS) {
      return; // Executado recentemente — pular para reduzir carga no banco
    }

    // Marcar antes de executar para que requests concorrentes não disparem em paralelo
    this.expireRefreshThrottle.set(throttleKey, Date.now());

    const where: FindOptionsWhere<Pt> = {
      status: PtStatus.APROVADA,
      data_hora_fim: LessThan(new Date()),
      deleted_at: IsNull(),
      ...(companyId ? { company_id: companyId } : {}),
      ...(!isSuperAdmin && siteScope !== 'all' ? { site_id: In(siteIds) } : {}),
    };

    const result = await this.ptsRepository.update(where, {
      status: PtStatus.EXPIRADA,
    });

    if ((result.affected ?? 0) > 0) {
      this.logger.log({
        event: 'pt_auto_expired',
        companyId: companyId || null,
        affected: result.affected ?? 0,
      });
    }
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
      'PT',
    );

    return {
      companyId: scope.companyId,
      siteId: scope.siteId,
      siteIds: scope.siteIds,
      siteScope: scope.siteScope,
      isSuperAdmin: scope.isSuperAdmin,
    };
  }

  private async getAllowedPtIdsForCurrentScope(): Promise<Set<string> | null> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();

    if (isSuperAdmin || siteScope === 'all') {
      return null;
    }

    // Teto de segurança: lista de IDs permitidos usada só como allow-list em
    // memória para filtrar documentos (document_registry não tem site_id).
    // Não deveria ser atingido na prática — mesma técnica de
    // ProfilesService.findAll / findAllForExport.
    const scopedPts = await this.ptsRepository.find({
      select: ['id'],
      where: {
        company_id: companyId,
        site_id: In(siteIds),
        deleted_at: IsNull(),
      },
      take: 50000,
    });

    return new Set(scopedPts.map((pt) => pt.id));
  }

  async create(createPtDto: CreatePtDto): Promise<Pt> {
    const { executantes, status, ...rest } = createPtDto;
    // PT recém-criada não pode ter anexos governados — descarta qualquer ref do cliente.
    for (const field of PT_CHECKLIST_ATTACHMENT_FIELDS) {
      rest[field]?.forEach((item) => delete item.anexo_ref);
    }
    if (new Date(rest.data_hora_fim) <= new Date(rest.data_hora_inicio)) {
      throw new BadRequestException(
        'A data/hora de término deve ser posterior à data/hora de início.',
      );
    }
    const { companyId, siteId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    const effectiveSiteId =
      !isSuperAdmin && siteScope !== 'all' ? siteId : createPtDto.site_id;

    if (
      !isSuperAdmin &&
      siteScope !== 'all' &&
      !siteIds.includes(createPtDto.site_id)
    ) {
      throw new BadRequestException(
        'PT deve ser criada na obra atual do tenant.',
      );
    }

    await this.validateRelatedEntityScope({
      companyId,
      siteId: effectiveSiteId,
      aprId: createPtDto.apr_id ?? null,
      responsavelId: createPtDto.responsavel_id,
      auditadoPorId: createPtDto.auditado_por_id ?? null,
      executantes,
      vigiaUserId: createPtDto.vigia_user_id ?? null,
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

    const pt = this.ptsRepository.create({
      ...rest,
      status: this.resolveStatusForGenericCreate(status),
      initial_risk: initialRisk,
      residual_risk: residualRisk,
      control_evidence: Boolean(rest.control_evidence),
      company_id: companyId,
      site_id: effectiveSiteId,
      executantes: executantes?.map((id) => ({ id }) as unknown as User),
    });

    let saved: Pt;
    try {
      saved = await this.ptsRepository.save(pt);
    } catch (error) {
      if (this.isDuplicatePtNumeroError(error)) {
        throw new ConflictException(
          `Já existe uma PT com o número "${createPtDto.numero}" nesta empresa.`,
        );
      }
      throw error;
    }
    await this.logAudit({
      action: AuditAction.CREATE,
      entityId: saved.id,
      after: saved,
    });
    this.logger.log({
      event: 'pt_created',
      ptId: saved.id,
      companyId: saved.company_id,
    });
    try {
      this.domainMetrics?.pts_created?.add(1, {
        company_id: saved.company_id,
      });
    } catch (error) {
      this.logger.warn(
        `[PTS] Falha ao registrar pts_created no domínio: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.metricsService?.incrementPtCreated(saved.company_id);
    }
    return saved;
  }

  async findAll(opts?: {
    page?: number;
    limit?: number;
  }): Promise<OffsetPage<Pt>> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    this.refreshExpiredStatuses(companyId).catch((err: unknown) =>
      this.logger.warn({
        event: 'pt_expire_refresh_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    // maxLimit: 1000 — limite de segurança para evitar OOM (5 JOINs em findOne)
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 1000,
    });

    const qb = this.ptsRepository
      .createQueryBuilder('pt')
      .select([
        'pt.id',
        'pt.numero',
        'pt.titulo',
        'pt.descricao',
        'pt.data_hora_inicio',
        'pt.data_hora_fim',
        'pt.status',
        'pt.company_id',
        'pt.site_id',
        'pt.apr_id',
        'pt.responsavel_id',
        'pt.pdf_file_key',
        'pt.created_at',
        'pt.updated_at',
      ])
      .where('pt.deleted_at IS NULL')
      .orderBy('pt.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    if (companyId) {
      qb.andWhere('pt.company_id = :companyId', { companyId });
    }
    if (!isSuperAdmin && siteScope !== 'all') {
      qb.andWhere('pt.site_id IN (:...siteIds)', { siteIds });
    }

    const [data, total] = await qb.getManyAndCount();
    return toOffsetPage(data, total, page, limit);
  }

  // Carrega todos os registros para uso interno (exportações, relatórios).
  // Sem relações; apenas campos essenciais; take: 5000 como teto de segurança.
  async findAllForExport(): Promise<Pt[]> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    this.refreshExpiredStatuses(companyId).catch((err: unknown) =>
      this.logger.warn({
        event: 'pt_expire_refresh_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    const qb = this.ptsRepository
      .createQueryBuilder('pt')
      .select([
        'pt.id',
        'pt.numero',
        'pt.titulo',
        'pt.status',
        'pt.data_hora_inicio',
        'pt.data_hora_fim',
        'pt.company_id',
        'pt.created_at',
      ])
      .where('pt.deleted_at IS NULL')
      .orderBy('pt.created_at', 'DESC')
      .take(5000);

    if (companyId) {
      qb.andWhere('pt.company_id = :companyId', { companyId });
    }
    if (!isSuperAdmin && siteScope !== 'all') {
      qb.andWhere('pt.site_id IN (:...siteIds)', { siteIds });
    }

    return qb.getMany();
  }

  async findPaginated(opts?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }): Promise<OffsetPage<Pt>> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    this.refreshExpiredStatuses(companyId).catch((err: unknown) =>
      this.logger.warn({
        event: 'pt_expire_refresh_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const qb = this.ptsRepository
      .createQueryBuilder('pt')
      .select([
        'pt.id',
        'pt.numero',
        'pt.titulo',
        'pt.descricao',
        'pt.data_hora_inicio',
        'pt.data_hora_fim',
        'pt.status',
        'pt.company_id',
        'pt.site_id',
        'pt.apr_id',
        'pt.responsavel_id',
        'pt.pdf_file_key',
        'pt.created_at',
        'pt.updated_at',
      ])
      .orderBy('pt.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    qb.where('pt.deleted_at IS NULL');

    if (companyId) {
      qb.andWhere('pt.company_id = :companyId', { companyId });
    }
    if (!isSuperAdmin && siteScope !== 'all') {
      qb.andWhere('pt.site_id IN (:...siteIds)', { siteIds });
    }
    if (opts?.search) {
      qb.andWhere('(pt.titulo ILIKE :search OR pt.numero ILIKE :search)', {
        search: `%${escapeLikePattern(opts.search)}%`,
      });
    }
    if (opts?.status) {
      qb.andWhere('pt.status = :status', { status: opts.status });
    }

    const [data, total] = await qb.getManyAndCount();
    return toOffsetPage(data, total, page, limit);
  }

  async findByCursor(opts?: {
    cursor?: string;
    limit?: number;
    search?: string;
    status?: string;
  }): Promise<CursorPaginatedResponse<Pt>> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    this.refreshExpiredStatuses(companyId).catch((err: unknown) =>
      this.logger.warn({
        event: 'pt_expire_refresh_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    const { limit } = normalizeOffsetPagination(
      { page: 1, limit: opts?.limit },
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );
    const decodedCursor = decodeCursorToken(opts?.cursor);
    if (opts?.cursor && !decodedCursor) {
      throw new BadRequestException('Cursor inválido para listagem de PT.');
    }

    const qb = this.ptsRepository
      .createQueryBuilder('pt')
      .select([
        'pt.id',
        'pt.numero',
        'pt.titulo',
        'pt.descricao',
        'pt.data_hora_inicio',
        'pt.data_hora_fim',
        'pt.status',
        'pt.company_id',
        'pt.site_id',
        'pt.apr_id',
        'pt.responsavel_id',
        'pt.pdf_file_key',
        'pt.created_at',
        'pt.updated_at',
      ])
      .where('pt.deleted_at IS NULL')
      .orderBy('pt.created_at', 'DESC')
      .addOrderBy('pt.id', 'DESC')
      .take(limit + 1);

    if (companyId) {
      qb.andWhere('pt.company_id = :companyId', { companyId });
    }
    if (!isSuperAdmin && siteScope !== 'all') {
      qb.andWhere('pt.site_id IN (:...siteIds)', { siteIds });
    }

    if (opts?.search) {
      qb.andWhere('(pt.titulo ILIKE :search OR pt.numero ILIKE :search)', {
        search: `%${escapeLikePattern(opts.search)}%`,
      });
    }

    if (opts?.status) {
      qb.andWhere('pt.status = :status', { status: opts.status });
    }

    if (decodedCursor) {
      qb.andWhere(
        '(pt.created_at < :cursorCreatedAt OR (pt.created_at = :cursorCreatedAt AND pt.id < :cursorId))',
        {
          cursorCreatedAt: decodedCursor.created_at,
          cursorId: decodedCursor.id,
        },
      );
    }

    const rows = await qb.getMany();
    return toCursorPaginatedResponse({
      rows,
      limit,
      getCreatedAt: (row) => row.created_at,
    });
  }

  async findOne(id: string): Promise<Pt> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    this.refreshExpiredStatuses(companyId).catch((err: unknown) =>
      this.logger.warn({
        event: 'pt_expire_refresh_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    const pt = await this.ptsRepository.findOne({
      where: { id, company_id: companyId },
      relations: [
        'site',
        'apr',
        'responsavel',
        'executantes',
        'auditado_por',
        'vigia',
        'encerrado_por',
      ],
    });
    if (!pt) {
      throw new NotFoundException(`PT com ID ${id} não encontrada`);
    }
    if (!isSuperAdmin && siteScope !== 'all' && !siteIds.includes(pt.site_id)) {
      throw new NotFoundException(`PT com ID ${id} não encontrada`);
    }
    return pt;
  }

  async update(id: string, updatePtDto: UpdatePtDto): Promise<Pt> {
    const pt = await this.findOne(id);
    this.assertPtEditableStatus(pt.status);
    this.assertPtDocumentMutable(pt);
    const { executantes, status, ...rest } = updatePtDto;
    this.preservePersistedChecklistAnexoRefs(pt, rest);

    // SGS-PT-SEC-004: mirror the site-scope guard from create() — the RLS
    // WITH CHECK would also reject the write, but as a 500 (Postgres error)
    // instead of the expected 400 with an actionable message.
    if (rest.site_id !== undefined && rest.site_id !== pt.site_id) {
      const { siteIds, siteScope, isSuperAdmin } =
        this.getTenantContextOrThrow();
      if (
        !isSuperAdmin &&
        siteScope !== 'all' &&
        !siteIds.includes(rest.site_id)
      ) {
        throw new BadRequestException(
          'PT deve permanecer na obra atual do tenant. A obra só pode ser alterada por um administrador com acesso global.',
        );
      }
    }

    const effectiveInicio = rest.data_hora_inicio ?? pt.data_hora_inicio;
    const effectiveFim = rest.data_hora_fim ?? pt.data_hora_fim;
    if (
      effectiveFim &&
      effectiveInicio &&
      new Date(effectiveFim) <= new Date(effectiveInicio)
    ) {
      throw new BadRequestException(
        'A data/hora de término deve ser posterior à data/hora de início.',
      );
    }
    const before = { ...pt };

    await this.validateRelatedEntityScope({
      companyId: pt.company_id,
      siteId: rest.site_id ?? pt.site_id,
      aprId: rest.apr_id !== undefined ? rest.apr_id : pt.apr_id,
      responsavelId: rest.responsavel_id ?? pt.responsavel_id,
      auditadoPorId:
        rest.auditado_por_id !== undefined
          ? rest.auditado_por_id
          : pt.auditado_por_id,
      executantes:
        executantes ??
        (Array.isArray(pt.executantes)
          ? pt.executantes.map((executante) => executante.id)
          : []),
      vigiaUserId:
        rest.vigia_user_id !== undefined
          ? rest.vigia_user_id
          : pt.vigia_user_id,
    });

    const initialRisk = this.riskCalculationService.calculateScore(
      rest.probability ?? pt.probability,
      rest.severity ?? pt.severity,
      rest.exposure ?? pt.exposure,
    );
    const residualRisk =
      rest.residual_risk ||
      this.riskCalculationService.classifyByScore(initialRisk) ||
      pt.residual_risk ||
      null;

    Object.assign(pt, {
      ...rest,
      status: this.resolveStatusForGenericUpdate(pt.status, status),
      initial_risk: initialRisk,
      residual_risk: residualRisk,
      control_evidence:
        rest.control_evidence !== undefined
          ? Boolean(rest.control_evidence)
          : Boolean(pt.control_evidence),
    });

    if (executantes) {
      pt.executantes = executantes.map((id) => ({ id }) as unknown as User);
    }

    const saved = await this.ptsRepository.save(pt);
    await this.logAudit({
      action: AuditAction.UPDATE,
      entityId: saved.id,
      before,
      after: saved,
    });
    this.logger.log({
      event: 'pt_updated',
      ptId: saved.id,
      companyId: saved.company_id,
    });
    return saved;
  }

  async attachPdf(
    id: string,
    file: Express.Multer.File,
    userId?: string,
  ): Promise<{ fileKey: string; folderPath: string; originalName: string }> {
    const pt = await this.findOne(id);
    this.assertPtReadyForFinalPdf(pt);
    if (!pt.site_id) {
      throw new BadRequestException(
        'PT sem obra/setor vinculado não pode receber PDF final.',
      );
    }

    const key = this.documentStorageService.generateDocumentKey(
      pt.company_id,
      'pts',
      id,
      file.originalname,
      { folderSegments: ['sites', pt.site_id] },
    );
    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          key,
          { resourceType: 'pt', resourceId: pt.id },
          'p1-document-storage-uploadFile',
        ),
        file.buffer,
        file.mimetype,
      );
    const uploadedToStorage = true;

    const folder = key.split('/').slice(0, -1).join('/');
    try {
      await this.documentGovernanceService.registerFinalDocument({
        companyId: pt.company_id,
        module: 'pt',
        entityId: pt.id,
        title: pt.titulo || pt.numero || 'PT',
        documentDate: pt.data_hora_inicio || pt.created_at,
        documentCode: this.buildPtDocumentCode(pt),
        fileKey: key,
        folderPath: folder,
        originalName: file.originalname,
        mimeType: file.mimetype,
        createdBy: userId || RequestContext.getUserId() || undefined,
        fileBuffer: file.buffer,
        persistEntityMetadata: async (manager, hash) => {
          await this.persistFinalPdfMetadata(
            manager,
            pt,
            {
              key,
              folderPath: folder,
              originalName: file.originalname,
            },
            hash,
          );
        },
      });
    } catch (error) {
      if (uploadedToStorage) {
        await cleanupUploadedFile(this.logger, `pt:${pt.id}`, key, (fileKey) =>
          uploadedReference.key === fileKey
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
        );
      }
      throw error;
    }
    this.logger.log({
      event: 'pt_pdf_anexado',
      ptId: id,
      userId,
      keyFingerprint: storageKeyFingerprint(key),
    });

    return {
      fileKey: key,
      folderPath: folder,
      originalName: file.originalname,
    };
  }

  async getPdfAccess(id: string): Promise<{
    entityId: string;
    hasFinalPdf: boolean;
    availability: PtPdfAccessAvailability;
    message: string;
    fileKey: string | null;
    folderPath: string | null;
    originalName: string | null;
    url: string | null;
  }> {
    const pt = await this.findOne(id);
    if (!pt.pdf_file_key) {
      return {
        entityId: pt.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message: 'A PT ainda não possui PDF final emitido.',
        fileKey: null,
        folderPath: null,
        originalName: null,
        url: null,
      };
    }

    let url: string | null;
    let availability: PtPdfAccessAvailability = 'ready';
    try {
      url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          pt.pdf_file_key,
          {
            resourceType: 'pt',
            resourceId: pt.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
        3600,
      );
    } catch {
      url = null;
      availability = 'registered_without_signed_url';
    }

    return {
      entityId: pt.id,
      hasFinalPdf: true,
      availability,
      message:
        availability === 'ready'
          ? 'PDF final disponível.'
          : 'PDF final registrado, mas a URL segura não está disponível no momento.',
      fileKey: pt.pdf_file_key,
      folderPath: pt.pdf_folder_path,
      originalName: pt.pdf_original_name,
      url,
    };
  }

  /**
   * Contexto de validação pública da PT (espelha DdsService.getValidationContext):
   * retorna o código documental canônico, o hash de integridade do PDF final (se
   * já emitido) e um token de grant assinado on-demand para o portal público.
   * O frontend consome isto ao gerar o PDF para embutir o hash e o QR com token,
   * tornando a validação em `/validar` séria (autenticidade + tamper-evidence).
   */
  async getValidationContext(id: string): Promise<{
    documentCode: string;
    finalPdfHash: string | null;
    token: string | null;
  }> {
    const pt = await this.findOne(id);
    const documentCode = this.buildPtDocumentCode(pt);
    let token: string | null = null;

    try {
      token = await this.publicValidationGrantService.issueToken({
        code: documentCode,
        companyId: pt.company_id,
        portal: 'pt_public_validation',
        documentId: pt.id,
      });
    } catch (error) {
      this.logger.warn({
        event: 'pt_validation_token_unavailable',
        ptId: pt.id,
        companyId: pt.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      documentCode,
      finalPdfHash: pt.final_pdf_hash_sha256 ?? null,
      token,
    };
  }

  /**
   * Executa uma transição de status da PT de forma atômica com SELECT FOR UPDATE.
   * Previne race conditions quando múltiplos usuários tentam alterar o status
   * simultaneamente — o segundo request recebe ConflictException imediatamente.
   */
  private async executePtWorkflowTransition(
    id: string,
    fn: (pt: Pt, manager: EntityManager) => Promise<Pt>,
  ): Promise<Pt> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();

    const scoped = !isSuperAdmin && siteScope !== 'all';
    const siteClause = scoped ? ' AND "site_id" = ANY($3::uuid[])' : '';
    const params = scoped ? [id, companyId, siteIds] : [id, companyId];

    for (
      let attempt = 0;
      attempt <= PT_ROW_LOCK_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        return await this.ptsRepository.manager.transaction(async (manager) => {
          const rows = await manager.query<Pt[]>(
            `SELECT * FROM "pts" WHERE "id" = $1 AND "company_id" = $2 AND "deleted_at" IS NULL${siteClause} FOR UPDATE NOWAIT`,
            params,
          );

          if (!rows || rows.length === 0) {
            throw new NotFoundException(`PT com ID ${id} não encontrada`);
          }

          const pt = manager.getRepository(Pt).create(rows[0]);
          return fn(pt, manager);
        });
      } catch (error: unknown) {
        if (!this.isPostgresLockNotAvailableError(error)) {
          throw error;
        }
        const retryDelayMs = PT_ROW_LOCK_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined) {
          throw new ConflictException(
            'Outra operação está em andamento para esta PT. Tente novamente em instantes.',
          );
        }
        await this.waitForRetry(retryDelayMs);
      }
    }

    throw new ConflictException(
      'Outra operação está em andamento para esta PT. Tente novamente em instantes.',
    );
  }

  private isPostgresLockNotAvailableError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === POSTGRES_LOCK_NOT_AVAILABLE_CODE
    );
  }

  private waitForRetry(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  async approve(
    id: string,
    approvedByUserId: string,
    reason?: string,
  ): Promise<Pt> {
    const before = await this.findOne(id);
    const saved = await this.executePtWorkflowTransition(
      id,
      async (pt, manager) => {
        this.assertPtDocumentMutable(pt);
        const allowed = PT_ALLOWED_TRANSITIONS[pt.status as PtStatus];
        if (!allowed?.includes(PtStatus.APROVADA)) {
          throw new BadRequestException(
            `Transição inválida: ${pt.status} → Aprovada. Permitidas: ${allowed?.join(', ') || 'nenhuma'}`,
          );
        }
        // SGS-PT-SM-006: reject approval of a PT whose validity window has
        // already closed — refreshExpiredStatuses only acts on already-APROVADA
        // PTs, so PENDENTE PTs with past data_hora_fim remain approval-eligible
        // indefinitely without this guard.
        if (pt.data_hora_fim && new Date(pt.data_hora_fim) <= new Date()) {
          throw new BadRequestException(
            'PT com janela de validade encerrada não pode ser aprovada. Emita uma nova PT.',
          );
        }
        await this.assertCanApprove(pt, pt.company_id);
        pt.status = PtStatus.APROVADA;
        pt.aprovado_por_id = approvedByUserId;
        pt.aprovado_em = new Date();
        pt.aprovado_motivo = reason || undefined;
        pt.reprovado_por_id = null;
        pt.reprovado_em = undefined;
        pt.reprovado_motivo = undefined;
        return manager.getRepository(Pt).save(pt);
      },
    );
    await this.logAudit({
      action: AuditAction.UPDATE,
      entityId: saved.id,
      before,
      after: saved,
      fallbackUserId: approvedByUserId,
    });
    this.logger.log({
      event: 'pt_approved',
      ptId: saved.id,
      companyId: saved.company_id,
      userId: approvedByUserId,
    });
    return saved;
  }

  async reject(
    id: string,
    rejectedByUserId: string,
    reason: string,
  ): Promise<Pt> {
    const before = await this.findOne(id);
    const saved = await this.executePtWorkflowTransition(
      id,
      async (pt, manager) => {
        this.assertPtDocumentMutable(pt);
        const allowed = PT_ALLOWED_TRANSITIONS[pt.status as PtStatus];
        if (!allowed?.includes(PtStatus.CANCELADA)) {
          throw new BadRequestException(
            `Transição inválida: ${pt.status} → Cancelada. Permitidas: ${allowed?.join(', ') || 'nenhuma'}`,
          );
        }
        const previousStatus = pt.status;
        pt.status = PtStatus.CANCELADA;
        pt.reprovado_por_id = rejectedByUserId;
        pt.reprovado_em = new Date();
        pt.reprovado_motivo = reason;
        const persisted = await manager.getRepository(Pt).save(pt);
        await this.forensicTrailService.append(
          {
            eventType: FORENSIC_EVENT_TYPES.DOCUMENT_CANCELED,
            module: 'pt',
            entityId: persisted.id,
            companyId: persisted.company_id,
            userId: rejectedByUserId,
            metadata: {
              previousStatus,
              currentStatus: persisted.status,
              reason,
            },
          },
          { manager },
        );
        return persisted;
      },
    );
    await this.logAudit({
      action: AuditAction.UPDATE,
      entityId: saved.id,
      before,
      after: saved,
      fallbackUserId: rejectedByUserId,
    });
    this.logger.log({
      event: 'pt_rejected',
      ptId: saved.id,
      companyId: saved.company_id,
      userId: rejectedByUserId,
    });
    return saved;
  }

  async finalize(
    id: string,
    finalizedByUserId: string,
    closure: FinalizePtDto,
  ): Promise<Pt> {
    const before = await this.findOne(id);
    const saved = await this.executePtWorkflowTransition(
      id,
      async (pt, manager) => {
        const allowed = PT_ALLOWED_TRANSITIONS[pt.status as PtStatus];
        if (!allowed?.includes(PtStatus.ENCERRADA)) {
          throw new BadRequestException(
            `Transição inválida: ${pt.status} → Encerrada. Permitidas: ${allowed?.join(', ') || 'nenhuma'}`,
          );
        }
        // PDF final congelado não refletirá dados de encerramento — impedir (SGS-PT-INT-014).
        this.assertPtDocumentMutable(pt);

        const realFim = closure.data_hora_real_fim
          ? new Date(closure.data_hora_real_fim)
          : new Date();
        if (Number.isNaN(realFim.getTime())) {
          throw new BadRequestException('Data/hora real de término inválida.');
        }
        if (pt.data_hora_inicio && realFim < new Date(pt.data_hora_inicio)) {
          throw new BadRequestException(
            'A data/hora real de término não pode ser anterior ao início da PT.',
          );
        }

        pt.status = PtStatus.ENCERRADA;
        pt.encerrado_por_id = finalizedByUserId;
        pt.data_hora_real_fim = realFim;
        pt.condicao_area_encerramento = closure.condicao_area;
        pt.observacoes_encerramento = closure.observacoes?.trim() || null;
        return manager.getRepository(Pt).save(pt);
      },
    );
    await this.logAudit({
      action: AuditAction.UPDATE,
      entityId: saved.id,
      before,
      after: saved,
      fallbackUserId: finalizedByUserId,
    });
    this.logger.log({
      event: 'pt_finalized',
      ptId: saved.id,
      companyId: saved.company_id,
      userId: finalizedByUserId,
      condicaoArea: saved.condicao_area_encerramento,
    });
    return saved;
  }

  async attachEvidencePhoto(
    id: string,
    buffer: Buffer,
    originalName: string,
    mimeType: string,
    meta: { fase: PtEvidencePhotoFase; legenda?: string },
    userId?: string,
  ): Promise<{
    entityId: string;
    photoIndex: number;
    storageMode: 'governed-storage';
    photoReference: string;
    fase: PtEvidencePhotoFase;
    legenda?: string;
    photo: { originalName: string; mimeType: string };
  }> {
    const pt = await this.findOne(id);
    this.assertPtEvidenceMutable(pt);

    const fileKey = this.documentStorageService.generateDocumentKey(
      pt.company_id,
      'pt-photos',
      pt.id,
      originalName,
      { folderSegments: ['sites', pt.site_id] },
    );
    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          fileKey,
          { resourceType: 'pt-photo', resourceId: pt.id },
          'p1-document-storage-uploadFile',
        ),
        buffer,
        mimeType,
      );

    const photoReference = this.buildGovernedPtFileReference({
      v: 1,
      kind: 'governed-storage',
      scope: 'evidence',
      fileKey,
      originalName,
      mimeType,
      uploadedAt: new Date().toISOString(),
      sizeBytes: buffer.byteLength,
    });

    const photo: PtEvidencePhoto = {
      ref: photoReference,
      legenda: meta.legenda?.trim() || undefined,
      fase: meta.fase,
      uploaded_by_id: userId || RequestContext.getUserId() || undefined,
      uploaded_at: new Date().toISOString(),
    };

    let saved: Pt;
    try {
      saved = await this.executePtWorkflowTransition(
        id,
        async (lockedPt, manager) => {
          this.assertPtEvidenceMutable(lockedPt);
          lockedPt.fotos_evidencia = [
            ...(lockedPt.fotos_evidencia ?? []),
            photo,
          ];
          return manager.getRepository(Pt).save(lockedPt);
        },
      );
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `pt-photo:${pt.id}`,
        fileKey,
        (key) =>
          uploadedReference.key === key
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      throw error;
    }

    await this.logAudit({
      action: AuditAction.UPDATE,
      entityId: saved.id,
      after: { fotos_evidencia: saved.fotos_evidencia },
      fallbackUserId: userId,
    });
    this.logger.log({
      event: 'pt_evidence_photo_uploaded',
      ptId: saved.id,
      companyId: saved.company_id,
      fase: meta.fase,
      userId,
    });

    return {
      entityId: saved.id,
      photoIndex: (saved.fotos_evidencia?.length ?? 1) - 1,
      storageMode: 'governed-storage',
      photoReference,
      fase: photo.fase,
      legenda: photo.legenda,
      photo: { originalName, mimeType },
    };
  }

  async getEvidencePhotoAccess(
    id: string,
    photoIndex: number,
  ): Promise<{
    entityId: string;
    photoIndex: number;
    fase: PtEvidencePhotoFase;
    legenda?: string;
    originalName: string;
    mimeType: string;
    url: string | null;
    degraded: boolean;
  }> {
    const pt = await this.findOne(id);
    const photo = pt.fotos_evidencia?.[photoIndex];
    if (!photo) {
      throw new NotFoundException('Foto de evidência não encontrada.');
    }

    const payload = this.parseGovernedPtFileReference(photo.ref, 'evidence');
    if (!payload) {
      throw new NotFoundException('Foto de evidência não encontrada.');
    }

    let url: string | null;
    try {
      url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          payload.fileKey,
          {
            resourceType: 'pt-photo',
            resourceId: pt.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
        3600,
      );
    } catch {
      url = null;
    }

    return {
      entityId: pt.id,
      photoIndex,
      fase: photo.fase,
      legenda: photo.legenda,
      originalName: payload.originalName,
      mimeType: payload.mimeType,
      url,
      degraded: url === null,
    };
  }

  async removeEvidencePhoto(
    id: string,
    photoIndex: number,
    userId?: string,
  ): Promise<{ entityId: string; removed: true; remaining: number }> {
    const saved = await this.executePtWorkflowTransition(
      id,
      async (pt, manager) => {
        this.assertPtEvidenceMutable(pt);
        const photos = pt.fotos_evidencia ?? [];
        const photo = photos[photoIndex];
        if (!photo) {
          throw new NotFoundException('Foto de evidência não encontrada.');
        }

        const payload = this.parseGovernedPtFileReference(
          photo.ref,
          'evidence',
        );
        if (payload) {
          await cleanupUploadedFile(
            this.logger,
            `pt-photo-remove:${pt.id}`,
            payload.fileKey,
            (key) =>
              this.documentStorageService.deleteFile(
                this.documentStorageService.referenceForExistingObject(
                  key,
                  {
                    resourceType: 'pt-photo',
                    resourceId: pt.id,
                  },
                  'p1-document-storage-deleteFile',
                ),
              ),
          );
        }

        pt.fotos_evidencia = photos.filter((_, index) => index !== photoIndex);
        return manager.getRepository(Pt).save(pt);
      },
    );

    this.logger.log({
      event: 'pt_evidence_photo_removed',
      ptId: saved.id,
      companyId: saved.company_id,
      photoIndex,
      userId,
    });

    return {
      entityId: saved.id,
      removed: true,
      remaining: saved.fotos_evidencia?.length ?? 0,
    };
  }

  async attachChecklistItemAttachment(
    id: string,
    checklistField: string,
    itemIndex: number,
    buffer: Buffer,
    originalName: string,
    mimeType: string,
    userId?: string,
  ): Promise<{
    entityId: string;
    checklistField: PtChecklistAttachmentField;
    itemIndex: number;
    storageMode: 'governed-storage';
    anexoReference: string;
    anexoNome: string;
  }> {
    if (!isPtChecklistAttachmentField(checklistField)) {
      throw new BadRequestException('Checklist inválido para anexo.');
    }

    const pt = await this.findOne(id);
    this.assertPtEditableStatus(pt.status);
    this.assertPtDocumentMutable(pt);
    const existingItem = pt[checklistField]?.[itemIndex];
    if (!existingItem) {
      throw new NotFoundException('Item de checklist não encontrado.');
    }

    const fileKey = this.documentStorageService.generateDocumentKey(
      pt.company_id,
      'pt-checklist-anexos',
      pt.id,
      originalName,
      { folderSegments: ['sites', pt.site_id] },
    );
    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          fileKey,
          { resourceType: 'pt-checklist-attachment', resourceId: pt.id },
          'p1-document-storage-uploadFile',
        ),
        buffer,
        mimeType,
      );

    const anexoReference = this.buildGovernedPtFileReference({
      v: 1,
      kind: 'governed-storage',
      scope: 'checklist-anexo',
      fileKey,
      originalName,
      mimeType,
      uploadedAt: new Date().toISOString(),
      sizeBytes: buffer.byteLength,
    });

    let saved: Pt;
    try {
      saved = await this.executePtWorkflowTransition(
        id,
        async (lockedPt, manager) => {
          this.assertPtEditableStatus(lockedPt.status);
          this.assertPtDocumentMutable(lockedPt);
          const items = lockedPt[checklistField] ?? [];
          const item = items[itemIndex];
          if (!item) {
            throw new NotFoundException('Item de checklist não encontrado.');
          }

          const previousRef = this.parseGovernedPtFileReference(
            item.anexo_ref,
            'checklist-anexo',
          );
          if (previousRef) {
            await cleanupUploadedFile(
              this.logger,
              `pt-checklist-anexo-replace:${lockedPt.id}`,
              previousRef.fileKey,
              (key) =>
                this.documentStorageService.deleteFile(
                  this.documentStorageService.referenceForExistingObject(
                    key,
                    {
                      resourceType: 'pt-checklist-attachment',
                      resourceId: lockedPt.id,
                    },
                    'p1-document-storage-deleteFile',
                  ),
                ),
            );
          }

          item.anexo_ref = anexoReference;
          item.anexo_nome = originalName;
          lockedPt[checklistField] = [...items];
          return manager.getRepository(Pt).save(lockedPt);
        },
      );
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `pt-checklist-anexo:${pt.id}`,
        fileKey,
        (key) =>
          uploadedReference.key === key
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      throw error;
    }

    this.logger.log({
      event: 'pt_checklist_anexo_uploaded',
      ptId: saved.id,
      companyId: saved.company_id,
      checklistField,
      itemIndex,
      userId,
    });

    return {
      entityId: saved.id,
      checklistField,
      itemIndex,
      storageMode: 'governed-storage',
      anexoReference,
      anexoNome: originalName,
    };
  }

  async getChecklistItemAttachmentAccess(
    id: string,
    checklistField: string,
    itemIndex: number,
  ): Promise<{
    entityId: string;
    checklistField: PtChecklistAttachmentField;
    itemIndex: number;
    originalName: string;
    mimeType: string;
    url: string | null;
    degraded: boolean;
  }> {
    if (!isPtChecklistAttachmentField(checklistField)) {
      throw new BadRequestException('Checklist inválido para anexo.');
    }

    const pt = await this.findOne(id);
    const item = pt[checklistField]?.[itemIndex];
    const payload = this.parseGovernedPtFileReference(
      item?.anexo_ref,
      'checklist-anexo',
    );
    if (!item || !payload) {
      throw new NotFoundException('Anexo do item de checklist não encontrado.');
    }

    let url: string | null;
    try {
      url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          payload.fileKey,
          {
            resourceType: 'pt-checklist-attachment',
            resourceId: pt.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
        3600,
      );
    } catch {
      url = null;
    }

    return {
      entityId: pt.id,
      checklistField,
      itemIndex,
      originalName: payload.originalName,
      mimeType: payload.mimeType,
      url,
      degraded: url === null,
    };
  }

  async appendAtmosphericReading(
    id: string,
    reading: PtAtmosphericReadingDto,
    userId?: string,
  ): Promise<Pt> {
    const saved = await this.executePtWorkflowTransition(
      id,
      async (pt, manager) => {
        this.assertPtDocumentMutable(pt);
        const status = pt.status as PtStatus;
        if (status !== PtStatus.PENDENTE && status !== PtStatus.APROVADA) {
          throw new BadRequestException(
            'Medições atmosféricas só podem ser registradas em PTs pendentes ou aprovadas.',
          );
        }

        pt.medicoes_atmosfericas = [
          ...(pt.medicoes_atmosfericas ?? []),
          { ...reading },
        ];
        return manager.getRepository(Pt).save(pt);
      },
    );

    await this.logAudit({
      action: AuditAction.UPDATE,
      entityId: saved.id,
      after: { medicoes_atmosfericas: saved.medicoes_atmosfericas },
      fallbackUserId: userId,
    });
    this.logger.log({
      event: 'pt_atmospheric_reading_appended',
      ptId: saved.id,
      companyId: saved.company_id,
      userId,
    });
    return saved;
  }

  async logPreApprovalReview(
    id: string,
    reviewedByUserId: string,
    payload: LogPreApprovalReviewDto,
  ): Promise<{ logged: true }> {
    const pt = await this.findOne(id);

    await this.auditService.log({
      userId: reviewedByUserId,
      action: AuditAction.PRE_APPROVAL,
      entity: 'PT',
      entityId: pt.id,
      changes: {
        after: {
          auditStage: 'pre_approval_review',
          reviewStage: payload.stage,
          pt: {
            id: pt.id,
            numero: pt.numero,
            titulo: pt.titulo,
            status: pt.status,
          },
          review: payload,
        },
      },
      ip: (RequestContext.get('ip') as string) || 'unknown',
      userAgent: RequestContext.get('userAgent') || 'unknown',
      companyId: pt.company_id,
    });

    this.logger.log({
      event: 'pt_pre_approval_review_logged',
      ptId: pt.id,
      stage: payload.stage,
      userId: reviewedByUserId,
    });

    return { logged: true };
  }

  async getPreApprovalHistory(id: string) {
    const pt = await this.findOne(id);
    const records = await this.auditLogsRepository.find({
      where: {
        entity: 'PT',
        entityId: pt.id,
        action: AuditAction.PRE_APPROVAL,
        companyId: pt.company_id,
      },
      order: {
        timestamp: 'DESC',
      },
      take: 20,
    });

    return records.map((record) => {
      const after = isRecord(record.after) ? record.after : null;
      const reviewSource = after?.review;
      const review: PreApprovalReviewPayload = isRecord(reviewSource)
        ? reviewSource
        : {};
      const checklist: PreApprovalChecklist | null = isRecord(review.checklist)
        ? review.checklist
        : null;

      return {
        id: record.id,
        action: record.action,
        userId: record.userId || null,
        createdAt: record.timestamp,
        stage: typeof review.stage === 'string' ? review.stage : null,
        readyForRelease:
          typeof review.readyForRelease === 'boolean'
            ? review.readyForRelease
            : null,
        blockers: isStringArray(review.blockers) ? review.blockers : [],
        unansweredChecklistItems:
          typeof review.unansweredChecklistItems === 'number'
            ? review.unansweredChecklistItems
            : 0,
        adverseChecklistItems:
          typeof review.adverseChecklistItems === 'number'
            ? review.adverseChecklistItems
            : 0,
        pendingSignatures:
          typeof review.pendingSignatures === 'number'
            ? review.pendingSignatures
            : 0,
        hasRapidRiskBlocker:
          typeof review.hasRapidRiskBlocker === 'boolean'
            ? review.hasRapidRiskBlocker
            : false,
        warnings: isStringArray(review.warnings) ? review.warnings : [],
        checklist,
      };
    });
  }

  async remove(id: string): Promise<void> {
    const pt = await this.findOne(id);
    if (pt.pdf_file_key) {
      throw new BadRequestException(
        'Somente PTs sem PDF final podem ser removidas. Use os fluxos formais de cancelamento/encerramento para registros já emitidos.',
      );
    }
    // SGS-PT-SM-008: PTs in terminal/active states must not be silently removed
    // even when they lack a PDF — Aprovada/Encerrada represent safety authorizations
    // and Cancelada/Expirada carry audit value.
    const nonRemovableStatuses: string[] = [
      PtStatus.APROVADA,
      PtStatus.ENCERRADA,
      PtStatus.CANCELADA,
      PtStatus.EXPIRADA,
    ];
    if (nonRemovableStatuses.includes(pt.status)) {
      throw new BadRequestException(
        `PT com status '${pt.status}' não pode ser removida. Somente PTs em rascunho ou pendentes sem PDF final podem ser excluídas.`,
      );
    }
    await this.documentGovernanceService.removeFinalDocumentReference({
      companyId: pt.company_id,
      module: 'pt',
      entityId: pt.id,
      trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
      trailMetadata: {
        removalMode: 'soft_delete',
      },
      removeEntityState: async (manager) => {
        await manager.getRepository(Pt).softDelete(id);
      },
      cleanupStoredFile: (fileKey) =>
        this.documentStorageService.deleteFile(
          this.documentStorageService.referenceForExistingObject(
            fileKey,
            { resourceType: 'pt', resourceId: pt.id },
            'p1-document-storage-deleteFile',
          ),
        ),
    });
    this.logger.log({ event: 'pt_soft_deleted', ptId: id });
  }

  async count(options?: FindManyOptions<Pt>): Promise<number> {
    // Sempre aplica filtro de tenant e soft-delete — impede cross-tenant leak (SGS-PT-SEC-013).
    const { companyId } = this.getTenantContextOrThrow();
    const raw = options?.where;
    const whereArr: FindOptionsWhere<Pt>[] = Array.isArray(raw)
      ? raw
      : [(raw as FindOptionsWhere<Pt>) ?? {}];
    return this.ptsRepository.count({
      ...options,
      where: whereArr.map((w) => ({
        ...w,
        company_id: companyId,
        deleted_at: IsNull(),
      })),
    });
  }

  async listStoredFiles(filters: WeeklyBundleFilters) {
    const files = await this.documentGovernanceService.listFinalDocuments(
      'pt',
      filters,
    );
    const allowedIds = await this.getAllowedPtIdsForCurrentScope();
    if (!allowedIds) {
      return files;
    }

    return files.filter((file) => allowedIds.has(file.entityId));
  }

  async getWeeklyBundle(filters: WeeklyBundleFilters) {
    const files = await this.listStoredFiles(filters);
    return this.documentBundleService.buildWeeklyPdfBundle(
      'PT',
      filters,
      files.map((file) => ({
        fileKey: file.fileKey,
        resourceType: 'pt',
        resourceId: file.entityId,
        title: file.title,
        originalName: file.originalName,
        date: file.date,
      })),
    );
  }

  async exportExcel(): Promise<Buffer> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    this.refreshExpiredStatuses(companyId).catch((err: unknown) =>
      this.logger.warn({
        event: 'pt_expire_refresh_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    const qb = this.ptsRepository
      .createQueryBuilder('pt')
      .select([
        'pt.numero',
        'pt.titulo',
        'pt.status',
        'pt.data_hora_inicio',
        'pt.data_hora_fim',
        'pt.created_at',
      ])
      .where('pt.deleted_at IS NULL')
      .orderBy('pt.created_at', 'DESC');
    if (companyId) qb.andWhere('pt.company_id = :companyId', { companyId });
    if (!isSuperAdmin && siteScope !== 'all') {
      qb.andWhere('pt.site_id IN (:...siteIds)', { siteIds });
    }
    const pts = await qb.getMany();

    const rows = pts.map((p) => ({
      Número: p.numero,
      Título: p.titulo,
      Status: p.status,
      'Data/Hora Início': p.data_hora_inicio
        ? new Date(p.data_hora_inicio).toLocaleString('pt-BR')
        : '',
      'Data/Hora Fim': p.data_hora_fim
        ? new Date(p.data_hora_fim).toLocaleString('pt-BR')
        : '',
      'Criado em': new Date(p.created_at).toLocaleDateString('pt-BR'),
    }));

    return jsonToExcelBuffer(rows, 'PTs');
  }

  async getAnalyticsOverview(): Promise<{
    totalPts: number;
    aprovadas: number;
    pendentes: number;
    canceladas: number;
    encerradas: number;
    expiradas: number;
  }> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    this.refreshExpiredStatuses(companyId).catch((err: unknown) =>
      this.logger.warn({
        event: 'pt_expire_refresh_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    const baseWhere: FindOptionsWhere<Pt> = {
      company_id: companyId,
      ...(!isSuperAdmin && siteScope !== 'all' ? { site_id: In(siteIds) } : {}),
    };

    const countByStatus = (status: PtStatus) =>
      this.ptsRepository.count({
        where: {
          ...baseWhere,
          status,
        },
      });

    const [totalPts, aprovadas, pendentes, canceladas, encerradas, expiradas] =
      await Promise.all([
        this.ptsRepository.count({ where: baseWhere }),
        countByStatus(PtStatus.APROVADA),
        countByStatus(PtStatus.PENDENTE),
        countByStatus(PtStatus.CANCELADA),
        countByStatus(PtStatus.ENCERRADA),
        countByStatus(PtStatus.EXPIRADA),
      ]);

    return {
      totalPts,
      aprovadas,
      pendentes,
      canceladas,
      encerradas,
      expiradas,
    };
  }

  async getApprovalRules() {
    const company = await this.findCurrentCompanyOrFail();
    return this.normalizeApprovalRules(company.pt_approval_rules || undefined);
  }

  async updateApprovalRules(payload: UpdatePtApprovalRulesDto) {
    const company = await this.findCurrentCompanyOrFail();
    const merged = this.normalizeApprovalRules({
      ...(company.pt_approval_rules || {}),
      ...payload,
    });
    company.pt_approval_rules = merged;
    await this.companiesRepository.save(company);
    return merged;
  }

  private async assertCanApprove(pt: Pt, companyId: string): Promise<void> {
    const reasons: string[] = [];
    const rules = await this.getApprovalRulesForCompany(companyId);

    if (
      rules.blockCriticalRiskWithoutEvidence &&
      pt.residual_risk === 'CRITICAL' &&
      !pt.control_evidence
    ) {
      reasons.push('risco residual crítico sem evidência de controle');
    }

    if (
      rules.requireAtLeastOneExecutante &&
      (!pt.executantes || pt.executantes.length === 0)
    ) {
      reasons.push('PT exige ao menos um executante vinculado');
    }

    const executantes = Array.isArray(pt.executantes) ? pt.executantes : [];
    if (executantes.length > 0) {
      const signatures = await this.signaturesService.findByDocument(
        pt.id,
        'PT',
      );
      const signedExecutanteIds = new Set(
        signatures
          .map((signature) => signature.user_id)
          .filter(
            (userId): userId is string =>
              Boolean(userId) &&
              executantes.some((executante) => executante.id === userId),
          ),
      );
      const pendingExecutantes = executantes.filter(
        (executante) => !signedExecutanteIds.has(executante.id),
      );

      if (pendingExecutantes.length > 0) {
        reasons.push(
          `assinaturas pendentes dos executantes (${pendingExecutantes
            .map((executante) => executante.nome || executante.id.slice(0, 8))
            .join(', ')})`,
        );
      }
    }

    const workerIds = [
      pt.responsavel_id,
      ...(Array.isArray(pt.executantes)
        ? pt.executantes.map((executante) => executante.id)
        : []),
    ].filter(
      (value, index, values): value is string =>
        Boolean(value) && values.indexOf(value) === index,
    );

    const workerStatuses =
      await this.workerOperationalStatusService.getByUserIds(workerIds);

    workerStatuses.forEach((status) => {
      const workerReasons: string[] = [];

      if (
        rules.blockWorkerWithExpiredBlockingTraining &&
        status.trainings.expiredBlocking.length > 0
      ) {
        workerReasons.push(
          `${status.user.nome}: treinamentos vencidos (${status.trainings.expiredBlocking
            .map((item) => item.nome)
            .join(', ')}).`,
        );
      }

      if (workerReasons.length > 0) {
        reasons.push(...workerReasons);
      }
    });

    // Conformidade NR-33 (espaço confinado) — regras opt-in por empresa.
    if (pt.espaco_confinado) {
      const atmosphericReadings = Array.isArray(pt.medicoes_atmosfericas)
        ? pt.medicoes_atmosfericas
        : [];
      const hasWatch = Boolean(
        pt.vigia_user_id || String(pt.vigia_nome ?? '').trim() || pt.vigia?.id,
      );
      const hasRescuePlan = Boolean(
        String(pt.plano_resgate ?? '').trim() &&
        String(pt.contato_emergencia ?? '').trim(),
      );

      if (
        rules.blockConfinedSpaceWithoutAtmosphericReadings &&
        atmosphericReadings.length === 0
      ) {
        reasons.push(
          'espaço confinado sem leitura atmosférica registrada (NR-33)',
        );
      }
      if (rules.blockConfinedSpaceWithoutWatch && !hasWatch) {
        reasons.push('espaço confinado sem vigia designado (NR-33)');
      }
      if (rules.blockConfinedSpaceWithoutRescuePlan && !hasRescuePlan) {
        reasons.push(
          'espaço confinado sem plano de resgate e contato de emergência (NR-33)',
        );
      }
    }

    if (rules.blockWithoutBeforeEvidence) {
      const beforeEvidenceCount = Array.isArray(pt.fotos_evidencia)
        ? pt.fotos_evidencia.filter((photo) => photo?.fase === 'antes').length
        : 0;
      if (beforeEvidenceCount === 0) {
        reasons.push(
          'sem evidência fotográfica da condição inicial (fase "antes")',
        );
      }
    }

    if (reasons.length > 0) {
      throw new BadRequestException({
        code: 'PT_APPROVAL_BLOCKED',
        message: 'PT bloqueada pelas regras de segurança da empresa.',
        reasons,
        rules,
      });
    }
  }

  private normalizeApprovalRules(
    rules?: Partial<Company['pt_approval_rules']>,
  ): NonNullable<Company['pt_approval_rules']> {
    return {
      blockCriticalRiskWithoutEvidence:
        rules?.blockCriticalRiskWithoutEvidence ??
        this.defaultApprovalRules.blockCriticalRiskWithoutEvidence,
      // Regra descontinuada por decisão de produto: ASO não bloqueia emissão/aprovação de PT.
      blockWorkerWithoutValidMedicalExam: false,
      blockWorkerWithExpiredBlockingTraining:
        rules?.blockWorkerWithExpiredBlockingTraining ??
        this.defaultApprovalRules.blockWorkerWithExpiredBlockingTraining,
      requireAtLeastOneExecutante:
        rules?.requireAtLeastOneExecutante ??
        this.defaultApprovalRules.requireAtLeastOneExecutante,
      blockConfinedSpaceWithoutAtmosphericReadings:
        rules?.blockConfinedSpaceWithoutAtmosphericReadings ??
        this.defaultApprovalRules.blockConfinedSpaceWithoutAtmosphericReadings,
      blockConfinedSpaceWithoutWatch:
        rules?.blockConfinedSpaceWithoutWatch ??
        this.defaultApprovalRules.blockConfinedSpaceWithoutWatch,
      blockConfinedSpaceWithoutRescuePlan:
        rules?.blockConfinedSpaceWithoutRescuePlan ??
        this.defaultApprovalRules.blockConfinedSpaceWithoutRescuePlan,
      blockWithoutBeforeEvidence:
        rules?.blockWithoutBeforeEvidence ??
        this.defaultApprovalRules.blockWithoutBeforeEvidence,
    };
  }

  private async findCurrentCompanyOrFail(): Promise<Company> {
    const { companyId } = this.getTenantContextOrThrow();
    if (!companyId) {
      throw new BadRequestException(
        'Contexto de empresa não identificado para configurar regras da PT.',
      );
    }
    const company = await this.companiesRepository.findOne({
      where: { id: companyId },
    });
    if (!company) {
      throw new NotFoundException(
        'Empresa não encontrada para configurar regras.',
      );
    }
    return company;
  }

  private async getApprovalRulesForCompany(companyId: string) {
    const company = await this.companiesRepository.findOne({
      where: { id: companyId },
      select: { id: true, pt_approval_rules: true },
    });
    return this.normalizeApprovalRules(company?.pt_approval_rules || undefined);
  }

  private async logAudit(params: {
    action: AuditAction;
    entityId: string;
    before?: unknown;
    after?: unknown;
    fallbackUserId?: string;
  }) {
    const userId =
      RequestContext.getUserId() || params.fallbackUserId || 'system';
    const companyId = this.getTenantContextOrThrow().companyId;
    await this.auditService.log({
      userId,
      action: params.action,
      entity: 'PT',
      entityId: params.entityId,
      changes: {
        before: params.before ?? null,
        after: params.after ?? null,
      },
      ip: (RequestContext.get('ip') as string) || 'unknown',
      userAgent: RequestContext.get('userAgent') || 'unknown',
      companyId,
    });
  }
}
