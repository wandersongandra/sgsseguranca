import {
  InjectQueue,
  Processor,
  WorkerHost,
  OnWorkerEvent,
} from '@nestjs/bullmq';
import { DelayedError, type Job, type Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { MetricsService } from '../../shared/observability/metrics.service';
import { TenantQuotaService } from '../../shared/queue/tenant-quota.service';
import {
  getPdfGenerationConcurrency,
  getPdfQueueJobTimeoutMs,
} from '../../shared/services/pdf-runtime-config';
import { captureException } from '../../shared/monitoring/sentry';
import { TenantService } from '../../shared/tenant/tenant.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentRegistryEntry } from '../document-registry/entities/document-registry.entity';
import {
  cleanupUploadedFile,
  storageKeyFingerprint,
} from '../../shared/storage/storage-compensation.util';
import { withJobTimeout } from '../../infra/queue/job-timeout.util';
import type { AuthorizedStorageObjectReference } from '../../shared/storage/storage-object-reference';

interface PdfGenerationJobData {
  reportType: string;
  params: unknown;
  userId: string;
  companyId: string;
}

interface DeadLetterPayload {
  originalQueue: string;
  originalJobId: string | undefined;
  originalJobName: string;
  attemptsMade: number;
  companyId?: string;
  data: unknown;
  error: {
    message: string;
  };
  failedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parsePdfGenerationJobData = (
  data: unknown,
): PdfGenerationJobData | null => {
  if (!isRecord(data)) {
    return null;
  }

  const reportType = data['reportType'];
  const userId = data['userId'];
  const companyId = data['companyId'];

  if (
    typeof reportType !== 'string' ||
    !reportType.trim() ||
    typeof userId !== 'string' ||
    !userId.trim() ||
    typeof companyId !== 'string' ||
    !companyId.trim()
  ) {
    return null;
  }

  return {
    reportType,
    params: data['params'],
    userId,
    companyId,
  };
};

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;

  const error = new Error('Job de PDF cancelado após o timeout.');
  error.name = 'AbortError';
  throw error;
}

// concurrency: 3 — Puppeteer é memory-intensive (~200-400 MB por instância).
// Não ultrapasse 3 por container; ajuste para 1 se o plano Railway for small.
const PDF_GENERATION_CONCURRENCY = getPdfGenerationConcurrency();

const PDF_RSS_WARN_THRESHOLD_MB = parseInt(
  process.env.PDF_GENERATION_RSS_WARN_MB || '900',
  10,
);
const PDF_TIMEOUT_CANCELLATION_GRACE_MS = 45_000;

function checkRssAndWarn(logger: { warn: (msg: object) => void }): void {
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rssMb >= PDF_RSS_WARN_THRESHOLD_MB) {
    logger.warn({
      event: 'pdf_worker_rss_high',
      rssMb,
      thresholdMb: PDF_RSS_WARN_THRESHOLD_MB,
      message:
        'RSS do worker de PDF próximo do limite — considere reduzir PDF_GENERATION_CONCURRENCY',
    });
  }
}

@Processor('pdf-generation', { concurrency: PDF_GENERATION_CONCURRENCY })
export class PdfProcessor extends WorkerHost {
  private readonly logger = new Logger(PdfProcessor.name);

  constructor(
    private readonly reportsService: ReportsService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly metricsService: MetricsService,
    private readonly tenantQuota: TenantQuotaService,
    private readonly tenantService: TenantService,
    @InjectQueue('pdf-generation-dlq') private readonly pdfDlq: Queue,
  ) {
    super();
  }

  // BullMQ v5+: @Process() foi removido. Implementar process() e rotear por job.name.
  async process(
    job: Job<unknown, unknown, string>,
  ): Promise<{ url: string | null } | void> {
    const start = Date.now();
    const jobData = parsePdfGenerationJobData(job.data);
    if (job.name !== 'generate' || !jobData) {
      throw new Error(
        `Payload inválido para job de PDF ${job.id ?? 'sem-id'}: tenantId/companyId obrigatório.`,
      );
    }
    const companyId = jobData.companyId;
    const quota = await this.tenantQuota.tryAcquire('pdf', companyId);
    if (!quota.acquired) {
      const delayMs = this.tenantQuota.getDelayMs('pdf');
      await job.moveToDelayed(Date.now() + delayMs, job.token);
      this.metricsService.recordQueueJob(
        'pdf-generation',
        job.name,
        Date.now() - start,
        'delayed',
        companyId,
      );
      throw new DelayedError();
    }
    try {
      const result = await withJobTimeout(
        (signal) => this.handleGenerate(job, jobData, signal),
        getPdfQueueJobTimeoutMs(),
        { jobName: job.name, jobId: job.id, logger: this.logger },
        {
          waitForSettledOnTimeoutMs: PDF_TIMEOUT_CANCELLATION_GRACE_MS,
        },
      );
      this.metricsService.recordQueueJob(
        'pdf-generation',
        job.name,
        Date.now() - start,
        'success',
        companyId,
      );
      return result;
    } catch (err) {
      this.metricsService.recordQueueJob(
        'pdf-generation',
        job.name,
        Date.now() - start,
        'error',
        companyId,
      );
      this.metricsService.recordPdfError(
        companyId ?? 'unknown',
        err instanceof Error ? err.name || 'Error' : 'UnknownError',
      );
      throw err;
    } finally {
      await this.tenantQuota.release('pdf', companyId);
    }
  }

  private async handleGenerate(
    job: Job<unknown, unknown, string>,
    data: PdfGenerationJobData,
    signal: AbortSignal,
  ): Promise<{ url: string | null }> {
    const start = Date.now();
    const { reportType, params, userId, companyId } = data;
    throwIfAborted(signal);
    this.logger.log({
      event: 'pdf_job_started',
      jobId: job.id,
      reportType,
      userId,
      companyId,
      concurrency: PDF_GENERATION_CONCURRENCY,
    });

    // Use original requester's site scope from job (propagated from controller) for correct scoped counts in reports
    const jobData = data as unknown as Record<string, unknown>;
    const jobSiteScope = jobData?.siteScope as 'single' | 'all' | undefined;
    const jobSiteId = jobData?.siteId as string | undefined;

    const tenantContext = {
      companyId,
      isSuperAdmin: false,
      siteScope: jobSiteScope ?? ('all' as const),
      siteId: jobSiteId,
    };
    const artifact = await this.tenantService.run(tenantContext, async () =>
      this.reportsService.generateBuffer(reportType, params, signal),
    );
    throwIfAborted(signal);
    if (artifact.report.company_id !== companyId) {
      throw new Error('Tenant do relatório não coincide com o job de PDF.');
    }
    const previousFileKey = artifact.report.pdf_file_key || null;
    const fileKey = this.documentStorageService.generateDocumentKey(
      artifact.report.company_id,
      'reports',
      artifact.report.id,
      artifact.originalName,
    );
    const folderPath = fileKey.split('/').slice(0, -1).join('/');

    let uploadedToStorage = false;
    let uploadedReference: AuthorizedStorageObjectReference | undefined;
    let registryEntry!: DocumentRegistryEntry;
    let registrationCommitted = false;
    const url = await this.tenantService.run(tenantContext, async () => {
      try {
        throwIfAborted(signal);
        uploadedReference =
          await this.documentStorageService.uploadFileWithCapability(
            this.documentStorageService.referenceForExistingObject(
              fileKey,
              { resourceType: 'report', resourceId: artifact.report.id },
              'p1-document-storage-uploadFile',
            ),
            artifact.buffer,
            'application/pdf',
          );
        uploadedToStorage = true;
        throwIfAborted(signal);

        ({ registryEntry } =
          await this.documentGovernanceService.registerFinalDocument({
            companyId: artifact.report.company_id,
            module: 'report',
            entityId: artifact.report.id,
            title: artifact.title,
            documentDate: artifact.report.created_at,
            documentCode: artifact.documentCode,
            fileKey,
            folderPath,
            originalName: artifact.originalName,
            mimeType: 'application/pdf',
            fileBuffer: artifact.buffer,
            createdBy: userId,
            persistEntityMetadata: async (manager, computedHash) => {
              const query = manager
                .createQueryBuilder()
                .update('reports')
                .set({
                  pdf_file_key: fileKey,
                  pdf_folder_path: folderPath,
                  pdf_original_name: artifact.originalName,
                  pdf_file_hash: computedHash,
                  pdf_generated_at: new Date(),
                })
                .where('id = :reportId AND company_id = :companyId', {
                  reportId: artifact.report.id,
                  companyId,
                })
                .andWhere(
                  previousFileKey
                    ? 'pdf_file_key = :previousFileKey'
                    : 'pdf_file_key IS NULL',
                  previousFileKey ? { previousFileKey } : undefined,
                );
              const updateResult = await query.execute();
              if (updateResult.affected !== 1) {
                throw new Error(
                  'Publicação do PDF perdeu a posse do relatório para outra tentativa.',
                );
              }
            },
          }));
        registrationCommitted = true;
        if (signal.aborted) return null;
      } catch (error) {
        if (uploadedToStorage && !registrationCommitted) {
          await cleanupUploadedFile(
            this.logger,
            `pdf-report:${artifact.report.id}`,
            fileKey,
            (key) =>
              uploadedReference && uploadedReference.key === key
                ? this.documentStorageService.deleteFile(uploadedReference)
                : Promise.resolve(),
          );
        }
        throw error;
      }

      if (signal.aborted) return null;
      if (previousFileKey && previousFileKey !== fileKey) {
        await this.documentStorageService
          .deleteFile(
            this.documentStorageService.referenceForExistingObject(
              previousFileKey,
              { resourceType: 'report', resourceId: artifact.report.id },
              'p1-document-storage-deleteFile',
            ),
          )
          .catch((error) => {
            this.logger.warn(
              {
                event: 'pdf_previous_file_cleanup_failed',
                reportId: artifact.report.id,
                keyFingerprint: storageKeyFingerprint(previousFileKey),
                errorName:
                  error instanceof Error ? error.name : 'unknown_error',
              },
              error instanceof Error ? error.stack : undefined,
            );
          });
      }

      const signedUrl = await this.documentStorageService
        .getSignedUrl(
          this.documentStorageService.referenceForExistingObject(
            fileKey,
            { resourceType: 'report', resourceId: artifact.report.id },
            'p1-document-storage-getSignedUrl',
          ),
        )
        .catch(() => null);
      return signal.aborted ? null : signedUrl;
    });

    this.metricsService.recordPdfGeneration(companyId, Date.now() - start);
    this.logger.log({
      event: 'pdf_job_completed',
      jobId: job.id,
      reportType,
      userId,
      companyId,
      sizeBytes: artifact.buffer.length,
      durationMs: Date.now() - start,
      reportId: artifact.report.id,
      keyFingerprint: storageKeyFingerprint(fileKey),
      documentCode: registryEntry.document_code || artifact.documentCode,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
    checkRssAndWarn(this.logger);
    return { url };
  }

  private sanitizeJobDataForDlq(data: unknown): unknown {
    if (typeof data !== 'object' || data === null) return data;
    const d = data as Record<string, unknown>;
    return {
      ...d,
      // HTML pode ter centenas de KB — guardar apenas tamanho para diagnóstico
      html:
        typeof d.html === 'string'
          ? `[truncated ${d.html.length} chars]`
          : d.html,
    };
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<unknown, unknown, string> | undefined, error: Error) {
    if (!job) return;
    const jobData = parsePdfGenerationJobData(job.data);

    const maxAttempts = job.opts.attempts ?? 1;
    const isFinal = job.attemptsMade >= maxAttempts;

    this.logger.error({
      event: 'pdf_generation_job_failed',
      jobId: job.id,
      jobName: job.name,
      attemptsMade: job.attemptsMade,
      finalAttempt: isFinal,
      companyId: jobData?.companyId,
      errorName: error.name || 'unknown_error',
    });

    if (!isFinal) return;

    captureException(error, {
      tags: { queue: 'pdf-generation', jobName: job.name },
      extra: {
        jobId: job.id,
        companyId: jobData?.companyId,
        attemptsMade: job.attemptsMade,
      },
    });

    try {
      const deadLetterPayload: DeadLetterPayload = {
        originalQueue: 'pdf-generation',
        originalJobId: job.id,
        originalJobName: job.name,
        attemptsMade: job.attemptsMade,
        companyId: jobData?.companyId,
        // job.data pode conter HTML gerado — truncar para evitar payload gigante na DLQ
        data: this.sanitizeJobDataForDlq(job.data),
        error: {
          message: error.name || 'UnknownError',
        },
        failedAt: new Date().toISOString(),
      };

      await this.pdfDlq.add('dead-letter', deadLetterPayload, {
        attempts: 1,
        backoff: undefined,
        removeOnComplete: 5000,
        removeOnFail: 5000,
      });
    } catch (dlqErr) {
      this.logger.error(
        `[Job ${job.id}] Falha ao publicar no DLQ: ${dlqErr instanceof Error ? dlqErr.message : String(dlqErr)}`,
        dlqErr instanceof Error ? dlqErr.stack : undefined,
      );
    }
  }
}
