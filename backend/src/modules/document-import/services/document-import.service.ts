import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { FindOptionsWhere, QueryFailedError, Repository } from 'typeorm';
import { TenantService } from '../../../shared/tenant/tenant.service';
import { DdsService } from '../../dds/dds.service';
import { withDefaultJobOptions } from '../../../infra/queue/default-job-options';
import { DocumentImportStatus } from '../entities/document-import-status.enum';
import {
  DocumentImport,
  DocumentImportMetadata,
} from '../entities/document-import.entity';
import {
  DocumentAnalysisDto,
  DocumentImportMetadataDto,
  DocumentValidationResultDto,
  toDocumentAnalysisResponseDto,
} from '../dto/document-analysis.dto';
import {
  DocumentImportEnqueueResponseDto,
  DocumentImportStatusResponseDto,
  toDocumentImportEnqueueResponseDto,
  toDocumentImportStatusResponseDto,
} from '../dto/document-import-queue.dto';
import {
  CreateDdsDraftFromImportDto,
  CreateDdsDraftFromImportResponseDto,
  DdsDraftFromImportResponseDto,
} from '../dto/dds-draft-from-import.dto';
import { FileParserService } from './file-parser.service';
import { DocumentClassifierService } from './document-classifier.service';
import { DocumentInterpreterService } from './document-interpreter.service';
import { DocumentValidationService } from './document-validation.service';
import { DocumentStorageService } from '../../../shared/services/document-storage.service';
import {
  getDocumentImportJobAttempts,
  getDocumentImportJobTimeoutMs,
} from '../document-import-runtime-config';

type DocumentImportQueueJobData = {
  documentId: string;
  companyId: string;
  requestedByUserId?: string;
};

type ProcessQueuedDocumentOptions = {
  /** Permite chamada externa apenas após revalidação de consentimento no worker. */
  allowExternalAi?: boolean;
};

type QueueSnapshot = {
  jobId?: string | null;
  queueState?: string | null;
  attemptsMade?: number;
  maxAttempts?: number;
  lastAttemptAt?: Date | string | null;
  deadLettered?: boolean;
};

type DedupeSource = 'idempotency_key' | 'file_hash';
type ReplayState = 'new' | 'in_progress' | 'completed' | 'failed';

const documentImportJobOptions = withDefaultJobOptions({
  attempts: getDocumentImportJobAttempts(),
  timeout: getDocumentImportJobTimeoutMs(),
});

@Injectable()
export class DocumentImportService {
  private readonly logger = new Logger(DocumentImportService.name);

  constructor(
    @InjectRepository(DocumentImport)
    private readonly documentImportRepository: Repository<DocumentImport>,
    private readonly fileParserService: FileParserService,
    private readonly documentClassifierService: DocumentClassifierService,
    private readonly documentInterpreterService: DocumentInterpreterService,
    private readonly documentValidationService: DocumentValidationService,
    private readonly ddsService: DdsService,
    private readonly tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
    @InjectQueue('document-import')
    private readonly documentImportQueue: Queue,
  ) {}

  async enqueueDocumentProcessing(
    fileBuffer: Buffer,
    empresaId: string,
    tipoDocumentoManual?: string,
    mimetype = 'application/pdf',
    originalname = 'document.pdf',
    requestedByUserId?: string,
    idempotencyKey?: string,
  ): Promise<DocumentImportEnqueueResponseDto> {
    this.assertTenantAccess(empresaId);
    this.logger.log(
      `Enfileirando importação documental para empresa: ${empresaId}`,
    );

    const normalizedIdempotencyKey =
      this.normalizeIdempotencyKey(idempotencyKey);
    const hash = this.fileParserService.generateFileHash(fileBuffer);

    if (normalizedIdempotencyKey) {
      const existingByIdempotencyKey = await this.findByIdempotencyKey(
        empresaId,
        normalizedIdempotencyKey,
      );

      if (existingByIdempotencyKey) {
        if (existingByIdempotencyKey.hash !== hash) {
          throw new ConflictException(
            'A mesma Idempotency-Key já foi utilizada para outro arquivo.',
          );
        }

        return this.buildReplayEnqueueResponse(
          existingByIdempotencyKey,
          'idempotency_key',
        );
      }
    }

    const existingByHash = await this.documentImportRepository.findOne({
      where: { hash, empresaId },
    });

    if (existingByHash) {
      return this.buildReplayEnqueueResponse(existingByHash, 'file_hash');
    }

    const documentImportId = randomUUID();
    const stagingKey = await this.uploadStagingFile(
      empresaId,
      hash,
      fileBuffer,
      mimetype,
      documentImportId,
    );

    const documentImport = this.documentImportRepository.create({
      id: documentImportId,
      empresaId,
      hash,
      idempotencyKey: normalizedIdempotencyKey,
      status: DocumentImportStatus.UPLOADED,
      nomeArquivo: originalname || `upload_${Date.now()}.pdf`,
      tipoDocumento: tipoDocumentoManual || 'DESCONHECIDO',
      tamanho: fileBuffer.length,
      mimeType: mimetype,
      arquivoStaging: null,
      arquivoStagingKey: stagingKey,
      processingAttempts: 0,
      metadata: {
        queue: {
          timeoutMs: getDocumentImportJobTimeoutMs(),
          attempts: getDocumentImportJobAttempts(),
        },
      },
    });

    let persisted: DocumentImport;
    try {
      persisted = await this.documentImportRepository.save(documentImport);
    } catch (error) {
      if (this.isDuplicateImportError(error)) {
        const replayCandidate = await this.findReplayCandidate(
          empresaId,
          hash,
          normalizedIdempotencyKey,
        );

        if (replayCandidate) {
          if (
            normalizedIdempotencyKey &&
            replayCandidate.record.idempotencyKey ===
              normalizedIdempotencyKey &&
            replayCandidate.record.hash !== hash
          ) {
            throw new ConflictException(
              'A mesma Idempotency-Key já foi utilizada para outro arquivo.',
            );
          }

          return this.buildReplayEnqueueResponse(
            replayCandidate.record,
            replayCandidate.source,
          );
        }

        throw new BadRequestException(
          'Este documento já foi importado anteriormente para esta empresa.',
        );
      }
      throw error;
    }

    const statusUrl = this.buildStatusUrl(persisted.id);
    const processingJobId = this.buildProcessingJobId(persisted.id);
    const preEnqueueMetadata = this.mergeMetadata(persisted.metadata, {
      queue: {
        statusUrl,
        timeoutMs: getDocumentImportJobTimeoutMs(),
        attempts: getDocumentImportJobAttempts(),
        lastQueueState: 'enqueueing',
      },
    });

    try {
      await this.documentImportRepository.update(
        { id: persisted.id, empresaId },
        {
          status: DocumentImportStatus.QUEUED,
          processingJobId,
          metadata: preEnqueueMetadata,
        },
      );
      persisted.status = DocumentImportStatus.QUEUED;
      persisted.processingJobId = processingJobId;
      persisted.metadata = preEnqueueMetadata;
    } catch (error) {
      await this.deleteAbandonedImportRecord(persisted.id, empresaId);

      throw new ServiceUnavailableException({
        message:
          'Não foi possível preparar a operação para a fila de importação.',
        documentId: persisted.id,
        statusUrl,
        details: {
          stage: 'pre_enqueue_persist',
          errorName: error instanceof Error ? error.name : 'unknown_error',
        },
      });
    }

    try {
      const job = await this.documentImportQueue.add(
        'process-document-import',
        {
          documentId: persisted.id,
          companyId: empresaId,
          requestedByUserId,
        } satisfies DocumentImportQueueJobData,
        {
          ...documentImportJobOptions,
          jobId: processingJobId,
        },
      );
      const resolvedJobId = String(job.id);

      try {
        const queuedMetadata = this.mergeMetadata(persisted.metadata, {
          queue: {
            statusUrl,
            enqueuedAt: new Date().toISOString(),
            timeoutMs: getDocumentImportJobTimeoutMs(),
            attempts: getDocumentImportJobAttempts(),
            lastQueueState: 'waiting',
          },
        });

        await this.documentImportRepository.update(
          { id: persisted.id, empresaId },
          {
            processingJobId: resolvedJobId,
            metadata: queuedMetadata,
          },
        );
        persisted.processingJobId = resolvedJobId;
        persisted.metadata = queuedMetadata;
      } catch (metadataError) {
        this.logger.warn(
          `Job ${resolvedJobId} foi enfileirado para ${persisted.id}, mas a persistência pós-enqueue falhou: ${
            metadataError instanceof Error
              ? metadataError.message
              : String(metadataError)
          }`,
        );
      }

      return toDocumentImportEnqueueResponseDto({
        documentId: persisted.id,
        status: DocumentImportStatus.QUEUED,
        statusUrl,
        job: {
          jobId: resolvedJobId,
          queueState: 'waiting',
          attemptsMade: 0,
          maxAttempts: getDocumentImportJobAttempts(),
          deadLettered: false,
        },
        reused: false,
        replayState: 'new',
        idempotencyKey: normalizedIdempotencyKey,
        message: 'Documento recebido e enviado para processamento assíncrono.',
      });
    } catch (error) {
      const queueFailureMessage =
        error instanceof Error
          ? error.message
          : 'Fila de importação indisponível no momento.';

      await this.markAsFailed(persisted.id, empresaId, queueFailureMessage, {
        clearStaging: true,
        status: DocumentImportStatus.FAILED,
        queueState: 'enqueue_failed',
      });

      throw new ServiceUnavailableException({
        message:
          'Fila de importação indisponível. O documento não foi processado.',
        documentId: persisted.id,
        statusUrl,
        details: {
          queue: 'document-import',
          error: queueFailureMessage,
        },
      });
    }
  }

  async processQueuedDocument(
    documentId: string,
    options: ProcessQueuedDocumentOptions = {},
  ): Promise<DocumentImportStatusResponseDto> {
    const record = await this.getDocumentForProcessing(documentId);

    if (!record) {
      throw new NotFoundException(
        `Importação ${documentId} não encontrada para processamento.`,
      );
    }

    if (record.status === DocumentImportStatus.COMPLETED) {
      return this.buildStatusResponse(record, {
        queueState: 'completed',
        jobId: record.processingJobId,
        attemptsMade: record.processingAttempts,
        maxAttempts: getDocumentImportJobAttempts(),
        lastAttemptAt: record.lastAttemptAt,
        deadLettered: false,
      });
    }

    const stagingBuffer = await this.resolveStagingBuffer(record);
    if (!stagingBuffer || stagingBuffer.length === 0) {
      throw new ServiceUnavailableException(
        'Arquivo de staging não está disponível para processamento assíncrono.',
      );
    }

    await this.registerProcessingAttemptStart(record, {
      queue: {
        lastQueueState: 'active',
      },
    });

    try {
      const textoExtraido = await this.fileParserService.extractText(
        stagingBuffer,
        record.mimeType || 'application/pdf',
        record.nomeArquivo || 'document.pdf',
      );

      const classification =
        await this.documentClassifierService.classifyDocument(textoExtraido, {
          useExternalAi: options.allowExternalAi === true,
        });

      const tipoDocumentoFinal =
        record.tipoDocumento && record.tipoDocumento !== 'DESCONHECIDO'
          ? record.tipoDocumento
          : classification.tipoDocumento;

      await this.updateRecordWithClassification(
        record.id,
        record.empresaId,
        tipoDocumentoFinal,
        classification.score,
        textoExtraido,
      );

      await this.transitionStatus(record, DocumentImportStatus.INTERPRETING, {
        queue: {
          lastQueueState: 'active',
        },
      });

      const analysis = await this.documentInterpreterService.interpretDocument(
        textoExtraido,
        tipoDocumentoFinal,
        { useExternalAi: options.allowExternalAi === true },
      );

      await this.transitionStatus(record, DocumentImportStatus.VALIDATING, {
        queue: {
          lastQueueState: 'active',
        },
      });

      const validation =
        this.documentValidationService.validateDocument(analysis);

      await this.updateRecordWithAnalysis(
        record.id,
        record.empresaId,
        analysis,
        validation,
        textoExtraido,
      );

      const completedRecord = await this.getDocumentStatusEntity(
        record.id,
        record.empresaId,
      );

      if (!completedRecord) {
        throw new UnprocessableEntityException(
          `Importação ${record.id} não encontrada após conclusão do processamento.`,
        );
      }

      return this.buildStatusResponse(completedRecord, {
        jobId: completedRecord.processingJobId,
        queueState: 'completed',
        attemptsMade: completedRecord.processingAttempts,
        maxAttempts: getDocumentImportJobAttempts(),
        lastAttemptAt: completedRecord.lastAttemptAt,
        deadLettered: false,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Erro desconhecido';
      await this.registerAttemptFailure(
        record.id,
        record.empresaId,
        errorMessage,
      );
      throw error;
    }
  }

  async markAsDeadLetter(
    documentId: string,
    companyId: string,
    errorMessage: string,
    queueState = 'dead_letter',
  ): Promise<void> {
    await this.markAsFailed(documentId, companyId, errorMessage, {
      status: DocumentImportStatus.DEAD_LETTER,
      queueState,
      deadLetteredAt: new Date(),
      clearStaging: false,
    });
  }

  async getDocumentStatusResponse(
    documentId: string,
    tenantId: string,
  ): Promise<DocumentImportStatusResponseDto | null> {
    const record = await this.getDocumentStatusEntity(documentId, tenantId);

    if (!record) {
      return null;
    }

    const queueSnapshot = await this.resolveQueueSnapshot(record);
    return this.buildStatusResponse(record, queueSnapshot);
  }

  async getDocumentStatus(
    documentId: string,
    tenantId: string,
  ): Promise<DocumentImport | null> {
    return this.getDocumentStatusEntity(documentId, tenantId);
  }

  async getDdsDraftPreview(
    documentId: string,
    tenantId: string,
  ): Promise<DdsDraftFromImportResponseDto | null> {
    const record = await this.getDocumentStatusEntity(documentId, tenantId);

    if (!record) {
      return null;
    }

    this.assertImportReadyForDdsDraft(record);
    return {
      documentId: record.id,
      preview: this.buildDdsDraftPreview(record),
    };
  }

  async createDdsDraftFromImport(
    documentId: string,
    tenantId: string,
    dto: CreateDdsDraftFromImportDto,
  ): Promise<CreateDdsDraftFromImportResponseDto | null> {
    const record = await this.getDocumentStatusEntity(documentId, tenantId);

    if (!record) {
      return null;
    }

    this.assertImportReadyForDdsDraft(record);

    const existingDdsId = this.readAutoCreatedDdsId(record.metadata);
    if (existingDdsId) {
      const existingDds = await this.tenantService.run(
        {
          companyId: record.empresaId,
          isSuperAdmin: false,
          siteScope: 'all',
        },
        () => this.ddsService.findOne(existingDdsId),
      );

      return {
        documentId: record.id,
        ddsId: existingDds.id,
        status: existingDds.status,
      };
    }

    const dds = await this.tenantService.run(
      {
        companyId: record.empresaId,
        isSuperAdmin: false,
        siteScope: 'all',
      },
      () =>
        this.ddsService.create({
          tema: dto.tema,
          conteudo: dto.conteudo,
          data: dto.data,
          site_id: dto.site_id,
          facilitador_id: dto.facilitador_id,
          participants: dto.participants,
        }),
    );

    const existingMetadata = record.metadata || {};
    await this.documentImportRepository.update(
      { id: record.id, empresaId: record.empresaId },
      {
        metadata: this.mergeMetadata(existingMetadata, {
          autoCreatedDdsId: dds.id,
          autoCreateDds: {
            state: 'created',
            requestedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            ddsId: dds.id,
          },
        }),
      },
    );

    return {
      documentId: record.id,
      ddsId: dds.id,
      status: dds.status,
    };
  }

  async retryDocumentProcessing(
    documentId: string,
    requestedByUserId?: string,
  ): Promise<DocumentImportEnqueueResponseDto> {
    const record = await this.getDocumentForProcessing(documentId);

    if (!record) {
      throw new NotFoundException('Importação documental não encontrada.');
    }

    this.assertTenantAccess(record.empresaId);

    if (record.status !== DocumentImportStatus.DEAD_LETTER) {
      throw new ConflictException(
        'Somente importações em dead-letter podem ser reenfileiradas com segurança.',
      );
    }

    if (
      !record.arquivoStagingKey &&
      (!record.arquivoStaging || record.arquivoStaging.length === 0)
    ) {
      throw new ConflictException(
        'O arquivo de staging não está mais disponível para reenfileirar esta importação.',
      );
    }

    const statusUrl = this.buildStatusUrl(record.id);
    const retryRequestedAt = new Date().toISOString();
    const retryJobId = this.buildRetryJobId(record.id);
    const preEnqueueMetadata = this.mergeMetadata(record.metadata, {
      queue: {
        statusUrl,
        timeoutMs: getDocumentImportJobTimeoutMs(),
        attempts: getDocumentImportJobAttempts(),
        lastQueueState: 'retry_enqueueing',
        retryRequestedAt,
      },
    });

    await this.documentImportRepository.update(
      { id: record.id, empresaId: record.empresaId },
      {
        status: DocumentImportStatus.QUEUED,
        processingJobId: retryJobId,
        mensagemErro: null,
        deadLetteredAt: null,
        metadata: preEnqueueMetadata,
      },
    );

    try {
      const job = await this.documentImportQueue.add(
        'process-document-import',
        {
          documentId: record.id,
          companyId: record.empresaId,
          requestedByUserId,
        } satisfies DocumentImportQueueJobData,
        {
          ...documentImportJobOptions,
          jobId: retryJobId,
        },
      );

      const resolvedJobId = String(job.id);
      const queuedMetadata = this.mergeMetadata(preEnqueueMetadata, {
        queue: {
          statusUrl,
          timeoutMs: getDocumentImportJobTimeoutMs(),
          attempts: getDocumentImportJobAttempts(),
          lastQueueState: 'waiting',
          retryRequestedAt,
          enqueuedAt: new Date().toISOString(),
        },
      });

      await this.documentImportRepository.update(
        { id: record.id, empresaId: record.empresaId },
        {
          processingJobId: resolvedJobId,
          metadata: queuedMetadata,
        },
      );

      this.logger.log(
        `Importação ${record.id} reenfileirada com sucesso para empresa ${record.empresaId}.`,
      );

      return toDocumentImportEnqueueResponseDto({
        documentId: record.id,
        status: DocumentImportStatus.QUEUED,
        statusUrl,
        job: {
          jobId: resolvedJobId,
          queueState: 'waiting',
          attemptsMade: record.processingAttempts || 0,
          maxAttempts: getDocumentImportJobAttempts(),
          lastAttemptAt: record.lastAttemptAt,
          deadLettered: false,
        },
        queued: true,
        reused: false,
        replayState: 'new',
        idempotencyKey: record.idempotencyKey,
        message: 'Importação reenfileirada para nova tentativa operacional.',
      });
    } catch (error) {
      const queueFailureMessage =
        error instanceof Error
          ? error.message
          : 'Fila de importação indisponível no momento.';

      await this.markAsFailed(
        record.id,
        record.empresaId,
        `Não foi possível reenfileirar a importação: ${queueFailureMessage}`,
        {
          status: DocumentImportStatus.DEAD_LETTER,
          queueState: 'retry_enqueue_failed',
          deadLetteredAt: new Date(),
          clearStaging: false,
        },
      );

      throw new ServiceUnavailableException({
        message:
          'Fila de importação indisponível. A operação continuou em dead-letter.',
        documentId: record.id,
        statusUrl,
        details: {
          queue: 'document-import',
          error: queueFailureMessage,
        },
      });
    }
  }

  async getDocumentsByEmpresa(empresaId: string): Promise<DocumentImport[]> {
    this.assertTenantAccess(empresaId);
    return this.documentImportRepository.find({
      where: { empresaId },
      order: { createdAt: 'DESC' },
    });
  }

  async getDocumentsByStatus(
    status: DocumentImportStatus,
  ): Promise<DocumentImport[]> {
    const tenantId = this.tenantService.getTenantId();
    if (!this.tenantService.isSuperAdmin() && !tenantId) {
      throw new ForbiddenException('Contexto de empresa não definido.');
    }

    const where: FindOptionsWhere<DocumentImport> = tenantId
      ? { status, empresaId: tenantId }
      : { status };

    return this.documentImportRepository.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  private normalizeIdempotencyKey(idempotencyKey?: string): string | undefined {
    if (typeof idempotencyKey !== 'string') {
      return undefined;
    }

    const trimmed = idempotencyKey.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private buildProcessingJobId(documentId: string): string {
    return `document-import-${this.toSafeJobToken(documentId)}`;
  }

  private buildRetryJobId(documentId: string): string {
    return `document-import-${this.toSafeJobToken(documentId)}-retry-${Date.now()}`;
  }

  private toSafeJobToken(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  private async findByIdempotencyKey(
    empresaId: string,
    idempotencyKey: string,
  ): Promise<DocumentImport | null> {
    return this.documentImportRepository.findOne({
      where: { empresaId, idempotencyKey },
    });
  }

  private async findReplayCandidate(
    empresaId: string,
    hash: string,
    idempotencyKey?: string,
  ): Promise<{ record: DocumentImport; source: DedupeSource } | null> {
    if (idempotencyKey) {
      const recordByKey = await this.findByIdempotencyKey(
        empresaId,
        idempotencyKey,
      );

      if (recordByKey) {
        return {
          record: recordByKey,
          source: 'idempotency_key',
        };
      }
    }

    const recordByHash = await this.documentImportRepository.findOne({
      where: { empresaId, hash },
    });

    if (!recordByHash) {
      return null;
    }

    return {
      record: recordByHash,
      source: 'file_hash',
    };
  }

  private async deleteAbandonedImportRecord(
    documentId: string,
    empresaId: string,
  ): Promise<void> {
    try {
      await this.documentImportRepository.delete({ id: documentId, empresaId });
    } catch (error) {
      this.logger.warn(
        `Falha ao remover importação abandonada ${documentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private assertTenantAccess(empresaId: string) {
    const tenantId = this.tenantService.getTenantId();
    const isSuperAdmin = this.tenantService.isSuperAdmin();

    if (!isSuperAdmin && !tenantId) {
      throw new ForbiddenException(
        'Contexto de tenant ausente para operação sensível de importação.',
      );
    }

    if (!isSuperAdmin && tenantId && empresaId !== tenantId) {
      throw new ForbiddenException('Acesso cross-tenant negado.');
    }
  }

  private createStatusQueryBuilder(documentId: string) {
    return this.documentImportRepository
      .createQueryBuilder('documentImport')
      .where('documentImport.id = :documentId', { documentId });
  }

  private async getDocumentForProcessing(documentId: string) {
    return this.createStatusQueryBuilder(documentId)
      .addSelect('documentImport.arquivoStaging')
      .getOne();
  }

  private async getDocumentStatusEntity(
    documentId: string,
    tenantId: string,
  ): Promise<DocumentImport | null> {
    return this.createStatusQueryBuilder(documentId)
      .andWhere('documentImport.empresaId = :tenantId', { tenantId })
      .getOne();
  }

  private async resolveQueueSnapshot(
    record: DocumentImport,
  ): Promise<QueueSnapshot> {
    const fallbackAttempts = record.processingAttempts || 0;
    const maxAttempts =
      record.metadata?.queue?.attempts || getDocumentImportJobAttempts();

    if (!record.processingJobId) {
      return {
        jobId: null,
        queueState: this.deriveQueueStateFromStatus(record.status),
        attemptsMade: fallbackAttempts,
        maxAttempts,
        lastAttemptAt: record.lastAttemptAt,
        deadLettered: record.status === DocumentImportStatus.DEAD_LETTER,
      };
    }

    try {
      const job = await this.documentImportQueue.getJob(record.processingJobId);
      if (!job) {
        return {
          jobId: record.processingJobId,
          queueState: this.deriveQueueStateFromStatus(record.status),
          attemptsMade: fallbackAttempts,
          maxAttempts,
          lastAttemptAt: record.lastAttemptAt,
          deadLettered: record.status === DocumentImportStatus.DEAD_LETTER,
        };
      }

      return {
        jobId: String(job.id),
        queueState: await job.getState(),
        attemptsMade: Math.max(fallbackAttempts, job.attemptsMade),
        maxAttempts: job.opts.attempts ?? maxAttempts,
        lastAttemptAt: record.lastAttemptAt,
        deadLettered: record.status === DocumentImportStatus.DEAD_LETTER,
      };
    } catch (error) {
      this.logger.warn(
        `Falha ao consultar job ${record.processingJobId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        jobId: record.processingJobId,
        queueState: 'unknown',
        attemptsMade: fallbackAttempts,
        maxAttempts,
        lastAttemptAt: record.lastAttemptAt,
        deadLettered: record.status === DocumentImportStatus.DEAD_LETTER,
      };
    }
  }

  private buildStatusResponse(
    record: DocumentImport,
    queueSnapshot: QueueSnapshot,
  ): DocumentImportStatusResponseDto {
    const validation = record.metadata?.validacao as
      DocumentValidationResultDto | undefined;

    return toDocumentImportStatusResponseDto({
      documentId: record.id,
      status: record.status,
      statusUrl: this.buildStatusUrl(record.id),
      tipoDocumento: record.tipoDocumento || undefined,
      tipoDocumentoDescricao:
        this.documentClassifierService.getDocumentTypeDescription(
          record.tipoDocumento || 'DESCONHECIDO',
        ),
      analysis: record.jsonEstruturado || undefined,
      validation,
      metadata: this.buildMetadataDto(record),
      job: queueSnapshot,
      message: this.buildStatusMessage(record, queueSnapshot.queueState),
    });
  }

  private async buildReplayEnqueueResponse(
    record: DocumentImport,
    dedupeSource: DedupeSource,
  ): Promise<DocumentImportEnqueueResponseDto> {
    const queueSnapshot = await this.resolveQueueSnapshot(record);
    const replayState = this.deriveReplayState(record.status);
    const queued =
      replayState === 'new' || replayState === 'in_progress'
        ? record.status !== DocumentImportStatus.COMPLETED &&
          record.status !== DocumentImportStatus.FAILED &&
          record.status !== DocumentImportStatus.DEAD_LETTER
        : false;

    return toDocumentImportEnqueueResponseDto({
      documentId: record.id,
      status: record.status,
      statusUrl: this.buildStatusUrl(record.id),
      job: queueSnapshot,
      queued,
      reused: true,
      replayState,
      dedupeSource,
      idempotencyKey: record.idempotencyKey,
      message: this.buildReplayMessage(record, dedupeSource, replayState),
    });
  }

  private buildMetadataDto(record: DocumentImport): DocumentImportMetadataDto {
    const validacao = record.metadata?.validacao as
      DocumentValidationResultDto | undefined;

    return {
      tamanhoArquivo: record.tamanho || 0,
      quantidadeTexto: Number(
        record.metadata?.quantidadeTexto || record.textoExtraido?.length || 0,
      ),
      hash: record.hash,
      timestamp: record.createdAt.toISOString(),
      scoreClassificacao: record.metadata?.scoreClassificacao,
      textoExtraidoLength:
        typeof record.textoExtraido === 'string'
          ? record.textoExtraido.length
          : undefined,
      validacao,
      erro: record.mensagemErro || record.metadata?.erro,
      timestampFalha: record.metadata?.timestampFalha,
      status: record.status,
      autoCreateDds: record.metadata?.autoCreateDds
        ? {
            state: record.metadata.autoCreateDds.state || 'pending',
            requestedAt: record.metadata.autoCreateDds.requestedAt,
            completedAt: record.metadata.autoCreateDds.completedAt,
            ddsId: record.metadata.autoCreateDds.ddsId ?? null,
            error: record.metadata.autoCreateDds.error,
          }
        : undefined,
    };
  }

  private buildStatusMessage(
    record: DocumentImport,
    queueState?: string | null,
  ): string {
    switch (record.status) {
      case DocumentImportStatus.QUEUED:
        return queueState === 'delayed'
          ? 'Importação aguardando nova tentativa automática na fila.'
          : 'Documento recebido e aguardando processamento na fila.';
      case DocumentImportStatus.PROCESSING:
        return 'Documento em extração de conteúdo.';
      case DocumentImportStatus.INTERPRETING:
        return 'Documento em interpretação semântica.';
      case DocumentImportStatus.VALIDATING:
        return 'Documento em validação estrutural.';
      case DocumentImportStatus.COMPLETED:
        return 'Documento processado com sucesso.';
      case DocumentImportStatus.DEAD_LETTER:
        return (
          record.mensagemErro ||
          'Importação falhou definitivamente e foi direcionada ao DLQ.'
        );
      case DocumentImportStatus.FAILED:
        return (
          record.mensagemErro || 'Importação falhou antes do processamento.'
        );
      default:
        return 'Documento recebido.';
    }
  }

  private buildReplayMessage(
    _record: DocumentImport,
    dedupeSource: DedupeSource,
    replayState: ReplayState,
  ): string {
    const sourceLabel =
      dedupeSource === 'idempotency_key'
        ? 'Idempotency-Key'
        : 'hash do arquivo';

    switch (replayState) {
      case 'completed':
        return `Esta operação já foi concluída anteriormente e foi reutilizada pelo ${sourceLabel}.`;
      case 'failed':
        return `Esta operação já falhou anteriormente e não foi reenfileirada. Reutilização detectada pelo ${sourceLabel}.`;
      case 'in_progress':
        return `Esta operação já está em andamento e foi reutilizada pelo ${sourceLabel}.`;
      default:
        return `Esta operação já foi registrada anteriormente e foi reutilizada pelo ${sourceLabel}.`;
    }
  }

  private deriveReplayState(status: DocumentImportStatus): ReplayState {
    switch (status) {
      case DocumentImportStatus.COMPLETED:
        return 'completed';
      case DocumentImportStatus.FAILED:
      case DocumentImportStatus.DEAD_LETTER:
        return 'failed';
      case DocumentImportStatus.QUEUED:
      case DocumentImportStatus.PROCESSING:
      case DocumentImportStatus.INTERPRETING:
      case DocumentImportStatus.VALIDATING:
        return 'in_progress';
      default:
        return 'new';
    }
  }

  private deriveQueueStateFromStatus(status: DocumentImportStatus): string {
    switch (status) {
      case DocumentImportStatus.QUEUED:
        return 'waiting';
      case DocumentImportStatus.PROCESSING:
      case DocumentImportStatus.INTERPRETING:
      case DocumentImportStatus.VALIDATING:
        return 'active';
      case DocumentImportStatus.COMPLETED:
        return 'completed';
      case DocumentImportStatus.DEAD_LETTER:
        return 'dead_letter';
      case DocumentImportStatus.FAILED:
        return 'failed';
      default:
        return 'uploaded';
    }
  }

  private async transitionStatus(
    record: DocumentImport,
    status: DocumentImportStatus,
    metadataPatch?: Partial<DocumentImportMetadata>,
  ) {
    await this.documentImportRepository.update(
      { id: record.id, empresaId: record.empresaId },
      {
        status,
        metadata: this.mergeMetadata(record.metadata, metadataPatch),
      },
    );

    record.status = status;
    record.metadata = this.mergeMetadata(record.metadata, metadataPatch);
  }

  private async registerProcessingAttemptStart(
    record: DocumentImport,
    metadataPatch?: Partial<DocumentImportMetadata>,
  ) {
    const attempts = (record.processingAttempts || 0) + 1;
    const lastAttemptAt = new Date();

    await this.documentImportRepository.update(
      { id: record.id, empresaId: record.empresaId },
      {
        status: DocumentImportStatus.PROCESSING,
        processingAttempts: attempts,
        lastAttemptAt,
        metadata: this.mergeMetadata(record.metadata, metadataPatch),
      },
    );

    record.status = DocumentImportStatus.PROCESSING;
    record.processingAttempts = attempts;
    record.lastAttemptAt = lastAttemptAt;
    record.metadata = this.mergeMetadata(record.metadata, metadataPatch);
  }

  private async updateRecordWithClassification(
    documentId: string,
    empresaId: string,
    tipoDocumento: string,
    scoreClassificacao: number,
    textoExtraido: string,
  ): Promise<void> {
    const record = await this.getDocumentStatusEntity(documentId, empresaId);
    const existingMetadata = record?.metadata || {};

    await this.documentImportRepository.update(
      { id: documentId, empresaId },
      {
        tipoDocumento,
        textoExtraido,
        scoreConfianca: scoreClassificacao,
        metadata: this.mergeMetadata(existingMetadata, {
          scoreClassificacao,
          quantidadeTexto: textoExtraido.length,
          queue: {
            lastQueueState: 'active',
          },
        }),
      },
    );
  }

  private async updateRecordWithAnalysis(
    documentId: string,
    empresaId: string,
    analysis: DocumentAnalysisDto,
    validation: DocumentValidationResultDto,
    textoExtraido: string,
  ): Promise<void> {
    const record = await this.getDocumentForProcessing(documentId);

    if (!record || record.empresaId !== empresaId) {
      return;
    }

    const nextMetadata = this.mergeMetadata(record.metadata, {
      quantidadeTexto: textoExtraido.length,
      validacao: validation,
      timestampFinalizacao: new Date().toISOString(),
      erro: undefined,
      queue: {
        lastQueueState: 'completed',
      },
    });

    record.jsonEstruturado = toDocumentAnalysisResponseDto(analysis) ?? null;
    record.textoExtraido = textoExtraido;
    record.status = DocumentImportStatus.COMPLETED;
    record.scoreConfianca = validation.scoreConfianca;
    record.dataDocumento =
      analysis.data instanceof Date
        ? analysis.data
        : analysis.data
          ? new Date(analysis.data)
          : null;
    record.metadata = nextMetadata;
    record.mensagemErro = null;
    record.arquivoStaging = null;
    const stagingKeyToDelete = record.arquivoStagingKey;
    record.arquivoStagingKey = null;

    await this.documentImportRepository.save(record);

    if (stagingKeyToDelete) {
      this.deleteStagingFile(stagingKeyToDelete, record.id);
    }
  }

  private assertImportReadyForDdsDraft(record: DocumentImport): void {
    if (record.status !== DocumentImportStatus.COMPLETED) {
      throw new ConflictException(
        'A importação ainda não foi concluída para gerar rascunho de DDS.',
      );
    }

    const tipoDocumento = String(
      record.tipoDocumento || record.jsonEstruturado?.tipoDocumento || '',
    ).toUpperCase();
    if (tipoDocumento !== 'DDS') {
      throw new BadRequestException(
        'A importação selecionada não foi classificada como DDS.',
      );
    }

    if (!record.jsonEstruturado) {
      throw new UnprocessableEntityException(
        'A importação não possui análise estruturada para pré-preencher DDS.',
      );
    }
  }

  private buildDdsDraftPreview(
    record: DocumentImport,
  ): DdsDraftFromImportResponseDto['preview'] {
    const analysis = record.jsonEstruturado;
    const campos = analysis?.camposEstruturados || {};
    const suggestedParticipants = this.extractSuggestedParticipantNames(campos);
    const data =
      analysis?.data ||
      record.dataDocumento?.toISOString() ||
      new Date().toISOString();

    return {
      tema:
        analysis?.tema ||
        analysis?.resumo ||
        `DDS importado: ${record.nomeArquivo || record.id}`,
      conteudo:
        analysis?.conteudo ||
        analysis?.resumo ||
        record.textoExtraido?.slice(0, 3000) ||
        '',
      data,
      participantesSugeridos: suggestedParticipants,
      pendencias: record.metadata?.validacao?.pendencias || [],
    };
  }

  private extractSuggestedParticipantNames(
    campos: Record<string, unknown>,
  ): string[] {
    const participantes = campos.participantes;
    if (!Array.isArray(participantes)) {
      return [];
    }

    return participantes
      .map((participant) => {
        if (typeof participant === 'string') {
          return participant;
        }

        if (this.hasParticipantName(participant)) {
          return participant.nome;
        }

        return null;
      })
      .filter((name): name is string => Boolean(name && name.trim()))
      .slice(0, 50);
  }

  private hasParticipantName(value: unknown): value is { nome: string } {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate.nome === 'string';
  }

  private readAutoCreatedDdsId(
    metadata?: DocumentImportMetadata | null,
  ): string | null {
    const candidate = metadata?.['autoCreatedDdsId'];
    return typeof candidate === 'string' && candidate.trim().length > 0
      ? candidate
      : null;
  }

  private async registerAttemptFailure(
    documentId: string,
    empresaId: string,
    errorMessage: string,
  ): Promise<void> {
    const record = await this.getDocumentStatusEntity(documentId, empresaId);
    const existingMetadata = record?.metadata || {};

    await this.documentImportRepository.update(
      { id: documentId, empresaId },
      {
        mensagemErro: errorMessage,
        metadata: this.mergeMetadata(existingMetadata, {
          erro: errorMessage,
          queue: {
            lastQueueState: 'retry_pending',
          },
        }),
      },
    );
  }

  private async markAsFailed(
    documentId: string,
    empresaId: string,
    errorMessage: string,
    options?: {
      clearStaging?: boolean;
      status?: DocumentImportStatus;
      queueState?: string;
      deadLetteredAt?: Date;
    },
  ): Promise<void> {
    const record = await this.getDocumentForProcessing(documentId);
    const existingMetadata = record?.metadata || {};

    await this.documentImportRepository.update(
      { id: documentId, empresaId },
      {
        status: options?.status || DocumentImportStatus.FAILED,
        mensagemErro: errorMessage,
        deadLetteredAt: options?.deadLetteredAt ?? null,
        ...(options?.clearStaging
          ? { arquivoStaging: null, arquivoStagingKey: null }
          : {}),
        metadata: this.mergeMetadata(existingMetadata, {
          erro: errorMessage,
          timestampFalha: new Date().toISOString(),
          queue: {
            lastQueueState: options?.queueState || 'failed',
          },
        }),
      },
    );
  }

  private mergeMetadata(
    existing: DocumentImportMetadata | null | undefined,
    patch?: Partial<DocumentImportMetadata> | null,
  ): DocumentImportMetadata {
    if (!patch) {
      return existing || {};
    }

    return {
      ...(existing || {}),
      ...patch,
      autoCreateDds: patch.autoCreateDds
        ? {
            ...(existing?.autoCreateDds || {}),
            ...patch.autoCreateDds,
          }
        : existing?.autoCreateDds,
      queue: {
        ...(existing?.queue || {}),
        ...(patch.queue || {}),
      },
    };
  }

  private stagingS3Key(empresaId: string, hash: string): string {
    return `documents/${empresaId}/imports/staging/${hash}`;
  }

  private async uploadStagingFile(
    empresaId: string,
    hash: string,
    buffer: Buffer,
    mimeType: string,
    documentImportId: string,
  ): Promise<string | null> {
    try {
      const key = this.stagingS3Key(empresaId, hash);
      await this.documentStorageService.uploadFile(
        this.documentStorageService.referenceForExistingObject(
          key,
          { resourceType: 'document-import', resourceId: documentImportId },
          'document-import-staging-upload',
        ),
        buffer,
        mimeType || 'application/octet-stream',
      );
      return key;
    } catch (error) {
      this.logger.warn({
        event: 'document_import_staging_upload_failed',
        empresaId,
        hash,
        errorName: error instanceof Error ? error.name : 'unknown_error',
      });
      return null;
    }
  }

  private async resolveStagingBuffer(
    record: DocumentImport,
  ): Promise<Buffer | null> {
    if (record.arquivoStagingKey) {
      try {
        return await this.documentStorageService.downloadFileBuffer(
          this.documentStorageService.referenceForExistingObject(
            record.arquivoStagingKey,
            {
              resourceType: 'document-import',
              resourceId: record.id,
            },
            'p1-document-storage-downloadFileBuffer',
          ),
        );
      } catch (error) {
        this.logger.warn({
          event: 'document_import_staging_download_failed',
          documentId: record.id,
          keyFingerprint: createHash('sha256')
            .update(record.arquivoStagingKey)
            .digest('hex')
            .slice(0, 16),
          errorName: error instanceof Error ? error.name : 'unknown_error',
        });
      }
    }
    // Fallback to legacy bytea column (records created before S3 migration)
    return record.arquivoStaging ?? null;
  }

  private deleteStagingFile(key: string, documentImportId: string): void {
    this.documentStorageService
      .deleteFile(
        this.documentStorageService.referenceForExistingObject(
          key,
          { resourceType: 'document-import', resourceId: documentImportId },
          'p1-document-storage-deleteFile',
        ),
      )
      .catch((error: unknown) => {
        this.logger.warn({
          event: 'document_import_staging_delete_failed',
          keyFingerprint: createHash('sha256')
            .update(key)
            .digest('hex')
            .slice(0, 16),
          errorName: error instanceof Error ? error.name : 'unknown_error',
        });
      });
  }

  private buildStatusUrl(documentId: string) {
    return `/documents/import/${documentId}/status`;
  }

  private isDuplicateImportError(error: unknown): boolean {
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
      const code = driverError?.code;
      const constraint = String(
        driverError?.constraint || driverError?.detail || '',
      ).toLowerCase();

      if (code === '23505') {
        return (
          constraint.includes('uq_document_imports_empresa_idempotency_key') ||
          constraint.includes('uq_document_imports_empresa_hash') ||
          constraint.includes('document_imports_hash_key')
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
      message.includes('duplicate key') ||
      message.includes('already exists') ||
      message.includes('já foi importado anteriormente')
    );
  }
}
