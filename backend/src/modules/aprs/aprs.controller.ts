import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Delete,
  Logger,
  UseGuards,
  UseInterceptors,
  Req,
  Query,
  UnauthorizedException,
  Header,
  StreamableFile,
  UploadedFile,
  BadRequestException,
  GoneException,
  HttpException,
} from '@nestjs/common';
import { AprFeatureFlag } from './decorators/apr-feature-flag.decorator';
import { AprMetricsInterceptor } from './interceptors/apr-metrics.interceptor';
import { AprEvidenceUploadDto } from './dto/apr-evidence-upload.dto';
import { AprControlSuggestionsDto } from './dto/apr-control-suggestions.dto';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { AprsService } from './aprs.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { CreateAprDto } from './dto/create-apr.dto';
import { UpdateAprDto } from './dto/update-apr.dto';
import { ApproveAprDto } from './dto/approve-apr.dto';
import { RejectAprDto } from './dto/reject-apr.dto';
import { PdfRateLimitService } from '../auth/services/pdf-rate-limit.service';
import { AprListItemDto } from './dto/apr-list-item.dto';
import { AprResponseDto, toAprResponseDto } from './dto/apr-response.dto';
import { Authorize } from '../auth/authorize.decorator';
import { APR_PERMISSIONS } from './apr-permissions.constants';
import { TenantThrottle } from '../../shared/decorators/tenant-throttle.decorator';
import { UserThrottle } from '../../shared/decorators/user-throttle.decorator';
import { OffsetPage } from '../../shared/utils/offset-pagination.util';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiStandardResponses } from '../../shared/swagger/api-standard-responses.decorator';
import { AuditAction as ForensicAuditAction } from '../../shared/decorators/audit-action.decorator';
import { RequestTimeout } from '../../shared/decorators/request-timeout.decorator';
import { PdfRequestTimeout } from '../../shared/decorators/pdf-request-timeout.decorator';
import { normalizeOptionalSearchQuery } from '../../shared/utils/query-normalization.util';
import { HttpCache } from '../../shared/decorators/http-cache.decorator';
import {
  parseRateLimit,
  resolveHourlyRateLimit,
} from '../../shared/rate-limit/rate-limit-config.util';
import {
  cleanupUploadedTempFile,
  createTemporaryUploadOptions,
  fileUploadOptions,
  readUploadedFileBuffer,
  validateFileMagicBytes,
} from '../../shared/interceptors/file-upload.interceptor';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { getRequestIp } from '../../shared/utils/request-ip.util';

const APR_LIST_SORT_OPTIONS = [
  'priority',
  'updated-desc',
  'deadline-asc',
  'title-asc',
] as const;

const APR_CREATE_TENANT_THROTTLE_LIMIT = parseRateLimit(
  process.env.APR_CREATE_TENANT_THROTTLE_LIMIT,
  60,
);
const APR_CREATE_TENANT_THROTTLE_HOUR_LIMIT = resolveHourlyRateLimit(
  process.env.APR_CREATE_TENANT_THROTTLE_HOUR_LIMIT,
  APR_CREATE_TENANT_THROTTLE_LIMIT,
);
const APR_CREATE_USER_THROTTLE_LIMIT = parseRateLimit(
  process.env.APR_CREATE_USER_THROTTLE_LIMIT,
  20,
);

const APR_LIST_TENANT_THROTTLE_LIMIT = parseRateLimit(
  process.env.APR_LIST_TENANT_THROTTLE_LIMIT,
  240,
);
const APR_LIST_TENANT_THROTTLE_HOUR_LIMIT = resolveHourlyRateLimit(
  process.env.APR_LIST_TENANT_THROTTLE_HOUR_LIMIT,
  APR_LIST_TENANT_THROTTLE_LIMIT,
);
const APR_LIST_USER_THROTTLE_LIMIT = parseRateLimit(
  process.env.APR_LIST_USER_THROTTLE_LIMIT,
  120,
);

// PDF final (Puppeteer) — rota cara em CPU/memória, compartilha o mesmo
// Chromium da VPS que hospeda API+Worker+Redis+ClamAV. Teto dedicado evita
// que um usuário em loop sature o processo de renderização.
const APR_PDF_USER_THROTTLE_LIMIT = parseRateLimit(
  process.env.APR_PDF_USER_THROTTLE_LIMIT,
  5,
);
const APR_PDF_TENANT_THROTTLE_LIMIT = parseRateLimit(
  process.env.APR_PDF_TENANT_THROTTLE_LIMIT,
  20,
);
// Teto horário FIXO via parseRateLimit (NÃO resolveHourlyRateLimit, que
// derivaria perMinute*60 = 1200/h) — achado da auditoria v2:
// @TenantThrottle cria um bucket DEDICADO por rota — ele não soma ao bucket
// global do plano, substitui. Se o teto horário caísse no default derivado,
// o teto por hora desta rota Puppeteer ficaria mais solto que o orçamento
// horário global do tenant, na prática afrouxando a proteção que este
// throttle existe para dar.
const APR_PDF_TENANT_THROTTLE_HOUR_LIMIT = parseRateLimit(
  process.env.APR_PDF_TENANT_THROTTLE_HOUR_LIMIT,
  60,
);

// Bundle semanal (Puppeteer) — reconstrói o pacote inteiro a cada chamada,
// sem cache. Teto mais apertado que o do PDF individual.
const APR_BUNDLE_USER_THROTTLE_LIMIT = parseRateLimit(
  process.env.APR_BUNDLE_USER_THROTTLE_LIMIT,
  2,
);
const APR_BUNDLE_TENANT_THROTTLE_LIMIT = parseRateLimit(
  process.env.APR_BUNDLE_TENANT_THROTTLE_LIMIT,
  6,
);
// Teto horário FIXO via parseRateLimit — mesmo motivo do APR_PDF acima
// (achado da auditoria v2): resolveHourlyRateLimit derivaria 6*60=360/h,
// bem mais solto que o orçamento horário global do tenant.
const APR_BUNDLE_TENANT_THROTTLE_HOUR_LIMIT = parseRateLimit(
  process.env.APR_BUNDLE_TENANT_THROTTLE_HOUR_LIMIT,
  20,
);

type AprListSortOption = (typeof APR_LIST_SORT_OPTIONS)[number];

const resolveAprFinalPdfRequestTimeoutMs = (): number => {
  const raw = process.env.APR_FINAL_PDF_REQUEST_TIMEOUT_MS;
  const configured = Number(raw);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  if (raw !== undefined && raw !== '') {
    Logger.warn(
      `APR_FINAL_PDF_REQUEST_TIMEOUT_MS="${raw}" rejeitado (deve ser número positivo); usando default 180000ms`,
      'AprController',
    );
  }
  return 180_000;
};

@ApiTags('aprs')
@ApiBearerAuth('access-token')
@ApiStandardResponses({ includeNotFound: true })
@Controller('aprs')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
@Roles(
  Role.ADMIN_GERAL,
  Role.ADMIN_EMPRESA,
  Role.TST,
  Role.SUPERVISOR,
  Role.COLABORADOR,
)
export class AprsController {
  private getRequestRoleName(
    req: Request & {
      user?: {
        id?: string;
        userId?: string;
        sub?: string;
        profile?: { nome?: string | null };
      };
    },
  ): string | undefined {
    return req.user?.profile?.nome ?? undefined;
  }

  /**
   * Coleta todos os sinais de papel disponíveis para autorização baseada em
   * papel: o `profile.nome` do token e o array `roles` que o RolesGuard popula
   * (via RBAC) quando o token não carrega o nome do perfil. O serviço normaliza
   * cada um com a mesma lógica canônica do RolesGuard.
   */
  private getRequestRoleSignals(
    req: Request & {
      user?: {
        profile?: { nome?: string | null };
        roles?: string[];
      };
    },
  ): string[] {
    const signals = [
      req.user?.profile?.nome,
      ...(Array.isArray(req.user?.roles) ? req.user.roles : []),
    ];
    return signals.filter(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    );
  }

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
    private readonly aprsService: AprsService,
    private readonly pdfRateLimitService: PdfRateLimitService,
    private readonly fileInspectionService: FileInspectionService,
  ) {}

  @Post()
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.COLABORADOR)
  @Authorize(APR_PERMISSIONS.CREATE)
  @RequestTimeout(120_000)
  @UserThrottle({ requestsPerMinute: APR_CREATE_USER_THROTTLE_LIMIT })
  @TenantThrottle({
    requestsPerMinute: APR_CREATE_TENANT_THROTTLE_LIMIT,
    requestsPerHour: APR_CREATE_TENANT_THROTTLE_HOUR_LIMIT,
  })
  create(
    @Body() createAprDto: CreateAprDto,
    @Req()
    req: Request & {
      user?: {
        id?: string;
        userId?: string;
        sub?: string;
        profile?: { nome?: string | null };
        roles?: string[];
      };
    },
  ): Promise<AprResponseDto> {
    return this.aprsService
      .create(createAprDto, this.getRequestUserId(req), {
        roleNames: this.getRequestRoleSignals(req),
      })
      .then(toAprResponseDto);
  }

  @Get()
  @Authorize(APR_PERMISSIONS.VIEW)
  @UserThrottle({ requestsPerMinute: APR_LIST_USER_THROTTLE_LIMIT })
  @TenantThrottle({
    requestsPerMinute: APR_LIST_TENANT_THROTTLE_LIMIT,
    requestsPerHour: APR_LIST_TENANT_THROTTLE_HOUR_LIMIT,
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Número da página',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Limite de itens por página (máx. 100)',
  })
  @ApiQuery({
    name: 'site_id',
    required: false,
    type: String,
    description: 'Filtra a fila por obra/unidade',
  })
  @ApiQuery({
    name: 'responsible_id',
    required: false,
    type: String,
    description: 'Filtra a fila pelo responsável operacional resolvido',
  })
  @ApiQuery({
    name: 'due_filter',
    required: false,
    type: String,
    description:
      'Filtra por janela de vencimento: today, next-7-days, expired, upcoming, no-deadline',
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    type: String,
    description:
      'Ordenação operacional: priority, updated-desc, deadline-asc, title-asc',
  })
  @ApiQuery({
    name: 'context_filter',
    required: false,
    type: String,
    description:
      'Filtro contextual: minhas (elaboradas por mim), vence-hoje, preciso-assinar',
  })
  findPaginated(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('site_id') siteId?: string,
    @Query('responsible_id') responsibleId?: string,
    @Query('due_filter') dueFilter?: string,
    @Query('sort') sort?: string,
    @Query('is_modelo_padrao') isModeloPadrao?: string,
    @Query('context_filter') contextFilter?: string,
    @Req()
    req?: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ): Promise<OffsetPage<AprListItemDto>> {
    const normalizedSearch = normalizeOptionalSearchQuery(search);
    const normalizedSort = APR_LIST_SORT_OPTIONS.includes(
      sort as AprListSortOption,
    )
      ? (sort as AprListSortOption)
      : undefined;

    const validContextFilters = [
      'minhas',
      'vence-hoje',
      'preciso-assinar',
    ] as const;
    type ValidContextFilter = (typeof validContextFilters)[number];
    const normalizedContextFilter = validContextFilters.includes(
      contextFilter as ValidContextFilter,
    )
      ? (contextFilter as ValidContextFilter)
      : undefined;

    return this.aprsService.findPaginated({
      page: Number(page),
      limit: Number(limit),
      search: normalizedSearch ?? undefined,
      status: status || undefined,
      siteId: siteId || undefined,
      responsibleId: responsibleId || undefined,
      dueFilter: dueFilter || undefined,
      sort: normalizedSort,
      isModeloPadrao:
        isModeloPadrao === undefined ? undefined : isModeloPadrao === 'true',
      contextFilter: normalizedContextFilter,
      userId: req ? this.getRequestUserId(req) : undefined,
    });
  }

  @Get('files/list')
  @Authorize(APR_PERMISSIONS.VIEW)
  listStoredFiles(@Query('year') year?: string, @Query('week') week?: string) {
    return this.aprsService.listStoredFiles({
      year: year ? Number(year) : undefined,
      week: week ? Number(week) : undefined,
    });
  }

  @Get('files/weekly-bundle')
  @Authorize(APR_PERMISSIONS.VIEW)
  @PdfRequestTimeout()
  @UserThrottle({ requestsPerMinute: APR_BUNDLE_USER_THROTTLE_LIMIT })
  @TenantThrottle({
    requestsPerMinute: APR_BUNDLE_TENANT_THROTTLE_LIMIT,
    requestsPerHour: APR_BUNDLE_TENANT_THROTTLE_HOUR_LIMIT,
  })
  async getWeeklyBundle(
    @Query('year') year?: string,
    @Query('week') week?: string,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.aprsService.getWeeklyBundle({
      year: year ? Number(year) : undefined,
      week: week ? Number(week) : undefined,
    });
    return new StreamableFile(buffer, {
      disposition: `attachment; filename="${fileName}"`,
      type: 'application/pdf',
    });
  }

  @Get('export/excel')
  @Authorize(APR_PERMISSIONS.VIEW)
  @UserThrottle({ requestsPerMinute: 10 })
  @Header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @Header('Content-Disposition', 'attachment; filename="aprs.xlsx"')
  async exportExcel(): Promise<StreamableFile> {
    const buffer = await this.aprsService.exportExcel();
    return new StreamableFile(buffer);
  }

  @Get('export/excel/template')
  @Authorize(APR_PERMISSIONS.VIEW)
  @HttpCache({ maxAge: 3600, visibility: 'private' })
  @Header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @Header(
    'Content-Disposition',
    'attachment; filename="apr-template-importacao.xlsx"',
  )
  async exportExcelTemplate(): Promise<StreamableFile> {
    const buffer = await this.aprsService.exportExcelTemplate();
    return new StreamableFile(buffer);
  }

  @Post('import/excel/preview')
  @Authorize(APR_PERMISSIONS.CREATE)
  @UseInterceptors(
    FileInterceptor(
      'file',
      createTemporaryUploadOptions({ maxFileSize: 15 * 1024 * 1024 }),
    ),
  )
  async previewExcelImport(@UploadedFile() file: Express.Multer.File) {
    const buffer = await readUploadedFileBuffer(
      file,
      'Nenhuma planilha enviada.',
    );
    validateFileMagicBytes(buffer, [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ]);
    await this.fileInspectionService.inspect(buffer, file.originalname);

    try {
      return this.aprsService.previewExcelImport(buffer, file.originalname);
    } finally {
      await cleanupUploadedTempFile(file);
    }
  }

  /** Lista todos os tipos de atividade com templates de risco disponíveis */
  @Get('activity-templates')
  @Authorize(APR_PERMISSIONS.VIEW)
  @HttpCache({ maxAge: 86400, visibility: 'private' })
  listActivityTemplates() {
    return this.aprsService.listActivityTemplates();
  }

  /** Retorna o template de itens de risco para um tipo de atividade */
  @Get('activity-templates/:tipoAtividade')
  @Authorize(APR_PERMISSIONS.VIEW)
  @HttpCache({ maxAge: 86400, visibility: 'private' })
  getActivityTemplate(@Param('tipoAtividade') tipoAtividade: string) {
    return this.aprsService.getActivityTemplate(tipoAtividade);
  }

  @Get('risks/matrix')
  @Authorize(APR_PERMISSIONS.VIEW)
  getRiskMatrix(
    // ParseUUIDPipe (achado da auditoria v2): sem isso, um site_id
    // arbitrário (ex.: contendo ':') entra sem validação na chave de cache
    // Redis do getRiskMatrix() e só falha depois, ao virar WHERE ... = :siteId
    // sobre coluna uuid (erro 22P02 → 500) — defesa acidental, não desenhada.
    @Query('site_id', new ParseUUIDPipe({ optional: true })) siteId?: string,
  ) {
    return this.aprsService.getRiskMatrix(siteId || undefined);
  }

  @Post('risk-controls/suggestions')
  @Authorize(APR_PERMISSIONS.VIEW)
  getControlSuggestions(@Body() payload: AprControlSuggestionsDto) {
    return this.aprsService.getControlSuggestions(payload);
  }

  /** Analytics overview para o dashboard */
  @Get('analytics/overview')
  @Authorize(APR_PERMISSIONS.VIEW)
  @AprFeatureFlag('APR_ANALYTICS')
  getAnalyticsOverview() {
    return this.aprsService.getAnalyticsOverview();
  }

  @Get('capabilities')
  @Authorize(APR_PERMISSIONS.VIEW)
  getCapabilities() {
    return this.aprsService.getCapabilities();
  }

  @Get(':id/export/excel')
  @Authorize(APR_PERMISSIONS.VIEW)
  @UserThrottle({ requestsPerMinute: 10 })
  @Header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @PdfRequestTimeout()
  async exportExcelById(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.aprsService.exportAprExcel(id);
    return new StreamableFile(buffer, {
      disposition: `attachment; filename="${fileName}"`,
    });
  }

  @Get(':id')
  @Authorize(APR_PERMISSIONS.VIEW)
  @UseInterceptors(AprMetricsInterceptor)
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AprResponseDto> {
    return toAprResponseDto(await this.aprsService.findOne(id));
  }

  @Get(':id/validate')
  @Authorize(APR_PERMISSIONS.VIEW)
  @AprFeatureFlag('APR_RULES_ENGINE')
  async validateApr(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.aprsService.validateCompliance(id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize(APR_PERMISSIONS.APPROVE)
  @ForensicAuditAction('approve', 'apr')
  async submitApr(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ApproveAprDto,
    @Req()
    req: Request & {
      user?: {
        id?: string;
        userId?: string;
        sub?: string;
        profile?: { nome?: string | null };
        roles?: string[];
      };
    },
  ): Promise<AprResponseDto> {
    const userId = this.getRequestUserId(req);
    if (!userId) throw new UnauthorizedException('Usuário não identificado.');
    const apr = await this.aprsService.submit(id, userId, body.reason, {
      roleName: this.getRequestRoleName(req),
      roleNames: this.getRequestRoleSignals(req),
      ipAddress: this.getRequestIp(req),
    });
    return toAprResponseDto(apr);
  }

  /** Retorna URL assinada (S3) ou null do PDF armazenado */
  @Get(':id/pdf')
  @Authorize(APR_PERMISSIONS.VIEW)
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
    return this.aprsService.getPdfAccess(id);
  }

  /** Histórico de ações/logs da APR */
  @Get(':id/logs')
  @Authorize(APR_PERMISSIONS.VIEW)
  getLogs(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.aprsService.getLogs(id);
  }

  /** Histórico de versões (todas as versões da mesma raiz) */
  @Get(':id/versions')
  @Authorize(APR_PERMISSIONS.VIEW)
  getVersionHistory(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.aprsService.getVersionHistory(id);
  }

  @Get(':id/compare/:targetId')
  @Authorize(APR_PERMISSIONS.VIEW)
  compareVersions(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('targetId', new ParseUUIDPipe()) targetId: string,
  ) {
    return this.aprsService.compareVersions(id, targetId);
  }

  /** Evidências de risco com URLs assinadas quando disponíveis */
  @Get(':id/evidence')
  @Authorize(APR_PERMISSIONS.VIEW)
  listAprEvidences(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.aprsService.listAprEvidences(id);
  }

  /** Upload de evidência fotográfica vinculada a um item de risco */
  @Post(':id/risk-items/:riskItemId/evidence')
  @Authorize(APR_PERMISSIONS.UPDATE)
  @UseInterceptors(FileInterceptor('file', fileUploadOptions))
  async uploadRiskEvidence(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('riskItemId', new ParseUUIDPipe()) riskItemId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body()
    body: AprEvidenceUploadDto,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ) {
    if (!file) {
      throw new BadRequestException('Nenhuma imagem enviada.');
    }

    const buffer = await readUploadedFileBuffer(file);
    validateFileMagicBytes(buffer, ['image/jpeg', 'image/png']);
    await this.fileInspectionService.inspect(buffer, file.originalname);

    try {
      return await this.aprsService.uploadRiskEvidence(
        id,
        riskItemId,
        file,
        {
          captured_at: body.captured_at,
          latitude: body.latitude,
          longitude: body.longitude,
          accuracy_m: body.accuracy_m,
          device_id: body.device_id,
          exif_datetime: body.exif_datetime,
        },
        this.getRequestUserId(req),
        this.getRequestIp(req),
      );
    } finally {
      await cleanupUploadedTempFile(file);
    }
  }

  /** Fluxo descontinuado: PDF final oficial da APR e gerado somente pelo backend. */
  @Post(':id/file')
  @Roles(Role.ADMIN_GERAL)
  @Authorize(APR_PERMISSIONS.IMPORT_PDF)
  attachFile(@Param('id', new ParseUUIDPipe()) _id: string) {
    throw new GoneException(
      'O anexo manual de PDF final da APR foi descontinuado. Gere o PDF final oficial pelo endpoint /aprs/:id/generate-final-pdf.',
    );
  }

  @Post(':id/generate-final-pdf')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize(APR_PERMISSIONS.GENERATE_PDF)
  @RequestTimeout(resolveAprFinalPdfRequestTimeoutMs())
  @UserThrottle({ requestsPerMinute: APR_PDF_USER_THROTTLE_LIMIT })
  @TenantThrottle({
    requestsPerMinute: APR_PDF_TENANT_THROTTLE_LIMIT,
    requestsPerHour: APR_PDF_TENANT_THROTTLE_HOUR_LIMIT,
  })
  async generateFinalPdf(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ) {
    return this.aprsService.generateFinalPdf(id, this.getRequestUserId(req));
  }

  /** Aprova a APR — Pendente → Aprovada. */
  @Patch(':id/approve')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize(APR_PERMISSIONS.APPROVE)
  @ForensicAuditAction('approve', 'apr')
  async approvePatch(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ApproveAprDto,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ): Promise<AprResponseDto> {
    return this.executeApprove(id, body.reason, req);
  }

  /** Reprova/Cancela a APR — Pendente/Aprovada → Cancelada. */
  @Patch(':id/reject')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize(APR_PERMISSIONS.REJECT)
  @ForensicAuditAction('reject', 'apr')
  async rejectPatch(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RejectAprDto,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ): Promise<AprResponseDto> {
    return this.executeReject(id, body.reason, req);
  }

  /** Encerra a APR — Aprovada → Encerrada. */
  @Patch(':id/finalize')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize(APR_PERMISSIONS.FINALIZE)
  @ForensicAuditAction('finalize', 'apr')
  async finalizePatch(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ): Promise<AprResponseDto> {
    return this.executeFinalize(id, req);
  }

  /** Cria nova versão a partir de APR Aprovada */
  @Post(':id/new-version')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize(APR_PERMISSIONS.UPDATE)
  async createNewVersion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ): Promise<AprResponseDto> {
    const userId = this.getRequestUserId(req);
    if (!userId) throw new UnauthorizedException('Usuário não identificado');
    return toAprResponseDto(
      await this.aprsService.createNewVersion(id, userId),
    );
  }

  @Patch(':id')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize(APR_PERMISSIONS.UPDATE)
  @RequestTimeout(120_000)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updateAprDto: UpdateAprDto,
    @Req()
    req: Request & {
      user?: {
        id?: string;
        userId?: string;
        sub?: string;
        profile?: { nome?: string | null };
        roles?: string[];
      };
    },
  ): Promise<AprResponseDto> {
    return this.aprsService
      .update(id, updateAprDto, this.getRequestUserId(req), {
        roleNames: this.getRequestRoleSignals(req),
      })
      .then(toAprResponseDto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize(APR_PERMISSIONS.DELETE)
  @ForensicAuditAction('delete', 'apr')
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req()
    req: Request & {
      user?: { id?: string; userId?: string; sub?: string };
    },
  ) {
    return this.aprsService.remove(id, this.getRequestUserId(req));
  }

  private async executeApprove(
    id: string,
    reason: string | undefined,
    req: Request & {
      user?: {
        id?: string;
        userId?: string;
        sub?: string;
        profile?: { nome?: string | null };
      };
    },
  ): Promise<AprResponseDto> {
    const userId = this.getRequestUserId(req);
    if (!userId) throw new UnauthorizedException('Usuário não identificado');
    return toAprResponseDto(
      await this.aprsService.approve(id, userId, reason, {
        roleName: this.getRequestRoleName(req),
        roleNames: this.getRequestRoleSignals(req),
        ipAddress: this.getRequestIp(req),
      }),
    );
  }

  private async executeReject(
    id: string,
    reason: string,
    req: Request & {
      user?: {
        id?: string;
        userId?: string;
        sub?: string;
        profile?: { nome?: string | null };
      };
    },
  ): Promise<AprResponseDto> {
    const userId = this.getRequestUserId(req);
    if (!userId) throw new UnauthorizedException('Usuário não identificado');
    if (!reason)
      throw new BadRequestException('Motivo de reprovação obrigatório');
    return toAprResponseDto(
      await this.aprsService.reject(id, userId, reason, {
        roleName: this.getRequestRoleName(req),
        roleNames: this.getRequestRoleSignals(req),
        ipAddress: this.getRequestIp(req),
      }),
    );
  }

  private async executeFinalize(
    id: string,
    req: Request & {
      user?: {
        id?: string;
        userId?: string;
        sub?: string;
        profile?: { nome?: string | null };
      };
    },
  ): Promise<AprResponseDto> {
    const userId = this.getRequestUserId(req);
    if (!userId) throw new UnauthorizedException('Usuário não identificado');
    return toAprResponseDto(
      await this.aprsService.finalize(id, userId, {
        roleName: this.getRequestRoleName(req),
        roleNames: this.getRequestRoleSignals(req),
        ipAddress: this.getRequestIp(req),
      }),
    );
  }
}
