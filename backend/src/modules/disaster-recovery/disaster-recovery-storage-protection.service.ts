import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import type {
  DisasterRecoveryArtifactInventoryItem,
  DisasterRecoveryStorageProtectionItem,
  DisasterRecoveryStorageProtectionReport,
} from './disaster-recovery.types';
import { resolveDisasterRecoveryEnvironment } from './disaster-recovery.util';
import { DisasterRecoveryExecutionService } from './disaster-recovery-execution.service';
import { DisasterRecoveryIntegrityService } from './disaster-recovery-integrity.service';
import { DisasterRecoveryReplicaStorageService } from './disaster-recovery-replica-storage.service';
import { TenantService } from '../../shared/tenant/tenant.service';

type ReplicateGovernedArtifactsOptions = {
  dryRun?: boolean;
  triggerSource: string;
  requestedByUserId?: string | null;
  artifactPath?: string | null;
  companyId?: string;
  limitPerSource?: number;
  forceReplace?: boolean;
};

const isMissingArtifactIssueType = (issueType: string): boolean =>
  [
    'registry_missing_artifact',
    'video_missing_artifact',
    'attachment_missing_artifact',
    'apr_evidence_missing_artifact',
  ].includes(issueType);

@Injectable()
export class DisasterRecoveryStorageProtectionService {
  private readonly logger = new Logger(
    DisasterRecoveryStorageProtectionService.name,
  );

  constructor(
    private readonly executionService: DisasterRecoveryExecutionService,
    private readonly integrityService: DisasterRecoveryIntegrityService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly replicaStorageService: DisasterRecoveryReplicaStorageService,
    private readonly tenantService: TenantService,
  ) {}

  async replicateGovernedArtifacts(
    options: ReplicateGovernedArtifactsOptions,
  ): Promise<DisasterRecoveryStorageProtectionReport> {
    const startedAt = new Date();
    const environment = resolveDisasterRecoveryEnvironment(
      process.env.DR_ENVIRONMENT_NAME,
      process.env.NODE_ENV,
    );
    const dryRun = Boolean(options.dryRun);
    const source = this.documentStorageService.getStorageConfigurationSummary();
    const replica = this.replicaStorageService.getConfigurationSummary();
    const report: DisasterRecoveryStorageProtectionReport = {
      summary: {
        environment,
        startedAt: startedAt.toISOString(),
        completedAt: startedAt.toISOString(),
        dryRun,
        replicaConfigured: replica.configured,
        sourceStorageConfigured:
          this.documentStorageService.isStorageConfigured(),
        totalInventory: 0,
        copied: 0,
        skippedExisting: 0,
        sourceMissing: 0,
        failed: 0,
      },
      source,
      replica: {
        ...replica,
        strategy: 'secondary_bucket_replication',
      },
      notes: [],
      items: [],
    };

    if (!report.summary.sourceStorageConfigured) {
      report.notes.push(
        'Storage governado principal não está configurado. A proteção do storage não pode ser executada.',
      );
      report.summary.failed = 1;
      report.summary.completedAt = new Date().toISOString();
      return report;
    }

    if (!replica.configured) {
      report.notes.push(
        'Bucket secundário de réplica não está configurado. Defina DR_STORAGE_REPLICA_BUCKET e credenciais compatíveis.',
      );
      report.summary.failed = 1;
      report.summary.completedAt = new Date().toISOString();
      return report;
    }

    const integrity = await this.integrityService.scan({
      companyId: options.companyId,
      includeOrphans: false,
      limitPerSource: options.limitPerSource,
      verifyHashes: false,
    });

    const missingSourceKeys = new Set(
      integrity.issues
        .filter(
          (issue) =>
            issue.fileKey && isMissingArtifactIssueType(issue.issueType),
        )
        .map((issue) => issue.fileKey as string),
    );

    report.summary.totalInventory = integrity.inventory.length;

    let executionId: string | null = null;
    if (!dryRun) {
      const execution = await this.executionService.startExecution({
        operationType: 'storage_replication',
        scope: 'storage',
        environment,
        triggerSource: options.triggerSource,
        requestedByUserId: options.requestedByUserId,
        artifactPath: options.artifactPath ?? null,
        metadata: {
          companyId: options.companyId || null,
          limitPerSource: options.limitPerSource ?? null,
          forceReplace: options.forceReplace ?? false,
          replicaBucket: replica.bucketName,
          sourceBucket: source.bucketName,
        },
      });
      executionId = execution.id;
    } else {
      report.notes.push(
        'Dry-run executado. Nenhuma cópia física para o bucket secundário foi realizada.',
      );
    }

    try {
      for (const inventoryItem of integrity.inventory) {
        const result = await this.replicateItem({
          inventoryItem,
          sourceMissing: missingSourceKeys.has(inventoryItem.fileKey),
          dryRun,
          forceReplace: options.forceReplace ?? false,
        });
        report.items.push(result);

        switch (result.action) {
          case 'copied':
            report.summary.copied += 1;
            break;
          case 'skipped_existing':
            report.summary.skippedExisting += 1;
            break;
          case 'source_missing':
            report.summary.sourceMissing += 1;
            break;
          case 'failed':
            report.summary.failed += 1;
            break;
          default:
            break;
        }
      }

      report.summary.completedAt = new Date().toISOString();

      if (executionId) {
        await this.executionService.finalizeExecution(executionId, {
          status: report.summary.failed > 0 ? 'partial' : 'success',
          artifactPath: options.artifactPath ?? null,
          metadata: {
            summary: report.summary,
            replicaBucket: replica.bucketName,
            sourceBucket: source.bucketName,
          },
        });
      }

      this.logger.log({
        event: 'dr_storage_replication_completed',
        environment,
        dryRun,
        summary: report.summary,
        replicaBucket: replica.bucketName,
      });

      return report;
    } catch (error) {
      report.summary.completedAt = new Date().toISOString();
      report.summary.failed += 1;
      report.notes.push(
        error instanceof Error
          ? error.message
          : 'Falha desconhecida na replicação do storage governado.',
      );

      if (executionId) {
        await this.executionService.finalizeExecution(executionId, {
          status: 'failed',
          artifactPath: options.artifactPath ?? null,
          errorMessage:
            error instanceof Error
              ? error.message
              : 'storage_replication_failed',
          metadata: {
            summary: report.summary,
          },
        });
      }

      throw error;
    }
  }

  private async replicateItem(input: {
    inventoryItem: DisasterRecoveryArtifactInventoryItem;
    sourceMissing: boolean;
    dryRun: boolean;
    forceReplace: boolean;
  }): Promise<DisasterRecoveryStorageProtectionItem> {
    const contentType = this.resolveContentType(input.inventoryItem);
    const base: DisasterRecoveryStorageProtectionItem = {
      fileKey: input.inventoryItem.fileKey,
      module: input.inventoryItem.module,
      companyId: input.inventoryItem.companyId,
      entityId: input.inventoryItem.entityId,
      sourceExists: !input.sourceMissing,
      replicaExistsBefore: false,
      replicaExistsAfter: false,
      action: 'planned',
      contentType,
      sha256: input.inventoryItem.expectedHash ?? null,
      sizeBytes: null,
      message: 'Replicação planejada.',
    };

    if (input.sourceMissing) {
      return {
        ...base,
        action: 'source_missing',
        message:
          'Artefato de origem ausente no storage principal. Nada foi replicado.',
      };
    }

    const replicaExistsBefore = await this.replicaStorageService.fileExists(
      input.inventoryItem.fileKey,
    );

    if (replicaExistsBefore && !input.forceReplace) {
      return {
        ...base,
        replicaExistsBefore: true,
        replicaExistsAfter: true,
        action: input.dryRun ? 'planned' : 'skipped_existing',
        message: input.dryRun
          ? 'Artefato já existe na réplica e seria preservado sem overwrite.'
          : 'Artefato já existente na réplica foi preservado sem overwrite.',
      };
    }

    if (input.dryRun) {
      return {
        ...base,
        replicaExistsBefore,
        action: 'planned',
        message: replicaExistsBefore
          ? 'Artefato existente na réplica seria sobrescrito somente se forceReplace=true.'
          : 'Artefato seria copiado para o bucket secundário.',
      };
    }

    try {
      const buffer = await this.tenantService.run(
        {
          companyId: input.inventoryItem.companyId ?? undefined,
          isSuperAdmin: true,
          siteScope: 'all',
        },
        () =>
          this.documentStorageService.downloadFileBufferPrivileged({
            tenantId: input.inventoryItem.companyId || '',
            key: input.inventoryItem.fileKey,
            owner: {
              resourceType: 'disaster-recovery',
              resourceId: 'storage-replication',
            },
            purpose: 'disaster-recovery-replication',
          }),
      );
      const sha256 = createHash('sha256').update(buffer).digest('hex');

      await this.replicaStorageService.uploadBuffer({
        key: input.inventoryItem.fileKey,
        buffer,
        contentType,
        metadata: {
          'dr-source-environment':
            process.env.DR_ENVIRONMENT_NAME ||
            process.env.NODE_ENV ||
            'unknown',
          'dr-source-key': input.inventoryItem.fileKey,
          'dr-replicated-at': new Date().toISOString(),
          'dr-sha256': sha256,
        },
      });

      const replicaExistsAfter = await this.replicaStorageService.fileExists(
        input.inventoryItem.fileKey,
      );

      return {
        ...base,
        replicaExistsBefore,
        replicaExistsAfter,
        action: 'copied',
        sha256,
        sizeBytes: buffer.byteLength,
        message: 'Artefato replicado com sucesso para o bucket secundário.',
      };
    } catch (error) {
      return {
        ...base,
        replicaExistsBefore,
        replicaExistsAfter: false,
        action: 'failed',
        message:
          error instanceof Error
            ? error.message
            : 'Falha desconhecida na replicação do artefato.',
      };
    }
  }

  private resolveContentType(
    item: DisasterRecoveryArtifactInventoryItem,
  ): string {
    const metadata = item.metadata || {};
    const mimeType = metadata['mimeType'];
    return typeof mimeType === 'string' && mimeType.trim().length > 0
      ? mimeType
      : 'application/octet-stream';
  }
}
