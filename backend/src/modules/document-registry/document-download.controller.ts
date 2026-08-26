import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Logger,
  Param,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../shared/decorators/public.decorator';
import { DocumentDownloadGrantService } from '../../shared/services/document-download-grant.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { SecurityAuditService } from '../../shared/security/security-audit.service';
import { isLikelySignedToken } from '../../shared/security/signed-token.util';
import { TenantService } from '../../shared/tenant/tenant.service';
import { DownloadTokenParamDto } from './dto/download-token-param.dto';

type DownloadRequest = Request & {
  tenant?: {
    userId?: string | null;
  };
};

@Controller('storage')
export class DocumentDownloadController {
  private readonly logger = new Logger(DocumentDownloadController.name);

  constructor(
    private readonly documentDownloadGrantService: DocumentDownloadGrantService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly securityAudit: SecurityAuditService,
    private readonly tenantService: TenantService,
  ) {}

  @Public()
  @Get('download/:token')
  // 20 downloads por minuto por IP: suficiente para usuário legítimo,
  // impossibilita enumeração automática de tokens.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Cache-Control', 'private, no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadDocument(
    @Param() params: DownloadTokenParamDto,
    @Req() req: DownloadRequest,
    @Res() res: Response,
  ): Promise<void> {
    const ip = req.ip ?? req.socket?.remoteAddress;
    const token = params.token;
    const normalizedToken = String(token || '').trim();

    if (!this.isLikelyDownloadToken(normalizedToken)) {
      this.securityAudit.bruteForceBlocked(ip, 'token_format:invalid');
      throw new ForbiddenException(
        'Token de download inválido, expirado ou já consumido.',
      );
    }

    let grant: Awaited<
      ReturnType<DocumentDownloadGrantService['consumeToken']>
    >;
    try {
      grant = await this.documentDownloadGrantService.consumeToken(
        normalizedToken,
        {
          consumerUserId: req.tenant?.userId ?? null,
        },
      );
    } catch (err) {
      // Token inválido, expirado ou já consumido — registra tentativa suspeita.
      this.securityAudit.bruteForceBlocked(
        ip,
        'token_rejected:invalid_or_expired',
      );
      throw err;
    }

    let buffer: Buffer;
    try {
      buffer = await this.tenantService.run(
        {
          companyId: grant.company_id,
          isSuperAdmin: false,
          siteScope: 'all',
        },
        () =>
          this.documentStorageService.downloadFileBuffer(
            this.documentDownloadGrantService.getAuthorizedReference(grant),
          ),
      );
    } catch {
      throw new ServiceUnavailableException(
        'Documento indisponível temporariamente no storage governado.',
      );
    }

    // Trilha forense: qualquer download de documento governado é evento WARNING.
    this.securityAudit.sensitiveDownload(
      grant.issued_for_user_id ?? 'anonymous',
      'document-registry',
      grant.id,
      'PDF',
    );

    const filename =
      this.sanitizeFilename(grant.original_name) ||
      grant.file_key.split('/').pop() ||
      'documento.pdf';

    res.setHeader('Content-Type', grant.content_type || 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );
    res.send(buffer);
  }

  private sanitizeFilename(value: string | null): string | null {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return null;
    }

    return normalized.replace(/[^\w.\- ]+/g, '_');
  }

  private isLikelyDownloadToken(token: string): boolean {
    return isLikelySignedToken(token);
  }
}
