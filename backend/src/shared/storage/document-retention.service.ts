import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentStorageService } from '../services/document-storage.service';
import {
  DocumentRegistryEntry,
  DocumentRegistryStatus,
} from '../../modules/document-registry/entities/document-registry.entity';
import { ForensicTrailService } from '../../modules/forensic-trail/forensic-trail.service';
import { storageKeyFingerprint } from './storage-compensation.util';

@Injectable()
export class DocumentRetentionService {
  private readonly logger = new Logger(DocumentRetentionService.name);

  constructor(
    @InjectRepository(DocumentRegistryEntry)
    private readonly documentRegistryRepository: Repository<DocumentRegistryEntry>,
    private readonly documentStorageService: DocumentStorageService,
    private readonly forensicTrailService: ForensicTrailService,
  ) {}

  async getExpiredDocuments(
    tenantId: string,
  ): Promise<DocumentRegistryEntry[]> {
    return this.documentRegistryRepository
      .createQueryBuilder('document')
      .where('document.company_id = :tenantId', { tenantId })
      .andWhere('document.status = :status', {
        status: DocumentRegistryStatus.ACTIVE,
      })
      .andWhere('document.litigation_hold = false')
      .andWhere('document.expires_at IS NOT NULL')
      .andWhere('document.expires_at <= NOW()')
      .orderBy('document.expires_at', 'ASC')
      .getMany();
  }

  async scheduleExpiry(documentId: string, expiresAt: Date): Promise<void> {
    await this.documentRegistryRepository.update(
      { id: documentId },
      {
        expires_at: expiresAt,
      },
    );
  }

  async executeExpiry(documentId: string): Promise<void> {
    const registryEntry = await this.documentRegistryRepository.findOne({
      where: { id: documentId },
    });

    if (!registryEntry) {
      return;
    }

    if (registryEntry.litigation_hold) {
      this.logger.warn(
        `Retention skip (litigation hold) document=${registryEntry.id} company=${registryEntry.company_id}`,
      );
      return;
    }

    if (registryEntry.status === DocumentRegistryStatus.EXPIRED) {
      return;
    }

    await this.documentStorageService.deleteFile(
      this.documentStorageService.referenceForExistingObject(
        registryEntry.file_key,
        {
          resourceType: registryEntry.module,
          resourceId: registryEntry.entity_id,
        },
        `document-registry:${registryEntry.module}:pdf`,
      ),
    );

    await this.documentRegistryRepository.update(
      { id: registryEntry.id },
      {
        status: DocumentRegistryStatus.EXPIRED,
      },
    );

    await this.forensicTrailService.append({
      eventType: 'DOCUMENT_EXPIRED',
      module: registryEntry.module,
      entityId: registryEntry.entity_id,
      companyId: registryEntry.company_id,
      metadata: {
        registryEntryId: registryEntry.id,
        documentType: registryEntry.document_type,
        documentCode: registryEntry.document_code,
        keyFingerprint: storageKeyFingerprint(registryEntry.file_key),
        expiresAt: registryEntry.expires_at?.toISOString() || null,
      },
    });
  }

  async executeTenantExpiry(tenantId: string): Promise<{
    expired: number;
    failed: number;
  }> {
    const expiredDocuments = await this.getExpiredDocuments(tenantId);

    let expired = 0;
    let failed = 0;

    for (const entry of expiredDocuments) {
      try {
        await this.executeExpiry(entry.id);
        expired += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Retention failed document=${entry.id} company=${tenantId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return { expired, failed };
  }
}
