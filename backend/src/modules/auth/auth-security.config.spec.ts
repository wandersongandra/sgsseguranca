import {
  getAccessTokenTtl,
  getAccessTokenTtlMs,
  getLegacyRequestCsrfClearCookieOptions,
  getLegacyRefreshTokenClearCookieOptions,
  getRequestCsrfCookieOptions,
  getRefreshCsrfCookieOptions,
  getRefreshTokenTtl,
  getRefreshTokenTtlDays,
  getRefreshTokenCookieOptions,
  getJwtContract,
  getJwtSignOptions,
  getJwtVerifyOptions,
  isFiniteJwtTtl,
  isUnsafeJwtSecret,
} from './auth-security.config';

describe('auth-security.config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      AUTH_COOKIE_DOMAIN: '.sgsseguranca.com.br',
      AUTH_COOKIE_SAMESITE: 'strict',
      AUTH_COOKIE_SECURE: 'true',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('prioriza ACCESS_TOKEN_TTL sobre JWT_EXPIRES_IN', () => {
    process.env.ACCESS_TOKEN_TTL = '20m';
    process.env.JWT_EXPIRES_IN = '10m';

    expect(getAccessTokenTtl()).toBe('20m');
  });

  it('calcula o TTL do access token em milissegundos para validação de produção', () => {
    process.env.ACCESS_TOKEN_TTL = '15m';

    expect(getAccessTokenTtlMs()).toBe(15 * 60 * 1000);
  });

  it('aceita TTL legado numérico em segundos', () => {
    process.env.ACCESS_TOKEN_TTL = '900';

    expect(getAccessTokenTtlMs()).toBe(15 * 60 * 1000);
  });

  it('retorna null para access token infinito', () => {
    process.env.ACCESS_TOKEN_TTL = 'infinite';

    expect(getAccessTokenTtlMs()).toBeNull();
  });

  it('usa REFRESH_TOKEN_TTL quando configurado', () => {
    process.env.REFRESH_TOKEN_TTL = '12h';
    process.env.REFRESH_TOKEN_TTL_DAYS = '14';

    expect(getRefreshTokenTtl()).toBe('12h');
    expect(getRefreshTokenTtlDays()).toBe(1);
  });

  it('faz fallback para REFRESH_TOKEN_TTL_DAYS quando REFRESH_TOKEN_TTL é inválido', () => {
    process.env.REFRESH_TOKEN_TTL = 'abc';
    process.env.REFRESH_TOKEN_TTL_DAYS = '21';

    expect(getRefreshTokenTtl()).toBe('21d');
    expect(getRefreshTokenTtlDays()).toBe(21);
  });

  it('mantém compatibilidade com JWT_REFRESH_EXPIRATION legado', () => {
    process.env.REFRESH_TOKEN_TTL = '';
    delete process.env.REFRESH_TOKEN_TTL_DAYS;
    process.env.JWT_REFRESH_EXPIRATION = '36h';

    expect(getRefreshTokenTtl()).toBe('2d');
    expect(getRefreshTokenTtlDays()).toBe(2);
  });

  it('envia refresh_token em todas as rotas (necessário para proxy)', () => {
    expect(getRefreshTokenCookieOptions()).toEqual(
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
        domain: '.sgsseguranca.com.br',
      }),
    );
  });

  it('expõe refresh_csrf no escopo necessário para o frontend ler e refletir no header', () => {
    expect(getRefreshCsrfCookieOptions()).toEqual(
      expect.objectContaining({
        httpOnly: false,
        secure: true,
        sameSite: 'strict',
        path: '/',
        domain: '.sgsseguranca.com.br',
      }),
    );
  });

  it('expõe csrf-token no domínio compartilhado entre app e api', () => {
    expect(getRequestCsrfCookieOptions()).toEqual(
      expect.objectContaining({
        httpOnly: false,
        secure: true,
        sameSite: 'strict',
        path: '/',
        domain: '.sgsseguranca.com.br',
      }),
    );
  });

  it('limpa o csrf-token legado host-only da api antes de emitir o novo cookie compartilhado', () => {
    expect(getLegacyRequestCsrfClearCookieOptions()).toEqual(
      expect.objectContaining({
        path: '/',
      }),
    );
    expect(getLegacyRequestCsrfClearCookieOptions()).not.toHaveProperty(
      'domain',
    );
  });

  it('limpa o refresh_token legado em /auth/refresh durante a migração para path amplo', () => {
    expect(getLegacyRefreshTokenClearCookieOptions()).toEqual(
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/auth/refresh',
        domain: '.sgsseguranca.com.br',
      }),
    );
  });

  it('exige issuer e audience para o contrato JWT', () => {
    const config = {
      get: jest.fn(
        (key: string) =>
          ({
            JWT_ISSUER: 'https://jwt.test.sgs.local',
            JWT_AUDIENCE: 'sgs-test',
          })[key],
      ),
    };

    expect(getJwtContract(config)).toEqual({
      issuer: 'https://jwt.test.sgs.local',
      audience: 'sgs-test',
      algorithms: ['HS256'],
    });
    expect(getJwtSignOptions(config)).toEqual({
      issuer: 'https://jwt.test.sgs.local',
      audience: 'sgs-test',
    });
    expect(getJwtVerifyOptions(config)).toEqual({
      issuer: 'https://jwt.test.sgs.local',
      audience: 'sgs-test',
      algorithms: ['HS256'],
    });
  });

  it('rejeita contrato JWT sem issuer/audience e TTL infinito fora do ambiente local', () => {
    const originalIssuer = process.env.JWT_ISSUER;
    const originalAudience = process.env.JWT_AUDIENCE;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    try {
      expect(() =>
        getJwtContract({ get: jest.fn().mockReturnValue(undefined) }),
      ).toThrow('JWT_ISSUER and JWT_AUDIENCE are required');
      expect(isFiniteJwtTtl('15m')).toBe(true);
      expect(isFiniteJwtTtl('infinite')).toBe(false);
      expect(isUnsafeJwtSecret('a'.repeat(64))).toBe(true);
      expect(isUnsafeJwtSecret('sgs-prod-access-key-A9'.repeat(4))).toBe(false);
    } finally {
      if (originalIssuer === undefined) delete process.env.JWT_ISSUER;
      else process.env.JWT_ISSUER = originalIssuer;
      if (originalAudience === undefined) delete process.env.JWT_AUDIENCE;
      else process.env.JWT_AUDIENCE = originalAudience;
    }
  });
});
