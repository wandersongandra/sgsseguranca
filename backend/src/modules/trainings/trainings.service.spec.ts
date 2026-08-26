import type { Repository } from 'typeorm';
import { TrainingsService } from './trainings.service';
import type { Training } from './entities/training.entity';
import type { TenantService } from '../../shared/tenant/tenant.service';
import type { DocumentStorageService } from '../../shared/services/document-storage.service';
import type { DocumentGovernanceService } from '../document-registry/document-governance.service';
import type { DocumentRegistryService } from '../document-registry/document-registry.service';
import type { DocumentRegistryEntry } from '../document-registry/entities/document-registry.entity';
import type { MetricsService } from '../../shared/observability/metrics.service';
import { markAuthorizedStorageReference } from '../../shared/storage/storage-object-reference';

describe('TrainingsService governed pdf', () => {
  let repository: Pick<Repository<Training>, 'findOne'>;
  let tenantService: Pick<TenantService, 'getTenantId'>;
  let documentStorageService: Pick<
    DocumentStorageService,
    | 'generateDocumentKey'
    | 'referenceForExistingObject'
    | 'uploadFile'
    | 'uploadFileWithCapability'
    | 'getSignedUrl'
    | 'deleteFile'
  >;
  let documentGovernanceService: Pick<
    DocumentGovernanceService,
    'registerFinalDocument'
  >;
  let documentRegistryService: Pick<DocumentRegistryService, 'findByDocument'>;
  let metricsService: Pick<MetricsService, 'incrementTrainingRegistered'>;
  let service: TrainingsService;

  const makeTraining = (overrides: Partial<Training> = {}): Training =>
    ({
      id: 'training-1',
      nome: 'NR-35',
      nr_codigo: 'NR35',
      data_conclusao: new Date('2026-05-05T00:00:00.000Z'),
      data_vencimento: new Date('2027-05-05T00:00:00.000Z'),
      company_id: 'company-1',
      user_id: 'user-1',
      created_at: new Date('2026-05-05T10:00:00.000Z'),
      updated_at: new Date('2026-05-05T10:00:00.000Z'),
      user: { nome: 'Joao da Silva' },
      ...overrides,
    }) as Training;

  beforeEach(() => {
    repository = {
      findOne: jest.fn(),
    };
    tenantService = {
      getTenantId: jest.fn(() => 'company-1'),
    };
    documentStorageService = {
      generateDocumentKey: jest.fn(
        () =>
          'documents/company-1/trainings/training-1/1710000000000-TREINAMENTO_NR-35_2026-05-05.pdf',
      ),
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
          legacy: !key.startsWith('documents/company-1/'),
        }),
      ),
      uploadFile: jest.fn(() => Promise.resolve()),
      uploadFileWithCapability: jest.fn((reference) =>
        Promise.resolve(markAuthorizedStorageReference(reference)),
      ),
      getSignedUrl: jest.fn(() =>
        Promise.resolve('https://storage.example.com/training.pdf'),
      ),
      deleteFile: jest.fn(() => Promise.resolve()),
    };
    documentGovernanceService = {
      registerFinalDocument: jest.fn(() =>
        Promise.resolve({
          hash: 'hash-123',
          registryEntry: {
            document_code: 'TRN-2026-NR35',
          } as unknown as DocumentRegistryEntry,
        }),
      ),
    };
    documentRegistryService = {
      findByDocument: jest.fn(() => Promise.resolve(null)),
    };
    metricsService = {
      incrementTrainingRegistered: jest.fn(),
    };

    service = new TrainingsService(
      repository as Repository<Training>,
      tenantService as TenantService,
      documentStorageService as DocumentStorageService,
      documentGovernanceService as DocumentGovernanceService,
      documentRegistryService as DocumentRegistryService,
      {
        issueToken: jest.fn().mockResolvedValue('token-mock'),
      } as unknown as import('../../shared/services/public-validation-grant.service').PublicValidationGrantService,
      metricsService as MetricsService,
    );
  });

  it('attachPdf envia o arquivo, registra governanca e retorna metadata oficial', async () => {
    (repository.findOne as jest.Mock).mockResolvedValue(makeTraining());

    const file = {
      originalname: 'treinamento-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4'),
    } as Express.Multer.File;

    const result = await service.attachPdf('training-1', file, 'user-1');

    expect(documentStorageService.generateDocumentKey).toHaveBeenCalledWith(
      'company-1',
      'trainings',
      'training-1',
      'treinamento-final.pdf',
    );
    expect(
      documentStorageService.referenceForExistingObject,
    ).toHaveBeenCalledWith(
      'documents/company-1/trainings/training-1/1710000000000-TREINAMENTO_NR-35_2026-05-05.pdf',
      {
        resourceType: 'training',
        resourceId: 'training-1',
      },
      'p1-document-storage-uploadFile',
    );
    expect(
      documentStorageService.uploadFileWithCapability,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'company-1',
        key: 'documents/company-1/trainings/training-1/1710000000000-TREINAMENTO_NR-35_2026-05-05.pdf',
        purpose: 'p1-document-storage-uploadFile',
      }),
      file.buffer,
      'application/pdf',
    );
    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        module: 'training',
        entityId: 'training-1',
        fileKey:
          'documents/company-1/trainings/training-1/1710000000000-TREINAMENTO_NR-35_2026-05-05.pdf',
      }),
    );
    expect(result).toMatchObject({
      trainingId: 'training-1',
      hasFinalPdf: true,
      availability: 'ready',
      fileHash: 'hash-123',
      documentCode: 'TRN-2026-NR35',
    });
  });

  it('getPdfAccess retorna not_emitted quando treinamento nao possui PDF oficial', async () => {
    (repository.findOne as jest.Mock).mockResolvedValue(
      makeTraining({ pdf_file_key: undefined }),
    );

    const result = await service.getPdfAccess('training-1');

    expect(result).toMatchObject({
      entityId: 'training-1',
      hasFinalPdf: false,
      availability: 'not_emitted',
      fileKey: null,
      url: null,
    });
  });

  it('getPdfAccess retorna URL assinada quando o PDF oficial existe', async () => {
    (repository.findOne as jest.Mock).mockResolvedValue(
      makeTraining({
        pdf_file_key:
          'documents/company-1/trainings/training-1/1710000000000-training.pdf',
        pdf_folder_path: 'documents/company-1/trainings/training-1',
        pdf_original_name: 'training.pdf',
        pdf_file_hash: 'hash-123',
      }),
    );
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValue({
      document_code: 'TRN-2026-NR35',
      file_hash: 'hash-123',
    });

    const result = await service.getPdfAccess('training-1');

    expect(documentStorageService.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'company-1',
        key: 'documents/company-1/trainings/training-1/1710000000000-training.pdf',
        owner: {
          resourceType: 'training',
          resourceId: 'training-1',
        },
        purpose: 'p1-document-storage-getSignedUrl',
      }),
    );
    expect(result).toMatchObject({
      entityId: 'training-1',
      hasFinalPdf: true,
      availability: 'ready',
      fileKey:
        'documents/company-1/trainings/training-1/1710000000000-training.pdf',
      originalName: 'training.pdf',
      fileHash: 'hash-123',
      documentCode: 'TRN-2026-NR35',
      url: 'https://storage.example.com/training.pdf',
    });
  });
});
