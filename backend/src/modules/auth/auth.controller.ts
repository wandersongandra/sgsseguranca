import {
  Controller,
  Get,
  Post,
  Body,
  UnauthorizedException,
  UseGuards,
  Request,
  Logger,
  Res,
  Req,
  Header,
} from '@nestjs/common';
import type { Response, Request as ExpressRequest } from 'express';
import { AuthService } from './auth.service';
import type { User } from '../users/entities/user.entity';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { Public } from '../../shared/decorators/public.decorator';
import { TenantOptional } from '../../shared/decorators/tenant-optional.decorator';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ApiStandardResponses } from '../../shared/swagger/api-standard-responses.decorator';
import { Throttle } from '@nestjs/throttler';
import { UsersService } from '../users/users.service';
import { BruteForceService } from './brute-force.service';
import { RbacService } from '../rbac/rbac.service';
import { getRequestIp } from '../../shared/utils/request-ip.util';
import { CpfUtil } from '../../shared/utils/cpf.util';
import {
  REFRESH_CSRF_COOKIE_NAME,
  getLegacyRequestCsrfClearCookieOptions,
  getRequestCsrfCookieOptions,
  getLegacyRefreshCsrfClearCookieOptions,
  getLegacyRefreshTokenClearCookieOptions,
  getRefreshCsrfClearCookieOptions,
  getRefreshCsrfCookieOptions,
  getRefreshTokenClearCookieOptions,
  getRefreshTokenCookieOptions,
  isRefreshCsrfEnforced,
  isRefreshCsrfReportOnly,
} from './auth-security.config';
import { SetSignaturePinDto } from './dto/set-signature-pin.dto';
import { ConfirmPasswordDto } from './dto/confirm-password.dto';
import type {
  AuthMeResponseDto,
  AuthLoginResponseDto,
  AuthSessionResponseDto,
  RefreshAccessTokenResponseDto,
  SignaturePinConfiguredResponseDto,
  SignaturePinStatusResponseDto,
} from './dto/auth-response.dto';
import { SecurityAuditService } from '../../shared/security/security-audit.service';
import * as crypto from 'crypto';
import { TurnstileService } from './turnstile.service';
import { ConfigService } from '@nestjs/config';
import { TenantThrottle } from '../../shared/decorators/tenant-throttle.decorator';
import {
  normalizeOriginValue,
  resolveAllowedCorsOrigins,
} from '../../shared/security/cors-origins';
import {
  isLikelySignedToken,
  normalizeSignedToken,
} from '../../shared/security/signed-token.util';
import { constantTimeEquals } from '../../shared/security/constant-time.util';
import { assertValidHexToken } from '../../shared/security/token-shape.util';
import { sanitizeLogUrl } from '../../shared/logging/log-sanitizer.util';
import { profileStage } from '../../shared/observability/perf-stage.util';
import { AuthzOptional } from './authz-optional.decorator';
import { MfaService } from './services/mfa.service';
import { normalizePrivilegedRole } from './mfa.config';
import { Role } from './enums/roles.enum';
import {
  ActivateBootstrapMfaDto,
  ActivateMfaEnrollmentDto,
  DisableMfaDto,
  MfaStatusResponseDto,
  VerifyLoginMfaDto,
  VerifyStepUpDto,
} from './dto/mfa.dto';

const isProd = process.env.NODE_ENV === 'production';
const LOGIN_THROTTLE_LIMIT = Number(
  process.env.LOGIN_THROTTLE_LIMIT || (isProd ? 5 : 30),
);
const LOGIN_THROTTLE_TTL = Number(process.env.LOGIN_THROTTLE_TTL || 60000);
const FORGOT_PASSWORD_THROTTLE_LIMIT = Number(
  process.env.FORGOT_PASSWORD_THROTTLE_LIMIT || (isProd ? 3 : 30),
);
const FORGOT_PASSWORD_THROTTLE_TTL = Number(
  process.env.FORGOT_PASSWORD_THROTTLE_TTL || 60000,
);
const CHANGE_PASSWORD_THROTTLE_LIMIT = Number(
  process.env.CHANGE_PASSWORD_THROTTLE_LIMIT || (isProd ? 5 : 30),
);
const CHANGE_PASSWORD_THROTTLE_TTL = Number(
  process.env.CHANGE_PASSWORD_THROTTLE_TTL || 60000,
);
const AUTH_ME_THROTTLE_LIMIT = Number(
  process.env.AUTH_ME_THROTTLE_LIMIT || (isProd ? 1200 : 6000),
);
const AUTH_ME_THROTTLE_TTL = Number(process.env.AUTH_ME_THROTTLE_TTL || 60000);
const AUTH_ME_TENANT_THROTTLE_LIMIT = Number(
  process.env.AUTH_ME_TENANT_THROTTLE_LIMIT || AUTH_ME_THROTTLE_LIMIT,
);
const AUTH_ME_TENANT_THROTTLE_HOUR_LIMIT = Number(
  process.env.AUTH_ME_TENANT_THROTTLE_HOUR_LIMIT ||
    AUTH_ME_TENANT_THROTTLE_LIMIT * 60,
);
const CSRF_THROTTLE_LIMIT = Number(
  process.env.CSRF_THROTTLE_LIMIT || (isProd ? 20 : 120),
);
const CSRF_THROTTLE_TTL = Number(process.env.CSRF_THROTTLE_TTL || 60000);
type AuthenticatedRequest = ExpressRequest & {
  user?: {
    userId?: string;
    company_id?: string;
    cpf?: string;
    jti?: string;
    profile?: { nome?: string };
  };
};

@ApiTags('auth')
@ApiStandardResponses({ includeUnauthorized: false, includeForbidden: false })
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private authService: AuthService,
    private usersService: UsersService,
    private bruteForceService: BruteForceService,
    private rbacService: RbacService,
    private securityAudit: SecurityAuditService,
    private turnstileService: TurnstileService,
    private readonly mfaService: MfaService,
    private readonly configService: ConfigService,
  ) {
    if (isProd && isRefreshCsrfReportOnly()) {
      throw new Error(
        'SECURITY: REFRESH_CSRF_REPORT_ONLY=true em producao e proibido. ' +
          'Defina REFRESH_CSRF_REPORT_ONLY=false (ou remova a variavel) para iniciar o servidor.',
      );
    }
  }

  @Public()
  @Throttle({ default: { limit: CSRF_THROTTLE_LIMIT, ttl: CSRF_THROTTLE_TTL } })
  @Get('csrf')
  getCsrfToken(@Res({ passthrough: true }) response: Response) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const secret = this.configService.get<string>('CSRF_TOKEN_SECRET');
    // SECURITY: Se o secret está configurado, o cookie guarda o rawToken e o
    // cliente deve enviar HMAC(secret, rawToken) no header x-csrf-token.
    // Sem secret (dev/test), rawToken é usado tanto no cookie quanto no header.
    const csrfToken = secret
      ? crypto.createHmac('sha256', secret).update(rawToken).digest('hex')
      : rawToken;
    response.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate, private',
    );
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Expires', '0');
    response.clearCookie(
      'csrf-token',
      getLegacyRequestCsrfClearCookieOptions(),
    );
    response.cookie('csrf-token', rawToken, getRequestCsrfCookieOptions());
    return { csrfToken };
  }

  @Public()
  @Throttle({
    default: { limit: LOGIN_THROTTLE_LIMIT, ttl: LOGIN_THROTTLE_TTL },
  })
  @Post('login')
  async login(
    @Req() req: ExpressRequest,
    @Body() body: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthLoginResponseDto> {
    const tracker = getRequestIp(req);
    await profileStage({
      logger: this.logger,
      route: '/auth/login',
      stage: 'pre_auth_checks',
      run: async () => {
        await Promise.all([
          this.turnstileService.assertHuman(body.turnstileToken, {
            remoteIp: tracker,
            expectedAction: 'login',
          }),
          this.bruteForceService.assertAllowed(tracker),
          this.bruteForceService.assertCpfAllowed(body.cpf),
        ]);
      },
    });
    const user = (await profileStage({
      logger: this.logger,
      route: '/auth/login',
      stage: 'validate_user',
      run: () => this.authService.validateUser(body.cpf, body.password),
    })) as User;
    if (!user) {
      await Promise.allSettled([
        this.bruteForceService.registerFailure(tracker),
        this.bruteForceService.registerCpfFailure(body.cpf),
      ]);
      this.logger.warn({
        event: 'login_failed',
        cpf: CpfUtil.mask(body.cpf),
        ip: tracker ?? 'unknown',
      });
      this.securityAudit.loginFailed(
        body.cpf,
        tracker ?? undefined,
        'invalid_credentials',
        String(req.headers['user-agent'] || ''),
      );
      throw new UnauthorizedException('Credenciais inválidas');
    }
    await Promise.allSettled([
      this.bruteForceService.reset(tracker),
      this.bruteForceService.resetCpf(body.cpf),
    ]);

    const profileName =
      typeof user.profile === 'object' && user.profile
        ? String((user.profile as { nome?: string }).nome || '')
        : '';
    if (
      this.mfaService.isEnabled() &&
      this.mfaService.requiresMfa(profileName)
    ) {
      const status = await this.mfaService.getStatus({
        userId: user.id,
        authUserId: user.auth_user_id || null,
        companyId: user.company_id || '',
        profileName,
      });
      if (!status.enabled) {
        const bootstrap =
          await this.mfaService.createBootstrapEnrollmentResponse({
            id: user.id,
            nome: user.nome || '',
            cpf: user.cpf || null,
            funcao: user.funcao || null,
            company_id: user.company_id || '',
            profile: { nome: profileName || null },
            auth_user_id: user.auth_user_id || null,
          });
        await this.addAuthResponseJitter();
        return {
          mfaEnrollRequired: true,
          challengeToken: bootstrap.challengeToken,
          expiresIn: bootstrap.expiresIn,
          otpAuthUrl: bootstrap.otpAuthUrl,
          manualEntryKey: bootstrap.manualEntryKey,
          recoveryCodes: bootstrap.recoveryCodes,
        };
      }

      const challenge = await this.mfaService.createLoginChallenge({
        userId: user.id,
        companyId: user.company_id || '',
      });
      await this.addAuthResponseJitter();
      return {
        mfaRequired: true,
        challengeToken: challenge.challengeToken,
        expiresIn: challenge.expiresIn,
        methods: challenge.methods,
      };
    }

    await this.addAuthResponseJitter();
    return this.issueAuthenticatedSession(user, req, response);
  }

  @Public()
  @Throttle({
    default: { limit: LOGIN_THROTTLE_LIMIT, ttl: LOGIN_THROTTLE_TTL },
  })
  @Post('login/mfa/verify')
  async verifyLoginMfa(
    @Req() req: ExpressRequest,
    @Body() body: VerifyLoginMfaDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionResponseDto> {
    const tracker = getRequestIp(req);
    try {
      const result = await this.mfaService.verifyLoginChallenge({
        challengeToken: body.challengeToken,
        code: body.code,
      });
      const user = (await this.usersService.findAuthSessionUser(
        result.userId,
      )) as unknown as User;
      return this.issueAuthenticatedSession(user, req, response);
    } catch (err) {
      void this.bruteForceService.registerFailure(tracker);
      throw err;
    }
  }

  @Public()
  @Throttle({
    default: { limit: LOGIN_THROTTLE_LIMIT, ttl: LOGIN_THROTTLE_TTL },
  })
  @Post('login/mfa/bootstrap/activate')
  async activateBootstrapMfa(
    @Req() req: ExpressRequest,
    @Body() body: ActivateBootstrapMfaDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionResponseDto> {
    const tracker = getRequestIp(req);
    try {
      const result = await this.mfaService.activateBootstrapChallenge({
        challengeToken: body.challengeToken,
        code: body.code,
      });
      const user = (await this.usersService.findAuthSessionUser(
        result.userId,
      )) as unknown as User;
      return this.issueAuthenticatedSession(user, req, response);
    } catch (err) {
      void this.bruteForceService.registerFailure(tracker);
      throw err;
    }
  }

  @Public()
  @Post('refresh')
  @Throttle({
    default: {
      limit: Number(process.env.REFRESH_THROTTLE_LIMIT || (isProd ? 5 : 20)),
      ttl: Number(process.env.REFRESH_THROTTLE_TTL || 60_000),
    },
  })
  async refresh(
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefreshAccessTokenResponseDto> {
    this.assertSameOrigin(req);
    this.assertRefreshCsrf(req);
    const refreshToken = (req.cookies as Record<string, string>)[
      'refresh_token'
    ];
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token não encontrado');
    }
    const normalizedRefreshToken = normalizeSignedToken(refreshToken);
    if (!isLikelySignedToken(normalizedRefreshToken)) {
      throw new UnauthorizedException('Refresh token inválido');
    }
    const result = await profileStage({
      logger: this.logger,
      route: '/auth/refresh',
      stage: 'refresh_session',
      run: () =>
        this.authService.refresh(normalizedRefreshToken, {
          userAgent: String(req.headers['user-agent'] || ''),
          ip: getRequestIp(req) ?? undefined,
        }),
    });

    if (result.refreshToken) {
      res.cookie(
        'refresh_token',
        result.refreshToken,
        getRefreshTokenCookieOptions(),
      );
      res.clearCookie(
        'refresh_token',
        getLegacyRefreshTokenClearCookieOptions(),
      );
      res.clearCookie(
        REFRESH_CSRF_COOKIE_NAME,
        getLegacyRefreshCsrfClearCookieOptions(),
      );
      res.cookie(
        REFRESH_CSRF_COOKIE_NAME,
        this.generateRefreshCsrfToken(),
        getRefreshCsrfCookieOptions(),
      );
    }

    return { accessToken: result.accessToken };
  }

  @Public()
  @Post('logout')
  async logout(
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = (req.cookies as Record<string, string>)[
      'refresh_token'
    ];
    const candidateRefreshToken = normalizeSignedToken(refreshToken);
    const normalizedRefreshToken = isLikelySignedToken(candidateRefreshToken)
      ? candidateRefreshToken
      : undefined;
    // Extrair o access token do header Authorization para adicioná-lo à blacklist.
    const authHeader = req.headers['authorization'] ?? '';
    const accessToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;

    if (normalizedRefreshToken || accessToken) {
      await this.authService.logout(normalizedRefreshToken ?? '', accessToken);
    }
    this.securityAudit.logout(
      (req as AuthenticatedRequest).user?.userId,
      getRequestIp(req) ?? undefined,
      String(req.headers['user-agent'] || ''),
    );
    response.clearCookie('refresh_token', getRefreshTokenClearCookieOptions());
    response.clearCookie(
      'refresh_token',
      getLegacyRefreshTokenClearCookieOptions(),
    );
    response.clearCookie(
      REFRESH_CSRF_COOKIE_NAME,
      getLegacyRefreshCsrfClearCookieOptions(),
    );
    response.clearCookie(
      REFRESH_CSRF_COOKIE_NAME,
      getRefreshCsrfClearCookieOptions(),
    );
    return { success: true };
  }

  @Throttle({
    default: {
      limit: CHANGE_PASSWORD_THROTTLE_LIMIT,
      ttl: CHANGE_PASSWORD_THROTTLE_TTL,
    },
  })
  @TenantOptional()
  @UseGuards(JwtAuthGuard)
  @AuthzOptional()
  @Post('change-password')
  async changePassword(
    @Request() req: { user?: { userId?: string } },
    @Body() body: ChangePasswordDto,
  ) {
    if (!req.user?.userId) {
      throw new UnauthorizedException('Usuário não autenticado');
    }
    const result = await this.authService.changePassword(
      req.user.userId,
      body.currentPassword,
      body.newPassword,
    );
    this.logger.log({ event: 'password_changed', userId: req.user.userId });
    this.securityAudit.passwordChanged(req.user.userId);
    return result;
  }

  @Public()
  @Throttle({
    default: {
      limit: FORGOT_PASSWORD_THROTTLE_LIMIT,
      ttl: FORGOT_PASSWORD_THROTTLE_TTL,
    },
  })
  @Post('forgot-password')
  async forgotPassword(
    @Body() body: ForgotPasswordDto,
    @Req() req: ExpressRequest,
  ) {
    return await this.authService.forgotPassword(body.cpf, {
      ip: getRequestIp(req),
    });
  }

  @Public()
  @ApiOperation({ summary: 'Página HTML de redefinição de senha' })
  @ApiResponse({
    status: 200,
    description: 'Página HTML com formulário de redefinição',
  })
  @ApiResponse({
    status: 400,
    description: 'Token ausente ou malformado no hash fragment',
  })
  @Get('reset-password')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, max-age=0')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  resetPasswordPage(@Res({ passthrough: true }) response: Response): string {
    // O CSP de produção não permite 'unsafe-inline'; o nonce gerado por
    // requisição em main.ts é o que autoriza o <style> e o <script> abaixo.
    // Sem ele a página era servida mas não executava nada em produção.
    const nonce = String(response.locals?.cspNonce ?? '');
    // Token lido do hash fragment no cliente — nunca enviado ao servidor na URL.
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>Redefinir senha</title>
  <style nonce="${nonce}">
    :root { color-scheme: light; }
    body { margin: 0; font-family: Arial, sans-serif; background: #f4f1eb; color: #26231f; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card { width: 100%; max-width: 420px; background: #fff; border: 1px solid #ddd3ca; border-radius: 16px; padding: 28px; box-shadow: 0 12px 30px rgba(0,0,0,.06); }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 18px; color: #665f58; line-height: 1.5; }
    label { display:block; margin: 14px 0 6px; font-weight: 700; font-size: 14px; }
    input { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 10px; border: 1px solid #cfc5bc; font-size: 15px; }
    button { width: 100%; margin-top: 18px; padding: 12px 14px; border: 0; border-radius: 10px; background: #2f5d46; color: #fff; font-size: 15px; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .7; cursor: not-allowed; }
    .msg { margin-top: 14px; font-size: 14px; line-height: 1.5; }
    .error { color: #b3261e; }
    .success { color: #1d6b43; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Redefinir senha</h1>
      <p>Defina uma nova senha para concluir a recuperação de acesso.</p>
      <form id="resetForm">
        <label for="newPassword">Nova senha</label>
        <input id="newPassword" type="password" minlength="8" autocomplete="new-password" required />
        <label for="confirmPassword">Confirmar senha</label>
        <input id="confirmPassword" type="password" minlength="8" autocomplete="new-password" required />
        <button id="submitButton" type="submit">Redefinir senha</button>
        <div id="message" class="msg"></div>
      </form>
    </div>
  </div>
  <script nonce="${nonce}">
    // Token lido do hash fragment — nunca viaja no path/query, não aparece em logs de acesso.
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
    if (!token) {
      document.getElementById('message').textContent = 'Link inválido ou expirado.';
      document.getElementById('message').className = 'msg error';
      document.getElementById('submitButton').disabled = true;
    }
    const form = document.getElementById('resetForm');
    const message = document.getElementById('message');
    const submitButton = document.getElementById('submitButton');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = '';
      message.className = 'msg';
      const newPassword = document.getElementById('newPassword').value;
      const confirmPassword = document.getElementById('confirmPassword').value;
      if (newPassword !== confirmPassword) {
        message.textContent = 'As senhas não coincidem.';
        message.classList.add('error');
        return;
      }
      submitButton.disabled = true;
      try {
        // O CsrfMiddleware exige x-csrf-token em toda requisição mutável. Esta
        // página é HTML servido pelo backend e não usa o cliente Next.js, que é
        // quem normalmente cuida disso — por isso o token é obtido aqui, em
        // /auth/csrf (rota isenta de CSRF justamente para permitir o handshake).
        // credentials:'include' é obrigatório: o middleware compara o header
        // com o cookie csrf-token emitido nessa mesma chamada.
        let csrfToken = '';
        try {
          const csrfResponse = await fetch('/auth/csrf', {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' }
          });
          if (csrfResponse.ok) {
            const csrfPayload = await csrfResponse.json().catch(() => ({}));
            csrfToken = csrfPayload?.csrfToken || '';
          }
        } catch {
          // Segue sem token: o backend responde 403 e a mensagem abaixo informa.
        }

        const response = await fetch('/auth/reset-password', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken
          },
          body: JSON.stringify({ token, newPassword })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          message.textContent = payload?.message || 'Não foi possível redefinir a senha.';
          message.classList.add('error');
          return;
        }
        message.textContent = 'Senha redefinida com sucesso. Você já pode fazer login.';
        message.classList.add('success');
        form.reset();
      } catch {
        message.textContent = 'Falha de rede ao redefinir a senha.';
        message.classList.add('error');
      } finally {
        submitButton.disabled = false;
      }
    });
  </script>
</body>
</html>`;
  }

  @Public()
  @Throttle({
    default: { limit: LOGIN_THROTTLE_LIMIT, ttl: LOGIN_THROTTLE_TTL },
  })
  @Post('reset-password')
  async resetPassword(@Body() body: ResetPasswordDto) {
    return await this.authService.resetPassword(
      assertValidHexToken(
        body.token,
        64,
        'Token de redefinição inválido ou expirado.',
      ),
      body.newPassword,
    );
  }

  @TenantOptional()
  @UseGuards(JwtAuthGuard)
  @AuthzOptional()
  @Throttle({
    default: {
      limit: AUTH_ME_THROTTLE_LIMIT,
      ttl: AUTH_ME_THROTTLE_TTL,
    },
  })
  @TenantThrottle({
    requestsPerMinute: AUTH_ME_TENANT_THROTTLE_LIMIT,
    requestsPerHour: AUTH_ME_TENANT_THROTTLE_HOUR_LIMIT,
  })
  @Get('me')
  async me(
    @Request() req: { user?: { userId?: string } },
  ): Promise<AuthMeResponseDto> {
    if (!req.user?.userId) {
      throw new UnauthorizedException('Usuário não autenticado');
    }

    const user = await profileStage({
      logger: this.logger,
      route: '/auth/me',
      stage: 'load_auth_session_user',
      userId: req.user.userId,
      run: () => this.usersService.findAuthSessionUser(req.user!.userId!),
    });

    const access = await profileStage({
      logger: this.logger,
      route: '/auth/me',
      stage: 'resolve_access_bundle',
      userId: req.user.userId,
      companyId: user.company_id,
      run: () =>
        this.rbacService.getUserAccess(req.user!.userId!, {
          profileName: user.profile?.nome,
        }),
    });

    return {
      user,
      roles: access.roles,
      permissions: access.permissions,
      isAdminGeral: this.hasAdminGeralRole(access.roles, user.profile?.nome),
    };
  }

  @TenantOptional()
  @UseGuards(JwtAuthGuard)
  @AuthzOptional()
  @Get('mfa/status')
  async getMfaStatus(
    @Request() req: { user?: { userId?: string; profile?: { nome?: string } } },
  ): Promise<MfaStatusResponseDto> {
    if (!req.user?.userId) {
      throw new UnauthorizedException('Usuário não autenticado');
    }
    return this.mfaService.getStatus({
      userId: req.user.userId,
      companyId: (req.user as { company_id?: string }).company_id,
      profileName: req.user.profile?.nome,
    });
  }

  @TenantOptional()
  @UseGuards(JwtAuthGuard)
  @AuthzOptional()
  @Post('mfa/enroll')
  async enrollMfa(@Request() req: AuthenticatedRequest): Promise<{
    otpAuthUrl: string;
    manualEntryKey: string;
    recoveryCodes: string[];
  }> {
    if (!req.user?.userId || !req.user.company_id) {
      throw new UnauthorizedException('Usuário não autenticado');
    }
    return this.mfaService.startEnrollment({
      userId: req.user.userId,
      companyId: req.user.company_id,
      label: req.user.cpf || req.user.userId,
    });
  }

  @TenantOptional()
  @UseGuards(JwtAuthGuard)
  @AuthzOptional()
  @Post('mfa/activate')
  async activateMfa(
    @Request() req: AuthenticatedRequest,
    @Body() body: ActivateMfaEnrollmentDto,
  ) {
    if (!req.user?.userId || !req.user.company_id) {
      throw new UnauthorizedException('Usuário não autenticado');
    }
    await this.mfaService.activateEnrollment({
      userId: req.user.userId,
      companyId: req.user.company_id,
      code: body.code,
    });
    return { success: true };
  }

  @TenantOptional()
  @UseGuards(JwtAuthGuard)
  @AuthzOptional()
  @Post('mfa/recovery-codes/regenerate')
  async regenerateRecoveryCodes(@Request() req: AuthenticatedRequest) {
    if (!req.user?.userId || !req.user.company_id) {
      throw new UnauthorizedException('Usuário não autenticado');
    }
    const recoveryCodes = await this.mfaService.regenerateRecoveryCodes({
      userId: req.user.userId,
      companyId: req.user.company_id,
    });
    return { recoveryCodes };
  }

  @TenantOptional()
  @UseGuards(JwtAuthGuard)
  @AuthzOptional()
  @Post('mfa/disable')
  async disableMfa(
    @Request() req: AuthenticatedRequest,
    @Body() body: DisableMfaDto,
  ) {
    if (!req.user?.userId || !req.user.company_id) {
      throw new UnauthorizedException('Usuário não autenticado');
    }
    await this.mfaService.disableMfa({
      userId: req.user.userId,
      companyId: req.user.company_id,
      code: body.code,
    });
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Step-up authentication: confirm password to get a short-lived token
  // for sensitive operations (signatures, approvals, deletions, exports).
  // ---------------------------------------------------------------------------

  @Throttle({
    default: {
      limit: CHANGE_PASSWORD_THROTTLE_LIMIT,
      ttl: CHANGE_PASSWORD_THROTTLE_TTL,
    },
  })
  @TenantOptional()
  @UseGuards(JwtAuthGuard)
  @AuthzOptional()
  @Post('confirm-password')
  async confirmPassword(
    @Request() req: AuthenticatedRequest,
    @Body() body: ConfirmPasswordDto,
  ): Promise<{ stepUpToken: string; expiresIn: number }> {
    if (!req.user?.userId || !req.user.company_id) {
      throw new UnauthorizedException('Usuário não autenticado');
    }

    return this.mfaService.verifyStepUp({
      userId: req.user.userId,
      companyId: req.user.company_id,
      profileName: req.user.profile?.nome || null,
      reason: 'legacy_confirm_password',
      password: body.password,
      accessJti: req.user.jti,
    });
  }

  @Throttle({
    default: {
      limit: CHANGE_PASSWORD_THROTTLE_LIMIT,
      ttl: CHANGE_PASSWORD_THROTTLE_TTL,
    },
  })
  @TenantOptional()
  @UseGuards(JwtAuthGuard)
  @AuthzOptional()
  @Post('step-up/verify')
  async verifyStepUp(
    @Request() req: AuthenticatedRequest,
    @Body() body: VerifyStepUpDto,
  ): Promise<{ stepUpToken: string; expiresIn: number }> {
    if (!req.user?.userId || !req.user.company_id) {
      throw new UnauthorizedException('Usuário não autenticado');
    }

    return this.mfaService.verifyStepUp({
      userId: req.user.userId,
      companyId: req.user.company_id,
      profileName: req.user.profile?.nome || null,
      reason: body.reason,
      code: body.code,
      password: body.password,
      accessJti: req.user.jti,
    });
  }

  // ---------------------------------------------------------------------------
  // Signature PIN endpoints
  // ---------------------------------------------------------------------------

  @UseGuards(JwtAuthGuard)
  @AuthzOptional()
  @Get('signature-pin/status')
  async getSignaturePinStatus(
    @Request() req: AuthenticatedRequest,
  ): Promise<SignaturePinStatusResponseDto> {
    if (!req.user?.userId) {
      throw new UnauthorizedException('Usuário não autenticado');
    }
    const hasPin = await this.usersService.hasSignaturePin(req.user.userId);
    return { has_pin: hasPin };
  }

  @UseGuards(JwtAuthGuard)
  @AuthzOptional()
  @Post('signature-pin')
  async setSignaturePin(
    @Request() req: AuthenticatedRequest,
    @Body() dto: SetSignaturePinDto,
  ): Promise<SignaturePinConfiguredResponseDto> {
    if (!req.user?.userId) {
      throw new UnauthorizedException('Usuário não autenticado');
    }
    await this.usersService.setSignaturePin(
      req.user.userId,
      dto.pin,
      dto.current_password,
    );
    return { ok: true, message: 'PIN de assinatura configurado com sucesso.' };
  }

  /**
   * Adiciona jitter aleatório (50–150ms) para reduzir oracle de timing após
   * autenticação de primeiro fator. Não elimina o oracle de shape de resposta
   * (mfaRequired vs accessToken), mas equaliza latência entre os caminhos.
   * Mitigação completa exige protocolo de 2 etapas com opaque session token.
   */
  private addAuthResponseJitter(): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(resolve, crypto.randomInt(50, 151)),
    );
  }

  private async issueAuthenticatedSession(
    user: User,
    req: ExpressRequest,
    response: Response,
  ): Promise<AuthSessionResponseDto> {
    const tracker = getRequestIp(req);
    const [result, access] = await profileStage({
      logger: this.logger,
      route: '/auth/login',
      stage: 'issue_session_and_rbac',
      companyId: user.company_id || undefined,
      userId: user.id,
      run: async () => {
        const accessBundle = await this.rbacService.getUserAccess(user.id, {
          profileName: user.profile?.nome,
        });
        const isAdminGeral = this.hasAdminGeralRole(
          accessBundle.roles,
          user.profile?.nome,
        );
        const session = await this.authService.login(
          user,
          {
            userAgent: String(req.headers['user-agent'] || ''),
            ip: tracker ?? undefined,
          },
          { isAdminGeral },
        );

        return [session, accessBundle] as const;
      },
    });

    response.cookie(
      'refresh_token',
      result.refreshToken,
      getRefreshTokenCookieOptions(),
    );
    response.clearCookie(
      'refresh_token',
      getLegacyRefreshTokenClearCookieOptions(),
    );
    response.clearCookie(
      REFRESH_CSRF_COOKIE_NAME,
      getLegacyRefreshCsrfClearCookieOptions(),
    );
    response.cookie(
      REFRESH_CSRF_COOKIE_NAME,
      this.generateRefreshCsrfToken(),
      getRefreshCsrfCookieOptions(),
    );

    this.logger.log({ event: 'login_success', userId: user.id });
    this.securityAudit.loginSuccess(
      user.id,
      tracker ?? undefined,
      String(req.headers['user-agent'] || ''),
      user.company_id || null,
    );

    return {
      accessToken: result.accessToken,
      user: result.user,
      roles: access.roles,
      permissions: access.permissions,
      isAdminGeral: this.hasAdminGeralRole(access.roles, user.profile?.nome),
    };
  }

  private hasAdminGeralRole(
    roles: string[],
    profileName?: string | null,
  ): boolean {
    return (
      normalizePrivilegedRole(profileName) === 'ADMIN_GERAL' ||
      roles.includes(Role.ADMIN_GERAL) ||
      roles.includes('ADMIN_GERAL')
    );
  }

  /**
   * Mitigação simples de CSRF para o fluxo de refresh baseado em cookie.
   * Permite:
   *  - chamadas sem Origin/Referer (navegação same-site)
   *  - Origin/Referer que comecem com alguma origem de CORS_ALLOWED_ORIGINS
   */
  private assertSameOrigin(req: ExpressRequest) {
    const originHeader = req.headers['origin'];
    const refererHeader = req.headers['referer'];
    const origin =
      typeof originHeader === 'string' ? originHeader.trim() : undefined;
    const referer =
      typeof refererHeader === 'string' ? refererHeader.trim() : undefined;
    const headerValue = origin || referer;
    if (!headerValue) return;

    const allowed = resolveAllowedCorsOrigins({
      isProduction: process.env.NODE_ENV === 'production',
      configuredOriginsRaw: this.configService.get<string>(
        'CORS_ALLOWED_ORIGINS',
      ),
    });

    const requestOrigin = normalizeOriginValue(headerValue);
    if (!requestOrigin) {
      throw new UnauthorizedException('Origem não autorizada para refresh');
    }

    const isAllowed = allowed.some((allowedOrigin) => {
      const normalizedAllowed = normalizeOriginValue(allowedOrigin);
      return normalizedAllowed === requestOrigin;
    });
    if (!isAllowed) {
      throw new UnauthorizedException('Origem não autorizada para refresh');
    }
  }

  private generateRefreshCsrfToken(): string {
    return crypto.randomBytes(24).toString('base64url');
  }

  private assertRefreshCsrf(req: ExpressRequest) {
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_CSRF_COOKIE_NAME
    ];
    const headerToken = String(req.headers['x-refresh-csrf'] || '').trim();
    const sanitizedPath =
      sanitizeLogUrl(req.originalUrl || req.url || '').split('?')[0] || '/';

    if (!cookieToken || !headerToken) {
      if (isRefreshCsrfEnforced()) {
        throw new UnauthorizedException('CSRF token ausente para refresh');
      }
      if (isRefreshCsrfReportOnly()) {
        this.logger.warn({
          event: 'refresh_csrf_missing',
          hasCookie: Boolean(cookieToken),
          hasHeader: Boolean(headerToken),
          path: sanitizedPath,
        });
      }
      return;
    }

    if (!constantTimeEquals(cookieToken, headerToken)) {
      if (isRefreshCsrfEnforced()) {
        throw new UnauthorizedException('CSRF token inválido para refresh');
      }
      if (isRefreshCsrfReportOnly()) {
        this.logger.warn({
          event: 'refresh_csrf_mismatch',
          path: sanitizedPath,
        });
      }
    }
  }
}
