import {
  Controller,
  Post,
  Body,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  ForbiddenException,
  Req,
  Logger,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { JwtAuthGuard } from '../../modules/auth/jwt-auth.guard';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { randomUUID } from 'crypto';
import { TenantService } from '../../shared/tenant/tenant.service';
import { RolesGuard } from '../../modules/auth/roles.guard';
import { Roles } from '../../modules/auth/roles.decorator';
import { Role } from '../../modules/auth/enums/roles.enum';
import { Authorize } from '../../modules/auth/authorize.decorator';
import { AuditService } from '../../modules/audit-trail/audit.service';
import { AuditAction } from '../../modules/audit-trail/enums/audit-action.enum';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { UserThrottle } from '../../shared/decorators/user-throttle.decorator';
import { TenantThrottle } from '../../shared/decorators/tenant-throttle.decorator';
import { assertQuarantineKey } from '../../shared/utils/s3-key.util';
import { getRequestIp } from '../../shared/utils/request-ip.util';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  CompleteUploadRequestDto,
  CompleteUploadResponseDto,
  CreatePresignedUploadRequestDto,
  CreatePresignedUploadResponseDto,
} from './dto/storage-upload.dto';

/** TTL para presigned upload URL: 10 minutos (P0 guardrail) */
const PRESIGNED_UPLOAD_TTL_SECONDS = 600;

/** Tamanho máximo permitido para documentos: 50 MB */
const MAX_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024;

/** Magic bytes do PDF: começa com "%PDF-" */
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');

function hasPdfMagicBytes(buffer: Buffer): boolean {
  if (buffer.length < 5) return false;
  return buffer.subarray(0, 5).equals(PDF_MAGIC);
}

function storageKeyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

@Controller('storage')
@ApiTags('storage')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
export class StorageController {
  private readonly logger = new Logger(StorageController.name);

  constructor(
    private readonly documentStorageService: DocumentStorageService,
    private readonly tenantService: TenantService,
    private readonly auditService: AuditService,
    private readonly fileInspectionService: FileInspectionService,
  ) {}

  /**
   * Emite uma presigned URL de upload para quarentena.
   * O arquivo vai para `quarantine/{tenantId}/{uuid}.pdf` e só é promovido
   * para `documents/` após validação no endpoint /storage/complete-upload.
   */
  @Post('presigned-url')
  @UserThrottle({ requestsPerMinute: 5 })
  @TenantThrottle({ requestsPerMinute: 20, requestsPerHour: 100 })
  @ApiOperation({
    summary:
      'Etapa 1 do fluxo governado de upload: reserva uma URL presignada para quarentena.',
    description:
      'Contrato atual: POST /storage/presigned-url -> PUT no storage -> POST /storage/complete-upload. A promoção para documents/ não acontece mais no PUT.',
  })
  @ApiBody({ type: CreatePresignedUploadRequestDto })
  @ApiCreatedResponse({ type: CreatePresignedUploadResponseDto })
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_import_documents')
  async getPresignedUrl(
    @Body() body: CreatePresignedUploadRequestDto,
    @Req()
    req: {
      user?: { userId?: string; id?: string; company_id?: string };
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    },
  ) {
    if (!body.filename) {
      throw new BadRequestException('Filename é obrigatório');
    }

    // Guardrail P0: aceitar somente application/pdf (contentType)
    const contentType = body.contentType || 'application/pdf';
    if (contentType !== 'application/pdf') {
      throw new BadRequestException('Apenas arquivos PDF são permitidos');
    }

    // Guardrail P0: aceitar somente extensão .pdf (independente do nome enviado)
    const lowerFilename = body.filename.toLowerCase().trim();
    if (!lowerFilename.endsWith('.pdf')) {
      throw new BadRequestException(
        'Extensão de arquivo inválida. Apenas .pdf é permitido',
      );
    }

    const tenantId = this.tenantService.getTenantId();
    const isSuperAdmin = this.tenantService.isSuperAdmin();
    if (!tenantId && !isSuperAdmin) {
      throw new BadRequestException('Contexto de empresa não definido.');
    }
    if (!tenantId && isSuperAdmin) {
      throw new BadRequestException(
        'Administrador Geral: selecione uma empresa via header x-company-id.',
      );
    }

    // P1 guardrail: arquivo vai para quarentena — não para documents/ diretamente
    const quarantineKey = `quarantine/${tenantId!}/${randomUUID()}.pdf`;
    const quarantineReference =
      this.documentStorageService.referenceForExistingObject(
        quarantineKey,
        { resourceType: 'upload', resourceId: quarantineKey },
        'storage-quarantine-upload',
      );

    // Guardrail P0: TTL de 10 minutos (reduzido de 1h)
    const uploadUrl = await this.documentStorageService.getPresignedUploadUrl(
      quarantineReference,
      contentType,
      PRESIGNED_UPLOAD_TTL_SECONDS,
    );

    // Guardrail P0: auditoria ao emitir URL de upload
    const actorId = req.user?.userId || req.user?.id || 'unknown';
    const ip = getRequestIp(req) ?? 'unknown';
    const userAgent = String(
      req.headers?.['user-agent'] ?? 'unknown',
    ).substring(0, 255);

    try {
      await this.auditService.log({
        userId: actorId,
        action: AuditAction.CREATE,
        entity: 'presigned_upload_url',
        entityId: storageKeyFingerprint(quarantineKey),
        changes: {
          after: {
            keyFingerprint: storageKeyFingerprint(quarantineKey),
            tenantId,
            contentType,
            ttlSeconds: PRESIGNED_UPLOAD_TTL_SECONDS,
            destination: 'quarantine',
          },
        },
        ip,
        userAgent,
        companyId: tenantId!,
      });
    } catch (auditError) {
      this.logger.error({
        event: 'storage_quarantine_audit_failed',
        keyFingerprint: storageKeyFingerprint(quarantineKey),
        errorName:
          auditError instanceof Error ? auditError.name : 'unknown_error',
      });
    }

    return {
      uploadUrl,
      fileKey: quarantineKey,
      expiresIn: PRESIGNED_UPLOAD_TTL_SECONDS,
    };
  }

  /**
   * Valida e promove um arquivo da quarentena para documents/.
   *
   * Fluxo:
   *   1. Verifica que fileKey pertence à quarentena do tenant correto
   *   2. Faz download do arquivo do S3
   *   3. Valida magic bytes (PDF), tamanho e SHA-256 opcional
   *   4. Executa inspeção AV/CDR (fail-closed em produção)
   *   5. Copia para documents/{tenantId}/{uuid}.pdf
   *   6. Remove da quarentena
   *   7. Retorna nova chave promovida + metadados validados
   */
  @Post('complete-upload')
  @UserThrottle({ requestsPerMinute: 5 })
  @TenantThrottle({ requestsPerMinute: 20, requestsPerHour: 100 })
  @ApiOperation({
    summary:
      'Etapa 3 do fluxo governado de upload: valida o arquivo enviado e promove para documents/.',
    description:
      'Este endpoint deve ser chamado somente após o PUT bem-sucedido na URL presignada retornada por POST /storage/presigned-url.',
  })
  @ApiBody({ type: CompleteUploadRequestDto })
  @ApiCreatedResponse({ type: CompleteUploadResponseDto })
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_import_documents')
  async completeUpload(
    @Body() body: CompleteUploadRequestDto,
    @Req()
    req: {
      user?: { userId?: string; id?: string };
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    },
  ) {
    if (!body.fileKey) {
      throw new BadRequestException('fileKey é obrigatório');
    }

    const tenantId = this.tenantService.getTenantId();
    const isSuperAdmin = this.tenantService.isSuperAdmin();
    if (!tenantId && !isSuperAdmin) {
      throw new BadRequestException('Contexto de empresa não definido.');
    }
    if (!tenantId && isSuperAdmin) {
      throw new BadRequestException(
        'Administrador Geral: selecione uma empresa via header x-company-id.',
      );
    }

    // Validar formato estrito da chave: `quarantine/{tenantId}/{uuid}.pdf`
    // Cobre path traversal, null bytes, caracteres de controle e cross-tenant.
    try {
      assertQuarantineKey(body.fileKey, tenantId!);
    } catch (e) {
      throw new ForbiddenException(
        e instanceof Error ? e.message : 'fileKey inválida.',
      );
    }

    const quarantineReference =
      this.documentStorageService.referenceForExistingObject(
        body.fileKey,
        { resourceType: 'upload', resourceId: body.fileKey },
        'storage-quarantine-promotion',
      );

    // Baixar arquivo do S3 para validação server-side
    let fileBuffer: Buffer;
    try {
      fileBuffer =
        await this.documentStorageService.downloadFileBuffer(
          quarantineReference,
        );
    } catch {
      throw new BadRequestException(
        'Arquivo não encontrado na quarentena. Verifique se o upload foi concluído.',
      );
    }

    // Validar tamanho
    if (fileBuffer.length === 0) {
      throw new BadRequestException('Arquivo enviado está vazio.');
    }
    if (fileBuffer.length > MAX_DOCUMENT_SIZE_BYTES) {
      await this.documentStorageService
        .deleteFile(quarantineReference)
        .catch(() => undefined);
      throw new BadRequestException(
        `Arquivo excede o tamanho máximo permitido (${MAX_DOCUMENT_SIZE_BYTES / 1024 / 1024} MB).`,
      );
    }

    // Validar magic bytes (PDF)
    if (!hasPdfMagicBytes(fileBuffer)) {
      await this.documentStorageService
        .deleteFile(quarantineReference)
        .catch(() => undefined);
      throw new BadRequestException(
        'O arquivo não é um PDF válido (magic bytes inválidos).',
      );
    }

    // Validar SHA-256 se informado pelo cliente
    if (body.sha256) {
      const actualHash = createHash('sha256')
        .update(fileBuffer)
        .digest('hex')
        .toLowerCase();
      const expectedHash = body.sha256.toLowerCase().trim();
      if (actualHash !== expectedHash) {
        await this.documentStorageService
          .deleteFile(quarantineReference)
          .catch(() => undefined);
        throw new BadRequestException(
          'Integridade do arquivo comprometida: SHA-256 não confere.',
        );
      }
    }

    // Inspeção AV/CDR — fail-closed em produção se não configurado
    const originalFilename = body.originalFilename || 'documento.pdf';
    await this.fileInspectionService.inspect(fileBuffer, originalFilename);

    // Promover para documents/
    const documentsKey = `documents/${tenantId!}/${randomUUID()}.pdf`;
    const documentsReference = this.documentStorageService.createReference({
      tenantId: tenantId!,
      key: documentsKey,
      owner: quarantineReference.owner,
      purpose: 'storage-quarantine-promotion',
    });
    await this.documentStorageService.uploadFile(
      documentsReference,
      fileBuffer,
      'application/pdf',
    );

    // Remover da quarentena (best-effort: falha não cancela a promoção)
    await this.documentStorageService
      .deleteFile(quarantineReference)
      .catch((deleteError) => {
        this.logger.warn({
          event: 'storage_quarantine_delete_failed',
          keyFingerprint: storageKeyFingerprint(body.fileKey),
          errorName:
            deleteError instanceof Error ? deleteError.name : 'unknown_error',
        });
      });

    // Auditoria da promoção
    const actorId = req.user?.userId || req.user?.id || 'unknown';
    const ip = getRequestIp(req) ?? 'unknown';
    const userAgent = String(
      req.headers?.['user-agent'] ?? 'unknown',
    ).substring(0, 255);

    try {
      await this.auditService.log({
        userId: actorId,
        action: AuditAction.CREATE,
        entity: 'document',
        entityId: storageKeyFingerprint(documentsKey),
        changes: {
          after: {
            documentsKeyFingerprint: storageKeyFingerprint(documentsKey),
            quarantineKeyFingerprint: storageKeyFingerprint(body.fileKey),
            tenantId,
            sizeBytes: fileBuffer.length,
            sha256Verified: !!body.sha256,
          },
        },
        ip,
        userAgent,
        companyId: tenantId!,
      });
    } catch (auditError) {
      this.logger.error({
        event: 'storage_promotion_audit_failed',
        keyFingerprint: storageKeyFingerprint(documentsKey),
        errorName:
          auditError instanceof Error ? auditError.name : 'unknown_error',
      });
    }

    return {
      fileKey: documentsKey,
      sizeBytes: fileBuffer.length,
      sha256Verified: !!body.sha256,
    };
  }
}
