import { DashboardDocumentPendenciesService } from './dashboard-document-pendencies.service';

type MockRepo = {
  find: jest.Mock;
  query: jest.Mock;
};

function createMockRepo(): MockRepo {
  return {
    find: jest.fn().mockResolvedValue([]),
    query: jest.fn().mockResolvedValue([]),
  };
}

describe('DashboardDocumentPendenciesService', () => {
  let aprsRepository: MockRepo;
  let auditsRepository: MockRepo;
  let catsRepository: MockRepo;
  let checklistsRepository: MockRepo;
  let companiesRepository: MockRepo;
  let ddsRepository: MockRepo;
  let documentImportsRepository: MockRepo;
  let documentRegistryRepository: MockRepo;
  let documentVideosRepository: MockRepo;
  let inspectionsRepository: MockRepo;
  let nonConformitiesRepository: MockRepo;
  let ptsRepository: MockRepo;
  let rdosRepository: MockRepo;
  let signaturesRepository: MockRepo;
  let sitesRepository: MockRepo;
  let documentStorageService: { getSignedUrl: jest.Mock };
  let cacheManager: { get: jest.Mock; set: jest.Mock };
  let documentAvailabilitySnapshotService: {
    scheduleRefreshIfNeeded: jest.Mock;
    ensureSnapshotsAvailable: jest.Mock;
    listUnavailableSnapshots: jest.Mock;
  };
  let publicValidationGrantService: { issueToken: jest.Mock };
  let cacheStore: Map<string, unknown>;
  let service: DashboardDocumentPendenciesService;

  beforeEach(() => {
    aprsRepository = createMockRepo();
    auditsRepository = createMockRepo();
    catsRepository = createMockRepo();
    checklistsRepository = createMockRepo();
    companiesRepository = createMockRepo();
    ddsRepository = createMockRepo();
    documentImportsRepository = createMockRepo();
    documentRegistryRepository = createMockRepo();
    documentVideosRepository = createMockRepo();
    inspectionsRepository = createMockRepo();
    nonConformitiesRepository = createMockRepo();
    ptsRepository = createMockRepo();
    rdosRepository = createMockRepo();
    signaturesRepository = createMockRepo();
    sitesRepository = createMockRepo();
    documentStorageService = {
      getSignedUrl: jest.fn(),
    };
    documentAvailabilitySnapshotService = {
      scheduleRefreshIfNeeded: jest.fn().mockResolvedValue({
        hasRows: true,
        lastCheckedAt: new Date('2026-04-13T10:00:00.000Z'),
        stale: false,
        readable: true,
        hasTrackableObjects: true,
        refreshScheduled: false,
      }),
      ensureSnapshotsAvailable: jest.fn().mockResolvedValue(undefined),
      listUnavailableSnapshots: jest.fn().mockResolvedValue([]),
    };
    publicValidationGrantService = {
      issueToken: jest.fn().mockResolvedValue('token-publico'),
    };
    cacheStore = new Map<string, unknown>();
    cacheManager = {
      get: jest.fn((key: string) => Promise.resolve(cacheStore.get(key))),
      set: jest.fn((key: string, value: unknown) => {
        cacheStore.set(key, value);
        return Promise.resolve(undefined);
      }),
    };

    service = new DashboardDocumentPendenciesService(
      aprsRepository as never,
      auditsRepository as never,
      catsRepository as never,
      checklistsRepository as never,
      companiesRepository as never,
      ddsRepository as never,
      documentImportsRepository as never,
      documentRegistryRepository as never,
      documentVideosRepository as never,
      inspectionsRepository as never,
      nonConformitiesRepository as never,
      ptsRepository as never,
      rdosRepository as never,
      signaturesRepository as never,
      sitesRepository as never,
      documentStorageService as never,
      cacheManager as never,
      documentAvailabilitySnapshotService as never,
      publicValidationGrantService as never,
    );
  });

  it('retorna vazio sem consultar fontes quando a criticidade pedida nunca existe', async () => {
    const response = await service.getDocumentPendencies({
      filters: { criticality: 'low' },
      currentCompanyId: 'company-1',
      permissions: ['can_view_dashboard'],
    });

    expect(response.summary.total).toBe(0);
    expect(response.items).toEqual([]);
    expect(aprsRepository.find).not.toHaveBeenCalled();
    expect(documentImportsRepository.query).not.toHaveBeenCalled();
    expect(documentRegistryRepository.find).not.toHaveBeenCalled();
    expect(documentVideosRepository.find).not.toHaveBeenCalled();
    expect(nonConformitiesRepository.find).not.toHaveBeenCalled();
    expect(
      documentAvailabilitySnapshotService.scheduleRefreshIfNeeded,
    ).not.toHaveBeenCalled();
  });

  it('evita fontes de storage quando o filtro pede apenas criticidade critical', async () => {
    const response = await service.getDocumentPendencies({
      filters: { criticality: 'critical' },
      currentCompanyId: 'company-1',
      permissions: ['can_view_rdos', 'can_import_documents'],
    });

    expect(response.summary.total).toBe(0);
    expect(documentRegistryRepository.find).not.toHaveBeenCalled();
    expect(documentVideosRepository.find).not.toHaveBeenCalled();
    expect(nonConformitiesRepository.find).not.toHaveBeenCalled();
    expect(documentStorageService.getSignedUrl).not.toHaveBeenCalled();
    expect(documentStorageService.getSignedUrl).not.toHaveBeenCalled();
    expect(
      documentAvailabilitySnapshotService.scheduleRefreshIfNeeded,
    ).not.toHaveBeenCalled();
    expect(documentImportsRepository.query).toHaveBeenCalledTimes(1);
  });

  it('reutiliza o cache base entre páginas sem recalcular todas as fontes', async () => {
    documentImportsRepository.query.mockResolvedValueOnce([
      {
        type: 'failed_import',
        module: 'document-import',
        company_id: 'company-1',
        site_id: null,
        document_id: 'import-1',
        document_code: 'dds.pdf',
        title: 'dds.pdf',
        status: 'DEAD_LETTER',
        relevant_date: new Date('2026-04-12T10:00:00.000Z'),
        required_signatures: null,
        signed_signatures: null,
        missing_fields: null,
        attachment_id: null,
        attachment_index: null,
        file_key: null,
        original_name: null,
        import_id: 'import-1',
        idempotency_key: 'idem-1',
        attempts: 3,
        error_message: 'Arquivo inconsistente',
      },
    ]);

    const pageOne = await service.getDocumentPendencies({
      filters: {
        module: 'document-import',
        criticality: 'critical',
        page: 1,
        limit: 1,
      },
      currentCompanyId: 'company-1',
      permissions: ['can_import_documents'],
    });

    const pageTwo = await service.getDocumentPendencies({
      filters: {
        module: 'document-import',
        criticality: 'critical',
        page: 2,
        limit: 1,
      },
      currentCompanyId: 'company-1',
      permissions: ['can_import_documents'],
    });

    expect(documentImportsRepository.query).toHaveBeenCalledTimes(1);
    expect(
      documentAvailabilitySnapshotService.scheduleRefreshIfNeeded,
    ).not.toHaveBeenCalled();
    expect(pageOne.pagination.total).toBe(1);
    expect(pageOne.items).toHaveLength(1);
    expect(pageTwo.pagination.total).toBe(1);
    expect(pageTwo.items).toHaveLength(0);
  });

  it('reutiliza o payload preparado entre conjuntos de permissões sem vazar itens não autorizados', async () => {
    documentImportsRepository.query.mockResolvedValueOnce([
      {
        type: 'failed_import',
        module: 'document-import',
        company_id: 'company-1',
        site_id: null,
        document_id: 'import-1',
        document_code: 'dds.pdf',
        title: 'dds.pdf',
        status: 'DEAD_LETTER',
        relevant_date: new Date('2026-04-12T10:00:00.000Z'),
        required_signatures: null,
        signed_signatures: null,
        missing_fields: null,
        attachment_id: null,
        attachment_index: null,
        file_key: null,
        original_name: null,
        import_id: 'import-1',
        idempotency_key: 'idem-1',
        attempts: 3,
        error_message: 'Arquivo inconsistente',
      },
    ]);

    const authorized = await service.getDocumentPendencies({
      filters: {
        module: 'document-import',
        criticality: 'critical',
      },
      currentCompanyId: 'company-1',
      permissions: ['can_import_documents'],
    });

    const unauthorized = await service.getDocumentPendencies({
      filters: {
        module: 'document-import',
        criticality: 'critical',
      },
      currentCompanyId: 'company-1',
      permissions: ['can_view_rdos'],
    });

    expect(documentImportsRepository.query).toHaveBeenCalledTimes(1);
    expect(authorized.summary.total).toBe(1);
    expect(authorized.items).toHaveLength(1);
    expect(unauthorized.summary.total).toBe(0);
    expect(unauthorized.items).toHaveLength(0);
  });

  it('deriva filtros do cache base aquecido sem consultar novamente o banco', async () => {
    documentImportsRepository.query.mockResolvedValueOnce([
      {
        type: 'failed_import',
        module: 'document-import',
        company_id: 'company-1',
        site_id: null,
        document_id: 'import-1',
        document_code: 'dds.pdf',
        title: 'dds.pdf',
        status: 'DEAD_LETTER',
        relevant_date: new Date('2026-04-12T10:00:00.000Z'),
        required_signatures: null,
        signed_signatures: null,
        missing_fields: null,
        attachment_id: null,
        attachment_index: null,
        file_key: null,
        original_name: null,
        import_id: 'import-1',
        idempotency_key: 'idem-1',
        attempts: 3,
        error_message: 'Arquivo inconsistente',
      },
    ]);

    const base = await service.getDocumentPendencies({
      filters: { page: 1, limit: 20 },
      currentCompanyId: 'company-1',
      permissions: ['can_import_documents'],
    });

    const filtered = await service.getDocumentPendencies({
      filters: {
        module: 'document-import',
        criticality: 'critical',
      },
      currentCompanyId: 'company-1',
      permissions: ['can_import_documents'],
    });

    expect(documentImportsRepository.query).toHaveBeenCalledTimes(1);
    expect(base.summary.total).toBe(1);
    expect(filtered.summary.total).toBe(1);
    expect(filtered.items).toHaveLength(1);
  });

  it('marca a resposta como degradada quando o snapshot documental ainda está aquecendo', async () => {
    documentAvailabilitySnapshotService.scheduleRefreshIfNeeded.mockResolvedValueOnce(
      {
        hasRows: false,
        lastCheckedAt: null,
        stale: true,
        readable: false,
        hasTrackableObjects: true,
        refreshScheduled: true,
      },
    );

    const response = await service.getDocumentPendencies({
      filters: { module: 'cat' },
      currentCompanyId: 'company-1',
      permissions: ['can_view_cats'],
    });

    expect(
      documentAvailabilitySnapshotService.scheduleRefreshIfNeeded,
    ).toHaveBeenCalledTimes(1);
    expect(response.degraded).toBe(true);
    expect(response.failedSources).toEqual(['storage-snapshot-backed']);
    expect(response.items).toEqual([]);
  });
});
