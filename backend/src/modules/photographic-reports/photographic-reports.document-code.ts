/**
 * Código do documento do Relatório Fotográfico — fonte única.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 *   Havia duas derivações independentes e divergentes do mesmo identificador:
 *   o serviço registrava `RFP-<ano>-<8 chars>` no Document Registry, enquanto o
 *   renderer imprimia no PDF `<10 chars sem hífen>` derivado do próprio id. O
 *   documento entregue ao cliente ostentava um identificador que não existia em
 *   lugar nenhum do sistema — e o código gravado no registry nunca aparecia no
 *   papel. Como este mesmo valor passa a ser o `verification_code` e o conteúdo
 *   do QR de validação pública, a divergência deixaria o QR apontando para um
 *   código que o portal não resolve.
 *
 * PROPRIEDADE IMPORTANTE
 *   É determinístico a partir de (id, start_date). Isso é o que permite
 *   computá-lo ANTES do render, embutir no QR, e persistir depois — sem o
 *   problema do ovo e da galinha que existiria se dependesse do hash do PDF.
 */

/** Formato: `RFP-<AAAA>-<8 primeiros caracteres do id, maiúsculos>`. */
export function buildPhotographicReportCode(report: {
  id: string;
  start_date?: string | null;
}): string {
  const year = resolveYear(report.start_date);
  const suffix = String(report.id ?? '')
    .replace(/-/g, '')
    .slice(0, 8)
    .toUpperCase();
  return `RFP-${year}-${suffix}`;
}

/**
 * Ano de referência do documento.
 *
 * Diferente do `normalizeDate` do serviço, uma data inválida aqui NÃO lança:
 * a emissão do documento não pode falhar por causa do identificador. Cai no ano
 * corrente, que é o comportamento que o serviço já tinha via `|| new Date()`.
 */
function resolveYear(startDate?: string | null): string {
  const raw = String(startDate ?? '').trim();
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 4);
    }
  }
  return new Date().getFullYear().toString();
}
