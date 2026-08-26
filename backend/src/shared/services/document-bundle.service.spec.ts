import { ServiceUnavailableException } from '@nestjs/common';
import { DocumentBundleService } from './document-bundle.service';
import type { DocumentStorageService } from './document-storage.service';
import type { StorageObjectOwner } from '../storage/storage-object-reference';

describe('DocumentBundleService', () => {
  it('propaga indisponibilidade de storage quando nenhum pdf pode ser baixado', async () => {
    const documentStorageService: Pick<
      DocumentStorageService,
      'referenceForExistingObject' | 'downloadFileBuffer'
    > = {
      referenceForExistingObject: jest.fn(
        (key: string, owner: StorageObjectOwner, purpose: string) => ({
          tenantId: 'company-1',
          key,
          owner,
          purpose,
          legacy: !key.startsWith('documents/company-1/'),
        }),
      ),
      downloadFileBuffer: jest.fn().mockRejectedValue(
        new ServiceUnavailableException({
          error: 'DOCUMENT_STORAGE_UNAVAILABLE',
          message: 'Storage indisponível',
        }),
      ),
    };
    const service = new DocumentBundleService(
      documentStorageService as unknown as DocumentStorageService,
    );

    await expect(
      service.buildWeeklyPdfBundle('APR', { year: 2026, week: 12 }, [
        {
          fileKey: 'documents/company/apr/final.pdf',
          resourceType: 'apr',
          resourceId: 'apr-1',
          title: 'APR final',
        },
      ]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
