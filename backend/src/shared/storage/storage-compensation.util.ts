import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

export function storageKeyFingerprint(fileKey: string): string {
  return createHash('sha256').update(fileKey).digest('hex').slice(0, 16);
}

export function isS3DisabledUploadError(error: unknown): boolean {
  return error instanceof Error && error.message === 'S3 is not enabled';
}

export type StorageCleanupCompensationResult = {
  attempted: boolean;
  cleaned: boolean;
  context: string;
  fileKey: string;
  errorMessage?: string;
};

export async function cleanupUploadedFile(
  logger: Logger,
  context: string,
  fileKey: string,
  deleteFile: (key: string) => Promise<void>,
): Promise<StorageCleanupCompensationResult> {
  try {
    await deleteFile(fileKey);
    logger.log({
      event: 'storage_cleanup_succeeded',
      context,
      keyFingerprint: storageKeyFingerprint(fileKey),
    });
    return {
      attempted: true,
      cleaned: true,
      context,
      fileKey,
    };
  } catch (cleanupError) {
    const errorMessage =
      cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
    logger.error(
      {
        event: 'storage_cleanup_failed',
        context,
        keyFingerprint: storageKeyFingerprint(fileKey),
        errorName:
          cleanupError instanceof Error ? cleanupError.name : 'unknown_error',
      },
      cleanupError instanceof Error ? cleanupError.stack : undefined,
    );
    return {
      attempted: true,
      cleaned: false,
      context,
      fileKey,
      errorMessage,
    };
  }
}
