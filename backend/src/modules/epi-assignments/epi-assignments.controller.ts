import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { Role } from '../auth/enums/roles.enum';
import { CreateEpiAssignmentDto } from './dto/create-epi-assignment.dto';
import {
  ReplaceEpiAssignmentDto,
  ReturnEpiAssignmentDto,
} from './dto/return-epi-assignment.dto';
import { UpdateEpiAssignmentDto } from './dto/update-epi-assignment.dto';
import { EpiAssignmentsService } from './epi-assignments.service';
import { Authorize } from '../auth/authorize.decorator';
import { CatalogQueryDto } from '../../shared/dto/catalog-query.dto';
import { FindEpiAssignmentsQueryDto } from './dto/find-epi-assignments-query.dto';
import { UsersService } from '../users/users.service';
import { EpisService } from '../epis/epis.service';
import { resolveLookupRole } from '../../shared/utils/lookup-role.util';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
  };
}

@Controller('epi-assignments')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
export class EpiAssignmentsController {
  constructor(
    private readonly assignmentsService: EpiAssignmentsService,
    private readonly usersService: UsersService,
    private readonly episService: EpisService,
  ) {}

  @Post()
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_epi_assignments')
  create(
    @Body() createDto: CreateEpiAssignmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignmentsService.create(createDto, req.user?.id);
  }

  @Get()
  @Authorize('can_view_epi_assignments')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  findAll(@Query() query: FindEpiAssignmentsQueryDto) {
    return this.assignmentsService.findPaginated({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      status: query.status,
      user_id: query.user_id,
      epi_id: query.epi_id,
    });
  }

  @Get('lookups/users')
  @Authorize('can_view_epi_assignments')
  async findLookupUsers(@Query() query: CatalogQueryDto) {
    const page = await this.usersService.findPaginated({
      page: query.page ?? 1,
      limit: query.limit ?? 100,
      search: query.search || undefined,
    });

    return {
      ...page,
      data: page.data.map((user) => ({
        id: user.id,
        nome: user.nome,
        funcao: user.funcao ?? '',
        role: resolveLookupRole(user.profile?.nome),
        company_id: user.company_id,
        site_id: user.site_id ?? undefined,
      })),
    };
  }

  @Get('lookups/epis')
  @Authorize('can_view_epi_assignments')
  async findLookupEpis(@Query() query: CatalogQueryDto) {
    const page = await this.episService.findPaginated({
      page: query.page ?? 1,
      limit: query.limit ?? 100,
      search: query.search || undefined,
    });

    return {
      ...page,
      data: page.data.map((epi) => ({
        id: epi.id,
        nome: epi.nome,
        ca: epi.ca ?? '',
        validade_ca: epi.validade_ca ?? null,
        company_id: epi.company_id,
      })),
    };
  }

  @Get('summary')
  @Authorize('can_view_epi_assignments')
  getSummary() {
    return this.assignmentsService.getSummary();
  }

  @Post(':id/generate-final-pdf')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_epi_assignments')
  generateFinalPdf(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignmentsService.generateFinalPdf(id, req.user?.id);
  }

  @Get(':id/pdf')
  @Authorize('can_view_epi_assignments')
  getPdfAccess(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.assignmentsService.getPdfAccess(id);
  }

  @Get(':id')
  @Authorize('can_view_epi_assignments')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.assignmentsService.findOne(id);
  }

  @Patch(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_epi_assignments')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateEpiAssignmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignmentsService.update(id, dto, req.user?.id);
  }

  @Post(':id/return')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
  )
  @Authorize('can_manage_epi_assignments')
  returnAssignment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReturnEpiAssignmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignmentsService.returnAssignment(id, dto, req.user?.id);
  }

  @Post(':id/replace')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
  @Authorize('can_manage_epi_assignments')
  replaceAssignment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReplaceEpiAssignmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignmentsService.replaceAssignment(id, dto, req.user?.id);
  }
}
