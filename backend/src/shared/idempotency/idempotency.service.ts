import {
  Injectable,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Redis } from 'ioredis';
import { REDIS_CLIENT_RATE_LIMIT } from '../redis/redis.constants';

export interface IdempotencyRecord {
  status: 'processing' | 'completed';
  requestHash: string;
  statusCode?: number;
  body?: unknown;
  responseStored?: boolean;
  createdAt: number;
}

export type MarkProcessingResult = 'acquired' | 'exists' | 'quota_exceeded';

export class DurableIdempotencyPersistenceException extends ServiceUnavailableException {
  constructor(error?: unknown) {
    super(
      'A persistência durável da idempotência está indisponível. Tente novamente.',
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

interface DurableIdempotencyRow {
  status: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  response_stored: boolean;
  created_at: Date | string | number;
}

const DEFAULT_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86400;
const DEFAULT_DURABLE_RETENTION_SECONDS = 2592000;
const MIN_DURABLE_RETENTION_SECONDS = 86400;
const MAX_DURABLE_RETENTION_SECONDS = 7776000;
const DEFAULT_MAX_RESPONSE_BYTES = 65536;
const MIN_MAX_RESPONSE_BYTES = 1024;
const MAX_MAX_RESPONSE_BYTES = 1048576;
const DEFAULT_MAX_KEYS_PER_SCOPE = 100;
const MIN_MAX_KEYS_PER_SCOPE = 1;
const MAX_MAX_KEYS_PER_SCOPE = 1000;
const DURABLE_TABLE = 'idempotency_durable_records';
const SENSITIVE_RESPONSE_KEY_PATTERN =
  /^(?:authorization|setcookie|cookie|token|accesstoken|refreshtoken|idtoken|bearertoken|csrftoken|password|secret|otp|recoverycode|credential|presignedurl|signedurl)$/;

function containsSensitiveResponseData(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return true;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveResponseData(entry, seen));
  }

  return Object.entries(value).some(([key, entry]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (
      SENSITIVE_RESPONSE_KEY_PATTERN.test(normalizedKey) ||
      containsSensitiveResponseData(entry, seen)
    );
  });
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly ttlSeconds: number;
  private readonly durableRetentionSeconds: number;
  private readonly maxResponseBytes: number;
  private readonly maxKeysPerScope: number;

  constructor(
    @Inject(REDIS_CLIENT_RATE_LIMIT) private readonly redis: Redis,
    configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.ttlSeconds = this.readBoundedInteger(
      configService,
      'IDEMPOTENCY_TTL_SECONDS',
      DEFAULT_TTL_SECONDS,
      MIN_TTL_SECONDS,
      MAX_TTL_SECONDS,
    );
    this.durableRetentionSeconds = this.readBoundedInteger(
      configService,
      'IDEMPOTENCY_DURABLE_RETENTION_SECONDS',
      DEFAULT_DURABLE_RETENTION_SECONDS,
      MIN_DURABLE_RETENTION_SECONDS,
      MAX_DURABLE_RETENTION_SECONDS,
    );
    this.maxResponseBytes = this.readBoundedInteger(
      configService,
      'IDEMPOTENCY_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      MIN_MAX_RESPONSE_BYTES,
      MAX_MAX_RESPONSE_BYTES,
    );
    this.maxKeysPerScope = this.readBoundedInteger(
      configService,
      'IDEMPOTENCY_MAX_KEYS_PER_SCOPE',
      DEFAULT_MAX_KEYS_PER_SCOPE,
      MIN_MAX_KEYS_PER_SCOPE,
      MAX_MAX_KEYS_PER_SCOPE,
    );
  }

  private readBoundedInteger(
    configService: ConfigService,
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const configured = configService.get<number | string>(key);
    const parsed =
      typeof configured === 'number'
        ? configured
        : Number.parseInt(configured ?? '', 10);

    if (!Number.isInteger(parsed)) {
      return fallback;
    }

    return Math.min(maximum, Math.max(minimum, parsed));
  }

  private buildKey(
    scopeId: string,
    method: string,
    path: string,
    idempotencyKey: string,
  ): string {
    return `idempotency:${scopeId}:${method}:${path}:${idempotencyKey}`;
  }

  private buildQuotaKey(scopeId: string): string {
    const scopeHash = createHash('sha256').update(scopeId).digest('hex');
    return `idempotency:quota:${scopeHash}`;
  }

  private hashIdentifier(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private buildDurableParameters(
    scopeId: string,
    method: string,
    path: string,
    idempotencyKey: string,
  ): [string, string, string, string] {
    return [
      this.hashIdentifier(scopeId),
      method,
      path,
      this.hashIdentifier(idempotencyKey),
    ];
  }

  private unavailable(error?: unknown): ServiceUnavailableException {
    return new ServiceUnavailableException(
      'Armazenamento de idempotência indisponível. Tente novamente.',
      error instanceof Error ? { cause: error } : undefined,
    );
  }

  private durableUnavailable(
    error?: unknown,
  ): DurableIdempotencyPersistenceException {
    return new DurableIdempotencyPersistenceException(error);
  }

  private async releaseDurableRecord(
    scopeId: string,
    method: string,
    path: string,
    idempotencyKey: string,
  ): Promise<void> {
    const [scopeHash, normalizedMethod, normalizedPath, keyHash] =
      this.buildDurableParameters(scopeId, method, path, idempotencyKey);
    await this.dataSource.query(
      `DELETE FROM ${DURABLE_TABLE}
       WHERE scope_hash = $1
         AND method = $2
         AND path = $3
         AND idempotency_key_hash = $4`,
      [scopeHash, normalizedMethod, normalizedPath, keyHash],
    );
  }

  private async releaseRedisReservation(
    scopeId: string,
    method: string,
    path: string,
    idempotencyKey: string,
    quotaIncremented: boolean,
  ): Promise<void> {
    const key = this.buildKey(scopeId, method, path, idempotencyKey);
    const removed = await this.redis.del(key).catch(() => 0);
    if (quotaIncremented && removed > 0) {
      await this.redis.decr(this.buildQuotaKey(scopeId)).catch(() => undefined);
    }
  }

  /**
   * Marca a chave como "em processamento".
   *
   * A linha PostgreSQL é a barreira durável. Redis continua sendo a reserva
   * rápida e a quota operacional, mas sua indisponibilidade nunca libera a
   * operação para seguir sem uma marca durável.
   */
  async markProcessing(
    scopeId: string,
    method: string,
    path: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<MarkProcessingResult> {
    const key = this.buildKey(scopeId, method, path, idempotencyKey);
    const [scopeHash, normalizedMethod, normalizedPath, keyHash] =
      this.buildDurableParameters(scopeId, method, path, idempotencyKey);
    const createdAt = new Date();
    const expiresAt = new Date(
      createdAt.getTime() + this.durableRetentionSeconds * 1000,
    );

    try {
      await this.dataSource.query(
        `DELETE FROM ${DURABLE_TABLE}
         WHERE scope_hash = $1
           AND method = $2
           AND path = $3
           AND idempotency_key_hash = $4
           AND expires_at <= NOW()`,
        [scopeHash, normalizedMethod, normalizedPath, keyHash],
      );

      const inserted = await this.dataSource.query<{ id: string }[]>(
        `INSERT INTO ${DURABLE_TABLE}
          (scope_hash, method, path, idempotency_key_hash, request_hash,
           status, response_stored, created_at, updated_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'processing', false, $6, $6, $7)
         ON CONFLICT (scope_hash, method, path, idempotency_key_hash)
         DO NOTHING
         RETURNING id`,
        [
          scopeHash,
          normalizedMethod,
          normalizedPath,
          keyHash,
          requestHash,
          createdAt,
          expiresAt,
        ],
      );

      if (inserted.length === 0) {
        return 'exists';
      }
    } catch (error) {
      throw this.durableUnavailable(error);
    }

    let quotaIncremented = false;
    let redisReservationCreated = false;
    try {
      const result = await this.redis.set(
        key,
        JSON.stringify({
          status: 'processing',
          requestHash,
          createdAt: createdAt.getTime(),
        } satisfies IdempotencyRecord),
        'EX',
        this.ttlSeconds,
        'NX',
      );

      if (result !== 'OK') {
        await this.releaseDurableRecord(scopeId, method, path, idempotencyKey);
        return 'exists';
      }
      redisReservationCreated = true;

      const quotaKey = this.buildQuotaKey(scopeId);
      const currentCount = await this.redis.incr(quotaKey);
      quotaIncremented = true;
      if (currentCount === 1) {
        await this.redis.expire(quotaKey, this.ttlSeconds);
      }

      if (currentCount > this.maxKeysPerScope) {
        await this.releaseRedisReservation(
          scopeId,
          method,
          path,
          idempotencyKey,
          redisReservationCreated && quotaIncremented,
        );
        await this.releaseDurableRecord(scopeId, method, path, idempotencyKey);
        return 'quota_exceeded';
      }
    } catch (error) {
      await this.releaseRedisReservation(
        scopeId,
        method,
        path,
        idempotencyKey,
        redisReservationCreated && quotaIncremented,
      );
      try {
        await this.releaseDurableRecord(scopeId, method, path, idempotencyKey);
      } catch (cleanupError) {
        throw this.unavailable(cleanupError);
      }
      throw this.unavailable(error);
    }

    return 'acquired';
  }

  /**
   * Persiste primeiro o resultado no PostgreSQL e só depois atualiza o Redis.
   * Se Redis falhar aqui, o registro completo continua disponível para replay.
   */
  async saveResponse(
    scopeId: string,
    method: string,
    path: string,
    idempotencyKey: string,
    requestHash: string,
    statusCode: number,
    body: unknown,
  ): Promise<void> {
    let serializedBody: string | undefined;
    try {
      serializedBody = JSON.stringify(body);
    } catch {
      serializedBody = undefined;
    }
    const responseStored =
      serializedBody !== undefined &&
      Buffer.byteLength(serializedBody, 'utf8') <= this.maxResponseBytes &&
      !containsSensitiveResponseData(body);
    const createdAt = Date.now();
    const record: IdempotencyRecord = {
      status: 'completed',
      requestHash,
      statusCode,
      ...(responseStored ? { body } : {}),
      responseStored,
      createdAt,
    };
    const [scopeHash, normalizedMethod, normalizedPath, keyHash] =
      this.buildDurableParameters(scopeId, method, path, idempotencyKey);

    try {
      const updated = await this.dataSource.query<{ id: string }[]>(
        `UPDATE ${DURABLE_TABLE}
         SET status = 'completed',
             request_hash = $5,
             response_status = $6,
             response_body = $7::jsonb,
             response_stored = $8,
             updated_at = NOW(),
             completed_at = NOW()
         WHERE scope_hash = $1
           AND method = $2
           AND path = $3
           AND idempotency_key_hash = $4
           AND status = 'processing'
         RETURNING id`,
        [
          scopeHash,
          normalizedMethod,
          normalizedPath,
          keyHash,
          requestHash,
          statusCode,
          responseStored ? serializedBody : null,
          responseStored,
        ],
      );
      if (updated.length === 0) {
        throw new Error('Registro durável de idempotência não encontrado.');
      }
    } catch (error) {
      throw this.durableUnavailable(error);
    }

    const key = this.buildKey(scopeId, method, path, idempotencyKey);
    try {
      await this.redis.set(key, JSON.stringify(record), 'EX', this.ttlSeconds);
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  /**
   * Remove a reserva quando a operação de domínio falha antes do commit.
   * A remoção durável acontece mesmo se Redis estiver fora do ar.
   */
  async deleteRecord(
    scopeId: string,
    method: string,
    path: string,
    idempotencyKey: string,
  ): Promise<void> {
    const [scopeHash, normalizedMethod, normalizedPath, keyHash] =
      this.buildDurableParameters(scopeId, method, path, idempotencyKey);
    let durableRemoved: boolean;
    try {
      const removed = await this.dataSource.query<{ id: string }[]>(
        `DELETE FROM ${DURABLE_TABLE}
         WHERE scope_hash = $1
           AND method = $2
           AND path = $3
           AND idempotency_key_hash = $4
         RETURNING id`,
        [scopeHash, normalizedMethod, normalizedPath, keyHash],
      );
      durableRemoved = removed.length > 0;
    } catch (error) {
      throw this.durableUnavailable(error);
    }

    try {
      const key = this.buildKey(scopeId, method, path, idempotencyKey);
      const redisRemoved = await this.redis.del(key);
      if (redisRemoved > 0 || durableRemoved) {
        const quotaKey = this.buildQuotaKey(scopeId);
        const quotaExists = await this.redis.exists(quotaKey).catch(() => 0);
        if (quotaExists > 0) {
          await this.redis.decr(quotaKey).catch(() => undefined);
        }
      }
    } catch (error) {
      // A reserva durável já foi removida; falha do Redis não deve impedir o
      // retry de uma operação que comprovadamente falhou antes do commit.
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      this.logger.warn(
        `Falha ao remover o espelho Redis após liberar idempotência: ${method} ${path} (${errorName})`,
      );
    }
  }

  /**
   * PostgreSQL é consultado primeiro. Redis é apenas fast-path e não pode
   * esconder um registro completo quando estiver indisponível.
   */
  async getRecord(
    scopeId: string,
    method: string,
    path: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null> {
    const [scopeHash, normalizedMethod, normalizedPath, keyHash] =
      this.buildDurableParameters(scopeId, method, path, idempotencyKey);
    let durableRows: DurableIdempotencyRow[];
    try {
      durableRows = await this.dataSource.query<DurableIdempotencyRow[]>(
        `SELECT status, request_hash, response_status, response_body,
                response_stored, created_at
           FROM ${DURABLE_TABLE}
          WHERE scope_hash = $1
            AND method = $2
            AND path = $3
            AND idempotency_key_hash = $4
            AND expires_at > NOW()
          LIMIT 1`,
        [scopeHash, normalizedMethod, normalizedPath, keyHash],
      );
    } catch (error) {
      throw this.durableUnavailable(error);
    }

    const durableRecord = durableRows[0]
      ? this.mapDurableRecord(durableRows[0])
      : null;
    if (durableRecord) {
      return durableRecord;
    }

    return null;
  }

  /** Limpeza operacional de registros duráveis fora da janela de retenção. */
  async cleanupExpired(limit = 1000): Promise<number> {
    const boundedLimit = Math.min(10_000, Math.max(1, Math.trunc(limit)));
    try {
      const removed = await this.dataSource.query<{ id: string }[]>(
        `DELETE FROM ${DURABLE_TABLE}
         WHERE id IN (
           SELECT id
             FROM ${DURABLE_TABLE}
            WHERE expires_at <= NOW()
            ORDER BY expires_at ASC
            LIMIT $1
         )
         RETURNING id`,
        [boundedLimit],
      );
      return removed.length;
    } catch (error) {
      throw this.durableUnavailable(error);
    }
  }

  private mapDurableRecord(row: DurableIdempotencyRow): IdempotencyRecord {
    const responseStored = row.response_stored === true;
    return {
      status: row.status === 'completed' ? 'completed' : 'processing',
      requestHash: row.request_hash,
      ...(row.response_status !== null
        ? { statusCode: row.response_status }
        : {}),
      ...(responseStored ? { body: row.response_body } : {}),
      responseStored,
      createdAt: this.toEpochMilliseconds(row.created_at),
    };
  }

  private toEpochMilliseconds(value: Date | string | number): number {
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === 'number') {
      return value;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
}
