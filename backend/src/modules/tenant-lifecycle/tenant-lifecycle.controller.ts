import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TenantLifecycleService } from './tenant-lifecycle.service';
import { CreateOnboardingInviteDto } from './dto/create-onboarding-invite.dto';
import { CompleteOnboardingDto } from './dto/complete-onboarding.dto';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { Authorize } from '../auth/authorize.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { assertValidBase64UrlToken } from '../../shared/security/token-shape.util';

type RequestWithUser = {
  user?: {
    userId?: string;
    sub?: string;
  };
};

@Controller('tenant-lifecycle')
export class TenantLifecycleController {
  constructor(private readonly service: TenantLifecycleService) {}

  @Post('invites')
  @Roles(Role.SUPER_ADMIN)
  @Authorize('can_manage_companies')
  @UseGuards(RolesGuard)
  createInvite(
    @Body() dto: CreateOnboardingInviteDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.createInvite(dto, req.user?.userId ?? req.user?.sub);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('onboarding/:token')
  getInvite(@Param('token') token: string) {
    return this.service.getInvitePublicView(
      assertValidBase64UrlToken(token, 'Token de onboarding inválido.'),
    );
  }

  @Public()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post('onboarding/:token/complete')
  completeOnboarding(
    @Param('token') token: string,
    @Body() dto: CompleteOnboardingDto,
  ) {
    return this.service.completeOnboarding(
      assertValidBase64UrlToken(token, 'Token de onboarding inválido.'),
      dto,
    );
  }

  @Delete('invites/:id/revoke')
  @Roles(Role.SUPER_ADMIN)
  @Authorize('can_manage_companies')
  @UseGuards(RolesGuard)
  @HttpCode(HttpStatus.OK)
  revokeInvite(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.revokeInvite(id);
  }
}
