import {
  BadRequestException,
  ConflictException,
  Inject,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  EntityManager,
  In,
  QueryFailedError,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { jsonToExcelBuffer } from '../../shared/utils/excel.util';
import {
  EquipamentoItem,
  MaoDeObraItem,
  MaterialItem,
  OcorrenciaItem,
  Rdo,
  ServicoItem,
} from './entities/rdo.entity';
import { CreateRdoDto } from './dto/create-rdo.dto';
import { FindRdosQueryDto } from './dto/find-rdos-query.dto';
import { UpdateRdoDto } from './dto/update-rdo.dto';
import { Site } from '../sites/entities/site.entity';
import { User } from '../users/entities/user.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { MailService } from '../../infra/mail/mail.service';
import { DocumentMailDispatchResponseDto } from '../../infra/mail/dto/document-mail-dispatch-response.dto';
import { defaultJobOptions } from '../../infra/queue/default-job-options';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentRegistryService } from '../document-registry/document-registry.service';
import { cleanupUploadedFile } from '../../shared/storage/storage-compensation.util';
import { DocumentBundleService } from '../../shared/services/document-bundle.service';
import { WeeklyBundleFilters } from '../../shared/services/document-bundle.service';
import { RdoAuditService } from './rdo-audit.service';
import { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import { SignatureTimestampService } from '../../shared/services/signature-timestamp.service';
import { DocumentVideosService } from '../document-videos/document-videos.service';
import { normalizeOptionalSearchQuery } from '../../shared/utils/query-normalization.util';
import { escapeLikePattern } from '../../shared/utils/sql.util';
import { RequestContext } from '../../shared/middleware/request-context.middleware';
import {
  SIGNATURE_LEGAL_ASSURANCE,
  SIGNATURE_PROOF_SCOPES,
  SIGNATURE_VERIFICATION_MODES,
  canonicalizeSignaturePayload,
  hashCanonicalSignaturePayload,
} from '../signatures/signature-proof.util';

const ALLOWED_STATUS_TRANSITIONS: Record<string, string[]> = {
  rascunho: ['enviado'],
  enviado: ['aprovado', 'rascunho'],
  aprovado: [],
  cancelado: [],
};

const CANCELABLE_STATUSES = new Set(['rascunho', 'enviado', 'aprovado']);
const FILTERABLE_RDO_STATUSES = new Set([
  'rascunho',
  'enviado',
  'aprovado',
  'cancelado',
]);

const CLIMA_LABEL: Record<string, string> = {
  ensolarado: 'Ensolarado ☀️',
  nublado: 'Nublado ☁️',
  chuvoso: 'Chuvoso 🌧️',
  parcialmente_nublado: 'Parcialmente Nublado 🌤️',
};

const RDO_ACTIVITY_PHOTO_REF_PREFIX = 'gst:rdo-activity-photo:';
const RDO_ACTIVITY_PHOTO_MAX_PER_ACTIVITY = 10;

const RDO_POSTGRES_LOCK_NOT_AVAILABLE_CODE = '55P03';
const RDO_ROW_LOCK_RETRY_DELAYS_MS = [50, 100, 200] as const;

import { GovernedPdfAccessAvailability } from '../../shared/dto/governed-pdf-access-response.dto';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';

type RdoPdfAccessAvailability = GovernedPdfAccessAvailability;

type GovernedRdoActivityPhotoReferencePayload = {
  v: 1;
  kind: 'governed-storage';
  scope: 'activity';
  fileKey: string;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  sizeBytes: number;
};

type RdoActivityPhotoAccessAvailability =
  'ready' | 'registered_without_signed_url';

type RdoActivityPhotoAccessResponse = {
  entityId: string;
  activityIndex: number;
  photoIndex: number;
  hasGovernedPhoto: true;
  availability: RdoActivityPhotoAccessAvailability;
  fileKey: string;
  originalName: string;
  mimeType: string;
  url: string | null;
  message: string | null;
};

type RdoActivityPhotoAttachResponse = {
  entityId: string;
  activityIndex: number;
  photoIndex: number;
  storageMode: 'governed-storage';
  message: string;
  photoReference: string;
  photo: {
    fileKey: string;
    originalName: string;
    mimeType: string;
  };
  signaturesReset: boolean;
};

type RdoActivityPhotoRemovalResponse = {
  entityId: string;
  activityIndex: number;
  photoIndex: number;
  removed: true;
  removedFileKey: string;
  signaturesReset: boolean;
};

type RdoOperationalSignature = {
  nome: string;
  cpf: string;
  signed_at: string;
  signature_mode: 'operational_ack';
  verification_mode: 'operational_ack';
  legal_assurance: 'not_legal_strong';
  verification_scope: 'document_integrity_snapshot';
  document_hash_algorithm: 'sha256';
  document_hash: string;
  signature_hash_algorithm: 'sha256';
  signature_hash: string;
  timestamp_token: string;
  timestamp_authority: string;
  canonical_payload_version: 1;
};

@Injectable()
export class RdosService {
  private readonly logger = new Logger(RdosService.name);

  constructor(
    @InjectRepository(Rdo)
    private rdosRepository: Repository<Rdo>,
    private tenantService: TenantService,
    @Inject(forwardRef(() => MailService))
    private mailService: MailService,
    @InjectQueue('mail')
    private readonly mailQueue: Queue,
    private documentStorageService: DocumentStorageService,
    private documentGovernanceService: DocumentGovernanceService,
    private documentRegistryService: DocumentRegistryService,
    private readonly documentBundleService: DocumentBundleService,
    private rdoAuditService: RdoAuditService,
    private readonly forensicTrailService: ForensicTrailService,
    private readonly signatureTimestampService: SignatureTimestampService,
    private readonly documentVideosService: DocumentVideosService,
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
    const rdo = await this.findOne(id);
    const documentCode = this.buildValidationCode(rdo);
    let token: string | null = null;

    try {
      token = await this.publicValidationGrantService.issueToken({
        code: documentCode,
        companyId: rdo.company_id,
        portal: 'rdo_public_validation',
        documentId: rdo.id,
      });
    } catch (error) {
      this.logger.warn({
        event: 'rdo_validation_token_unavailable',
        rdoId: rdo.id,
        companyId: rdo.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return { documentCode, token };
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

    const exists = await this.rdosRepository.manager
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

  private async validateRelatedEntityScope(input: {
    companyId: string;
    siteId?: string | null;
    responsavelId?: string | null;
  }): Promise<void> {
    await Promise.all([
      this.assertCompanyScopedEntityId(
        Site,
        input.companyId,
        input.siteId,
        'Site',
      ),
      this.assertCompanyScopedEntityId(
        User,
        input.companyId,
        input.responsavelId,
        'Responsável',
      ),
    ]);
  }

  private resolveCompanyIdForCreate(): string {
    const { companyId } = this.getTenantContextOrThrow();
    return companyId;
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
      'RDO',
    );

    return {
      companyId: scope.companyId,
      siteId: scope.siteId,
      siteIds: scope.siteIds,
      siteScope: scope.siteScope,
      isSuperAdmin: scope.isSuperAdmin,
    };
  }

  private async getAllowedRdoIdsForCurrentScope(): Promise<Set<string> | null> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();

    if (isSuperAdmin || siteScope === 'all') {
      return null;
    }

    // Teto de segurança: lista de IDs permitidos usada só como allow-list em
    // memória para filtrar documentos (document_registry não tem site_id).
    // Não deveria ser atingido na prática — mesma técnica de
    // ProfilesService.findAll / findAllForExport.
    const scopedRdos = await this.rdosRepository.find({
      select: ['id'],
      where: { company_id: companyId, site_id: In(siteIds) },
      take: 50000,
    });

    return new Set(scopedRdos.map((rdo) => rdo.id));
  }

  private resolveStatusForCreate(requestedStatus?: string): string {
    if (!requestedStatus || requestedStatus === 'rascunho') {
      return 'rascunho';
    }

    throw new BadRequestException(
      'O status do RDO é controlado pelo fluxo formal de tramitação. Crie o documento como rascunho e use PATCH /rdos/:id/status para avançar o ciclo.',
    );
  }

  private logRdoEvent(
    event: string,
    rdo: Pick<
      Rdo,
      | 'id'
      | 'company_id'
      | 'status'
      | 'site_id'
      | 'responsavel_id'
      | 'pdf_file_key'
    >,
    metadata: Record<string, unknown> = {},
  ) {
    this.logger.log({
      event,
      rdoId: rdo.id,
      companyId: rdo.company_id,
      status: rdo.status,
      siteId: rdo.site_id ?? null,
      responsavelId: rdo.responsavel_id ?? null,
      hasFinalPdf: Boolean(rdo.pdf_file_key),
      ...metadata,
    });
  }

  private isDuplicateNumeroError(error: unknown): boolean {
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
        return constraint.includes('uq_rdos_company_numero');
      }
    }

    const message =
      error instanceof Error
        ? error.message.toLowerCase()
        : typeof error === 'string'
          ? error.toLowerCase()
          : '';

    return (
      message.includes('uq_rdos_company_numero') ||
      message.includes('duplicate key')
    );
  }

  private async generateNumero(companyId: string): Promise<string> {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `RDO-${yyyymm}-`;
    const last = await this.rdosRepository
      .createQueryBuilder('rdo')
      .select('MAX(rdo.numero)', 'max')
      .where('rdo.company_id = :companyId', { companyId })
      .andWhere('rdo.numero LIKE :prefix', { prefix: `${prefix}%` })
      .getRawOne<{ max: string | null }>();
    const lastSeq = last?.max ? Number(last.max.slice(prefix.length)) || 0 : 0;
    return `${prefix}${String(lastSeq + 1).padStart(3, '0')}`;
  }

  private buildSignatureTrackedSnapshot(
    rdo: Pick<
      Rdo,
      | 'data'
      | 'site_id'
      | 'responsavel_id'
      | 'clima_manha'
      | 'clima_tarde'
      | 'temperatura_min'
      | 'temperatura_max'
      | 'condicao_terreno'
      | 'mao_de_obra'
      | 'equipamentos'
      | 'materiais_recebidos'
      | 'servicos_executados'
      | 'ocorrencias'
      | 'houve_acidente'
      | 'houve_paralisacao'
      | 'motivo_paralisacao'
      | 'observacoes'
      | 'programa_servicos_amanha'
    >,
  ) {
    return {
      data: rdo.data,
      site_id: rdo.site_id ?? null,
      responsavel_id: rdo.responsavel_id ?? null,
      clima_manha: rdo.clima_manha ?? null,
      clima_tarde: rdo.clima_tarde ?? null,
      temperatura_min: rdo.temperatura_min ?? null,
      temperatura_max: rdo.temperatura_max ?? null,
      condicao_terreno: rdo.condicao_terreno ?? null,
      mao_de_obra: rdo.mao_de_obra ?? [],
      equipamentos: rdo.equipamentos ?? [],
      materiais_recebidos: rdo.materiais_recebidos ?? [],
      servicos_executados: rdo.servicos_executados ?? [],
      ocorrencias: rdo.ocorrencias ?? [],
      houve_acidente: rdo.houve_acidente,
      houve_paralisacao: rdo.houve_paralisacao,
      motivo_paralisacao: rdo.motivo_paralisacao ?? null,
      observacoes: rdo.observacoes ?? null,
      programa_servicos_amanha: rdo.programa_servicos_amanha ?? null,
    };
  }

  private buildSnapshotHash(
    rdo: Pick<
      Rdo,
      | 'data'
      | 'site_id'
      | 'responsavel_id'
      | 'clima_manha'
      | 'clima_tarde'
      | 'temperatura_min'
      | 'temperatura_max'
      | 'condicao_terreno'
      | 'mao_de_obra'
      | 'equipamentos'
      | 'materiais_recebidos'
      | 'servicos_executados'
      | 'ocorrencias'
      | 'houve_acidente'
      | 'houve_paralisacao'
      | 'motivo_paralisacao'
      | 'observacoes'
      | 'programa_servicos_amanha'
    >,
  ): string {
    return hashCanonicalSignaturePayload(
      this.buildSignatureTrackedSnapshot(rdo),
    );
  }

  private buildOperationalSignatureCanonicalPayload(input: {
    rdo: Pick<
      Rdo,
      | 'id'
      | 'company_id'
      | 'numero'
      | 'status'
      | 'updated_at'
      | 'data'
      | 'site_id'
      | 'responsavel_id'
      | 'clima_manha'
      | 'clima_tarde'
      | 'temperatura_min'
      | 'temperatura_max'
      | 'condicao_terreno'
      | 'mao_de_obra'
      | 'equipamentos'
      | 'materiais_recebidos'
      | 'servicos_executados'
      | 'ocorrencias'
      | 'houve_acidente'
      | 'houve_paralisacao'
      | 'motivo_paralisacao'
      | 'observacoes'
      | 'programa_servicos_amanha'
    >;
    signerType: 'responsavel' | 'engenheiro';
    signerName: string;
    signerCpf: string;
    signedAt: string;
    actorUserId?: string | null;
  }) {
    return canonicalizeSignaturePayload({
      schema_version: 1,
      verification_mode: SIGNATURE_VERIFICATION_MODES.OPERATIONAL_ACK,
      legal_assurance: SIGNATURE_LEGAL_ASSURANCE.NOT_LEGAL_STRONG,
      document: {
        id: input.rdo.id,
        company_id: input.rdo.company_id,
        numero: input.rdo.numero,
        status: input.rdo.status,
        updated_at: input.rdo.updated_at?.toISOString?.() ?? null,
        proof_scope: SIGNATURE_PROOF_SCOPES.OPERATIONAL_SNAPSHOT,
        snapshot_hash: this.buildSnapshotHash(input.rdo),
      },
      signer: {
        actor_user_id: input.actorUserId || null,
        role: input.signerType,
        name: input.signerName,
        cpf_suffix: input.signerCpf.slice(-4),
      },
      signed_at: input.signedAt,
    });
  }

  private resetSignatures(
    rdo: Pick<
      Rdo,
      | 'assinatura_responsavel'
      | 'assinatura_engenheiro'
      | 'status'
      | 'id'
      | 'company_id'
      | 'site_id'
      | 'responsavel_id'
      | 'pdf_file_key'
    >,
    reason: 'content_changed' | 'returned_to_draft',
  ): boolean {
    if (!rdo.assinatura_responsavel && !rdo.assinatura_engenheiro) {
      return false;
    }

    rdo.assinatura_responsavel = null;
    rdo.assinatura_engenheiro = null;

    this.logRdoEvent('rdo_signatures_reset', rdo, { reason });
    return true;
  }

  private assertRdoNotCancelled(
    rdo: Pick<Rdo, 'status'>,
    action: 'editado' | 'assinado' | 'movimentado',
  ) {
    if (rdo.status === 'cancelado') {
      throw new BadRequestException(`RDO cancelado não pode ser ${action}.`);
    }
  }

  private encodeBase64Url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  private decodeBase64Url(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf8');
  }

  private buildGovernedActivityPhotoReference(
    payload: GovernedRdoActivityPhotoReferencePayload,
  ): string {
    return `${RDO_ACTIVITY_PHOTO_REF_PREFIX}${this.encodeBase64Url(JSON.stringify(payload))}`;
  }

  private parseGovernedActivityPhotoReference(
    value?: string | null,
  ): GovernedRdoActivityPhotoReferencePayload | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return null;
    }

    if (!normalized.startsWith(RDO_ACTIVITY_PHOTO_REF_PREFIX)) {
      return null;
    }

    const encodedPayload = normalized.slice(
      RDO_ACTIVITY_PHOTO_REF_PREFIX.length,
    );
    if (!encodedPayload) {
      throw new BadRequestException(
        'Referência de foto governada da atividade do RDO inválida.',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.decodeBase64Url(encodedPayload));
    } catch {
      throw new BadRequestException(
        'Referência de foto governada da atividade do RDO inválida.',
      );
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as GovernedRdoActivityPhotoReferencePayload).v !== 1 ||
      (parsed as GovernedRdoActivityPhotoReferencePayload).kind !==
        'governed-storage' ||
      (parsed as GovernedRdoActivityPhotoReferencePayload).scope !==
        'activity' ||
      typeof (parsed as GovernedRdoActivityPhotoReferencePayload).fileKey !==
        'string' ||
      typeof (parsed as GovernedRdoActivityPhotoReferencePayload)
        .originalName !== 'string' ||
      typeof (parsed as GovernedRdoActivityPhotoReferencePayload).mimeType !==
        'string' ||
      typeof (parsed as GovernedRdoActivityPhotoReferencePayload).uploadedAt !==
        'string'
    ) {
      throw new BadRequestException(
        'Referência de foto governada da atividade do RDO inválida.',
      );
    }

    return parsed as GovernedRdoActivityPhotoReferencePayload;
  }

  private normalizeOptionalText(value?: string | null): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed || undefined;
  }

  private requireText(
    value: string | undefined,
    fieldLabel: string,
    itemLabel: string,
  ): string {
    const normalized = this.normalizeOptionalText(value);
    if (!normalized) {
      throw new BadRequestException(
        `${fieldLabel} é obrigatório em ${itemLabel}.`,
      );
    }

    return normalized;
  }

  private normalizeActivityPhotoReferences(
    photos?: string[],
  ): string[] | undefined {
    if (photos === undefined) {
      return undefined;
    }

    const normalized = photos.map((photo, photoIndex) => {
      const value = this.normalizeOptionalText(photo);
      if (!value) {
        throw new BadRequestException(
          `Foto ${photoIndex + 1} da atividade do RDO inválida.`,
        );
      }

      const parsed = this.parseGovernedActivityPhotoReference(value);
      if (!parsed) {
        throw new BadRequestException(
          'Fotos da atividade do RDO devem usar referências governadas emitidas pela plataforma.',
        );
      }

      return value;
    });

    if (normalized.length > RDO_ACTIVITY_PHOTO_MAX_PER_ACTIVITY) {
      throw new BadRequestException(
        `Cada atividade aceita no máximo ${RDO_ACTIVITY_PHOTO_MAX_PER_ACTIVITY} fotos.`,
      );
    }

    return normalized;
  }

  private normalizeMaoDeObra(
    items?: MaoDeObraItem[],
  ): MaoDeObraItem[] | undefined {
    if (items === undefined) {
      return undefined;
    }

    return items.map((item, index) => ({
      ...item,
      funcao: this.requireText(
        item.funcao,
        'Função',
        `mão de obra #${index + 1}`,
      ),
    }));
  }

  private normalizeEquipamentos(
    items?: EquipamentoItem[],
  ): EquipamentoItem[] | undefined {
    if (items === undefined) {
      return undefined;
    }

    return items.map((item, index) => ({
      ...item,
      nome: this.requireText(item.nome, 'Nome', `equipamento #${index + 1}`),
      observacao: this.normalizeOptionalText(item.observacao),
    }));
  }

  private normalizeMateriais(
    items?: MaterialItem[],
  ): MaterialItem[] | undefined {
    if (items === undefined) {
      return undefined;
    }

    return items.map((item, index) => ({
      ...item,
      descricao: this.requireText(
        item.descricao,
        'Descrição',
        `material #${index + 1}`,
      ),
      unidade: this.requireText(
        item.unidade,
        'Unidade',
        `material #${index + 1}`,
      ),
      fornecedor: this.normalizeOptionalText(item.fornecedor),
    }));
  }

  private normalizeServicos(items?: ServicoItem[]): ServicoItem[] | undefined {
    if (items === undefined) {
      return undefined;
    }

    return items.map((item, index) => ({
      ...item,
      descricao: this.requireText(
        item.descricao,
        'Descrição',
        `atividade #${index + 1}`,
      ),
      observacao: this.normalizeOptionalText(item.observacao),
      fotos: this.normalizeActivityPhotoReferences(item.fotos) ?? [],
    }));
  }

  private normalizeOcorrencias(
    items?: OcorrenciaItem[],
  ): OcorrenciaItem[] | undefined {
    if (items === undefined) {
      return undefined;
    }

    return items.map((item, index) => ({
      ...item,
      descricao: this.requireText(
        item.descricao,
        'Descrição',
        `ocorrência #${index + 1}`,
      ),
      hora: this.normalizeOptionalText(item.hora),
    }));
  }

  private normalizeRdoPayload(
    input: CreateRdoDto | UpdateRdoDto,
  ): Partial<Rdo> {
    const normalized: Partial<Rdo> = {};

    if (input.data !== undefined) {
      normalized.data = new Date(input.data);
    }
    if (input.site_id !== undefined) {
      normalized.site_id = input.site_id;
    }
    if (input.responsavel_id !== undefined) {
      normalized.responsavel_id = input.responsavel_id;
    }
    if (input.company_id !== undefined) {
      normalized.company_id = input.company_id;
    }
    if (input.clima_manha !== undefined) {
      normalized.clima_manha = input.clima_manha;
    }
    if (input.clima_tarde !== undefined) {
      normalized.clima_tarde = input.clima_tarde;
    }
    if (input.temperatura_min !== undefined) {
      normalized.temperatura_min = input.temperatura_min;
    }
    if (input.temperatura_max !== undefined) {
      normalized.temperatura_max = input.temperatura_max;
    }
    if (input.condicao_terreno !== undefined) {
      normalized.condicao_terreno = this.normalizeOptionalText(
        input.condicao_terreno,
      );
    }
    if (input.mao_de_obra !== undefined) {
      normalized.mao_de_obra = this.normalizeMaoDeObra(input.mao_de_obra) ?? [];
    }
    if (input.equipamentos !== undefined) {
      normalized.equipamentos =
        this.normalizeEquipamentos(input.equipamentos) ?? [];
    }
    if (input.materiais_recebidos !== undefined) {
      normalized.materiais_recebidos =
        this.normalizeMateriais(input.materiais_recebidos) ?? [];
    }
    if (input.servicos_executados !== undefined) {
      normalized.servicos_executados =
        this.normalizeServicos(input.servicos_executados) ?? [];
    }
    if (input.ocorrencias !== undefined) {
      normalized.ocorrencias =
        this.normalizeOcorrencias(input.ocorrencias) ?? [];
    }
    if (input.houve_acidente !== undefined) {
      normalized.houve_acidente = input.houve_acidente;
    }
    if (input.houve_paralisacao !== undefined) {
      normalized.houve_paralisacao = input.houve_paralisacao;
    }
    if (input.motivo_paralisacao !== undefined) {
      normalized.motivo_paralisacao = this.normalizeOptionalText(
        input.motivo_paralisacao,
      );
    }
    if (input.observacoes !== undefined) {
      normalized.observacoes = this.normalizeOptionalText(input.observacoes);
    }
    if (input.programa_servicos_amanha !== undefined) {
      normalized.programa_servicos_amanha = this.normalizeOptionalText(
        input.programa_servicos_amanha,
      );
    }

    return normalized;
  }

  private assertRdoBusinessRules(
    rdo: Pick<
      Rdo,
      | 'temperatura_min'
      | 'temperatura_max'
      | 'houve_paralisacao'
      | 'motivo_paralisacao'
      | 'servicos_executados'
    >,
  ): void {
    if (
      rdo.temperatura_min != null &&
      rdo.temperatura_max != null &&
      Number(rdo.temperatura_min) > Number(rdo.temperatura_max)
    ) {
      throw new BadRequestException(
        'A temperatura mínima não pode ser maior que a temperatura máxima.',
      );
    }

    if (rdo.houve_paralisacao) {
      const reason = this.normalizeOptionalText(rdo.motivo_paralisacao);
      if (!reason) {
        throw new BadRequestException(
          'Informe o motivo da paralisação quando o RDO registrar paralisação.',
        );
      }
      rdo.motivo_paralisacao = reason;
    } else {
      rdo.motivo_paralisacao = undefined;
    }

    for (const [index, item] of (rdo.servicos_executados ?? []).entries()) {
      if ((item.fotos?.length ?? 0) > RDO_ACTIVITY_PHOTO_MAX_PER_ACTIVITY) {
        throw new BadRequestException(
          `A atividade #${index + 1} excedeu o limite de ${RDO_ACTIVITY_PHOTO_MAX_PER_ACTIVITY} fotos.`,
        );
      }
    }
  }

  private countActivityPhotos(rdo: Pick<Rdo, 'servicos_executados'>): number {
    return (rdo.servicos_executados ?? []).reduce(
      (total, item) => total + (item.fotos?.length ?? 0),
      0,
    );
  }

  private collectGovernedActivityPhotoPayloads(
    rdo: Pick<Rdo, 'servicos_executados'>,
  ): GovernedRdoActivityPhotoReferencePayload[] {
    const payloads: GovernedRdoActivityPhotoReferencePayload[] = [];

    (rdo.servicos_executados ?? []).forEach((activity) => {
      (activity.fotos ?? []).forEach((photo) => {
        const payload = this.parseGovernedActivityPhotoReference(photo);
        if (payload) {
          payloads.push(payload);
        }
      });
    });

    return payloads;
  }

  private isValidDateOnly(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));

    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }

  private assertFindPaginatedFilters(opts?: FindRdosQueryDto): void {
    if (!opts) {
      return;
    }

    if (opts.status && !FILTERABLE_RDO_STATUSES.has(opts.status)) {
      throw new BadRequestException('Status de filtro do RDO inválido.');
    }

    if (opts.data_inicio && !this.isValidDateOnly(opts.data_inicio)) {
      throw new BadRequestException(
        'A data inicial do filtro deve ser uma data válida no formato YYYY-MM-DD.',
      );
    }

    if (opts.data_fim && !this.isValidDateOnly(opts.data_fim)) {
      throw new BadRequestException(
        'A data final do filtro deve ser uma data válida no formato YYYY-MM-DD.',
      );
    }
  }

  private applyFindPaginatedFilters(
    qb: SelectQueryBuilder<Rdo>,
    tenantId?: string | null,
    opts?: FindRdosQueryDto,
  ): void {
    let hasWhereClause = false;
    const appendClause = (
      clause: string,
      parameters: Record<string, unknown>,
    ) => {
      if (!hasWhereClause) {
        qb.where(clause, parameters);
        hasWhereClause = true;
        return;
      }

      qb.andWhere(clause, parameters);
    };

    // RDO tem soft-delete (deleted_at, incluído no gdpr_delete_user_data).
    // createQueryBuilder NÃO filtra deleted_at automaticamente (só
    // Repository.find/count o fazem), então tanto a listagem quanto o total
    // precisam do filtro explícito — senão RDOs de titular anonimizado por
    // GDPR contam no total e criam "buracos" na página (IDs que o .find()
    // posterior descarta).
    appendClause('rdo.deleted_at IS NULL', {});

    if (tenantId) {
      appendClause('rdo.company_id = :tenantId', { tenantId });
    }
    if (opts?.site_id) {
      appendClause('rdo.site_id = :siteId', { siteId: opts.site_id });
    }
    if (opts?.status) {
      appendClause('rdo.status = :status', { status: opts.status });
    }
    if (opts?.data_inicio) {
      appendClause('rdo.data >= :dataInicio', { dataInicio: opts.data_inicio });
    }
    if (opts?.data_fim) {
      appendClause('rdo.data <= :dataFim', { dataFim: opts.data_fim });
    }
    const search = normalizeOptionalSearchQuery(opts?.search);
    if (search) {
      appendClause(
        "(rdo.numero ILIKE :search ESCAPE '\\\\' OR site.nome ILIKE :search ESCAPE '\\\\' OR responsavel.nome ILIKE :search ESCAPE '\\\\')",
        { search: `%${escapeLikePattern(search)}%` },
      );
    }
  }

  private cloneServicos(items?: ServicoItem[] | null): ServicoItem[] {
    return (items ?? []).map((item) => ({
      ...item,
      fotos: [...(item.fotos ?? [])],
    }));
  }

  private getActivityOrThrow(
    rdo: Pick<Rdo, 'servicos_executados'>,
    activityIndex: number,
  ): ServicoItem {
    const activity = Array.isArray(rdo.servicos_executados)
      ? rdo.servicos_executados[activityIndex]
      : undefined;

    if (!activity) {
      throw new BadRequestException('Atividade do RDO não encontrada.');
    }

    return activity;
  }

  /**
   * Serializa mutações no array JSONB de atividades do RDO sob SELECT FOR UPDATE
   * NOWAIT. Sem este lock, dois uploads/remoções concorrentes de foto na mesma
   * atividade fazem `save()` da linha inteira e o segundo sobrescreve o
   * primeiro — foto perdida do documento + arquivo órfão no storage.
   *
   * O callback recebe a linha travada e o EntityManager transacional. É
   * responsabilidade do callback chamar `manager.getRepository(Rdo).save(rdo)`
   * para persistir as alterações dentro da transação, e retornar o resultado.
   */
  private async mutateRdoContentLocked<T>(
    id: string,
    companyId: string,
    apply: (rdo: Rdo, manager: EntityManager) => T | Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt <= RDO_ROW_LOCK_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        return await this.rdosRepository.manager.transaction(
          async (manager) => {
            const rows = await manager.query<Rdo[]>(
              `SELECT * FROM "rdos" WHERE "id" = $1 AND "company_id" = $2 AND "deleted_at" IS NULL FOR UPDATE NOWAIT`,
              [id, companyId],
            );
            if (!rows || rows.length === 0) {
              throw new NotFoundException(`RDO com ID ${id} não encontrado`);
            }
            const rdo = manager.getRepository(Rdo).create(rows[0]);
            return apply(rdo, manager);
          },
        );
      } catch (error: unknown) {
        if (!this.isRdoLockNotAvailableError(error)) {
          throw error;
        }
        const retryDelayMs = RDO_ROW_LOCK_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined) {
          throw new ConflictException(
            'Outra operação está em andamento para este RDO. Tente novamente em instantes.',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    throw new ConflictException(
      'Outra operação está em andamento para este RDO. Tente novamente em instantes.',
    );
  }

  private isRdoLockNotAvailableError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === RDO_POSTGRES_LOCK_NOT_AVAILABLE_CODE
    );
  }

  private async persistContentMutation(
    rdo: Rdo,
    input: {
      previousSnapshot: string;
      previousStatus: string;
      hadSignaturesBeforeChange: boolean;
      auditEventType: string;
      auditDetails?: Record<string, unknown>;
    },
  ): Promise<{
    saved: Rdo;
    signaturesReset: boolean;
    approvalReset: boolean;
  }> {
    this.assertRdoBusinessRules(rdo);

    const nextSnapshot = this.buildSnapshotHash(rdo);
    const contentChanged = input.previousSnapshot !== nextSnapshot;
    const signaturesReset =
      input.hadSignaturesBeforeChange && contentChanged
        ? this.resetSignatures(rdo, 'content_changed')
        : false;
    const approvalReset = contentChanged && input.previousStatus === 'aprovado';

    if (approvalReset) {
      rdo.status = 'enviado';
    }

    const saved = await this.rdosRepository.save(rdo);
    await this.rdoAuditService.recordEvent(saved.id, input.auditEventType, {
      signaturesReset,
      previousStatus: input.previousStatus,
      currentStatus: saved.status,
      approvalReset,
      ...(input.auditDetails ?? {}),
    });

    if (signaturesReset) {
      await this.rdoAuditService.recordEvent(saved.id, 'SIGNATURES_RESET', {
        reason: 'content_changed',
      });
    }

    return {
      saved,
      signaturesReset,
      approvalReset,
    };
  }

  async create(createRdoDto: CreateRdoDto): Promise<Rdo> {
    const companyId = this.resolveCompanyIdForCreate();
    const normalizedPayload = this.normalizeRdoPayload(createRdoDto);
    await this.validateRelatedEntityScope({
      companyId,
      siteId: normalizedPayload.site_id,
      responsavelId: normalizedPayload.responsavel_id,
    });

    let saved: Rdo | null = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const numero = await this.generateNumero(companyId);
      const rdo = this.rdosRepository.create({
        ...normalizedPayload,
        company_id: companyId,
        status: this.resolveStatusForCreate(createRdoDto.status),
        numero,
      });
      this.assertRdoBusinessRules(rdo);

      try {
        saved = await this.rdosRepository.save(rdo);
        break;
      } catch (error) {
        if (this.isDuplicateNumeroError(error) && attempt < 3) {
          this.logger.warn({
            event: 'rdo_create_duplicate_numero_retry',
            companyId,
            attempt,
          });
          continue;
        }

        if (this.isDuplicateNumeroError(error)) {
          throw new BadRequestException(
            'Já existe um RDO com este número na empresa atual.',
          );
        }

        throw error;
      }
    }

    if (!saved) {
      throw new BadRequestException(
        'Não foi possível gerar um número único para o RDO.',
      );
    }

    this.logRdoEvent('rdo_created', saved);
    await this.rdoAuditService.recordEvent(saved.id, 'CREATED', {
      numero: saved.numero,
      status: saved.status,
      siteId: saved.site_id ?? null,
      responsavelId: saved.responsavel_id ?? null,
    });
    return saved;
  }

  async findPaginated(opts?: FindRdosQueryDto): Promise<OffsetPage<Rdo>> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });
    const search = normalizeOptionalSearchQuery(opts?.search);

    this.assertFindPaginatedFilters(opts);

    if (
      opts?.data_inicio &&
      opts?.data_fim &&
      opts.data_inicio > opts.data_fim
    ) {
      throw new BadRequestException(
        'O período informado para consulta de RDO é inválido.',
      );
    }

    const idsQuery = this.rdosRepository
      .createQueryBuilder('rdo')
      .select('rdo.id', 'id')
      .orderBy('rdo.data', 'DESC')
      .addOrderBy('rdo.created_at', 'DESC')
      .addOrderBy('rdo.id', 'DESC')
      .skip(skip)
      .take(limit);
    const countQuery = this.rdosRepository.createQueryBuilder('rdo');

    if (search) {
      idsQuery
        .leftJoin('rdo.site', 'site')
        .leftJoin('rdo.responsavel', 'responsavel');
      countQuery
        .leftJoin('rdo.site', 'site')
        .leftJoin('rdo.responsavel', 'responsavel');
    }

    this.applyFindPaginatedFilters(idsQuery, companyId, opts);
    this.applyFindPaginatedFilters(countQuery, companyId, opts);

    if (!isSuperAdmin && siteScope !== 'all') {
      idsQuery.andWhere('rdo.site_id IN (:...siteIds)', { siteIds });
      countQuery.andWhere('rdo.site_id IN (:...siteIds)', { siteIds });
    } else if (opts?.site_id) {
      idsQuery.andWhere('rdo.site_id = :siteId', { siteId: opts.site_id });
      countQuery.andWhere('rdo.site_id = :siteId', { siteId: opts.site_id });
    }

    const [rows, total] = await Promise.all([
      idsQuery.getRawMany<{ id: string }>(),
      countQuery.getCount(),
    ]);

    const ids = rows.map((row) => row.id).filter(Boolean);
    if (ids.length === 0) {
      return toOffsetPage([], total, page, limit);
    }

    const data = await this.rdosRepository.find({
      where: ids.map((id) => ({ id, company_id: companyId })),
      relations: ['site', 'responsavel'],
    });
    const dataById = new Map(data.map((item) => [item.id, item]));
    const ordered = ids
      .map((id) => dataById.get(id))
      .filter((item): item is Rdo => Boolean(item));

    return toOffsetPage(ordered, total, page, limit);
  }

  async findOne(id: string): Promise<Rdo> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    const rdo = await this.rdosRepository.findOne({
      where: { id, company_id: companyId },
      relations: ['site', 'responsavel', 'company'],
    });
    if (!rdo) {
      throw new NotFoundException(`RDO com ID ${id} não encontrado`);
    }

    if (
      !isSuperAdmin &&
      siteScope !== 'all' &&
      (!rdo.site_id || !siteIds.includes(rdo.site_id))
    ) {
      throw new NotFoundException(`RDO com ID ${id} não encontrado`);
    }

    return rdo;
  }

  async update(id: string, updateRdoDto: UpdateRdoDto): Promise<Rdo> {
    const rdo = await this.findOne(id);
    await this.assertRdoDocumentMutable(rdo);
    this.assertRdoNotCancelled(rdo, 'editado');
    const normalizedPayload = this.normalizeRdoPayload(updateRdoDto);
    if ('status' in updateRdoDto && updateRdoDto.status !== undefined) {
      throw new BadRequestException(
        'Use PATCH /rdos/:id/status para alterar o status do RDO.',
      );
    }
    if (
      updateRdoDto.company_id !== undefined &&
      updateRdoDto.company_id !== rdo.company_id
    ) {
      throw new BadRequestException(
        'O company_id do RDO não pode ser alterado pelo endpoint genérico.',
      );
    }

    await this.validateRelatedEntityScope({
      companyId: rdo.company_id,
      siteId:
        normalizedPayload.site_id !== undefined
          ? normalizedPayload.site_id
          : rdo.site_id,
      responsavelId:
        normalizedPayload.responsavel_id !== undefined
          ? normalizedPayload.responsavel_id
          : rdo.responsavel_id,
    });

    const previousSnapshot = this.buildSnapshotHash(rdo);
    const previousStatus = rdo.status;
    const hadSignatures = Boolean(
      rdo.assinatura_responsavel || rdo.assinatura_engenheiro,
    );
    const previousActivityPhotoPayloads =
      this.collectGovernedActivityPhotoPayloads(rdo);
    Object.assign(rdo, { ...normalizedPayload, company_id: rdo.company_id });
    const {
      saved,
      signaturesReset: _signaturesReset,
      approvalReset: _approvalReset,
    } = await this.persistContentMutation(rdo, {
      previousSnapshot,
      previousStatus,
      hadSignaturesBeforeChange: hadSignatures,
      auditEventType: 'UPDATED',
      auditDetails: {
        siteId: rdo.site_id ?? null,
        responsavelId: rdo.responsavel_id ?? null,
      },
    });

    const currentActivityPhotoKeys = new Set(
      this.collectGovernedActivityPhotoPayloads(saved).map(
        (payload) => payload.fileKey,
      ),
    );
    const removedActivityPhotoPayloads = previousActivityPhotoPayloads.filter(
      (payload) => !currentActivityPhotoKeys.has(payload.fileKey),
    );

    await Promise.all(
      removedActivityPhotoPayloads.map((payload) =>
        this.documentStorageService
          .deleteFile(payload.fileKey)
          .catch((error) => {
            this.logger.warn({
              event: 'rdo_activity_photo_cleanup_failed_after_update',
              rdoId: saved.id,
              fileKey: payload.fileKey,
              message: error instanceof Error ? error.message : String(error),
            });
          }),
      ),
    );
    this.logRdoEvent('rdo_updated', saved);
    return saved;
  }

  async updateStatus(id: string, newStatus: string): Promise<Rdo> {
    const rdo = await this.findOne(id);
    await this.assertRdoDocumentMutable(rdo);
    this.assertRdoNotCancelled(rdo, 'movimentado');
    const allowed = ALLOWED_STATUS_TRANSITIONS[rdo.status] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(
        `Transição de "${rdo.status}" para "${newStatus}" não permitida`,
      );
    }
    if (newStatus === 'aprovado') {
      this.assertRdoSignaturesComplete(rdo);
    }
    const previousStatus = rdo.status;
    rdo.status = newStatus;
    const signaturesReset =
      newStatus === 'rascunho'
        ? this.resetSignatures(rdo, 'returned_to_draft')
        : false;
    const saved = await this.rdosRepository.save(rdo);
    this.logRdoEvent('rdo_status_changed', saved, {
      previousStatus,
      newStatus,
      signaturesReset,
    });

    await this.rdoAuditService.recordStatusChange(
      saved.id,
      previousStatus,
      newStatus,
    );
    if (signaturesReset) {
      await this.rdoAuditService.recordEvent(saved.id, 'SIGNATURES_RESET', {
        reason: 'returned_to_draft',
      });
    }

    return saved;
  }

  async cancel(id: string, reason: string): Promise<Rdo> {
    const rdo = await this.findOne(id);
    await this.assertRdoDocumentMutable(rdo);

    if (!CANCELABLE_STATUSES.has(rdo.status)) {
      throw new BadRequestException(
        `Transição de "${rdo.status}" para "cancelado" não permitida.`,
      );
    }

    const previousStatus = rdo.status;
    rdo.status = 'cancelado';
    const saved = await this.rdosRepository.manager.transaction(
      async (manager) => {
        const transactionalRepository = manager.getRepository(Rdo);
        const persisted = await transactionalRepository.save(rdo);
        await this.forensicTrailService.append(
          {
            eventType: FORENSIC_EVENT_TYPES.DOCUMENT_CANCELED,
            module: 'rdo',
            entityId: persisted.id,
            companyId: persisted.company_id,
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

    this.logRdoEvent('rdo_canceled', saved, { reason });
    await this.rdoAuditService.recordCancellation(
      saved.id,
      reason,
      previousStatus,
    );

    return saved;
  }

  async getAuditTrail(id: string) {
    await this.findOne(id); // Garante a validação de existência e o escopo do Tenant atual
    const events = await this.rdoAuditService.getEventsForRdo(id);

    const EVENT_LABELS: Record<string, string> = {
      CREATED: 'Criado',
      UPDATED: 'Atualizado',
      CANCELED: 'Cancelado',
      STATUS_CHANGED: 'Status Alterado',
      PDF_GENERATED: 'PDF Gerado',
      SIGNED: 'Assinado',
      EMAIL_SENT: 'E-mail enviado',
      REMOVED: 'Removido',
      SIGNATURES_RESET: 'Assinaturas invalidadas',
      LEGACY_SAVE_PDF_ATTEMPT: 'Tentativa em endpoint legado',
      ACTIVITY_PHOTO_UPLOADED: 'Foto da atividade anexada',
      ACTIVITY_PHOTO_REMOVED: 'Foto da atividade removida',
    };

    return events.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      eventLabel: EVENT_LABELS[event.event_type] || event.event_type,
      userId: event.user_id,
      createdAt: event.created_at,
      details: event.details || {},
    }));
  }

  async sign(
    id: string,
    body: {
      tipo: 'responsavel' | 'engenheiro';
      nome: string;
      cpf: string;
    },
    authenticatedUserId?: string,
  ): Promise<Rdo> {
    const rdo = await this.findOne(id);
    await this.assertRdoDocumentMutable(rdo);
    this.assertRdoNotCancelled(rdo, 'assinado');

    if (rdo.status === 'rascunho') {
      throw new BadRequestException(
        'Envie o RDO para revisão antes de coletar assinaturas.',
      );
    }

    const signedAtIso = new Date().toISOString();
    const canonicalPayload = this.buildOperationalSignatureCanonicalPayload({
      rdo,
      signerType: body.tipo,
      signerName: body.nome.trim(),
      signerCpf: body.cpf.trim(),
      signedAt: signedAtIso,
      actorUserId: authenticatedUserId,
    });
    const documentHash = this.buildSnapshotHash(rdo);
    const signatureHash = hashCanonicalSignaturePayload(canonicalPayload);
    const generatedStamp = this.signatureTimestampService.issueFromHash(
      signatureHash,
      signedAtIso,
    );
    const signaturePayload: RdoOperationalSignature = {
      nome: body.nome.trim(),
      cpf: body.cpf.trim(),
      signed_at: generatedStamp.timestamp_issued_at,
      signature_mode: 'operational_ack',
      verification_mode: SIGNATURE_VERIFICATION_MODES.OPERATIONAL_ACK,
      legal_assurance: SIGNATURE_LEGAL_ASSURANCE.NOT_LEGAL_STRONG,
      verification_scope: 'document_integrity_snapshot',
      document_hash_algorithm: 'sha256',
      document_hash: documentHash,
      signature_hash_algorithm: 'sha256',
      signature_hash: generatedStamp.signature_hash,
      timestamp_token: generatedStamp.timestamp_token,
      timestamp_authority: generatedStamp.timestamp_authority,
      canonical_payload_version: 1,
    };

    const sigData = JSON.stringify(signaturePayload);

    if (body.tipo === 'responsavel') {
      rdo.assinatura_responsavel = sigData;
    } else {
      rdo.assinatura_engenheiro = sigData;
    }

    const saved = await this.rdosRepository.manager.transaction(
      async (manager) => {
        const transactionalRepository = manager.getRepository(Rdo);
        const persisted = await transactionalRepository.save(rdo);
        await this.forensicTrailService.append(
          {
            eventType: FORENSIC_EVENT_TYPES.SIGNATURE_RECORDED,
            module: 'rdo',
            entityId: persisted.id,
            companyId: persisted.company_id,
            userId: authenticatedUserId || null,
            occurredAt: new Date(signaturePayload.signed_at),
            metadata: {
              signatureType: body.tipo,
              verificationMode: signaturePayload.verification_mode,
              signatureMode: signaturePayload.signature_mode,
              signerName: signaturePayload.nome,
              signerCpfSuffix: signaturePayload.cpf.slice(-4),
              documentHash: signaturePayload.document_hash,
              signatureHash: signaturePayload.signature_hash,
              timestampAuthority: signaturePayload.timestamp_authority,
            },
          },
          { manager },
        );
        return persisted;
      },
    );
    this.logRdoEvent('rdo_signed', saved, {
      signatureType: body.tipo,
      verificationMode: signaturePayload.verification_mode,
      signatureMode: signaturePayload.signature_mode,
      documentHash: signaturePayload.document_hash,
      signatureHash: signaturePayload.signature_hash,
    });

    await this.rdoAuditService.recordSignature(saved.id, body.tipo, body.nome);

    return saved;
  }

  async savePdf(
    id: string,
    file: Express.Multer.File,
  ): Promise<{ fileKey: string; folderPath: string; originalName: string }> {
    const rdo = await this.findOne(id);
    await this.assertRdoDocumentMutable(rdo);
    this.assertRdoReadyForFinalDocument(rdo);

    const documentDate = this.getRdoDocumentDate(rdo);
    const year = documentDate.getFullYear();
    const weekNumber = String(this.getIsoWeekNumber(documentDate)).padStart(
      2,
      '0',
    );
    const originalName =
      file.originalname?.trim() || `${rdo.numero || `rdo-${rdo.id}`}.pdf`;
    const fileKey = this.documentStorageService.generateDocumentKey(
      rdo.company_id,
      'rdos',
      rdo.id,
      originalName,
      {
        folderSegments: [
          ...(rdo.site_id ? ['sites', rdo.site_id] : []),
          String(year),
          `week-${weekNumber}`,
        ],
      },
    );
    const folderPath = fileKey.split('/').slice(0, -1).join('/');

    await this.documentStorageService.uploadFile(
      fileKey,
      file.buffer,
      file.mimetype,
    );

    try {
      await this.documentGovernanceService.registerFinalDocument({
        companyId: rdo.company_id,
        module: 'rdo',
        entityId: rdo.id,
        title: this.buildRdoTitle(rdo),
        documentDate,
        documentCode: this.buildValidationCode(rdo),
        fileKey,
        folderPath,
        originalName,
        mimeType: file.mimetype,
        fileBuffer: file.buffer,
        persistEntityMetadata: async (manager) => {
          await manager.getRepository(Rdo).update(
            { id: rdo.id },
            {
              pdf_file_key: fileKey,
              pdf_folder_path: folderPath,
              pdf_original_name: originalName,
            },
          );
        },
      });
    } catch (error) {
      await cleanupUploadedFile(this.logger, `rdo:${rdo.id}`, fileKey, (key) =>
        this.documentStorageService.deleteFile(key),
      );
      throw error;
    }

    this.logRdoEvent('rdo_pdf_uploaded', rdo, {
      fileKey,
      folderPath,
      originalName,
    });

    await this.rdoAuditService.recordPdfGenerated(
      rdo.id,
      fileKey,
      originalName,
    );

    return {
      fileKey,
      folderPath,
      originalName,
    };
  }

  async attachActivityPhoto(
    id: string,
    activityIndex: number,
    buffer: Buffer,
    originalName: string,
    mimeType: string,
  ): Promise<RdoActivityPhotoAttachResponse> {
    const rdo = await this.findOne(id);
    await this.assertRdoActivityPhotoMutable(rdo);

    const sanitizedOriginalName =
      originalName?.trim() || `atividade-${activityIndex + 1}.jpg`;
    const fileKey = this.documentStorageService.generateDocumentKey(
      rdo.company_id,
      'rdo-activity-photos',
      rdo.id,
      sanitizedOriginalName,
    );

    await this.documentStorageService.uploadFile(fileKey, buffer, mimeType);

    try {
      const photoReference = this.buildGovernedActivityPhotoReference({
        v: 1,
        kind: 'governed-storage',
        scope: 'activity',
        fileKey,
        originalName: sanitizedOriginalName,
        mimeType,
        uploadedAt: new Date().toISOString(),
        sizeBytes: buffer.byteLength,
      });

      // Append atômico: re-lê a linha sob lock para não perder fotos gravadas
      // por uploads concorrentes na mesma atividade (read-modify-write do jsonb).
      const {
        saved,
        signaturesReset,
        approvalReset,
        photoIndex,
        previousStatus,
      } = await this.mutateRdoContentLocked(
        id,
        rdo.company_id,
        async (lockedRdo, manager) => {
          if (lockedRdo.pdf_file_key) {
            throw new BadRequestException(
              'RDO com PDF final emitido está bloqueado para edição.',
            );
          }
          if (
            lockedRdo.status === 'aprovado' ||
            lockedRdo.status === 'cancelado'
          ) {
            throw new BadRequestException(
              'RDO aprovado ou cancelado não aceita novas fotos nas atividades pelo fluxo comum.',
            );
          }

          const activities = this.cloneServicos(lockedRdo.servicos_executados);
          const targetActivity = this.getActivityOrThrow(
            { servicos_executados: activities },
            activityIndex,
          );
          const currentPhotos = [...(targetActivity.fotos ?? [])];

          if (currentPhotos.length >= RDO_ACTIVITY_PHOTO_MAX_PER_ACTIVITY) {
            throw new BadRequestException(
              `Cada atividade aceita no máximo ${RDO_ACTIVITY_PHOTO_MAX_PER_ACTIVITY} fotos.`,
            );
          }

          currentPhotos.push(photoReference);
          targetActivity.fotos = currentPhotos;

          const previousSnapshot = this.buildSnapshotHash(lockedRdo);
          const prevStatus = lockedRdo.status;
          const hadSignaturesBeforeChange = Boolean(
            lockedRdo.assinatura_responsavel || lockedRdo.assinatura_engenheiro,
          );
          lockedRdo.servicos_executados = activities;

          this.assertRdoBusinessRules(lockedRdo);
          const nextSnapshot = this.buildSnapshotHash(lockedRdo);
          const contentChanged = previousSnapshot !== nextSnapshot;
          const signaturesReset =
            hadSignaturesBeforeChange && contentChanged
              ? this.resetSignatures(lockedRdo, 'content_changed')
              : false;
          const approvalReset = contentChanged && prevStatus === 'aprovado';
          if (approvalReset) {
            lockedRdo.status = 'enviado';
          }

          const saved = await manager.getRepository(Rdo).save(lockedRdo);
          return {
            saved,
            signaturesReset,
            approvalReset,
            photoIndex: currentPhotos.length - 1,
            previousStatus: prevStatus,
          };
        },
      );

      await this.rdoAuditService.recordEvent(
        saved.id,
        'ACTIVITY_PHOTO_UPLOADED',
        {
          signaturesReset,
          previousStatus,
          currentStatus: saved.status,
          approvalReset,
          activityIndex,
          photoIndex,
          fileKey,
          originalName: sanitizedOriginalName,
          mimeType,
        },
      );

      if (signaturesReset) {
        await this.rdoAuditService.recordEvent(saved.id, 'SIGNATURES_RESET', {
          reason: 'content_changed',
        });
      }

      this.logRdoEvent('rdo_activity_photo_uploaded', saved, {
        activityIndex,
        photoIndex,
        fileKey,
        mimeType,
        signaturesReset,
      });

      return {
        entityId: saved.id,
        activityIndex,
        photoIndex,
        storageMode: 'governed-storage',
        message: 'Foto da atividade anexada ao RDO com governança.',
        photoReference,
        photo: {
          fileKey,
          originalName: sanitizedOriginalName,
          mimeType,
        },
        signaturesReset,
      };
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `rdos.attachActivityPhoto:${rdo.id}`,
        fileKey,
        (key) => this.documentStorageService.deleteFile(key),
      );
      throw error;
    }
  }

  async getActivityPhotoAccess(
    id: string,
    activityIndex: number,
    photoIndex: number,
  ): Promise<RdoActivityPhotoAccessResponse> {
    const rdo = await this.findOne(id);
    const activity = this.getActivityOrThrow(rdo, activityIndex);
    const photoReference = Array.isArray(activity.fotos)
      ? activity.fotos[photoIndex]
      : undefined;
    const payload = this.parseGovernedActivityPhotoReference(photoReference);

    if (!payload) {
      throw new NotFoundException(
        'A foto da atividade não está em armazenamento governado.',
      );
    }

    let url: string | null = null;
    let availability: RdoActivityPhotoAccessAvailability = 'ready';
    let message: string | null = null;
    try {
      url = await this.documentStorageService.getSignedUrl(
        payload.fileKey,
        3600,
      );
    } catch {
      availability = 'registered_without_signed_url';
      message =
        'A foto da atividade foi localizada, mas a URL assinada não está disponível no momento.';
    }

    this.logRdoEvent('rdo_activity_photo_accessed', rdo, {
      activityIndex,
      photoIndex,
      availability,
      fileKey: payload.fileKey,
    });

    return {
      entityId: rdo.id,
      activityIndex,
      photoIndex,
      hasGovernedPhoto: true,
      availability,
      fileKey: payload.fileKey,
      originalName: payload.originalName,
      mimeType: payload.mimeType,
      url,
      message,
    };
  }

  async removeActivityPhoto(
    id: string,
    activityIndex: number,
    photoIndex: number,
  ): Promise<RdoActivityPhotoRemovalResponse> {
    const rdo = await this.findOne(id);
    await this.assertRdoActivityPhotoMutable(rdo);

    // Remoção atômica: re-lê a linha sob lock para não perder fotos gravadas
    // por uploads concorrentes desde a leitura inicial (read-modify-write do jsonb).
    const {
      saved,
      signaturesReset,
      approvalReset,
      removedPayload,
      previousStatus,
    } = await this.mutateRdoContentLocked(
      id,
      rdo.company_id,
      async (lockedRdo, manager) => {
        if (lockedRdo.pdf_file_key) {
          throw new BadRequestException(
            'RDO com PDF final emitido está bloqueado para edição.',
          );
        }
        if (
          lockedRdo.status === 'aprovado' ||
          lockedRdo.status === 'cancelado'
        ) {
          throw new BadRequestException(
            'RDO aprovado ou cancelado não aceita remoção de fotos pelo fluxo comum.',
          );
        }

        const activities = this.cloneServicos(lockedRdo.servicos_executados);
        const targetActivity = this.getActivityOrThrow(
          { servicos_executados: activities },
          activityIndex,
        );
        const currentPhotos = [...(targetActivity.fotos ?? [])];
        const removedReference = currentPhotos[photoIndex];
        const payload =
          this.parseGovernedActivityPhotoReference(removedReference);

        if (!payload) {
          throw new NotFoundException(
            'A foto da atividade não está em armazenamento governado.',
          );
        }

        currentPhotos.splice(photoIndex, 1);
        targetActivity.fotos = currentPhotos;

        const previousSnapshot = this.buildSnapshotHash(lockedRdo);
        const prevStatus = lockedRdo.status;
        const hadSignaturesBeforeChange = Boolean(
          lockedRdo.assinatura_responsavel || lockedRdo.assinatura_engenheiro,
        );
        lockedRdo.servicos_executados = activities;

        this.assertRdoBusinessRules(lockedRdo);
        const nextSnapshot = this.buildSnapshotHash(lockedRdo);
        const contentChanged = previousSnapshot !== nextSnapshot;
        const signaturesReset =
          hadSignaturesBeforeChange && contentChanged
            ? this.resetSignatures(lockedRdo, 'content_changed')
            : false;
        const approvalReset = contentChanged && prevStatus === 'aprovado';
        if (approvalReset) {
          lockedRdo.status = 'enviado';
        }

        const saved = await manager.getRepository(Rdo).save(lockedRdo);
        return {
          saved,
          signaturesReset,
          approvalReset,
          removedPayload: payload,
          previousStatus: prevStatus,
        };
      },
    );

    await this.documentStorageService
      .deleteFile(removedPayload.fileKey)
      .catch((error) => {
        this.logger.warn({
          event: 'rdo_activity_photo_cleanup_failed',
          rdoId: saved.id,
          activityIndex,
          photoIndex,
          fileKey: removedPayload.fileKey,
          message: error instanceof Error ? error.message : String(error),
        });
      });

    await this.rdoAuditService.recordEvent(saved.id, 'ACTIVITY_PHOTO_REMOVED', {
      signaturesReset,
      previousStatus,
      currentStatus: saved.status,
      approvalReset,
      activityIndex,
      photoIndex,
      removedFileKey: removedPayload.fileKey,
    });

    if (signaturesReset) {
      await this.rdoAuditService.recordEvent(saved.id, 'SIGNATURES_RESET', {
        reason: 'content_changed',
      });
    }

    this.logRdoEvent('rdo_activity_photo_removed', saved, {
      activityIndex,
      photoIndex,
      removedFileKey: removedPayload.fileKey,
      signaturesReset,
    });

    return {
      entityId: saved.id,
      activityIndex,
      photoIndex,
      removed: true,
      removedFileKey: removedPayload.fileKey,
      signaturesReset,
    };
  }

  async listVideoAttachments(id: string) {
    const rdo = await this.findOne(id);
    return this.documentVideosService.listByDocument({
      companyId: rdo.company_id,
      module: 'rdo',
      documentId: rdo.id,
    });
  }

  async uploadVideoAttachment(
    id: string,
    buffer: Buffer,
    originalName: string,
    mimeType: string,
  ) {
    const rdo = await this.findOne(id);
    await this.assertRdoVideoMutable(rdo);
    const result = await this.documentVideosService.uploadForDocument({
      companyId: rdo.company_id,
      module: 'rdo',
      documentId: rdo.id,
      buffer,
      originalName,
      mimeType,
      uploadedById: RequestContext.getUserId() || undefined,
    });
    this.logRdoEvent('rdo_video_attachment_uploaded', rdo, {
      attachmentId: result.attachment.id,
      mimeType: result.attachment.mime_type,
      storageKey: result.attachment.storage_key,
    });
    return result;
  }

  async getVideoAttachmentAccess(id: string, attachmentId: string) {
    const rdo = await this.findOne(id);
    const result = await this.documentVideosService.getAccess({
      companyId: rdo.company_id,
      module: 'rdo',
      documentId: rdo.id,
      attachmentId,
    });
    this.logRdoEvent('rdo_video_attachment_accessed', rdo, {
      attachmentId,
      availability: result.availability,
    });
    return result;
  }

  async removeVideoAttachment(id: string, attachmentId: string) {
    const rdo = await this.findOne(id);
    await this.assertRdoVideoMutable(rdo);
    const result = await this.documentVideosService.removeFromDocument({
      companyId: rdo.company_id,
      module: 'rdo',
      documentId: rdo.id,
      attachmentId,
      removedById: RequestContext.getUserId() || undefined,
    });
    this.logRdoEvent('rdo_video_attachment_removed', rdo, {
      attachmentId,
    });
    return result;
  }

  async markPdfSaved(
    id: string,
    _body?: { filename?: string },
  ): Promise<never> {
    const rdo = await this.findOne(id);
    this.logRdoEvent('rdo_legacy_save_pdf_attempt', rdo, {
      endpoint: 'POST /rdos/:id/save-pdf',
    });
    await this.rdoAuditService.recordEvent(rdo.id, 'LEGACY_SAVE_PDF_ATTEMPT', {
      endpoint: 'POST /rdos/:id/save-pdf',
      deprecated: true,
    });
    throw new GoneException(
      'O endpoint legado POST /rdos/:id/save-pdf foi descontinuado. Envie o arquivo real por POST /rdos/:id/file.',
    );
  }

  async getPdfAccess(id: string): Promise<{
    entityId: string;
    hasFinalPdf: boolean;
    availability: RdoPdfAccessAvailability;
    message: string | null;
    fileKey: string | null;
    folderPath: string | null;
    originalName: string | null;
    url: string | null;
  }> {
    const rdo = await this.findOne(id);
    const registryEntry = await this.documentRegistryService.findByDocument(
      'rdo',
      rdo.id,
      'pdf',
      rdo.company_id,
    );

    if (!registryEntry) {
      return {
        entityId: rdo.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message: 'O PDF final do RDO ainda não foi emitido.',
        fileKey: null,
        folderPath: null,
        originalName: null,
        url: null,
      };
    }

    let url: string | null;
    let availability: RdoPdfAccessAvailability = 'ready';
    let message: string | null = null;
    try {
      url = await this.documentStorageService.getSignedUrl(
        registryEntry.file_key,
        3600,
      );
    } catch {
      availability = 'registered_without_signed_url';
      message =
        'O PDF final do RDO foi emitido, mas a URL segura não está disponível agora.';
      url = null;
    }

    return {
      entityId: rdo.id,
      hasFinalPdf: true,
      availability,
      message,
      fileKey: registryEntry.file_key,
      folderPath: registryEntry.folder_path || null,
      originalName:
        registryEntry.original_name ||
        registryEntry.file_key.split('/').pop() ||
        'rdo.pdf',
      url,
    };
  }

  async downloadPdf(id: string): Promise<{
    buffer: Buffer;
    fileName: string;
  }> {
    const access = await this.getPdfAccess(id);
    if (!access.hasFinalPdf || !access.fileKey) {
      throw new BadRequestException(
        access.message ||
          'O RDO ainda não possui PDF final governado disponível.',
      );
    }

    const buffer = await this.documentStorageService.downloadFileBuffer(
      access.fileKey,
    );

    return {
      buffer,
      fileName: access.originalName || `rdo-${id}.pdf`,
    };
  }

  async sendEmail(
    id: string,
    to: string[],
  ): Promise<DocumentMailDispatchResponseDto & { recipients: number }> {
    const rdo = await this.findOne(id);
    if (!to.length) {
      return {
        success: true,
        message: 'Nenhum destinatário informado para envio do RDO.',
        deliveryMode: 'sent',
        artifactType: 'governed_final_pdf',
        isOfficial: true,
        fallbackUsed: false,
        documentId: rdo.id,
        documentType: 'RDO',
        recipients: 0,
      };
    }
    const access = await this.getPdfAccess(id);
    if (!access.hasFinalPdf) {
      this.logRdoEvent('rdo_email_blocked_without_final_pdf', rdo, {
        recipients: to.length,
      });
      await this.rdoAuditService.recordEvent(rdo.id, 'EMAIL_BLOCKED', {
        recipients: to.length,
        reason: 'missing_final_pdf',
      });
      throw new BadRequestException(
        'Emita o PDF final governado antes de enviar este RDO por e-mail.',
      );
    }

    const scope = this.getTenantContextOrThrow();
    const workerTenantContext = {
      companyId: scope.companyId,
      isSuperAdmin: scope.isSuperAdmin,
      siteScope: scope.siteScope,
      ...(scope.siteScope === 'single' ? { siteIds: scope.siteIds } : {}),
    };

    let queuedCount = 0;
    let syncFallbackUsed = false;

    for (const email of to) {
      try {
        await this.mailQueue.add(
          'send-document',
          {
            documentId: rdo.id,
            documentType: 'RDO',
            email,
            companyId: rdo.company_id,
            tenantContext: workerTenantContext,
          },
          defaultJobOptions,
        );
        queuedCount++;
      } catch (error) {
        this.logger.warn(
          `Fila de e-mail indisponível para RDO ${rdo.id}, aplicando fallback síncrono: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.mailService.sendStoredDocument(
          rdo.id,
          'RDO',
          email,
          rdo.company_id,
        );
        syncFallbackUsed = true;
      }
    }

    const deliveryMode: 'queued' | 'sent' =
      queuedCount === to.length ? 'queued' : 'sent';

    this.logRdoEvent('rdo_email_sent', rdo, {
      recipients: to.length,
      hasGovernedPdf: true,
      artifactType: 'governed_final_pdf',
      deliveryMode,
      queueFallbackUsed: syncFallbackUsed,
    });
    await this.rdoAuditService.recordEvent(rdo.id, 'EMAIL_SENT', {
      recipients: to.length,
      hasGovernedPdf: true,
      artifactType: 'governed_final_pdf',
      deliveryMode,
      queueFallbackUsed: syncFallbackUsed,
    });

    return {
      success: true,
      message:
        deliveryMode === 'queued'
          ? `O envio do RDO com o PDF final governado foi agendado para ${to.length} destinatário(s).`
          : `O RDO foi enviado com o PDF final governado para ${to.length} destinatário(s).`,
      deliveryMode,
      artifactType: 'governed_final_pdf',
      isOfficial: true,
      fallbackUsed: false,
      documentId: rdo.id,
      documentType: 'RDO',
      recipients: to.length,
    };
  }

  async listFiles(filters: WeeklyBundleFilters = {}) {
    const files = await this.documentGovernanceService.listFinalDocuments(
      'rdo',
      filters,
    );
    const allowedIds = await this.getAllowedRdoIdsForCurrentScope();
    if (!allowedIds) {
      return files;
    }

    return files.filter((file) => allowedIds.has(file.entityId));
  }

  async getWeeklyBundle(filters: WeeklyBundleFilters) {
    const files = await this.listFiles(filters);
    return this.documentBundleService.buildWeeklyPdfBundle(
      'RDO',
      filters,
      files.map((file) => ({
        fileKey: file.fileKey,
        title: file.title,
        originalName: file.originalName,
        date: file.date,
      })),
    );
  }

  async remove(id: string): Promise<void> {
    const rdo = await this.findOne(id);
    const removedRdoId = rdo.id;
    const removedCompanyId = rdo.company_id;
    const removedStatus = rdo.status;
    const hadFinalPdfBeforeRemove = Boolean(rdo.pdf_file_key);
    const activityPhotoCountBeforeRemove = this.countActivityPhotos(rdo);
    const activityPhotoPayloads =
      this.collectGovernedActivityPhotoPayloads(rdo);

    if (rdo.status === 'aprovado' || rdo.status === 'cancelado') {
      throw new BadRequestException(
        'RDOs aprovados ou cancelados não podem ser excluídos fisicamente. Utilize o cancelamento explícito.',
      );
    }

    await this.documentGovernanceService.removeFinalDocumentReference({
      companyId: removedCompanyId,
      module: 'rdo',
      entityId: removedRdoId,
      trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
      trailMetadata: {
        removalMode: 'hard_remove',
      },
      removeEntityState: async (manager) => {
        await manager.getRepository(Rdo).update(
          { id: removedRdoId },
          {
            pdf_file_key: null,
            pdf_folder_path: null,
            pdf_original_name: null,
          },
        );
      },
      cleanupStoredFile: (fileKey) =>
        this.documentStorageService.deleteFile(fileKey),
    });
    await this.rdosRepository.remove(rdo);
    await Promise.all(
      activityPhotoPayloads.map((payload) =>
        this.documentStorageService
          .deleteFile(payload.fileKey)
          .catch((error) => {
            this.logger.warn({
              event: 'rdo_activity_photo_cleanup_failed_on_remove',
              rdoId: removedRdoId,
              fileKey: payload.fileKey,
              message: error instanceof Error ? error.message : String(error),
            });
          }),
      ),
    );
    await this.forensicTrailService
      .append({
        eventType: FORENSIC_EVENT_TYPES.DOCUMENT_HARD_REMOVED,
        module: 'rdo',
        entityId: removedRdoId,
        companyId: removedCompanyId,
        metadata: {
          status: removedStatus,
          hadFinalPdf: hadFinalPdfBeforeRemove,
          activityPhotoCount: activityPhotoCountBeforeRemove,
        },
      })
      .catch((error) => {
        this.logger.warn({
          event: 'rdo_hard_remove_forensic_append_failed',
          rdoId: removedRdoId,
          companyId: removedCompanyId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    this.logRdoEvent('rdo_removed', {
      id: removedRdoId,
      company_id: removedCompanyId,
      status: removedStatus,
      site_id: rdo.site_id,
      responsavel_id: rdo.responsavel_id,
      pdf_file_key: null,
    });
  }

  async getAnalyticsOverview(): Promise<{
    totalRdos: number;
    rascunho: number;
    enviado: number;
    aprovado: number;
    cancelado: number;
  }> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    const qb = this.rdosRepository
      .createQueryBuilder('rdo')
      .select('COUNT(*)::int', 'totalRdos')
      .addSelect(
        `COUNT(*) FILTER (WHERE rdo.status = 'rascunho')::int`,
        'rascunho',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE rdo.status = 'enviado')::int`,
        'enviado',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE rdo.status = 'aprovado')::int`,
        'aprovado',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE rdo.status = 'cancelado')::int`,
        'cancelado',
      );

    if (companyId) {
      qb.where('rdo.company_id = :companyId', { companyId });
    }
    qb.andWhere('rdo.deleted_at IS NULL');
    if (!isSuperAdmin && siteScope !== 'all') {
      qb.andWhere('rdo.site_id IN (:...siteIds)', { siteIds });
    }

    const aggregates = await qb.getRawOne<{
      totalRdos?: number | string;
      rascunho?: number | string;
      enviado?: number | string;
      aprovado?: number | string;
      cancelado?: number | string;
    }>();

    return {
      totalRdos: Number(aggregates?.totalRdos ?? 0),
      rascunho: Number(aggregates?.rascunho ?? 0),
      enviado: Number(aggregates?.enviado ?? 0),
      aprovado: Number(aggregates?.aprovado ?? 0),
      cancelado: Number(aggregates?.cancelado ?? 0),
    };
  }

  async exportExcel(): Promise<Buffer> {
    const { companyId, siteIds, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    const qb = this.rdosRepository
      .createQueryBuilder('rdo')
      .leftJoinAndSelect('rdo.site', 'site')
      .leftJoinAndSelect('rdo.responsavel', 'responsavel')
      .orderBy('rdo.data', 'DESC');

    if (companyId) {
      qb.where('rdo.company_id = :companyId', { companyId });
    }
    qb.andWhere('rdo.deleted_at IS NULL');
    if (!isSuperAdmin && siteScope !== 'all') {
      qb.andWhere('rdo.site_id IN (:...siteIds)', { siteIds });
    }

    const rdos = await qb.getMany();

    const rows = rdos.map((r) => {
      const totalTrab = (r.mao_de_obra ?? []).reduce(
        (s, m) => s + (m.quantidade ?? 0),
        0,
      );
      return {
        Número: r.numero,
        Data: new Date(r.data).toLocaleDateString('pt-BR'),
        'Obra/Setor': r.site?.nome ?? '',
        Responsável: r.responsavel?.nome ?? '',
        Status: r.status,
        'Total Trabalhadores': totalTrab,
        Equipamentos: (r.equipamentos ?? []).length,
        Materiais: (r.materiais_recebidos ?? []).length,
        'Serviços Exec.': (r.servicos_executados ?? []).length,
        'Fotos Atividades': this.countActivityPhotos(r),
        Ocorrências: (r.ocorrencias ?? []).length,
        'Clima Manhã': r.clima_manha
          ? (CLIMA_LABEL[r.clima_manha] ?? r.clima_manha)
          : '',
        'Clima Tarde': r.clima_tarde
          ? (CLIMA_LABEL[r.clima_tarde] ?? r.clima_tarde)
          : '',
        'Temp. Mín (°C)': r.temperatura_min ?? '',
        'Temp. Máx (°C)': r.temperatura_max ?? '',
        'Condição Terreno': r.condicao_terreno ?? '',
        'Houve Acidente': r.houve_acidente ? 'Sim' : 'Não',
        'Houve Paralisação': r.houve_paralisacao ? 'Sim' : 'Não',
        'Motivo Paralisação': r.motivo_paralisacao ?? '',
        'Tem PDF': r.pdf_file_key ? 'Sim' : 'Não',
        'Assinado Responsável': r.assinatura_responsavel ? 'Sim' : 'Não',
        'Assinado Engenheiro': r.assinatura_engenheiro ? 'Sim' : 'Não',
        Observações: r.observacoes ?? '',
        'Programa Amanhã': r.programa_servicos_amanha ?? '',
      };
    });

    return jsonToExcelBuffer(rows, 'RDOs');
  }

  private getRdoDocumentDate(rdo: Pick<Rdo, 'data' | 'created_at'>): Date {
    const dateValue = rdo.data as Date | string | null | undefined;

    if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
      const looksLikeDateColumn =
        dateValue.getUTCHours() === 0 &&
        dateValue.getUTCMinutes() === 0 &&
        dateValue.getUTCSeconds() === 0 &&
        dateValue.getUTCMilliseconds() === 0;

      if (looksLikeDateColumn) {
        return new Date(
          dateValue.getUTCFullYear(),
          dateValue.getUTCMonth(),
          dateValue.getUTCDate(),
        );
      }

      return new Date(dateValue.getTime());
    }

    if (typeof dateValue === 'string') {
      const dateOnlyMatch = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateOnlyMatch) {
        const [, year, month, day] = dateOnlyMatch;
        return new Date(Number(year), Number(month) - 1, Number(day));
      }

      const parsed = new Date(dateValue);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    const createdAt = new Date(rdo.created_at);
    return Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;
  }

  private buildRdoTitle(
    rdo: Pick<Rdo, 'numero'> & { site?: { nome?: string } | null },
  ): string {
    return rdo.site?.nome ? `${rdo.numero} - ${rdo.site.nome}` : rdo.numero;
  }

  private buildValidationCode(rdo: Pick<Rdo, 'id' | 'data' | 'created_at'>) {
    const documentDate = this.getRdoDocumentDate(rdo);
    return `RDO-${this.getIsoYear(documentDate)}-${String(
      this.getIsoWeekNumber(documentDate),
    ).padStart(2, '0')}-${rdo.id.slice(0, 8).toUpperCase()}`;
  }

  private getIsoYear(date: Date): number {
    const target = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
    );
    target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
    return target.getUTCFullYear();
  }

  private getIsoWeekNumber(date: Date): number {
    const target = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
    );
    target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    return Math.ceil(
      ((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
  }

  private assertRdoSignaturesComplete(
    rdo: Pick<Rdo, 'assinatura_responsavel' | 'assinatura_engenheiro'>,
  ) {
    if (!rdo.assinatura_responsavel || !rdo.assinatura_engenheiro) {
      throw new BadRequestException(
        'Assinaturas do responsável e do engenheiro são obrigatórias antes da emissão final do RDO.',
      );
    }
  }

  private assertRdoReadyForFinalDocument(
    rdo: Pick<
      Rdo,
      'status' | 'assinatura_responsavel' | 'assinatura_engenheiro'
    >,
  ) {
    if (rdo.status !== 'aprovado') {
      throw new BadRequestException(
        'Somente RDO aprovado pode receber PDF final governado.',
      );
    }

    this.assertRdoSignaturesComplete(rdo);
  }

  private async assertRdoDocumentMutable(
    rdo: Pick<Rdo, 'id' | 'company_id'>,
  ): Promise<void> {
    const registryEntry = await this.documentRegistryService.findByDocument(
      'rdo',
      rdo.id,
      'pdf',
      rdo.company_id,
    );

    if (registryEntry) {
      throw new BadRequestException(
        'RDO com PDF final emitido está bloqueado para edição. Gere um novo documento para alterar o conteúdo.',
      );
    }
  }

  private async assertRdoVideoMutable(
    rdo: Pick<Rdo, 'id' | 'company_id' | 'status'>,
  ): Promise<void> {
    await this.assertRdoDocumentMutable(rdo);

    if (rdo.status === 'aprovado' || rdo.status === 'cancelado') {
      throw new BadRequestException(
        'RDO aprovado ou cancelado não aceita novos vídeos por fluxo comum.',
      );
    }
  }

  private async assertRdoActivityPhotoMutable(
    rdo: Pick<Rdo, 'id' | 'company_id' | 'status'>,
  ): Promise<void> {
    await this.assertRdoDocumentMutable(rdo);

    if (rdo.status === 'aprovado' || rdo.status === 'cancelado') {
      throw new BadRequestException(
        'RDO aprovado ou cancelado não aceita novas fotos nas atividades pelo fluxo comum.',
      );
    }
  }
}
