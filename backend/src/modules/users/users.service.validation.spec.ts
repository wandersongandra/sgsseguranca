/**
 * Testes de validação focados em isolamento de tenant e integridade de cadastro.
 * Identity classification e role assignment já cobertos em users.service.spec.ts.
 */
import { DeepPartial, Repository } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { UserSite } from './entities/user-site.entity';
import { Profile } from '../profiles/entities/profile.entity';
import type { TenantService } from '../../shared/tenant/tenant.service';
import type { PasswordService } from '../../shared/services/password.service';
import type { PwnedPasswordService } from '../auth/services/pwned-password.service';
import type { AuditService } from '../audit-trail/audit.service';
import type { RbacService } from '../rbac/rbac.service';
import type { AuthRedisService } from '../../shared/redis/redis.service';
import type { AuthPrincipalService } from '../auth/auth-principal.service';
import type { ConfigService } from '@nestjs/config';
import { UserIdentityType } from './constants/user-identity.constant';

const COMPANY_ID = 'company-uuid-1';
const OTHER_COMPANY_ID = 'company-uuid-2';
const SITE_ID = 'site-uuid-1';
const PROFILE_ID = 'profile-uuid-1';

function buildUserSitesRepo(): Repository<UserSite> {
  const inner = {
    delete: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue([]),
    create: jest.fn((d: unknown) => d),
    find: jest.fn().mockResolvedValue([]),
  };
  return {
    ...inner,
    manager: {
      transaction: jest.fn(
        <T>(cb: (m: { getRepository: () => typeof inner }) => T) =>
          cb({ getRepository: () => inner }),
      ),
    },
  } as unknown as Repository<UserSite>;
}

function buildService(opts: {
  tenantId?: string | null;
  isSuperAdmin?: boolean;
  siteRepoMock?: { findOne?: jest.Mock; count?: jest.Mock };
}) {
  const { tenantId = COMPANY_ID, isSuperAdmin = false, siteRepoMock } = opts;

  const siteRepo = {
    findOne:
      siteRepoMock?.findOne ?? jest.fn().mockResolvedValue({ id: SITE_ID }),
    count: siteRepoMock?.count ?? jest.fn().mockResolvedValue(1),
  };

  const userRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((d: DeepPartial<User>) => d as User),
    save: jest.fn((e: User) =>
      Promise.resolve({
        ...e,
        created_at: new Date(),
        updated_at: new Date(),
      }),
    ),
    manager: {
      getRepository: jest.fn().mockReturnValue(siteRepo),
    },
  } as unknown as jest.Mocked<Repository<User>>;

  const profilesRepo = {
    findOne: jest.fn().mockResolvedValue({ id: PROFILE_ID, nome: 'Técnico' }),
  } as unknown as jest.Mocked<Repository<Profile>>;

  const tenantService: Partial<TenantService> = {
    getTenantId: jest.fn().mockReturnValue(tenantId ?? undefined),
    isSuperAdmin: jest.fn().mockReturnValue(isSuperAdmin),
  };

  const passwordService: Partial<PasswordService> = {
    hash: jest.fn().mockResolvedValue('$argon2id$hashed'),
    validate: jest.fn().mockReturnValue({ valid: true, errors: [] }),
  };
  const pwnedPasswordService: Partial<PwnedPasswordService> = {
    assertNotPwned: jest.fn().mockResolvedValue(undefined),
  };

  const auditService: Partial<AuditService> = { log: jest.fn() };
  const rbacService: Partial<RbacService> = {
    invalidateUserAccess: jest.fn(),
    getUserAccess: jest.fn().mockResolvedValue({ roles: [] }),
  };
  const redisService = { getClient: jest.fn() } as unknown as AuthRedisService;
  const authPrincipalService = {
    invalidateBridgeCache: jest.fn(),
  } as unknown as AuthPrincipalService;

  const service = new UsersService(
    userRepo,
    buildUserSitesRepo(),
    profilesRepo,
    tenantService as TenantService,
    passwordService as PasswordService,
    pwnedPasswordService as PwnedPasswordService,
    auditService as AuditService,
    rbacService as RbacService,
    redisService,
    { get: jest.fn() } as unknown as ConfigService,
    authPrincipalService,
  );

  return { service, userRepo, profilesRepo };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.FIELD_ENCRYPTION_ENABLED = 'true';
  process.env.FIELD_ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.FIELD_ENCRYPTION_HASH_KEY = 'users-validation-test-hash-key';
});

afterEach(() => {
  process.env = { ...originalEnv };
  jest.clearAllMocks();
});

describe('UsersService.create — isolamento de tenant', () => {
  it('lança ForbiddenException quando company_id do payload diverge do tenant autenticado', async () => {
    const { service } = buildService({});

    await expect(
      service.create({
        nome: 'Usuário Invasor',
        cpf: '09878058433',
        funcao: 'Eletricista',
        profile_id: PROFILE_ID,
        identity_type: UserIdentityType.EMPLOYEE_SIGNER,
        company_id: OTHER_COMPANY_ID,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lança BadRequestException quando nenhum tenant está no contexto (sem company)', async () => {
    const { service } = buildService({ tenantId: null });

    await expect(
      service.create({
        nome: 'Usuário Sem Empresa',
        cpf: '09878058433',
        funcao: 'Operador',
        identity_type: UserIdentityType.EMPLOYEE_SIGNER,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('injeta company_id do tenant, ignorando qualquer valor do body', async () => {
    const { service, userRepo } = buildService({});

    await service.create({
      nome: 'Funcionário',
      cpf: '09878058433',
      funcao: 'Eletricista',
      profile_id: PROFILE_ID,
      identity_type: UserIdentityType.EMPLOYEE_SIGNER,
    });

    const calls = (userRepo.create as jest.Mock).mock.calls as [
      Partial<User>,
    ][];
    const created = calls[0][0];
    expect(created.company_id).toBe(COMPANY_ID);
  });
});

describe('UsersService.create — site isolation (assertSitesBelongToCompany)', () => {
  it('lança BadRequestException quando site_id pertence a outra empresa', async () => {
    const { service } = buildService({
      siteRepoMock: { findOne: jest.fn().mockResolvedValue(null) },
    });

    await expect(
      service.create({
        nome: 'Funcionário',
        cpf: '09878058433',
        funcao: 'Eletricista',
        profile_id: PROFILE_ID,
        identity_type: UserIdentityType.EMPLOYEE_SIGNER,
        site_id: 'site-de-outra-empresa',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lança BadRequestException quando múltiplos site_ids não pertencem todos à empresa', async () => {
    const { service } = buildService({
      siteRepoMock: {
        // count retorna 1, mas 2 site_ids foram informados → divergência
        count: jest.fn().mockResolvedValue(1),
        findOne: jest.fn().mockResolvedValue({ id: SITE_ID }),
      },
    });

    await expect(
      service.create({
        nome: 'Funcionário',
        cpf: '09878058433',
        funcao: 'Eletricista',
        profile_id: PROFILE_ID,
        identity_type: UserIdentityType.EMPLOYEE_SIGNER,
        site_ids: [SITE_ID, 'site-de-outra-empresa'],
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('aceita cadastro quando site pertence à empresa do tenant', async () => {
    const { service } = buildService({
      siteRepoMock: { findOne: jest.fn().mockResolvedValue({ id: SITE_ID }) },
    });

    await expect(
      service.create({
        nome: 'Funcionário',
        cpf: '09878058433',
        funcao: 'Eletricista',
        profile_id: PROFILE_ID,
        identity_type: UserIdentityType.EMPLOYEE_SIGNER,
        site_id: SITE_ID,
      }),
    ).resolves.toBeDefined();
  });
});

describe('UsersService.create — CPF encryption', () => {
  it('armazena CPF como null + cpf_hash + cpf_ciphertext (nunca plaintext)', async () => {
    const { service, userRepo } = buildService({});

    await service.create({
      nome: 'Funcionário',
      cpf: '09878058433',
      funcao: 'Eletricista',
      profile_id: PROFILE_ID,
      identity_type: UserIdentityType.EMPLOYEE_SIGNER,
    });

    type CreatedUser = Partial<User> & {
      cpf_hash?: string | null;
      cpf_ciphertext?: string | null;
    };
    const cpfCalls = (userRepo.create as jest.Mock).mock.calls as [
      CreatedUser,
    ][];
    const created = cpfCalls[0][0];

    expect(created.cpf).toBeNull();
    expect(typeof created.cpf_hash).toBe('string');
    expect(created.cpf_hash).toHaveLength(64);
    expect(created.cpf_ciphertext).toMatch(/^enc:v1:/);
  });
});

describe('UsersService.create — unicidade de email', () => {
  it('lança ConflictException quando email já está em uso na mesma empresa', async () => {
    const { service, userRepo } = buildService({});
    // primeira chamada (CPF hash lookup) -> nenhum conflito
    // segunda chamada (email lookup) -> conflito
    (userRepo.findOne as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'existing-user' });

    await expect(
      service.create({
        nome: 'Funcionário Duplicado',
        cpf: '09878058433',
        email: 'duplicado@empresa.com',
        funcao: 'Técnico',
        profile_id: PROFILE_ID,
        identity_type: UserIdentityType.EMPLOYEE_SIGNER,
      }),
    ).rejects.toThrow('Email já está em uso nesta empresa.');
  });

  it('não lança erro quando email está vazio (campo opcional)', async () => {
    const { service } = buildService({});

    await expect(
      service.create({
        nome: 'Funcionário Sem Email',
        cpf: '09878058433',
        funcao: 'Operador',
        profile_id: PROFILE_ID,
        identity_type: UserIdentityType.EMPLOYEE_SIGNER,
      }),
    ).resolves.toBeDefined();
  });
});

describe('UsersService.create — mensagem CPF com neste sistema', () => {
  it('lança ConflictException com "neste sistema" quando CPF já existe', async () => {
    const { service, userRepo } = buildService({});
    (userRepo.findOne as jest.Mock).mockResolvedValueOnce({
      id: 'existing-user',
    });

    let caught: unknown;
    try {
      await service.create({
        nome: 'Funcionário Duplicado',
        cpf: '09878058433',
        funcao: 'Técnico',
        profile_id: PROFILE_ID,
        identity_type: UserIdentityType.EMPLOYEE_SIGNER,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ConflictException);
    const message = (caught as ConflictException).message;
    expect(message).toMatch(/neste sistema/i);
  });
});
