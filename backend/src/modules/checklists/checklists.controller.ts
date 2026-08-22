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
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  BadRequestException,
  GoneException,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ChecklistsService } from './checklists.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { FeatureAiGuard } from '../../shared/guards/feature-ai.guard';
import { AiConsentGuard } from '../../shared/guards/ai-consent.guard';
import { CreateChecklistDto } from './dto/create-checklist.dto';
import { SendChecklistEmailDto } from './dto/send-checklist-email.dto';
import { UpdateChecklistDto } from './dto/update-checklist.dto';
import { Role } from '../auth/enums/roles.enum';
import { Authorize } from '../auth/authorize.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiStandardResponses } from '../../shared/swagger/api-standard-responses.decorator';
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
import { UserThrottle } from '../../shared/decorators/user-throttle.decorator';
import { TenantThrottle } from '../../shared/decorators/tenant-throttle.decorator';

const wordUploadOptions = createTemporaryUploadOptions({
  maxFileSize: 20 * 1024 * 1024,
  // Permissive filter: prioritize magic bytes + FileInspection inside handler
  // (mime/extension checks would run before magic; security requires magic first)
  fileFilter: (
    _req: unknown,
    _file: Express.Multer.File,
    cb: (err: Error | null, accept: boolean) => void,
  ) => {
    cb(null, true);
  },
});

@ApiTags('checklists')
@ApiBearerAuth('access-token')
@ApiStandardResponses({ includeNotFound: true })
@Controller('checklists')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
export class ChecklistsController {
  private getRequestUserId(
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ): string | undefined {
    return req.user?.userId ?? req.user?.id ?? req.user?.sub;
  }

  constructor(
    private readonly checklistsService: ChecklistsService,
    private readonly fileInspectionService: FileInspectionService,
  ) {}

  @Post('seed/welding-machine')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  seedWeldingMachine() {
    return this.checklistsService.createWeldingMachineTemplate();
  }

  @Post('templates/bootstrap')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  bootstrapTemplates() {
    return this.checklistsService.createPresetTemplates();
  }

  @Post('models/bootstrap')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  bootstrapModels() {
    return this.checklistsService.createPresetTemplates();
  }

  @Post('import-word')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  @UseGuards(FeatureAiGuard, AiConsentGuard)
  @UserThrottle({ requestsPerMinute: 5 })
  @TenantThrottle({ requestsPerMinute: 20, requestsPerHour: 100 })
  @UseInterceptors(FileInterceptor('file', wordUploadOptions))
  async importWord(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Nenhum arquivo enviado.');
    }

    const buffer = await readUploadedFileBuffer(file);
    try {
      validateFileMagicBytes(buffer, [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/msword',
      ]);
      await inspectUploadedFileBuffer(buffer, file, this.fileInspectionService);
      return await this.checklistsService.importFromWord(
        buffer,
        file.mimetype,
        file.originalname,
      );
    } finally {
      await cleanupUploadedTempFile(file);
    }
  }

  @Post()
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  @ForensicAuditAction('create', 'checklist')
  @UserThrottle({ requestsPerMinute: 10 })
  @TenantThrottle({ requestsPerMinute: 30, requestsPerHour: 120 })
  create(@Body() createChecklistDto: CreateChecklistDto) {
    return this.checklistsService.create(createChecklistDto);
  }

  @Get()
  @Authorize('can_view_checklists')
  findPaginated(
    @Query('onlyTemplates') onlyTemplates?: string,
    @Query('excludeTemplates') excludeTemplates?: string,
    @Query('category') category?: string,
    @Query('segment') segment?: string,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
  ) {
    return this.checklistsService.findPaginated({
      onlyTemplates: onlyTemplates === 'true',
      excludeTemplates: excludeTemplates === 'true',
      category: category?.trim() || undefined,
      segment: segment?.trim() || undefined,
      page: Number(page),
      limit: Number(limit),
    });
  }

  @Get('files/list')
  @Authorize('can_view_checklists')
  listStoredFiles(@Query('year') year?: string, @Query('week') week?: string) {
    return this.checklistsService.listStoredFiles({
      year: year ? Number(year) : undefined,
      week: week ? Number(week) : undefined,
    });
  }

  @Get('files/weekly-bundle')
  @Authorize('can_view_checklists')
  async getWeeklyBundle(
    @Query('year') year?: string,
    @Query('week') week?: string,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.checklistsService.getWeeklyBundle({
      year: year ? Number(year) : undefined,
      week: week ? Number(week) : undefined,
    });

    return new StreamableFile(buffer, {
      disposition: `attachment; filename="${fileName}"`,
      type: 'application/pdf',
    });
  }

  @Get(':id')
  @Authorize('can_view_checklists')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.checklistsService.findOne(id);
  }

  @Get(':id/pdf')
  @Authorize('can_view_checklists')
  getPdfAccess(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.checklistsService.getPdfAccess(id);
  }

  @Get(':id/validation-context')
  @Authorize('can_view_checklists')
  getValidationContext(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.checklistsService.getValidationContext(id);
  }

  @Get(':id/equipment-photo/access')
  @Authorize('can_view_checklists')
  getEquipmentPhotoAccess(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.checklistsService.getEquipmentPhotoAccess(id);
  }

  @Get(':id/items/:itemIndex/photos/:photoIndex/access')
  @Authorize('can_view_checklists')
  getItemPhotoAccess(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemIndex', ParseIntPipe) itemIndex: number,
    @Param('photoIndex', ParseIntPipe) photoIndex: number,
  ) {
    return this.checklistsService.getItemPhotoAccess(id, itemIndex, photoIndex);
  }

  @Patch(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  @ForensicAuditAction('update', 'checklist')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updateChecklistDto: UpdateChecklistDto,
  ) {
    return this.checklistsService.update(id, updateChecklistDto);
  }

  @Post(':id/send-email')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  sendEmail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendChecklistEmailDto,
  ) {
    return this.checklistsService.sendEmail(id, body.to);
  }

  @Post('fill-from-template/:templateId')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  @UserThrottle({ requestsPerMinute: 10 })
  @TenantThrottle({ requestsPerMinute: 30, requestsPerHour: 120 })
  fillFromTemplate(
    @Param('templateId', new ParseUUIDPipe()) templateId: string,
    @Body() fillData: UpdateChecklistDto,
  ) {
    return this.checklistsService.fillFromTemplate(templateId, fillData);
  }

  @Post('fill-from-model/:modelId')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  @UserThrottle({ requestsPerMinute: 10 })
  @TenantThrottle({ requestsPerMinute: 30, requestsPerHour: 120 })
  fillFromModel(
    @Param('modelId', new ParseUUIDPipe()) modelId: string,
    @Body() fillData: UpdateChecklistDto,
  ) {
    return this.checklistsService.fillFromTemplate(modelId, fillData);
  }

  @Post(':id/save-pdf')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  savePdf(@Param('id', new ParseUUIDPipe()) id: string) {
    throw new GoneException(
      `O endpoint legado de PDF do checklist (${id}) foi descontinuado. Use POST /checklists/${id}/file com o PDF oficial gerado no cliente.`,
    );
  }

  @Post(':id/file')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  @ForensicAuditAction('finalize', 'checklist')
  @UserThrottle({ requestsPerMinute: 5 })
  @TenantThrottle({ requestsPerMinute: 20, requestsPerHour: 100 })
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
      'PDF do checklist não enviado.',
      this.fileInspectionService,
    );
    try {
      return await this.checklistsService.attachPdf(
        id,
        pdfFile,
        this.getRequestUserId(req),
      );
    } finally {
      await cleanupUploadedTempFile(pdfFile);
    }
  }

  @Post(':id/equipment-photo')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  @ForensicAuditAction('update', 'checklist')
  @UserThrottle({ requestsPerMinute: 5 })
  @TenantThrottle({ requestsPerMinute: 20, requestsPerHour: 100 })
  @UseInterceptors(
    FileInterceptor(
      'file',
      createTemporaryUploadOptions({ maxFileSize: 10 * 1024 * 1024 }),
    ),
  )
  async attachEquipmentPhoto(
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Foto do equipamento não enviada.');
    }

    const buffer = await readUploadedFileBuffer(file);

    try {
      validateFileMagicBytes(buffer, ['image/jpeg', 'image/png', 'image/webp']);
      await inspectUploadedFileBuffer(buffer, file, this.fileInspectionService);

      return await this.checklistsService.attachEquipmentPhoto(
        id,
        buffer,
        file.originalname,
        file.mimetype,
      );
    } finally {
      await cleanupUploadedTempFile(file);
    }
  }

  @Post(':id/items/:itemIndex/photos')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_checklists')
  @ForensicAuditAction('update', 'checklist')
  @UserThrottle({ requestsPerMinute: 5 })
  @TenantThrottle({ requestsPerMinute: 20, requestsPerHour: 100 })
  @UseInterceptors(
    FileInterceptor(
      'file',
      createTemporaryUploadOptions({ maxFileSize: 10 * 1024 * 1024 }),
    ),
  )
  async attachItemPhoto(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemIndex', ParseIntPipe) itemIndex: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Foto do item não enviada.');
    }

    const buffer = await readUploadedFileBuffer(file);

    try {
      validateFileMagicBytes(buffer, ['image/jpeg', 'image/png', 'image/webp']);
      await inspectUploadedFileBuffer(buffer, file, this.fileInspectionService);

      return await this.checklistsService.attachItemPhoto(
        id,
        itemIndex,
        buffer,
        file.originalname,
        file.mimetype,
      );
    } finally {
      await cleanupUploadedTempFile(file);
    }
  }

  @Delete(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize('can_manage_checklists')
  @ForensicAuditAction('delete', 'checklist')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.checklistsService.remove(id);
  }
}
