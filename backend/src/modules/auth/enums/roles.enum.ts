export enum Role {
  /** Papel de plataforma; nunca é derivado de ADMIN_GERAL. */
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN_GERAL = 'Administrador Geral',
  ADMIN_EMPRESA = 'Administrador da Empresa',
  TST = 'Técnico de Segurança do Trabalho (TST)',
  SUPERVISOR = 'Supervisor / Encarregado',
  COLABORADOR = 'Operador / Colaborador',
  TRABALHADOR = 'Trabalhador',
}
