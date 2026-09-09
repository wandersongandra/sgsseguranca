import {
  ADMIN_ROUTES,
  PERMISSION_ROUTE_EXCEPTIONS,
  getRoutePermissionException,
  isAdminRoute,
} from './route-config';
import { Permission } from '@/lib/permissions';

describe('route-config — rota /dashboard/dds (achado I1)', () => {
  describe('ADMIN_ROUTES', () => {
    it('inclui /dashboard/dds como rota protegida', () => {
      expect(ADMIN_ROUTES).toContain('/dashboard/dds');
    });

    it('isAdminRoute retorna true para /dashboard/dds', () => {
      expect(isAdminRoute('/dashboard/dds')).toBe(true);
    });

    it('isAdminRoute retorna true para sub-rotas de /dashboard/dds', () => {
      expect(isAdminRoute('/dashboard/dds/new')).toBe(true);
      expect(isAdminRoute('/dashboard/dds/edit/some-id')).toBe(true);
    });

    it('isAdminRoute retorna false para /dashboard/dds-outras-coisas (sem falso positivo)', () => {
      expect(isAdminRoute('/dashboard/dds-extras')).toBe(false);
    });
  });

  describe('PERMISSION_ROUTE_EXCEPTIONS', () => {
    it('inclui exceção can_view_dds para /dashboard/dds', () => {
      const exception = PERMISSION_ROUTE_EXCEPTIONS.find((e) => e.route === '/dashboard/dds');
      expect(exception).toBeDefined();
      expect(exception?.permission).toBe(Permission.CAN_VIEW_DDS);
    });

    it('getRoutePermissionException retorna can_view_dds para /dashboard/dds', () => {
      expect(getRoutePermissionException('/dashboard/dds')).toBe(Permission.CAN_VIEW_DDS);
    });

    it('getRoutePermissionException retorna can_view_dds para sub-rotas de DDS', () => {
      expect(getRoutePermissionException('/dashboard/dds/new')).toBe(Permission.CAN_VIEW_DDS);
      expect(getRoutePermissionException('/dashboard/dds/edit/123')).toBe(Permission.CAN_VIEW_DDS);
    });

    it('getRoutePermissionException retorna can_view_companies para empresas', () => {
      expect(getRoutePermissionException('/dashboard/companies')).toBe(
        Permission.CAN_VIEW_COMPANIES,
      );
    });

    it('getRoutePermissionException retorna undefined para null', () => {
      expect(getRoutePermissionException(null)).toBeUndefined();
    });
  });

  describe('regressão — exceções existentes não foram removidas', () => {
    const expectedExceptions = [
      { route: '/dashboard/activities', permission: Permission.CAN_VIEW_ACTIVITIES },
      { route: '/dashboard/risks', permission: Permission.CAN_VIEW_RISKS },
      { route: '/dashboard/trainings', permission: Permission.CAN_VIEW_TRAININGS },
      { route: '/dashboard/medical-exams', permission: Permission.CAN_VIEW_MEDICAL_EXAMS },
      { route: '/dashboard/epis', permission: Permission.CAN_MANAGE_CATALOGS },
      { route: '/dashboard/epi-fichas', permission: Permission.CAN_VIEW_EPI_ASSIGNMENTS },
      { route: '/dashboard/tools', permission: Permission.CAN_MANAGE_CATALOGS },
      { route: '/dashboard/machines', permission: Permission.CAN_MANAGE_CATALOGS },
      { route: '/dashboard/companies', permission: Permission.CAN_VIEW_COMPANIES },
      { route: '/dashboard/sites', permission: Permission.CAN_MANAGE_SITES },
      { route: '/dashboard/users', permission: Permission.CAN_MANAGE_USERS },
      { route: '/dashboard/dds', permission: Permission.CAN_VIEW_DDS },
      { route: '/dashboard/checklists', permission: Permission.CAN_VIEW_CHECKLISTS },
      { route: '/dashboard/checklist-models', permission: Permission.CAN_VIEW_CHECKLISTS },
      { route: '/dashboard/nonconformities', permission: Permission.CAN_VIEW_NC },
    ];

    test.each(expectedExceptions)(
      'mantém exceção $route → $permission',
      ({ route, permission }) => {
        expect(getRoutePermissionException(route)).toBe(permission);
      },
    );
  });
});
