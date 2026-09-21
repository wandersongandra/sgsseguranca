export type InstitutionalPdfHeader = {
  title: string;
  subtitle: string;
  code: string;
  status: string;
  company?: string | null;
  site?: string | null;
  referenceDate?: string | null;
};

export function escapeInstitutionalPdfHtml(value: unknown): string {
  let text: string;
  if (value === null || value === undefined || value === '') {
    text = '-';
  } else if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value) ?? '-';
    } catch {
      text = '-';
    }
  }
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const INSTITUTIONAL_PDF_CSS = `
  :root { color-scheme: light; --page-bg:#f6f8fb; --surface:#fff; --border:#d3dce6; --border-strong:#8694a6; --text:#111827; --secondary:#374151; --muted:#6b7280; --brand:#18517c; --brand-strong:#0f2036; --info:#1865b0; --success:#1b5e3e; }
  * { box-sizing:border-box; }
  body { font-family:"Liberation Sans", "DejaVu Sans", Arial, sans-serif; color:var(--text); background:var(--page-bg); margin:0; font-size:10px; line-height:1.35; }
  .institutional-header { background:var(--brand-strong); color:#fff; border-bottom:1.4mm solid var(--brand); padding:6mm 7mm 5mm; display:flex; justify-content:space-between; gap:8mm; }
  .header-copy { min-width:0; }
  .institutional-header h1 { font-size:16px; line-height:1.18; margin:0 0 2mm; }
  .header-subtitle { color:#dfe7ef; font-size:9px; line-height:1.35; }
  .code-card { flex:0 0 52mm; background:#fff; color:var(--text); border:0.35mm solid var(--border-strong); border-radius:2mm; padding:2mm 3mm; text-align:center; }
  .code-label { display:block; background:var(--info); color:#fff; border-radius:1mm; padding:1mm; font-size:7px; font-weight:700; letter-spacing:.04em; }
  .code-value { display:block; margin:2mm 0 1mm; font-size:9px; font-weight:700; overflow-wrap:anywhere; }
  .code-status { display:block; color:var(--secondary); font-size:7px; }
  .metadata-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:2.4mm; margin:3mm 0 5mm; }
  .metadata-card { background:var(--surface); border:0.24mm solid var(--border); border-radius:1.8mm; padding:2.2mm 3mm 2.5mm 4.5mm; position:relative; min-height:14mm; }
  .metadata-card::before { content:""; position:absolute; inset:0 auto 0 0; width:2.2mm; background:var(--brand); border-radius:1.8mm 0 0 1.8mm; }
  .metadata-label, .field span { display:block; color:var(--muted); font-size:7px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
  .metadata-value { display:block; margin-top:1.2mm; color:var(--text); font-size:8.3px; font-weight:700; overflow-wrap:anywhere; }
  .section-title { background:var(--surface); border:0.24mm solid var(--border); border-radius:1.8mm; padding:2.2mm 3mm 2.2mm 6mm; margin:4mm 0 2.5mm; font-size:11px; line-height:1.2; position:relative; }
  .section-title::before { content:""; position:absolute; inset:0 auto 0 0; width:2.5mm; background:var(--info); border-radius:1.8mm 0 0 1.8mm; }
  .grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:2.4mm; }
  .field { background:var(--surface); border:0.24mm solid var(--border); border-radius:1.8mm; padding:2.2mm 3mm; min-height:13mm; page-break-inside:avoid; }
  .field strong { display:block; margin-top:1.1mm; color:var(--text); font-size:8.3px; font-weight:700; overflow-wrap:anywhere; white-space:pre-wrap; }
  .executive-summary { background:var(--surface); border:0.24mm solid var(--border); border-radius:1.8mm; padding:3.5mm 4mm; margin:4mm 0 5mm; page-break-inside:avoid; }
  .executive-summary h2 { margin:0 0 1.5mm; font-size:12px; }
  .executive-summary p { margin:0 0 3mm; color:var(--secondary); font-size:8.8px; }
  .metrics { display:grid; grid-template-columns:repeat(3, 1fr); gap:2.4mm; }
  .metric { background:var(--surface); border:0.24mm solid var(--border); border-radius:1.8mm; padding:2.3mm 3mm; min-height:13mm; page-break-inside:avoid; }
  .metric-label { display:block; color:var(--muted); font-size:7px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
  .metric-value { display:block; margin-top:1.1mm; color:var(--text); font-size:9px; font-weight:700; }
  .narrative { background:var(--surface); border:0.24mm solid var(--border); border-radius:1.8mm; padding:3mm; color:var(--secondary); min-height:12mm; overflow-wrap:anywhere; white-space:pre-wrap; page-break-inside:avoid; }
  .governance { margin-top:5mm; background:#eef3f8; border-color:var(--border-strong); border-left:2.5mm solid var(--success); line-height:1.4; page-break-inside:avoid; }
  .governance-title { color:var(--text); font-size:10px; font-weight:700; margin-bottom:1.2mm; }
  .participants-table { width:100%; border-collapse:separate; border-spacing:0; border:0.24mm solid var(--border); border-radius:1.8mm; overflow:hidden; page-break-inside:avoid; }
  .participants-table th { background:var(--surface-muted, #eef2f7); color:var(--muted); font-size:7px; text-transform:uppercase; letter-spacing:.04em; text-align:left; padding:2.2mm 3mm; }
  .participants-table td { background:var(--surface); border-top:0.24mm solid var(--border); color:var(--text); font-size:8.5px; padding:2.2mm 3mm; }
  .integrity { margin-top:3mm; font-size:7px; color:var(--muted); overflow-wrap:anywhere; }
  ul { margin:0; padding-left:6mm; }
`;

export function buildInstitutionalHeaderHtml(
  input: InstitutionalPdfHeader,
): string {
  return `<div class="institutional-header">
    <div class="header-copy">
      <h1>${escapeInstitutionalPdfHtml(input.title)}</h1>
      <div class="header-subtitle">${escapeInstitutionalPdfHtml(input.subtitle)}</div>
    </div>
    <div class="code-card">
      <span class="code-label">IDENTIFICADOR</span>
      <span class="code-value">${escapeInstitutionalPdfHtml(input.code)}</span>
      <span class="code-status">Status: ${escapeInstitutionalPdfHtml(input.status)} | V1</span>
    </div>
  </div>
  <div class="metadata-grid">
    <div class="metadata-card"><span class="metadata-label">Empresa</span><strong class="metadata-value">${escapeInstitutionalPdfHtml(input.company)}</strong></div>
    <div class="metadata-card"><span class="metadata-label">Site/Obra</span><strong class="metadata-value">${escapeInstitutionalPdfHtml(input.site)}</strong></div>
    <div class="metadata-card"><span class="metadata-label">Data de referência</span><strong class="metadata-value">${escapeInstitutionalPdfHtml(input.referenceDate)}</strong></div>
  </div>`;
}

export const INSTITUTIONAL_PDF_FOOTER_TEMPLATE =
  '<div style="font-size:7px;width:100%;border-top:0.3mm solid #d3dce6;padding:2mm 14mm 0;color:#6b7280;display:flex;justify-content:space-between"><span>SGS - Sistema de Gestao de Seguranca</span><span>Documento governado | Pagina <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>';
