import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../shared/decorators/public.decorator';
import { TenantOptional } from '../../shared/decorators/tenant-optional.decorator';
import { SubmitPublicDdsSignatureDto } from './dto/dds-signature-invite.dto';
import { getRequestIp } from '../../shared/utils/request-ip.util';
import { assertValidSignedToken } from '../../shared/security/signed-token.util';
import {
  DdsSignatureInviteService,
  PublicDdsSignatureContext,
  PublicDdsSignatureSubmitResult,
} from './dds-signature-invite.service';

const PUBLIC_DDS_SIGNATURE_THROTTLE_LIMIT = Number(
  process.env.PUBLIC_DDS_SIGNATURE_THROTTLE_LIMIT || 12,
);
const PUBLIC_DDS_SIGNATURE_THROTTLE_TTL = Number(
  process.env.PUBLIC_DDS_SIGNATURE_THROTTLE_TTL || 60_000,
);

@Public()
@TenantOptional()
@Controller('public/dds/signature')
export class PublicDdsSignatureController {
  constructor(
    private readonly signatureInviteService: DdsSignatureInviteService,
  ) {}

  @Get(':token')
  @Throttle({
    default: {
      limit: PUBLIC_DDS_SIGNATURE_THROTTLE_LIMIT,
      ttl: PUBLIC_DDS_SIGNATURE_THROTTLE_TTL,
    },
  })
  getContext(
    @Param('token') token: string,
  ): Promise<PublicDdsSignatureContext> {
    return this.signatureInviteService.getPublicContext(
      this.assertValidPublicToken(token),
    );
  }

  @Post(':token')
  @Throttle({
    default: {
      limit: PUBLIC_DDS_SIGNATURE_THROTTLE_LIMIT,
      ttl: PUBLIC_DDS_SIGNATURE_THROTTLE_TTL,
    },
  })
  submitSignature(
    @Param('token') token: string,
    @Body() dto: SubmitPublicDdsSignatureDto,
    @Req() req: Request,
  ): Promise<PublicDdsSignatureSubmitResult> {
    return this.signatureInviteService.submitPublicSignature(
      this.assertValidPublicToken(token),
      {
        acceptedTerms: dto.accepted_terms,
        signatureData: dto.signature_data,
        turnstileToken: dto.turnstileToken ?? null,
        ip: getRequestIp(req),
        userAgent: this.getRequestUserAgent(req),
      },
    );
  }

  private getRequestUserAgent(req: Request): string | null {
    const userAgent = req.get('user-agent');
    return typeof userAgent === 'string' && userAgent.trim() ? userAgent : null;
  }

  private assertValidPublicToken(rawToken: string): string {
    return assertValidSignedToken(rawToken, 'Token de assinatura inválido.');
  }
}
