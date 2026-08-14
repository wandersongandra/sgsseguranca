import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  In,
  IsNull,
  OptimisticLockVersionMismatchError,
  Repository,
  EntityManager,
  SelectQueryBuilder,
} from 'typeorm';
import { Dds, DdsStatus, DDS_ALLOWED_TRANSITIONS } from './entities/dds.entity';
import {
  DdsApprovalAction,
  DdsApprovalRecord,
} from './entities/dds-approval-record.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import { CreateDdsDto } from './dto/create-dds.dto';
import { UpdateDdsDto } from './dto/update-dds.dto';
import { UpdateDdsAuditDto } from './dto/update-dds-audit.dto';
import { ReplaceDdsSignaturesDto } from './dto/replace-dds-signatures.dto';
import { User } from '../users/entities/user.entity';
import { UserSite } from '../users/entities/user-site.entity';
import { Site } from '../sites/entities/site.entity';
import {
  DocumentBundleService,
  WeeklyBundleFilters,
} from '../../shared/services/document-bundle.service';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { normalizeOptionalSearchQuery } from '../../shared/utils/query-normalization.util';
import { escapeLikePattern } from '../../shared/utils/sql.util';
import {
  CursorPaginatedResponse,
  decodeCursorToken,
  toCursorPaginatedResponse,
} from '../../shared/utils/cursor-pagination.util';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { cleanupUploadedFile } from '../../shared/storage/storage-compensation.util';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentVideosService } from '../document-videos/document-videos.service';
import { SignaturesService } from '../signatures/signatures.service';
import { Signature } from '../signatures/entities/signature.entity';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import { MetricsService } from '../../shared/observability/metrics.service';
import { Counter } from '@opentelemetry/api';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';

export const DDS_DOMAIN_METRICS = 'DDS_DOMAIN_METRICS';

const TEAM_PHOTO_SIGNATURE_PREFIX = 'team_photo';
const TEAM_PHOTO_REUSE_JUSTIFICATION_TYPE = 'team_photo_reuse_justification';

/** Limite padrão de DDSs históricos consultados para detecção de foto reutilizada */
const HISTORICAL_PHOTO_HASH_LIMIT = parseTenantConfigInt(
  process.env.DDS_HISTORICAL_PHOTO_HASH_LIMIT,
  20, // Reduzido de 100 para 20 para melhorar performance
);

/** Expiração (segundos) da URL assinada do PDF final */
const DDS_PDF_SIGNED_URL_EXPIRY_SECONDS = parseTenantConfigInt(
  process.env.DDS_PDF_SIGNED_URL_EXPIRY_SECONDS,
  900,
);

function parseTenantConfigInt(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type HistoricalPhotoHashes = {
  ddsId: string;
  tema: string;
  data: string;
  hashes: string[];
};

type DdsPdfAvailability =
  'ready' | 'registered_without_signed_url' | 'not_emitted';

type TeamPhotoEvidence = {
  imageData: string;
  capturedAt: string;
  hash: string;
  metadata: {
    userAgent: string;
    latitude?: number;
    longitude?: number;
    accuracy?: number;
  };
};

type DdsPdfEmissionContext = {
  userId?: string;
  ip?: string | null;
  userAgent?: string | null;
};

type DdsValidationContext = {
  documentCode: string;
  token: string | null;
};

type DdsStoredFileListItem = {
  ddsId: string;
  tema: string;
  data: string;
  companyId: string;
  siteId: string | null;
  siteName: string | null;
  fileKey: string;
  folderPath: string;
  originalName: string;
};

export type DdsPeopleListItem = {
  id: string;
  nome: string;
  funcao: string | null;
  company_id: string;
  site_id: string | null;
  status: boolean;
};

@Injectable()
export class DdsService {
  private readonly logger = new Logger(DdsService.name);

  constructor(
    @InjectRepository(Dds)
    private ddsRepository: Repository<Dds>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly documentBundleService: DocumentBundleService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly documentVideosService: DocumentVideosService,
    private readonly signaturesService: SignaturesService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional()
    @Inject(DDS_DOMAIN_METRICS)
    private readonly domainMetrics?: Record<string, Counter>,
  ) {}

  private getTenantIdOrThrow(): string {
    const tenantId = this.tenantService.getTenantId();
    if (!tenantId) {
      throw new UnauthorizedException(
        'Contexto de empresa não identificado para DDS.',
      );
    }
    return tenantId;
  }

  private getSiteAccessScopeOrThrow(options?: {
    allowMissingSiteScope?: boolean;
  }) {
    if (
      !this.tenantService.getContext?.() &&
      !this.tenantService.getTenantId()
    ) {
      throw new UnauthorizedException(
        'Contexto de empresa não identificado para DDS.',
      );
    }
    return resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'DDS',
      options,
    );
  }

  private assertSiteAllowed(siteId: string | null | undefined): void {
    const scope = this.getSiteAccessScopeOrThrow();
    if (
      !scope.hasCompanyWideAccess &&
      (!siteId || !scope.siteIds.includes(siteId))
    ) {
      throw new ForbiddenException(
        'DDS fora do escopo de obra do usuário atual.',
      );
    }
  }

  private buildTenantScopedIdsWhere(ids: string[], tenantId: string) {
    return {
      id: In(ids),
      deleted_at: IsNull(),
      company_id: tenantId,
    };
  }

  private applyDdsSiteScope(
    query: SelectQueryBuilder<Dds>,
    scope: ReturnType<DdsService['getSiteAccessScopeOrThrow']>,
  ): void {
    if (scope.hasCompanyWideAccess) {
      return;
    }

    if (scope.siteIds.length === 0) {
      query.andWhere('1 = 0');
      return;
    }

    query.andWhere('dds.site_id IN (:...currentSiteIds)', {
      currentSiteIds: scope.siteIds,
    });
  }

  private orderByIds(ids: string[], data: Dds[]): Dds[] {
    const byId = new Map(data.map((item) => [item.id, item]));
    return ids
      .map((id) => byId.get(id))
      .filter((item): item is Dds => Boolean(item));
  }

  private async assignParticipantCounts(
    ddsList: Dds[],
    tenantId?: string,
  ): Promise<void> {
    if (ddsList.length === 0) {
      return;
    }

    const ids = ddsList.map((dds) => dds.id);
    const qb = this.ddsRepository
      .createQueryBuilder('dds')
      .leftJoin('dds.participants', 'participant')
      .select('dds.id', 'id')
      .addSelect('COUNT(participant.id)', 'participant_count')
      .where('dds.id IN (:...ids)', { ids })
      .andWhere('dds.deleted_at IS NULL')
      .groupBy('dds.id');

    if (tenantId) {
      qb.andWhere('dds.company_id = :tenantId', { tenantId });
    }

    const rows = await qb.getRawMany<{
      id: string;
      participant_count?: string | number | null;
    }>();
    const countMap = new Map<string, number>(
      rows.map((row) => {
        const parsed = Number(row.participant_count);
        return [row.id, Number.isFinite(parsed) ? parsed : 0];
      }),
    );

    ddsList.forEach((dds) => {
      dds.participant_count = countMap.get(dds.id) ?? 0;
    });
  }

  private sanitizeFileKey(fileKey: string): string {
    // Manter apenas sufixo para evitar exposição de chaves S3 em logs
    const parts = fileKey.split('/');
    return `.../${parts.slice(-2).join('/')}`;
  }

  async create(createDdsDto: CreateDdsDto): Promise<Dds> {
    const { participants, company_id, ...rest } = createDdsDto;
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;

    if (company_id !== undefined) {
      throw new BadRequestException(
        'company_id não é permitido no payload. O tenant autenticado define a empresa.',
      );
    }
    this.assertSiteAllowed(rest.site_id);

    const participantIds = this.normalizeUniqueIds(participants);
    await this.assertRelationsBelongToCompany({
      companyId: tenantId,
      siteId: rest.site_id,
      facilitatorId: rest.facilitador_id,
      participantIds,
      auditorId: rest.auditado_por_id,
    });

    const dds = this.ddsRepository.create({
      ...rest,
      company_id: tenantId,
      participants: participantIds.map((id) => ({ id }) as User),
    });

    const saved = await this.ddsRepository.save(dds);
    this.logger.log({
      event: 'dds_created',
      ddsId: saved.id,
      companyId: saved.company_id,
    });
    try {
      this.domainMetrics?.dds_created?.add(1, {
        company_id: saved.company_id,
      });
    } catch (error) {
      this.logger.warn(
        `[DDS] Falha ao registrar dds_created no domínio: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.metricsService?.incrementDdsCreated(saved.company_id);
    }
    return saved;
  }

  async listPeople(opts?: {
    page?: number;
    limit?: number;
    siteId?: string;
  }): Promise<OffsetPage<DdsPeopleListItem>> {
    const scope = this.getSiteAccessScopeOrThrow({
      allowMissingSiteScope: true,
    });
    const tenantId = scope.companyId;
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    // Prioridade: obra explicitamente selecionada no formulário (opts.siteId).
    // Fallback para scope do usuário quando não há obra selecionada.
    const siteIds = opts?.siteId
      ? [opts.siteId]
      : scope.hasCompanyWideAccess
        ? []
        : scope.siteIds;

    const qb = this.usersRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.nome',
        'user.funcao',
        'user.company_id',
        'user.site_id',
        'user.status',
      ])
      .where('user.company_id = :tenantId', { tenantId })
      .andWhere('user.deleted_at IS NULL')
      .andWhere(
        "(user.status = true OR user.password IS NULL OR btrim(user.password) = '')",
      )
      .skip(skip)
      .take(limit)
      .orderBy('user.nome', 'ASC');

    if (siteIds.length > 0) {
      qb.andWhere(
        `(user.site_id IN (:...siteIds) OR user.site_id IS NULL OR EXISTS (
          SELECT 1 FROM user_sites us WHERE us.user_id = user.id AND us.site_id IN (:...siteIds)
        ))`,
        { siteIds },
      );
    } else if (!scope.hasCompanyWideAccess) {
      qb.andWhere('1 = 0');
    }

    const [users, total] = await qb.getManyAndCount();
    const data = users.map((user) => ({
      id: user.id,
      nome: user.nome,
      funcao: user.funcao,
      company_id: user.company_id,
      site_id: user.site_id ?? null,
      status: user.status,
    }));

    return toOffsetPage(data, total, page, limit);
  }

  async findAll(opts?: {
    page?: number;
    limit?: number;
  }): Promise<OffsetPage<Dds>> {
    const scope = this.getSiteAccessScopeOrThrow({
      allowMissingSiteScope: true,
    });
    const tenantId = scope.companyId;
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const idsQuery = this.ddsRepository
      .createQueryBuilder('dds')
      .select('dds.id', 'id')
      .where('dds.deleted_at IS NULL')
      .orderBy('dds.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    const countQuery = this.ddsRepository
      .createQueryBuilder('dds')
      .where('dds.deleted_at IS NULL');

    idsQuery.andWhere('dds.company_id = :tenantId', { tenantId });
    countQuery.andWhere('dds.company_id = :tenantId', { tenantId });

    this.applyDdsSiteScope(idsQuery, scope);
    this.applyDdsSiteScope(countQuery, scope);

    const [rows, total] = await Promise.all([
      idsQuery.getRawMany<{ id: string }>(),
      countQuery.getCount(),
    ]);

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return toOffsetPage([], total, page, limit);
    }

    const data = await this.ddsRepository.find({
      where: this.buildTenantScopedIdsWhere(ids, tenantId),
      relations: ['site', 'facilitador'], // participants via batch count para evitar N+1
    });

    const ordered = this.orderByIds(ids, data);
    await this.assignParticipantCounts(ordered, tenantId);

    return toOffsetPage(ordered, total, page, limit);
  }

  // Carrega todos os registros para uso interno (exportações, relatórios).
  // Sem relações pesadas; take: 5000 como teto de segurança.
  async findAllForExport(): Promise<Dds[]> {
    const scope = this.getSiteAccessScopeOrThrow({
      allowMissingSiteScope: true,
    });
    const tenantId = scope.companyId;
    const qb = this.ddsRepository
      .createQueryBuilder('dds')
      .select([
        'dds.id',
        'dds.tema',
        'dds.data',
        'dds.status',
        'dds.is_modelo',
        'dds.company_id',
        'dds.site_id',
        'dds.created_at',
      ])
      .where('dds.deleted_at IS NULL')
      .orderBy('dds.created_at', 'DESC')
      .take(5000);

    qb.andWhere('dds.company_id = :tenantId', { tenantId });
    this.applyDdsSiteScope(qb, scope);

    return qb.getMany();
  }

  async findPaginated(opts?: {
    page?: number;
    limit?: number;
    search?: string;
    kind?: 'all' | 'model' | 'regular';
    status?: 'all' | DdsStatus;
    sort_by?: 'created_at' | 'data' | 'tema' | 'status';
    sort_dir?: 'ASC' | 'DESC';
  }): Promise<OffsetPage<Dds>> {
    const scope = this.getSiteAccessScopeOrThrow({
      allowMissingSiteScope: true,
    });
    const tenantId = scope.companyId;
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const SORT_COLUMN_MAP: Record<string, string> = {
      created_at: 'dds.created_at',
      data: 'dds.data',
      tema: 'dds.tema',
      status: 'dds.status',
    };
    const orderField = SORT_COLUMN_MAP[opts?.sort_by ?? ''] ?? 'dds.created_at';
    const orderDir: 'ASC' | 'DESC' = opts?.sort_dir === 'ASC' ? 'ASC' : 'DESC';

    const idsQuery = this.ddsRepository
      .createQueryBuilder('dds')
      .select('dds.id', 'id')
      .orderBy(orderField, orderDir)
      .addOrderBy('dds.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    const countQuery = this.ddsRepository.createQueryBuilder('dds');

    idsQuery.where('dds.deleted_at IS NULL');
    countQuery.where('dds.deleted_at IS NULL');

    idsQuery.andWhere('dds.company_id = :tenantId', { tenantId });
    countQuery.andWhere('dds.company_id = :tenantId', { tenantId });

    this.applyDdsSiteScope(idsQuery, scope);
    this.applyDdsSiteScope(countQuery, scope);

    const searchTerm = normalizeOptionalSearchQuery(opts?.search);
    if (searchTerm) {
      const search = `%${escapeLikePattern(searchTerm.toLowerCase())}%`;
      idsQuery
        .leftJoin('dds.site', 'search_site')
        .leftJoin('dds.facilitador', 'search_facilitador')
        .andWhere(
          "(LOWER(dds.tema) LIKE :search ESCAPE '\\' OR LOWER(search_site.nome) LIKE :search ESCAPE '\\' OR LOWER(search_facilitador.nome) LIKE :search ESCAPE '\\')",
          { search },
        );
      countQuery
        .leftJoin('dds.site', 'search_site')
        .leftJoin('dds.facilitador', 'search_facilitador')
        .andWhere(
          "(LOWER(dds.tema) LIKE :search ESCAPE '\\' OR LOWER(search_site.nome) LIKE :search ESCAPE '\\' OR LOWER(search_facilitador.nome) LIKE :search ESCAPE '\\')",
          { search },
        );
    }

    if (opts?.kind === 'model') {
      idsQuery.andWhere('dds.is_modelo = true');
      countQuery.andWhere('dds.is_modelo = true');
    } else if (opts?.kind === 'regular') {
      idsQuery.andWhere('dds.is_modelo = false');
      countQuery.andWhere('dds.is_modelo = false');
    }

    if (opts?.status && opts.status !== 'all') {
      idsQuery.andWhere('dds.status = :status', { status: opts.status });
      countQuery.andWhere('dds.status = :status', { status: opts.status });
    }

    const [rows, total] = await Promise.all([
      idsQuery.getRawMany<{ id: string }>(),
      countQuery.getCount(),
    ]);

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return toOffsetPage([], total, page, limit);
    }

    const data = await this.ddsRepository.find({
      where: this.buildTenantScopedIdsWhere(ids, tenantId),
      relations: ['site', 'facilitador', 'company'], // Removido 'participants' para evitar N+1 queries
    });

    const ordered = this.orderByIds(ids, data);
    await this.assignParticipantCounts(ordered, tenantId);

    return toOffsetPage(ordered, total, page, limit);
  }

  async findByCursor(opts?: {
    cursor?: string;
    limit?: number;
    search?: string;
    kind?: 'all' | 'model' | 'regular';
    status?: 'all' | DdsStatus;
  }): Promise<CursorPaginatedResponse<Dds>> {
    const scope = this.getSiteAccessScopeOrThrow({
      allowMissingSiteScope: true,
    });
    const tenantId = scope.companyId;
    const { limit } = normalizeOffsetPagination(
      { page: 1, limit: opts?.limit },
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );

    const decodedCursor = decodeCursorToken(opts?.cursor);
    if (opts?.cursor && !decodedCursor) {
      throw new BadRequestException('Cursor inválido para listagem de DDS.');
    }

    const idsQuery = this.ddsRepository
      .createQueryBuilder('dds')
      .select('dds.id', 'id')
      .addSelect('dds.created_at', 'created_at')
      .where('dds.deleted_at IS NULL')
      .orderBy('dds.created_at', 'DESC')
      .addOrderBy('dds.id', 'DESC')
      .take(limit + 1);

    idsQuery.andWhere('dds.company_id = :tenantId', { tenantId });
    this.applyDdsSiteScope(idsQuery, scope);

    const searchTerm = normalizeOptionalSearchQuery(opts?.search);
    if (searchTerm) {
      const search = `%${escapeLikePattern(searchTerm.toLowerCase())}%`;
      idsQuery
        .leftJoin('dds.site', 'search_site')
        .leftJoin('dds.facilitador', 'search_facilitador')
        .andWhere(
          "(LOWER(dds.tema) LIKE :search ESCAPE '\\' OR LOWER(search_site.nome) LIKE :search ESCAPE '\\' OR LOWER(search_facilitador.nome) LIKE :search ESCAPE '\\')",
          { search },
        );
    }

    if (opts?.kind === 'model') {
      idsQuery.andWhere('dds.is_modelo = true');
    } else if (opts?.kind === 'regular') {
      idsQuery.andWhere('dds.is_modelo = false');
    }

    if (opts?.status && opts.status !== 'all') {
      idsQuery.andWhere('dds.status = :status', { status: opts.status });
    }

    if (decodedCursor) {
      idsQuery.andWhere(
        '(dds.created_at < :cursorCreatedAt OR (dds.created_at = :cursorCreatedAt AND dds.id < :cursorId))',
        {
          cursorCreatedAt: decodedCursor.created_at,
          cursorId: decodedCursor.id,
        },
      );
    }

    const rows = await idsQuery.getRawMany<{ id: string; created_at: Date }>();
    const cursorPage = toCursorPaginatedResponse({
      rows,
      limit,
      getCreatedAt: (row) => row.created_at,
    });

    const ids = cursorPage.data.map((row) => row.id);
    if (ids.length === 0) {
      return {
        data: [],
        cursor: null,
        hasMore: false,
      };
    }

    const data = await this.ddsRepository.find({
      where: {
        ...this.buildTenantScopedIdsWhere(ids, tenantId),
        ...(!scope.hasCompanyWideAccess ? { site_id: In(scope.siteIds) } : {}),
      },
      relations: ['site', 'facilitador', 'company'], // Removido 'participants' para evitar N+1 queries
    });

    const ordered = this.orderByIds(ids, data);
    await this.assignParticipantCounts(ordered, tenantId);

    return {
      data: ordered,
      cursor: cursorPage.cursor,
      hasMore: cursorPage.hasMore,
    };
  }

  async findOne(id: string): Promise<Dds> {
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;
    const dds = await this.ddsRepository.findOne({
      where: {
        id,
        company_id: tenantId,
        deleted_at: IsNull(),
        ...(!scope.hasCompanyWideAccess ? { site_id: In(scope.siteIds) } : {}),
      },
      relations: [
        'company',
        'site',
        'facilitador',
        'participants',
        'auditado_por',
        'emitted_by',
      ],
    });
    if (!dds) {
      throw new NotFoundException(`DDS com ID ${id} não encontrado`);
    }
    return dds;
  }

  async updateStatus(id: string, status: DdsStatus): Promise<Dds> {
    const dds = await this.findOne(id);
    this.assertFinalDocumentMutable(dds);
    if (
      dds.is_modelo &&
      (status === DdsStatus.PUBLICADO || status === DdsStatus.AUDITADO)
    ) {
      throw new BadRequestException(
        'Modelos de DDS não podem ser publicados ou auditados. Gere um DDS operacional a partir do modelo.',
      );
    }
    const allowed = DDS_ALLOWED_TRANSITIONS[dds.status];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Transição inválida: ${dds.status} → ${status}. Permitidas: ${allowed.join(', ') || 'nenhuma'}`,
      );
    }

    if (status === DdsStatus.AUDITADO) {
      const approvalStatus = await this.getApprovalFlowStatus(dds.id);
      if (approvalStatus !== 'approved') {
        throw new BadRequestException(
          'O DDS só pode ser auditado após conclusão formal do fluxo de aprovação.',
        );
      }
      const missing: string[] = [];
      if (!dds.auditado_por_id) missing.push('auditado_por_id');
      if (!dds.data_auditoria) missing.push('data_auditoria');
      if (!dds.resultado_auditoria) missing.push('resultado_auditoria');
      if (missing.length > 0) {
        throw new BadRequestException(
          `Para marcar como auditado, preencha os campos obrigatórios: ${missing.join(', ')}.`,
        );
      }
    }
    const previousStatus = dds.status;
    dds.status = status;
    let saved: Dds;
    try {
      saved = await this.ddsRepository.save(dds);
    } catch (error) {
      if (error instanceof OptimisticLockVersionMismatchError) {
        throw new ConflictException(
          'O DDS foi modificado por outra operação simultânea. Atualize e tente novamente.',
        );
      }
      throw error;
    }
    this.logger.log({
      event: 'dds_status_updated',
      ddsId: saved.id,
      companyId: saved.company_id,
      previousStatus,
      nextStatus: saved.status,
    });
    return saved;
  }

  async attachPdf(
    id: string,
    file: Express.Multer.File,
    context: DdsPdfEmissionContext = {},
  ): Promise<{
    fileKey: string;
    folderPath: string;
    originalName: string;
    storageMode: 's3';
    degraded: boolean;
    message: string;
  }> {
    const dds = await this.findOne(id);
    this.assertFinalDocumentMutable(dds);
    await this.assertReadyForFinalDocument(dds);
    const companyId = dds.company_id;
    const siteId = dds.site_id;
    if (!siteId) {
      throw new BadRequestException(
        'DDS sem obra/setor vinculado não pode receber PDF final.',
      );
    }
    const key = this.documentStorageService.generateDocumentKey(
      companyId,
      'dds',
      id,
      file.originalname,
      { folderSegments: ['sites', siteId] },
    );
    const storageMode = 's3' as const;
    await this.documentStorageService.uploadFile(
      key,
      file.buffer,
      file.mimetype,
    );
    const uploadedToStorage = true;

    const folder = key.split('/').slice(0, -1).join('/');
    const documentCode = dds.document_code || this.buildDdsDocumentCode(dds);
    const pdfGeneratedAt = new Date();
    try {
      await this.documentGovernanceService.registerFinalDocument({
        companyId: dds.company_id,
        module: 'dds',
        entityId: dds.id,
        title: dds.tema || 'DDS',
        documentDate: dds.data || dds.created_at,
        documentCode,
        fileKey: key,
        folderPath: folder,
        originalName: file.originalname,
        mimeType: file.mimetype,
        createdBy: context.userId,
        fileBuffer: file.buffer,
        persistEntityMetadata: async (manager, hash) => {
          await manager.getRepository(Dds).update(id, {
            pdf_file_key: key,
            pdf_folder_path: folder,
            pdf_original_name: file.originalname,
            document_code: documentCode,
            final_pdf_hash_sha256: hash,
            pdf_generated_at: pdfGeneratedAt,
            emitted_by_user_id: context.userId ?? null,
            emitted_ip: context.ip ?? null,
            emitted_user_agent: context.userAgent ?? null,
          });
        },
      });
    } catch (error) {
      this.logger.error({
        event: 'dds_pdf_governance_registration_failed',
        ddsId: dds.id,
        companyId: dds.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        uploadedToStorage,
        fileKeySuffix: this.sanitizeFileKey(key),
      });

      if (uploadedToStorage) {
        await cleanupUploadedFile(
          this.logger,
          `dds:${dds.id}`,
          key,
          (fileKey) => this.documentStorageService.deleteFile(fileKey),
        );
      }
      throw error;
    }

    this.logger.log({
      event: 'dds_pdf_attached',
      ddsId: dds.id,
      companyId: dds.company_id,
      storageMode,
      fileKeySuffix: this.sanitizeFileKey(key),
    });
    return {
      fileKey: key,
      folderPath: folder,
      originalName: file.originalname,
      storageMode,
      degraded: false,
      message: 'PDF final do DDS emitido e registrado com sucesso.',
    };
  }

  async getPdfAccess(id: string): Promise<{
    ddsId: string;
    hasFinalPdf: boolean;
    availability: DdsPdfAvailability;
    message: string;
    degraded: boolean;
    fileKey: string | null;
    folderPath: string | null;
    originalName: string | null;
    url: string | null;
  }> {
    const dds = await this.findOne(id);
    if (!dds.pdf_file_key) {
      const payload = {
        ddsId: dds.id,
        hasFinalPdf: false,
        availability: 'not_emitted' as const,
        message:
          'O DDS ainda não possui PDF final emitido. Gere o documento final para habilitar download governado.',
        degraded: false,
        fileKey: null,
        folderPath: null,
        originalName: null,
        url: null,
      };
      this.logger.log({
        event: 'dds_pdf_access_resolved',
        ddsId: dds.id,
        companyId: dds.company_id,
        availability: payload.availability,
        degraded: payload.degraded,
      });
      return payload;
    }

    let url: string | null;
    let availability: DdsPdfAvailability = 'ready';
    let degraded = false;
    let message = 'PDF final governado disponível para acesso.';
    try {
      url = await this.documentStorageService.getSignedUrl(
        dds.pdf_file_key,
        DDS_PDF_SIGNED_URL_EXPIRY_SECONDS,
      );
    } catch {
      // S3 desabilitado ou indisponível — retorna sem URL segura
      url = null;
      availability = 'registered_without_signed_url';
      degraded = true;
      message =
        'PDF final registrado, mas a URL segura não está disponível no momento. O storage está em modo degradado.';
    }

    const payload = {
      ddsId: dds.id,
      hasFinalPdf: true,
      availability,
      message,
      degraded,
      fileKey: dds.pdf_file_key,
      folderPath: dds.pdf_folder_path,
      originalName: dds.pdf_original_name,
      url,
    };
    this.logger.log({
      event: 'dds_pdf_access_resolved',
      ddsId: dds.id,
      companyId: dds.company_id,
      availability: payload.availability,
      degraded: payload.degraded,
    });
    return payload;
  }

  async getValidationContext(id: string): Promise<DdsValidationContext> {
    const dds = await this.findOne(id);
    const documentCode = dds.document_code || this.buildDdsDocumentCode(dds);
    let token: string | null = null;

    try {
      token = await this.publicValidationGrantService.issueToken({
        code: documentCode,
        companyId: dds.company_id,
        portal: 'dds_public_validation',
        documentId: dds.id,
      });
    } catch (error) {
      this.logger.warn({
        event: 'dds_validation_token_unavailable',
        ddsId: dds.id,
        companyId: dds.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      documentCode,
      token,
    };
  }

  async getHistoricalPhotoHashes(
    limit = HISTORICAL_PHOTO_HASH_LIMIT,
    excludeDocumentId?: string,
  ): Promise<HistoricalPhotoHashes[]> {
    const scope = this.getSiteAccessScopeOrThrow();
    const companyScopeId = scope.companyId;

    const recentQuery = this.ddsRepository
      .createQueryBuilder('dds')
      .select(['dds.id AS id', 'dds.tema AS tema', 'dds.data AS data'])
      .where('dds.company_id = :companyScopeId', {
        companyScopeId,
      })
      .andWhere('dds.deleted_at IS NULL')
      .andWhere(excludeDocumentId ? 'dds.id != :excludeDocumentId' : '1=1', {
        excludeDocumentId,
      })
      .orderBy('dds.created_at', 'DESC')
      .limit(limit);

    this.applyDdsSiteScope(recentQuery, scope);

    const recent = await recentQuery.getRawMany<{
      id: string;
      tema: string;
      data: string;
    }>();

    const documentIds = recent.map((item) => item.id);
    const signatures = await this.signaturesService.findManyByDocuments(
      documentIds,
      'DDS',
      {
        companyId: companyScopeId,
        typePrefix: TEAM_PHOTO_SIGNATURE_PREFIX,
      },
    );
    const hashesByDocument = signatures.reduce<Record<string, string[]>>(
      (accumulator, signature) => {
        const hash = this.parseTeamPhotoHash(signature);
        if (!hash) {
          return accumulator;
        }
        const current = accumulator[signature.document_id] || [];
        current.push(hash);
        accumulator[signature.document_id] = current;
        return accumulator;
      },
      {},
    );

    return recent.map((item) => ({
      ddsId: item.id,
      tema: item.tema,
      data: item.data,
      hashes: hashesByDocument[item.id] || [],
    }));
  }

  async replaceSignatures(
    id: string,
    dto: ReplaceDdsSignaturesDto,
    authenticatedUserId: string,
  ): Promise<{
    participantSignatures: number;
    teamPhotos: number;
    duplicatePhotoWarnings: string[];
  }> {
    const dds = await this.findOne(id);
    this.assertWorkflowMutable(dds);
    await this.assertNoPendingApprovalFlowForMutation(dds);
    if (dds.is_modelo) {
      throw new BadRequestException(
        'Modelos de DDS não podem receber assinaturas de execução.',
      );
    }

    const participantIds = this.getParticipantIds(dds);
    if (participantIds.length === 0) {
      throw new BadRequestException(
        'O DDS precisa ter participantes definidos antes das assinaturas.',
      );
    }

    const providedParticipantSignatures = dto.participant_signatures || [];
    const uniqueParticipantSignatures = new Map(
      providedParticipantSignatures.map((signature) => [
        signature.user_id,
        signature,
      ]),
    );
    const hasAnyParticipantSignature = uniqueParticipantSignatures.size > 0;

    if (hasAnyParticipantSignature) {
      const invalidParticipant = Array.from(
        uniqueParticipantSignatures.keys(),
      ).find((userId) => !participantIds.includes(userId));
      if (invalidParticipant) {
        throw new BadRequestException(
          'Assinatura recebida para um participante que nao pertence a este DDS.',
        );
      }

      if (uniqueParticipantSignatures.size !== participantIds.length) {
        throw new BadRequestException(
          'Assinaturas parciais não são permitidas: assine todos os participantes selecionados.',
        );
      }
    }

    const teamPhotos = dto.team_photos || [];
    const duplicateWarnings = await this.findDuplicateTeamPhotoHashes(
      dds,
      teamPhotos,
    );
    if (
      duplicateWarnings.length > 0 &&
      String(dto.photo_reuse_justification || '').trim().length < 20
    ) {
      throw new BadRequestException(
        'Detectamos reuso potencial de foto. Informe uma justificativa com pelo menos 20 caracteres.',
      );
    }

    const signaturesToPersist = [
      ...Array.from(uniqueParticipantSignatures.values()).map((signature) => ({
        user_id: signature.user_id,
        signer_user_id: signature.user_id,
        signature_data:
          signature.type === 'hmac' ? 'HMAC_PENDING' : signature.signature_data,
        type: signature.type,
        pin: signature.type === 'hmac' ? signature.pin : undefined,
        company_id: dds.company_id,
        document_id: id,
        document_type: 'DDS',
      })),
      ...teamPhotos.map((photo, index) => ({
        user_id: dds.facilitador_id,
        signer_user_id: dds.facilitador_id,
        signature_data: JSON.stringify(photo),
        type: `${TEAM_PHOTO_SIGNATURE_PREFIX}_${index + 1}`,
        company_id: dds.company_id,
        document_id: id,
        document_type: 'DDS',
      })),
    ];

    const justification =
      duplicateWarnings.length > 0
        ? String(dto.photo_reuse_justification || '').trim()
        : null;

    await this.ddsRepository.manager.transaction(async (manager) => {
      // Pessimistic write lock: garante que uploads concorrentes de assinaturas
      // não sobrescrevam uns aos outros de forma silenciosa.
      await manager
        .getRepository(Dds)
        .createQueryBuilder('dds')
        .setLock('pessimistic_write')
        .whereInIds([id])
        .andWhere('dds.deleted_at IS NULL')
        .getOne();

      await this.signaturesService.replaceDocumentSignatures({
        document_id: id,
        document_type: 'DDS',
        company_id: dds.company_id,
        authenticated_user_id: authenticatedUserId,
        signatures: signaturesToPersist,
      });
      await manager.getRepository(Dds).update(id, {
        photo_reuse_justification: justification,
      });
    });
    this.logger.log({
      event: 'dds_signatures_replaced',
      ddsId: dds.id,
      companyId: dds.company_id,
      participantSignatures: uniqueParticipantSignatures.size,
      teamPhotos: teamPhotos.length,
      duplicateWarnings: duplicateWarnings.length,
    });

    return {
      participantSignatures: participantIds.length,
      teamPhotos: teamPhotos.length,
      duplicatePhotoWarnings: duplicateWarnings,
    };
  }

  async listSignatures(id: string): Promise<Signature[]> {
    const dds = await this.findOne(id);
    return this.signaturesService.findByDocument(dds.id, 'DDS');
  }

  async listVideoAttachments(id: string) {
    const dds = await this.findOne(id);
    return this.documentVideosService.listByDocument({
      companyId: dds.company_id,
      module: 'dds',
      documentId: dds.id,
    });
  }

  async uploadVideoAttachment(
    id: string,
    input: {
      buffer: Buffer;
      originalName: string;
      mimeType: string;
    },
    actorId?: string,
  ) {
    const dds = await this.findOne(id);
    this.assertDdsVideoMutable(dds);
    await this.assertNoPendingApprovalFlowForMutation(dds);

    const result = await this.documentVideosService.uploadForDocument({
      companyId: dds.company_id,
      module: 'dds',
      documentId: dds.id,
      buffer: input.buffer,
      originalName: input.originalName,
      mimeType: input.mimeType,
      uploadedById: actorId,
    });

    this.logger.log({
      event: 'dds_video_attachment_uploaded',
      ddsId: dds.id,
      companyId: dds.company_id,
      attachmentId: result.attachment.id,
      mimeType: result.attachment.mime_type,
      storageKey: result.attachment.storage_key,
      actorId: actorId || null,
    });

    return result;
  }

  async getVideoAttachmentAccess(
    id: string,
    attachmentId: string,
    actorId?: string,
  ) {
    const dds = await this.findOne(id);
    const result = await this.documentVideosService.getAccess({
      companyId: dds.company_id,
      module: 'dds',
      documentId: dds.id,
      attachmentId,
    });

    this.logger.log({
      event: 'dds_video_attachment_accessed',
      ddsId: dds.id,
      companyId: dds.company_id,
      attachmentId,
      availability: result.availability,
      actorId: actorId || null,
    });

    return result;
  }

  async removeVideoAttachment(
    id: string,
    attachmentId: string,
    actorId?: string,
  ) {
    const dds = await this.findOne(id);
    this.assertDdsVideoMutable(dds);
    await this.assertNoPendingApprovalFlowForMutation(dds);

    const result = await this.documentVideosService.removeFromDocument({
      companyId: dds.company_id,
      module: 'dds',
      documentId: dds.id,
      attachmentId,
      removedById: actorId,
    });

    this.logger.log({
      event: 'dds_video_attachment_removed',
      ddsId: dds.id,
      companyId: dds.company_id,
      attachmentId,
      actorId: actorId || null,
    });

    return result;
  }

  async update(id: string, updateDdsDto: UpdateDdsDto): Promise<Dds> {
    const dds = await this.findOne(id);
    this.assertWorkflowMutable(dds);
    await this.assertNoPendingApprovalFlowForMutation(dds);
    const { participants, confirm_signature_reset, ...rest } = updateDdsDto;
    const participantIds =
      participants !== undefined
        ? this.normalizeUniqueIds(participants)
        : this.getParticipantIds(dds);
    if (rest.site_id) {
      this.assertSiteAllowed(rest.site_id);
    }
    const siteId = this.resolveRequiredSiteId(
      rest.site_id ?? dds.site_id,
      'DDS sem obra/setor não pode ter relações validadas para edição.',
    );
    await this.assertRelationsBelongToCompany({
      companyId: dds.company_id,
      siteId,
      facilitatorId: rest.facilitador_id ?? dds.facilitador_id,
      participantIds,
      auditorId:
        rest.auditado_por_id !== undefined
          ? rest.auditado_por_id
          : (dds.auditado_por_id ?? undefined),
    });

    const signatureResetReasons = this.getSignatureResetReasons(
      dds,
      rest,
      participantIds,
    );

    if (signatureResetReasons.length > 0 && !confirm_signature_reset) {
      throw new BadRequestException({
        message:
          'Esta alteração irá invalidar as assinaturas existentes do DDS. ' +
          'Reenvie a requisição com confirm_signature_reset: true para confirmar.',
        signatureResetReasons,
      });
    }

    Object.assign(dds, rest);
    dds.participants = participantIds.map(
      (participantId) => ({ id: participantId }) as User,
    );

    const saved = await this.ddsRepository.manager.transaction(
      async (manager: EntityManager) => {
        const persistedDds = await manager.getRepository(Dds).save(dds);
        if (signatureResetReasons.length > 0) {
          await manager.getRepository(Signature).delete({
            document_id: id,
            document_type: 'DDS',
            company_id: dds.company_id,
          });
        }
        return persistedDds;
      },
    );

    this.logger.log({
      event: 'dds_updated',
      ddsId: saved.id,
      companyId: saved.company_id,
    });
    if (signatureResetReasons.length > 0) {
      this.logger.warn({
        event: 'dds_signatures_invalidated',
        ddsId: saved.id,
        companyId: saved.company_id,
        reasons: signatureResetReasons,
      });
    }
    return saved;
  }

  /**
   * Cria uma cópia operacional a partir de um template (is_modelo=true).
   * O novo DDS herda tema, conteudo, site_id e facilitador_id do modelo,
   * com data do dia atual e status RASCUNHO.
   */
  async operationalizeTemplate(
    id: string,
    overrides: {
      data?: string;
      facilitador_id?: string;
      site_id?: string;
    } = {},
  ): Promise<Dds> {
    const template = await this.findOne(id);
    if (!template.is_modelo) {
      throw new BadRequestException(
        'Somente modelos (is_modelo=true) podem ser operacionalizados.',
      );
    }
    const siteId = overrides.site_id ?? template.site_id;
    this.assertSiteAllowed(siteId);
    const facilitatorId = overrides.facilitador_id ?? template.facilitador_id;
    await this.assertRelationsBelongToCompany({
      companyId: template.company_id,
      siteId: this.resolveRequiredSiteId(
        siteId,
        'Modelo DDS sem obra/setor não pode ser operacionalizado.',
      ),
      facilitatorId,
      participantIds: [],
    });

    const newDds = this.ddsRepository.create({
      company_id: template.company_id,
      tema: template.tema,
      conteudo: template.conteudo,
      site_id: siteId,
      facilitador_id: facilitatorId,
      data: overrides.data ? new Date(overrides.data) : new Date(),
      is_modelo: false,
      status: DdsStatus.RASCUNHO,
    });
    const saved = await this.ddsRepository.save(newDds);
    this.logger.log({
      event: 'dds_operationalized',
      sourceTemplateId: id,
      newDdsId: saved.id,
      companyId: saved.company_id,
    });
    return saved;
  }

  /** Busca múltiplos DDSs por IDs (máximo 50) */
  async findByIds(ids: string[]): Promise<Dds[]> {
    if (ids.length === 0) return [];
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;
    const safeIds = ids.slice(0, 50);
    const ddsList = await this.ddsRepository.find({
      where: safeIds.map((id) => ({
        id,
        deleted_at: IsNull(),
        company_id: tenantId,
        ...(!scope.hasCompanyWideAccess ? { site_id: In(scope.siteIds) } : {}),
      })),
      relations: ['site', 'facilitador', 'company'], // Removido 'participants' para evitar N+1 queries
    });
    await this.assignParticipantCounts(ddsList, tenantId);
    return ddsList;
  }

  /**
   * Atualiza exclusivamente os campos de auditoria do DDS.
   * Não revalida nem invalida assinaturas — campos de auditoria são
   * independentes do conteúdo técnico do documento.
   */
  async updateAudit(id: string, dto: UpdateDdsAuditDto): Promise<Dds> {
    const dds = await this.findOne(id);
    if (dds.pdf_file_key) {
      throw new BadRequestException(
        'DDS com PDF final emitido não pode ter auditoria alterada. Gere um novo DDS para reabrir o fluxo.',
      );
    }
    if (dds.status === DdsStatus.AUDITADO) {
      throw new BadRequestException(
        'DDS auditado não pode ter auditoria alterada. Gere um novo DDS para um novo ciclo de revisão.',
      );
    }
    if (dds.status === DdsStatus.ARQUIVADO) {
      throw new BadRequestException(
        'DDS arquivado não pode ter campos de auditoria alterados.',
      );
    }
    const siteId = this.resolveRequiredSiteId(
      dds.site_id,
      'DDS sem obra/setor não pode ter auditoria validada.',
    );
    await this.assertRelationsBelongToCompany({
      companyId: dds.company_id,
      siteId,
      facilitatorId: dds.facilitador_id,
      participantIds: this.getParticipantIds(dds),
      auditorId: dto.auditado_por_id,
    });
    Object.assign(dds, {
      auditado_por_id: dto.auditado_por_id,
      data_auditoria: dto.data_auditoria,
      resultado_auditoria: dto.resultado_auditoria,
      notas_auditoria: dto.notas_auditoria ?? dds.notas_auditoria,
    });
    let saved: Dds;
    try {
      saved = await this.ddsRepository.save(dds);
    } catch (error) {
      if (error instanceof OptimisticLockVersionMismatchError) {
        throw new ConflictException(
          'O DDS foi modificado por outra operação simultânea. Atualize e tente novamente.',
        );
      }
      throw error;
    }
    this.logger.log({
      event: 'dds_audit_updated',
      ddsId: saved.id,
      companyId: saved.company_id,
      resultado: saved.resultado_auditoria,
    });
    return saved;
  }

  private async getApprovalFlowStatus(
    ddsId: string,
  ): Promise<'not_started' | 'pending' | 'approved' | 'rejected' | 'canceled'> {
    const records = await this.ddsRepository.manager
      .getRepository(DdsApprovalRecord)
      .find({
        where: {
          dds_id: ddsId,
          company_id: this.getTenantIdOrThrow(),
        },
        order: {
          cycle: 'ASC',
          level_order: 'ASC',
          created_at: 'ASC',
        },
      });

    if (records.length === 0) {
      return 'not_started';
    }

    const activeCycle = Math.max(...records.map((record) => record.cycle));
    const cycleRecords = records.filter(
      (record) => record.cycle === activeCycle,
    );
    const latestByLevel = new Map<number, DdsApprovalRecord>();

    cycleRecords.forEach((record) => {
      const current = latestByLevel.get(record.level_order);
      if (
        !current ||
        current.created_at.getTime() <= record.created_at.getTime()
      ) {
        latestByLevel.set(record.level_order, record);
      }
    });

    const stepActions = [...latestByLevel.entries()]
      .filter(([levelOrder]) => levelOrder > 0)
      .map(([, record]) => record.action);

    if (stepActions.length === 0) {
      return 'not_started';
    }
    if (stepActions.some((action) => action === DdsApprovalAction.REJECTED)) {
      return 'rejected';
    }
    if (stepActions.every((action) => action === DdsApprovalAction.APPROVED)) {
      return 'approved';
    }
    if (stepActions.every((action) => action === DdsApprovalAction.CANCELED)) {
      return 'canceled';
    }

    return 'pending';
  }

  private async assertNoPendingApprovalFlowForMutation(
    dds: Dds,
  ): Promise<void> {
    const approvalStatus = await this.getApprovalFlowStatus(dds.id);
    if (approvalStatus === 'pending') {
      throw new BadRequestException(
        'DDS com aprovação em andamento não pode ser alterado. Reprove/reabra o fluxo ou crie um novo ciclo antes de editar o documento.',
      );
    }
  }

  async remove(id: string): Promise<void> {
    const dds = await this.findOne(id);
    await this.documentGovernanceService.removeFinalDocumentReference({
      companyId: dds.company_id,
      module: 'dds',
      entityId: dds.id,
      trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
      trailMetadata: {
        removalMode: 'soft_delete',
      },
      removeEntityState: async (manager) => {
        await manager.getRepository(Dds).softDelete(id);
      },
      cleanupStoredFile: (fileKey) =>
        this.documentStorageService.deleteFile(fileKey),
    });
    this.logger.log({
      event: 'dds_archived',
      ddsId: dds.id,
      companyId: dds.company_id,
    });
  }

  async count(options?: { where?: Record<string, unknown> }): Promise<number> {
    const scope = this.getSiteAccessScopeOrThrow({
      allowMissingSiteScope: true,
    });
    if (!scope.hasCompanyWideAccess && scope.siteIds.length === 0) {
      return 0;
    }
    const where = options?.where || {};
    return this.ddsRepository.count({
      where: {
        ...where,
        company_id: scope.companyId,
        deleted_at: IsNull(),
        ...(!scope.hasCompanyWideAccess ? { site_id: In(scope.siteIds) } : {}),
      } as Record<string, unknown>,
    });
  }

  async listStoredFiles(
    filters: WeeklyBundleFilters,
  ): Promise<DdsStoredFileListItem[]> {
    const scope = this.getSiteAccessScopeOrThrow({
      allowMissingSiteScope: true,
    });
    const tenantId = scope.companyId;
    if (!scope.hasCompanyWideAccess && scope.siteIds.length === 0) {
      return [];
    }
    const files = await this.documentGovernanceService.listFinalDocuments(
      'dds',
      filters,
    );
    if (files.length === 0) {
      return [];
    }

    const ddsIds = files.map((file) => file.id);
    const ddsRows = await this.ddsRepository.find({
      where: {
        ...this.buildTenantScopedIdsWhere(ddsIds, tenantId),
        ...(!scope.hasCompanyWideAccess ? { site_id: In(scope.siteIds) } : {}),
      },
      select: {
        id: true,
        tema: true,
        data: true,
        site_id: true,
        site: { nome: true },
      },
      relations: ['site'],
    });
    const ddsById = new Map(ddsRows.map((dds) => [dds.id, dds]));

    return files.flatMap((file) => {
      const dds = ddsById.get(file.id);
      if (!dds) {
        return [];
      }

      return [
        {
          ddsId: file.id,
          tema: dds.tema || file.title,
          data: this.toDateString(dds.data || file.date),
          companyId: file.companyId,
          siteId: dds.site_id ?? null,
          siteName: dds.site?.nome ?? null,
          fileKey: file.fileKey,
          folderPath: file.folderPath,
          originalName: file.originalName,
        },
      ];
    });
  }

  async getWeeklyBundle(filters: WeeklyBundleFilters) {
    const files = await this.listStoredFiles(filters);

    return this.documentBundleService.buildWeeklyPdfBundle(
      'DDS',
      filters,
      files.map((file) => ({
        fileKey: file.fileKey,
        title: file.tema,
        originalName: file.originalName,
        date: file.data,
      })),
    );
  }

  private async assertReadyForFinalDocument(dds: Dds): Promise<void> {
    if (dds.is_modelo) {
      throw new BadRequestException(
        'Modelos de DDS nao podem receber PDF final. Gere um DDS operacional a partir do modelo.',
      );
    }

    if (dds.status !== DdsStatus.AUDITADO) {
      throw new BadRequestException(
        'O DDS precisa estar auditado por fluxo de aprovação antes do anexo do PDF final.',
      );
    }

    const approvalStatus = await this.getApprovalFlowStatus(dds.id);
    if (approvalStatus !== 'approved') {
      throw new BadRequestException(
        'O DDS precisa ter fluxo de aprovação concluído antes do anexo do PDF final.',
      );
    }

    const participantIds = this.getParticipantIds(dds);
    if (participantIds.length === 0) {
      throw new BadRequestException(
        'O DDS precisa ter participantes definidos antes do PDF final.',
      );
    }

    const signatures = await this.signaturesService.findByDocument(
      dds.id,
      'DDS',
    );
    const participantSigners = new Set(
      signatures
        .filter(
          (signature) =>
            !this.isTeamPhotoSignature(signature.type) &&
            signature.type !== TEAM_PHOTO_REUSE_JUSTIFICATION_TYPE,
        )
        .map((signature) => signature.user_id),
    );

    const missingParticipants = participantIds.filter(
      (participantId) => !participantSigners.has(participantId),
    );

    if (missingParticipants.length > 0) {
      throw new BadRequestException(
        'Todos os participantes precisam assinar o DDS antes do anexo do PDF final.',
      );
    }

    const duplicateWarnings = await this.findDuplicateTeamPhotoHashes(
      dds,
      signatures
        .filter((signature) => this.isTeamPhotoSignature(signature.type))
        .map((signature) => this.parseTeamPhoto(signature))
        .filter((photo): photo is TeamPhotoEvidence => Boolean(photo)),
    );

    if (
      duplicateWarnings.length > 0 &&
      String(dds.photo_reuse_justification || '').trim().length < 20
    ) {
      throw new BadRequestException(
        'O DDS possui foto potencialmente reutilizada e exige justificativa registrada antes do PDF final.',
      );
    }
  }

  private async findDuplicateTeamPhotoHashes(
    dds: Dds,
    teamPhotos: TeamPhotoEvidence[],
  ): Promise<string[]> {
    if (teamPhotos.length === 0) {
      return [];
    }

    const historicalHashes = await this.getHistoricalPhotoHashes(
      HISTORICAL_PHOTO_HASH_LIMIT,
      dds.id,
    );
    const knownHashes = new Set(
      historicalHashes.flatMap((item) => item.hashes).filter(Boolean),
    );

    return Array.from(
      new Set(
        teamPhotos
          .map((photo) => photo.hash)
          .filter((hash) => Boolean(hash) && knownHashes.has(hash)),
      ),
    );
  }

  private getParticipantIds(dds: Dds): string[] {
    return Array.from(
      new Set((dds.participants || []).map((participant) => participant.id)),
    );
  }

  private isTeamPhotoSignature(type: string): boolean {
    return /^team_photo_\d+$/i.test(type);
  }

  private parseTeamPhotoHash(signature: Signature): string | null {
    return this.parseTeamPhoto(signature)?.hash || null;
  }

  private parseTeamPhoto(signature: Signature): TeamPhotoEvidence | null {
    if (!signature.signature_data) {
      return null;
    }

    try {
      const parsed = JSON.parse(signature.signature_data) as TeamPhotoEvidence;
      if (!parsed?.hash || !parsed?.imageData) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private assertFinalDocumentMutable(dds: Dds): void {
    if (dds.pdf_file_key) {
      throw new BadRequestException(
        'DDS com PDF final anexado. Edição bloqueada. Gere um novo DDS para alterar o documento.',
      );
    }
    if (dds.status === DdsStatus.ARQUIVADO) {
      throw new BadRequestException(
        'DDS arquivado. Gere um novo DDS para retomar o fluxo operacional.',
      );
    }
  }

  private assertWorkflowMutable(dds: Dds): void {
    this.assertFinalDocumentMutable(dds);

    if (dds.status === DdsStatus.AUDITADO) {
      throw new BadRequestException(
        'DDS auditado. Gere um novo DDS operacional para um novo ciclo de execução.',
      );
    }
  }

  private assertDdsVideoMutable(dds: Dds): void {
    this.assertWorkflowMutable(dds);

    if (dds.is_modelo) {
      throw new BadRequestException(
        'Modelos de DDS não aceitam evidências em vídeo. Gere um DDS operacional antes de anexar o vídeo.',
      );
    }
  }

  private normalizeUniqueIds(ids?: string[]): string[] {
    return Array.from(new Set((ids || []).filter(Boolean)));
  }

  private async assertRelationsBelongToCompany(input: {
    companyId: string;
    siteId: string;
    facilitatorId: string;
    participantIds: string[];
    auditorId?: string;
  }): Promise<void> {
    const checks: Promise<void>[] = [
      this.assertSiteBelongsToCompany(input.siteId, input.companyId),
      this.assertUsersBelongToCompany(
        [input.facilitatorId],
        input.companyId,
        'Facilitador',
        input.siteId,
      ),
    ];

    if (input.auditorId) {
      checks.push(
        this.assertUsersBelongToCompany(
          [input.auditorId],
          input.companyId,
          'Auditor',
          input.siteId,
        ),
      );
    }

    if (input.participantIds.length > 0) {
      checks.push(
        this.assertUsersBelongToCompany(
          input.participantIds,
          input.companyId,
          'Participantes',
          input.siteId,
        ),
      );
    }

    await Promise.all(checks);
  }

  private async assertSiteBelongsToCompany(
    siteId: string,
    companyId: string,
  ): Promise<void> {
    const site = await this.ddsRepository.manager.getRepository(Site).findOne({
      where: { id: siteId, company_id: companyId },
      select: ['id'],
    });
    if (!site) {
      throw new BadRequestException(
        'O site informado não pertence à empresa atual do DDS.',
      );
    }
  }

  private resolveRequiredSiteId(
    siteId: string | null | undefined,
    message: string,
  ): string {
    if (!siteId) {
      throw new BadRequestException(message);
    }
    return siteId;
  }

  private async assertUsersBelongToCompany(
    userIds: string[],
    companyId: string,
    label: string,
    siteId: string,
  ): Promise<void> {
    const uniqueUserIds = this.normalizeUniqueIds(userIds);
    if (uniqueUserIds.length === 0) {
      return;
    }

    // Proteção contra queries muito grandes
    if (uniqueUserIds.length > 1000) {
      throw new BadRequestException(
        `Máximo 1000 ${label} por operação. Recebido: ${uniqueUserIds.length}`,
      );
    }

    const users = await this.ddsRepository.manager.getRepository(User).find({
      where: [
        {
          id: In(uniqueUserIds),
          company_id: companyId,
          site_id: siteId,
          deletedAt: IsNull(),
        },
        {
          id: In(uniqueUserIds),
          company_id: companyId,
          site_id: IsNull(),
          deletedAt: IsNull(),
        },
      ],
      select: ['id'],
    });

    const siteLinks = await this.ddsRepository.manager
      .getRepository(UserSite)
      .find({
        where: {
          user_id: In(uniqueUserIds),
          company_id: companyId,
          site_id: siteId,
        },
        select: ['user_id'],
      });

    const foundIds = new Set(users.map((user) => user.id));
    siteLinks.forEach((link) => foundIds.add(link.user_id));
    const missingIds = uniqueUserIds.filter((userId) => !foundIds.has(userId));
    if (missingIds.length > 0) {
      throw new BadRequestException(
        `${label} informado(s) não pertencem à obra/setor selecionada do DDS.`,
      );
    }
  }

  private getSignatureResetReasons(
    dds: Dds,
    nextValues: Omit<UpdateDdsDto, 'participants'>,
    nextParticipantIds: string[],
  ): string[] {
    const reasons: string[] = [];
    const currentParticipantIds = [...this.getParticipantIds(dds)].sort();
    const sortedNextParticipantIds = [...nextParticipantIds].sort();

    if (
      JSON.stringify(currentParticipantIds) !==
      JSON.stringify(sortedNextParticipantIds)
    ) {
      reasons.push('participants_changed');
    }

    const nextTema = nextValues.tema ?? dds.tema;
    const nextConteudo = nextValues.conteudo ?? dds.conteudo ?? '';
    const nextData = nextValues.data ?? this.toDateString(dds.data);
    const nextSiteId = nextValues.site_id ?? dds.site_id;
    const nextFacilitadorId = nextValues.facilitador_id ?? dds.facilitador_id;
    const nextIsModelo = nextValues.is_modelo ?? dds.is_modelo;

    if (nextTema !== dds.tema) {
      reasons.push('theme_changed');
    }
    if (nextConteudo !== (dds.conteudo ?? '')) {
      reasons.push('content_changed');
    }
    if (nextData !== this.toDateString(dds.data)) {
      reasons.push('date_changed');
    }
    if (nextSiteId !== dds.site_id) {
      reasons.push('site_changed');
    }
    if (nextFacilitadorId !== dds.facilitador_id) {
      reasons.push('facilitator_changed');
    }
    if (nextIsModelo !== dds.is_modelo) {
      reasons.push('model_flag_changed');
    }

    return reasons;
  }

  private toDateString(value?: Date | string | null): string {
    if (!value) {
      return '';
    }
    if (typeof value === 'string') {
      return value.slice(0, 10);
    }
    return value.toISOString().slice(0, 10);
  }

  private buildDdsDocumentCode(
    dds: Pick<Dds, 'id' | 'tema' | 'data' | 'created_at'>,
  ): string {
    const candidateDate = dds.data
      ? new Date(dds.data)
      : dds.created_at
        ? new Date(dds.created_at)
        : new Date();
    const year = Number.isNaN(candidateDate.getTime())
      ? new Date().getFullYear()
      : candidateDate.getFullYear();
    const reference = String(dds.id || dds.tema || 'DDS')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-8)
      .toUpperCase();

    return `DDS-${year}-${reference || String(Date.now()).slice(-6)}`;
  }
}
