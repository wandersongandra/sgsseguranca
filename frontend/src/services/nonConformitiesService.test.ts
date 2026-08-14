import api from '@/lib/api';
import {
  nonConformitiesService,
  NcStatus,
  parseGovernedNcAttachmentReference,
} from './nonConformitiesService';

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const mockedApi = api as jest.Mocked<typeof api>;

describe('nonConformitiesService offline action policy', () => {
  const originalOnLine = navigator.onLine;

  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: originalOnLine });
    jest.clearAllMocks();
  });

  it('blocks every NC mutation offline without pretending to queue it', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });

    await expect(nonConformitiesService.create({ codigo_nc: 'NC-1' })).rejects.toMatchObject({
      code: 'ERR_OFFLINE_ACTION_UNAVAILABLE',
      action: 'create',
    });
    await expect(nonConformitiesService.update('nc-1', { codigo_nc: 'NC-1' })).rejects.toMatchObject({
      code: 'ERR_OFFLINE_ACTION_UNAVAILABLE',
      action: 'update',
    });
    await expect(nonConformitiesService.generateFinalPdf('nc-1')).rejects.toMatchObject({
      code: 'ERR_OFFLINE_ACTION_UNAVAILABLE',
      action: 'generate-pdf',
    });
    const evidence = new File(['evidence'], 'evidence.jpg', { type: 'image/jpeg' });
    await expect(nonConformitiesService.attachAttachment('nc-1', evidence)).rejects.toMatchObject({
      code: 'ERR_OFFLINE_ACTION_UNAVAILABLE',
      action: 'upload',
    });
    await expect(nonConformitiesService.removeAttachment('nc-1', 0)).rejects.toMatchObject({
      code: 'ERR_OFFLINE_ACTION_UNAVAILABLE',
      action: 'remove',
    });
    await expect(nonConformitiesService.updateStatus('nc-1', NcStatus.EM_ANDAMENTO)).rejects.toMatchObject({
      code: 'ERR_OFFLINE_ACTION_UNAVAILABLE',
      action: 'update-status',
    });
    await expect(nonConformitiesService.remove('nc-1')).rejects.toMatchObject({
      code: 'ERR_OFFLINE_ACTION_UNAVAILABLE',
      action: 'remove',
    });
    expect(mockedApi.patch).not.toHaveBeenCalled();
    expect(mockedApi.delete).not.toHaveBeenCalled();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });
});

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

describe('parseGovernedNcAttachmentReference', () => {
  it('preserva nomes de arquivos UTF-8 na referência governada', () => {
    const payload = {
      v: 1,
      kind: 'governed-storage' as const,
      fileKey: 'documents/company-1/nonconformity-attachments/nc-1/evidencia.jpg',
      originalName: 'Evidência – inspeção nº 1.jpg',
      mimeType: 'image/jpeg',
      uploadedAt: '2026-08-03T13:00:00.000Z',
      sizeBytes: 2048,
    };
    const reference = `gst:nc-attachment:${encodeBase64Url(JSON.stringify(payload))}`;

    expect(parseGovernedNcAttachmentReference(reference)).toEqual(payload);
  });
});

describe('nonConformitiesService attachment removal', () => {
  const originalOnLine = navigator.onLine;

  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: originalOnLine });
    jest.clearAllMocks();
  });

  it('uses the governed immediate-removal endpoint when online', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    const response = {
      entityId: 'nc-1',
      attachments: [],
      attachmentCount: 0,
      removedAttachmentReference: 'gst:nc-attachment:reference',
      storageCleanup: 'removed' as const,
      message: 'Anexo removido da não conformidade e do storage oficial.',
    };
    mockedApi.delete.mockResolvedValue({ data: response });

    await expect(nonConformitiesService.removeAttachment('nc-1', 2)).resolves.toEqual(
      response,
    );
    expect(mockedApi.delete).toHaveBeenCalledWith('/nonconformities/nc-1/attachments/2');
  });
});
