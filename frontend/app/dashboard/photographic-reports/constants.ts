export const PHOTO_CONDITIONS = [
  'EPIs em uso pelos trabalhadores',
  'Área devidamente sinalizada',
  'Procedimentos seguidos corretamente',
  'Risco identificado na imagem',
  'Conformidade com NR aplicável',
] as const;

export type PhotoCondition = (typeof PHOTO_CONDITIONS)[number];

/**
 * `tone` substituiu o antigo campo `color`, que nunca era lido: o PhotoCard
 * mantinha um segundo mapa próprio com classes literais (bg-green-500 etc.),
 * de modo que existiam duas fontes de verdade para o mesmo significado — e a
 * literal era a única cor que de fato renderizava, porque o resto do módulo
 * usava classes que não existem neste projeto. Agora o tom é semântico e vai
 * direto para o StatusPill do design system.
 */
export const CONDITION_CLASSIFICATION_OPTIONS = [
  { value: 'Satisfatória', tone: 'info', label: 'Satisfatória' },
  { value: 'Muito satisfatória', tone: 'success', label: 'Muito satisfatória' },
  {
    value: 'Ponto de atenção preventivo',
    tone: 'warning',
    label: 'Preventiva',
  },
  { value: 'Atenção necessária', tone: 'danger', label: 'Atenção' },
] as const;

export type ClassificationValue =
  (typeof CONDITION_CLASSIFICATION_OPTIONS)[number]['value'];

export type ClassificationTone =
  (typeof CONDITION_CLASSIFICATION_OPTIONS)[number]['tone'];

/**
 * Espelha APPLICABLE_NR_OPTIONS do backend
 * (`backend/src/modules/photographic-reports/photographic-reports.constants.ts`).
 * Se divergirem, o backend descarta em silêncio a NR desconhecida.
 */
export const APPLICABLE_NR_OPTIONS = [
  'NR-01',
  'NR-04',
  'NR-05',
  'NR-06',
  'NR-07',
  'NR-09',
  'NR-10',
  'NR-11',
  'NR-12',
  'NR-13',
  'NR-17',
  'NR-18',
  'NR-20',
  'NR-23',
  'NR-24',
  'NR-26',
  'NR-33',
  'NR-35',
] as const;
export type ApplicableNr = (typeof APPLICABLE_NR_OPTIONS)[number];

/** Descrição curta para o rótulo de apoio na seleção de NRs. */
export const NR_LABELS: Record<string, string> = {
  'NR-01': 'Disposições gerais e GRO/PGR',
  'NR-04': 'SESMT',
  'NR-05': 'CIPA',
  'NR-06': 'EPI',
  'NR-07': 'PCMSO',
  'NR-09': 'Exposições ocupacionais',
  'NR-10': 'Eletricidade',
  'NR-11': 'Movimentação de materiais',
  'NR-12': 'Máquinas e equipamentos',
  'NR-13': 'Caldeiras e vasos de pressão',
  'NR-17': 'Ergonomia',
  'NR-18': 'Construção civil',
  'NR-20': 'Inflamáveis e combustíveis',
  'NR-23': 'Proteção contra incêndios',
  'NR-24': 'Condições sanitárias',
  'NR-26': 'Sinalização de segurança',
  'NR-33': 'Espaços confinados',
  'NR-35': 'Trabalho em altura',
};

export const REGISTRATION_TYPE_OPTIONS = [
  'CREA',
  'CFT',
  'MTE',
  'Outro',
] as const;
export type RegistrationTypeOption =
  (typeof REGISTRATION_TYPE_OPTIONS)[number];

export const SHIFT_OPTIONS = ['Diurno', 'Noturno', 'Integral'] as const;
export type ShiftOption = (typeof SHIFT_OPTIONS)[number];

export const TONE_OPTIONS = ['Positivo', 'Técnico', 'Preventivo'] as const;
export type ToneOption = (typeof TONE_OPTIONS)[number];

export const AREA_STATUS_OPTIONS = [
  'Loja aberta',
  'Loja fechada',
  'Área controlada',
  'Área isolada',
] as const;
export type AreaStatusOption = (typeof AREA_STATUS_OPTIONS)[number];
