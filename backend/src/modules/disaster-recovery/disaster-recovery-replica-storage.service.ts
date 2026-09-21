import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Readable } from 'stream';
import { resolveDrReplicaStorageConfig } from '../../shared/config/dr-replica-storage.config';
import { IntegrationResilienceService } from '../../shared/resilience/integration-resilience.service';
import { storageKeyFingerprint } from '../../shared/storage/storage-compensation.util';

const SYNTHETIC_PROBE_KEY_PATTERN =
  /^sgs-dr-probe\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/probe\.bin$/i;

const toBufferChunk = (chunk: Buffer | Uint8Array | string): Buffer =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

const isAsyncIterableBody = (
  value: unknown,
): value is AsyncIterable<Buffer | Uint8Array | string> =>
  typeof value === 'object' &&
  value !== null &&
  Symbol.asyncIterator in value &&
  typeof value[Symbol.asyncIterator] === 'function';

@Injectable()
export class DisasterRecoveryReplicaStorageService {
  private readonly logger = new Logger(
    DisasterRecoveryReplicaStorageService.name,
  );

  private readonly bucketName: string | null;
  private readonly endpoint: string | null;
  private readonly region: string;
  private readonly forcePathStyle: boolean;
  private readonly configured: boolean;
  private readonly client: S3Client;

  constructor(
    private readonly configService: ConfigService,
    private readonly integration: IntegrationResilienceService,
  ) {
    // ConfigModule/Joi may already coerce booleans before ConfigService returns
    // them. Read as unknown and let the shared resolver enforce the real
    // runtime type contract instead of trusting a TypeScript generic cast.
    const replica = resolveDrReplicaStorageConfig((key) =>
      this.configService.get<unknown>(key),
    );

    this.bucketName = replica.bucketName;
    this.endpoint = replica.endpoint;
    this.region = replica.region;
    this.forcePathStyle = replica.forcePathStyle;
    this.configured = replica.configured;

    this.client = new S3Client({
      region: this.region,
      endpoint: this.endpoint || undefined,
      credentials: {
        accessKeyId: replica.accessKeyId,
        secretAccessKey: replica.secretAccessKey,
      },
      forcePathStyle: this.forcePathStyle,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 2_000,
        socketTimeout: 15_000,
      }),
      maxAttempts: 3,
    });
  }

  isConfigured(): boolean {
    return this.configured;
  }

  getConfigurationSummary(): {
    configured: boolean;
    bucketName: string | null;
    endpoint: string | null;
  } {
    return {
      configured: this.configured,
      bucketName: this.bucketName,
      endpoint: this.endpoint,
    };
  }

  async fileExists(key: string): Promise<boolean> {
    this.assertConfigured();

    try {
      await this.integration.execute(
        'dr_storage_replica_head_object',
        () =>
          this.client.send(
            new HeadObjectCommand({
              Bucket: this.bucketName!,
              Key: key,
            }),
          ),
        { timeoutMs: 10_000 },
      );
      return true;
    } catch (error) {
      const candidate = error as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (
        candidate.name === 'NotFound' ||
        candidate.name === 'NoSuchKey' ||
        candidate.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      throw error;
    }
  }

  async uploadBuffer(input: {
    key: string;
    buffer: Buffer;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<void> {
    this.assertConfigured();

    await this.integration.execute(
      'dr_storage_replica_put_object',
      () =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.bucketName!,
            Key: input.key,
            Body: input.buffer,
            ContentType: input.contentType,
            Metadata: input.metadata,
          }),
        ),
      { timeoutMs: 30_000 },
    );

    this.logger.log({
      event: 'dr_storage_replica_uploaded',
      bucketName: this.bucketName,
      keyFingerprint: storageKeyFingerprint(input.key),
      sizeBytes: input.buffer.byteLength,
    });
  }

  async downloadFileBuffer(key: string): Promise<Buffer> {
    this.assertConfigured();

    const response = await this.integration.execute(
      'dr_storage_replica_get_object',
      () =>
        this.client.send(
          new GetObjectCommand({
            Bucket: this.bucketName!,
            Key: key,
          }),
        ),
      { timeoutMs: 30_000 },
    );

    const body = response.Body;
    if (!body || !(body instanceof Readable || isAsyncIterableBody(body))) {
      throw new Error(`Objeto da réplica não pôde ser lido: ${key}`);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<
      Buffer | Uint8Array | string
    >) {
      chunks.push(toBufferChunk(chunk));
    }

    return Buffer.concat(chunks);
  }

  async deleteObject(key: string): Promise<void> {
    this.assertConfigured();

    if (!SYNTHETIC_PROBE_KEY_PATTERN.test(key)) {
      throw new Error(
        'Exclusão na réplica é restrita a objetos do probe sintético.',
      );
    }

    await this.integration.execute(
      'dr_storage_replica_delete_object',
      () =>
        this.client.send(
          new DeleteObjectCommand({
            Bucket: this.bucketName!,
            Key: key,
          }),
        ),
      { timeoutMs: 10_000 },
    );

    this.logger.log({
      event: 'dr_storage_replica_deleted',
      bucketName: this.bucketName,
      keyFingerprint: storageKeyFingerprint(key),
    });
  }

  async listKeys(
    prefix: string,
    options?: { maxKeys?: number },
  ): Promise<string[]> {
    this.assertConfigured();

    const keys: string[] = [];
    let continuationToken: string | undefined;
    const maxKeys = options?.maxKeys;

    do {
      const response = await this.integration.execute(
        'dr_storage_replica_list_objects',
        () =>
          this.client.send(
            new ListObjectsV2Command({
              Bucket: this.bucketName!,
              Prefix: prefix,
              ContinuationToken: continuationToken,
              MaxKeys:
                maxKeys && maxKeys > 0
                  ? Math.min(1000, Math.max(1, maxKeys - keys.length))
                  : undefined,
            }),
          ),
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

  private assertConfigured(): void {
    if (this.configured) {
      return;
    }

    throw new Error(
      'Storage de réplica não configurado. Defina DR_STORAGE_REPLICA_BUCKET, DR_STORAGE_REPLICA_ENDPOINT e credenciais DR independentes.',
    );
  }
}
