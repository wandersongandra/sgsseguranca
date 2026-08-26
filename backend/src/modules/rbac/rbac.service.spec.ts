import { Repository } from 'typeorm';
import { PROFILE_PERMISSION_FALLBACK, RbacService } from './rbac.service';
import { User } from '../users/entities/user.entity';
import { PermissionEntity } from './entities/permission.entity';
import { RolePermissionEntity } from './entities/role-permission.entity';
import { UserRoleEntity } from './entities/user-role.entity';
import { RedisService } from '../../shared/redis/redis.service';

type RedisClientMock = {
  get: jest.Mock;
  setex: jest.Mock;
  del: jest.Mock;
};

describe('RbacService cache curto', () => {
  let service: RbacService;
  let userRolesRepository: jest.Mocked<Repository<UserRoleEntity>>;
  let rolePermissionsRepository: jest.Mocked<Repository<RolePermissionEntity>>;
  let permissionsRepository: jest.Mocked<Repository<PermissionEntity>>;
  let usersRepository: jest.Mocked<Repository<User>>;
  let redisService: Pick<RedisService, 'getClient'>;
  let redisClient: RedisClientMock;
  let userRolesQueryMock: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
  let usersFindMock: jest.Mock<Promise<User[]>, [unknown?]>;
  let usersQueryMock: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
  let redisGetMock: jest.Mock;
  let redisSetexMock: jest.Mock;
  let redisDelMock: jest.Mock;

  beforeEach(() => {
    delete process.env.RBAC_ACCESS_CACHE_TTL_SECONDS;
    delete process.env.RBAC_ACCESS_LOCAL_CACHE_TTL_SECONDS;

    userRolesQueryMock = jest.fn<Promise<unknown[]>, [string, unknown[]?]>();
    usersFindMock = jest.fn<Promise<User[]>, [unknown?]>();
    usersQueryMock = jest.fn<Promise<unknown[]>, [string, unknown[]?]>();

    userRolesRepository = {
      query: userRolesQueryMock,
    } as unknown as jest.Mocked<Repository<UserRoleEntity>>;
    rolePermissionsRepository = {} as unknown as jest.Mocked<
      Repository<RolePermissionEntity>
    >;
    permissionsRepository = {
      find: jest.fn(),
    } as unknown as jest.Mocked<Repository<PermissionEntity>>;
    usersRepository = {
      find: usersFindMock,
      query: usersQueryMock,
    } as unknown as jest.Mocked<Repository<User>>;

    redisGetMock = jest.fn<Promise<string | null>, [string]>();
    redisSetexMock = jest.fn<Promise<string>, [string, number, string]>();
    redisDelMock = jest.fn<Promise<number>, [string, ...string[]]>();
    redisClient = {
      get: redisGetMock,
      setex: redisSetexMock,
      del: redisDelMock,
    };

    redisService = {
      getClient: jest.fn(() => redisClient as never),
    };

    service = new RbacService(
      userRolesRepository,
      rolePermissionsRepository,
      permissionsRepository,
      usersRepository,
      redisService as RedisService,
    );
  });

  it('reusa bundle de acesso do Redis quando disponível', async () => {
    redisGetMock.mockResolvedValue(
      JSON.stringify({
        roles: ['Administrador da Empresa'],
        permissions: ['can_view_dashboard'],
      }),
    );

    const result = await service.getUserAccess('user-1');

    expect(result).toEqual({
      roles: ['Administrador da Empresa'],
      permissions: ['can_view_dashboard'],
    });
    expect(userRolesQueryMock).not.toHaveBeenCalled();
  });

  it('calcula e persiste bundle quando cache está vazio', async () => {
    redisGetMock.mockResolvedValue(null);
    redisSetexMock.mockResolvedValue('OK');
    userRolesQueryMock.mockResolvedValue([
      {
        role_names: ['Administrador Geral'],
        permission_names: ['can_view_dashboard'],
      },
    ]);

    const result = await service.getUserAccess('user-1');

    expect(result.roles).toEqual(['Administrador Geral']);
    expect(result.permissions).toEqual(
      expect.arrayContaining([
        'can_view_dashboard',
        'can_view_dids',
        'can_manage_dids',
      ]),
    );
    expect(redisSetexMock.mock.calls[0]).toEqual([
      'rbac:access:user-1',
      120,
      JSON.stringify(result),
    ]);

    redisGetMock.mockClear();
    userRolesQueryMock.mockClear();

    const reused = await service.getUserAccess('user-1');

    expect(reused).toEqual(result);
    expect(redisGetMock).not.toHaveBeenCalled();
    expect(userRolesQueryMock).not.toHaveBeenCalled();
  });

  it('prioriza banco e usa hint de profile apenas como último fallback', async () => {
    redisGetMock.mockResolvedValue(null);
    redisSetexMock.mockResolvedValue('OK');
    userRolesQueryMock.mockResolvedValue([]);
    usersQueryMock.mockResolvedValue([]);

    const result = await service.getUserAccess('user-1', {
      profileName: 'Administrador Geral',
    });

    expect(result.roles).toEqual(['Administrador Geral']);
    expect(result.permissions).toEqual(
      expect.arrayContaining(['can_view_dashboard', 'can_manage_users']),
    );
    expect(result.permissions).not.toContain('can_view_system_health');
    expect(userRolesQueryMock).toHaveBeenCalledTimes(1);
    expect(usersQueryMock).toHaveBeenCalledTimes(2);
    expect(redisSetexMock).toHaveBeenCalledWith(
      'rbac:access:user-1',
      120,
      JSON.stringify(result),
    );
  });

  it('ignora hint do token quando RBAC normalizado já resolve acesso no banco', async () => {
    redisGetMock.mockResolvedValue(null);
    redisSetexMock.mockResolvedValue('OK');
    userRolesQueryMock.mockResolvedValue([
      {
        role_names: ['Supervisor / Encarregado'],
        permission_names: ['can_view_dashboard'],
      },
    ]);

    const result = await service.getUserAccess('user-claim-vs-db', {
      profileName: 'Administrador Geral',
    });

    expect(result.roles).toEqual(['Supervisor / Encarregado']);
    expect(result.permissions).not.toContain('can_view_system_health');
    expect(usersQueryMock).toHaveBeenCalledTimes(1);
  });

  it('remove permissões globais quando o papel normalizado não é Admin Geral', async () => {
    redisGetMock.mockResolvedValue(null);
    redisSetexMock.mockResolvedValue('OK');
    userRolesQueryMock.mockResolvedValue([
      {
        role_names: ['Administrador da Empresa'],
        permission_names: [
          'can_manage_users',
          'can_manage_companies',
          'can_manage_profiles',
          'can_view_system_health',
          'can_manage_disaster_recovery',
        ],
      },
    ]);

    const result = await service.getUserAccess(
      'company-admin-with-legacy-rbac',
    );

    expect(result.permissions).toContain('can_manage_users');
    expect(result.permissions).not.toContain('can_manage_companies');
    expect(result.permissions).not.toContain('can_manage_profiles');
    expect(result.permissions).not.toContain('can_view_system_health');
    expect(result.permissions).not.toContain('can_manage_disaster_recovery');
  });

  it('mescla permissões fallback do papel quando a consulta normalizada não devolve permissões novas', async () => {
    redisGetMock.mockResolvedValue(null);
    redisSetexMock.mockResolvedValue('OK');
    userRolesQueryMock.mockResolvedValue([
      {
        role_names: ['Supervisor / Encarregado'],
        permission_names: ['can_view_dashboard'],
      },
    ]);

    const result = await service.getUserAccess('user-2');

    expect(result.roles).toEqual(['Supervisor / Encarregado']);
    expect(result.permissions).toEqual(
      expect.arrayContaining([
        'can_view_dashboard',
        'can_view_dids',
        'can_manage_dids',
      ]),
    );
  });

  it('mescla módulos liberados por usuário nas permissions efetivas', async () => {
    redisGetMock.mockResolvedValue(null);
    redisSetexMock.mockResolvedValue('OK');
    userRolesQueryMock.mockResolvedValue([
      {
        role_names: ['Trabalhador'],
        permission_names: [],
      },
    ]);
    usersQueryMock.mockResolvedValue([
      {
        module_access_keys: ['trainings'],
      },
    ]);

    const result = await service.getUserAccess('worker-with-extra-module');

    expect(result.roles).toEqual(['Trabalhador']);
    expect(result.permissions).toContain('can_view_trainings');
    expect(result.permissions).not.toContain('can_manage_trainings');
  });

  it('faz fallback para o profile quando o usuário não possui roles RBAC', async () => {
    redisGetMock.mockResolvedValue(null);
    redisSetexMock.mockResolvedValue('OK');
    userRolesQueryMock.mockResolvedValue([
      {
        role_names: [],
        permission_names: [],
      },
    ]);
    usersQueryMock.mockResolvedValue([
      {
        profile_name: 'Trabalhador',
        profile_permissions: ['custom_permission'],
      },
    ]);

    const result = await service.getUserAccess('user-fallback');

    expect(result.roles).toEqual(['Trabalhador']);
    expect(result.permissions).toContain('can_view_dashboard');
    expect(result.permissions).not.toContain('custom_permission');
    expect(usersQueryMock).toHaveBeenCalledTimes(2);
  });

  it('remove permissões globais vindas de profile legado tenant-scoped', async () => {
    redisGetMock.mockResolvedValue(null);
    redisSetexMock.mockResolvedValue('OK');
    userRolesQueryMock.mockResolvedValue([
      {
        role_names: [],
        permission_names: [],
      },
    ]);
    usersQueryMock.mockResolvedValue([
      {
        profile_name: 'Técnico de Segurança do Trabalho (TST)',
        profile_permissions: [
          'can_manage_users',
          'can_manage_companies',
          'can_manage_profiles',
          'can_view_system_health',
        ],
      },
    ]);

    const result = await service.getUserAccess('legacy-tst-profile');

    expect(result.permissions).toContain('can_manage_users');
    expect(result.permissions).not.toContain('can_manage_companies');
    expect(result.permissions).not.toContain('can_manage_profiles');
    expect(result.permissions).not.toContain('can_view_system_health');
  });

  it('invalida cache de um usuário específico', async () => {
    redisDelMock.mockResolvedValue(1);

    await service.invalidateUserAccess('user-123');

    expect(redisDelMock.mock.calls[0]).toEqual(['rbac:access:user-123']);
  });

  it('sincroniza user_roles pelo nome canonico do profile', async () => {
    userRolesQueryMock.mockResolvedValue([]);
    redisDelMock.mockResolvedValue(1);

    await service.syncUserRoleFromProfileName('user-admin', 'ADMIN_GERAL');

    expect(userRolesQueryMock.mock.calls[0]?.[1]).toEqual([
      'user-admin',
      'Administrador Geral',
    ]);
    expect(redisDelMock.mock.calls[0]).toEqual(['rbac:access:user-admin']);
  });

  it('normaliza aliases de profile ao sincronizar user_roles', async () => {
    userRolesQueryMock.mockResolvedValue([]);
    redisDelMock.mockResolvedValue(1);

    await service.syncUserRoleFromProfileName('user-tst', 'Técnico');

    expect(userRolesQueryMock.mock.calls[0]?.[1]).toEqual([
      'user-tst',
      'Técnico de Segurança do Trabalho (TST)',
    ]);
  });

  it('preserva GERENTE na sincronização para não rebaixar escopo para supervisor', async () => {
    userRolesQueryMock.mockResolvedValue([]);
    redisDelMock.mockResolvedValue(1);

    await service.syncUserRoleFromProfileName('user-gerente', 'GERENTE');

    expect(userRolesQueryMock.mock.calls[0]?.[1]).toEqual([
      'user-gerente',
      'GERENTE',
    ]);
  });

  it('invalida cache dos usuários de um profile', async () => {
    usersFindMock.mockResolvedValue([
      { id: 'user-a' } as User,
      { id: 'user-b' } as User,
    ]);
    redisDelMock.mockResolvedValue(2);

    const count = await service.invalidateUsersByProfileId('profile-1');

    expect(count).toBe(2);
    expect(usersFindMock.mock.calls[0]).toEqual([
      {
        where: { profile_id: 'profile-1' },
        select: { id: true },
      },
    ]);
    expect(redisDelMock.mock.calls[0]).toEqual([
      'rbac:access:user-a',
      'rbac:access:user-b',
    ]);
  });

  it('deduplica lookups concorrentes do mesmo usuário', async () => {
    redisGetMock.mockResolvedValue(null);
    redisSetexMock.mockResolvedValue('OK');

    let resolveLookup: ((value: unknown[]) => void) | undefined;
    userRolesQueryMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );

    const firstPromise = service.getUserAccess('user-race');
    const secondPromise = service.getUserAccess('user-race');

    await Promise.resolve();
    await Promise.resolve();
    resolveLookup?.([
      {
        role_names: ['Administrador Geral'],
        permission_names: ['can_view_dashboard'],
      },
    ]);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first).toEqual(second);
    expect(userRolesQueryMock).toHaveBeenCalledTimes(1);
  });

  it('expõe o escopo efetivo coerente para aliases do produto', () => {
    expect(service.getRoleScope('ADMIN_GERAL')).toBe('ADMIN_EMPRESA');
    expect(service.getRoleScope('SUPER_ADMIN')).toBe('SUPER_ADMIN');
    expect(service.getRoleScope('GERENTE')).toBe('GERENTE');
    expect(service.getRoleScope('Técnico')).toBe('TECNICO');
    expect(service.getRoleScope('VISUALIZADOR')).toBe('VISUALIZADOR');
    expect(service.getEffectiveRoleScope(['GERENTE', 'Trabalhador'])).toBe(
      'GERENTE',
    );
  });
});

describe('PROFILE_PERMISSION_FALLBACK', () => {
  it('mantém TST com acesso operacional sem fechar despesas', () => {
    const adminEmpresaPermissions = new Set(
      PROFILE_PERMISSION_FALLBACK['Administrador da Empresa'] || [],
    );
    const tstPermissions = new Set(
      PROFILE_PERMISSION_FALLBACK['Técnico de Segurança do Trabalho (TST)'] ||
        [],
    );

    const adminWithoutExpenseClose = new Set(adminEmpresaPermissions);
    adminWithoutExpenseClose.delete('can_close_expenses');
    expect(tstPermissions).not.toEqual(adminWithoutExpenseClose);
    expect(tstPermissions.has('can_view_companies')).toBe(false);
    expect(tstPermissions.has('can_view_profiles')).toBe(false);
    expect(tstPermissions.has('can_manage_users')).toBe(true);
    expect(tstPermissions.has('can_view_users')).toBe(true);
    expect(tstPermissions.has('can_view_expenses')).toBe(true);
    expect(tstPermissions.has('can_manage_expenses')).toBe(true);
    expect(tstPermissions.has('can_close_expenses')).toBe(false);
    expect(tstPermissions.has('can_manage_companies')).toBe(false);
    expect(tstPermissions.has('can_manage_profiles')).toBe(false);
    expect(tstPermissions.has('can_view_system_health')).toBe(false);
  });

  it('permite ao TST aprovar/reprovar/encerrar APR (paridade com PT e com a migration 332)', () => {
    const tstPermissions = new Set(
      PROFILE_PERMISSION_FALLBACK['Técnico de Segurança do Trabalho (TST)'] ||
        [],
    );

    // O banco (migration split-apr-critical-permissions) concede estas ao TST;
    // o allowlist de escopo precisa refletir para não filtrá-las em runtime.
    expect(tstPermissions.has('can_approve_apr')).toBe(true);
    expect(tstPermissions.has('can_reject_apr')).toBe(true);
    expect(tstPermissions.has('can_finalize_apr')).toBe(true);
    // Paridade com o fluxo de PT (que já funcionava).
    expect(tstPermissions.has('can_approve_pt')).toBe(true);
  });

  it('mantém aliases legados de TST com acesso operacional de cadastro', () => {
    const tecnicoPermissions = new Set(
      PROFILE_PERMISSION_FALLBACK['Técnico'] || [],
    );

    expect(tecnicoPermissions.has('can_view_users')).toBe(true);
    expect(tecnicoPermissions.has('can_manage_users')).toBe(true);
    expect(tecnicoPermissions.has('can_view_sites')).toBe(true);
    expect(tecnicoPermissions.has('can_manage_sites')).toBe(false);
    expect(tecnicoPermissions.has('can_manage_companies')).toBe(false);
  });

  it('mantém Supervisor com acesso operacional sem fechar despesas', () => {
    const adminEmpresaPermissions = new Set(
      PROFILE_PERMISSION_FALLBACK['Administrador da Empresa'] || [],
    );
    const supervisorPermissions = new Set(
      PROFILE_PERMISSION_FALLBACK['Supervisor / Encarregado'] || [],
    );

    const adminWithoutExpenseClose = new Set(adminEmpresaPermissions);
    adminWithoutExpenseClose.delete('can_close_expenses');
    expect(supervisorPermissions).not.toEqual(adminWithoutExpenseClose);
    expect(supervisorPermissions.has('can_manage_users')).toBe(true);
    expect(supervisorPermissions.has('can_view_expenses')).toBe(true);
    expect(supervisorPermissions.has('can_manage_expenses')).toBe(true);
    expect(supervisorPermissions.has('can_close_expenses')).toBe(false);
    expect(supervisorPermissions.has('can_manage_companies')).toBe(false);
  });
});
