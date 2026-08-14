/**
 * Preview local do PDF de Relatório Fotográfico.
 *
 * PARA QUE SERVE
 *   O PDF oficial é gerado por Puppeteer dentro do container, e cada deploy
 *   leva de 8 a 12 minutos por causa do Chromium. Este script renderiza o mesmo
 *   HTML com dados fictícios e escreve PDF + PNGs, permitindo iterar no layout
 *   em segundos.
 *
 * COMO RODAR
 *   cd backend && npx ts-node -T scripts/preview-photographic-report-pdf.ts
 *
 * LIMITE HONESTO
 *   Fontes, quebra de página e decodificação de imagem se comportam diferente
 *   no Chromium do container. Este preview valida ESTRUTURA e conteúdo, não
 *   substitui a conferência do PDF emitido em ambiente real.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import puppeteer from 'puppeteer';
import QRCode from 'qrcode';
import { buildPhotographicReportCode } from '../src/modules/photographic-reports/photographic-reports.document-code';
import { buildPhotographicReportHtml } from '../src/modules/photographic-reports/photographic-reports.renderer';

/** Raiz do repositório, resolvida a partir deste arquivo. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Assinatura manuscrita fictícia como data URI.
 *
 * Em produção a imagem vem do storage via `resolveSignatureData` — assinaturas
 * desenhadas passam de 4 KB e são offloaded para o S3, então `signature_data`
 * chega nulo. Aqui um SVG inline exercita o mesmo caminho de renderização.
 */
const SAMPLE_SIGNATURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 90">
  <path d="M12 62 C 34 18, 52 20, 58 46 C 63 68, 78 70, 88 50 C 96 34, 108 30, 116 44 C 124 58, 140 60, 152 44 C 166 26, 184 30, 190 50 C 196 70, 214 68, 228 48 C 240 30, 262 30, 276 46 C 286 58, 298 58, 308 48"
        fill="none" stroke="%230f2036" stroke-width="3.2" stroke-linecap="round"/>
  <path d="M96 74 C 140 66, 200 66, 250 72" fill="none" stroke="%230f2036" stroke-width="1.6" stroke-linecap="round" opacity="0.75"/>
</svg>`;

const sampleSignatureImage = `data:image/svg+xml;utf8,${SAMPLE_SIGNATURE_SVG.replace(/\n\s*/g, ' ').replace(/#/g, '%23')}`;

/** Sobrescreva com PREVIEW_OUT_DIR para escrever fora do repositório. */
const OUT_DIR = process.env.PREVIEW_OUT_DIR
  ? path.resolve(process.env.PREVIEW_OUT_DIR)
  : REPO_ROOT;
const SHOT_DIR = process.env.PREVIEW_SHOT_DIR
  ? path.resolve(process.env.PREVIEW_SHOT_DIR)
  : OUT_DIR;

/**
 * Imagem de teste. Qualquer PNG serve — o preview valida enquadramento e
 * moldura, não o conteúdo da foto. Sem arquivo, os cards renderizam o estado
 * "sem foto", que também é um caminho que vale conferir.
 */
const photoPath =
  process.env.PREVIEW_PHOTO ||
  path.join(REPO_ROOT, 'report-upload.png');
const photoDataUrl = fs.existsSync(photoPath)
  ? `data:image/png;base64,${fs.readFileSync(photoPath).toString('base64')}`
  : null;

const day1 = {
  id: 'day-1',
  report_id: 'rep-1',
  activity_date: '2026-08-08',
  day_summary: 'Inspeção matinal da frente de loja e área de carga.',
  created_at: '2026-08-08T08:00:00Z',
  updated_at: '2026-08-08T08:00:00Z',
};

function img(over: Record<string, unknown>) {
  return {
    id: 'img',
    report_id: 'rep-1',
    report_day_id: 'day-1',
    image_url: 'x',
    download_url: null,
    image_order: 1,
    manual_caption: null,
    ai_title: null,
    ai_description: null,
    ai_positive_points: null,
    ai_technical_assessment: null,
    ai_condition_classification: null,
    ai_recommendations: null,
    photo_conditions: null,
    is_nonconformity: false,
    recommended_action: null,
    action_deadline: null,
    action_responsible: null,
    original_name: 'foto-inspecao.jpg',
    mime_type: 'image/jpeg',
    file_size_bytes: 248113,
    hash_sha256:
      'a3f1c9d24b7e8051f6c2a90d3e5b71482c6d0f9a1b3e5c7d9f0a2b4c6d8e0f12',
    captured_at: '2026-08-08T08:05:00Z',
    latitude: -23.56,
    longitude: -46.64,
    accuracy_m: 12.5,
    exif_datetime: null,
    integrity_flags: {
      gps: true,
      accuracy: true,
      device: false,
      ip: true,
      exif: false,
      client_reencoded: true,
    },
    created_at: '2026-08-08T08:00:00Z',
    updated_at: '2026-08-08T08:00:00Z',
    data_url: photoDataUrl,
    activity_date_label: '2026-08-08',
    ...over,
  } as never;
}

const report = {
  id: 'c283fe18-cdbd-4413-8247-e5e8bd064405',
  company_id: 'comp-1',
  client_id: null,
  project_id: null,
  client_name: 'Gandra Tecnologia',
  project_name: 'Loja Centro — Manutenção Preventiva',
  unit_name: 'Unidade Centro',
  location: 'Área de carga e descarga',
  activity_type: 'Inspeção de Segurança',
  report_tone: 'Técnico',
  area_status: 'Loja aberta',
  shift: 'Diurno',
  start_date: '2026-08-08',
  end_date: null,
  start_time: '08:00',
  end_time: '17:00',
  responsible_name: 'Wanderson Rodrigues Gandra',
  responsible_registration_type: 'CREA',
  responsible_registration_number: '5069874521',
  responsible_registration_state: 'SP',
  art_number: 'ART-2026-0004512',
  contractor_company: 'Gandra Tecnologia',
  applicable_nrs: ['NR-06', 'NR-12', 'NR-26', 'NR-35'],
  inspection_methodology:
    'Inspeção visual planejada da frente de serviço, com percurso da área de carga até a fachada, registro fotográfico sequencial e conferência dos EPIs em uso pela equipe. Não foram executados ensaios instrumentais nem medições atmosféricas.',
  scope_and_limitations:
    'O escopo abrange exclusivamente as áreas acessíveis durante o turno diurno e as frentes de serviço em execução no momento da visita. Não contempla instalações elétricas energizadas, cobertura, nem áreas sob responsabilidade de terceiros. As conclusões referem-se às condições observadas na data do registro.',
  general_observations:
    'Inspeção realizada com a loja em operação. Equipe de manutenção atuando na área de carga com isolamento parcial. Fluxo de clientes desviado conforme procedimento.',
  ai_summary:
    'A inspeção identificou aderência geral às práticas de segurança. Os colaboradores utilizavam EPIs adequados e a sinalização de área estava conforme. Recomenda-se atenção contínua ao isolamento da zona de circulação de clientes durante os trabalhos em altura.',
  final_conclusion:
    'As condições observadas são satisfatórias e compatíveis com os requisitos das NR-06, NR-12 e NR-35. Não foram identificadas não conformidades que exijam paralisação. Mantém-se a recomendação de reforço na delimitação física da área de trabalho.',
  status: 'Exportado',
  created_by: null,
  created_at: '2026-08-08T08:00:00Z',
  updated_at: '2026-08-08T08:00:00Z',
  day_count: 1,
  image_count: 3,
  export_count: 2,
  last_exported_at: '2026-08-08T09:00:00Z',
  // Emissão anterior existente, para exercitar o rótulo "Hash da emissão
  // anterior" no bloco de governança.
  verification_code: 'RFP-2026-C283FE18',
  final_pdf_hash_sha256:
    'b7e2d4f60a1c8395e2f4a6b8c0d2e4f60819a3b5c7d9e1f30527496a8b0c2d4e',
  pdf_generated_at: '2026-08-08T09:00:00Z',
  days: [day1],
  images: [],
  exports: [
    {
      id: 'e1',
      report_id: 'rep-1',
      export_type: 'pdf',
      file_url: 'x',
      download_url: null,
      generated_by: null,
      generated_at: '2026-08-08T09:00:00Z',
    },
    {
      id: 'e2',
      report_id: 'rep-1',
      export_type: 'word',
      file_url: 'x',
      download_url: null,
      generated_by: null,
      generated_at: '2026-08-08T09:30:00Z',
    },
  ],
} as never;

const renderableImages = [
  img({
    id: 'i1',
    image_order: 1,
    ai_title: 'Uso correto de EPIs pela equipe',
    ai_description:
      'Colaboradores executando manutenção com capacete, óculos de proteção e calçado de segurança. Cinto de segurança tipo paraquedista ancorado em ponto fixo certificado.',
    ai_condition_classification: 'Muito satisfatória',
    ai_positive_points: [
      'EPIs completos e em bom estado de conservação',
      'Ancoragem em ponto fixo certificado',
      'Área sinalizada com cones e fita zebrada',
    ],
    ai_technical_assessment:
      'Conformidade plena com NR-06 e NR-35. Não há exposição a risco de queda não controlado.',
    photo_conditions: [
      'EPIs em uso pelos trabalhadores',
      'Área devidamente sinalizada',
      'Conformidade com NR aplicável',
    ],
  }),
  img({
    id: 'i2',
    image_order: 2,
    ai_title: 'Sinalização da área de circulação',
    ai_description:
      'Delimitação da zona de trabalho com fita zebrada. Fluxo de clientes desviado por corredor alternativo.',
    ai_condition_classification: 'Ponto de atenção preventivo',
    ai_positive_points: ['Sinalização visível a distância'],
    ai_technical_assessment:
      'A fita zebrada delimita mas não impede fisicamente o acesso. Recomenda-se barreira rígida.',
    ai_recommendations: [
      'Substituir fita zebrada por barreira rígida articulada',
      'Posicionar vigia na entrada do corredor durante o turno',
    ],
    photo_conditions: ['Área devidamente sinalizada'],
    manual_caption: 'Corredor lateral — acesso de clientes',
    // Foto marcada como não conformidade, para exercitar o resumo, o badge e
    // o bloco de tratativa dentro do card.
    is_nonconformity: true,
    recommended_action:
      'Substituir a fita zebrada por barreira rígida articulada e posicionar vigia na entrada do corredor durante todo o turno.',
    action_deadline: '2026-09-01',
    action_responsible: 'Equipe de manutenção — Carlos Menezes',
    original_name: 'corredor-lateral.jpg',
    file_size_bytes: 1_842_000,
  }),
  img({
    id: 'i3',
    image_order: 3,
    ai_title: 'Organização de ferramentas e materiais',
    ai_condition_classification: 'Satisfatória',
    ai_description:
      'Ferramentas acondicionadas em maleta própria. Materiais empilhados de forma estável fora da rota de fuga.',
    photo_conditions: [
      'Procedimentos seguidos corretamente',
      'Área devidamente sinalizada',
    ],
  }),
] as never;

async function main() {
  // QR real, gerado com as mesmas opções que o serviço usa.
  const qrDataUri = await QRCode.toDataURL(
    'https://app.sgsseguranca.com.br/validar/RFP-2026-C283FE18?token=abc123',
    {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 256,
      color: { dark: '#0F2036', light: '#FFFFFF' },
    },
  );

  const html = buildPhotographicReportHtml(report, {
    companyIdentity: {
      razaoSocial: 'Gandra Tecnologia LTDA',
      cnpj: '12345678000190',
    },
    clientName: 'Gandra Tecnologia',
    documentCode: buildPhotographicReportCode(report),
    generatedAt: '2026-08-08T09:45:00Z',
    renderableImages,
    logoDataUrl: null,
    validation: {
      url: 'https://app.sgsseguranca.com.br/validar/RFP-2026-C283FE18?token=abc123',
      qrDataUri: qrDataUri,
    },
    signatures: [
      {
        signerName: 'Wanderson Rodrigues Gandra',
        signerRole: 'Engenheiro de Segurança do Trabalho',
        type: 'hmac',
        signedAt: '2026-08-08T09:40:00Z',
        signatureHash:
          'a3f1c9d24b7e8051f6c2a90d3e5b71482c6d0f9a1b3e5c7d9f0a2b4c6d8e0f12',
        signatureImage: null,
      },
      {
        signerName: 'Maria Souza',
        signerRole: 'Responsável pela obra',
        type: 'digital',
        signedAt: '2026-08-08T09:42:00Z',
        signatureHash:
          'b7e2d4f60a1c8395e2f4a6b8c0d2e4f60819a3b5c7d9e1f30527496a8b0c2d4e',
        // Assinatura desenhada: exercita o caminho da imagem no documento.
        signatureImage: sampleSignatureImage,
      },
    ],
  });

  fs.writeFileSync(
    path.join(OUT_DIR, 'RELATORIO-FOTOGRAFICO-PREVIEW.html'),
    html,
    'utf8',
  );

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1300, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });

  await page.pdf({
    path: path.join(OUT_DIR, 'RELATORIO-FOTOGRAFICO-PREVIEW.pdf'),
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });

  // screenshots por faixa vertical para inspecao visual
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  const slice = 1250;
  const shots = Math.min(Math.ceil(height / slice), 6);
  for (let i = 0; i < shots; i++) {
    await page.screenshot({
      path: path.join(SHOT_DIR, `preview-${i + 1}.png`),
      clip: {
        x: 0,
        y: i * slice,
        width: 900,
        height: Math.min(slice, height - i * slice),
      },
    });
  }

  await browser.close();
  console.log(`OK height=${height} shots=${shots}`);
}

void main();
