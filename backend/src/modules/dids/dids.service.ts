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
import { Did, DidStatus, DID_ALLOWED_TRANSITIONS } from './entities/did.entity';
import { CreateDidDto } from './dto/create-did.dto';
import { UpdateDidDto } from './dto/update-did.dto';
import {
  cleanupUploadedFile,
  storageKeyFingerprint,
} from '../../shared/storage/storage-compensation.util';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';

export type DidPdfAccessAvailability = GovernedPdfAccessAvailability;

const DID_PDF_SIGNED_URL_EXPIRY_SECONDS = parseInt(
  process.env.DID_PDF_SIGNED_URL_EXPIRY_SECONDS || '900',
  10,
);

type DidPdfEmissionContext = {
  userId?: string;
};

type DidPeopleListItem = {
  id: string;
  nome: string;
  funcao: string | null;
  company_id: string;
  site_id: string | null;
  status: boolean;
};

@Injectable()
export class DidsService {
  private readonly logger = new Logger(DidsService.name);

  constructor(
    @InjectRepository(Did)
    private readonly didRepository: Repository<Did>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
  ) {}

  /**
   * Código documental + token de validação pública (grant) do DID.
   * Mesmo padrão do DDS: o código é determinístico (igual ao usado no anexo
   * do PDF final), então o token vale antes e depois da emissão.
   */
  async getValidationContext(
    id: string,
  ): Promise<{ documentCode: string; token: string | null }> {
    const did = await this.findOne(id);
    const documentCode = this.buildDidDocumentCode(did);
    let token: string | null = null;

    try {
      token = await this.publicValidationGrantService.issueToken({
        code: documentCode,
        companyId: did.company_id,
        portal: 'did_public_validation',
        documentId: did.id,
      });
    } catch (error) {
      this.logger.warn({
        event: 'did_validation_token_unavailable',
        didId: did.id,
        companyId: did.company_id,
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
      'DID',
      options,
    );
  }

  private assertSiteAllowed(siteId: string): void {
    const scope = this.getSiteAccessScopeOrThrow();
    if (!scope.hasCompanyWideAccess && !scope.siteIds.includes(siteId)) {
      throw new ForbiddenException(
        'DID fora do escopo de obra do usuário atual.',
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

  async create(createDidDto: CreateDidDto): Promise<Did> {
    const { participants, company_id, ...rest } = createDidDto;
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

    const did = this.didRepository.create({
      ...rest,
      company_id: tenantId,
      participants: participantIds.map((id) => ({ id }) as User),
    });

    const saved = await this.didRepository.save(did);
    this.logger.log({
      event: 'did_created',
      didId: saved.id,
      companyId: saved.company_id,
    });
    return saved;
  }

  async listPeople(opts?: {
    page?: number;
    limit?: number;
    siteId?: string;
  }): Promise<OffsetPage<DidPeopleListItem>> {
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

  async findPaginated(opts?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: DidStatus;
  }): Promise<OffsetPage<Did>> {
    const scope = this.getSiteAccessScopeOrThrow({
      allowMissingSiteScope: true,
    });
    const tenantId = scope.companyId;
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const idsQuery = this.didRepository
      .createQueryBuilder('did')
      .select('did.id', 'id')
      .where('did.deleted_at IS NULL')
      .orderBy('did.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    const countQuery = this.didRepository
      .createQueryBuilder('did')
      .where('did.deleted_at IS NULL');

    idsQuery.andWhere('did.company_id = :tenantId', { tenantId });
    countQuery.andWhere('did.company_id = :tenantId', { tenantId });

    if (!scope.hasCompanyWideAccess) {
      if (scope.siteIds.length === 0) {
        idsQuery.andWhere('1 = 0');
        countQuery.andWhere('1 = 0');
      } else {
        idsQuery.andWhere('did.site_id IN (:...currentSiteIds)', {
          currentSiteIds: scope.siteIds,
        });
        countQuery.andWhere('did.site_id IN (:...currentSiteIds)', {
          currentSiteIds: scope.siteIds,
        });
      }
    }

    const searchTerm = normalizeOptionalSearchQuery(opts?.search);
    if (searchTerm) {
      const search = `%${escapeLikePattern(searchTerm.toLowerCase())}%`;
      const condition =
        "(LOWER(did.titulo) LIKE :search ESCAPE '\\' OR LOWER(did.atividade_principal) LIKE :search ESCAPE '\\' OR LOWER(COALESCE(did.frente_trabalho, '')) LIKE :search ESCAPE '\\')";
      idsQuery.andWhere(condition, { search });
      countQuery.andWhere(condition, { search });
    }

    if (opts?.status) {
      idsQuery.andWhere('did.status = :status', { status: opts.status });
      countQuery.andWhere('did.status = :status', { status: opts.status });
    }

    const [rows, total] = await Promise.all([
      idsQuery.getRawMany<{ id: string }>(),
      countQuery.getCount(),
    ]);

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return toOffsetPage([], total, page, limit);
    }

    const data = await this.didRepository.find({
      where: this.buildTenantScopedIdsWhere(ids, tenantId),
      relations: ['site', 'responsavel', 'participants', 'company'],
    });

    const dataById = new Map(data.map((item) => [item.id, item] as const));
    const ordered = ids
      .map((id) => dataById.get(id))
      .filter((item): item is Did => Boolean(item));

    return toOffsetPage(ordered, total, page, limit);
  }

  async findOne(id: string): Promise<Did> {
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = scope.companyId;
    const did = await this.didRepository.findOne({
      where: {
        id,
        company_id: tenantId,
        deleted_at: IsNull(),
        ...(!scope.hasCompanyWideAccess ? { site_id: In(scope.siteIds) } : {}),
      },
      relations: ['site', 'responsavel', 'participants', 'company'],
    });

    if (!did) {
      throw new NotFoundException(
        `Diálogo do Início do Dia com ID ${id} não encontrado.`,
      );
    }

    return did;
  }

  async update(id: string, updateDidDto: UpdateDidDto): Promise<Did> {
    const did = await this.findOne(id);
    this.assertFinalDocumentMutable(did);

    const { participants, ...rest } = updateDidDto;
    if (rest.site_id) {
      this.assertSiteAllowed(rest.site_id);
    }
    const participantIds =
      participants !== undefined
        ? this.normalizeUniqueIds(participants)
        : this.getParticipantIds(did);

    await this.assertRelationsBelongToCompany({
      companyId: did.company_id,
      siteId: rest.site_id ?? did.site_id,
      responsavelId: rest.responsavel_id ?? did.responsavel_id,
      participantIds,
    });

    Object.assign(did, rest);
    did.participants = participantIds.map((participantId) => ({
      id: participantId,
    })) as User[];

    const saved = await this.didRepository.save(did);
    this.logger.log({
      event: 'did_updated',
      didId: saved.id,
      companyId: saved.company_id,
    });
    return saved;
  }

  async updateStatus(id: string, status: DidStatus): Promise<Did> {
    const did = await this.findOne(id);
    this.assertFinalDocumentMutable(did);

    if (did.status === DidStatus.ARQUIVADO) {
      throw new BadRequestException(
        'Documento arquivado não pode ter o status alterado.',
      );
    }

    const allowed = DID_ALLOWED_TRANSITIONS[did.status] || [];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Transição inválida: ${did.status} → ${status}. Permitidas: ${allowed.join(', ') || 'nenhuma'}`,
      );
    }

    did.status = status;
    const saved = await this.didRepository.save(did);
    this.logger.log({
      event: 'did_status_updated',
      didId: saved.id,
      companyId: saved.company_id,
      nextStatus: saved.status,
    });
    return saved;
  }

  async attachPdf(
    id: string,
    file: Express.Multer.File,
    context: DidPdfEmissionContext = {},
  ): Promise<{
    fileKey: string;
    folderPath: string;
    originalName: string;
    storageMode: 's3';
    degraded: boolean;
    message: string;
  }> {
    const did = await this.findOne(id);
    this.assertReadyForFinalDocument(did);
    if (!did.site_id) {
      throw new BadRequestException(
        'DID sem obra/setor vinculado não pode receber PDF final.',
      );
    }

    const key = this.documentStorageService.generateDocumentKey(
      did.company_id,
      'did',
      did.id,
      file.originalname,
      { folderSegments: ['sites', did.site_id] },
    );
    const folder = key.split('/').slice(0, -1).join('/');
    const storageMode = 's3' as const;

    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          key,
          { resourceType: 'did', resourceId: did.id },
          'p1-document-storage-uploadFile',
        ),
        file.buffer,
        file.mimetype,
      );

    try {
      await this.documentGovernanceService.registerFinalDocument({
        companyId: did.company_id,
        module: 'did',
        entityId: did.id,
        title: did.titulo || 'Diálogo do Início do Dia',
        documentDate: did.data || did.created_at,
        documentCode: this.buildDidDocumentCode(did),
        fileKey: key,
        folderPath: folder,
        originalName: file.originalname,
        mimeType: file.mimetype,
        createdBy: context.userId,
        fileBuffer: file.buffer,
        persistEntityMetadata: async (manager) => {
          await manager.getRepository(Did).update(id, {
            pdf_file_key: key,
            pdf_folder_path: folder,
            pdf_original_name: file.originalname,
            status:
              did.status === DidStatus.ALINHADO
                ? DidStatus.EXECUTADO
                : did.status,
          });
        },
      });
    } catch (error) {
      await cleanupUploadedFile(this.logger, `did:${did.id}`, key, (fileKey) =>
        uploadedReference.key === fileKey
          ? this.documentStorageService.deleteFile(uploadedReference)
          : Promise.resolve(),
      );
      throw error;
    }

    this.logger.log({
      event: 'did_pdf_attached',
      didId: did.id,
      companyId: did.company_id,
      keyFingerprint: storageKeyFingerprint(key),
      previousStatus: did.status,
      nextStatus:
        did.status === DidStatus.ALINHADO ? DidStatus.EXECUTADO : did.status,
      emittedByUserId: context.userId ?? null,
    });

    return {
      fileKey: key,
      folderPath: folder,
      originalName: file.originalname,
      storageMode,
      degraded: false,
      message:
        'PDF final do Diálogo do Início do Dia emitido e registrado com sucesso.',
    };
  }

  async getPdfAccess(id: string): Promise<
    GovernedPdfAccessResponseDto & {
      degraded: boolean;
    }
  > {
    const did = await this.findOne(id);

    if (!did.pdf_file_key) {
      return {
        entityId: did.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message:
          'O Diálogo do Início do Dia ainda não possui PDF final emitido.',
        degraded: false,
        fileKey: null,
        folderPath: null,
        originalName: null,
        url: null,
      };
    }

    let availability: DidPdfAccessAvailability = 'ready';
    let degraded = false;
    let url: string | null = null;
    let message = 'PDF final governado disponível para acesso.';

    try {
      url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          did.pdf_file_key,
          {
            resourceType: 'did',
            resourceId: did.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
        DID_PDF_SIGNED_URL_EXPIRY_SECONDS,
      );
    } catch {
      availability = 'registered_without_signed_url';
      degraded = true;
      message =
        'PDF final registrado, mas a URL segura não está disponível no momento.';
    }

    return {
      entityId: did.id,
      hasFinalPdf: true,
      availability,
      message,
      degraded,
      fileKey: did.pdf_file_key,
      folderPath: did.pdf_folder_path,
      originalName: did.pdf_original_name,
      url,
    };
  }

  async remove(id: string): Promise<void> {
    const did = await this.findOne(id);
    if (did.pdf_file_key) {
      throw new BadRequestException(
        'Somente DIDs sem PDF final podem ser removidos. Use os fluxos formais de cancelamento/encerramento para registros já emitidos.',
      );
    }

    await this.documentGovernanceService.removeFinalDocumentReference({
      companyId: did.company_id,
      module: 'did',
      entityId: did.id,
      trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
      trailMetadata: { removalMode: 'soft_delete' },
      removeEntityState: async (manager) => {
        await manager.getRepository(Did).softDelete(id);
      },
      cleanupStoredFile: (fileKey) =>
        this.documentStorageService.deleteFile(
          this.documentStorageService.referenceForExistingObject(
            fileKey,
            { resourceType: 'did', resourceId: did.id },
            'p1-document-storage-deleteFile',
          ),
        ),
    });

    this.logger.log({
      event: 'did_archived',
      didId: did.id,
      companyId: did.company_id,
    });
  }

  private assertReadyForFinalDocument(did: Did): void {
    if (did.status === DidStatus.RASCUNHO) {
      throw new BadRequestException(
        'O documento precisa estar alinhado, executado ou arquivado antes da emissão do PDF final.',
      );
    }

    if (did.pdf_file_key) {
      throw new BadRequestException(
        'Documento com PDF final emitido. Gere um novo registro para alterações.',
      );
    }

    if (this.getParticipantIds(did).length === 0) {
      throw new BadRequestException(
        'O documento precisa ter participantes definidos antes da emissão do PDF final.',
      );
    }
  }

  private assertFinalDocumentMutable(did: Did): void {
    if (did.pdf_file_key) {
      throw new BadRequestException(
        'Documento com PDF final emitido. Gere um novo registro para alterações.',
      );
    }

    if (did.status === DidStatus.ARQUIVADO) {
      throw new BadRequestException(
        'Documento arquivado. Gere um novo registro para retomar o fluxo.',
      );
    }
  }

  private getParticipantIds(did: Did): string[] {
    return this.normalizeUniqueIds(
      (did.participants || []).map((participant) => participant.id),
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
    const site = await this.didRepository.manager.getRepository(Site).findOne({
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

    const users = await this.didRepository.manager.getRepository(User).find({
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

    const siteLinks = await this.didRepository.manager
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

  private buildDidDocumentCode(
    did: Pick<Did, 'id' | 'titulo' | 'data' | 'created_at'>,
  ): string {
    const candidateDate = did.data
      ? new Date(did.data)
      : did.created_at
        ? new Date(did.created_at)
        : new Date();
    const year = Number.isNaN(candidateDate.getTime())
      ? new Date().getFullYear()
      : candidateDate.getFullYear();
    const reference = String(did.id || did.titulo || 'DID')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-8)
      .toUpperCase();

    return `DID-${year}-${reference || String(Date.now()).slice(-6)}`;
  }
}
