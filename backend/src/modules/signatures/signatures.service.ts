import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import {
  type EntityManager,
  type EntityTarget,
  DataSource,
  In,
  IsNull,
  Repository,
} from 'typeorm';
import { SignatureTimestampService } from '../../shared/services/signature-timestamp.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import {
  isSiteVisibleToScope,
  resolveSiteAccessScopeFromTenantService,
} from '../../shared/tenant/site-access-scope.util';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { Role } from '../auth/enums/roles.enum';
import { resolveRegistryModuleForSignatureDocumentType } from '../document-registry/document-governance.service';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { Signature } from './entities/signature.entity';
import { CreateSignatureDto } from './dto/create-signature.dto';
import { StorageService } from '../../shared/services/storage.service';
import { cleanupUploadedFile } from '../../shared/storage/storage-compensation.util';
import { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import { Apr, AprStatus } from '../aprs/entities/apr.entity';
import { AprRiskEvidence } from '../aprs/entities/apr-risk-evidence.entity';
import {
  APR_CONTENT_CANONICALIZATION_VERSION,
  APR_CONTENT_HASH_ALGORITHM,
  APR_CONTENT_INTEGRITY_SCHEME,
  buildAprSignableContentV1,
  hashAprSignableContentV1,
} from '../aprs/apr-integrity.util';
import { Pt } from '../pts/entities/pt.entity';
import { Dds } from '../dds/entities/dds.entity';
import { Checklist } from '../checklists/entities/checklist.entity';
import { Inspection } from '../../shared/entities/inspection.entity';
import { Cat } from '../cats/entities/cat.entity';
import { NonConformity } from '../nonconformities/entities/nonconformity.entity';
import { Audit } from '../audits/entities/audit.entity';
import { Rdo } from '../rdos/entities/rdo.entity';
import { Arr } from '../arrs/entities/arr.entity';
import { Did } from '../dids/entities/did.entity';
import { Training } from '../trainings/entities/training.entity';
import { PhotographicReport } from '../photographic-reports/entities/photographic-report.entity';
import {
  LEGACY_SIGNATURE_TYPES,
  SIGNATURE_LEGAL_ASSURANCE,
  SIGNATURE_PROOF_SCOPES,
  SIGNATURE_TYPE_VALUES,
  SIGNATURE_VERIFICATION_MODES,
  canonicalizeSignaturePayload,
  hashCanonicalSignaturePayload,
  hashSignatureEvidence,
  isAcceptedSignatureType,
} from './signature-proof.util';

type SignatureWriteInput = Omit<CreateSignatureDto, 'company_id'> & {
  company_id?: string;
  signer_user_id?: string;
  integrity_context?: Record<string, unknown>;
};

type SignatureVerificationMode =
  (typeof SIGNATURE_VERIFICATION_MODES)[keyof typeof SIGNATURE_VERIFICATION_MODES];

type SignatureProofScope =
  (typeof SIGNATURE_PROOF_SCOPES)[keyof typeof SIGNATURE_PROOF_SCOPES];

type SignatureLegalAssurance =
  (typeof SIGNATURE_LEGAL_ASSURANCE)[keyof typeof SIGNATURE_LEGAL_ASSURANCE];

type SignatureDocumentBinding = {
  module: string;
  proofScope: SignatureProofScope;
  reference: string | null;
  status: string | null;
  version: string | number | null;
  updatedAt: string | null;
  bindingHash: string;
  registryEntryId: string | null;
  documentCode: string | null;
  fileHash: string | null;
  fileKey: string | null;
};

type SignatureVerificationDetails = {
  verificationMode: SignatureVerificationMode;
  proofScope: SignatureProofScope | null;
  legalAssurance: SignatureLegalAssurance;
  canonicalPayloadHash: string | null;
  signatureEvidenceHash: string | null;
  documentBindingHash: string | null;
};

export type ContentIntegrityStatus =
  | 'VALID'
  | 'CONTENT_MISMATCH'
  | 'LEGACY_SIGNATURE'
  | 'MISSING_CONTENT'
  | 'MISSING_SIGNATURE'
  | 'INVALID_STATE';

type SiteScopedSignatureDocument = {
  id: string;
  company_id: string;
  site_id?: string | null;
};

type SignatureDocumentScope = {
  companyId: string;
  siteId: string | null;
};

type TrainingSignatureDocumentScopeRow = {
  company_id: string;
  site_id: string | null;
};

const SITE_SCOPED_SIGNATURE_DOCUMENT_ENTITIES: Record<
  string,
  EntityTarget<SiteScopedSignatureDocument>
> = {
  apr: Apr,
  pt: Pt,
  dds: Dds,
  arr: Arr,
  did: Did,
  checklist: Checklist,
  inspection: Inspection,
  cat: Cat,
  nonconformity: NonConformity,
  audit: Audit,
  rdo: Rdo,
};

/** Base64 payload larger than this threshold (in bytes) is offloaded to S3. */
const SIGNATURE_DATA_S3_THRESHOLD_BYTES = 4096;
const DEPRECATED_SIGNATURE_DOCUMENT_TYPES = new Set(['inspection', 'inspecao']);
const ACTIVE_SIGNATURE_DOCUMENT_TYPES = new Set([
  'apr',
  'pt',
  'dds',
  'checklist',
  'cat',
  'nonconformity',
  'audit',
  'rdo',
  'photographic_report',
]);

@Injectable()
export class SignaturesService {
  private readonly logger = new Logger(SignaturesService.name);

  constructor(
    @InjectRepository(Signature)
    private signaturesRepository: Repository<Signature>,
    private readonly dataSource: DataSource,
    private readonly tenantService: TenantService,
    private readonly signatureTimestampService: SignatureTimestampService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
    private readonly forensicTrailService: ForensicTrailService,
    private readonly storageService: StorageService,
  ) {}

  async create(
    createSignatureDto: CreateSignatureDto,
    authenticatedUserId: string,
  ): Promise<Signature> {
    const companyId = this.tenantService.getTenantId() || null;
    const documentType = this.normalizeLegacyReadDocumentType(
      createSignatureDto.document_type,
    );
    this.assertDocumentTypeAllowedForNewSignatures(documentType);
    const documentScope = await this.assertDocumentSiteVisibleForCurrentScope({
      documentId: createSignatureDto.document_id,
      documentType,
    });
    await this.assertDocumentSignatureMutable({
      documentId: createSignatureDto.document_id,
      documentType,
      companyId,
      signerUserId: authenticatedUserId,
    });
    return this.signaturesRepository.manager.transaction((manager) =>
      this.persistSignature(
        { ...createSignatureDto, document_type: documentType },
        authenticatedUserId,
        authenticatedUserId,
        manager,
        documentScope,
      ),
    );
  }

  async createWithManager(
    createSignatureDto: SignatureWriteInput,
    authenticatedUserId: string,
    manager: EntityManager,
    signerUserId = authenticatedUserId,
  ): Promise<Signature> {
    const companyId =
      this.tenantService.getTenantId() || createSignatureDto.company_id || null;
    const documentType = this.normalizeLegacyReadDocumentType(
      createSignatureDto.document_type,
    );
    this.assertDocumentTypeAllowedForNewSignatures(documentType);
    const documentScope = await this.assertDocumentSiteVisibleForCurrentScope({
      documentId: createSignatureDto.document_id,
      documentType,
    });
    await this.assertDocumentSignatureMutable({
      documentId: createSignatureDto.document_id,
      documentType,
      companyId,
      signerUserId,
    });

    return this.persistSignature(
      { ...createSignatureDto, document_type: documentType },
      authenticatedUserId,
      signerUserId,
      manager,
      documentScope,
    );
  }

  async replaceDocumentSignatures(input: {
    document_id: string;
    document_type: string;
    company_id?: string;
    authenticated_user_id: string;
    signatures: SignatureWriteInput[];
  }): Promise<Signature[]> {
    const tenantId = this.tenantService.getTenantId();
    const effectiveCompanyId = tenantId || input.company_id;
    const documentType = this.normalizeLegacyReadDocumentType(
      input.document_type,
    );
    this.assertDocumentTypeAllowedForNewSignatures(documentType);

    const documentScope = await this.assertDocumentSiteVisibleForCurrentScope({
      documentId: input.document_id,
      documentType,
    });
    await this.assertDocumentSignatureMutable({
      documentId: input.document_id,
      documentType,
      companyId: effectiveCompanyId || null,
    });
    const { created, replacedSignatures } =
      await this.signaturesRepository.manager.transaction(async (manager) => {
        const signatureRepository = manager.getRepository(Signature);
        const where = {
          document_id: input.document_id,
          document_type: documentType,
          ...(effectiveCompanyId ? { company_id: effectiveCompanyId } : {}),
        };
        const replacedSignatures = await signatureRepository.find({
          where,
          select: ['id', 'signature_data_key'],
        });
        await signatureRepository.delete(where);

        const created: Signature[] = [];
        for (const signatureInput of input.signatures) {
          created.push(
            await this.persistSignature(
              {
                ...signatureInput,
                document_id: input.document_id,
                document_type: documentType,
                company_id:
                  tenantId || signatureInput.company_id || input.company_id,
              },
              input.authenticated_user_id,
              signatureInput.signer_user_id || signatureInput.user_id,
              manager,
              documentScope,
            ),
          );
        }

        return { created, replacedSignatures };
      });

    await this.cleanupSignatureEvidenceFiles(
      replacedSignatures,
      `signatures:replace:${input.document_id}`,
    );
    return created;
  }

  async findManyByDocuments(
    documentIds: string[],
    documentType: string,
    options?: {
      companyId?: string;
      typePrefix?: string;
      take?: number;
    },
  ): Promise<Signature[]> {
    if (documentIds.length === 0) {
      return [];
    }

    const tenantId = this.tenantService.getTenantId();
    const effectiveCompanyId = options?.companyId || tenantId;
    const query = this.signaturesRepository
      .createQueryBuilder('signature')
      .where('signature.document_id IN (:...documentIds)', { documentIds })
      .andWhere('signature.document_type = :documentType', { documentType })
      .andWhere('signature.deleted_at IS NULL')
      .orderBy('signature.created_at', 'DESC');

    if (effectiveCompanyId) {
      query.andWhere('signature.company_id = :companyId', {
        companyId: effectiveCompanyId,
      });
    }

    if (options?.typePrefix) {
      query.andWhere('signature.type LIKE :typePrefix', {
        typePrefix: `${options.typePrefix}%`,
      });
    }

    const hasTenantContext = Boolean(
      this.tenantService.getContext?.() || tenantId,
    );
    if (hasTenantContext) {
      const scope = resolveSiteAccessScopeFromTenantService(
        this.tenantService,
        'assinaturas',
      );
      if (!scope.hasCompanyWideAccess) {
        query.andWhere('signature.site_id IN (:...siteIds)', {
          siteIds: scope.siteIds,
        });
      }
    }

    if (options?.take) {
      query.take(options.take);
    }

    return query.getMany();
  }

  private async persistSignature(
    createSignatureDto: SignatureWriteInput,
    authenticatedUserId: string,
    signerUserId = authenticatedUserId,
    manager?: EntityManager,
    documentScope?: SignatureDocumentScope,
  ): Promise<Signature> {
    const tenantId = this.tenantService.getTenantId();
    let payload = { ...createSignatureDto };
    this.assertSignatureTypeAllowed(payload.type);
    const effectiveCompanyId =
      tenantId || payload.company_id || documentScope?.companyId || null;
    const effectiveSiteId = documentScope?.siteId ?? null;
    const signedAtIso = new Date().toISOString();

    if (payload.type === 'hmac') {
      if (!payload.pin) {
        throw new BadRequestException('PIN obrigatório para assinatura HMAC.');
      }
      const signatureContextHash = payload.integrity_context
        ? hashCanonicalSignaturePayload(payload.integrity_context)
        : '';
      const hmacKey = await this.usersService.deriveHmacKey(
        signerUserId,
        payload.pin,
      );
      const message = [
        payload.document_id,
        payload.document_type,
        signerUserId,
        effectiveCompanyId || '',
        effectiveSiteId || '',
        payload.type,
        signatureContextHash,
        signedAtIso,
      ].join('|');
      const hmacHex = this.usersService.computeHmac(hmacKey, message);
      payload = {
        ...payload,
        signature_data: hmacHex,
        pin: undefined,
      };
    }

    const registryContext =
      await this.documentGovernanceService.findRegistryContextForSignature(
        payload.document_id,
        payload.document_type,
        effectiveCompanyId,
      );
    const documentBinding = await this.resolveDocumentBindingContext({
      documentId: payload.document_id,
      documentType: payload.document_type,
      companyId: effectiveCompanyId,
      registryContext,
    });
    const contentBinding =
      payload.document_type.toLowerCase() === 'apr'
        ? await this.loadAprContentBinding({
            manager,
            documentId: payload.document_id,
            companyId: effectiveCompanyId,
          })
        : null;
    const signatureEvidenceHash = hashSignatureEvidence(payload.signature_data);
    const verificationMode = SIGNATURE_VERIFICATION_MODES.SERVER_VERIFIABLE;
    const proofScope = documentBinding.proofScope;
    const legalAssurance = SIGNATURE_LEGAL_ASSURANCE.NOT_LEGAL_STRONG;
    const canonicalPayload = canonicalizeSignaturePayload({
      schema_version: 2,
      verification_mode: verificationMode,
      legal_assurance: legalAssurance,
      document: {
        id: payload.document_id,
        type: payload.document_type,
        module: documentBinding.module,
        company_id: effectiveCompanyId,
        site_id: effectiveSiteId,
        reference: documentBinding.reference,
        status: documentBinding.status,
        version: documentBinding.version,
        updated_at: documentBinding.updatedAt,
        proof_scope: proofScope,
        binding_hash: documentBinding.bindingHash,
        registry_entry_id: documentBinding.registryEntryId,
        document_code: documentBinding.documentCode,
        file_hash: documentBinding.fileHash,
        file_key: documentBinding.fileKey,
        content_hash: contentBinding?.contentHash || null,
        hash_algorithm: contentBinding ? APR_CONTENT_HASH_ALGORITHM : null,
        canonicalization_version: contentBinding
          ? APR_CONTENT_CANONICALIZATION_VERSION
          : null,
        integrity_scheme: contentBinding ? APR_CONTENT_INTEGRITY_SCHEME : null,
      },
      signer: {
        user_id: signerUserId,
        captured_by_user_id:
          authenticatedUserId !== signerUserId ? authenticatedUserId : null,
      },
      signature: {
        type: payload.type,
        evidence_hash: signatureEvidenceHash,
        evidence_kind: this.resolveEvidenceKind(
          payload.type,
          payload.signature_data,
        ),
      },
      signature_context: payload.integrity_context || null,
      signed_at: signedAtIso,
    });
    const canonicalPayloadHash =
      hashCanonicalSignaturePayload(canonicalPayload);
    const generatedStamp = this.signatureTimestampService.issueFromHash(
      canonicalPayloadHash,
      signedAtIso,
    );
    const signedAt = new Date(generatedStamp.timestamp_issued_at);
    const signatureRepository =
      manager?.getRepository(Signature) ?? this.signaturesRepository;
    const { inlineData, dataKey } = await this.resolveSignatureDataStorage(
      payload.document_id,
      payload.type,
      payload.signature_data,
    );

    const signature = signatureRepository.create({
      document_id: payload.document_id,
      document_type: payload.document_type,
      signature_data: inlineData,
      signature_data_key: dataKey,
      type: payload.type,
      user_id: signerUserId,
      company_id: effectiveCompanyId || undefined,
      site_id: effectiveSiteId,
      signature_hash: generatedStamp.signature_hash,
      timestamp_token: generatedStamp.timestamp_token,
      timestamp_authority: generatedStamp.timestamp_authority,
      signed_at: signedAt,
      content_hash: contentBinding?.contentHash || null,
      hash_algorithm: contentBinding ? APR_CONTENT_HASH_ALGORITHM : null,
      canonicalization_version: contentBinding
        ? APR_CONTENT_CANONICALIZATION_VERSION
        : null,
      integrity_scheme: contentBinding ? APR_CONTENT_INTEGRITY_SCHEME : null,
      integrity_payload: {
        schema_version: 2,
        document_id: payload.document_id,
        document_type: payload.document_type,
        user_id: signerUserId,
        captured_by_user_id:
          authenticatedUserId !== signerUserId
            ? authenticatedUserId
            : undefined,
        type: payload.type,
        signed_at: signedAt.toISOString(),
        verification_mode: verificationMode,
        legal_assurance: legalAssurance,
        proof_scope: proofScope,
        canonical_payload_hash: canonicalPayloadHash,
        content_hash: contentBinding?.contentHash,
        hash_algorithm: contentBinding ? APR_CONTENT_HASH_ALGORITHM : undefined,
        canonicalization_version: contentBinding
          ? APR_CONTENT_CANONICALIZATION_VERSION
          : undefined,
        integrity_scheme: contentBinding
          ? APR_CONTENT_INTEGRITY_SCHEME
          : undefined,
        signable_content: contentBinding?.content,
        canonical_payload: canonicalPayload,
        signature_evidence_hash: signatureEvidenceHash,
        signature_evidence_kind: this.resolveEvidenceKind(
          payload.type,
          payload.signature_data,
        ),
        signature_context_hash: payload.integrity_context
          ? hashCanonicalSignaturePayload(payload.integrity_context)
          : undefined,
        signature_context: payload.integrity_context || undefined,
        hmac_verified: payload.type === 'hmac' ? true : undefined,
        document_binding: {
          module: documentBinding.module,
          site_id: effectiveSiteId,
          reference: documentBinding.reference,
          status: documentBinding.status,
          version: documentBinding.version,
          updated_at: documentBinding.updatedAt,
          proof_scope: documentBinding.proofScope,
          binding_hash: documentBinding.bindingHash,
          content_hash: contentBinding?.contentHash,
          hash_algorithm: contentBinding
            ? APR_CONTENT_HASH_ALGORITHM
            : undefined,
          canonicalization_version: contentBinding
            ? APR_CONTENT_CANONICALIZATION_VERSION
            : undefined,
          integrity_scheme: contentBinding
            ? APR_CONTENT_INTEGRITY_SCHEME
            : undefined,
        },
        document_registry: registryContext
          ? {
              entry_id: registryContext.registryEntryId,
              module: registryContext.module,
              document_code: registryContext.documentCode,
              file_hash: registryContext.fileHash,
              file_key: registryContext.fileKey,
            }
          : undefined,
      },
    });
    const savedSignature = await signatureRepository.save(signature);
    const signatureModule =
      registryContext?.module ||
      resolveRegistryModuleForSignatureDocumentType(payload.document_type) ||
      normalizeModuleFromDocumentType(payload.document_type);

    await this.forensicTrailService.append(
      {
        eventType: FORENSIC_EVENT_TYPES.SIGNATURE_RECORDED,
        module: signatureModule,
        entityId: payload.document_id,
        companyId: effectiveCompanyId,
        userId: signerUserId,
        occurredAt: signedAt,
        metadata: {
          signatureId: savedSignature.id,
          signatureType: payload.type,
          documentType: payload.document_type,
          signedAt: signedAt.toISOString(),
          signatureHash: savedSignature.signature_hash || null,
          signatureEvidenceHash,
          verificationMode,
          proofScope,
          timestampAuthority: savedSignature.timestamp_authority || null,
          registryEntryId: registryContext?.registryEntryId || null,
          documentCode: registryContext?.documentCode || null,
          documentFileHash: registryContext?.fileHash || null,
          documentBindingHash: documentBinding.bindingHash,
          contentHash: contentBinding?.contentHash || null,
          hashAlgorithm: contentBinding ? APR_CONTENT_HASH_ALGORITHM : null,
          canonicalizationVersion: contentBinding
            ? APR_CONTENT_CANONICALIZATION_VERSION
            : null,
        },
      },
      manager ? { manager } : undefined,
    );

    return savedSignature;
  }

  private async loadAprContentBinding(input: {
    manager?: EntityManager;
    documentId: string;
    companyId: string | null;
  }): Promise<{ content: Record<string, unknown>; contentHash: string }> {
    const manager = input.manager;
    if (!manager) {
      throw new BadRequestException(
        'Não foi possível calcular a integridade da APR em uma transação.',
      );
    }

    // O lock do pai permanece válido até o INSERT da assinatura. As tabelas
    // filhas são carregadas dentro do mesmo manager, eliminando TOCTOU entre
    // validação, hash e persistência.
    const lockedRows = await manager.query<Array<{ id: string }>>(
      `SELECT "id" FROM "aprs"
        WHERE "id" = $1 AND "company_id" = $2 AND "deleted_at" IS NULL
        FOR UPDATE`,
      [input.documentId, input.companyId],
    );
    if (lockedRows.length === 0) {
      throw new NotFoundException(
        'APR não encontrada para cálculo de integridade.',
      );
    }
    const aprRepository = manager.getRepository(Apr);
    const apr = await aprRepository.findOne({
      where: input.companyId
        ? { id: input.documentId, company_id: input.companyId }
        : { id: input.documentId },
      relations: [
        'company',
        'site',
        'elaborador',
        'auditado_por',
        'activities',
        'risks',
        'epis',
        'tools',
        'machines',
        'participants',
        'risk_items',
      ],
    });
    if (!apr) {
      throw new NotFoundException(
        'APR não encontrada para cálculo de integridade.',
      );
    }

    const evidences = await manager.getRepository(AprRiskEvidence).find({
      where: { apr_id: input.documentId },
      select: [
        'id',
        'apr_risk_item_id',
        'original_name',
        'hash_sha256',
        'watermarked_hash_sha256',
        'captured_at',
      ],
      order: { uploaded_at: 'ASC' },
    });
    const contentInput = { ...apr, evidences };
    const content = buildAprSignableContentV1(contentInput);
    return { content, contentHash: hashAprSignableContentV1(contentInput) };
  }

  async findByDocument(
    document_id: string,
    document_type: string,
  ): Promise<Signature[]> {
    const normalizedDocumentType =
      this.normalizeLegacyReadDocumentType(document_type);
    await this.assertDocumentSiteVisibleForCurrentScope({
      documentId: document_id,
      documentType: normalizedDocumentType,
    });
    const tenantId = this.tenantService.getTenantId();
    const where = tenantId
      ? {
          document_id,
          document_type: normalizedDocumentType,
          company_id: tenantId,
        }
      : {
          document_id,
          document_type: normalizedDocumentType,
        };
    const signatures = await this.signaturesRepository.find({
      where: { ...where, deleted_at: IsNull() },
      relations: { user: true },
      select: {
        user: {
          id: true,
          nome: true,
          funcao: true,
        },
      },
    });
    const hydratedSignatures = await this.hydrateSignaturesData(signatures);
    return hydratedSignatures.map((signature) =>
      this.minimizeSignaturePayload(this.minimizeSignatureUser(signature)),
    );
  }

  private async hydrateSignaturesData(
    signatures: Signature[],
  ): Promise<Signature[]> {
    await Promise.all(
      signatures.map(async (signature) => {
        if (
          signature.signature_data !== null &&
          signature.signature_data !== undefined
        ) {
          return;
        }
        if (!signature.signature_data_key) {
          return;
        }

        signature.signature_data = await this.resolveSignatureData(signature);
      }),
    );

    return signatures;
  }

  async remove(
    signatureId: string,
    requesterId: string,
    requesterRole?: string | null,
  ): Promise<void> {
    const tenantId = this.tenantService.getTenantId();
    const signature = await this.signaturesRepository.findOne({
      where: tenantId
        ? { id: signatureId, company_id: tenantId, deleted_at: IsNull() }
        : { id: signatureId, deleted_at: IsNull() },
    });

    if (!signature) {
      throw new NotFoundException('Assinatura não encontrada.');
    }

    await this.assertDocumentSiteVisibleForCurrentScope({
      documentId: signature.document_id,
      documentType: signature.document_type,
    });

    const isOwner = signature.user_id === requesterId;
    const isPrivileged = this.isPrivilegedRole(requesterRole);

    if (!isOwner && !isPrivileged) {
      throw new ForbiddenException(
        'Sem permissão para remover esta assinatura.',
      );
    }

    await this.assertDocumentSignatureMutable({
      documentId: signature.document_id,
      documentType: signature.document_type,
      companyId: signature.company_id || tenantId || null,
    });

    // Alinhado para soft delete (a entidade suporta deleted_at). Preserva histórico de assinaturas para auditoria/forense.
    await this.signaturesRepository.softDelete({ id: signature.id });
    await this.cleanupSignatureEvidenceFiles(
      [signature],
      `signatures:remove:${signature.id}`,
    );
  }

  async removeByDocument(
    document_id: string,
    document_type: string,
    requesterId: string,
    requesterRole?: string | null,
  ): Promise<void> {
    const tenantId = this.tenantService.getTenantId();
    await this.assertDocumentSiteVisibleForCurrentScope({
      documentId: document_id,
      documentType: document_type,
    });
    const where = tenantId
      ? {
          document_id,
          document_type,
          company_id: tenantId,
        }
      : {
          document_id,
          document_type,
        };
    const signatures = await this.signaturesRepository.find({
      where: { ...where, deleted_at: IsNull() },
    });

    if (signatures.length === 0) {
      return;
    }

    const isPrivileged = this.isPrivilegedRole(requesterRole);
    if (!isPrivileged) {
      const hasUnauthorized = signatures.some(
        (signature) => signature.user_id !== requesterId,
      );
      if (hasUnauthorized) {
        throw new ForbiddenException(
          'Sem permissão para remover assinaturas deste documento.',
        );
      }
    }

    await this.assertDocumentSignatureMutable({
      documentId: document_id,
      documentType: document_type,
      companyId: tenantId || signatures[0]?.company_id || null,
    });

    // Uso de softDelete para alinhamento com soft-delete de documentos (checklists, etc).
    // Evidências de arquivo são limpas, mas o registro de assinatura permanece para trilha forense.
    await this.signaturesRepository.softDelete({
      id: In(signatures.map((signature) => signature.id)),
    });
    await this.cleanupSignatureEvidenceFiles(
      signatures,
      `signatures:remove-document:${document_id}`,
    );
  }

  async removeByDocumentSystem(
    document_id: string,
    document_type: string,
    knownDocumentScope?: {
      companyId: string;
      siteId?: string | null;
    },
  ): Promise<number> {
    const tenantId = this.tenantService.getTenantId();
    if (knownDocumentScope) {
      this.assertKnownDocumentScopeVisibleForCurrentScope(knownDocumentScope);
    } else {
      await this.assertDocumentSiteVisibleForCurrentScope({
        documentId: document_id,
        documentType: document_type,
      });
    }
    const where = tenantId
      ? {
          document_id,
          document_type,
          company_id: tenantId,
        }
      : {
          document_id,
          document_type,
        };
    const signatures = await this.signaturesRepository.find({
      where: { ...where, deleted_at: IsNull() },
      select: ['id', 'signature_data_key'],
    });
    const deleteResult = await this.signaturesRepository.softDelete(where);
    await this.cleanupSignatureEvidenceFiles(
      signatures,
      `signatures:remove-document-system:${document_id}`,
    );

    return deleteResult.affected ?? 0;
  }

  async verifyById(signatureId: string): Promise<{
    id: string;
    valid: boolean;
    signed_at?: string;
    timestamp_authority?: string;
    signature_hash?: string;
    verification_mode: SignatureVerificationMode;
    legal_assurance: SignatureLegalAssurance;
    proof_scope?: SignatureProofScope | null;
    document_binding_hash?: string | null;
    signature_evidence_hash?: string | null;
    content_integrity?: ContentIntegrityStatus;
    content_hash?: string | null;
    hash_algorithm?: string | null;
    canonicalization_version?: number | null;
  }> {
    const tenantId = this.tenantService.getTenantId();
    const signature = await this.signaturesRepository.findOne({
      where: tenantId
        ? { id: signatureId, company_id: tenantId, deleted_at: IsNull() }
        : { id: signatureId, deleted_at: IsNull() },
    });

    if (!signature) {
      throw new NotFoundException('Assinatura não encontrada.');
    }

    await this.assertDocumentSiteVisibleForCurrentScope({
      documentId: signature.document_id,
      documentType: signature.document_type,
    });

    const hasFields = Boolean(
      signature.signature_hash && signature.timestamp_token,
    );
    const valid = hasFields
      ? this.signatureTimestampService.verify(
          signature.signature_hash as string,
          signature.timestamp_token as string,
        )
      : false;
    const verificationDetails = this.extractVerificationDetails(signature);
    let contentIntegrity: ContentIntegrityStatus | undefined;
    if (signature.document_type.toLowerCase() === 'apr') {
      if (!signature.content_hash) {
        contentIntegrity = 'LEGACY_SIGNATURE';
      } else {
        try {
          const binding = await this.dataSource.transaction((manager) =>
            this.loadAprContentBinding({
              manager,
              documentId: signature.document_id,
              companyId: signature.company_id,
            }),
          );
          contentIntegrity =
            binding.contentHash === signature.content_hash
              ? 'VALID'
              : 'CONTENT_MISMATCH';
        } catch {
          contentIntegrity = 'MISSING_CONTENT';
        }
      }
    }

    return {
      id: signature.id,
      valid,
      signed_at: signature.signed_at?.toISOString(),
      timestamp_authority: signature.timestamp_authority,
      signature_hash: signature.signature_hash,
      verification_mode: verificationDetails.verificationMode,
      legal_assurance: verificationDetails.legalAssurance,
      proof_scope: verificationDetails.proofScope,
      document_binding_hash: verificationDetails.documentBindingHash,
      signature_evidence_hash: verificationDetails.signatureEvidenceHash,
      content_integrity: contentIntegrity,
      content_hash: signature.content_hash,
      hash_algorithm: signature.hash_algorithm,
      canonicalization_version: signature.canonicalization_version,
    };
  }

  async verifyByHashPublic(signatureHash: string): Promise<{
    valid: boolean;
    message?: string;
    signature?: {
      hash: string;
      signed_at?: string;
      timestamp_authority?: string;
      type?: string;
      verification_mode?: SignatureVerificationMode;
      legal_assurance?: SignatureLegalAssurance;
      proof_scope?: SignatureProofScope | null;
      document_binding_hash?: string | null;
      signature_evidence_hash?: string | null;
    };
  }> {
    const normalizedHash = String(signatureHash || '')
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
      return {
        valid: false,
        message: 'Hash SHA-256 inválido.',
      };
    }

    const signature = await this.signaturesRepository.findOne({
      where: { signature_hash: normalizedHash },
    });

    if (!signature) {
      return {
        valid: false,
        message: 'Assinatura não localizada.',
      };
    }

    const persistedHash = signature.signature_hash;
    const timestampToken = signature.timestamp_token;
    const valid =
      typeof persistedHash === 'string' &&
      typeof timestampToken === 'string' &&
      this.signatureTimestampService.verify(persistedHash, timestampToken);
    const verificationDetails = this.extractVerificationDetails(signature);

    return {
      valid,
      message: valid
        ? 'Assinatura validada com sucesso.'
        : 'Assinatura localizada, mas inválida.',
      signature: {
        hash: signature.signature_hash || normalizedHash,
        signed_at: signature.signed_at?.toISOString(),
        timestamp_authority: signature.timestamp_authority || undefined,
        type: signature.type,
        verification_mode: verificationDetails.verificationMode,
        legal_assurance: verificationDetails.legalAssurance,
        proof_scope: verificationDetails.proofScope,
        document_binding_hash: verificationDetails.documentBindingHash,
        signature_evidence_hash: verificationDetails.signatureEvidenceHash,
      },
    };
  }

  private resolveEvidenceKind(type: string, signatureData: string): string {
    if (type === 'hmac') {
      return 'pin_hmac';
    }

    if (type.startsWith('team_photo_')) {
      return 'json';
    }

    if (signatureData.startsWith('data:image')) {
      return 'image_data_url';
    }

    return 'raw_text';
  }

  private async resolveDocumentBindingContext(input: {
    documentId: string;
    documentType: string;
    companyId: string | null;
    registryContext: {
      registryEntryId: string;
      module: string;
      documentCode: string | null;
      fileHash: string | null;
      fileKey: string | null;
    } | null;
  }): Promise<SignatureDocumentBinding> {
    const module =
      input.registryContext?.module ||
      resolveRegistryModuleForSignatureDocumentType(input.documentType) ||
      normalizeModuleFromDocumentType(input.documentType);
    const entityContext = await this.loadEntityBindingContext(
      module,
      input.documentId,
      input.companyId,
    );

    const bindingHash =
      input.registryContext?.fileHash ||
      entityContext?.stateHash ||
      hashCanonicalSignaturePayload({
        documentId: input.documentId,
        documentType: input.documentType,
        companyId: input.companyId,
      });
    const proofScope = input.registryContext?.fileHash
      ? SIGNATURE_PROOF_SCOPES.GOVERNED_FINAL_DOCUMENT
      : entityContext?.stateHash
        ? SIGNATURE_PROOF_SCOPES.DOCUMENT_REVISION
        : SIGNATURE_PROOF_SCOPES.DOCUMENT_IDENTITY;

    return {
      module,
      proofScope,
      reference: entityContext?.reference || null,
      status: entityContext?.status || null,
      version: entityContext?.version ?? null,
      updatedAt: entityContext?.updatedAt || null,
      bindingHash,
      registryEntryId: input.registryContext?.registryEntryId || null,
      documentCode: input.registryContext?.documentCode || null,
      fileHash: input.registryContext?.fileHash || null,
      fileKey: input.registryContext?.fileKey || null,
    };
  }

  private async assertDocumentSignatureMutable(input: {
    documentId: string;
    documentType: string;
    companyId: string | null;
    signerUserId?: string;
  }): Promise<void> {
    const module =
      resolveRegistryModuleForSignatureDocumentType(input.documentType) ||
      normalizeModuleFromDocumentType(input.documentType);

    const registryContext =
      await this.documentGovernanceService.findRegistryContextForSignature(
        input.documentId,
        input.documentType,
        input.companyId,
      );
    const hasGovernedFinalPdf = Boolean(registryContext?.fileKey);

    switch (module) {
      case 'apr': {
        const apr = await this.dataSource.getRepository(Apr).findOne({
          where: input.companyId
            ? { id: input.documentId, company_id: input.companyId }
            : { id: input.documentId },
          select: [
            'id',
            'company_id',
            'status',
            'pdf_file_key',
            'elaborador_id',
          ],
        });

        if (!apr) {
          throw new NotFoundException('APR não encontrada para assinatura.');
        }

        if (input.signerUserId) {
          const participantRows = await this.dataSource.query<
            Array<{ allowed: boolean | string }>
          >(
            `SELECT EXISTS (
               SELECT 1 FROM "apr_participants"
                WHERE "apr_id" = $1 AND "user_id" = $2
             ) AS allowed`,
            [apr.id, input.signerUserId],
          );
          const isParticipant =
            participantRows[0]?.allowed === true ||
            participantRows[0]?.allowed === 't' ||
            participantRows[0]?.allowed === 'true';
          if (apr.elaborador_id !== input.signerUserId && !isParticipant) {
            throw new ForbiddenException(
              'Somente o elaborador ou um participante da APR pode registrar assinatura.',
            );
          }
        }

        if (hasGovernedFinalPdf || apr.pdf_file_key) {
          throw new BadRequestException(
            'APR com PDF final emitido está bloqueada para alterações de assinatura. Gere uma nova versão para seguir com alterações.',
          );
        }

        const approvalProgressRows = await this.dataSource.query<
          Array<{ count: string }>
        >(
          `SELECT COUNT(*)::text AS count
             FROM "apr_approval_steps"
            WHERE "apr_id" = $1
              AND "status" IN ('approved','rejected','skipped')`,
          [apr.id],
        );
        const approvalProgressCount = Number(
          approvalProgressRows[0]?.count ?? 0,
        );
        if (approvalProgressCount > 0) {
          throw new BadRequestException(
            'APR com aprovação em andamento está bloqueada para alterações de assinatura. Gere uma nova versão para ajustar signatários.',
          );
        }

        const isPendingApr = String(apr.status) === String(AprStatus.PENDENTE);
        if (!isPendingApr) {
          throw new BadRequestException(
            'Somente APRs pendentes podem ter assinaturas alteradas diretamente. Use nova versão se precisar ajustar signatários.',
          );
        }
        return;
      }
      case 'pt': {
        const pt = await this.dataSource.getRepository(Pt).findOne({
          where: input.companyId
            ? { id: input.documentId, company_id: input.companyId }
            : { id: input.documentId },
          select: ['id', 'company_id', 'pdf_file_key'],
        });

        if (!pt) {
          throw new NotFoundException('PT não encontrada para assinatura.');
        }

        this.assertNoFinalPdfSignatureMutation({
          documentLabel: 'PT',
          hasLegacyPdf: Boolean(pt.pdf_file_key),
          hasGovernedFinalPdf,
        });
        return;
      }
      case 'dds': {
        const dds = await this.dataSource.getRepository(Dds).findOne({
          where: input.companyId
            ? { id: input.documentId, company_id: input.companyId }
            : { id: input.documentId },
          select: ['id', 'company_id', 'is_modelo', 'pdf_file_key'],
        });

        if (!dds) {
          throw new NotFoundException('DDS não encontrado para assinatura.');
        }

        if (dds.is_modelo) {
          throw new BadRequestException(
            'Modelos de DDS não aceitam alterações de assinatura por este fluxo.',
          );
        }

        this.assertNoFinalPdfSignatureMutation({
          documentLabel: 'DDS',
          hasLegacyPdf: Boolean(dds.pdf_file_key),
          hasGovernedFinalPdf,
        });
        return;
      }
      case 'checklist': {
        const checklist = await this.dataSource
          .getRepository(Checklist)
          .findOne({
            where: input.companyId
              ? { id: input.documentId, company_id: input.companyId }
              : { id: input.documentId },
            select: ['id', 'company_id', 'is_modelo', 'pdf_file_key'],
          });

        if (!checklist) {
          throw new NotFoundException(
            'Checklist não encontrado para assinatura.',
          );
        }

        if (checklist.is_modelo) {
          throw new BadRequestException(
            'Modelos de checklist não aceitam alterações de assinatura por este fluxo.',
          );
        }

        this.assertNoFinalPdfSignatureMutation({
          documentLabel: 'Checklist',
          hasLegacyPdf: Boolean(checklist.pdf_file_key),
          hasGovernedFinalPdf,
        });
        return;
      }
      case 'inspection': {
        const inspection = await this.dataSource
          .getRepository(Inspection)
          .findOne({
            where: input.companyId
              ? { id: input.documentId, company_id: input.companyId }
              : { id: input.documentId },
            select: ['id', 'company_id'],
          });

        if (!inspection) {
          throw new NotFoundException(
            'Relatório de inspeção não encontrado para assinatura.',
          );
        }

        this.assertNoFinalPdfSignatureMutation({
          documentLabel: 'Relatório de inspeção',
          hasLegacyPdf: false,
          hasGovernedFinalPdf,
        });
        return;
      }
      case 'cat': {
        const cat = await this.dataSource.getRepository(Cat).findOne({
          where: input.companyId
            ? { id: input.documentId, company_id: input.companyId }
            : { id: input.documentId },
          select: ['id', 'company_id', 'pdf_file_key'],
        });

        if (!cat) {
          throw new NotFoundException('CAT não encontrada para assinatura.');
        }

        this.assertNoFinalPdfSignatureMutation({
          documentLabel: 'CAT',
          hasLegacyPdf: Boolean(cat.pdf_file_key),
          hasGovernedFinalPdf,
        });
        return;
      }
      case 'nonconformity': {
        const nonconformity = await this.dataSource
          .getRepository(NonConformity)
          .findOne({
            where: input.companyId
              ? { id: input.documentId, company_id: input.companyId }
              : { id: input.documentId },
            select: ['id', 'company_id', 'pdf_file_key'],
          });

        if (!nonconformity) {
          throw new NotFoundException(
            'Não conformidade não encontrada para assinatura.',
          );
        }

        this.assertNoFinalPdfSignatureMutation({
          documentLabel: 'Não conformidade',
          hasLegacyPdf: Boolean(nonconformity.pdf_file_key),
          hasGovernedFinalPdf,
        });
        return;
      }
      case 'audit': {
        const audit = await this.dataSource.getRepository(Audit).findOne({
          where: input.companyId
            ? { id: input.documentId, company_id: input.companyId }
            : { id: input.documentId },
          select: ['id', 'company_id', 'pdf_file_key'],
        });

        if (!audit) {
          throw new NotFoundException(
            'Auditoria não encontrada para assinatura.',
          );
        }

        this.assertNoFinalPdfSignatureMutation({
          documentLabel: 'Auditoria',
          hasLegacyPdf: Boolean(audit.pdf_file_key),
          hasGovernedFinalPdf,
        });
        return;
      }
      case 'rdo': {
        const rdo = await this.dataSource.getRepository(Rdo).findOne({
          where: input.companyId
            ? { id: input.documentId, company_id: input.companyId }
            : { id: input.documentId },
          select: ['id', 'company_id', 'pdf_file_key'],
        });

        if (!rdo) {
          throw new NotFoundException('RDO não encontrado para assinatura.');
        }

        this.assertNoFinalPdfSignatureMutation({
          documentLabel: 'RDO',
          hasLegacyPdf: Boolean(rdo.pdf_file_key),
          hasGovernedFinalPdf,
        });
        return;
      }
      default:
        return;
    }
  }

  private async assertDocumentSiteVisibleForCurrentScope(input: {
    documentId: string;
    documentType: string;
  }): Promise<SignatureDocumentScope> {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'assinaturas',
    );

    const module =
      resolveRegistryModuleForSignatureDocumentType(input.documentType) ||
      normalizeModuleFromDocumentType(input.documentType);
    const entity = SITE_SCOPED_SIGNATURE_DOCUMENT_ENTITIES[module];
    if (!entity) {
      if (module === 'training') {
        return this.resolveTrainingSignatureDocumentScope({
          documentId: input.documentId,
          scope,
        });
      }

      if (module === 'photographic_report') {
        return this.resolvePhotographicReportSignatureDocumentScope({
          documentId: input.documentId,
          scope,
        });
      }

      throw new NotFoundException('Documento não encontrado para assinaturas.');
    }

    const document = await this.dataSource
      .getRepository<SiteScopedSignatureDocument>(entity)
      .findOne({
        where: {
          id: input.documentId,
          company_id: scope.companyId,
        },
        select: ['id', 'company_id', 'site_id'],
      });

    if (!document || !isSiteVisibleToScope(document.site_id, scope)) {
      throw new NotFoundException('Documento não encontrado para assinaturas.');
    }

    return {
      companyId: document.company_id,
      siteId: document.site_id ?? null,
    };
  }

  private async resolveTrainingSignatureDocumentScope(input: {
    documentId: string;
    scope: ReturnType<typeof resolveSiteAccessScopeFromTenantService>;
  }): Promise<SignatureDocumentScope> {
    const document = await this.dataSource
      .getRepository(Training)
      .createQueryBuilder('training')
      .leftJoin('training.user', 'user')
      .select('training.company_id', 'company_id')
      .addSelect('user.site_id', 'site_id')
      .where('training.id = :documentId', { documentId: input.documentId })
      .andWhere('training.company_id = :companyId', {
        companyId: input.scope.companyId,
      })
      .getRawOne<TrainingSignatureDocumentScopeRow>();

    if (!document || !isSiteVisibleToScope(document.site_id, input.scope)) {
      throw new NotFoundException('Documento não encontrado para assinaturas.');
    }

    return {
      companyId: document.company_id,
      siteId: document.site_id ?? null,
    };
  }

  /**
   * Escopo de assinatura de Relatório Fotográfico.
   *
   * Não usa `SITE_SCOPED_SIGNATURE_DOCUMENT_ENTITIES` por dois motivos, nesta
   * ordem de importância:
   *
   * 1. `photographic_reports` NÃO tem coluna `site_id`. Registrar a entidade
   *    naquele mapa faria o `findOne({ select: [...,'site_id'] })` da linha
   *    acima estourar `EntityColumnNotFound` em runtime.
   *
   * 2. Mesmo que a coluna existisse, aplicar `isSiteVisibleToScope(null, scope)`
   *    devolveria `false` para usuário restrito a obra — porque a função exige
   *    `siteId` presente E pertencente ao escopo. Um TST alocado a uma obra
   *    ficaria impedido de assinar ou de ler assinaturas do relatório.
   *
   * O relatório fotográfico é escopado por empresa por natureza: a checagem de
   * obra não se aplica, e a verificação relevante — o documento pertencer à
   * empresa do solicitante — é feita no próprio `where`.
   */
  private async resolvePhotographicReportSignatureDocumentScope(input: {
    documentId: string;
    scope: ReturnType<typeof resolveSiteAccessScopeFromTenantService>;
  }): Promise<SignatureDocumentScope> {
    const document = await this.dataSource
      .getRepository(PhotographicReport)
      .findOne({
        where: {
          id: input.documentId,
          company_id: input.scope.companyId,
        },
        select: ['id', 'company_id'],
      });

    if (!document) {
      throw new NotFoundException('Documento não encontrado para assinaturas.');
    }

    return {
      companyId: document.company_id,
      siteId: null,
    };
  }

  private assertKnownDocumentScopeVisibleForCurrentScope(input: {
    companyId: string;
    siteId?: string | null;
  }): void {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'assinaturas',
    );
    if (
      input.companyId !== scope.companyId ||
      !isSiteVisibleToScope(input.siteId, scope)
    ) {
      throw new NotFoundException('Documento não encontrado para assinaturas.');
    }
  }

  private minimizeSignatureUser(signature: Signature): Signature {
    if (!signature.user) {
      return signature;
    }

    signature.user = {
      id: signature.user.id,
      nome: signature.user.nome,
      funcao: signature.user.funcao,
    } as User;
    return signature;
  }

  /**
   * The canonical APR snapshot is kept server-side for forensic verification,
   * but must not be returned by the broad signature listing endpoint.
   */
  private minimizeSignaturePayload(signature: Signature): Signature {
    if (!signature.integrity_payload) {
      return signature;
    }

    const payload = signature.integrity_payload;
    if (!Object.prototype.hasOwnProperty.call(payload, 'signable_content')) {
      return signature;
    }

    const publicPayload = { ...payload };
    delete publicPayload.signable_content;
    signature.integrity_payload = publicPayload;
    return signature;
  }

  private async cleanupSignatureEvidenceFiles(
    signatures: Array<Pick<Signature, 'id' | 'signature_data_key'>>,
    context: string,
  ): Promise<void> {
    await Promise.all(
      signatures.map(async (signature) => {
        if (!signature.signature_data_key) {
          return;
        }

        await cleanupUploadedFile(
          this.logger,
          `${context}:${signature.id}`,
          signature.signature_data_key,
          (key) => this.storageService.deleteFile(key),
        );
      }),
    );
  }

  private async loadEntityBindingContext(
    module: string,
    documentId: string,
    companyId: string | null,
  ): Promise<{
    reference: string | null;
    status: string | null;
    version: string | number | null;
    updatedAt: string | null;
    stateHash: string;
  } | null> {
    switch (module) {
      case 'apr': {
        const apr = await this.dataSource.getRepository(Apr).findOne({
          where: companyId
            ? { id: documentId, company_id: companyId }
            : { id: documentId },
          select: [
            'id',
            'company_id',
            'numero',
            'versao',
            'status',
            'updated_at',
          ],
        });
        if (!apr) {
          return null;
        }

        return this.buildEntityBindingContext({
          module,
          documentId: apr.id,
          companyId: apr.company_id,
          reference: apr.numero,
          status: apr.status,
          version: apr.versao,
          updatedAt: apr.updated_at,
        });
      }
      case 'pt': {
        const pt = await this.dataSource.getRepository(Pt).findOne({
          where: companyId
            ? { id: documentId, company_id: companyId }
            : { id: documentId },
          select: ['id', 'company_id', 'numero', 'status', 'updated_at'],
        });
        if (!pt) {
          return null;
        }

        return this.buildEntityBindingContext({
          module,
          documentId: pt.id,
          companyId: pt.company_id,
          reference: pt.numero,
          status: pt.status,
          version: null,
          updatedAt: pt.updated_at,
        });
      }
      case 'dds': {
        const dds = await this.dataSource.getRepository(Dds).findOne({
          where: companyId
            ? { id: documentId, company_id: companyId }
            : { id: documentId },
          select: ['id', 'company_id', 'tema', 'status', 'updated_at'],
        });
        if (!dds) {
          return null;
        }

        return this.buildEntityBindingContext({
          module,
          documentId: dds.id,
          companyId: dds.company_id,
          reference: dds.tema,
          status: dds.status,
          version: null,
          updatedAt: dds.updated_at,
        });
      }
      case 'checklist': {
        const checklist = await this.dataSource
          .getRepository(Checklist)
          .findOne({
            where: companyId
              ? { id: documentId, company_id: companyId }
              : { id: documentId },
            select: ['id', 'company_id', 'titulo', 'status', 'updated_at'],
          });
        if (!checklist) {
          return null;
        }

        return this.buildEntityBindingContext({
          module,
          documentId: checklist.id,
          companyId: checklist.company_id,
          reference: checklist.titulo,
          status: checklist.status,
          version: null,
          updatedAt: checklist.updated_at,
        });
      }
      case 'inspection': {
        const inspection = await this.dataSource
          .getRepository(Inspection)
          .findOne({
            where: companyId
              ? { id: documentId, company_id: companyId }
              : { id: documentId },
            select: [
              'id',
              'company_id',
              'tipo_inspecao',
              'setor_area',
              'updated_at',
            ],
          });
        if (!inspection) {
          return null;
        }

        return this.buildEntityBindingContext({
          module,
          documentId: inspection.id,
          companyId: inspection.company_id,
          reference: `${inspection.tipo_inspecao} - ${inspection.setor_area}`,
          status: null,
          version: null,
          updatedAt: inspection.updated_at,
        });
      }
      case 'cat': {
        const cat = await this.dataSource.getRepository(Cat).findOne({
          where: companyId
            ? { id: documentId, company_id: companyId }
            : { id: documentId },
          select: ['id', 'company_id', 'numero', 'status', 'updated_at'],
        });
        if (!cat) {
          return null;
        }

        return this.buildEntityBindingContext({
          module,
          documentId: cat.id,
          companyId: cat.company_id,
          reference: cat.numero,
          status: cat.status,
          version: null,
          updatedAt: cat.updated_at,
        });
      }
      case 'nonconformity': {
        const nonconformity = await this.dataSource
          .getRepository(NonConformity)
          .findOne({
            where: companyId
              ? { id: documentId, company_id: companyId }
              : { id: documentId },
            select: ['id', 'company_id', 'codigo_nc', 'status', 'updated_at'],
          });
        if (!nonconformity) {
          return null;
        }

        return this.buildEntityBindingContext({
          module,
          documentId: nonconformity.id,
          companyId: nonconformity.company_id,
          reference: nonconformity.codigo_nc,
          status: nonconformity.status,
          version: null,
          updatedAt: nonconformity.updated_at,
        });
      }
      case 'audit': {
        const audit = await this.dataSource.getRepository(Audit).findOne({
          where: companyId
            ? { id: documentId, company_id: companyId }
            : { id: documentId },
          select: ['id', 'company_id', 'titulo', 'updated_at'],
        });
        if (!audit) {
          return null;
        }

        return this.buildEntityBindingContext({
          module,
          documentId: audit.id,
          companyId: audit.company_id,
          reference: audit.titulo,
          status: null,
          version: null,
          updatedAt: audit.updated_at,
        });
      }
      case 'rdo': {
        const rdo = await this.dataSource.getRepository(Rdo).findOne({
          where: companyId
            ? { id: documentId, company_id: companyId }
            : { id: documentId },
          select: ['id', 'company_id', 'numero', 'status', 'updated_at'],
        });
        if (!rdo) {
          return null;
        }

        return this.buildEntityBindingContext({
          module,
          documentId: rdo.id,
          companyId: rdo.company_id,
          reference: rdo.numero,
          status: rdo.status,
          version: null,
          updatedAt: rdo.updated_at,
        });
      }
      case 'photographic_report': {
        // Sem este case o switch cairia no default, a prova degradaria para
        // DOCUMENT_IDENTITY e a assinatura deixaria de vincular à revisão do
        // documento — enfraquecendo em silêncio justamente a afirmação mais
        // forte da feature.
        const report = await this.dataSource
          .getRepository(PhotographicReport)
          .findOne({
            where: companyId
              ? { id: documentId, company_id: companyId }
              : { id: documentId },
            select: [
              'id',
              'company_id',
              'verification_code',
              'status',
              'updated_at',
            ],
          });
        if (!report) {
          return null;
        }

        return this.buildEntityBindingContext({
          module,
          documentId: report.id,
          companyId: report.company_id,
          // Antes da primeira emissão não há verification_code; o id é a
          // referência estável nesse intervalo.
          reference: report.verification_code || report.id,
          status: report.status,
          version: null,
          updatedAt: report.updated_at,
        });
      }
      default:
        return null;
    }
  }

  private assertNoFinalPdfSignatureMutation(input: {
    documentLabel: string;
    hasLegacyPdf: boolean;
    hasGovernedFinalPdf: boolean;
  }) {
    if (!input.hasLegacyPdf && !input.hasGovernedFinalPdf) {
      return;
    }

    throw new BadRequestException(
      `${input.documentLabel} com PDF final emitido está bloqueado para alterações de assinatura.`,
    );
  }

  private buildEntityBindingContext(input: {
    module: string;
    documentId: string;
    companyId: string | null;
    reference: string | null;
    status: string | null;
    version: string | number | null;
    updatedAt: Date | null;
  }) {
    const updatedAtIso = input.updatedAt?.toISOString() || null;
    const stateHash = hashCanonicalSignaturePayload({
      module: input.module,
      document_id: input.documentId,
      company_id: input.companyId,
      reference: input.reference,
      status: input.status,
      version: input.version,
      updated_at: updatedAtIso,
    });

    return {
      reference: input.reference,
      status: input.status,
      version: input.version,
      updatedAt: updatedAtIso,
      stateHash,
    };
  }

  private extractVerificationDetails(
    signature: Signature,
  ): SignatureVerificationDetails {
    const integrityPayload =
      (signature.integrity_payload as Record<string, unknown> | null) || null;
    const documentBinding =
      (integrityPayload?.document_binding as
        Record<string, unknown> | undefined) || undefined;

    const verificationMode = this.isKnownVerificationMode(
      integrityPayload?.verification_mode,
    )
      ? integrityPayload?.verification_mode
      : SIGNATURE_VERIFICATION_MODES.LEGACY_CLIENT_HASH;
    const proofScope = this.isKnownProofScope(integrityPayload?.proof_scope)
      ? integrityPayload?.proof_scope
      : null;
    const legalAssurance = this.isKnownLegalAssurance(
      integrityPayload?.legal_assurance,
    )
      ? integrityPayload?.legal_assurance
      : SIGNATURE_LEGAL_ASSURANCE.NOT_LEGAL_STRONG;

    return {
      verificationMode,
      proofScope,
      legalAssurance,
      canonicalPayloadHash:
        typeof integrityPayload?.canonical_payload_hash === 'string'
          ? integrityPayload.canonical_payload_hash
          : null,
      signatureEvidenceHash:
        typeof integrityPayload?.signature_evidence_hash === 'string'
          ? integrityPayload.signature_evidence_hash
          : null,
      documentBindingHash:
        typeof documentBinding?.binding_hash === 'string'
          ? documentBinding.binding_hash
          : null,
    };
  }

  /**
   * Decides whether to store signature_data inline or offload to S3.
   * Large payloads (base64 images) are uploaded to S3; compact data (HMAC hex,
   * short JSON) stays inline.
   */
  private async resolveSignatureDataStorage(
    documentId: string,
    type: string,
    signatureData: string,
  ): Promise<{ inlineData: string | null; dataKey: string | null }> {
    const byteLength = Buffer.byteLength(signatureData, 'utf8');
    if (byteLength <= SIGNATURE_DATA_S3_THRESHOLD_BYTES) {
      return { inlineData: signatureData, dataKey: null };
    }

    const key = `signatures/${documentId}/${type}-${Date.now()}-${randomUUID()}.dat`;
    try {
      await this.storageService.uploadFile(
        key,
        Buffer.from(signatureData, 'utf8'),
        'application/octet-stream',
      );
      return { inlineData: null, dataKey: key };
    } catch (error) {
      this.logger.warn({
        event: 'signature_data_s3_offload_failed',
        documentId,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallback: keep inline even if large
      return { inlineData: signatureData, dataKey: null };
    }
  }

  /**
   * Resolves the raw signature_data, downloading from S3 if offloaded.
   */
  async resolveSignatureData(signature: Signature): Promise<string | null> {
    if (
      signature.signature_data !== null &&
      signature.signature_data !== undefined
    ) {
      return signature.signature_data;
    }
    if (!signature.signature_data_key) {
      return null;
    }
    try {
      const buf = await this.storageService.downloadFileBuffer(
        signature.signature_data_key,
      );
      return buf.toString('utf8');
    } catch (error) {
      this.logger.warn({
        event: 'signature_data_s3_download_failed',
        signatureId: signature.id,
        key: signature.signature_data_key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private isKnownVerificationMode(
    value: unknown,
  ): value is SignatureVerificationMode {
    return Object.values(SIGNATURE_VERIFICATION_MODES).includes(
      value as SignatureVerificationMode,
    );
  }

  private isKnownProofScope(value: unknown): value is SignatureProofScope {
    return Object.values(SIGNATURE_PROOF_SCOPES).includes(
      value as SignatureProofScope,
    );
  }

  private isKnownLegalAssurance(
    value: unknown,
  ): value is SignatureLegalAssurance {
    return Object.values(SIGNATURE_LEGAL_ASSURANCE).includes(
      value as SignatureLegalAssurance,
    );
  }

  private isPrivilegedRole(roleName?: string | null): boolean {
    if (!roleName) {
      return false;
    }
    const privilegedRoles = new Set<string>([
      Role.ADMIN_GERAL,
      Role.ADMIN_EMPRESA,
      Role.SUPERVISOR,
    ]);
    return privilegedRoles.has(roleName.trim());
  }

  private normalizeLegacyReadDocumentType(documentType: string): string {
    const trimmed = String(documentType || '').trim();
    const normalized = trimmed
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (normalized === 'inspecao') {
      return 'inspection';
    }

    return trimmed;
  }

  private assertDocumentTypeAllowedForNewSignatures(
    documentType: string,
  ): void {
    const normalized = this.normalizeLegacyReadDocumentType(documentType)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (DEPRECATED_SIGNATURE_DOCUMENT_TYPES.has(normalized)) {
      throw new BadRequestException(
        'Novas assinaturas para relatório de inspeção foram descontinuadas. Use um modelo de relatório ativo.',
      );
    }

    if (!ACTIVE_SIGNATURE_DOCUMENT_TYPES.has(normalized)) {
      throw new BadRequestException(
        'document_type inválido para criação de assinatura.',
      );
    }
  }

  /**
   * O `type` determina o rótulo de prova impresso no PDF governado. Sem
   * allowlist, o cliente escolhia esse rótulo: era possível gravar
   * `type: 'digital'` — apresentado como "Assinatura Digital" — sem nenhuma
   * verificação criptográfica. Apenas `hmac` é verificado no servidor.
   */
  private assertSignatureTypeAllowed(type: string): void {
    const normalized = String(type || '').trim();

    if (!isAcceptedSignatureType(normalized)) {
      if (LEGACY_SIGNATURE_TYPES.has(normalized.toLowerCase())) {
        throw new BadRequestException(
          `Tipo de assinatura "${normalized}" foi descontinuado por não representar prova verificada. ` +
            `Use: ${SIGNATURE_TYPE_VALUES.join(', ')}.`,
        );
      }

      throw new BadRequestException(
        `Tipo de assinatura inválido. Use: ${SIGNATURE_TYPE_VALUES.join(', ')}.`,
      );
    }
  }
}

function normalizeModuleFromDocumentType(documentType: string): string {
  const normalized = String(documentType || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

  if (normalized === 'auditoria') {
    return 'audit';
  }

  if (
    normalized === 'nao_conformidade' ||
    normalized === 'nonconformity' ||
    normalized === 'nc'
  ) {
    return 'nonconformity';
  }

  if (normalized === 'inspecao' || normalized === 'inspection') {
    return 'inspection';
  }

  return normalized || 'document';
}
