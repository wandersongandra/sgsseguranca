import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  FindManyOptions,
  In,
  IsNull,
  Not,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { jsonToExcelBuffer } from '../../shared/utils/excel.util';
import { NonConformity } from './entities/nonconformity.entity';
import { Checklist } from '../checklists/entities/checklist.entity';
import {
  CreateNonConformityDto,
  UpdateNonConformityDto,
} from './dto/create-nonconformity.dto';
import { plainToClass } from 'class-transformer';
import { NonConformityResponseDto } from './dto/nonconformity-response.dto';
import { TenantService } from '../../shared/tenant/tenant.service';
import {
  getScopedSiteIds,
  isSiteVisibleToScope,
  resolveSiteAccessScopeFromTenantService,
} from '../../shared/tenant/site-access-scope.util';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { cleanupUploadedFile } from '../../shared/storage/storage-compensation.util';
import {
  DocumentBundleService,
  WeeklyBundleFilters,
} from '../../shared/services/document-bundle.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { AuditService } from '../audit-trail/audit.service';
import { AuditAction } from '../audit-trail/enums/audit-action.enum';
import { RequestContext } from '../../shared/middleware/request-context.middleware';
import { Site } from '../sites/entities/site.entity';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { normalizeOptionalSearchQuery } from '../../shared/utils/query-normalization.util';
import { escapeLikePattern } from '../../shared/utils/sql.util';
import { coerceDocumentDate } from '../../shared/utils/document-calendar.util';
import { detectMimeFromMagicBytes } from '../../shared/utils/detect-mime.util';
import { sanitizePlainText } from '../../shared/utils/plain-text-sanitizer.util';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import {
  GovernedPdfAccessAvailability,
  GovernedPdfAccessResponseDto,
} from '../../shared/dto/governed-pdf-access-response.dto';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';
import { NonConformityWorkflowLockService } from './services/nonconformity-workflow-lock.service';
import { getNonConformityClosureMissingFields } from './utils/nonconformity-closure.util';
import {
  getNonConformityCivilCalendar,
  parseNonConformityCivilDate,
  parseNonConformityTimestampDate,
} from './utils/nonconformity-document-calendar.util';

export enum NcStatus {
  ABERTA = 'ABERTA',
  EM_ANDAMENTO = 'EM_ANDAMENTO',
  AGUARDANDO_VALIDACAO = 'AGUARDANDO_VALIDACAO',
  ENCERRADA = 'ENCERRADA',
}

export type NonConformityPdfAccessAvailability = GovernedPdfAccessAvailability;
export type NonConformityPdfAccessResponse = GovernedPdfAccessResponseDto;

export type NonConformityAnalyticsOverview = {
  totalNonConformities: number;
  abertas: number;
  emAndamento: number;
  aguardandoValidacao: number;
  encerradas: number;
};

export type NonConformityAttachmentAccessAvailability =
  'ready' | 'registered_without_signed_url';

export type NonConformityAttachmentAccessResponse = {
  entityId: string;
  index: number;
  hasGovernedAttachment: true;
  availability: NonConformityAttachmentAccessAvailability;
  fileKey: string;
  originalName: string;
  mimeType: string;
  url: string | null;
  degraded: boolean;
  message: string | null;
};

export type NonConformityAttachmentAttachResponse = {
  entityId: string;
  attachments: string[];
  attachmentCount: number;
  storageMode: 'governed-storage';
  degraded: false;
  message: string;
  // SECURITY: use governed reference (like photoReference in checklists) for attach responses.
  // Do not include raw fileKey here. Access file via the governed ref in attachments[] + dedicated /access endpoint.
  attachmentReference: string;
  attachment: {
    index: number;
    // fileKey intentionally omitted (raw keys never in attach responses; only in /access responses)
    originalName: string;
    mimeType: string;
  };
};

export type NonConformityAttachmentRemoveResponse = {
  entityId: string;
  attachments: string[];
  attachmentCount: number;
  removedAttachmentReference: string;
  storageCleanup: 'removed' | 'pending';
  message: string;
};

const MAX_NC_ATTACHMENTS = 24;
const GOVERNED_ATTACHMENT_REF_PREFIX = 'gst:nc-attachment:';
const SUPPORTED_NC_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

type SupportedNcAttachmentMimeType =
  (typeof SUPPORTED_NC_ATTACHMENT_MIME_TYPES)[number];

// Coordenação de concorrência para append de anexos (espelha APR/PT/Checklist).
// FOR UPDATE NOWAIT falha com 55P03 quando a linha já está travada; reprocessamos
// com backoff curto e, esgotadas as tentativas, devolvemos 409.
const NC_POSTGRES_LOCK_NOT_AVAILABLE_CODE = '55P03';
const NC_ROW_LOCK_RETRY_DELAYS_MS = [50, 100, 200] as const;

type GovernedAttachmentReferencePayload = {
  v: 1;
  kind: 'governed-storage';
  fileKey: string;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  sizeBytes?: number | null;
};

const ALLOWED_TRANSITIONS: Record<NcStatus, NcStatus[]> = {
  [NcStatus.ABERTA]: [NcStatus.EM_ANDAMENTO],
  [NcStatus.EM_ANDAMENTO]: [NcStatus.AGUARDANDO_VALIDACAO, NcStatus.ABERTA],
  [NcStatus.AGUARDANDO_VALIDACAO]: [NcStatus.ENCERRADA, NcStatus.ABERTA],
  [NcStatus.ENCERRADA]: [NcStatus.ABERTA],
};

const NC_AUDITABLE_FIELDS = [
  'codigo_nc',
  'tipo',
  'status',
  'risco_nivel',
  'site_id',
  'checklist_id',
  'closed',
  'has_final_pdf',
  'attachment_count',
  'governed_attachment_count',
  'legacy_attachment_count',
  'has_assinatura_responsavel_area',
  'has_assinatura_tecnico_auditor',
  'has_assinatura_gestao',
] as const;

type NonConformityAuditSnapshot = Record<
  (typeof NC_AUDITABLE_FIELDS)[number],
  string | number | boolean | null
>;

@Injectable()
export class NonConformitiesService {
  private readonly logger = new Logger(NonConformitiesService.name);

  constructor(
    @InjectRepository(NonConformity)
    private nonConformitiesRepository: Repository<NonConformity>,
    @InjectRepository(Site)
    private sitesRepository: Repository<Site>,
    @InjectRepository(Checklist)
    private checklistsRepository: Repository<Checklist>,
    private tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly documentBundleService: DocumentBundleService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly auditService: AuditService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
    private readonly workflowLock: NonConformityWorkflowLockService,
  ) {}

  /**
   * Código documental + token de validação pública (grant). O código é
   * determinístico (o mesmo do anexo do PDF final), então o token vale
   * antes e depois da emissão.
   */
  async getValidationContext(
    id: string,
  ): Promise<{ documentCode: string; token: string | null }> {
    const nc = await this.findOneEntity(id);
    const documentCode = this.buildNcDocumentCode(nc);
    let token: string | null = null;

    try {
      token = await this.publicValidationGrantService.issueToken({
        code: documentCode,
        companyId: nc.company_id,
        portal: 'nonconformity_public_validation',
        documentId: nc.id,
      });
    } catch (error) {
      this.logger.warn({
        event: 'nonconformity_validation_token_unavailable',
        ncId: nc.id,
        companyId: nc.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return { documentCode, token };
  }

  /**
   * Replica o código default do documento governado (module-ANO-SEMANA-ID8),
   * o mesmo gerado pelo registry quando o anexo não informa código próprio.
   */
  private buildNcDocumentCode(
    nc: Pick<NonConformity, 'id' | 'data_identificacao' | 'created_at'>,
  ): string {
    const civilDate =
      parseNonConformityCivilDate(nc.data_identificacao) ||
      parseNonConformityTimestampDate(nc.created_at, 'America/Araguaina') ||
      parseNonConformityTimestampDate(new Date(), 'America/Araguaina');
    if (!civilDate) {
      throw new BadRequestException(
        'Não foi possível determinar a data documental da não conformidade.',
      );
    }

    const calendar = getNonConformityCivilCalendar(civilDate);
    const week = String(calendar.isoWeek).padStart(2, '0');
    return `NONCONFORMITY-${calendar.year}-${week}-${nc.id
      .slice(0, 8)
      .toUpperCase()}`;
  }

  private getTenantIdOrThrow(): string {
    const tenantId = this.tenantService.getTenantId();
    if (!tenantId) {
      throw new BadRequestException(
        'Contexto de empresa não identificado para a não conformidade.',
      );
    }
    return tenantId;
  }

  private normalizeRequiredText(value: string): string {
    return (sanitizePlainText(value) as string).trim();
  }

  private normalizeNcCode(value: string): string {
    return this.normalizeRequiredText(value).toUpperCase();
  }

  private assertNcDocumentMutable(
    nc: Pick<NonConformity, 'status' | 'pdf_file_key'>,
  ): void {
    // O PDF final é a versão oficial e imutável da NC. Não é suficiente
    // bloquear somente pelo status: um registro legado/reaberto poderia ficar
    // ABERTO com pdf_file_key e voltar a divergir do documento registrado.
    if (nc.pdf_file_key) {
      throw new BadRequestException(
        'Não conformidade com PDF final emitido é imutável. Para corrigir dados, utilize o fluxo formal de retificação.',
      );
    }

    // Comparação direta (não normalizeStatus, que lança para status
    // ausente/malformado): o valor persistido já é sempre canônico
    // (gravado via normalizeStatus em create/update), então checar a
    // trava não deve exigir um status válido só para permitir edição.
    if (nc.status === (NcStatus.ENCERRADA as string)) {
      throw new BadRequestException(
        'Não conformidade encerrada. Edição bloqueada. Reabra a NC pelo fluxo de status antes de alterar o documento.',
      );
    }
  }

  private hasMeaningfulText(value: unknown): boolean {
    return typeof value === 'string' && value.trim().length >= 3;
  }

  private isSupportedNcAttachmentMimeType(
    mimeType: string,
  ): mimeType is SupportedNcAttachmentMimeType {
    return (SUPPORTED_NC_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
      mimeType,
    );
  }

  private resolveSupportedNcAttachmentMimeType(
    buffer: Buffer,
  ): SupportedNcAttachmentMimeType {
    const detectedMimeType = detectMimeFromMagicBytes(buffer);
    if (
      !detectedMimeType ||
      !this.isSupportedNcAttachmentMimeType(detectedMimeType)
    ) {
      throw new BadRequestException(
        'O conteúdo do anexo não corresponde a um tipo de evidência permitido.',
      );
    }

    return detectedMimeType;
  }

  private assertExpectedNcVersion(
    nc: Pick<NonConformity, 'updated_at'>,
    expectedUpdatedAt?: Date | string | null,
  ): void {
    const expected = coerceDocumentDate(expectedUpdatedAt);
    if (!expected) {
      return;
    }

    const current = coerceDocumentDate(nc.updated_at);
    if (!current || current.getTime() !== expected.getTime()) {
      throw new ConflictException(
        'A não conformidade foi alterada por outra operação. Recarregue o registro antes de salvar novamente.',
      );
    }
  }

  private isExpectedAttachmentStorageKey(
    nc: Pick<NonConformity, 'id' | 'company_id' | 'site_id'>,
    fileKey: string,
  ): boolean {
    const basePrefix = `documents/${nc.company_id}/nonconformity-attachments/`;
    const directPrefix = `${basePrefix}${nc.id}/`;
    const sitePrefix = nc.site_id
      ? `${basePrefix}sites/${nc.site_id}/${nc.id}/`
      : null;

    return (
      fileKey.startsWith(directPrefix) ||
      Boolean(sitePrefix && fileKey.startsWith(sitePrefix))
    );
  }

  /**
   * O encerramento é a atestação de que a ação corretiva funcionou; portanto
   * não pode depender só de uma mudança de enum feita pelo cliente.
   */
  private assertReadyForClosure(nc: NonConformity): void {
    const missing = getNonConformityClosureMissingFields(nc);

    if (missing.length > 0) {
      throw new UnprocessableEntityException(
        `Não é possível encerrar a não conformidade. Preencha: ${missing.join(', ')}.`,
      );
    }
  }

  /**
   * Serializa uma mutação de NC no banco. O Redis reduz contenção entre
   * réplicas, mas este lock de linha é a barreira definitiva contra uma escrita
   * stale caso o lease Redis expire durante uma operação lenta.
   */
  private async mutateNcLocked<T>(
    id: string,
    companyId: string,
    apply: (nc: NonConformity, manager: EntityManager) => T | Promise<T>,
    options?: {
      expectedUpdatedAt?: Date | string | null;
      assertLeaseHealthy?: () => void;
    },
  ): Promise<{ saved: NonConformity; result: T }> {
    for (
      let attempt = 0;
      attempt <= NC_ROW_LOCK_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        return await this.nonConformitiesRepository.manager.transaction(
          async (manager) => {
            const rows = await manager.query<NonConformity[]>(
              `SELECT * FROM "nonconformities" WHERE "id" = $1 AND "company_id" = $2 AND "deleted_at" IS NULL FOR UPDATE NOWAIT`,
              [id, companyId],
            );
            if (!rows || rows.length === 0) {
              throw new NotFoundException(
                `Não conformidade com ID ${id} não encontrada`,
              );
            }
            const nc = manager.getRepository(NonConformity).create(rows[0]);
            this.assertExpectedNcVersion(nc, options?.expectedUpdatedAt);
            const result = await apply(nc, manager);
            options?.assertLeaseHealthy?.();
            const saved = await manager.getRepository(NonConformity).save(nc);
            return { saved, result };
          },
        );
      } catch (error: unknown) {
        if (!this.isNcLockNotAvailableError(error)) {
          throw error;
        }
        const retryDelayMs = NC_ROW_LOCK_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined) {
          throw new ConflictException(
            'Outra operação está em andamento para esta não conformidade. Tente novamente em instantes.',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    throw new ConflictException(
      'Outra operação está em andamento para esta não conformidade. Tente novamente em instantes.',
    );
  }

  private isNcLockNotAvailableError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === NC_POSTGRES_LOCK_NOT_AVAILABLE_CODE
    );
  }

  private normalizeOptionalText(value?: string | null): string | undefined {
    const sanitized =
      value != null ? (sanitizePlainText(value) as string) : undefined;
    const normalized = sanitized?.trim();
    return normalized ? normalized : undefined;
  }

  private encodeBase64Url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  private decodeBase64Url(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf8');
  }

  private normalizeStringArray(values?: string[]): string[] {
    return Array.from(
      new Set(
        (values ?? [])
          .map((value) => (sanitizePlainText(value) as string).trim())
          .filter(Boolean),
      ),
    );
  }

  private isDuplicateCodigoNcError(error: unknown): boolean {
    if (error instanceof QueryFailedError) {
      const driverError = (
        error as QueryFailedError & { driverError?: unknown }
      ).driverError as
        | {
            code?: string;
            constraint?: string;
            detail?: string;
          }
        | undefined;

      if (driverError?.code === '23505') {
        const constraint = String(
          driverError.constraint || driverError.detail || '',
        ).toLowerCase();
        return constraint.includes(
          'uq_nonconformities_company_codigo_nc_active',
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
      message.includes('uq_nonconformities_company_codigo_nc_active') ||
      message.includes('duplicate key')
    );
  }

  private async ensureUniqueCodigoNc(
    companyId: string,
    codigoNc: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.nonConformitiesRepository.findOne({
      where: {
        company_id: companyId,
        codigo_nc: this.normalizeNcCode(codigoNc),
        deleted_at: IsNull(),
        ...(excludeId ? { id: Not(excludeId) } : {}),
      },
      select: ['id'],
    });

    if (existing) {
      throw new BadRequestException(
        'Já existe uma não conformidade com este código na empresa atual.',
      );
    }
  }

  private logNcEvent(
    level: 'log' | 'warn',
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const loggerPayload = {
      event,
      userId: RequestContext.getUserId() || undefined,
      ...payload,
    };

    if (level === 'warn') {
      this.logger.warn(loggerPayload);
      return;
    }

    this.logger.log(loggerPayload);
  }

  private countLegacyAttachments(values?: string[]): number {
    return (values ?? []).filter(
      (item) =>
        typeof item === 'string' &&
        !item.startsWith(GOVERNED_ATTACHMENT_REF_PREFIX),
    ).length;
  }

  /**
   * O audit trail precisa explicar a mutação sem replicar descrições, nomes,
   * assinaturas ou conteúdo de anexos (inclusive data URLs) em três colunas
   * JSONB. Mantemos apenas metadados operacionais e indicadores booleanos.
   */
  private toAuditSnapshot(value: unknown): NonConformityAuditSnapshot | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const attachments = Array.isArray(record.anexos)
      ? record.anexos.filter(
          (attachment): attachment is string => typeof attachment === 'string',
        )
      : [];
    const governedAttachmentCount = attachments.filter((attachment) =>
      attachment.startsWith(GOVERNED_ATTACHMENT_REF_PREFIX),
    ).length;
    const textOrNull = (entry: unknown): string | null =>
      typeof entry === 'string' && entry.trim() ? entry.trim() : null;

    return {
      codigo_nc: textOrNull(record.codigo_nc),
      tipo: textOrNull(record.tipo),
      status: textOrNull(record.status),
      risco_nivel: textOrNull(record.risco_nivel),
      site_id: textOrNull(record.site_id),
      checklist_id: textOrNull(record.checklist_id),
      closed: Boolean(record.closed_at),
      has_final_pdf: Boolean(record.pdf_file_key),
      attachment_count: attachments.length,
      governed_attachment_count: governedAttachmentCount,
      legacy_attachment_count: attachments.length - governedAttachmentCount,
      has_assinatura_responsavel_area: this.hasMeaningfulText(
        record.assinatura_responsavel_area,
      ),
      has_assinatura_tecnico_auditor: this.hasMeaningfulText(
        record.assinatura_tecnico_auditor,
      ),
      has_assinatura_gestao: this.hasMeaningfulText(record.assinatura_gestao),
    };
  }

  private getAuditChangedFields(
    before: NonConformityAuditSnapshot | null,
    after: NonConformityAuditSnapshot | null,
  ): string[] {
    return NC_AUDITABLE_FIELDS.filter(
      (field) => before?.[field] !== after?.[field],
    );
  }

  private buildGovernedAttachmentReference(
    payload: GovernedAttachmentReferencePayload,
  ): string {
    return `${GOVERNED_ATTACHMENT_REF_PREFIX}${this.encodeBase64Url(JSON.stringify(payload))}`;
  }

  private parseGovernedAttachmentReference(
    value?: string | null,
  ): GovernedAttachmentReferencePayload | null {
    const normalized = this.normalizeOptionalText(value);
    if (!normalized || !normalized.startsWith(GOVERNED_ATTACHMENT_REF_PREFIX)) {
      return null;
    }

    const encodedPayload = normalized.slice(
      GOVERNED_ATTACHMENT_REF_PREFIX.length,
    );
    if (!encodedPayload) {
      throw new BadRequestException('Referência de anexo governado inválida.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.decodeBase64Url(encodedPayload));
    } catch {
      throw new BadRequestException('Referência de anexo governado inválida.');
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as GovernedAttachmentReferencePayload).v !== 1 ||
      (parsed as GovernedAttachmentReferencePayload).kind !==
        'governed-storage' ||
      typeof (parsed as GovernedAttachmentReferencePayload).fileKey !==
        'string' ||
      typeof (parsed as GovernedAttachmentReferencePayload).originalName !==
        'string' ||
      typeof (parsed as GovernedAttachmentReferencePayload).mimeType !==
        'string' ||
      typeof (parsed as GovernedAttachmentReferencePayload).uploadedAt !==
        'string'
    ) {
      throw new BadRequestException('Referência de anexo governado inválida.');
    }

    return parsed as GovernedAttachmentReferencePayload;
  }

  private getGovernedAttachmentEntries(values?: string[]): Array<{
    reference: string;
    payload: GovernedAttachmentReferencePayload;
  }> {
    return (values ?? []).flatMap((value) => {
      const payload = this.parseGovernedAttachmentReference(value);
      if (!payload || !value) {
        return [];
      }

      return [
        {
          reference: value,
          payload,
        },
      ];
    });
  }

  private normalizeAttachmentReference(
    value?: string | null,
    options?: {
      allowedGovernedReferences?: Set<string>;
      allowedLegacyReferences?: Set<string>;
    },
  ): string | undefined {
    const normalized = this.normalizeOptionalText(value) || undefined;
    if (!normalized) {
      return undefined;
    }

    const governedPayload = this.parseGovernedAttachmentReference(normalized);
    if (governedPayload) {
      const allowedReferences = options?.allowedGovernedReferences;
      if (!allowedReferences?.has(normalized)) {
        throw new BadRequestException(
          'Anexos governados devem ser enviados pelo endpoint dedicado do módulo.',
        );
      }
      return normalized;
    }

    // Registros antigos podem preservar a referência legada para leitura e
    // migração posterior, mas nunca podem introduzir URLs/data URLs novas por
    // create/update. Todo novo arquivo deve passar pelo endpoint multipart,
    // que valida magic bytes, antimalware e storage tenantizado.
    if (options?.allowedLegacyReferences?.has(normalized)) {
      return normalized;
    }

    throw new BadRequestException(
      'Novos anexos devem ser enviados pelo endpoint dedicado do módulo. URLs e dados inline não são aceitos.',
    );
  }

  private normalizeAttachments(
    values?: string[],
    options?: {
      allowedGovernedReferences?: Set<string>;
      allowedLegacyReferences?: Set<string>;
    },
  ): string[] {
    return Array.from(
      new Set(
        (values ?? [])
          .map((value) => this.normalizeAttachmentReference(value, options))
          .filter((value): value is string => Boolean(value)),
      ),
    );
  }

  private getAllowedGovernedAttachmentReferences(
    values?: string[],
  ): Set<string> {
    return new Set(
      this.getGovernedAttachmentEntries(values).map((item) => item.reference),
    );
  }

  private getAllowedLegacyAttachmentReferences(values?: string[]): Set<string> {
    return new Set(
      (values ?? []).filter(
        (value) =>
          typeof value === 'string' &&
          !value.startsWith(GOVERNED_ATTACHMENT_REF_PREFIX),
      ),
    );
  }

  private async cleanupGovernedAttachmentFiles(
    nc: Pick<NonConformity, 'id' | 'company_id' | 'site_id'>,
    attachments: Array<{
      reference: string;
      payload: GovernedAttachmentReferencePayload;
    }>,
  ): Promise<void> {
    await Promise.all(
      attachments.map(async ({ payload }) => {
        if (!this.isExpectedAttachmentStorageKey(nc, payload.fileKey)) {
          this.logNcEvent('warn', 'nc_attachment_storage_scope_mismatch', {
            entityId: nc.id,
          });
          return;
        }

        try {
          await this.documentStorageService.deleteFile(payload.fileKey);
          this.logNcEvent('log', 'nc_attachment_removed_from_storage', {
            entityId: nc.id,
          });
        } catch (error) {
          this.logNcEvent('warn', 'nc_attachment_storage_cleanup_failed', {
            entityId: nc.id,
            errorMessage: error instanceof Error ? error.message : 'unknown',
          });
        }
      }),
    );
  }

  private toNonConformityResponse(
    nonConformity: NonConformity,
  ): NonConformityResponseDto {
    // SECURITY: explicitly strip raw internal storage keys from main responses.
    // These are only for governed access endpoints that return temporary signed URLs.
    const {
      pdf_file_key: _pdfKey,
      pdf_folder_path: _pdfPath,
      pdf_original_name: _pdfName,
      ...rest
    } = nonConformity as NonConformity & Record<string, unknown>;

    // For anexos, the governed refs are already used (gst:); no raw fileKey in main payload.
    return plainToClass(NonConformityResponseDto, rest, {
      excludeExtraneousValues: true,
    });
  }

  private canonicalizeStatus(value?: string | null): string {
    return (
      value
        ?.trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase() || ''
    );
  }

  private normalizeStatus(value?: string | null): NcStatus {
    const normalized = this.canonicalizeStatus(value);
    const statusMap: Record<string, NcStatus> = {
      ABERTA: NcStatus.ABERTA,
      EM_ANDAMENTO: NcStatus.EM_ANDAMENTO,
      EM_TRATAMENTO: NcStatus.EM_ANDAMENTO,
      AGUARDANDO_VALIDACAO: NcStatus.AGUARDANDO_VALIDACAO,
      AGUARDANDO_VALIDACAO_FINAL: NcStatus.AGUARDANDO_VALIDACAO,
      ENCERRADA: NcStatus.ENCERRADA,
      FINALIZADA: NcStatus.ENCERRADA,
      CONCLUIDA: NcStatus.ENCERRADA,
    };
    const mappedStatus = statusMap[normalized];

    if (mappedStatus) {
      return mappedStatus;
    }

    throw new BadRequestException('Status de não conformidade inválido.');
  }

  private buildCreatePayload(
    dto: CreateNonConformityDto,
    tenantId: string,
  ): Partial<NonConformity> {
    return {
      company_id: tenantId,
      codigo_nc: this.normalizeNcCode(dto.codigo_nc),
      tipo: this.normalizeRequiredText(dto.tipo),
      data_identificacao: dto.data_identificacao as unknown as Date,
      site_id: dto.site_id,
      local_setor_area: this.normalizeRequiredText(dto.local_setor_area),
      atividade_envolvida: this.normalizeRequiredText(dto.atividade_envolvida),
      responsavel_area: this.normalizeRequiredText(dto.responsavel_area),
      auditor_responsavel: this.normalizeRequiredText(dto.auditor_responsavel),
      classificacao: this.normalizeStringArray(dto.classificacao),
      descricao: this.normalizeRequiredText(dto.descricao),
      evidencia_observada: this.normalizeRequiredText(dto.evidencia_observada),
      condicao_insegura: this.normalizeRequiredText(dto.condicao_insegura),
      ato_inseguro: this.normalizeOptionalText(dto.ato_inseguro),
      requisito_nr: this.normalizeRequiredText(dto.requisito_nr),
      requisito_item: this.normalizeRequiredText(dto.requisito_item),
      requisito_procedimento: this.normalizeOptionalText(
        dto.requisito_procedimento,
      ),
      requisito_politica: this.normalizeOptionalText(dto.requisito_politica),
      risco_perigo: this.normalizeRequiredText(dto.risco_perigo),
      risco_associado: this.normalizeRequiredText(dto.risco_associado),
      risco_consequencias: this.normalizeStringArray(dto.risco_consequencias),
      risco_nivel: this.normalizeRequiredText(dto.risco_nivel),
      causa: this.normalizeStringArray(dto.causa),
      causa_outro: this.normalizeOptionalText(dto.causa_outro),
      acao_imediata_descricao: this.normalizeOptionalText(
        dto.acao_imediata_descricao,
      ),
      acao_imediata_data: dto.acao_imediata_data as unknown as Date,
      acao_imediata_responsavel: this.normalizeOptionalText(
        dto.acao_imediata_responsavel,
      ),
      acao_imediata_status: this.normalizeOptionalText(
        dto.acao_imediata_status,
      ),
      acao_definitiva_descricao: this.normalizeOptionalText(
        dto.acao_definitiva_descricao,
      ),
      acao_definitiva_prazo: dto.acao_definitiva_prazo as unknown as Date,
      acao_definitiva_responsavel: this.normalizeOptionalText(
        dto.acao_definitiva_responsavel,
      ),
      acao_definitiva_recursos: this.normalizeOptionalText(
        dto.acao_definitiva_recursos,
      ),
      acao_definitiva_data_prevista:
        dto.acao_definitiva_data_prevista as unknown as Date,
      acao_preventiva_medidas: this.normalizeOptionalText(
        dto.acao_preventiva_medidas,
      ),
      acao_preventiva_treinamento: this.normalizeOptionalText(
        dto.acao_preventiva_treinamento,
      ),
      acao_preventiva_revisao_procedimento: this.normalizeOptionalText(
        dto.acao_preventiva_revisao_procedimento,
      ),
      acao_preventiva_melhoria_processo: this.normalizeOptionalText(
        dto.acao_preventiva_melhoria_processo,
      ),
      acao_preventiva_epc_epi: this.normalizeOptionalText(
        dto.acao_preventiva_epc_epi,
      ),
      verificacao_resultado: this.normalizeOptionalText(
        dto.verificacao_resultado,
      ),
      verificacao_evidencias: this.normalizeOptionalText(
        dto.verificacao_evidencias,
      ),
      verificacao_data: dto.verificacao_data as unknown as Date,
      verificacao_responsavel: this.normalizeOptionalText(
        dto.verificacao_responsavel,
      ),
      status: this.normalizeStatus(dto.status),
      observacoes_gerais: this.normalizeOptionalText(dto.observacoes_gerais),
      anexos: this.normalizeAttachments(dto.anexos, {
        allowedGovernedReferences: new Set<string>(),
      }),
      assinatura_responsavel_area: this.normalizeOptionalText(
        dto.assinatura_responsavel_area,
      ),
      assinatura_tecnico_auditor: this.normalizeOptionalText(
        dto.assinatura_tecnico_auditor,
      ),
      assinatura_gestao: this.normalizeOptionalText(dto.assinatura_gestao),
      checklist_id: dto.checklist_id,
    };
  }

  private applyQuestionnaireUpdateFields(
    payload: Partial<NonConformity>,
    dto: UpdateNonConformityDto,
  ): void {
    if (dto.causa_categoria !== undefined) payload.causa_categoria = this.normalizeOptionalText(dto.causa_categoria);
    if (dto.causa_fator_humano !== undefined) payload.causa_fator_humano = dto.causa_fator_humano;
    if (dto.causa_fator_equipamento !== undefined) payload.causa_fator_equipamento = dto.causa_fator_equipamento;
    if (dto.causa_fator_processo !== undefined) payload.causa_fator_processo = dto.causa_fator_processo;
    if (dto.causa_fator_ambiente !== undefined) payload.causa_fator_ambiente = dto.causa_fator_ambiente;
    if (dto.causa_fator_gerencial !== undefined) payload.causa_fator_gerencial = dto.causa_fator_gerencial;
    if (dto.tipo_categoria !== undefined) payload.tipo_categoria = this.normalizeOptionalText(dto.tipo_categoria);
    if (dto.tipo_subcategoria !== undefined) payload.tipo_subcategoria = this.normalizeOptionalText(dto.tipo_subcategoria);
    if (dto.requisito_nr_categoria !== undefined) payload.requisito_nr_categoria = this.normalizeOptionalText(dto.requisito_nr_categoria);
    if (dto.risco_categoria !== undefined) payload.risco_categoria = this.normalizeOptionalText(dto.risco_categoria);
    if (dto.risco_fonte !== undefined) payload.risco_fonte = this.normalizeOptionalText(dto.risco_fonte);
    if (dto.evidencia_descricao_foto !== undefined) payload.evidencia_descricao_foto = this.normalizeOptionalText(dto.evidencia_descricao_foto);
    if (dto.evidencia_foto1_key !== undefined) payload.evidencia_foto1_key = this.normalizeOptionalText(dto.evidencia_foto1_key);
    if (dto.evidencia_foto2_key !== undefined) payload.evidencia_foto2_key = this.normalizeOptionalText(dto.evidencia_foto2_key);
    if (dto.evidencia_foto3_key !== undefined) payload.evidencia_foto3_key = this.normalizeOptionalText(dto.evidencia_foto3_key);
    if (dto.verificacao_descricao_foto !== undefined) payload.verificacao_descricao_foto = this.normalizeOptionalText(dto.verificacao_descricao_foto);
    if (dto.verificacao_foto1_key !== undefined) payload.verificacao_foto1_key = this.normalizeOptionalText(dto.verificacao_foto1_key);
    if (dto.verificacao_foto2_key !== undefined) payload.verificacao_foto2_key = this.normalizeOptionalText(dto.verificacao_foto2_key);
    if (dto.verificacao_foto3_key !== undefined) payload.verificacao_foto3_key = this.normalizeOptionalText(dto.verificacao_foto3_key);
  }

  private buildUpdatePayload(
    dto: UpdateNonConformityDto,
    existingAttachments?: string[],
  ): Partial<NonConformity> {
    const payload: Partial<NonConformity> = {};
    const allowedGovernedReferences =
      this.getAllowedGovernedAttachmentReferences(existingAttachments);
    const allowedLegacyReferences =
      this.getAllowedLegacyAttachmentReferences(existingAttachments);

    if (dto.codigo_nc !== undefined)
      payload.codigo_nc = this.normalizeNcCode(dto.codigo_nc);
    if (dto.tipo !== undefined)
      payload.tipo = this.normalizeRequiredText(dto.tipo);
    if (dto.data_identificacao !== undefined) {
      payload.data_identificacao = dto.data_identificacao as unknown as Date;
    }
    if (dto.site_id !== undefined) payload.site_id = dto.site_id;
    if (dto.local_setor_area !== undefined) {
      payload.local_setor_area = this.normalizeRequiredText(
        dto.local_setor_area,
      );
    }
    if (dto.atividade_envolvida !== undefined) {
      payload.atividade_envolvida = this.normalizeRequiredText(
        dto.atividade_envolvida,
      );
    }
    if (dto.responsavel_area !== undefined) {
      payload.responsavel_area = this.normalizeRequiredText(
        dto.responsavel_area,
      );
    }
    if (dto.auditor_responsavel !== undefined) {
      payload.auditor_responsavel = this.normalizeRequiredText(
        dto.auditor_responsavel,
      );
    }
    if (dto.classificacao !== undefined) {
      payload.classificacao = this.normalizeStringArray(dto.classificacao);
    }
    if (dto.descricao !== undefined)
      payload.descricao = this.normalizeRequiredText(dto.descricao);
    if (dto.evidencia_observada !== undefined) {
      payload.evidencia_observada = this.normalizeRequiredText(
        dto.evidencia_observada,
      );
    }
    if (dto.condicao_insegura !== undefined) {
      payload.condicao_insegura = this.normalizeRequiredText(
        dto.condicao_insegura,
      );
    }
    if (dto.ato_inseguro !== undefined) {
      payload.ato_inseguro = this.normalizeOptionalText(dto.ato_inseguro);
    }
    if (dto.requisito_nr !== undefined) {
      payload.requisito_nr = this.normalizeRequiredText(dto.requisito_nr);
    }
    if (dto.requisito_item !== undefined) {
      payload.requisito_item = this.normalizeRequiredText(dto.requisito_item);
    }
    if (dto.requisito_procedimento !== undefined) {
      payload.requisito_procedimento = this.normalizeOptionalText(
        dto.requisito_procedimento,
      );
    }
    if (dto.requisito_politica !== undefined) {
      payload.requisito_politica = this.normalizeOptionalText(
        dto.requisito_politica,
      );
    }
    if (dto.risco_perigo !== undefined) {
      payload.risco_perigo = this.normalizeRequiredText(dto.risco_perigo);
    }
    if (dto.risco_associado !== undefined) {
      payload.risco_associado = this.normalizeRequiredText(dto.risco_associado);
    }
    if (dto.risco_consequencias !== undefined) {
      payload.risco_consequencias = this.normalizeStringArray(
        dto.risco_consequencias,
      );
    }
    if (dto.risco_nivel !== undefined) {
      payload.risco_nivel = this.normalizeRequiredText(dto.risco_nivel);
    }
    if (dto.causa !== undefined) {
      payload.causa = this.normalizeStringArray(dto.causa);
    }
    this.applyQuestionnaireUpdateFields(payload, dto);
    if (dto.causa_outro !== undefined) {
      payload.causa_outro = this.normalizeOptionalText(dto.causa_outro);
    }
    if (dto.acao_imediata_descricao !== undefined) {
      payload.acao_imediata_descricao = this.normalizeOptionalText(
        dto.acao_imediata_descricao,
      );
    }
    if (dto.acao_imediata_data !== undefined) {
      payload.acao_imediata_data = dto.acao_imediata_data as unknown as Date;
    }
    if (dto.acao_imediata_responsavel !== undefined) {
      payload.acao_imediata_responsavel = this.normalizeOptionalText(
        dto.acao_imediata_responsavel,
      );
    }
    if (dto.acao_imediata_status !== undefined) {
      payload.acao_imediata_status = this.normalizeOptionalText(
        dto.acao_imediata_status,
      );
    }
    if (dto.acao_definitiva_descricao !== undefined) {
      payload.acao_definitiva_descricao = this.normalizeOptionalText(
        dto.acao_definitiva_descricao,
      );
    }
    if (dto.acao_definitiva_prazo !== undefined) {
      payload.acao_definitiva_prazo =
        dto.acao_definitiva_prazo as unknown as Date;
    }
    if (dto.acao_definitiva_responsavel !== undefined) {
      payload.acao_definitiva_responsavel = this.normalizeOptionalText(
        dto.acao_definitiva_responsavel,
      );
    }
    if (dto.acao_definitiva_recursos !== undefined) {
      payload.acao_definitiva_recursos = this.normalizeOptionalText(
        dto.acao_definitiva_recursos,
      );
    }
    if (dto.acao_definitiva_data_prevista !== undefined) {
      payload.acao_definitiva_data_prevista =
        dto.acao_definitiva_data_prevista as unknown as Date;
    }
    if (dto.acao_preventiva_medidas !== undefined) {
      payload.acao_preventiva_medidas = this.normalizeOptionalText(
        dto.acao_preventiva_medidas,
      );
    }
    if (dto.acao_preventiva_treinamento !== undefined) {
      payload.acao_preventiva_treinamento = this.normalizeOptionalText(
        dto.acao_preventiva_treinamento,
      );
    }
    if (dto.acao_preventiva_revisao_procedimento !== undefined) {
      payload.acao_preventiva_revisao_procedimento = this.normalizeOptionalText(
        dto.acao_preventiva_revisao_procedimento,
      );
    }
    if (dto.acao_preventiva_melhoria_processo !== undefined) {
      payload.acao_preventiva_melhoria_processo = this.normalizeOptionalText(
        dto.acao_preventiva_melhoria_processo,
      );
    }
    if (dto.acao_preventiva_epc_epi !== undefined) {
      payload.acao_preventiva_epc_epi = this.normalizeOptionalText(
        dto.acao_preventiva_epc_epi,
      );
    }
    if (dto.verificacao_resultado !== undefined) {
      payload.verificacao_resultado = this.normalizeOptionalText(
        dto.verificacao_resultado,
      );
    }
    if (dto.verificacao_evidencias !== undefined) {
      payload.verificacao_evidencias = this.normalizeOptionalText(
        dto.verificacao_evidencias,
      );
    }
    if (dto.verificacao_data !== undefined) {
      payload.verificacao_data = dto.verificacao_data as unknown as Date;
    }
    if (dto.verificacao_responsavel !== undefined) {
      payload.verificacao_responsavel = this.normalizeOptionalText(
        dto.verificacao_responsavel,
      );
    }
    if (dto.status !== undefined)
      payload.status = this.normalizeStatus(dto.status);
    if (dto.observacoes_gerais !== undefined) {
      payload.observacoes_gerais = this.normalizeOptionalText(
        dto.observacoes_gerais,
      );
    }
    if (dto.anexos !== undefined) {
      payload.anexos = this.normalizeAttachments(dto.anexos, {
        allowedGovernedReferences,
        allowedLegacyReferences,
      });
    }
    if (dto.assinatura_responsavel_area !== undefined) {
      payload.assinatura_responsavel_area = this.normalizeOptionalText(
        dto.assinatura_responsavel_area,
      );
    }
    if (dto.assinatura_tecnico_auditor !== undefined) {
      payload.assinatura_tecnico_auditor = this.normalizeOptionalText(
        dto.assinatura_tecnico_auditor,
      );
    }
    if (dto.assinatura_gestao !== undefined) {
      payload.assinatura_gestao = this.normalizeOptionalText(
        dto.assinatura_gestao,
      );
    }
    if (dto.checklist_id !== undefined) {
      payload.checklist_id = dto.checklist_id;
    }

    return payload;
  }

  private async validateLinkedRecords(
    payload: Partial<NonConformity>,
    tenantId: string,
  ): Promise<void> {
    if (!payload.site_id) {
      return;
    }

    const site = await this.sitesRepository.findOne({
      where: {
        id: payload.site_id,
        company_id: tenantId,
        status: true,
      },
    });

    if (!site) {
      throw new BadRequestException(
        'O site informado não está ativo ou não pertence à empresa selecionada.',
      );
    }
  }

  private async validateChecklistLink(
    checklistId: string | null | undefined,
    siteId: string | null | undefined,
    tenantId: string,
  ): Promise<void> {
    if (!checklistId) {
      return;
    }

    const checklist = await this.checklistsRepository.findOne({
      where: {
        id: checklistId,
        company_id: tenantId,
        deleted_at: IsNull(),
      },
      select: ['id', 'site_id'],
    });

    if (!checklist) {
      throw new BadRequestException(
        'O checklist informado não foi encontrado ou não pertence à empresa atual.',
      );
    }

    if (!siteId || !checklist.site_id || checklist.site_id !== siteId) {
      throw new BadRequestException(
        'O checklist vinculado deve pertencer à mesma obra da não conformidade.',
      );
    }
  }

  async create(
    createNonConformityDto: CreateNonConformityDto,
  ): Promise<NonConformityResponseDto> {
    const tenantId = this.getTenantIdOrThrow();
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'nao conformidades',
    );
    const payload = this.buildCreatePayload(createNonConformityDto, tenantId);
    if (!isSiteVisibleToScope(payload.site_id, scope)) {
      throw new BadRequestException(
        'Não conformidade deve ser criada em uma obra autorizada para o usuário.',
      );
    }
    if (payload.status !== NcStatus.ABERTA) {
      throw new UnprocessableEntityException(
        'Uma não conformidade deve ser criada com status ABERTA e seguir o fluxo de tratamento e validação.',
      );
    }
    await this.validateLinkedRecords(payload, tenantId);
    await this.validateChecklistLink(
      payload.checklist_id,
      payload.site_id,
      tenantId,
    );
    await this.ensureUniqueCodigoNc(tenantId, payload.codigo_nc!);

    const nonConformity = this.nonConformitiesRepository.create(payload);
    let saved: NonConformity;
    try {
      saved = await this.nonConformitiesRepository.save(nonConformity);
    } catch (error) {
      if (this.isDuplicateCodigoNcError(error)) {
        throw new BadRequestException(
          'Já existe uma não conformidade com este código na empresa atual.',
        );
      }
      throw error;
    }
    const legacyAttachmentCount = this.countLegacyAttachments(saved.anexos);
    if (legacyAttachmentCount > 0) {
      this.logNcEvent('warn', 'nc_legacy_attachments_preserved', {
        entityId: saved.id,
        legacyAttachmentCount,
      });
    }
    await this.logAudit(AuditAction.CREATE, saved.id, null, saved);
    return this.toNonConformityResponse(saved);
  }

  async findAll(options?: {
    take?: number;
    select?: (keyof NonConformity)[];
  }): Promise<NonConformityResponseDto[]> {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'nao conformidades',
    );
    const entities = await this.nonConformitiesRepository.find({
      where: {
        company_id: scope.companyId,
        deleted_at: IsNull(),
        ...(!scope.hasCompanyWideAccess
          ? { site_id: In(getScopedSiteIds(scope)) }
          : {}),
      },
      ...(options?.select?.length
        ? { select: options.select }
        : { relations: ['site'] }),
      order: { created_at: 'DESC' },
      ...(options?.take !== undefined && { take: options.take }),
    });
    return entities.map((e) => this.toNonConformityResponse(e));
  }

  async findPaginated(opts?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }): Promise<OffsetPage<NonConformityResponseDto>> {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'nao conformidades',
    );
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const query = this.nonConformitiesRepository
      .createQueryBuilder('nc')
      .leftJoinAndSelect('nc.site', 'site')
      .where('nc.deleted_at IS NULL')
      .orderBy('nc.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    query.andWhere('nc.company_id = :tenantId', { tenantId: scope.companyId });
    if (!scope.hasCompanyWideAccess) {
      query.andWhere('nc.site_id IN (:...siteIds)', {
        siteIds: getScopedSiteIds(scope),
      });
    }

    if (opts?.status) {
      query.andWhere('nc.status = :statusFilter', {
        statusFilter: opts.status,
      });
    }

    const searchTerm = normalizeOptionalSearchQuery(opts?.search);
    if (searchTerm) {
      const search = `%${escapeLikePattern(searchTerm.toLowerCase())}%`;
      const condition = `(
        LOWER(nc.codigo_nc) LIKE :search ESCAPE '\\'
        OR LOWER(nc.local_setor_area) LIKE :search ESCAPE '\\'
        OR LOWER(nc.tipo) LIKE :search ESCAPE '\\'
        OR LOWER(nc.status) LIKE :search ESCAPE '\\'
      )`;
      query.andWhere(condition, { search });
    }

    const [data, total] = await query.getManyAndCount();
    const transformed = data.map((e) => this.toNonConformityResponse(e));
    return toOffsetPage(transformed, total, page, limit);
  }

  async countPendingActionItems(companyId?: string): Promise<number> {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'nao conformidades',
    );
    const tenantId = companyId || scope.companyId;
    const query = this.nonConformitiesRepository
      .createQueryBuilder('nc')
      .select(
        `
          COALESCE(
            SUM(
              CASE
                WHEN nc.acao_imediata_status IS NOT NULL
                 AND LOWER(nc.acao_imediata_status) NOT LIKE '%conclu%'
                 AND LOWER(nc.acao_imediata_status) NOT LIKE '%encerr%'
                THEN 1
                ELSE 0
              END
              +
              CASE
                WHEN nc.status IS NOT NULL
                 AND LOWER(nc.status) NOT LIKE '%conclu%'
                 AND LOWER(nc.status) NOT LIKE '%encerr%'
                THEN 1
                ELSE 0
              END
            ),
            0
          )
        `,
        'total',
      );

    if (tenantId) {
      query
        .where('nc.deleted_at IS NULL')
        .andWhere('nc.company_id = :tenantId', { tenantId });
      if (!scope.hasCompanyWideAccess) {
        query.andWhere('nc.site_id IN (:...siteIds)', {
          siteIds: getScopedSiteIds(scope),
        });
      }
    } else {
      query.where('nc.deleted_at IS NULL');
    }

    const row = await query.getRawOne<{ total?: string | number }>();
    return Number(row?.total ?? 0);
  }

  async summarizeByStatus(status?: string) {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'nao conformidades',
    );
    const query = this.nonConformitiesRepository
      .createQueryBuilder('nc')
      .select('UPPER(COALESCE(nc.status, :emptyStatus))', 'status')
      .addSelect('COUNT(*)', 'total')
      .setParameter('emptyStatus', 'SEM_STATUS')
      .where('nc.deleted_at IS NULL')
      .groupBy('UPPER(COALESCE(nc.status, :emptyStatus))');

    query.andWhere('nc.company_id = :tenantId', { tenantId: scope.companyId });
    if (!scope.hasCompanyWideAccess) {
      query.andWhere('nc.site_id IN (:...siteIds)', {
        siteIds: getScopedSiteIds(scope),
      });
    }

    const rows = await query.getRawMany<{ status: string; total: string }>();
    const byStatus = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = Number(row.total);
      return acc;
    }, {});

    const total = Object.values(byStatus).reduce(
      (sum, value) => sum + value,
      0,
    );
    const normalizedStatus = status?.trim().toUpperCase();

    return {
      total,
      filtered: normalizedStatus ? (byStatus[normalizedStatus] ?? 0) : total,
      byStatus,
      filterStatus: normalizedStatus ?? null,
    };
  }

  async findOne(id: string): Promise<NonConformityResponseDto> {
    const entity = await this.findOneEntity(id);
    return this.toNonConformityResponse(entity);
  }

  async findOneEntity(id: string): Promise<NonConformity> {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'nao conformidades',
    );
    const nonConformity = await this.nonConformitiesRepository.findOne({
      where: {
        id,
        company_id: scope.companyId,
        deleted_at: IsNull(),
        ...(!scope.hasCompanyWideAccess
          ? { site_id: In(getScopedSiteIds(scope)) }
          : {}),
      },
      relations: ['site', 'company'],
    });

    if (!nonConformity) {
      throw new NotFoundException(
        `Não conformidade com ID ${id} não encontrada`,
      );
    }

    return nonConformity;
  }

  async update(
    id: string,
    updateNonConformityDto: UpdateNonConformityDto,
  ): Promise<NonConformityResponseDto> {
    return this.workflowLock.runExclusive(id, (assertLeaseHealthy) =>
      this.updateLocked(id, updateNonConformityDto, assertLeaseHealthy),
    );
  }

  private async updateLocked(
    id: string,
    updateNonConformityDto: UpdateNonConformityDto,
    assertLeaseHealthy: () => void,
  ): Promise<NonConformityResponseDto> {
    const nonConformity = await this.findOneEntity(id);
    this.assertNcDocumentMutable(nonConformity);
    const previousGovernedAttachments = this.getGovernedAttachmentEntries(
      nonConformity.anexos,
    );
    const payload = this.buildUpdatePayload(
      updateNonConformityDto,
      nonConformity.anexos,
    );
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'nao conformidades',
    );
    if (
      payload.site_id !== undefined &&
      !isSiteVisibleToScope(payload.site_id, scope)
    ) {
      throw new BadRequestException(
        'Não conformidade não pode ser movida para uma obra não autorizada.',
      );
    }
    await this.validateLinkedRecords(payload, nonConformity.company_id);
    await this.validateChecklistLink(
      payload.checklist_id ?? nonConformity.checklist_id,
      payload.site_id ?? nonConformity.site_id,
      nonConformity.company_id,
    );
    if (payload.codigo_nc) {
      await this.ensureUniqueCodigoNc(
        nonConformity.company_id,
        payload.codigo_nc,
        nonConformity.id,
      );
    }
    // Status é aplicado à parte (via applyValidatedStatusTransition) em vez
    // de deixar o Object.assign abaixo sobrescrevê-lo diretamente: o
    // formulário completo de edição envia o status atual em toda gravação
    // (campo obrigatório), então só validamos/transicionamos quando o valor
    // realmente muda — evita reprocessar uma "transição" para o mesmo status
    // a cada Salvar.
    const requestedStatus = payload.status as NcStatus | undefined;
    delete payload.status;
    if (
      requestedStatus !== undefined &&
      requestedStatus !== this.normalizeStatus(nonConformity.status)
    ) {
      const transitionPreview = Object.assign({ ...nonConformity }, payload);
      this.applyValidatedStatusTransition(transitionPreview, requestedStatus);
    }
    let mutation: {
      saved: NonConformity;
      result: NonConformity;
    };
    try {
      mutation = await this.mutateNcLocked(
        id,
        nonConformity.company_id,
        (locked) => {
          this.assertNcDocumentMutable(locked);
          const before = { ...locked };
          Object.assign(locked, payload);
          if (
            requestedStatus !== undefined &&
            requestedStatus !== this.normalizeStatus(before.status)
          ) {
            this.applyValidatedStatusTransition(locked, requestedStatus);
          }
          return before;
        },
        {
          expectedUpdatedAt: nonConformity.updated_at,
          assertLeaseHealthy,
        },
      );
    } catch (error) {
      if (this.isDuplicateCodigoNcError(error)) {
        throw new BadRequestException(
          'Já existe uma não conformidade com este código na empresa atual.',
        );
      }
      throw error;
    }
    const { saved, result: before } = mutation;
    const nextAttachmentReferences = new Set(saved.anexos ?? []);
    const removedGovernedAttachments = previousGovernedAttachments.filter(
      ({ reference }) => !nextAttachmentReferences.has(reference),
    );
    if (removedGovernedAttachments.length > 0) {
      await this.cleanupGovernedAttachmentFiles(
        nonConformity,
        removedGovernedAttachments,
      );
    }
    const legacyAttachmentCount = this.countLegacyAttachments(saved.anexos);
    if (legacyAttachmentCount > 0) {
      this.logNcEvent('warn', 'nc_legacy_attachments_preserved', {
        entityId: saved.id,
        legacyAttachmentCount,
      });
    }
    await this.logAudit(AuditAction.UPDATE, saved.id, before, saved);
    return this.toNonConformityResponse(await this.findOneEntity(saved.id));
  }

  async remove(id: string) {
    return this.workflowLock.runExclusive(id, (assertLeaseHealthy) =>
      this.removeLocked(id, assertLeaseHealthy),
    );
  }

  private async removeLocked(id: string, assertLeaseHealthy: () => void) {
    const nonConformity = await this.findOneEntity(id);
    if (nonConformity.pdf_file_key) {
      throw new BadRequestException(
        'Somente não conformidades sem PDF final podem ser removidas. Use os fluxos formais de cancelamento/encerramento para registros já emitidos.',
      );
    }
    let before: NonConformity | null = null;
    let governedAttachments: Array<{
      reference: string;
      payload: GovernedAttachmentReferencePayload;
    }> = [];
    await this.documentGovernanceService.removeFinalDocumentReference({
      companyId: nonConformity.company_id,
      module: 'nonconformity',
      entityId: nonConformity.id,
      trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
      trailMetadata: {
        removalMode: 'soft_delete',
      },
      removeEntityState: async (manager) => {
        const rows = await manager.query<NonConformity[]>(
          `SELECT * FROM "nonconformities" WHERE "id" = $1 AND "company_id" = $2 AND "deleted_at" IS NULL FOR UPDATE NOWAIT`,
          [id, nonConformity.company_id],
        );
        if (!rows || rows.length === 0) {
          throw new NotFoundException(
            `Não conformidade com ID ${id} não encontrada`,
          );
        }

        const locked = manager.getRepository(NonConformity).create(rows[0]);
        this.assertExpectedNcVersion(locked, nonConformity.updated_at);
        if (locked.pdf_file_key) {
          throw new BadRequestException(
            'Somente não conformidades sem PDF final podem ser removidas. Use os fluxos formais de cancelamento/encerramento para registros já emitidos.',
          );
        }

        assertLeaseHealthy();
        before = { ...locked };
        governedAttachments = this.getGovernedAttachmentEntries(locked.anexos);
        await manager.getRepository(NonConformity).softDelete(locked.id);
      },
      cleanupStoredFile: (fileKey) =>
        this.documentStorageService.deleteFile(fileKey),
    });
    if (!before) {
      throw new ConflictException(
        'A não conformidade não pôde ser bloqueada para remoção. Tente novamente.',
      );
    }
    if (governedAttachments.length > 0) {
      await this.cleanupGovernedAttachmentFiles(
        nonConformity,
        governedAttachments,
      );
    }
    await this.logAudit(AuditAction.DELETE, id, before, null);
  }

  async listStoredFiles(filters: WeeklyBundleFilters) {
    const files = await this.documentGovernanceService.listFinalDocuments(
      'nonconformity',
      filters,
    );
    if (files.length === 0) {
      return files;
    }

    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'nao conformidades',
    );
    const relevantNonConformities = await this.nonConformitiesRepository.find({
      select: {
        id: true,
        pdf_file_key: true,
        pdf_folder_path: true,
        pdf_original_name: true,
      },
      where: {
        id: In(files.map((file) => file.entityId)),
        company_id: scope.companyId,
        deleted_at: IsNull(),
        ...(!scope.hasCompanyWideAccess
          ? { site_id: In(getScopedSiteIds(scope)) }
          : {}),
      },
    });
    const byId = new Map(
      relevantNonConformities.map((nonConformity) => [
        nonConformity.id,
        nonConformity,
      ]),
    );

    // O document_registry fica congelado no arquivo da 1ª emissão do PDF
    // oficial (a NC permite regenerar o PDF livremente enquanto não estiver
    // Encerrada, sem re-registrar a governança — ver NonConformitiesPdfService).
    // A própria NC é sempre a fonte da verdade do arquivo atual; sobrepomos
    // aqui para o painel de arquivos e o pacote semanal nunca servirem uma
    // versão desatualizada.
    return files
      .filter((file) => byId.has(file.entityId))
      .map((file) => {
        const nonConformity = byId.get(file.entityId);
        if (!nonConformity?.pdf_file_key) {
          return file;
        }
        return {
          ...file,
          fileKey: nonConformity.pdf_file_key,
          folderPath: nonConformity.pdf_folder_path || file.folderPath,
          originalName: nonConformity.pdf_original_name || file.originalName,
        };
      });
  }

  async getWeeklyBundle(filters: WeeklyBundleFilters) {
    const files = await this.listStoredFiles(filters);
    return this.documentBundleService.buildWeeklyPdfBundle(
      'Nao Conformidade',
      filters,
      files.map((file) => ({
        fileKey: file.fileKey,
        title: file.title,
        originalName: file.originalName,
        date: file.date,
      })),
    );
  }

  async getPdfAccess(id: string): Promise<NonConformityPdfAccessResponse> {
    const nc = await this.findOneEntity(id);
    if (!nc.pdf_file_key) {
      const response: NonConformityPdfAccessResponse = {
        entityId: nc.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        fileKey: null,
        folderPath: null,
        originalName: null,
        url: null,
        message: 'PDF final ainda não foi emitido para esta não conformidade.',
      };
      this.logNcEvent('log', 'nc_pdf_access_resolved', {
        entityId: nc.id,
        availability: response.availability,
        hasFinalPdf: response.hasFinalPdf,
      });
      return response;
    }

    try {
      const url = await this.documentStorageService.getSignedUrl(
        nc.pdf_file_key,
      );
      const response: NonConformityPdfAccessResponse = {
        entityId: nc.id,
        hasFinalPdf: true,
        availability: 'ready',
        fileKey: nc.pdf_file_key,
        folderPath: nc.pdf_folder_path || null,
        originalName: nc.pdf_original_name || null,
        url,
        message: null,
      };
      this.logNcEvent('log', 'nc_pdf_access_resolved', {
        entityId: nc.id,
        availability: response.availability,
        hasFinalPdf: response.hasFinalPdf,
      });
      return response;
    } catch (error) {
      const response: NonConformityPdfAccessResponse = {
        entityId: nc.id,
        hasFinalPdf: true,
        availability: 'registered_without_signed_url',
        fileKey: nc.pdf_file_key,
        folderPath: nc.pdf_folder_path || null,
        originalName: nc.pdf_original_name || null,
        url: null,
        message:
          'PDF final registrado, mas a URL segura do storage não está disponível no momento.',
      };
      this.logNcEvent('warn', 'nc_pdf_access_storage_degraded', {
        entityId: nc.id,
        availability: response.availability,
        errorMessage: error instanceof Error ? error.message : 'unknown',
      });
      return response;
    }
  }

  async attachAttachment(
    id: string,
    buffer: Buffer,
    originalName: string,
  ): Promise<NonConformityAttachmentAttachResponse> {
    return this.workflowLock.runExclusive(id, (assertLeaseHealthy) =>
      this.attachAttachmentLocked(id, buffer, originalName, assertLeaseHealthy),
    );
  }

  private async attachAttachmentLocked(
    id: string,
    buffer: Buffer,
    originalName: string,
    assertLeaseHealthy: () => void,
  ): Promise<NonConformityAttachmentAttachResponse> {
    const nc = await this.findOneEntity(id);
    this.assertNcDocumentMutable(nc);
    const mimeType = this.resolveSupportedNcAttachmentMimeType(buffer);

    const fileKey = this.documentStorageService.generateDocumentKey(
      nc.company_id,
      'nonconformity-attachments',
      id,
      originalName,
      {
        folderSegments: nc.site_id ? ['sites', nc.site_id] : [],
      },
    );

    try {
      assertLeaseHealthy();
      await this.documentStorageService.uploadFile(fileKey, buffer, mimeType);
    } catch (error) {
      this.logNcEvent('warn', 'nc_attachment_upload_failed', {
        entityId: nc.id,
        mimeType,
        errorMessage: error instanceof Error ? error.message : 'unknown',
      });
      throw error;
    }

    const reference = this.buildGovernedAttachmentReference({
      v: 1,
      kind: 'governed-storage',
      fileKey,
      originalName,
      mimeType,
      uploadedAt: new Date().toISOString(),
      sizeBytes: buffer.byteLength,
    });

    // Append atômico: re-lê a linha sob lock para não perder referências de
    // anexos gravadas por uploads concorrentes na mesma NC (read-modify-write).
    let saved: NonConformity;
    let beforeSnapshot: NonConformity;
    try {
      const { saved: lockedSaved, result: snapshot } =
        await this.mutateNcLocked(
          id,
          nc.company_id,
          (locked) => {
            this.assertNcDocumentMutable(locked);
            const snap = { ...locked };
            const currentAttachments = locked.anexos ?? [];
            if (
              !currentAttachments.includes(reference) &&
              currentAttachments.length >= MAX_NC_ATTACHMENTS
            ) {
              throw new BadRequestException(
                `Máximo de ${MAX_NC_ATTACHMENTS} anexos por não conformidade. Remova um anexo antes de enviar outro.`,
              );
            }
            locked.anexos = Array.from(
              new Set([...currentAttachments, reference]),
            );
            return snap;
          },
          { assertLeaseHealthy },
        );
      saved = lockedSaved;
      beforeSnapshot = snapshot;
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `nonconformity-attachment:${nc.id}`,
        fileKey,
        (key) => this.documentStorageService.deleteFile(key),
      );
      this.logNcEvent('warn', 'nc_attachment_persist_failed', {
        entityId: nc.id,
        mimeType,
        errorMessage: error instanceof Error ? error.message : 'unknown',
      });
      throw error;
    }

    await this.logAudit(AuditAction.UPDATE, saved.id, beforeSnapshot, saved);
    this.logNcEvent('log', 'nc_attachment_uploaded', {
      entityId: saved.id,
      mimeType,
      sizeBytes: buffer.byteLength,
      attachmentCount: saved.anexos?.length ?? 0,
      governedAttachment: true,
    });

    return {
      entityId: saved.id,
      attachments: saved.anexos ?? [],
      attachmentCount: saved.anexos?.length ?? 0,
      storageMode: 'governed-storage',
      degraded: false,
      message: 'Anexo governado salvo no storage oficial.',
      attachmentReference: reference,
      attachment: {
        index: (saved.anexos ?? []).findIndex((item) => item === reference),
        originalName,
        mimeType,
      },
    };
  }

  async removeAttachment(
    id: string,
    index: number,
  ): Promise<NonConformityAttachmentRemoveResponse> {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new BadRequestException('Índice de anexo inválido.');
    }

    return this.workflowLock.runExclusive(id, (assertLeaseHealthy) =>
      this.removeAttachmentLocked(id, index, assertLeaseHealthy),
    );
  }

  private async removeAttachmentLocked(
    id: string,
    index: number,
    assertLeaseHealthy: () => void,
  ): Promise<NonConformityAttachmentRemoveResponse> {
    const nc = await this.findOneEntity(id);
    this.assertNcDocumentMutable(nc);
    const attachmentReference = nc.anexos?.[index];
    const attachment =
      this.parseGovernedAttachmentReference(attachmentReference);
    if (!attachment || !attachmentReference) {
      throw new BadRequestException(
        'Somente anexos governados podem ser removidos imediatamente.',
      );
    }
    if (!this.isExpectedAttachmentStorageKey(nc, attachment.fileKey)) {
      throw new BadRequestException(
        'A referência de anexo não corresponde à não conformidade solicitada.',
      );
    }

    const { saved, result: before } = await this.mutateNcLocked(
      id,
      nc.company_id,
      (locked) => {
        this.assertNcDocumentMutable(locked);
        const lockedReference = locked.anexos?.[index];
        if (lockedReference !== attachmentReference) {
          throw new ConflictException(
            'A lista de anexos foi alterada por outra operação. Recarregue a não conformidade antes de tentar remover novamente.',
          );
        }

        const lockedAttachment =
          this.parseGovernedAttachmentReference(lockedReference);
        if (!lockedAttachment) {
          throw new BadRequestException(
            'O anexo solicitado não está disponível no storage governado.',
          );
        }

        const beforeSnapshot = { ...locked };
        locked.anexos = (locked.anexos ?? []).filter(
          (_item, attachmentIndex) => attachmentIndex !== index,
        );
        return beforeSnapshot;
      },
      {
        expectedUpdatedAt: nc.updated_at,
        assertLeaseHealthy,
      },
    );

    await this.logAudit(AuditAction.UPDATE, saved.id, before, saved);

    try {
      await this.documentStorageService.deleteFile(attachment.fileKey);
      this.logNcEvent('log', 'nc_attachment_removed_immediately', {
        entityId: saved.id,
        attachmentCount: saved.anexos?.length ?? 0,
      });
      return {
        entityId: saved.id,
        attachments: saved.anexos ?? [],
        attachmentCount: saved.anexos?.length ?? 0,
        removedAttachmentReference: attachmentReference,
        storageCleanup: 'removed',
        message: 'Anexo removido da não conformidade e do storage oficial.',
      };
    } catch (error) {
      this.logNcEvent('warn', 'nc_attachment_storage_cleanup_pending', {
        entityId: saved.id,
        errorMessage: error instanceof Error ? error.message : 'unknown',
      });
      return {
        entityId: saved.id,
        attachments: saved.anexos ?? [],
        attachmentCount: saved.anexos?.length ?? 0,
        removedAttachmentReference: attachmentReference,
        storageCleanup: 'pending',
        message:
          'Anexo removido da não conformidade; a limpeza do storage será conciliada.',
      };
    }
  }

  async getAttachmentAccess(
    id: string,
    index: number,
  ): Promise<NonConformityAttachmentAccessResponse> {
    const nc = await this.findOneEntity(id);
    const attachmentValue = nc.anexos?.[index];
    const governedAttachment =
      this.parseGovernedAttachmentReference(attachmentValue);

    if (!governedAttachment) {
      throw new BadRequestException(
        'O anexo solicitado não está disponível no storage governado.',
      );
    }
    if (!this.isExpectedAttachmentStorageKey(nc, governedAttachment.fileKey)) {
      throw new BadRequestException(
        'A referência de anexo não corresponde à não conformidade solicitada.',
      );
    }

    try {
      const url = await this.documentStorageService.getSignedUrl(
        governedAttachment.fileKey,
      );
      const response: NonConformityAttachmentAccessResponse = {
        entityId: nc.id,
        index,
        hasGovernedAttachment: true,
        availability: 'ready',
        fileKey: governedAttachment.fileKey,
        originalName: governedAttachment.originalName,
        mimeType: governedAttachment.mimeType,
        url,
        degraded: false,
        message: null,
      };
      this.logNcEvent('log', 'nc_attachment_access_resolved', {
        entityId: nc.id,
        index,
        availability: response.availability,
      });
      return response;
    } catch (error) {
      const response: NonConformityAttachmentAccessResponse = {
        entityId: nc.id,
        index,
        hasGovernedAttachment: true,
        availability: 'registered_without_signed_url',
        fileKey: governedAttachment.fileKey,
        originalName: governedAttachment.originalName,
        mimeType: governedAttachment.mimeType,
        url: null,
        degraded: true,
        message:
          'Anexo governado registrado, mas a URL segura do storage não está disponível no momento.',
      };
      this.logNcEvent('warn', 'nc_attachment_storage_degraded', {
        entityId: nc.id,
        index,
        errorMessage: error instanceof Error ? error.message : 'unknown',
      });
      return response;
    }
  }

  async getMonthlyAnalytics(): Promise<{ mes: string; total: number }[]> {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'nonconformities',
      { allowMissingSiteScope: true },
    );
    const qb = this.nonConformitiesRepository
      .createQueryBuilder('nc')
      .select("TO_CHAR(DATE_TRUNC('month', nc.created_at), 'YYYY-MM')", 'mes')
      .addSelect('COUNT(*)', 'total')
      .where('nc.deleted_at IS NULL')
      .andWhere("nc.created_at >= NOW() - INTERVAL '12 months'")
      .andWhere('nc.company_id = :companyId', { companyId: scope.companyId })
      .groupBy("DATE_TRUNC('month', nc.created_at)")
      .orderBy("DATE_TRUNC('month', nc.created_at)", 'ASC');

    if (!scope.hasCompanyWideAccess) {
      const siteIds = getScopedSiteIds(scope);
      if (siteIds.length === 0) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('nc.site_id IN (:...siteIds)', { siteIds });
      }
    }

    const rows = await qb.getRawMany<{ mes: string; total: string }>();
    return rows.map((r) => ({ mes: r.mes, total: Number(r.total) }));
  }

  async getAnalyticsOverview(): Promise<NonConformityAnalyticsOverview> {
    const summary = await this.summarizeByStatus();
    return {
      totalNonConformities: summary.total,
      abertas: summary.byStatus[NcStatus.ABERTA] ?? 0,
      emAndamento: summary.byStatus[NcStatus.EM_ANDAMENTO] ?? 0,
      aguardandoValidacao: summary.byStatus[NcStatus.AGUARDANDO_VALIDACAO] ?? 0,
      encerradas: summary.byStatus[NcStatus.ENCERRADA] ?? 0,
    };
  }

  /**
   * Valida a transição de status contra ALLOWED_TRANSITIONS e carimba
   * closed_at/resolved_by de forma consistente. Usado tanto por
   * updateStatus() (ação rápida "Mover status" da listagem) quanto por
   * update() (formulário completo de edição) — sem isso, o formulário
   * completo conseguia pular o fluxo de aprovação (ex.: Aberta -> Encerrada
   * direto) e encerrar a NC sem preencher closed_at/resolved_by, já que só
   * updateStatus() aplicava essas regras.
   */
  private applyValidatedStatusTransition(
    nc: NonConformity,
    newStatus: NcStatus,
  ): void {
    const current = this.normalizeStatus(nc.status);
    if (current === newStatus) {
      return;
    }
    if (nc.pdf_file_key) {
      throw new BadRequestException(
        'Não conformidade com PDF final emitido não pode ter o status alterado. Para corrigir dados, utilize o fluxo formal de retificação.',
      );
    }
    const allowed = ALLOWED_TRANSITIONS[current] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new UnprocessableEntityException(
        `Transição de "${current}" para "${newStatus}" não permitida`,
      );
    }
    nc.status = newStatus;
    if (newStatus === NcStatus.ENCERRADA) {
      this.assertReadyForClosure(nc);
      nc.closed_at = new Date();
      nc.resolved_by = RequestContext.getUserId() || null;
    } else if (current === NcStatus.ENCERRADA) {
      nc.closed_at = null;
      nc.resolved_by = null;
    }
  }

  async updateStatus(
    id: string,
    newStatus: NcStatus,
  ): Promise<NonConformityResponseDto> {
    return this.workflowLock.runExclusive(id, (assertLeaseHealthy) =>
      this.updateStatusLocked(id, newStatus, assertLeaseHealthy),
    );
  }

  private async updateStatusLocked(
    id: string,
    newStatus: NcStatus,
    assertLeaseHealthy: () => void,
  ): Promise<NonConformityResponseDto> {
    const nc = await this.findOneEntity(id);
    const requestedStatus = this.normalizeStatus(newStatus);
    if (requestedStatus === this.normalizeStatus(nc.status)) {
      // PATCH idempotente: não regrava nem acrescenta evento de auditoria
      // quando o cliente apenas repete o status já persistido.
      return this.toNonConformityResponse(nc);
    }
    const transitionPreview = { ...nc };
    this.applyValidatedStatusTransition(transitionPreview, requestedStatus);
    const { saved, result: before } = await this.mutateNcLocked(
      id,
      nc.company_id,
      (locked) => {
        this.assertNcDocumentMutable(locked);
        const beforeSnapshot = { ...locked };
        this.applyValidatedStatusTransition(locked, requestedStatus);
        return beforeSnapshot;
      },
      {
        expectedUpdatedAt: nc.updated_at,
        assertLeaseHealthy,
      },
    );
    await this.logAudit(AuditAction.UPDATE, saved.id, before, saved);
    return this.toNonConformityResponse(await this.findOneEntity(saved.id));
  }

  async count(options?: FindManyOptions<NonConformity>): Promise<number> {
    return this.nonConformitiesRepository.count(options);
  }

  async exportExcel(): Promise<Buffer> {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'nonconformities',
      { allowMissingSiteScope: true },
    );
    const qb = this.nonConformitiesRepository
      .createQueryBuilder('nc')
      .select([
        'nc.codigo_nc',
        'nc.tipo',
        'nc.status',
        'nc.data_identificacao',
        'nc.created_at',
      ])
      .where('nc.deleted_at IS NULL')
      .andWhere('nc.company_id = :companyId', { companyId: scope.companyId })
      .orderBy('nc.created_at', 'DESC')
      .take(5000);
    if (!scope.hasCompanyWideAccess) {
      const siteIds = getScopedSiteIds(scope);
      if (siteIds.length === 0) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('nc.site_id IN (:...siteIds)', { siteIds });
      }
    }
    const ncs = await qb.getMany();

    const rows = ncs.map((n) => ({
      'Código NC': n.codigo_nc,
      Tipo: n.tipo ?? '',
      Status: n.status,
      'Data de Identificação': n.data_identificacao
        ? new Date(n.data_identificacao).toLocaleDateString('pt-BR')
        : '',
      'Criado em': new Date(n.created_at).toLocaleDateString('pt-BR'),
    }));

    return jsonToExcelBuffer(rows, 'Não Conformidades');
  }

  private async logAudit(
    action: AuditAction,
    entityId: string,
    before: unknown,
    after: unknown,
  ) {
    const companyId = this.tenantService.getTenantId();
    if (!companyId) return;
    const beforeSnapshot = this.toAuditSnapshot(before);
    const afterSnapshot = this.toAuditSnapshot(after);
    await this.auditService.log({
      userId: RequestContext.getUserId() || 'system',
      action,
      entity: 'NonConformity',
      entityId,
      changes: {
        schema: 'nonconformity-audit-v2',
        changedFields: this.getAuditChangedFields(
          beforeSnapshot,
          afterSnapshot,
        ),
        before: beforeSnapshot,
        after: afterSnapshot,
      },
      ip: (RequestContext.get('ip') as string) || 'unknown',
      userAgent: RequestContext.get('userAgent') || 'unknown',
      companyId,
    });
  }
}
