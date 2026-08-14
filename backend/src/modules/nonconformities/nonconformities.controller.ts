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
  UploadedFile,
  BadRequestException,
  GoneException,
  Query,
  Header,
  StreamableFile,
  Req,
} from '@nestjs/common';
import { NonConformitiesService, NcStatus } from './nonconformities.service';
import { NonConformitiesPdfService } from './services/nonconformities-pdf.service';
import {
  CreateNonConformityDto,
  UpdateNonConformityDto,
} from './dto/create-nonconformity.dto';
import { NonConformityFilesQueryDto } from './dto/nonconformity-files-query.dto';
import { NonConformityListQueryDto } from './dto/nonconformity-list-query.dto';
import { NonConformityResponseDto } from './dto/nonconformity-response.dto';
import type {
  NonConformityAttachmentAttachResponse,
  NonConformityAttachmentRemoveResponse,
} from './nonconformities.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  cleanupUploadedTempFile,
  createTemporaryUploadOptions,
  inspectUploadedFileBuffer,
  readUploadedFileBuffer,
  validateFileMagicBytes,
} from '../../shared/interceptors/file-upload.interceptor';
import { Authorize } from '../auth/authorize.decorator';
import { AuditAction as ForensicAuditAction } from '../../shared/decorators/audit-action.decorator';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { PdfRequestTimeout } from '../../shared/decorators/pdf-request-timeout.decorator';
import type { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
  };
}

@Controller('nonconformities')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
export class NonConformitiesController {
  constructor(
    private readonly nonConformitiesService: NonConformitiesService,
    private readonly nonConformitiesPdfService: NonConformitiesPdfService,
    private readonly fileInspectionService: FileInspectionService,
  ) {}

  @Post()
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_nc')
  create(
    @Body() createNonConformityDto: CreateNonConformityDto,
  ): Promise<NonConformityResponseDto> {
    return this.nonConformitiesService.create(createNonConformityDto);
  }

  @Get()
  @Authorize('can_view_nc')
  findAll(@Query() query: NonConformityListQueryDto) {
    return this.nonConformitiesService.findPaginated({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      search: query.search,
      status: query.status,
    });
  }

  @Get('files/list')
  @Authorize('can_view_nc')
  listStoredFiles(@Query() query: NonConformityFilesQueryDto) {
    return this.nonConformitiesService.listStoredFiles({
      year: query.year,
      week: query.week,
    });
  }

  @Get('files/weekly-bundle')
  @Authorize('can_view_nc')
  async getWeeklyBundle(
    @Query() query: NonConformityFilesQueryDto,
  ): Promise<StreamableFile> {
    const { buffer, fileName } =
      await this.nonConformitiesService.getWeeklyBundle({
        year: query.year,
        week: query.week,
      });

    return new StreamableFile(buffer, {
      disposition: `attachment; filename="${fileName}"`,
      type: 'application/pdf',
    });
  }

  @Get('analytics/monthly')
  @Authorize('can_view_nc')
  getMonthlyAnalytics() {
    return this.nonConformitiesService.getMonthlyAnalytics();
  }

  @Get('analytics/overview')
  @Authorize('can_view_nc')
  getAnalyticsOverview() {
    return this.nonConformitiesService.getAnalyticsOverview();
  }

  @Get('export/excel')
  @Authorize('can_view_nc')
  @Header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @Header(
    'Content-Disposition',
    'attachment; filename="nao-conformidades.xlsx"',
  )
  async exportExcel(): Promise<StreamableFile> {
    const buffer = await this.nonConformitiesService.exportExcel();
    return new StreamableFile(buffer);
  }

  @Get(':id')
  @Authorize('can_view_nc')
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<NonConformityResponseDto> {
    return this.nonConformitiesService.findOne(id);
  }

  @Get(':id/pdf')
  @Authorize('can_view_nc')
  getPdf(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.nonConformitiesService.getPdfAccess(id);
  }

  @Post(':id/generate-final-pdf')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_nc')
  @PdfRequestTimeout()
  generateFinalPdf(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.nonConformitiesPdfService.generateFinalPdf(id, req.user?.id);
  }

  @Get(':id/validation-context')
  @Authorize('can_view_nc')
  getValidationContext(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.nonConformitiesService.getValidationContext(id);
  }

  @Get(':id/attachments/:index/access')
  @Authorize('can_view_nc')
  getAttachmentAccess(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.nonConformitiesService.getAttachmentAccess(id, index);
  }

  @Delete(':id/attachments/:index')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_nc')
  removeAttachment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<NonConformityAttachmentRemoveResponse> {
    return this.nonConformitiesService.removeAttachment(id, index);
  }

  @Post(':id/file')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_nc')
  attachFileDeprecated(): never {
    throw new GoneException(
      'O envio manual de PDF final foi desativado. Encerre a NC e use a geração oficial do sistema.',
    );
  }

  @Post(':id/attachments')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @UseInterceptors(
    FileInterceptor(
      'file',
      createTemporaryUploadOptions({ maxFileSize: 10 * 1024 * 1024 }),
    ),
  )
  @Authorize('can_manage_nc')
  async attachAttachment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<NonConformityAttachmentAttachResponse> {
    if (!file) {
      throw new BadRequestException('Arquivo de evidência não enviado');
    }

    const buffer = await readUploadedFileBuffer(file);

    try {
      validateFileMagicBytes(buffer, [
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp',
      ]);
      await inspectUploadedFileBuffer(buffer, file, this.fileInspectionService);

      return await this.nonConformitiesService.attachAttachment(
        id,
        buffer,
        file.originalname,
      );
    } finally {
      await cleanupUploadedTempFile(file);
    }
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_nc')
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('status') status: NcStatus,
  ): Promise<NonConformityResponseDto> {
    return this.nonConformitiesService.updateStatus(id, status);
  }

  @Patch(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_nc')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updateNonConformityDto: UpdateNonConformityDto,
  ): Promise<NonConformityResponseDto> {
    return this.nonConformitiesService.update(id, updateNonConformityDto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize('can_manage_nc')
  @ForensicAuditAction('delete', 'non_conformity')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.nonConformitiesService.remove(id);
  }
}
