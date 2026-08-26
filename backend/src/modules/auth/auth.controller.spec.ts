/* eslint-disable @typescript-eslint/unbound-method */
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { UsersService } from '../users/users.service';
import type { BruteForceService } from './brute-force.service';
import type { RbacService } from '../rbac/rbac.service';
import type { SecurityAuditService } from '../../shared/security/security-audit.service';
import type { TurnstileService } from './turnstile.service';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { LoginDto } from './dto/login.dto';
import type { ConfirmPasswordDto } from './dto/confirm-password.dto';
import type { MfaService } from './services/mfa.service';
import type { TenantService } from '../../shared/tenant/tenant.service';
import { Role } from './enums/roles.enum';

type RefreshRequest = Partial<Request> & {
  cookies: Record<string, string>;
  headers: Record<string, string>;
  originalUrl: string;
  url: string;
  user?: {
    userId?: string;
  };
};

type LoginRequest = Partial<Request> & {
  headers: Record<string, string>;
};

type MockResponse = Response & {
  cookie: jest.Mock;
  clearCookie: jest.Mock;
};

describe('AuthController security hardening', () => {
  let controller: AuthController;
  let authService: Pick<
    AuthService,
    | 'refresh'
    | 'validateUser'
    | 'login'
    | 'logout'
    | 'verifyUserPassword'
    | 'resetPassword'
  >;
  let bruteForceService: Pick<
    BruteForceService,
    | 'assertAllowed'
    | 'assertCpfAllowed'
    | 'registerFailure'
    | 'registerCpfFailure'
    | 'reset'
    | 'resetCpf'
  >;
  let turnstileService: Pick<TurnstileService, 'assertHuman'>;
  let rbacService: Pick<RbacService, 'getUserAccess'>;
  let mfaService: Pick<
    MfaService,
    | 'isEnabled'
    | 'requiresMfa'
    | 'getStatus'
    | 'createBootstrapEnrollmentResponse'
    | 'createLoginChallenge'
    | 'verifyLoginChallenge'
    | 'activateBootstrapChallenge'
    | 'verifyStepUp'
  >;
  let authSessionUserLoader: jest.Mock;
  let tenantService: Pick<TenantService, 'run'>;

  const createResponse = (): MockResponse =>
    ({
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    }) as unknown as MockResponse;

  const buildRefreshRequest = (
    overrides: Partial<RefreshRequest> = {},
  ): Request =>
    ({
      cookies: {},
      headers: {},
      originalUrl: '/auth/refresh',
      url: '/auth/refresh',
      ...overrides,
    }) as Request;

  const buildLoginRequest = (overrides: Partial<LoginRequest> = {}): Request =>
    ({
      headers: {},
      ...overrides,
    }) as Request;

  const buildLoginDto = (overrides: Partial<LoginDto> = {}): LoginDto => ({
    cpf: '12345678900',
    password: 'SenhaSegura@123',
    turnstileToken: 'turnstile',
    ...overrides,
  });

  const buildConfirmPasswordDto = (
    overrides: Partial<ConfirmPasswordDto> = {},
  ): ConfirmPasswordDto => ({
    password: 'SenhaSegura@123',
    ...overrides,
  });

  beforeEach(() => {
    process.env.REFRESH_CSRF_ENFORCED = 'true';
    process.env.REFRESH_CSRF_REPORT_ONLY = 'false';

    authService = {
      refresh: jest.fn(),
      validateUser: jest.fn(),
      login: jest.fn(),
      logout: jest.fn(),
      verifyUserPassword: jest.fn(),
      resetPassword: jest.fn(),
    };
    bruteForceService = {
      assertAllowed: jest.fn(),
      assertCpfAllowed: jest.fn(),
      registerFailure: jest.fn(),
      registerCpfFailure: jest.fn(),
      reset: jest.fn(),
      resetCpf: jest.fn(),
    };
    turnstileService = {
      assertHuman: jest.fn(),
    };
    mfaService = {
      isEnabled: jest.fn().mockReturnValue(true),
      requiresMfa: jest.fn().mockReturnValue(false),
      getStatus: jest.fn().mockResolvedValue({
        enabled: false,
        required: false,
        privilegedRole: 'NON_PRIVILEGED',
        recoveryCodesRemaining: 0,
      }),
      createBootstrapEnrollmentResponse: jest.fn(),
      createLoginChallenge: jest.fn(),
      verifyLoginChallenge: jest.fn(),
      activateBootstrapChallenge: jest.fn(),
      verifyStepUp: jest.fn().mockResolvedValue({
        stepUpToken: 'step-up-token',
        expiresIn: 300,
      }),
    };
    rbacService = {
      getUserAccess: jest.fn().mockResolvedValue({
        roles: ['admin'],
        permissions: ['can_view'],
      }),
    };

    authSessionUserLoader = jest.fn().mockResolvedValue({
      id: 'user-1',
      nome: 'Usuário Teste',
      cpf: '12345678900',
      email: 'user@example.com',
      company_id: 'company-1',
      profile: { id: 'profile-1', nome: 'Administrador Geral' },
      profile_id: 'profile-1',
      status: true,
      created_at: new Date('2026-03-28T00:00:00.000Z'),
      updated_at: new Date('2026-03-28T00:00:00.000Z'),
    });
    tenantService = {
      run: jest.fn((_context, callback) => callback()),
    };

    controller = new AuthController(
      authService as AuthService,
      {
        findOne: jest.fn(),
        findAuthSessionUser: authSessionUserLoader,
        findOneWithPassword: jest.fn(),
        hasSignaturePin: jest.fn(),
        setSignaturePin: jest.fn(),
      } as unknown as UsersService,
      bruteForceService as BruteForceService,
      rbacService as RbacService,
      {
        loginSuccess: jest.fn(),
        loginFailed: jest.fn(),
        stepUpFailed: jest.fn(),
        stepUpIssued: jest.fn(),
        logout: jest.fn(),
        passwordChanged: jest.fn(),
      } as unknown as SecurityAuditService,
      turnstileService as TurnstileService,
      mfaService as MfaService,
      {
        get: jest.fn((key: string) =>
          key === 'CORS_ALLOWED_ORIGINS'
            ? 'https://app.example.com'
            : undefined,
        ),
      } as unknown as ConfigService,
      tenantService as TenantService,
    );
  });

  it('refresh exige CSRF válido quando enforcement está ativo', async () => {
    const req = buildRefreshRequest({
      cookies: {
        refresh_token: 'aaa.bbb.ccc',
        refresh_csrf: 'cookie-token',
      },
      headers: {
        origin: 'https://app.example.com',
        'x-refresh-csrf': 'header-token-different',
        'user-agent': 'jest',
      },
      originalUrl: '/auth/refresh',
      url: '/auth/refresh',
    });
    const res = createResponse();

    await expect(controller.refresh(req, res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refresh rejeita origem não permitida', async () => {
    const req = buildRefreshRequest({
      cookies: {
        refresh_token: 'aaa.bbb.ccc',
        refresh_csrf: 'token',
      },
      headers: {
        origin: 'https://evil.example.com',
        'x-refresh-csrf': 'token',
      },
      originalUrl: '/auth/refresh',
      url: '/auth/refresh',
    });
    const res = createResponse();

    await expect(controller.refresh(req, res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refresh rejeita origem com prefix spoofing', async () => {
    const req = buildRefreshRequest({
      cookies: {
        refresh_token: 'aaa.bbb.ccc',
        refresh_csrf: 'token',
      },
      headers: {
        origin: 'https://app.example.com.evil.com/path',
        'x-refresh-csrf': 'token',
      },
      originalUrl: '/auth/refresh',
      url: '/auth/refresh',
    });
    const res = createResponse();

    await expect(controller.refresh(req, res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refresh rotaciona refresh token e cookie CSRF quando request é legítima', async () => {
    (authService.refresh as jest.Mock).mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    const req = buildRefreshRequest({
      cookies: {
        refresh_token: 'aaa.bbb.ccc',
        refresh_csrf: 'csrf-token',
      },
      headers: {
        origin: 'https://app.example.com',
        'x-refresh-csrf': 'csrf-token',
        'user-agent': 'jest',
      },
      originalUrl: '/auth/refresh',
      url: '/auth/refresh',
    });
    const res = createResponse();

    const result = await controller.refresh(req, res);

    expect(result).toEqual({ accessToken: 'new-access' });
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_csrf',
      expect.objectContaining({ path: '/auth/refresh' }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_token',
      expect.objectContaining({ path: '/auth/refresh' }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      'new-refresh',
      expect.any(Object),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_csrf',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('refresh rejeita token malformado', async () => {
    const req = buildRefreshRequest({
      cookies: {
        refresh_token: 'refresh-token-bruto',
        refresh_csrf: 'csrf-token',
      },
      headers: {
        origin: 'https://app.example.com',
        'x-refresh-csrf': 'csrf-token',
      },
      originalUrl: '/auth/refresh',
      url: '/auth/refresh',
    });
    const res = createResponse();

    await expect(controller.refresh(req, res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(authService.refresh).not.toHaveBeenCalled();
  });

  it('reset-password bloqueia token malformado antes de chamar o service', async () => {
    await expect(
      controller.resetPassword({
        token: 'token-invalido',
        newPassword: 'SenhaNova@123',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(authService.resetPassword).not.toHaveBeenCalled();
  });

  it('login limpa cookie CSRF legado e emite o novo cookie amplo para o frontend', async () => {
    (turnstileService.assertHuman as jest.Mock).mockResolvedValue(undefined);
    (authService.validateUser as jest.Mock).mockResolvedValue({
      id: 'user-1',
      company_id: 'company-1',
      profile: { nome: 'Administrador Geral' },
    });
    (mfaService.requiresMfa as jest.Mock).mockReturnValue(false);
    (authService.login as jest.Mock).mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      user: { id: 'user-1' },
    });

    const res = createResponse();

    await controller.login(
      buildLoginRequest({
        headers: { 'user-agent': 'jest' },
      }),
      buildLoginDto(),
      res,
    );

    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_csrf',
      expect.objectContaining({ path: '/auth/refresh' }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_token',
      expect.objectContaining({ path: '/auth/refresh' }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_csrf',
      expect.any(String),
      expect.objectContaining({ path: '/' }),
    );
  });

  it('logout remove refresh_token antigo e novo quando invalida a sessão', async () => {
    const req = buildRefreshRequest({
      cookies: {
        refresh_token: 'aaa.bbb.ccc',
        refresh_csrf: 'csrf-token',
      },
      headers: {
        authorization: 'Bearer REDACTED',
        'user-agent': 'jest',
      },
    });
    const res = createResponse();

    await controller.logout(req, res);

    expect(authService.logout).toHaveBeenCalledWith('aaa.bbb.ccc', 'REDACTED');
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_token',
      expect.objectContaining({ path: '/' }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_token',
      expect.objectContaining({ path: '/auth/refresh' }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_csrf',
      expect.objectContaining({ path: '/' }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_csrf',
      expect.objectContaining({ path: '/auth/refresh' }),
    );
  });

  it('login continua funcionando quando a auth legada está desligada, desde que validateUser aprove', async () => {
    (turnstileService.assertHuman as jest.Mock).mockResolvedValue(undefined);
    (authService.validateUser as jest.Mock).mockResolvedValue({
      id: 'user-1',
      company_id: 'company-1',
      profile: { nome: 'Administrador Geral' },
    });
    (mfaService.requiresMfa as jest.Mock).mockReturnValue(false);
    (authService.login as jest.Mock).mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      user: { id: 'user-1' },
    });

    const result = await controller.login(
      buildLoginRequest({
        headers: { 'user-agent': 'jest' },
      }),
      buildLoginDto(),
      createResponse(),
    );

    expect(turnstileService.assertHuman).toHaveBeenCalled();
    expect(authService.validateUser).toHaveBeenCalledWith(
      '12345678900',
      'SenhaSegura@123',
    );
    expect(rbacService.getUserAccess).toHaveBeenCalledWith('user-1', {
      profileName: 'Administrador Geral',
    });
    expect(result).toEqual(
      expect.objectContaining({
        accessToken: 'new-access',
        user: { id: 'user-1' },
        isAdminGeral: true,
      }),
    );
  });

  it('login de ADMIN_GERAL emite sessão direta quando MFA obrigatório está desligado', async () => {
    (turnstileService.assertHuman as jest.Mock).mockResolvedValue(undefined);
    (authService.validateUser as jest.Mock).mockResolvedValue({
      id: 'user-1',
      nome: 'Usuário Teste',
      cpf: '12345678900',
      company_id: 'company-1',
      profile: { nome: Role.ADMIN_GERAL },
    });
    (mfaService.isEnabled as jest.Mock).mockReturnValue(true);
    (mfaService.requiresMfa as jest.Mock).mockReturnValue(false);
    (authService.login as jest.Mock).mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      user: { id: 'user-1' },
    });

    const result = await controller.login(
      buildLoginRequest({
        headers: { 'user-agent': 'jest' },
      }),
      buildLoginDto(),
      createResponse(),
    );

    expect(mfaService.requiresMfa).toHaveBeenCalledWith(Role.ADMIN_GERAL);
    expect(mfaService.getStatus).not.toHaveBeenCalled();
    expect(mfaService.createLoginChallenge).not.toHaveBeenCalled();
    expect(mfaService.createBootstrapEnrollmentResponse).not.toHaveBeenCalled();
    expect(authService.login).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        accessToken: 'new-access',
        user: { id: 'user-1' },
        isAdminGeral: true,
      }),
    );
  });

  it('confirm-password delega para o fluxo de step-up MFA', async () => {
    const result = await controller.confirmPassword(
      {
        user: {
          userId: 'user-1',
          company_id: 'company-1',
          profile: { nome: 'Administrador Geral' },
          jti: 'access-jti-1',
        },
      } as never,
      buildConfirmPasswordDto(),
    );

    expect(mfaService.verifyStepUp).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        reason: 'legacy_confirm_password',
        password: 'SenhaSegura@123',
        accessJti: 'access-jti-1',
      }),
    );
    expect(result).toEqual({
      stepUpToken: 'step-up-token',
      expiresIn: 300,
    });
  });

  it('confirm-password retorna 401 quando o step-up reprova a reautenticação', async () => {
    (mfaService.verifyStepUp as jest.Mock).mockRejectedValue(
      new UnauthorizedException('Senha incorreta'),
    );

    await expect(
      controller.confirmPassword(
        {
          user: {
            userId: 'user-1',
            company_id: 'company-1',
            profile: { nome: 'Administrador Geral' },
          },
        } as never,
        buildConfirmPasswordDto({
          password: 'SenhaErrada@123',
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('login retorna challenge MFA para conta privilegiada já cadastrada', async () => {
    (turnstileService.assertHuman as jest.Mock).mockResolvedValue(undefined);
    (authService.validateUser as jest.Mock).mockResolvedValue({
      id: 'user-1',
      nome: 'Usuário Teste',
      cpf: '12345678900',
      company_id: 'company-1',
      profile: { nome: 'Administrador Geral' },
    });
    (mfaService.requiresMfa as jest.Mock).mockReturnValue(true);
    (mfaService.getStatus as jest.Mock).mockResolvedValue({
      enabled: true,
      required: true,
      privilegedRole: 'ADMIN_GERAL',
      recoveryCodesRemaining: 8,
    });
    (mfaService.createLoginChallenge as jest.Mock).mockResolvedValue({
      challengeToken: 'challenge-token',
      expiresIn: 300,
      methods: ['totp', 'recovery_code'],
    });

    const result = await controller.login(
      buildLoginRequest({
        headers: { 'user-agent': 'jest' },
      }),
      buildLoginDto(),
      createResponse(),
    );

    expect(result).toEqual({
      mfaRequired: true,
      challengeToken: 'challenge-token',
      expiresIn: 300,
      methods: ['totp', 'recovery_code'],
    });
    expect(authService.login).not.toHaveBeenCalled();
  });

  it('login retorna bootstrap MFA para conta privilegiada sem cadastro ativo', async () => {
    (turnstileService.assertHuman as jest.Mock).mockResolvedValue(undefined);
    (authService.validateUser as jest.Mock).mockResolvedValue({
      id: 'user-1',
      nome: 'Usuário Teste',
      cpf: '12345678900',
      funcao: 'Administrador',
      auth_user_id: 'auth-user-1',
      company_id: 'company-1',
      profile: { nome: 'Administrador Geral' },
    });
    (mfaService.requiresMfa as jest.Mock).mockReturnValue(true);
    (mfaService.getStatus as jest.Mock).mockResolvedValue({
      enabled: false,
      required: true,
      privilegedRole: 'ADMIN_GERAL',
      recoveryCodesRemaining: 0,
    });
    (
      mfaService.createBootstrapEnrollmentResponse as jest.Mock
    ).mockResolvedValue({
      challengeToken: 'bootstrap-token',
      expiresIn: 900,
      otpAuthUrl: 'otpauth://totp/SGS',
      manualEntryKey: 'JBSWY3DPEHPK3PXP',
      recoveryCodes: ['ABCD-EFGH-IJKL-MNOP'],
    });

    const result = await controller.login(
      buildLoginRequest({
        headers: { 'user-agent': 'jest' },
      }),
      buildLoginDto(),
      createResponse(),
    );

    expect(result).toEqual({
      mfaEnrollRequired: true,
      challengeToken: 'bootstrap-token',
      expiresIn: 900,
      otpAuthUrl: 'otpauth://totp/SGS',
      manualEntryKey: 'JBSWY3DPEHPK3PXP',
      recoveryCodes: ['ABCD-EFGH-IJKL-MNOP'],
    });
    expect(authService.login).not.toHaveBeenCalled();
    expect(mfaService.getStatus).toHaveBeenCalledWith({
      userId: 'user-1',
      authUserId: 'auth-user-1',
      companyId: 'company-1',
      profileName: 'Administrador Geral',
    });
  });

  it('reentra no tenant do challenge antes de recarregar o usuário no bootstrap MFA', async () => {
    (mfaService.activateBootstrapChallenge as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
    });
    (authService.login as jest.Mock).mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user: { id: 'user-1', company_id: 'company-1' },
    });

    const result = await controller.activateBootstrapMfa(
      buildLoginRequest({ headers: { 'user-agent': 'jest' } }),
      { challengeToken: 'bootstrap-token', code: '123456' },
      createResponse(),
    );

    expect(tenantService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        isSuperAdmin: false,
        userId: 'user-1',
      }),
      expect.any(Function),
    );
    expect(authSessionUserLoader).toHaveBeenCalledWith('user-1');
    expect(result.accessToken).toBe('access-token');
  });

  it('reentra no tenant do challenge antes de recarregar o usuário no login MFA', async () => {
    (mfaService.verifyLoginChallenge as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
    });
    (authService.login as jest.Mock).mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user: { id: 'user-1', company_id: 'company-1' },
    });

    const result = await controller.verifyLoginMfa(
      buildLoginRequest({ headers: { 'user-agent': 'jest' } }),
      { challengeToken: 'login-token', code: '123456' },
      createResponse(),
    );

    expect(tenantService.run).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', isSuperAdmin: false }),
      expect.any(Function),
    );
    expect(authSessionUserLoader).toHaveBeenCalledWith('user-1');
    expect(result.accessToken).toBe('access-token');
  });

  it('me usa leitura leve de sessão e retorna RBAC', async () => {
    const req = {
      user: {
        userId: 'user-1',
      },
    };

    const result = await controller.me(req);

    expect(result.user.id).toBe('user-1');
    expect(result.roles).toEqual(['admin']);
    expect(result.permissions).toEqual(['can_view']);
    expect(result.isAdminGeral).toBe(true);
    expect(rbacService.getUserAccess).toHaveBeenCalledWith('user-1', {
      profileName: 'Administrador Geral',
    });
  });

  it('me retorna isAdminGeral=true para role Administrador Geral', async () => {
    (rbacService.getUserAccess as jest.Mock).mockResolvedValueOnce({
      roles: [Role.ADMIN_GERAL],
      permissions: ['can_view'],
    });

    const result = await controller.me({
      user: {
        userId: 'user-1',
      },
    });

    expect(result.isAdminGeral).toBe(true);
  });
});
