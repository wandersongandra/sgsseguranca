import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentDownloadGrantService } from './document-download-grant.service';
import { DocumentStorageService } from './document-storage.service';
import { S3Service } from '../storage/s3.service';
import { TenantService } from '../tenant/tenant.service';
import {
  isAuthorizedStorageObjectReference,
  markAuthorizedStorageReference,
} from '../storage/storage-object-reference';
import type { StorageObjectReference } from '../storage/storage-object-reference';
import type { DataSource } from 'typeorm';

describe('DocumentStorageService — P1 storage boundary', () => {
  const tenantA = 'tenant-a';
  const tenantB = 'tenant-b';

  const build = (activeTenant: string, superAdmin = false) => {
    const provider = {
      uploadFile: jest.fn().mockResolvedValue('s3://object'),
      downloadFile: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      fileExists: jest.fn().mockResolvedValue(true),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      getSignedUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example/object'),
      getEmailLinkSignedUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example/email'),
      getPresignedUploadUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example/upload'),
      getInlineViewUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example/inline'),
      listKeys: jest.fn().mockResolvedValue(['documents/tenant-a/a.pdf']),
    };
    const tenantService = {
      getTenantId: jest.fn().mockReturnValue(activeTenant),
      isSuperAdmin: jest.fn().mockReturnValue(superAdmin),
    };
    const dataSource = {
      query: jest.fn().mockImplementation((sql: string, params: unknown[]) => {
        if (!sql.includes('FROM document_registry')) {
          return Promise.resolve([]);
        }
        const [tenantId, ownerType, ownerId, key] = params;
        const acceptedOwner =
          (ownerType === 'apr' && ownerId === 'resource-a') ||
          (ownerType === 'report' && ownerId === 'user-a');
        if (!acceptedOwner) return Promise.resolve([]);
        return Promise.resolve([
          {
            company_id: tenantId,
            file_key: key,
            module: ownerType,
            entity_id: ownerId,
            status: 'ACTIVE',
            deleted_at: null,
          },
        ]);
      }),
    } as unknown as DataSource;
    const service = new DocumentStorageService(
      {
        get: jest.fn((key: string) =>
          key === 'AWS_BUCKET_NAME' ? 'p1-test-bucket' : undefined,
        ),
      } as unknown as ConfigService,
      provider as unknown as S3Service,
      tenantService as unknown as TenantService,
      {} as DocumentDownloadGrantService,
      dataSource,
    );
    return { service, provider, tenantService };
  };

  const ref = (
    service: DocumentStorageService,
    tenantId: string,
    key: string,
    ownerId = 'resource-a',
  ): StorageObjectReference =>
    service.createReference({
      tenantId,
      key,
      owner: { resourceType: 'apr', resourceId: ownerId },
      purpose: 'p1-document-storage-downloadFileBuffer',
    });

  it('executa upload, download, delete e presign somente após referência tenant-scoped', async () => {
    const { service, provider } = build(tenantA);
    const object = ref(
      service,
      tenantA,
      'documents/tenant-a/apr/apr-a/file.pdf',
    );
    const quarantine = service.createReference({
      tenantId: tenantA,
      key: 'quarantine/tenant-a/550e8400-e29b-41d4-a716-446655440000.pdf',
      owner: {
        resourceType: 'upload',
        resourceId:
          'quarantine/tenant-a/550e8400-e29b-41d4-a716-446655440000.pdf',
      },
      purpose: 'storage-quarantine-upload',
    });

    await service.uploadFile(object, Buffer.from('pdf'), 'application/pdf');
    await service.downloadFileBuffer(object);
    await service.deleteFile(object);
    await service.getEmailLinkSignedUrl(object);
    await service.getPresignedUploadUrl(quarantine, 'application/pdf');

    expect(provider.uploadFile).toHaveBeenCalledWith(
      object.key,
      expect.any(Buffer),
      'application/pdf',
      undefined,
    );
    expect(provider.downloadFile).toHaveBeenCalledWith(object.key);
    expect(provider.deleteFile).toHaveBeenCalledWith(object.key);
    expect(provider.getEmailLinkSignedUrl).toHaveBeenCalledWith(
      object.key,
      14400,
    );
    expect(provider.getPresignedUploadUrl).toHaveBeenCalledWith(
      quarantine.key,
      'application/pdf',
      600,
    );
  });

  it('autoriza upload novo com owner/purpose bounded e devolve capability de cleanup', async () => {
    const { service, provider } = build(tenantA);
    const reference = service.createReference({
      tenantId: tenantA,
      key: 'documents/tenant-a/apr/new-apr/file.pdf',
      owner: { resourceType: 'apr', resourceId: 'new-apr' },
      purpose: 'p1-document-storage-uploadFile',
    });

    const authorized = await service.uploadFileWithCapability(
      reference,
      Buffer.from('pdf'),
      'application/pdf',
    );

    expect(provider.uploadFile).toHaveBeenCalledWith(
      reference.key,
      expect.any(Buffer),
      'application/pdf',
      undefined,
    );
    expect(isAuthorizedStorageObjectReference(authorized)).toBe(true);
  });

  it('bloqueia B→A antes de qualquer chamada ao provider em todas as operações sensíveis', async () => {
    const { service, provider } = build(tenantB);
    const foreign = ref(
      service,
      tenantA,
      'documents/tenant-a/apr/apr-a/file.pdf',
    );
    const destination = ref(
      service,
      tenantB,
      'documents/tenant-b/apr/apr-b/file.pdf',
    );

    await expect(service.downloadFileBuffer(foreign)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.deleteFile(foreign)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.getEmailLinkSignedUrl(foreign)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.replaceFile(
        foreign,
        Buffer.from('replacement'),
        'application/pdf',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.copyFile(foreign, destination, 'application/pdf'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.moveFile(foreign, destination, 'application/pdf'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.promoteFile(foreign, destination, 'application/pdf'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
    expect(provider.getEmailLinkSignedUrl).not.toHaveBeenCalled();
    expect(provider.uploadFile).not.toHaveBeenCalled();
  });

  it.each([
    '../documents/tenant-a/escape.pdf',
    '/absolute/tenant-a.pdf',
    'documents/tenant-a/nested/../escape.pdf',
    'documents//tenant-a/double-slash.pdf',
  ])('rejeita chave adulterada antes do provider: %s', async (key) => {
    const { service, provider } = build(tenantA);
    const object = ref(service, tenantA, key);

    await expect(service.downloadFileBuffer(object)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.deleteFile(object)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.uploadFile(object, Buffer.from('x'), 'application/pdf'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
    expect(provider.uploadFile).not.toHaveBeenCalled();
  });

  it('rejeita chave legada implícita e só permite legado quando a fonte persistida o resolve', async () => {
    const { service, provider } = build(tenantA);
    const legacy = service.createReference({
      tenantId: tenantA,
      key: 'reports/user-a/old-report.pdf',
      owner: { resourceType: 'report', resourceId: 'user-a' },
      purpose: 'p1-document-storage-downloadFileBuffer',
      legacy: true,
    });

    await expect(
      service.uploadFile(legacy, Buffer.from('new'), 'application/pdf'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await service.downloadFileBuffer(legacy);
    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(provider.downloadFile).toHaveBeenCalledWith(legacy.key);
  });

  it('não permite owner type forjado antes do provider', async () => {
    const { service, provider } = build(tenantA);
    const forged = service.createReference({
      tenantId: tenantA,
      key: 'documents/tenant-a/apr/apr-a/file.pdf',
      owner: { resourceType: 'wrong-owner-type', resourceId: 'resource-a' },
      purpose: 'p1-document-storage-downloadFileBuffer',
    });

    await expect(service.downloadFileBuffer(forged)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.deleteFile(forged)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.getSignedUrl(forged)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
    expect(provider.getSignedUrl).not.toHaveBeenCalled();
  });

  it('não permite owner id forjado antes do provider', async () => {
    const { service, provider } = build(tenantA);
    const forged = service.createReference({
      tenantId: tenantA,
      key: 'documents/tenant-a/apr/apr-a/file.pdf',
      owner: { resourceType: 'apr', resourceId: 'wrong-resource' },
      purpose: 'p1-document-storage-downloadFileBuffer',
    });

    await expect(service.downloadFileBuffer(forged)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.deleteFile(forged)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getSignedUrl(forged)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
    expect(provider.getSignedUrl).not.toHaveBeenCalled();
  });

  it('não permite destino de cópia sem vínculo persistido antes do provider', async () => {
    const { service, provider } = build(tenantA);
    const source = ref(
      service,
      tenantA,
      'documents/tenant-a/apr/apr-a/source.pdf',
    );
    const forgedDestination = service.createReference({
      tenantId: tenantA,
      key: 'documents/tenant-a/apr/apr-a/forged-destination.pdf',
      owner: { resourceType: 'apr', resourceId: 'wrong-resource' },
      purpose: 'p1-document-storage-copyFile',
    });

    await expect(
      service.copyFile(source, forgedDestination, 'application/pdf'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
  });

  it('não confia em marcação de capability criada fora do serviço', async () => {
    const { service, provider } = build(tenantA);
    const forged = markAuthorizedStorageReference(
      service.createReference({
        tenantId: tenantA,
        key: 'documents/tenant-a/apr/apr-a/file.pdf',
        owner: { resourceType: 'apr', resourceId: 'wrong-resource' },
        purpose: 'p1-document-storage-downloadFileBuffer',
      }),
    );

    expect(isAuthorizedStorageObjectReference(forged)).toBe(true);
    await expect(service.downloadFileBuffer(forged)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(provider.downloadFile).not.toHaveBeenCalled();
  });

  it('rejeita purpose fora do contrato antes do provider', async () => {
    const { service, provider } = build(tenantA);
    const forged = ref(
      service,
      tenantA,
      'documents/tenant-a/apr/apr-a/file.pdf',
    );
    const invalidPurpose = service.createReference({
      ...forged,
      purpose: 'wrong-purpose',
    });

    await expect(
      service.downloadFileBuffer(invalidPurpose),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(provider.downloadFile).not.toHaveBeenCalled();
  });

  it('separa enumeração global de infraestrutura e exige super-admin explícito', async () => {
    const regular = build(tenantA, false);
    await expect(
      regular.service.listKeysPrivileged(
        'documents',
        { resourceType: 'disaster-recovery', resourceId: 'scan' },
        'dr-orphan-scan',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const privileged = build(tenantA, true);
    await privileged.service.listKeysPrivileged(
      'documents',
      { resourceType: 'disaster-recovery', resourceId: 'scan' },
      'dr-orphan-scan',
    );
    expect(privileged.provider.listKeys).toHaveBeenCalledWith(
      'documents/',
      undefined,
    );
  });

  it('separa leitura física de DR e exige owner/purpose privilegiados', async () => {
    const regular = build(tenantA, false);
    await expect(
      regular.service.downloadFileBufferPrivileged({
        tenantId: tenantA,
        key: 'documents/tenant-a/apr/apr-a/file.pdf',
        owner: {
          resourceType: 'disaster-recovery',
          resourceId: 'integrity-scan',
        },
        purpose: 'disaster-recovery-integrity',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(regular.provider.downloadFile).not.toHaveBeenCalled();

    const privileged = build(tenantA, true);
    await privileged.service.downloadFileBufferPrivileged({
      tenantId: tenantA,
      key: 'documents/tenant-a/apr/apr-a/file.pdf',
      owner: {
        resourceType: 'disaster-recovery',
        resourceId: 'integrity-scan',
      },
      purpose: 'disaster-recovery-integrity',
    });
    await privileged.service.fileExistsPrivileged({
      tenantId: tenantA,
      key: 'documents/tenant-a/apr/apr-a/file.pdf',
      owner: {
        resourceType: 'disaster-recovery',
        resourceId: 'storage-replication',
      },
      purpose: 'disaster-recovery-replication',
    });
    expect(privileged.provider.downloadFile).toHaveBeenCalledWith(
      'documents/tenant-a/apr/apr-a/file.pdf',
    );
    expect(privileged.provider.fileExists).toHaveBeenCalledWith(
      'documents/tenant-a/apr/apr-a/file.pdf',
    );
  });
});
