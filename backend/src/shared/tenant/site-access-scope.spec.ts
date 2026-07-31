import { BadRequestException } from '@nestjs/common';
import {
  resolveSiteAccessScope,
  isCompanyWideProfile,
  type ResolvedSiteAccessScope,
} from './site-access-scope.util';
import { Role } from '../../modules/auth/enums/roles.enum';

// Helper para verificar se um site é visível para o escopo
function isSiteVisibleToScope(
  siteId: string,
  scope: Pick<ResolvedSiteAccessScope, 'hasCompanyWideAccess' | 'siteIds'>,
): boolean {
  if (scope.hasCompanyWideAccess) {
    return true;
  }
  return scope.siteIds.includes(siteId);
}

describe('site-access-scope.util', () => {
  describe('resolveSiteAccessScope', () => {
    const makeTenantContext = (
      overrides: {
        companyId: string;
        isSuperAdmin?: boolean;
        userId?: string;
        siteId?: string;
        siteIds?: string[];
        siteScope?: 'single' | 'all';
      } = { companyId: 'company-1' },
    ) => ({
      companyId: 'company-1',
      ...overrides,
    });

    const makeScope = (
      siteIds: string[],
      hasCompanyWideAccess = false,
    ): Pick<ResolvedSiteAccessScope, 'hasCompanyWideAccess' | 'siteIds'> => ({
      hasCompanyWideAccess,
      siteIds,
    });

    it('retorna erro se contexto undefined', () => {
      expect(() => resolveSiteAccessScope(undefined, 'APR')).toThrow(
        BadRequestException,
      );
    });

    it('retorna erro se companyId vazio', () => {
      expect(() =>
        resolveSiteAccessScope(makeTenantContext({ companyId: '' }), 'APR'),
      ).toThrow(BadRequestException);
    });

    it('retorna erro se siteScope=single sem siteIds', () => {
      expect(() =>
        resolveSiteAccessScope(
          makeTenantContext({ siteScope: 'single' }),
          'APR',
        ),
      ).toThrow(BadRequestException);
    });

    it('retorna escopo com allowMissingSiteScope=true', () => {
      const scope = resolveSiteAccessScope(
        makeTenantContext({ siteScope: 'single' }),
        'APR',
        { allowMissingSiteScope: true },
      );
      expect(scope.siteScope).toBe('single');
      expect(scope.siteIds).toEqual([]);
    });

    it('retorna escopo vazio se isSuperAdmin=true', () => {
      const scope = resolveSiteAccessScope(
        makeTenantContext({ isSuperAdmin: true }),
        'APR',
      );
      expect(scope.hasCompanyWideAccess).toBe(true);
      expect(scope.siteScope).toBe('all');
    });

    it('retorna escopo vazio se siteScope=all (acesso total)', () => {
      const scope = resolveSiteAccessScope(
        makeTenantContext({ siteScope: 'all' }),
        'APR',
      );
      expect(scope.hasCompanyWideAccess).toBe(true);
      expect(scope.siteScope).toBe('all');
    });

    it('retorna escopo com siteIds específicos', () => {
      const scope = resolveSiteAccessScope(
        makeTenantContext({
          siteIds: ['site-x', 'site-y'],
          siteScope: 'single',
        }),
        'APR',
      );
      expect(scope.hasCompanyWideAccess).toBe(false);
      expect(scope.siteScope).toBe('single');
      expect(scope.siteIds).toContain('site-x');
      expect(scope.siteIds).toContain('site-y');
    });

    it('normaliza siteIds e remove duplicatas', () => {
      const scope = resolveSiteAccessScope(
        makeTenantContext({
          siteIds: ['site-x', 'site-y', 'site-x'],
          siteId: 'site-z',
          siteScope: 'single',
        }),
        'APR',
      );
      expect(scope.siteIds).toEqual(['site-x', 'site-y', 'site-z']);
    });

    it('isCompanyWideProfile retorna true para ADMIN_GERAL', () => {
      expect(isCompanyWideProfile(Role.ADMIN_GERAL)).toBe(true);
    });

    it('isCompanyWideProfile retorna true para ADMIN_EMPRESA', () => {
      expect(isCompanyWideProfile(Role.ADMIN_EMPRESA)).toBe(true);
    });

    it('isCompanyWideProfile retorna false para outros perfis', () => {
      expect(isCompanyWideProfile(Role.TECHNICAL)).toBe(false);
      expect(isCompanyWideProfile(Role.TST)).toBe(false);
      expect(isCompanyWideProfile(undefined)).toBe(false);
      expect(isCompanyWideProfile(null)).toBe(false);
    });

    it('TST com acesso às Obras X e Y vê ambas', () => {
      const scope = makeScope(['site-x', 'site-y']);

      expect(isSiteVisibleToScope('site-x', scope)).toBe(true);
      expect(isSiteVisibleToScope('site-y', scope)).toBe(true);
    });

    it('ADM_EMPRESA vê todas as obras da empresa', () => {
      const scope = makeScope(['site-x', 'site-y'], true);

      expect(isSiteVisibleToScope('site-x', scope)).toBe(true);
      expect(isSiteVisibleToScope('site-y', scope)).toBe(true);
      expect(isSiteVisibleToScope('site-z', scope)).toBe(true);
    });

    it('ADMIN_GERAL vê todas as obras', () => {
      const scope = makeScope([], true);

      expect(isSiteVisibleToScope('site-x', scope)).toBe(true);
      expect(isSiteVisibleToScope('site-y', scope)).toBe(true);
    });
  });
});
