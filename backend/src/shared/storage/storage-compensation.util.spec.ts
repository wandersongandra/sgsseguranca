import { Logger } from '@nestjs/common';
import { cleanupUploadedFile } from './storage-compensation.util';

describe('storage-compensation.util', () => {
  let logger: Logger;
  let logMock: jest.Mock;
  let warnMock: jest.Mock;
  let errorMock: jest.Mock;

  beforeEach(() => {
    logMock = jest.fn();
    warnMock = jest.fn();
    errorMock = jest.fn();
    logger = {
      log: logMock,
      warn: warnMock,
      error: errorMock,
    } as unknown as Logger;
  });

  it('logs and returns a successful cleanup result', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);

    const result = await cleanupUploadedFile(
      logger,
      'apr:123',
      'documents/company/apr.pdf',
      deleteFile,
    );

    expect(deleteFile).toHaveBeenCalledWith('documents/company/apr.pdf');
    expect(result).toEqual({
      attempted: true,
      cleaned: true,
      context: 'apr:123',
      fileKey: 'documents/company/apr.pdf',
    });
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'storage_cleanup_succeeded',
        context: 'apr:123',
      }),
    );
  });

  it('logs and returns a failed cleanup result', async () => {
    const deleteFile = jest
      .fn()
      .mockRejectedValue(new Error('storage delete failed'));

    const result = await cleanupUploadedFile(
      logger,
      'rdo:456',
      'documents/company/rdo.pdf',
      deleteFile,
    );

    expect(result).toEqual({
      attempted: true,
      cleaned: false,
      context: 'rdo:456',
      fileKey: 'documents/company/rdo.pdf',
      errorMessage: 'storage delete failed',
    });
    expect(errorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'storage_cleanup_failed',
        context: 'rdo:456',
        errorName: 'Error',
      }),
      expect.any(String),
    );
  });
});
