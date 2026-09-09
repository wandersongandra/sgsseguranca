const ROLE_ALIASES = {
  superAdmin: ['super_admin', 'super admin'],
  adminEmpresa: ['admin_empresa', 'administrador da empresa'],
  tst: ['tst', 'técnico de segurança', 'técnico de segurança do trabalho (tst)'],
  supervisor: ['supervisor', 'supervisor / encarregado'],
} as const;

function normalizeRole(role: string): string {
  return role.trim().toLocaleLowerCase('pt-BR');
}

export function hasAnyRole(roles: readonly string[], allowedRoles: readonly string[]): boolean {
  const allowed = new Set(allowedRoles.map(normalizeRole));
  return roles.some((role) => allowed.has(normalizeRole(role)));
}

export function canManageCompanies(roles: readonly string[]): boolean {
  return hasAnyRole(roles, ROLE_ALIASES.superAdmin);
}

export function canWriteSites(roles: readonly string[], isAdminGeral: boolean): boolean {
  return isAdminGeral || hasAnyRole(roles, [...ROLE_ALIASES.adminEmpresa, ...ROLE_ALIASES.tst]);
}

export function canDeleteSites(roles: readonly string[], isAdminGeral: boolean): boolean {
  return (
    isAdminGeral ||
    hasAnyRole(roles, [
      ...ROLE_ALIASES.adminEmpresa,
      ...ROLE_ALIASES.tst,
      ...ROLE_ALIASES.supervisor,
    ])
  );
}
