import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthRedisService } from '../../../shared/redis/redis.service';
import * as crypto from 'crypto';
import { getRefreshTokenSecret } from '../auth-security.config';
import {
  getJwtContract,
  JWT_REFRESH_TOKEN_TYPE,
} from '../auth-security.config';
import {
  assertJwtHasExpiration,
  assertJwtTokenType,
  normalizeAccessTokenClaims,
} from '../utils/access-token-claims.util';

type RefreshCookieRequest = {
  cookies?: Record<string, string | undefined>;
};

function cookieExtractor(req?: RefreshCookieRequest): string | null {
  const refreshToken = req?.cookies?.refresh_token;
  if (typeof refreshToken === 'string' && refreshToken.length > 0) {
    return refreshToken;
  }
  return null;
}

@Injectable()
/**
 * @deprecated The runtime refresh contract is AuthService.refresh(), which
 * performs issuer/audience/type validation and atomic rotation. This strategy
 * remains only as a compatibility test surface and is not registered by AuthModule.
 */
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor(
    private configService: ConfigService,
    private redisService: AuthRedisService,
  ) {
    const jwtContract = getJwtContract(configService);
    const jwtSecret = getRefreshTokenSecret(configService);
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([cookieExtractor]),
      ignoreExpiration: false,
      algorithms: jwtContract.algorithms,
      issuer: jwtContract.issuer,
      audience: jwtContract.audience,
      passReqToCallback: true,
      secretOrKey: jwtSecret,
    });
  }

  async validate(
    request: RefreshCookieRequest,
    payload: Record<string, unknown>,
  ) {
    const refreshToken = cookieExtractor(request);
    if (!refreshToken) {
      throw new UnauthorizedException();
    }

    const jwtContract = getJwtContract(this.configService);
    if (payload.iss !== jwtContract.issuer) {
      throw new UnauthorizedException('Emissor de refresh inválido');
    }
    const audiences = Array.isArray(payload.aud)
      ? payload.aud
      : payload.aud
        ? [payload.aud]
        : [];
    if (!audiences.includes(jwtContract.audience)) {
      throw new UnauthorizedException('Audience de refresh inválida');
    }
    assertJwtTokenType(payload, JWT_REFRESH_TOKEN_TYPE);
    assertJwtHasExpiration(payload);

    const normalized = normalizeAccessTokenClaims(payload);
    const client = this.redisService.getClient();
    const tokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');
    const key = this.redisService.getRefreshTokenKey(
      normalized.userId,
      tokenHash,
    );
    const exists = await client.get(key);
    if (!exists) {
      throw new UnauthorizedException();
    }
    return {
      id: normalized.id,
      userId: normalized.userId,
      app_user_id: normalized.app_user_id,
      auth_user_id: normalized.auth_user_id,
      authUserId: normalized.auth_user_id,
      cpf: normalized.cpf,
      company_id: normalized.company_id,
      companyId: normalized.companyId,
      site_id: normalized.site_id,
      siteId: normalized.siteId,
      profile: normalized.profile,
      isSuperAdmin: normalized.isSuperAdmin,
      plan: normalized.plan,
    };
  }
}
