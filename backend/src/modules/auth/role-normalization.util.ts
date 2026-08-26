import { Role } from './enums/roles.enum';

/**
 * Aliases aceitos para nomes de papel provenientes de tokens/perfis legados ou
 * de fontes com grafia divergente. As chaves sao comparadas apos normalizacao
 * (trim + remocao de acentos + upper-case).
 */
const ROLE_ALIASES: Record<string, Role> = {
  SUPER_ADMIN: Role.SUPER_ADMIN,
  'SUPER ADMIN': Role.SUPER_ADMIN,
  'ADMINISTRADOR GERAL': Role.ADMIN_GERAL,
  'ADMINISTRADOR EMPRESA': Role.ADMIN_EMPRESA,
  'ADMINISTRADOR DA EMPRESA': Role.ADMIN_EMPRESA,
  'ADMIN EMPRESA': Role.ADMIN_EMPRESA,
  ADMIN_EMPRESA: Role.ADMIN_EMPRESA,
  GERENTE: Role.SUPERVISOR,
  TECNICO: Role.TST,
  'TECNICO SST': Role.TST,
  'TECNICO DE SEGURANCA DO TRABALHO': Role.TST,
  'TECNICO DE SEGURANCA DO TRABALHO (TST)': Role.TST,
  TST: Role.TST,
  SUPERVISOR: Role.SUPERVISOR,
  'SUPERVISOR / ENCARREGADO': Role.SUPERVISOR,
  VISUALIZADOR: Role.TRABALHADOR,
  COLABORADOR: Role.COLABORADOR,
  'OPERADOR / COLABORADOR': Role.COLABORADOR,
  TRABALHADOR: Role.TRABALHADOR,
};

/**
 * Resolve um nome de papel (canonico, alias, com acentos ou grafia divergente)
 * para o valor canonico do enum {@link Role}, ou `null` quando nao reconhecido.
 *
 * Fonte unica de verdade para normalizacao de papel — reutilizada pelo
 * RolesGuard e por checagens de autorizacao baseadas em papel (ex.: restricao
 * de acoes administrativas condicionadas ao conteudo da requisicao).
 */
export function normalizeRoleName(role?: string | Role | null): Role | null {
  if (!role) {
    return null;
  }

  if (Object.values(Role).includes(role as Role)) {
    return role as Role;
  }

  const normalizedRole = String(role)
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase();

  const aliasedRole = ROLE_ALIASES[normalizedRole];
  if (aliasedRole) {
    return aliasedRole;
  }

  const matchedEntry = Object.entries(Role).find(
    ([key, value]) =>
      key === normalizedRole ||
      String(value)
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toUpperCase() === normalizedRole,
  );

  return matchedEntry ? matchedEntry[1] : null;
}
