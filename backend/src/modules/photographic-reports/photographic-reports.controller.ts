import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { getRequestIp } from '../../shared/utils/request-ip.util';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { FeatureAiGuard } from '../../shared/guards/feature-ai.guard';
import { AiConsentGuard } from '../../shared/guards/ai-consent.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { Authorize } from '../auth/authorize.decorator';
import { createTemporaryUploadOptions } from '../../shared/interceptors/file-upload.interceptor';
import { PhotographicReportsService } from './photographic-reports.service';
import { CreatePhotographicReportDto } from './dto/create-photographic-report.dto';
import { UpdatePhotographicReportDto } from './dto/update-photographic-report.dto';
import { CreatePhotographicReportDayDto } from './dto/create-photographic-report-day.dto';
import { UpdatePhotographicReportDayDto } from './dto/update-photographic-report-day.dto';
import { UpdatePhotographicReportImageDto } from './dto/update-photographic-report-image.dto';
import { ReorderPhotographicReportImagesDto } from './dto/reorder-photographic-report-images.dto';
import { UploadPhotographicReportImagesDto } from './dto/upload-photographic-report-images.dto';
import { PhotographicReportStatus } from './entities/photographic-report.entity';
import { SendEmailDto } from './dto/send-email.dto';

@Controller('photographic-reports')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class PhotographicReportsController {
  constructor(
    private readonly photographicReportsService: PhotographicReportsService,
  ) {}

  @Get()
  @Authorize('can_view_photographic_reports')
  findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: PhotographicReportStatus,
  ) {
    return this.photographicReportsService.findPaginated({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
      search,
      status,
    });
  }

  @Post()
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_photographic_reports')
  create(@Body() dto: CreatePhotographicReportDto) {
    return this.photographicReportsService.create(dto);
  }

  @Get(':id')
  @Authorize('can_view_photographic_reports')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.photographicReportsService.findOne(id);
  }

  @Patch(':id')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_photographic_reports')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePhotographicReportDto,
  ) {
    return this.photographicReportsService.update(id, dto);
  }

  @Post(':id/draft')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_photographic_reports')
  saveDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePhotographicReportDto,
  ) {
    return this.photographicReportsService.saveDraft(id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_photographic_reports')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.photographicReportsService.remove(id);
  }

  @Post(':id/days')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_photographic_reports')
  createDay(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreatePhotographicReportDayDto,
  ) {
    return this.photographicReportsService.createDay(id, dto);
  }

  @Patch(':id/days/:dayId')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_photographic_reports')
  updateDay(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('dayId', new ParseUUIDPipe()) dayId: string,
    @Body() dto: UpdatePhotographicReportDayDto,
  ) {
    return this.photographicReportsService.updateDay(id, dayId, dto);
  }

  @Delete(':id/days/:dayId')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_photographic_reports')
  removeDay(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('dayId', new ParseUUIDPipe()) dayId: string,
  ) {
    return this.photographicReportsService.removeDay(id, dayId);
  }

  @Post(':id/images')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_photographic_reports')
  @UseInterceptors(
    FilesInterceptor(
      'files',
      30,
      createTemporaryUploadOptions({
        maxFileSize: 15 * 1024 * 1024,
        maxFiles: 30,
      }),
    ),
  )
  uploadImages(
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: UploadPhotographicReportImagesDto,
    @Req() req: Request,
  ) {
    const uploadedFiles = Array.isArray(files) ? files : [];
    return this.photographicReportsService.uploadImages(
      id,
      uploadedFiles,
      dto,
      getRequestIp(req),
    );
  }

  @Patch(':id/images/:imageId')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_photographic_reports')
  updateImage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('imageId', new ParseUUIDPipe()) imageId: string,
    @Body() dto: UpdatePhotographicReportImageDto,
  ) {
    return this.photographicReportsService.updateImage(id, imageId, dto);
  }

  @Delete(':id/images/:imageId')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_photographic_reports')
  removeImage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('imageId', new ParseUUIDPipe()) imageId: string,
  ) {
    return this.photographicReportsService.removeImage(id, imageId);
  }

  @Post(':id/images/reorder')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_photographic_reports')
  reorderImages(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReorderPhotographicReportImagesDto,
  ) {
    return this.photographicReportsService.reorderImages(id, dto);
  }

  @Post(':id/images/analyze')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_generate_photographic_report_ai')
  @UseGuards(FeatureAiGuard, AiConsentGuard)
  analyzeAllImages(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.photographicReportsService.analyzeAllImages(id);
  }

  @Post(':id/images/:imageId/analyze')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_generate_photographic_report_ai')
  @UseGuards(FeatureAiGuard, AiConsentGuard)
  analyzeImage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('imageId', new ParseUUIDPipe()) imageId: string,
  ) {
    return this.photographicReportsService.analyzeImage(id, imageId);
  }

  @Post(':id/analyze')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_generate_photographic_report_ai')
  @UseGuards(FeatureAiGuard, AiConsentGuard)
  generateSummary(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.photographicReportsService.generateReportSummary(id);
  }

  @Post(':id/finalize')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_finalize_photographic_report')
  @UseGuards(FeatureAiGuard, AiConsentGuard)
  finalize(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.photographicReportsService.finalize(id);
  }

  @Post(':id/export/pdf')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_export_photographic_report_pdf')
  async exportPdf(@Param('id', new ParseUUIDPipe()) id: string) {
    const { buffer, fileName } =
      await this.photographicReportsService.exportPdf(id);
    return new StreamableFile(buffer, {
      disposition: `attachment; filename="${fileName}"`,
      type: 'application/pdf',
    });
  }

  @Post(':id/export/word')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_export_photographic_report_word')
  async exportWord(@Param('id', new ParseUUIDPipe()) id: string) {
    const { buffer, fileName } =
      await this.photographicReportsService.exportWord(id);
    return new StreamableFile(buffer, {
      disposition: `attachment; filename="${fileName}"`,
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  }

  @Get(':id/exports')
  @Authorize('can_view_photographic_reports')
  listExports(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.photographicReportsService.listExports(id);
  }

  @Get(':id/exports/:exportId/file')
  @Authorize('can_view_photographic_reports')
  async downloadExport(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('exportId', new ParseUUIDPipe()) exportId: string,
  ) {
    const { buffer, fileName, mimeType } =
      await this.photographicReportsService.downloadExport(id, exportId);
    return new StreamableFile(buffer, {
      disposition: `attachment; filename="${fileName}"`,
      type: mimeType,
    });
  }

  @Get(':id/pdf')
  @Authorize('can_view_photographic_reports')
  getPdfAccess(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.photographicReportsService.getPdfAccess(id);
  }

  @Post(':id/send-email')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_photographic_reports')
  sendEmail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendEmailDto,
  ) {
    if (!body.to.length) {
      throw new BadRequestException(
        'Informe pelo menos um destinatário para envio.',
      );
    }
    return this.photographicReportsService.sendEmail(id, body.to);
  }
}
