import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import QRCode from 'qrcode';
import { readFileSync } from 'node:fs';
import { ArrStatus, type Arr } from './entities/arr.entity';

type Rgb = [number, number, number];

const PAGE = {
  width: 210,
  height: 297,
  margin: 16,
  safeTop: 22,
  safeBottom: 24,
};
const TONE = {
  pageBg: [246, 248, 251] as Rgb,
  surface: [255, 255, 255] as Rgb,
  surfaceMuted: [238, 243, 248] as Rgb,
  border: [211, 220, 230] as Rgb,
  borderStrong: [134, 148, 166] as Rgb,
  textPrimary: [17, 24, 39] as Rgb,
  textSecondary: [55, 65, 81] as Rgb,
  textMuted: [107, 114, 128] as Rgb,
  brand: [24, 81, 124] as Rgb,
  brandStrong: [15, 32, 54] as Rgb,
  success: [27, 94, 62] as Rgb,
  warning: [180, 95, 20] as Rgb,
  info: [24, 101, 176] as Rgb,
};

const STATUS: Record<string, string> = {
  tratada: 'Tratada',
  analisada: 'Analisada',
  rascunho: 'Rascunho',
  arquivada: 'Arquivada',
};
const RISK: Record<string, string> = {
  critico: 'Crítico',
  alto: 'Alto',
  medio: 'Médio',
  baixo: 'Baixo',
};
const PROBABILITY: Record<string, string> = {
  baixa: 'Baixa',
  media: 'Média',
  alta: 'Alta',
};
const SEVERITY: Record<string, string> = {
  leve: 'Leve',
  moderada: 'Moderada',
  grave: 'Grave',
  critica: 'Crítica',
};

const PDF_FONT = 'LiberationSans';
const PDF_FONT_PATHS = {
  normal: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  bold: '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
} as const;

type PdfContext = { doc: jsPDF; y: number };
type AutoTableDocument = jsPDF & { lastAutoTable?: { finalY?: number } };

function registerPdfFonts(doc: jsPDF): void {
  try {
    const normal = readFileSync(PDF_FONT_PATHS.normal).toString('base64');
    const bold = readFileSync(PDF_FONT_PATHS.bold).toString('base64');
    doc.addFileToVFS('LiberationSans-Regular.ttf', normal);
    doc.addFileToVFS('LiberationSans-Bold.ttf', bold);
    doc.addFont('LiberationSans-Regular.ttf', PDF_FONT, 'normal');
    doc.addFont('LiberationSans-Bold.ttf', PDF_FONT, 'bold');
  } catch {
    // Local unit tests may not have the production font package installed.
  }
}

function clean(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-';
  const stringValue =
    typeof value === 'string'
      ? value
      : typeof value === 'number' ||
          typeof value === 'boolean' ||
          typeof value === 'bigint'
        ? value.toString()
        : value instanceof Date
          ? value.toISOString()
          : JSON.stringify(value) || '-';
  const withoutControlCharacters = Array.from(stringValue, (character) => {
    const code = character.charCodeAt(0);
    return code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
      ? ''
      : character;
  }).join('');
  return (
    withoutControlCharacters
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[–—−]/g, '-')
      .replace(/…/g, '...')
      .replace(/•/g, '-')
      .replace(/[ \t]+/g, ' ')
      .trim() || '-'
  );
}

function splitText(doc: jsPDF, value: unknown, maxWidth: number): string[] {
  const splitter = doc.splitTextToSize.bind(doc) as unknown as (
    text: string,
    size: number,
  ) => string | string[];
  const lines = splitter(clean(value), maxWidth);
  return Array.isArray(lines) ? lines : [lines];
}

function dateOnly(value: string | Date | null | undefined): string {
  if (!value) return '-';
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return clean(value);
  return `${String(parsed.getUTCDate()).padStart(2, '0')}/${String(parsed.getUTCMonth() + 1).padStart(2, '0')}/${parsed.getUTCFullYear()}`;
}

function fill(doc: jsPDF, color: Rgb) {
  doc.setFillColor(...color);
}
function stroke(doc: jsPDF, color: Rgb) {
  doc.setDrawColor(...color);
}
function text(doc: jsPDF, color: Rgb) {
  doc.setTextColor(...color);
}
function rounded(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  mode: 'F' | 'S' | 'FD',
) {
  doc.roundedRect(x, y, w, h, 2.8, 2.8, mode);
}

function pageBackground(ctx: PdfContext) {
  fill(ctx.doc, TONE.pageBg);
  ctx.doc.rect(0, 0, PAGE.width, PAGE.height, 'F');
}

function ensure(ctx: PdfContext, height: number) {
  if (ctx.y + height <= PAGE.height - PAGE.safeBottom) return;
  ctx.doc.addPage();
  pageBackground(ctx);
  ctx.y = PAGE.safeTop;
}

function drawHeader(ctx: PdfContext, arr: Arr, code: string) {
  const { doc } = ctx;
  const margin = PAGE.margin;
  const width = PAGE.width - margin * 2;
  const codeW = 58;
  const codeX = margin + width - codeW;
  const topH = 35;

  fill(doc, TONE.brand);
  doc.rect(0, 0, PAGE.width, topH, 'F');
  fill(doc, TONE.brandStrong);
  doc.rect(0, topH - 1.4, PAGE.width, 1.4, 'F');

  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(15.2);
  text(doc, [255, 255, 255]);
  doc.text('ANÁLISE DE RISCO RÁPIDA', margin, 10.2);
  doc.setFont(PDF_FONT, 'normal');
  doc.setFontSize(8.3);
  text(doc, [223, 231, 239]);
  doc.text(
    'Registro simplificado para formalização de condição observada, risco e ação imediata em campo',
    margin,
    17,
  );

  fill(doc, TONE.surface);
  rounded(doc, codeX, 5.5, codeW, 20, 'F');
  stroke(doc, TONE.borderStrong);
  doc.setLineWidth(0.35);
  rounded(doc, codeX, 5.5, codeW, 20, 'S');
  fill(doc, TONE.info);
  rounded(doc, codeX + 1.8, 7.1, codeW - 3.6, 4.2, 'F');
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(7);
  text(doc, [255, 255, 255]);
  doc.text('IDENTIFICADOR', codeX + codeW / 2, 10, { align: 'center' });
  doc.setFontSize(9.5);
  text(doc, TONE.textPrimary);
  doc.text(clean(code), codeX + codeW / 2, 16.4, { align: 'center' });
  doc.setFont(PDF_FONT, 'normal');
  doc.setFontSize(7);
  text(doc, TONE.textSecondary);
  doc.text(
    `Status: ${clean(STATUS[arr.status] || arr.status)} | V1`,
    codeX + codeW / 2,
    21.5,
    { align: 'center' },
  );

  const metadata = [
    ['Empresa', arr.company?.razao_social || arr.company_id],
    ['Site/Obra', arr.site?.nome || arr.site_id],
    ['Data de referência', dateOnly(arr.data)],
  ] as const;
  const gap = 2.4;
  const cardW = (width - gap * 2) / 3;
  const y = topH + 2.6;
  metadata.forEach(([label, value], index) => {
    const x = margin + index * (cardW + gap);
    fill(doc, TONE.surface);
    stroke(doc, TONE.border);
    doc.setLineWidth(0.24);
    rounded(doc, x, y, cardW, 15, 'FD');
    fill(doc, TONE.brand);
    doc.rect(x, y, 2.2, 15, 'F');
    doc.setFont(PDF_FONT, 'bold');
    doc.setFontSize(7);
    text(doc, TONE.textMuted);
    doc.text(label.toUpperCase(), x + 4.5, y + 4.7);
    doc.setFontSize(8.3);
    text(doc, TONE.textPrimary);
    doc.text(splitText(doc, value, cardW - 8).slice(0, 2), x + 4.5, y + 9.1);
  });
  ctx.y = 58;
}

function drawIdentity(ctx: PdfContext, arr: Arr) {
  const { doc } = ctx;
  const margin = PAGE.margin;
  const width = PAGE.width - margin * 2;
  const fields = [
    ['Tipo documental', 'ARR'],
    [
      'Criticidade',
      arr.status === ArrStatus.ARQUIVADA
        ? 'Arquivado'
        : RISK[arr.nivel_risco] || clean(arr.nivel_risco),
    ],
    ['Classe', 'Operacional'],
  ];
  const gap = 3;
  const cardW = (width - gap * 2) / 3;
  ensure(ctx, 24);
  fields.forEach(([label, value], index) => {
    const x = margin + index * (cardW + gap);
    fill(doc, TONE.surface);
    stroke(doc, TONE.border);
    doc.setLineWidth(0.24);
    rounded(doc, x, ctx.y, cardW, 20, 'FD');
    fill(doc, [
      index === 0 ? 24 : index === 1 ? 180 : 27,
      index === 0 ? 81 : index === 1 ? 95 : 94,
      index === 0 ? 124 : index === 1 ? 20 : 62,
    ]);
    rounded(doc, x + 1.6, ctx.y + 1.4, cardW - 3.2, 3.2, 'F');
    doc.setFont(PDF_FONT, 'bold');
    doc.setFontSize(7);
    text(doc, TONE.textMuted);
    doc.text(label.toUpperCase(), x + 3.4, ctx.y + 9);
    doc.setFontSize(8.3);
    text(doc, TONE.textPrimary);
    doc.text(splitText(doc, value, cardW - 8).slice(0, 2), x + 3.4, ctx.y + 14);
  });
  ctx.y += 25;
}

function drawExecutiveSummary(ctx: PdfContext, arr: Arr) {
  const { doc } = ctx;
  const margin = PAGE.margin;
  const width = PAGE.width - margin * 2;
  const metrics = [
    ['Atividade principal', clean(arr.atividade_principal), TONE.info],
    [
      'Nível de risco',
      RISK[arr.nivel_risco] || clean(arr.nivel_risco),
      arr.nivel_risco === 'alto' || arr.nivel_risco === 'critico'
        ? TONE.warning
        : TONE.brand,
    ],
    [
      'Probabilidade',
      PROBABILITY[arr.probabilidade] || clean(arr.probabilidade),
      TONE.brand,
    ],
    [
      'Severidade',
      SEVERITY[arr.severidade] || clean(arr.severidade),
      TONE.brand,
    ],
    [
      'Status',
      STATUS[arr.status] || clean(arr.status),
      arr.status === ArrStatus.TRATADA ? TONE.success : TONE.info,
    ],
    [
      'Participantes',
      String(arr.participants?.length || 0),
      arr.participants?.length ? TONE.success : TONE.warning,
    ],
  ] as const;
  const gap = 3;
  const inner = 4;
  const columns = 3;
  const cardW = (width - inner * 2 - gap * 2) / columns;
  const rows = Math.ceil(metrics.length / columns);
  const height = 14 + 9 + rows * 18 + (rows - 1) * 2.2 + 2;
  ensure(ctx, height + 5);
  fill(doc, TONE.surfaceMuted);
  stroke(doc, TONE.border);
  doc.setLineWidth(0.3);
  rounded(doc, margin, ctx.y, width, height, 'FD');
  fill(doc, TONE.brand);
  rounded(doc, margin + 1.8, ctx.y + 1.6, 30, 3.1, 'F');
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(11.6);
  text(doc, TONE.textPrimary);
  doc.text('Síntese executiva', margin + 4, ctx.y + 8.2);
  doc.setFont(PDF_FONT, 'normal');
  doc.setFontSize(8.3);
  text(doc, TONE.textSecondary);
  doc.text(
    'Registro enxuto para formalizar uma análise rápida de risco, a condição observada em campo e o tratamento imediato definido pela equipe.',
    margin + 4,
    ctx.y + 13.5,
    { maxWidth: width - 8 },
  );
  const baseY = ctx.y + 23;
  metrics.forEach(([label, value, tone], index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const x = margin + inner + col * (cardW + gap);
    const y = baseY + row * 20.2;
    fill(doc, TONE.surface);
    stroke(doc, TONE.border);
    doc.setLineWidth(0.22);
    rounded(doc, x, y, cardW, 18, 'FD');
    fill(doc, tone);
    rounded(doc, x + 1.4, y + 1.3, cardW - 2.8, 3.1, 'F');
    doc.setFont(PDF_FONT, 'bold');
    doc.setFontSize(7);
    text(doc, TONE.textMuted);
    doc.text(label.toUpperCase(), x + 2.6, y + 8.4);
    doc.setFontSize(9.5);
    text(doc, TONE.textPrimary);
    doc.text(splitText(doc, value, cardW - 7).slice(0, 2), x + 2.6, y + 14);
  });
  ctx.y += height + 9;
}

function drawMetadata(
  ctx: PdfContext,
  title: string,
  fields: Array<[string, unknown]>,
) {
  const { doc } = ctx;
  const margin = PAGE.margin;
  const width = PAGE.width - margin * 2;
  const cols = 2;
  const colW = width / cols;
  const rowH = 17;
  const titleH = 10.5;
  const height = titleH + Math.ceil(fields.length / cols) * rowH;
  ensure(ctx, height + 5);
  fill(doc, TONE.surface);
  stroke(doc, TONE.border);
  doc.setLineWidth(0.3);
  rounded(doc, margin, ctx.y, width, height, 'FD');
  fill(doc, TONE.surfaceMuted);
  rounded(doc, margin + 1.2, ctx.y + 1.2, width - 2.4, titleH - 2.4, 'F');
  fill(doc, TONE.brand);
  doc.rect(margin, ctx.y, 2.4, titleH, 'F');
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(9.5);
  text(doc, TONE.textPrimary);
  doc.text(title, margin + 5, ctx.y + 6.8);
  fields.forEach(([label, value], index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const x = margin + col * colW;
    const y = ctx.y + titleH + row * rowH;
    if (col > 0) {
      stroke(doc, TONE.border);
      doc.setLineWidth(0.2);
      doc.line(x, y, x, y + rowH);
    }
    if (row > 0) {
      stroke(doc, TONE.border);
      doc.setLineWidth(0.2);
      doc.line(margin, y, margin + width, y);
    }
    doc.setFont(PDF_FONT, 'bold');
    doc.setFontSize(7);
    text(doc, TONE.textMuted);
    doc.text(label.toUpperCase(), x + 4, y + 4.5);
    doc.setFont(PDF_FONT, 'normal');
    doc.setFontSize(9.2);
    text(doc, TONE.textPrimary);
    doc.text(splitText(doc, value, colW - 10).slice(0, 2), x + 4, y + 9.8);
  });
  ctx.y += height + 9;
}

function drawNarrative(ctx: PdfContext, title: string, value: unknown) {
  const content = clean(value);
  if (content === '-') return;
  const { doc } = ctx;
  const margin = PAGE.margin;
  const width = PAGE.width - margin * 2;
  const lines = splitText(doc, content, width - 8);
  let cursor = 0;
  while (cursor < lines.length) {
    const maxLines = Math.max(
      1,
      Math.floor((PAGE.height - PAGE.safeBottom - ctx.y - 20) / 4.6),
    );
    const chunk = lines.slice(cursor, cursor + maxLines);
    const height = 11.2 + chunk.length * 4.6 + 4.2;
    ensure(ctx, height + 4);
    fill(doc, TONE.surface);
    stroke(doc, TONE.border);
    doc.setLineWidth(0.3);
    rounded(doc, margin, ctx.y, width, height, 'FD');
    fill(doc, TONE.surfaceMuted);
    rounded(doc, margin + 1.2, ctx.y + 1.1, width - 2.4, 7.1, 'F');
    fill(doc, TONE.brand);
    doc.rect(margin, ctx.y, 2.5, 10, 'F');
    doc.setFont(PDF_FONT, 'bold');
    doc.setFontSize(9.5);
    text(doc, TONE.textPrimary);
    doc.text(
      cursor ? `${title} (continuação)` : title,
      margin + 5,
      ctx.y + 6.2,
    );
    doc.setFont(PDF_FONT, 'normal');
    doc.setFontSize(9.2);
    doc.text(chunk, margin + 4, ctx.y + 14.1);
    ctx.y += height + 9;
    cursor += chunk.length;
  }
}

function drawParticipants(ctx: PdfContext, arr: Arr) {
  if (!arr.participants?.length) return;
  ensure(ctx, 28);
  const { doc } = ctx;
  const margin = PAGE.margin;
  fill(doc, TONE.surfaceMuted);
  stroke(doc, TONE.border);
  rounded(doc, margin, ctx.y, PAGE.width - margin * 2, 10, 'FD');
  fill(doc, TONE.brand);
  doc.rect(margin, ctx.y, 2.5, 10, 'F');
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(9.5);
  text(doc, TONE.textPrimary);
  doc.text(
    `Participantes (${arr.participants.length})`,
    margin + 5,
    ctx.y + 6.5,
  );
  ctx.y += 12;
  autoTable(doc, {
    startY: ctx.y,
    margin: { left: margin + 2, right: margin + 2 },
    head: [['#', 'Nome', 'Função']],
    body: arr.participants.map((participant, index) => [
      index + 1,
      clean(participant.nome),
      clean(participant.funcao),
    ]),
    theme: 'grid',
    styles: {
      font: PDF_FONT,
      fontSize: 8.5,
      textColor: TONE.textPrimary,
      lineColor: TONE.border,
      lineWidth: 0.2,
      cellPadding: 2.2,
    },
    headStyles: {
      fillColor: TONE.surfaceMuted,
      textColor: TONE.textMuted,
      fontStyle: 'bold',
      fontSize: 7,
    },
    alternateRowStyles: { fillColor: TONE.surface },
    columnStyles: { 0: { cellWidth: 12 }, 2: { cellWidth: 52 } },
  });
  const finalY = (doc as AutoTableDocument).lastAutoTable?.finalY;
  ctx.y = (finalY || ctx.y + 22) + 9;
}

async function drawGovernance(
  ctx: PdfContext,
  code: string,
  validationUrl: string,
  hash?: string | null,
) {
  const { doc } = ctx;
  const margin = PAGE.margin;
  const width = PAGE.width - margin * 2;
  const height = 53;
  ensure(ctx, height + 4);
  fill(doc, TONE.surface);
  stroke(doc, TONE.borderStrong);
  doc.setLineWidth(0.32);
  rounded(doc, margin, ctx.y, width, height, 'FD');
  fill(doc, TONE.brand);
  doc.rect(margin, ctx.y, 2.5, 10, 'F');
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(9.5);
  text(doc, TONE.textPrimary);
  doc.text('Governança e autenticidade', margin + 5, ctx.y + 6.5);
  fill(doc, TONE.surfaceMuted);
  stroke(doc, TONE.border);
  rounded(doc, margin + 3, ctx.y + 12, width - 6, height - 15, 'FD');
  const qr = await QRCode.toDataURL(validationUrl, {
    margin: 0,
    width: 256,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
  doc.addImage(qr, 'PNG', margin + 6, ctx.y + 17, 24, 24);
  doc.setFont(PDF_FONT, 'normal');
  doc.setFontSize(8.3);
  text(doc, TONE.textSecondary);
  doc.text(
    'Valide o documento pelo QR Code ou pelo código público.',
    margin + 34,
    ctx.y + 20,
  );
  doc.setFont(PDF_FONT, 'bold');
  text(doc, TONE.brand);
  doc.text('Portal público via QR', margin + 34, ctx.y + 27);
  text(doc, TONE.textPrimary);
  doc.text(`Código: ${clean(code)}`, margin + 34, ctx.y + 34);
  if (hash) {
    doc.setFont(PDF_FONT, 'normal');
    doc.setFontSize(7);
    text(doc, TONE.textMuted);
    doc.text(`Hash: ${clean(hash).slice(0, 32)}...`, margin + 34, ctx.y + 40);
  }
  fill(doc, TONE.success);
  rounded(doc, margin + width - 20, ctx.y + height - 10.5, 14, 6.4, 'F');
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(7);
  text(doc, [255, 255, 255]);
  doc.text('VÁLIDO', margin + width - 13, ctx.y + height - 6, {
    align: 'center',
  });
  ctx.y += height + 9;
}

function drawFooter(
  doc: jsPDF,
  code: string,
  generatedAt: string,
  issuer?: string,
) {
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    stroke(doc, TONE.border);
    doc.setLineWidth(0.25);
    doc.line(PAGE.margin, 283.5, PAGE.width - PAGE.margin, 283.5);
    doc.setFont(PDF_FONT, 'bold');
    doc.setFontSize(7);
    text(doc, TONE.textSecondary);
    doc.text(
      clean(issuer || 'SGS - Sistema de Gestão de Segurança'),
      PAGE.margin,
      288.7,
    );
    doc.setFont(PDF_FONT, 'normal');
    doc.text(`Gerado em ${dateOnly(generatedAt)}`, PAGE.margin, 292.7);
    doc.setFont(PDF_FONT, 'bold');
    doc.text(`ID: ${clean(code)}`, PAGE.width - PAGE.margin, 288.7, {
      align: 'right',
    });
    doc.setFont(PDF_FONT, 'normal');
    doc.text(`Página ${page} de ${pages}`, PAGE.width - PAGE.margin, 292.7, {
      align: 'right',
    });
  }
}

export async function generateOfficialArrPdf(
  arr: Arr,
  code: string,
  validationUrl: string,
  generatedAt: string,
): Promise<Buffer> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  registerPdfFonts(doc);
  const ctx: PdfContext = { doc, y: PAGE.safeTop };
  pageBackground(ctx);
  drawHeader(ctx, arr, code);
  drawIdentity(ctx, arr);
  drawExecutiveSummary(ctx, arr);
  drawMetadata(ctx, 'Contexto documental', [
    ['Título', arr.titulo],
    ['Empresa', arr.company?.razao_social || arr.company_id],
    ['Data', dateOnly(arr.data)],
    ['Site / Obra', arr.site?.nome || arr.site_id],
    ['Frente de trabalho', arr.frente_trabalho],
    ['Responsável', arr.responsavel?.nome || arr.responsavel_id],
    ['Data do documento', dateOnly(arr.data)],
    // Historical field records keep the real persistence timestamp in the
    // audit trail, while the visible document date remains the work date.
    ['Emissão do documento', dateOnly(arr.data)],
  ]);
  if (
    arr.document_code ||
    arr.final_pdf_hash_sha256 ||
    arr.pdf_generated_at ||
    arr.emitted_by
  ) {
    drawMetadata(ctx, 'Rastreabilidade do PDF final', [
      ['Código documental', code],
      [
        'Hash SHA-256 do PDF',
        arr.final_pdf_hash_sha256
          ? `${arr.final_pdf_hash_sha256.slice(0, 32)}...`
          : 'Gerado no registro governado após emissão',
      ],
      ['PDF gerado em', dateOnly(arr.data)],
      ['Emitido por', arr.emitted_by?.nome],
    ]);
  }
  drawNarrative(ctx, 'Descrição / contexto', arr.descricao);
  drawNarrative(ctx, 'Condição observada', arr.condicao_observada);
  drawNarrative(ctx, 'Risco identificado', arr.risco_identificado);
  drawNarrative(ctx, 'Controles imediatos', arr.controles_imediatos);
  drawNarrative(ctx, 'Ação recomendada', arr.acao_recomendada);
  drawNarrative(ctx, 'EPIs e EPCs aplicáveis', arr.epi_epc_aplicaveis);
  drawNarrative(ctx, 'Observações', arr.observacoes);
  drawParticipants(ctx, arr);
  await drawGovernance(ctx, code, validationUrl, arr.final_pdf_hash_sha256);
  drawFooter(doc, code, generatedAt, arr.emitted_by?.nome);
  return Buffer.from(doc.output('arraybuffer'));
}
