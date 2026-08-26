import { PrivacyGovernanceService } from './privacy-governance.service';
import type { StoragePrefixReference } from '../../shared/storage/storage-object-reference';

describe('PrivacyGovernanceService', () => {
  const makeService = () => {
    const dataSource = {
      query: jest.fn(),
    };
    const documentStorageService = {
      createPrefixReference: jest.fn(
        (input: StoragePrefixReference): StoragePrefixReference => input,
      ),
      listKeys: jest.fn(),
    };

    return {
      service: new PrivacyGovernanceService(
        dataSource as never,
        documentStorageService as never,
      ),
      dataSource,
      documentStorageService,
    };
  };

  it('expoe registro de suboperadores com evidencias pendentes explicitas', () => {
    const { service } = makeService();

    const result = service.getSubprocessors();

    expect(result.subprocessors.length).toBeGreaterThan(0);
    expect(result.caveat).toContain('pending_review');
    expect(result.subprocessors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openai',
          sensitiveDataRisk: 'high',
          dpaStatus: 'pending_review',
        }),
        expect.objectContaining({
          id: 'sentry',
          category: 'observability',
        }),
      ]),
    );
  });

  it('expoe matriz de retencao com status de implementacao por dominio', () => {
    const { service } = makeService();

    const result = service.getRetentionMatrix();

    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dataDomain: 'Logs de auditoria e segurança',
          implementationStatus: 'implemented',
        }),
        expect.objectContaining({
          dataDomain: 'Backups',
          implementationStatus: 'requires_external_evidence',
        }),
      ]),
    );
  });

  it('expoe checklist de offboarding com passos bloqueantes', () => {
    const { service } = makeService();

    const result = service.getTenantOffboardingChecklist();

    expect(result.steps.some((step) => step.blocking)).toBe(true);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Inventariar arquivos, PDFs, evidências e anexos em storage',
          blocking: true,
        }),
      ]),
    );
  });

  it('gera manifesto de storage do tenant a partir do document_registry', async () => {
    const { service, dataSource, documentStorageService } = makeService();
    dataSource.query
      .mockResolvedValueOnce([
        {
          id: 'doc-1',
          module: 'APR',
          document_type: 'pdf',
          entity_id: 'apr-1',
          title: 'APR final',
          file_key: 'documents/company-1/apr-1.pdf',
          original_name: 'apr.pdf',
          mime_type: 'application/pdf',
          file_hash: 'hash-1',
          status: 'ACTIVE',
          litigation_hold: false,
          expires_at: null,
          created_at: new Date('2026-04-24T12:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([{ module: 'APR', total: '1' }]);

    const result = await service.getTenantStorageManifest('company-1');

    expect(result.database.totalKnownObjects).toBe(1);
    expect(result.database.entries[0]).toMatchObject({
      fileKey: 'documents/company-1/apr-1.pdf',
      module: 'APR',
    });
    expect(result.storage.listingRequested).toBe(false);
    expect(documentStorageService.listKeys).not.toHaveBeenCalled();
  });

  it('lista prefixos do storage quando solicitado', async () => {
    const { service, dataSource, documentStorageService } = makeService();
    dataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    documentStorageService.listKeys
      .mockResolvedValueOnce(['documents/company-1/a.pdf'])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['reports/company-1/b.pdf']);

    const result = await service.getTenantStorageManifest('company-1', {
      includeStorageListing: true,
    });

    expect(documentStorageService.listKeys).toHaveBeenCalledTimes(3);
    expect(result.storage.keys).toEqual([
      'documents/company-1/a.pdf',
      'reports/company-1/b.pdf',
    ]);
  });

  it('gera plano dry-run de expurgo respeitando legal hold e vencimento', async () => {
    const { service, dataSource } = makeService();
    dataSource.query
      .mockResolvedValueOnce([
        {
          id: 'eligible',
          module: 'APR',
          document_type: 'pdf',
          entity_id: 'apr-1',
          title: 'APR expirada',
          file_key: 'documents/company-1/eligible.pdf',
          original_name: null,
          mime_type: 'application/pdf',
          file_hash: null,
          status: 'EXPIRED',
          litigation_hold: false,
          expires_at: new Date('2020-01-01T00:00:00.000Z'),
          created_at: new Date('2019-01-01T00:00:00.000Z'),
        },
        {
          id: 'blocked',
          module: 'APR',
          document_type: 'pdf',
          entity_id: 'apr-2',
          title: 'APR em legal hold',
          file_key: 'documents/company-1/blocked.pdf',
          original_name: null,
          mime_type: 'application/pdf',
          file_hash: null,
          status: 'EXPIRED',
          litigation_hold: true,
          expires_at: new Date('2020-01-01T00:00:00.000Z'),
          created_at: new Date('2019-01-01T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([{ module: 'APR', total: '2' }]);

    const result = await service.getTenantStorageExpungePlan('company-1');

    expect(result.dryRun).toBe(true);
    expect(result.eligibleKeys).toHaveLength(1);
    expect(result.eligibleKeys[0].id).toBe('eligible');
    expect(result.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'legal_hold' }),
      ]),
    );
  });
});
