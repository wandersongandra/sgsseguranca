import { ConfigService } from '@nestjs/config';
import { Role } from '../enums/roles.enum';
import {
  extractAccessTokenClaimCache,
  normalizeAccessTokenClaims,
  resolveAccessTokenSecret,
} from './access-token-claims.util';

describe('access-token-claims.util', () => {
  it('normaliza o JWT local legado para o contrato canônico', () => {
    const normalized = normalizeAccessTokenClaims({
      sub: 'app-user-1',
      cpf: '12345678900',
      company_id: 'company-1',
      profile: { nome: 'Administrador Empresa' },
      plan: 'PROFESSIONAL',
    });

    expect(normalized).toEqual(
      expect.objectContaining({
        id: 'app-user-1',
        userId: 'app-user-1',
        app_user_id: 'app-user-1',
        cpf: '12345678900',
        company_id: 'company-1',
        companyId: 'company-1',
        profile: { nome: 'Administrador Empresa' },
        plan: 'PROFESSIONAL',
        isSuperAdmin: false,
      }),
    );
    expect(normalized.token_claim_cache).toEqual(
      expect.objectContaining({
        auth_user_id: 'app-user-1',
        company_id: 'company-1',
      }),
    );
  });

  it('promove explicitamente o super admin quando a claim booleana estiver presente', () => {
    const normalized = normalizeAccessTokenClaims({
      sub: 'app-user-1',
      app_user_id: 'app-user-1',
      is_super_admin: true,
    });

    expect(normalized.profile).toEqual({ nome: Role.SUPER_ADMIN });
    expect(normalized.isSuperAdmin).toBe(true);
    expect(normalized.token_claim_cache.is_super_admin).toBe(true);
  });

  it('expõe claims apenas como cache/hints para validação posterior em banco', () => {
    const cache = extractAccessTokenClaimCache({
      sub: 'app-user-42',
      app_user_id: 'app-user-42',
      company_id: 'company-claim',
      site_id: 'site-claim',
    });

    expect(cache).toEqual(
      expect.objectContaining({
        app_user_id: 'app-user-42',
        company_id: 'company-claim',
        site_id: 'site-claim',
      }),
    );
  });

  it('resolveAccessTokenSecret retorna JWT_SECRET quando configurado', () => {
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'JWT_SECRET')
          return 'local-secret-123456789012345678901234';
        return undefined;
      }),
    } as unknown as ConfigService;

    expect(resolveAccessTokenSecret(configService)).toBe(
      'local-secret-123456789012345678901234',
    );
  });

  it('resolveAccessTokenSecret lança erro quando JWT_SECRET não está configurado', () => {
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    expect(() => resolveAccessTokenSecret(configService)).toThrow(
      'JWT_SECRET is required',
    );
  });

  it('normaliza token com auth_uid mapeando para auth_user_id no cache', () => {
    const normalized = normalizeAccessTokenClaims({
      sub: 'app-user-1',
      app_user_id: 'app-user-1',
      auth_uid: 'auth-user-external-1',
      company_id: 'company-1',
      site_id: 'site-1',
    });

    expect(normalized.token_claim_cache.auth_user_id).toBe(
      'auth-user-external-1',
    );
    expect(normalized.app_user_id).toBe('app-user-1');
  });
});
