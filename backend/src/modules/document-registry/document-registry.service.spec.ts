/* eslint-disable @typescript-eslint/unbound-method */
import { BadRequestException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { DocumentBundleService } from '../../shared/services/document-bundle.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import { DocumentRegistryEntry } from './entities/document-registry.entity';
import { DocumentRegistryVersionEntry } from './entities/document-registry-version.entity';
import { DocumentRegistryService } from './document-registry.service';

describe('DocumentRegistryService', () => {
  let service: DocumentRegistryService;
  let registryRepository: jest.Mocked<Repository<DocumentRegistryEntry>>;
  let versionRepository: jest.Mocked<Repository<DocumentRegistryVersionEntry>>;
  let tenantService: Pick<TenantService, 'getTenantId' | 'getContext' | 'run'>;
  let documentBundleService: Pick<
    DocumentBundleService,
    'buildWeeklyPdfBundle'
  >;
  let documentStorageService: Pick<
    DocumentStorageService,
    'getSignedUrl' | 'referenceForExistingObject'
  >;
  let queryBuilder: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    take: jest.Mock;
    getMany: jest.Mock;
    getOne: jest.Mock;
  };

  beforeEach(() => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
    };

    registryRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      findOne: jest.fn(),
      manager: {} as Repository<DocumentRegistryEntry>['manager'],
    } as unknown as jest.Mocked<Repository<DocumentRegistryEntry>>;

    versionRepository = {
      findOne: jest.fn(),
      create: jest.fn((data) => data as DocumentRegistryVersionEntry),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<DocumentRegistryVersionEntry>>;

    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
      getContext: jest.fn().mockReturnValue({
        companyId: 'company-1',
        isSuperAdmin: false,
        siteScope: 'all',
      }),
      run: jest.fn((_context, callback) => callback()),
    };

    documentBundleService = {
      buildWeeklyPdfBundle: jest.fn(),
    };
    documentStorageService = {
      referenceForExistingObject: jest.fn((key: string, owner, purpose) => ({
        tenantId: 'company-1',
        key,
        owner,
        purpose,
      })),
      getSignedUrl: jest.fn().mockResolvedValue('/storage/download/token'),
    };

    service = new DocumentRegistryService(
      registryRepository,
      versionRepository,
      {} as DataSource,
      tenantService as TenantService,
      documentBundleService as DocumentBundleService,
      documentStorageService as DocumentStorageService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('aplica sempre o tenant autenticado na listagem governada', async () => {
    await service.list({
      companyId: 'company-1',
      year: 2026,
      week: 14,
      modules: ['dds'],
    });

    expect(registryRepository.createQueryBuilder).toHaveBeenCalledWith(
      'document',
    );
    expect(queryBuilder.where).toHaveBeenCalledWith(
      'document.company_id = :companyId',
      { companyId: 'company-1' },
    );
    expect(queryBuilder.take).toHaveBeenCalledWith(500);
  });

  it('rejeita company_id divergente do tenant autenticado', async () => {
    await expect(
      service.list({
        companyId: 'company-2',
        year: 2026,
      }),
    ).rejects.toThrow(
      new BadRequestException('company_id divergente do tenant autenticado.'),
    );

    expect(registryRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('executa validação pública dentro do contexto explícito do tenant', async () => {
    await expect(
      service.validatePublicCode({
        code: ' DDS-2026-TEST ',
        companyId: 'company-1',
        expectedModule: 'dds',
      }),
    ).resolves.toMatchObject({
      valid: false,
      code: 'DDS-2026-TEST',
    });

    expect(tenantService.run).toHaveBeenCalledWith(
      {
        companyId: 'company-1',
        isSuperAdmin: false,
        siteScope: 'all',
      },
      expect.any(Function),
    );
    expect(queryBuilder.getOne).toHaveBeenCalled();
  });

  it('mantém compatibilidade para chamadas internas sem tenant usando companyId explícito', async () => {
    (tenantService.getTenantId as jest.Mock).mockReturnValue(undefined);

    await service.list({
      companyId: 'company-internal',
      year: 2026,
    });

    expect(queryBuilder.where).toHaveBeenCalledWith(
      'document.company_id = :companyId',
      { companyId: 'company-internal' },
    );
  });

  it('restringe listagem do registry ao caminho da obra para usuario operacional', async () => {
    (tenantService.getContext as jest.Mock).mockReturnValue({
      companyId: 'company-1',
      isSuperAdmin: false,
      userId: 'user-tst',
      siteId: 'site-1',
      siteScope: 'single',
    });

    await service.list({ year: 2026, week: 18 });

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '(document.file_key LIKE :sitePath0 OR document.folder_path LIKE :sitePath0)',
      { sitePath0: '%/sites/site-1/%' },
    );
  });

  it('emite URL individual somente quando documento arquivado pertence ao escopo da obra', async () => {
    (tenantService.getContext as jest.Mock).mockReturnValue({
      companyId: 'company-1',
      isSuperAdmin: false,
      userId: 'user-tst',
      siteId: 'site-1',
      siteScope: 'single',
    });
    registryRepository.findOne.mockResolvedValue({
      id: 'registry-1',
      company_id: 'company-1',
      entity_id: 'dds-1',
      file_key: 'documents/company-1/dds/sites/site-1/dds-1/final.pdf',
      folder_path: 'documents/company-1/dds/sites/site-1/dds-1',
      original_name: 'dds-final.pdf',
    } as DocumentRegistryEntry);

    await expect(service.getPdfAccess('registry-1')).resolves.toMatchObject({
      entityId: 'dds-1',
      availability: 'ready',
      url: '/storage/download/token',
    });
    expect(documentStorageService.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/dds/sites/site-1/dds-1/final.pdf',
      }),
    );
  });

  it('nega URL individual quando documento arquivado pertence a outra obra', async () => {
    (tenantService.getContext as jest.Mock).mockReturnValue({
      companyId: 'company-1',
      isSuperAdmin: false,
      userId: 'user-tst',
      siteId: 'site-1',
      siteScope: 'single',
    });
    registryRepository.findOne.mockResolvedValue({
      id: 'registry-2',
      company_id: 'company-1',
      entity_id: 'dds-2',
      file_key: 'documents/company-1/dds/sites/site-2/dds-2/final.pdf',
      folder_path: 'documents/company-1/dds/sites/site-2/dds-2',
      original_name: 'dds-final.pdf',
    } as DocumentRegistryEntry);

    await expect(service.getPdfAccess('registry-2')).resolves.toMatchObject({
      entityId: 'registry-2',
      hasFinalPdf: false,
      availability: 'not_emitted',
      url: null,
    });
    expect(documentStorageService.getSignedUrl).not.toHaveBeenCalled();
  });
});
