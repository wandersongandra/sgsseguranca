import { BadRequestException } from '@nestjs/common';
import { diskStorage } from 'multer';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { mkdirSync } from 'fs';
import { open, readFile, realpath, readdir, stat, unlink } from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { resolveSgsTempDirectory } from '../temp-directory.util';
import { detectMimeFromMagicBytes } from '../utils/detect-mime.util';

const TEMP_UPLOAD_DIR = resolveSgsTempDirectory();
const TEMP_UPLOAD_CLEANUP_TTL_MS = resolvePositiveIntEnv(
  'TEMP_UPLOAD_CLEANUP_TTL_MS',
  24 * 60 * 60 * 1000,
);
const TEMP_UPLOAD_CLEANUP_MIN_INTERVAL_MS = resolvePositiveIntEnv(
  'TEMP_UPLOAD_CLEANUP_MIN_INTERVAL_MS',
  15 * 60 * 1000,
);
const GOVERNED_PDF_MAX_FILE_SIZE_BYTES = resolvePositiveIntEnv(
  'GOVERNED_PDF_MAX_FILE_SIZE_BYTES',
  50 * 1024 * 1024,
);

let tempUploadCleanupInFlight: Promise<TempUploadCleanupSummary> | null = null;
let lastTempUploadCleanupAt = 0;

type UploadLogger = {
  log?: (message: unknown) => void;
  warn: (message: unknown) => void;
  error?: (message: unknown, trace?: string) => void;
};

export type FileInspectionServiceLike = {
  inspect(buffer: Buffer, filename: string): Promise<unknown>;
};

export type TempUploadCleanupSummary = {
  directory: string;
  scannedFiles: number;
  removedFiles: number;
  failedFiles: number;
  ttlMs: number;
  cutoffTimestamp: string;
};

function resolvePositiveIntEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function prepareTempUploadDir(): string {
  mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
  return TEMP_UPLOAD_DIR;
}

function ensureTempUploadDir(): string {
  const directory = prepareTempUploadDir();
  void runTempUploadCleanupBestEffort();
  return directory;
}

function sanitizeExtension(originalName?: string): string {
  const extension = path.extname(String(originalName || '')).toLowerCase();
  return extension.replace(/[^a-z0-9._-]/g, '').slice(0, 12);
}

function createTempFilename(originalName?: string): string {
  const extension = sanitizeExtension(originalName);
  return `${Date.now()}-${randomUUID()}${extension}`;
}

function resolvePathInsideDirectory(
  baseDirectory: string,
  candidatePath: string,
): string {
  const resolvedBase = path.resolve(baseDirectory);
  const resolvedCandidate = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(resolvedBase, candidatePath);
  const relativePath = path.relative(resolvedBase, resolvedCandidate);
  const isInside =
    relativePath.length === 0 ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));

  if (!isInside) {
    throw new BadRequestException('Caminho de arquivo temporário inválido.');
  }

  return resolvedCandidate;
}

function resolveTempUploadPath(candidatePath: string): string {
  return resolvePathInsideDirectory(TEMP_UPLOAD_DIR, candidatePath);
}

function isCompatibleDetectedMime(
  detectedMime: string,
  allowedMimes: string[],
): boolean {
  if (allowedMimes.includes(detectedMime)) {
    return true;
  }

  if (
    detectedMime === 'application/zip' &&
    (allowedMimes.includes(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ) ||
      allowedMimes.includes(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ))
  ) {
    return true;
  }

  if (
    detectedMime === 'application/x-cfb' &&
    (allowedMimes.includes('application/vnd.ms-excel') ||
      allowedMimes.includes('application/msword'))
  ) {
    return true;
  }

  return false;
}

export function createTemporaryUploadOptions(options?: {
  maxFileSize?: number;
  maxFiles?: number;
  fileFilter?: MulterOptions['fileFilter'];
}): MulterOptions {
  return {
    storage: diskStorage({
      destination: (_req, _file, cb) => cb(null, ensureTempUploadDir()),
      filename: (_req, file, cb) =>
        cb(null, createTempFilename(file.originalname)),
    }),
    fileFilter:
      options?.fileFilter ||
      ((_req, _file, cb) => {
        cb(null, true);
      }),
    limits: {
      fileSize: options?.maxFileSize ?? 10 * 1024 * 1024,
      files: options?.maxFiles ?? 1,
      fields: 20,
      parts: (options?.maxFiles ?? 1) + 24,
      fieldNameSize: 200,
      fieldSize: 100 * 1024,
    },
  };
}

export const fileUploadOptions: MulterOptions = createTemporaryUploadOptions();

export function validateFileMagicBytes(
  buffer: Buffer,
  allowedMimes: string[] = ['application/pdf', 'image/jpeg', 'image/png'],
): void {
  const sample = buffer.slice(0, 4100);
  const detectedMime = detectMimeFromMagicBytes(sample);
  if (!detectedMime || !isCompatibleDetectedMime(detectedMime, allowedMimes)) {
    throw new BadRequestException('Tipo de arquivo não permitido');
  }
}

export function validatePdfMagicBytes(buffer: Buffer): void {
  return validateFileMagicBytes(buffer, ['application/pdf']);
}

export function validateVideoMagicBytes(buffer: Buffer): void {
  return validateFileMagicBytes(buffer, [
    'video/mp4',
    'video/webm',
    'video/quicktime',
  ]);
}

export async function inspectUploadedFileBuffer(
  buffer: Buffer,
  file: Pick<Express.Multer.File, 'originalname'>,
  fileInspectionService?: FileInspectionServiceLike,
): Promise<void> {
  if (!fileInspectionService) {
    return;
  }

  await fileInspectionService.inspect(
    buffer,
    file.originalname || 'uploaded-file',
  );
}

export function createGovernedPdfUploadOptions(
  maxFileSize = GOVERNED_PDF_MAX_FILE_SIZE_BYTES,
): MulterOptions {
  return createTemporaryUploadOptions({
    maxFileSize,
    fileFilter: (_req, file, cb) => {
      const mimeType = String(file.mimetype || '').toLowerCase();
      const isAcceptedMime =
        mimeType === 'application/pdf' ||
        mimeType === 'application/octet-stream' ||
        mimeType.length === 0;

      if (!isAcceptedMime) {
        return cb(null, false);
      }

      cb(null, true);
    },
  });
}

export function createGovernedVideoUploadOptions(
  maxFileSize = 75 * 1024 * 1024,
): MulterOptions {
  return createTemporaryUploadOptions({
    maxFileSize,
    fileFilter: (_req, file, cb) => {
      const allowed = [
        'video/mp4',
        'video/webm',
        'video/quicktime',
        'video/x-m4v',
      ];

      if (!allowed.includes(file.mimetype)) {
        return cb(null, false);
      }

      cb(null, true);
    },
  });
}

export async function readUploadedFileBuffer(
  file: Express.Multer.File | undefined,
  missingFileMessage = 'Nenhum arquivo enviado',
): Promise<Buffer> {
  if (!file) {
    throw new BadRequestException(missingFileMessage);
  }

  if (file.buffer && file.buffer.length > 0) {
    return file.buffer;
  }

  if (file.path) {
    // lgtm[js/path-injection]
    const filePath = resolveTempUploadPath(file.path);
    const buffer = await readFile(filePath);
    if (buffer.length === 0) {
      throw new BadRequestException('Falha ao ler o arquivo enviado.');
    }

    file.buffer = buffer;
    return buffer;
  }

  throw new BadRequestException('Falha ao ler o arquivo enviado.');
}

export async function assertUploadedPdf(
  file: Express.Multer.File | undefined,
  missingFileMessage = 'Nenhum arquivo enviado',
  fileInspectionService?: FileInspectionServiceLike,
): Promise<Express.Multer.File> {
  if (!file) {
    throw new BadRequestException(missingFileMessage);
  }

  // Prioritize magic bytes + FileInspection before any mime/extension trust
  const buffer = await readUploadedFileBuffer(file, missingFileMessage);
  validatePdfMagicBytes(buffer);
  await inspectUploadedFileBuffer(buffer, file, fileInspectionService);
  return file;
}

export async function assertUploadedVideo(
  file: Express.Multer.File | undefined,
  missingFileMessage = 'Nenhum arquivo enviado',
  fileInspectionService?: FileInspectionServiceLike,
): Promise<Express.Multer.File> {
  if (!file) {
    throw new BadRequestException(missingFileMessage);
  }

  // Prioritize magic bytes + FileInspection before any mime/extension trust
  const buffer = await readUploadedFileBuffer(file, missingFileMessage);
  validateVideoMagicBytes(buffer);
  await inspectUploadedFileBuffer(buffer, file, fileInspectionService);
  return file;
}

export async function cleanupUploadedTempFile(
  file: Express.Multer.File | undefined,
  logger?: UploadLogger,
): Promise<void> {
  if (!file?.path) {
    return;
  }

  // lgtm[js/path-injection]
  const filePath = resolveTempUploadPath(file.path);
  await unlink(filePath).catch((error) => {
    logger?.warn(
      `Falha ao remover arquivo temporário ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

export async function cleanupStaleTempUploads(options?: {
  directory?: string;
  ttlMs?: number;
  now?: number;
  logger?: UploadLogger;
}): Promise<TempUploadCleanupSummary> {
  const directory = options?.directory
    ? resolvePathInsideDirectory(TEMP_UPLOAD_DIR, options.directory)
    : prepareTempUploadDir();
  const resolvedDirectory = await realpath(directory);
  const ttlMs = options?.ttlMs ?? TEMP_UPLOAD_CLEANUP_TTL_MS;
  const now = options?.now ?? Date.now();
  const logger = options?.logger;
  const cutoff = now - ttlMs;
  const entries = await readdir(resolvedDirectory, { withFileTypes: true });

  let scannedFiles = 0;
  let removedFiles = 0;
  let failedFiles = 0;

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    scannedFiles += 1;
    const safeName = path.basename(entry.name);
    if (
      safeName !== entry.name ||
      entry.name.includes('/') ||
      entry.name.includes('\\')
    ) {
      failedFiles += 1;
      logger?.warn({
        event: 'temp_upload_cleanup_skipped_unsafe_path',
        fileName: entry.name,
      });
      continue;
    }
    const filePath = resolvePathInsideDirectory(
      resolvedDirectory,
      path.join(resolvedDirectory, safeName),
    );

    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs > cutoff) {
        continue;
      }

      await unlink(filePath);
      removedFiles += 1;
    } catch (error) {
      failedFiles += 1;
      logger?.warn({
        event: 'temp_upload_cleanup_failed_file',
        filePath,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary: TempUploadCleanupSummary = {
    directory: resolvedDirectory,
    scannedFiles,
    removedFiles,
    failedFiles,
    ttlMs,
    cutoffTimestamp: new Date(cutoff).toISOString(),
  };

  logger?.log?.({
    event: 'temp_upload_cleanup_completed',
    ...summary,
  });

  return summary;
}

export async function runTempUploadCleanupBestEffort(
  logger?: UploadLogger,
): Promise<TempUploadCleanupSummary | null> {
  const now = Date.now();
  if (
    tempUploadCleanupInFlight ||
    now - lastTempUploadCleanupAt < TEMP_UPLOAD_CLEANUP_MIN_INTERVAL_MS
  ) {
    return tempUploadCleanupInFlight
      ? tempUploadCleanupInFlight.catch(() => null)
      : null;
  }

  lastTempUploadCleanupAt = now;
  tempUploadCleanupInFlight = cleanupStaleTempUploads({ logger }).finally(
    () => {
      tempUploadCleanupInFlight = null;
    },
  );

  try {
    return await tempUploadCleanupInFlight;
  } catch (error) {
    logger?.error?.(
      {
        event: 'temp_upload_cleanup_failed',
        directory: TEMP_UPLOAD_DIR,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      error instanceof Error ? error.stack : undefined,
    );
    return null;
  }
}

export function resetTempUploadCleanupStateForTests(): void {
  tempUploadCleanupInFlight = null;
  lastTempUploadCleanupAt = 0;
}

export async function validatePdfMagicBytesFromPath(
  filePath: string,
  fileInspectionService?: FileInspectionServiceLike,
  filename = path.basename(filePath),
) {
  // lgtm[js/path-injection]
  const resolvedFilePath = resolveTempUploadPath(filePath);
  const safeFilename = path.basename(filename);
  const handle = await open(resolvedFilePath, 'r');
  try {
    const sample = Buffer.alloc(4100);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    validatePdfMagicBytes(sample.slice(0, bytesRead));
  } finally {
    await handle.close().catch(() => undefined);
  }

  if (fileInspectionService) {
    // lgtm[js/path-injection]
    await fileInspectionService.inspect(
      await readFile(resolvedFilePath),
      safeFilename,
    );
  }
}
