import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { RbacService } from '../rbac/rbac.service';
import { ROLES_KEY } from './roles.decorator';
import { Role } from './enums/roles.enum';
import { PERMISSIONS_KEY } from './permissions.decorator';

type GuardLogEntry = {
  path?: string;
  class?: string;
  timestamp?: string;
};

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;
  let rbacService: RbacService;
  let mockExecutionContext: ExecutionContext;
  let loggerWarnSpy: jest.SpyInstance<void, [GuardLogEntry]>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn(),
          },
        },
        {
          provide: RbacService,
          useValue: {
            getUserAccess: jest.fn(),
          },
        },
      ],
    }).compile();

    guard = module.get<RolesGuard>(RolesGuard);
    reflector = module.get<Reflector>(Reflector);
    rbacService = module.get<RbacService>(RbacService);

    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn') as jest.SpyInstance<
      void,
      [GuardLogEntry]
    >;
    loggerWarnSpy.mockImplementation();

    mockExecutionContext = {
      getHandler: () => ({ name: 'testHandler' }),
      getClass: () => ({ name: 'TestController' }),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue({
          user: {
            userId: 'user-123',
            profile: { nome: Role.ADMIN_GERAL },
          },
        }),
      }),
    } as unknown as ExecutionContext;
  });

  afterEach(() => {
    jest.clearAllMocks();
    loggerWarnSpy.mockRestore();
  });

  describe('Default-deny behavior', () => {
    it('should throw ForbiddenException when no @Roles() decorator is applied', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(null);

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        new ForbiddenException('Acesso negado: função não especificada'),
      );

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'unauthorized_access_no_roles_required',
          path: 'testHandler',
          class: 'TestController',
        }),
      );
    });

    it('should throw ForbiddenException when @Roles() decorator has empty array', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([]);

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        new ForbiddenException('Acesso negado: função não especificada'),
      );

      expect(loggerWarnSpy).toHaveBeenCalled();
    });

    it('should defer to PermissionsGuard when @Permissions() metadata exists without @Roles()', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockImplementation(
        (key: string) => {
          if (key === ROLES_KEY) return null;
          if (key === PERMISSIONS_KEY) return ['can_view_dds'];
          return null;
        },
      );

      await expect(guard.canActivate(mockExecutionContext)).resolves.toBe(true);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('UserId validation', () => {
    it('should throw ForbiddenException when user is not authenticated (no userId)', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.ADMIN_GERAL,
      ]);

      const requestWithoutUser = {
        user: {
          profile: { nome: Role.ADMIN_GERAL },
        },
      };

      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue(requestWithoutUser);

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        new ForbiddenException('Usuário não autenticado'),
      );

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'unauthorized_access_no_user',
          path: 'testHandler',
          class: 'TestController',
        }),
      );
    });

    it('should throw ForbiddenException when user object is null', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.ADMIN_GERAL,
      ]);

      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue({});

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        new ForbiddenException('Usuário não autenticado'),
      );
    });
  });

  describe('Role validation', () => {
    it('should throw ForbiddenException when user has invalid role', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.ADMIN_GERAL,
      ]);

      const requestWithInvalidRole = {
        user: {
          userId: 'user-123',
          profile: { nome: 'INVALID_ROLE' },
        },
      };

      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue(requestWithInvalidRole);

      (rbacService.getUserAccess as jest.Mock).mockResolvedValue({
        roles: [Role.COLABORADOR],
        permissions: ['can_view_dashboard'],
      });

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        new ForbiddenException('Função de usuário inválida'),
      );

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'unauthorized_access_invalid_role',
          userId: 'user-123',
          attemptedRole: 'INVALID_ROLE',
          requiredRoles: [Role.ADMIN_GERAL],
        }),
      );
    });

    it('should allow access when profile role is missing but RBAC roles satisfy required role', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.ADMIN_GERAL,
      ]);

      const requestWithoutRole = {
        user: {
          userId: 'user-123',
        },
      };

      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue(requestWithoutRole);

      (rbacService.getUserAccess as jest.Mock).mockResolvedValue({
        roles: [Role.ADMIN_GERAL],
        permissions: ['can_manage_companies'],
      });

      await expect(guard.canActivate(mockExecutionContext)).resolves.toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const getUserAccessMock = rbacService.getUserAccess as jest.Mock;
      expect(getUserAccessMock).toHaveBeenCalledWith('user-123', {
        profileName: undefined,
      });
    });

    it('should throw ForbiddenException when user does not have required role', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.ADMIN_GERAL,
      ]);

      const requestWithWrongRole = {
        user: {
          userId: 'user-123',
          profile: { nome: Role.COLABORADOR },
        },
      };

      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue(requestWithWrongRole);

      (rbacService.getUserAccess as jest.Mock).mockResolvedValue({
        roles: [Role.COLABORADOR],
        permissions: ['can_view_dashboard'],
      });

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        new ForbiddenException('Função insuficiente para esta operação'),
      );

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'unauthorized_access_insufficient_role',
          userId: 'user-123',
          userRole: Role.COLABORADOR,
          requiredRoles: [Role.ADMIN_GERAL],
        }),
      );

      const mockedRbacService = rbacService as unknown as {
        getUserAccess: jest.Mock;
      };
      const getUserAccessMock = mockedRbacService.getUserAccess;
      expect(getUserAccessMock).toHaveBeenCalledWith('user-123', {
        profileName: Role.COLABORADOR,
      });
    });

    it('should handle RbacService error gracefully', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.ADMIN_GERAL,
      ]);

      const requestWithWrongRole = {
        user: {
          userId: 'user-123',
          profile: { nome: Role.COLABORADOR },
        },
      };

      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue(requestWithWrongRole);

      (rbacService.getUserAccess as jest.Mock).mockRejectedValue(
        new Error('RBAC service error'),
      );

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        new ForbiddenException('Função insuficiente para esta operação'),
      );

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'unauthorized_access_insufficient_role',
          userId: 'user-123',
          userRole: Role.COLABORADOR,
          error: 'RBAC service error',
        }),
      );
    });
  });

  describe('Access granted', () => {
    it('should allow access when user has required role', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.ADMIN_GERAL,
      ]);

      const result = await guard.canActivate(mockExecutionContext);

      expect(result).toBe(true);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it('should allow access when user has one of multiple required roles', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.ADMIN_GERAL,
        Role.ADMIN_EMPRESA,
      ]);

      const result = await guard.canActivate(mockExecutionContext);

      expect(result).toBe(true);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it('should allow access with string role names', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        'ADMIN_GERAL',
      ]);

      const result = await guard.canActivate(mockExecutionContext);

      expect(result).toBe(true);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it.each([Role.TST, Role.SUPERVISOR, Role.ADMIN_EMPRESA])(
      'does not treat ADMIN_GERAL as a universal bypass for %s',
      async (requiredRole) => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
          requiredRole,
        ]);
        (rbacService.getUserAccess as jest.Mock).mockResolvedValue({
          roles: [Role.ADMIN_GERAL],
          permissions: [],
        });

        await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
          new ForbiddenException('Função insuficiente para esta operação'),
        );
      },
    );

    it('allows the explicit SUPER_ADMIN role only when the route declares it', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.SUPER_ADMIN,
      ]);
      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue({
        user: {
          userId: 'platform-admin',
          profile: { nome: Role.SUPER_ADMIN },
        },
      });

      await expect(guard.canActivate(mockExecutionContext)).resolves.toBe(true);
    });

    it('normaliza alias GERENTE como supervisor operacional', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.SUPERVISOR,
      ]);

      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue({
        user: {
          userId: 'user-gerente',
          profile: { nome: 'GERENTE' },
        },
      });

      await expect(guard.canActivate(mockExecutionContext)).resolves.toBe(true);
    });

    it('blocks TST when route requires Admin Empresa', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.ADMIN_EMPRESA,
      ]);

      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue({
        user: {
          userId: 'user-tst',
          profile: { nome: Role.TST },
        },
      });

      (rbacService.getUserAccess as jest.Mock).mockResolvedValue({
        roles: [Role.TST],
        permissions: ['can_view_dashboard'],
      });

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        new ForbiddenException('Função insuficiente para esta operação'),
      );
    });

    it('blocks legacy Técnico profile when route requires Admin Empresa', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.ADMIN_EMPRESA,
      ]);

      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue({
        user: {
          userId: 'user-tecnico',
          profile: { nome: 'Técnico' },
        },
      });

      (rbacService.getUserAccess as jest.Mock).mockResolvedValue({
        roles: [Role.TST],
        permissions: ['can_view_dashboard'],
      });

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        new ForbiddenException('Função insuficiente para esta operação'),
      );
    });

    it('blocks Supervisor when route requires TST', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([Role.TST]);

      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue({
        user: {
          userId: 'user-supervisor',
          profile: { nome: Role.SUPERVISOR },
        },
      });

      (rbacService.getUserAccess as jest.Mock).mockResolvedValue({
        roles: [Role.SUPERVISOR],
        permissions: ['can_view_dashboard'],
      });

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        new ForbiddenException('Função insuficiente para esta operação'),
      );
    });

    it('keeps Admin Geral routes exclusive', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
        Role.ADMIN_GERAL,
      ]);

      (
        mockExecutionContext.switchToHttp().getRequest as jest.Mock
      ).mockReturnValue({
        user: {
          userId: 'user-company-admin',
          profile: { nome: Role.ADMIN_EMPRESA },
        },
      });

      (rbacService.getUserAccess as jest.Mock).mockResolvedValue({
        roles: [Role.ADMIN_EMPRESA],
        permissions: ['can_manage_users'],
      });

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        new ForbiddenException('Função insuficiente para esta operação'),
      );
    });
  });

  describe('Logging context', () => {
    it('should include correct path and class in logs', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(null);

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow();

      const firstWarnCall = loggerWarnSpy.mock.calls[0];
      expect(firstWarnCall).toBeDefined();
      const [logCall] = firstWarnCall;
      expect(logCall.path).toBe('testHandler');
      expect(logCall.class).toBe('TestController');
      expect(logCall.timestamp).toEqual(expect.any(String));
    });

    it('should include timestamp in all log entries', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(null);

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow();

      const firstWarnCall = loggerWarnSpy.mock.calls[0];
      expect(firstWarnCall).toBeDefined();
      const [logCall] = firstWarnCall;
      expect(logCall.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
