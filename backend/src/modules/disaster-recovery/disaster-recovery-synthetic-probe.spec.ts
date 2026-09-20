import {
  SYNTHETIC_PROBE_PAYLOAD_BYTES,
  runSyntheticStorageProbe,
} from './disaster-recovery-synthetic-probe';

type UploadInput = {
  key: string;
  buffer: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
};

type StorageMock = {
  uploadBuffer: jest.Mock<Promise<void>, [UploadInput]>;
  downloadFileBuffer: jest.Mock<Promise<Buffer>, [string]>;
  deleteObject: jest.Mock<Promise<void>, [string]>;
};

const buildStorageMock = (): StorageMock => ({
  uploadBuffer: jest
    .fn<Promise<void>, [UploadInput]>()
    .mockResolvedValue(undefined),
  downloadFileBuffer: jest.fn<Promise<Buffer>, [string]>(),
  deleteObject: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
});

const getUploadedInput = (storage: StorageMock): UploadInput => {
  const upload = storage.uploadBuffer.mock.calls[0]?.[0];
  if (!upload) {
    throw new Error('Synthetic probe upload was not captured.');
  }
  return upload;
};

describe('runSyntheticStorageProbe', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('faz Put/Get/SHA-256/Delete usando somente payload sintético', async () => {
    const storage = buildStorageMock();
    storage.downloadFileBuffer.mockImplementation((key) => {
      const upload = getUploadedInput(storage);
      expect(key).toBe(upload.key);
      return Promise.resolve(upload.buffer);
    });

    const report = await runSyntheticStorageProbe(storage);
    const upload = getUploadedInput(storage);

    expect(report).toMatchObject({
      mode: 'synthetic-probe',
      upload: 'PASS',
      restore: 'PASS',
      sha256: 'PASS',
      cleanup: 'PASS',
      result: 'PASS',
    });
    expect(report.probeKey).toMatch(
      /^sgs-dr-probe\/[0-9a-f-]{36}\/probe\.bin$/,
    );
    expect(upload.key).toBe(report.probeKey);
    expect(upload.buffer).toBeInstanceOf(Buffer);
    expect(upload.buffer.byteLength).toBe(SYNTHETIC_PROBE_PAYLOAD_BYTES);
    expect(upload.metadata).toEqual({ 'dr-probe': 'synthetic' });
    expect(storage.downloadFileBuffer).toHaveBeenCalledWith(report.probeKey);
    expect(storage.deleteObject).toHaveBeenCalledWith(report.probeKey);
  });

  it('falha por mismatch de SHA-256 e ainda limpa o objeto', async () => {
    const storage = buildStorageMock();
    storage.downloadFileBuffer.mockResolvedValue(Buffer.from('different'));

    await expect(runSyntheticStorageProbe(storage)).rejects.toThrow(
      'SHA-256 mismatch',
    );

    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('falha no upload sem tentar leitura ou exclusão', async () => {
    const storage = buildStorageMock();
    storage.uploadBuffer.mockRejectedValue(new Error('upload failed'));

    await expect(runSyntheticStorageProbe(storage)).rejects.toThrow(
      'upload failed',
    );

    expect(storage.downloadFileBuffer).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('falha na leitura e limpa depois de upload confirmado', async () => {
    const storage = buildStorageMock();
    storage.downloadFileBuffer.mockRejectedValue(new Error('restore failed'));

    await expect(runSyntheticStorageProbe(storage)).rejects.toThrow(
      'restore failed',
    );

    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('propaga falha de exclusão como falha do probe', async () => {
    const storage = buildStorageMock();
    storage.downloadFileBuffer.mockImplementation(() => {
      const upload = getUploadedInput(storage);
      return Promise.resolve(upload.buffer);
    });
    storage.deleteObject.mockRejectedValue(new Error('delete failed'));

    await expect(runSyntheticStorageProbe(storage)).rejects.toThrow(
      'delete failed',
    );
  });
});
