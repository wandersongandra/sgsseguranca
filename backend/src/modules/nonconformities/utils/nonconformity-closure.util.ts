import type { NonConformity } from '../entities/nonconformity.entity';

type NonConformityClosureReadinessInput = Pick<
  NonConformity,
  | 'acao_definitiva_descricao'
  | 'acao_definitiva_responsavel'
  | 'acao_definitiva_prazo'
  | 'acao_definitiva_data_prevista'
  | 'verificacao_resultado'
  | 'verificacao_evidencias'
  | 'verificacao_data'
  | 'verificacao_responsavel'
  | 'assinatura_responsavel_area'
  | 'assinatura_tecnico_auditor'
>;

function hasMeaningfulText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length >= 3;
}

function hasValidDocumentDate(value: unknown): boolean {
  if (!value || (typeof value !== 'string' && !(value instanceof Date))) {
    return false;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(parsed.getTime());
}

function isPositiveVerificationResult(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return normalized === 'sim';
}

/**
 * Retorna os campos que ainda impedem o encerramento formal da NC. A regra é
 * compartilhada por transições de status e pela emissão do PDF final para que
 * um registro legado marcado como encerrado não se torne um documento oficial
 * sem a evidência mínima de eficácia.
 */
export function getNonConformityClosureMissingFields(
  nc: NonConformityClosureReadinessInput,
): string[] {
  const missing: string[] = [];

  if (!hasMeaningfulText(nc.acao_definitiva_descricao)) {
    missing.push('descrição da ação corretiva definitiva');
  }
  if (!hasMeaningfulText(nc.acao_definitiva_responsavel)) {
    missing.push('responsável pela ação corretiva definitiva');
  }
  if (
    !hasValidDocumentDate(nc.acao_definitiva_prazo) &&
    !hasValidDocumentDate(nc.acao_definitiva_data_prevista)
  ) {
    missing.push('prazo ou data prevista da ação corretiva definitiva');
  }
  if (!isPositiveVerificationResult(nc.verificacao_resultado)) {
    missing.push('resultado de eficácia confirmado como "Sim"');
  }
  if (!hasMeaningfulText(nc.verificacao_evidencias)) {
    missing.push('evidências da verificação de eficácia');
  }
  if (!hasValidDocumentDate(nc.verificacao_data)) {
    missing.push('data da verificação de eficácia');
  }
  if (!hasMeaningfulText(nc.verificacao_responsavel)) {
    missing.push('responsável pela verificação de eficácia');
  }
  if (!hasMeaningfulText(nc.assinatura_responsavel_area)) {
    missing.push('assinatura do responsável da área');
  }
  if (!hasMeaningfulText(nc.assinatura_tecnico_auditor)) {
    missing.push('assinatura do técnico/auditor de SST');
  }

  return missing;
}
