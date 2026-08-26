import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { TokenRevocationService } from '../token-revocation.service';
import { AuthPrincipalService } from '../auth-principal.service';
import {
  assertJwtHasExpiration,
  assertJwtTokenType,
  resolveAccessTokenSecret,
} from '../utils/access-token-claims.util';
import type { AuthenticatedPrincipal } from '../auth-principal.service';
import { getJwtContract, JWT_ACCESS_TOKEN_TYPE } from '../auth-security.config';

type AuthenticatedHttpRequest = Request & {
  authPrincipal?: AuthenticatedPrincipal;
};

// Token emitido quando must_change_password=true (ver AuthService.login):
// TTL curto, sem refresh token, e só pode chamar a troca de senha.
const FORCE_PASSWORD_CHANGE_ALLOWED_PATHS = new Set(['/auth/change-password']);

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly jwtIssuer: string;
  private readonly jwtAudience: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly tokenRevocationService: TokenRevocationService,
    private readonly authPrincipalService: AuthPrincipalService,
  ) {
    const jwtContract = getJwtContract(configService);
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: jwtContract.algorithms,
      issuer: jwtContract.issuer,
      audience: jwtContract.audience,
      passReqToCallback: true,
      secretOrKeyProvider: (_request, _rawJwtToken, done) => {
        try {
          done(null, resolveAccessTokenSecret(configService));
        } catch (error) {
          done(error);
        }
      },
    });

    this.jwtIssuer = jwtContract.issuer;
    this.jwtAudience = jwtContract.audience;
  }

  async validate(
    request: AuthenticatedHttpRequest,
    payload: { jti?: string; iss?: string; aud?: string | string[] } & Record<
      string,
      unknown
    >,
  ) {
    if (payload.iss !== this.jwtIssuer) {
      throw new UnauthorizedException(
        'Token inválido: emissor não reconhecido',
      );
    }

    const aud = payload.aud;
    const audiences = Array.isArray(aud) ? aud : aud ? [aud] : [];
    if (!audiences.includes(this.jwtAudience)) {
      throw new UnauthorizedException('Token inválido: audience incorreta');
    }

    assertJwtTokenType(payload, JWT_ACCESS_TOKEN_TYPE);
    assertJwtHasExpiration(payload);

    // Checar blacklist: tokens revogados via logout são rejeitados imediatamente,
    // sem esperar o TTL natural expirar.
    if (
      payload.jti &&
      (await this.tokenRevocationService.isRevoked(payload.jti))
    ) {
      throw new UnauthorizedException('Token revogado');
    }

    // Token de troca obrigatória de senha: só pode ser usado no endpoint de
    // troca. Sem essa checagem, um token "limitado" resolveria o principal
    // real (com as permissões reais do usuário) em qualquer outra rota.
    if (
      payload.scope === 'force_change' &&
      !FORCE_PASSWORD_CHANGE_ALLOWED_PATHS.has(request.path)
    ) {
      throw new UnauthorizedException('Troque sua senha antes de continuar.');
    }

    const cachedPrincipal = request.authPrincipal;
    if (
      cachedPrincipal &&
      this.matchesResolvedPrincipal(cachedPrincipal, payload)
    ) {
      return cachedPrincipal;
    }

    return this.authPrincipalService.resolveAccessPrincipal(payload);
  }

  private matchesResolvedPrincipal(
    principal: AuthenticatedPrincipal,
    payload: Record<string, unknown>,
  ): boolean {
    const subject = this.readString(payload, 'sub');
    if (!subject) {
      return false;
    }

    return principal.userId === subject || principal.authUserId === subject;
  }

  private readString(
    source: Record<string, unknown> | null | undefined,
    key: string,
  ): string | undefined {
    const value = source?.[key];
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
