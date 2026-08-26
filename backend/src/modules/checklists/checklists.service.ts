import {
  Injectable,
  NotFoundException,
  Inject,
  forwardRef,
  Logger,
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  DataSource,
  EntityManager,
  FindOptionsSelect,
  FindOptionsWhere,
  DeepPartial,
  In,
  IsNull,
} from 'typeorm';
import { plainToClass } from 'class-transformer';
import { ConfigService } from '@nestjs/config';
import { IntegrationResilienceService } from '../../shared/resilience/integration-resilience.service';
import { Checklist } from './entities/checklist.entity';
import { ChecklistResponseDto } from './dto/checklist-response.dto';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import { CreateChecklistDto } from './dto/create-checklist.dto';
import { UpdateChecklistDto } from './dto/update-checklist.dto';
import { MailService } from '../../infra/mail/mail.service';
import { SignaturesService } from '../signatures/signatures.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { FileParserService } from '../document-import/services/file-parser.service';
import {
  cleanupUploadedFile,
  storageKeyFingerprint,
} from '../../shared/storage/storage-compensation.util';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { UsersService } from '../users/users.service';
import { SitesService } from '../sites/sites.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import {
  applyBackendPdfFooter,
  backendPdfTheme,
  createBackendPdfTableTheme,
  drawBackendPdfHeader,
  drawBackendSectionTitle,
  getBackendLastTableY,
} from '../../shared/services/pdf-branding';

import { NotificationsGateway } from '../notifications/notifications.gateway';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { WeeklyBundleFilters } from '../../shared/services/document-bundle.service';
import { DocumentBundleService } from '../../shared/services/document-bundle.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentRegistryService } from '../document-registry/document-registry.service';
import { RequestContext } from '../../shared/middleware/request-context.middleware';
import { getIsoWeekNumber } from '../../shared/utils/document-calendar.util';
import { requestOpenAiChatCompletionResponse } from '../ai/openai-request.util';
import {
  isConfiguredAiLlmRuntime,
  resolveAiLlmRuntimeConfig,
} from '../ai/ai-llm.config';
import { OpenAiCircuitBreakerService } from '../../shared/resilience/openai-circuit-breaker.service';
import { escapeLikePattern } from '../../shared/utils/sql.util';
import { sanitizePlainText } from '../../shared/utils/plain-text-sanitizer.util';
import {
  CHECKLIST_BARRIER_TYPE_VALUES,
  CHECKLIST_ITEM_CRITICALITY_VALUES,
  ChecklistItemValue,
  ChecklistSubitemValue,
  ChecklistTopicValue,
} from './types/checklist-item.type';
import {
  CHECKLIST_PRESET_SEEDS,
  getChecklistPresetSeedByKey,
  type ChecklistPresetSeedDefinition,
  type ChecklistPresetSeedKey,
} from './presets';
import {
  GovernedPdfAccessAvailability,
  GovernedPdfAccessResponseDto,
} from '../../shared/dto/governed-pdf-access-response.dto';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';

type ChecklistPdfAccessAvailability = GovernedPdfAccessAvailability;
type ChecklistPdfAccessResponse = GovernedPdfAccessResponseDto;

type ChecklistSegment =
  'normativos' | 'operacionais' | 'equipamentos' | 'veiculos' | 'epis';

type ChecklistPhotoAccessAvailability =
  'ready' | 'registered_without_signed_url';

type ChecklistPhotoAccessResponse = {
  entityId: string;
  scope: 'equipment' | 'item';
  itemIndex: number | null;
  photoIndex: number | null;
  hasGovernedPhoto: true;
  availability: ChecklistPhotoAccessAvailability;
  fileKey: string;
  originalName: string;
  mimeType: string;
  url: string | null;
  degraded: boolean;
  message: string | null;
};

type ChecklistPhotoAttachResponse = {
  entityId: string;
  scope: 'equipment' | 'item';
  itemIndex: number | null;
  photoIndex: number | null;
  storageMode: 'governed-storage';
  degraded: false;
  message: string;
  photoReference: string;
  photo: {
    // fileKey omitted from response for security (no raw storage keys in JSON)
    originalName: string;
    mimeType: string;
  };
  signaturesReset: boolean;
};

type PresetChecklistTemplateDefinition = {
  titulo: string;
  descricao: string;
  categoria: string;
  periodicidade: string;
  nivel_risco_padrao: string;
  itens: ChecklistItemValue[];
  equipamento?: string;
  maquina?: string;
  foto_equipamento?: string;
};

type GovernedChecklistPhotoReferencePayload = {
  v: 1;
  kind: 'governed-storage';
  scope: 'equipment' | 'item';
  fileKey: string;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  sizeBytes?: number | null;
};

const GOVERNED_CHECKLIST_PHOTO_REF_PREFIX = 'gst:checklist-photo:';
const CHECKLIST_BARRIER_TYPE_SET = new Set<string>(
  CHECKLIST_BARRIER_TYPE_VALUES,
);
const CHECKLIST_ITEM_CRITICALITY_SET = new Set<string>(
  CHECKLIST_ITEM_CRITICALITY_VALUES,
);
const CHECKLIST_SEGMENT_FIELDS = [
  'titulo',
  'descricao',
  'equipamento',
  'maquina',
] as const;
const CHECKLIST_SEGMENT_KEYWORDS = {
  normativos: ['nr', 'loto'],
  operacionais: [
    'operacional',
    'pre-uso',
    'pré-uso',
    'rotina',
    'diario',
    'diário',
  ],
  equipamentos: [
    'equipamento',
    'maquina',
    'máquina',
    'ferramenta',
    'plataforma',
    'escada',
    'solda',
    'lixadeira',
    'furadeira',
    'parafusadeira',
  ],
  veiculos: [
    'veiculo',
    'veículo',
    'caminhao',
    'caminhão',
    'munck',
    'guindauto',
    'carreta',
    'frota',
    'automovel',
    'automóvel',
    'caminhonete',
  ],
  epis: [
    'epi',
    'talabarte',
    'cinto',
    'capacete',
    'luva',
    'oculos',
    'óculos',
    'protetor',
    'mascara',
    'máscara',
    'respirador',
  ],
} satisfies Record<ChecklistSegment, string[]>;

// Coordenação de concorrência das mutações de checklist (espelha APR/PT).
// FOR UPDATE NOWAIT falha com 55P03 quando a linha já está travada; então
// reprocessamos com backoff curto e, esgotadas as tentativas, devolvemos 409.
const CHECKLIST_POSTGRES_LOCK_NOT_AVAILABLE_CODE = '55P03';
const CHECKLIST_ROW_LOCK_RETRY_DELAYS_MS = [50, 100, 200] as const;

@Injectable()
export class ChecklistsService {
  private readonly logger = new Logger(ChecklistsService.name);
  private static readonly MAX_INLINE_IMAGE_BYTES = 1 * 1024 * 1024;
  private normalizeChecklistSegment(
    segment?: string | null,
  ): ChecklistSegment | undefined {
    const normalized = segment?.trim().toLowerCase();
    if (
      normalized === 'normativos' ||
      normalized === 'operacionais' ||
      normalized === 'equipamentos' ||
      normalized === 'veiculos' ||
      normalized === 'epis'
    ) {
      return normalized;
    }
    return undefined;
  }

  private buildChecklistSegmentClause(
    alias: string,
    segment: ChecklistSegment,
  ): { sql: string; params: Record<string, string> } {
    const buildAnyFieldClause = (
      tokenPrefix: string,
      tokens: string[],
    ): { sql: string; params: Record<string, string> } => {
      const params: Record<string, string> = {};
      const tokenClauses = tokens
        .map((token, tokenIndex) => {
          const paramName = `${tokenPrefix}_${tokenIndex}`;
          params[paramName] = `%${escapeLikePattern(token)}%`;
          const fieldClauses = CHECKLIST_SEGMENT_FIELDS.map(
            (field) => `${alias}.${field} ILIKE :${paramName}`,
          );
          return `(${fieldClauses.join(' OR ')})`;
        })
        .filter(Boolean);

      return {
        sql:
          tokenClauses.length > 0 ? `(${tokenClauses.join(' OR ')})` : 'FALSE',
        params,
      };
    };

    const params: Record<string, string> = {};

    switch (segment) {
      case 'normativos': {
        const categoryClause = `${alias}.categoria = :${segment}_category`;
        params[`${segment}_category`] = 'Operacional';
        const keywordClause = buildAnyFieldClause(
          `${segment}_keyword`,
          CHECKLIST_SEGMENT_KEYWORDS.normativos,
        );
        return {
          sql: `(${categoryClause} AND ${keywordClause.sql})`,
          params: {
            ...params,
            ...keywordClause.params,
          },
        };
      }
      case 'operacionais': {
        const categoryClause = `${alias}.categoria = :${segment}_category`;
        params[`${segment}_category`] = 'Operacional';
        const excludeClause = buildAnyFieldClause(`${segment}_exclude`, [
          ...CHECKLIST_SEGMENT_KEYWORDS.normativos,
          ...CHECKLIST_SEGMENT_KEYWORDS.equipamentos,
          ...CHECKLIST_SEGMENT_KEYWORDS.veiculos,
          ...CHECKLIST_SEGMENT_KEYWORDS.epis,
        ]);
        return {
          sql: `(${categoryClause} AND NOT ${excludeClause.sql})`,
          params: {
            ...params,
            ...excludeClause.params,
          },
        };
      }
      case 'equipamentos': {
        const categoryClause = `${alias}.categoria = :${segment}_category`;
        params[`${segment}_category`] = 'Equipamento';
        const positiveClause = buildAnyFieldClause(
          `${segment}_positive`,
          CHECKLIST_SEGMENT_KEYWORDS.equipamentos,
        );
        const excludeClause = buildAnyFieldClause(`${segment}_exclude`, [
          ...CHECKLIST_SEGMENT_KEYWORDS.veiculos,
          ...CHECKLIST_SEGMENT_KEYWORDS.epis,
        ]);
        return {
          sql: `((${categoryClause} OR ${positiveClause.sql}) AND NOT ${excludeClause.sql})`,
          params: {
            ...params,
            ...positiveClause.params,
            ...excludeClause.params,
          },
        };
      }
      case 'veiculos': {
        const vehicleClause = buildAnyFieldClause(
          `${segment}_vehicle`,
          CHECKLIST_SEGMENT_KEYWORDS.veiculos,
        );
        return vehicleClause;
      }
      case 'epis': {
        const categoryClause = `${alias}.categoria = :${segment}_category`;
        params[`${segment}_category`] = 'EPI';
        const positiveClause = buildAnyFieldClause(
          `${segment}_positive`,
          CHECKLIST_SEGMENT_KEYWORDS.epis,
        );
        return {
          sql: `(${categoryClause} OR ${positiveClause.sql})`,
          params: {
            ...params,
            ...positiveClause.params,
          },
        };
      }
    }

    return { sql: 'TRUE', params: {} };
  }

  private buildPresetTemplateDefinition(
    seed: ChecklistPresetSeedDefinition,
  ): PresetChecklistTemplateDefinition {
    return {
      titulo: seed.titulo,
      descricao: seed.descricao,
      categoria: seed.categoria,
      periodicidade: seed.periodicidade,
      nivel_risco_padrao: seed.nivel_risco_padrao,
      equipamento: seed.equipamento,
      maquina: seed.maquina,
      foto_equipamento: seed.foto_equipamento,
      itens: this.resolveChecklistItemsForPersistence({
        topicos: seed.buildTopics(),
      }),
    };
  }

  private presetSeedHasExistingTitle(
    seed: ChecklistPresetSeedDefinition,
    existingTitles: Set<string>,
  ): boolean {
    return [seed.titulo, ...(seed.aliases ?? [])].some((title) =>
      existingTitles.has(title),
    );
  }

  constructor(
    @InjectRepository(Checklist)
    private checklistsRepository: Repository<Checklist>,
    private tenantService: TenantService,
    private dataSource: DataSource,
    @Inject(forwardRef(() => MailService))
    private mailService: MailService,
    private signaturesService: SignaturesService,
    private notificationsGateway: NotificationsGateway,
    private readonly documentStorageService: DocumentStorageService,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    private sitesService: SitesService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly documentRegistryService: DocumentRegistryService,
    private readonly fileParserService: FileParserService,
    private readonly configService: ConfigService,
    private readonly integrationResilienceService: IntegrationResilienceService,
    private readonly openAiCircuitBreaker: OpenAiCircuitBreakerService,
    private readonly documentBundleService: DocumentBundleService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
  ) {}

  /**
   * Código documental + token de validação pública (grant). O código é
   * determinístico (o mesmo do anexo do PDF final), então o token vale
   * antes e depois da emissão.
   */
  async getValidationContext(
    id: string,
  ): Promise<{ documentCode: string; token: string | null }> {
    const checklist = await this.findOne(id);
    const documentCode = this.buildChecklistDocumentCode(checklist);
    let token: string | null = null;

    try {
      token = await this.publicValidationGrantService.issueToken({
        code: documentCode,
        companyId: checklist.company_id,
        portal: 'checklist_public_validation',
        documentId: checklist.id,
      });
    } catch (error) {
      this.logger.warn({
        event: 'checklist_validation_token_unavailable',
        checklistId: checklist.id,
        companyId: checklist.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return { documentCode, token };
  }

  private readonly checklistListSelect: FindOptionsSelect<Checklist> = {
    id: true,
    titulo: true,
    descricao: true,
    equipamento: true,
    maquina: true,
    data: true,
    status: true,
    company_id: true,
    site_id: true,
    inspetor_id: true,
    is_modelo: true,
    created_at: true,
    updated_at: true,
    pdf_file_key: true,
    pdf_folder_path: true,
    pdf_original_name: true,
    company: {
      id: true,
      razao_social: true,
    },
    site: {
      id: true,
      nome: true,
    },
    inspetor: {
      id: true,
      nome: true,
    },
  };

  private getTenantContextOrThrow(): {
    companyId: string;
    siteId?: string;
    siteIds: string[];
    siteScope: 'single' | 'all';
    isSuperAdmin: boolean;
  } {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'checklists',
    );

    return {
      companyId: scope.companyId,
      siteId: scope.siteId,
      siteIds: scope.siteIds,
      siteScope: scope.siteScope,
      isSuperAdmin: scope.isSuperAdmin,
    };
  }

  /**
   * Aplica uma mutação em um checklist sob SELECT FOR UPDATE, tornando o
   * read-modify-write atômico. Sem isso, dois anexos de foto concorrentes na
   * mesma checklist (ex.: burst/retry do app mobile) fazem `save()` da linha
   * inteira e a segunda escrita sobrescreve a primeira — foto perdida do
   * documento + arquivo órfão no storage. Espelha executePtWorkflowTransition.
   *
   * A autorização/escopo já foi validada pelo findOneEntity que precede a
   * chamada; o lock apenas serializa escritores concorrentes na mesma linha.
   */
  private async mutateChecklistLocked<T>(
    id: string,
    apply: (checklist: Checklist, manager: EntityManager) => T | Promise<T>,
  ): Promise<{ saved: Checklist; result: T }> {
    const { companyId } = this.getTenantContextOrThrow();

    for (
      let attempt = 0;
      attempt <= CHECKLIST_ROW_LOCK_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        return await this.checklistsRepository.manager.transaction(
          async (manager) => {
            const rows = await manager.query<Checklist[]>(
              `SELECT * FROM "checklists" WHERE "id" = $1 AND "company_id" = $2 AND "deleted_at" IS NULL FOR UPDATE NOWAIT`,
              [id, companyId],
            );
            if (!rows || rows.length === 0) {
              throw new NotFoundException(
                `Checklist com ID ${id} não encontrado`,
              );
            }
            const checklist = manager.getRepository(Checklist).create(rows[0]);
            const result = await apply(checklist, manager);
            const saved = await manager
              .getRepository(Checklist)
              .save(checklist);
            return { saved, result };
          },
        );
      } catch (error: unknown) {
        if (!this.isPostgresLockNotAvailableError(error)) {
          throw error;
        }
        const retryDelayMs = CHECKLIST_ROW_LOCK_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined) {
          throw new ConflictException(
            'Outra operação está em andamento para este checklist. Tente novamente em instantes.',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    throw new ConflictException(
      'Outra operação está em andamento para este checklist. Tente novamente em instantes.',
    );
  }

  private isPostgresLockNotAvailableError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code ===
        CHECKLIST_POSTGRES_LOCK_NOT_AVAILABLE_CODE
    );
  }

  private async getAllowedChecklistIdsForCurrentScope(): Promise<Set<string> | null> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();

    if (isSuperAdmin || siteScope === 'all') {
      return null;
    }

    const scopedChecklists = await this.checklistsRepository.find({
      select: ['id'],
      where: {
        company_id: companyId,
        site_id: In(siteIds),
        deleted_at: IsNull(),
      },
    });

    return new Set(scopedChecklists.map((item) => item.id));
  }

  private assertChecklistExecutionRequirements(
    checklist: Pick<Checklist, 'is_modelo' | 'site_id' | 'inspetor_id'>,
  ) {
    if (checklist.is_modelo) {
      return;
    }

    if (!checklist.site_id) {
      throw new BadRequestException(
        'Checklist operacional exige obra/setor vinculado.',
      );
    }

    if (!checklist.inspetor_id) {
      throw new BadRequestException(
        'Checklist operacional exige inspetor responsável.',
      );
    }
  }

  private assertChecklistDocumentMutable(
    checklist: Pick<Checklist, 'is_modelo' | 'pdf_file_key'>,
  ) {
    if (checklist.is_modelo) {
      return;
    }

    if (checklist.pdf_file_key) {
      throw new BadRequestException(
        'Checklist com PDF final emitido. Edição bloqueada. Gere um novo checklist para alterar o documento.',
      );
    }
  }

  private async assertChecklistReadyForFinalPdf(
    checklist: Pick<
      Checklist,
      'id' | 'is_modelo' | 'site_id' | 'inspetor_id' | 'pdf_file_key'
    >,
  ) {
    if (checklist.is_modelo) {
      throw new BadRequestException(
        'Modelos de checklist não podem ser emitidos como documento final.',
      );
    }

    this.assertChecklistExecutionRequirements(checklist);
    this.assertChecklistDocumentMutable(checklist);

    const signatures = await this.signaturesService.findByDocument(
      checklist.id,
      'CHECKLIST',
    );

    if (!signatures.length) {
      throw new BadRequestException(
        'Checklist precisa de ao menos uma assinatura antes da emissão do PDF final.',
      );
    }
  }

  private logChecklistEvent(
    event: string,
    checklist: Pick<Checklist, 'id' | 'company_id'> | null,
    extra?: Record<string, unknown>,
  ) {
    this.logger.log({
      event,
      checklistId: checklist?.id ?? null,
      companyId: checklist?.company_id ?? this.tenantService.getTenantId(),
      requestId: RequestContext.getRequestId(),
      actorId: RequestContext.getUserId(),
      ...extra,
    });
  }

  private rethrowHttpAware(error: unknown, fallbackMessage: string): never {
    if (error instanceof HttpException) {
      throw error;
    }
    throw new InternalServerErrorException(fallbackMessage, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  private hashRecipient(recipient: string): string {
    return createHash('sha256')
      .update(recipient.trim().toLowerCase())
      .digest('hex')
      .slice(0, 16);
  }

  private getInlineImageByteLength(imageData: string): number {
    const trimmed = imageData.trim();
    const base64 = trimmed.includes(',')
      ? trimmed.split(',')[1] || ''
      : trimmed;
    const normalized = base64.replace(/\s+/g, '');

    if (!normalized) {
      return 0;
    }

    const padding = normalized.endsWith('==')
      ? 2
      : normalized.endsWith('=')
        ? 1
        : 0;

    return Math.floor((normalized.length * 3) / 4) - padding;
  }

  private encodeBase64Url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  private decodeBase64Url(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf8');
  }

  private buildGovernedChecklistPhotoReference(
    payload: GovernedChecklistPhotoReferencePayload,
  ): string {
    return `${GOVERNED_CHECKLIST_PHOTO_REF_PREFIX}${this.encodeBase64Url(JSON.stringify(payload))}`;
  }

  private parseGovernedChecklistPhotoReference(
    value?: string | null,
  ): GovernedChecklistPhotoReferencePayload | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (
      !normalized ||
      !normalized.startsWith(GOVERNED_CHECKLIST_PHOTO_REF_PREFIX)
    ) {
      return null;
    }

    const encodedPayload = normalized.slice(
      GOVERNED_CHECKLIST_PHOTO_REF_PREFIX.length,
    );
    if (!encodedPayload) {
      throw new BadRequestException(
        'Referência de foto governada do checklist inválida.',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.decodeBase64Url(encodedPayload));
    } catch {
      throw new BadRequestException(
        'Referência de foto governada do checklist inválida.',
      );
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as GovernedChecklistPhotoReferencePayload).v !== 1 ||
      (parsed as GovernedChecklistPhotoReferencePayload).kind !==
        'governed-storage' ||
      ((parsed as GovernedChecklistPhotoReferencePayload).scope !==
        'equipment' &&
        (parsed as GovernedChecklistPhotoReferencePayload).scope !== 'item') ||
      typeof (parsed as GovernedChecklistPhotoReferencePayload).fileKey !==
        'string' ||
      typeof (parsed as GovernedChecklistPhotoReferencePayload).originalName !==
        'string' ||
      typeof (parsed as GovernedChecklistPhotoReferencePayload).mimeType !==
        'string' ||
      typeof (parsed as GovernedChecklistPhotoReferencePayload).uploadedAt !==
        'string'
    ) {
      throw new BadRequestException(
        'Referência de foto governada do checklist inválida.',
      );
    }

    return parsed as GovernedChecklistPhotoReferencePayload;
  }

  private normalizeInlineImage(
    imageData: unknown,
    fieldLabel: string,
  ): string | undefined {
    if (typeof imageData !== 'string') {
      return undefined;
    }

    const trimmed = imageData.trim();
    if (!trimmed) {
      return undefined;
    }

    if (/^javascript:/i.test(trimmed)) {
      throw new BadRequestException(`${fieldLabel} possui URL inválida.`);
    }

    if (!trimmed.startsWith('data:image/')) {
      return trimmed;
    }

    const matchesDataImage = /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(
      trimmed,
    );
    if (!matchesDataImage) {
      throw new BadRequestException(`${fieldLabel} possui formato inválido.`);
    }

    const byteLength = this.getInlineImageByteLength(trimmed);
    if (byteLength > ChecklistsService.MAX_INLINE_IMAGE_BYTES) {
      throw new BadRequestException(
        `${fieldLabel} excede o limite de ${Math.floor(
          ChecklistsService.MAX_INLINE_IMAGE_BYTES / 1024 / 1024,
        )} MB.`,
      );
    }

    return trimmed;
  }

  private normalizeChecklistPhotoReference(
    imageData: unknown,
    fieldLabel: string,
    options?: {
      allowedGovernedReferences?: Set<string>;
    },
  ): string | undefined {
    if (typeof imageData !== 'string') {
      return undefined;
    }

    const normalized = imageData.trim();
    if (!normalized) {
      return undefined;
    }

    const governedPayload =
      this.parseGovernedChecklistPhotoReference(normalized);
    if (governedPayload) {
      if (!options?.allowedGovernedReferences?.has(normalized)) {
        throw new BadRequestException(
          `${fieldLabel} deve ser enviado pelo endpoint governado de fotos do checklist.`,
        );
      }
      return normalized;
    }

    return this.normalizeInlineImage(imageData, fieldLabel);
  }

  private getAllowedGovernedChecklistPhotoReferences(
    checklist: Pick<Checklist, 'foto_equipamento' | 'itens'>,
  ): Set<string> {
    return new Set(
      this.getGovernedChecklistPhotoEntries(checklist).map(
        (entry) => entry.reference,
      ),
    );
  }

  private getGovernedChecklistPhotoEntries(
    checklist: Pick<Checklist, 'foto_equipamento' | 'itens'>,
  ): Array<{
    reference: string;
    payload: GovernedChecklistPhotoReferencePayload;
    scope: 'equipment' | 'item';
    itemIndex: number | null;
    photoIndex: number | null;
  }> {
    const entries: Array<{
      reference: string;
      payload: GovernedChecklistPhotoReferencePayload;
      scope: 'equipment' | 'item';
      itemIndex: number | null;
      photoIndex: number | null;
    }> = [];

    if (typeof checklist.foto_equipamento === 'string') {
      const payload = this.parseGovernedChecklistPhotoReference(
        checklist.foto_equipamento,
      );
      if (payload) {
        entries.push({
          reference: checklist.foto_equipamento,
          payload,
          scope: 'equipment',
          itemIndex: null,
          photoIndex: null,
        });
      }
    }

    (Array.isArray(checklist.itens) ? checklist.itens : []).forEach(
      (item, itemIndex) => {
        (Array.isArray(item?.fotos) ? item.fotos : []).forEach(
          (photo, photoIndex) => {
            const payload = this.parseGovernedChecklistPhotoReference(photo);
            if (!payload) {
              return;
            }
            entries.push({
              reference: photo,
              payload,
              scope: 'item',
              itemIndex,
              photoIndex,
            });
          },
        );
      },
    );

    return entries;
  }

  private buildChecklistAlphabeticLabel(index: number): string {
    let value = index + 1;
    let label = '';

    while (value > 0) {
      const remainder = (value - 1) % 26;
      label = String.fromCharCode(65 + remainder) + label;
      value = Math.floor((value - 1) / 26);
    }

    return label;
  }

  private normalizeChecklistSubitems(
    subitems: unknown,
    options?: { resetExecutionState?: boolean },
  ): ChecklistSubitemValue[] {
    if (!Array.isArray(subitems)) {
      return [];
    }

    return subitems
      .map((subitem, index) => {
        const current =
          subitem && typeof subitem === 'object'
            ? (subitem as Record<string, unknown>)
            : {};
        const rawTexto =
          typeof current.descricao === 'string'
            ? current.descricao
            : typeof current.texto === 'string'
              ? current.texto
              : typeof current.item === 'string'
                ? current.item
                : '';
        const texto = rawTexto
          ? (sanitizePlainText(rawTexto) as string).trim()
          : '';

        if (!texto) {
          return null;
        }

        const normalized: ChecklistSubitemValue = {
          texto,
          ordem:
            typeof current.ordem === 'number' && Number.isFinite(current.ordem)
              ? current.ordem
              : index + 1,
          status: options?.resetExecutionState
            ? undefined
            : typeof current.status === 'string' ||
                typeof current.status === 'boolean'
              ? (current.status as ChecklistSubitemValue['status'])
              : undefined,
          resposta: options?.resetExecutionState ? '' : current.resposta,
          observacao: options?.resetExecutionState
            ? ''
            : typeof current.observacao === 'string'
              ? (sanitizePlainText(current.observacao) as string).trim()
              : '',
        };

        if (typeof current.id === 'string' && current.id.trim()) {
          normalized.id = current.id.trim();
        }

        return normalized;
      })
      .filter((value): value is ChecklistSubitemValue => value !== null);
  }

  private normalizeChecklistBarrierType(
    value: unknown,
  ): ChecklistItemValue['barreira_tipo'] | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized || !CHECKLIST_BARRIER_TYPE_SET.has(normalized)) {
      return undefined;
    }

    return normalized as ChecklistItemValue['barreira_tipo'];
  }

  private normalizeChecklistCriticality(
    value: unknown,
  ): ChecklistItemValue['criticidade'] | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized || !CHECKLIST_ITEM_CRITICALITY_SET.has(normalized)) {
      return undefined;
    }

    return normalized as ChecklistItemValue['criticidade'];
  }

  private normalizeChecklistPositiveNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }

    return value;
  }

  private classifyChecklistItemAssessment(
    item: Record<string, unknown>,
  ): 'rompido' | 'degradado' | 'pendente' | 'integro' {
    const assessmentStatuses = this.getChecklistAssessmentStatuses(item);

    if (!assessmentStatuses.length) {
      return 'pendente';
    }

    let hasApplicableStatus = false;

    for (const status of assessmentStatuses) {
      if (
        status === 'nok' ||
        status === 'nao' ||
        status === false ||
        status === 'Não Conforme'
      ) {
        const isCritical =
          this.normalizeChecklistCriticality(item.criticidade) === 'critico';
        const blocksOperation =
          typeof item.bloqueia_operacao_quando_nc === 'boolean'
            ? item.bloqueia_operacao_quando_nc
            : false;
        return isCritical || blocksOperation ? 'rompido' : 'degradado';
      }

      if (
        status !== undefined &&
        status !== null &&
        status !== '' &&
        status !== 'Pendente'
      ) {
        hasApplicableStatus = true;
      }
    }

    return hasApplicableStatus ? 'integro' : 'pendente';
  }

  private normalizeChecklistItemValue(
    item: unknown,
    options?: {
      topicoId?: string;
      topicoTitulo?: string;
      topicoDescricao?: string;
      ordemTopico?: number;
      ordemItem?: number;
      barreiraTipo?: ChecklistItemValue['barreira_tipo'];
      pesoBarreira?: number;
      limiteRuptura?: number;
      resetExecutionState?: boolean;
      allowedGovernedReferences?: Set<string>;
    },
  ): ChecklistItemValue | null {
    const current =
      item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const itemTitle =
      typeof current.item === 'string'
        ? (sanitizePlainText(current.item) as string).trim()
        : '';

    if (!itemTitle) {
      return null;
    }

    const normalizedItem: ChecklistItemValue = {
      id:
        typeof current.id === 'string' && current.id.trim()
          ? current.id.trim()
          : undefined,
      item: itemTitle,
      topico_id:
        typeof current.topico_id === 'string' && current.topico_id.trim()
          ? current.topico_id.trim()
          : options?.topicoId,
      topico_titulo:
        typeof current.topico_titulo === 'string' &&
        (sanitizePlainText(current.topico_titulo) as string).trim()
          ? (sanitizePlainText(current.topico_titulo) as string).trim()
          : options?.topicoTitulo,
      topico_descricao:
        typeof current.topico_descricao === 'string' &&
        (sanitizePlainText(current.topico_descricao) as string).trim()
          ? (sanitizePlainText(current.topico_descricao) as string).trim()
          : options?.topicoDescricao,
      ordem_topico:
        typeof current.ordem_topico === 'number' &&
        Number.isFinite(current.ordem_topico)
          ? current.ordem_topico
          : options?.ordemTopico,
      ordem_item:
        typeof current.ordem_item === 'number' &&
        Number.isFinite(current.ordem_item)
          ? current.ordem_item
          : options?.ordemItem,
      tipo_resposta:
        typeof current.tipo_resposta === 'string'
          ? (current.tipo_resposta as ChecklistItemValue['tipo_resposta'])
          : 'sim_nao_na',
      obrigatorio:
        typeof current.obrigatorio === 'boolean'
          ? current.obrigatorio
          : Boolean(current.obrigatorio ?? true),
      peso:
        typeof current.peso === 'number' && Number.isFinite(current.peso)
          ? current.peso
          : 1,
      barreira_tipo:
        this.normalizeChecklistBarrierType(current.barreira_tipo) ??
        options?.barreiraTipo,
      peso_barreira:
        this.normalizeChecklistPositiveNumber(current.peso_barreira) ??
        options?.pesoBarreira,
      limite_ruptura:
        this.normalizeChecklistPositiveNumber(current.limite_ruptura) ??
        options?.limiteRuptura,
      criticidade: this.normalizeChecklistCriticality(current.criticidade),
      bloqueia_operacao_quando_nc:
        typeof current.bloqueia_operacao_quando_nc === 'boolean'
          ? current.bloqueia_operacao_quando_nc
          : undefined,
      exige_foto_quando_nc:
        typeof current.exige_foto_quando_nc === 'boolean'
          ? current.exige_foto_quando_nc
          : undefined,
      exige_observacao_quando_nc:
        typeof current.exige_observacao_quando_nc === 'boolean'
          ? current.exige_observacao_quando_nc
          : undefined,
      acao_corretiva_imediata:
        typeof current.acao_corretiva_imediata === 'string' &&
        (sanitizePlainText(current.acao_corretiva_imediata) as string).trim()
          ? (
              sanitizePlainText(current.acao_corretiva_imediata) as string
            ).trim()
          : undefined,
      subitens: this.normalizeChecklistSubitems(current.subitens, options),
    };

    if (options?.resetExecutionState) {
      normalizedItem.status =
        normalizedItem.tipo_resposta === 'conforme' ? 'ok' : 'sim';
      normalizedItem.resposta = '';
      normalizedItem.observacao = '';
      normalizedItem.fotos = [];
    } else {
      normalizedItem.status =
        typeof current.status === 'string' ||
        typeof current.status === 'boolean'
          ? (current.status as ChecklistItemValue['status'])
          : 'ok';
      normalizedItem.resposta =
        typeof current.resposta === 'string'
          ? sanitizePlainText(current.resposta)
          : (current.resposta ?? '');
      normalizedItem.observacao =
        typeof current.observacao === 'string'
          ? (sanitizePlainText(current.observacao) as string)
          : '';
      normalizedItem.fotos = Array.isArray(current.fotos)
        ? current.fotos.filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
    }

    return normalizedItem;
  }

  private normalizeChecklistItems(
    items: unknown,
    options?: {
      resetExecutionState?: boolean;
      allowedGovernedReferences?: Set<string>;
    },
  ): ChecklistItemValue[] {
    if (!Array.isArray(items)) {
      return [];
    }

    return items
      .map((item, index) =>
        this.normalizeChecklistItemValue(item, {
          ...options,
          ordemItem: index + 1,
        }),
      )
      .filter((value): value is ChecklistItemValue => value !== null)
      .map((item, index) => ({
        ...item,
        fotos: Array.isArray(item.fotos)
          ? item.fotos
              .map((photo) =>
                this.normalizeChecklistPhotoReference(
                  photo,
                  `Foto do item ${index + 1} do checklist`,
                  {
                    allowedGovernedReferences:
                      options?.allowedGovernedReferences,
                  },
                ),
              )
              .filter((photo): photo is string => Boolean(photo))
          : [],
      }));
  }

  private flattenChecklistTopics(
    topicos: unknown,
    options?: {
      resetExecutionState?: boolean;
      allowedGovernedReferences?: Set<string>;
    },
  ): ChecklistItemValue[] {
    if (!Array.isArray(topicos)) {
      return [];
    }

    return topicos.flatMap((topico, topicoIndex) => {
      const current =
        topico && typeof topico === 'object'
          ? (topico as Record<string, unknown>)
          : {};
      const topicoId =
        typeof current.id === 'string' && current.id.trim()
          ? current.id.trim()
          : `topic-${topicoIndex + 1}`;
      const rawTopicoTitulo =
        typeof current.titulo === 'string' ? current.titulo : '';
      const topicoTitulo = rawTopicoTitulo
        ? (sanitizePlainText(rawTopicoTitulo) as string).trim()
        : `Tópico ${topicoIndex + 1}`;
      const rawTopicoDescricao =
        typeof current.descricao === 'string' ? current.descricao : '';
      const topicoDescricao = rawTopicoDescricao
        ? (sanitizePlainText(rawTopicoDescricao) as string).trim() || undefined
        : undefined;
      const barreiraTipo = this.normalizeChecklistBarrierType(
        current.barreira_tipo,
      );
      const pesoBarreira = this.normalizeChecklistPositiveNumber(
        current.peso_barreira,
      );
      const limiteRuptura = this.normalizeChecklistPositiveNumber(
        current.limite_ruptura,
      );
      const topicItems = Array.isArray(current.itens)
        ? current.itens
        : Array.isArray(current.items)
          ? current.items
          : [];

      return topicItems
        .map((item, itemIndex) =>
          this.normalizeChecklistItemValue(item, {
            ...options,
            topicoId,
            topicoTitulo,
            topicoDescricao,
            ordemTopico:
              typeof current.ordem === 'number' &&
              Number.isFinite(current.ordem)
                ? current.ordem
                : topicoIndex + 1,
            ordemItem: itemIndex + 1,
            barreiraTipo,
            pesoBarreira,
            limiteRuptura,
          }),
        )
        .filter((value): value is ChecklistItemValue => value !== null);
    });
  }

  private buildChecklistTopicMetadataMap(topicos: unknown) {
    if (!Array.isArray(topicos)) {
      return new Map<
        string,
        {
          titulo?: string;
          descricao?: string;
          ordem?: number;
          barreira_tipo?: ChecklistItemValue['barreira_tipo'];
          peso_barreira?: number;
          limite_ruptura?: number;
        }
      >();
    }

    const metadata = new Map<
      string,
      {
        titulo?: string;
        descricao?: string;
        ordem?: number;
        barreira_tipo?: ChecklistItemValue['barreira_tipo'];
        peso_barreira?: number;
        limite_ruptura?: number;
      }
    >();

    topicos.forEach((topico, index) => {
      const current =
        topico && typeof topico === 'object'
          ? (topico as Record<string, unknown>)
          : {};
      const topicoId =
        typeof current.id === 'string' && current.id.trim()
          ? current.id.trim()
          : '';

      if (!topicoId) {
        return;
      }

      metadata.set(topicoId, {
        titulo:
          typeof current.titulo === 'string' && current.titulo.trim()
            ? current.titulo.trim()
            : undefined,
        descricao:
          typeof current.descricao === 'string' && current.descricao.trim()
            ? current.descricao.trim()
            : undefined,
        ordem:
          typeof current.ordem === 'number' && Number.isFinite(current.ordem)
            ? current.ordem
            : index + 1,
        barreira_tipo: this.normalizeChecklistBarrierType(
          current.barreira_tipo,
        ),
        peso_barreira: this.normalizeChecklistPositiveNumber(
          current.peso_barreira,
        ),
        limite_ruptura: this.normalizeChecklistPositiveNumber(
          current.limite_ruptura,
        ),
      });
    });

    return metadata;
  }

  private resolveChecklistItemsForPersistence(
    input: {
      itens?: unknown;
      topicos?: unknown;
    },
    options?: {
      resetExecutionState?: boolean;
      allowedGovernedReferences?: Set<string>;
    },
  ): ChecklistItemValue[] {
    const hasTopics = Array.isArray(input.topicos) && input.topicos.length > 0;
    const topicMetadata = this.buildChecklistTopicMetadataMap(input.topicos);

    if (hasTopics) {
      const flattened = this.flattenChecklistTopics(input.topicos, options);
      if (flattened.length > 0) {
        return flattened;
      }
    }

    return this.normalizeChecklistItems(input.itens, options).map((item) => {
      const topic =
        typeof item.topico_id === 'string'
          ? topicMetadata.get(item.topico_id)
          : undefined;

      if (!topic) {
        return item;
      }

      return {
        ...item,
        topico_titulo: item.topico_titulo || topic.titulo,
        topico_descricao: item.topico_descricao || topic.descricao,
        ordem_topico:
          typeof item.ordem_topico === 'number'
            ? item.ordem_topico
            : topic.ordem,
        barreira_tipo: item.barreira_tipo ?? topic.barreira_tipo,
        peso_barreira: item.peso_barreira ?? topic.peso_barreira,
        limite_ruptura: item.limite_ruptura ?? topic.limite_ruptura,
      };
    });
  }

  private buildChecklistTopicsFromItems(
    items: ChecklistItemValue[] | undefined,
  ): ChecklistTopicValue[] {
    if (!Array.isArray(items) || !items.length) {
      return [];
    }

    const topics = new Map<
      string,
      ChecklistTopicValue & { __firstSeen: number }
    >();

    items.forEach((item, index) => {
      const title =
        typeof item.topico_titulo === 'string' && item.topico_titulo.trim()
          ? item.topico_titulo.trim()
          : 'Itens do checklist';
      const id =
        typeof item.topico_id === 'string' && item.topico_id.trim()
          ? item.topico_id.trim()
          : `topic-${title.toLowerCase().replace(/[^a-z0-9]+/gi, '-') || 'legacy'}`;
      const existing = topics.get(id);
      const nextItem = {
        ...item,
        subitens: this.normalizeChecklistSubitems(item.subitens),
      };

      if (!existing) {
        topics.set(id, {
          id,
          titulo: title,
          descricao:
            typeof item.topico_descricao === 'string' &&
            item.topico_descricao.trim()
              ? item.topico_descricao.trim()
              : undefined,
          ordem:
            typeof item.ordem_topico === 'number' &&
            Number.isFinite(item.ordem_topico)
              ? item.ordem_topico
              : undefined,
          barreira_tipo: this.normalizeChecklistBarrierType(item.barreira_tipo),
          peso_barreira: this.normalizeChecklistPositiveNumber(
            item.peso_barreira,
          ),
          limite_ruptura: this.normalizeChecklistPositiveNumber(
            item.limite_ruptura,
          ),
          itens: [nextItem],
          __firstSeen: index,
        });
        return;
      }

      if (
        existing.titulo === 'Itens do checklist' &&
        title !== existing.titulo
      ) {
        existing.titulo = title;
      }
      if (
        !existing.descricao &&
        typeof item.topico_descricao === 'string' &&
        item.topico_descricao.trim()
      ) {
        existing.descricao = item.topico_descricao.trim();
      }
      if (!existing.barreira_tipo) {
        existing.barreira_tipo = this.normalizeChecklistBarrierType(
          item.barreira_tipo,
        );
      }
      if (typeof existing.peso_barreira !== 'number') {
        existing.peso_barreira = this.normalizeChecklistPositiveNumber(
          item.peso_barreira,
        );
      }
      if (typeof existing.limite_ruptura !== 'number') {
        existing.limite_ruptura = this.normalizeChecklistPositiveNumber(
          item.limite_ruptura,
        );
      }
      existing.itens.push(nextItem);
      if (
        typeof existing.ordem !== 'number' &&
        typeof item.ordem_topico === 'number' &&
        Number.isFinite(item.ordem_topico)
      ) {
        existing.ordem = item.ordem_topico;
      }
    });

    return Array.from(topics.values())
      .sort((a, b) => {
        const aOrder =
          typeof a.ordem === 'number' ? a.ordem : Number.MAX_SAFE_INTEGER;
        const bOrder =
          typeof b.ordem === 'number' ? b.ordem : Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) {
          return aOrder - bOrder;
        }
        return a.__firstSeen - b.__firstSeen;
      })
      .map(({ __firstSeen, ...topic }) => ({
        ...(() => {
          const sortedItems = topic.itens.sort((a, b) => {
            const aOrder =
              typeof a.ordem_item === 'number'
                ? a.ordem_item
                : Number.MAX_SAFE_INTEGER;
            const bOrder =
              typeof b.ordem_item === 'number'
                ? b.ordem_item
                : Number.MAX_SAFE_INTEGER;
            return aOrder - bOrder;
          });
          const classifiedItems = sortedItems.map((item) =>
            this.classifyChecklistItemAssessment(
              item as Record<string, unknown>,
            ),
          );
          const controlesRompidos = classifiedItems.filter(
            (status) => status === 'rompido',
          ).length;
          const controlesDegradados = classifiedItems.filter(
            (status) => status === 'degradado',
          ).length;
          const controlesPendentes = classifiedItems.filter(
            (status) => status === 'pendente',
          ).length;
          const limiteRuptura =
            typeof topic.limite_ruptura === 'number' && topic.limite_ruptura > 0
              ? topic.limite_ruptura
              : 1;
          const statusBarreira =
            controlesRompidos >= limiteRuptura
              ? 'rompida'
              : controlesDegradados > 0 || controlesPendentes > 0
                ? 'degradada'
                : 'integra';
          const bloqueiaOperacao =
            statusBarreira === 'rompida' ||
            sortedItems.some((item) => {
              if (!item.bloqueia_operacao_quando_nc) {
                return false;
              }
              return this.classifyChecklistItemAssessment(item) === 'rompido';
            });

          return {
            ...topic,
            status_barreira: statusBarreira,
            controles_rompidos: controlesRompidos,
            controles_degradados: controlesDegradados,
            controles_pendentes: controlesPendentes,
            bloqueia_operacao: bloqueiaOperacao,
            itens: sortedItems,
          };
        })(),
      }));
  }

  private toChecklistResponse(checklist: Checklist): ChecklistResponseDto {
    const topicos = this.buildChecklistTopicsFromItems(
      Array.isArray(checklist.itens) ? checklist.itens : [],
    );
    return plainToClass(ChecklistResponseDto, {
      ...checklist,
      topicos,
    });
  }

  private async cleanupGovernedChecklistPhotoFiles(
    checklistId: string,
    removedEntries: Array<{
      payload: GovernedChecklistPhotoReferencePayload;
    }>,
  ): Promise<void> {
    await Promise.all(
      removedEntries.map(async ({ payload }) => {
        try {
          await this.documentStorageService.deleteFile(
            this.documentStorageService.referenceForExistingObject(
              payload.fileKey,
              {
                resourceType: 'checklist-photo',
                resourceId: checklistId,
              },
              'p1-document-storage-deleteFile',
            ),
          );
          this.logChecklistEvent('checklist_photo_removed_from_storage', null, {
            checklistId,
            keyFingerprint: storageKeyFingerprint(payload.fileKey),
            originalName: payload.originalName,
          });
        } catch (error) {
          this.logChecklistEvent(
            'checklist_photo_storage_cleanup_failed',
            null,
            {
              checklistId,
              keyFingerprint: storageKeyFingerprint(payload.fileKey),
              originalName: payload.originalName,
              errorName: error instanceof Error ? error.name : 'unknown_error',
            },
          );
        }
      }),
    );
  }

  private buildChecklistMaterialSnapshot(
    checklist: Pick<
      Checklist,
      | 'titulo'
      | 'descricao'
      | 'equipamento'
      | 'maquina'
      | 'foto_equipamento'
      | 'data'
      | 'site_id'
      | 'inspetor_id'
      | 'itens'
      | 'categoria'
      | 'periodicidade'
      | 'nivel_risco_padrao'
    >,
  ): string {
    return JSON.stringify({
      titulo: checklist.titulo ?? '',
      descricao: checklist.descricao ?? '',
      equipamento: checklist.equipamento ?? '',
      maquina: checklist.maquina ?? '',
      foto_equipamento: checklist.foto_equipamento ?? '',
      data:
        checklist.data instanceof Date
          ? checklist.data.toISOString()
          : checklist.data
            ? new Date(checklist.data).toISOString()
            : '',
      site_id: checklist.site_id ?? '',
      inspetor_id: checklist.inspetor_id ?? '',
      itens: this.cloneChecklistItems(checklist.itens),
      categoria: checklist.categoria ?? '',
      periodicidade: checklist.periodicidade ?? '',
      nivel_risco_padrao: checklist.nivel_risco_padrao ?? '',
    });
  }

  private async resetChecklistSignatures(
    checklist: Pick<Checklist, 'id' | 'company_id' | 'site_id' | 'is_modelo'>,
    reason: string,
  ): Promise<boolean> {
    if (checklist.is_modelo) {
      return false;
    }

    const removedCount = await this.signaturesService.removeByDocumentSystem(
      checklist.id,
      'CHECKLIST',
      {
        companyId: checklist.company_id,
        siteId: checklist.site_id,
      },
    );

    if (removedCount > 0) {
      this.logChecklistEvent('checklist_signatures_reset', checklist, {
        reason,
        removedCount,
      });
      return true;
    }

    return false;
  }

  private async buildChecklistPhotoAccessResponse(
    checklistId: string,
    input: {
      scope: 'equipment' | 'item';
      itemIndex: number | null;
      photoIndex: number | null;
      payload: GovernedChecklistPhotoReferencePayload;
    },
  ): Promise<ChecklistPhotoAccessResponse> {
    let url: string | null = null;
    let availability: ChecklistPhotoAccessAvailability = 'ready';
    let message: string | null = null;

    try {
      url = await this.documentStorageService.getPresignedDownloadUrl(
        this.documentStorageService.referenceForExistingObject(
          input.payload.fileKey,
          {
            resourceType: 'checklist-photo',
            resourceId: checklistId,
          },
          'p1-document-storage-getPresignedDownloadUrl',
        ),
      );
    } catch (error) {
      availability = 'registered_without_signed_url';
      message =
        'A foto governada foi localizada, mas a URL assinada não está disponível no momento.';
      this.logChecklistEvent('checklist_photo_access_degraded', null, {
        checklistId,
        scope: input.scope,
        itemIndex: input.itemIndex,
        photoIndex: input.photoIndex,
        keyFingerprint: storageKeyFingerprint(input.payload.fileKey),
        errorName: error instanceof Error ? error.name : 'unknown_error',
      });
    }

    this.logChecklistEvent('checklist_photo_access_checked', null, {
      checklistId,
      scope: input.scope,
      itemIndex: input.itemIndex,
      photoIndex: input.photoIndex,
      availability,
      keyFingerprint: storageKeyFingerprint(input.payload.fileKey),
    });

    return {
      entityId: checklistId,
      scope: input.scope,
      itemIndex: input.itemIndex,
      photoIndex: input.photoIndex,
      hasGovernedPhoto: true,
      availability,
      fileKey: input.payload.fileKey,
      originalName: input.payload.originalName,
      mimeType: input.payload.mimeType,
      url,
      degraded: availability !== 'ready',
      message,
    };
  }

  private sanitizeChecklistItems(
    items: UpdateChecklistDto['itens'],
    options?: {
      resetExecutionState?: boolean;
      allowedGovernedReferences?: Set<string>;
    },
  ) {
    return this.normalizeChecklistItems(items, options);
  }

  private deriveChecklistStatus(
    input: Pick<Checklist, 'is_modelo'> & {
      status?: string | null;
      itens?: unknown;
    },
  ): Checklist['status'] {
    if (input.is_modelo) {
      if (
        input.status === 'Conforme' ||
        input.status === 'Não Conforme' ||
        input.status === 'Pendente'
      ) {
        return input.status;
      }
      return 'Pendente';
    }

    const items = Array.isArray(input.itens) ? input.itens : [];
    if (!items.length) {
      return 'Pendente';
    }

    let hasPending = false;
    let hasNonConformity = false;

    for (const rawItem of items) {
      const item =
        rawItem && typeof rawItem === 'object'
          ? (rawItem as Record<string, unknown>)
          : {};
      const assessmentStatuses = this.getChecklistAssessmentStatuses(item);

      for (const status of assessmentStatuses) {
        if (
          status === 'nok' ||
          status === 'nao' ||
          status === false ||
          status === 'Não Conforme'
        ) {
          hasNonConformity = true;
          break;
        }

        if (
          status === undefined ||
          status === null ||
          status === '' ||
          status === 'Pendente'
        ) {
          hasPending = true;
        }
      }

      if (hasNonConformity) {
        break;
      }
    }

    if (hasNonConformity) {
      return 'Não Conforme';
    }

    if (hasPending) {
      return 'Pendente';
    }

    return 'Conforme';
  }

  private getChecklistAssessmentStatuses(
    item: Record<string, unknown>,
  ): unknown[] {
    const subitems = Array.isArray(item.subitens) ? item.subitens : [];
    const subitemStatuses = subitems
      .map((subitem) =>
        subitem && typeof subitem === 'object'
          ? (subitem as Record<string, unknown>).status
          : undefined,
      )
      .filter((status) => status !== undefined);

    if (subitemStatuses.length > 0) {
      return subitemStatuses;
    }

    return [item.status];
  }

  private async validateChecklistRelations(checklist: {
    company_id?: string | null;
    site_id?: string | null;
    inspetor_id?: string | null;
    auditado_por_id?: string | null;
  }) {
    if (!checklist.company_id) {
      throw new BadRequestException(
        'Não foi possível identificar a empresa do checklist.',
      );
    }

    await Promise.all([
      checklist.site_id ? this.sitesService.findOne(checklist.site_id) : null,
      checklist.inspetor_id
        ? this.usersService.findOne(checklist.inspetor_id)
        : null,
      checklist.auditado_por_id
        ? this.usersService.findOne(checklist.auditado_por_id)
        : null,
    ]);
  }

  private cloneChecklistItems(
    items: Checklist['itens'] | undefined,
    options?: { resetExecutionState?: boolean },
  ) {
    // Itens clonados aqui vem SEMPRE de fonte confiavel ja persistida (a linha do
    // banco travada em attachItemPhoto, ou a entidade em buildChecklistMaterialSnapshot).
    // As referencias governadas presentes neles sao legitimas por definicao, entao
    // liberamos exatamente essas referencias ao normalizar. Sem isso,
    // normalizeChecklistPhotoReference rejeitaria uma foto governada JA EXISTENTE
    // (ex.: 2o upload no mesmo item apos o 1o), derrubando o append com 400. Entrada
    // de usuario NAO passa por aqui: create/update chamam normalizeChecklistItems
    // diretamente, mantendo a rejeicao de referencias governadas arbitrarias.
    const allowedGovernedReferences =
      this.collectGovernedItemPhotoReferences(items);
    return this.normalizeChecklistItems(items, {
      ...options,
      allowedGovernedReferences,
    });
  }

  private collectGovernedItemPhotoReferences(
    items: Checklist['itens'] | undefined,
  ): Set<string> {
    const references = new Set<string>();
    if (!Array.isArray(items)) {
      return references;
    }
    for (const item of items) {
      const fotos = (item as { fotos?: unknown } | null)?.fotos;
      if (!Array.isArray(fotos)) {
        continue;
      }
      for (const foto of fotos) {
        if (typeof foto !== 'string') {
          continue;
        }
        const trimmed = foto.trim();
        if (trimmed && this.parseGovernedChecklistPhotoReference(trimmed)) {
          references.add(trimmed);
        }
      }
    }
    return references;
  }

  private buildChecklistFromTemplate(
    template: Checklist,
    fillData: UpdateChecklistDto,
  ): Checklist {
    const checklistData: DeepPartial<Checklist> = {
      titulo: fillData.titulo
        ? (sanitizePlainText(fillData.titulo) as string)
        : template.titulo
          ? (sanitizePlainText(template.titulo) as string)
          : template.titulo,
      descricao: fillData.descricao
        ? (sanitizePlainText(fillData.descricao) as string)
        : template.descricao
          ? (sanitizePlainText(template.descricao) as string)
          : template.descricao,
      equipamento: fillData.equipamento
        ? (sanitizePlainText(fillData.equipamento) as string)
        : template.equipamento
          ? (sanitizePlainText(template.equipamento) as string)
          : template.equipamento,
      maquina: fillData.maquina
        ? (sanitizePlainText(fillData.maquina) as string)
        : template.maquina
          ? (sanitizePlainText(template.maquina) as string)
          : template.maquina,
      foto_equipamento:
        fillData.foto_equipamento ?? template.foto_equipamento ?? undefined,
      data: fillData.data ?? template.data,
      status: fillData.status ?? 'Pendente',
      company_id: template.company_id,
      site_id: fillData.site_id ?? undefined,
      inspetor_id: fillData.inspetor_id ?? undefined,
      itens:
        (Array.isArray(fillData.topicos) && fillData.topicos.length > 0) ||
        fillData.itens !== undefined
          ? this.resolveChecklistItemsForPersistence(
              {
                itens: fillData.itens,
                topicos: fillData.topicos,
              },
              {
                resetExecutionState: true,
              },
            )
          : this.normalizeChecklistItems(
              Array.isArray(template.itens) ? template.itens : undefined,
              {
                resetExecutionState: true,
              },
            ),
      is_modelo: false,
      template_id: template.id,
      ativo: fillData.ativo ?? true,
      categoria: fillData.categoria
        ? (sanitizePlainText(fillData.categoria) as string)
        : template.categoria
          ? (sanitizePlainText(template.categoria) as string)
          : template.categoria,
      periodicidade: fillData.periodicidade
        ? (sanitizePlainText(fillData.periodicidade) as string)
        : template.periodicidade
          ? (sanitizePlainText(template.periodicidade) as string)
          : template.periodicidade,
      nivel_risco_padrao: fillData.nivel_risco_padrao
        ? (sanitizePlainText(fillData.nivel_risco_padrao) as string)
        : template.nivel_risco_padrao
          ? (sanitizePlainText(template.nivel_risco_padrao) as string)
          : template.nivel_risco_padrao,
      auditado_por_id: fillData.auditado_por_id ?? undefined,
      data_auditoria: fillData.data_auditoria ?? undefined,
      resultado_auditoria: template.resultado_auditoria ?? undefined,
      notas_auditoria: template.notas_auditoria ?? undefined,
    };

    return this.checklistsRepository.create(checklistData);
  }

  private getChecklistDocumentDate(
    checklist: Pick<Checklist, 'data' | 'created_at'>,
  ): Date {
    const candidate = checklist.data
      ? new Date(checklist.data)
      : checklist.created_at
        ? new Date(checklist.created_at)
        : new Date();

    return Number.isNaN(candidate.getTime()) ? new Date() : candidate;
  }

  private buildChecklistDocumentCode(
    checklist: Pick<Checklist, 'id' | 'data' | 'created_at'>,
  ) {
    const year = this.getChecklistDocumentDate(checklist).getFullYear();
    const reference = String(checklist.id || '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-8)
      .toUpperCase();
    return `CHK-${year}-${reference}`;
  }

  private resolvePdfImage(imageData: string): {
    data: string;
    format: 'PNG' | 'JPEG';
  } {
    const normalized = imageData.trim();
    const dataUriMatch = normalized.match(
      /^data:image\/(png|jpeg|jpg);base64,(.+)$/i,
    );

    if (dataUriMatch) {
      const format = dataUriMatch[1].toLowerCase() === 'png' ? 'PNG' : 'JPEG';
      return { data: dataUriMatch[2], format };
    }

    return {
      data: normalized.split(',')[1] || normalized,
      format: 'PNG',
    };
  }

  private async resolveChecklistPdfImage(
    imageData: string,
    checklistId: string,
  ): Promise<{
    data: string;
    format: 'PNG' | 'JPEG';
  }> {
    const governedPhoto = this.parseGovernedChecklistPhotoReference(imageData);
    if (!governedPhoto) {
      return this.resolvePdfImage(imageData);
    }

    const buffer = await this.documentStorageService.downloadFileBuffer(
      this.documentStorageService.referenceForExistingObject(
        governedPhoto.fileKey,
        {
          resourceType: 'checklist-photo',
          resourceId: checklistId,
        },
        'p1-document-storage-downloadFileBuffer',
      ),
    );
    const base64 = buffer.toString('base64');
    const isPng =
      governedPhoto.mimeType === 'image/png' ||
      governedPhoto.originalName.toLowerCase().endsWith('.png');

    return {
      data: base64,
      format: isPng ? 'PNG' : 'JPEG',
    };
  }

  async create(
    createChecklistDto: CreateChecklistDto,
  ): Promise<ChecklistResponseDto> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    this.logger.log(`Criando checklist para empresa: ${companyId}`);

    if (
      !isSuperAdmin &&
      siteScope !== 'all' &&
      createChecklistDto.is_modelo !== true &&
      createChecklistDto.site_id &&
      !siteIds.includes(createChecklistDto.site_id)
    ) {
      throw new BadRequestException(
        'Checklist operacional deve pertencer à obra atual do tenant.',
      );
    }

    const checklist = this.checklistsRepository.create({
      ...createChecklistDto,
      titulo: createChecklistDto.titulo
        ? (sanitizePlainText(createChecklistDto.titulo) as string)
        : createChecklistDto.titulo,
      descricao: createChecklistDto.descricao
        ? (sanitizePlainText(createChecklistDto.descricao) as string)
        : createChecklistDto.descricao,
      equipamento: createChecklistDto.equipamento
        ? (sanitizePlainText(createChecklistDto.equipamento) as string)
        : createChecklistDto.equipamento,
      maquina: createChecklistDto.maquina
        ? (sanitizePlainText(createChecklistDto.maquina) as string)
        : createChecklistDto.maquina,
      company_id: companyId,
      site_id:
        !isSuperAdmin &&
        siteScope !== 'all' &&
        createChecklistDto.is_modelo !== true
          ? createChecklistDto.site_id
          : createChecklistDto.site_id,
      foto_equipamento: this.normalizeChecklistPhotoReference(
        createChecklistDto.foto_equipamento,
        'Foto do equipamento',
      ),
      itens: this.resolveChecklistItemsForPersistence({
        itens: createChecklistDto.itens,
        topicos: createChecklistDto.topicos,
      }),
    });
    checklist.status = this.deriveChecklistStatus(checklist);
    this.assertChecklistExecutionRequirements(checklist);
    await this.validateChecklistRelations(checklist);
    const saved: Checklist = await this.checklistsRepository.save(checklist);
    this.logChecklistEvent('checklist_created', saved, {
      isTemplate: saved.is_modelo,
      status: saved.status,
      itemsCount: Array.isArray(saved.itens) ? saved.itens.length : 0,
    });
    return this.toChecklistResponse(saved);
  }

  async findAll(options?: {
    onlyTemplates?: boolean;
    excludeTemplates?: boolean;
    category?: string;
    segment?: string;
    take?: number;
    select?: (keyof Checklist)[];
  }): Promise<ChecklistResponseDto[]> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    this.logger.debug(`Buscando checklists para empresa: ${companyId}`);
    if (options?.onlyTemplates && companyId) {
      await this.ensureCompanyPresetsExist(companyId);
    }
    const segment = this.normalizeChecklistSegment(options?.segment);

    const filter: {
      company_id?: string;
      is_modelo?: boolean;
      categoria?: string;
      site_id?: string | ReturnType<typeof In<string>>;
    } = {};
    if (companyId) {
      filter.company_id = companyId;
    }
    if (options?.onlyTemplates) {
      filter.is_modelo = true;
    } else if (options?.excludeTemplates) {
      filter.is_modelo = false;
    }
    if (options?.category?.trim()) {
      filter.categoria = options.category.trim();
    }
    const applySiteFilter = !isSuperAdmin && siteScope !== 'all';
    if (applySiteFilter && !options?.onlyTemplates) {
      filter.site_id = In(siteIds);
    }

    if (segment) {
      const qb = this.checklistsRepository
        .createQueryBuilder('checklist')
        .leftJoinAndSelect('checklist.company', 'company')
        .leftJoinAndSelect('checklist.site', 'site')
        .leftJoinAndSelect('checklist.inspetor', 'inspetor')
        .leftJoinAndSelect('checklist.auditado_por', 'auditado_por')
        .where('checklist.deleted_at IS NULL');

      if (filter.company_id) {
        qb.andWhere('checklist.company_id = :companyId', {
          companyId: filter.company_id,
        });
      }
      if (filter.site_id) {
        qb.andWhere('checklist.site_id IN (:...siteIds)', {
          siteIds,
        });
      } else if (applySiteFilter && options?.onlyTemplates) {
        // For templates: include global (site_id NULL) + matching site; do not skip site filters for templates improperly
        qb.andWhere(
          '(checklist.site_id IS NULL OR checklist.site_id IN (:...scopedSiteIds))',
          { scopedSiteIds: siteIds },
        );
      }
      if (filter.is_modelo !== undefined) {
        qb.andWhere('checklist.is_modelo = :isModelo', {
          isModelo: filter.is_modelo,
        });
      }
      if (filter.categoria) {
        qb.andWhere('checklist.categoria = :categoria', {
          categoria: filter.categoria,
        });
      }

      const segmentClause = this.buildChecklistSegmentClause(
        'checklist',
        segment,
      );
      qb.andWhere(segmentClause.sql, segmentClause.params);
      qb.orderBy('checklist.created_at', 'DESC');
      if (options?.take !== undefined) {
        qb.take(options.take);
      }

      // Reforça select explícito excluindo "itens" (jsonb) para listagens - não carrega coluna grande desnecessariamente
      qb.select([
        'checklist.id',
        'checklist.titulo',
        'checklist.descricao',
        'checklist.equipamento',
        'checklist.maquina',
        'checklist.data',
        'checklist.status',
        'checklist.company_id',
        'checklist.site_id',
        'checklist.inspetor_id',
        'checklist.is_modelo',
        'checklist.created_at',
        'checklist.updated_at',
        'checklist.pdf_file_key',
        'checklist.pdf_folder_path',
        'checklist.pdf_original_name',
        'company.id',
        'company.razao_social',
        'site.id',
        'site.nome',
        'inspetor.id',
        'inspetor.nome',
        'auditado_por.id',
        'auditado_por.nome',
      ]);
      const rows = await qb.getMany();
      return rows.map((c) => this.toChecklistResponse(c));
    }

    // Reforçado: usar select parcial (checklistListSelect) para evitar carregar JSONB "itens" completo desnecessariamente em listagens.
    let findWhere: FindOptionsWhere<Checklist> | FindOptionsWhere<Checklist>[] =
      { ...filter, deleted_at: IsNull() };
    if (applySiteFilter && options?.onlyTemplates) {
      // Do not skip site filters improperly for templates: global templates (null site) + site-matching ones
      findWhere = [
        { ...filter, site_id: IsNull(), deleted_at: IsNull() },
        { ...filter, site_id: In(siteIds), deleted_at: IsNull() },
      ];
    }
    const results = await this.checklistsRepository.find({
      where: findWhere,
      ...(options?.select?.length
        ? { select: options.select }
        : {
            select: this.checklistListSelect,
            relations: ['company', 'site', 'inspetor', 'auditado_por'],
          }),
      order: { created_at: 'DESC' },
      ...(options?.take !== undefined && { take: options.take }),
    });
    return results.map((c) => this.toChecklistResponse(c));
  }

  async findPaginated(options?: {
    onlyTemplates?: boolean;
    excludeTemplates?: boolean;
    category?: string;
    segment?: string;
    page?: number;
    limit?: number;
    cursor?: string; // keyset cursor: `${created_at.toISOString()}|${id}`
  }): Promise<OffsetPage<ChecklistResponseDto>> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    this.logger.debug(
      `Buscando checklists paginados para empresa: ${companyId}`,
    );
    if (options?.onlyTemplates && companyId) {
      await this.ensureCompanyPresetsExist(companyId);
    }
    const segment = this.normalizeChecklistSegment(options?.segment);

    const filter: {
      company_id?: string;
      is_modelo?: boolean;
      categoria?: string;
      site_id?: string | ReturnType<typeof In<string>>;
    } = {};
    if (companyId) {
      filter.company_id = companyId;
    }
    if (options?.onlyTemplates) {
      filter.is_modelo = true;
    } else if (options?.excludeTemplates) {
      filter.is_modelo = false;
    }
    if (options?.category?.trim()) {
      filter.categoria = options.category.trim();
    }
    const applySiteFilter = !isSuperAdmin && siteScope !== 'all';
    if (applySiteFilter && !options?.onlyTemplates) {
      filter.site_id = In(siteIds);
    }

    const { page, limit, skip } = normalizeOffsetPagination(
      { page: options?.page, limit: options?.limit },
      { defaultLimit: 20, maxLimit: 100 },
    );

    // Suporte básico a keyset/cursor para evitar OFFSET grande em tabelas de alto volume.
    // Cursor formato: "2026-01-01T00:00:00.000Z|uuid"
    // Quando cursor fornecido, ignora skip e aplica filtro (created_at, id) < cursor.
    let useKeyset = false;
    let keysetCreatedAt: Date | null = null;
    let keysetId: string | null = null;
    if (options?.cursor) {
      const parts = options.cursor.split('|');
      if (parts.length === 2) {
        const dt = new Date(parts[0]);
        if (!Number.isNaN(dt.getTime()) && parts[1]) {
          useKeyset = true;
          keysetCreatedAt = dt;
          keysetId = parts[1];
        }
      }
    }

    if (segment) {
      const qb = this.checklistsRepository
        .createQueryBuilder('checklist')
        .leftJoinAndSelect('checklist.company', 'company')
        .leftJoinAndSelect('checklist.site', 'site')
        .leftJoinAndSelect('checklist.inspetor', 'inspetor')
        .leftJoinAndSelect('checklist.auditado_por', 'auditado_por')
        .where('checklist.deleted_at IS NULL');

      if (filter.company_id) {
        qb.andWhere('checklist.company_id = :companyId', {
          companyId: filter.company_id,
        });
      }
      if (filter.site_id) {
        qb.andWhere('checklist.site_id IN (:...siteIds)', { siteIds });
      } else if (applySiteFilter && options?.onlyTemplates) {
        // For templates: include global + site scoped matching; fix improper skip of site filters
        qb.andWhere(
          '(checklist.site_id IS NULL OR checklist.site_id IN (:...scopedSiteIds))',
          { scopedSiteIds: siteIds },
        );
      }
      if (filter.is_modelo !== undefined) {
        qb.andWhere('checklist.is_modelo = :isModelo', {
          isModelo: filter.is_modelo,
        });
      }
      if (filter.categoria) {
        qb.andWhere('checklist.categoria = :categoria', {
          categoria: filter.categoria,
        });
      }

      const segmentClause = this.buildChecklistSegmentClause(
        'checklist',
        segment,
      );
      qb.andWhere(segmentClause.sql, segmentClause.params);
      qb.orderBy('checklist.created_at', 'DESC');
      qb.skip(skip).take(limit);

      // Reforça select explícito excluindo "itens" (jsonb pesado) em paginação
      qb.select([
        'checklist.id',
        'checklist.titulo',
        'checklist.descricao',
        'checklist.equipamento',
        'checklist.maquina',
        'checklist.data',
        'checklist.status',
        'checklist.company_id',
        'checklist.site_id',
        'checklist.inspetor_id',
        'checklist.is_modelo',
        'checklist.created_at',
        'checklist.updated_at',
        'checklist.pdf_file_key',
        'checklist.pdf_folder_path',
        'checklist.pdf_original_name',
        'company.id',
        'company.razao_social',
        'site.id',
        'site.nome',
        'inspetor.id',
        'inspetor.nome',
        'auditado_por.id',
        'auditado_por.nome',
      ]);
      const [rows, total] = await qb.getManyAndCount();
      const data = rows.map((c) => this.toChecklistResponse(c));
      return toOffsetPage(data, total, page, limit);
    }

    // Keyset/cursor support stub (variáveis declaradas para extensão futura).
    // Atualmente cai para paginação por offset (skip/take) reforçada com select parcial sem JSONB 'itens'.
    // Para keyset completo, usar cursor em chamadas e implementar filtro (created_at, id) < cursor no QB.
    const useKeysetNow = useKeyset && keysetCreatedAt && keysetId;
    const effectiveSkip = useKeysetNow ? 0 : skip;
    const effectiveTake = limit;

    const [rows, total] = await this.checklistsRepository.findAndCount({
      where: { ...filter, deleted_at: IsNull() },
      // LISTING: reforçado select parcial para não carregar JSONB 'itens' completo.
      select: this.checklistListSelect,
      relations: ['company', 'site', 'inspetor'],
      order: { created_at: 'DESC' },
      skip: effectiveSkip,
      take: effectiveTake,
    });

    const data = rows.map((c) => this.toChecklistResponse(c));
    return toOffsetPage(data, total, page, limit);
  }

  async findOne(id: string): Promise<ChecklistResponseDto> {
    const checklist = await this.findOneEntity(id);
    return this.toChecklistResponse(checklist);
  }

  async findOneEntity(id: string): Promise<Checklist> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    const checklist = await this.checklistsRepository.findOne({
      where: { id, company_id: companyId, deleted_at: IsNull() },
      relations: ['company', 'site', 'inspetor', 'auditado_por'],
    });
    if (!checklist) {
      throw new NotFoundException(`Checklist com ID ${id} não encontrado`);
    }
    if (
      !isSuperAdmin &&
      siteScope !== 'all' &&
      checklist.site_id != null &&
      !siteIds.includes(checklist.site_id)
    ) {
      // Models without site_id (global templates) are visible to all in company;
      // site-scoped models or operational checklists must match user's site scope.
      // This prevents improperly skipping site filters for (site-specific) templates.
      throw new NotFoundException(`Checklist com ID ${id} não encontrado`);
    }
    return checklist;
  }

  async update(
    id: string,
    updateChecklistDto: UpdateChecklistDto,
  ): Promise<ChecklistResponseDto> {
    const { siteIds, siteScope, isSuperAdmin } = this.getTenantContextOrThrow();
    const checklist = await this.findOneEntity(id);
    this.assertChecklistDocumentMutable(checklist);
    const allowedGovernedPhotoReferences =
      this.getAllowedGovernedChecklistPhotoReferences(checklist);
    const previousPhotoEntries =
      this.getGovernedChecklistPhotoEntries(checklist);
    const previousMaterialSnapshot =
      this.buildChecklistMaterialSnapshot(checklist);

    if (updateChecklistDto.titulo !== undefined) {
      checklist.titulo = updateChecklistDto.titulo
        ? (sanitizePlainText(updateChecklistDto.titulo) as string)
        : updateChecklistDto.titulo;
    }
    if (updateChecklistDto.descricao !== undefined) {
      checklist.descricao = updateChecklistDto.descricao
        ? (sanitizePlainText(updateChecklistDto.descricao) as string)
        : updateChecklistDto.descricao;
    }
    if (updateChecklistDto.equipamento !== undefined) {
      checklist.equipamento = updateChecklistDto.equipamento
        ? (sanitizePlainText(updateChecklistDto.equipamento) as string)
        : updateChecklistDto.equipamento;
    }
    if (updateChecklistDto.maquina !== undefined) {
      checklist.maquina = updateChecklistDto.maquina
        ? (sanitizePlainText(updateChecklistDto.maquina) as string)
        : updateChecklistDto.maquina;
    }
    if (updateChecklistDto.foto_equipamento !== undefined) {
      checklist.foto_equipamento =
        this.normalizeChecklistPhotoReference(
          updateChecklistDto.foto_equipamento,
          'Foto do equipamento',
          {
            allowedGovernedReferences: allowedGovernedPhotoReferences,
          },
        ) ?? '';
    }
    if (updateChecklistDto.data !== undefined) {
      checklist.data = new Date(updateChecklistDto.data);
    }
    if (updateChecklistDto.site_id !== undefined) {
      if (
        !isSuperAdmin &&
        siteScope !== 'all' &&
        !siteIds.includes(updateChecklistDto.site_id)
      ) {
        throw new BadRequestException(
          'Checklist operacional não pode ser movido para outra obra.',
        );
      }
      checklist.site_id = updateChecklistDto.site_id;
    }
    if (updateChecklistDto.inspetor_id !== undefined) {
      checklist.inspetor_id = updateChecklistDto.inspetor_id;
    }
    if (
      updateChecklistDto.itens !== undefined ||
      updateChecklistDto.topicos !== undefined
    ) {
      checklist.itens = this.resolveChecklistItemsForPersistence(
        {
          itens: updateChecklistDto.itens,
          topicos: updateChecklistDto.topicos,
        },
        {
          allowedGovernedReferences: allowedGovernedPhotoReferences,
        },
      );
    }
    if (
      updateChecklistDto.is_modelo !== undefined &&
      updateChecklistDto.is_modelo !== checklist.is_modelo
    ) {
      // SGS-CHK-STM-002: changing is_modelo bypasses assertChecklistDocumentMutable
      // (templates are always mutable) and signature-reset — block the transition.
      throw new BadRequestException(
        'Não é permitido alterar o tipo do checklist (modelo/operacional) após a criação.',
      );
    }
    if (updateChecklistDto.ativo !== undefined) {
      checklist.ativo = updateChecklistDto.ativo;
    }
    if (updateChecklistDto.categoria !== undefined) {
      checklist.categoria = updateChecklistDto.categoria;
    }
    if (updateChecklistDto.periodicidade !== undefined) {
      checklist.periodicidade = updateChecklistDto.periodicidade;
    }
    if (updateChecklistDto.nivel_risco_padrao !== undefined) {
      checklist.nivel_risco_padrao = updateChecklistDto.nivel_risco_padrao;
    }
    if (updateChecklistDto.auditado_por_id !== undefined) {
      checklist.auditado_por_id = updateChecklistDto.auditado_por_id;
    }
    if (updateChecklistDto.data_auditoria) {
      checklist.data_auditoria = new Date(updateChecklistDto.data_auditoria);
    }

    checklist.status = this.deriveChecklistStatus({
      ...checklist,
      status: updateChecklistDto.status ?? checklist.status,
    });
    this.assertChecklistExecutionRequirements(checklist);
    await this.validateChecklistRelations(checklist);
    const saved: Checklist = await this.checklistsRepository.save(checklist);
    const nextPhotoEntries = this.getGovernedChecklistPhotoEntries(saved);
    const nextPhotoReferences = new Set(
      nextPhotoEntries.map((entry) => entry.reference),
    );
    const removedPhotoEntries = previousPhotoEntries.filter(
      (entry) => !nextPhotoReferences.has(entry.reference),
    );
    if (removedPhotoEntries.length > 0) {
      await this.cleanupGovernedChecklistPhotoFiles(
        saved.id,
        removedPhotoEntries,
      );
    }
    const materialChanged =
      previousMaterialSnapshot !== this.buildChecklistMaterialSnapshot(saved);
    const signaturesReset = materialChanged
      ? await this.resetChecklistSignatures(saved, 'material_update')
      : false;

    try {
      this.notificationsGateway.sendToCompany(
        checklist.company_id,
        'checklist:updated',
        { id: checklist.id },
      );
    } catch (e) {
      this.logger.error(
        'Falha ao enviar notificação de checklist atualizado',
        e,
      );
    }

    this.logChecklistEvent('checklist_updated', saved, {
      isTemplate: saved.is_modelo,
      status: saved.status,
      itemsCount: Array.isArray(saved.itens) ? saved.itens.length : 0,
      signaturesReset,
      removedGovernedPhotos: removedPhotoEntries.length,
    });

    return this.toChecklistResponse(saved);
  }

  async remove(id: string): Promise<void> {
    const checklist = await this.findOneEntity(id);
    if (checklist.pdf_file_key) {
      throw new BadRequestException(
        'Somente checklists sem PDF final podem ser removidos. Use os fluxos formais de cancelamento/encerramento para registros já emitidos.',
      );
    }
    const governedPhotoEntries =
      this.getGovernedChecklistPhotoEntries(checklist);

    // Garante que o remove seja transacional: o governance já envolve registry + forensic + softDelete em tx.
    // Reforçamos explicitamente com tx no service para o reset de signatures (alinhado com task).
    await this.dataSource.transaction(async (_manager) => {
      await this.documentGovernanceService.removeFinalDocumentReference({
        companyId: checklist.company_id,
        module: 'checklist',
        entityId: checklist.id,
        trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
        trailMetadata: {
          removalMode: 'soft_delete',
        },
        removeEntityState: async (innerManager) => {
          await innerManager.getRepository(Checklist).softDelete(checklist.id);
        },
        cleanupStoredFile: (fileKey) =>
          this.documentStorageService.deleteFile(
            this.documentStorageService.referenceForExistingObject(
              fileKey,
              {
                resourceType: 'checklist',
                resourceId: checklist.id,
              },
              'p1-document-storage-deleteFile',
            ),
          ),
      });
    });

    if (governedPhotoEntries.length > 0) {
      await this.cleanupGovernedChecklistPhotoFiles(
        checklist.id,
        governedPhotoEntries,
      );
    }

    // Reset de signatures em transação dedicada (removeByDocumentSystem usa softDelete agora)
    await this.dataSource.transaction(async (_txManager) => {
      await this.resetChecklistSignatures(checklist, 'checklist_removed');
    });
  }

  async attachEquipmentPhoto(
    id: string,
    buffer: Buffer,
    originalName: string,
    mimeType: string,
  ): Promise<ChecklistPhotoAttachResponse> {
    const checklist = await this.findOneEntity(id);
    this.assertChecklistDocumentMutable(checklist);

    const sanitizedOriginalName = originalName?.trim() || 'foto-equipamento';
    const fileKey = this.documentStorageService.generateDocumentKey(
      checklist.company_id,
      'checklist-photos',
      checklist.id,
      sanitizedOriginalName,
    );

    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          fileKey,
          { resourceType: 'checklist-photo', resourceId: checklist.id },
          'p1-document-storage-uploadFile',
        ),
        buffer,
        mimeType,
      );

    try {
      const photoReference = this.buildGovernedChecklistPhotoReference({
        v: 1,
        kind: 'governed-storage',
        scope: 'equipment',
        fileKey,
        originalName: sanitizedOriginalName,
        mimeType,
        uploadedAt: new Date().toISOString(),
        sizeBytes: buffer.byteLength,
      });

      // Substituição atômica: a foto anterior é lida da linha travada, evitando
      // que uma escrita concorrente (ex.: foto de item) seja perdida no save.
      const { saved, result: previousGovernedPhoto } =
        await this.mutateChecklistLocked(id, (locked) => {
          this.assertChecklistDocumentMutable(locked);
          const currentEquipmentPhoto =
            typeof locked.foto_equipamento === 'string'
              ? locked.foto_equipamento
              : null;
          const previous = currentEquipmentPhoto
            ? this.parseGovernedChecklistPhotoReference(currentEquipmentPhoto)
            : null;
          locked.foto_equipamento = photoReference;
          return previous;
        });
      const signaturesReset = await this.resetChecklistSignatures(
        saved,
        'equipment_photo_updated',
      );

      if (previousGovernedPhoto && previousGovernedPhoto.fileKey !== fileKey) {
        await this.cleanupGovernedChecklistPhotoFiles(saved.id, [
          {
            payload: previousGovernedPhoto,
          },
        ]);
      }

      this.logChecklistEvent('checklist_equipment_photo_uploaded', saved, {
        keyFingerprint: storageKeyFingerprint(fileKey),
        originalName: sanitizedOriginalName,
        mimeType,
        signaturesReset,
      });

      return {
        entityId: saved.id,
        scope: 'equipment',
        itemIndex: null,
        photoIndex: null,
        storageMode: 'governed-storage',
        degraded: false,
        message: 'Foto do equipamento anexada ao checklist com governança.',
        photoReference,
        // SECURITY: omit raw internal fileKey from attach response JSON. Use photoReference (gst:...) + /access for signed url.
        photo: {
          originalName: sanitizedOriginalName,
          mimeType,
        },
        signaturesReset,
      };
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        'checklists.attachEquipmentPhoto',
        fileKey,
        (key) =>
          uploadedReference.key === key
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      this.rethrowHttpAware(
        error,
        'Falha ao anexar foto de equipamento do checklist.',
      );
    }
  }

  async attachItemPhoto(
    id: string,
    itemIndex: number,
    buffer: Buffer,
    originalName: string,
    mimeType: string,
  ): Promise<ChecklistPhotoAttachResponse> {
    const checklist = await this.findOneEntity(id);
    this.assertChecklistDocumentMutable(checklist);

    if (!Array.isArray(checklist.itens) || !checklist.itens[itemIndex]) {
      throw new BadRequestException('Item do checklist não encontrado.');
    }

    const sanitizedOriginalName = originalName?.trim() || 'foto-item';
    const fileKey = this.documentStorageService.generateDocumentKey(
      checklist.company_id,
      'checklist-photos',
      checklist.id,
      sanitizedOriginalName,
    );

    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          fileKey,
          { resourceType: 'checklist-photo', resourceId: checklist.id },
          'p1-document-storage-uploadFile',
        ),
        buffer,
        mimeType,
      );

    try {
      const photoReference = this.buildGovernedChecklistPhotoReference({
        v: 1,
        kind: 'governed-storage',
        scope: 'item',
        fileKey,
        originalName: sanitizedOriginalName,
        mimeType,
        uploadedAt: new Date().toISOString(),
        sizeBytes: buffer.byteLength,
      });

      // Append atômico: re-lê a linha sob lock para não perder fotos anexadas
      // concorrentemente na mesma checklist (read-modify-write do jsonb).
      const { saved, result: photoIndex } = await this.mutateChecklistLocked(
        id,
        (locked) => {
          this.assertChecklistDocumentMutable(locked);
          if (!Array.isArray(locked.itens) || !locked.itens[itemIndex]) {
            throw new BadRequestException('Item do checklist não encontrado.');
          }
          const items = this.cloneChecklistItems(locked.itens);
          const targetItem = items[itemIndex];
          const nextPhotos = Array.isArray(targetItem.fotos)
            ? [...targetItem.fotos]
            : [];
          nextPhotos.push(photoReference);
          targetItem.fotos = nextPhotos;
          locked.itens = items;
          return nextPhotos.length - 1;
        },
      );
      const signaturesReset = await this.resetChecklistSignatures(
        saved,
        'item_photo_added',
      );

      this.logChecklistEvent('checklist_item_photo_uploaded', saved, {
        itemIndex,
        photoIndex,
        keyFingerprint: storageKeyFingerprint(fileKey),
        originalName: sanitizedOriginalName,
        mimeType,
        signaturesReset,
      });

      return {
        entityId: saved.id,
        scope: 'item',
        itemIndex,
        photoIndex,
        storageMode: 'governed-storage',
        degraded: false,
        message: 'Foto do item anexada ao checklist com governança.',
        photoReference,
        // SECURITY: omit raw internal fileKey from attach response JSON. Use photoReference (gst:...) + /access for signed url.
        photo: {
          originalName: sanitizedOriginalName,
          mimeType,
        },
        signaturesReset,
      };
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        'checklists.attachItemPhoto',
        fileKey,
        (key) =>
          uploadedReference.key === key
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      this.rethrowHttpAware(
        error,
        'Falha ao anexar foto de item do checklist.',
      );
    }
  }

  async getEquipmentPhotoAccess(
    id: string,
  ): Promise<ChecklistPhotoAccessResponse> {
    const checklist = await this.findOneEntity(id);
    const governedPhoto = this.parseGovernedChecklistPhotoReference(
      checklist.foto_equipamento,
    );

    if (!governedPhoto) {
      throw new NotFoundException(
        'O checklist não possui foto do equipamento em armazenamento governado.',
      );
    }

    return this.buildChecklistPhotoAccessResponse(checklist.id, {
      scope: 'equipment',
      itemIndex: null,
      photoIndex: null,
      payload: governedPhoto,
    });
  }

  async getItemPhotoAccess(
    id: string,
    itemIndex: number,
    photoIndex: number,
  ): Promise<ChecklistPhotoAccessResponse> {
    const checklist = await this.findOneEntity(id);
    const item = Array.isArray(checklist.itens)
      ? checklist.itens[itemIndex]
      : null;
    const photo =
      item && Array.isArray(item.fotos) ? item.fotos[photoIndex] : undefined;
    const governedPhoto = this.parseGovernedChecklistPhotoReference(photo);

    if (!governedPhoto) {
      throw new NotFoundException(
        'A foto do item não está em armazenamento governado.',
      );
    }

    return this.buildChecklistPhotoAccessResponse(checklist.id, {
      scope: 'item',
      itemIndex,
      photoIndex,
      payload: governedPhoto,
    });
  }

  async sendEmail(id: string, to: string) {
    const checklist = await this.findOneEntity(id);
    const access = await this.getPdfAccess(id);
    const recipientHash = this.hashRecipient(to);
    if (!access.hasFinalPdf || !access.fileKey) {
      this.logChecklistEvent(
        'checklist_email_blocked_without_final_pdf',
        checklist,
        {
          recipientHash,
        },
      );
      throw new BadRequestException(
        'Emita o PDF final governado antes de enviar este checklist por e-mail.',
      );
    }

    try {
      const result = await this.mailService.sendStoredDocument(
        checklist.id,
        'CHECKLIST',
        to,
        checklist.company_id,
      );
      this.logChecklistEvent('checklist_email_sent', checklist, {
        reusedFinalPdf: true,
        recipientHash,
        artifactType: result.artifactType,
        fallbackUsed: result.fallbackUsed,
      });
      return result;
    } catch (error) {
      this.logChecklistEvent(
        'checklist_email_failed_official_pdf_unavailable',
        checklist,
        {
          recipientHash,
          errorMessage: error instanceof Error ? error.message : 'unknown',
        },
      );
      this.rethrowHttpAware(
        error,
        'Falha ao enviar checklist com PDF oficial por e-mail.',
      );
    }
  }

  async generatePdf(checklist: Checklist): Promise<Buffer> {
    // ALERTA DE PERFORMANCE: A geração de PDFs é uma tarefa síncrona e intensiva em CPU.
    // Em um ambiente com alta concorrência, isso pode bloquear o event loop do Node.js
    // e degradar a performance da aplicação.
    // RECOMENDA�!ÒO: Mover esta lógica para um job em background (ex: usando BullMQ)
    // para não impactar a responsividade da API.
    let logoBase64: string | null = null;
    let logoFormat: 'PNG' | 'JPEG' = 'PNG';
    const logoKey = checklist.company?.logo_storage_key;
    if (logoKey) {
      try {
        const buf = await this.documentStorageService.downloadFileBuffer(
          this.documentStorageService.referenceForExistingObject(
            logoKey,
            { resourceType: 'company', resourceId: checklist.company_id },
            'p1-document-storage-downloadFileBuffer',
          ),
        );
        logoBase64 = buf.toString('base64');
        logoFormat = checklist.company?.logo_content_type?.includes('png')
          ? 'PNG'
          : 'JPEG';
      } catch {
        // logo inacessível — PDF gerado sem logo
      }
    }
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const tableTheme = createBackendPdfTableTheme();
    drawBackendPdfHeader(doc, {
      title: 'CHECKLIST SST',
      subtitle: checklist.titulo,
      metaRight: [
        `Data: ${new Date(checklist.data).toLocaleDateString('pt-BR')}`,
        `Status: ${checklist.status || 'Pendente'}`,
      ],
      logoBase64,
      logoFormat,
    });

    doc.setFontSize(10);
    doc.setTextColor(...backendPdfTheme.text);
    doc.text(
      `Data: ${new Date(checklist.data).toLocaleDateString('pt-BR')}`,
      16,
      41,
    );
    doc.text(`Inspetor: ${checklist.inspetor?.nome || 'N/A'}`, 16, 47);
    doc.text(`Obra/Setor: ${checklist.site?.nome || 'N/A'}`, 16, 53);
    if (checklist.equipamento)
      doc.text(`Equipamento: ${checklist.equipamento}`, 16, 59);
    if (checklist.maquina) doc.text(`Máquina: ${checklist.maquina}`, 16, 65);

    let currentY = 74;
    if (checklist.foto_equipamento) {
      try {
        const { data: imgData, format } = await this.resolveChecklistPdfImage(
          checklist.foto_equipamento,
          checklist.id,
        );
        drawBackendSectionTitle(doc, currentY - 10, 'Evidência do equipamento');
        doc.setFillColor(...backendPdfTheme.surface);
        doc.setDrawColor(...backendPdfTheme.border);
        doc.roundedRect(16, currentY - 4, 64, 64, 2, 2, 'FD');
        doc.addImage(imgData, format, 18, currentY - 2, 60, 60);
        currentY += 70;
      } catch (e) {
        this.logger.error('Erro ao adicionar imagem do equipamento:', e);
      }
    }

    const topicsForPdf = this.buildChecklistTopicsFromItems(
      Array.isArray(checklist.itens) ? checklist.itens : [],
    );

    const normalizePdfStatus = (status: unknown): string => {
      if (status === true || status === 'ok' || status === 'sim') {
        return 'Conforme';
      }
      if (status === false || status === 'nok' || status === 'nao') {
        return 'Não Conforme';
      }
      if (status === 'na') {
        return 'N/A';
      }
      return typeof status === 'string' && status.trim() ? status : 'N/A';
    };

    const renderTopicTable = (topic: ChecklistTopicValue) => {
      const rows = (topic.itens || []).map((item, index) => {
        const itemNumber =
          typeof item.ordem_item === 'number' &&
          Number.isFinite(item.ordem_item)
            ? item.ordem_item
            : index + 1;
        const subitemsText =
          Array.isArray(item.subitens) && item.subitens.length
            ? item.subitens
                .map((subitem, subIndex) => {
                  const label =
                    typeof subitem.ordem === 'number' &&
                    Number.isFinite(subitem.ordem)
                      ? this.buildChecklistAlphabeticLabel(subitem.ordem - 1)
                      : this.buildChecklistAlphabeticLabel(subIndex);
                  const subitemStatus = normalizePdfStatus(subitem.status);
                  const suffix =
                    subitem.status === undefined || subitem.status === null
                      ? ''
                      : ` � ${subitemStatus}`;
                  return `${label}) ${subitem.texto}${suffix}`;
                })
                .join('\n')
            : '';
        const itemText = `${itemNumber}. ${item.item}`;
        return [
          subitemsText ? `${itemText}\n${subitemsText}` : itemText,
          normalizePdfStatus(item.status),
          item.observacao || '',
        ];
      });

      return rows;
    };

    const renderTopicSection = (topic: ChecklistTopicValue) => {
      if (currentY > 250) {
        doc.addPage();
        currentY = 20;
      }

      const barrierLabel =
        topic.status_barreira === 'rompida'
          ? 'Barreira rompida'
          : topic.status_barreira === 'degradada'
            ? 'Barreira degradada'
            : topic.status_barreira === 'integra'
              ? 'Barreira íntegra'
              : null;
      drawBackendSectionTitle(
        doc,
        currentY - 6,
        barrierLabel ? `${topic.titulo} - ${barrierLabel}` : topic.titulo,
      );
      currentY += 2;

      if (topic.descricao) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(90, 99, 118);
        const wrappedDescriptionRaw = doc.splitTextToSize(
          topic.descricao,
          180,
        ) as string | string[];
        const wrappedDescription = Array.isArray(wrappedDescriptionRaw)
          ? wrappedDescriptionRaw.filter(
              (line): line is string => typeof line === 'string',
            )
          : [String(wrappedDescriptionRaw)];
        doc.text(wrappedDescription, 14, currentY);
        currentY += wrappedDescription.length * 4 + 2;
      }

      autoTable(doc, {
        startY: currentY,
        head: [['Item', 'Status', 'Observação']],
        body: renderTopicTable(topic),
        ...tableTheme,
        styles: {
          ...tableTheme.styles,
          fontSize: 8.5,
          cellPadding: 2.2,
          valign: 'top',
        },
        didParseCell: (hookData) => {
          if (hookData.section === 'body' && hookData.column.index === 0) {
            hookData.cell.styles.fontStyle = 'normal';
          }
        },
      });

      currentY = getBackendLastTableY(doc, currentY) + 6;
    };

    if (topicsForPdf.length) {
      topicsForPdf.forEach((topic) => renderTopicSection(topic));
    } else {
      autoTable(doc, {
        startY: currentY,
        head: [['Item', 'Status', 'Observação']],
        body: [],
        ...tableTheme,
      });
    }

    const signatures = await this.signaturesService.findByDocument(
      checklist.id,
      'CHECKLIST',
    );
    if (signatures.length > 0) {
      const finalY = getBackendLastTableY(doc, 150);
      let currentSigY = finalY + 20;

      if (currentSigY > 250) {
        doc.addPage();
        currentSigY = 20;
      }
      drawBackendSectionTitle(doc, currentSigY - 4, 'Assinaturas');
      doc.setFontSize(12);
      doc.setTextColor(...backendPdfTheme.text);
      doc.text('Assinaturas', 16, currentSigY + 2);
      currentSigY += 10;

      for (const sig of signatures) {
        if (currentSigY + 40 > 280) {
          doc.addPage();
          currentSigY = 20;
        }
        doc.setFontSize(10);
        doc.text(
          `Assinado por: ${sig.user?.nome || 'Usuário'} em ${new Date(sig.created_at).toLocaleString('pt-BR')}`,
          16,
          currentSigY,
        );
        currentSigY += 5;
        if (sig.signature_data) {
          try {
            const { data: imgData, format } = this.resolvePdfImage(
              sig.signature_data,
            );
            doc.addImage(imgData, format, 16, currentSigY, 50, 20);
            currentSigY += 25;
          } catch (e) {
            this.logger.error('Erro ao adicionar imagem de assinatura:', e);
            currentSigY += 10;
          }
        } else {
          currentSigY += 10;
        }
      }
    }

    applyBackendPdfFooter(doc);

    return Buffer.from(doc.output('arraybuffer'));
  }

  async createWeldingMachineTemplate() {
    const presetKey: ChecklistPresetSeedKey = 'welding-machine';
    const seed = getChecklistPresetSeedByKey(presetKey);
    const companyId = this.tenantService.getTenantId();
    if (!companyId) {
      throw new BadRequestException(
        'Não foi possível identificar a empresa para criar o template.',
      );
    }
    if (!seed) {
      throw new BadRequestException(
        'Não foi possível localizar o modelo padrão de máquina de solda.',
      );
    }

    const existing = await this.checklistsRepository.findOne({
      where: [seed.titulo, ...(seed.aliases ?? [])].map((titulo) => ({
        titulo,
        is_modelo: true,
        company_id: companyId,
        deleted_at: IsNull(),
      })),
    });
    if (existing) {
      this.logger.warn(
        `Template de máquina de solda já existe para a empresa ${companyId} com o título "${existing.titulo}".`,
      );
      return existing;
    }

    const checklist = this.checklistsRepository.create({
      ...this.buildPresetTemplateDefinition(seed),
      data: new Date(),
      status: 'Pendente',
      company_id: companyId,
      is_modelo: true,
      ativo: true,
    });

    return this.checklistsRepository.save(checklist);
  }

  private async ensureCompanyPresetsExist(companyId: string): Promise<void> {
    const count = await this.checklistsRepository.count({
      where: { company_id: companyId, is_modelo: true, deleted_at: IsNull() },
    });
    if (count === 0) {
      this.logger.log(
        `Primeiro acesso à biblioteca de modelos — bootstrap automático para empresa ${companyId}`,
      );
      await this.createPresetTemplates();
    }
  }

  async createPresetTemplates() {
    const companyId = this.tenantService.getTenantId();
    if (!companyId) {
      throw new BadRequestException(
        'Não foi possível identificar a empresa para criar os templates.',
      );
    }

    const existingTemplates = await this.checklistsRepository.find({
      where: { company_id: companyId, is_modelo: true, deleted_at: IsNull() },
      select: ['titulo'],
    });
    const existingTitles = new Set(
      existingTemplates.map((item) => item.titulo),
    );

    const templatesToCreate = CHECKLIST_PRESET_SEEDS.filter(
      (seed) => !this.presetSeedHasExistingTitle(seed, existingTitles),
    ).map((seed) =>
      this.checklistsRepository.create({
        ...this.buildPresetTemplateDefinition(seed),
        data: new Date(),
        status: 'Pendente',
        company_id: companyId,
        is_modelo: true,
        ativo: true,
      }),
    );

    if (templatesToCreate.length === 0) {
      return {
        created: 0,
        skipped: CHECKLIST_PRESET_SEEDS.length,
        templates: existingTemplates,
      };
    }

    const saved = await this.checklistsRepository.save(templatesToCreate);
    return {
      created: saved.length,
      skipped: CHECKLIST_PRESET_SEEDS.length - saved.length,
      templates: saved,
    };
  }

  async fillFromTemplate(
    templateId: string,
    fillData: UpdateChecklistDto,
  ): Promise<ChecklistResponseDto> {
    const template = await this.findOneEntity(templateId);
    if (!template.is_modelo) {
      throw new BadRequestException(
        'O checklist especificado não é um template',
      );
    }

    const newChecklist = this.buildChecklistFromTemplate(template, fillData);
    newChecklist.foto_equipamento =
      this.normalizeChecklistPhotoReference(
        newChecklist.foto_equipamento,
        'Foto do equipamento',
      ) ?? '';
    newChecklist.status = this.deriveChecklistStatus(newChecklist);
    this.assertChecklistExecutionRequirements(newChecklist);
    await this.validateChecklistRelations(newChecklist);
    const saved = await this.checklistsRepository.save(newChecklist);

    try {
      this.notificationsGateway.sendToCompany(
        saved.company_id,
        'checklist:created',
        { id: saved.id, titulo: saved.titulo },
      );
    } catch (e) {
      this.logger.error('Falha ao enviar notificação de checklist criado', e);
    }

    this.logChecklistEvent('checklist_filled_from_template', saved, {
      templateId: template.id,
      status: saved.status,
      itemsCount: Array.isArray(saved.itens) ? saved.itens.length : 0,
    });

    return this.toChecklistResponse(saved);
  }

  savePdfToStorage(id: string): Promise<{
    fileKey: string;
    folderPath: string;
    fileUrl: string | null;
    url: string | null;
    originalName: string;
    entityId: string;
    hasFinalPdf: true;
    availability: 'ready' | 'registered_without_signed_url';
    message: string;
  }> {
    return Promise.reject(
      new GoneException(
        `O fluxo legado savePdfToStorage do checklist (${id}) foi descontinuado. Use attachPdf com o PDF oficial governado.`,
      ),
    );
  }

  async attachPdf(
    id: string,
    file: Express.Multer.File,
    userId?: string,
  ): Promise<{ fileKey: string; folderPath: string; originalName: string }> {
    const checklist = await this.findOneEntity(id);
    await this.assertChecklistReadyForFinalPdf(checklist);

    const documentDate = this.getChecklistDocumentDate(checklist);
    const year = documentDate.getFullYear();
    const weekNumber = String(getIsoWeekNumber(documentDate) || 1).padStart(
      2,
      '0',
    );
    const fileKey = this.documentStorageService.generateDocumentKey(
      checklist.company_id,
      'checklists',
      checklist.id,
      file.originalname,
      {
        folderSegments: [
          ...(checklist.site_id ? ['sites', checklist.site_id] : []),
          String(year),
          `week-${weekNumber}`,
        ],
      },
    );
    const folderPath = fileKey.split('/').slice(0, -1).join('/');

    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          fileKey,
          { resourceType: 'checklist', resourceId: checklist.id },
          'p1-document-storage-uploadFile',
        ),
        file.buffer,
        file.mimetype,
      );

    try {
      await this.documentGovernanceService.registerFinalDocument({
        companyId: checklist.company_id,
        module: 'checklist',
        entityId: checklist.id,
        title: checklist.titulo,
        documentDate,
        documentCode: this.buildChecklistDocumentCode(checklist),
        fileKey,
        folderPath,
        originalName: file.originalname,
        mimeType: file.mimetype,
        createdBy: userId || RequestContext.getUserId() || undefined,
        fileBuffer: file.buffer,
        persistEntityMetadata: async (manager) => {
          // SGS-CHK-CON-007: conditional update prevents double-emission race —
          // two concurrent attachPdf requests both pass assertChecklistReadyForFinalPdf
          // but only the first one's UPDATE matches (pdf_file_key IS NULL).
          const result = await manager.getRepository(Checklist).update(
            { id: checklist.id, pdf_file_key: IsNull() },
            {
              pdf_file_key: fileKey,
              pdf_folder_path: folderPath,
              pdf_original_name: file.originalname,
            },
          );
          if (result.affected !== 1) {
            throw new ConflictException(
              'O checklist já possui PDF final anexado.',
            );
          }
        },
      });

      this.logChecklistEvent('checklist_pdf_attached', checklist, {
        keyFingerprint: storageKeyFingerprint(fileKey),
        folderPath,
        originalName: file.originalname,
      });

      return {
        fileKey,
        folderPath,
        originalName: file.originalname,
      };
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `checklist:${checklist.id}`,
        fileKey,
        (key) =>
          uploadedReference.key === key
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      this.rethrowHttpAware(error, 'Falha ao anexar PDF final do checklist.');
    }
  }

  async getPdfAccess(id: string): Promise<ChecklistPdfAccessResponse> {
    const checklist = await this.findOneEntity(id);
    if (!checklist.pdf_file_key) {
      const response: ChecklistPdfAccessResponse = {
        entityId: checklist.id,
        fileKey: null,
        folderPath: null,
        originalName: null,
        url: null,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message: 'O checklist ainda não possui PDF final emitido.',
      };
      this.logChecklistEvent('checklist_pdf_access_checked', checklist, {
        availability: response.availability,
      });
      return response;
    }

    let url: string | null;
    let availability: ChecklistPdfAccessAvailability = 'ready';
    let message = 'PDF final do checklist disponível para acesso.';
    try {
      url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          checklist.pdf_file_key,
          {
            resourceType: 'checklist',
            resourceId: checklist.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
      );
      if (!url) {
        availability = 'registered_without_signed_url';
        message =
          'PDF final registrado, mas a URL assinada não está disponível no momento.';
      }
    } catch {
      url = null;
      availability = 'registered_without_signed_url';
      message =
        'PDF final registrado, mas a URL assinada não está disponível no momento.';
    }

    const response: ChecklistPdfAccessResponse = {
      entityId: checklist.id,
      fileKey: checklist.pdf_file_key,
      folderPath: checklist.pdf_folder_path,
      originalName: checklist.pdf_original_name,
      url,
      hasFinalPdf: true,
      availability,
      message,
    };

    this.logChecklistEvent('checklist_pdf_access_checked', checklist, {
      availability: response.availability,
      hasUrl: Boolean(response.url),
    });

    return response;
  }

  async count(options?: { where?: Record<string, unknown> }): Promise<number> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    const where = options?.where || {};
    const effectiveWhere =
      'deleted_at' in where ? where : { ...where, deleted_at: IsNull() };
    const scopedWhere =
      !isSuperAdmin && siteScope !== 'all'
        ? { ...effectiveWhere, site_id: In(siteIds) }
        : effectiveWhere;
    return this.checklistsRepository.count({
      where: { ...scopedWhere, company_id: companyId },
    });
  }

  async listStoredFiles(filters: WeeklyBundleFilters) {
    const files = await this.documentGovernanceService.listFinalDocuments(
      'checklist',
      filters,
    );
    const allowedIds = await this.getAllowedChecklistIdsForCurrentScope();
    if (!allowedIds) {
      return files;
    }

    return files.filter((file) => allowedIds.has(file.entityId));
  }

  async getWeeklyBundle(filters: WeeklyBundleFilters) {
    const files = await this.listStoredFiles(filters);
    return this.documentBundleService.buildWeeklyPdfBundle(
      'Checklist',
      filters,
      files.map((file) => ({
        fileKey: file.fileKey,
        resourceType: 'checklist',
        resourceId: file.entityId,
        title: file.title,
        originalName: file.originalName,
        date: file.date,
      })),
    );
  }

  async importFromWord(
    fileBuffer: Buffer,
    mimetype: string,
    originalname: string,
  ): Promise<ChecklistResponseDto> {
    const tenantId = this.tenantService.getTenantId();
    this.logger.log(`Importando checklist do Word para empresa: ${tenantId}`);

    // 1. Extrair texto do arquivo Word/PDF
    const rawText = await this.fileParserService.extractText(
      fileBuffer,
      mimetype,
      originalname,
    );

    if (!rawText || rawText.trim().length < 10) {
      throw new BadRequestException(
        'O arquivo não contém texto suficiente para extrair um checklist.',
      );
    }

    // 2. Enviar para o runtime LLM configurado e estruturar como checklist.
    // A mesma resolução fornece chave, URL e modelo, impedindo mistura entre
    // credencial OpenAI e endpoint NVIDIA.
    const llm = resolveAiLlmRuntimeConfig(this.configService);

    let structured: {
      titulo: string;
      descricao: string;
      categoria: string;
      periodicidade: string;
      nivel_risco_padrao: string;
      itens: Array<{
        item: string;
        tipo_resposta: string;
        obrigatorio: boolean;
      }>;
    };

    if (!isConfiguredAiLlmRuntime(llm)) {
      this.logger.warn(
        `Runtime de IA ${llm.configuredProvider} não configurado; usando stub de importação.`,
      );
      structured = {
        titulo:
          originalname.replace(/\.(docx?|pdf)$/i, '').trim() ||
          'Checklist Importado',
        descricao:
          'Modelo importado de arquivo. Edite os itens conforme necessário.',
        categoria: 'SST',
        periodicidade: 'Por tarefa',
        nivel_risco_padrao: 'Médio',
        itens: rawText
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 3)
          .slice(0, 30)
          .map((line) => ({
            item: line,
            tipo_resposta: 'sim_nao_na',
            obrigatorio: true,
          })),
      };
    } else {
      const systemPrompt = `Você é um especialista em segurança do trabalho (SST/NR).
Analise o texto extraído de um documento Word e estruture-o como um checklist de inspeção SST.
Retorne SOMENTE um JSON válido, sem markdown, sem explicações adicionais.
Formato obrigatório:
{
  "titulo": "título do checklist (curto, descritivo)",
  "descricao": "descrição do propósito do checklist",
  "categoria": "SST|Qualidade|Equipamento|Atividade Crítica|Manutenção",
  "periodicidade": "Diário|Semanal|Mensal|Por tarefa|Por turno|Por entrada",
  "nivel_risco_padrao": "Baixo|Médio|Alto|Crítico",
  "itens": [
    {
      "item": "descrição do item a verificar",
      "tipo_resposta": "sim_nao_na|conforme|texto|sim_nao",
      "obrigatorio": true
    }
  ]
}
Regras:
- Extraia apenas itens que são verificações concretas (não cabeçalhos ou rodapés)
- Prefira tipo_resposta "sim_nao_na" para verificações binárias
- Use "texto" para itens que pedem descrição ou observação
- Limite a no máximo 50 itens`;

      const userPrompt = `Texto extraído do documento "${originalname}":\n\n${rawText.slice(0, 6000)}`;

      const response = await requestOpenAiChatCompletionResponse({
        runtime: llm,
        body: {
          model: llm.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 4000,
          reasoning_effort: llm.reasoningEffort,
        },
        configService: this.configService,
        integration: this.integrationResilienceService,
        circuitBreaker: this.openAiCircuitBreaker,
      });

      if (!response.ok) {
        throw new BadRequestException(
          `Erro ao processar com IA: ${response.status} ${response.statusText}`,
        );
      }

      const json = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = json.choices?.[0]?.message?.content || '';

      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new BadRequestException('JSON não encontrado na resposta');
        }
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        const parsedItems = Array.isArray(parsed.itens) ? parsed.itens : [];

        structured = {
          titulo:
            typeof parsed.titulo === 'string' && parsed.titulo.trim()
              ? parsed.titulo.trim()
              : originalname.replace(/\.(docx?|pdf)$/i, '').trim() ||
                'Checklist Importado',
          descricao:
            typeof parsed.descricao === 'string' ? parsed.descricao : '',
          categoria:
            typeof parsed.categoria === 'string' ? parsed.categoria : 'SST',
          periodicidade:
            typeof parsed.periodicidade === 'string'
              ? parsed.periodicidade
              : 'Por tarefa',
          nivel_risco_padrao:
            typeof parsed.nivel_risco_padrao === 'string'
              ? parsed.nivel_risco_padrao
              : 'Médio',
          itens: parsedItems
            .map((item) => {
              const current =
                item && typeof item === 'object'
                  ? (item as Record<string, unknown>)
                  : null;
              if (!current || typeof current.item !== 'string') {
                return null;
              }
              return {
                item: current.item,
                tipo_resposta:
                  typeof current.tipo_resposta === 'string'
                    ? current.tipo_resposta
                    : 'sim_nao_na',
                obrigatorio: current.obrigatorio !== false,
              };
            })
            .filter(
              (
                item,
              ): item is {
                item: string;
                tipo_resposta: string;
                obrigatorio: boolean;
              } => item !== null,
            ),
        };
      } catch {
        throw new BadRequestException(
          'Não foi possível interpretar a resposta da IA. Tente novamente ou ajuste o arquivo.',
        );
      }
    }

    if (!structured.itens?.length) {
      throw new BadRequestException(
        'Nenhum item de checklist foi identificado no documento.',
      );
    }

    // 3. Criar checklist como modelo (is_modelo = true)
    // SECURITY: sanitize all free-text fields from AI/stub import path (bypasses DTO @Transform)
    const sanitizedTitulo = sanitizePlainText(
      structured.titulo || 'Checklist Importado',
    ) as string;
    const sanitizedDescricao = structured.descricao
      ? (sanitizePlainText(structured.descricao) as string)
      : '';
    const sanitizedCategoria = structured.categoria
      ? (sanitizePlainText(structured.categoria) as string)
      : 'SST';
    const sanitizedPeriodicidade = structured.periodicidade
      ? (sanitizePlainText(structured.periodicidade) as string)
      : 'Por tarefa';
    const sanitizedNivel = structured.nivel_risco_padrao
      ? (sanitizePlainText(structured.nivel_risco_padrao) as string)
      : 'Médio';

    const checklist = this.checklistsRepository.create({
      titulo: sanitizedTitulo,
      descricao: sanitizedDescricao,
      categoria: sanitizedCategoria,
      periodicidade: sanitizedPeriodicidade,
      nivel_risco_padrao: sanitizedNivel,
      itens: structured.itens.map((item, idx) => ({
        id: `item-${idx + 1}`,
        item: sanitizePlainText(item.item) as string,
        tipo_resposta: (item.tipo_resposta ||
          'sim_nao_na') as ChecklistItemValue['tipo_resposta'],
        obrigatorio: item.obrigatorio !== false,
        status: 'ok',
        peso: 1,
        observacao: '',
      })) as ChecklistItemValue[],
      is_modelo: true,
      status: 'Pendente',
      data: new Date().toISOString().split('T')[0],
      company_id: tenantId || '',
    });

    const saved = await this.checklistsRepository.save(checklist);
    this.logger.log(
      `Checklist importado do Word salvo como modelo: ${saved.id}`,
    );
    return this.toChecklistResponse(saved);
  }

  /** Validação pública por código de documento (ex.: CHK-2026-XXXXXXXX) */
  async validateByCode(
    code: string,
    companyId: string,
  ): Promise<{
    valid: boolean;
    code?: string;
    message?: string;
  }> {
    const normalized = code.trim().toUpperCase();

    if (!normalized.startsWith('CHK-')) {
      return {
        valid: false,
        message: 'Código inválido ou expirado.',
      };
    }

    const validation = await this.documentRegistryService.validatePublicCode({
      code: normalized,
      companyId,
      expectedModule: 'checklist',
    });

    if (!validation.valid) {
      return {
        valid: false,
        code: normalized,
        message: validation.message,
      };
    }

    return {
      valid: true,
      code: normalized,
    };
  }

  async validateByCodeLegacy(code: string): Promise<{
    valid: boolean;
    code?: string;
    message?: string;
  }> {
    const normalized = code.trim().toUpperCase();
    if (!normalized.startsWith('CHK-')) {
      return {
        valid: false,
        message: 'Código inválido ou expirado.',
      };
    }

    return this.documentRegistryService.validateLegacyPublicCode({
      code: normalized,
      expectedModule: 'checklist',
    });
  }
}
