import { Role } from '../../src/modules/auth/enums/roles.enum';
import { TestApp, type LoginSession } from '../helpers/test-app';

/**
 * Valida o comportamento do sistema após o hardening de RLS (migration 361):
 * - sgs_app sem sgs_rls_bypass
 * - Funções SECURITY DEFINER para rotas de auth (PRs #163/#164)
 * - Políticas sgs_admin em companies (PR #165/#166)
 *
 * Cenários cobertos:
 *   1. /auth/me sem x-company-id: todos os roles recebem 200 (TenantOptional)
 *   2. GET /companies sem x-company-id: ADMIN_GERAL e ADMIN_EMPRESA veem
 *      somente a própria; TST recebe 403 (sem can_view_companies)
 */
const describeE2E =
  process.env.E2E_INFRA_AVAILABLE === 'false' ? describe.skip : describe;

type CompaniesBody = { data?: Array<{ id: string }> };
type MeBody = { user?: { id?: string } };

describeE2E('RLS Hardening — validação de auth pós-migration-361', () => {
  let testApp: TestApp;
  let adminGeralSession: LoginSession;
  let adminEmpresaSession: LoginSession;
  let tstSession: LoginSession;

  beforeAll(async () => {
    testApp = await TestApp.create();
    await testApp.resetDatabase();

    adminGeralSession = await testApp.loginAs(Role.ADMIN_GERAL, 'tenantA');
    adminEmpresaSession = await testApp.loginAs(Role.ADMIN_EMPRESA, 'tenantA');
    tstSession = await testApp.loginAs(Role.TST, 'tenantA');
  });

  afterAll(async () => {
    if (testApp) {
      await testApp.close();
    }
  });

  describe('/auth/me sem x-company-id (TenantOptional — válido para todos os roles)', () => {
    it('ADMIN_GERAL obtém perfil próprio sem header de tenant', async () => {
      const response = await testApp
        .request()
        .get('/auth/me')
        .set('Authorization', `Bearer ${adminGeralSession.accessToken}`);

      expect(response.status).toBe(200);
      const body = response.body as MeBody;
      expect(body.user?.id).toBe(adminGeralSession.userId);
    });

    it('ADMIN_EMPRESA obtém perfil próprio sem header de tenant', async () => {
      const response = await testApp
        .request()
        .get('/auth/me')
        .set('Authorization', `Bearer ${adminEmpresaSession.accessToken}`);

      expect(response.status).toBe(200);
      const body = response.body as MeBody;
      expect(body.user?.id).toBe(adminEmpresaSession.userId);
    });

    it('TST obtém perfil próprio sem header de tenant', async () => {
      const response = await testApp
        .request()
        .get('/auth/me')
        .set('Authorization', `Bearer ${tstSession.accessToken}`);

      expect(response.status).toBe(200);
      const body = response.body as MeBody;
      expect(body.user?.id).toBe(tstSession.userId);
    });
  });

  describe('GET /companies sem x-company-id (isolamento de listagem)', () => {
    it('ADMIN_GERAL lista somente a própria empresa sem header de tenant', async () => {
      const tenantA = testApp.getTenant('tenantA');
      const tenantB = testApp.getTenant('tenantB');

      const response = await testApp
        .request()
        .get('/companies')
        .set('Authorization', `Bearer ${adminGeralSession.accessToken}`);

      expect(response.status).toBe(200);
      const body = response.body as CompaniesBody;
      expect(Array.isArray(body.data)).toBe(true);
      const ids = (body.data ?? []).map((c) => c.id);
      expect(ids).toContain(tenantA.companyId);
      expect(ids).not.toContain(tenantB.companyId);
    });

    it('ADMIN_EMPRESA sem header de tenant vê apenas a própria empresa (sem cross-tenant)', async () => {
      const tenantA = testApp.getTenant('tenantA');
      const tenantB = testApp.getTenant('tenantB');

      const response = await testApp
        .request()
        .get('/companies')
        .set('Authorization', `Bearer ${adminEmpresaSession.accessToken}`);

      expect(response.status).toBe(200);
      const body = response.body as CompaniesBody;
      expect(Array.isArray(body.data)).toBe(true);
      const ids = (body.data ?? []).map((c) => c.id);
      expect(ids).toContain(tenantA.companyId);
      expect(ids).not.toContain(tenantB.companyId);
    });

    it('TST recebe 403 em GET /companies (sem permissão can_view_companies)', async () => {
      const response = await testApp
        .request()
        .get('/companies')
        .set('Authorization', `Bearer ${tstSession.accessToken}`);

      expect(response.status).toBe(403);
    });
  });
});
