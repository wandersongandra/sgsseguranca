import { BadRequestException } from '@nestjs/common';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { PtsService } from './pts.service';
import { Pt, PtStatus } from './entities/pt.entity';
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
  let getRepositoryMock: jest.Mock;
  let defaultScopedRepository: {
    exist: jest.Mock;
    count: jest.Mock;
  };

  beforeEach(() => {
    ptsSaveMock = jest.fn((input: Pt) => Promise.resolve(input));
    auditLogsFindMock = jest.fn();
    ptsRepository = {
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
      registerFinalDocument: jest.fn(),
      removeFinalDocumentReference: jest.fn(),
    };
    const documentBundleService = {
      buildWeeklyPdfBundle: jest.fn(),
    };
    signaturesService = {
      findByDocument: jest.fn().mockResolvedValue([]),
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
    getRepositoryMock = jest.fn(() => defaultScopedRepository);
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
                  save: jest.fn((input: Pt) => Promise.resolve(input)),
                };
              }
              return getRepositoryMock(entity) as {
                exist?: jest.Mock;
                count?: jest.Mock;
              };
            }),
            query: jest.fn(async (_sql: string, params?: unknown[]) => {
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
      expect(ptsSaveMock).toHaveBeenCalled();
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
      const manager = (
        ptsRepository as unknown as {
          manager: { transaction: jest.Mock };
        }
      ).manager;
      manager.transaction.mockRejectedValueOnce(new Error('db down'));

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
  });
});
