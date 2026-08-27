import type { Job } from 'bullmq';
import { PdfProcessor } from './pdf.processor';
import * as pdfRuntimeConfig from '../../shared/services/pdf-runtime-config';
import { JobTimeoutError } from '../../infra/queue/job-timeout.util';
import {
  markAuthorizedStorageReference,
  type StorageObjectReference,
} from '../../shared/storage/storage-object-reference';

describe('PdfProcessor tenant isolation', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('processa job de PDF dentro de contexto explícito de tenant', async () => {
    const reportsService = {
      generateBuffer: jest.fn().mockResolvedValue({
        buffer: Buffer.from('pdf'),
        report: {
          id: 'report-1',
          company_id: 'company-1',
          created_at: new Date('2026-05-05T10:00:00.000Z'),
          titulo: 'Relatório Mensal',
          pdf_file_key: null,
        },
        documentCode: 'RPT-2026-05-REPORT001',
        originalName: 'RELATORIO_MENSAL_05-2026.pdf',
        title: 'Relatório Mensal',
      }),
    };
    const documentStorageService = {
      referenceForExistingObject: jest.fn(
        (
          key: string,
          owner: { resourceType: string; resourceId: string },
          purpose: string,
        ) => ({
          tenantId: 'company-1',
          key,
          owner,
          purpose,
        }),
      ),
      generateDocumentKey: jest
        .fn()
        .mockReturnValue(
          'documents/company-1/reports/report-1/1710000000000-RELATORIO_MENSAL_05-2026.pdf',
        ),
      uploadFileWithCapability: jest.fn((reference: StorageObjectReference) =>
        Promise.resolve(markAuthorizedStorageReference(reference)),
      ),
      getSignedUrl: jest
        .fn()
        .mockResolvedValue('https://cdn.example.com/report.pdf'),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };
    const documentGovernanceService = {
      registerFinalDocument: jest.fn().mockResolvedValue({
        registryEntry: { document_code: 'RPT-2026-05-REPORT001' },
      }),
    };
    const metricsService = {
      recordQueueJob: jest.fn(),
      recordPdfError: jest.fn(),
      recordPdfGeneration: jest.fn(),
    };
    const tenantQuota = {
      tryAcquire: jest.fn().mockResolvedValue({ acquired: true }),
      getDelayMs: jest.fn().mockReturnValue(1000),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const tenantService = {
      run: jest.fn(async (_ctx, fn: () => Promise<unknown>) => fn()),
    };
    const dlqQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const processor = new PdfProcessor(
      reportsService as never,
      documentStorageService as never,
      documentGovernanceService as never,
      metricsService as never,
      tenantQuota as never,
      tenantService as never,
      dlqQueue as never,
    );

    const result = await processor.process({
      id: 'job-1',
      name: 'generate',
      data: {
        reportType: 'monthly',
        params: { companyId: 'company-1', year: 2026, month: 3 },
        userId: 'user-1',
        companyId: 'company-1',
      },
      opts: { attempts: 1 },
    } as Job<unknown, unknown, string>);

    expect(tenantService.run).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', isSuperAdmin: false }),
      expect.any(Function),
    );

    expect(result).toEqual({ url: 'https://cdn.example.com/report.pdf' });
  });

  it('rejeita job sem companyId antes de quota, tenant ou storage', async () => {
    const tenantQuota = {
      tryAcquire: jest.fn(),
      release: jest.fn(),
    };
    const processor = new PdfProcessor(
      {} as never,
      {} as never,
      {} as never,
      { recordQueueJob: jest.fn(), recordPdfError: jest.fn() } as never,
      tenantQuota as never,
      { run: jest.fn() } as never,
      { add: jest.fn() } as never,
    );

    await expect(
      processor.process({
        id: 'job-without-tenant',
        name: 'generate',
        data: { reportType: 'monthly', params: {}, userId: 'user-1' },
      } as Job<unknown, unknown, string>),
    ).rejects.toThrow('tenantId/companyId obrigatório');
    expect(tenantQuota.tryAcquire).not.toHaveBeenCalled();
  });

  it('compensa o upload do relatório com a capability quando a governança falha', async () => {
    const reportsService = {
      generateBuffer: jest.fn().mockResolvedValue({
        buffer: Buffer.from('pdf'),
        report: {
          id: 'report-1',
          company_id: 'company-1',
          created_at: new Date('2026-05-05T10:00:00.000Z'),
          pdf_file_key: null,
        },
        documentCode: 'RPT-2026-05-REPORT001',
        originalName: 'report.pdf',
        title: 'Report',
      }),
    };
    const uploadFileWithCapability = jest.fn(
      (reference: StorageObjectReference) =>
        Promise.resolve(markAuthorizedStorageReference(reference)),
    );
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const documentStorageService = {
      referenceForExistingObject: jest.fn(
        (
          key: string,
          owner: { resourceType: string; resourceId: string },
          purpose: string,
        ) => ({
          tenantId: 'company-1',
          key,
          owner,
          purpose,
        }),
      ),
      generateDocumentKey: jest
        .fn()
        .mockReturnValue(
          'documents/company-1/reports/report-1/1710000000000-report.pdf',
        ),
      uploadFileWithCapability,
      deleteFile,
      getSignedUrl: jest.fn(),
    };
    const processor = new PdfProcessor(
      reportsService as never,
      documentStorageService as never,
      {
        registerFinalDocument: jest
          .fn()
          .mockRejectedValue(new Error('registry failed')),
      } as never,
      {
        recordQueueJob: jest.fn(),
        recordPdfError: jest.fn(),
        recordPdfGeneration: jest.fn(),
      } as never,
      {
        tryAcquire: jest.fn().mockResolvedValue({ acquired: true }),
        release: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        run: jest.fn(async (_ctx, fn: () => Promise<unknown>) => fn()),
      } as never,
      { add: jest.fn() } as never,
    );

    await expect(
      processor.process({
        id: 'job-registry-failure',
        name: 'generate',
        data: {
          reportType: 'monthly',
          params: { companyId: 'company-1', year: 2026, month: 3 },
          userId: 'user-1',
          companyId: 'company-1',
        },
        opts: { attempts: 1 },
      } as Job<unknown, unknown, string>),
    ).rejects.toThrow('registry failed');

    expect(deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/reports/report-1/1710000000000-report.pdf',
      }),
    );
  });

  it('rejeita artefato de relatório pertencente a outro tenant antes do upload', async () => {
    const reportsService = {
      generateBuffer: jest.fn().mockResolvedValue({
        buffer: Buffer.from('pdf'),
        report: {
          id: 'report-foreign',
          company_id: 'company-2',
          created_at: new Date('2026-05-05T10:00:00.000Z'),
          pdf_file_key: null,
        },
        documentCode: 'RPT-FOREIGN',
        originalName: 'report.pdf',
        title: 'Report',
      }),
    };
    const uploadFileWithCapability = jest.fn();
    const processor = new PdfProcessor(
      reportsService as never,
      {
        generateDocumentKey: jest.fn(),
        uploadFileWithCapability,
      } as never,
      {} as never,
      {
        recordQueueJob: jest.fn(),
        recordPdfError: jest.fn(),
      } as never,
      {
        tryAcquire: jest.fn().mockResolvedValue({ acquired: true }),
        release: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        run: jest.fn(async (_ctx, fn: () => Promise<unknown>) => fn()),
      } as never,
      { add: jest.fn() } as never,
    );

    await expect(
      processor.process({
        id: 'job-foreign-report',
        name: 'generate',
        data: {
          reportType: 'monthly',
          params: { companyId: 'company-1', year: 2026, month: 3 },
          userId: 'user-1',
          companyId: 'company-1',
        },
        opts: { attempts: 1 },
      } as Job<unknown, unknown, string>),
    ).rejects.toThrow('Tenant do relatório não coincide');

    expect(uploadFileWithCapability).not.toHaveBeenCalled();
  });

  it('impede efeitos de retry enquanto uma geração expirada ainda está pendente', async () => {
    jest.useFakeTimers();
    jest.spyOn(pdfRuntimeConfig, 'getPdfQueueJobTimeoutMs').mockReturnValue(20);

    const artifact = {
      buffer: Buffer.from('pdf'),
      report: {
        id: 'report-timeout-before-upload',
        company_id: 'company-1',
        created_at: new Date('2026-05-05T10:00:00.000Z'),
        titulo: 'Relatório Mensal',
        pdf_file_key: null,
      },
      documentCode: 'RPT-TIMEOUT-001',
      originalName: 'report.pdf',
      title: 'Report',
    };
    let resolveFirstGeneration!: (value: typeof artifact) => void;
    let generationCalls = 0;
    const reportsService = {
      generateBuffer: jest.fn(
        (_reportType: string, _params: unknown, _signal?: AbortSignal) => {
          generationCalls += 1;
          if (generationCalls === 1) {
            return new Promise<typeof artifact>((resolve) => {
              resolveFirstGeneration = resolve;
            });
          }
          return Promise.resolve(artifact);
        },
      ),
    };
    const uploadFileWithCapability = jest.fn(
      (reference: StorageObjectReference) =>
        Promise.resolve(markAuthorizedStorageReference(reference)),
    );
    const documentStorageService = {
      referenceForExistingObject: jest.fn(
        (
          key: string,
          owner: { resourceType: string; resourceId: string },
          purpose: string,
        ) => ({ tenantId: 'company-1', key, owner, purpose }),
      ),
      generateDocumentKey: jest
        .fn()
        .mockReturnValueOnce(
          'documents/company-1/reports/report-timeout-before-upload/attempt-1.pdf',
        )
        .mockReturnValueOnce(
          'documents/company-1/reports/report-timeout-before-upload/attempt-2.pdf',
        ),
      uploadFileWithCapability,
      getSignedUrl: jest
        .fn()
        .mockResolvedValue('https://cdn.example.com/report.pdf'),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };
    const documentGovernanceService = {
      registerFinalDocument: jest.fn().mockResolvedValue({
        registryEntry: { document_code: 'RPT-TIMEOUT-001' },
      }),
    };
    const tenantQuota = {
      tryAcquire: jest.fn().mockResolvedValue({ acquired: true }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new PdfProcessor(
      reportsService as never,
      documentStorageService as never,
      documentGovernanceService as never,
      {
        recordQueueJob: jest.fn(),
        recordPdfError: jest.fn(),
        recordPdfGeneration: jest.fn(),
      } as never,
      tenantQuota as never,
      {
        run: jest.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
      } as never,
      { add: jest.fn() } as never,
    );
    const makeJob = (id: string) =>
      ({
        id,
        name: 'generate',
        data: {
          reportType: 'monthly',
          params: { companyId: 'company-1', year: 2026, month: 3 },
          userId: 'user-1',
          companyId: 'company-1',
        },
        opts: { attempts: 2 },
      }) as Job<unknown, unknown, string>;

    const firstAttempt = processor.process(makeJob('job-timeout-1'));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await Promise.resolve();
    }
    expect(reportsService.generateBuffer).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(20);
    await Promise.resolve();
    jest.advanceTimersByTime(45_000);
    await expect(firstAttempt).rejects.toBeInstanceOf(JobTimeoutError);

    await expect(processor.process(makeJob('job-timeout-1'))).resolves.toEqual({
      url: 'https://cdn.example.com/report.pdf',
    });
    expect(uploadFileWithCapability).toHaveBeenCalledTimes(1);
    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledTimes(1);

    resolveFirstGeneration(artifact);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await Promise.resolve();
    }

    expect(uploadFileWithCapability).toHaveBeenCalledTimes(1);
    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledTimes(1);
  });

  it('compensa upload tardio somente da tentativa expirada e preserva o retry', async () => {
    jest.useFakeTimers();
    jest.spyOn(pdfRuntimeConfig, 'getPdfQueueJobTimeoutMs').mockReturnValue(20);

    const artifact = {
      buffer: Buffer.from('pdf'),
      report: {
        id: 'report-timeout-during-upload',
        company_id: 'company-1',
        created_at: new Date('2026-05-05T10:00:00.000Z'),
        pdf_file_key: null,
      },
      documentCode: 'RPT-TIMEOUT-002',
      originalName: 'report.pdf',
      title: 'Report',
    };
    let uploadCalls = 0;
    let resolveFirstUpload!: (
      reference: ReturnType<typeof markAuthorizedStorageReference>,
    ) => void;
    const uploadFileWithCapability = jest.fn(
      (reference: StorageObjectReference) => {
        uploadCalls += 1;
        const authorized = markAuthorizedStorageReference(reference);
        if (uploadCalls === 1) {
          return new Promise<typeof authorized>((resolve) => {
            resolveFirstUpload = resolve;
          });
        }
        return Promise.resolve(authorized);
      },
    );
    const reportsService = {
      generateBuffer: jest.fn().mockResolvedValue(artifact),
    };
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const documentStorageService = {
      referenceForExistingObject: jest.fn(
        (
          key: string,
          owner: { resourceType: string; resourceId: string },
          purpose: string,
        ) => ({ tenantId: 'company-1', key, owner, purpose }),
      ),
      generateDocumentKey: jest
        .fn()
        .mockReturnValueOnce(
          'documents/company-1/reports/report-timeout-during-upload/attempt-1.pdf',
        )
        .mockReturnValueOnce(
          'documents/company-1/reports/report-timeout-during-upload/attempt-2.pdf',
        ),
      uploadFileWithCapability,
      getSignedUrl: jest
        .fn()
        .mockResolvedValue('https://cdn.example.com/retry.pdf'),
      deleteFile,
    };
    const documentGovernanceService = {
      registerFinalDocument: jest.fn().mockResolvedValue({
        registryEntry: { document_code: 'RPT-TIMEOUT-002' },
      }),
    };
    const tenantQuota = {
      tryAcquire: jest.fn().mockResolvedValue({ acquired: true }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new PdfProcessor(
      reportsService as never,
      documentStorageService as never,
      documentGovernanceService as never,
      {
        recordQueueJob: jest.fn(),
        recordPdfError: jest.fn(),
        recordPdfGeneration: jest.fn(),
      } as never,
      tenantQuota as never,
      {
        run: jest.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
      } as never,
      { add: jest.fn() } as never,
    );
    const job = {
      id: 'job-timeout-upload',
      name: 'generate',
      data: {
        reportType: 'monthly',
        params: { companyId: 'company-1', year: 2026, month: 3 },
        userId: 'user-1',
        companyId: 'company-1',
      },
      opts: { attempts: 2 },
    } as Job<unknown, unknown, string>;

    const firstAttempt = processor.process(job);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await Promise.resolve();
    }
    expect(uploadFileWithCapability).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(20);
    await Promise.resolve();
    jest.advanceTimersByTime(45_000);
    await expect(firstAttempt).rejects.toBeInstanceOf(JobTimeoutError);

    await expect(processor.process(job)).resolves.toEqual({
      url: 'https://cdn.example.com/retry.pdf',
    });
    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledTimes(1);

    const firstReference = markAuthorizedStorageReference({
      tenantId: 'company-1',
      key: 'documents/company-1/reports/report-timeout-during-upload/attempt-1.pdf',
      owner: { resourceType: 'report', resourceId: artifact.report.id },
      purpose: 'p1-document-storage-uploadFile',
    });
    resolveFirstUpload(firstReference);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await Promise.resolve();
    }

    expect(deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ key: firstReference.key }),
    );
    expect(deleteFile).not.toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/reports/report-timeout-during-upload/attempt-2.pdf',
      }),
    );
  });

  it('descarta a publicação quando a tentativa perde o fence transacional do relatório', async () => {
    const artifact = {
      buffer: Buffer.from('pdf'),
      report: {
        id: 'report-fence-lost',
        company_id: 'company-1',
        created_at: new Date('2026-05-05T10:00:00.000Z'),
        pdf_file_key: null,
      },
      documentCode: 'RPT-FENCE-001',
      originalName: 'report.pdf',
      title: 'Report',
    };
    const execute = jest.fn().mockResolvedValue({ affected: 0 });
    const queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    };
    const manager = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const documentStorageService = {
      referenceForExistingObject: jest.fn(
        (
          key: string,
          owner: { resourceType: string; resourceId: string },
          purpose: string,
        ) => ({ tenantId: 'company-1', key, owner, purpose }),
      ),
      generateDocumentKey: jest
        .fn()
        .mockReturnValue(
          'documents/company-1/reports/report-fence-lost/fence.pdf',
        ),
      uploadFileWithCapability: jest.fn((reference: StorageObjectReference) =>
        Promise.resolve(markAuthorizedStorageReference(reference)),
      ),
      deleteFile,
      getSignedUrl: jest.fn(),
    };
    const documentGovernanceService = {
      registerFinalDocument: jest.fn(
        async (input: {
          persistEntityMetadata?: (
            manager: never,
            hash: string,
          ) => Promise<void>;
        }) => {
          await input.persistEntityMetadata?.(manager as never, 'hash');
          return { registryEntry: { document_code: 'RPT-FENCE-001' } };
        },
      ),
    };
    const processor = new PdfProcessor(
      { generateBuffer: jest.fn().mockResolvedValue(artifact) } as never,
      documentStorageService as never,
      documentGovernanceService as never,
      {
        recordQueueJob: jest.fn(),
        recordPdfError: jest.fn(),
        recordPdfGeneration: jest.fn(),
      } as never,
      {
        tryAcquire: jest.fn().mockResolvedValue({ acquired: true }),
        release: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        run: jest.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
      } as never,
      { add: jest.fn() } as never,
    );

    await expect(
      processor.process({
        id: 'job-fence-lost',
        name: 'generate',
        data: {
          reportType: 'monthly',
          params: { companyId: 'company-1', year: 2026, month: 3 },
          userId: 'user-1',
          companyId: 'company-1',
        },
        opts: { attempts: 2 },
      } as Job<unknown, unknown, string>),
    ).rejects.toThrow('perdeu a posse do relatório');

    expect(queryBuilder.update).toHaveBeenCalledWith('reports');
    expect(queryBuilder.where).toHaveBeenCalledWith(
      'id = :reportId AND company_id = :companyId',
      { reportId: artifact.report.id, companyId: 'company-1' },
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/reports/report-fence-lost/fence.pdf',
      }),
    );
  });
});
