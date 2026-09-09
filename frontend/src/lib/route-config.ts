/**
 * Fonte única de verdade para configuração de rotas do dashboard.
 *
 * ADMIN_ROUTES        — requer isAdminGeral para acesso direto.
 * PERMISSION_ROUTES   — rota requer permissão específica (exceção dentro de ADMIN_ROUTES).
 * HIDDEN_ROUTES       — módulos temporariamente desabilitados (redireciona para /dashboard).
 *
 * Para adicionar uma nova rota protegida:
 *   1. Se requer ADMIN_GERAL: adicione o prefixo em ADMIN_ROUTES.
 *   2. Se requer permissão granular: adicione em PERMISSION_ROUTES (usar Permission.CAN_XXX).
 *   3. Se temporariamente oculta: adicione em HIDDEN_ROUTES.
 *
 * SEMPRE use Permission constants de '@/lib/permissions' — nunca strings literais.
 */

import { Permission, type AppPermission } from '@/lib/permissions';

export const ADMIN_ROUTES = [
  '/dashboard/companies',
  '/dashboard/sites',
  '/dashboard/users',
  '/dashboard/activities',
  '/dashboard/risks',
  '/dashboard/trainings',
  '/dashboard/medical-exams',
  '/dashboard/epis',
  '/dashboard/epi-fichas',
  '/dashboard/tools',
  '/dashboard/machines',
  '/dashboard/dds',
  '/dashboard/checklists',
  '/dashboard/checklist-models',
  '/dashboard/nonconformities',
] as const;

export type AdminRoute = (typeof ADMIN_ROUTES)[number];

/**
 * Rotas dentro de ADMIN_ROUTES que podem ser acessadas com permissão
 * específica mesmo sem ser ADMIN_GERAL.
 */
export const PERMISSION_ROUTE_EXCEPTIONS: Array<{
  route: string;
  permission: AppPermission;
}> = [
  { route: '/dashboard/companies', permission: Permission.CAN_VIEW_COMPANIES },
  { route: '/dashboard/activities', permission: Permission.CAN_VIEW_ACTIVITIES },
  { route: '/dashboard/risks', permission: Permission.CAN_VIEW_RISKS },
  { route: '/dashboard/trainings', permission: Permission.CAN_VIEW_TRAININGS },
  { route: '/dashboard/medical-exams', permission: Permission.CAN_VIEW_MEDICAL_EXAMS },
  { route: '/dashboard/epis', permission: Permission.CAN_MANAGE_CATALOGS },
  { route: '/dashboard/epi-fichas', permission: Permission.CAN_VIEW_EPI_ASSIGNMENTS },
  { route: '/dashboard/tools', permission: Permission.CAN_MANAGE_CATALOGS },
  { route: '/dashboard/machines', permission: Permission.CAN_MANAGE_CATALOGS },
  { route: '/dashboard/sites', permission: Permission.CAN_MANAGE_SITES },
  { route: '/dashboard/users', permission: Permission.CAN_MANAGE_USERS },
  { route: '/dashboard/dds', permission: Permission.CAN_VIEW_DDS },
  { route: '/dashboard/checklists', permission: Permission.CAN_VIEW_CHECKLISTS },
  { route: '/dashboard/checklist-models', permission: Permission.CAN_VIEW_CHECKLISTS },
  { route: '/dashboard/nonconformities', permission: Permission.CAN_VIEW_NC },
];

/**
 * Prefixos de rotas temporariamente ocultadas (feature flags de rollout).
 * Redireciona silenciosamente para /dashboard ao tentar acessar.
 */
export const HIDDEN_ROUTES = [] as const;

export type HiddenRoute = (typeof HIDDEN_ROUTES)[number];

/** Retorna true se o pathname é uma rota exclusiva de ADMIN_GERAL. */
function normalizePath(pathname: string): string {
  const beforeQuery = pathname.split('?')[0]!;
  const [cleaned] = beforeQuery.split('#');
  return cleaned ?? beforeQuery;
}

export function isAdminRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const clean = normalizePath(pathname);
  return ADMIN_ROUTES.some((route) => clean === route || clean.startsWith(`${route}/`));
}

/** Retorna true se o pathname está temporariamente oculto. */
export function isHiddenRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const clean = normalizePath(pathname);
  return HIDDEN_ROUTES.some((prefix) => clean === prefix || clean.startsWith(`${prefix}/`));
}

/**
 * Verifica se o pathname tem exceção de permissão granular
 * (usuário não-admin com permissão específica pode acessar).
 * Retorna AppPermission (constante tipada) ou undefined.
 */
export function getRoutePermissionException(
  pathname: string | null | undefined,
): AppPermission | undefined {
  if (!pathname) return undefined;
  const clean = normalizePath(pathname);
  return PERMISSION_ROUTE_EXCEPTIONS.find(({ route }) => clean.startsWith(route))?.permission;
}
