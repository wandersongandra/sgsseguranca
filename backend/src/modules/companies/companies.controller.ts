import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  NotFoundException,
  Req,
  ParseUUIDPipe,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { TenantService } from '../../shared/tenant/tenant.service';
import { TenantOptional } from '../../shared/decorators/tenant-optional.decorator';
import { Authorize } from '../auth/authorize.decorator';
import { AuthzOptional } from '../auth/authz-optional.decorator';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiStandardResponses } from '../../shared/swagger/api-standard-responses.decorator';
import { AuditAction as ForensicAuditAction } from '../../shared/decorators/audit-action.decorator';
import { CompanyResponseDto } from './dto/company-response.dto';
import { ExtendTrialDto } from './dto/extend-trial.dto';
import {
  normalizeOffsetPagination,
  OffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { normalizeOptionalSearchQuery } from '../../shared/utils/query-normalization.util';

type AuthReq = {
  user?: {
    company_id?: string;
  };
};

@ApiTags('companies')
@ApiBearerAuth('access-token')
@ApiStandardResponses({ includeNotFound: true })
@Controller('companies')
@TenantOptional()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class CompaniesController {
  constructor(
    private readonly companiesService: CompaniesService,
    private readonly tenantService: TenantService,
  ) {}

  @Post()
  @Roles(Role.SUPER_ADMIN)
  @Authorize('can_manage_companies')
  @ForensicAuditAction('create', 'company')
  create(@Body() createCompanyDto: CreateCompanyDto) {
    return this.companiesService.create(createCompanyDto);
  }

  @Get()
  @Roles(
    Role.SUPER_ADMIN,
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
  )
  @Authorize('can_view_companies')
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
  findAll(
    @Req() req: AuthReq,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ): Promise<OffsetPage<CompanyResponseDto>> {
    const normalizedSearch = normalizeOptionalSearchQuery(search);
    const isSuperAdmin = this.tenantService.isSuperAdmin();
    if (!isSuperAdmin) {
      const tenantId = req.user?.company_id || this.tenantService.getTenantId();
      const pagination = normalizeOffsetPagination(
        {
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
        { defaultLimit: 20, maxLimit: 100 },
      );

      if (!tenantId) {
        return Promise.resolve({
          data: [],
          total: 0,
          page: pagination.page,
          limit: pagination.limit,
          lastPage: 1,
        });
      }

      return this.companiesService.findOne(tenantId).then((company) => {
        const matchesSearch =
          !normalizedSearch ||
          [company.razao_social, company.cnpj, company.responsavel]
            .filter(Boolean)
            .some((value) =>
              value.toLowerCase().includes(normalizedSearch.toLowerCase()),
            );
        const data = matchesSearch ? [company] : [];

        return {
          data,
          total: data.length,
          page: pagination.page,
          limit: pagination.limit,
          lastPage: 1,
        };
      });
    }

    return this.companiesService.findPaginated({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
      search: normalizedSearch ?? undefined,
    });
  }

  /**
   * Logo da empresa do usuário autenticado, como data URL.
   * Sem permissão especial: a logo já é impressa nos documentos que qualquer
   * usuário do tenant emite (PT, DDS, checklists), então não é dado sensível.
   * Usa sempre o tenant do contexto — não aceita id arbitrário (anti-BOLA).
   */
  @Get('current/logo')
  @AuthzOptional()
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
    Role.TRABALHADOR,
  )
  getCurrentCompanyLogo(@Req() req: AuthReq) {
    const tenantId = req.user?.company_id || this.tenantService.getTenantId();
    if (!tenantId) {
      throw new NotFoundException('Empresa não encontrada.');
    }
    return this.companiesService.getLogoDataUrl(tenantId);
  }

  @Get(':id')
  @Authorize('can_view_companies')
  findOne(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: AuthReq) {
    // Broken Object Level Authorization (BOLA) fix:
    // - companies é uma tabela global (sem company_id e sem RLS)
    // - usuários comuns só podem acessar a própria empresa
    const tenantId = req.user?.company_id || this.tenantService.getTenantId();
    const isSuperAdmin = this.tenantService.isSuperAdmin();

    // Anti-oracle: retornar 404 evita diferenciar "não existe" vs "não pertence ao tenant".
    if (!isSuperAdmin && (!tenantId || id !== tenantId)) {
      throw new NotFoundException('Empresa não encontrada.');
    }
    return this.companiesService.findOne(id);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  @Authorize('can_manage_companies')
  @ForensicAuditAction('update', 'company')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updateCompanyDto: UpdateCompanyDto,
  ) {
    return this.companiesService.update(id, updateCompanyDto);
  }

  @Post(':id/activate')
  @Roles(Role.SUPER_ADMIN)
  @Authorize('can_manage_companies')
  @HttpCode(HttpStatus.OK)
  @ForensicAuditAction('activate', 'company')
  activateTenant(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companiesService.activateTenant(id);
  }

  @Post(':id/extend-trial')
  @Roles(Role.SUPER_ADMIN)
  @Authorize('can_manage_companies')
  @HttpCode(HttpStatus.OK)
  @ForensicAuditAction('extend_trial', 'company')
  extendTrial(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ExtendTrialDto,
  ) {
    return this.companiesService.extendTrial(id, dto.extraDays);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  @Authorize('can_manage_companies')
  @ForensicAuditAction('delete', 'company')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companiesService.remove(id);
  }
}
