/**
 * Utilitários de formatação e mascaramento de CPF.
 *
 * LGPD Art. 6º, III — princípio de minimização de dados:
 * Em listagens e tabelas, use `maskCpf`. O CPF completo só deve ser exibido
 * mediante ação explícita do usuário em tela de detalhe/edição individual.
 */

/**
 * Retorna "***.***.***-XX" preservando os 2 últimos dígitos para identificação mínima.
 * Entradas inválidas (não numéricas, comprimento diferente de 11) retornam '-'.
 */
export function maskCpf(value?: string | null): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length !== 11) return '-';
  return `***.***.***-${digits.slice(9)}`;
}

/**
 * Formata CPF com pontuação padrão: "123.456.789-00".
 * Entradas inválidas retornam o valor original ou '-' se ausente.
 * Use apenas em telas de edição/detalhe individual, nunca em listagens.
 */
export function formatCpf(value?: string | null): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length !== 11) return value ?? '-';
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

/**
 * Máscara progressiva para inputs de CPF: formata conforme o usuário digita
 * ("123" -> "123.456" -> "123.456.789-00"), limitando a 11 dígitos.
 * Use apenas em campos de digitação, nunca em exibição.
 */
export function formatCpfInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  const parts = [
    digits.slice(0, 3),
    digits.slice(3, 6),
    digits.slice(6, 9),
    digits.slice(9, 11),
  ].filter(Boolean);

  if (parts.length === 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]}.${parts[1]}`;
  if (parts.length === 3) return `${parts[0]}.${parts[1]}.${parts[2]}`;
  return `${parts[0]}.${parts[1]}.${parts[2]}-${parts[3]}`;
}
