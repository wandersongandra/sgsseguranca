import { canDeleteSites, canManageCompanies, canWriteSites } from './role-access';

describe('role-access', () => {
  it('respeita o papel de plataforma para mutações de empresas', () => {
    expect(canManageCompanies(['Administrador Geral'])).toBe(false);
    expect(canManageCompanies(['SUPER_ADMIN'])).toBe(true);
  });

  it('permite escrever obras apenas para os papéis aceitos pelo backend', () => {
    expect(canWriteSites(['Supervisor / Encarregado'], false)).toBe(false);
    expect(canWriteSites(['Técnico de Segurança do Trabalho (TST)'], false)).toBe(true);
    expect(canWriteSites([], true)).toBe(true);
  });

  it('mantém exclusão disponível para supervisor quando o permissionamento permite', () => {
    expect(canDeleteSites(['Supervisor / Encarregado'], false)).toBe(true);
    expect(canDeleteSites(['Colaborador'], false)).toBe(false);
  });
});
