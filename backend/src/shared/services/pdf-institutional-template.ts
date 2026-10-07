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
  :root { color-scheme:light; --page-bg:#fff; --surface:#fff; --surface-muted:#f7f9fc; --border:#d6dce4; --border-strong:#94a3b8; --text:#0f172a; --secondary:#334155; --muted:#64748b; --brand:#1f4e79; --brand-strong:#102033; --success:#166534; --warning:#b45309; --danger:#b91c1c; }
  * { box-sizing:border-box; }
  html, body { background:var(--page-bg); }
  body { font-family:"Liberation Sans","DejaVu Sans",Arial,sans-serif; color:var(--text); margin:0; font-size:9.5px; line-height:1.42; }
  .institutional-header { border-top:2.8mm solid var(--brand-strong); padding:5mm 0 3.8mm; display:flex; justify-content:space-between; align-items:flex-start; gap:8mm; }
  .header-copy { min-width:0; padding-top:.6mm; flex:1 1 auto; }
  .institutional-header h1 { color:var(--text); font-size:16.5px; line-height:1.12; margin:0 0 1.7mm; letter-spacing:-.015em; }
  .header-subtitle { color:var(--secondary); font-size:8.6px; line-height:1.4; max-width:116mm; }
  .code-card { flex:0 0 52mm; background:#fff; color:var(--text); border:.26mm solid var(--border-strong); border-top:1mm solid var(--brand); padding:0; }
  .code-label { display:block; color:var(--muted); border-bottom:.2mm solid var(--border); padding:1.5mm 2.6mm 1.2mm; font-size:6.6px; font-weight:700; letter-spacing:.055em; text-transform:uppercase; }
  .code-value { display:block; margin:2.3mm 2.6mm .9mm; font-size:9.2px; font-weight:700; overflow-wrap:anywhere; }
  .code-status { display:block; margin:0 2.6mm 2.2mm; color:var(--secondary); font-size:7px; }
  .metadata-grid { display:grid; grid-template-columns:repeat(3,1fr); border-top:.24mm solid var(--border-strong); border-bottom:.24mm solid var(--border); margin:1.5mm 0 5mm; }
  .metadata-card { background:var(--surface); border-right:.2mm solid var(--border); padding:2.4mm 3mm; min-height:12.5mm; }
  .metadata-card:last-child { border-right:0; }
  .metadata-label, .field span { display:block; color:var(--muted); font-size:6.7px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; }
  .metadata-value { display:block; margin-top:1.2mm; color:var(--text); font-size:8.3px; font-weight:600; overflow-wrap:anywhere; }
  .section-title { position:relative; padding:0 0 2mm; margin:5.5mm 0 2.8mm; font-size:10.8px; line-height:1.2; font-weight:700; color:var(--text); border-bottom:.2mm solid var(--border); }
  .section-title::after { content:""; position:absolute; left:0; bottom:-.2mm; width:28mm; border-bottom:.55mm solid var(--brand); }
  .grid { display:grid; grid-template-columns:repeat(2,1fr); border:.22mm solid var(--border); }
  .field { background:var(--surface); border-right:.2mm solid var(--border); border-bottom:.2mm solid var(--border); padding:2.5mm 3mm; min-height:13mm; page-break-inside:avoid; }
  .field:nth-child(2n) { border-right:0; }
  .field strong { display:block; margin-top:1.1mm; color:var(--text); font-size:8.4px; font-weight:600; overflow-wrap:anywhere; white-space:pre-wrap; }
  .executive-summary { border:.24mm solid var(--border); border-top:.9mm solid var(--brand-strong); padding:3.2mm 3.5mm 3.5mm; margin:4mm 0 5mm; page-break-inside:avoid; background:#fff; }
  .executive-summary h2 { margin:0 0 1.5mm; font-size:11.4px; }
  .executive-summary p { margin:0 0 3mm; color:var(--secondary); font-size:8.5px; }
  .metrics { display:grid; grid-template-columns:repeat(3,1fr); border-top:.2mm solid var(--border); }
  .metric { padding:2.2mm 2.4mm 0 0; min-height:11mm; page-break-inside:avoid; }
  .metric + .metric { border-left:.2mm solid var(--border); padding-left:2.4mm; }
  .metric-label { display:block; color:var(--muted); font-size:6.7px; font-weight:700; text-transform:uppercase; letter-spacing:.045em; }
  .metric-value { display:block; margin-top:1mm; color:var(--text); font-size:9px; font-weight:700; }
  .narrative, .observations { border-left:.8mm solid var(--border-strong); padding:2.6mm 3.2mm; color:var(--secondary); min-height:11mm; overflow-wrap:anywhere; white-space:pre-wrap; page-break-inside:avoid; background:#fff; }
  .governance { margin-top:5mm; border:.22mm solid var(--border); border-left:1mm solid var(--brand); padding:3mm 3.3mm; line-height:1.45; page-break-inside:avoid; color:var(--secondary); background:#fff; }
  .governance-title { color:var(--text); font-size:9.5px; font-weight:700; margin-bottom:1.2mm; }
  .receipt-note { margin-top:3mm; padding:2.8mm 3.2mm; border:.22mm solid var(--border); background:var(--surface-muted); color:var(--secondary); line-height:1.45; page-break-inside:avoid; }
  .participants-table { width:100%; border-collapse:collapse; border:.22mm solid var(--border); page-break-inside:auto; }
  .participants-table th { background:var(--brand-strong); color:#fff; font-size:6.8px; text-transform:uppercase; letter-spacing:.04em; text-align:left; padding:2.1mm 2.6mm; border-bottom:.22mm solid var(--brand-strong); }
  .participants-table td { background:var(--surface); border-top:.18mm solid var(--border); color:var(--text); font-size:8.2px; padding:2mm 2.6mm; }
  .participants-table tr:nth-child(even) td { background:#fafbfd; }
  .integrity { margin-top:3mm; padding-top:2mm; border-top:.2mm solid var(--border); font-size:6.7px; color:var(--muted); overflow-wrap:anywhere; }
  .mono { font-family:"Liberation Mono","DejaVu Sans Mono",monospace; }
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
      <span class="code-label">Identificador</span>
      <span class="code-value">${escapeInstitutionalPdfHtml(input.code)}</span>
      <span class="code-status">${escapeInstitutionalPdfHtml(input.status)} · v1</span>
    </div>
  </div>
  <div class="metadata-grid">
    <div class="metadata-card"><span class="metadata-label">Empresa</span><strong class="metadata-value">${escapeInstitutionalPdfHtml(input.company)}</strong></div>
    <div class="metadata-card"><span class="metadata-label">Site/Obra</span><strong class="metadata-value">${escapeInstitutionalPdfHtml(input.site)}</strong></div>
    <div class="metadata-card"><span class="metadata-label">Data de referência</span><strong class="metadata-value">${escapeInstitutionalPdfHtml(input.referenceDate)}</strong></div>
  </div>`;
}

export const INSTITUTIONAL_PDF_FOOTER_TEMPLATE =
  '<div style="font-size:7px;width:100%;border-top:0.3mm solid #d6dce4;padding:2mm 14mm 0;color:#64748b;display:flex;justify-content:space-between"><span style="font-weight:700;color:#334155">SGS · Segurança do Trabalho</span><span>Documento eletrônico · Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>';
