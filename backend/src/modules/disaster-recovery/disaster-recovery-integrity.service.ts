import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import { AprRiskEvidence } from '../aprs/entities/apr-risk-evidence.entity';
import { Cat } from '../cats/entities/cat.entity';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { DocumentRegistryEntry } from '../document-registry/entities/document-registry.entity';
import { DocumentVideoAttachment } from '../document-videos/entities/document-video-attachment.entity';
import { NonConformity } from '../nonconformities/entities/nonconformity.entity';
import type {
  DisasterRecoveryArtifactInventoryItem,
  DisasterRecoveryIntegrityIssue,
  DisasterRecoveryIntegrityScanOptions,
  DisasterRecoveryIntegrityScanReport,
} from './disaster-recovery.types';
import { resolveDisasterRecoveryEnvironment } from './disaster-recovery.util';

type GovernedNcAttachmentPayload = {
  v: 1;
  kind: 'governed-storage';
  fileKey: string;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  sizeBytes?: number | null;
};

const GOVERNED_ATTACHMENT_REF_PREFIX = 'gst:nc-attachment:';

@Injectable()
export class DisasterRecoveryIntegrityService {
  private readonly logger = new Logger(DisasterRecoveryIntegrityService.name);

  constructor(
    @InjectRepository(DocumentRegistryEntry)
    private readonly registryRepository: Repository<DocumentRegistryEntry>,
    @InjectRepository(DocumentVideoAttachment)
    private readonly documentVideoRepository: Repository<DocumentVideoAttachment>,
    @InjectRepository(Cat)
    private readonly catRepository: Repository<Cat>,
    @InjectRepository(NonConformity)
    private readonly nonConformityRepository: Repository<NonConformity>,
    @InjectRepository(AprRiskEvidence)
    private readonly aprEvidenceRepository: Repository<AprRiskEvidence>,
    private readonly documentStorageService: DocumentStorageService,
  ) {}

  async scan(
    options: DisasterRecoveryIntegrityScanOptions = {},
  ): Promise<DisasterRecoveryIntegrityScanReport> {
    const startedAt = new Date();
    const environment = resolveDisasterRecoveryEnvironment(
      process.env.DR_ENVIRONMENT_NAME,
      process.env.NODE_ENV,
    );
    const storageTarget =
      this.documentStorageService.getStorageConfigurationSummary();
    const issues: DisasterRecoveryIntegrityIssue[] = [];
    const inventory: DisasterRecoveryArtifactInventoryItem[] = [];
    const referencedKeys = new Set<string>();

    const storageConfigured = this.documentStorageService.isStorageConfigured();
    if (!storageConfigured) {
      issues.push({
        severity: 'critical',
        issueType: 'storage_backend_unavailable',
        module: 'system',
        companyId: null,
        entityId: null,
        fileKey: null,
        message:
          'Storage governado não está configurado. Não é possível validar a integridade física dos artefatos.',
      });
    }

    await this.scanRegistryDocuments(
      options,
      issues,
      inventory,
      referencedKeys,
      storageConfigured,
    );
    await this.scanVideos(
      options,
      issues,
      inventory,
      referencedKeys,
      storageConfigured,
    );
    await this.scanCatAttachments(
      options,
      issues,
      inventory,
      referencedKeys,
      storageConfigured,
    );
    await this.scanNonConformityAttachments(
      options,
      issues,
      inventory,
      referencedKeys,
      storageConfigured,
    );
    await this.scanAprEvidences(
      options,
      issues,
      inventory,
      referencedKeys,
      storageConfigured,
    );

    const orphanKeys =
      storageConfigured && options.includeOrphans
        ? await this.scanOrphans(referencedKeys)
        : [];

    for (const orphanKey of orphanKeys) {
      issues.push({
        severity: 'high',
        issueType: 'storage_orphan_artifact',
        module: this.inferModuleFromKey(orphanKey),
        companyId: this.inferCompanyIdFromKey(orphanKey),
        entityId: null,
        fileKey: orphanKey,
        message:
          'Artefato físico sem referência governada conhecida. Revisar retenção, exclusão ou registry.',
      });
    }

    const completedAt = new Date();
    return {
      summary: {
        environment,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        degraded: issues.some((issue) => issue.severity === 'critical'),
        storageConfigured,
        storageTarget,
        scannedRegistryDocuments: inventory.filter(
          (item) => item.source === 'registry',
        ).length,
        scannedGovernedVideos: inventory.filter(
          (item) => item.source === 'video',
        ).length,
        scannedGovernedAttachments: inventory.filter(
          (item) =>
            item.source === 'cat_attachment' ||
            item.source === 'nonconformity_attachment',
        ).length,
        scannedAprEvidences: inventory.filter(
          (item) => item.source === 'apr_evidence',
        ).length,
        orphanArtifactsFound: orphanKeys.length,
        criticalIssues: issues.filter((issue) => issue.severity === 'critical')
          .length,
        highIssues: issues.filter((issue) => issue.severity === 'high').length,
        mediumIssues: issues.filter((issue) => issue.severity === 'medium')
          .length,
        lowIssues: issues.filter((issue) => issue.severity === 'low').length,
      },
      issues,
      inventory,
      orphanKeys,
      scannedPrefixes: options.includeOrphans ? ['documents/', 'cats/'] : [],
    };
  }

  private async scanRegistryDocuments(
    options: DisasterRecoveryIntegrityScanOptions,
    issues: DisasterRecoveryIntegrityIssue[],
    inventory: DisasterRecoveryArtifactInventoryItem[],
    referencedKeys: Set<string>,
    storageConfigured: boolean,
  ): Promise<void> {
    const where = options.companyId ? { company_id: options.companyId } : {};
    const entries = await this.registryRepository.find({
      where,
      order: { updated_at: 'DESC' },
      ...(options.limitPerSource ? { take: options.limitPerSource } : {}),
    });

    for (const entry of entries) {
      inventory.push({
        source: 'registry',
        module: entry.module,
        companyId: entry.company_id,
        entityId: entry.entity_id,
        fileKey: entry.file_key,
        expectedHash: entry.file_hash,
        expectedAvailability: 'governed',
        metadata: {
          documentType: entry.document_type,
          documentCode: entry.document_code,
          title: entry.title,
          mimeType: entry.mime_type,
          originalName: entry.original_name,
        },
      });
      referencedKeys.add(entry.file_key);

      if (!storageConfigured) {
        continue;
      }

      const exists = await this.safeFileExists(
        entry.company_id,
        entry.file_key,
      );
      if (!exists) {
        issues.push({
          severity: 'critical',
          issueType: 'registry_missing_artifact',
          module: entry.module,
          companyId: entry.company_id,
          entityId: entry.entity_id,
          fileKey: entry.file_key,
          expectedHash: entry.file_hash,
          message:
            'Documento oficial está no registry, mas o artefato físico não foi encontrado no storage governado.',
          metadata: {
            documentType: entry.document_type,
            documentCode: entry.document_code,
          },
        });
        continue;
      }

      if (options.verifyHashes && entry.file_hash) {
        const actualHash = await this.safeComputeHash(
          entry.company_id,
          entry.file_key,
        );
        if (actualHash && actualHash !== entry.file_hash) {
          issues.push({
            severity: 'critical',
            issueType: 'registry_hash_mismatch',
            module: entry.module,
            companyId: entry.company_id,
            entityId: entry.entity_id,
            fileKey: entry.file_key,
            expectedHash: entry.file_hash,
            actualHash,
            message:
              'Documento oficial localizado, mas o hash restaurado não confere com o registry.',
            metadata: {
              documentType: entry.document_type,
              documentCode: entry.document_code,
            },
          });
        }
      }
    }
  }

  private async scanVideos(
    options: DisasterRecoveryIntegrityScanOptions,
    issues: DisasterRecoveryIntegrityIssue[],
    inventory: DisasterRecoveryArtifactInventoryItem[],
    referencedKeys: Set<string>,
    storageConfigured: boolean,
  ): Promise<void> {
    const where = {
      removed_at: IsNull(),
      ...(options.companyId ? { company_id: options.companyId } : {}),
    };
    const attachments = await this.documentVideoRepository.find({
      where,
      order: { created_at: 'DESC' },
      ...(options.limitPerSource ? { take: options.limitPerSource } : {}),
    });

    for (const attachment of attachments) {
      inventory.push({
        source: 'video',
        module: attachment.module,
        companyId: attachment.company_id,
        entityId: attachment.document_id,
        fileKey: attachment.storage_key,
        expectedHash: attachment.file_hash,
        expectedAvailability: attachment.availability,
        metadata: {
          attachmentId: attachment.id,
          processingStatus: attachment.processing_status,
          originalName: attachment.original_name,
          mimeType: attachment.mime_type,
        },
      });
      referencedKeys.add(attachment.storage_key);

      if (!storageConfigured) {
        continue;
      }

      const exists = await this.safeFileExists(
        attachment.company_id,
        attachment.storage_key,
      );
      if (!exists) {
        issues.push({
          severity: 'high',
          issueType: 'video_missing_artifact',
          module: attachment.module,
          companyId: attachment.company_id,
          entityId: attachment.document_id,
          fileKey: attachment.storage_key,
          expectedHash: attachment.file_hash,
          message:
            'Vídeo governado referenciado no banco não foi encontrado no storage governado.',
          metadata: {
            attachmentId: attachment.id,
            availability: attachment.availability,
          },
        });
      }
    }
  }

  private async scanCatAttachments(
    options: DisasterRecoveryIntegrityScanOptions,
    issues: DisasterRecoveryIntegrityIssue[],
    inventory: DisasterRecoveryArtifactInventoryItem[],
    referencedKeys: Set<string>,
    storageConfigured: boolean,
  ): Promise<void> {
    const cats = await this.catRepository.find({
      where: options.companyId ? { company_id: options.companyId } : {},
      order: { updated_at: 'DESC' },
      ...(options.limitPerSource ? { take: options.limitPerSource } : {}),
    });

    for (const cat of cats) {
      for (const attachment of cat.attachments || []) {
        inventory.push({
          source: 'cat_attachment',
          module: 'cat',
          companyId: cat.company_id,
          entityId: cat.id,
          fileKey: attachment.file_key,
          expectedHash: attachment.file_hash || null,
          expectedAvailability: 'governed',
          metadata: {
            attachmentId: attachment.id,
            category: attachment.category,
            fileName: attachment.file_name,
            mimeType: attachment.file_type,
          },
        });
        referencedKeys.add(attachment.file_key);

        if (!storageConfigured) {
          continue;
        }

        const exists = await this.safeFileExists(
          cat.company_id,
          attachment.file_key,
        );
        if (!exists) {
          issues.push({
            severity: 'high',
            issueType: 'attachment_missing_artifact',
            module: 'cat',
            companyId: cat.company_id,
            entityId: cat.id,
            fileKey: attachment.file_key,
            expectedHash: attachment.file_hash || null,
            message: 'Anexo governado de CAT não foi encontrado no storage.',
            metadata: {
              attachmentId: attachment.id,
              category: attachment.category,
            },
          });
        }
      }
    }
  }

  private async scanNonConformityAttachments(
    options: DisasterRecoveryIntegrityScanOptions,
    issues: DisasterRecoveryIntegrityIssue[],
    inventory: DisasterRecoveryArtifactInventoryItem[],
    referencedKeys: Set<string>,
    storageConfigured: boolean,
  ): Promise<void> {
    const ncs = await this.nonConformityRepository.find({
      where: {
        deleted_at: IsNull(),
        ...(options.companyId ? { company_id: options.companyId } : {}),
      },
      order: { updated_at: 'DESC' },
      ...(options.limitPerSource ? { take: options.limitPerSource } : {}),
    });

    for (const nc of ncs) {
      for (const attachment of this.getGovernedNcAttachments(nc.anexos)) {
        inventory.push({
          source: 'nonconformity_attachment',
          module: 'nonconformity',
          companyId: nc.company_id,
          entityId: nc.id,
          fileKey: attachment.fileKey,
          expectedAvailability: 'governed',
          metadata: {
            originalName: attachment.originalName,
            mimeType: attachment.mimeType,
            uploadedAt: attachment.uploadedAt,
          },
        });
        referencedKeys.add(attachment.fileKey);

        if (!storageConfigured) {
          continue;
        }

        const exists = await this.safeFileExists(
          nc.company_id,
          attachment.fileKey,
        );
        if (!exists) {
          issues.push({
            severity: 'high',
            issueType: 'attachment_missing_artifact',
            module: 'nonconformity',
            companyId: nc.company_id,
            entityId: nc.id,
            fileKey: attachment.fileKey,
            message:
              'Anexo governado de não conformidade não foi encontrado no storage.',
            metadata: {
              originalName: attachment.originalName,
              mimeType: attachment.mimeType,
            },
          });
        }
      }
    }
  }

  private async scanAprEvidences(
    options: DisasterRecoveryIntegrityScanOptions,
    issues: DisasterRecoveryIntegrityIssue[],
    inventory: DisasterRecoveryArtifactInventoryItem[],
    referencedKeys: Set<string>,
    storageConfigured: boolean,
  ): Promise<void> {
    const qb = this.aprEvidenceRepository
      .createQueryBuilder('evidence')
      .leftJoinAndSelect('evidence.apr', 'apr')
      .orderBy('evidence.uploaded_at', 'DESC');

    if (options.companyId) {
      qb.where('apr.company_id = :companyId', { companyId: options.companyId });
    }

    if (options.limitPerSource) {
      qb.take(options.limitPerSource);
    }

    const evidences = await qb.getMany();

    for (const evidence of evidences) {
      const companyId =
        evidence.apr && 'company_id' in evidence.apr
          ? (evidence.apr as { company_id?: string }).company_id || null
          : null;

      inventory.push({
        source: 'apr_evidence',
        module: 'apr',
        companyId,
        entityId: evidence.apr_id,
        fileKey: evidence.file_key,
        expectedHash: evidence.hash_sha256,
        expectedAvailability: 'governed',
        metadata: {
          evidenceId: evidence.id,
          kind: 'original',
          originalName: evidence.original_name,
          mimeType: evidence.mime_type,
        },
      });
      referencedKeys.add(evidence.file_key);

      if (evidence.watermarked_file_key) {
        inventory.push({
          source: 'apr_evidence',
          module: 'apr',
          companyId,
          entityId: evidence.apr_id,
          fileKey: evidence.watermarked_file_key,
          expectedHash: evidence.watermarked_hash_sha256,
          expectedAvailability: 'governed',
          metadata: {
            evidenceId: evidence.id,
            kind: 'watermarked',
            originalName: evidence.original_name,
            mimeType: evidence.mime_type,
          },
        });
        referencedKeys.add(evidence.watermarked_file_key);
      }

      if (!storageConfigured) {
        continue;
      }

      const originalExists = await this.safeFileExists(
        companyId,
        evidence.file_key,
      );
      if (!originalExists) {
        issues.push({
          severity: 'high',
          issueType: 'apr_evidence_missing_artifact',
          module: 'apr',
          companyId,
          entityId: evidence.apr_id,
          fileKey: evidence.file_key,
          expectedHash: evidence.hash_sha256,
          message: 'Evidência governada da APR não foi encontrada no storage.',
          metadata: {
            evidenceId: evidence.id,
            kind: 'original',
          },
        });
      } else if (options.verifyHashes && evidence.hash_sha256) {
        const actualHash = await this.safeComputeHash(
          companyId,
          evidence.file_key,
        );
        if (actualHash && actualHash !== evidence.hash_sha256) {
          issues.push({
            severity: 'high',
            issueType: 'apr_evidence_hash_mismatch',
            module: 'apr',
            companyId,
            entityId: evidence.apr_id,
            fileKey: evidence.file_key,
            expectedHash: evidence.hash_sha256,
            actualHash,
            message:
              'Hash da evidência da APR não confere com o valor persistido.',
            metadata: {
              evidenceId: evidence.id,
              kind: 'original',
            },
          });
        }
      }

      if (evidence.watermarked_file_key) {
        const watermarkedExists = await this.safeFileExists(
          companyId,
          evidence.watermarked_file_key,
        );
        if (!watermarkedExists) {
          issues.push({
            severity: 'medium',
            issueType: 'apr_evidence_missing_artifact',
            module: 'apr',
            companyId,
            entityId: evidence.apr_id,
            fileKey: evidence.watermarked_file_key,
            expectedHash: evidence.watermarked_hash_sha256,
            message:
              'Versão com watermark da evidência da APR não foi encontrada no storage.',
            metadata: {
              evidenceId: evidence.id,
              kind: 'watermarked',
            },
          });
        }
      }
    }
  }

  private async scanOrphans(referencedKeys: Set<string>): Promise<string[]> {
    const prefixes = ['documents/', 'cats/'];
    const orphanKeys = new Set<string>();

    for (const prefix of prefixes) {
      const keys = await this.documentStorageService.listKeysPrivileged(
        prefix,
        { resourceType: 'disaster-recovery', resourceId: 'storage-orphans' },
        'disaster-recovery-storage-orphan-scan',
        { maxKeys: 5000 },
      );
      for (const key of keys) {
        if (!referencedKeys.has(key)) {
          orphanKeys.add(key);
        }
      }
    }

    return Array.from(orphanKeys).sort();
  }

  private getGovernedNcAttachments(
    values?: string[] | null,
  ): GovernedNcAttachmentPayload[] {
    return (values ?? []).flatMap((value) => {
      if (
        typeof value !== 'string' ||
        !value.startsWith(GOVERNED_ATTACHMENT_REF_PREFIX)
      ) {
        return [];
      }

      try {
        const payload = JSON.parse(
          Buffer.from(
            value.slice(GOVERNED_ATTACHMENT_REF_PREFIX.length),
            'base64url',
          ).toString('utf8'),
        ) as GovernedNcAttachmentPayload;
        if (
          payload?.v === 1 &&
          payload.kind === 'governed-storage' &&
          typeof payload.fileKey === 'string'
        ) {
          return [payload];
        }
      } catch (error) {
        this.logger.warn(
          `Falha ao interpretar referência governada de NC durante scanner de DR: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return [];
    });
  }

  private async safeFileExists(
    tenantId: string | null,
    key: string,
  ): Promise<boolean> {
    try {
      if (!tenantId) return false;
      return await this.documentStorageService.fileExistsPrivileged({
        tenantId,
        key,
        owner: {
          resourceType: 'disaster-recovery',
          resourceId: 'integrity-scan',
        },
        purpose: 'disaster-recovery-integrity',
      });
    } catch (error) {
      this.logger.warn({
        event: 'dr_storage_exists_probe_failed',
        keyFingerprint: this.storageDiagnosticFingerprint(key),
        errorName: error instanceof Error ? error.name : 'unknown_error',
      });
      return false;
    }
  }

  private async safeComputeHash(
    tenantId: string | null,
    key: string,
  ): Promise<string | null> {
    try {
      if (!tenantId) return null;
      const buffer =
        await this.documentStorageService.downloadFileBufferPrivileged({
          tenantId,
          key,
          owner: {
            resourceType: 'disaster-recovery',
            resourceId: 'integrity-scan',
          },
          purpose: 'disaster-recovery-integrity',
        });
      return createHash('sha256').update(buffer).digest('hex');
    } catch (error) {
      this.logger.warn({
        event: 'dr_storage_hash_probe_failed',
        keyFingerprint: this.storageDiagnosticFingerprint(key),
        errorName: error instanceof Error ? error.name : 'unknown_error',
      });
      return null;
    }
  }

  private storageDiagnosticFingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  private inferModuleFromKey(key: string): string {
    if (key.startsWith('documents/')) {
      const [, , module] = key.split('/');
      return module || 'documents';
    }
    if (key.startsWith('cats/')) {
      return 'cat';
    }
    return 'storage';
  }

  private inferCompanyIdFromKey(key: string): string | null {
    if (key.startsWith('documents/')) {
      return key.split('/')[1] || null;
    }
    if (key.startsWith('cats/')) {
      return key.split('/')[1] || null;
    }
    return null;
  }
}
