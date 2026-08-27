import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'crypto';

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const HMAC_HEX_PATTERN = SHA256_HEX_PATTERN;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface TimestampStamp {
  signature_hash: string;
  timestamp_token: string;
  timestamp_issued_at: string;
  timestamp_authority: string;
}

@Injectable()
export class SignatureTimestampService {
  private static readonly AUTHORITY = 'internal-hmac-v1';

  constructor(private readonly configService: ConfigService) {}

  issueFromRaw(rawPayload: string): TimestampStamp {
    if (typeof rawPayload !== 'string') {
      throw new TypeError('rawPayload must be a string');
    }

    const signatureHash = createHash('sha256').update(rawPayload).digest('hex');
    return this.issueFromHash(signatureHash);
  }

  issueFromHash(signatureHash: string, issuedAt?: string): TimestampStamp {
    this.assertCanonicalHash(signatureHash);
    const timestampIssuedAt = issuedAt ?? new Date().toISOString();
    this.assertCanonicalTimestamp(timestampIssuedAt);
    const tokenSignature = this.sign(signatureHash, timestampIssuedAt);
    return {
      signature_hash: signatureHash,
      timestamp_token: `${timestampIssuedAt}.${tokenSignature}`,
      timestamp_issued_at: timestampIssuedAt,
      timestamp_authority: SignatureTimestampService.AUTHORITY,
    };
  }

  verify(signatureHash: string, timestampToken: string): boolean {
    if (
      !this.isCanonicalHash(signatureHash) ||
      typeof timestampToken !== 'string'
    ) {
      return false;
    }

    // O timestamp ISO contém um ponto nos milissegundos (ex.: `.000Z`).
    // O separador do HMAC é o último ponto do envelope.
    const dotIndex = timestampToken.lastIndexOf('.');
    if (dotIndex <= 0 || dotIndex >= timestampToken.length - 1) {
      return false;
    }

    const timestampIssuedAt = timestampToken.slice(0, dotIndex);
    const tokenSignature = timestampToken.slice(dotIndex + 1);
    if (
      !this.isCanonicalTimestamp(timestampIssuedAt) ||
      !HMAC_HEX_PATTERN.test(tokenSignature)
    ) {
      return false;
    }

    try {
      const expected = this.sign(signatureHash, timestampIssuedAt);
      const actualBuffer = Buffer.from(tokenSignature, 'utf8');
      const expectedBuffer = Buffer.from(expected, 'utf8');
      if (actualBuffer.length !== expectedBuffer.length) {
        return false;
      }
      return timingSafeEqual(actualBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  private isCanonicalHash(value: unknown): value is string {
    return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
  }

  private assertCanonicalHash(value: unknown): asserts value is string {
    if (!this.isCanonicalHash(value)) {
      throw new TypeError(
        'signatureHash must be a lowercase SHA-256 hex digest',
      );
    }
  }

  private isCanonicalTimestamp(value: unknown): value is string {
    if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value)) {
      return false;
    }

    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  }

  private assertCanonicalTimestamp(value: unknown): asserts value is string {
    if (!this.isCanonicalTimestamp(value)) {
      throw new TypeError(
        'issuedAt must be a valid UTC timestamp in canonical ISO-8601 format',
      );
    }
  }

  private sign(signatureHash: string, timestampIssuedAt: string): string {
    return createHmac('sha256', this.getSecret())
      .update(`${signatureHash}.${timestampIssuedAt}`)
      .digest('hex');
  }

  private getSecret(): string {
    const secret = this.readSecret('SIGNATURE_TIMESTAMP_SECRET');
    if (!secret) {
      throw new Error('Missing SIGNATURE_TIMESTAMP_SECRET');
    }
    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error('Signature timestamp secret is too short');
    }
    return secret;
  }

  private readSecret(key: string): string | undefined {
    const value = this.configService.get<unknown>(key);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
}
