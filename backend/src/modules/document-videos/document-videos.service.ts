import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { randomUUID } from 'node:crypto';
import { storageKeyFingerprint } from '../../shared/storage/storage-compensation.util';
import * as path from 'path';
import { IsNull, Repository } from 'typeorm';
import { cleanupUploadedFile } from '../../shared/storage/storage-compensation.util';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import {
  DOCUMENT_VIDEO_MODULES,
  DocumentVideoAttachment,
  type DocumentVideoModule,
} from './entities/document-video-attachment.entity';
import {
  GOVERNED_VIDEO_ALLOWED_MIME_TYPES,
  GOVERNED_VIDEO_MAX_FILE_SIZE_BYTES,
} from './document-video.constants';

export type DocumentVideoAccessAvailability =
  'ready' | 'registered_without_signed_url';

export type DocumentVideoAttachmentAccessResponse = {
  entityId: string;
  attachmentId: string;
  availability: DocumentVideoAccessAvailability;
  url: string | null;
  message: string | null;
  video: DocumentVideoAttachment;
};

export type DocumentVideoAttachmentMutationResponse = {
  entityId: string;
  attachments: DocumentVideoAttachment[];
  attachmentCount: number;
  storageMode: 'governed-storage';
  degraded: false;
  message: string;
  attachment: DocumentVideoAttachment;
};

type UploadVideoAttachmentInput = {
  companyId: string;
  module: DocumentVideoModule;
  documentType?: DocumentVideoModule;
  documentId: string;
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  uploadedById?: string | null;
  durationSeconds?: number | null;
};

type ScopedAttachmentInput = {
  companyId: string;
  module: DocumentVideoModule;
  documentId: string;
  attachmentId: string;
};

@Injectable()
export class DocumentVideosService {
  private readonly logger = new Logger(DocumentVideosService.name);

  constructor(
    @InjectRepository(DocumentVideoAttachment)
    private readonly documentVideoRepository: Repository<DocumentVideoAttachment>,
    private readonly documentStorageService: DocumentStorageService,
    private readonly forensicTrailService: ForensicTrailService,
  ) {}

  async listByDocument(input: {
    companyId: string;
    module: DocumentVideoModule;
    documentId: string;
  }): Promise<DocumentVideoAttachment[]> {
    this.assertSupportedModule(input.module);
    return this.documentVideoRepository.find({
      where: {
        company_id: input.companyId,
        module: input.module,
        document_id: input.documentId,
        removed_at: IsNull(),
      },
      order: {
        uploaded_at: 'DESC',
        created_at: 'DESC',
      },
    });
  }

  async uploadForDocument(
    input: UploadVideoAttachmentInput,
  ): Promise<DocumentVideoAttachmentMutationResponse> {
    this.assertSupportedModule(input.module);
    this.assertVideoPayload(input.buffer, input.mimeType);

    const safeOriginalName = this.sanitizeOriginalName(input.originalName);
    const fileHash = createHash('sha256').update(input.buffer).digest('hex');
    const fileKey = this.documentStorageService.generateDocumentKey(
      input.companyId,
      `${input.module}-videos`,
      input.documentId,
      safeOriginalName,
    );
    const attachmentId = randomUUID();

    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.createReference({
          tenantId: input.companyId,
          key: fileKey,
          owner: { resourceType: 'document-video', resourceId: attachmentId },
          purpose: 'document-video',
        }),
        input.buffer,
        input.mimeType,
      );

    const uploadedAt = new Date();
    const attachment = this.documentVideoRepository.create({
      id: attachmentId,
      company_id: input.companyId,
      module: input.module,
      document_type: input.documentType || input.module,
      document_id: input.documentId,
      original_name: safeOriginalName,
      mime_type: input.mimeType,
      size_bytes: input.buffer.byteLength,
      file_hash: fileHash,
      storage_key: fileKey,
      uploaded_by_id: input.uploadedById || null,
      uploaded_at: uploadedAt,
      duration_seconds: input.durationSeconds ?? null,
      processing_status: 'ready',
      availability: 'stored',
    });

    try {
      const saved = await this.documentVideoRepository.save(attachment);
      await this.forensicTrailService.append({
        eventType: FORENSIC_EVENT_TYPES.VIDEO_ATTACHMENT_UPLOADED,
        module: input.module,
        entityId: input.documentId,
        companyId: input.companyId,
        userId: input.uploadedById || undefined,
        metadata: {
          attachmentId: saved.id,
          originalName: saved.original_name,
          mimeType: saved.mime_type,
          sizeBytes: saved.size_bytes,
          keyFingerprint: storageKeyFingerprint(saved.storage_key),
          fileHash: saved.file_hash,
          processingStatus: saved.processing_status,
          availability: saved.availability,
        },
      });
      this.logger.log({
        event: 'document_video_uploaded',
        module: input.module,
        entityId: input.documentId,
        companyId: input.companyId,
        attachmentId: saved.id,
        keyFingerprint: storageKeyFingerprint(saved.storage_key),
        mimeType: saved.mime_type,
        sizeBytes: saved.size_bytes,
        userId: input.uploadedById || undefined,
      });

      const attachments = await this.listByDocument({
        companyId: input.companyId,
        module: input.module,
        documentId: input.documentId,
      });

      return {
        entityId: input.documentId,
        attachments,
        attachmentCount: attachments.length,
        storageMode: 'governed-storage',
        degraded: false,
        message: 'Vídeo governado anexado ao documento com sucesso.',
        attachment: saved,
      };
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `document-video:${input.module}:${input.documentId}`,
        fileKey,
        (key) =>
          key === uploadedReference.key
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      throw error;
    }
  }

  async getAccess(
    input: ScopedAttachmentInput,
  ): Promise<DocumentVideoAttachmentAccessResponse> {
    this.assertSupportedModule(input.module);
    const attachment = await this.findActiveAttachmentOrThrow(input);

    try {
      const url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          attachment.storage_key,
          {
            resourceType: 'document-video',
            resourceId: attachment.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
      );
      await this.forensicTrailService.append({
        eventType: FORENSIC_EVENT_TYPES.VIDEO_ATTACHMENT_ACCESSED,
        module: input.module,
        entityId: input.documentId,
        companyId: input.companyId,
        metadata: {
          attachmentId: attachment.id,
          keyFingerprint: storageKeyFingerprint(attachment.storage_key),
          mimeType: attachment.mime_type,
          availability: 'ready',
        },
      });
      this.logger.log({
        event: 'document_video_access_resolved',
        module: input.module,
        entityId: input.documentId,
        companyId: input.companyId,
        attachmentId: attachment.id,
        availability: 'ready',
      });
      return {
        entityId: input.documentId,
        attachmentId: attachment.id,
        availability: 'ready',
        url,
        message: null,
        video: attachment,
      };
    } catch (error) {
      await this.documentVideoRepository.update(
        { id: attachment.id },
        { availability: 'registered_without_signed_url' },
      );
      await this.forensicTrailService.append({
        eventType: FORENSIC_EVENT_TYPES.VIDEO_ATTACHMENT_ACCESSED,
        module: input.module,
        entityId: input.documentId,
        companyId: input.companyId,
        metadata: {
          attachmentId: attachment.id,
          keyFingerprint: storageKeyFingerprint(attachment.storage_key),
          mimeType: attachment.mime_type,
          availability: 'registered_without_signed_url',
          errorName: error instanceof Error ? error.name : 'unknown_error',
        },
      });
      this.logger.warn({
        event: 'document_video_access_storage_degraded',
        module: input.module,
        entityId: input.documentId,
        companyId: input.companyId,
        attachmentId: attachment.id,
        errorName: error instanceof Error ? error.name : 'unknown_error',
      });
      return {
        entityId: input.documentId,
        attachmentId: attachment.id,
        availability: 'registered_without_signed_url',
        url: null,
        message:
          'Vídeo registrado, mas a URL segura do storage não está disponível no momento.',
        video: {
          ...attachment,
          availability: 'registered_without_signed_url',
        },
      };
    }
  }

  async removeFromDocument(
    input: ScopedAttachmentInput & { removedById?: string | null },
  ): Promise<DocumentVideoAttachmentMutationResponse> {
    this.assertSupportedModule(input.module);
    const attachment = await this.findActiveAttachmentOrThrow(input);

    attachment.removed_at = new Date();
    attachment.removed_by_id = input.removedById || null;
    attachment.availability = 'removed';
    const savedAttachment = await this.documentVideoRepository.save(attachment);

    let storageCleanup: 'deleted' | 'pending_manual_cleanup' = 'deleted';
    try {
      await this.documentStorageService.deleteFile(
        this.documentStorageService.referenceForExistingObject(
          attachment.storage_key,
          {
            resourceType: 'document-video',
            resourceId: attachment.id,
          },
          'p1-document-storage-deleteFile',
        ),
      );
    } catch (error) {
      storageCleanup = 'pending_manual_cleanup';
      this.logger.warn({
        event: 'document_video_storage_cleanup_failed',
        module: input.module,
        entityId: input.documentId,
        companyId: input.companyId,
        attachmentId: attachment.id,
        keyFingerprint: storageKeyFingerprint(attachment.storage_key),
        errorName: error instanceof Error ? error.name : 'unknown_error',
      });
    }

    await this.forensicTrailService.append({
      eventType: FORENSIC_EVENT_TYPES.VIDEO_ATTACHMENT_REMOVED,
      module: input.module,
      entityId: input.documentId,
      companyId: input.companyId,
      userId: input.removedById || undefined,
      metadata: {
        attachmentId: attachment.id,
        keyFingerprint: storageKeyFingerprint(attachment.storage_key),
        mimeType: attachment.mime_type,
        storageCleanup,
      },
    });
    this.logger.log({
      event: 'document_video_removed',
      module: input.module,
      entityId: input.documentId,
      companyId: input.companyId,
      attachmentId: attachment.id,
      storageCleanup,
      userId: input.removedById || undefined,
    });

    const attachments = await this.listByDocument({
      companyId: input.companyId,
      module: input.module,
      documentId: input.documentId,
    });

    return {
      entityId: input.documentId,
      attachments,
      attachmentCount: attachments.length,
      storageMode: 'governed-storage',
      degraded: false,
      message: 'Vídeo removido da lista ativa do documento.',
      attachment: savedAttachment,
    };
  }

  private assertSupportedModule(
    module: string,
  ): asserts module is DocumentVideoModule {
    if (!DOCUMENT_VIDEO_MODULES.includes(module as DocumentVideoModule)) {
      throw new BadRequestException('Módulo de vídeo governado inválido.');
    }
  }

  private assertVideoPayload(buffer: Buffer, mimeType: string): void {
    if (!buffer?.length) {
      throw new BadRequestException('Arquivo de vídeo não enviado.');
    }

    if (!GOVERNED_VIDEO_ALLOWED_MIME_TYPES.includes(mimeType as never)) {
      throw new BadRequestException('Tipo de vídeo não permitido.');
    }

    if (buffer.byteLength > GOVERNED_VIDEO_MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `Vídeo excede o limite de ${(GOVERNED_VIDEO_MAX_FILE_SIZE_BYTES / 1024 / 1024).toFixed(0)} MB.`,
      );
    }
  }

  private sanitizeOriginalName(originalName?: string): string {
    const baseName = path.basename(
      String(originalName || 'video-evidencia.mp4'),
    );
    const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
    return sanitized || 'video-evidencia.mp4';
  }

  private async findActiveAttachmentOrThrow(
    input: ScopedAttachmentInput,
  ): Promise<DocumentVideoAttachment> {
    const attachment = await this.documentVideoRepository.findOne({
      where: {
        id: input.attachmentId,
        company_id: input.companyId,
        module: input.module,
        document_id: input.documentId,
        removed_at: IsNull(),
      },
    });

    if (!attachment) {
      throw new NotFoundException(
        'Vídeo anexado não encontrado para o documento solicitado.',
      );
    }

    return attachment;
  }
}
