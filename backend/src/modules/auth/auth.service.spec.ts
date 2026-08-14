/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { PasswordService } from '../../shared/services/password.service';
import {
  BadRequestException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { User } from '../users/entities/user.entity';
import { AuthRedisService } from '../../shared/redis/redis.service';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TokenRevocationService } from './token-revocation.service';
import { MailService } from '../../infra/mail/mail.service';
import { UserSession } from './entities/user-session.entity';
import { SecurityAuditService } from '../../shared/security/security-audit.service';
import { LoginAnomalyService } from './services/login-anomaly.service';
import { PwnedPasswordService } from './services/pwned-password.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import { AuthPrincipalService } from './auth-principal.service';

type UserSessionRepositoryMock = {
  insert: jest.Mock<Promise<unknown>, [Partial<UserSession>]>;
  update: jest.Mock<Promise<{ affected?: number }>, [unknown?, unknown?]>;
  findOne: jest.Mock<Promise<UserSession | null>, [unknown?]>;
};

type UserSessionLookupArgs = {
  where?: {
    user_id?: string;
    is_active?: boolean;
  };
};

const TEST_BCRYPT_HASH = [
  '$2b$10$tV1AhMRqCdZTnSEV18aoR.',
  'MSJ.1zu7PIewZKDn1GkoTSqvrSNENC2',
].join('');

type UserSessionUpdateWhereArgs = {
  user_id?: string;
  token_hash?: string;
  is_active?: boolean;
};

type UserSessionUpdateSetArgs = {
  token_hash?: string;
  is_active?: boolean;
  revoked_at?: Date;
};

describe('AuthService', () => {
  let service: AuthService;
  let jwtService: jest.Mocked<JwtService>;
  let passwordService: jest.Mocked<PasswordService>;
  let redisService: jest.Mocked<AuthRedisService>;
  let tokenRevocationService: {
    isRevoked: jest.Mock;
    revoke: jest.Mock;
  };
  let securityAuditService: {
    tokenReuseDetected: jest.Mock;
    tokenRefresh: jest.Mock;
    passwordChanged: jest.Mock;
    passwordReset: jest.Mock;
    logout: jest.Mock;
  };
  let usersService: {
    findOneWithPassword: jest.Mock;
    update: jest.Mock;
  };
  let configService: { get: jest.Mock };
  let mailService: { sendMailSimple: jest.Mock };
  let dataSource: {
    transaction: jest.Mock;
    query: jest.Mock;
    createQueryRunner: jest.Mock;
  };
  let userSessionRepository: UserSessionRepositoryMock;
  let redisClient: {
    get: jest.Mock;
    setex: jest.Mock;
    del: jest.Mock;
    eval: jest.Mock;
  };
  let manager: {
    query: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    getRepository: jest.Mock;
  };

  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_ENABLED = 'true';
    process.env.FIELD_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.FIELD_ENCRYPTION_HASH_KEY = 'auth-service-test-hash-key';

    manager = {
      query: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      getRepository: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn((callback: (txManager: typeof manager) => unknown) =>
        Promise.resolve(callback(manager)),
      ),
      query: jest.fn().mockResolvedValue([]),
      createQueryRunner: jest.fn().mockReturnValue({
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([]),
        manager,
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
      }),
    };
    userSessionRepository = {
      insert: jest
        .fn<Promise<unknown>, [Partial<UserSession>]>()
        .mockResolvedValue({ identifiers: [{ id: 'session-1' }] }),
      update: jest
        .fn<Promise<{ affected?: number }>, [unknown?, unknown?]>()
        .mockResolvedValue({ affected: 1 }),
      findOne: jest
        .fn<Promise<UserSession | null>, [unknown?]>()
        .mockResolvedValue(null),
    };
    manager.getRepository.mockReturnValue(userSessionRepository);
    redisClient = {
      get: jest.fn().mockResolvedValue('1'),
      setex: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(['1', '1', '0', '0']),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: DataSource,
          useValue: dataSource,
        },
        {
          provide: getRepositoryToken(UserSession),
          useValue: userSessionRepository,
        },
        {
          provide: UsersService,
          useValue: (usersService = {
            findOneWithPassword: jest.fn(),
            update: jest.fn(),
          }),
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('token'),
            verifyAsync: jest.fn(),
          },
        },
        {
          provide: PasswordService,
          useValue: {
            verify: jest.fn().mockResolvedValue(true),
            compare: jest.fn().mockResolvedValue(true),
            hash: jest
              .fn()
              .mockResolvedValue('$argon2id$v=19$m=65536$new-hash'),
            isLegacyHash: jest.fn().mockReturnValue(false),
            validate: jest.fn().mockReturnValue({ valid: true }),
          },
        },
        {
          provide: AuthRedisService,
          useValue: {
            storeRefreshToken: jest.fn().mockResolvedValue(undefined),
            enforceMaxSessions: jest.fn().mockResolvedValue([]),
            atomicConsumeRefreshToken: jest.fn().mockResolvedValue('1'),
            isTokenConsumed: jest.fn().mockResolvedValue(false),
            revokeRefreshToken: jest.fn().mockResolvedValue(undefined),
            clearAllRefreshTokens: jest.fn().mockResolvedValue(undefined),
            getClient: jest.fn(() => redisClient),
          },
        },
        {
          provide: ConfigService,
          useValue: (configService = {
            get: jest.fn((key: string) => {
              if (key === 'JWT_SECRET') return 'test-access-secret-1234567890';
              if (key === 'JWT_REFRESH_SECRET') {
                return 'test-refresh-secret-1234567890';
              }
              if (key === 'LEGACY_PASSWORD_AUTH_ENABLED') {
                return true;
              }
              return null;
            }),
          }),
        },
        {
          provide: TokenRevocationService,
          useValue: (tokenRevocationService = {
            isRevoked: jest.fn().mockResolvedValue(false),
            revoke: jest.fn().mockResolvedValue(undefined),
          }),
        },
        {
          provide: MailService,
          useValue: {
            sendMailSimple: jest
              .fn()
              .mockResolvedValue({ info: {}, usingTestAccount: false }),
          },
        },
        {
          provide: SecurityAuditService,
          useValue: (securityAuditService = {
            tokenReuseDetected: jest.fn(),
            tokenRefresh: jest.fn(),
            passwordChanged: jest.fn(),
            passwordReset: jest.fn(),
            logout: jest.fn(),
          }),
        },
        {
          provide: LoginAnomalyService,
          useValue: { checkAndAlert: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: PwnedPasswordService,
          useValue: { assertNotPwned: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: TenantService,
          useValue: {
            run: jest.fn((_ctx: unknown, callback: () => unknown) =>
              callback(),
            ),
          },
        },
        {
          provide: AuthPrincipalService,
          useValue: {
            resolveCurrentUserContext: jest.fn().mockResolvedValue(null),
            invalidateBridgeCache: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get(JwtService);
    passwordService = module.get(PasswordService);
    redisService = module.get(AuthRedisService);
    mailService = module.get(MailService);
  });

  describe('validateUser', () => {
    it('should return user without password if validation succeeds', async () => {
      const userRow = {
        id: 'user-1',
        nome: 'Usuário Teste',
        cpf: '12345678900',
        email: 'user@example.com',
        funcao: 'Técnico',
        company_id: 'company-1',
        site_id: null,
        profile_id: 'profile-1',
        profile_nome: 'Administrador Geral',
        auth_user_id: 'auth-user-1',
        password: TEST_BCRYPT_HASH,
        status: true,
      };
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('find_login_user')) {
          return [userRow];
        }
        return [];
      });
      passwordService.isLegacyHash.mockReturnValue(true);
      passwordService.verify.mockResolvedValue(true);

      const result = (await service.validateUser(
        '12345678900',
        'password',
      )) as Partial<User>;

      await new Promise((resolve) => setImmediate(resolve));

      expect(result).toEqual(
        expect.objectContaining({
          id: userRow.id,
          profile: { id: 'profile-1', nome: 'Administrador Geral' },
        }),
      );
      expect(result.password).toBeUndefined();
    });

    it('should return null if user not found', async () => {
      dataSource.query.mockResolvedValue([]);
      const result = await service.validateUser('123', 'pass');
      expect(result).toBeNull();
    });

    it('should return null if password does not match', async () => {
      const userRow = {
        id: 'user-1',
        nome: 'Usuário Teste',
        cpf: '12345678900',
        email: 'user@example.com',
        funcao: 'Técnico',
        company_id: 'company-1',
        site_id: null,
        profile_id: 'profile-1',
        profile_nome: 'Administrador Geral',
        auth_user_id: 'auth-user-1',
        password: TEST_BCRYPT_HASH,
        status: true,
      };
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('find_login_user')) {
          return [userRow];
        }
        if (sql.includes('FROM auth.users')) {
          return [];
        }
        return [];
      });
      passwordService.isLegacyHash.mockReturnValue(true);
      passwordService.verify.mockResolvedValue(false);

      const result = await service.validateUser('123', 'pass');
      expect(result).toBeNull();
    });

    it('retorna null quando senha local não confere', async () => {
      const userRow = {
        id: 'user-1',
        nome: 'Usuário Teste',
        cpf: '12345678900',
        email: 'user@example.com',
        funcao: 'Técnico',
        company_id: 'company-1',
        site_id: null,
        profile_id: 'profile-1',
        profile_nome: 'Administrador Geral',
        auth_user_id: '11111111-1111-1111-1111-111111111111',
        password: TEST_BCRYPT_HASH,
        status: true,
      };
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('find_login_user')) {
          return [userRow];
        }
        return [];
      });
      passwordService.isLegacyHash.mockReturnValue(true);
      passwordService.verify.mockResolvedValue(false);

      const result = await service.validateUser('12345678900', 'wrong-pass');

      expect(result).toBeNull();
      expect(dataSource.query).not.toHaveBeenCalledWith(
        expect.stringContaining('FROM auth.users'),
        expect.anything(),
      );
    });

    it('nunca consulta auth.users — autenticação é exclusivamente local', async () => {
      const userRow = {
        id: 'user-1',
        nome: 'Usuário Teste',
        cpf: '12345678900',
        email: 'user@example.com',
        funcao: 'Técnico',
        company_id: 'company-1',
        auth_user_id: '11111111-1111-1111-1111-111111111111',
        site_id: null,
        profile_id: 'profile-1',
        profile_nome: 'Administrador Geral',
        password: '$argon2id$v=19$m=65536,t=3,p=4$local$hash',
        status: true,
      };
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('find_login_user')) {
          return [userRow];
        }
        if (sql.includes('FROM auth.users')) {
          throw new Error('auth.users should not be queried');
        }
        return [];
      });
      passwordService.isLegacyHash.mockReturnValue(false);
      passwordService.verify.mockResolvedValue(true);

      const result = await service.validateUser('12345678900', 'password');

      expect(result).toEqual(expect.objectContaining({ id: 'user-1' }));
      expect(dataSource.query).not.toHaveBeenCalledWith(
        expect.stringContaining('FROM auth.users'),
        expect.anything(),
      );
    });

    it('reutiliza o usuário real no bypass de desenvolvimento para manter UUID válido', async () => {
      const originalEnv = {
        NODE_ENV: process.env.NODE_ENV,
        DEV_LOGIN_BYPASS: process.env.DEV_LOGIN_BYPASS,
        ALLOW_DEV_LOGIN_BYPASS: process.env.ALLOW_DEV_LOGIN_BYPASS,
        DEV_ADMIN_CPF: process.env.DEV_ADMIN_CPF,
        DEV_ADMIN_PASSWORD: process.env.DEV_ADMIN_PASSWORD,
      };

      process.env.NODE_ENV = 'development';
      process.env.DEV_LOGIN_BYPASS = 'true';
      process.env.ALLOW_DEV_LOGIN_BYPASS = 'true';
      process.env.DEV_ADMIN_CPF = '15082302698';
      process.env.DEV_ADMIN_PASSWORD = 'GANDRA@2026';

      const userRow = {
        id: '11111111-1111-1111-1111-111111111111',
        nome: 'Administrador Geral',
        cpf: '15082302698',
        email: 'admin@example.com',
        funcao: 'Administrador',
        company_id: 'company-1',
        auth_user_id: '22222222-2222-2222-2222-222222222222',
        site_id: null,
        profile_id: 'profile-1',
        profile_nome: 'Administrador Geral',
        password: '$argon2id$v=19$m=65536,t=3,p=4$shadow$hash',
        status: true,
      };

      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('find_login_user')) {
          return [userRow];
        }
        return [];
      });

      try {
        const result = (await service.validateUser(
          '15082302698',
          'GANDRA@2026',
        )) as Partial<User>;

        expect(result).toEqual(
          expect.objectContaining({
            id: userRow.id,
            company_id: userRow.company_id,
            auth_user_id: userRow.auth_user_id,
            profile: { id: 'profile-1', nome: 'Administrador Geral' },
          }),
        );
      } finally {
        process.env.NODE_ENV = originalEnv.NODE_ENV;
        process.env.DEV_LOGIN_BYPASS = originalEnv.DEV_LOGIN_BYPASS;
        process.env.ALLOW_DEV_LOGIN_BYPASS = originalEnv.ALLOW_DEV_LOGIN_BYPASS;
        process.env.DEV_ADMIN_CPF = originalEnv.DEV_ADMIN_CPF;
        process.env.DEV_ADMIN_PASSWORD = originalEnv.DEV_ADMIN_PASSWORD;
      }
    });

    it('não aceita fallback plaintext quando o hash armazenado não é reconhecido', async () => {
      const userRow = {
        id: 'user-1',
        nome: 'Usuário Teste',
        cpf: '12345678900',
        email: 'user@example.com',
        funcao: 'Técnico',
        company_id: 'company-1',
        site_id: null,
        profile_id: 'profile-1',
        profile_nome: 'Administrador Geral',
        auth_user_id: 'auth-user-1',
        password: 'plaintext-antigo',
        status: true,
      };

      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('find_login_user')) {
          return [userRow];
        }
        return [];
      });
      passwordService.isLegacyHash.mockReturnValue(false);
      passwordService.verify.mockResolvedValue(false);

      const result = await service.validateUser(
        '12345678900',
        'plaintext-antigo',
      );
      expect(result).toBeNull();
    });

    it('ignora a flag legado de plaintext mesmo quando ela está ligada', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'JWT_SECRET') return 'test-access-secret-1234567890';
        if (key === 'JWT_REFRESH_SECRET') {
          return 'test-refresh-secret-1234567890';
        }
        if (key === 'LEGACY_PASSWORD_AUTH_ENABLED') {
          return true;
        }
        if (key === 'LEGACY_PASSWORD_PLAINTEXT_FALLBACK_ENABLED') {
          return true;
        }
        return null;
      });

      const userRow = {
        id: 'user-1',
        nome: 'Usuário Teste',
        cpf: '12345678900',
        email: 'user@example.com',
        funcao: 'Técnico',
        company_id: 'company-1',
        site_id: null,
        profile_id: 'profile-1',
        profile_nome: 'Administrador Geral',
        auth_user_id: 'auth-user-1',
        password: 'plaintext-antigo',
        status: true,
      };

      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('find_login_user')) {
          return [userRow];
        }
        return [];
      });
      passwordService.isLegacyHash.mockReturnValue(false);
      passwordService.verify.mockReset();

      const result = await service.validateUser(
        '12345678900',
        'plaintext-antigo',
      );

      expect(result).toBeNull();
      expect(passwordService.verify).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('should return access and refresh tokens', async () => {
      const user = {
        id: 'user-1',
        nome: 'Usuário Teste',
        cpf: '12345678900',
        funcao: 'Técnico',
        company_id: 'company-1',
        profile: { nome: 'Administrador Geral' },
      } as unknown as User;
      const result = await service.login(user);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result.user).toEqual(expect.objectContaining({ id: user.id }));
      const refreshTokenCall = jwtService.sign.mock.calls[1];
      const accessTokenCall = jwtService.sign.mock.calls[0];
      expect(accessTokenCall?.[0]).toEqual(
        expect.objectContaining({
          sub: user.id,
          isAdminGeral: true,
        }),
      );
      expect(accessTokenCall?.[0]).not.toHaveProperty('cpf');
      expect(refreshTokenCall?.[0]).toEqual(
        expect.objectContaining({ sub: user.id, isAdminGeral: true }),
      );
      expect(refreshTokenCall?.[0]).not.toHaveProperty('cpf');
      expect(refreshTokenCall?.[1]).toEqual(
        expect.objectContaining({
          expiresIn: '30d',
          secret: 'test-refresh-secret-1234567890',
        }),
      );
      expect(redisService.storeRefreshToken.mock.calls).toHaveLength(1);
      const savedSessionArg = userSessionRepository.insert.mock
        .calls[0]?.[0] as Partial<UserSession> | undefined;
      expect(savedSessionArg?.user_id).toBe('user-1');
      expect(typeof savedSessionArg?.token_hash).toBe('string');
      expect(savedSessionArg?.is_active).toBe(true);
    });
  });

  describe('changePassword local', () => {
    it('changePassword atualiza a senha local e invalida todas as sessões', async () => {
      usersService.findOneWithPassword.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        auth_user_id: '11111111-1111-1111-1111-111111111111',
        password: '$argon2id$v=19$m=65536,t=3,p=4$shadow$hash',
      });
      passwordService.isLegacyHash.mockReturnValue(false);
      passwordService.verify.mockResolvedValue(true);

      const result = await service.changePassword(
        'user-1',
        'Atual@123',
        'NovaSenha@123',
      );

      expect(result).toEqual({ message: 'Senha atualizada com sucesso' });
      expect(usersService.update).toHaveBeenCalledWith('user-1', {
        password: 'NovaSenha@123',
        must_change_password: false,
      });
      expect(redisService.clearAllRefreshTokens.mock.calls[0]).toEqual([
        'user-1',
      ]);
    });
  });

  describe('verifyUserPassword', () => {
    it('prioriza a senha local quando auth legada está habilitada', async () => {
      usersService.findOneWithPassword.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        password: TEST_BCRYPT_HASH,
      });
      passwordService.isLegacyHash.mockReturnValue(true);
      passwordService.verify.mockResolvedValue(true);

      const result = await service.verifyUserPassword('user-1', 'Atual@123');

      expect(result).toBe(true);
      expect(dataSource.query).not.toHaveBeenCalledWith(
        expect.stringContaining('FROM auth.users'),
        expect.anything(),
      );
    });

    it('retorna false quando senha local não confere e não há fallback externo', async () => {
      usersService.findOneWithPassword.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        auth_user_id: '11111111-1111-1111-1111-111111111111',
        password: TEST_BCRYPT_HASH,
      });
      passwordService.isLegacyHash.mockReturnValue(true);
      passwordService.verify.mockResolvedValue(false);

      const result = await service.verifyUserPassword('user-1', 'SenhaErrada');

      expect(result).toBe(false);
      expect(dataSource.query).not.toHaveBeenCalledWith(
        expect.stringContaining('FROM auth.users'),
        expect.anything(),
      );
    });
  });

  describe('refresh', () => {
    it('should return new access token if refresh token is valid', async () => {
      jwtService.sign
        .mockReturnValueOnce('new-access-token')
        .mockReturnValueOnce('new-refresh-token');
      const verifiedPayload = {
        sub: '123',
        cpf: '123',
        company_id: '123',
      };
      jwtService.verifyAsync.mockResolvedValue(verifiedPayload);
      redisService.atomicConsumeRefreshToken.mockResolvedValue('1');

      const result = await service.refresh('valid-refresh-token');

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(jwtService.verifyAsync.mock.calls[0]).toEqual([
        'valid-refresh-token',
        expect.objectContaining({
          secret: 'test-refresh-secret-1234567890',
        }),
      ]);
      expect(redisService.atomicConsumeRefreshToken.mock.calls).toHaveLength(1);
      expect(redisService.storeRefreshToken.mock.calls).toHaveLength(1);
      expect(userSessionRepository.update).toHaveBeenCalled();
    });

    it('recovers refresh token from persisted session when Redis lost the key', async () => {
      jwtService.sign
        .mockReturnValueOnce('new-access-token')
        .mockReturnValueOnce('new-refresh-token');
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        cpf: '123',
        company_id: 'company-1',
      });
      redisService.atomicConsumeRefreshToken.mockResolvedValue(null);
      redisService.isTokenConsumed.mockResolvedValue(false);
      userSessionRepository.findOne.mockResolvedValue({
        user_id: 'user-1',
        token_hash: 'existing-hash',
        is_active: true,
        expires_at: new Date('2099-01-01T00:00:00Z'),
      } as UserSession);

      const result = await service.refresh('valid-refresh-token');

      expect(result.accessToken).toBe('new-access-token');
      const findOneCalls = userSessionRepository.findOne.mock.calls as Array<
        [UserSessionLookupArgs?]
      >;
      const [findOneArgs] = findOneCalls.at(-1) ?? [];
      expect(findOneArgs?.where?.user_id).toBe('user-1');
      expect(findOneArgs?.where?.is_active).toBe(true);

      const updateCalls = userSessionRepository.update.mock.calls as Array<
        [UserSessionUpdateWhereArgs?, UserSessionUpdateSetArgs?]
      >;
      const [updateWhere, updateSet] = updateCalls.at(-1) ?? [];
      expect(updateWhere?.user_id).toBe('user-1');
      expect(updateWhere?.is_active).toBe(true);
      expect(updateSet?.token_hash).toEqual(expect.any(String));
      expect(updateSet?.is_active).toBe(true);
      expect(userSessionRepository.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'user-1' }),
      );
    });

    it('rejects refresh when Redis misses the key and persisted session is inactive', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        cpf: '123',
        company_id: 'company-1',
      });
      redisService.atomicConsumeRefreshToken.mockResolvedValue(null);
      redisService.isTokenConsumed.mockResolvedValue(false);
      userSessionRepository.findOne.mockResolvedValue(null);

      await expect(service.refresh('revoked-refresh-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('revoga todas as sessões ao detectar reuso de refresh token já consumido', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        cpf: '123',
        company_id: 'company-1',
      });
      redisService.atomicConsumeRefreshToken.mockResolvedValue(null);
      redisService.isTokenConsumed.mockResolvedValue(true);

      await expect(service.refresh('replayed-refresh-token')).rejects.toThrow(
        UnauthorizedException,
      );

      expect(redisService.clearAllRefreshTokens).toHaveBeenCalledWith('user-1');
      expect(securityAuditService.tokenReuseDetected).toHaveBeenCalledWith(
        'user-1',
        undefined,
        undefined,
      );
      expect(redisService.storeRefreshToken).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException if refresh token is invalid', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error());
      await expect(service.refresh('invalid')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
  describe('forgotPassword', () => {
    afterEach(() => {
      delete process.env.FORGOT_PASSWORD_MIN_PROCESSING_MS;
      delete process.env.FORGOT_PASSWORD_JITTER_MS;
      jest.useRealTimers();
    });

    it('should send reset email via MailService for an existing user', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 'user-1',
          email: 'user@example.com',
          nome: 'Usuário Teste',
          status: true,
        },
      ]);

      const result = await service.forgotPassword('12345678900');

      expect(result.message).toContain('Se o CPF estiver cadastrado');
      expect(mailService.sendMailSimple).toHaveBeenCalledTimes(1);
      expect(mailService.sendMailSimple).toHaveBeenCalledWith(
        'user@example.com',
        'Redefinição de senha — SGS',
        expect.stringContaining('/auth/reset-password'),
        { userId: 'user-1' },
        undefined,
        expect.objectContaining({ filename: 'password-reset' }),
      );
      expect(redisClient.eval).toHaveBeenCalledTimes(1);
    });

    it('busca o usuário pela função SECURITY DEFINER, não por SELECT com flag de sessão', async () => {
      // Regressão da migration 361: a CTE com
      // `set_config('app.is_super_admin','true')` que existia aqui virou letra
      // morta — a RLS de `users` devolvia 0 linhas, nenhum e-mail era enviado, e
      // a resposta genérica antienumeração escondia a falha de todo mundo.
      dataSource.query.mockResolvedValueOnce([
        {
          id: 'user-1',
          email: 'user@example.com',
          nome: 'Usuário Teste',
          status: true,
        },
      ]);

      await service.forgotPassword('12345678900');

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('find_login_user'),
        expect.any(Array),
      );
      expect(dataSource.query).not.toHaveBeenCalledWith(
        expect.stringContaining('app.is_super_admin'),
        expect.anything(),
      );
    });

    it('should keep a successful public response if e-mail delivery fails', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 'user-1',
          email: 'user@example.com',
          nome: 'Usuário Teste',
          status: true,
        },
      ]);
      mailService.sendMailSimple.mockRejectedValueOnce(
        new Error('smtp unavailable'),
      );

      const result = await service.forgotPassword('12345678900');

      expect(result.message).toContain('Se o CPF estiver cadastrado');
      expect(mailService.sendMailSimple).toHaveBeenCalledTimes(1);
    });

    it('aplica tempo mínimo consistente para usuário existente e inexistente', async () => {
      process.env.FORGOT_PASSWORD_MIN_PROCESSING_MS = '300';
      process.env.FORGOT_PASSWORD_JITTER_MS = '0';
      jest.useFakeTimers();
      const ensureSpy = jest.spyOn(
        service as any,
        'ensureMinimumProcessingTime',
      );

      dataSource.query.mockResolvedValueOnce([
        {
          id: 'user-1',
          email: 'user@example.com',
          nome: 'Usuário Teste',
          status: true,
        },
      ]);

      const firstPromise = service.forgotPassword('12345678900', {
        ip: '203.0.113.10',
      });
      await Promise.resolve();
      jest.advanceTimersByTime(300);
      await firstPromise;

      dataSource.query.mockResolvedValueOnce([]);
      const secondPromise = service.forgotPassword('12345678900', {
        ip: '203.0.113.10',
      });
      await Promise.resolve();
      jest.advanceTimersByTime(300);
      await secondPromise;

      expect(ensureSpy).toHaveBeenCalledTimes(2);
      expect(ensureSpy).toHaveBeenNthCalledWith(1, expect.any(Number), 300);
      expect(ensureSpy).toHaveBeenNthCalledWith(2, expect.any(Number), 300);
    });

    it('bloqueia por rate limit de IP/CPF sem vazar estado do usuário', async () => {
      process.env.FORGOT_PASSWORD_MIN_PROCESSING_MS = '200';
      process.env.FORGOT_PASSWORD_JITTER_MS = '0';
      jest.useFakeTimers();
      redisClient.eval.mockResolvedValueOnce(['13', '7', '1', '120']);
      dataSource.query.mockResolvedValueOnce([
        {
          id: 'user-1',
          email: 'user@example.com',
          nome: 'Usuário Teste',
          status: true,
        },
      ]);

      const promise = service.forgotPassword('12345678900', {
        ip: '198.51.100.20',
      });
      await Promise.resolve();
      jest.advanceTimersByTime(200);

      await expect(promise).rejects.toThrow(HttpException);
      expect(mailService.sendMailSimple).not.toHaveBeenCalled();
    });
  });

  describe('session hardening', () => {
    it('logout revoga sessão persistida quando refresh token é válido', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        cpf: '123',
        company_id: 'company-1',
      });
      await service.logout('valid-refresh-token');

      const updateCalls = userSessionRepository.update.mock.calls as Array<
        [UserSessionUpdateWhereArgs?, UserSessionUpdateSetArgs?]
      >;
      const [updateWhere, updateSet] = updateCalls.at(-1) ?? [];
      expect(updateWhere?.user_id).toBe('user-1');
      expect(updateWhere?.token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(updateWhere?.is_active).toBe(true);
      expect(updateSet?.is_active).toBe(false);
      expect(updateSet?.revoked_at).toEqual(expect.any(Date));
    });

    it('logout invalida access token no servidor usando blacklist por jti', async () => {
      const now = Math.floor(Date.now() / 1000);
      jwtService.verifyAsync
        .mockResolvedValueOnce({
          sub: 'user-1',
          cpf: '123',
          company_id: 'company-1',
        })
        .mockResolvedValueOnce({
          sub: 'user-1',
          jti: 'access-jti-1',
          exp: now + 300,
          cpf: '123',
          company_id: 'company-1',
        });

      await service.logout('valid-refresh-token', 'valid-access-token');

      expect(tokenRevocationService.revoke).toHaveBeenCalledWith(
        'access-jti-1',
        expect.any(Number),
      );
      const [, ttl] = tokenRevocationService.revoke.mock.calls[0] as [
        string,
        number,
      ];
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
    });
  });

  describe('resetPassword', () => {
    it('consome token de forma atômica e redefine senha com sucesso', async () => {
      redisClient.eval.mockResolvedValueOnce([
        'CONSUMED',
        '1',
        'user-1',
        String(Date.now()),
      ]);
      dataSource.query.mockResolvedValueOnce([
        { user_id: 'user-1', company_id: 'company-1' },
      ]);

      const result = await service.resetPassword(
        'valid-reset-token',
        'Nova@Senha123',
      );

      expect(result.message).toContain('Senha redefinida com sucesso');
      expect(redisClient.eval).toHaveBeenCalledTimes(1);
      expect(redisService.clearAllRefreshTokens).toHaveBeenCalledWith('user-1');
      expect(userSessionRepository.update).toHaveBeenCalledWith(
        { user_id: 'user-1', is_active: true },
        { is_active: false, revoked_at: expect.any(Date) },
      );
    });

    it('grava a senha pela função SECURITY DEFINER, não por UPDATE direto', async () => {
      // Regressão da migration 361: `UPDATE users` na conexão de runtime é
      // descartado pela RLS com 0 linhas afetadas e sem erro — o fluxo
      // respondia "senha alterada" com a senha antiga intacta.
      redisClient.eval.mockResolvedValueOnce([
        'CONSUMED',
        '1',
        'user-1',
        String(Date.now()),
      ]);
      dataSource.query.mockResolvedValueOnce([
        { user_id: 'user-1', company_id: 'company-1' },
      ]);

      await service.resetPassword('valid-reset-token', 'Nova@Senha123');

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('reset_login_user_password'),
        ['user-1', expect.any(String)],
      );
      expect(manager.update).not.toHaveBeenCalledWith(
        User,
        { id: 'user-1' },
        expect.anything(),
      );
    });

    it('falha alto quando nenhuma linha é atualizada', async () => {
      // Sem esta guarda, um usuário inexistente ou excluído recebia
      // "senha redefinida com sucesso" sem que nada tivesse mudado.
      redisClient.eval.mockResolvedValueOnce([
        'CONSUMED',
        '1',
        'user-inexistente',
        String(Date.now()),
      ]);
      dataSource.query.mockResolvedValueOnce([]);

      await expect(
        service.resetPassword('valid-reset-token', 'Nova@Senha123'),
      ).rejects.toThrow(BadRequestException);
    });

    it('bloqueia reuso de token e registra auditoria', async () => {
      redisClient.eval.mockResolvedValueOnce(['REUSED', '2', '']);
      const warnSpy = jest.spyOn((service as any).logger, 'warn');

      await expect(
        service.resetPassword('reused-reset-token', 'Nova@Senha123'),
      ).rejects.toThrow(BadRequestException);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'reset_password_token_reuse_detected',
          attempts: 2,
        }),
      );
      expect(passwordService.hash).not.toHaveBeenCalled();
    });

    it('aplica rate limit por token e retorna HTTP 429', async () => {
      redisClient.eval.mockResolvedValueOnce(['RATE_LIMITED', '9', '120']);
      const warnSpy = jest.spyOn((service as any).logger, 'warn');

      await expect(
        service.resetPassword('rate-limited-reset-token', 'Nova@Senha123'),
      ).rejects.toThrow(HttpException);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'reset_password_rate_limited',
          attempts: 9,
          retryAfterSeconds: 120,
        }),
      );
      expect(passwordService.hash).not.toHaveBeenCalled();
    });

    it('rejeita token expirado sem avançar para troca de senha', async () => {
      redisClient.eval.mockResolvedValueOnce(['EXPIRED', '1', '']);

      await expect(
        service.resetPassword('expired-reset-token', 'Nova@Senha123'),
      ).rejects.toThrow(BadRequestException);

      expect(passwordService.hash).not.toHaveBeenCalled();
      expect(redisService.clearAllRefreshTokens).not.toHaveBeenCalled();
    });
  });
});
