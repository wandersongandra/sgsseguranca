import { BadRequestException } from '@nestjs/common';
import { EntityManager, IsNull, QueryFailedError, Repository } from 'typeorm';
import { PtsService } from './pts.service';
import { Pt, PtStatus } from './entities/pt.entity';
import { Signature } from '../signatures/entities/signature.entity';
import { Company } from '../companies/entities/company.entity';
import { AuditLog } from '../audit-trail/entities/audit-log.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { RiskCalculationService } from '../../shared/services/risk-calculation.service';
import { AuditService } from '../audit-trail/audit.service';
import { WorkerOperationalStatusService } from '../users/worker-operational-status.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import type { DocumentBundleService } from '../../shared/services/document-bundle.service';
import { AuditAction } from '../audit-trail/enums/audit-action.enum';
import { SignaturesService } from '../signatures/signatures.service';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';
import { Site } from '../sites/entities/site.entity';
import { Apr } from '../aprs/entities/apr.entity';
import { User } from '../users/entities/user.entity';
import type { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import type { AppendForensicTrailEventInput } from '../forensic-trail/forensic-trail.service';
import { markAuthorizedStorageReference } from '../../shared/storage/storage-object-reference';

type RegisterFinalDocumentInput = Parameters<
  DocumentGovernanceService['registerFinalDocument']
>[0];
type RemoveFinalDocumentReferenceInput = Parameters<
  DocumentGovernanceService['removeFinalDocumentReference']
>[0];

describe('PtsService', () => {
  let service: PtsService;
  let ptsRepository: jest.Mocked<Repository<Pt>>;
  let companiesRepository: jest.Mocked<Repository<Company>>;
  let auditLogsRepository: jest.Mocked<Repository<AuditLog>>;
  let ptsSaveMock: jest.Mock;
  let auditLogsFindMock: jest.Mock;
  let tenantService: Partial<TenantService>;
  let riskCalculationService: Partial<RiskCalculationService>;
  let auditService: Partial<AuditService>;
  let workerOperationalStatusService: Partial<WorkerOperationalStatusService>;
  let documentStorageService: Partial<DocumentStorageService>;
  let documentGovernanceService: Partial<DocumentGovernanceService>;
  let signaturesService: Partial<SignaturesService>;
  let publicValidationGrantService: {
    issueToken: jest.Mock;
  };
  let forensicTrailService: Partial<ForensicTrailService>;
  let getRepositoryMock: jest.Mock<unknown, [unknown?]>;
  let signaturesRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
    softDelete: jest.Mock;
  };
  let defaultScopedRepository: {
    exist: jest.Mock;
    count: jest.Mock;
  };

  beforeEach(() => {
    ptsSaveMock = jest.fn((input: Pt) => Promise.resolve(input));
    auditLogsFindMock = jest.fn();
    ptsRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: ptsSaveMock,
      create: jest.fn((input: Partial<Pt>) => input),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      count: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<Repository<Pt>>;
    companiesRepository = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Company>>;
    auditLogsRepository = {
      find: auditLogsFindMock,
    } as unknown as jest.Mocked<Repository<AuditLog>>;
    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
      getContext: jest.fn().mockReturnValue({
        companyId: 'company-1',
        siteScope: 'all',
        isSuperAdmin: false,
      }),
    };
    riskCalculationService = {
      calculateScore: jest.fn(),
      classifyByScore: jest.fn(),
    };
    auditService = {
      log: jest.fn(),
    };
    workerOperationalStatusService = {
      getByUserIds: jest.fn().mockResolvedValue([]),
    };
    documentStorageService = {
      generateDocumentKey: jest.fn(
        () => 'documents/company-1/pts/sites/site-1/pt-1/pt-final.pdf',
      ),
      referenceForExistingObject: jest.fn((key: string) => ({
        tenantId: 'company-1',
        key,
        owner: { resourceType: 'test', resourceId: key },
        purpose: 'test',
        legacy: !key.startsWith('documents/company-1/'),
      })),
      uploadFile: jest.fn(() => Promise.resolve()),
      uploadFileWithCapability: jest.fn((reference) =>
        Promise.resolve(markAuthorizedStorageReference(reference)),
      ),
      deleteFile: jest.fn(() => Promise.resolve()),
    };
    documentGovernanceService = {
      listFinalDocuments: jest.fn(),
      registerFinalDocument: jest.fn(),
      removeFinalDocumentReference: jest.fn(),
    };
    const documentBundleService = {
      buildWeeklyPdfBundle: jest.fn(),
    };
    signaturesService = {
      findByDocument: jest.fn().mockResolvedValue([]),
      createWithManager: jest.fn().mockResolvedValue({
        id: 'signature-1',
        signature_data_key: null,
      }),
      replaceDocumentSignatures: jest.fn().mockResolvedValue([]),
    };
    publicValidationGrantService = {
      issueToken: jest.fn().mockResolvedValue('pt-validation-token'),
    };
    forensicTrailService = {
      append: jest.fn().mockResolvedValue(undefined),
    };
    defaultScopedRepository = {
      exist: jest.fn().mockResolvedValue(true),
      count: jest
        .fn()
        .mockImplementation((opts?: { where?: { id?: string[] } }) => {
          const ids = opts?.where?.id;
          return Array.isArray(ids) ? ids.length : 0;
        }),
    };
    getRepositoryMock = jest.fn((entity: unknown) =>
      entity === Company ? companiesRepository : defaultScopedRepository,
    );
    signaturesRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      softDelete: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    (
      ptsRepository as unknown as {
        manager: { getRepository: jest.Mock; transaction: jest.Mock };
      }
    ).manager = {
      getRepository: getRepositoryMock,
      transaction: jest.fn((callback: (manager: unknown) => unknown) =>
        Promise.resolve(
          callback({
            getRepository: jest.fn((entity: unknown) => {
              if (entity === Pt) {
                return {
                  create: jest.fn((input: Pt) => input),
                  findOne: jest.fn((options: unknown) =>
                    ptsRepository.findOne(options as never),
                  ),
                  save: jest.fn((input: Pt) => Promise.resolve(input)),
                };
              }
              if (entity === Signature) {
                return signaturesRepository;
              }
              return getRepositoryMock(entity) as {
                exist?: jest.Mock;
                count?: jest.Mock;
              };
            }),
            query: jest.fn(async (_sql: string, params?: unknown[]) => {
              if (_sql.includes('pt_executantes')) {
                const id = typeof params?.[0] === 'string' ? params[0] : '';
                const tenantId =
                  typeof params?.[1] === 'string' ? params[1] : undefined;
                const scopedPt = await ptsRepository.findOne({
                  where: tenantId ? { id, company_id: tenantId } : { id },
                });
                return Array.isArray(scopedPt?.executantes)
                  ? scopedPt.executantes.map((user) => ({ user_id: user.id }))
                  : [{ user_id: 'user-1' }];
              }
              const id = typeof params?.[0] === 'string' ? params[0] : '';
              const tenantId =
                typeof params?.[1] === 'string' ? params[1] : undefined;
              const pt = await ptsRepository.findOne({
                where: tenantId ? { id, company_id: tenantId } : { id },
              });
              return pt ? [pt] : [];
            }),
          }),
        ),
      ),
    };

    service = new PtsService(
      ptsRepository,
      companiesRepository,
      auditLogsRepository,
      tenantService as TenantService,
      riskCalculationService as RiskCalculationService,
      auditService as unknown as AuditService,
      workerOperationalStatusService as WorkerOperationalStatusService,
      documentStorageService as DocumentStorageService,
      documentGovernanceService as DocumentGovernanceService,
      documentBundleService as unknown as DocumentBundleService,
      signaturesService as SignaturesService,
      publicValidationGrantService as unknown as PublicValidationGrantService,
      forensicTrailService as ForensicTrailService,
    );
  });

  it('registra a pré-liberação no audit log com ação PRE_APPROVAL', async () => {
    const pt = {
      id: 'pt-1',
      numero: 'PT-001',
      titulo: 'Trabalho em altura',
      status: 'Pendente',
      company_id: 'company-1',
    } as unknown as Pt;

    ptsRepository.findOne.mockResolvedValue(pt);

    await service.logPreApprovalReview('pt-1', 'user-1', {
      stage: 'preview',
      readyForRelease: false,
      blockers: ['Selecionar ao menos um executante.'],
      unansweredChecklistItems: 2,
      adverseChecklistItems: 1,
      pendingSignatures: 1,
      hasRapidRiskBlocker: false,
      workerStatuses: [],
      warnings: [],
      rules: {
        blockCriticalRiskWithoutEvidence: true,
        blockWorkerWithoutValidMedicalExam: true,
        blockWorkerWithExpiredBlockingTraining: true,
        requireAtLeastOneExecutante: true,
      },
    });

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: AuditAction.PRE_APPROVAL,
        entity: 'PT',
        entityId: 'pt-1',
        companyId: 'company-1',
      }),
    );
  });

  it('retorna histórico de pré-liberação mapeado a partir do audit log', async () => {
    const pt = {
      id: 'pt-1',
      company_id: 'company-1',
    } as unknown as Pt;

    const createdAt = new Date('2026-03-14T12:00:00.000Z');

    ptsRepository.findOne.mockResolvedValue(pt);
    auditLogsFindMock.mockResolvedValue([
      {
        id: 'audit-1',
        action: AuditAction.PRE_APPROVAL,
        userId: 'user-1',
        created_at: createdAt,
        timestamp: createdAt,
        after: {
          review: {
            stage: 'approval_requested',
            readyForRelease: true,
            blockers: [],
            unansweredChecklistItems: 0,
            adverseChecklistItems: 0,
            pendingSignatures: 0,
            hasRapidRiskBlocker: false,
            warnings: [],
            checklist: {
              reviewedReadiness: true,
              reviewedWorkers: true,
              confirmedRelease: true,
            },
          },
        },
      },
    ]);

    const result = await service.getPreApprovalHistory('pt-1');
    const findCalls = auditLogsFindMock.mock.calls as unknown as Array<
      [
        {
          where?: {
            entity?: string;
            entityId?: string;
            action?: AuditAction;
            companyId?: string;
          };
        },
      ]
    >;
    const findArgs = findCalls[0]?.[0];

    expect(auditLogsFindMock).toHaveBeenCalledTimes(1);
    expect(findArgs?.where).toEqual(
      expect.objectContaining({
        entity: 'PT',
        entityId: 'pt-1',
        action: AuditAction.PRE_APPROVAL,
        companyId: 'company-1',
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: 'audit-1',
        userId: 'user-1',
        stage: 'approval_requested',
        readyForRelease: true,
        checklist: {
          reviewedReadiness: true,
          reviewedWorkers: true,
          confirmedRelease: true,
        },
      }),
    ]);
  });

  it('anexa o PDF final da PT pela esteira central quando a PT ja esta aprovada', async () => {
    const pt = {
      id: 'pt-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'PT Trabalho em altura',
      numero: 'PT-001',
      status: PtStatus.APROVADA,
      data_hora_inicio: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
    } as unknown as Pt;
    const update = jest.fn();
    const manager = {
      getRepository: jest.fn(() => ({ update })),
    } as unknown as EntityManager;
    ptsRepository.findOne.mockResolvedValue(pt);
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockImplementation(async (input: RegisterFinalDocumentInput) => {
      await input.persistEntityMetadata?.(manager, 'hash-pt');
      return { hash: 'hash-pt', registryEntry: { id: 'registry-pt' } };
    });

    const file = {
      originalname: 'pt-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-pt'),
    } as Express.Multer.File;

    await expect(service.attachPdf('pt-1', file, 'user-1')).resolves.toEqual({
      fileKey: 'documents/company-1/pts/sites/site-1/pt-1/pt-final.pdf',
      folderPath: 'documents/company-1/pts/sites/site-1/pt-1',
      originalName: 'pt-final.pdf',
    });

    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        module: 'pt',
        entityId: 'pt-1',
        // Deve ser o número cru da PT (paridade com o código impresso no QR do
        // PDF pelo frontend), não um código derivado do id/titulo. Sem isso,
        // o /validar retornaria "inválido" para uma PT legítima.
        documentCode: 'PT-001',
        fileBuffer: file.buffer,
        createdBy: 'user-1',
      }),
    );
    const registerCalls = (
      Reflect.get(
        documentGovernanceService,
        'registerFinalDocument',
      ) as jest.Mock
    ).mock.calls as Array<[RegisterFinalDocumentInput]>;
    expect(registerCalls[0]?.[0]?.transactionManager).toBeDefined();
    expect(update).toHaveBeenCalledWith(
      'pt-1',
      expect.objectContaining({
        pdf_file_key: 'documents/company-1/pts/sites/site-1/pt-1/pt-final.pdf',
        pdf_folder_path: 'documents/company-1/pts/sites/site-1/pt-1',
        pdf_original_name: 'pt-final.pdf',
        final_pdf_hash_sha256: 'hash-pt',
      }),
    );
    const updateCalls = update.mock.calls as Array<
      [string, { pdf_generated_at?: unknown }]
    >;
    expect(updateCalls[0]?.[1]?.pdf_generated_at).toBeInstanceOf(Date);
  });

  it('adquire o lock da PT antes de enviar o PDF ao storage', async () => {
    const pt = {
      id: 'pt-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'PT Trabalho em altura',
      numero: 'PT-001',
      status: PtStatus.APROVADA,
      data_hora_inicio: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
    } as unknown as Pt;
    ptsRepository.findOne.mockResolvedValue(pt);

    const update = jest.fn();
    const metadataManager = {
      getRepository: jest.fn(() => ({ update })),
    } as unknown as EntityManager;
    let lockAcquired = false;
    const transaction = Reflect.get(
      ptsRepository.manager,
      'transaction',
    ) as jest.Mock;
    transaction.mockImplementation(
      async (callback: (manager: EntityManager) => Promise<unknown>) => {
        lockAcquired = true;
        const lockedManager = {
          query: jest.fn((sql: string) =>
            sql.includes('pt_executantes')
              ? Promise.resolve([{ user_id: 'user-1' }])
              : Promise.resolve([pt]),
          ),
          getRepository: jest.fn(() => ({
            create: jest.fn((input: Pt) => ({ ...input })),
            save: jest.fn((input: Pt) => Promise.resolve(input)),
          })),
        } as unknown as EntityManager;
        return callback(lockedManager);
      },
    );

    const upload = Reflect.get(
      documentStorageService,
      'uploadFileWithCapability',
    ) as jest.Mock;
    upload.mockImplementation((reference: { key: string }) => {
      expect(lockAcquired).toBe(true);
      return markAuthorizedStorageReference(reference as never);
    });
    const register = Reflect.get(
      documentGovernanceService,
      'registerFinalDocument',
    ) as jest.Mock;
    register.mockImplementation(async (input: RegisterFinalDocumentInput) => {
      await input.persistEntityMetadata?.(metadataManager, 'hash-pt');
      return { hash: 'hash-pt', registryEntry: { id: 'registry-pt' } };
    });

    const file = {
      originalname: 'pt-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-pt'),
    } as Express.Multer.File;

    await expect(service.attachPdf('pt-1', file, 'user-1')).resolves.toEqual(
      expect.objectContaining({ originalName: 'pt-final.pdf' }),
    );
    expect(lockAcquired).toBe(true);
  });

  it('degrada para os metadados mínimos quando a base ainda não possui hash/timestamp final da PT', async () => {
    const pt = {
      id: 'pt-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'PT Trabalho em altura',
      numero: 'PT-001',
      status: PtStatus.APROVADA,
      data_hora_inicio: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
    } as unknown as Pt;
    const update = jest
      .fn()
      .mockRejectedValueOnce(
        new QueryFailedError(
          'UPDATE "pts"',
          [],
          Object.assign(
            new Error('column "final_pdf_hash_sha256" does not exist'),
            {
              code: '42703',
              column: 'final_pdf_hash_sha256',
            },
          ),
        ),
      )
      .mockResolvedValueOnce({ affected: 1 });
    const manager = {
      getRepository: jest.fn(() => ({ update })),
    } as unknown as EntityManager;
    ptsRepository.findOne.mockResolvedValue(pt);
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockImplementation(async (input: RegisterFinalDocumentInput) => {
      await input.persistEntityMetadata?.(manager, 'hash-pt');
      return { hash: 'hash-pt', registryEntry: { id: 'registry-pt' } };
    });

    const file = {
      originalname: 'pt-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-pt'),
    } as Express.Multer.File;

    await expect(service.attachPdf('pt-1', file, 'user-1')).resolves.toEqual({
      fileKey: 'documents/company-1/pts/sites/site-1/pt-1/pt-final.pdf',
      folderPath: 'documents/company-1/pts/sites/site-1/pt-1',
      originalName: 'pt-final.pdf',
    });

    const updateCalls = update.mock.calls as Array<
      [string, Record<string, unknown>]
    >;
    expect(update).toHaveBeenCalledTimes(2);
    expect(updateCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        pdf_file_key: 'documents/company-1/pts/sites/site-1/pt-1/pt-final.pdf',
        pdf_folder_path: 'documents/company-1/pts/sites/site-1/pt-1',
        pdf_original_name: 'pt-final.pdf',
        final_pdf_hash_sha256: 'hash-pt',
      }),
    );
    expect(updateCalls[1]?.[1]).toEqual({
      pdf_file_key: 'documents/company-1/pts/sites/site-1/pt-1/pt-final.pdf',
      pdf_folder_path: 'documents/company-1/pts/sites/site-1/pt-1',
      pdf_original_name: 'pt-final.pdf',
    });
    expect(documentStorageService.deleteFile).not.toHaveBeenCalled();
  });

  it('remove o arquivo do storage quando a governanca falha depois do upload da PT', async () => {
    const pt = {
      id: 'pt-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'PT Trabalho em altura',
      numero: 'PT-001',
      status: PtStatus.APROVADA,
      data_hora_inicio: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
    } as unknown as Pt;
    ptsRepository.findOne.mockResolvedValue(pt);
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockRejectedValue(new Error('governance failed'));

    const file = {
      originalname: 'pt-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-pt'),
    } as Express.Multer.File;

    await expect(service.attachPdf('pt-1', file, 'user-1')).rejects.toThrow(
      'governance failed',
    );

    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/pts/sites/site-1/pt-1/pt-final.pdf',
      }),
    );
  });

  it('falha imediatamente quando o storage governado da PT está indisponível', async () => {
    const pt = {
      id: 'pt-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'PT Trabalho em altura',
      numero: 'PT-001',
      status: PtStatus.APROVADA,
      data_hora_inicio: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
    } as unknown as Pt;
    ptsRepository.findOne.mockResolvedValue(pt);
    (
      documentStorageService.uploadFileWithCapability as jest.Mock
    ).mockRejectedValue(new Error('S3 is not enabled'));
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockRejectedValue(new Error('governance failed'));

    const file = {
      originalname: 'pt-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-pt'),
    } as Express.Multer.File;

    await expect(service.attachPdf('pt-1', file, 'user-1')).rejects.toThrow(
      'S3 is not enabled',
    );

    expect(
      documentGovernanceService.registerFinalDocument,
    ).not.toHaveBeenCalled();
    expect(documentStorageService.deleteFile).not.toHaveBeenCalled();
  });

  it('bloqueia o anexo final quando a PT ainda nao esta aprovada', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
    } as unknown as Pt);

    const file = {
      originalname: 'pt-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-pt'),
    } as Express.Multer.File;

    await expect(service.attachPdf('pt-1', file, 'user-1')).rejects.toThrow(
      BadRequestException,
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
    expect(
      documentGovernanceService.registerFinalDocument,
    ).not.toHaveBeenCalled();
  });

  it('bloqueia edicao quando a PT ja possui PDF final', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.APROVADA,
      pdf_file_key: 'documents/company-1/pts/pt-1/pt-final.pdf',
    } as unknown as Pt);

    await expect(
      service.update('pt-1', { titulo: 'Novo titulo' }),
    ).rejects.toThrow(BadRequestException);

    expect(ptsSaveMock).not.toHaveBeenCalled();
  });

  it('bloqueia rejeicao quando a PT ja possui PDF final', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.APROVADA,
      pdf_file_key: 'documents/company-1/pts/pt-1/pt-final.pdf',
    } as unknown as Pt);

    await expect(
      service.reject('pt-1', 'user-1', 'Rejeitada depois do PDF'),
    ).rejects.toThrow(BadRequestException);
  });

  it('registra cancelamento da PT na trilha imutável', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
    } as unknown as Pt);

    await expect(
      service.reject('pt-1', 'user-1', 'Condição insegura'),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'pt-1',
        status: PtStatus.CANCELADA,
      }),
    );

    const appendCalls = (forensicTrailService.append as jest.Mock).mock
      .calls as Array<[AppendForensicTrailEventInput, { manager?: unknown }]>;
    const firstAppendCall = appendCalls[0];
    if (!firstAppendCall) {
      throw new Error('Expected forensic append call');
    }
    const [appendInput, appendOptions] = firstAppendCall;
    const appendMetadata = appendInput.metadata as Record<string, unknown>;
    expect(appendInput.eventType).toBe(FORENSIC_EVENT_TYPES.DOCUMENT_CANCELED);
    expect(appendInput.module).toBe('pt');
    expect(appendInput.entityId).toBe('pt-1');
    expect(appendInput.companyId).toBe('company-1');
    expect(appendInput.userId).toBe('user-1');
    expect(appendMetadata.previousStatus).toBe(PtStatus.PENDENTE);
    expect(appendMetadata.currentStatus).toBe(PtStatus.CANCELADA);
    expect(appendMetadata.reason).toBe('Condição insegura');
    expect(appendOptions.manager).toBeDefined();
  });

  it('remove a PT via esteira central e aplica a policy de lifecycle', async () => {
    const pt = {
      id: 'pt-1',
      company_id: 'company-1',
    } as unknown as Pt;
    const softDelete = jest.fn();
    const manager = {
      getRepository: jest.fn(() => ({ softDelete })),
    } as unknown as EntityManager;
    ptsRepository.findOne.mockResolvedValue(pt);
    (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mockImplementation(async (input: RemoveFinalDocumentReferenceInput) => {
      await input.removeEntityState?.(manager);
    });

    await expect(service.remove('pt-1')).resolves.toBeUndefined();

    expect(
      documentGovernanceService.removeFinalDocumentReference,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        module: 'pt',
        entityId: 'pt-1',
        trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
        trailMetadata: {
          removalMode: 'soft_delete',
        },
      }),
    );
    expect(softDelete).toHaveBeenCalledWith('pt-1');
    expect(
      (ptsRepository.manager as unknown as { transaction: jest.Mock })
        .transaction,
    ).toHaveBeenCalled();
  });

  it('bloqueia remocao de PT que ja tem PDF final emitido', async () => {
    const pt = {
      id: 'pt-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/pt-1.pdf',
    } as unknown as Pt;
    ptsRepository.findOne.mockResolvedValue(pt);

    await expect(service.remove('pt-1')).rejects.toThrow('sem PDF final');
    expect(
      documentGovernanceService.removeFinalDocumentReference,
    ).not.toHaveBeenCalled();
  });

  it('bloqueia create generico com status de aprovacao sensivel', async () => {
    await expect(
      service.create({
        numero: 'PT-001',
        titulo: 'PT sensivel',
        data_hora_inicio: '2026-03-14T08:00:00.000Z',
        data_hora_fim: '2026-03-14T18:00:00.000Z',
        site_id: 'site-1',
        responsavel_id: 'user-1',
        status: PtStatus.APROVADA,
      }),
    ).rejects.toThrow(BadRequestException);

    expect(ptsSaveMock).not.toHaveBeenCalled();
  });

  it('bloqueia create quando o site nao pertence a empresa atual', async () => {
    getRepositoryMock.mockImplementation((entity: unknown) => {
      if (entity === Site) {
        return {
          exist: jest.fn().mockResolvedValue(false),
        };
      }
      return defaultScopedRepository;
    });

    await expect(
      service.create({
        numero: 'PT-001',
        titulo: 'PT com site invalido',
        data_hora_inicio: '2026-03-14T08:00:00.000Z',
        data_hora_fim: '2026-03-14T18:00:00.000Z',
        site_id: 'site-fora-tenant',
        responsavel_id: 'user-1',
      }),
    ).rejects.toThrow('Site inválido para a empresa/tenant atual.');

    expect(ptsSaveMock).not.toHaveBeenCalled();
  });

  it('preserva a obra permitida selecionada quando o tenant possui acesso a varias obras', async () => {
    tenantService.getContext = jest.fn().mockReturnValue({
      companyId: 'company-1',
      siteId: 'site-a',
      siteIds: ['site-a', 'site-b'],
      siteScope: 'single',
      isSuperAdmin: false,
    });
    getRepositoryMock.mockImplementation((entity: unknown) => {
      if (entity === User) {
        return {
          exist: jest.fn().mockResolvedValue(true),
          count: jest.fn().mockResolvedValue(1),
        };
      }
      return defaultScopedRepository;
    });

    await service.create({
      numero: 'PT-MULTI-SITE',
      titulo: 'PT na segunda obra permitida',
      data_hora_inicio: '2026-03-14T08:00:00.000Z',
      data_hora_fim: '2026-03-14T18:00:00.000Z',
      site_id: 'site-b',
      responsavel_id: 'user-1',
    });

    expect(ptsSaveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: 'company-1',
        site_id: 'site-b',
      }),
    );
  });

  it('bloqueia APR de outra obra ao criar a PT', async () => {
    getRepositoryMock.mockImplementation((entity: unknown) => {
      if (entity === Apr) {
        return {
          exist: jest
            .fn()
            .mockImplementation((options: { where?: { site_id?: string } }) =>
              Promise.resolve(options.where?.site_id === undefined),
            ),
        };
      }
      if (entity === User) {
        return {
          exist: jest.fn().mockResolvedValue(true),
          count: jest.fn().mockResolvedValue(1),
        };
      }
      return defaultScopedRepository;
    });

    await expect(
      service.create({
        numero: 'PT-APR-SITE',
        titulo: 'PT com APR de outra obra',
        data_hora_inicio: '2026-03-14T08:00:00.000Z',
        data_hora_fim: '2026-03-14T18:00:00.000Z',
        site_id: 'site-1',
        apr_id: 'apr-site-2',
        responsavel_id: 'user-1',
      }),
    ).rejects.toThrow('APR vinculada inválida para a obra/setor selecionada.');

    expect(ptsSaveMock).not.toHaveBeenCalled();
  });

  it('bloqueia update generico quando tenta alterar o status da PT', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
      probability: 2,
      severity: 2,
      exposure: 2,
      residual_risk: 'LOW',
      control_evidence: false,
    } as unknown as Pt);

    await expect(
      service.update('pt-1', {
        titulo: 'Tentativa de aprovar no update',
        status: PtStatus.APROVADA,
      }),
    ).rejects.toThrow(BadRequestException);

    expect(ptsSaveMock).not.toHaveBeenCalled();
  });

  it('bloqueia update quando a PT ja saiu do estado pendente', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.APROVADA,
      pdf_file_key: null,
      probability: 2,
      severity: 2,
      exposure: 2,
      residual_risk: 'LOW',
      control_evidence: false,
      titulo: 'PT original',
    } as unknown as Pt);

    await expect(
      service.update('pt-1', { titulo: 'PT atualizada' }),
    ).rejects.toThrow(
      'Somente PTs pendentes podem ser editadas pelo formulário.',
    );

    expect(ptsSaveMock).not.toHaveBeenCalled();
  });

  it('serializa update dentro da transação com lock da PT', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
      probability: 2,
      severity: 2,
      exposure: 2,
      residual_risk: 'LOW',
      control_evidence: false,
      executantes: [],
    } as unknown as Pt);

    await expect(
      service.update('pt-1', { titulo: 'PT atualizada' }),
    ).resolves.toEqual(
      expect.objectContaining({ id: 'pt-1', titulo: 'PT atualizada' }),
    );

    const transactionMock = (
      ptsRepository.manager as unknown as { transaction: jest.Mock }
    ).transaction;
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(ptsSaveMock).not.toHaveBeenCalled();
  });

  it('valida entidades relacionadas usando o manager da transação protegida', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      site_id: 'site-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
      probability: 2,
      severity: 2,
      exposure: 2,
      residual_risk: 'LOW',
      control_evidence: false,
      executantes: [],
    } as unknown as Pt);

    const validateScope = jest.spyOn(
      service as unknown as {
        validateRelatedEntityScope: (...args: unknown[]) => Promise<void>;
      },
      'validateRelatedEntityScope',
    );

    await service.update('pt-1', {
      titulo: 'PT atualizada no lock',
      site_id: 'site-1',
    });

    expect(validateScope).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-1' }),
      expect.anything(),
    );
  });

  it('substitui assinaturas da PT dentro da transação e limita aos executantes', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
      executantes: [{ id: 'user-1' }],
    } as unknown as Pt);
    (signaturesService.createWithManager as jest.Mock).mockResolvedValue({
      id: 'signature-1',
      signature_data_key: null,
    });
    signaturesRepository.find.mockResolvedValue([
      {
        id: 'signature-old',
        signature_data_key: 'documents/company-1/signatures/old.dat',
      },
    ]);

    await expect(
      service.replaceSignatures(
        'pt-1',
        {
          signatures: [
            {
              user_id: 'user-1',
              signature_data: 'data:image/png;base64,signature',
              type: 'drawn',
            },
          ],
        },
        'user-1',
      ),
    ).resolves.toEqual({ entityId: 'pt-1', replaced: 1 });

    expect(signaturesService.createWithManager).toHaveBeenCalledWith(
      expect.objectContaining({
        document_id: 'pt-1',
        document_type: 'PT',
        company_id: 'company-1',
        user_id: 'user-1',
        signer_user_id: 'user-1',
      }),
      'user-1',
      expect.any(Object) as unknown,
      'user-1',
    );
    expect(signaturesService.replaceDocumentSignatures).not.toHaveBeenCalled();
    expect(signaturesRepository.softDelete).toHaveBeenCalledWith({
      document_id: 'pt-1',
      document_type: 'PT',
      company_id: 'company-1',
      deleted_at: IsNull(),
    });
    expect(signaturesRepository.delete).not.toHaveBeenCalled();
    expect(documentStorageService.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('cria assinatura avulsa somente para executante e dentro do lock da PT', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
    } as unknown as Pt);
    signaturesRepository.findOne.mockResolvedValue(null);
    (signaturesService.createWithManager as jest.Mock).mockResolvedValue({
      id: 'signature-new',
      signature_data_key: null,
    });

    await expect(
      service.createSignature(
        'pt-1',
        {
          signature_data: 'data:image/png;base64,signature',
          type: 'drawn',
        },
        'user-1',
      ),
    ).resolves.toEqual({ entityId: 'pt-1', created: true });

    expect(signaturesRepository.findOne).toHaveBeenCalledWith({
      where: {
        document_id: 'pt-1',
        document_type: 'PT',
        company_id: 'company-1',
        user_id: 'user-1',
        deleted_at: IsNull(),
      },
    });
    expect(signaturesService.createWithManager).toHaveBeenCalledWith(
      expect.objectContaining({
        document_id: 'pt-1',
        document_type: 'PT',
        user_id: 'user-1',
        signer_user_id: 'user-1',
      }),
      'user-1',
      expect.any(Object) as unknown,
      'user-1',
    );
  });

  it('bloqueia assinatura avulsa de usuário que não é executante', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
    } as unknown as Pt);

    await expect(
      service.createSignature(
        'pt-1',
        { signature_data: 'signature', type: 'drawn' },
        'user-2',
      ),
    ).rejects.toThrow('Somente executantes vinculados à PT');

    expect(signaturesService.createWithManager).not.toHaveBeenCalled();
  });

  it('só limpa a evidência antiga depois do commit da transação externa', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
      executantes: [{ id: 'user-1' }],
    } as unknown as Pt);
    signaturesRepository.find.mockResolvedValue([
      {
        id: 'signature-old',
        signature_data_key: 'documents/company-1/signatures/old.dat',
      },
    ]);
    (
      signaturesService.replaceDocumentSignatures as jest.Mock
    ).mockImplementation(async () => {
      await (documentStorageService.deleteFile as jest.Mock)('old-key');
      return [];
    });
    (signaturesService.createWithManager as jest.Mock).mockResolvedValue({
      id: 'signature-new',
      signature_data_key: null,
    });

    const transactionManager = (
      ptsRepository.manager as unknown as { transaction: jest.Mock }
    ).transaction;
    transactionManager.mockImplementationOnce(
      async (callback: (manager: unknown) => Promise<unknown>) => {
        const manager = {
          getRepository: jest.fn((entity: unknown) => {
            if (entity === Pt) {
              return {
                create: jest.fn((input: Pt) => input),
                findOne: jest.fn((options: unknown) =>
                  ptsRepository.findOne(options as never),
                ),
                save: jest.fn((input: Pt) => Promise.resolve(input)),
              };
            }
            if (entity === Signature) {
              return signaturesRepository;
            }
            return getRepositoryMock(entity);
          }),
          query: jest.fn(async (_sql: string, params?: unknown[]) => {
            if (_sql.includes('pt_executantes')) {
              return [{ user_id: 'user-1' }];
            }
            const id = typeof params?.[0] === 'string' ? params[0] : '';
            const companyId = typeof params?.[1] === 'string' ? params[1] : '';
            const pt = await ptsRepository.findOne({
              where: { id, company_id: companyId },
            });
            return pt ? [pt] : [];
          }),
        };
        await callback(manager);
        throw new Error('commit failed');
      },
    );

    await expect(
      service.replaceSignatures(
        'pt-1',
        {
          signatures: [
            {
              user_id: 'user-1',
              signature_data: 'signature',
              type: 'drawn',
            },
          ],
        },
        'user-1',
      ),
    ).rejects.toThrow('commit failed');

    expect(documentStorageService.deleteFile).not.toHaveBeenCalled();
  });

  it('bloqueia assinatura de usuário que não está vinculado como executante', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
      executantes: [{ id: 'user-1' }],
    } as unknown as Pt);

    await expect(
      service.replaceSignatures(
        'pt-1',
        {
          signatures: [
            {
              user_id: 'user-2',
              signature_data: 'signature',
              type: 'drawn',
            },
          ],
        },
        'user-1',
      ),
    ).rejects.toThrow('Somente executantes vinculados à PT');

    expect(signaturesService.createWithManager).not.toHaveBeenCalled();
  });

  it('compensa evidência já criada quando uma assinatura posterior falha', async () => {
    const pt = {
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
    } as unknown as Pt;
    ptsRepository.findOne.mockResolvedValue(pt);
    signaturesRepository.find.mockResolvedValue([]);
    (signaturesService.createWithManager as jest.Mock)
      .mockResolvedValueOnce({
        id: 'signature-new-1',
        signature_data_key: 'documents/company-1/signatures/new-1.dat',
      })
      .mockRejectedValueOnce(new Error('second signature upload failed'));

    const transactionManager = (
      ptsRepository.manager as unknown as { transaction: jest.Mock }
    ).transaction;
    transactionManager.mockImplementationOnce(
      async (callback: (manager: unknown) => Promise<unknown>) => {
        const manager = {
          getRepository: jest.fn((entity: unknown) => {
            if (entity === Pt) {
              return { create: jest.fn((input: Pt) => input) };
            }
            if (entity === Signature) {
              return signaturesRepository;
            }
            return getRepositoryMock(entity);
          }),
          query: jest.fn((sql: string) => {
            if (sql.includes('pt_executantes')) {
              return [{ user_id: 'user-1' }, { user_id: 'user-2' }];
            }
            return [pt];
          }),
        };
        return callback(manager);
      },
    );

    await expect(
      service.replaceSignatures(
        'pt-1',
        {
          signatures: [
            {
              user_id: 'user-1',
              signature_data: 'signature-1',
              type: 'drawn',
            },
            {
              user_id: 'user-2',
              signature_data: 'signature-2',
              type: 'drawn',
            },
          ],
        },
        'user-1',
      ),
    ).rejects.toThrow('second signature upload failed');

    expect(documentStorageService.deleteFile).toHaveBeenCalledTimes(1);
    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/signatures/new-1.dat',
      }),
    );
  });

  it('bloqueia update quando executantes nao pertencem a empresa atual', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
      site_id: 'site-1',
      responsavel_id: 'user-1',
      apr_id: null,
      auditado_por_id: null,
      executantes: [{ id: 'user-1' }],
      probability: 2,
      severity: 2,
      exposure: 2,
      residual_risk: 'LOW',
      control_evidence: false,
    } as unknown as Pt);
    getRepositoryMock.mockImplementation((entity: unknown) => {
      if (entity === User) {
        return {
          exist: jest.fn().mockResolvedValue(true),
          count: jest.fn().mockResolvedValue(1),
        };
      }
      if (entity === Site || entity === Apr) {
        return {
          exist: jest.fn().mockResolvedValue(true),
        };
      }
      return defaultScopedRepository;
    });

    await expect(
      service.update('pt-1', {
        executantes: ['user-1', 'user-fora-tenant'],
      }),
    ).rejects.toThrow(
      'Executantes contém vínculo(s) inválido(s) para a empresa/tenant atual.',
    );

    expect(ptsSaveMock).not.toHaveBeenCalled();
  });

  it('bloqueia create quando usuarios nao pertencem a obra selecionada da PT', async () => {
    const userRepository = {
      exist: jest.fn().mockResolvedValue(true),
      count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1),
    };
    getRepositoryMock.mockImplementation((entity: unknown) => {
      if (entity === User) {
        return userRepository;
      }
      if (entity === Site || entity === Apr) {
        return {
          exist: jest.fn().mockResolvedValue(true),
        };
      }
      return defaultScopedRepository;
    });

    await expect(
      service.create({
        numero: 'PT-001',
        titulo: 'PT com executante fora da obra',
        data_hora_inicio: '2026-03-14T08:00:00.000Z',
        data_hora_fim: '2026-03-14T18:00:00.000Z',
        site_id: 'site-1',
        responsavel_id: 'user-1',
        executantes: ['user-1', 'user-outra-obra'],
      }),
    ).rejects.toThrow(
      'Usuários da PT contém vínculo(s) inválido(s) para a obra/setor selecionada.',
    );

    expect(ptsSaveMock).not.toHaveBeenCalled();
  });

  it('permite usuario company-scoped ao criar PT em obra selecionada', async () => {
    const userRepository = {
      exist: jest.fn().mockResolvedValue(true),
      count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(2),
    };
    getRepositoryMock.mockImplementation((entity: unknown) => {
      if (entity === User) {
        return userRepository;
      }
      if (entity === Site || entity === Apr) {
        return {
          exist: jest.fn().mockResolvedValue(true),
        };
      }
      return defaultScopedRepository;
    });

    await expect(
      service.create({
        numero: 'PT-002',
        titulo: 'PT com executante company-scoped',
        data_hora_inicio: '2026-03-14T08:00:00.000Z',
        data_hora_fim: '2026-03-14T18:00:00.000Z',
        site_id: 'site-1',
        responsavel_id: 'user-1',
        executantes: ['user-1', 'user-company-scoped'],
      }),
    ).resolves.toBeTruthy();

    expect(ptsSaveMock).toHaveBeenCalled();
  });

  it('bloqueia vigia de outra obra ao criar PT', async () => {
    const userRepository = {
      exist: jest.fn().mockResolvedValue(true),
      count: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1),
    };
    getRepositoryMock.mockImplementation((entity: unknown) => {
      if (entity === User) {
        return userRepository;
      }
      if (entity === Site || entity === Apr) {
        return {
          exist: jest.fn().mockResolvedValue(true),
        };
      }
      return defaultScopedRepository;
    });

    await expect(
      service.create({
        numero: 'PT-003',
        titulo: 'PT com vigia fora da obra',
        data_hora_inicio: '2026-03-14T08:00:00.000Z',
        data_hora_fim: '2026-03-14T18:00:00.000Z',
        site_id: 'site-1',
        responsavel_id: 'user-1',
        executantes: ['user-1'],
        vigia_user_id: 'user-outra-obra',
      }),
    ).rejects.toThrow(
      'Usuários da PT contém vínculo(s) inválido(s) para a obra/setor selecionada.',
    );

    expect(ptsSaveMock).not.toHaveBeenCalled();
  });

  it('create: traduz número duplicado (23505) em ConflictException, não 500', async () => {
    // Foco no caminho de tradução do erro — o escopo de entidades relacionadas
    // já tem cobertura própria e não é o objeto deste teste.
    jest
      .spyOn(
        service as unknown as {
          validateRelatedEntityScope: () => Promise<void>;
        },
        'validateRelatedEntityScope',
      )
      .mockResolvedValue(undefined);
    ptsSaveMock.mockRejectedValueOnce(
      new QueryFailedError('insert', [], {
        code: '23505',
        constraint: 'UQ_pts_company_numero',
      } as unknown as Error),
    );

    await expect(
      service.create({
        numero: 'PT-DUP',
        titulo: 'PT com número repetido',
        data_hora_inicio: '2026-03-14T08:00:00.000Z',
        data_hora_fim: '2026-03-14T18:00:00.000Z',
        site_id: 'site-1',
        responsavel_id: 'user-1',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('transição concorrente (lock NOWAIT 55P03) devolve 409, não erro cru', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-lock',
      numero: 'PT-LOCK',
      status: 'Pendente',
      company_id: 'company-1',
      site_id: 'site-1',
    } as unknown as Pt);

    // Todas as tentativas de transação falham com o código de lock indisponível.
    (
      ptsRepository as unknown as { manager: { transaction: jest.Mock } }
    ).manager.transaction = jest.fn().mockRejectedValue({ code: '55P03' });

    await expect(
      service.approve('pt-lock', 'user-1', 'ok'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('findPaginated: aplica filtro deleted_at IS NULL para excluir PTs removidas', async () => {
    const andWhereMock = jest.fn().mockReturnThis();
    const getManyAndCountMock = jest.fn().mockResolvedValue([[], 0]);
    const qbChain = {
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: andWhereMock,
      getManyAndCount: getManyAndCountMock,
    };
    (
      ptsRepository as unknown as { createQueryBuilder: jest.Mock }
    ).createQueryBuilder = jest.fn().mockReturnValue(qbChain);

    await service.findPaginated({ page: 1, limit: 10 });

    const whereCall = qbChain.where.mock.calls[0] as [string];
    expect(whereCall[0]).toContain('deleted_at IS NULL');
  });

  it('exportExcel: aplica filtro deleted_at IS NULL para excluir PTs removidas', async () => {
    const getMany = jest.fn().mockResolvedValue([]);
    const qbChain = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany,
    };
    (
      ptsRepository as unknown as { createQueryBuilder: jest.Mock }
    ).createQueryBuilder = jest.fn().mockReturnValue(qbChain);

    await service.exportExcel();

    const whereCall = qbChain.where.mock.calls[0] as [string];
    expect(whereCall[0]).toContain('deleted_at IS NULL');
  });

  it('getPdfAccess: retorna disponibilidade explicita quando a PT nao possui PDF armazenado', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      pdf_file_key: null,
    } as unknown as Pt);

    await expect(service.getPdfAccess('pt-1')).resolves.toEqual({
      entityId: 'pt-1',
      hasFinalPdf: false,
      availability: 'not_emitted',
      message: 'A PT ainda não possui PDF final emitido.',
      fileKey: null,
      folderPath: null,
      originalName: null,
      url: null,
    });
  });

  it('permite finalizar PT aprovada ou expirada pelo fluxo formal', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.EXPIRADA,
      pdf_file_key: null,
    } as unknown as Pt);

    await expect(
      service.finalize('pt-1', 'user-1', {
        condicao_area: 'Limpa e liberada',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'pt-1',
        status: PtStatus.ENCERRADA,
        condicao_area_encerramento: 'Limpa e liberada',
        encerrado_por_id: 'user-1',
      }),
    );
  });

  it('getAnalyticsOverview: retorna contagem consolidada por status', async () => {
    (ptsRepository.count as jest.Mock)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    await expect(service.getAnalyticsOverview()).resolves.toEqual({
      totalPts: 10,
      aprovadas: 3,
      pendentes: 4,
      canceladas: 1,
      encerradas: 1,
      expiradas: 1,
    });

    const countMock = (ptsRepository as unknown as { count: jest.Mock }).count;
    expect(countMock).toHaveBeenCalledTimes(6);
    type CountCall = [{ where?: unknown }];
    const countCalls = countMock.mock.calls as unknown as CountCall[];
    for (const [options] of countCalls) {
      const where = options.where as Record<string, unknown> | undefined;
      expect(where).toBeDefined();
      expect(where?.deleted_at).toBeDefined();
    }
  });

  it('aguarda a atualização de PTs expiradas antes de calcular métricas', async () => {
    let releaseRefresh!: () => void;
    const refresh = new Promise<{ affected: number }>((resolve) => {
      releaseRefresh = () => resolve({ affected: 1 });
    });
    const countMock = (ptsRepository as unknown as { count: jest.Mock }).count;
    countMock.mockResolvedValue(0);
    ptsRepository.update.mockReturnValue(refresh as never);

    const overviewPromise = service.getAnalyticsOverview();
    await Promise.resolve();

    expect(countMock).not.toHaveBeenCalled();

    releaseRefresh();
    await expect(overviewPromise).resolves.toEqual({
      totalPts: 0,
      aprovadas: 0,
      pendentes: 0,
      canceladas: 0,
      encerradas: 0,
      expiradas: 0,
    });
    expect(countMock).toHaveBeenCalledTimes(6);
  });

  it('aplica escopo de obra ao count para tenants multi-site', async () => {
    tenantService.getContext = jest.fn().mockReturnValue({
      companyId: 'company-1',
      siteId: 'site-a',
      siteIds: ['site-a'],
      siteScope: 'single',
      isSuperAdmin: false,
    });

    type CountOptions = { where?: Array<Record<string, unknown>> };
    const countMock = Reflect.get(ptsRepository, 'count') as jest.Mock;
    let receivedOptions: CountOptions | undefined;
    countMock.mockImplementation((options: CountOptions) => {
      receivedOptions = options;
      return Promise.resolve(0);
    });

    await service.count({ where: { status: PtStatus.PENDENTE } });

    const where = receivedOptions?.where?.[0];
    expect(receivedOptions?.where).toHaveLength(1);
    expect(where?.company_id).toBe('company-1');
    expect(where?.site_id).toBeDefined();
    expect(where?.deleted_at).toBeDefined();
    expect(where?.status).toBe(PtStatus.PENDENTE);
  });

  it('pagina a allow-list de PTs ao filtrar arquivos armazenados', async () => {
    tenantService.getContext = jest.fn().mockReturnValue({
      companyId: 'company-1',
      siteId: 'site-1',
      siteIds: ['site-1'],
      siteScope: 'single',
      isSuperAdmin: false,
    });
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      id: `pt-${index}`,
    })) as Pt[];
    const findMock = Reflect.get(ptsRepository, 'find') as jest.Mock;
    findMock
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([{ id: 'pt-1000' }] as Pt[]);
    (
      documentGovernanceService.listFinalDocuments as jest.Mock
    ).mockResolvedValue([{ entityId: 'pt-0' }, { entityId: 'pt-1000' }]);

    await expect(
      service.listStoredFiles({ companyId: 'company-1', year: 2026 }),
    ).resolves.toEqual([{ entityId: 'pt-0' }, { entityId: 'pt-1000' }]);
    expect(findMock).toHaveBeenCalledTimes(2);
  });

  it('serializa a atualização das regras de aprovação sob lock da empresa', async () => {
    const company = {
      id: 'company-1',
      pt_approval_rules: {
        blockCriticalRiskWithoutEvidence: true,
        blockWorkerWithoutValidMedicalExam: false,
        blockWorkerWithExpiredBlockingTraining: false,
        requireAtLeastOneExecutante: false,
      },
    } as Company;
    const lockedCompany = { ...company };
    companiesRepository.findOne.mockResolvedValue(company);
    (companiesRepository as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(company);
    const companyFindOne = jest.fn().mockResolvedValue(lockedCompany);
    const companySave = jest
      .fn()
      .mockImplementation((input: Company) => Promise.resolve(input));
    const transaction = Reflect.get(
      ptsRepository.manager,
      'transaction',
    ) as jest.Mock;
    transaction.mockImplementation(
      async (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback({
          getRepository: jest.fn((entity: unknown) =>
            entity === Company
              ? { findOne: companyFindOne, save: companySave }
              : defaultScopedRepository,
          ),
        } as unknown as EntityManager),
    );

    await expect(
      service.updateApprovalRules({ requireAtLeastOneExecutante: true }),
    ).resolves.toEqual(
      expect.objectContaining({ requireAtLeastOneExecutante: true }),
    );

    expect(companyFindOne).toHaveBeenCalledWith({
      where: { id: 'company-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(companySave).toHaveBeenCalledTimes(1);
    const companySaveCalls = companySave.mock.calls as Array<[Company]>;
    expect(companySaveCalls[0]?.[0]).toMatchObject({
      pt_approval_rules: { requireAtLeastOneExecutante: true },
    });
  });

  it('bloqueia aprovacao quando transicao de status e invalida (Cancelada -> Aprovada)', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.CANCELADA,
      pdf_file_key: null,
      executantes: [],
    } as unknown as Pt);

    await expect(service.approve('pt-1', 'approver-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('carrega executantes dentro do lock antes de aplicar regras de aprovação', async () => {
    const pt = {
      id: 'pt-approval-executantes',
      company_id: 'company-1',
      site_id: 'site-1',
      status: PtStatus.PENDENTE,
      data_hora_fim: new Date(Date.now() + 60_000),
      pdf_file_key: null,
      residual_risk: 'LOW',
      control_evidence: true,
      responsavel_id: 'user-1',
      executantes: [{ id: 'user-1' }],
      fotos_evidencia: [],
      medicoes_atmosfericas: [],
    } as unknown as Pt;
    ptsRepository.findOne.mockResolvedValue(pt);
    (companiesRepository.findOne as jest.Mock).mockResolvedValue({
      id: 'company-1',
      pt_approval_rules: {
        blockCriticalRiskWithoutEvidence: false,
        blockWorkerWithExpiredBlockingTraining: false,
        requireAtLeastOneExecutante: true,
        blockConfinedSpaceWithoutAtmosphericReadings: false,
        blockConfinedSpaceWithoutWatch: false,
        blockConfinedSpaceWithoutRescuePlan: false,
        blockWithoutBeforeEvidence: false,
      },
    });
    (signaturesService.findByDocument as jest.Mock).mockResolvedValue([
      { user_id: 'user-1' },
    ]);
    const rawPt = { ...pt, executantes: undefined } as unknown as Pt;
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Pt) {
          return {
            create: jest.fn((input: Pt) => input),
            save: jest.fn((input: Pt) => Promise.resolve(input)),
          };
        }
        if (entity === Signature) {
          return signaturesRepository;
        }
        return getRepositoryMock(entity);
      }),
      query: jest.fn((sql: string) => {
        if (sql.includes('pt_executantes')) {
          return [{ user_id: 'user-1' }];
        }
        return [rawPt];
      }),
    };
    (
      ptsRepository.manager as unknown as { transaction: jest.Mock }
    ).transaction.mockImplementationOnce(
      async (callback: (transactionManager: unknown) => Promise<Pt>) =>
        callback(manager),
    );

    await expect(
      service.approve('pt-approval-executantes', 'approver-1'),
    ).resolves.toMatchObject({ status: PtStatus.APROVADA });
  });

  it('lê regras de aprovação pelo manager transacional sob lock da empresa', async () => {
    const pt = {
      id: 'pt-approval-rules-lock',
      company_id: 'company-1',
      site_id: 'site-1',
      status: PtStatus.PENDENTE,
      data_hora_fim: new Date(Date.now() + 60_000),
      pdf_file_key: null,
      residual_risk: 'CRITICAL',
      control_evidence: false,
      responsavel_id: 'user-1',
      executantes: [],
      fotos_evidencia: [],
    } as unknown as Pt;
    ptsRepository.findOne.mockResolvedValue(pt);
    (companiesRepository.findOne as jest.Mock).mockResolvedValue({
      id: 'company-1',
      pt_approval_rules: {
        blockCriticalRiskWithoutEvidence: false,
        blockWorkerWithExpiredBlockingTraining: false,
        requireAtLeastOneExecutante: false,
      },
    });
    const lockedCompanyFindOne = jest.fn().mockResolvedValue({
      id: 'company-1',
      pt_approval_rules: {
        blockCriticalRiskWithoutEvidence: true,
        blockWorkerWithExpiredBlockingTraining: false,
        requireAtLeastOneExecutante: false,
      },
    });
    const manager = {
      query: jest.fn((sql: string) =>
        Promise.resolve(sql.includes('pt_executantes') ? [] : [pt]),
      ),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Pt) {
          return {
            create: jest.fn((input: Pt) => input),
            save: jest.fn((input: Pt) => Promise.resolve(input)),
          };
        }
        if (entity === Company) {
          return { findOne: lockedCompanyFindOne };
        }
        return getRepositoryMock(entity);
      }),
    };
    (
      ptsRepository as unknown as {
        manager: { transaction: jest.Mock };
      }
    ).manager.transaction.mockImplementationOnce(
      async (callback: (transactionManager: unknown) => Promise<unknown>) =>
        callback(manager),
    );

    await expect(
      service.approve('pt-approval-rules-lock', 'approver-1'),
    ).rejects.toThrow(BadRequestException);
    expect(lockedCompanyFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'company-1' },
        lock: { mode: 'pessimistic_read' },
      }),
    );
  });

  it('registra o snapshot anterior da aprovação a partir da PT protegida pelo lock', async () => {
    const stalePt = {
      id: 'pt-audit-snapshot',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'Título antigo',
      status: PtStatus.PENDENTE,
      data_hora_fim: new Date(Date.now() + 60_000),
      pdf_file_key: null,
      residual_risk: 'LOW',
      control_evidence: true,
      responsavel_id: 'user-1',
      executantes: [],
      fotos_evidencia: [],
    } as unknown as Pt;
    const lockedPt = {
      ...stalePt,
      titulo: 'Título atual',
    };
    ptsRepository.findOne.mockResolvedValue(stalePt);
    (companiesRepository.findOne as jest.Mock).mockResolvedValue({
      id: 'company-1',
      pt_approval_rules: {
        blockCriticalRiskWithoutEvidence: false,
        blockWorkerWithExpiredBlockingTraining: false,
        requireAtLeastOneExecutante: false,
      },
    });
    const manager = {
      query: jest.fn((sql: string) =>
        Promise.resolve(sql.includes('pt_executantes') ? [] : [lockedPt]),
      ),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Pt) {
          return {
            create: jest.fn((input: Pt) => input),
            save: jest.fn((input: Pt) => Promise.resolve(input)),
          };
        }
        if (entity === Company) {
          return companiesRepository;
        }
        return getRepositoryMock(entity);
      }),
    };
    (
      ptsRepository as unknown as {
        manager: { transaction: jest.Mock };
      }
    ).manager.transaction.mockImplementationOnce(
      async (callback: (transactionManager: unknown) => Promise<unknown>) =>
        callback(manager),
    );

    await expect(
      service.approve('pt-audit-snapshot', 'approver-1'),
    ).resolves.toMatchObject({
      id: 'pt-audit-snapshot',
      titulo: 'Título atual',
      status: PtStatus.APROVADA,
    });
    const auditLogMock = auditService.log as jest.Mock;
    const auditCalls = auditLogMock.mock.calls as Array<
      [{ changes?: { before?: { titulo?: string } } }]
    >;
    const lastAudit = auditCalls[auditCalls.length - 1]?.[0];
    expect(lastAudit?.changes?.before?.titulo).toBe('Título atual');
  });

  it('bloqueia aprovacao quando o risco residual e CRITICAL sem evidencia de controle', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
      residual_risk: 'CRITICAL',
      control_evidence: false,
      responsavel_id: 'resp-1',
      executantes: [],
    } as unknown as Pt);
    (companiesRepository.findOne as jest.Mock).mockResolvedValue({
      id: 'company-1',
      pt_approval_rules: {
        blockCriticalRiskWithoutEvidence: true,
        blockWorkerWithoutValidMedicalExam: false,
        blockWorkerWithExpiredBlockingTraining: false,
        requireAtLeastOneExecutante: false,
      },
    });
    (
      workerOperationalStatusService.getByUserIds as jest.Mock
    ).mockResolvedValue([]);

    await expect(service.approve('pt-1', 'approver-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('bloqueia aprovacao quando trabalhador possui treinamento bloqueante vencido', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
      residual_risk: 'LOW',
      control_evidence: true,
      responsavel_id: 'resp-1',
      executantes: [],
    } as unknown as Pt);
    (companiesRepository.findOne as jest.Mock).mockResolvedValue({
      id: 'company-1',
      pt_approval_rules: {
        blockCriticalRiskWithoutEvidence: true,
        blockWorkerWithoutValidMedicalExam: false,
        blockWorkerWithExpiredBlockingTraining: true,
        requireAtLeastOneExecutante: false,
      },
    });
    (
      workerOperationalStatusService.getByUserIds as jest.Mock
    ).mockResolvedValue([
      {
        user: { nome: 'Responsável' },
        medicalExam: { status: 'VALIDO' },
        trainings: { expiredBlocking: [{ nome: 'NR-35 Trabalho em Altura' }] },
      },
    ]);

    let approvalError: unknown;

    try {
      await service.approve('pt-1', 'approver-1');
    } catch (error) {
      approvalError = error;
    }

    expect(approvalError).toBeInstanceOf(BadRequestException);

    if (!(approvalError instanceof BadRequestException)) {
      return;
    }

    const response = approvalError.getResponse() as {
      code?: string;
      reasons?: unknown;
    };

    if (
      response.code !== 'PT_APPROVAL_BLOCKED' ||
      !Array.isArray(response.reasons)
    ) {
      throw new Error('Expected PT approval block response payload');
    }

    expect(response.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('NR-35 Trabalho em Altura'),
      ]),
    );
  });

  describe('conformidade NR-33 (regras opt-in de espaço confinado)', () => {
    const baseConfinedPt = {
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
      residual_risk: 'LOW',
      control_evidence: true,
      responsavel_id: 'resp-1',
      executantes: [],
      espaco_confinado: true,
    };

    const setupCompanyRules = (rules: Record<string, boolean>): void => {
      (companiesRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'company-1',
        pt_approval_rules: {
          blockCriticalRiskWithoutEvidence: false,
          blockWorkerWithoutValidMedicalExam: false,
          blockWorkerWithExpiredBlockingTraining: false,
          requireAtLeastOneExecutante: false,
          ...rules,
        },
      });
      (
        workerOperationalStatusService.getByUserIds as jest.Mock
      ).mockResolvedValue([]);
    };

    const expectApprovalBlockedReason = async (
      match: string,
    ): Promise<void> => {
      let error: unknown;
      try {
        await service.approve('pt-1', 'approver-1');
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BadRequestException);
      if (!(error instanceof BadRequestException)) return;
      const response = error.getResponse() as {
        code?: string;
        reasons?: string[];
      };
      expect(response.code).toBe('PT_APPROVAL_BLOCKED');
      expect(response.reasons).toEqual(
        expect.arrayContaining([expect.stringContaining(match)]),
      );
    };

    it('bloqueia espaço confinado sem leitura atmosférica quando a regra está ligada', async () => {
      ptsRepository.findOne.mockResolvedValue({
        ...baseConfinedPt,
        medicoes_atmosfericas: [],
      } as unknown as Pt);
      setupCompanyRules({
        blockConfinedSpaceWithoutAtmosphericReadings: true,
      });
      await expectApprovalBlockedReason('leitura atmosférica');
    });

    it('bloqueia espaço confinado sem vigia quando a regra está ligada', async () => {
      ptsRepository.findOne.mockResolvedValue({
        ...baseConfinedPt,
        medicoes_atmosfericas: [{ hora: '08:00' }],
        vigia_nome: null,
        vigia_user_id: null,
      } as unknown as Pt);
      setupCompanyRules({ blockConfinedSpaceWithoutWatch: true });
      await expectApprovalBlockedReason('vigia');
    });

    it('bloqueia espaço confinado sem plano de resgate quando a regra está ligada', async () => {
      ptsRepository.findOne.mockResolvedValue({
        ...baseConfinedPt,
        plano_resgate: '',
        contato_emergencia: '',
      } as unknown as Pt);
      setupCompanyRules({ blockConfinedSpaceWithoutRescuePlan: true });
      await expectApprovalBlockedReason('plano de resgate');
    });

    it('bloqueia sem evidência fotográfica inicial quando a regra está ligada', async () => {
      ptsRepository.findOne.mockResolvedValue({
        ...baseConfinedPt,
        espaco_confinado: false,
        fotos_evidencia: [{ fase: 'durante' }],
      } as unknown as Pt);
      setupCompanyRules({ blockWithoutBeforeEvidence: true });
      await expectApprovalBlockedReason('evidência fotográfica');
    });

    it('NÃO bloqueia quando as regras NR-33 estão desligadas (default)', async () => {
      ptsRepository.findOne.mockResolvedValue({
        ...baseConfinedPt,
        medicoes_atmosfericas: [],
        vigia_nome: null,
        plano_resgate: '',
        contato_emergencia: '',
        fotos_evidencia: [],
      } as unknown as Pt);
      // Todas as regras NR-33 ausentes → caem no default false.
      setupCompanyRules({});
      // Mocka a transição atômica de status para permitir a aprovação seguir.
      (ptsRepository.manager as unknown as { transaction: jest.Mock }) = {
        transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
          cb({
            query: jest.fn().mockResolvedValue([{ ...baseConfinedPt }]),
            getRepository: jest.fn(() => ({ update: jest.fn() })),
          }),
        ),
      };
      // Não deve lançar PT_APPROVAL_BLOCKED por regras NR-33; qualquer erro
      // posterior de infraestrutura da transição não é o alvo deste teste.
      let blockedByNr33 = false;
      try {
        await service.approve('pt-1', 'approver-1');
      } catch (error) {
        if (error instanceof BadRequestException) {
          const response = error.getResponse() as { reasons?: string[] };
          const reasons = response.reasons || [];
          blockedByNr33 = reasons.some(
            (r) => r.includes('NR-33') || r.includes('evidência fotográfica'),
          );
        }
      }
      expect(blockedByNr33).toBe(false);
    });
  });

  it('bloqueia aprovacao quando ainda existem executantes sem assinatura unica valida', async () => {
    ptsRepository.findOne.mockResolvedValue({
      id: 'pt-1',
      company_id: 'company-1',
      status: PtStatus.PENDENTE,
      pdf_file_key: null,
      residual_risk: 'LOW',
      control_evidence: true,
      responsavel_id: 'resp-1',
      executantes: [
        { id: 'user-1', nome: 'Executor 1' },
        { id: 'user-2', nome: 'Executor 2' },
      ],
    } as unknown as Pt);
    (companiesRepository.findOne as jest.Mock).mockResolvedValue({
      id: 'company-1',
      pt_approval_rules: {
        blockCriticalRiskWithoutEvidence: true,
        blockWorkerWithoutValidMedicalExam: true,
        blockWorkerWithExpiredBlockingTraining: true,
        requireAtLeastOneExecutante: true,
      },
    });
    (
      workerOperationalStatusService.getByUserIds as jest.Mock
    ).mockResolvedValue([
      {
        user: { nome: 'Responsável' },
        medicalExam: { status: 'VALIDO' },
        trainings: { expiredBlocking: [] },
      },
      {
        user: { nome: 'Executor 1' },
        medicalExam: { status: 'VALIDO' },
        trainings: { expiredBlocking: [] },
      },
      {
        user: { nome: 'Executor 2' },
        medicalExam: { status: 'VALIDO' },
        trainings: { expiredBlocking: [] },
      },
    ]);
    (signaturesService.findByDocument as jest.Mock).mockResolvedValue([
      { user_id: 'user-1' },
      { user_id: 'user-1' },
    ]);

    await expect(service.approve('pt-1', 'approver-1')).rejects.toThrow(
      BadRequestException,
    );
  });
  describe('validação temporal — achado M1', () => {
    it('create: rejeita quando data_hora_fim é igual a data_hora_inicio', async () => {
      await expect(
        service.create({
          numero: 'PT-TEMP-01',
          titulo: 'PT com datas iguais',
          data_hora_inicio: '2026-06-15T08:00:00.000Z',
          data_hora_fim: '2026-06-15T08:00:00.000Z',
          site_id: 'site-1',
          responsavel_id: 'user-1',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(ptsSaveMock).not.toHaveBeenCalled();
    });

    it('create: rejeita quando data_hora_fim é anterior a data_hora_inicio', async () => {
      await expect(
        service.create({
          numero: 'PT-TEMP-02',
          titulo: 'PT com datas invertidas',
          data_hora_inicio: '2026-06-15T18:00:00.000Z',
          data_hora_fim: '2026-06-15T08:00:00.000Z',
          site_id: 'site-1',
          responsavel_id: 'user-1',
        }),
      ).rejects.toThrow(
        'A data/hora de término deve ser posterior à data/hora de início.',
      );
      expect(ptsSaveMock).not.toHaveBeenCalled();
    });

    it('create: aceita quando data_hora_fim é posterior a data_hora_inicio', async () => {
      getRepositoryMock.mockImplementation((entity: unknown) => {
        if (entity === User) {
          return {
            exist: jest.fn().mockResolvedValue(true),
            count: jest.fn().mockResolvedValue(1),
          };
        }
        if (entity === Site || entity === Apr) {
          return { exist: jest.fn().mockResolvedValue(true) };
        }
        return defaultScopedRepository;
      });

      await expect(
        service.create({
          numero: 'PT-TEMP-03',
          titulo: 'PT com datas válidas',
          data_hora_inicio: '2026-06-15T08:00:00.000Z',
          data_hora_fim: '2026-06-15T18:00:00.000Z',
          site_id: 'site-1',
          responsavel_id: 'user-1',
        }),
      ).resolves.toBeTruthy();
      expect(ptsSaveMock).toHaveBeenCalled();
    });

    it('update: rejeita quando data_hora_fim atualizada é anterior ao data_hora_inicio existente', async () => {
      ptsRepository.findOne.mockResolvedValue({
        id: 'pt-temporal',
        company_id: 'company-1',
        status: PtStatus.PENDENTE,
        pdf_file_key: null,
        data_hora_inicio: new Date('2026-06-15T08:00:00.000Z'),
        data_hora_fim: new Date('2026-06-15T18:00:00.000Z'),
        site_id: 'site-1',
        responsavel_id: 'user-1',
        apr_id: null,
        auditado_por_id: null,
        executantes: [],
        probability: 2,
        severity: 2,
        exposure: 2,
        residual_risk: 'LOW',
        control_evidence: false,
      } as unknown as Pt);

      await expect(
        service.update('pt-temporal', {
          data_hora_fim: '2026-06-15T06:00:00.000Z',
        }),
      ).rejects.toThrow(
        'A data/hora de término deve ser posterior à data/hora de início.',
      );
      expect(ptsSaveMock).not.toHaveBeenCalled();
    });

    it('update: rejeita quando novo data_hora_inicio é posterior ao data_hora_fim existente', async () => {
      ptsRepository.findOne.mockResolvedValue({
        id: 'pt-temporal',
        company_id: 'company-1',
        status: PtStatus.PENDENTE,
        pdf_file_key: null,
        data_hora_inicio: new Date('2026-06-15T08:00:00.000Z'),
        data_hora_fim: new Date('2026-06-15T18:00:00.000Z'),
        site_id: 'site-1',
        responsavel_id: 'user-1',
        apr_id: null,
        auditado_por_id: null,
        executantes: [],
        probability: 2,
        severity: 2,
        exposure: 2,
        residual_risk: 'LOW',
        control_evidence: false,
      } as unknown as Pt);

      await expect(
        service.update('pt-temporal', {
          data_hora_inicio: '2026-06-15T20:00:00.000Z',
        }),
      ).rejects.toThrow(
        'A data/hora de término deve ser posterior à data/hora de início.',
      );
      expect(ptsSaveMock).not.toHaveBeenCalled();
    });

    it('update: aceita quando ambas as datas são atualizadas com intervalo válido', async () => {
      ptsRepository.findOne.mockResolvedValue({
        id: 'pt-temporal',
        company_id: 'company-1',
        status: PtStatus.PENDENTE,
        pdf_file_key: null,
        data_hora_inicio: new Date('2026-06-15T08:00:00.000Z'),
        data_hora_fim: new Date('2026-06-15T18:00:00.000Z'),
        site_id: 'site-1',
        responsavel_id: 'user-1',
        apr_id: null,
        auditado_por_id: null,
        executantes: [],
        probability: 2,
        severity: 2,
        exposure: 2,
        residual_risk: 'LOW',
        control_evidence: false,
      } as unknown as Pt);

      getRepositoryMock.mockImplementation((entity: unknown) => {
        if (entity === User) {
          return {
            exist: jest.fn().mockResolvedValue(true),
            count: jest.fn().mockResolvedValue(1),
          };
        }
        if (entity === Site || entity === Apr) {
          return { exist: jest.fn().mockResolvedValue(true) };
        }
        return defaultScopedRepository;
      });

      await expect(
        service.update('pt-temporal', {
          data_hora_inicio: '2026-06-16T08:00:00.000Z',
          data_hora_fim: '2026-06-16T18:00:00.000Z',
        }),
      ).resolves.toBeTruthy();
      const transactionMock = (
        ptsRepository.manager as unknown as { transaction: jest.Mock }
      ).transaction;
      expect(transactionMock).toHaveBeenCalled();
    });
  });

  describe('evidências fotográficas governadas', () => {
    const basePt = () =>
      ({
        id: 'pt-1',
        company_id: 'company-1',
        site_id: 'site-1',
        status: PtStatus.APROVADA,
        pdf_file_key: null,
        fotos_evidencia: [],
      }) as unknown as Pt;

    it('anexa foto de evidência em PT aprovada e retorna referência governada sem fileKey cru', async () => {
      ptsRepository.findOne.mockResolvedValue(basePt());

      const result = await service.attachEvidencePhoto(
        'pt-1',
        Buffer.from('fake-image'),
        'antes.jpg',
        'image/jpeg',
        { fase: 'antes', legenda: 'Área isolada' },
        'user-1',
      );

      expect(
        documentStorageService.uploadFileWithCapability,
      ).toHaveBeenCalled();
      expect(result.photoReference.startsWith('gst:pt-photo:')).toBe(true);
      expect(result.fase).toBe('antes');
      expect(result.legenda).toBe('Área isolada');
      expect(JSON.stringify(result)).not.toContain('documents/company-1');
    });

    it('gera a chave da foto usando a obra protegida pelo lock', async () => {
      const initialPt = basePt();
      const lockedPt = { ...initialPt, site_id: 'site-2' };
      ptsRepository.findOne.mockResolvedValue(initialPt);
      const save = jest.fn((input: Pt) => Promise.resolve(input));
      const manager = {
        query: jest.fn((sql: string) =>
          Promise.resolve(sql.includes('pt_executantes') ? [] : [lockedPt]),
        ),
        getRepository: jest.fn(() => ({
          create: jest.fn((input: Pt) => input),
          save,
        })),
      };
      (
        ptsRepository as unknown as {
          manager: { transaction: jest.Mock };
        }
      ).manager.transaction.mockImplementationOnce(
        async (callback: (transactionManager: unknown) => Promise<unknown>) =>
          callback(manager),
      );

      await service.attachEvidencePhoto(
        'pt-1',
        Buffer.from('fake-image'),
        'depois.jpg',
        'image/jpeg',
        { fase: 'depois' },
        'user-1',
      );

      expect(documentStorageService.generateDocumentKey).toHaveBeenCalledWith(
        'company-1',
        'pt-photos',
        'pt-1',
        'depois.jpg',
        { folderSegments: ['sites', 'site-2'] },
      );
    });

    it('bloqueia foto quando a PT já possui PDF final governado', async () => {
      ptsRepository.findOne.mockResolvedValue({
        ...basePt(),
        pdf_file_key: 'documents/company-1/pts/pt-1/final.pdf',
      });

      await expect(
        service.attachEvidencePhoto(
          'pt-1',
          Buffer.from('fake'),
          'foto.jpg',
          'image/jpeg',
          { fase: 'depois' },
        ),
      ).rejects.toThrow(BadRequestException);
      expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
    });

    it('bloqueia foto quando a PT está encerrada', async () => {
      ptsRepository.findOne.mockResolvedValue({
        ...basePt(),
        status: PtStatus.ENCERRADA,
      });

      await expect(
        service.attachEvidencePhoto(
          'pt-1',
          Buffer.from('fake'),
          'foto.jpg',
          'image/jpeg',
          { fase: 'depois' },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('remove o arquivo do storage quando a persistência da foto falha (compensação)', async () => {
      const pt = basePt();
      ptsRepository.findOne.mockResolvedValue(pt);
      const manager = {
        query: jest.fn((sql: string) =>
          Promise.resolve(sql.includes('pt_executantes') ? [] : [pt]),
        ),
        getRepository: jest.fn(() => ({
          create: jest.fn((input: Pt) => input),
          save: jest.fn().mockRejectedValue(new Error('db down')),
        })),
      };
      (
        ptsRepository as unknown as {
          manager: { transaction: jest.Mock };
        }
      ).manager.transaction.mockImplementationOnce(
        async (callback: (transactionManager: unknown) => Promise<unknown>) =>
          callback(manager),
      );

      await expect(
        service.attachEvidencePhoto(
          'pt-1',
          Buffer.from('fake'),
          'foto.jpg',
          'image/jpeg',
          { fase: 'antes' },
        ),
      ).rejects.toThrow('db down');
      expect(documentStorageService.deleteFile).toHaveBeenCalled();
    });
  });

  describe('paridade do document_code com o QR do PDF (validação round-trip)', () => {
    const runAttachAndCaptureCode = async (
      ptOverrides: Partial<Pt>,
    ): Promise<string> => {
      const pt = {
        id: 'pt-code-1',
        company_id: 'company-1',
        site_id: 'site-1',
        titulo: 'PT Entrada em espaco confinado',
        status: PtStatus.APROVADA,
        data_hora_inicio: new Date('2026-07-10T08:00:00.000Z'),
        created_at: new Date('2026-07-10T07:00:00.000Z'),
        ...ptOverrides,
      } as unknown as Pt;
      const update = jest.fn();
      const manager = {
        getRepository: jest.fn(() => ({ update })),
      } as unknown as EntityManager;
      ptsRepository.findOne.mockResolvedValue(pt);
      (
        documentGovernanceService.registerFinalDocument as jest.Mock
      ).mockImplementation(async (input: RegisterFinalDocumentInput) => {
        await input.persistEntityMetadata?.(manager, 'hash-pt');
        return { hash: 'hash-pt', registryEntry: { id: 'registry-pt' } };
      });

      const file = {
        originalname: 'pt-final.pdf',
        mimetype: 'application/pdf',
        buffer: Buffer.from('%PDF-pt'),
      } as Express.Multer.File;

      await service.attachPdf(pt.id, file, 'user-1');

      const calls = (
        documentGovernanceService.registerFinalDocument as jest.Mock
      ).mock.calls as RegisterFinalDocumentInput[][];
      const call = calls[calls.length - 1]?.[0];
      return call?.documentCode ?? '';
    };

    it('usa o número cru da PT como document_code quando há número', async () => {
      const code = await runAttachAndCaptureCode({
        numero: 'PT-2026-07-10-ECQ-001',
      });
      // Deve ser exatamente igual ao que o frontend imprime no QR
      // (frontend prioriza pt.numero cru — ver ptGenerator.ts).
      expect(code).toBe('PT-2026-07-10-ECQ-001');
    });

    it('trima o número antes de usar como document_code', async () => {
      const code = await runAttachAndCaptureCode({
        numero: '   PT-77   ',
      });
      expect(code).toBe('PT-77');
    });

    it('cai no formato PT-{ano}-{ref} quando não há número', async () => {
      const code = await runAttachAndCaptureCode({
        numero: undefined,
        id: 'abcdef12-3456-7890-abcd-ef1234567890',
      });
      // Espelha buildDocumentCode do frontend: PT-{ano}-{últimos 8 alfanum de id, upper}.
      expect(code).toBe('PT-2026-34567890');
    });

    it('getValidationContext emite token para o portal PT com o mesmo código', async () => {
      const pt = {
        id: 'pt-ctx-1',
        company_id: 'company-1',
        site_id: 'site-1',
        numero: 'PT-2026-07-10-ECQ-001',
        titulo: 'PT',
        status: PtStatus.APROVADA,
        final_pdf_hash_sha256: 'abc123hash',
        data_hora_inicio: new Date('2026-07-10T08:00:00.000Z'),
      } as unknown as Pt;
      ptsRepository.findOne.mockResolvedValue(pt);

      const context = await service.getValidationContext('pt-ctx-1');

      expect(context).toEqual({
        documentCode: 'PT-2026-07-10-ECQ-001',
        finalPdfHash: 'abc123hash',
        token: 'pt-validation-token',
      });
      expect(publicValidationGrantService.issueToken).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'PT-2026-07-10-ECQ-001',
          companyId: 'company-1',
          portal: 'pt_public_validation',
          documentId: 'pt-ctx-1',
        }),
      );
    });

    it('getValidationContext degrada graciosamente quando o token falha', async () => {
      const pt = {
        id: 'pt-ctx-2',
        company_id: 'company-1',
        site_id: 'site-1',
        numero: 'PT-999',
        titulo: 'PT',
        status: PtStatus.APROVADA,
        final_pdf_hash_sha256: null,
        data_hora_inicio: new Date('2026-07-10T08:00:00.000Z'),
      } as unknown as Pt;
      ptsRepository.findOne.mockResolvedValue(pt);
      publicValidationGrantService.issueToken.mockRejectedValueOnce(
        new Error('kill switch'),
      );

      const context = await service.getValidationContext('pt-ctx-2');

      expect(context).toEqual({
        documentCode: 'PT-999',
        finalPdfHash: null,
        token: null,
      });
    });
  });

  describe('medições atmosféricas (NR-33)', () => {
    const reading = {
      id: 'm1',
      hora: '08:30',
      oxigenio: 20.9,
      inflamaveis_lel: 0,
      co: 2,
      h2s: 0,
      instrumento: 'Detector MX6',
      responsavel: 'Fabio TST',
    };

    it('permite registrar medição em PT aprovada (append-only)', async () => {
      ptsRepository.findOne.mockResolvedValue({
        id: 'pt-1',
        company_id: 'company-1',
        status: PtStatus.APROVADA,
        pdf_file_key: null,
        medicoes_atmosfericas: [],
      } as unknown as Pt);

      const saved = await service.appendAtmosphericReading(
        'pt-1',
        reading,
        'user-1',
      );
      expect(saved.medicoes_atmosfericas).toHaveLength(1);
      expect(saved.medicoes_atmosfericas?.[0]).toMatchObject(reading);
    });

    it('bloqueia medição em PT encerrada', async () => {
      ptsRepository.findOne.mockResolvedValue({
        id: 'pt-1',
        company_id: 'company-1',
        status: PtStatus.ENCERRADA,
        pdf_file_key: null,
      } as unknown as Pt);

      await expect(
        service.appendAtmosphericReading('pt-1', reading),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('encerramento estruturado', () => {
    it('rejeita término real anterior ao início da PT', async () => {
      ptsRepository.findOne.mockResolvedValue({
        id: 'pt-1',
        company_id: 'company-1',
        status: PtStatus.APROVADA,
        pdf_file_key: null,
        data_hora_inicio: new Date('2026-06-16T08:00:00.000Z'),
      } as unknown as Pt);

      await expect(
        service.finalize('pt-1', 'user-1', {
          condicao_area: 'Limpa e liberada',
          data_hora_real_fim: '2026-06-15T08:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('persiste os campos de devolução da área ao encerrar', async () => {
      ptsRepository.findOne.mockResolvedValue({
        id: 'pt-1',
        company_id: 'company-1',
        status: PtStatus.APROVADA,
        pdf_file_key: null,
        data_hora_inicio: new Date('2026-06-16T08:00:00.000Z'),
      } as unknown as Pt);

      const saved = await service.finalize('pt-1', 'user-9', {
        condicao_area: 'Isolada com pendências',
        data_hora_real_fim: '2026-06-16T17:30:00.000Z',
        observacoes: 'Pendência de limpeza fina.',
      });

      expect(saved.status).toBe(PtStatus.ENCERRADA);
      expect(saved.encerrado_por_id).toBe('user-9');
      expect(saved.condicao_area_encerramento).toBe('Isolada com pendências');
      expect(saved.observacoes_encerramento).toBe('Pendência de limpeza fina.');
      expect(saved.data_hora_real_fim).toEqual(
        new Date('2026-06-16T17:30:00.000Z'),
      );
    });
  });

  describe('hardening de anexo_ref no update()', () => {
    it('descarta anexo_ref forjado pelo cliente e restaura o valor persistido', async () => {
      getRepositoryMock.mockImplementation((entity: unknown) => {
        if (entity === User) {
          return {
            exist: jest.fn().mockResolvedValue(true),
            count: jest.fn().mockResolvedValue(1),
          };
        }
        if (entity === Site || entity === Apr) {
          return { exist: jest.fn().mockResolvedValue(true) };
        }
        return defaultScopedRepository;
      });
      ptsRepository.findOne.mockResolvedValue({
        id: 'pt-1',
        company_id: 'company-1',
        site_id: 'site-1',
        responsavel_id: 'user-1',
        status: PtStatus.PENDENTE,
        pdf_file_key: null,
        data_hora_inicio: new Date('2026-06-16T08:00:00.000Z'),
        data_hora_fim: new Date('2026-06-16T18:00:00.000Z'),
        executantes: [],
        trabalho_altura_checklist: [
          {
            id: 'item-1',
            pergunta: 'Pergunta 1',
            anexo_ref: 'gst:pt-checklist-anexo:legitimo',
          },
          { id: 'item-2', pergunta: 'Pergunta 2' },
        ],
      } as unknown as Pt);

      const saved = await service.update('pt-1', {
        trabalho_altura_checklist: [
          {
            id: 'item-1',
            pergunta: 'Pergunta 1',
            anexo_ref: 'gst:pt-checklist-anexo:FORJADO',
          },
          {
            id: 'item-2',
            pergunta: 'Pergunta 2',
            anexo_ref: 'gst:pt-checklist-anexo:FORJADO2',
          },
        ],
      });

      const items = saved.trabalho_altura_checklist ?? [];
      expect(items[0]?.anexo_ref).toBe('gst:pt-checklist-anexo:legitimo');
      expect(items[1]?.anexo_ref).toBeUndefined();
    });
  });

  describe('anexo de item de checklist', () => {
    it('bloqueia anexo quando a PT não está pendente', async () => {
      ptsRepository.findOne.mockResolvedValue({
        id: 'pt-1',
        company_id: 'company-1',
        site_id: 'site-1',
        status: PtStatus.APROVADA,
        pdf_file_key: null,
        trabalho_altura_checklist: [{ id: 'item-1', pergunta: 'P1' }],
      } as unknown as Pt);

      await expect(
        service.attachChecklistItemAttachment(
          'pt-1',
          'trabalho_altura_checklist',
          0,
          Buffer.from('fake'),
          'anexo.pdf',
          'application/pdf',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejeita campo de checklist fora da whitelist', async () => {
      await expect(
        service.attachChecklistItemAttachment(
          'pt-1',
          'recomendacoes_gerais_checklist',
          0,
          Buffer.from('fake'),
          'anexo.pdf',
          'application/pdf',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('gera a chave do anexo usando a obra protegida pelo lock', async () => {
      const initialPt = {
        id: 'pt-1',
        company_id: 'company-1',
        site_id: 'site-1',
        status: PtStatus.PENDENTE,
        pdf_file_key: null,
        trabalho_altura_checklist: [{ id: 'item-1', pergunta: 'P1' }],
      } as unknown as Pt;
      const lockedPt = { ...initialPt, site_id: 'site-2' };
      ptsRepository.findOne.mockResolvedValue(initialPt);
      const save = jest.fn((input: Pt) => Promise.resolve(input));
      const manager = {
        query: jest.fn((sql: string) =>
          Promise.resolve(sql.includes('pt_executantes') ? [] : [lockedPt]),
        ),
        getRepository: jest.fn(() => ({
          create: jest.fn((input: Pt) => input),
          save,
        })),
      };
      (
        ptsRepository as unknown as {
          manager: { transaction: jest.Mock };
        }
      ).manager.transaction.mockImplementationOnce(
        async (callback: (transactionManager: unknown) => Promise<unknown>) =>
          callback(manager),
      );

      await service.attachChecklistItemAttachment(
        'pt-1',
        'trabalho_altura_checklist',
        0,
        Buffer.from('fake-pdf'),
        'novo.pdf',
        'application/pdf',
        'user-1',
      );

      expect(documentStorageService.generateDocumentKey).toHaveBeenCalledWith(
        'company-1',
        'pt-checklist-anexos',
        'pt-1',
        'novo.pdf',
        { folderSegments: ['sites', 'site-2'] },
      );
    });

    it('não remove o anexo anterior se a gravação da substituição falhar', async () => {
      const previousKey = 'documents/company-1/pt-checklist-anexos/old.pdf';
      const previousRef = `gst:pt-checklist-anexo:${Buffer.from(
        JSON.stringify({
          v: 1,
          kind: 'governed-storage',
          scope: 'checklist-anexo',
          fileKey: previousKey,
          originalName: 'old.pdf',
          mimeType: 'application/pdf',
          uploadedAt: new Date().toISOString(),
        }),
      ).toString('base64url')}`;
      const pt = {
        id: 'pt-1',
        company_id: 'company-1',
        site_id: 'site-1',
        status: PtStatus.PENDENTE,
        pdf_file_key: null,
        trabalho_altura_checklist: [
          { id: 'item-1', pergunta: 'P1', anexo_ref: previousRef },
        ],
      } as unknown as Pt;
      const managerSave = jest.fn().mockRejectedValue(new Error('db down'));
      ptsRepository.findOne.mockResolvedValue(pt);
      (
        ptsRepository as unknown as {
          manager: { transaction: jest.Mock };
        }
      ).manager.transaction.mockImplementationOnce(
        async (callback: (manager: unknown) => Promise<unknown>) =>
          callback({
            query: jest.fn().mockResolvedValue([pt]),
            getRepository: jest.fn(() => ({
              create: jest.fn((input: Pt) => input),
              save: managerSave,
            })),
          }),
      );

      await expect(
        service.attachChecklistItemAttachment(
          'pt-1',
          'trabalho_altura_checklist',
          0,
          Buffer.from('fake'),
          'new.pdf',
          'application/pdf',
        ),
      ).rejects.toThrow('db down');

      expect(documentStorageService.deleteFile).not.toHaveBeenCalledWith(
        expect.objectContaining({ key: previousKey }),
      );
    });
  });

  describe('remoção de evidência fotográfica', () => {
    it('preserva a foto no storage se a gravação da remoção falhar', async () => {
      const photoKey = 'documents/company-1/pt-photos/photo.jpg';
      const photoRef = `gst:pt-photo:${Buffer.from(
        JSON.stringify({
          v: 1,
          kind: 'governed-storage',
          scope: 'evidence',
          fileKey: photoKey,
          originalName: 'photo.jpg',
          mimeType: 'image/jpeg',
          uploadedAt: new Date().toISOString(),
        }),
      ).toString('base64url')}`;
      const pt = {
        id: 'pt-1',
        company_id: 'company-1',
        site_id: 'site-1',
        status: PtStatus.PENDENTE,
        pdf_file_key: null,
        fotos_evidencia: [
          {
            ref: photoRef,
            fase: 'antes',
            uploaded_at: new Date().toISOString(),
          },
        ],
      } as unknown as Pt;
      const managerSave = jest.fn().mockRejectedValue(new Error('db down'));
      ptsRepository.findOne.mockResolvedValue(pt);
      (
        ptsRepository as unknown as {
          manager: { transaction: jest.Mock };
        }
      ).manager.transaction.mockImplementationOnce(
        async (callback: (manager: unknown) => Promise<unknown>) =>
          callback({
            query: jest.fn().mockResolvedValue([pt]),
            getRepository: jest.fn(() => ({
              create: jest.fn((input: Pt) => input),
              save: managerSave,
            })),
          }),
      );

      await expect(
        service.removeEvidencePhoto('pt-1', 0, 'user-1'),
      ).rejects.toThrow('db down');

      expect(documentStorageService.deleteFile).not.toHaveBeenCalledWith(
        expect.objectContaining({ key: photoKey }),
      );
    });
  });
});
