/**
 * Fase 1/2 — Testes P0: AdminController
 *
 * Verifica que todas as rotas /admin/* exigem:
 *   - Autenticação JWT (401 se ausente)
 *   - Role.SUPER_ADMIN    (403 se role insuficiente)
 *
 * Fase 2 adiciona:
 *   - Verificação de metadados NestJS (guards declarados em nível de classe)
 *   - Cobertura de TODAS as rotas do controller (não apenas sample)
 *   - Guards separados: JWT vs Roles (comportamento mais realista)
 *   - Resposta estruturada verificada para SUPER_ADMIN
 */
import {
  INestApplication,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { AdminController } from './admin.controller';
import { CacheRefreshService } from './services/cache-refresh.service';
import { GDPRDeletionService } from './services/gdpr-deletion.service';
import { RLSValidationService } from './services/rls-validation.service';
import { DatabaseHealthService } from './services/database-health.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Role } from '../auth/enums/roles.enum';
import { ROLES_KEY } from '../auth/roles.decorator';
import { PERMISSIONS_KEY } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RbacService } from '../rbac/rbac.service';
import { SensitiveActionGuard } from '../../shared/security/sensitive-action.guard';

jest.setTimeout(10000);

const httpRequest = (nestApp: INestApplication) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  request(nestApp.getHttpServer());

// Guard JWT que lança UnauthorizedException (comportamento real do passport)
const jwtDenyGuard = {
  canActivate: () => {
    throw new UnauthorizedException('Token JWT ausente ou inválido');
  },
};

// Guard que simula usuário autenticado mas com role insuficiente
const makeRoleGuard = (userRole: Role) => ({
  canActivate: (context: import('@nestjs/common').ExecutionContext) => {
    const req = context
      .switchToHttp()
      .getRequest<{ user: { profile: { nome: string } } }>();
    req.user = { profile: { nome: userRole } };
    if (userRole !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Função insuficiente para esta operação');
    }
    return true;
  },
});

// Guard composto: simula JWT OK mas com role errado
const makeAuthenticatedWithRoleGuard = (userRole: Role) => ({
  canActivate: (context: import('@nestjs/common').ExecutionContext) => {
    const req = context
      .switchToHttp()
      .getRequest<{ user: { profile: { nome: string } } }>();
    req.user = { profile: { nome: userRole } };
    return true; // JWT always passes
  },
});

// Guard para RolesGuard: bloqueia se não é SUPER_ADMIN
const rolesGuardFor = (userRole: Role) => ({
  canActivate: () => {
    if (userRole !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Função insuficiente');
    }
    return true;
  },
});

const makeServices = () => ({
  cacheRefreshService: {
    refreshDashboard: jest.fn().mockResolvedValue({ ok: true }),
    refreshRiskRankings: jest.fn().mockResolvedValue({ ok: true }),
    refreshAll: jest.fn().mockResolvedValue({ ok: true }),
    getCacheStatus: jest.fn().mockResolvedValue({ ok: true }),
  },
  gdprDeletionService: {
    deleteUserData: jest.fn().mockResolvedValue({ ok: true }),
    deleteExpiredData: jest.fn().mockResolvedValue({ ok: true }),
    getDeleteRequestStatus: jest.fn().mockReturnValue({ status: 'done' }),
    getPendingRequests: jest.fn().mockReturnValue([]),
    getRetentionCleanupRuns: jest.fn().mockReturnValue([]),
  },
  rlsValidationService: {
    validateRLSPolicies: jest.fn().mockResolvedValue({
      status: 'secure',
      all_pass: true,
      critical_tables: [],
      timestamp: '',
    }),
    testCrossTenantIsolation: jest.fn().mockResolvedValue({ status: 'secure' }),
    getSecurityScore: jest.fn().mockResolvedValue({
      overall_score: 100,
      max_score: 100,
      percentage: 100,
      components: [],
      status: 'secure',
      recommendations: [],
      timestamp: '',
    }),
  },
  databaseHealthService: {
    getFullHealthCheck: jest
      .fn()
      .mockResolvedValue({ status: 'healthy', overall_health_score: 100 }),
    getQuickStatus: jest.fn().mockResolvedValue({ status: 'ok' }),
  },
});

async function buildApp(
  jwtGuardOverride: object,
  rolesGuardOverride?: object,
): Promise<INestApplication> {
  const svc = makeServices();
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminController],
    providers: [
      { provide: CacheRefreshService, useValue: svc.cacheRefreshService },
      { provide: GDPRDeletionService, useValue: svc.gdprDeletionService },
      { provide: RLSValidationService, useValue: svc.rlsValidationService },
      { provide: DatabaseHealthService, useValue: svc.databaseHealthService },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(jwtGuardOverride)
    .overrideGuard(RolesGuard)
    .useValue(rolesGuardOverride ?? jwtGuardOverride)
    // AdminController tem rotas com @UseGuards(SensitiveActionGuard). Para estes testes,
    // o comportamento de "ação sensível" não é alvo, então mockamos como allow.
    .overrideGuard(SensitiveActionGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(PermissionsGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

async function buildModuleRef(): Promise<TestingModule> {
  const svc = makeServices();
  return Test.createTestingModule({
    controllers: [AdminController],
    providers: [
      { provide: CacheRefreshService, useValue: svc.cacheRefreshService },
      { provide: GDPRDeletionService, useValue: svc.gdprDeletionService },
      { provide: RLSValidationService, useValue: svc.rlsValidationService },
      { provide: DatabaseHealthService, useValue: svc.databaseHealthService },
      {
        provide: RbacService,
        useValue: {
          getUserAccess: jest
            .fn()
            .mockResolvedValue({ roles: [], permissions: [] }),
        },
      },
    ],
  })
    .overrideGuard(SensitiveActionGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(PermissionsGuard)
    .useValue({ canActivate: () => true })
    .compile();
}

// TODAS as rotas do AdminController — cobertura total (Fase 2)
const ALL_ADMIN_ROUTES: Array<{
  method: 'get' | 'post';
  path: string;
  description: string;
}> = [
  // Cache
  {
    method: 'post',
    path: '/admin/cache/refresh-dashboard',
    description: 'refresh dashboard cache',
  },
  {
    method: 'post',
    path: '/admin/cache/refresh-rankings',
    description: 'refresh rankings cache',
  },
  {
    method: 'post',
    path: '/admin/cache/refresh-all',
    description: 'refresh all caches',
  },
  { method: 'get', path: '/admin/cache/status', description: 'cache status' },
  // GDPR
  {
    method: 'post',
    path: '/admin/gdpr/cleanup-expired',
    description: 'cleanup expired data',
  },
  {
    method: 'get',
    path: '/admin/gdpr/pending-requests',
    description: 'list pending GDPR requests',
  },
  {
    method: 'get',
    path: '/admin/gdpr/retention-cleanup-runs',
    description: 'list retention cleanup runs',
  },
  // Security
  {
    method: 'get',
    path: '/admin/security/validate-rls',
    description: 'validate RLS policies',
  },
  {
    method: 'get',
    path: '/admin/security/score',
    description: 'security score',
  },
  // Health
  {
    method: 'get',
    path: '/admin/health/full-check',
    description: 'full health check',
  },
  {
    method: 'get',
    path: '/admin/health/quick-status',
    description: 'quick health status',
  },
  // Summary
  {
    method: 'get',
    path: '/admin/summary/compliance',
    description: 'compliance summary',
  },
  {
    method: 'get',
    path: '/admin/summary/deployment-readiness',
    description: 'deployment readiness',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Fase 2: Verificação de metadados NestJS (guards declarados em nível de classe)
// ─────────────────────────────────────────────────────────────────────────────

describe('AdminController — Metadados NestJS: guards aplicados em nível de classe (Fase 2)', () => {
  it('AdminController tem @Roles(Role.SUPER_ADMIN) declarado a nível de classe', async () => {
    const moduleRef = await buildModuleRef();
    const reflector = moduleRef.get(Reflector);

    // Verifica via Reflector que o metadata ROLES_KEY está no controller
    const roles = reflector.get<Role[]>(ROLES_KEY, AdminController);

    expect(Array.isArray(roles)).toBe(true);
    expect(roles).toContain(Role.SUPER_ADMIN);

    // Garante que nenhum role de menor privilégio está incluído na declaração de classe
    const unprivilegedRoles = [
      Role.TRABALHADOR,
      Role.COLABORADOR,
      Role.TST,
      Role.SUPERVISOR,
      Role.ADMIN_EMPRESA,
    ];
    for (const role of unprivilegedRoles) {
      expect(roles).not.toContain(role);
    }

    await moduleRef.close?.();
  });

  it('AdminController usa @UseGuards declarado (metadado __guards__ presente)', () => {
    // Verifica via reflect-metadata que UseGuards foi aplicado ao controller
    const guards = Reflect.getMetadata('__guards__', AdminController) as
      unknown[] | undefined;

    // Guards devem estar declarados no controller
    expect(Array.isArray(guards)).toBe(true);
    expect(guards!.length).toBeGreaterThan(0);
  });

  it('rotas administrativas sensíveis declaram permissões específicas', async () => {
    const moduleRef = await buildModuleRef();
    const reflector = moduleRef.get(Reflector);
    const cases: Array<{
      method: keyof AdminController;
      permissions: string[];
    }> = [
      { method: 'refreshDashboard', permissions: ['can_view_system_health'] },
      { method: 'refreshRankings', permissions: ['can_view_system_health'] },
      { method: 'refreshAllCaches', permissions: ['can_view_system_health'] },
      { method: 'getCacheStatus', permissions: ['can_view_system_health'] },
      { method: 'deleteUserData', permissions: ['can_manage_users'] },
      { method: 'cleanupExpiredData', permissions: ['can_manage_users'] },
      { method: 'getGDPRStatus', permissions: ['can_manage_users'] },
      { method: 'getPendingGDPRRequests', permissions: ['can_manage_users'] },
      { method: 'getRetentionCleanupRuns', permissions: ['can_manage_users'] },
      { method: 'validateRLS', permissions: ['can_view_system_health'] },
      {
        method: 'testCrossTenantIsolation',
        permissions: ['can_view_system_health'],
      },
      { method: 'getSecurityScore', permissions: ['can_view_system_health'] },
      { method: 'getFullHealthCheck', permissions: ['can_view_system_health'] },
      { method: 'getQuickStatus', permissions: ['can_view_system_health'] },
      {
        method: 'getComplianceSummary',
        permissions: ['can_view_system_health'],
      },
      {
        method: 'getDeploymentReadiness',
        permissions: ['can_view_system_health'],
      },
    ];

    for (const item of cases) {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const handler = AdminController.prototype[item.method];
      expect(reflector.get<string[]>(PERMISSIONS_KEY, handler)).toEqual(
        item.permissions,
      );
    }

    await moduleRef.close?.();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cobertura de autenticação e autorização
// ─────────────────────────────────────────────────────────────────────────────

describe('AdminController — Autenticação e Autorização (P0)', () => {
  let unauthApp: INestApplication;
  let insufficientRoleApp: INestApplication;
  let trabalhadorApp: INestApplication;

  beforeAll(async () => {
    // Sem JWT: UnauthorizedException (401)
    unauthApp = await buildApp(jwtDenyGuard, { canActivate: () => true });
    // JWT OK mas role insuficiente: ForbiddenException (403)
    insufficientRoleApp = await buildApp(
      makeAuthenticatedWithRoleGuard(Role.COLABORADOR),
      rolesGuardFor(Role.COLABORADOR),
    );
    trabalhadorApp = await buildApp(
      makeAuthenticatedWithRoleGuard(Role.TRABALHADOR),
      rolesGuardFor(Role.TRABALHADOR),
    );
  });

  afterAll(async () => {
    await unauthApp.close();
    await insufficientRoleApp.close();
    await trabalhadorApp.close();
  });

  describe('Sem autenticação JWT → 401 (TODAS as rotas)', () => {
    for (const route of ALL_ADMIN_ROUTES) {
      it(`${route.method.toUpperCase()} ${route.path} → 401 sem token`, async () => {
        const response = await httpRequest(unauthApp)[route.method](route.path);
        expect(response.status).toBe(401);
      });
    }
  });

  describe('Role COLABORADOR (JWT válido) → 403 (TODAS as rotas)', () => {
    for (const route of ALL_ADMIN_ROUTES) {
      it(`${route.method.toUpperCase()} ${route.path} → 403 para COLABORADOR`, async () => {
        const response = await httpRequest(insufficientRoleApp)[route.method](
          route.path,
        );
        expect(response.status).toBe(403);
      });
    }
  });

  describe('Role TRABALHADOR (JWT válido) → 403', () => {
    it('GET /admin/cache/status → 403 para TRABALHADOR', async () => {
      const response = await httpRequest(trabalhadorApp).get(
        '/admin/cache/status',
      );
      expect(response.status).toBe(403);
    });
    it('GET /admin/security/score → 403 para TRABALHADOR', async () => {
      const response = await httpRequest(trabalhadorApp).get(
        '/admin/security/score',
      );
      expect(response.status).toBe(403);
    });
  });

  describe('SUPER_ADMIN → acesso permitido (2xx)', () => {
    let adminApp: INestApplication;

    beforeAll(async () => {
      adminApp = await buildApp(
        makeAuthenticatedWithRoleGuard(Role.SUPER_ADMIN),
        rolesGuardFor(Role.SUPER_ADMIN),
      );
    });

    afterAll(async () => {
      await adminApp.close();
    });

    it('GET /admin/cache/status retorna 200 para SUPER_ADMIN', async () => {
      const response = await httpRequest(adminApp).get('/admin/cache/status');
      expect(response.status).toBe(200);
    });

    it('GET /admin/security/validate-rls retorna 200 com estrutura correta', async () => {
      const response = await httpRequest(adminApp).get(
        '/admin/security/validate-rls',
      );
      expect(response.status).toBe(200);

      const body = response.body as {
        status?: string;
        all_pass?: boolean;
        critical_tables?: unknown[];
      };
      expect(['secure', 'warning', 'vulnerable']).toContain(body.status);
      expect(typeof body.all_pass).toBe('boolean');
      expect(Array.isArray(body.critical_tables)).toBe(true);
    });

    it('GET /admin/security/score retorna 200 com estrutura correta', async () => {
      const response = await httpRequest(adminApp).get('/admin/security/score');
      expect(response.status).toBe(200);

      const body = response.body as {
        overall_score?: number;
        status?: string;
        components?: unknown[];
      };
      expect(typeof body.overall_score).toBe('number');
      expect(['secure', 'at_risk', 'vulnerable']).toContain(body.status);
      expect(Array.isArray(body.components)).toBe(true);
    });

    it('GET /admin/gdpr/pending-requests retorna 200 com array', async () => {
      const response = await httpRequest(adminApp).get(
        '/admin/gdpr/pending-requests',
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('GET /admin/health/quick-status retorna 200', async () => {
      const response = await httpRequest(adminApp).get(
        '/admin/health/quick-status',
      );
      expect(response.status).toBe(200);
    });
  });
});

describe('AdminController — Validação de UUID nos parâmetros de rota (P0)', () => {
  let adminApp: INestApplication;

  beforeAll(async () => {
    adminApp = await buildApp(makeRoleGuard(Role.SUPER_ADMIN));
  });

  afterAll(async () => {
    await adminApp.close();
  });

  it('POST /admin/gdpr/delete-user/:userId rejeita UUID inválido com 400', async () => {
    const response = await httpRequest(adminApp).post(
      '/admin/gdpr/delete-user/nao-e-um-uuid',
    );
    expect(response.status).toBe(400);
  });

  it('POST /admin/gdpr/delete-user/:userId rejeita SQL injection com 400', async () => {
    const response = await httpRequest(adminApp).post(
      "/admin/gdpr/delete-user/'; DROP TABLE users; --",
    );
    expect(response.status).toBe(400);
  });

  it('GET /admin/gdpr/request-status/:requestId rejeita string arbitrária com 400', async () => {
    const response = await httpRequest(adminApp).get(
      '/admin/gdpr/request-status/invalid-id',
    );
    expect(response.status).toBe(400);
  });
});
