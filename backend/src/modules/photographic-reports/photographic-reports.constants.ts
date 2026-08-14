/**
 * Catálogos de domínio do Relatório Fotográfico.
 *
 * Não existe catálogo de NRs em lugar nenhum do repositório — as normas
 * aparecem como literais espalhados (`apr-rules.seed.ts`, presets de checklist,
 * `auditChecklist.ts`). Este é o primeiro; se outros módulos precisarem do mesmo
 * conjunto, a lista deve subir para `shared/` em vez de ser copiada.
 *
 * O espelho no frontend fica em
 * `frontend/app/dashboard/photographic-reports/constants.ts`.
 */

/**
 * NRs que fazem sentido citar num relatório fotográfico de inspeção de campo.
 *
 * Deliberadamente não é a lista completa das NRs: normas de escopo puramente
 * administrativo ou setorial (NR-02, NR-03, NR-14, NR-15/16 de insalubridade e
 * periculosidade, NR-19, NR-21, NR-25, NR-28…) não são o que uma inspeção
 * visual documenta. Manter a lista curta é o que faz a seleção ser usada.
 */
export const APPLICABLE_NR_OPTIONS = [
  'NR-01', // Disposições gerais e gerenciamento de riscos (GRO/PGR)
  'NR-04', // SESMT
  'NR-05', // CIPA
  'NR-06', // EPI
  'NR-07', // PCMSO
  'NR-09', // Avaliação e controle de exposições ocupacionais
  'NR-10', // Segurança em instalações e serviços em eletricidade
  'NR-11', // Transporte, movimentação, armazenagem e manuseio de materiais
  'NR-12', // Segurança no trabalho em máquinas e equipamentos
  'NR-13', // Caldeiras, vasos de pressão e tubulações
  'NR-17', // Ergonomia
  'NR-18', // Construção civil
  'NR-20', // Inflamáveis e combustíveis
  'NR-23', // Proteção contra incêndios
  'NR-24', // Condições sanitárias e de conforto
  'NR-26', // Sinalização de segurança
  'NR-33', // Espaços confinados
  'NR-35', // Trabalho em altura
] as const;

export type ApplicableNr = (typeof APPLICABLE_NR_OPTIONS)[number];

const APPLICABLE_NR_SET: ReadonlySet<string> = new Set(APPLICABLE_NR_OPTIONS);

export function isApplicableNr(value: string): value is ApplicableNr {
  return APPLICABLE_NR_SET.has(value);
}

/**
 * Conselho/órgão do registro profissional de quem assina tecnicamente.
 *
 * `Outro` existe porque a lista de conselhos com atribuição em SST não é
 * fechada — sem essa saída, um profissional legítimo ficaria impedido de
 * preencher o campo.
 */
export const REGISTRATION_TYPE_OPTIONS = [
  'CREA', // Conselho Regional de Engenharia e Agronomia
  'CFT', // Conselho Federal dos Técnicos Industriais
  'MTE', // Registro de Técnico de Segurança no Ministério do Trabalho
  'Outro',
] as const;

export type PhotographicReportRegistrationType =
  (typeof REGISTRATION_TYPE_OPTIONS)[number];

/**
 * Condições observáveis por foto. Espelha PHOTO_CONDITIONS no frontend.
 * Mantido aqui para que o backend possa validar o que recebe em vez de
 * confiar no cliente.
 */
export const PHOTO_CONDITION_OPTIONS = [
  'EPIs em uso pelos trabalhadores',
  'Área devidamente sinalizada',
  'Procedimentos seguidos corretamente',
  'Risco identificado na imagem',
  'Conformidade com NR aplicável',
] as const;

/** Limite de NRs por relatório — folgado o bastante para não atrapalhar. */
export const MAX_APPLICABLE_NRS = 30;

/** Limite de condições marcadas por foto. */
export const MAX_PHOTO_CONDITIONS = 20;
