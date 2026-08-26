import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { IntegrationResilienceService } from '../resilience/integration-resilience.service';
import {
  EMAIL_LINK_DOWNLOAD_TTL_SECONDS,
  INTERNAL_DOWNLOAD_TTL_SECONDS,
  normalizeEmailLinkDownloadTtl,
  normalizeInternalDownloadTtl,
} from './storage-download-ttl';

const getErrorStack = (error: unknown): string | undefined =>
  error instanceof Error ? error.stack : undefined;

const storageKeyFingerprint = (key: string): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 16);

const hasAsyncIterator = (value: unknown): value is AsyncIterable<unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const asyncIterableCandidate = value as {
    [Symbol.asyncIterator]?: unknown;
  };
  const asyncIterator = asyncIterableCandidate[Symbol.asyncIterator];
  return typeof asyncIterator === 'function';
};

const toBufferChunk = (chunk: unknown): Buffer => {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }

  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }

  throw new Error('Chunk inválido recebido do stream S3.');
};

@Injectable()
export class S3Service implements OnModuleDestroy {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly region: string;
  private readonly useS3: boolean;

  constructor(
    private configService: ConfigService,
    private readonly integration: IntegrationResilienceService,
  ) {
    this.bucketName =
      this.configService.get<string>('AWS_BUCKET_NAME') ||
      this.configService.get<string>('AWS_S3_BUCKET') ||
      '';
    this.region = this.configService.get<string>('AWS_REGION', 'us-east-1');
    const endpoint =
      this.configService.get<string>('AWS_ENDPOINT') ||
      this.configService.get<string>('AWS_S3_ENDPOINT');
    const forcePathStyle = /^true$/i.test(
      this.configService.get<string>('S3_FORCE_PATH_STYLE', ''),
    );
    this.useS3 = Boolean(this.bucketName);

    if (this.useS3) {
      this.s3Client = new S3Client({
        region: this.region,
        endpoint,
        credentials: {
          accessKeyId:
            this.configService.get<string>('AWS_ACCESS_KEY_ID') || '',
          secretAccessKey:
            this.configService.get<string>('AWS_SECRET_ACCESS_KEY') || '',
        },
        forcePathStyle: forcePathStyle || Boolean(endpoint),
      });
      this.logger.log(`S3 Service initialized with bucket: ${this.bucketName}`);
    } else {
      this.logger.warn('S3 is disabled. Using local storage.');
    }
  }

  onModuleDestroy(): void {
    if (this.useS3) {
      this.s3Client.destroy();
    }
  }

  /**
   * Upload file to S3
   */
  async uploadFile(
    key: string,
    file: Buffer | Readable,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<string> {
    if (!this.useS3) {
      throw new Error('S3 is not enabled');
    }

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: file,
        ContentType: contentType,
        Metadata: metadata,
        // Cache control for CDN
        CacheControl: 'public, max-age=31536000', // 1 year
      });

      await this.integration.execute(
        's3_put_object',
        () => this.s3Client.send(command),
        { timeoutMs: 30_000 },
      );

      const url = `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
      this.logger.log({
        event: 's3_file_uploaded',
        keyFingerprint: storageKeyFingerprint(key),
      });

      return url;
    } catch (error) {
      this.logger.error(
        {
          event: 's3_file_upload_failed',
          keyFingerprint: storageKeyFingerprint(key),
          errorName: error instanceof Error ? error.name : 'unknown_error',
        },
        getErrorStack(error),
      );
      throw error;
    }
  }

  /**
   * Get signed URL for private file access
   */
  async getSignedUrl(
    key: string,
    expiresIn: number = INTERNAL_DOWNLOAD_TTL_SECONDS,
  ): Promise<string> {
    return this.signDownloadUrl(key, normalizeInternalDownloadTtl(expiresIn));
  }

  async getPresignedUploadUrl(
    key: string,
    contentType: string,
    expiresIn = 600,
  ): Promise<string> {
    if (!this.useS3) {
      throw new Error('S3 is not enabled');
    }

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: contentType,
    });

    return this.integration.execute(
      's3_presign_put',
      () => getSignedUrl(this.s3Client, command, { expiresIn }),
      { timeoutMs: 10_000 },
    );
  }

  async getEmailLinkSignedUrl(
    key: string,
    expiresIn: number = EMAIL_LINK_DOWNLOAD_TTL_SECONDS,
  ): Promise<string> {
    return this.signDownloadUrl(key, normalizeEmailLinkDownloadTtl(expiresIn));
  }

  async getInlineViewUrl(
    key: string,
    expiresIn: number = INTERNAL_DOWNLOAD_TTL_SECONDS,
  ): Promise<string> {
    if (!this.useS3) {
      throw new Error('S3 is not enabled');
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ResponseCacheControl: 'private, no-store',
      ResponseContentDisposition: 'inline',
    });

    return this.integration.execute(
      's3_presign_inline_get',
      () =>
        getSignedUrl(this.s3Client, command, {
          expiresIn: normalizeInternalDownloadTtl(expiresIn),
        }),
      { timeoutMs: 10_000 },
    );
  }

  private async signDownloadUrl(
    key: string,
    expiresIn: number,
  ): Promise<string> {
    if (!this.useS3) {
      throw new Error('S3 is not enabled');
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ResponseCacheControl: 'private, no-store',
        ResponseContentDisposition: 'attachment',
      });

      const url = await this.integration.execute(
        's3_presign_get',
        () => getSignedUrl(this.s3Client, command, { expiresIn }),
        { timeoutMs: 10_000 },
      );
      return url;
    } catch (error) {
      this.logger.error(
        {
          event: 's3_signed_url_generation_failed',
          keyFingerprint: storageKeyFingerprint(key),
          errorName: error instanceof Error ? error.name : 'unknown_error',
        },
        getErrorStack(error),
      );
      throw error;
    }
  }

  /**
   * Download file from S3
   */
  async downloadFile(key: string): Promise<Buffer> {
    if (!this.useS3) {
      throw new Error('S3 is not enabled');
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const response = await this.integration.execute(
        's3_get_object',
        () => this.s3Client.send(command),
        { timeoutMs: 30_000 },
      );
      const stream = response.Body;

      if (!hasAsyncIterator(stream)) {
        throw new Error('S3 response body não é um stream async iterável.');
      }

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(toBufferChunk(chunk));
      }

      return Buffer.concat(chunks);
    } catch (error) {
      this.logger.error(
        {
          event: 's3_file_download_failed',
          keyFingerprint: storageKeyFingerprint(key),
          errorName: error instanceof Error ? error.name : 'unknown_error',
        },
        getErrorStack(error),
      );
      throw error;
    }
  }

  /**
   * Delete file from S3
   */
  async deleteFile(key: string): Promise<void> {
    if (!this.useS3) {
      throw new Error('S3 is not enabled');
    }

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.integration.execute(
        's3_delete',
        () => this.s3Client.send(command),
        { timeoutMs: 10_000 },
      );
      this.logger.log({
        event: 's3_file_deleted',
        keyFingerprint: storageKeyFingerprint(key),
      });
    } catch (error) {
      this.logger.error(
        {
          event: 's3_file_delete_failed',
          keyFingerprint: storageKeyFingerprint(key),
          errorName: error instanceof Error ? error.name : 'unknown_error',
        },
        getErrorStack(error),
      );
      throw error;
    }
  }

  /**
   * Check if file exists
   */
  async fileExists(key: string): Promise<boolean> {
    if (!this.useS3) {
      throw new Error('S3 is not enabled');
    }

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.integration.execute(
        's3_head_object',
        () => this.s3Client.send(command),
        { timeoutMs: 10_000 },
      );
      return true;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const code = (error as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      if (name === 'NotFound' || name === 'NoSuchKey' || code === 404) {
        return false;
      }
      throw error;
    }
  }

  async listKeys(
    prefix: string,
    options?: { maxKeys?: number },
  ): Promise<string[]> {
    if (!this.useS3) {
      throw new Error('S3 is not enabled');
    }

    const keys: string[] = [];
    let continuationToken: string | undefined;
    const maxKeys = options?.maxKeys;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys:
          maxKeys && maxKeys > 0
            ? Math.min(1000, Math.max(1, maxKeys - keys.length))
            : undefined,
      });

      const response = await this.integration.execute(
        's3_list_objects',
        () => this.s3Client.send(command),
        { timeoutMs: 30_000 },
      );
      for (const object of response.Contents || []) {
        if (object.Key) {
          keys.push(object.Key);
        }
      }

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (
      continuationToken &&
      (!maxKeys || maxKeys <= 0 || keys.length < maxKeys)
    );

    return maxKeys && maxKeys > 0 ? keys.slice(0, maxKeys) : keys;
  }

  /**
   * Generate S3 key for document
   */
  generateDocumentKey(
    companyId: string,
    documentType: string,
    documentId: string,
    filename: string,
  ): string {
    const timestamp = Date.now();
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    return `documents/${companyId}/${documentType}/${documentId}/${timestamp}-${sanitizedFilename}`;
  }

  /**
   * Get public URL (for CDN)
   */
  getPublicUrl(key: string): string {
    if (!this.useS3) {
      throw new Error('S3 is not enabled');
    }

    // If using CloudFront, return CloudFront URL
    const cloudFrontDomain =
      this.configService.get<string>('CLOUDFRONT_DOMAIN');
    if (cloudFrontDomain) {
      return `https://${cloudFrontDomain}/${key}`;
    }

    // Otherwise return S3 URL
    return `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
  }
}
