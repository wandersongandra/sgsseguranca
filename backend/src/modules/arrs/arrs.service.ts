import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { normalizeOptionalSearchQuery } from '../../shared/utils/query-normalization.util';
import { escapeLikePattern } from '../../shared/utils/sql.util';
import {
  GovernedPdfAccessAvailability,
  GovernedPdfAccessResponseDto,
} from '../../shared/dto/governed-pdf-access-response.dto';
import { Site } from '../sites/entities/site.entity';
import { User } from '../users/entities/user.entity';
import { UserSite } from '../users/entities/user-site.entity';
import { cleanupUploadedFile } from '../../shared/storage/storage-compensation.util';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import { Arr, ArrStatus, ARR_ALLOWED_TRANSITIONS } from './entities/arr.entity';
import { CreateArrDto } from './dto/create-arr.dto';
import { UpdateArrDto } from './dto/update-arr.dto';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';

export type ArrPdfAccessAvailability = GovernedPdfAccessAvailability;

const ARR_PDF_SIGNED_URL_EXPIRY_SECONDS = parseInt(
  process.env.ARR_PDF_SIGNED_URL_EXPIRY_SECONDS || '900',
  10,
);

type ArrPdfEmissionContext = {
  userId?: string;
};

@Injectable()
export class ArrsService {
  private readonly logger = new Logger(ArrsService.name);

  constructor(
    @InjectRepository(Arr)
    private readonly arrRepository: Repository<Arr>,
    private readonly tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
  ) {}

  /**
   * Código documental + token de validação pública (grant) da ARR.
   * O código é determinístico (mesmo do anexo do PDF final), então o token
   * vale antes e depois da emissão.
   */
  async getValidationContext(
    id: string,
  ): Promise<{ documentCode: string; token: string | null }> {
    const arr = await this.findOne(id);
    const documentCode = arr.document_code || this.buildArrDocumentCode(arr);
    let token: string | null = null;

    try {
      token = await this.publicValidationGrantService.issueToken({
        code: documentCode,
        companyId: arr.company_id,
        portal: 'arr_public_validation',
        documentId: arr.id,
      });
    } catch (error) {
      this.logger.warn({
        event: 'arr_validation_token_unavailable',
        arrId: arr.id,
        companyId: arr.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return { documentCode, token };
  }

  private getSiteAccessScopeOrThrow(options?: {
    allowMissingSiteScope?: boolean;
  }) {
    return resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'ARR',
      options,
    );
  }

  private assertSiteAllowed(siteId: string): void {
    const scope = this.getSiteAccessScopeOrThrow();
    if (!scope.hasCompanyWideAccess && !scope.siteIds.includes(siteId)) {
      throw new ForbiddenException(
        'ARR fora do escopo de obra do usuário atual.',
      );
    }
  }

  private buildTenantScopedIdsWhere(ids: string[], tenantId: string) {
    return ids.map((id) => ({
      id,
      deleted_at: IsNull(),
      company_id: tenantId,
    }));
  }

  async create(createArrDto: CreateArrDto): Promise<Arr> {
    const { participants, company_id, ...rest } = createArrDto;
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
      responsavelId: rest.responsavel_id,
      participantIds,
    });

    const arr = this.arrRepository.create({
      ...rest,
      company_id: tenantId,
      participants: participantIds.map((id) => ({ id }) as User),
    });

    const saved = await this.arrRepository.save(arr);
    this.logger.log({
      event: 'arr_created',
      arrId: saved.id,
      companyId: saved.company_id,
    });
    return saved;
  }

  async findPaginated(opts?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: ArrStatus;
  }): Promise<OffsetPage<Arr>> {
    const scope = this.getSiteAccessScopeOrThrow({
      allowMissingSiteScope: true,
    });
    const tenantId = scope.companyId;
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const idsQuery = this.arrRepository
      .createQueryBuilder('arr')
      .select('arr.id', 'id')
      .where('arr.deleted_at IS NULL')
      .orderBy('arr.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    const countQuery = this.arrRepository
      .createQueryBuilder('arr')
      .where('arr.deleted_at IS NULL');

    idsQuery.andWhere('arr.company_id = :tenantId', { tenantId });
    countQuery.andWhere('arr.company_id = :tenantId', { tenantId });

    if (!scope.hasCompanyWideAccess) {
      if (scope.siteIds.length === 0) {
        idsQuery.andWhere('1 = 0');
        countQuery.andWhere('1 = 0');
      } else {
        idsQuery.andWhere('arr.site_id IN (:...currentSiteIds)', {
          currentSiteIds: scope.siteIds,
        });
        countQuery.andWhere('arr.site_id IN (:...currentSiteIds)', {
          currentSiteIds: scope.siteIds,
        });
      }
    }

    const searchTerm = normalizeOptionalSearchQuery(opts?.search);
    if (searchTerm) {
      const search = `%${escapeLikePattern(searchTerm.toLowerCase())}%`;
      const condition =
        "(LOWER(arr.titulo) LIKE :search ESCAPE '\\' OR LOWER(arr.atividade_principal) LIKE :search ESCAPE '\\' OR LOWER(COALESCE(arr.frente_trabalho, '')) LIKE :search ESCAPE '\\' OR LOWER(arr.risco_identificado) LIKE :search ESCAPE '\\')";
      idsQuery.andWhere(condition, { search });
      countQuery.andWhere(condition, { search });
    }

    if (opts?.status) {
      idsQuery.andWhere('arr.status = :status', { status: opts.status });
      countQuery.andWhere('arr.status = :status', { status: opts.status });
    }

    const [rows, total] = await Promise.all([
      idsQuery.getRawMany<{ id: string }>(),
      countQuery.getCount(),
    ]);

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return toOffsetPage([], total, page, limit);
    }

    const data = await this.arrRepository.find({
      where: this.buildTenantScopedIdsWhere(ids, tenantId),
      relations: ['site', 'responsavel', 'participants', 'company'],
    });

    const ordered = ids
      .map((id) => data.find((item) => item.id === id))
      .filter((item): item is Arr => Boolean(item));

    return toOffsetPage(ordered, total, page, limit);
  }

  async findOne(id: string): Promise<Arr> {
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;
    const arr = await this.arrRepository.findOne({
      where: {
        id,
        company_id: tenantId,
        deleted_at: IsNull(),
        ...(!scope.hasCompanyWideAccess ? { site_id: In(scope.siteIds) } : {}),
      },
      relations: ['site', 'responsavel', 'participants', 'company'],
    });

    if (!arr) {
      throw new NotFoundException(
        `Análise de Risco Rápida com ID ${id} não encontrada.`,
      );
    }

    return arr;
  }

  async update(id: string, updateArrDto: UpdateArrDto): Promise<Arr> {
    const arr = await this.findOne(id);
    this.assertFinalDocumentMutable(arr);

    const { participants, ...rest } = updateArrDto;
    if (rest.site_id) {
      this.assertSiteAllowed(rest.site_id);
    }
    const participantIds =
      participants !== undefined
        ? this.normalizeUniqueIds(participants)
        : this.getParticipantIds(arr);

    await this.assertRelationsBelongToCompany({
      companyId: arr.company_id,
      siteId: rest.site_id ?? arr.site_id,
      responsavelId: rest.responsavel_id ?? arr.responsavel_id,
      participantIds,
    });

    Object.assign(arr, rest);
    arr.participants = participantIds.map((participantId) => ({
      id: participantId,
    })) as User[];

    const saved = await this.arrRepository.save(arr);
    this.logger.log({
      event: 'arr_updated',
      arrId: saved.id,
      companyId: saved.company_id,
    });
    return saved;
  }

  async updateStatus(id: string, status: ArrStatus): Promise<Arr> {
    const arr = await this.findOne(id);
    this.assertFinalDocumentMutable(arr);

    if (arr.status === ArrStatus.ARQUIVADA) {
      throw new BadRequestException(
        'Documento arquivado não pode ter o status alterado.',
      );
    }

    const allowed = ARR_ALLOWED_TRANSITIONS[arr.status] || [];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Transição inválida: ${arr.status} → ${status}. Permitidas: ${allowed.join(', ') || 'nenhuma'}`,
      );
    }

    arr.status = status;
    const saved = await this.arrRepository.save(arr);
    this.logger.log({
      event: 'arr_status_updated',
      arrId: saved.id,
      companyId: saved.company_id,
      nextStatus: saved.status,
    });
    return saved;
  }

  async attachPdf(
    id: string,
    file: Express.Multer.File,
    context: ArrPdfEmissionContext = {},
  ): Promise<{
    fileKey: string;
    folderPath: string;
    originalName: string;
    storageMode: 's3';
    degraded: boolean;
    message: string;
  }> {
    const arr = await this.findOne(id);
    this.assertFinalDocumentMutable(arr);
    this.assertReadyForFinalDocument(arr);
    if (!arr.site_id) {
      throw new BadRequestException(
        'ARR sem obra/setor vinculado não pode receber PDF final.',
      );
    }

    const key = this.documentStorageService.generateDocumentKey(
      arr.company_id,
      'arr',
      arr.id,
      file.originalname,
      { folderSegments: ['sites', arr.site_id] },
    );
    const folder = key.split('/').slice(0, -1).join('/');
    const storageMode = 's3' as const;
    const documentCode = arr.document_code || this.buildArrDocumentCode(arr);
    const pdfGeneratedAt = new Date();

    await this.documentStorageService.uploadFile(
      key,
      file.buffer,
      file.mimetype,
    );

    try {
      const { hash } =
        await this.documentGovernanceService.registerFinalDocument({
          companyId: arr.company_id,
          module: 'arr',
          entityId: arr.id,
          title: arr.titulo || 'Análise de Risco Rápida',
          documentDate: arr.data || arr.created_at,
          documentCode,
          fileKey: key,
          folderPath: folder,
          originalName: file.originalname,
          mimeType: file.mimetype,
          createdBy: context.userId,
          fileBuffer: file.buffer,
          persistEntityMetadata: async (manager, computedHash) => {
            await manager.getRepository(Arr).update(id, {
              pdf_file_key: key,
              pdf_folder_path: folder,
              pdf_original_name: file.originalname,
              document_code: documentCode,
              final_pdf_hash_sha256: computedHash,
              pdf_generated_at: pdfGeneratedAt,
              emitted_by_user_id: context.userId ?? null,
              status:
                arr.status === ArrStatus.ANALISADA
                  ? ArrStatus.TRATADA
                  : arr.status,
            });
          },
        });
      if (!hash) {
        throw new BadRequestException(
          'Falha ao registrar a integridade do PDF final da ARR.',
        );
      }
    } catch (error) {
      await cleanupUploadedFile(this.logger, `arr:${arr.id}`, key, (fileKey) =>
        this.documentStorageService.deleteFile(fileKey),
      );
      throw error;
    }

    this.logger.log({
      event: 'arr_pdf_attached',
      arrId: arr.id,
      companyId: arr.company_id,
      fileKey: key,
      previousStatus: arr.status,
      nextStatus:
        arr.status === ArrStatus.ANALISADA ? ArrStatus.TRATADA : arr.status,
      documentCode,
      pdfGeneratedAt: pdfGeneratedAt.toISOString(),
      emittedByUserId: context.userId ?? null,
    });

    return {
      fileKey: key,
      folderPath: folder,
      originalName: file.originalname,
      storageMode,
      degraded: false,
      message:
        'PDF final da Análise de Risco Rápida emitido e registrado com sucesso.',
    };
  }

  async getPdfAccess(id: string): Promise<
    GovernedPdfAccessResponseDto & {
      degraded: boolean;
    }
  > {
    const arr = await this.findOne(id);

    if (!arr.pdf_file_key) {
      return {
        entityId: arr.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message:
          'A Análise de Risco Rápida ainda não possui PDF final emitido.',
        degraded: false,
        fileKey: null,
        folderPath: null,
        originalName: null,
        url: null,
      };
    }

    let availability: ArrPdfAccessAvailability = 'ready';
    let degraded = false;
    let url: string | null = null;
    let message = 'PDF final governado disponível para acesso.';

    try {
      url = await this.documentStorageService.getSignedUrl(
        arr.pdf_file_key,
        ARR_PDF_SIGNED_URL_EXPIRY_SECONDS,
      );
    } catch {
      availability = 'registered_without_signed_url';
      degraded = true;
      message =
        'PDF final registrado, mas a URL segura não está disponível no momento.';
    }

    return {
      entityId: arr.id,
      hasFinalPdf: true,
      availability,
      message,
      degraded,
      fileKey: arr.pdf_file_key,
      folderPath: arr.pdf_folder_path,
      originalName: arr.pdf_original_name,
      url,
    };
  }

  async remove(id: string): Promise<void> {
    const arr = await this.findOne(id);
    if (arr.pdf_file_key) {
      throw new BadRequestException(
        'Somente ARRs sem PDF final podem ser removidas. Use os fluxos formais de cancelamento/encerramento para registros já emitidos.',
      );
    }

    await this.documentGovernanceService.removeFinalDocumentReference({
      companyId: arr.company_id,
      module: 'arr',
      entityId: arr.id,
      trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
      trailMetadata: { removalMode: 'soft_delete' },
      removeEntityState: async (manager) => {
        await manager.getRepository(Arr).softDelete(id);
      },
      cleanupStoredFile: (fileKey) =>
        this.documentStorageService.deleteFile(fileKey),
    });

    this.logger.log({
      event: 'arr_archived',
      arrId: arr.id,
      companyId: arr.company_id,
    });
  }

  private assertReadyForFinalDocument(arr: Arr): void {
    if (arr.status === ArrStatus.RASCUNHO) {
      throw new BadRequestException(
        'O documento precisa estar analisado ou tratado antes da emissão do PDF final.',
      );
    }

    if (arr.status === ArrStatus.ARQUIVADA) {
      throw new BadRequestException(
        'Documento arquivado não pode ter PDF final emitido.',
      );
    }

    if (this.getParticipantIds(arr).length === 0) {
      throw new BadRequestException(
        'O documento precisa ter participantes definidos antes da emissão do PDF final.',
      );
    }
  }

  private assertFinalDocumentMutable(arr: Arr): void {
    if (arr.pdf_file_key) {
      throw new BadRequestException(
        'Documento com PDF final emitido. Gere um novo registro para alterações.',
      );
    }

    if (arr.status === ArrStatus.ARQUIVADA) {
      throw new BadRequestException(
        'Documento arquivado. Gere um novo registro para retomar o fluxo.',
      );
    }
  }

  private getParticipantIds(arr: Arr): string[] {
    return this.normalizeUniqueIds(
      (arr.participants || []).map((participant) => participant.id),
    );
  }

  private normalizeUniqueIds(ids?: string[]): string[] {
    return Array.from(new Set((ids || []).filter(Boolean)));
  }

  private async assertRelationsBelongToCompany(input: {
    companyId: string;
    siteId: string;
    responsavelId: string;
    participantIds: string[];
  }): Promise<void> {
    await this.assertSiteBelongsToCompany(input.siteId, input.companyId);
    await this.assertUsersBelongToCompany(
      [input.responsavelId],
      input.companyId,
      'Responsável',
      input.siteId,
    );
    await this.assertUsersBelongToCompany(
      input.participantIds,
      input.companyId,
      'Participantes',
      input.siteId,
    );
  }

  private async assertSiteBelongsToCompany(
    siteId: string,
    companyId: string,
  ): Promise<void> {
    const site = await this.arrRepository.manager.getRepository(Site).findOne({
      where: { id: siteId, company_id: companyId },
      select: ['id'],
    });

    if (!site) {
      throw new BadRequestException(
        'O site informado não pertence à empresa atual do documento.',
      );
    }
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

    const users = await this.arrRepository.manager.getRepository(User).find({
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

    const siteLinks = await this.arrRepository.manager
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
        `${label} informado(s) não pertencem à obra/setor selecionada do documento.`,
      );
    }
  }

  private buildArrDocumentCode(
    arr: Pick<Arr, 'id' | 'titulo' | 'data' | 'created_at'>,
  ): string {
    const candidateDate = arr.data
      ? new Date(arr.data)
      : arr.created_at
        ? new Date(arr.created_at)
        : new Date();
    const year = Number.isNaN(candidateDate.getTime())
      ? new Date().getFullYear()
      : candidateDate.getFullYear();
    const reference = String(arr.id || arr.titulo || 'ARR')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-8)
      .toUpperCase();

    return `ARR-${year}-${reference || String(Date.now()).slice(-6)}`;
  }
}
