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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { Authorize } from '../auth/authorize.decorator';
import { Role } from '../auth/enums/roles.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { TenantThrottle } from '../../shared/decorators/tenant-throttle.decorator';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import {
  assertUploadedPdf,
  cleanupUploadedTempFile,
  createGovernedPdfUploadOptions,
} from '../../shared/interceptors/file-upload.interceptor';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { AuditAction as ForensicAuditAction } from '../../shared/decorators/audit-action.decorator';
import { ArrsService } from './arrs.service';
import { CreateArrDto } from './dto/create-arr.dto';
import { FindArrsQueryDto } from './dto/find-arrs-query.dto';
import { UpdateArrDto } from './dto/update-arr.dto';
import { ArrStatus } from './entities/arr.entity';

const parseTenantThrottle = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const resolveHourlyTenantThrottle = (
  hourlyValue: string | undefined,
  perMinuteValue: number,
) => {
  const parsed = Number(hourlyValue);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return perMinuteValue * 60;
};

const ARR_CREATE_TENANT_THROTTLE_LIMIT = parseTenantThrottle(
  process.env.ARR_CREATE_TENANT_THROTTLE_LIMIT,
  120,
);
const ARR_CREATE_TENANT_THROTTLE_HOUR_LIMIT = resolveHourlyTenantThrottle(
  process.env.ARR_CREATE_TENANT_THROTTLE_HOUR_LIMIT,
  ARR_CREATE_TENANT_THROTTLE_LIMIT,
);

const ARR_STATUS_TENANT_THROTTLE_LIMIT = parseTenantThrottle(
  process.env.ARR_STATUS_TENANT_THROTTLE_LIMIT,
  120,
);
const ARR_STATUS_TENANT_THROTTLE_HOUR_LIMIT = resolveHourlyTenantThrottle(
  process.env.ARR_STATUS_TENANT_THROTTLE_HOUR_LIMIT,
  ARR_STATUS_TENANT_THROTTLE_LIMIT,
);

const ARR_UPLOAD_TENANT_THROTTLE_LIMIT = parseTenantThrottle(
  process.env.ARR_UPLOAD_TENANT_THROTTLE_LIMIT,
  60,
);
const ARR_UPLOAD_TENANT_THROTTLE_HOUR_LIMIT = resolveHourlyTenantThrottle(
  process.env.ARR_UPLOAD_TENANT_THROTTLE_HOUR_LIMIT,
  ARR_UPLOAD_TENANT_THROTTLE_LIMIT,
);

const ARR_UPDATE_TENANT_THROTTLE_LIMIT = parseTenantThrottle(
  process.env.ARR_UPDATE_TENANT_THROTTLE_LIMIT,
  120,
);
const ARR_UPDATE_TENANT_THROTTLE_HOUR_LIMIT = resolveHourlyTenantThrottle(
  process.env.ARR_UPDATE_TENANT_THROTTLE_HOUR_LIMIT,
  ARR_UPDATE_TENANT_THROTTLE_LIMIT,
);

@Controller('arrs')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
@Roles(
  Role.ADMIN_GERAL,
  Role.ADMIN_EMPRESA,
  Role.TST,
  Role.SUPERVISOR,
  Role.COLABORADOR,
)
export class ArrsController {
  constructor(
    private readonly arrsService: ArrsService,
    private readonly fileInspectionService: FileInspectionService,
  ) {}

  private getRequestUserId(
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ): string | undefined {
    return req.user?.userId ?? req.user?.id ?? req.user?.sub;
  }

  @Post()
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_arrs')
  @ForensicAuditAction('create', 'arr')
  @TenantThrottle({
    requestsPerMinute: ARR_CREATE_TENANT_THROTTLE_LIMIT,
    requestsPerHour: ARR_CREATE_TENANT_THROTTLE_HOUR_LIMIT,
  })
  create(@Body() createArrDto: CreateArrDto) {
    return this.arrsService.create(createArrDto);
  }

  @Get()
  @Authorize('can_view_arrs')
  findAll(@Query() query: FindArrsQueryDto) {
    return this.arrsService.findPaginated(query);
  }

  @Get(':id')
  @Authorize('can_view_arrs')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.arrsService.findOne(id);
  }

  @Get(':id/pdf')
  @Authorize('can_view_arrs')
  getPdfAccess(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.arrsService.getPdfAccess(id);
  }

  @Post(':id/generate-final-pdf')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_arrs')
  @ForensicAuditAction('finalize', 'arr')
  async generateFinalPdf(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ) {
    return this.arrsService.generateFinalPdf(id, this.getRequestUserId(req));
  }

  @Get(':id/validation-context')
  @Authorize('can_view_arrs')
  getValidationContext(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.arrsService.getValidationContext(id);
  }

  @Post(':id/file')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_arrs')
  @ForensicAuditAction('finalize', 'arr')
  @TenantThrottle({
    requestsPerMinute: ARR_UPLOAD_TENANT_THROTTLE_LIMIT,
    requestsPerHour: ARR_UPLOAD_TENANT_THROTTLE_HOUR_LIMIT,
  })
  @UseInterceptors(FileInterceptor('file', createGovernedPdfUploadOptions()))
  async attachFile(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const pdfFile = await assertUploadedPdf(
      file,
      undefined,
      this.fileInspectionService,
    );
    try {
      return await this.arrsService.attachPdf(id, pdfFile, {
        userId: this.getRequestUserId(req),
      });
    } finally {
      await cleanupUploadedTempFile(pdfFile);
    }
  }

  @Patch(':id/status')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_arrs')
  @ForensicAuditAction('update', 'arr')
  @TenantThrottle({
    requestsPerMinute: ARR_STATUS_TENANT_THROTTLE_LIMIT,
    requestsPerHour: ARR_STATUS_TENANT_THROTTLE_HOUR_LIMIT,
  })
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('status') status: ArrStatus,
  ) {
    if (!Object.values(ArrStatus).includes(status)) {
      throw new BadRequestException(`Status inválido: ${status}`);
    }

    return this.arrsService.updateStatus(id, status);
  }

  @Patch(':id')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_arrs')
  @ForensicAuditAction('update', 'arr')
  @TenantThrottle({
    requestsPerMinute: ARR_UPDATE_TENANT_THROTTLE_LIMIT,
    requestsPerHour: ARR_UPDATE_TENANT_THROTTLE_HOUR_LIMIT,
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updateArrDto: UpdateArrDto,
  ) {
    return this.arrsService.update(id, updateArrDto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_arrs')
  @ForensicAuditAction('delete', 'arr')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.arrsService.remove(id);
  }
}
