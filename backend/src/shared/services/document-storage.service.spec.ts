import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DocumentDownloadGrantService } from './document-download-grant.service';
import { DocumentStorageService } from './document-storage.service';
import type { S3Service } from '../storage/s3.service';
import type { TenantService } from '../tenant/tenant.service';
import type { DataSource } from 'typeorm';

describe('DocumentStorageService', () => {
  const tenantId = 'company-1';
  const reference = (service: DocumentStorageService, key: string) =>
    service.createReference({
      tenantId,
      key,
      owner: { resourceType: 'apr', resourceId: key },
      purpose: 'p1-document-storage-downloadFileBuffer',
    });

  const createDataSource = (): DataSource =>
    ({
      query: jest.fn().mockImplementation((sql: string, params: unknown[]) => {
        if (sql.includes('FROM document_registry')) {
          return Promise.resolve([
            {
              company_id: params[0],
              file_key: params[3],
              module: params[1],
              entity_id: params[2],
              status: 'ACTIVE',
              deleted_at: null,
            },
          ]);
        }
        return Promise.resolve([
          { tenant_id: params[0], storage_key: params[2] },
        ]);
      }),
    }) as unknown as DataSource;

  const createConfigService = (
    values: Record<string, string | undefined> = {},
  ): ConfigService =>
    ({
      get: jest.fn((key: string, defaultValue?: string) => {
        const value = values[key];
        return value === undefined ? defaultValue : value;
      }),
    }) as unknown as ConfigService;

  it('gera chave documental com subpasta de escopo sem quebrar o prefixo do tenant', () => {
    const service = new DocumentStorageService(
      createConfigService(),
      {} as S3Service,
      {
        getTenantId: jest.fn().mockReturnValue(tenantId),
      } as unknown as TenantService,
      {} as DocumentDownloadGrantService,
    );

    const key = service.generateDocumentKey(
      'company-1',
      'dds',
      'dds-1',
      'DDS Final.pdf',
      { folderSegments: ['sites', 'site-1'] },
    );

    expect(key).toMatch(
      /^documents\/company-1\/dds\/sites\/site-1\/dds-1\/\d+-DDS_Final\.pdf$/,
    );
  });

  it('falha de forma explícita quando nenhum storage documental está configurado', async () => {
    const service = new DocumentStorageService(
      createConfigService(),
      {} as S3Service,
      {
        getTenantId: jest.fn().mockReturnValue(tenantId),
      } as unknown as TenantService,
      {} as DocumentDownloadGrantService,
    );

    await expect(
      service.uploadFile(
        reference(service, 'documents/company-1/documents/doc.pdf'),
        Buffer.from('%PDF-test'),
        'application/pdf',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('usa o S3Service quando AWS_BUCKET_NAME está configurado (managed ou legacy)', async () => {
    const uploadFile = jest.fn().mockResolvedValue('url');
    const service = new DocumentStorageService(
      createConfigService({ AWS_BUCKET_NAME: 'managed-bucket' }),
      {
        uploadFile,
      } as unknown as S3Service,
      {
        getTenantId: jest.fn().mockReturnValue(tenantId),
      } as unknown as TenantService,
      {} as DocumentDownloadGrantService,
    );

    await service.uploadFile(
      reference(service, 'documents/company-1/video/video.mp4'),
      Buffer.from('video'),
      'video/mp4',
    );

    expect(uploadFile).toHaveBeenCalledWith(
      'documents/company-1/video/video.mp4',
      Buffer.from('video'),
      'video/mp4',
      undefined,
    );
  });

  it('usa o S3Service quando AWS_S3_BUCKET está configurado (legacy)', async () => {
    const uploadFile = jest.fn().mockResolvedValue('url');
    const service = new DocumentStorageService(
      createConfigService({ AWS_S3_BUCKET: 'legacy-bucket' }),
      {
        uploadFile,
      } as unknown as S3Service,
      {
        getTenantId: jest.fn().mockReturnValue(tenantId),
      } as unknown as TenantService,
      {} as DocumentDownloadGrantService,
    );

    await service.uploadFile(
      reference(service, 'documents/company-1/video/video.mp4'),
      Buffer.from('video'),
      'video/mp4',
    );

    expect(uploadFile).toHaveBeenCalledWith(
      'documents/company-1/video/video.mp4',
      Buffer.from('video'),
      'video/mp4',
      undefined,
    );
  });

  it('traduz falha de download por arquivo ausente em NotFoundException honesta', async () => {
    const service = new DocumentStorageService(
      createConfigService({ AWS_BUCKET_NAME: 'managed-bucket' }),
      {
        downloadFile: jest
          .fn()
          .mockRejectedValue(new Error('Not found in bucket')),
      } as unknown as S3Service,
      {
        getTenantId: jest.fn().mockReturnValue(tenantId),
      } as unknown as TenantService,
      {} as DocumentDownloadGrantService,
      createDataSource(),
    );

    await expect(
      service.downloadFileBuffer(
        reference(service, 'documents/company-1/apr/doc.pdf'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('traduz falha de presign em indisponibilidade do storage governado', async () => {
    const service = new DocumentStorageService(
      createConfigService({ AWS_BUCKET_NAME: 'managed-bucket' }),
      {} as S3Service,
      {
        getTenantId: jest.fn().mockReturnValue(tenantId),
      } as unknown as TenantService,
      {
        issueRestrictedAppDownloadUrl: jest
          .fn()
          .mockRejectedValue(new Error('socket timeout')),
      } as unknown as DocumentDownloadGrantService,
      createDataSource(),
    );

    await expect(
      service.getSignedUrl(
        reference(service, 'documents/company-1/apr/doc.pdf'),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('usa rota restrita com TTL interno padrão de 900s para PDFs do app', async () => {
    const issueRestrictedAppDownloadUrl = jest
      .fn<
        Promise<string>,
        [
          Parameters<
            DocumentDownloadGrantService['issueRestrictedAppDownloadUrl']
          >[0],
        ]
      >()
      .mockResolvedValue('/storage/download/token');
    const service = new DocumentStorageService(
      createConfigService({ AWS_BUCKET_NAME: 'managed-bucket' }),
      {} as S3Service,
      {
        getTenantId: jest.fn().mockReturnValue(tenantId),
      } as unknown as TenantService,
      {
        issueRestrictedAppDownloadUrl,
      } as unknown as DocumentDownloadGrantService,
      createDataSource(),
    );

    await service.getSignedUrl(
      reference(service, 'documents/company-1/apr/doc.pdf'),
    );

    expect(issueRestrictedAppDownloadUrl.mock.calls[0]?.[0]).toMatchObject({
      reference: {
        tenantId,
        key: 'documents/company-1/apr/doc.pdf',
        owner: {
          resourceType: 'apr',
          resourceId: 'documents/company-1/apr/doc.pdf',
        },
        purpose: 'document-registry:apr:pdf',
      },
      originalName: 'doc.pdf',
      expiresIn: 900,
    });
  });

  it('aceita somente finalidades document-registry de PDF para objetos registrados', async () => {
    const issueRestrictedAppDownloadUrl = jest
      .fn()
      .mockResolvedValue('/storage/download/token');
    const service = new DocumentStorageService(
      createConfigService({ AWS_BUCKET_NAME: 'managed-bucket' }),
      {} as S3Service,
      {
        getTenantId: jest.fn().mockReturnValue(tenantId),
      } as unknown as TenantService,
      {
        issueRestrictedAppDownloadUrl,
      } as unknown as DocumentDownloadGrantService,
      createDataSource(),
    );

    await expect(
      service.getSignedUrl(
        service.createReference({
          tenantId,
          key: 'documents/company-1/reports/report-1/report.pdf',
          owner: { resourceType: 'report', resourceId: 'report-1' },
          purpose: 'document-registry:report:pdf',
        }),
      ),
    ).resolves.toBe('/storage/download/token');

    expect(issueRestrictedAppDownloadUrl).toHaveBeenCalled();
  });

  it('permite TTL explícito de até 4h apenas via fluxo de e-mail', async () => {
    const getEmailLinkSignedUrl = jest.fn().mockResolvedValue('signed-url');
    const service = new DocumentStorageService(
      createConfigService({ AWS_BUCKET_NAME: 'managed-bucket' }),
      { getEmailLinkSignedUrl } as unknown as S3Service,
      {
        getTenantId: jest.fn().mockReturnValue(tenantId),
      } as unknown as TenantService,
      {} as DocumentDownloadGrantService,
      createDataSource(),
    );

    await service.getEmailLinkSignedUrl(
      reference(service, 'documents/company-1/apr/doc.pdf'),
    );

    expect(getEmailLinkSignedUrl).toHaveBeenCalledWith(
      'documents/company-1/apr/doc.pdf',
      14400,
    );
  });

  it('mantém presign direto para artefatos não-PDF', async () => {
    const getSignedUrl = jest.fn().mockResolvedValue('signed-url');
    const issueRestrictedAppDownloadUrl = jest.fn();
    const service = new DocumentStorageService(
      createConfigService({ AWS_BUCKET_NAME: 'managed-bucket' }),
      { getSignedUrl } as unknown as S3Service,
      {
        getTenantId: jest.fn().mockReturnValue(tenantId),
      } as unknown as TenantService,
      {
        issueRestrictedAppDownloadUrl,
      } as unknown as DocumentDownloadGrantService,
      createDataSource(),
    );

    await service.getSignedUrl(
      reference(service, 'documents/company-1/evidence/video.mp4'),
    );

    expect(getSignedUrl).toHaveBeenCalledWith(
      'documents/company-1/evidence/video.mp4',
      900,
    );
    expect(issueRestrictedAppDownloadUrl).not.toHaveBeenCalled();
  });
});
