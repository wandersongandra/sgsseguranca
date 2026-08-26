import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Audit } from './entities/audit.entity';
import { CreateAuditDto } from './dto/create-audit.dto';
import { UpdateAuditDto } from './dto/create-audit.dto';
import { User } from '../users/entities/user.entity';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import {
  TenantRepository,
  TenantRepositoryFactory,
} from '../../shared/tenant/tenant-repository';
import {
  DocumentBundleService,
  WeeklyBundleFilters,
} from '../../shared/services/document-bundle.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import {
  cleanupUploadedFile,
  storageKeyFingerprint,
} from '../../shared/storage/storage-compensation.util';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import { TenantService } from '../../shared/tenant/tenant.service';
import {
  ResolvedSiteAccessScope,
  isCompanyWideProfile,
  resolveSiteAccessScopeFromTenantService,
} from '../../shared/tenant/site-access-scope.util';
import { escapeLikePattern } from '../../shared/utils/sql.util';
import { normalizeOptionalSearchQuery } from '../../shared/utils/query-normalization.util';
import {
  GovernedPdfAccessAvailability,
  GovernedPdfAccessResponseDto,
} from '../../shared/dto/governed-pdf-access-response.dto';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';
import {
  coerceDocumentDate,
  getIsoWeekNumber,
} from '../../shared/utils/document-calendar.util';

type AuditPdfAccessAvailability = GovernedPdfAccessAvailability;
type AuditPdfAccessResponse = GovernedPdfAccessResponseDto;
type AuditNonComplianceClassification = NonNullable<
  CreateAuditDto['resultados_nao_conformidades']
>[number]['classificacao'];
type AuditChecklistAnswer = NonNullable<
  CreateAuditDto['checklist_respostas']
>[number];
type AuditChecklistEvidence = NonNullable<
  NonNullable<AuditChecklistAnswer['evidences']>
>[number];

type AuditorSiteLink = {
  site_id: string;
};

@Injectable()
export class AuditsService {
  private readonly logger = new Logger(AuditsService.name);
  private readonly tenantRepo: TenantRepository<Audit>;

  constructor(
    @InjectRepository(Audit)
    private auditsRepository: Repository<Audit>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    tenantRepositoryFactory: TenantRepositoryFactory,
    private readonly documentStorageService: DocumentStorageService,
    private readonly documentBundleService: DocumentBundleService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
    @Optional() private readonly tenantService?: TenantService,
  ) {
    this.tenantRepo = tenantRepositoryFactory.wrap(this.auditsRepository);
  }

  /**
   * Código documental + token de validação pública (grant) da auditoria.
   * O código replica o default do documento governado (module-ANO-SEMANA-ID8),
   * o mesmo gerado pelo registry no anexo do PDF final.
   */
  async getValidationContext(
    id: string,
    companyId: string,
  ): Promise<{ documentCode: string; token: string | null }> {
    const audit = await this.findOne(id, companyId);
    const documentDate =
      coerceDocumentDate(audit.data_auditoria) ||
      coerceDocumentDate(audit.created_at) ||
      new Date();
    const year = documentDate.getFullYear();
    const week = String(getIsoWeekNumber(documentDate) || 1).padStart(2, '0');
    const documentCode = `AUDIT-${year}-${week}-${audit.id.slice(0, 8).toUpperCase()}`;
    let token: string | null = null;

    try {
      token = await this.publicValidationGrantService.issueToken({
        code: documentCode,
        companyId: audit.company_id,
        portal: 'audit_public_validation',
        documentId: audit.id,
      });
    } catch (error) {
      this.logger.warn({
        event: 'audit_validation_token_unavailable',
        auditId: audit.id,
        companyId: audit.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return { documentCode, token };
  }

  private getSiteAccessScopeOrThrow(): ResolvedSiteAccessScope {
    if (!this.tenantService) {
      throw new BadRequestException(
        'Contexto de tenant obrigatório para auditorias.',
      );
    }

    return resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'auditorias',
    );
  }

  private assertCompanyScope(
    companyId: string,
    scope: ResolvedSiteAccessScope,
  ) {
    if (companyId !== scope.companyId) {
      throw new NotFoundException(`Auditoria não encontrada`);
    }
  }

  private assertSiteAllowed(siteId: string, scope: ResolvedSiteAccessScope) {
    if (!scope.hasCompanyWideAccess && !scope.siteIds.includes(siteId)) {
      throw new NotFoundException(`Auditoria não encontrada`);
    }
  }

  private resolveUserSiteIds(user: {
    site_id?: string | null;
    site_links?: AuditorSiteLink[] | null;
  }): string[] {
    return [
      user.site_id,
      ...(user.site_links?.map((link) => link.site_id) ?? []),
    ]
      .map((siteId) => siteId?.trim())
      .filter((siteId): siteId is string => Boolean(siteId));
  }

  private normalizeRequiredText(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException(`${label} é obrigatório.`);
    }

    return normalized;
  }

  private normalizeOptionalText(value?: string | null): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
  }

  private normalizeStringArray(
    values?: Array<string | null | undefined> | null,
  ): string[] | undefined {
    const normalized = (values ?? [])
      .map((value) => this.normalizeOptionalText(value))
      .filter((value): value is string => Boolean(value));

    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeObjectArray<T extends object>(
    values: T[] | undefined | null,
    mapper: (value: T) => T,
  ): T[] | undefined {
    const normalized = (values ?? [])
      .map((value) => mapper(value))
      .filter((value) =>
        Object.values(value).every((entry) => {
          if (typeof entry === 'string') {
            return entry.trim().length > 0;
          }
          return Boolean(entry);
        }),
      );

    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeChecklistEvidence(
    evidence: AuditChecklistEvidence,
  ): AuditChecklistEvidence | null {
    const dataUrl = this.normalizeOptionalText(evidence.dataUrl);
    const fileName = this.normalizeOptionalText(evidence.fileName);
    const id = this.normalizeOptionalText(evidence.id);
    const capturedAt = this.normalizeOptionalText(evidence.capturedAt);

    if (!dataUrl || !fileName || !id || !capturedAt) {
      return null;
    }

    if (!dataUrl.startsWith('data:image/')) {
      return null;
    }

    return {
      id,
      fileName,
      mimeType: evidence.mimeType,
      size: evidence.size,
      dataUrl,
      capturedAt,
      hash: this.normalizeOptionalText(evidence.hash),
    };
  }

  private normalizeChecklistAnswers(
    values?: AuditChecklistAnswer[] | null,
  ): AuditChecklistAnswer[] | undefined {
    const normalized = (values ?? [])
      .slice(0, 80)
      .map((item): AuditChecklistAnswer | null => {
        const sectionId = this.normalizeOptionalText(item.sectionId);
        const sectionTitle = this.normalizeOptionalText(item.sectionTitle);
        const questionId = this.normalizeOptionalText(item.questionId);
        const question = this.normalizeOptionalText(item.question);
        const requirement = this.normalizeOptionalText(item.requirement);

        if (
          !sectionId ||
          !sectionTitle ||
          !questionId ||
          !question ||
          !requirement
        ) {
          return null;
        }

        const evidences = (item.evidences ?? [])
          .slice(0, 3)
          .map((evidence) => this.normalizeChecklistEvidence(evidence))
          .filter(
            (evidence): evidence is AuditChecklistEvidence => evidence !== null,
          );

        return {
          sectionId,
          sectionTitle,
          questionId,
          question,
          requirement,
          criticality: item.criticality,
          answer: item.answer,
          observation: this.normalizeOptionalText(item.observation),
          allowsPhoto: Boolean(item.allowsPhoto),
          photoRequiredWhen: item.photoRequiredWhen,
          suggestedAction: this.normalizeOptionalText(item.suggestedAction),
          evidences: evidences.length > 0 ? evidences : undefined,
        };
      })
      .filter((item): item is AuditChecklistAnswer => item !== null);

    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeAuditPayload(
    auditDto: CreateAuditDto | UpdateAuditDto,
  ): CreateAuditDto | UpdateAuditDto {
    const caracterizacao = auditDto.caracterizacao
      ? {
          cnae: this.normalizeOptionalText(auditDto.caracterizacao.cnae),
          grau_risco: this.normalizeOptionalText(
            auditDto.caracterizacao.grau_risco,
          ),
          num_trabalhadores:
            typeof auditDto.caracterizacao.num_trabalhadores === 'number'
              ? auditDto.caracterizacao.num_trabalhadores
              : undefined,
          turnos: this.normalizeOptionalText(auditDto.caracterizacao.turnos),
          atividades_principais: this.normalizeOptionalText(
            auditDto.caracterizacao.atividades_principais,
          ),
        }
      : undefined;

    const normalizedCaracterizacao =
      caracterizacao &&
      Object.values(caracterizacao).some(
        (value) => value !== undefined && value !== null && value !== '',
      )
        ? caracterizacao
        : undefined;

    return {
      ...auditDto,
      titulo: this.normalizeRequiredText(auditDto.titulo, 'Título'),
      data_auditoria: this.normalizeRequiredText(
        auditDto.data_auditoria,
        'Data da auditoria',
      ),
      tipo_auditoria: this.normalizeRequiredText(
        auditDto.tipo_auditoria,
        'Tipo de auditoria',
      ),
      site_id: this.normalizeRequiredText(auditDto.site_id, 'Site'),
      auditor_id: this.normalizeRequiredText(auditDto.auditor_id, 'Auditor'),
      representantes_empresa: this.normalizeOptionalText(
        auditDto.representantes_empresa,
      ),
      objetivo: this.normalizeOptionalText(auditDto.objetivo),
      escopo: this.normalizeOptionalText(auditDto.escopo),
      referencias: this.normalizeStringArray(auditDto.referencias),
      metodologia: this.normalizeOptionalText(auditDto.metodologia),
      caracterizacao: normalizedCaracterizacao,
      documentos_avaliados: this.normalizeStringArray(
        auditDto.documentos_avaliados,
      ),
      resultados_conformidades: this.normalizeStringArray(
        auditDto.resultados_conformidades,
      ),
      resultados_nao_conformidades: this.normalizeObjectArray(
        auditDto.resultados_nao_conformidades ?? undefined,
        (item) => ({
          descricao: this.normalizeOptionalText(item.descricao) ?? '',
          requisito: this.normalizeOptionalText(item.requisito) ?? '',
          evidencia: this.normalizeOptionalText(item.evidencia) ?? '',
          classificacao: (this.normalizeOptionalText(item.classificacao) ??
            '') as AuditNonComplianceClassification,
        }),
      ),
      resultados_observacoes: this.normalizeStringArray(
        auditDto.resultados_observacoes,
      ),
      resultados_oportunidades: this.normalizeStringArray(
        auditDto.resultados_oportunidades,
      ),
      avaliacao_riscos: this.normalizeObjectArray(
        auditDto.avaliacao_riscos ?? undefined,
        (item) => ({
          perigo: this.normalizeOptionalText(item.perigo) ?? '',
          classificacao: this.normalizeOptionalText(item.classificacao) ?? '',
          impactos: this.normalizeOptionalText(item.impactos) ?? '',
          medidas_controle:
            this.normalizeOptionalText(item.medidas_controle) ?? '',
        }),
      ),
      plano_acao: this.normalizeObjectArray(
        auditDto.plano_acao ?? undefined,
        (item) => ({
          item: this.normalizeOptionalText(item.item) ?? '',
          acao: this.normalizeOptionalText(item.acao) ?? '',
          responsavel: this.normalizeOptionalText(item.responsavel) ?? '',
          prazo: this.normalizeOptionalText(item.prazo) ?? '',
          status: this.normalizeOptionalText(item.status) ?? '',
        }),
      ),
      checklist_respostas: this.normalizeChecklistAnswers(
        auditDto.checklist_respostas,
      ),
      conclusao: this.normalizeOptionalText(auditDto.conclusao),
    };
  }

  private async assertAuditorAllowed(
    auditorId: string,
    siteId: string,
    scope: ResolvedSiteAccessScope,
  ) {
    const auditor = await this.usersRepository.findOne({
      where: {
        id: auditorId,
        company_id: scope.companyId,
      },
      relations: ['profile', 'site_links'],
      select: {
        id: true,
        company_id: true,
        site_id: true,
      },
    });

    if (!auditor) {
      throw new NotFoundException('Auditor não encontrado');
    }

    const isCompanyWideAuditor = isCompanyWideProfile(auditor.profile?.nome);
    const auditorSiteIds = this.resolveUserSiteIds(auditor);

    if (auditorSiteIds.length === 0 && !isCompanyWideAuditor) {
      throw new BadRequestException(
        'Auditor sem obra só pode ser usado para perfis corporativos.',
      );
    }

    if (!isCompanyWideAuditor && siteId && !auditorSiteIds.includes(siteId)) {
      throw new BadRequestException(
        'Auditor informado não pertence à obra selecionada.',
      );
    }
  }

  async create(createAuditDto: CreateAuditDto, companyId: string) {
    const scope = this.getSiteAccessScopeOrThrow();
    this.assertCompanyScope(companyId, scope);
    const normalizedAudit = this.normalizeAuditPayload(createAuditDto);
    this.assertSiteAllowed(normalizedAudit.site_id, scope);
    await this.assertAuditorAllowed(
      normalizedAudit.auditor_id,
      normalizedAudit.site_id,
      scope,
    );
    const audit = this.auditsRepository.create({
      ...normalizedAudit,
      company_id: scope.companyId,
    });
    const saved = await this.auditsRepository.save(audit);
    this.logger.log({
      event: 'audit_created',
      auditId: saved.id,
      companyId,
    });
    return saved;
  }

  async findAll(companyId: string) {
    const scope = this.getSiteAccessScopeOrThrow();
    this.assertCompanyScope(companyId, scope);
    return await this.auditsRepository.find({
      where: {
        company_id: scope.companyId,
        deleted_at: IsNull(),
        ...(!scope.hasCompanyWideAccess ? { site_id: In(scope.siteIds) } : {}),
      },
      relations: ['site', 'auditor'],
      order: { created_at: 'DESC' },
      take: 100,
    });
  }

  async findPaginated(
    opts: { page?: number; limit?: number; search?: string },
    companyId: string,
  ): Promise<OffsetPage<Audit>> {
    const scope = this.getSiteAccessScopeOrThrow();
    this.assertCompanyScope(companyId, scope);
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const qb = this.auditsRepository
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.site', 'site')
      .leftJoinAndSelect('a.auditor', 'auditor')
      .where('a.company_id = :companyId', { companyId })
      .andWhere('a.deleted_at IS NULL')
      .orderBy('a.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    if (!scope.hasCompanyWideAccess) {
      qb.andWhere('a.site_id IN (:...siteIds)', { siteIds: scope.siteIds });
    }

    const searchTerm = normalizeOptionalSearchQuery(opts?.search);
    if (searchTerm) {
      const search = `%${escapeLikePattern(searchTerm)}%`;
      qb.andWhere(
        "(a.titulo ILIKE :search ESCAPE '\\' OR a.tipo_auditoria ILIKE :search ESCAPE '\\')",
        { search },
      );
    }

    const [data, total] = await qb.getManyAndCount();
    return toOffsetPage(data, total, page, limit);
  }

  async countPendingActionItems(companyId?: string): Promise<number> {
    const scope = this.getSiteAccessScopeOrThrow();
    const tenantId = companyId || scope.companyId;
    this.assertCompanyScope(tenantId, scope);
    const params = scope.hasCompanyWideAccess
      ? [tenantId]
      : [tenantId, scope.siteIds];
    const siteClause = scope.hasCompanyWideAccess
      ? ''
      : ' AND a.site_id = ANY($2::uuid[])';

    const rows: Array<{ total?: number | string }> =
      await this.auditsRepository.query(
        `
        SELECT COALESCE(
          SUM(
            (
              SELECT COUNT(*)
              FROM jsonb_array_elements(COALESCE(a.plano_acao::jsonb, '[]'::jsonb)) AS item
              WHERE LOWER(COALESCE(item->>'status', '')) NOT LIKE '%conclu%'
                AND LOWER(COALESCE(item->>'status', '')) NOT LIKE '%encerr%'
            )
          ),
          0
        )::int AS total
        FROM audits a
        WHERE a.company_id = $1 AND a.deleted_at IS NULL
          ${siteClause}
      `,
        params,
      );

    return Number(rows[0]?.total ?? 0);
  }

  async findOne(id: string, companyId: string) {
    const scope = this.getSiteAccessScopeOrThrow();
    this.assertCompanyScope(companyId, scope);
    const audit = await this.tenantRepo.findOne(id, scope.companyId, {
      relations: ['site', 'auditor', 'company'],
    });

    if (
      !audit ||
      (!scope.hasCompanyWideAccess && !scope.siteIds.includes(audit.site_id))
    ) {
      throw new NotFoundException(`Auditoria com ID ${id} não encontrada`);
    }

    return audit;
  }

  async update(id: string, updateAuditDto: UpdateAuditDto, companyId: string) {
    const audit = await this.findOne(id, companyId);
    const scope = this.getSiteAccessScopeOrThrow();
    const normalizedAudit = this.normalizeAuditPayload(updateAuditDto);
    this.assertSiteAllowed(normalizedAudit.site_id, scope);
    if (audit.pdf_file_key) {
      throw new BadRequestException(
        'Auditoria com PDF final anexado. Edição bloqueada. Gere uma nova auditoria para alterar o documento.',
      );
    }
    await this.assertAuditorAllowed(
      normalizedAudit.auditor_id,
      normalizedAudit.site_id,
      scope,
    );
    Object.assign(audit, normalizedAudit);
    const saved = await this.auditsRepository.save(audit);
    this.logger.log({
      event: 'audit_updated',
      auditId: saved.id,
      companyId,
    });
    return saved;
  }

  async remove(id: string, companyId: string) {
    const audit = await this.findOne(id, companyId);
    const auditId = audit.id;
    if (audit.pdf_file_key) {
      throw new BadRequestException(
        'Somente auditorias sem PDF final podem ser removidas. Use os fluxos formais de cancelamento/encerramento para registros já emitidos.',
      );
    }
    await this.documentGovernanceService.removeFinalDocumentReference({
      companyId: audit.company_id,
      module: 'audit',
      entityId: auditId,
      trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
      trailMetadata: {
        removalMode: 'soft_delete',
      },
      removeEntityState: async (manager) => {
        await manager.getRepository(Audit).softDelete(auditId);
      },
      cleanupStoredFile: (fileKey) =>
        this.documentStorageService.deleteFile(
          this.documentStorageService.referenceForExistingObject(
            fileKey,
            { resourceType: 'audit', resourceId: auditId },
            'p1-document-storage-deleteFile',
          ),
        ),
    });
    this.logger.log({
      event: 'audit_removed',
      auditId,
      companyId,
    });
  }

  async attachPdf(
    id: string,
    companyId: string,
    file: Express.Multer.File,
    userId?: string,
  ): Promise<{ fileKey: string; folderPath: string; originalName: string }> {
    const audit = await this.findOne(id, companyId);
    if (audit.pdf_file_key) {
      throw new BadRequestException(
        'Esta auditoria já possui PDF final anexado. Gere uma nova auditoria para substituir o documento.',
      );
    }
    if (!audit.site_id) {
      throw new BadRequestException(
        'Auditoria sem obra/setor vinculado não pode receber PDF final.',
      );
    }

    const key = this.documentStorageService.generateDocumentKey(
      audit.company_id,
      'audits',
      audit.id,
      file.originalname,
      { folderSegments: ['sites', audit.site_id] },
    );
    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          key,
          { resourceType: 'audit', resourceId: audit.id },
          'p1-document-storage-uploadFile',
        ),
        file.buffer,
        file.mimetype,
      );
    const uploadedToStorage = true;

    const folder = key.split('/').slice(0, -1).join('/');
    try {
      await this.documentGovernanceService.registerFinalDocument({
        companyId: audit.company_id,
        module: 'audit',
        entityId: audit.id,
        title: audit.titulo || 'Auditoria',
        documentDate: audit.data_auditoria || audit.created_at,
        fileKey: key,
        folderPath: folder,
        originalName: file.originalname,
        mimeType: file.mimetype,
        createdBy: userId || undefined,
        fileBuffer: file.buffer,
        persistEntityMetadata: async (manager, computedHash) => {
          await manager.getRepository(Audit).update(id, {
            pdf_file_key: key,
            pdf_folder_path: folder,
            pdf_original_name: file.originalname,
            pdf_file_hash: computedHash,
            pdf_generated_at: new Date(),
          });
        },
      });
    } catch (error) {
      if (uploadedToStorage) {
        await cleanupUploadedFile(
          this.logger,
          `audit:${audit.id}`,
          key,
          (fileKey) =>
            uploadedReference.key === fileKey
              ? this.documentStorageService.deleteFile(uploadedReference)
              : Promise.resolve(),
        );
      }
      throw error;
    }

    this.logger.log({
      event: 'audit_pdf_attached',
      auditId: audit.id,
      companyId: audit.company_id,
      userId,
      keyFingerprint: storageKeyFingerprint(key),
    });

    return {
      fileKey: key,
      folderPath: folder,
      originalName: file.originalname,
    };
  }

  async getPdfAccess(
    id: string,
    companyId: string,
  ): Promise<AuditPdfAccessResponse> {
    const audit = await this.findOne(id, companyId);
    if (!audit.pdf_file_key) {
      return {
        entityId: audit.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message: 'PDF final ainda não emitido para esta auditoria.',
        fileKey: null,
        folderPath: audit.pdf_folder_path ?? null,
        originalName: audit.pdf_original_name ?? null,
        url: null,
      };
    }

    let url: string | null;
    let availability: AuditPdfAccessAvailability = 'ready';
    let message: string | null = null;
    try {
      url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          audit.pdf_file_key,
          {
            resourceType: 'audit',
            resourceId: audit.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
        3600,
      );
    } catch {
      url = null;
      availability = 'registered_without_signed_url';
      message =
        'PDF final emitido, mas a URL segura não está disponível no momento.';
    }

    return {
      entityId: audit.id,
      hasFinalPdf: true,
      availability,
      message,
      fileKey: audit.pdf_file_key,
      folderPath: audit.pdf_folder_path ?? null,
      originalName: audit.pdf_original_name ?? null,
      url,
    };
  }

  async listStoredFiles(filters: WeeklyBundleFilters) {
    const files = await this.documentGovernanceService.listFinalDocuments(
      'audit',
      filters,
    );
    const scope = this.tenantService
      ? resolveSiteAccessScopeFromTenantService(
          this.tenantService,
          'auditorias',
        )
      : undefined;
    if (!scope || scope.hasCompanyWideAccess || files.length === 0) {
      return files;
    }

    const visibleAudits = await this.auditsRepository.find({
      select: { id: true },
      where: {
        id: In(files.map((file) => file.entityId)),
        company_id: scope.companyId,
        site_id: In(scope.siteIds),
        deleted_at: IsNull(),
      },
    });
    const visibleIds = new Set(visibleAudits.map((audit) => audit.id));

    return files.filter((file) => visibleIds.has(file.entityId));
  }

  async getWeeklyBundle(filters: WeeklyBundleFilters) {
    const files = await this.listStoredFiles(filters);
    return this.documentBundleService.buildWeeklyPdfBundle(
      'Auditoria',
      filters,
      files.map((file) => ({
        fileKey: file.fileKey,
        resourceType: 'audit',
        resourceId: file.entityId,
        title: file.title,
        originalName: file.originalName,
        date: file.date,
      })),
    );
  }
}
