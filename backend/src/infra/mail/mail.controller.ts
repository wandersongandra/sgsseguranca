import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Query,
  Param,
  UseGuards,
  UseInterceptors,
  Request,
  Res,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Response } from 'express';
import { readFile, unlink } from 'fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { resolveSgsTempDirectory } from '../../shared/temp-directory.util';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { UploadedFile } from '@nestjs/common';
import { MailService } from './mail.service';
import { MailDlqService } from './mail-dlq.service';
import { JwtAuthGuard } from '../../modules/auth/jwt-auth.guard';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { RolesGuard } from '../../modules/auth/roles.guard';
import { Roles } from '../../modules/auth/roles.decorator';
import { Role } from '../../modules/auth/enums/roles.enum';
import { DispatchAlertsDto } from './dto/dispatch-alerts.dto';
import { UpdateAlertSettingsDto } from './dto/update-alert-settings.dto';
import { SendStoredDocumentDto } from './dto/send-stored-document.dto';
import { SendUploadedDocumentDto } from './dto/send-uploaded-document.dto';
import { defaultJobOptions } from '../queue/default-job-options';
import { validatePdfMagicBytesFromPath } from '../../shared/interceptors/file-upload.interceptor';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import { Authorize } from '../../modules/auth/authorize.decorator';
import { DocumentMailDispatchResponseDto } from './dto/document-mail-dispatch-response.dto';
import { RequestTimeout } from '../../shared/decorators/request-timeout.decorator';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { maskEmail } from '../../shared/logging/log-sanitizer.util';

const resolveMailRequestTimeoutMs = (): number => {
  const raw = process.env.MAIL_REQUEST_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : 90_000;
};

const MAIL_TEMP_UPLOAD_DIR = resolveSgsTempDirectory();

type RequestWithUser = {
  user?: { company_id?: string; companyId?: string; userId?: string };
};

function getRequiredCompanyId(req: RequestWithUser): string {
  const companyId = String(
    req.user?.company_id || req.user?.companyId || '',
  ).trim();
  if (!companyId) {
    throw new BadRequestException(
      'Contexto de empresa é obrigatório para enfileirar envio de e-mail.',
    );
  }
  return companyId;
}

@Controller('mail')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
export class MailController {
  private readonly logger = new Logger(MailController.name);

  constructor(
    private readonly mailService: MailService,
    private readonly mailDlqService: MailDlqService,
    @InjectQueue('mail') private readonly mailQueue: Queue,
    private readonly tenantService: TenantService,
    private readonly fileInspectionService: FileInspectionService,
  ) {}

  @Get('logs/export')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize('can_view_mail')
  async exportLogs(
    @Query()
    query: {
      startDate?: string;
      endDate?: string;
      status?: string;
      to?: string;
      subject?: string;
      messageId?: string;
      companyId?: string;
      userId?: string;
      limit?: string;
    },
    @Request() req: RequestWithUser,
    @Res() res: Response,
  ) {
    const isSuperAdmin = this.tenantService.isSuperAdmin();
    const tenantCompanyId = req.user?.company_id || req.user?.companyId;

    if (isSuperAdmin && query.companyId) {
      const uuidV4 =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidV4.test(query.companyId)) {
        throw new BadRequestException('companyId inválido.');
      }
    }
    const effectiveCompanyId = isSuperAdmin
      ? query.companyId || tenantCompanyId
      : tenantCompanyId;

    const { csv, filename } = await this.mailService.exportLogs({
      startDate: query.startDate,
      endDate: query.endDate,
      status: query.status,
      to: query.to,
      subject: query.subject,
      messageId: query.messageId,
      // Segurança multi-tenant:
      // - usuários comuns: ignorar companyId vindo da query (não confiável)
      // - ADMIN_GERAL: pode filtrar por companyId explicitamente
      companyId: effectiveCompanyId,
      userId: query.userId || req.user?.userId,
      limit: query.limit,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  @Get('logs')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize('can_view_mail')
  async listLogs(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      startDate?: string;
      endDate?: string;
      status?: string;
      to?: string;
      subject?: string;
      messageId?: string;
      companyId?: string;
      userId?: string;
    },
    @Request() req: RequestWithUser,
  ) {
    const isSuperAdmin = this.tenantService.isSuperAdmin();
    const tenantCompanyId = req.user?.company_id || req.user?.companyId;

    if (isSuperAdmin && query.companyId) {
      const uuidV4 =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidV4.test(query.companyId)) {
        throw new BadRequestException('companyId inválido.');
      }
    }
    const effectiveCompanyId = isSuperAdmin
      ? query.companyId || tenantCompanyId
      : tenantCompanyId;

    return this.mailService.listLogs({
      page: query.page,
      pageSize: query.pageSize,
      startDate: query.startDate,
      endDate: query.endDate,
      status: query.status,
      to: query.to,
      subject: query.subject,
      messageId: query.messageId,
      companyId: effectiveCompanyId,
      userId: query.userId || req.user?.userId,
    });
  }

  @Get('dlq')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA)
  @Authorize('can_manage_mail')
  async listDlq(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
    },
    @Request() req: RequestWithUser,
  ) {
    return this.mailDlqService.list({
      currentCompanyId: req.user?.company_id || req.user?.companyId,
      isSuperAdmin: this.tenantService.isSuperAdmin(),
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });
  }

  @Post('dlq/:jobId/retry')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA)
  @Authorize('can_manage_mail')
  async retryDlqJob(
    @Param('jobId') jobId: string,
    @Request() req: RequestWithUser,
  ) {
    if (!jobId?.trim()) {
      throw new BadRequestException('jobId é obrigatório.');
    }

    return this.mailDlqService.retry(jobId, {
      currentCompanyId: req.user?.company_id || req.user?.companyId,
      isSuperAdmin: this.tenantService.isSuperAdmin(),
      actorId: req.user?.userId,
    });
  }

  @Post('send-stored-document')
  @Authorize('can_manage_mail')
  @RequestTimeout(resolveMailRequestTimeoutMs())
  async sendStoredDocument(
    @Body() body: SendStoredDocumentDto,
  ): Promise<DocumentMailDispatchResponseDto> {
    const { documentId, documentType, email } = body;
    const siteScope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'envio de documento governado por e-mail',
    );
    const companyId = siteScope.companyId;

    if (!documentId || !documentType || !email) {
      throw new BadRequestException(
        'documentId, documentType e email são obrigatórios.',
      );
    }

    this.mailService.assertDispatchAvailable();

    const workerTenantContext = {
      companyId: siteScope.companyId,
      isSuperAdmin: siteScope.isSuperAdmin,
      siteScope: siteScope.hasCompanyWideAccess
        ? ('all' as const)
        : ('single' as const),
      ...(!siteScope.hasCompanyWideAccess
        ? {
            siteIds: siteScope.siteIds,
            userId: siteScope.userId,
          }
        : {}),
    };

    try {
      await this.mailQueue.add(
        'send-document',
        {
          documentId,
          documentType,
          email,
          companyId,
          tenantContext: workerTenantContext,
        },
        defaultJobOptions,
      );

      this.logger.log({
        event: 'mail_document_dispatch_queued',
        documentType: documentType.toUpperCase().trim(),
        documentId,
        companyId,
        artifactType: 'governed_final_pdf',
        fallbackUsed: false,
        isOfficial: true,
        recipient: maskEmail(email),
      });

      return this.mailService.buildDocumentDispatchResponse({
        message:
          'Solicitação recebida. O documento final governado será enviado por e-mail em instantes.',
        deliveryMode: 'queued',
        artifactType: 'governed_final_pdf',
        isOfficial: true,
        fallbackUsed: false,
        documentType: documentType.toUpperCase().trim(),
        documentId,
      });
    } catch (error) {
      this.logger.warn(
        `Fila de e-mail indisponível, aplicando fallback síncrono: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return this.mailService.sendStoredDocument(
        documentId,
        documentType,
        email,
        companyId,
      );
    }
  }

  @Post('send-uploaded-document')
  @Authorize('can_manage_mail')
  @RequestTimeout(resolveMailRequestTimeoutMs())
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          mkdirSync(MAIL_TEMP_UPLOAD_DIR, { recursive: true });
          cb(null, MAIL_TEMP_UPLOAD_DIR);
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname) || '.pdf';
          cb(null, `${randomUUID()}${ext}`);
        },
      }),
      limits: {
        fileSize: 25 * 1024 * 1024,
      },
      fileFilter: (_req, file, cb) => {
        if (file.mimetype !== 'application/pdf') {
          return cb(null, false);
        }
        cb(null, true);
      },
    }),
  )
  async sendUploadedDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: SendUploadedDocumentDto,
    @Request() req: RequestWithUser,
  ): Promise<DocumentMailDispatchResponseDto> {
    const email = body.email?.trim();
    if (!email) {
      throw new BadRequestException('email é obrigatório.');
    }

    if (!file) {
      throw new BadRequestException(
        'Arquivo PDF é obrigatório e deve ser do tipo application/pdf.',
      );
    }

    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('Apenas arquivos PDF são permitidos.');
    }

    const companyId = getRequiredCompanyId(req);
    const resolvedDocName = body.docName?.trim() || file.originalname;
    let pdfBuffer: Buffer;

    this.mailService.assertDispatchAvailable();

    try {
      pdfBuffer = await readFile(file.path);
      await validatePdfMagicBytesFromPath(
        file.path,
        this.fileInspectionService,
        file.originalname,
      );
    } finally {
      await unlink(file.path).catch(() => undefined);
    }

    return this.mailService.sendUploadedPdfBuffer(pdfBuffer, email, {
      subject: body.subject,
      docName: resolvedDocName,
      companyId,
      userId: req.user?.userId,
    });
  }

  @Post('alerts/dispatch')
  @Authorize('can_manage_mail')
  async dispatchAlerts(
    @Body() body: DispatchAlertsDto,
    @Request() req: RequestWithUser,
  ) {
    const companyId = req.user?.companyId || req.user?.company_id;
    const result = await this.mailService.dispatchAlerts({
      to: body.to,
      includeWhatsapp: body.includeWhatsapp,
      companyId,
      userId: req.user?.userId,
    });

    if (!result.recipients.length) {
      throw new ServiceUnavailableException('Nenhum destinatário válido.');
    }

    return {
      success: true,
      recipients: result.recipients,
      previewUrl: result.previewUrl,
      usingTestAccount: result.usingTestAccount,
      whatsappSent: result.whatsappSent,
    };
  }

  @Get('alerts/settings')
  @Authorize('can_manage_mail')
  async getAlertSettings(@Request() req: RequestWithUser) {
    const companyId = req.user?.companyId || req.user?.company_id;
    return this.mailService.getAlertSettingsSnapshot(companyId);
  }

  @Patch('alerts/settings')
  @Authorize('can_manage_mail')
  async updateAlertSettings(
    @Body() body: UpdateAlertSettingsDto,
    @Request() req: RequestWithUser,
  ) {
    const companyId = req.user?.companyId || req.user?.company_id;
    return this.mailService.updateAlertSettings(companyId, body);
  }

  @Get('alerts/preview')
  @Authorize('can_manage_mail')
  async previewAlertSummary(@Request() req: RequestWithUser) {
    const companyId = req.user?.companyId || req.user?.company_id;
    return this.mailService.getAlertSummaryPreview(companyId);
  }
}
