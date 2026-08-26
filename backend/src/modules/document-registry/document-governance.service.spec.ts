import { DataSource, EntityManager } from 'typeorm';
import { DocumentGovernanceService } from './document-governance.service';
import type { PdfService } from '../../shared/services/pdf.service';
import type { DocumentBundleService } from '../../shared/services/document-bundle.service';
import type { DocumentRegistryService } from './document-registry.service';
import type { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import type { AppendForensicTrailEventInput } from '../forensic-trail/forensic-trail.service';
import { storageKeyFingerprint } from '../../shared/storage/storage-compensation.util';

describe('DocumentGovernanceService', () => {
  let service: DocumentGovernanceService;
  let dataSource: Pick<DataSource, 'transaction'>;
  let manager: EntityManager;
  let pdfService: Pick<PdfService, 'computeHash' | 'registerHashIntegrity'>;
  let documentBundleService: Pick<
    DocumentBundleService,
    'buildWeeklyPdfBundle'
  >;
  let documentRegistryService: Pick<
    DocumentRegistryService,
    'upsertWithManager' | 'removeWithManager' | 'findByDocument' | 'list'
  >;
  let forensicTrailService: Pick<ForensicTrailService, 'append'>;

  beforeEach(() => {
    manager = {} as EntityManager;
    dataSource = {
      transaction: jest.fn(
        async (cb: (tx: EntityManager) => Promise<unknown>) => cb(manager),
      ) as unknown as DataSource['transaction'],
    };
    pdfService = {
      computeHash: jest.fn(() => 'abc123'),
      registerHashIntegrity: jest.fn(),
    };
    documentBundleService = {
      buildWeeklyPdfBundle: jest.fn(),
    };
    documentRegistryService = {
      upsertWithManager: jest.fn(),
      removeWithManager: jest.fn(),
      findByDocument: jest.fn(),
      list: jest.fn(),
    };
    forensicTrailService = {
      append: jest.fn(),
    };

    service = new DocumentGovernanceService(
      dataSource as DataSource,
      pdfService as PdfService,
      documentBundleService as DocumentBundleService,
      documentRegistryService as DocumentRegistryService,
      forensicTrailService as ForensicTrailService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('registra integridade e registry no mesmo bloco transacional', async () => {
    const persistEntityMetadata = jest.fn();
    const registryEntry = {
      id: 'registry-1',
      file_hash: 'abc123',
      file_key: 'documents/company-1/checklists/doc.pdf',
    };
    (documentRegistryService.upsertWithManager as jest.Mock).mockResolvedValue(
      registryEntry,
    );

    await expect(
      service.registerFinalDocument({
        companyId: 'company-1',
        module: 'checklist',
        entityId: 'checklist-1',
        title: 'Checklist de campo',
        documentDate: '2026-03-14',
        fileKey: 'documents/company-1/checklists/doc.pdf',
        folderPath: 'documents/company-1/checklists',
        originalName: 'checklist.pdf',
        mimeType: 'application/pdf',
        fileBuffer: Buffer.from('%PDF-governed'),
        createdBy: 'user-1',
        persistEntityMetadata,
      }),
    ).resolves.toEqual({
      hash: 'abc123',
      registryEntry,
    });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(pdfService.computeHash).toHaveBeenCalledWith(
      Buffer.from('%PDF-governed'),
    );
    expect(persistEntityMetadata).toHaveBeenCalledWith(manager, 'abc123');
    expect(pdfService.registerHashIntegrity).toHaveBeenCalledWith(
      'abc123',
      expect.objectContaining({
        originalName: 'checklist.pdf',
        recordedByUserId: 'user-1',
        companyId: 'company-1',
      }),
      { manager },
    );
    expect(documentRegistryService.upsertWithManager).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        companyId: 'company-1',
        module: 'checklist',
        entityId: 'checklist-1',
        fileHash: 'abc123',
      }),
    );
    const registerTrailCalls = (forensicTrailService.append as jest.Mock).mock
      .calls as Array<
      [AppendForensicTrailEventInput, { manager?: EntityManager }]
    >;
    const firstRegisterTrailCall = registerTrailCalls[0];
    if (!firstRegisterTrailCall) {
      throw new Error('Expected forensic register trail call');
    }
    const [registerTrailInput, registerTrailOptions] = firstRegisterTrailCall;
    const registerMetadata = registerTrailInput.metadata as Record<
      string,
      unknown
    >;
    expect(registerTrailInput.eventType).toBe(
      FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REGISTERED,
    );
    expect(registerTrailInput.module).toBe('checklist');
    expect(registerTrailInput.entityId).toBe('checklist-1');
    expect(registerTrailInput.companyId).toBe('company-1');
    expect(registerTrailInput.userId).toBe('user-1');
    expect(registerMetadata.registryEntryId).toBe('registry-1');
    expect(registerMetadata.fileHash).toBe('abc123');
    expect(registerTrailOptions.manager).toBe(manager);
  });

  it('propaga a falha do bloco relacional sem deixar o erro silencioso', async () => {
    const loggerError = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation();
    const failure = new Error('registry failed');
    (documentRegistryService.upsertWithManager as jest.Mock).mockRejectedValue(
      failure,
    );

    await expect(
      service.registerFinalDocument({
        companyId: 'company-1',
        module: 'checklist',
        entityId: 'checklist-1',
        title: 'Checklist de campo',
        fileKey: 'documents/company-1/checklists/doc.pdf',
        fileBuffer: Buffer.from('%PDF-governed'),
      }),
    ).rejects.toThrow('registry failed');

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'document_governance_registration_failed',
        module: 'checklist',
        entityId: 'checklist-1',
        errorName: 'Error',
        keyFingerprint: storageKeyFingerprint(
          'documents/company-1/checklists/doc.pdf',
        ),
      }),
      failure.stack,
    );
  });

  it('remove registry em transação e preserva a política de rastreabilidade da integridade', async () => {
    const removeEntityState = jest.fn();
    const loggerDebug = jest
      .spyOn(service['logger'], 'debug')
      .mockImplementation();
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValue({
      file_key: 'documents/company-1/checklists/doc.pdf',
    });
    const cleanupStoredFile = jest.fn();

    await service.removeFinalDocumentReference({
      companyId: 'company-1',
      module: 'checklist',
      entityId: 'checklist-1',
      removeEntityState,
      cleanupStoredFile,
    });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(removeEntityState).toHaveBeenCalledWith(manager);
    expect(documentRegistryService.findByDocument).toHaveBeenCalledWith(
      'checklist',
      'checklist-1',
      'pdf',
      'company-1',
    );
    expect(documentRegistryService.removeWithManager).toHaveBeenCalledWith(
      manager,
      {
        companyId: 'company-1',
        module: 'checklist',
        entityId: 'checklist-1',
        documentType: undefined,
      },
    );
    expect(cleanupStoredFile).toHaveBeenCalledWith(
      'documents/company-1/checklists/doc.pdf',
    );
    const removalTrailCalls = (forensicTrailService.append as jest.Mock).mock
      .calls as Array<
      [AppendForensicTrailEventInput, { manager?: EntityManager }]
    >;
    const firstRemovalTrailCall = removalTrailCalls[0];
    if (!firstRemovalTrailCall) {
      throw new Error('Expected forensic removal trail call');
    }
    const [removalTrailInput, removalTrailOptions] = firstRemovalTrailCall;
    const removalMetadata = removalTrailInput.metadata as Record<
      string,
      unknown
    >;
    expect(removalTrailInput.eventType).toBe(
      FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
    );
    expect(removalTrailInput.module).toBe('checklist');
    expect(removalTrailInput.entityId).toBe('checklist-1');
    expect(removalTrailInput.companyId).toBe('company-1');
    expect(removalMetadata.hadGovernedFile).toBe(true);
    expect(removalMetadata.keyFingerprint).toBe(
      storageKeyFingerprint('documents/company-1/checklists/doc.pdf'),
    );
    expect(removalTrailOptions.manager).toBe(manager);
    expect(loggerDebug).toHaveBeenCalledWith(
      expect.stringContaining('registro de integridade preservado'),
    );
  });

  it('resolve contexto de assinatura a partir do registry governado', async () => {
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValue({
      id: 'registry-22',
      document_code: 'CHECKLIST-2026-11-ABCD1234',
      file_hash: 'known-hash',
      file_key: 'documents/company-1/checklists/doc.pdf',
    });

    await expect(
      service.findRegistryContextForSignature(
        'checklist-1',
        'CHECKLIST',
        'company-1',
      ),
    ).resolves.toEqual({
      registryEntryId: 'registry-22',
      documentCode: 'CHECKLIST-2026-11-ABCD1234',
      fileHash: 'known-hash',
      fileKey: 'documents/company-1/checklists/doc.pdf',
      module: 'checklist',
    });

    expect(documentRegistryService.findByDocument).toHaveBeenCalledWith(
      'checklist',
      'checklist-1',
      'pdf',
      'company-1',
    );
  });

  it('lista documentos finais de um módulo a partir do registry canônico', async () => {
    (documentRegistryService.list as jest.Mock).mockResolvedValue([
      {
        entity_id: 'pt-1',
        company_id: 'company-1',
        title: 'PT principal',
        document_date: new Date('2026-03-16T00:00:00.000Z'),
        file_key: 'documents/company-1/pts/pt-1/final.pdf',
        folder_path: 'documents/company-1/pts/2026/11',
        original_name: 'pt-final.pdf',
      },
    ]);

    await expect(
      service.listFinalDocuments('pt', { companyId: 'company-1', year: 2026 }),
    ).resolves.toEqual([
      {
        entityId: 'pt-1',
        id: 'pt-1',
        title: 'PT principal',
        date: new Date('2026-03-16T00:00:00.000Z'),
        companyId: 'company-1',
        fileKey: 'documents/company-1/pts/pt-1/final.pdf',
        folderPath: 'documents/company-1/pts/2026/11',
        originalName: 'pt-final.pdf',
        module: 'pt',
      },
    ]);

    expect(documentRegistryService.list).toHaveBeenCalledWith({
      companyId: 'company-1',
      year: 2026,
      modules: ['pt'],
    });
  });

  it('gera pacote semanal de módulo a partir do registry como fonte única', async () => {
    (documentRegistryService.list as jest.Mock).mockResolvedValue([
      {
        entity_id: 'audit-1',
        company_id: 'company-1',
        title: 'Auditoria interna',
        document_date: new Date('2026-03-16T00:00:00.000Z'),
        file_key: 'documents/company-1/audit/audit-1/final.pdf',
        folder_path: 'audits/company-1/2026/week-12',
        original_name: 'audit-final.pdf',
      },
    ]);
    (documentBundleService.buildWeeklyPdfBundle as jest.Mock).mockResolvedValue(
      {
        buffer: Buffer.from('%PDF-bundle'),
        fileName: 'auditoria-semana-2026-12.pdf',
      },
    );

    await expect(
      service.getModuleWeeklyBundle('audit', 'Auditoria', {
        companyId: 'company-1',
        year: 2026,
        week: 12,
      }),
    ).resolves.toEqual({
      buffer: Buffer.from('%PDF-bundle'),
      fileName: 'auditoria-semana-2026-12.pdf',
    });

    expect(documentBundleService.buildWeeklyPdfBundle).toHaveBeenCalledWith(
      'Auditoria',
      { companyId: 'company-1', year: 2026, week: 12 },
      [
        {
          fileKey: 'documents/company-1/audit/audit-1/final.pdf',
          title: 'Auditoria interna',
          originalName: 'audit-final.pdf',
          date: new Date('2026-03-16T00:00:00.000Z'),
          resourceType: 'audit',
          resourceId: 'audit-1',
        },
      ],
    );
  });

  it('mantem o mapeamento centralizado para auditoria sem perder contexto', async () => {
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValue({
      id: 'registry-audit',
      document_code: 'AUDIT-2026-11-ABCD1234',
      file_hash: 'audit-hash',
      file_key: 'documents/company-1/audits/doc.pdf',
    });

    await expect(
      service.findRegistryContextForSignature(
        'audit-1',
        'AUDITORIA',
        'company-1',
      ),
    ).resolves.toEqual({
      registryEntryId: 'registry-audit',
      documentCode: 'AUDIT-2026-11-ABCD1234',
      fileHash: 'audit-hash',
      fileKey: 'documents/company-1/audits/doc.pdf',
      module: 'audit',
    });

    expect(documentRegistryService.findByDocument).toHaveBeenCalledWith(
      'audit',
      'audit-1',
      'pdf',
      'company-1',
    );
  });

  it('expõe internamente tipos documentais sem mapeamento', async () => {
    const loggerWarn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation();

    await expect(
      service.findRegistryContextForSignature(
        'document-1',
        'TIPO_DESCONHECIDO',
        'company-1',
      ),
    ).resolves.toBeNull();

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Tipo documental sem mapeamento'),
    );
  });
});
