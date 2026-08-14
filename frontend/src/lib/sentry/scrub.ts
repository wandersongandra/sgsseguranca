export function scrubbedText(text: string): string {
  return text
    .replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '[CPF]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
    .replace(/(\d{2}\.?\d{3}\.?\d{3}-?\d|\d{2}\.?\d{3}\.?\d{3})/g, '[RG]')
    .replace(/(?:\+55\s?)?\(?\d{2}\)?\s?\d{4,5}-?\d{4}/g, '[TELEFONE]')
    .replace(/(medico_responsavel|crm_medico|observacoes):\s*[^,\s]+/gi, '$1: [REDACTED]');
}
