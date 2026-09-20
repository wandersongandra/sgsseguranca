export type PtFocusTarget =
  | 'basic-info'
  | 'risk-analysis'
  | 'checklists'
  | 'team';

const PT_FOCUS_TARGETS: readonly PtFocusTarget[] = [
  'basic-info',
  'risk-analysis',
  'checklists',
  'team',
];

export function isPtFocusTarget(value: string | null): value is PtFocusTarget {
  return value !== null && PT_FOCUS_TARGETS.includes(value as PtFocusTarget);
}

export function inferPtFocusTarget(reason: string): PtFocusTarget {
  const normalized = String(reason || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (
    normalized.includes('empresa') ||
    normalized.includes('obra') ||
    normalized.includes('site') ||
    normalized.includes('responsavel') ||
    normalized.includes('titulo')
  ) {
    return 'basic-info';
  }

  if (
    normalized.includes('checklist') ||
    normalized.includes('resposta') ||
    normalized.includes('item(ns)')
  ) {
    return 'checklists';
  }

  if (
    normalized.includes('executante') ||
    normalized.includes('assinatura') ||
    normalized.includes('aso') ||
    normalized.includes('treinamento')
  ) {
    return 'team';
  }

  if (
    normalized.includes('risco') ||
    normalized.includes('evidencia') ||
    normalized.includes('controle') ||
    normalized.includes('acoes corretivas') ||
    normalized.includes('analise')
  ) {
    return 'risk-analysis';
  }

  return 'basic-info';
}

export function buildPtEditFocusHref(id: string, reason: string) {
  const focus = inferPtFocusTarget(reason);
  return `/dashboard/pts/edit/${id}?focus=${focus}`;
}

export function getPtFocusLabel(target: PtFocusTarget) {
  switch (target) {
    case 'basic-info':
      return 'Dados básicos da PT';
    case 'risk-analysis':
      return 'Análise de risco e controles';
    case 'checklists':
      return 'Checklists críticos';
    case 'team':
      return 'Equipe, assinaturas e liberação';
    default:
      return 'Seção da PT';
  }
}
