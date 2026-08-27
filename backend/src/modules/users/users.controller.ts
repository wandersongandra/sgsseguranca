import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  ParseUUIDPipe,
  Delete,
  UseGuards,
  UseInterceptors,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { WorkerOperationalStatusService } from './worker-operational-status.service';
import { WorkerTimelineService } from './worker-timeline.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { FindUsersQueryDto } from './dto/find-users-query.dto';
import { UpdateUserDetailsDto } from './dto/update-user-details.dto';
import { UpdateAiConsentDto } from './dto/update-ai-consent.dto';
import { WorkerCpfLookupDto } from './dto/worker-cpf-lookup.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { ExportMyDataResponseDto } from './dto/export-my-data-response.dto';
import { Authorize } from '../auth/authorize.decorator';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserModuleAccessDto } from './dto/update-user-module-access.dto';
import { AuditAction as ForensicAuditAction } from '../../shared/decorators/audit-action.decorator';
import { OffsetPage } from '../../shared/utils/offset-pagination.util';
import { UserThrottle } from '../../shared/decorators/user-throttle.decorator';
import {
  SensitiveAction,
  SensitiveActionGuard,
} from '../../shared/security/sensitive-action.guard';
import { AuditRead } from '../../shared/security/audit-read.decorator';
import { ConsentsService } from '../consents/consents.service';
import { getRequestIp } from '../../shared/utils/request-ip.util';

type AuthenticatedRequest = ExpressRequest & {
  user?: { sub?: string; userId?: string };
};

@ApiTags('users')
@Controller('users')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('access-token')
@Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly workerOperationalStatusService: WorkerOperationalStatusService,
    private readonly workerTimelineService: WorkerTimelineService,
    private readonly consentsService: ConsentsService,
  ) {}

  /**
   * GET /users/me/export
   *
   * Exporta os dados pessoais do usuário autenticado (LGPD Art. 20 — Portabilidade).
   * Retorna JSON estruturado com todos os dados pessoais sem segredos (senha, PIN).
   * Registra trilha de auditoria com AuditAction.DATA_PORTABILITY.
   *
   * Rate limit: 3 req/min por usuário (export é operação custosa — I/O + auditoria).
   */
  @Get('me/export')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
    Role.TRABALHADOR,
  )
  @UseGuards(SensitiveActionGuard)
  @SensitiveAction('user_data_export')
  @UserThrottle({ requestsPerMinute: 3 })
  @ApiOperation({ summary: 'Exportar meus dados pessoais (LGPD Art. 20)' })
  @ApiResponse({
    status: 200,
    description: 'Dados pessoais exportados com sucesso',
    type: ExportMyDataResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  @ApiResponse({ status: 429, description: 'Rate limit excedido (3 req/min)' })
  async exportMyData(
    @Req() req: AuthenticatedRequest,
  ): Promise<ExportMyDataResponseDto> {
    const userId = req.user?.sub ?? req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Usuário não autenticado.');
    }
    return this.usersService.exportMyData(userId);
  }

  /**
   * PATCH /users/me/ai-consent
   *
   * Atualiza o consentimento do usuário autenticado para processamento por IA (LGPD).
   * Qualquer usuário autenticado pode atualizar seu próprio consentimento.
   */
  @Patch('me/ai-consent')
  @Roles(
    Role.ADMIN_GERAL,
    Role.ADMIN_EMPRESA,
    Role.TST,
    Role.SUPERVISOR,
    Role.COLABORADOR,
    Role.TRABALHADOR,
  )
  async updateMyAiConsent(
    @Body() dto: UpdateAiConsentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req.user?.sub ?? req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Usuário não autenticado.');
    }
    const ip = getRequestIp(req) ?? 'unknown';
    const userAgentHeader = req.headers['user-agent'];
    const userAgent = Array.isArray(userAgentHeader)
      ? userAgentHeader.join(' ')
      : userAgentHeader || 'unknown';

    if (dto.consent) {
      await this.consentsService.accept(userId, 'ai_processing', undefined, {
        ip,
        userAgent,
      });
    } else {
      await this.consentsService.revoke(userId, 'ai_processing', {
        ip,
        userAgent,
      });
    }

    return this.usersService.updateAiConsent(userId, dto.consent);
  }

  @Post()
  @Authorize('can_manage_users')
  @ApiOperation({ summary: 'Criar novo usuário' })
  @ApiResponse({
    status: 201,
    description: 'Usuário criado com sucesso',
    type: UserResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Dados inválidos',
    schema: {
      example: {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Dados inválidos',
          details: ['CPF já cadastrado'],
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 403, description: 'Sem permissão' })
  create(@Body() createUserDto: CreateUserDto): Promise<UserResponseDto> {
    return this.usersService.create(createUserDto);
  }

  @Get()
  @Authorize('can_view_users')
  @ApiOperation({ summary: 'Listar todos os usuários' })
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
    description: 'Limite de itens por página',
  })
  @ApiQuery({
    name: 'site_id',
    required: false,
    type: String,
    description: 'Filtro por obra/site',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de usuários retornada com sucesso',
    schema: {
      example: {
        data: [
          {
            id: '123e4567-e89b-12d3-a456-426614174000',
            nome: 'João da Silva',
            cpf: '12345678900',
            email: 'joao@example.com',
            status: true,
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        lastPage: 1,
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 403, description: 'Sem permissão' })
  findPaginated(
    @Query() query: FindUsersQueryDto,
  ): Promise<OffsetPage<UserResponseDto>> {
    return this.usersService.findPaginated({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      search: query.search || undefined,
      siteId: query.site_id || undefined,
      identityType: query.identity_type,
      accessStatus: query.access_status,
    });
  }

  @Get('module-access-options')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA)
  @Authorize('can_manage_users')
  @ApiOperation({ summary: 'Listar módulos liberáveis por usuário' })
  @ApiResponse({
    status: 200,
    description: 'Catálogo de módulos retornado com sucesso',
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 403, description: 'Sem permissão' })
  getModuleAccessOptions() {
    return { modules: this.usersService.listModuleAccessOptions() };
  }

  @Post('worker-status/by-cpf')
  @Authorize('can_view_users')
  @ApiOperation({
    summary: 'Consultar status operacional do trabalhador por CPF',
  })
  @ApiResponse({
    status: 200,
    description: 'Status operacional retornado com sucesso',
  })
  @ApiResponse({ status: 404, description: 'Trabalhador não encontrado' })
  getWorkerStatusByCpf(@Body() dto: WorkerCpfLookupDto) {
    return this.workerOperationalStatusService.getByCpf(dto.cpf);
  }

  @Post('worker-status/by-cpf/timeline')
  @Authorize('can_view_users')
  @ApiOperation({
    summary: 'Consultar timeline operacional do trabalhador por CPF',
  })
  @ApiResponse({
    status: 200,
    description: 'Timeline operacional retornada com sucesso',
  })
  @ApiResponse({ status: 404, description: 'Trabalhador não encontrado' })
  getWorkerTimelineByCpf(@Body() dto: WorkerCpfLookupDto) {
    return this.workerTimelineService.getByCpf(dto.cpf);
  }

  @Get(':id')
  @Authorize('can_view_users')
  @AuditRead('user_personal_data')
  @ApiOperation({ summary: 'Buscar usuário por ID' })
  @ApiParam({ name: 'id', description: 'ID do usuário', type: String })
  @ApiResponse({
    status: 200,
    description: 'Usuário encontrado com sucesso',
    type: UserResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 403, description: 'Sem permissão' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<UserResponseDto> {
    return this.usersService.findOne(id);
  }

  @Get(':id/timeline')
  @Authorize('can_view_users')
  @ApiOperation({
    summary: 'Consultar timeline operacional do trabalhador por ID',
  })
  @ApiParam({ name: 'id', description: 'ID do usuário', type: String })
  @ApiResponse({
    status: 200,
    description: 'Timeline operacional retornada com sucesso',
  })
  @ApiResponse({ status: 404, description: 'Trabalhador não encontrado' })
  getWorkerTimeline(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.workerTimelineService.getByUserId(id);
  }

  @Patch(':id')
  @Authorize('can_manage_users')
  @ApiOperation({ summary: 'Atualizar usuário' })
  @ApiParam({ name: 'id', description: 'ID do usuário', type: String })
  @ApiResponse({
    status: 200,
    description: 'Usuário atualizado com sucesso',
    type: UserResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Dados inválidos',
    schema: {
      example: {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Dados inválidos',
          details: ['Email já cadastrado'],
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 403, description: 'Sem permissão' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updateUserDto: UpdateUserDetailsDto,
  ): Promise<UserResponseDto> {
    return this.usersService.update(id, updateUserDto);
  }

  @Patch(':id/role')
  @Authorize('can_manage_users')
  @UseGuards(SensitiveActionGuard)
  @SensitiveAction('user_role_change')
  @ForensicAuditAction('role_change', 'user')
  @ApiOperation({ summary: 'Atualizar role/perfil do usuário' })
  @ApiParam({ name: 'id', description: 'ID do usuário', type: String })
  @ApiResponse({
    status: 200,
    description: 'Role do usuário atualizada com sucesso',
    type: UserResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 403, description: 'Sem permissão' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  updateRole(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserRoleDto,
  ): Promise<UserResponseDto> {
    // role change is now protected by step-up MFA
    return this.usersService.update(id, { profile_id: dto.profile_id });
  }

  @Patch(':id/module-access')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA)
  @Authorize('can_manage_users')
  @UseGuards(SensitiveActionGuard)
  @SensitiveAction('user_module_access_change')
  @ForensicAuditAction('permission_change', 'user')
  @ApiOperation({ summary: 'Liberar módulos para um usuário' })
  @ApiParam({ name: 'id', description: 'ID do usuário', type: String })
  @ApiHeader({
    name: 'x-step-up-token',
    required: true,
    description: 'Token de step-up obtido em /auth/step-up/verify',
  })
  @ApiResponse({
    status: 200,
    description: 'Módulos atualizados com sucesso',
    type: UserResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 403, description: 'Sem permissão' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  updateModuleAccess(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserModuleAccessDto,
  ): Promise<UserResponseDto> {
    return this.usersService.updateModuleAccess(id, dto.module_keys);
  }

  @Patch(':id/gdpr-erasure')
  @Authorize('can_manage_users')
  @UseGuards(SensitiveActionGuard)
  @SensitiveAction('user_gdpr_erasure')
  @ApiOperation({ summary: 'Anonimizar e desativar usuário (LGPD)' })
  @ApiParam({ name: 'id', description: 'ID do usuário', type: String })
  @ApiResponse({
    status: 200,
    description: 'Dados pessoais anonimizados e usuário desativado',
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 403, description: 'Sem permissão' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  gdprErasure(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.usersService.gdprErasure(id);
  }

  @Delete(':id')
  @Authorize('can_manage_users')
  @UseGuards(SensitiveActionGuard)
  @SensitiveAction('user_delete')
  @ForensicAuditAction('delete', 'user')
  @ApiOperation({ summary: 'Excluir usuário' })
  @ApiParam({ name: 'id', description: 'ID do usuário', type: String })
  @ApiResponse({ status: 200, description: 'Usuário excluído com sucesso' })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 403, description: 'Sem permissão' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.usersService.remove(id);
  }
}
