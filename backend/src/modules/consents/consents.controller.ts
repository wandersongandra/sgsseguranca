import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthzOptional } from '../auth/authz-optional.decorator';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { ConsentsService } from './consents.service';
import { AcceptConsentDto, CONSENT_TYPES } from './dto/accept-consent.dto';
import { ConsentStatusResponseDto } from './dto/consent-status.dto';
import { ConsentType } from './entities/consent-version.entity';
import { getRequestIp } from '../../shared/utils/request-ip.util';

type AuthenticatedRequest = ExpressRequest & {
  user?: { sub?: string; userId?: string };
};

function isConsentType(value: string): value is ConsentType {
  return (CONSENT_TYPES as unknown as string[]).includes(value);
}

@ApiTags('consents')
@Controller('users/me/consents')
@AuthzOptional()
@UseGuards(JwtAuthGuard, TenantGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('access-token')
export class ConsentsController {
  constructor(private readonly consentsService: ConsentsService) {}

  private requireUserId(req: AuthenticatedRequest): string {
    const userId = req.user?.sub ?? req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Usuário não autenticado.');
    }
    return userId;
  }

  @Get()
  @ApiOperation({ summary: 'Status de todos os consentimentos do titular' })
  @ApiResponse({ status: 200, type: ConsentStatusResponseDto })
  async status(
    @Req() req: AuthenticatedRequest,
  ): Promise<ConsentStatusResponseDto> {
    const userId = this.requireUserId(req);
    return this.consentsService.getStatus(userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Registrar aceite de consentimento',
    description:
      'Grava prova material (IP, user-agent, timestamp) do aceite da versão indicada (ou da versão ativa se versionLabel for omitido).',
  })
  async accept(
    @Body() dto: AcceptConsentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = this.requireUserId(req);
    const ip = getRequestIp(req);
    const userAgent = req.headers['user-agent']?.toString() ?? null;

    const saved = await this.consentsService.accept(
      userId,
      dto.type,
      dto.versionLabel,
      { ip, userAgent },
    );

    return {
      id: saved.id,
      type: saved.type,
      versionId: saved.version_id,
      acceptedAt: saved.accepted_at?.toISOString() ?? null,
    };
  }

  @Delete(':type')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revogar consentimento do tipo especificado',
    description:
      'Cria um evento de revogação preservando a trilha histórica (o aceite anterior permanece registrado).',
  })
  async revoke(@Param('type') type: string, @Req() req: AuthenticatedRequest) {
    const userId = this.requireUserId(req);
    if (!isConsentType(type)) {
      throw new BadRequestException(`Tipo de consentimento inválido: ${type}`);
    }

    const ip = getRequestIp(req);
    const userAgent = req.headers['user-agent']?.toString() ?? null;

    const revocation = await this.consentsService.revoke(userId, type, {
      ip,
      userAgent,
    });

    return {
      revoked: !!revocation?.revoked_at,
      type,
      revokedAt: revocation?.revoked_at?.toISOString() ?? null,
    };
  }
}
