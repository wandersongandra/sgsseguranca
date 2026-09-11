import { Role } from '../../src/modules/auth/enums/roles.enum';
import { AprStatus } from '../../src/modules/aprs/entities/apr.entity';
import { createApr } from '../factories/apr.factory';
import { TestApp, type LoginSession } from '../helpers/test-app';

const describeE2E =
  process.env.E2E_INFRA_AVAILABLE === 'false' ? describe.skip : describe;

// ---------------------------------------------------------------------------
// Tipos auxiliares — inferência segura dos corpos de resposta da API
// ---------------------------------------------------------------------------
type AprBody = {
  id?: string;
  status?: string;
  titulo?: string;
  codigo?: string;
  numero?: string;
  parent_apr_id?: string | null;
  pdf_file_key?: string | null;
  versao?: number;
  reprovado_motivo?: string;
  deleted_at?: string | null;
};

type PageBody<T = AprBody> = {
  data?: T[];
  total?: number;
  page?: number;
  lastPage?: number;
};

type PdfAccessBody = {
  availability?: string;
  url?: string | null;
  fileKey?: string | null;
  hasFinalPdf?: boolean;
};

// ---------------------------------------------------------------------------
// IMPORTANTE — mapeamento dos nomes reais de status (diferem do enunciado):
//   "FINALIZADA" no enunciado → AprStatus.ENCERRADA ('Encerrada') no código
//   "REPROVADA"  no enunciado → AprStatus.CANCELADA ('Cancelada') no código
//
// Transições permitidas:
//   PENDENTE  → APROVADA  (PATCH /aprs/:id/approve)
//   PENDENTE  → CANCELADA (PATCH /aprs/:id/reject)
//   APROVADA  → ENCERRADA (PATCH /aprs/:id/finalize)
//   APROVADA  → CANCELADA (PATCH /aprs/:id/reject)
//   CANCELADA → (nenhuma — terminal)
//   ENCERRADA → (nenhuma — terminal)
//
// new-version: exige status APROVADA (não Encerrada). A nova versão inicia
// como PENDENTE e recebe parent_apr_id apontando para a APR original.
// ---------------------------------------------------------------------------

describeE2E('E2E Critical - APR lifecycle', () => {
  let testApp: TestApp;

  // Sessões reutilizadas entre flows — evita múltiplos roundtrips de login
  let adminSession: LoginSession;
  let tstSession: LoginSession;
  let csrfHeaders: Record<string, string>;

  // IDs compartilhados entre flows
  let aprEncerradaId: string; // APR Encerrada do Fluxo 1

  beforeAll(async () => {
    testApp = await TestApp.create();
    await testApp.resetDatabase();

    adminSession = await testApp.loginAs(Role.ADMIN_EMPRESA, 'tenantA');
    tstSession = await testApp.loginAs(Role.TST, 'tenantA');
    csrfHeaders = await testApp.csrfHeaders();
  });

  afterAll(async () => {
    await testApp.close();
  });

  // =========================================================================
  // Fluxo 1 — Ciclo completo: Pendente → Aprovada → Encerrada
  //           Inclui cobertura de CRUD, paginação e soft delete.
  // =========================================================================
  describe('Fluxo 1 — Ciclo completo (Pendente → Aprovada → Encerrada)', () => {
    let aprId: string;

    it('1.1 POST /aprs → cria APR com status Pendente', async () => {
      const tenantA = testApp.getTenant('tenantA');
      const tst = testApp.getUser('tenantA', Role.TST);

      const apr = await createApr(testApp, tstSession, {
        numero: 'APR-LIFE-001',
        titulo: 'APR Ciclo Completo',
        siteId: tenantA.siteId,
        elaboradorId: tst.id,
      });

      expect(apr.id).toBeTruthy();
      expect(apr.status).toBe(AprStatus.PENDENTE);
      aprId = apr.id;
    });

    it('1.2 PATCH /aprs/:id → atualiza título da APR Pendente', async () => {
      const res = await testApp
        .request()
        .patch(`/aprs/${aprId}`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders)
        .send({ titulo: 'APR Ciclo Completo Revisada' });

      const body = res.body as AprBody;
      expect(res.status).toBe(200);
      expect(body.titulo).toBe('APR Ciclo Completo Revisada');
    });

    it('1.3 GET /aprs?page=1&limit=5 → APR aparece na listagem paginada', async () => {
      const res = await testApp
        .request()
        .get('/aprs?page=1&limit=5')
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders);

      const body = res.body as PageBody;
      const items = Array.isArray(body.data) ? body.data : [];

      expect(res.status).toBe(200);
      expect(typeof body.total).toBe('number');
      expect(body.page).toBe(1);
      expect(typeof body.lastPage).toBe('number');
      expect(items.some((item) => item.id === aprId)).toBe(true);
    });

    it('1.4 PATCH /aprs/:id/approve → Pendente → Aprovada', async () => {
      const signatureRes = await testApp
        .request()
        .post('/signatures')
        .set(testApp.authHeaders(tstSession))
        .set(csrfHeaders)
        .send({
          document_id: aprId,
          document_type: 'APR',
          signature_data: 'assinatura-e2e-apr-life-finalize',
          type: 'drawn',
        });

      expect(signatureRes.status).toBe(201);

      const res = await testApp
        .request()
        .patch(`/aprs/${aprId}/approve`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders)
        .send({ reason: 'Documentação completa e revisada' });

      const body = res.body as AprBody;
      expect([200, 201]).toContain(res.status);
      expect(body.status).toBe(AprStatus.APROVADA);
    });

    it('1.5 PATCH /aprs/:id/finalize → exige PDF final e encerra Aprovada → Encerrada', async () => {
      const genRes = await testApp
        .request()
        .post(`/aprs/${aprId}/generate-final-pdf`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders);

      const genBody = genRes.body as PdfAccessBody & { generated?: boolean };
      expect([200, 201]).toContain(genRes.status);
      expect(genBody.hasFinalPdf).toBe(true);
      expect(genBody.fileKey).toMatch(/^documents\/.+\.pdf$/i);

      const res = await testApp
        .request()
        .patch(`/aprs/${aprId}/finalize`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders);

      const body = res.body as AprBody;
      expect([200, 201]).toContain(res.status);
      expect(body.status).toBe(AprStatus.ENCERRADA);

      aprEncerradaId = aprId; // compartilhado com Fluxo 3 e 4
    });

    it('1.6 GET /aprs/:id → APR encerrada persiste com status correto', async () => {
      const res = await testApp
        .request()
        .get(`/aprs/${aprId}`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders);

      const body = res.body as AprBody;
      expect(res.status).toBe(200);
      expect(body.id).toBe(aprId);
      expect(body.status).toBe(AprStatus.ENCERRADA);
    });

    it('1.7 POST /aprs/:id/generate-final-pdf → gera PDF para APR aprovada e assinada', async () => {
      const tenantA = testApp.getTenant('tenantA');
      const tst = testApp.getUser('tenantA', Role.TST);

      const pdfApr = await createApr(testApp, tstSession, {
        numero: 'APR-LIFE-PDF-001',
        titulo: 'APR Para PDF Final',
        siteId: tenantA.siteId,
        elaboradorId: tst.id,
      });

      const signatureRes = await testApp
        .request()
        .post('/signatures')
        .set(testApp.authHeaders(tstSession))
        .set(csrfHeaders)
        .send({
          document_id: pdfApr.id,
          document_type: 'APR',
          signature_data: 'assinatura-e2e-apr-pdf-final',
          type: 'drawn',
        });

      expect(signatureRes.status).toBe(201);

      const approveRes = await testApp
        .request()
        .patch(`/aprs/${pdfApr.id}/approve`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders)
        .send({ reason: 'Assinada e pronta para PDF final' });

      expect([200, 201]).toContain(approveRes.status);

      const genRes = await testApp
        .request()
        .post(`/aprs/${pdfApr.id}/generate-final-pdf`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders);

      expect([200, 201]).toContain(genRes.status);

      const aprRes = await testApp
        .request()
        .get(`/aprs/${pdfApr.id}`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders);

      expect(aprRes.status).toBe(200);
      expect((aprRes.body as AprBody).id).toBe(pdfApr.id);

      const pdfAccessRes = await testApp
        .request()
        .get(`/aprs/${pdfApr.id}/pdf`)
        .set(testApp.authHeaders(adminSession));
      const pdfAccessBody = pdfAccessRes.body as PdfAccessBody;

      expect(pdfAccessRes.status).toBe(200);
      expect(pdfAccessBody.hasFinalPdf).toBe(true);
      expect(pdfAccessBody.availability).toBe('ready');
      expect(pdfAccessBody.fileKey).toMatch(/^documents\/.+\.pdf$/i);
      expect(typeof pdfAccessBody.url).toBe('string');

      const downloadUrl = String(pdfAccessBody.url || '');
      const downloadPath = downloadUrl.startsWith('http')
        ? (() => {
            const parsed = new URL(downloadUrl);
            return `${parsed.pathname}${parsed.search}`;
          })()
        : downloadUrl;

      const anonymousDownloadRes = await testApp.request().get(downloadPath);
      expect(anonymousDownloadRes.status).toBe(403);

      const downloadRes = await testApp
        .request()
        .get(downloadPath)
        .set(testApp.authHeaders(adminSession));

      expect(downloadRes.status).toBe(200);
      expect(String(downloadRes.headers['content-type'] || '')).toContain(
        'application/pdf',
      );
      expect(
        String(downloadRes.headers['content-disposition'] || ''),
      ).toContain('.pdf');
      expect(downloadRes.body).toBeInstanceOf(Buffer);
      expect((downloadRes.body as Buffer).byteLength).toBeGreaterThan(32);

      const replayRes = await testApp
        .request()
        .get(downloadPath)
        .set(testApp.authHeaders(adminSession));
      expect(replayRes.status).toBe(403);

      const finalizeRes = await testApp
        .request()
        .patch(`/aprs/${pdfApr.id}/finalize`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders);

      expect([200, 201]).toContain(finalizeRes.status);
      expect((finalizeRes.body as AprBody).status).toBe(AprStatus.ENCERRADA);
    });

    it('1.8 Soft delete: DELETE /aprs/:id e confirmação via query SQL', async () => {
      const tenantA = testApp.getTenant('tenantA');
      const tst = testApp.getUser('tenantA', Role.TST);

      const toDelete = await createApr(testApp, tstSession, {
        numero: 'APR-LIFE-DELETE-001',
        titulo: 'APR Para Soft Delete',
        siteId: tenantA.siteId,
        elaboradorId: tst.id,
      });

      const delRes = await testApp
        .request()
        .delete(`/aprs/${toDelete.id}`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders);

      expect(delRes.status).toBe(200);

      // API deve retornar 404 para registro soft-deleted
      const getRes = await testApp
        .request()
        .get(`/aprs/${toDelete.id}`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders);

      expect(getRes.status).toBe(404);

      // Confirma via SQL que deleted_at foi preenchido (soft delete real)
      const rows: Array<{ id: string; deleted_at: string | null }> =
        await testApp.setupQuery(
          'SELECT id, deleted_at FROM aprs WHERE id = $1',
          [toDelete.id],
        );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.deleted_at).toBeTruthy();
    });
  });

  // =========================================================================
  // Fluxo 2 — Rejeição: Pendente → Cancelada + bloqueio de transições inválidas
  // =========================================================================
  describe('Fluxo 2 — Rejeição e transições inválidas', () => {
    let aprCancelableId: string;

    beforeAll(async () => {
      const tenantA = testApp.getTenant('tenantA');
      const tst = testApp.getUser('tenantA', Role.TST);

      const apr = await createApr(testApp, tstSession, {
        numero: 'APR-REJECT-001',
        titulo: 'APR Para Rejeição',
        siteId: tenantA.siteId,
        elaboradorId: tst.id,
      });
      aprCancelableId = apr.id;
    });

    it('2.1 PATCH /aprs/:id/reject sem motivo → 400 (body.reason obrigatório)', async () => {
      const res = await testApp
        .request()
        .patch(`/aprs/${aprCancelableId}/reject`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders)
        .send({});

      expect(res.status).toBe(400);
    });

    it('2.2 PATCH /aprs/:id/reject com motivo → Pendente → Cancelada', async () => {
      const res = await testApp
        .request()
        .patch(`/aprs/${aprCancelableId}/reject`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders)
        .send({
          reason: 'Documentação incompleta: falta ART do responsável técnico',
        });

      const body = res.body as AprBody;
      expect([200, 201]).toContain(res.status);
      expect(body.status).toBe(AprStatus.CANCELADA);
      expect(body.reprovado_motivo).toBe(
        'Documentação incompleta: falta ART do responsável técnico',
      );
    });

    it('2.3 PATCH /aprs/:id/approve em APR Cancelada → 400 (transição inválida)', async () => {
      // CANCELADA é estado terminal — nenhuma transição é permitida
      const res = await testApp
        .request()
        .patch(`/aprs/${aprCancelableId}/approve`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders)
        .send({});

      expect(res.status).toBe(400);
    });

    it('2.4 PATCH /aprs/:id/finalize em APR Encerrada → 400 (estado terminal)', async () => {
      // Usa a APR Encerrada do Fluxo 1 — ENCERRADA → ENCERRADA é inválida
      const res = await testApp
        .request()
        .patch(`/aprs/${aprEncerradaId}/finalize`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders);

      expect(res.status).toBe(400);
    });

    it('2.5 PATCH /aprs/:id/approve em APR Encerrada → 400 (estado terminal)', async () => {
      // ENCERRADA → APROVADA também não é permitida
      const res = await testApp
        .request()
        .patch(`/aprs/${aprEncerradaId}/approve`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders)
        .send({});

      expect(res.status).toBe(400);
    });

    it('2.6 POST /aprs/:id/new-version em APR Encerrada → 400 (requer Aprovada)', async () => {
      // ENCERRADA é terminal — new-version exige status APROVADA
      const res = await testApp
        .request()
        .post(`/aprs/${aprEncerradaId}/new-version`)
        .set(testApp.authHeaders(adminSession))
        .set(csrfHeaders);

      expect(res.status).toBe(400);
    });
  });
});
