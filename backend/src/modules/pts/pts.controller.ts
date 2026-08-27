import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Delete,
  UseGuards,
  UseInterceptors,
  Req,
  Query,
  UnauthorizedException,
  Header,
  StreamableFile,
  BadRequestException,
  UploadedFile,
  HttpException,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { PtsService } from './pts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { CreatePtDto, PtAtmosphericReadingDto } from './dto/create-pt.dto';
import { UpdatePtDto } from './dto/update-pt.dto';
import { FinalizePtDto } from './dto/finalize-pt.dto';
import { AttachPtEvidencePhotoDto } from './dto/attach-pt-photo.dto';
import { LogPreApprovalReviewDto } from './dto/log-pre-approval-review.dto';
import { UpdatePtApprovalRulesDto } from './dto/update-pt-approval-rules.dto';
import { ApprovePtDto } from './dto/approve-pt.dto';
import { RejectPtDto } from './dto/reject-pt.dto';
import { PtResponseDto, toPtResponseDto } from './dto/pt-response.dto';
import { PdfRateLimitService } from '../auth/services/pdf-rate-limit.service';
import { Authorize } from '../auth/authorize.decorator';
import { AuditAction as ForensicAuditAction } from '../../shared/decorators/audit-action.decorator';
import {
  assertUploadedPdf,
  cleanupUploadedTempFile,
  createGovernedPdfUploadOptions,
  createTemporaryUploadOptions,
  inspectUploadedFileBuffer,
  readUploadedFileBuffer,
  validateFileMagicBytes,
} from '../../shared/interceptors/file-upload.interceptor';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { getRequestIp } from '../../shared/utils/request-ip.util';
import { UserThrottle } from '../../shared/decorators/user-throttle.decorator';
import { TenantThrottle } from '../../shared/decorators/tenant-throttle.decorator';

@Controller('pts')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
@Roles(
  Role.ADMIN_GERAL,
  Role.ADMIN_EMPRESA,
  Role.TST,
  Role.SUPERVISOR,
  Role.COLABORADOR,
)
export class PtsController {
  private getRequestUserId(
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ): string | undefined {
    return req.user?.userId ?? req.user?.id ?? req.user?.sub;
  }

  private getRequestErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Usuário não autorizado';
  }

  private getRequestIp(
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ): string {
    return getRequestIp(req) || 'unknown';
  }

  constructor(
    private readonly ptsService: PtsService,
    private readonly pdfRateLimitService: PdfRateLimitService,
    private readonly fileInspectionService: FileInspectionService,
  ) {}

  @Post()
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_pt')
  @ForensicAuditAction('create', 'pt')
  create(@Body() createPtDto: CreatePtDto): Promise<PtResponseDto> {
    return this.ptsService.create(createPtDto).then(toPtResponseDto);
  }

  @Post(':id/approve')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_approve_pt')
  @ForensicAuditAction('approve', 'pt')
  approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ApprovePtDto,
    @Req() req: { user?: { userId?: string } },
  ): Promise<PtResponseDto> {
    const userId = req.user?.userId;
    if (!userId) {
      throw new BadRequestException('Usuário autenticado inválido');
    }
    return this.ptsService
      .approve(id, userId, body.reason)
      .then(toPtResponseDto);
  }

  @Post(':id/pre-approval-review')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_approve_pt')
  logPreApprovalReview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() payload: LogPreApprovalReviewDto,
    @Req() req: { user?: { userId?: string } },
  ) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new BadRequestException('Usuário autenticado inválido');
    }
    return this.ptsService.logPreApprovalReview(id, userId, payload);
  }

  @Get(':id/pre-approval-history')
  @Authorize('can_view_pt')
  getPreApprovalHistory(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.ptsService.getPreApprovalHistory(id);
  }

  @Post(':id/reject')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_approve_pt')
  @ForensicAuditAction('reject', 'pt')
  reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RejectPtDto,
    @Req() req: { user?: { userId?: string } },
  ): Promise<PtResponseDto> {
    const userId = req.user?.userId;
    if (!userId) {
      throw new BadRequestException('Usuário autenticado inválido');
    }
    return this.ptsService
      .reject(id, userId, body.reason)
      .then(toPtResponseDto);
  }

  @Get()
  @Authorize('can_view_pt')
  findPaginated(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
    @Query('cursor') cursor?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    if (cursor) {
      return this.ptsService.findByCursor({
        cursor,
        limit: Number(limit),
        search: search || undefined,
        status: status || undefined,
      });
    }

    return this.ptsService.findPaginated({
      page: Number(page),
      limit: Number(limit),
      search: search || undefined,
      status: status || undefined,
    });
  }

  @Get('export/all')
  @Authorize('can_view_pt')
  findAllForExport() {
    return this.ptsService.findAllForExport();
  }

  @Get('files/list')
  @Authorize('can_view_pt')
  listStoredFiles(@Query('year') year?: string, @Query('week') week?: string) {
    return this.ptsService.listStoredFiles({
      year: year ? Number(year) : undefined,
      week: week ? Number(week) : undefined,
    });
  }

  @Get('files/weekly-bundle')
  @Authorize('can_view_pt')
  async getWeeklyBundle(
    @Query('year') year?: string,
    @Query('week') week?: string,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.ptsService.getWeeklyBundle({
      year: year ? Number(year) : undefined,
      week: week ? Number(week) : undefined,
    });

    return new StreamableFile(buffer, {
      disposition: `attachment; filename="${fileName}"`,
      type: 'application/pdf',
    });
  }

  @Get('export/excel')
  @Authorize('can_view_pt')
  @Header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @Header('Content-Disposition', 'attachment; filename="pts.xlsx"')
  async exportExcel(): Promise<StreamableFile> {
    const buffer = await this.ptsService.exportExcel();
    return new StreamableFile(buffer);
  }

  @Get('approval-rules')
  @Authorize('can_view_pt')
  getApprovalRules() {
    return this.ptsService.getApprovalRules();
  }

  @Get('analytics/overview')
  @Authorize('can_view_pt')
  getAnalyticsOverview() {
    return this.ptsService.getAnalyticsOverview();
  }

  @Patch('approval-rules')
  @Authorize('can_manage_pt')
  updateApprovalRules(@Body() payload: UpdatePtApprovalRulesDto) {
    return this.ptsService.updateApprovalRules(payload);
  }

  /** Retorna URL assinada (S3) ou null do PDF armazenado */
  @Get(':id/pdf')
  @Authorize('can_view_pt')
  async getPdfAccess(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ) {
    try {
      const userId = this.getRequestUserId(req);
      if (userId) {
        await this.pdfRateLimitService.checkDownloadLimit(
          userId,
          this.getRequestIp(req),
        );
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new UnauthorizedException(this.getRequestErrorMessage(error));
    }

    return this.ptsService.getPdfAccess(id);
  }

  @Get(':id/validation-context')
  @Authorize('can_view_pt')
  getValidationContext(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.ptsService.getValidationContext(id);
  }

  @Post(':id/finalize')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_approve_pt')
  @ForensicAuditAction('finalize', 'pt')
  finalize(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: FinalizePtDto,
    @Req() req: { user?: { userId?: string } },
  ): Promise<PtResponseDto> {
    const userId = req.user?.userId;
    if (!userId) {
      throw new BadRequestException('Usuário autenticado inválido');
    }
    return this.ptsService.finalize(id, userId, body).then(toPtResponseDto);
  }

  /** Evidência fotográfica governada da área (antes/durante/depois). */
  @Post(':id/photos')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_pt')
  @UserThrottle({ requestsPerMinute: 5 })
  @TenantThrottle({ requestsPerMinute: 20, requestsPerHour: 100 })
  @UseInterceptors(
    FileInterceptor(
      'file',
      createTemporaryUploadOptions({ maxFileSize: 10 * 1024 * 1024 }),
    ),
  )
  async attachEvidencePhoto(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AttachPtEvidencePhotoDto,
    @UploadedFile() file: Express.Multer.File,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ) {
    if (!file) {
      throw new BadRequestException('Foto de evidência não enviada.');
    }

    const buffer = await readUploadedFileBuffer(file);

    try {
      validateFileMagicBytes(buffer, ['image/jpeg', 'image/png', 'image/webp']);
      await inspectUploadedFileBuffer(buffer, file, this.fileInspectionService);

      return await this.ptsService.attachEvidencePhoto(
        id,
        buffer,
        file.originalname,
        file.mimetype,
        { fase: body.fase, legenda: body.legenda },
        this.getRequestUserId(req),
      );
    } finally {
      await cleanupUploadedTempFile(file);
    }
  }

  @Get(':id/photos/:photoIndex/access')
  @Authorize('can_view_pt')
  getEvidencePhotoAccess(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('photoIndex', ParseIntPipe) photoIndex: number,
  ) {
    return this.ptsService.getEvidencePhotoAccess(id, photoIndex);
  }

  @Delete(':id/photos/:photoIndex')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_pt')
  removeEvidencePhoto(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('photoIndex', ParseIntPipe) photoIndex: number,
    @Req() req: { user?: { userId?: string } },
  ) {
    return this.ptsService.removeEvidencePhoto(
      id,
      photoIndex,
      req.user?.userId,
    );
  }

  /** Anexo governado de item de checklist (imagem ou PDF). */
  @Post(':id/checklists/:checklistField/items/:itemIndex/attachment')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_pt')
  @UserThrottle({ requestsPerMinute: 5 })
  @TenantThrottle({ requestsPerMinute: 20, requestsPerHour: 100 })
  @UseInterceptors(
    FileInterceptor(
      'file',
      createTemporaryUploadOptions({ maxFileSize: 10 * 1024 * 1024 }),
    ),
  )
  async attachChecklistItemAttachment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('checklistField') checklistField: string,
    @Param('itemIndex', ParseIntPipe) itemIndex: number,
    @UploadedFile() file: Express.Multer.File,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ) {
    if (!file) {
      throw new BadRequestException('Anexo do item não enviado.');
    }

    const buffer = await readUploadedFileBuffer(file);

    try {
      validateFileMagicBytes(buffer, [
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/pdf',
      ]);
      await inspectUploadedFileBuffer(buffer, file, this.fileInspectionService);

      return await this.ptsService.attachChecklistItemAttachment(
        id,
        checklistField,
        itemIndex,
        buffer,
        file.originalname,
        file.mimetype,
        this.getRequestUserId(req),
      );
    } finally {
      await cleanupUploadedTempFile(file);
    }
  }

  @Get(':id/checklists/:checklistField/items/:itemIndex/attachment/access')
  @Authorize('can_view_pt')
  getChecklistItemAttachmentAccess(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('checklistField') checklistField: string,
    @Param('itemIndex', ParseIntPipe) itemIndex: number,
  ) {
    return this.ptsService.getChecklistItemAttachmentAccess(
      id,
      checklistField,
      itemIndex,
    );
  }

  /** Registro append-only de medição atmosférica NR-33 (espaço confinado). */
  @Post(':id/atmospheric-readings')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_pt')
  appendAtmosphericReading(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PtAtmosphericReadingDto,
    @Req() req: { user?: { userId?: string } },
  ): Promise<PtResponseDto> {
    return this.ptsService
      .appendAtmosphericReading(id, body, req.user?.userId)
      .then(toPtResponseDto);
  }

  /** Anexa PDF a uma PT existente */
  @Post(':id/file')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_pt')
  @UseInterceptors(FileInterceptor('file', createGovernedPdfUploadOptions()))
  async attachFile(
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ) {
    const pdfFile = await assertUploadedPdf(
      file,
      undefined,
      this.fileInspectionService,
    );
    try {
      return await this.ptsService.attachPdf(
        id,
        pdfFile,
        this.getRequestUserId(req),
      );
    } finally {
      await cleanupUploadedTempFile(pdfFile);
    }
  }

  @Get(':id')
  @Authorize('can_view_pt')
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PtResponseDto> {
    return toPtResponseDto(await this.ptsService.findOne(id));
  }

  @Patch(':id')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_pt')
  @ForensicAuditAction('update', 'pt')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updatePtDto: UpdatePtDto,
  ): Promise<PtResponseDto> {
    return this.ptsService.update(id, updatePtDto).then(toPtResponseDto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize('can_manage_pt')
  @ForensicAuditAction('delete', 'pt')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.ptsService.remove(id);
  }
}
