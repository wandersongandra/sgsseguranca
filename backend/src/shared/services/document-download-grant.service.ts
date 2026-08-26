import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RequestContext } from '../middleware/request-context.middleware';
import { TenantService } from '../tenant/tenant.service';
import { DocumentDownloadGrant } from '../entities/document-download-grant.entity';
import {
  INTERNAL_DOWNLOAD_TTL_SECONDS,
  normalizeInternalDownloadTtl,
} from '../storage/storage-download-ttl';
import type { StorageObjectReference } from '../storage/storage-object-reference';

type DownloadTokenPayload = {
  typ: 'document_download';
  gid: string;
  companyId: string;
  key: string;
  ownerType: string;
  ownerId: string;
  purpose: string;
  uid?: string;
};

@Injectable()
export class DocumentDownloadGrantService {
  private readonly logger = new Logger(DocumentDownloadGrantService.name);
  private readonly authorizedReferences = new WeakMap<
    DocumentDownloadGrant,
    StorageObjectReference
  >();

  constructor(
    @InjectRepository(DocumentDownloadGrant)
    private readonly downloadGrantRepository: Repository<DocumentDownloadGrant>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly tenantService: TenantService,
  ) {}

  async issueRestrictedAppDownloadUrl(input: {
    reference: StorageObjectReference;
    originalName?: string | null;
    contentType?: string | null;
    expiresIn?: number;
  }): Promise<string> {
    const fileKey = String(input.reference.key || '').trim();
    if (!fileKey.startsWith('documents/')) {
      throw new BadRequestException(
        'Somente documentos oficiais em documents/ podem receber token de download restrito.',
      );
    }

    if (!/\.pdf$/i.test(fileKey)) {
      throw new BadRequestException(
        'Download restrito com token está habilitado apenas para PDFs governados.',
      );
    }

    const companyId = input.reference.tenantId.trim();
    if (!companyId) {
      throw new BadRequestException(
        'Não foi possível resolver a empresa dona do documento governado.',
      );
    }

    if (this.tenantService.isSuperAdmin()) {
      throw new ForbiddenException(
        'Download restrito exige contexto tenant-scoped explícito.',
      );
    }
    if (this.tenantService.getTenantId()?.trim() !== companyId) {
      throw new ForbiddenException(
        'Download restrito exige o tenant atual do documento.',
      );
    }

    await this.assertRegistryBoundReference(input.reference);

    const expiresIn = normalizeInternalDownloadTtl(
      input.expiresIn ?? INTERNAL_DOWNLOAD_TTL_SECONDS,
    );
    const grantId = randomUUID();
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const issuedForUserId = RequestContext.getUserId() || null;

    await this.tenantService.run(
      {
        companyId,
        isSuperAdmin: false,
        userId: issuedForUserId || undefined,
        siteScope: 'all',
      },
      () =>
        this.downloadGrantRepository.save(
          this.downloadGrantRepository.create({
            id: grantId,
            company_id: companyId,
            file_key: fileKey,
            original_name:
              this.normalizeOriginalName(input.originalName) || null,
            content_type: input.contentType?.trim() || 'application/pdf',
            issued_for_user_id: issuedForUserId,
            expires_at: expiresAt,
            consumed_at: null,
          }),
        ),
    );

    const token = jwt.sign(
      {
        typ: 'document_download',
        gid: grantId,
        companyId,
        key: fileKey,
        ownerType: input.reference.owner.resourceType,
        ownerId: input.reference.owner.resourceId,
        purpose: input.reference.purpose,
        uid: issuedForUserId || undefined,
      } satisfies DownloadTokenPayload,
      this.getSecret(),
      {
        algorithm: 'HS256',
        expiresIn,
      },
    );

    const path = `/storage/download/${token}`;
    const baseUrl = this.configService.get<string>('API_PUBLIC_URL')?.trim();

    this.logger.debug({
      event: 'document_download_grant_issued',
      grantId,
      companyId,
      keyFingerprint: this.diagnosticFingerprint(fileKey),
      ownerType: input.reference.owner.resourceType,
      purpose: input.reference.purpose,
      expiresIn,
      issuedForUserId,
    });

    if (!baseUrl) {
      return path;
    }

    return `${baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async consumeToken(
    token: string,
    options?: { consumerUserId?: string | null },
  ): Promise<DocumentDownloadGrant> {
    const decoded = this.verifyToken(token);

    const grant = await this.tenantService.run(
      { companyId: decoded.companyId, isSuperAdmin: false, siteScope: 'all' },
      () =>
        this.dataSource.transaction(async (manager) => {
          const repository = manager.getRepository(DocumentDownloadGrant);
          const grant = await repository
            .createQueryBuilder('grant')
            .setLock('pessimistic_write')
            .where('grant.id = :id', { id: decoded.gid })
            .getOne();

          if (!grant) {
            throw new ForbiddenException(
              'Token de download inválido, expirado ou já consumido.',
            );
          }

          if (grant.consumed_at) {
            throw new ForbiddenException(
              'Token de download inválido, expirado ou já consumido.',
            );
          }

          if (grant.expires_at.getTime() <= Date.now()) {
            throw new ForbiddenException(
              'Token de download inválido, expirado ou já consumido.',
            );
          }

          if (
            grant.company_id !== decoded.companyId ||
            grant.file_key !== decoded.key
          ) {
            throw new ForbiddenException(
              'Token de download inválido, expirado ou já consumido.',
            );
          }

          if (grant.issued_for_user_id) {
            if (!decoded.uid || decoded.uid !== grant.issued_for_user_id) {
              throw new ForbiddenException(
                'Token de download inválido, expirado ou já consumido.',
              );
            }

            const consumerUserId = options?.consumerUserId?.trim();
            if (
              !consumerUserId ||
              consumerUserId !== grant.issued_for_user_id
            ) {
              throw new ForbiddenException(
                'Token de download inválido, expirado ou já consumido.',
              );
            }
          }

          grant.consumed_at = new Date();
          await repository.save(grant);

          this.logger.debug({
            event: 'document_download_grant_consumed',
            grantId: grant.id,
            companyId: grant.company_id,
            keyFingerprint: this.diagnosticFingerprint(grant.file_key),
          });

          return grant;
        }),
    );

    this.authorizedReferences.set(grant, {
      tenantId: grant.company_id,
      key: grant.file_key,
      owner: {
        resourceType: decoded.ownerType,
        resourceId: decoded.ownerId,
      },
      purpose: decoded.purpose,
    });
    return grant;
  }

  getAuthorizedReference(grant: DocumentDownloadGrant): StorageObjectReference {
    const reference = this.authorizedReferences.get(grant);
    if (!reference) {
      throw new ForbiddenException(
        'Download restrito sem referência autorizada.',
      );
    }
    return reference;
  }

  private verifyToken(token: string): DownloadTokenPayload {
    try {
      const decoded = jwt.verify(token, this.getSecret(), {
        algorithms: ['HS256'],
      }) as jwt.JwtPayload & {
        typ?: unknown;
        gid?: unknown;
        companyId?: unknown;
        key?: unknown;
        ownerType?: unknown;
        ownerId?: unknown;
        purpose?: unknown;
        uid?: unknown;
      };

      const readStringClaim = (value: unknown): string =>
        typeof value === 'string' ? value.trim() : '';

      const typ = readStringClaim(decoded.typ);
      const gid = readStringClaim(decoded.gid);
      const companyId = readStringClaim(decoded.companyId);
      const key = readStringClaim(decoded.key);
      const ownerType = readStringClaim(decoded.ownerType);
      const ownerId = readStringClaim(decoded.ownerId);
      const purpose = readStringClaim(decoded.purpose);
      const uidRaw = decoded.uid;
      const uid =
        typeof uidRaw === 'string' && uidRaw.trim().length > 0
          ? uidRaw.trim()
          : undefined;

      if (
        typ !== 'document_download' ||
        !gid ||
        !companyId ||
        !key.startsWith('documents/') ||
        !ownerType ||
        !ownerId ||
        !purpose
      ) {
        throw new Error('invalid_download_token_payload');
      }

      return {
        typ: 'document_download',
        gid,
        companyId,
        key,
        ownerType,
        ownerId,
        purpose,
        uid,
      };
    } catch (_error) {
      this.logger.warn({
        event: 'document_download_token_rejected',
        reason: 'invalid_or_expired_token',
      });
      throw new ForbiddenException(
        'Token de download inválido, expirado ou já consumido.',
      );
    }
  }

  private getSecret(): string {
    const secret = this.configService
      .get<string>('DOCUMENT_DOWNLOAD_TOKEN_SECRET')
      ?.trim();

    if (!secret) {
      throw new ServiceUnavailableException(
        'Serviço de download temporariamente indisponível.',
      );
    }

    return secret;
  }

  private normalizeOriginalName(originalName?: string | null): string | null {
    const normalized = String(originalName || '').trim();
    if (!normalized) {
      return null;
    }

    return normalized.replace(/[^\w.\- ]+/g, '_');
  }

  private diagnosticFingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  private async assertRegistryBoundReference(
    reference: StorageObjectReference,
  ): Promise<void> {
    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(
      `SELECT company_id, module, entity_id, file_key, status, deleted_at
         FROM document_registry
        WHERE company_id = $1
          AND module = $2
          AND entity_id = $3
          AND file_key = $4
          AND status = 'ACTIVE'
          AND deleted_at IS NULL
        LIMIT 1`,
      [
        reference.tenantId.trim(),
        reference.owner.resourceType.trim(),
        reference.owner.resourceId.trim(),
        reference.key.trim(),
      ],
    );
    const row = rows[0];
    const registryPurpose = row
      ? `document-registry:${String(row.module)}:pdf`
      : null;

    if (
      !row ||
      String(row.company_id) !== reference.tenantId.trim() ||
      String(row.module) !== reference.owner.resourceType.trim() ||
      String(row.entity_id) !== reference.owner.resourceId.trim() ||
      String(row.file_key) !== reference.key.trim() ||
      reference.purpose.trim() !== registryPurpose
    ) {
      throw new ForbiddenException(
        'Download restrito requer documento governado autorizado.',
      );
    }
  }
}
