import {
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DocumentImportStatus } from '../entities/document-import-status.enum';
import { DocumentImportService } from './document-import.service';
import { DocumentImport } from '../entities/document-import.entity';
import type {
  StorageObjectOwner,
  StorageObjectReference,
} from '../../../shared/storage/storage-object-reference';

const COMPANY_ID = 'company-1';
const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';

function makeDocumentImport(
  overrides: Partial<DocumentImport> = {},
): DocumentImport {
  return {
    id: DOCUMENT_ID,
    empresaId: COMPANY_ID,
    tipoDocumento: 'APR',
    nomeArquivo: 'document.pdf',
    hash: 'hash-1',
    idempotencyKey: null,
    tamanho: 128,
    mimeType: 'application/pdf',
    textoExtraido: null,
    arquivoStaging: null,
    arquivoStagingKey: 'document-import-staging/company-1/hash-1',
    jsonEstruturado: null,
    metadata: {
      queue: {
        attempts: 3,
        timeoutMs: 180000,
        statusUrl: `/documents/import/${DOCUMENT_ID}/status`,
      },
    },
    status: DocumentImportStatus.UPLOADED,
    scoreConfianca: 0,
    dataDocumento: null,
    processingJobId: null,
    processingAttempts: 0,
    lastAttemptAt: null,
    deadLetteredAt: null,
    createdAt: new Date('2026-03-20T10:00:00.000Z'),
    updatedAt: new Date('2026-03-20T10:00:00.000Z'),
    mensagemErro: null,
    ...overrides,
  };
}

describe('DocumentImportService', () => {
  let service: DocumentImportService;
  let repository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let queryBuilder: {
    where: jest.Mock;
    andWhere: jest.Mock;
    addSelect: jest.Mock;
    getOne: jest.Mock;
  };
  let fileParserService: {
    generateFileHash: jest.Mock;
    extractText: jest.Mock;
  };
  let documentClassifierService: {
    getDocumentTypeDescription: jest.Mock;
    classifyDocument: jest.Mock;
  };
  let documentInterpreterService: {
    interpretDocument: jest.Mock;
  };
  let documentValidationService: {
    validateDocument: jest.Mock;
  };
  let ddsService: {
    create: jest.Mock;
    findOne: jest.Mock;
  };
  let tenantService: {
    getTenantId: jest.Mock;
    isSuperAdmin: jest.Mock;
    run: jest.Mock;
  };
  let queue: {
    add: jest.Mock;
    getJob: jest.Mock;
  };
  let storageService: {
    referenceForExistingObject: jest.Mock;
    uploadFile: jest.Mock;
    downloadFileBuffer: jest.Mock;
    deleteFile: jest.Mock;
  };

  beforeEach(() => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };

    repository = {
      findOne: jest.fn(),
      create: jest.fn((input: Partial<DocumentImport>) =>
        makeDocumentImport(input),
      ),
      save: jest.fn((input) => Promise.resolve(input)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    fileParserService = {
      generateFileHash: jest.fn().mockReturnValue('hash-1'),
      extractText: jest.fn().mockResolvedValue('conteudo extraido'),
    };
    documentClassifierService = {
      getDocumentTypeDescription: jest.fn().mockReturnValue('APR'),
      classifyDocument: jest.fn().mockResolvedValue({
        tipoDocumento: 'DDS',
        score: 0.91,
      }),
    };
    documentInterpreterService = {
      interpretDocument: jest.fn().mockResolvedValue({
        tipoDocumento: 'DDS',
        tema: 'DDS Importado',
        conteudo: 'Conteudo importado',
        resumo: 'Resumo',
        data: '2026-03-20T10:00:00.000Z',
        scoreConfianca: 0.88,
      }),
    };
    documentValidationService = {
      validateDocument: jest.fn().mockReturnValue({
        status: 'VALIDO',
        pendencias: [],
        scoreConfianca: 88,
      }),
    };
    ddsService = {
      create: jest.fn(),
      findOne: jest.fn(),
    };
    tenantService = {
      getTenantId: jest.fn(() => COMPANY_ID),
      isSuperAdmin: jest.fn(() => false),
      run: jest.fn((_ctx, callback: () => unknown) => callback()),
    };
    queue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      getJob: jest.fn(),
    };
    storageService = {
      referenceForExistingObject: jest.fn(
        (
          key: string,
          owner: StorageObjectOwner,
          purpose: string,
        ): StorageObjectReference => ({
          tenantId: COMPANY_ID,
          key,
          owner,
          purpose,
        }),
      ),
      uploadFile: jest.fn().mockResolvedValue(undefined),
      downloadFileBuffer: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };

    service = new DocumentImportService(
      repository as never,
      fileParserService as never,
      documentClassifierService as never,
      documentInterpreterService as never,
      documentValidationService as never,
      ddsService as never,
      tenantService as never,
      storageService as never,
      queue as never,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('enfileira o documento e devolve contrato consultável de status', async () => {
    repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    repository.save.mockResolvedValue(
      makeDocumentImport({
        id: DOCUMENT_ID,
        status: DocumentImportStatus.UPLOADED,
      }),
    );

    const result = await service.enqueueDocumentProcessing(
      Buffer.from('%PDF-1.4 async'),
      COMPANY_ID,
      'APR',
      'application/pdf',
      'apr.pdf',
      'user-1',
      'idem-1',
    );

    const [jobName, jobData, jobOptions] = queue.add.mock.calls[0] as [
      string,
      {
        documentId: string;
        companyId: string;
        requestedByUserId?: string;
      },
      {
        attempts?: number;
        timeout?: number;
        jobId?: string;
      },
    ];

    expect(jobName).toBe('process-document-import');
    expect(jobData).toEqual({
      documentId: DOCUMENT_ID,
      companyId: COMPANY_ID,
      requestedByUserId: 'user-1',
    });
    expect(jobOptions.attempts).toEqual(expect.any(Number));
    expect(jobOptions.jobId).toBe(`document-import-${DOCUMENT_ID}`);
    expect(repository.update).toHaveBeenCalledWith(
      { id: DOCUMENT_ID, empresaId: COMPANY_ID },
      expect.objectContaining({
        status: DocumentImportStatus.QUEUED,
        processingJobId: `document-import-${DOCUMENT_ID}`,
      }),
    );
    expect(result).toMatchObject({
      success: true,
      queued: true,
      documentId: DOCUMENT_ID,
      status: DocumentImportStatus.QUEUED,
      statusUrl: `/documents/import/${DOCUMENT_ID}/status`,
      reused: false,
      replayState: 'new',
      idempotencyKey: 'idem-1',
      job: {
        jobId: 'job-1',
        queueState: 'waiting',
        deadLettered: false,
      },
    });
  });

  it('não marca a importação como falha quando o job já foi enfileirado e a persistência pós-enqueue falha', async () => {
    repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    repository.save.mockResolvedValue(
      makeDocumentImport({
        id: DOCUMENT_ID,
        status: DocumentImportStatus.UPLOADED,
      }),
    );
    repository.update
      .mockResolvedValueOnce({ affected: 1 })
      .mockRejectedValueOnce(new Error('metadata persist failed'));

    const result = await service.enqueueDocumentProcessing(
      Buffer.from('%PDF-1.4 async'),
      COMPANY_ID,
      'APR',
      'application/pdf',
      'apr.pdf',
      'user-1',
      'idem-1',
    );

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(repository.delete).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      documentId: DOCUMENT_ID,
      status: DocumentImportStatus.QUEUED,
      queued: true,
      reused: false,
      job: {
        jobId: 'job-1',
      },
    });
  });

  it('retorna status consultável com snapshot real do job', async () => {
    queryBuilder.getOne.mockResolvedValue(
      makeDocumentImport({
        id: DOCUMENT_ID,
        status: DocumentImportStatus.QUEUED,
        processingJobId: 'job-1',
        processingAttempts: 1,
      }),
    );
    queue.getJob.mockResolvedValue({
      id: 'job-1',
      attemptsMade: 1,
      opts: { attempts: 3 },
      getState: jest.fn().mockResolvedValue('active'),
    });

    const result = await service.getDocumentStatusResponse(
      DOCUMENT_ID,
      COMPANY_ID,
    );

    expect(result).toMatchObject({
      success: true,
      documentId: DOCUMENT_ID,
      status: DocumentImportStatus.QUEUED,
      completed: false,
      failed: false,
      statusUrl: `/documents/import/${DOCUMENT_ID}/status`,
      job: {
        jobId: 'job-1',
        queueState: 'active',
        attemptsMade: 1,
        maxAttempts: 3,
      },
    });
    expect(queryBuilder.where).toHaveBeenCalledWith(
      'documentImport.id = :documentId',
      { documentId: DOCUMENT_ID },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'documentImport.empresaId = :tenantId',
      { tenantId: COMPANY_ID },
    );
  });

  it('retorna null para status fora do tenant sem expor existência cross-tenant', async () => {
    queryBuilder.getOne.mockResolvedValue(null);

    const result = await service.getDocumentStatusResponse(
      DOCUMENT_ID,
      COMPANY_ID,
    );

    expect(result).toBeNull();
    expect(queryBuilder.where).toHaveBeenCalledWith(
      'documentImport.id = :documentId',
      { documentId: DOCUMENT_ID },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'documentImport.empresaId = :tenantId',
      { tenantId: COMPANY_ID },
    );
  });

  it('reenfileira importação em dead-letter com staging preservado', async () => {
    queryBuilder.getOne.mockResolvedValue(
      makeDocumentImport({
        id: DOCUMENT_ID,
        status: DocumentImportStatus.DEAD_LETTER,
        processingJobId: 'job-dead-letter',
        processingAttempts: 3,
        deadLetteredAt: new Date('2026-03-20T10:05:00.000Z'),
        mensagemErro: 'parse timeout',
      }),
    );
    queue.add.mockResolvedValue({ id: 'retry-job-1' });

    const result = await service.retryDocumentProcessing(DOCUMENT_ID, 'user-1');

    const [jobName, jobData, jobOptions] = queue.add.mock.calls[0] as [
      string,
      {
        documentId: string;
        companyId: string;
        requestedByUserId?: string;
      },
      {
        jobId?: string;
      },
    ];

    expect(jobName).toBe('process-document-import');
    expect(jobData).toEqual({
      documentId: DOCUMENT_ID,
      companyId: COMPANY_ID,
      requestedByUserId: 'user-1',
    });
    expect(String(jobOptions.jobId)).toContain(
      `document-import-${DOCUMENT_ID}-retry-`,
    );
    expect(repository.update).toHaveBeenCalledWith(
      { id: DOCUMENT_ID, empresaId: COMPANY_ID },
      expect.objectContaining({
        status: DocumentImportStatus.QUEUED,
        mensagemErro: null,
        deadLetteredAt: null,
      }),
    );
    expect(result).toMatchObject({
      success: true,
      queued: true,
      documentId: DOCUMENT_ID,
      status: DocumentImportStatus.QUEUED,
      replayState: 'new',
      reused: false,
      job: {
        jobId: 'retry-job-1',
        queueState: 'waiting',
        deadLettered: false,
      },
    });
  });

  it('bloqueia retry de importações que não estão em dead-letter', async () => {
    queryBuilder.getOne.mockResolvedValue(
      makeDocumentImport({
        id: DOCUMENT_ID,
        status: DocumentImportStatus.FAILED,
        mensagemErro: 'enqueue failed',
      }),
    );

    await expect(
      service.retryDocumentProcessing(DOCUMENT_ID, 'user-1'),
    ).rejects.toThrow(
      'Somente importações em dead-letter podem ser reenfileiradas com segurança.',
    );

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('reutiliza a operação em andamento quando a mesma idempotency key é reenviada', async () => {
    repository.findOne.mockResolvedValueOnce(
      makeDocumentImport({
        idempotencyKey: 'idem-1',
        hash: 'hash-1',
        status: DocumentImportStatus.PROCESSING,
        processingJobId: 'job-1',
        processingAttempts: 1,
      }),
    );
    queue.getJob.mockResolvedValue({
      id: 'job-1',
      attemptsMade: 1,
      opts: { attempts: 3 },
      getState: jest.fn().mockResolvedValue('active'),
    });

    const result = await service.enqueueDocumentProcessing(
      Buffer.from('%PDF-1.4 async'),
      COMPANY_ID,
      'APR',
      'application/pdf',
      'apr.pdf',
      'user-1',
      'idem-1',
    );

    expect(queue.add).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      documentId: DOCUMENT_ID,
      status: DocumentImportStatus.PROCESSING,
      reused: true,
      replayState: 'in_progress',
      dedupeSource: 'idempotency_key',
      idempotencyKey: 'idem-1',
    });
  });

  it('bloqueia reuse da mesma idempotency key para outro arquivo', async () => {
    repository.findOne.mockResolvedValueOnce(
      makeDocumentImport({
        idempotencyKey: 'idem-1',
        hash: 'hash-existente',
      }),
    );

    await expect(
      service.enqueueDocumentProcessing(
        Buffer.from('%PDF-diferente'),
        COMPANY_ID,
        'APR',
        'application/pdf',
        'apr.pdf',
        'user-1',
        'idem-1',
      ),
    ).rejects.toThrow(
      'A mesma Idempotency-Key já foi utilizada para outro arquivo.',
    );

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('devolve a mesma operação falhada quando a mesma idempotency key é repetida', async () => {
    repository.findOne.mockResolvedValueOnce(
      makeDocumentImport({
        idempotencyKey: 'idem-1',
        status: DocumentImportStatus.DEAD_LETTER,
        processingJobId: 'job-1',
        processingAttempts: 3,
        mensagemErro: 'parse timeout',
      }),
    );
    queue.getJob.mockResolvedValue(null);

    const result = await service.enqueueDocumentProcessing(
      Buffer.from('%PDF-1.4 async'),
      COMPANY_ID,
      'APR',
      'application/pdf',
      'apr.pdf',
      'user-1',
      'idem-1',
    );

    expect(queue.add).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      documentId: DOCUMENT_ID,
      status: DocumentImportStatus.DEAD_LETTER,
      queued: false,
      reused: true,
      replayState: 'failed',
      dedupeSource: 'idempotency_key',
      idempotencyKey: 'idem-1',
    });
    expect(result.message).toContain('já falhou anteriormente');
  });

  it('reutiliza a operação existente pelo hash do arquivo quando o request é repetido', async () => {
    repository.findOne.mockResolvedValueOnce(
      makeDocumentImport({
        status: DocumentImportStatus.COMPLETED,
        processingJobId: 'job-1',
        processingAttempts: 1,
      }),
    );
    queue.getJob.mockResolvedValue({
      id: 'job-1',
      attemptsMade: 1,
      opts: { attempts: 3 },
      getState: jest.fn().mockResolvedValue('completed'),
    });

    const result = await service.enqueueDocumentProcessing(
      Buffer.from('%PDF-1.4 async'),
      COMPANY_ID,
      'APR',
    );

    expect(queue.add).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      documentId: DOCUMENT_ID,
      status: DocumentImportStatus.COMPLETED,
      reused: true,
      replayState: 'completed',
      dedupeSource: 'file_hash',
    });
  });

  it('conclui importação DDS sem criar rascunho automaticamente antes da validação humana', async () => {
    queryBuilder.getOne
      .mockResolvedValueOnce(
        makeDocumentImport({
          id: DOCUMENT_ID,
          status: DocumentImportStatus.QUEUED,
          tipoDocumento: 'DDS',
          processingJobId: `document-import-${DOCUMENT_ID}`,
          arquivoStagingKey: 'document-import-staging/company-1/hash-1',
        }),
      )
      .mockResolvedValueOnce(
        makeDocumentImport({
          id: DOCUMENT_ID,
          status: DocumentImportStatus.PROCESSING,
          tipoDocumento: 'DDS',
          processingJobId: `document-import-${DOCUMENT_ID}`,
        }),
      )
      .mockResolvedValueOnce(
        makeDocumentImport({
          id: DOCUMENT_ID,
          status: DocumentImportStatus.VALIDATING,
          tipoDocumento: 'DDS',
          processingJobId: `document-import-${DOCUMENT_ID}`,
          metadata: {
            queue: {
              attempts: 3,
              timeoutMs: 180000,
              statusUrl: `/documents/import/${DOCUMENT_ID}/status`,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        makeDocumentImport({
          id: DOCUMENT_ID,
          status: DocumentImportStatus.COMPLETED,
          tipoDocumento: 'DDS',
          processingJobId: `document-import-${DOCUMENT_ID}`,
          metadata: {
            queue: {
              attempts: 3,
              timeoutMs: 180000,
              statusUrl: `/documents/import/${DOCUMENT_ID}/status`,
            },
          },
        }),
      );

    const result = await service.processQueuedDocument(DOCUMENT_ID, {
      allowExternalAi: true,
    });

    expect(ddsService.create).not.toHaveBeenCalled();
    expect(documentClassifierService.classifyDocument).toHaveBeenCalledWith(
      'conteudo extraido',
      { useExternalAi: true },
    );
    expect(documentInterpreterService.interpretDocument).toHaveBeenCalledWith(
      'conteudo extraido',
      'DDS',
      { useExternalAi: true },
    );
    expect(repository.save).toHaveBeenCalled();
    const [savedRecord] = repository.save.mock.calls.at(-1) as [DocumentImport];
    expect(savedRecord.status).toBe(DocumentImportStatus.COMPLETED);
    expect(savedRecord.metadata?.autoCreateDds).toBeUndefined();
    expect(result).toMatchObject({
      documentId: DOCUMENT_ID,
      status: DocumentImportStatus.COMPLETED,
    });
  });

  it('retorna 404 tipado quando a importação não existe para processamento', async () => {
    queryBuilder.getOne.mockResolvedValue(null);

    await expect(
      service.processQueuedDocument(DOCUMENT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('retorna 503 tipado quando o staging não está disponível', async () => {
    queryBuilder.getOne.mockResolvedValue(
      makeDocumentImport({
        id: DOCUMENT_ID,
        status: DocumentImportStatus.QUEUED,
        arquivoStaging: null,
        arquivoStagingKey: null,
      }),
    );

    await expect(
      service.processQueuedDocument(DOCUMENT_ID),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('retorna 422 tipado quando o registro desaparece após concluir o processamento', async () => {
    queryBuilder.getOne
      .mockResolvedValueOnce(
        makeDocumentImport({
          id: DOCUMENT_ID,
          status: DocumentImportStatus.QUEUED,
          tipoDocumento: 'APR',
        }),
      )
      .mockResolvedValueOnce(null);

    documentValidationService.validateDocument.mockReturnValue({
      status: 'VALIDO',
      pendencias: [],
      scoreConfianca: 88,
    });

    await expect(
      service.processQueuedDocument(DOCUMENT_ID),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('gera prévia DDS tenant-scoped a partir de importação concluída', async () => {
    queryBuilder.getOne.mockResolvedValue(
      makeDocumentImport({
        id: DOCUMENT_ID,
        status: DocumentImportStatus.COMPLETED,
        tipoDocumento: 'DDS',
        textoExtraido: 'texto base do DDS',
        jsonEstruturado: {
          tipoDocumento: 'DDS',
          tema: 'DDS Importado',
          conteudo: 'Conteudo importado',
          data: '2026-03-20T10:00:00.000Z',
          nrsCitadas: [],
          riscos: [],
          epis: [],
          assinaturas: [],
          camposEstruturados: {
            participantes: [{ nome: 'Ana TST' }, { nome: 'Bruno' }],
          },
        },
      }),
    );

    const result = await service.getDdsDraftPreview(DOCUMENT_ID, COMPANY_ID);

    expect(result).toMatchObject({
      documentId: DOCUMENT_ID,
      preview: {
        tema: 'DDS Importado',
        conteudo: 'Conteudo importado',
        data: '2026-03-20T10:00:00.000Z',
        participantesSugeridos: ['Ana TST', 'Bruno'],
      },
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'documentImport.empresaId = :tenantId',
      { tenantId: COMPANY_ID },
    );
  });

  it('cria rascunho DDS somente após confirmação humana', async () => {
    queryBuilder.getOne.mockResolvedValue(
      makeDocumentImport({
        id: DOCUMENT_ID,
        status: DocumentImportStatus.COMPLETED,
        tipoDocumento: 'DDS',
        jsonEstruturado: {
          tipoDocumento: 'DDS',
          tema: 'DDS Importado',
          conteudo: 'Conteudo importado',
          data: '2026-03-20T10:00:00.000Z',
          nrsCitadas: [],
          riscos: [],
          epis: [],
          assinaturas: [],
        },
      }),
    );
    ddsService.create.mockResolvedValue({
      id: 'dds-1',
      status: 'rascunho',
    });

    const result = await service.createDdsDraftFromImport(
      DOCUMENT_ID,
      COMPANY_ID,
      {
        tema: 'DDS Validado',
        conteudo: 'Conteúdo validado',
        data: '2026-03-20',
        site_id: '11111111-1111-4111-8111-111111111111',
        facilitador_id: '22222222-2222-4222-8222-222222222222',
        participants: ['33333333-3333-4333-8333-333333333333'],
      },
    );

    expect(ddsService.create).toHaveBeenCalledWith({
      tema: 'DDS Validado',
      conteudo: 'Conteúdo validado',
      data: '2026-03-20',
      site_id: '11111111-1111-4111-8111-111111111111',
      facilitador_id: '22222222-2222-4222-8222-222222222222',
      participants: ['33333333-3333-4333-8333-333333333333'],
    });
    const [, updatePayload] = repository.update.mock.calls.at(-1) as [
      { id: string; empresaId: string },
      { metadata?: DocumentImport['metadata'] },
    ];
    expect(updatePayload.metadata).toMatchObject({
      autoCreatedDdsId: 'dds-1',
      autoCreateDds: {
        state: 'created',
        ddsId: 'dds-1',
      },
    });
    expect(result).toEqual({
      documentId: DOCUMENT_ID,
      ddsId: 'dds-1',
      status: 'rascunho',
    });
  });

  it('reaproveita DDS já vinculado e não duplica rascunho', async () => {
    queryBuilder.getOne.mockResolvedValue(
      makeDocumentImport({
        id: DOCUMENT_ID,
        status: DocumentImportStatus.COMPLETED,
        tipoDocumento: 'DDS',
        metadata: {
          autoCreatedDdsId: 'dds-1',
          autoCreateDds: {
            state: 'created',
            ddsId: 'dds-1',
          },
        },
        jsonEstruturado: {
          tipoDocumento: 'DDS',
          tema: 'DDS Importado',
          conteudo: 'Conteudo importado',
          data: '2026-03-20T10:00:00.000Z',
          nrsCitadas: [],
          riscos: [],
          epis: [],
          assinaturas: [],
        },
      }),
    );
    ddsService.findOne.mockResolvedValue({
      id: 'dds-1',
      status: 'rascunho',
    });

    const result = await service.createDdsDraftFromImport(
      DOCUMENT_ID,
      COMPANY_ID,
      {
        tema: 'DDS Validado',
        conteudo: 'Conteúdo validado',
        data: '2026-03-20',
        site_id: '11111111-1111-4111-8111-111111111111',
        facilitador_id: '22222222-2222-4222-8222-222222222222',
        participants: [],
      },
    );

    expect(ddsService.create).not.toHaveBeenCalled();
    expect(ddsService.findOne).toHaveBeenCalledWith('dds-1');
    expect(result).toEqual({
      documentId: DOCUMENT_ID,
      ddsId: 'dds-1',
      status: 'rascunho',
    });
  });

  it('bloqueia prévia DDS para importação ainda não concluída', async () => {
    queryBuilder.getOne.mockResolvedValue(
      makeDocumentImport({
        id: DOCUMENT_ID,
        status: DocumentImportStatus.PROCESSING,
        tipoDocumento: 'DDS',
      }),
    );

    await expect(
      service.getDdsDraftPreview(DOCUMENT_ID, COMPANY_ID),
    ).rejects.toThrow(
      'A importação ainda não foi concluída para gerar rascunho de DDS.',
    );
  });
});
