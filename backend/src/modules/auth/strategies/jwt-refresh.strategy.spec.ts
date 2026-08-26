import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { JwtRefreshStrategy } from './jwt-refresh.strategy';

describe('JwtRefreshStrategy', () => {
  const issuer = 'https://jwt.test.sgs.local';
  const audience = 'sgs-test';

  const buildStrategy = () => {
    process.env.JWT_REFRESH_SECRET = 'refresh-secret-for-tests';
    const redisClient = {
      get: jest.fn().mockResolvedValue('1'),
    };
    const redisService = {
      getClient: jest.fn(() => redisClient),
      getRefreshTokenKey: jest.fn((userId: string, tokenHash: string) => {
        return `refresh:${userId}:${tokenHash}`;
      }),
    };
    const configService = {
      get: jest.fn(
        (key: string) =>
          ({
            JWT_REFRESH_SECRET: 'refresh-secret-for-tests',
            JWT_ISSUER: issuer,
            JWT_AUDIENCE: audience,
          })[key],
      ),
    } as unknown as ConfigService;

    const strategy = new JwtRefreshStrategy(
      configService,
      redisService as never,
    );

    return { strategy, redisService, redisClient };
  };

  it('restringe a verificação JWT ao algoritmo HS256', () => {
    const { strategy } = buildStrategy();
    const verifyOptions = (strategy as unknown as { _verifOpts?: unknown })
      ._verifOpts as { algorithms?: string[] } | undefined;

    expect(verifyOptions?.algorithms).toEqual(['HS256']);
  });

  it('bloqueia refresh quando cookie refresh_token está ausente', async () => {
    const { strategy, redisClient } = buildStrategy();

    await expect(
      strategy.validate(
        {},
        {
          sub: 'user-1',
          iss: issuer,
          aud: audience,
          exp: 4_102_444_800,
          token_type: 'refresh',
        },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(redisClient.get).not.toHaveBeenCalled();
  });

  it('valida refresh token no Redis com hash do cookie', async () => {
    const { strategy, redisService, redisClient } = buildStrategy();
    const refreshToken = 'refresh-token-value';
    const tokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    const result = await strategy.validate(
      { cookies: { refresh_token: refreshToken } },
      {
        sub: 'user-1',
        company_id: 'company-1',
        profile: 'TST',
        iss: issuer,
        aud: audience,
        exp: 4_102_444_800,
        token_type: 'refresh',
      },
    );

    expect(redisService.getRefreshTokenKey).toHaveBeenCalledWith(
      'user-1',
      tokenHash,
    );
    expect(redisClient.get).toHaveBeenCalledWith(`refresh:user-1:${tokenHash}`);
    expect(result).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        company_id: 'company-1',
      }),
    );
  });

  it('bloqueia issuer/audience ausentes ou incorretos', async () => {
    const { strategy } = buildStrategy();
    const base = {
      sub: 'user-1',
      company_id: 'company-1',
      iss: issuer,
      aud: audience,
      exp: 4_102_444_800,
      token_type: 'refresh',
    };

    for (const payload of [
      { ...base, iss: undefined },
      { ...base, iss: 'https://evil.example' },
      { ...base, aud: undefined },
      { ...base, aud: 'other-api' },
    ]) {
      await expect(
        strategy.validate(
          { cookies: { refresh_token: 'refresh-token-value' } },
          payload,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('bloqueia access token e token legado sem token_type no caminho de refresh', async () => {
    const { strategy } = buildStrategy();
    const base = {
      sub: 'user-1',
      company_id: 'company-1',
      iss: issuer,
      aud: audience,
    };

    await expect(
      strategy.validate(
        { cookies: { refresh_token: 'refresh-token-value' } },
        { ...base, token_type: 'access' },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      strategy.validate(
        { cookies: { refresh_token: 'refresh-token-value' } },
        { ...base },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('bloqueia refresh token sem expiração', async () => {
    const { strategy } = buildStrategy();

    await expect(
      strategy.validate(
        { cookies: { refresh_token: 'refresh-token-value' } },
        {
          sub: 'user-1',
          company_id: 'company-1',
          iss: issuer,
          aud: audience,
          token_type: 'refresh',
          exp: undefined,
        },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
