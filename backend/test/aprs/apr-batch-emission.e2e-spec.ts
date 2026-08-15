import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFParse } from 'pdf-parse';
import { AprStatus } from '../../src/modules/aprs/entities/apr.entity';
import { Role } from '../../src/modules/auth/enums/roles.enum';
import { createTestApr, type AprBody } from '../helpers/apr-test.factory';
import { TestApp, type LoginSession } from '../helpers/test-app';

const describeE2E =
  process.env.E2E_INFRA_AVAILABLE === 'false' ? describe.skip : describe;

type PdfAccessBody = {
  availability?: string;
  url?: string | null;
  fileKey?: string | null;
  hasFinalPdf?: boolean;
};

type GeneratedApr = {
  id: string;
  number: string;
};

const SAMPLE_SIGNATURE_IMAGE =
  'data:image/png;base64,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';
const BATCH_SIZE = Number(process.env.APR_BATCH_EMISSION_COUNT || 3);
const BATCH_TIMEOUT_MS = Math.max(180_000, BATCH_SIZE * 60_000);
const SAMPLE_PDF_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'output',
  'pdf',
  'apr-final-e2e-sample.pdf',
);
const EXPECTED_SAMPLE_PDF_TEXTS = [
  'APR - ANÁLISE PRELIMINAR DE RISCOS',
  'APR-BATCH-001',
  'APR lote governado 1',
  'Tenant A SST LTDA',
  '11222333000181',
  'Site A',
  '22/05/2026',
  '23/05/2026',
  'Tecnico A',
  'Técnico de Segurança do Trabalho',
  'Administrador da empresa',
  'CARGO / FUNÇÃO',
  'Assinado',
  'Aprovado',
  'Assinatura desenhada',
  'Imagem da assinatura registrada',
  'Admin A',
  'Operação de rotina',
  'Ruído',
  'Exposição eventual',
  'Linha de produção',
  'Perda auditiva',
  'Uso de EPI e monitoramento',
  'Técnico SST',
  'Aprovada',
  'APR validada para emissão em lote.',
  'Assinaturas registradas',
  'Autenticidade e rastreabilidade',
];

jest.setTimeout(BATCH_TIMEOUT_MS);

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text.replace(/\s+/g, ' ').trim();
  } finally {
    await parser.destroy();
  }
}

describeE2E('E2E — APR batch final PDF emission', () => {
  let testApp: TestApp;
  let creatorSession: LoginSession;
  let approverSession: LoginSession;
  let csrfHeaders: Record<string, string>;
  let siteId: string;
  let elaboradorId: string;

  beforeAll(async () => {
    testApp = await TestApp.create();
    await testApp.resetDatabase();

    creatorSession = await testApp.loginAs(Role.TST, 'tenantA');
    approverSession = await testApp.loginAs(Role.ADMIN_EMPRESA, 'tenantA');
    csrfHeaders = await testApp.csrfHeaders();

    siteId = testApp.getTenant('tenantA').siteId;
    elaboradorId = testApp.getUser('tenantA', Role.TST).id;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('cria, assina, aprova e emite PDF final governado para várias APRs', async () => {
    expect(Number.isFinite(BATCH_SIZE)).toBe(true);
    expect(BATCH_SIZE).toBeGreaterThan(0);

    const generatedAprs: GeneratedApr[] = [];

    for (let index = 0; index < BATCH_SIZE; index += 1) {
      const aprNumber = `APR-BATCH-${String(index + 1).padStart(3, '0')}`;
      const apr = await createTestApr(testApp, creatorSession, {
        numero: aprNumber,
        titulo: `APR lote governado ${index + 1}`,
        siteId,
        elaboradorId,
        participantIds: [elaboradorId, approverSession.userId],
        dataInicio: '2026-05-22',
        dataFim: '2026-05-23',
      });

      const creatorSignatureRes = await testApp
        .request()
        .post('/signatures')
        .set(testApp.authHeaders(creatorSession))
        .set(csrfHeaders)
        .send({
          document_id: apr.id,
          document_type: 'APR',
          signature_data: SAMPLE_SIGNATURE_IMAGE,
          type: 'drawn',
        });
      expect(creatorSignatureRes.status).toBe(201);

      const approverSignatureRes = await testApp
        .request()
        .post('/signatures')
        .set(testApp.authHeaders(approverSession))
        .set(csrfHeaders)
        .send({
          document_id: apr.id,
          document_type: 'APR',
          signature_data: SAMPLE_SIGNATURE_IMAGE,
          type: 'drawn',
        });
      expect(approverSignatureRes.status).toBe(201);

      const approveRes = await testApp
        .request()
        .patch(`/aprs/${apr.id}/approve`)
        .set(testApp.authHeaders(approverSession))
        .set(csrfHeaders)
        .send({ reason: 'APR validada para emissão em lote.' });
      expect([200, 201]).toContain(approveRes.status);
      expect((approveRes.body as AprBody).status).toBe(AprStatus.APROVADA);

      const generateRes = await testApp
        .request()
        .post(`/aprs/${apr.id}/generate-final-pdf`)
        .set(testApp.authHeaders(approverSession))
        .set(csrfHeaders);
      expect([200, 201]).toContain(generateRes.status);
      expect((generateRes.body as PdfAccessBody).hasFinalPdf).toBe(true);

      const accessRes = await testApp
        .request()
        .get(`/aprs/${apr.id}/pdf`)
        .set(testApp.authHeaders(approverSession));
      expect(accessRes.status).toBe(200);

      const accessBody = accessRes.body as PdfAccessBody;
      expect(accessBody.hasFinalPdf).toBe(true);
      expect(accessBody.availability).toBe('ready');
      expect(accessBody.fileKey).toBeUndefined();
      expect(typeof accessBody.url).toBe('string');

      generatedAprs.push({
        id: apr.id,
        number: aprNumber,
      });

      console.info(
        `[apr-batch-emission] ${index + 1}/${BATCH_SIZE} APR emitida: ${aprNumber}`,
      );
    }

    expect(generatedAprs).toHaveLength(BATCH_SIZE);

    const sampleAccessRes = await testApp
      .request()
      .get(`/aprs/${generatedAprs[0].id}/pdf`)
      .set(testApp.authHeaders(approverSession));
    const sampleAccess = sampleAccessRes.body as PdfAccessBody;
    const sampleDownloadUrl = String(sampleAccess.url || '');
    const sampleDownloadPath = sampleDownloadUrl.startsWith('http')
      ? (() => {
          const parsed = new URL(sampleDownloadUrl);
          return `${parsed.pathname}${parsed.search}`;
        })()
      : sampleDownloadUrl;

    const anonymousDownloadRes = await testApp
      .request()
      .get(sampleDownloadPath);
    expect(anonymousDownloadRes.status).toBe(403);

    const downloadRes = await testApp
      .request()
      .get(sampleDownloadPath)
      .set(testApp.authHeaders(approverSession));
    expect(downloadRes.status).toBe(200);
    expect(String(downloadRes.headers['content-type'] || '')).toContain(
      'application/pdf',
    );
    expect(downloadRes.body).toBeInstanceOf(Buffer);
    const samplePdfBuffer = downloadRes.body as Buffer;
    expect(samplePdfBuffer.byteLength).toBeGreaterThan(10_000);

    await mkdir(resolve(SAMPLE_PDF_PATH, '..'), { recursive: true });
    await writeFile(SAMPLE_PDF_PATH, samplePdfBuffer);

    const samplePdfText = await extractPdfText(samplePdfBuffer);
    for (const expectedText of EXPECTED_SAMPLE_PDF_TEXTS) {
      expect(samplePdfText).toContain(expectedText);
    }
    expect(samplePdfText).not.toContain(
      'Nenhum item de risco estruturado disponível.',
    );

    console.info(
      `[apr-batch-emission] PDF amostra salvo em: ${SAMPLE_PDF_PATH}`,
    );
  });
});
