import { BadRequestException } from '@nestjs/common';
import { Role } from '../../modules/auth/enums/roles.enum';
import { normalizeRoleName } from '../../modules/auth/role-normalization.util';
import { RequestContext } from '../middleware/request-context.middleware';
import { TenantContext } from './tenant.service';

export type ResolvedSiteAccessScope = {
  companyId: string;
  userId?: string;
  siteId?: string;
  siteIds: string[];
  siteScope: 'single' | 'all';
  isSuperAdmin: boolean;
  hasCompanyWideAccess: boolean;
  profileName?: string;
};

type ResolveSiteAccessScopeOptions = {
  allowMissingSiteScope?: boolean;
};

export function isCompanyWideProfile(profileName?: string | null): boolean {
  const normalized = normalizeRoleName(profileName);
  return normalized === Role.ADMIN_GERAL || normalized === Role.ADMIN_EMPRESA;
}

export function resolveSiteAccessScope(
  context: TenantContext | undefined,
  moduleLabel: string,
  options?: ResolveSiteAccessScopeOptions,
): ResolvedSiteAccessScope {
  const companyId = context?.companyId?.trim();
  if (!companyId) {
    throw new BadRequestException(
      `Contexto de empresa nao definido para ${moduleLabel}.`,
    );
  }

  const profileName = RequestContext.get<string>('profileName');
  const isSuperAdmin = context?.isSuperAdmin === true;
  const internalCompanyWideJob =
    !context?.userId && context?.siteScope === 'all' && !profileName;
  const hasCompanyWideAccess =
    isSuperAdmin || isCompanyWideProfile(profileName) || internalCompanyWideJob;
  const siteScope: 'single' | 'all' = hasCompanyWideAccess ? 'all' : 'single';
  const siteIds = normalizeSiteIds(context?.siteIds, context?.siteId);
  const siteId = siteIds[0];

  if (
    siteScope === 'single' &&
    siteIds.length === 0 &&
    options?.allowMissingSiteScope !== true
  ) {
    throw new BadRequestException(
      `Contexto de obra nao definido para ${moduleLabel}.`,
    );
  }

  return {
    companyId,
    userId: context?.userId,
    siteId,
    siteIds,
    siteScope,
    isSuperAdmin,
    hasCompanyWideAccess,
    profileName,
  };
}

export function resolveSiteAccessScopeFromTenantService(
  tenantService: {
    getContext?: () => TenantContext | undefined;
    getTenantId?: () => string | undefined;
    isSuperAdmin?: () => boolean;
  },
  moduleLabel: string,
  options?: ResolveSiteAccessScopeOptions,
): ResolvedSiteAccessScope {
  const currentContext = tenantService.getContext?.();
  const context =
    currentContext ??
    ({
      companyId: tenantService.getTenantId?.(),
      isSuperAdmin: tenantService.isSuperAdmin?.() ?? false,
      siteIds: [],
      siteScope: 'all',
    } satisfies TenantContext);

  return resolveSiteAccessScope(context, moduleLabel, options);
}

export function isSiteVisibleToScope(
  siteId: string | null | undefined,
  scope: Pick<
    ResolvedSiteAccessScope,
    'hasCompanyWideAccess' | 'siteId' | 'siteIds'
  >,
): boolean {
  if (scope.hasCompanyWideAccess) {
    return true;
  }

  return Boolean(siteId && scope.siteIds.includes(siteId));
}

export function getScopedSiteIds(
  scope: Pick<ResolvedSiteAccessScope, 'hasCompanyWideAccess' | 'siteIds'>,
): string[] {
  return scope.hasCompanyWideAccess ? [] : scope.siteIds;
}

function normalizeSiteIds(
  siteIds: string[] | undefined,
  fallbackSiteId: string | undefined,
): string[] {
  const ordered = [...(siteIds ?? []), fallbackSiteId]
    .map((siteId) => String(siteId || '').trim())
    .filter(Boolean);
  return Array.from(new Set(ordered));
}
