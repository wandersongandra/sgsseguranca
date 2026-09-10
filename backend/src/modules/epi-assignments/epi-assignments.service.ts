import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Role } from '../auth/enums/roles.enum';
import { AuditService } from '../audit-trail/audit.service';
import { AuditAction } from '../audit-trail/enums/audit-action.enum';
import { SignatureTimestampService } from '../../shared/services/signature-timestamp.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { PdfService } from '../../shared/services/pdf.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import type { GovernedPdfAccessResponseDto } from '../../shared/dto/governed-pdf-access-response.dto';
import { cleanupUploadedFile } from '../../shared/storage/storage-compensation.util';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import {
  normalizeOffsetPagination,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { Epi } from '../epis/entities/epi.entity';
import { Site } from '../sites/entities/site.entity';
import { User } from '../users/entities/user.entity';
import {
  CreateEpiAssignmentDto,
  EpiSignatureInputDto,
} from './dto/create-epi-assignment.dto';
import {
  ReplaceEpiAssignmentDto,
  ReturnEpiAssignmentDto,
} from './dto/return-epi-assignment.dto';
import { UpdateEpiAssignmentDto } from './dto/update-epi-assignment.dto';
import {
  EpiAssignment,
  EpiSignatureStamp,
} from './entities/epi-assignment.entity';
import { buildEpiAssignmentPdfHtml } from './epi-assignment-pdf.template';
import { INSTITUTIONAL_PDF_FOOTER_TEMPLATE } from '../../shared/services/pdf-institutional-template';

const EPI_PDF_SIGNED_URL_EXPIRY_SECONDS = 900;

@Injectable()
export class EpiAssignmentsService {
  private readonly logger = new Logger(EpiAssignmentsService.name);

  constructor(
    @InjectRepository(EpiAssignment)
    private readonly assignmentsRepository: Repository<EpiAssignment>,
    @InjectRepository(Epi)
    private readonly episRepository: Repository<Epi>,
    @InjectRepository(Site)
    private readonly sitesRepository: Repository<Site>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly tenantService: TenantService,
    private readonly signatureTimestampService: SignatureTimestampService,
    private readonly auditService: AuditService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly pdfService: PdfService,
    private readonly documentGovernanceService: DocumentGovernanceService,
  ) {}

  async create(
    dto: CreateEpiAssignmentDto,
    actorId?: string,
  ): Promise<EpiAssignment> {
    const scope = this.getSiteAccessScopeOrThrow();
    const companyId = scope.companyId;
    const effectiveSiteId = !scope.hasCompanyWideAccess
      ? (dto.site_id ?? scope.siteId)
      : dto.site_id;
    if (!scope.hasCompanyWideAccess && effectiveSiteId !== scope.siteId) {
      throw new BadRequestException(
        'Ficha EPI deve ser lançada na obra atual.',
      );
    }

    // SGS-EPI-SEC-008: validate site belongs to this company (company-wide
    // actors bypass the site-scope check above but must still not reference
    // sites from other tenants).
    if (effectiveSiteId) {
      const site = await this.sitesRepository.findOne({
        where: { id: effectiveSiteId, company_id: companyId },
      });
      if (!site) {
        throw new NotFoundException('Obra não encontrada para esta empresa.');
      }
    }

    const [epi, user] = await Promise.all([
      this.episRepository.findOne({
        where: { id: dto.epi_id, company_id: companyId },
      }),
      this.usersRepository.findOne({
        where: { id: dto.user_id, company_id: companyId },
      }),
    ]);

    if (!epi) {
      throw new NotFoundException('EPI não encontrado para esta empresa.');
    }
    if (!user) {
      throw new NotFoundException(
        'Colaborador não encontrado para esta empresa.',
      );
    }

    // SGS-EPI-BR-006: block delivery of inactive or expired-CA EPIs (NR-6)
    if (epi.status === false) {
      throw new BadRequestException(
        'EPI inativo no catálogo não pode ser entregue.',
      );
    }
    if (epi.validade_ca) {
      const validade = new Date(epi.validade_ca);
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      if (!Number.isNaN(validade.getTime()) && validade < hoje) {
        throw new BadRequestException(
          `CA ${epi.ca ?? ''} vencido em ${validade.toISOString().slice(0, 10)}. Atualize o CA antes de entregar (NR-6).`,
        );
      }
    }

    const assinaturaEntrega = this.buildSignatureStamp(
      dto.assinatura_entrega,
      actorId,
      actorId !== user.id ? user.id : undefined,
    );

    // SGS-EPI-BR-007: atomic stock check-and-decrement inside a transaction with
    // pessimistic lock on the EPI row to prevent TOCTOU race conditions when two
    // concurrent requests try to deliver the last unit simultaneously.
    const saved = await this.assignmentsRepository.manager.transaction(
      async (trx) => {
        const epiRepo = trx.getRepository(Epi);
        let lockedEpi: Epi | null;
        try {
          lockedEpi = await epiRepo.findOne({
            where: { id: dto.epi_id, company_id: companyId },
            lock: { mode: 'pessimistic_write', onLocked: 'nowait' },
          });
        } catch (err) {
          const e = err as { code?: string };
          if (e?.code === '55P03') {
            throw new ConflictException(
              'EPI em processamento por outra operação. Tente novamente.',
            );
          }
          throw err;
        }
        if (!lockedEpi) {
          throw new NotFoundException('EPI não encontrado para esta empresa.');
        }
        const qty = dto.quantidade || 1;
        if (
          lockedEpi.quantidade_estoque !== null &&
          lockedEpi.quantidade_estoque !== undefined &&
          lockedEpi.quantidade_estoque < qty
        ) {
          throw new BadRequestException(
            `Estoque insuficiente. Disponível: ${lockedEpi.quantidade_estoque}, solicitado: ${qty}.`,
          );
        }

        const assignmentRepo = trx.getRepository(EpiAssignment);
        const assignment = assignmentRepo.create({
          company_id: companyId,
          epi_id: dto.epi_id,
          user_id: dto.user_id,
          site_id: effectiveSiteId,
          ca: epi.ca,
          validade_ca: epi.validade_ca,
          quantidade: qty,
          status: 'entregue',
          entregue_em: new Date(),
          observacoes: dto.observacoes,
          assinatura_entrega: assinaturaEntrega,
          created_by_id: actorId,
          updated_by_id: actorId,
        });
        const savedAssignment = await assignmentRepo.save(assignment);

        // Decrement only when stock is tracked (quantidade_estoque IS NOT NULL)
        await trx.query(
          `UPDATE epis SET quantidade_estoque = quantidade_estoque - $1 WHERE id = $2 AND quantidade_estoque IS NOT NULL`,
          [qty, dto.epi_id],
        );

        return savedAssignment;
      },
    );

    await this.writeAuditLog(AuditAction.CREATE, saved, actorId, {
      event: 'epi_assignment_delivered',
      companyId,
      epiId: saved.epi_id,
      userId: saved.user_id,
    });
    return saved;
  }

  async findAll(filters?: {
    status?: 'entregue' | 'devolvido' | 'substituido';
    user_id?: string;
    epi_id?: string;
  }): Promise<EpiAssignment[]> {
    const page = await this.findPaginated({
      ...filters,
      page: 1,
      limit: 100,
    });
    return page.data;
  }

  async findPaginated(filters?: {
    status?: 'entregue' | 'devolvido' | 'substituido';
    user_id?: string;
    epi_id?: string;
    page?: number;
    limit?: number;
  }) {
    const scope = this.getSiteAccessScopeOrThrow();
    const companyId = scope.companyId;
    const { page, limit, skip } = normalizeOffsetPagination(filters, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const query = this.assignmentsRepository
      .createQueryBuilder('assignment')
      .leftJoinAndSelect('assignment.epi', 'epi')
      .leftJoinAndSelect('assignment.user', 'user')
      .leftJoinAndSelect('assignment.site', 'site')
      .where('assignment.company_id = :companyId', { companyId })
      .andWhere('assignment.deleted_at IS NULL')
      .orderBy('assignment.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    if (!scope.hasCompanyWideAccess) {
      query.andWhere('assignment.site_id = :siteId', { siteId: scope.siteId });
    }

    if (filters?.status) {
      query.andWhere('assignment.status = :status', { status: filters.status });
    }

    if (filters?.user_id) {
      query.andWhere('assignment.user_id = :userId', {
        userId: filters.user_id,
      });
    }

    if (filters?.epi_id) {
      query.andWhere('assignment.epi_id = :epiId', { epiId: filters.epi_id });
    }

    const [data, total] = await query.getManyAndCount();
    return toOffsetPage(data, total, page, limit);
  }

  async findOne(id: string): Promise<EpiAssignment> {
    const scope = this.getSiteAccessScopeOrThrow();
    const companyId = scope.companyId;
    const assignment = await this.assignmentsRepository.findOne({
      where: {
        id,
        company_id: companyId,
        ...(!scope.hasCompanyWideAccess ? { site_id: scope.siteId } : {}),
      },
      relations: ['company', 'epi', 'user', 'site'],
    });
    if (!assignment) {
      throw new NotFoundException(`Ficha EPI com ID ${id} não encontrada.`);
    }
    return assignment;
  }

  async update(
    id: string,
    dto: UpdateEpiAssignmentDto,
    actorId?: string,
  ): Promise<EpiAssignment> {
    const assignment = await this.findOne(id);
    if (assignment.status === 'devolvido') {
      throw new BadRequestException(
        'Ficha já devolvida. Não é possível edição genérica.',
      );
    }
    if (
      assignment.assinatura_entrega?.signature_hash ||
      assignment.pdf_file_key
    ) {
      throw new ConflictException(
        'Ficha EPI assinada ou com PDF final anexado. A edição genérica está bloqueada; use o fluxo formal de devolução ou substituição.',
      );
    }

    Object.assign(assignment, {
      ...dto,
      updated_by_id: actorId,
    });

    const saved = await this.assignmentsRepository.save(assignment);
    await this.writeAuditLog(AuditAction.UPDATE, saved, actorId, {
      event: 'epi_assignment_updated',
      companyId: saved.company_id,
      fields: Object.keys(dto),
    });
    return saved;
  }

  async returnAssignment(
    id: string,
    dto: ReturnEpiAssignmentDto,
    actorId?: string,
  ): Promise<EpiAssignment> {
    // SGS-EPI-CONC-005: wrap in transaction with pessimistic lock to prevent
    // double-return race (two concurrent requests both reading status='entregue')
    const scope = this.getSiteAccessScopeOrThrow();
    const saved = await this.assignmentsRepository.manager.transaction(
      async (trx) => {
        const repo = trx.getRepository(EpiAssignment);
        let assignment: EpiAssignment | null;
        try {
          assignment = await repo.findOne({
            where: {
              id,
              company_id: scope.companyId,
              ...(!scope.hasCompanyWideAccess ? { site_id: scope.siteId } : {}),
            },
            lock: { mode: 'pessimistic_write', onLocked: 'nowait' },
          });
        } catch (err) {
          const e = err as { code?: string };
          if (e?.code === '55P03') {
            throw new ConflictException(
              'Ficha em processamento por outra operação. Tente novamente.',
            );
          }
          throw err;
        }
        if (!assignment) {
          throw new NotFoundException(`Ficha EPI com ID ${id} não encontrada.`);
        }
        if (assignment.status !== 'entregue') {
          throw new BadRequestException(
            `Somente fichas entregues podem ser devolvidas. Status atual: ${assignment.status}.`,
          );
        }
        const isPrivileged =
          scope.hasCompanyWideAccess ||
          scope.profileName === Role.TST ||
          scope.profileName === Role.SUPERVISOR;
        if (!isPrivileged && assignment.user_id !== scope.userId) {
          throw new ForbiddenException(
            'Você só pode devolver EPIs atribuídos a você.',
          );
        }
        const assinaturaDevolucao = this.buildSignatureStamp(
          dto.assinatura_devolucao,
          actorId,
          actorId !== assignment.user_id ? assignment.user_id : undefined,
        );
        assignment.status = 'devolvido';
        assignment.devolvido_em = new Date();
        assignment.motivo_devolucao = dto.motivo_devolucao;
        assignment.observacoes = dto.observacoes || assignment.observacoes;
        assignment.assinatura_devolucao = assinaturaDevolucao;
        assignment.updated_by_id = actorId;
        const result = await repo.save(assignment);

        // SGS-EPI-BR-007: restore stock on return (only when tracked)
        await trx.query(
          `UPDATE epis SET quantidade_estoque = quantidade_estoque + $1 WHERE id = $2 AND quantidade_estoque IS NOT NULL`,
          [result.quantidade, result.epi_id],
        );

        return result;
      },
    );
    await this.writeAuditLog(AuditAction.UPDATE, saved, actorId, {
      event: 'epi_assignment_returned',
      companyId: saved.company_id,
      userId: saved.user_id,
    });
    return saved;
  }

  async replaceAssignment(
    id: string,
    dto: ReplaceEpiAssignmentDto,
    actorId?: string,
  ): Promise<EpiAssignment> {
    // SGS-EPI-CONC-005: pessimistic lock prevents concurrent return/replace
    const scope = this.getSiteAccessScopeOrThrow();
    const saved = await this.assignmentsRepository.manager.transaction(
      async (trx) => {
        const repo = trx.getRepository(EpiAssignment);
        let assignment: EpiAssignment | null;
        try {
          assignment = await repo.findOne({
            where: {
              id,
              company_id: scope.companyId,
              ...(!scope.hasCompanyWideAccess ? { site_id: scope.siteId } : {}),
            },
            lock: { mode: 'pessimistic_write', onLocked: 'nowait' },
          });
        } catch (err) {
          const e = err as { code?: string };
          if (e?.code === '55P03') {
            throw new ConflictException(
              'Ficha em processamento por outra operação. Tente novamente.',
            );
          }
          throw err;
        }
        if (!assignment) {
          throw new NotFoundException(`Ficha EPI com ID ${id} não encontrada.`);
        }
        if (assignment.status !== 'entregue') {
          throw new BadRequestException(
            'Somente fichas em uso podem ser marcadas como substituídas.',
          );
        }
        assignment.status = 'substituido';
        assignment.observacoes =
          `${assignment.observacoes || ''}\nSubstituição: ${dto.motivo_substituicao}`.trim();
        if (dto.observacoes) {
          assignment.observacoes =
            `${assignment.observacoes}\n${dto.observacoes}`.trim();
        }
        assignment.updated_by_id = actorId;
        const result = await repo.save(assignment);

        // SGS-EPI-BR-007: restore stock on replacement (only when tracked)
        await trx.query(
          `UPDATE epis SET quantidade_estoque = quantidade_estoque + $1 WHERE id = $2 AND quantidade_estoque IS NOT NULL`,
          [result.quantidade, result.epi_id],
        );

        return result;
      },
    );
    await this.writeAuditLog(AuditAction.UPDATE, saved, actorId, {
      event: 'epi_assignment_replaced',
      companyId: saved.company_id,
      userId: saved.user_id,
      reason: dto.motivo_substituicao,
    });
    return saved;
  }

  async getSummary() {
    const scope = this.getSiteAccessScopeOrThrow();
    const companyId = scope.companyId;
    const where = {
      company_id: companyId,
      ...(!scope.hasCompanyWideAccess ? { site_id: scope.siteId } : {}),
    };
    const now = new Date();
    const [total, entregue, devolvido, substituido] = await Promise.all([
      this.assignmentsRepository.count({ where }),
      this.assignmentsRepository.count({
        where: { ...where, status: 'entregue' },
      }),
      this.assignmentsRepository.count({
        where: { ...where, status: 'devolvido' },
      }),
      this.assignmentsRepository.count({
        where: { ...where, status: 'substituido' },
      }),
    ]);

    const caExpiradoQuery = this.assignmentsRepository
      .createQueryBuilder('assignment')
      .where('assignment.company_id = :companyId', { companyId })
      .andWhere('assignment.deleted_at IS NULL')
      .andWhere("assignment.status = 'entregue'")
      .andWhere('assignment.validade_ca IS NOT NULL')
      .andWhere('assignment.validade_ca < :now', { now });
    if (!scope.hasCompanyWideAccess) {
      caExpiradoQuery.andWhere('assignment.site_id = :siteId', {
        siteId: scope.siteId,
      });
    }
    const caExpirado = await caExpiradoQuery.getCount();

    return {
      total,
      entregue,
      devolvido,
      substituido,
      caExpirado,
    };
  }

  async generateFinalPdf(
    id: string,
    userId?: string,
  ): Promise<
    GovernedPdfAccessResponseDto & {
      generated: boolean;
      degraded: boolean;
    }
  > {
    const assignment = await this.findOne(id);

    if (assignment.pdf_file_key) {
      return { ...(await this.getPdfAccess(id)), generated: false };
    }

    this.assertReadyForFinalDocument(assignment);

    const buffer = await this.pdfService.generateFromHtml(
      buildEpiAssignmentPdfHtml(assignment, this.buildDocumentCode(assignment)),
      {
        format: 'A4',
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: INSTITUTIONAL_PDF_FOOTER_TEMPLATE,
        margin: { top: '14mm', right: '14mm', bottom: '16mm', left: '14mm' },
      },
    );

    const documentCode = this.buildDocumentCode(assignment);
    const originalName = `${this.safePdfName(assignment.id)}.pdf`;
    const key = this.documentStorageService.generateDocumentKey(
      assignment.company_id,
      'epi',
      assignment.id,
      originalName,
      {
        folderSegments: assignment.site_id ? ['sites', assignment.site_id] : [],
      },
    );
    const folder = key.split('/').slice(0, -1).join('/');

    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          key,
          { resourceType: 'epi', resourceId: assignment.id },
          'p1-document-storage-uploadFile',
        ),
        buffer,
        'application/pdf',
      );

    try {
      const { hash } =
        await this.documentGovernanceService.registerFinalDocument({
          companyId: assignment.company_id,
          module: 'epi',
          entityId: assignment.id,
          title: `Ficha de Entrega de EPI — ${assignment.epi?.nome || assignment.id}`,
          documentDate: assignment.entregue_em,
          documentCode,
          fileKey: key,
          folderPath: folder,
          originalName,
          mimeType: 'application/pdf',
          createdBy: userId,
          fileBuffer: buffer,
          persistEntityMetadata: async (manager, computedHash) => {
            const result = await manager.getRepository(EpiAssignment).update(
              { id: assignment.id, pdf_file_key: IsNull() },
              {
                pdf_file_key: key,
                pdf_folder_path: folder,
                pdf_original_name: originalName,
                final_pdf_hash_sha256: computedHash,
                pdf_generated_at: new Date(),
                document_code: documentCode,
                emitted_by_user_id: userId ?? null,
              },
            );
            if (result.affected !== 1) {
              throw new ConflictException(
                'A ficha de EPI já possui PDF final emitido.',
              );
            }
          },
        });

      if (!hash) {
        throw new BadRequestException(
          'Falha ao registrar a integridade do PDF final da ficha EPI.',
        );
      }
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `epi-assignment:${assignment.id}`,
        key,
        (fileKey) =>
          uploadedReference.key === fileKey
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      throw error;
    }

    return { ...(await this.getPdfAccess(id)), generated: true };
  }

  async getPdfAccess(
    id: string,
  ): Promise<GovernedPdfAccessResponseDto & { degraded: boolean }> {
    const assignment = await this.findOne(id);

    if (!assignment.pdf_file_key) {
      return {
        entityId: assignment.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message: 'A ficha de EPI ainda não possui PDF final emitido.',
        degraded: false,
        fileKey: null,
        folderPath: null,
        originalName: null,
        url: null,
      };
    }

    try {
      const url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          assignment.pdf_file_key,
          {
            resourceType: 'epi',
            resourceId: assignment.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
        EPI_PDF_SIGNED_URL_EXPIRY_SECONDS,
      );
      return {
        entityId: assignment.id,
        hasFinalPdf: true,
        availability: 'ready',
        message: 'PDF final governado disponível para acesso.',
        degraded: false,
        fileKey: assignment.pdf_file_key,
        folderPath: assignment.pdf_folder_path ?? null,
        originalName: assignment.pdf_original_name ?? null,
        url,
      };
    } catch {
      return {
        entityId: assignment.id,
        hasFinalPdf: true,
        availability: 'registered_without_signed_url',
        message:
          'PDF final registrado, mas a URL segura não está disponível no momento.',
        degraded: true,
        fileKey: assignment.pdf_file_key,
        folderPath: assignment.pdf_folder_path ?? null,
        originalName: assignment.pdf_original_name ?? null,
        url: null,
      };
    }
  }

  private assertReadyForFinalDocument(assignment: EpiAssignment): void {
    if (!assignment.epi?.nome || !assignment.user?.nome) {
      throw new BadRequestException(
        'A ficha de EPI precisa ter equipamento e trabalhador vinculados antes da emissão.',
      );
    }
    if (!assignment.assinatura_entrega?.signature_hash) {
      throw new BadRequestException(
        'A ficha de EPI precisa ter assinatura de entrega com hash antes da emissão.',
      );
    }
  }

  private buildDocumentCode(assignment: EpiAssignment): string {
    return `EPI-${assignment.id.replace(/-/g, '').slice(0, 16).toUpperCase()}`;
  }

  private safePdfName(value: string): string {
    const normalized = value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 100);
    return `EPI_${normalized || 'ficha'}`;
  }

  private buildSignatureStamp(
    input: EpiSignatureInputDto,
    signerUserId?: string,
    signedOnBehalfOfUserId?: string,
  ): EpiSignatureStamp {
    const generated = this.signatureTimestampService.issueFromRaw(
      input.signature_data,
    );
    return {
      signer_user_id: signerUserId,
      signed_on_behalf_of_user_id: signedOnBehalfOfUserId,
      signer_name: input.signer_name,
      signature_data: input.signature_data,
      signature_type: input.signature_type,
      signature_hash: generated.signature_hash,
      timestamp_token: generated.timestamp_token,
      timestamp_issued_at: generated.timestamp_issued_at,
      timestamp_authority: generated.timestamp_authority,
      timestamp_token_version: generated.timestamp_token_version,
      signature_key_id: generated.signature_key_id,
    };
  }

  private getSiteAccessScopeOrThrow() {
    return resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'fichas de EPI',
    );
  }

  private async writeAuditLog(
    action: AuditAction,
    assignment: EpiAssignment,
    actorId?: string,
    metadata?: Record<string, unknown>,
  ) {
    await this.auditService.log({
      action,
      entity: 'EPI_ASSIGNMENT',
      entityId: assignment.id,
      userId: actorId || '',
      companyId: assignment.company_id,
      changes: metadata,
      ip: 'unknown', // No contexto do serviço não temos IP facilmente
      userAgent: 'system',
    });
  }
}
