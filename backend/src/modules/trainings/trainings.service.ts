import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  LessThan,
  type FindManyOptions,
  type FindOptionsSelect,
  type FindOptionsWhere,
  Repository,
} from 'typeorm';
import { jsonToExcelBuffer } from '../../shared/utils/excel.util';
import { Training } from './entities/training.entity';
import { CreateTrainingDto } from './dto/create-training.dto';
import { UpdateTrainingDto } from './dto/update-training.dto';
import { TenantService } from '../../shared/tenant/tenant.service';
import { User } from '../users/entities/user.entity';
import {
  ResolvedSiteAccessScope,
  resolveSiteAccessScopeFromTenantService,
} from '../../shared/tenant/site-access-scope.util';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentRegistryService } from '../document-registry/document-registry.service';
import { cleanupUploadedFile } from '../../shared/storage/storage-compensation.util';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import {
  CursorPaginatedResponse,
  decodeCursorToken,
  toCursorPaginatedResponse,
} from '../../shared/utils/cursor-pagination.util';
import { MetricsService } from '../../shared/observability/metrics.service';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';

export interface BlockingTrainingUser {
  user: Training['user'];
  blockingTrainings: Training[];
}

type TrainingPdfAccessAvailability =
  'not_emitted' | 'ready' | 'registered_without_signed_url';

export type TrainingPdfAccessResponse = {
  entityId: string;
  hasFinalPdf: boolean;
  availability: TrainingPdfAccessAvailability;
  message: string;
  degraded: boolean;
  fileKey: string | null;
  folderPath: string | null;
  originalName: string | null;
  fileHash: string | null;
  documentCode: string | null;
  url: string | null;
};

const TRAINING_LIST_SELECT: FindOptionsSelect<Training> = {
  id: true,
  nome: true,
  nr_codigo: true,
  carga_horaria: true,
  obrigatorio_para_funcao: true,
  bloqueia_operacao_quando_vencido: true,
  data_conclusao: true,
  data_vencimento: true,
  certificado_url: true,
  user_id: true,
  company_id: true,
  auditado_por_id: true,
  data_auditoria: true,
  resultado_auditoria: true,
  notas_auditoria: true,
  created_at: true,
  updated_at: true,
};

@Injectable()
export class TrainingsService {
  private readonly logger = new Logger(TrainingsService.name);

  constructor(
    @InjectRepository(Training)
    private trainingsRepository: Repository<Training>,
    private tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly documentRegistryService: DocumentRegistryService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
    @Optional() private readonly metricsService?: MetricsService,
  ) {}

  /**
   * Código documental + token de validação pública (grant). O código é
   * determinístico (o mesmo do anexo do PDF final), então o token vale
   * antes e depois da emissão.
   */
  async getValidationContext(
    id: string,
  ): Promise<{ documentCode: string; token: string | null }> {
    const training = await this.findOne(id);
    const documentCode = this.buildPdfDocumentCode(training);
    let token: string | null = null;

    try {
      token = await this.publicValidationGrantService.issueToken({
        code: documentCode,
        companyId: training.company_id,
        portal: 'training_public_validation',
        documentId: training.id,
      });
    } catch (error) {
      this.logger.warn({
        event: 'training_validation_token_unavailable',
        trainingId: training.id,
        companyId: training.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return { documentCode, token };
  }

  private getTenantIdOrThrow(): string {
    const tenantId = this.tenantService.getTenantId();
    if (!tenantId) {
      throw new UnauthorizedException(
        'Contexto de empresa não identificado para treinamentos.',
      );
    }
    return tenantId;
  }

  private getSiteAccessScopeOrThrow(): ResolvedSiteAccessScope {
    return resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'treinamentos',
    );
  }

  private applyUserSiteScope(
    query: {
      andWhere: (
        condition: string,
        params?: Record<string, unknown>,
      ) => unknown;
    },
    userAlias: string,
    scope: ResolvedSiteAccessScope,
  ) {
    if (!scope.hasCompanyWideAccess) {
      query.andWhere(`${userAlias}.site_id = :currentSiteId`, {
        currentSiteId: scope.siteId,
      });
    }
  }

  private async assertUserInCurrentScope(
    userId: string,
    scope: ResolvedSiteAccessScope,
  ): Promise<void> {
    if (scope.hasCompanyWideAccess) {
      return;
    }
    const user = await this.trainingsRepository.manager
      .getRepository(User)
      .findOne({
        where: {
          id: userId,
          company_id: scope.companyId,
          site_id: scope.siteId,
        },
        select: { id: true },
      });
    if (!user) {
      throw new NotFoundException('Colaborador não encontrado na obra atual.');
    }
  }

  private buildPdfDocumentCode(training: Training): string {
    const parsedDate = new Date(training.data_conclusao);
    const year = Number.isNaN(parsedDate.getTime())
      ? new Date().getFullYear()
      : parsedDate.getFullYear();
    const reference = String(training.nr_codigo || training.id || 'training')
      .trim()
      .replace(/[^A-Za-z0-9]+/g, '')
      .toUpperCase()
      .slice(0, 12);

    return `TRN-${year}-${reference || training.id.slice(0, 8).toUpperCase()}`;
  }

  private buildPdfTitle(training: Training): string {
    return `Treinamento: ${training.nome}`;
  }

  private buildPdfOriginalName(training: Training): string {
    const safeName = String(training.nome || training.nr_codigo || training.id)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    const parsedDate = new Date(training.data_conclusao);
    const dateLabel = Number.isNaN(parsedDate.getTime())
      ? 'sem-data'
      : parsedDate.toISOString().slice(0, 10);

    return `TREINAMENTO_${safeName || training.id}_${dateLabel}.pdf`;
  }

  async create(createTrainingDto: CreateTrainingDto): Promise<Training> {
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;
    if (createTrainingDto.company_id !== undefined) {
      throw new BadRequestException(
        'company_id não é permitido no payload. O tenant autenticado define a empresa.',
      );
    }
    await this.assertUserInCurrentScope(createTrainingDto.user_id, scope);
    if (
      createTrainingDto.data_conclusao &&
      createTrainingDto.data_vencimento &&
      new Date(createTrainingDto.data_vencimento) <=
        new Date(createTrainingDto.data_conclusao)
    ) {
      throw new BadRequestException(
        'Data de vencimento não pode ser anterior à data de conclusão.',
      );
    }
    const training = this.trainingsRepository.create({
      ...createTrainingDto,
      company_id: tenantId,
    });
    const saved = await this.trainingsRepository.save(training);
    this.metricsService?.incrementTrainingRegistered(
      saved.company_id,
      saved.nr_codigo || saved.nome,
    );
    return saved;
  }

  async findAll(opts?: {
    page?: number;
    limit?: number;
  }): Promise<OffsetPage<Training>> {
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    if (scope.hasCompanyWideAccess) {
      const [data, total] = await this.trainingsRepository.findAndCount({
        where: { company_id: tenantId },
        relations: ['user'],
        select: TRAINING_LIST_SELECT,
        order: { data_vencimento: 'ASC' },
        skip,
        take: limit,
      });

      return toOffsetPage(data, total, page, limit);
    }

    const query = this.trainingsRepository
      .createQueryBuilder('training')
      .leftJoinAndSelect('training.user', 'user')
      .where('training.company_id = :tenantId', { tenantId })
      .andWhere('training.deleted_at IS NULL')
      .orderBy('training.data_vencimento', 'ASC')
      .skip(skip)
      .take(limit);
    this.applyUserSiteScope(query, 'user', scope);

    const [data, total] = await query.getManyAndCount();

    return toOffsetPage(data, total, page, limit);
  }

  // Carrega todos os registros para uso interno (exportações, relatórios).
  // Sem relação de user; apenas campos essenciais; take: 5000 como teto.
  async findAllForExport(): Promise<Training[]> {
    const scope = this.getSiteAccessScopeOrThrow();
    if (scope.hasCompanyWideAccess) {
      return this.trainingsRepository.find({
        where: { company_id: scope.companyId },
        select: TRAINING_LIST_SELECT,
        order: { data_vencimento: 'ASC' },
        take: 5000,
      });
    }

    const qb = this.trainingsRepository
      .createQueryBuilder('training')
      .leftJoin('training.user', 'user')
      .select([
        'training.id',
        'training.nome',
        'training.nr_codigo',
        'training.carga_horaria',
        'training.obrigatorio_para_funcao',
        'training.bloqueia_operacao_quando_vencido',
        'training.data_conclusao',
        'training.data_vencimento',
        'training.certificado_url',
        'training.user_id',
        'training.company_id',
        'training.auditado_por_id',
        'training.data_auditoria',
        'training.resultado_auditoria',
        'training.notas_auditoria',
        'training.created_at',
        'training.updated_at',
      ])
      .where('training.company_id = :tenantId', { tenantId: scope.companyId })
      .andWhere('training.deleted_at IS NULL')
      .orderBy('training.data_vencimento', 'ASC')
      .take(5000);
    this.applyUserSiteScope(qb, 'user', scope);
    return qb.getMany();
  }

  async findPaginated(opts?: {
    page?: number;
    limit?: number;
  }): Promise<OffsetPage<Training>> {
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    if (scope.hasCompanyWideAccess) {
      const [data, total] = await this.trainingsRepository.findAndCount({
        where: { company_id: tenantId },
        relations: ['user'],
        select: TRAINING_LIST_SELECT,
        order: { data_vencimento: 'ASC' },
        skip,
        take: limit,
      });

      return toOffsetPage(data, total, page, limit);
    }

    const query = this.trainingsRepository
      .createQueryBuilder('training')
      .leftJoinAndSelect('training.user', 'user')
      .where('training.company_id = :tenantId', { tenantId })
      .andWhere('training.deleted_at IS NULL')
      .orderBy('training.data_vencimento', 'ASC')
      .skip(skip)
      .take(limit);
    this.applyUserSiteScope(query, 'user', scope);

    const [data, total] = await query.getManyAndCount();

    return toOffsetPage(data, total, page, limit);
  }

  async findByCursor(opts?: {
    cursor?: string;
    limit?: number;
  }): Promise<CursorPaginatedResponse<Training>> {
    const scope = this.getSiteAccessScopeOrThrow();
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
      throw new BadRequestException(
        'Cursor inválido para listagem de treinamentos.',
      );
    }

    const qb = this.trainingsRepository
      .createQueryBuilder('training')
      .leftJoinAndSelect('training.user', 'user')
      .where('training.deleted_at IS NULL')
      .select([
        'training.id',
        'training.nome',
        'training.nr_codigo',
        'training.carga_horaria',
        'training.obrigatorio_para_funcao',
        'training.bloqueia_operacao_quando_vencido',
        'training.data_conclusao',
        'training.data_vencimento',
        'training.certificado_url',
        'training.user_id',
        'training.company_id',
        'training.auditado_por_id',
        'training.data_auditoria',
        'training.resultado_auditoria',
        'training.notas_auditoria',
        'training.created_at',
        'training.updated_at',
        'user.id',
        'user.nome',
      ])
      .orderBy('training.created_at', 'DESC')
      .addOrderBy('training.id', 'DESC')
      .take(limit + 1);

    qb.andWhere('training.company_id = :tenantId', { tenantId });
    this.applyUserSiteScope(qb, 'user', scope);

    if (decodedCursor) {
      qb.andWhere(
        '(training.created_at < :cursorCreatedAt OR (training.created_at = :cursorCreatedAt AND training.id < :cursorId))',
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

  async findOne(id: string): Promise<Training> {
    const scope = this.getSiteAccessScopeOrThrow();
    if (scope.hasCompanyWideAccess) {
      const training = await this.trainingsRepository.findOne({
        where: { id, company_id: scope.companyId },
        relations: ['user'],
      });
      if (!training) {
        throw new NotFoundException(`Treinamento com ID ${id} não encontrado`);
      }
      return training;
    }

    const qb = this.trainingsRepository
      .createQueryBuilder('training')
      .leftJoinAndSelect('training.user', 'user')
      .where('training.id = :id', { id })
      .andWhere('training.company_id = :tenantId', {
        tenantId: scope.companyId,
      })
      .andWhere('training.deleted_at IS NULL');
    this.applyUserSiteScope(qb, 'user', scope);
    const training = await qb.getOne();
    if (!training) {
      throw new NotFoundException(`Treinamento com ID ${id} não encontrado`);
    }
    return training;
  }

  async attachPdf(
    id: string,
    file: Express.Multer.File,
    actorId?: string,
  ): Promise<{
    trainingId: string;
    hasFinalPdf: boolean;
    availability: TrainingPdfAccessAvailability;
    message: string;
    degraded: boolean;
    fileKey: string;
    folderPath: string;
    originalName: string;
    documentCode: string;
    fileHash: string;
  }> {
    const training = await this.findOne(id);
    const originalName =
      file.originalname?.trim() || this.buildPdfOriginalName(training);
    const fileKey = this.documentStorageService.generateDocumentKey(
      training.company_id,
      'trainings',
      training.id,
      originalName,
    );
    const folderPath = fileKey.split('/').slice(0, -1).join('/');
    const documentCode = this.buildPdfDocumentCode(training);

    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          fileKey,
          { resourceType: 'training', resourceId: training.id },
          'p1-document-storage-uploadFile',
        ),
        file.buffer,
        file.mimetype,
      );

    try {
      const { hash, registryEntry } =
        await this.documentGovernanceService.registerFinalDocument({
          companyId: training.company_id,
          module: 'training',
          entityId: training.id,
          title: this.buildPdfTitle(training),
          documentDate: training.data_conclusao || training.created_at,
          documentCode,
          fileKey,
          folderPath,
          originalName,
          mimeType: file.mimetype || 'application/pdf',
          fileBuffer: file.buffer,
          createdBy: actorId || null,
          persistEntityMetadata: async (manager, computedHash) => {
            await manager.getRepository(Training).update(training.id, {
              pdf_file_key: fileKey,
              pdf_folder_path: folderPath,
              pdf_original_name: originalName,
              pdf_file_hash: computedHash,
              pdf_generated_at: new Date(),
            });
          },
        });

      return {
        trainingId: training.id,
        hasFinalPdf: true,
        availability: 'ready',
        message: 'PDF final do treinamento emitido e governado com sucesso.',
        degraded: false,
        fileKey,
        folderPath,
        originalName,
        documentCode:
          registryEntry.document_code || this.buildPdfDocumentCode(training),
        fileHash: hash,
      };
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `trainings.attachPdf:${training.id}`,
        fileKey,
        (key) =>
          uploadedReference.key === key
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      throw error;
    }
  }

  async getPdfAccess(id: string): Promise<TrainingPdfAccessResponse> {
    const training = await this.findOne(id);
    const registryEntry = await this.documentRegistryService.findByDocument(
      'training',
      training.id,
      'pdf',
      training.company_id,
    );

    if (!training.pdf_file_key) {
      return {
        entityId: training.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message:
          'O treinamento ainda não possui PDF final emitido. Gere o documento oficial para habilitar envio e acesso governado.',
        degraded: false,
        fileKey: null,
        folderPath: null,
        originalName: null,
        fileHash: null,
        documentCode:
          registryEntry?.document_code || this.buildPdfDocumentCode(training),
        url: null,
      };
    }

    let url: string | null = null;
    let availability: TrainingPdfAccessAvailability = 'ready';
    let degraded = false;
    let message = 'PDF final governado disponível para acesso.';

    try {
      url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          training.pdf_file_key,
          {
            resourceType: 'training',
            resourceId: training.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
      );
    } catch (error) {
      availability = 'registered_without_signed_url';
      degraded = true;
      message =
        'PDF final registrado, mas a URL segura não está disponível no momento. Tente novamente quando o storage estiver saudável.';
      this.logger.warn(
        `URL assinada indisponível para PDF final do treinamento ${training.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      entityId: training.id,
      hasFinalPdf: true,
      availability,
      message,
      degraded,
      fileKey: training.pdf_file_key,
      folderPath: training.pdf_folder_path || null,
      originalName: training.pdf_original_name || null,
      fileHash: registryEntry?.file_hash || training.pdf_file_hash || null,
      documentCode:
        registryEntry?.document_code || this.buildPdfDocumentCode(training),
      url,
    };
  }

  async update(id: string, updateTrainingDto: UpdateTrainingDto) {
    const training = await this.findOne(id);
    if (updateTrainingDto.user_id) {
      await this.assertUserInCurrentScope(
        updateTrainingDto.user_id,
        this.getSiteAccessScopeOrThrow(),
      );
    }
    const conclusao =
      updateTrainingDto.data_conclusao ?? training.data_conclusao;
    const vencimento =
      updateTrainingDto.data_vencimento ?? training.data_vencimento;
    if (
      conclusao &&
      vencimento &&
      new Date(vencimento) <= new Date(conclusao)
    ) {
      throw new BadRequestException(
        'Data de vencimento não pode ser anterior à data de conclusão.',
      );
    }
    Object.assign(training, updateTrainingDto);
    return this.trainingsRepository.save(training);
  }

  async remove(id: string): Promise<void> {
    const training = await this.findOne(id);
    if (training.pdf_file_key) {
      throw new BadRequestException(
        'Somente treinamentos sem certificado (PDF) final podem ser removidos. Use os fluxos formais de cancelamento para registros já emitidos.',
      );
    }
    // Mesmo sem PDF final, garante que nenhuma entrada de registry órfã
    // permaneça publicamente validável por QR após a remoção do treinamento.
    await this.documentGovernanceService.removeFinalDocumentReference({
      companyId: training.company_id,
      module: 'training',
      entityId: training.id,
      removeEntityState: async (manager) => {
        await manager.getRepository(Training).softDelete(training.id);
      },
    });
  }

  async findByUserId(userId: string): Promise<Training[]> {
    const scope = this.getSiteAccessScopeOrThrow();
    if (scope.hasCompanyWideAccess) {
      return this.trainingsRepository.find({
        where: { user_id: userId, company_id: scope.companyId },
      });
    }

    const qb = this.trainingsRepository
      .createQueryBuilder('training')
      .leftJoin('training.user', 'user')
      .where('training.user_id = :userId', { userId })
      .andWhere('training.company_id = :tenantId', {
        tenantId: scope.companyId,
      })
      .andWhere('training.deleted_at IS NULL');
    this.applyUserSiteScope(qb, 'user', scope);
    return qb.getMany();
  }

  async findExpirySummary() {
    const now = new Date();
    const limitDate = new Date();
    limitDate.setDate(now.getDate() + 30);

    const [total, expired, expiringSoon] = await Promise.all([
      this.count(),
      this.count({
        where: {
          data_vencimento: LessThan(now),
        },
      }),
      this.count({
        where: {
          data_vencimento: Between(now, limitDate),
        },
      }),
    ]);

    return {
      total,
      expired,
      expiringSoon,
      valid: total - expired - expiringSoon,
    };
  }

  async findExpiring(days: number) {
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;
    const now = new Date();
    const future = new Date();
    future.setDate(now.getDate() + days);

    const qb = this.trainingsRepository
      .createQueryBuilder('training')
      .leftJoinAndSelect('training.user', 'user')
      .where('training.data_vencimento BETWEEN :now AND :future', {
        now,
        future,
      });

    qb.andWhere('training.deleted_at IS NULL');
    qb.andWhere('training.company_id = :tenantId', { tenantId });
    this.applyUserSiteScope(qb, 'user', scope);

    return qb.getMany();
  }

  async dispatchExpiryNotifications(days: number) {
    const expiring = await this.findExpiring(days);
    // Simulação de envio de notificações
    return {
      dispatched: expiring.length,
      timestamp: new Date(),
    };
  }

  async findBlockingUsers() {
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;
    const now = new Date();

    const qb = this.trainingsRepository
      .createQueryBuilder('training')
      .leftJoinAndSelect('training.user', 'user')
      .where('training.data_vencimento < :now', { now })
      .andWhere('training.bloqueia_operacao_quando_vencido = :blocking', {
        blocking: true,
      });

    qb.andWhere('training.deleted_at IS NULL');
    qb.andWhere('training.company_id = :tenantId', { tenantId });
    this.applyUserSiteScope(qb, 'user', scope);

    const trainings = await qb.getMany();
    const usersMap = new Map<string, BlockingTrainingUser>();
    trainings.forEach((t) => {
      if (!usersMap.has(t.user_id)) {
        usersMap.set(t.user_id, {
          user: t.user,
          blockingTrainings: [],
        });
      }

      const userEntry = usersMap.get(t.user_id);
      if (userEntry) {
        userEntry.blockingTrainings.push(t);
      }
    });

    return Array.from(usersMap.values());
  }

  async getComplianceByUser(userId: string) {
    const trainings = await this.findByUserId(userId);
    const now = new Date();
    const expired = trainings.filter((t) => new Date(t.data_vencimento) < now);

    return {
      userId,
      isCompliant: expired.length === 0,
      totalTrainings: trainings.length,
      expiredCount: expired.length,
      expiredTrainings: expired,
    };
  }

  async count(options?: FindManyOptions<Training>): Promise<number> {
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;

    const scopedWhere = options?.where;
    const where = Array.isArray(scopedWhere)
      ? scopedWhere.map((clause) => ({
          ...clause,
          company_id: tenantId,
          ...(!scope.hasCompanyWideAccess
            ? { user: { site_id: scope.siteId } }
            : {}),
        }))
      : ({
          ...(scopedWhere ?? {}),
          company_id: tenantId,
          ...(!scope.hasCompanyWideAccess
            ? { user: { site_id: scope.siteId } }
            : {}),
        } satisfies FindOptionsWhere<Training>);

    return this.trainingsRepository.count({
      ...(options ?? {}),
      where,
    });
  }

  async exportExcel(): Promise<Buffer> {
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;
    const qb = this.trainingsRepository
      .createQueryBuilder('training')
      .leftJoinAndSelect('training.user', 'user')
      .select([
        'training.nr_codigo',
        'training.nome',
        'training.data_vencimento',
        'training.data_conclusao',
        'training.carga_horaria',
        'training.created_at',
        'user.nome',
      ])
      .where('training.deleted_at IS NULL')
      .orderBy('training.data_vencimento', 'ASC');
    qb.andWhere('training.company_id = :tenantId', { tenantId });
    this.applyUserSiteScope(qb, 'user', scope);
    const trainings = await qb.getMany();

    const now = new Date();
    const rows = trainings.map((t) => {
      const vencimento = t.data_vencimento ? new Date(t.data_vencimento) : null;
      const status = !vencimento
        ? 'Sem validade'
        : vencimento < now
          ? 'Vencido'
          : (vencimento.getTime() - now.getTime()) / (1000 * 60 * 60 * 24) <= 30
            ? 'Vencendo em breve'
            : 'Em dia';
      return {
        'Código NR': t.nr_codigo ?? '',
        Nome: t.nome,
        Status: status,
        'Data de Vencimento': vencimento
          ? vencimento.toLocaleDateString('pt-BR')
          : '',
        'Data de Conclusão': t.data_conclusao
          ? new Date(t.data_conclusao).toLocaleDateString('pt-BR')
          : '',
        'Carga Horária (h)': t.carga_horaria ?? '',
        Funcionário: t.user?.nome ?? '',
      };
    });

    return jsonToExcelBuffer(rows, 'Treinamentos');
  }
}
