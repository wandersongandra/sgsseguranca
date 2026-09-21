jest.mock('../../../scripts/disaster-recovery/common', () => {
  const actual = jest.requireActual<
    typeof import('../../../scripts/disaster-recovery/common')
  >('../../../scripts/disaster-recovery/common');

  return {
    ...actual,
    appendAuditLog: jest.fn().mockResolvedValue(undefined),
    createStandaloneReplicaStorageService: jest.fn(),
    withNestAppContext: jest.fn(),
  };
});

import { main, runCli } from '../../../scripts/dr-protect-storage';
import * as common from '../../../scripts/disaster-recovery/common';

type UploadInput = {
  key: string;
  buffer: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
};

type CliStorageMock = {
  uploadBuffer: jest.Mock<Promise<void>, [UploadInput]>;
  downloadFileBuffer: jest.Mock<Promise<Buffer>, [string]>;
  deleteObject: jest.Mock<Promise<void>, [string]>;
};

const buildStorageMock = (): CliStorageMock => ({
  uploadBuffer: jest
    .fn<Promise<void>, [UploadInput]>()
    .mockResolvedValue(undefined),
  downloadFileBuffer: jest.fn<Promise<Buffer>, [string]>(),
  deleteObject: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
});

const getUploadedInput = (storage: CliStorageMock): UploadInput => {
  const upload = storage.uploadBuffer.mock.calls[0]?.[0];
  if (!upload) {
    throw new Error('Synthetic probe upload was not captured.');
  }
  return upload;
};

describe('dr-protect-storage synthetic CLI mode', () => {
  const createStandaloneReplicaStorageService =
    common.createStandaloneReplicaStorageService as jest.Mock;
  const withNestAppContext = common.withNestAppContext as jest.Mock;
  const appendAuditLog = common.appendAuditLog as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('não inicializa Nest/DB nem chama o fluxo de artefatos governados', async () => {
    const storage = buildStorageMock();
    storage.downloadFileBuffer.mockImplementation(() => {
      const upload = getUploadedInput(storage);
      return Promise.resolve(upload.buffer);
    });
    createStandaloneReplicaStorageService.mockReturnValue(storage);

    await main(['--execute', '--synthetic-probe']);

    expect(withNestAppContext).not.toHaveBeenCalled();
    expect(storage.uploadBuffer).toHaveBeenCalledTimes(1);
    expect(storage.downloadFileBuffer).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('mapeia falha do probe para código não zero', async () => {
    const storage = buildStorageMock();
    storage.uploadBuffer.mockRejectedValue(new Error('upload failed'));
    createStandaloneReplicaStorageService.mockReturnValue(storage);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();

    await expect(runCli(['--execute', '--synthetic-probe'])).resolves.toBe(1);

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[DR][STORAGE] Falha:',
      'upload failed',
    );
    expect(storage.downloadFileBuffer).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
