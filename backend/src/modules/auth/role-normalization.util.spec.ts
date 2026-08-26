import { Role } from './enums/roles.enum';
import { normalizeRoleName } from './role-normalization.util';

describe('normalizeRoleName', () => {
  it('retorna o valor canônico quando já é um Role do enum', () => {
    expect(normalizeRoleName(Role.ADMIN_GERAL)).toBe(Role.ADMIN_GERAL);
    expect(normalizeRoleName('Administrador da Empresa')).toBe(
      Role.ADMIN_EMPRESA,
    );
    expect(normalizeRoleName('Técnico de Segurança do Trabalho (TST)')).toBe(
      Role.TST,
    );
  });

  it('resolve aliases conhecidos (case/acentos-insensível)', () => {
    expect(normalizeRoleName('SUPER_ADMIN')).toBe(Role.SUPER_ADMIN);
    expect(normalizeRoleName('ADMIN_EMPRESA')).toBe(Role.ADMIN_EMPRESA);
    expect(normalizeRoleName('administrador da empresa')).toBe(
      Role.ADMIN_EMPRESA,
    );
    expect(normalizeRoleName('  Administrador Geral  ')).toBe(Role.ADMIN_GERAL);
    expect(normalizeRoleName('TECNICO SST')).toBe(Role.TST);
    expect(normalizeRoleName('tecnico de seguranca do trabalho')).toBe(
      Role.TST,
    );
    expect(normalizeRoleName('gerente')).toBe(Role.SUPERVISOR);
  });

  it('resolve pelo nome da chave do enum (ex.: ADMIN_GERAL)', () => {
    expect(normalizeRoleName('ADMIN_GERAL')).toBe(Role.ADMIN_GERAL);
    expect(normalizeRoleName('COLABORADOR')).toBe(Role.COLABORADOR);
  });

  it('retorna null para vazio, nulo ou desconhecido', () => {
    expect(normalizeRoleName(undefined)).toBeNull();
    expect(normalizeRoleName(null)).toBeNull();
    expect(normalizeRoleName('')).toBeNull();
    expect(normalizeRoleName('   ')).toBeNull();
    expect(normalizeRoleName('Papel Inexistente')).toBeNull();
  });
});
