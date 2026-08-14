import { DeepPartial, Repository } from 'typeorm';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { UserSite } from './entities/user-site.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { PasswordService } from '../../shared/services/password.service';
import { PwnedPasswordService } from '../auth/services/pwned-password.service';
import { AuditService } from '../audit-trail/audit.service';
import { AuditAction } from '../audit-trail/enums/audit-action.enum';
import { Profile } from '../profiles/entities/profile.entity';
import { RequestContext } from '../../shared/middleware/request-context.middleware';
import { RbacService } from '../rbac/rbac.service';
import { AuthRedisService } from '../../shared/redis/redis.service';
import { AuthPrincipalService } from '../auth/auth-principal.service';
import { ConfigService } from '@nestjs/config';
import {
  UserAccessStatus,
  UserIdentityType,
} from './constants/user-identity.constant';

type AuditLogPersistencePayload = {
  userId?: string;
  action: AuditAction;
  entity: string;
  entityId: string;
  companyId?: string;
  changes?: {
    erasureCoverage?: Array<{
      tableName: string;
      affectedRows: number;
    }>;
  };
};

function expectEncryptedCpfPayload(
  payload: Pick<User, 'cpf'> & {
    cpf_hash?: string | null;
    cpf_ciphertext?: string | null;
  },
): void {
  expect(payload.cpf).toBeNull();
  expect(typeof payload.cpf_hash).toBe('string');
  expect(payload.cpf_hash).toHaveLength(64);
  expect(payload.cpf_ciphertext).toMatch(/^enc:v1:/);
}

function buildUserSitesRepositoryMock(): Repository<UserSite> {
  const repository = {
    delete: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue([]),
    create: jest.fn((input: unknown) => input),
    find: jest.fn().mockResolvedValue([]),
  };

  return {
    ...repository,
    manager: {
      transaction: jest.fn(
        <T>(cb: (manager: { getRepository: () => typeof repository }) => T) =>
          cb({ getRepository: () => repository }),
      ),
    },
  } as unknown as Repository<UserSite>;
}

describe('UsersService.gdprErasure', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;
  let profilesRepo: jest.Mocked<Repository<Profile>>;
  let updateMock: jest.Mock;
  let softDeleteMock: jest.Mock;
  let auditLogMock: jest.Mock;
  let auditRepoCreateMock: jest.Mock<
    AuditLogPersistencePayload,
    [AuditLogPersistencePayload]
  >;
  let auditRepoSaveMock: jest.Mock<
    Promise<Record<string, never>>,
    [AuditLogPersistencePayload]
  >;
  let tenantService: Partial<TenantService>;
  let passwordService: Partial<PasswordService>;
  let auditService: Partial<AuditService>;
  let rbacService: Partial<RbacService>;

  beforeEach(() => {
    updateMock = jest.fn();
    softDeleteMock = jest.fn();
    auditLogMock = jest.fn();
    auditRepoCreateMock = jest.fn<
      AuditLogPersistencePayload,
      [AuditLogPersistencePayload]
    >((d) => d);
    auditRepoSaveMock = jest
      .fn<Promise<Record<string, never>>, [AuditLogPersistencePayload]>()
      .mockResolvedValue({});
    const transactionManager = {
      query: jest.fn().mockResolvedValue([
        { table_name: 'ai_interactions', deleted_count: 1 },
        { table_name: 'user_consents', deleted_count: '2' },
      ]),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === User) {
          return {
            update: updateMock,
            softDelete: softDeleteMock,
          };
        }
        return {
          create: auditRepoCreateMock,
          save: auditRepoSaveMock,
        };
      }),
    };
    repo = {
      findOne: jest.fn(),
      update: updateMock,
      softDelete: softDeleteMock,
      softRemove: jest.fn().mockResolvedValue(undefined),
      manager: {
        transaction: jest.fn(
          <T>(cb: (manager: typeof transactionManager) => Promise<T> | T) =>
            cb(transactionManager),
        ),
      },
    } as unknown as jest.Mocked<Repository<User>>;
    profilesRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Profile>>;

    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
    };
    passwordService = {};
    auditService = {
      log: auditLogMock,
    };
    rbacService = {
      invalidateUserAccess: jest.fn(),
    };

    service = new UsersService(
      repo,
      buildUserSitesRepositoryMock(),
      profilesRepo,
      tenantService as TenantService,
      passwordService as PasswordService,
      {
        assertNotPwned: jest.fn().mockResolvedValue(undefined),
      } as unknown as PwnedPasswordService,
      auditService as AuditService,
      rbacService as RbacService,
      {
        getClient: jest.fn(),
      } as unknown as AuthRedisService,
      { get: jest.fn() } as unknown as ConfigService,
      { invalidateBridgeCache: jest.fn() } as unknown as AuthPrincipalService,
    );
  });

  it('anonimiza PII e faz soft delete', async () => {
    const user: User = {
      id: 'user-1',
      nome: 'Nome Original',
      cpf: '12345678900',
      email: 'user@example.com',
      funcao: 'Dev',
      status: true,
      company_id: 'company-1',
      profile_id: 'profile-1',
      site_id: 'site-1',
      created_at: new Date(),
      updated_at: new Date(),
    } as unknown as User;

    repo.findOne.mockResolvedValue(user);

    await service.gdprErasure(user.id);

    expect(updateMock).toHaveBeenCalledWith(user.id, {
      email: `deleted_${user.id}@anon.invalid`,
      nome: 'Usuário Removido',
      cpf: null,
      cpf_hash: null,
      cpf_ciphertext: null,
      funcao: null,
      status: false,
      deletedAt: expect.any(Date) as Date,
    });
    expect(softDeleteMock).toHaveBeenCalledWith(user.id);
    expect(auditRepoCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        action: AuditAction.GDPR_ERASURE,
        entity: 'USER',
        entityId: user.id,
        companyId: user.company_id,
      }),
    );
    expect(auditRepoCreateMock.mock.calls[0]?.[0].changes).toMatchObject({
      erasureCoverage: [
        { tableName: 'ai_interactions', affectedRows: 1 },
        { tableName: 'user_consents', affectedRows: 2 },
      ],
    });
    expect(auditRepoSaveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.GDPR_ERASURE,
        entity: 'USER',
        entityId: user.id,
      }),
    );
  });

  it('lança NotFound se usuário não existir', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.gdprErasure('missing')).rejects.toThrow(
      /Usuário com ID missing não encontrado/,
    );
  });
});

describe('UsersService.remove (soft delete)', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;
  let tenantService: Partial<TenantService>;
  let rbacService: Partial<RbacService>;
  let softRemoveMock: jest.Mock;
  let hardRemoveMock: jest.Mock;

  function buildService() {
    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
      isSuperAdmin: jest.fn().mockReturnValue(true),
    };
    rbacService = {
      invalidateUserAccess: jest.fn().mockResolvedValue(undefined),
    };
    softRemoveMock = jest.fn().mockResolvedValue(undefined);
    hardRemoveMock = jest.fn().mockResolvedValue(undefined);
    repo = {
      findOne: jest.fn(),
      softRemove: softRemoveMock,
      remove: hardRemoveMock,
      createQueryBuilder: jest.fn(),
    } as unknown as jest.Mocked<Repository<User>>;

    service = new UsersService(
      repo,
      buildUserSitesRepositoryMock(),
      {
        findOne: jest.fn(),
      } as unknown as jest.Mocked<Repository<Profile>>,
      tenantService as TenantService,
      {} as PasswordService,
      {
        assertNotPwned: jest.fn().mockResolvedValue(undefined),
      } as unknown as PwnedPasswordService,
      { log: jest.fn() } as unknown as AuditService,
      rbacService as RbacService,
      {
        getClient: jest.fn().mockReturnValue({
          scan: jest.fn().mockResolvedValue(['0', []]),
          del: jest.fn(),
        }),
      } as unknown as AuthRedisService,
      { get: jest.fn() } as unknown as ConfigService,
      { invalidateBridgeCache: jest.fn() } as unknown as AuthPrincipalService,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(RequestContext, 'getUserId').mockReturnValue('actor-1');
    buildService();
  });

  it('usa softRemove (não remove) para preservar histórico e evitar FK violations', async () => {
    const user = {
      id: 'user-1',
      nome: 'Colaborador',
      company_id: 'company-1',
      profile_id: 'profile-1',
      profile: { nome: 'colaborador' },
    } as unknown as User;

    repo.findOne.mockResolvedValue(user);

    await service.remove('user-1');

    expect(softRemoveMock).toHaveBeenCalledWith(user);
    expect(hardRemoveMock).not.toHaveBeenCalled();
    expect(rbacService.invalidateUserAccess).toHaveBeenCalledWith('user-1');
  });
});

describe('UsersService.exportMyData', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;
  let profilesRepo: jest.Mocked<Repository<Profile>>;
  let auditLogMock: jest.Mock;
  let tenantService: Partial<TenantService>;
  let passwordService: Partial<PasswordService>;
  let auditService: Partial<AuditService>;
  let rbacService: Partial<RbacService>;

  beforeEach(() => {
    auditLogMock = jest.fn();
    repo = {
      findOne: jest.fn(),
      manager: {
        query: jest.fn((sql: string) => {
          if (sql.includes('FROM user_consents')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([{ count: 0 }]);
        }),
      },
    } as unknown as jest.Mocked<Repository<User>>;
    profilesRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Profile>>;

    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
    };
    passwordService = {};
    auditService = {
      log: auditLogMock,
    };
    rbacService = {
      invalidateUserAccess: jest.fn(),
    };

    service = new UsersService(
      repo,
      buildUserSitesRepositoryMock(),
      profilesRepo,
      tenantService as TenantService,
      passwordService as PasswordService,
      {
        assertNotPwned: jest.fn().mockResolvedValue(undefined),
      } as unknown as PwnedPasswordService,
      auditService as AuditService,
      rbacService as RbacService,
      {
        getClient: jest.fn(),
      } as unknown as AuthRedisService,
      { get: jest.fn() } as unknown as ConfigService,
      { invalidateBridgeCache: jest.fn() } as unknown as AuthPrincipalService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reutiliza o mesmo exportedAt no audit log e na resposta tipada', async () => {
    const createdAt = new Date('2026-03-24T10:00:00.000Z');
    const updatedAt = new Date('2026-03-25T10:30:00.000Z');
    const user: User = {
      id: 'user-1',
      nome: 'Maria da Silva',
      cpf: '12345678900',
      email: 'maria@example.com',
      funcao: 'TST',
      status: true,
      ai_processing_consent: true,
      company_id: 'company-1',
      profile_id: 'profile-1',
      site_id: 'site-1',
      created_at: createdAt,
      updated_at: updatedAt,
      profile: {
        id: 'profile-1',
        nome: 'Administrador da Empresa',
      } as Profile,
      site: {
        id: 'site-1',
        nome: 'Matriz',
      } as User['site'],
    } as User;

    repo.findOne.mockResolvedValue(user);
    jest.spyOn(RequestContext, 'get').mockImplementation((key: string) => {
      if (key === 'ip') return '127.0.0.1';
      if (key === 'userAgent') return 'jest';
      return undefined;
    });

    const result = await service.exportMyData('user-1');

    expect(typeof result.exportedAt).toBe('string');
    expect(result.dataController).toBe('SGS — Sistema de Gestão de Segurança');
    expect(result.legalBasis).toBe(
      'LGPD Art. 20 — Portabilidade de dados pessoais',
    );
    expect(result.profile).toEqual({
      id: 'user-1',
      nome: 'Maria da Silva',
      cpf: '12345678900',
      email: 'maria@example.com',
      funcao: 'TST',
      status: true,
      ai_processing_consent: true,
      profile: {
        id: 'profile-1',
        nome: 'Administrador da Empresa',
      },
      site: {
        id: 'site-1',
        nome: 'Matriz',
      },
      company_id: 'company-1',
      created_at: createdAt.toISOString(),
      updated_at: updatedAt.toISOString(),
    });
    expect(result.consents).toEqual([]);
    expect(result.processingSummary.length).toBeGreaterThan(0);
    expect(result.processingSummary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          area: 'medical_exams',
          count: 0,
          sensitivity: 'sensivel_saude_ocupacional',
        }),
        expect.objectContaining({
          area: 'audit_and_security_logs',
          count: 0,
        }),
      ]),
    );
    expect(result.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: 'documentos_sst' }),
      ]),
    );

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: AuditAction.DATA_PORTABILITY,
        entity: 'USER',
        entityId: 'user-1',
        companyId: 'company-1',
        ip: '127.0.0.1',
        userAgent: 'jest',
        changes: {
          exportedAt: result.exportedAt,
        },
      }),
    );
  });
});

describe('UsersService.updateModuleAccess', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;
  let profilesRepo: jest.Mocked<Repository<Profile>>;
  let tenantService: Partial<TenantService>;
  let passwordService: Partial<PasswordService>;
  let auditService: Partial<AuditService>;
  let rbacService: Partial<RbacService>;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<User>>;
    profilesRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Profile>>;
    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
    };
    passwordService = {};
    auditService = {
      log: jest.fn(),
    };
    rbacService = {
      invalidateUserAccess: jest.fn(),
    };

    service = new UsersService(
      repo,
      buildUserSitesRepositoryMock(),
      profilesRepo,
      tenantService as TenantService,
      passwordService as PasswordService,
      {
        assertNotPwned: jest.fn().mockResolvedValue(undefined),
      } as unknown as PwnedPasswordService,
      auditService as AuditService,
      rbacService as RbacService,
      {
        getClient: jest.fn(),
      } as unknown as AuthRedisService,
      { get: jest.fn() } as unknown as ConfigService,
      { invalidateBridgeCache: jest.fn() } as unknown as AuthPrincipalService,
    );
  });

  it('salva módulos liberados e invalida caches do RBAC', async () => {
    const user = {
      id: 'user-1',
      nome: 'João',
      cpf: '12345678900',
      email: 'joao@example.com',
      funcao: 'TST',
      status: true,
      company_id: 'company-1',
      profile_id: 'profile-1',
      site_id: 'site-1',
      module_access_keys: [],
      created_at: new Date(),
      updated_at: new Date(),
    } as unknown as User;

    repo.findOne.mockResolvedValue(user);
    repo.save.mockImplementation((entity) => Promise.resolve(entity as User));

    const result = await service.updateModuleAccess('user-1', [
      'trainings',
      'trainings',
      'medical-exams',
    ]);

    const findOneCall = repo.findOne.mock.calls[0]?.[0] as
      Record<string, unknown> | undefined;
    const saveCall = repo.save.mock.calls[0]?.[0] as
      Record<string, unknown> | undefined;

    expect(findOneCall).toMatchObject({
      where: { id: 'user-1', company_id: 'company-1' },
      select: {
        module_access_keys: true,
      },
    });
    expect(saveCall).toMatchObject({
      module_access_keys: ['trainings', 'medical-exams'],
    });
    expect(rbacService.invalidateUserAccess).toHaveBeenCalledWith('user-1');
    expect(result.module_access_keys).toEqual(['trainings', 'medical-exams']);
  });
});

describe('UsersService.findPaginated', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;
  let profilesRepo: jest.Mocked<Repository<Profile>>;
  let tenantService: Partial<TenantService>;
  let passwordService: Partial<PasswordService>;
  let auditService: Partial<AuditService>;
  let rbacService: Partial<RbacService>;
  let qb: {
    leftJoinAndSelect: jest.Mock;
    addSelect: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    orderBy: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getManyAndCount: jest.Mock;
  };

  beforeEach(() => {
    qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    repo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as jest.Mocked<Repository<User>>;
    profilesRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Profile>>;

    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
      isSuperAdmin: jest.fn().mockReturnValue(false),
      getContext: jest.fn().mockReturnValue({
        companyId: 'company-1',
        isSuperAdmin: false,
        siteScope: 'single',
        siteId: 'site-contexto',
        siteIds: ['site-contexto'],
        userId: 'user-contexto',
      }),
    };
    passwordService = {};
    auditService = {
      log: jest.fn(),
    };
    rbacService = {
      invalidateUserAccess: jest.fn(),
    };

    service = new UsersService(
      repo,
      buildUserSitesRepositoryMock(),
      profilesRepo,
      tenantService as TenantService,
      passwordService as PasswordService,
      {
        assertNotPwned: jest.fn().mockResolvedValue(undefined),
      } as unknown as PwnedPasswordService,
      auditService as AuditService,
      rbacService as RbacService,
      {
        getClient: jest.fn(),
      } as unknown as AuthRedisService,
      { get: jest.fn() } as unknown as ConfigService,
      { invalidateBridgeCache: jest.fn() } as unknown as AuthPrincipalService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('aplica filtro rígido pela obra do contexto autenticado', async () => {
    jest.spyOn(RequestContext, 'getSiteId').mockReturnValue('site-1');
    qb.getManyAndCount.mockResolvedValue([
      [
        {
          id: 'user-1',
          nome: 'Ana',
          cpf: '12345678900',
          company_id: 'company-1',
          company: {
            id: 'company-1',
            razao_social: 'Empresa Teste',
            cnpj: 'nao-deve-sair-na-resposta',
          },
          site_id: 'site-1',
          site: {
            id: 'site-1',
            nome: 'Obra Teste',
            endereco: 'nao-deve-sair-na-resposta',
          },
        } as User,
      ],
      1,
    ]);

    const result = await service.findPaginated({
      page: 1,
      limit: 20,
    });

    const mockedRepo = repo as unknown as { createQueryBuilder: jest.Mock };
    const createQueryBuilderMock = mockedRepo.createQueryBuilder;
    expect(createQueryBuilderMock).toHaveBeenCalledWith('user');
    expect(qb.where).toHaveBeenCalledWith('user.deleted_at IS NULL');
    expect(qb.andWhere).toHaveBeenCalledWith('user.company_id = :tenantId', {
      tenantId: 'company-1',
    });
    // Regressão: a listagem paginada nunca deve retornar usuários soft-deletados
    // (anonimizados por erasure LGPD). createQueryBuilder não filtra deleted_at
    // automaticamente — o filtro precisa ser explícito.
    expect(qb.andWhere).toHaveBeenCalledWith('user.deleted_at IS NULL');
    expect(qb.leftJoinAndSelect).toHaveBeenCalledWith(
      'user.company',
      'company',
    );
    expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('user.site', 'site');
    expect(qb.andWhere).toHaveBeenCalledWith(
      '(user.site_id IN (:...scopeSiteIds) OR siteLinks.site_id IN (:...scopeSiteIds) OR user.id = :currentUserId)',
      {
        scopeSiteIds: ['site-contexto'],
        currentUserId: 'user-contexto',
      },
    );
    expect(result.total).toBe(1);
    expect(result.data[0]?.id).toBe('user-1');
    expect(result.data[0]?.company?.razao_social).toBe('Empresa Teste');
    expect(result.data[0]?.site?.nome).toBe('Obra Teste');
    expect(
      (result.data[0]?.company as unknown as { cnpj?: string })?.cnpj,
    ).toBeUndefined();
    expect(
      (result.data[0]?.site as unknown as { endereco?: string })?.endereco,
    ).toBeUndefined();
  });

  it('rejeita siteId informado pelo cliente fora da obra do contexto', async () => {
    jest.spyOn(RequestContext, 'getSiteId').mockReturnValue('site-contexto');

    await expect(
      service.findPaginated({
        page: 1,
        limit: 20,
        siteId: 'site-cliente',
      }),
    ).rejects.toThrow('Obra fora do escopo do usuário atual.');

    expect(qb.andWhere).not.toHaveBeenCalledWith(
      '(user.site_id = :siteId OR siteLinks.site_id = :siteId OR user.id = :currentUserId)',
      expect.anything(),
    );
  });

  it('não expõe usuários sem obra para usuário operacional site-scoped', async () => {
    await service.findPaginated({
      page: 1,
      limit: 20,
    });

    expect(qb.andWhere).toHaveBeenCalledWith(
      '(user.site_id IN (:...scopeSiteIds) OR siteLinks.site_id IN (:...scopeSiteIds) OR user.id = :currentUserId)',
      {
        scopeSiteIds: ['site-contexto'],
        currentUserId: 'user-contexto',
      },
    );
    const scopedClause = (qb.andWhere.mock.calls as Array<[unknown]>)
      .map(([clause]) => String(clause))
      .find((clause) => clause.includes('scopeSiteIds'));
    expect(scopedClause).not.toContain('user.site_id IS NULL');
  });

  it('permite admin empresa filtrar usuários pela obra escolhida no DID', async () => {
    (tenantService.getContext as jest.Mock).mockReturnValue({
      companyId: 'company-1',
      isSuperAdmin: false,
      siteScope: 'all',
      userId: 'admin-empresa-1',
    });
    jest.spyOn(RequestContext, 'get').mockImplementation((key: string) => {
      if (key === 'profileName') {
        return 'Administrador da Empresa';
      }
      return undefined;
    });
    jest.spyOn(RequestContext, 'getSiteId').mockReturnValue('site-do-tst');

    await service.findPaginated({
      page: 1,
      limit: 20,
      siteId: 'site-selecionado-no-did',
    });

    expect(qb.andWhere).toHaveBeenCalledWith(
      '(user.site_id = :siteId OR siteLinks.site_id = :siteId OR user.site_id IS NULL)',
      {
        siteId: 'site-selecionado-no-did',
      },
    );
  });

  it('usuario comum sem siteId no contexto recebe lista vazia sem ampliar escopo', async () => {
    (tenantService.getContext as jest.Mock).mockReturnValue({
      companyId: 'company-1',
      isSuperAdmin: false,
      siteScope: 'single',
      userId: 'user-contexto',
      siteIds: [],
    });
    jest.spyOn(RequestContext, 'getSiteId').mockReturnValue(undefined);

    const result = await service.findPaginated({
      page: 1,
      limit: 20,
    });

    expect(qb.andWhere).toHaveBeenCalledWith('1 = 0');
    expect(result.data).toEqual([]);
  });

  it('permite super-admin filtrar por obra escolhida', async () => {
    (tenantService.isSuperAdmin as jest.Mock).mockReturnValue(true);
    (tenantService.getContext as jest.Mock).mockReturnValue({
      companyId: 'company-1',
      isSuperAdmin: true,
      siteScope: 'all',
    });
    jest.spyOn(RequestContext, 'getSiteId').mockReturnValue(undefined);

    await service.findPaginated({
      page: 1,
      limit: 20,
      siteId: 'site-super',
    });

    expect(qb.andWhere).toHaveBeenCalledWith(
      '(user.site_id = :siteId OR siteLinks.site_id = :siteId OR user.site_id IS NULL)',
      {
        siteId: 'site-super',
      },
    );
  });

  it('aplica filtro semantico de identidade sem remover isolamento por tenant', async () => {
    await service.findPaginated({
      page: 1,
      limit: 20,
      identityType: UserIdentityType.EMPLOYEE_SIGNER,
      accessStatus: UserAccessStatus.NO_LOGIN,
    });

    // deleted_at IS NULL é agora o primeiro clause (.where); tenant vira andWhere.
    expect(qb.where).toHaveBeenCalledWith('user.deleted_at IS NULL');
    expect(qb.andWhere).toHaveBeenCalledWith('user.company_id = :tenantId', {
      tenantId: 'company-1',
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      'user.identity_type = :identityType',
      {
        identityType: UserIdentityType.EMPLOYEE_SIGNER,
      },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'user.access_status = :accessStatus',
      {
        accessStatus: UserAccessStatus.NO_LOGIN,
      },
    );
  });

  it('rejeita search malformado em vez de cair em 500', async () => {
    await expect(
      service.findPaginated({
        page: 1,
        limit: 20,
        search: ['forged'] as unknown as string,
      }),
    ).rejects.toThrow();
  });
});

describe('UsersService.create identity classification', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;
  let profilesRepo: jest.Mocked<Repository<Profile>>;
  let tenantService: Partial<TenantService>;
  let passwordService: Partial<PasswordService>;
  let auditService: Partial<AuditService>;
  let rbacService: Partial<RbacService>;
  let repoCreateMock: jest.Mock<User, [DeepPartial<User>]>;
  let repoSaveMock: jest.Mock<Promise<User>, [User]>;
  let passwordHashMock: jest.Mock<Promise<string>, [string]>;

  const baseCreatePayload = {
    nome: 'Bruno Operacional',
    cpf: '09878058433',
    funcao: 'Eletricista',
    profile_id: 'profile-1',
  };

  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_ENABLED = 'true';
    process.env.FIELD_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.FIELD_ENCRYPTION_HASH_KEY = 'users-service-test-hash-key';

    repoCreateMock = jest.fn((entity: DeepPartial<User>) => entity as User);
    repoSaveMock = jest.fn((entity: User) =>
      Promise.resolve({
        ...entity,
        created_at: new Date('2026-04-30T00:00:00.000Z'),
        updated_at: new Date('2026-04-30T00:00:00.000Z'),
      }),
    );
    passwordHashMock = jest
      .fn<Promise<string>, [string]>()
      .mockResolvedValue('hashed-password');
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: repoCreateMock,
      save: repoSaveMock,
      manager: {
        getRepository: jest.fn(),
      },
    } as unknown as jest.Mocked<Repository<User>>;
    profilesRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Profile>>;
    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
      isSuperAdmin: jest.fn().mockReturnValue(false),
    };
    passwordService = {
      hash: passwordHashMock,
      validate: jest.fn().mockReturnValue({ valid: true, errors: [] }),
    };
    auditService = {
      log: jest.fn(),
    };
    rbacService = {
      invalidateUserAccess: jest.fn(),
      getUserAccess: jest.fn().mockResolvedValue({ roles: [] }),
    };

    service = new UsersService(
      repo,
      buildUserSitesRepositoryMock(),
      profilesRepo,
      tenantService as TenantService,
      passwordService as PasswordService,
      {
        assertNotPwned: jest.fn().mockResolvedValue(undefined),
      } as unknown as PwnedPasswordService,
      auditService as AuditService,
      rbacService as RbacService,
      {
        getClient: jest.fn(),
      } as unknown as AuthRedisService,
      { get: jest.fn() } as unknown as ConfigService,
      { invalidateBridgeCache: jest.fn() } as unknown as AuthPrincipalService,
    );
  });

  it('classifica funcionario/signatario sem login como no_login', async () => {
    const result = await service.create({
      ...baseCreatePayload,
      identity_type: UserIdentityType.EMPLOYEE_SIGNER,
    });

    const createPayload = repoCreateMock.mock.calls[0]?.[0];
    expect(createPayload).toMatchObject({
      company_id: 'company-1',
      identity_type: UserIdentityType.EMPLOYEE_SIGNER,
      access_status: UserAccessStatus.NO_LOGIN,
      password: undefined,
    });
    expectEncryptedCpfPayload(createPayload as User);
    expect(result.identity_type).toBe(UserIdentityType.EMPLOYEE_SIGNER);
    expect(result.access_status).toBe(UserAccessStatus.NO_LOGIN);
  });

  it('classifica usuario do sistema com senha como credentialed', async () => {
    const result = await service.create({
      ...baseCreatePayload,
      email: 'bruno@example.com',
      password: 'secret123',
      identity_type: UserIdentityType.SYSTEM_USER,
    });

    expect(passwordHashMock).toHaveBeenCalledWith('secret123');
    const createPayload = repoCreateMock.mock.calls[0]?.[0];
    expect(createPayload).toMatchObject({
      identity_type: UserIdentityType.SYSTEM_USER,
      access_status: UserAccessStatus.CREDENTIALED,
      password: 'hashed-password',
    });
    expectEncryptedCpfPayload(createPayload as User);
    expect(result.identity_type).toBe(UserIdentityType.SYSTEM_USER);
    expect(result.access_status).toBe(UserAccessStatus.CREDENTIALED);
  });

  it('bloqueia funcionario/signatario sem login com credenciais', async () => {
    await expect(
      service.create({
        ...baseCreatePayload,
        password: 'secret123',
        identity_type: UserIdentityType.EMPLOYEE_SIGNER,
      }),
    ).rejects.toThrow('sem login não pode manter credenciais');

    expect(repoSaveMock).not.toHaveBeenCalled();
  });
});

describe('UsersService.create role assignment hardening', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;
  let profilesRepo: jest.Mocked<Repository<Profile>>;
  let tenantService: Partial<TenantService>;
  let passwordService: Partial<PasswordService>;
  let auditService: Partial<AuditService>;
  let rbacService: Partial<RbacService>;
  let repoCreateMock: jest.Mock<User, [DeepPartial<User>]>;
  let repoSaveMock: jest.Mock<Promise<User>, [User]>;

  const resolveScope = (roleName?: string | null) => {
    const normalized = String(roleName || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase();

    const aliases: Record<string, string> = {
      'ADMINISTRADOR GERAL': 'SUPER_ADMIN',
      SUPER_ADMIN: 'SUPER_ADMIN',
      ADMIN_GERAL: 'SUPER_ADMIN',
      'ADMINISTRADOR DA EMPRESA': 'ADMIN_EMPRESA',
      ADMIN_EMPRESA: 'ADMIN_EMPRESA',
      GERENTE: 'GERENTE',
      'SUPERVISOR / ENCARREGADO': 'SUPERVISOR',
      SUPERVISOR: 'SUPERVISOR',
      'TECNICO DE SEGURANCA DO TRABALHO (TST)': 'TECNICO',
      'TECNICO DE SEGURANCA DO TRABALHO': 'TECNICO',
      TECNICO: 'TECNICO',
      'TECNICO SST': 'TECNICO',
      VISUALIZADOR: 'VISUALIZADOR',
      TRABALHADOR: 'VISUALIZADOR',
      COLABORADOR: 'VISUALIZADOR',
      'OPERADOR / COLABORADOR': 'VISUALIZADOR',
    };

    return aliases[normalized] || null;
  };

  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_ENABLED = 'true';
    process.env.FIELD_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.FIELD_ENCRYPTION_HASH_KEY = 'users-service-test-hash-key';

    repoCreateMock = jest.fn((entity: DeepPartial<User>) => entity as User);
    repoSaveMock = jest.fn((entity: User) =>
      Promise.resolve({
        ...entity,
        created_at: new Date('2026-04-30T00:00:00.000Z'),
        updated_at: new Date('2026-04-30T00:00:00.000Z'),
      }),
    );

    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: repoCreateMock,
      save: repoSaveMock,
      manager: {
        getRepository: jest.fn(),
      },
    } as unknown as jest.Mocked<Repository<User>>;

    profilesRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Profile>>;

    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
      isSuperAdmin: jest.fn().mockReturnValue(false),
    };

    passwordService = {
      hash: jest.fn().mockResolvedValue('hashed-password'),
      validate: jest.fn().mockReturnValue({ valid: true, errors: [] }),
    };

    auditService = {
      log: jest.fn(),
    };

    rbacService = {
      invalidateUserAccess: jest.fn(),
      getUserAccess: jest.fn().mockResolvedValue({
        roles: ['GERENTE'],
        permissions: ['can_manage_users'],
      }),
      getEffectiveRoleScope: jest.fn((roles: string[]) => {
        for (const role of roles) {
          const resolved = resolveScope(role);
          if (resolved) {
            return resolved;
          }
        }
        return null;
      }),
      getRoleScope: jest.fn((roleName?: string | null) =>
        resolveScope(roleName),
      ),
    } as Partial<RbacService>;

    service = new UsersService(
      repo,
      buildUserSitesRepositoryMock(),
      profilesRepo,
      tenantService as TenantService,
      passwordService as PasswordService,
      {
        assertNotPwned: jest.fn().mockResolvedValue(undefined),
      } as unknown as PwnedPasswordService,
      auditService as AuditService,
      rbacService as RbacService,
      {
        getClient: jest.fn(),
      } as unknown as AuthRedisService,
      { get: jest.fn() } as unknown as ConfigService,
      { invalidateBridgeCache: jest.fn() } as unknown as AuthPrincipalService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('bloqueia GERENTE atribuindo Administrador da Empresa', async () => {
    profilesRepo.findOne.mockResolvedValue({
      id: 'profile-admin-empresa',
      nome: 'Administrador da Empresa',
    } as Profile);
    jest.spyOn(RequestContext, 'getUserId').mockReturnValue('actor-gerente');

    await expect(
      service.create({
        nome: 'Novo Admin Empresa',
        cpf: '09878058433',
        funcao: 'Coordenador',
        profile_id: 'profile-admin-empresa',
      }),
    ).rejects.toThrow(
      'Gerente não pode atribuir o perfil "Administrador da Empresa".',
    );

    expect(repoSaveMock).not.toHaveBeenCalled();
  });

  it('bloqueia Tecnico atribuindo Supervisor por comparação de escopo', async () => {
    profilesRepo.findOne.mockResolvedValue({
      id: 'profile-supervisor',
      nome: 'Supervisor / Encarregado',
    } as Profile);
    (
      rbacService.getUserAccess as jest.MockedFunction<
        NonNullable<Partial<RbacService>['getUserAccess']>
      >
    ).mockResolvedValue({
      roles: ['Técnico'],
      permissions: ['can_manage_users'],
    });
    jest.spyOn(RequestContext, 'getUserId').mockReturnValue('actor-tecnico');

    await expect(
      service.create({
        nome: 'Novo Supervisor',
        cpf: '17146619802',
        funcao: 'Lider',
        profile_id: 'profile-supervisor',
      }),
    ).rejects.toThrow(
      'Técnico não pode atribuir o perfil "Supervisor / Encarregado".',
    );

    expect(repoSaveMock).not.toHaveBeenCalled();
  });

  it('falha fechado quando o escopo RBAC do perfil alvo não é resolvido', async () => {
    profilesRepo.findOne.mockResolvedValue({
      id: 'profile-local',
      nome: 'Perfil Local Desconhecido',
    } as Profile);
    jest.spyOn(RequestContext, 'getUserId').mockReturnValue('actor-gerente');

    await expect(
      service.create({
        nome: 'Novo Usuario',
        cpf: '98803972075',
        funcao: 'Operador',
        profile_id: 'profile-local',
      }),
    ).rejects.toThrow('escopo RBAC não foi resolvido');

    expect(repoSaveMock).not.toHaveBeenCalled();
  });
});

describe('UsersService.update site binding', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;
  let profilesRepo: jest.Mocked<Repository<Profile>>;
  let tenantService: Partial<TenantService>;
  let passwordService: Partial<PasswordService>;
  let auditService: Partial<AuditService>;
  let rbacService: Partial<RbacService>;
  let siteFindOneMock: jest.Mock;

  beforeEach(() => {
    siteFindOneMock = jest.fn();
    repo = {
      findOne: jest.fn(),
      save: jest.fn(),
      manager: {
        getRepository: jest.fn().mockReturnValue({
          findOne: siteFindOneMock,
        }),
      },
    } as unknown as jest.Mocked<Repository<User>>;
    profilesRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Profile>>;
    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
      isSuperAdmin: jest.fn().mockReturnValue(false),
    };
    passwordService = {
      hash: jest.fn(),
      validate: jest.fn().mockReturnValue({ valid: true, errors: [] }),
    };
    auditService = {
      log: jest.fn(),
    };
    rbacService = {
      invalidateUserAccess: jest.fn(),
    };

    service = new UsersService(
      repo,
      buildUserSitesRepositoryMock(),
      profilesRepo,
      tenantService as TenantService,
      passwordService as PasswordService,
      {
        assertNotPwned: jest.fn().mockResolvedValue(undefined),
      } as unknown as PwnedPasswordService,
      auditService as AuditService,
      rbacService as RbacService,
      {
        getClient: jest.fn(),
      } as unknown as AuthRedisService,
      { get: jest.fn() } as unknown as ConfigService,
      { invalidateBridgeCache: jest.fn() } as unknown as AuthPrincipalService,
    );
  });

  it('bloqueia salvar obra de outra empresa no cadastro do funcionario', async () => {
    repo.findOne.mockResolvedValue({
      id: 'user-1',
      nome: 'Bruno',
      cpf: '09878058433',
      email: null,
      funcao: 'Eletricista',
      status: true,
      company_id: 'company-1',
      site_id: null,
      profile_id: 'profile-1',
      created_at: new Date(),
      updated_at: new Date(),
    } as unknown as User);
    siteFindOneMock.mockResolvedValue(null);

    await expect(
      service.update('user-1', { site_id: 'site-de-outra-empresa' }),
    ).rejects.toThrow('A obra/setor informada não pertence à empresa');

    expect(repo.save.mock.calls).toHaveLength(0);
    expect(siteFindOneMock).toHaveBeenCalledWith({
      where: { id: 'site-de-outra-empresa', company_id: 'company-1' },
      select: ['id'],
    });
  });

  it('salva site_id quando a obra pertence a empresa do funcionario', async () => {
    const user = {
      id: 'user-1',
      nome: 'Bruno',
      cpf: '09878058433',
      email: null,
      funcao: 'Eletricista',
      status: true,
      company_id: 'company-1',
      site_id: null,
      profile_id: 'profile-1',
      created_at: new Date(),
      updated_at: new Date(),
    } as unknown as User;
    repo.findOne.mockResolvedValue(user);
    siteFindOneMock.mockResolvedValue({ id: 'site-1' });
    repo.save.mockImplementation((entity) => Promise.resolve(entity as User));

    const result = await service.update('user-1', { site_id: 'site-1' });

    expect(repo.save.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: 'user-1', site_id: 'site-1' }),
    );
    expect(result.site_id).toBe('site-1');
  });

  it('atualiza CPF sem persistir plaintext (cpf=null + ciphertext/hash)', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const saveMock = repo.save as unknown as jest.Mock<Promise<User>, [User]>;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const findOneMock = repo.findOne as jest.MockedFunction<
      Repository<User>['findOne']
    >;
    const userId = 'user-1';
    const existingUser = {
      id: userId,
      nome: 'Bruno',
      cpf: null,
      cpf_hash: null,
      cpf_ciphertext: null,
      email: null,
      funcao: 'Eletricista',
      status: true,
      company_id: 'company-1',
      site_id: null,
      profile_id: 'profile-1',
      auth_user_id: null,
      identity_type: UserIdentityType.SYSTEM_USER,
      access_status: UserAccessStatus.CREDENTIALED,
      module_access_keys: [],
      password: null,
      created_at: new Date(),
      updated_at: new Date(),
    } as unknown as User;

    // 1) carrega user original; 2) checa duplicidade por CPF -> nenhum dono.
    findOneMock.mockResolvedValueOnce(existingUser).mockResolvedValueOnce(null);
    saveMock.mockImplementation((entity: User) =>
      Promise.resolve({
        ...entity,
        updated_at: new Date('2026-05-01T00:00:00.000Z'),
      }),
    );

    process.env.FIELD_ENCRYPTION_ENABLED = 'true';
    process.env.FIELD_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.FIELD_ENCRYPTION_HASH_KEY = 'users-service-test-hash-key';

    const result = await service.update(userId, {
      cpf: '098.780.584-33',
    });

    expect(saveMock).toHaveBeenCalled();
    const savedUser = saveMock.mock.calls[0]?.[0];
    expect(savedUser).toBeDefined();
    expectEncryptedCpfPayload(savedUser);
    expect((result as unknown as Record<string, unknown>).cpf).toBeUndefined(); // LGPD: CPF removido do UserResponseDto
  });
});

describe('UsersService.findAuthSessionUser', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;
  let profilesRepo: jest.Mocked<Repository<Profile>>;
  let tenantService: Partial<TenantService>;
  let passwordService: Partial<PasswordService>;
  let auditService: Partial<AuditService>;
  let rbacService: Partial<RbacService>;
  let repoFindOneMock: jest.Mock;

  beforeEach(() => {
    repoFindOneMock = jest.fn();
    repo = {
      findOne: repoFindOneMock,
    } as unknown as jest.Mocked<Repository<User>>;
    profilesRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Profile>>;
    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
    };
    passwordService = {};
    auditService = {
      log: jest.fn(),
    };
    rbacService = {
      invalidateUserAccess: jest.fn(),
    };

    service = new UsersService(
      repo,
      buildUserSitesRepositoryMock(),
      profilesRepo,
      tenantService as TenantService,
      passwordService as PasswordService,
      {
        assertNotPwned: jest.fn().mockResolvedValue(undefined),
      } as unknown as PwnedPasswordService,
      auditService as AuditService,
      rbacService as RbacService,
      {
        getClient: jest.fn(),
      } as unknown as AuthRedisService,
      { get: jest.fn() } as unknown as ConfigService,
      { invalidateBridgeCache: jest.fn() } as unknown as AuthPrincipalService,
    );
  });

  it('carrega dados leves de sessão sem join de company', async () => {
    repoFindOneMock.mockResolvedValue({
      id: 'user-1',
      nome: 'Usuário Sessão',
      cpf: '12345678900',
      email: 'sessao@example.com',
      funcao: 'TST',
      company_id: 'company-1',
      site_id: 'site-1',
      profile_id: 'profile-1',
      status: true,
      created_at: new Date('2026-03-28T00:00:00.000Z'),
      updated_at: new Date('2026-03-28T01:00:00.000Z'),
      profile: {
        id: 'profile-1',
        nome: 'Administrador da Empresa',
        permissoes: ['can_view_dashboard'],
        status: true,
        created_at: new Date('2026-03-28T00:00:00.000Z'),
        updated_at: new Date('2026-03-28T01:00:00.000Z'),
      } as Profile,
    });

    const result = await service.findAuthSessionUser('user-1');
    expect(result.id).toBe('user-1');
    expect(result.company_id).toBe('company-1');
    expect(result.profile?.id).toBe('profile-1');
    expect(result.profile?.nome).toBe('Administrador da Empresa');

    expect(repoFindOneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1', company_id: 'company-1' },
        relations: { profile: true },
      }),
    );
  });
});
