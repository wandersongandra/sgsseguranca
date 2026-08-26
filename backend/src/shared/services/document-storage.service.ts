import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'stream';
import { DataSource } from 'typeorm';
import {
  extractResilienceErrorCode,
  extractResilienceErrorMessage,
  extractResilienceErrorStatus,
} from '../resilience/resilience-error.util';
import { S3Service } from '../storage/s3.service';
import { sanitizeS3Key } from '../utils/s3-key.util';
import { TenantService } from '../tenant/tenant.service';
import { DocumentDownloadGrantService } from './document-download-grant.service';
import type {
  AuthorizedStorageObjectReference,
  StorageObjectReference,
  StorageOperation,
  StoragePrefixReference,
} from '../storage/storage-object-reference';
import {
  isAuthorizedStorageObjectReference,
  markAuthorizedStorageReference,
} from '../storage/storage-object-reference';
import {
  EMAIL_LINK_DOWNLOAD_TTL_SECONDS,
  INTERNAL_DOWNLOAD_TTL_SECONDS,
  normalizeEmailLinkDownloadTtl,
  normalizeInternalDownloadTtl,
} from '../storage/storage-download-ttl';

export type PrivilegedStorageAccessInput = {
  tenantId: string;
  key: string;
  owner: StorageObjectReference['owner'];
  purpose: 'disaster-recovery-integrity' | 'disaster-recovery-replication';
};

const AUTHORIZED_REFERENCE_OPERATIONS: ReadonlySet<StorageOperation> = new Set([
  'download',
  'delete',
  'presign',
  'upload-presign',
  'list',
  'copy',
  'move',
  'replace',
]);

@Injectable()
export class DocumentStorageService {
  private readonly logger = new Logger(DocumentStorageService.name);
  private readonly authorizedReferences = new WeakSet<object>();
  private readonly authorizedReferenceOperations = new WeakMap<
    object,
    ReadonlySet<StorageOperation>
  >();
  private localStorageDirCache: string | null | undefined;

  constructor(
    private readonly configService: ConfigService,
    private readonly s3Service: S3Service,
    private readonly tenantService: TenantService,
    private readonly documentDownloadGrantService: DocumentDownloadGrantService,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  /**
   * Cria a referência canônica usada pela boundary de storage.
   * A autorização efetiva ocorre imediatamente antes do provider, em cada
   * operação, para evitar que uma referência seja reutilizada fora do escopo.
   */
  createReference(input: StorageObjectReference): StorageObjectReference {
    return {
      tenantId: String(input.tenantId || '').trim(),
      key: String(input.key || ''),
      owner: {
        resourceType: String(input.owner?.resourceType || '').trim(),
        resourceId: String(input.owner?.resourceId || '').trim(),
      },
      purpose: String(input.purpose || '').trim(),
    };
  }

  /**
   * Constrói referência para uma chave já persistida pelo domínio.
   *
   * A referência retornada é deliberadamente estrutural e não autorizada.
   * Operações sobre objetos existentes resolvem a relação persistida antes de
   * tocar o provider. A chave histórica não é promovida automaticamente para
   * `legacy`.
   */
  referenceForExistingObject(
    key: string,
    owner: StorageObjectReference['owner'],
    purpose: string,
  ): StorageObjectReference {
    const tenantId = this.tenantService.getTenantId();
    if (!tenantId) {
      throw new BadRequestException(
        'Contexto de tenant é obrigatório para storage governado.',
      );
    }
    const cleanKey = String(key || '').trim();
    return this.createReference({
      tenantId,
      key: cleanKey,
      owner,
      purpose,
    });
  }

  createPrefixReference(input: StoragePrefixReference): StoragePrefixReference {
    return {
      tenantId: String(input.tenantId || '').trim(),
      prefix: String(input.prefix || ''),
      owner: {
        resourceType: String(input.owner?.resourceType || '').trim(),
        resourceId: String(input.owner?.resourceId || '').trim(),
      },
      purpose: String(input.purpose || '').trim(),
    };
  }

  generateDocumentKey(
    companyId: string,
    documentType: string,
    documentId: string,
    filename: string,
    options?: { folderSegments?: string[] },
  ): string {
    const timestamp = Date.now();
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const scopedFolders = (options?.folderSegments ?? []).map((segment) =>
      this.sanitizeFolderSegment(segment),
    );
    return [
      'documents',
      companyId,
      documentType,
      ...scopedFolders,
      documentId,
      `${timestamp}-${sanitizedFilename}`,
    ].join('/');
  }

  private sanitizeFolderSegment(segment: string): string {
    const sanitized = String(segment || '')
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/^_+|_+$/g, '');

    if (!sanitized || sanitized === '.' || sanitized === '..') {
      throw new BadRequestException('Segmento de pasta documental inválido.');
    }

    return sanitized;
  }

  async uploadFile(
    reference: StorageObjectReference,
    file: Buffer | Readable,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const key = this.assertReference(reference, 'upload');
    this.assertNewUploadReference(reference, key);
    await this.writeFileToProvider(key, file, contentType, metadata);
  }

  private async writeFileToProvider(
    key: string,
    file: Buffer | Readable,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    this.ensureStorageConfigured('upload');
    try {
      if (this.shouldUseLocalFsStorage()) {
        const buffer = await this.toBuffer(file);
        await this.writeLocalFile(key, buffer);
        return;
      }

      if (this.shouldUseManagedStorage()) {
        await this.s3Service.uploadFile(key, file, contentType, metadata);
        return;
      }

      await this.s3Service.uploadFile(key, file, contentType, metadata);
      return;
    } catch (error) {
      this.handleStorageError('upload', key, error);
    }
  }

  /**
   * Upload inicial que devolve uma capability de limpeza para o trecho entre
   * a gravação física e o vínculo persistido do objeto.
   */
  async uploadFileWithCapability(
    reference: StorageObjectReference,
    file: Buffer | Readable,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<AuthorizedStorageObjectReference> {
    await this.uploadFile(reference, file, contentType, metadata);
    return this.markAuthorizedReference(
      this.createReference({ ...reference, key: reference.key }),
      new Set<StorageOperation>(['delete']),
    );
  }

  /**
   * Resolve uma referência estrutural sem tocar no provider.
   *
   * É usado por fluxos que precisam manter uma capability estável enquanto
   * removem o vínculo persistido primeiro e limpam o objeto depois.
   */
  async resolveExistingReference(
    reference: StorageObjectReference,
    operation: Extract<
      StorageOperation,
      'download' | 'delete' | 'presign' | 'copy' | 'move' | 'replace'
    >,
  ): Promise<AuthorizedStorageObjectReference> {
    return this.authorizeExistingReference(reference, operation);
  }

  async getSignedUrl(
    reference: StorageObjectReference,
    expiresIn = INTERNAL_DOWNLOAD_TTL_SECONDS,
  ): Promise<string> {
    return this.issueSignedUrl(
      reference,
      normalizeInternalDownloadTtl(expiresIn),
    );
  }

  /**
   * Uso explícito para links enviados por e-mail.
   *
   * Não use este método para navegação interna do app. O TTL estendido
   * (até 24h) é reservado apenas para mensagens assíncronas onde o usuário
   * pode abrir o link fora da sessão web ativa.
   */
  async getEmailLinkSignedUrl(
    reference: StorageObjectReference,
    expiresIn = EMAIL_LINK_DOWNLOAD_TTL_SECONDS,
  ): Promise<string> {
    return this.issueSignedUrl(
      reference,
      normalizeEmailLinkDownloadTtl(expiresIn),
      {
        emailLink: true,
      },
    );
  }

  async getPresignedDownloadUrl(
    reference: StorageObjectReference,
    expiresIn = INTERNAL_DOWNLOAD_TTL_SECONDS,
  ): Promise<string> {
    return this.getSignedUrl(reference, expiresIn);
  }

  async getInlineViewUrl(
    reference: StorageObjectReference,
    expiresIn = INTERNAL_DOWNLOAD_TTL_SECONDS,
  ): Promise<string> {
    const authorized = await this.authorizeExistingReference(
      reference,
      'presign',
    );
    const key = authorized.key;
    this.ensureStorageConfigured('presign');
    if (this.shouldUseLocalFsStorage()) {
      throw new ServiceUnavailableException(
        'Visualização presignada indisponível no storage local.',
      );
    }
    try {
      return await this.s3Service.getInlineViewUrl(key, expiresIn);
    } catch (error) {
      this.handleStorageError('presign', key, error);
    }
  }

  async getPresignedUploadUrl(
    reference: StorageObjectReference,
    contentType: string,
    expiresIn = 600,
  ): Promise<string> {
    const key = this.assertReference(reference, 'upload-presign', {
      allowUnresolvedLegacy: true,
    });
    this.assertNewUploadReference(reference, key, { allowQuarantine: true });
    this.ensureStorageConfigured('presign');
    if (this.shouldUseLocalFsStorage()) {
      throw new ServiceUnavailableException(
        'Upload presignado indisponível no storage local.',
      );
    }
    try {
      return await this.s3Service.getPresignedUploadUrl(
        key,
        contentType,
        expiresIn,
      );
    } catch (error) {
      this.handleStorageError('presign', key, error);
    }
  }

  private async issueSignedUrl(
    reference: StorageObjectReference,
    expiresIn: number,
    options?: { emailLink?: boolean },
  ): Promise<string> {
    const authorized = await this.authorizeExistingReference(
      reference,
      'presign',
    );
    const key = authorized.key;
    this.ensureStorageConfigured('presign');
    try {
      if (!options?.emailLink && this.shouldUseRestrictedAppDownload(key)) {
        return await this.documentDownloadGrantService.issueRestrictedAppDownloadUrl(
          {
            reference: authorized,
            originalName: key.split('/').pop() || null,
            expiresIn,
          },
        );
      }

      return options?.emailLink
        ? await this.s3Service.getEmailLinkSignedUrl(key, expiresIn)
        : await this.s3Service.getSignedUrl(key, expiresIn);
    } catch (error) {
      this.handleStorageError('presign', key, error);
    }
  }

  async downloadFileBuffer(reference: StorageObjectReference): Promise<Buffer> {
    const authorized = await this.authorizeExistingReference(
      reference,
      'download',
    );
    const key = authorized.key;
    this.ensureStorageConfigured('download');
    try {
      if (this.shouldUseLocalFsStorage()) {
        return await this.readLocalFile(key);
      }

      return await this.s3Service.downloadFile(key);
    } catch (error) {
      this.handleStorageError('download', key, error);
    }
  }

  async deleteFile(reference: StorageObjectReference): Promise<void> {
    const authorized = await this.authorizeExistingReference(
      reference,
      'delete',
    );
    const key = authorized.key;
    this.ensureStorageConfigured('delete');
    try {
      if (this.shouldUseLocalFsStorage()) {
        await this.deleteLocalFile(key);
        return;
      }

      await this.s3Service.deleteFile(key);
    } catch (error) {
      this.handleStorageError('delete', key, error);
    }
  }

  async fileExists(reference: StorageObjectReference): Promise<boolean> {
    const authorized = await this.authorizeExistingReference(
      reference,
      'download',
    );
    const key = authorized.key;
    this.ensureStorageConfigured('download');
    try {
      if (this.shouldUseLocalFsStorage()) {
        return await this.localFileExists(key);
      }

      return await this.s3Service.fileExists(key);
    } catch (error) {
      this.handleStorageError('download', key, error);
    }
  }

  async listKeys(
    reference: StoragePrefixReference,
    options?: { maxKeys?: number },
  ): Promise<string[]> {
    const prefix = this.assertPrefixReference(reference);
    this.ensureStorageConfigured('download');
    try {
      if (this.shouldUseLocalFsStorage()) {
        return await this.listLocalKeys(prefix, options);
      }

      return await this.s3Service.listKeys(prefix, options);
    } catch (error) {
      this.handleStorageError('download', prefix, error);
    }
  }

  /**
   * Varredura global de infraestrutura. Não é uma alternativa ao fluxo
   * tenant-scoped: exige contexto super-admin explícito e permanece limitada
   * à enumeração física para DR/retention.
   */
  async listKeysPrivileged(
    prefix: string,
    owner: StorageObjectReference['owner'],
    purpose: string,
    options?: { maxKeys?: number },
  ): Promise<string[]> {
    if (!this.tenantService.isSuperAdmin()) {
      throw new ForbiddenException(
        'Enumeração global de storage exige contexto super-admin explícito.',
      );
    }
    const normalizedPrefix = String(prefix || '').replace(/\/+$/, '');
    if (
      !normalizedPrefix ||
      !owner?.resourceType ||
      !owner?.resourceId ||
      !purpose
    ) {
      throw new BadRequestException(
        'Varredura privilegiada requer prefixo, owner e purpose explícitos.',
      );
    }
    const cleanPrefix = sanitizeS3Key(normalizedPrefix);
    if (cleanPrefix !== normalizedPrefix) {
      throw new ForbiddenException('Prefixo de storage inválido.');
    }
    this.ensureStorageConfigured('download');
    try {
      if (this.shouldUseLocalFsStorage()) {
        return await this.listLocalKeys(`${cleanPrefix}/`, options);
      }
      return await this.s3Service.listKeys(`${cleanPrefix}/`, options);
    } catch (error) {
      this.handleStorageError('download', `${cleanPrefix}/`, error);
    }
  }

  /**
   * Leitura física exclusiva de DR. Não resolve owner de domínio e não é
   * utilizável por contexto tenant-scoped; o chamador precisa estar em
   * contexto super-admin explícito e declarar a operação de infraestrutura.
   */
  async downloadFileBufferPrivileged(
    input: PrivilegedStorageAccessInput,
  ): Promise<Buffer> {
    const key = this.assertPrivilegedStorageAccess(input);
    this.ensureStorageConfigured('download');
    try {
      if (this.shouldUseLocalFsStorage()) {
        return await this.readLocalFile(key);
      }

      return await this.s3Service.downloadFile(key);
    } catch (error) {
      this.handleStorageError('download', key, error);
    }
  }

  /** Existência física exclusiva de DR, separada da API documental. */
  async fileExistsPrivileged(
    input: PrivilegedStorageAccessInput,
  ): Promise<boolean> {
    const key = this.assertPrivilegedStorageAccess(input);
    this.ensureStorageConfigured('download');
    try {
      if (this.shouldUseLocalFsStorage()) {
        return await this.localFileExists(key);
      }

      return await this.s3Service.fileExists(key);
    } catch (error) {
      this.handleStorageError('download', key, error);
    }
  }

  /** Upload governado para substituir o conteúdo de um objeto existente. */
  async replaceFile(
    reference: StorageObjectReference,
    file: Buffer | Readable,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const authorized = await this.authorizeExistingReference(
      reference,
      'replace',
    );
    await this.writeFileToProvider(authorized.key, file, contentType, metadata);
  }

  /** Copia um objeto somente depois de validar origem e destino. */
  async copyFile(
    source: StorageObjectReference,
    destination: StorageObjectReference,
    contentType = 'application/octet-stream',
  ): Promise<void> {
    const authorizedSource = await this.authorizeExistingReference(
      source,
      'copy',
    );
    const authorizedDestination = await this.authorizeExistingReference(
      destination,
      'copy',
    );
    const sourceKey = authorizedSource.key;
    const buffer = await this.downloadFileBuffer(authorizedSource);
    await this.writeFileToProvider(
      authorizedDestination.key,
      buffer,
      contentType,
    );
    this.logger.debug({
      event: 'document_storage_copy_completed',
      keyFingerprint: this.storageDiagnosticFingerprint(sourceKey),
    });
  }

  /** Move governado: copy validado seguido de delete validado da origem. */
  async moveFile(
    source: StorageObjectReference,
    destination: StorageObjectReference,
    contentType = 'application/octet-stream',
  ): Promise<void> {
    await this.copyFile(source, destination, contentType);
    await this.deleteFile(source);
  }

  /**
   * Promoção usada pelo fluxo de quarentena. Ambas as referências precisam
   * pertencer ao mesmo tenant e ao mesmo owner lógico.
   */
  async promoteFile(
    source: StorageObjectReference,
    destination: StorageObjectReference,
    contentType: string,
  ): Promise<void> {
    const authorizedSource = await this.authorizeExistingReference(
      source,
      'move',
    );
    const sourceKey = authorizedSource.key;
    const destinationKey = this.assertReference(destination, 'move');
    if (
      source.tenantId !== destination.tenantId ||
      source.owner.resourceType !== destination.owner.resourceType ||
      source.owner.resourceId !== destination.owner.resourceId
    ) {
      throw new ForbiddenException(
        'Origem e destino devem pertencer ao mesmo tenant e recurso.',
      );
    }
    this.assertNewUploadReference(destination, destinationKey);
    const buffer = await this.downloadFileBuffer(authorizedSource);
    await this.writeFileToProvider(destinationKey, buffer, contentType);
    await this.deleteFile(authorizedSource);
    this.logger.debug({
      event: 'document_storage_promotion_completed',
      sourceFingerprint: this.storageDiagnosticFingerprint(sourceKey),
      destinationFingerprint: this.storageDiagnosticFingerprint(destinationKey),
    });
  }

  isStorageConfigured(): boolean {
    return (
      this.shouldUseManagedStorage() ||
      this.shouldUseLegacyS3() ||
      this.shouldUseLocalFsStorage()
    );
  }

  getStorageConfigurationSummary(): {
    mode: 'managed' | 'legacy' | 'local_fs' | 'unconfigured';
    bucketName: string | null;
    endpoint: string | null;
  } {
    if (this.shouldUseLocalFsStorage()) {
      return {
        mode: 'local_fs',
        bucketName: null,
        endpoint: this.getLocalFsStorageDir(),
      };
    }

    if (this.shouldUseManagedStorage()) {
      return {
        mode: 'managed',
        bucketName: this.configService.get<string>('AWS_BUCKET_NAME') || null,
        endpoint: this.configService.get<string>('AWS_ENDPOINT') || null,
      };
    }

    if (this.shouldUseLegacyS3()) {
      return {
        mode: 'legacy',
        bucketName: this.configService.get<string>('AWS_S3_BUCKET') || null,
        endpoint: this.configService.get<string>('AWS_S3_ENDPOINT') || null,
      };
    }

    return {
      mode: 'unconfigured',
      bucketName: null,
      endpoint: null,
    };
  }

  /**
   * Resolve uma referência estrutural contra a relação persistida do objeto.
   * A busca é feita pelo tenant e pela identidade declarada do recurso; a
   * chave somente confirma o valor persistido e nunca cria a autorização.
   */
  private async authorizeExistingReference(
    reference: StorageObjectReference,
    operation: StorageOperation,
  ): Promise<AuthorizedStorageObjectReference> {
    if (this.isAuthorizedReference(reference)) {
      if (!this.isAuthorizedReferenceForOperation(reference, operation)) {
        throw new ForbiddenException(
          'A referência de storage não autoriza esta operação.',
        );
      }
      this.assertReference(reference, operation);
      return reference;
    }

    const key = this.assertReference(reference, operation, {
      allowUnresolvedLegacy: true,
    });

    if (operation === 'upload') {
      this.assertNewUploadReference(reference, key);
      return this.markAuthorizedReference(
        this.createReference({
          tenantId: reference.tenantId,
          key,
          owner: reference.owner,
          purpose: reference.purpose,
        }),
      );
    }

    // Quarentena é uma capacidade curta de criação emitida pelo próprio
    // controller. Ela não possui entidade de domínio até o complete-upload.
    if (
      operation !== 'download' &&
      operation !== 'delete' &&
      operation !== 'presign' &&
      operation !== 'copy' &&
      operation !== 'move' &&
      operation !== 'replace'
    ) {
      throw new BadRequestException('Operação de storage não suportada.');
    }
    if (
      key.startsWith('quarantine/') &&
      (operation === 'download' ||
        operation === 'copy' ||
        operation === 'move' ||
        operation === 'delete') &&
      reference.owner.resourceType === 'upload' &&
      reference.purpose === 'storage-quarantine-promotion'
    ) {
      return this.markAuthorizedReference(
        this.createReference({
          ...reference,
          key,
        }),
        new Set<StorageOperation>(['download', 'delete', 'copy', 'move']),
      );
    }

    if (!this.dataSource) {
      throw new ServiceUnavailableException(
        'Resolução autoritativa de storage indisponível.',
      );
    }

    if (reference.owner.resourceType === 'domain-storage-key') {
      throw new ForbiddenException(
        'Referência de storage sem recurso autoritativo.',
      );
    }

    if (!this.isSupportedOwnerType(reference.owner.resourceType)) {
      throw new ForbiddenException('Recurso de storage não autorizado.');
    }

    if (!this.isSupportedPurpose(reference.purpose)) {
      throw new ForbiddenException('Finalidade de storage não autorizada.');
    }

    const binding = await this.findPersistedStorageBinding(
      reference.tenantId,
      key,
      reference.owner,
    );
    if (!binding || !this.isPurposeCompatible(reference, binding, operation)) {
      throw new NotFoundException(
        'Objeto de storage não encontrado para o recurso autorizado.',
      );
    }

    const authorized = {
      ...this.createReference({
        tenantId: binding.tenantId,
        key: binding.key,
        owner: {
          resourceType: binding.ownerType,
          resourceId: binding.ownerId,
        },
        purpose: binding.purpose,
        ...(binding.legacy ? { legacy: true } : {}),
      }),
      ...(binding.legacy ? { legacy: true } : {}),
    };
    this.assertReference(authorized, operation);
    return this.markAuthorizedReference(authorized);
  }

  private markAuthorizedReference(
    reference: StorageObjectReference,
    operations: ReadonlySet<StorageOperation> = AUTHORIZED_REFERENCE_OPERATIONS,
  ): AuthorizedStorageObjectReference {
    this.authorizedReferences.add(reference);
    this.authorizedReferenceOperations.set(reference, operations);
    return markAuthorizedStorageReference(reference);
  }

  private isAuthorizedReference(
    reference: unknown,
  ): reference is AuthorizedStorageObjectReference {
    return (
      isAuthorizedStorageObjectReference(reference) &&
      this.authorizedReferences.has(reference)
    );
  }

  private isAuthorizedReferenceForOperation(
    reference: AuthorizedStorageObjectReference,
    operation: StorageOperation,
  ): boolean {
    return Boolean(
      this.authorizedReferenceOperations.get(reference)?.has(operation),
    );
  }

  private assertPrivilegedStorageAccess(
    input: PrivilegedStorageAccessInput,
  ): string {
    if (!this.tenantService.isSuperAdmin()) {
      throw new ForbiddenException(
        'Acesso físico privilegiado de DR exige contexto super-admin explícito.',
      );
    }

    const tenantId = String(input?.tenantId || '').trim();
    const ownerType = String(input?.owner?.resourceType || '').trim();
    const ownerId = String(input?.owner?.resourceId || '').trim();
    const purpose = String(input?.purpose || '').trim();
    if (
      !tenantId ||
      ownerType !== 'disaster-recovery' ||
      !['integrity-scan', 'storage-replication'].includes(ownerId) ||
      ![
        'disaster-recovery-integrity',
        'disaster-recovery-replication',
      ].includes(purpose)
    ) {
      throw new ForbiddenException(
        'Referência física privilegiada de DR inválida.',
      );
    }

    const rawKey = String(input?.key || '');
    const cleanKey = sanitizeS3Key(rawKey);
    if (!cleanKey || cleanKey !== rawKey) {
      throw new ForbiddenException('Chave física de DR inválida.');
    }

    return cleanKey;
  }

  private async findPersistedStorageBinding(
    tenantId: string,
    key: string,
    owner: StorageObjectReference['owner'],
  ): Promise<{
    tenantId: string;
    key: string;
    ownerType: string;
    ownerId: string;
    purpose: string;
    legacy: boolean;
  } | null> {
    const normalizedTenantId = tenantId.trim();
    const normalizedKey = key.trim();
    const normalizedType = owner.resourceType.trim();
    const normalizedOwnerId = owner.resourceId.trim();

    if (this.isRegistryOwnerType(normalizedType)) {
      const rows = await this.dataSource!.query<Array<Record<string, unknown>>>(
        `SELECT company_id, file_key, module, entity_id, status, deleted_at
           FROM document_registry
          WHERE company_id = $1
            AND module = $2
            AND entity_id = $3
            AND file_key = $4
            AND status = 'ACTIVE'
            AND deleted_at IS NULL
          LIMIT 1`,
        [normalizedTenantId, normalizedType, normalizedOwnerId, normalizedKey],
      );
      const row = rows[0];
      if (row) {
        return {
          tenantId: String(row.company_id),
          key: String(row.file_key),
          ownerType: String(row.module),
          ownerId: String(row.entity_id),
          purpose: `document-registry:${String(row.module)}:pdf`,
          legacy: !this.isNewTenantKey(String(row.file_key)),
        };
      }
    }

    if (normalizedType === 'rdo-activity-photo') {
      const rows = await this.dataSource!.query<Array<Record<string, unknown>>>(
        `SELECT r.company_id, $3::text AS storage_key
           FROM rdos r
          WHERE r.company_id = $1
            AND r.id = $2
            AND r.deleted_at IS NULL
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(
                  COALESCE(r.servicos_executados::jsonb, '[]'::jsonb)
                ) AS activity
                CROSS JOIN LATERAL jsonb_array_elements(
                  COALESCE(activity->'fotos', '[]'::jsonb)
                ) AS photo
               WHERE photo->>'fileKey' = $3
                  OR photo #>> '{}' = $3
            )
          LIMIT 1`,
        [normalizedTenantId, normalizedOwnerId, normalizedKey],
      );
      const row = rows[0];
      if (row) {
        return {
          tenantId: String(row.company_id),
          key: String(row.storage_key),
          ownerType: normalizedType,
          ownerId: normalizedOwnerId,
          purpose: 'rdo-activity-photo',
          legacy: !this.isNewTenantKey(String(row.storage_key)),
        };
      }
    }

    if (normalizedType === 'cat-attachment') {
      const rows = await this.dataSource!.query<Array<Record<string, unknown>>>(
        `SELECT c.company_id, c.attachments
           FROM cats c
          WHERE c.company_id = $1
            AND c.id = $2
            AND c.deleted_at IS NULL
          LIMIT 1`,
        [normalizedTenantId, normalizedOwnerId],
      );
      const row = rows[0];
      const attachments = this.parseJsonArray(row?.attachments);
      const isBound = attachments.some((attachment) => {
        if (!attachment || typeof attachment !== 'object') return false;
        const fileKey = (attachment as Record<string, unknown>).file_key;
        return typeof fileKey === 'string' && fileKey === normalizedKey;
      });
      if (row && isBound) {
        return {
          tenantId: String(row.company_id),
          key: normalizedKey,
          ownerType: normalizedType,
          ownerId: normalizedOwnerId,
          purpose: 'cat-attachment',
          legacy: !this.isNewTenantKey(normalizedKey),
        };
      }
    }

    if (normalizedType === 'nc-attachment') {
      const rows = await this.dataSource!.query<Array<Record<string, unknown>>>(
        `SELECT n.company_id, n.anexos
           FROM nonconformities n
          WHERE n.company_id = $1
            AND n.id = $2
            AND n.deleted_at IS NULL
          LIMIT 1`,
        [normalizedTenantId, normalizedOwnerId],
      );
      const row = rows[0];
      const attachments = this.parseJsonArray(row?.anexos);
      const isBound = attachments.some((attachment) => {
        if (typeof attachment !== 'string') return false;
        return this.encodedStorageReferenceMatches(
          attachment,
          normalizedKey,
          'gst:nc-attachment:',
        );
      });
      if (row && isBound) {
        return {
          tenantId: String(row.company_id),
          key: normalizedKey,
          ownerType: normalizedType,
          ownerId: normalizedOwnerId,
          purpose: 'nc-attachment',
          legacy: !this.isNewTenantKey(normalizedKey),
        };
      }
    }

    if (normalizedType === 'checklist-photo') {
      const rows = await this.dataSource!.query<Array<Record<string, unknown>>>(
        `SELECT c.company_id, c.foto_equipamento, c.itens
           FROM checklists c
          WHERE c.company_id = $1
            AND c.id = $2
            AND c.deleted_at IS NULL
          LIMIT 1`,
        [normalizedTenantId, normalizedOwnerId],
      );
      const row = rows[0];
      const itemValues = this.parseJsonArray(row?.itens).flatMap((item) =>
        item && typeof item === 'object'
          ? this.parseJsonArray((item as Record<string, unknown>).fotos)
          : [],
      );
      const isBound = [row?.foto_equipamento, ...itemValues].some((value) =>
        this.encodedStorageReferenceMatches(
          value,
          normalizedKey,
          'gst:checklist-photo:',
        ),
      );
      if (row && isBound) {
        return {
          tenantId: String(row.company_id),
          key: normalizedKey,
          ownerType: normalizedType,
          ownerId: normalizedOwnerId,
          purpose: 'checklist-photo',
          legacy: !this.isNewTenantKey(normalizedKey),
        };
      }
    }

    if (
      normalizedType === 'pt-photo' ||
      normalizedType === 'pt-checklist-attachment'
    ) {
      const rows = await this.dataSource!.query<Array<Record<string, unknown>>>(
        `SELECT p.company_id,
                p.fotos_evidencia,
                p.trabalho_altura_checklist,
                p.trabalho_eletrico_checklist,
                p.trabalho_quente_checklist,
                p.trabalho_espaco_confinado_checklist,
                p.trabalho_escavacao_checklist
           FROM pts p
          WHERE p.company_id = $1
            AND p.id = $2
            AND p.deleted_at IS NULL
          LIMIT 1`,
        [normalizedTenantId, normalizedOwnerId],
      );
      const row = rows[0];
      const photoValues = this.parseJsonArray(row?.fotos_evidencia);
      const checklistValues = [
        row?.trabalho_altura_checklist,
        row?.trabalho_eletrico_checklist,
        row?.trabalho_quente_checklist,
        row?.trabalho_espaco_confinado_checklist,
        row?.trabalho_escavacao_checklist,
      ].flatMap((value) =>
        this.parseJsonArray(value).flatMap((item) =>
          item && typeof item === 'object'
            ? [
                (item as Record<string, unknown>).anexo_ref,
                (item as Record<string, unknown>).fileKey,
              ]
            : [],
        ),
      );
      const expectedPrefix =
        normalizedType === 'pt-photo'
          ? 'gst:pt-photo:'
          : 'gst:pt-checklist-anexo:';
      const isBound = [
        ...(normalizedType === 'pt-photo' ? photoValues : checklistValues),
      ].some((value) =>
        this.encodedStorageReferenceMatches(
          value,
          normalizedKey,
          expectedPrefix,
        ),
      );
      if (row && isBound) {
        return {
          tenantId: String(row.company_id),
          key: normalizedKey,
          ownerType: normalizedType,
          ownerId: normalizedOwnerId,
          purpose: normalizedType,
          legacy: !this.isNewTenantKey(normalizedKey),
        };
      }
    }

    if (normalizedType === 'nc-photo') {
      const rows = await this.dataSource!.query<Array<Record<string, unknown>>>(
        `SELECT n.company_id, n.fotos_evidencia, n.fotos_verificacao
           FROM nonconformities n
          WHERE n.company_id = $1
            AND n.id = $2
            AND n.deleted_at IS NULL
          LIMIT 1`,
        [normalizedTenantId, normalizedOwnerId],
      );
      const row = rows[0];
      const photoValues = [
        ...this.parseJsonArray(row?.fotos_evidencia),
        ...this.parseJsonArray(row?.fotos_verificacao),
      ];
      const isBound = photoValues.some(
        (value) =>
          this.encodedStorageReferenceMatches(
            value,
            normalizedKey,
            'gst:nc-foto-evidencia:',
          ) ||
          this.encodedStorageReferenceMatches(
            value,
            normalizedKey,
            'gst:nc-foto-verificacao:',
          ),
      );
      if (row && isBound) {
        return {
          tenantId: String(row.company_id),
          key: normalizedKey,
          ownerType: normalizedType,
          ownerId: normalizedOwnerId,
          purpose: normalizedType,
          legacy: !this.isNewTenantKey(normalizedKey),
        };
      }
    }

    const definition = this.domainBindingDefinition(normalizedType);
    if (!definition) return null;
    const rows = await this.dataSource!.query<Array<Record<string, unknown>>>(
      `SELECT ${definition.tenantColumn} AS tenant_id,
              ${definition.keyColumn} AS storage_key
         FROM ${definition.table}
        WHERE ${definition.tenantColumn} = $1
          AND ${definition.idColumn || 'id'} = $2
          AND ${definition.keyColumn} = $3
          AND ${definition.keyColumn} IS NOT NULL
        LIMIT 1`,
      [normalizedTenantId, normalizedOwnerId, normalizedKey],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      tenantId: String(row.tenant_id),
      key: String(row.storage_key),
      ownerType: normalizedType,
      ownerId: normalizedOwnerId,
      purpose: definition.purpose,
      legacy: !this.isNewTenantKey(String(row.storage_key)),
    };
  }

  private domainBindingDefinition(resourceType: string): {
    table: string;
    tenantColumn: string;
    keyColumn: string;
    idColumn?: string;
    purpose: string;
  } | null {
    const definitions: Record<
      string,
      {
        table: string;
        tenantColumn: string;
        keyColumn: string;
        idColumn?: string;
        purpose: string;
      }
    > = {
      apr: {
        table: 'aprs',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'apr-pdf',
      },
      arr: {
        table: 'arrs',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'arr-pdf',
      },
      audit: {
        table: 'audits',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'audit-pdf',
      },
      cat: {
        table: 'cats',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'cat-pdf',
      },
      checklist: {
        table: 'checklists',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'checklist-pdf',
      },
      dds: {
        table: 'dds',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'dds-pdf',
      },
      did: {
        table: 'dids',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'did-pdf',
      },
      epi: {
        table: 'epi_assignments',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'epi-pdf',
      },
      nonconformity: {
        table: 'nonconformities',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'nonconformity-pdf',
      },
      photographic_report: {
        table: 'photographic_reports',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'photographic-report-pdf',
      },
      pt: {
        table: 'pts',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'pt-pdf',
      },
      rdo: {
        table: 'rdos',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'rdo-pdf',
      },
      training: {
        table: 'trainings',
        tenantColumn: 'company_id',
        keyColumn: 'pdf_file_key',
        purpose: 'training-pdf',
      },
      company: {
        table: 'companies',
        tenantColumn: 'id',
        keyColumn: 'logo_storage_key',
        purpose: 'company-logo',
      },
      signature: {
        table: 'signatures',
        tenantColumn: 'company_id',
        keyColumn: 'signature_data_key',
        purpose: 'signature-data',
      },
      'document-video': {
        table: 'document_video_attachments',
        tenantColumn: 'company_id',
        keyColumn: 'storage_key',
        purpose: 'document-video',
      },
      'document-import': {
        table: 'document_imports',
        tenantColumn: 'empresa_id',
        keyColumn: 'arquivo_staging_key',
        purpose: 'document-import-staging',
      },
      'expense-item': {
        table:
          'expense_items item JOIN expense_reports report ON report.id = item.report_id',
        tenantColumn: 'report.company_id',
        keyColumn: 'item.receipt_file_key',
        idColumn: 'item.id',
        purpose: 'expense-item',
      },
      'photographic-report-image': {
        table: 'photographic_report_images',
        tenantColumn: 'company_id',
        keyColumn: 'image_url',
        purpose: 'photographic-report-image',
      },
      'apr-evidence': {
        table:
          'apr_risk_evidences evidence JOIN aprs apr ON apr.id = evidence.apr_id',
        tenantColumn: 'apr.company_id',
        keyColumn: 'evidence.file_key',
        idColumn: 'evidence.id',
        purpose: 'apr-evidence',
      },
      'apr-evidence-watermarked': {
        table:
          'apr_risk_evidences evidence JOIN aprs apr ON apr.id = evidence.apr_id',
        tenantColumn: 'apr.company_id',
        keyColumn: 'evidence.watermarked_file_key',
        idColumn: 'evidence.id',
        purpose: 'apr-evidence-watermarked',
      },
      'photographic-report-export': {
        table: 'photographic_report_exports',
        tenantColumn: 'company_id',
        keyColumn: 'file_url',
        purpose: 'photographic-report-export',
      },
    };
    return definitions[resourceType] || null;
  }

  private parseJsonArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private encodedStorageReferenceMatches(
    value: unknown,
    expectedKey: string,
    prefix: string,
  ): boolean {
    if (typeof value !== 'string' || !value.startsWith(prefix)) {
      return false;
    }
    const encodedPayload = value.slice(prefix.length);
    if (!encodedPayload) return false;

    const candidates = [
      encodedPayload,
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ];
    for (const candidate of candidates) {
      try {
        const payload = JSON.parse(candidate) as Record<string, unknown>;
        if (
          typeof payload.fileKey === 'string' &&
          payload.fileKey === expectedKey
        ) {
          return true;
        }
      } catch {
        // The next representation is attempted; malformed legacy values fail closed.
      }
    }
    return false;
  }

  private isRegistryOwnerType(resourceType: string): boolean {
    return new Set([
      'apr',
      'arr',
      'audit',
      'cat',
      'checklist',
      'dds',
      'did',
      'epi',
      'nonconformity',
      'photographic_report',
      'pt',
      'rdo',
      'training',
      'dossier',
      'report',
    ]).has(resourceType);
  }

  private isSupportedOwnerType(resourceType: string): boolean {
    return (
      this.isRegistryOwnerType(resourceType) ||
      Boolean(this.domainBindingDefinition(resourceType)) ||
      resourceType === 'cat-attachment' ||
      resourceType === 'nc-attachment' ||
      resourceType === 'rdo-activity-photo' ||
      resourceType === 'checklist-photo' ||
      resourceType === 'pt-photo' ||
      resourceType === 'pt-checklist-attachment' ||
      resourceType === 'nc-photo'
    );
  }

  private isSupportedPurpose(purpose: string): boolean {
    const boundedPurposes = new Set([
      'company-logo',
      'company-logo-cleanup',
      'signature-data-offload',
      'apr-evidence',
      'photographic-report-image',
      'photographic-report-export',
      'document-import-staging-upload',
      'document-video',
      'cat-attachment-upload',
      'checklist-photo',
      'pt-photo',
      'pt-checklist-attachment',
      'nc-photo',
      'cat-attachment',
      'nc-attachment',
      'rdo-pdf',
      'rdo-activity-photo-cleanup',
      'rdo-activity-photo',
      'rdo-pdf-cleanup',
      'apr-pdf-company-logo',
      'storage-quarantine-promotion',
      'storage-quarantine-upload',
      'p1-document-storage-uploadFile',
      'p1-document-storage-downloadFileBuffer',
      'p1-document-storage-deleteFile',
      'p1-document-storage-getSignedUrl',
      'p1-document-storage-getInlineViewUrl',
      'p1-document-storage-getPresignedDownloadUrl',
      'p1-document-storage-fileExists',
      'p1-document-storage-copyFile',
      'p1-document-storage-moveFile',
      'p1-document-storage-replaceFile',
    ]);
    return boundedPurposes.has(purpose);
  }

  private assertNewUploadReference(
    reference: StorageObjectReference,
    key: string,
    options: { allowQuarantine?: boolean } = {},
  ): void {
    const isQuarantine =
      key.startsWith('quarantine/') &&
      reference.owner.resourceType === 'upload' &&
      reference.owner.resourceId === key &&
      (reference.purpose === 'storage-quarantine-upload' ||
        reference.purpose === 'storage-quarantine-promotion');

    if (isQuarantine && options.allowQuarantine) return;

    const isQuarantinePromotion =
      key.startsWith('documents/') &&
      reference.owner.resourceType === 'upload' &&
      reference.owner.resourceId.startsWith('quarantine/') &&
      reference.purpose === 'storage-quarantine-promotion';

    if (isQuarantinePromotion) return;

    if (this.isNewTenantKey(key)) {
      if (!this.isSupportedOwnerType(reference.owner.resourceType)) {
        throw new ForbiddenException('Recurso de storage não autorizado.');
      }
      if (!this.isSupportedPurpose(reference.purpose)) {
        throw new ForbiddenException('Finalidade de storage não autorizada.');
      }
      return;
    }

    throw new ForbiddenException(
      'Novos objetos exigem chave tenant-scoped e contrato governado.',
    );
  }

  private isPurposeCompatible(
    reference: StorageObjectReference,
    binding: { purpose: string },
    operation: StorageOperation,
  ): boolean {
    if (reference.purpose === binding.purpose) return true;
    if (!reference.purpose.startsWith('p1-document-storage-')) return false;
    return (
      new Set([
        'download',
        'downloadFileBuffer',
        'delete',
        'getSignedUrl',
        'getInlineViewUrl',
        'getPresignedDownloadUrl',
        'fileExists',
        'copyFile',
        'moveFile',
        'replaceFile',
      ]).has(reference.purpose.slice('p1-document-storage-'.length)) &&
      operation !== 'upload'
    );
  }

  private storageDiagnosticFingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  private assertReference(
    reference: StorageObjectReference,
    operation: StorageOperation,
    options: { allowUnresolvedLegacy?: boolean } = {},
  ): string {
    if (!reference || typeof reference !== 'object') {
      throw new BadRequestException(
        'Referência de storage governada é obrigatória.',
      );
    }
    const tenantId = String(reference.tenantId || '')
      .trim()
      .toLowerCase();
    const currentTenant = String(this.tenantService.getTenantId() || '')
      .trim()
      .toLowerCase();
    const resourceType = String(reference.owner?.resourceType || '').trim();
    const resourceId = String(reference.owner?.resourceId || '').trim();
    const purpose = String(reference.purpose || '').trim();
    const key = String(reference.key || '');

    if (!tenantId || !currentTenant) {
      throw new BadRequestException(
        'Contexto de tenant é obrigatório para storage governado.',
      );
    }
    if (tenantId !== currentTenant) {
      throw new ForbiddenException(
        'Acesso negado: storage pertence a outra empresa.',
      );
    }
    if (!resourceType || !resourceId || !purpose) {
      throw new BadRequestException(
        'Storage requer tenant, owner/resource e purpose explícitos.',
      );
    }

    const cleanKey = sanitizeS3Key(key);
    if (!cleanKey || cleanKey !== key) {
      throw new ForbiddenException('Chave de storage inválida.');
    }

    const keyTenantId = this.extractKeyTenantId(cleanKey);
    if (keyTenantId && keyTenantId.toLowerCase() !== tenantId) {
      this.logger.error({
        event: 'presigned_url_tenant_mismatch',
        severity: 'CRITICAL',
        expectedTenantFingerprint: this.storageDiagnosticFingerprint(tenantId),
        fileKeyTenantFingerprint:
          this.storageDiagnosticFingerprint(keyTenantId),
        keyFingerprint: this.storageDiagnosticFingerprint(cleanKey),
      });
      throw new ForbiddenException(
        'Acesso negado: documento pertence a outra empresa.',
      );
    }

    if (!keyTenantId && !reference.legacy && !options.allowUnresolvedLegacy) {
      throw new ForbiddenException(
        'Chave histórica exige referência de compatibilidade explícita.',
      );
    }

    if (reference.legacy && this.isNewTenantKey(cleanKey)) {
      throw new BadRequestException(
        'Chave nova não pode ser marcada como legado.',
      );
    }

    if (operation === 'upload' && reference.legacy) {
      throw new BadRequestException(
        'Criação de novos objetos em layout legado está bloqueada.',
      );
    }

    if (operation === 'presign' && cleanKey.startsWith('quarantine/')) {
      throw new ForbiddenException(
        'Acesso negado: objeto em quarentena não pode receber URL de download.',
      );
    }

    return cleanKey;
  }

  private assertPrefixReference(reference: StoragePrefixReference): string {
    const syntheticReference: StorageObjectReference = {
      tenantId: reference.tenantId,
      key: reference.prefix.replace(/\/$/, '') + '/__prefix_marker__',
      owner: reference.owner,
      purpose: reference.purpose,
      legacy: reference.legacy,
    };
    const cleanMarker = this.assertReference(syntheticReference, 'list');
    return cleanMarker.slice(0, -'__prefix_marker__'.length);
  }

  private extractKeyTenantId(key: string): string | null {
    const segments = key.split('/');
    if (segments[0] === 'documents' || segments[0] === 'quarantine') {
      return segments[1] || null;
    }
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        segments[0] || '',
      )
    ) {
      return segments[0];
    }
    return null;
  }

  private isNewTenantKey(key: string): boolean {
    return Boolean(this.extractKeyTenantId(key));
  }

  private shouldUseManagedStorage(): boolean {
    return Boolean(this.configService.get<string>('AWS_BUCKET_NAME'));
  }

  private shouldUseLegacyS3(): boolean {
    return Boolean(this.configService.get<string>('AWS_S3_BUCKET'));
  }

  private getLocalFsStorageDir(): string | null {
    if (this.localStorageDirCache !== undefined) {
      return this.localStorageDirCache;
    }

    const explicit = this.configService
      .get<string>('LOCAL_DOCUMENT_STORAGE_DIR')
      ?.trim();
    if (explicit) {
      if (process.env.NODE_ENV === 'production') {
        // Storage local com múltiplas instâncias causa perda de dados: uploads vão para o
        // disco da instância A e são inacessíveis na instância B após autoscale.
        this.logger.error({
          event: 'document_storage_local_fs_blocked_in_production',
          reason:
            'LOCAL_DOCUMENT_STORAGE_DIR ignorado em produção. Configure AWS_BUCKET_NAME.',
        });
        this.localStorageDirCache = null;
        return null;
      }
      this.localStorageDirCache = explicit;
      return explicit;
    }

    // Dev fallback: sem S3 configurado, gravar em disco local para manter o módulo funcional.
    if (
      process.env.NODE_ENV === 'development' &&
      !this.shouldUseManagedStorage() &&
      !this.shouldUseLegacyS3()
    ) {
      const fallback = path.resolve(
        process.cwd(),
        'temp',
        'local-document-storage',
      );
      this.localStorageDirCache = fallback;
      this.logger.warn({
        event: 'document_storage_local_fs_fallback_enabled',
        storageDir: fallback,
      });
      return fallback;
    }

    this.localStorageDirCache = null;
    return null;
  }

  private shouldUseLocalFsStorage(): boolean {
    return Boolean(this.getLocalFsStorageDir());
  }

  private shouldUseRestrictedAppDownload(key: string): boolean {
    return key.startsWith('documents/') && /\.pdf$/i.test(key);
  }

  private ensureStorageConfigured(
    action: 'upload' | 'presign' | 'download' | 'delete',
  ): void {
    if (
      this.shouldUseManagedStorage() ||
      this.shouldUseLegacyS3() ||
      this.shouldUseLocalFsStorage()
    ) {
      return;
    }

    throw new ServiceUnavailableException({
      error: 'DOCUMENT_STORAGE_UNAVAILABLE',
      message:
        'Armazenamento documental indisponível. Configure o storage antes de anexar, emitir ou acessar artefatos governados.',
      details: {
        action,
        storageConfigured: false,
      },
    });
  }

  private handleStorageError(
    action: 'upload' | 'presign' | 'download' | 'delete',
    key: string,
    error: unknown,
  ): never {
    const message =
      extractResilienceErrorMessage(error) || 'Erro desconhecido no storage.';
    const code = extractResilienceErrorCode(error);
    const status = extractResilienceErrorStatus(error);
    const keyFingerprint = this.storageDiagnosticFingerprint(key);
    const diagnosticMessage = message.includes(key)
      ? message.replaceAll(key, `[key:${keyFingerprint}]`)
      : message;
    const storageNotEnabled =
      /s3 is not enabled/i.test(message) ||
      code === 'STORAGE_NOT_CONFIGURED' ||
      code === 'DOCUMENT_STORAGE_UNAVAILABLE';

    if (storageNotEnabled) {
      this.logger.warn({
        event: 'document_storage_operation_unavailable',
        action,
        keyFingerprint,
        code,
        status,
        message: diagnosticMessage,
      });
    } else {
      this.logger.error({
        event: 'document_storage_operation_failed',
        action,
        keyFingerprint,
        code,
        status,
        message: diagnosticMessage,
      });
    }

    if (
      error instanceof ForbiddenException ||
      error instanceof ServiceUnavailableException ||
      error instanceof NotFoundException
    ) {
      throw error;
    }

    if (
      status === 404 ||
      code === 'NotFound' ||
      code === 'NoSuchKey' ||
      /nao encontrado|não encontrado|not found|no such key/i.test(message)
    ) {
      throw new NotFoundException({
        error: 'DOCUMENT_STORAGE_OBJECT_NOT_FOUND',
        message:
          'O artefato oficial foi referenciado, mas não está disponível no storage governado.',
        details: {
          action,
          code,
          status,
        },
      });
    }

    throw new ServiceUnavailableException({
      error: 'DOCUMENT_STORAGE_OPERATION_FAILED',
      message:
        action === 'presign'
          ? 'Não foi possível resolver a URL segura do artefato governado no momento.'
          : 'O storage governado está temporariamente indisponível para esta operação.',
      details: {
        action,
        code,
        status,
      },
    });
  }

  private async toBuffer(file: Buffer | Readable): Promise<Buffer> {
    if (Buffer.isBuffer(file)) {
      return file;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of file) {
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === 'string'
            ? Buffer.from(chunk)
            : Buffer.from(chunk as Uint8Array),
      );
    }
    return Buffer.concat(chunks);
  }

  private resolveLocalFilePath(key: string): string {
    const baseDir = this.getLocalFsStorageDir();
    if (!baseDir) {
      throw new Error('Local FS storage dir não configurado.');
    }

    // Normaliza separadores e impede path traversal.
    const normalizedKey = key.replace(/\\/g, '/').replace(/^\/+/, '');
    const resolvedBase = path.resolve(baseDir);
    const resolved = path.resolve(resolvedBase, normalizedKey);
    if (!resolved.startsWith(resolvedBase + path.sep)) {
      throw new Error('Chave de storage inválida (path traversal detectado).');
    }

    return resolved;
  }

  private async writeLocalFile(key: string, buffer: Buffer): Promise<void> {
    const target = this.resolveLocalFilePath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
  }

  private async readLocalFile(key: string): Promise<Buffer> {
    const target = this.resolveLocalFilePath(key);
    try {
      return await fs.readFile(target);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'ENOENT') {
        throw new NotFoundException({
          error: 'DOCUMENT_STORAGE_OBJECT_NOT_FOUND',
          message:
            'O artefato oficial foi referenciado, mas não está disponível no storage governado.',
          details: { action: 'download', key },
        });
      }
      throw error;
    }
  }

  private async deleteLocalFile(key: string): Promise<void> {
    const target = this.resolveLocalFilePath(key);
    try {
      await fs.unlink(target);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  private async localFileExists(key: string): Promise<boolean> {
    const target = this.resolveLocalFilePath(key);
    try {
      await fs.stat(target);
      return true;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  private async listLocalKeys(
    prefix: string,
    options?: { maxKeys?: number },
  ): Promise<string[]> {
    const baseDir = this.getLocalFsStorageDir();
    if (!baseDir) {
      return [];
    }

    const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/^\/+/, '');
    const prefixClean = normalizedPrefix.replace(/\/+$/, '');
    const resolvedBase = path.resolve(baseDir);
    const root = path.resolve(resolvedBase, normalizedPrefix);
    if (!root.startsWith(resolvedBase + path.sep)) {
      return [];
    }

    const maxKeys =
      options?.maxKeys && options.maxKeys > 0 ? options.maxKeys : null;
    const results: string[] = [];

    const walk = async (dir: string, relative: string) => {
      if (maxKeys && results.length >= maxKeys) {
        return;
      }
      let entries: Array<import('node:fs').Dirent>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === 'ENOENT') {
          return;
        }
        throw error;
      }

      for (const entry of entries) {
        if (maxKeys && results.length >= maxKeys) {
          return;
        }
        const nextRelative = relative
          ? `${relative}/${entry.name}`
          : entry.name;
        const nextPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(nextPath, nextRelative);
        } else if (entry.isFile()) {
          results.push(
            (prefixClean
              ? `${prefixClean}/${nextRelative}`
              : nextRelative
            ).replace(/^\/+/, ''),
          );
        }
      }
    };

    await walk(root, '');
    return results;
  }
}
