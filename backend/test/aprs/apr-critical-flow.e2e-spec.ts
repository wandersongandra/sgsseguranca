import { AprStatus } from '../../src/modules/aprs/entities/apr.entity';
import { Role } from '../../src/modules/auth/enums/roles.enum';
import { TestApp, type LoginSession } from '../helpers/test-app';
import {
  createTestApr,
  createApproverSession,
  createCreatorSession,
  createTestTenant,
  type AprBody,
} from '../helpers/apr-test.factory';

const describeE2E =
  process.env.E2E_INFRA_AVAILABLE === 'false' ? describe.skip : describe;

describeE2E('E2E — APR critical flow: criar → aprovar → PDF → encerrar', () => {
  let testApp: TestApp;
  let creatorSession: LoginSession;
  let approverSession: LoginSession;
  let csrfHeaders: Record<string, string>;
  let aprId: string;
  let tenantInfo: { companyId: string; siteId: string };

  beforeAll(async () => {
    testApp = await TestApp.create();
    await testApp.resetDatabase();

    tenantInfo = createTestTenant(testApp);
    creatorSession = await createCreatorSession(testApp);
    approverSession = await createApproverSession(testApp);
    csrfHeaders = await testApp.csrfHeaders();
  });

  afterAll(async () => {
    await testApp.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Passo 1 — Criar APR
  // ──────────────────────────────────────────────────────────────────────────
  it('1. POST /aprs — cria APR com status Pendente', async () => {
    const tst = testApp.getUser('tenantA', Role.TST);

    const apr = await createTestApr(testApp, creatorSession, {
      numero: 'APR-FLOW-001',
      titulo: 'APR Fluxo Crítico',
      siteId: tenantInfo.siteId,
      elaboradorId: tst.id,
    });

    expect(apr.id).toBeTruthy();
    expect(apr.status).toBe(AprStatus.PENDENTE);
    aprId = apr.id;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Passo 2 — Salvar rascunho (PATCH)
  // ──────────────────────────────────────────────────────────────────────────
  it('2. PATCH /aprs/:id — salva rascunho com novo título', async () => {
    const res = await testApp
      .request()
      .patch(`/aprs/${aprId}`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders)
      .send({ titulo: 'APR Fluxo Crítico — Revisada' });

    const body = res.body as AprBody;
    expect(res.status).toBe(200);
    expect(body.status).toBe(AprStatus.PENDENTE);
    expect(body.titulo).toBe('APR Fluxo Crítico — Revisada');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Passo 3 — Submeter para aprovação
  // Não existe endpoint dedicado /submit — o status Pendente já é o estado
  // de submissão neste módulo. Verificamos que a APR está Pendente e pronta.
  // ──────────────────────────────────────────────────────────────────────────
  it('3. GET /aprs/:id — APR está Pendente (pronta para aprovação)', async () => {
    const res = await testApp
      .request()
      .get(`/aprs/${aprId}`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders);

    const body = res.body as AprBody;
    expect(res.status).toBe(200);
    expect(body.status).toBe(AprStatus.PENDENTE);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Passo 4 — Aprovar (Pendente → Aprovada)
  // ──────────────────────────────────────────────────────────────────────────
  it('4. PATCH /aprs/:id/approve — transição Pendente → Aprovada', async () => {
    const signatureRes = await testApp
      .request()
      .post('/signatures')
      .set(testApp.authHeaders(creatorSession))
      .set(csrfHeaders)
      .send({
        document_id: aprId,
        document_type: 'APR',
        signature_data: 'assinatura-e2e-apr-critical-flow',
        type: 'drawn',
      });

    expect(signatureRes.status).toBe(201);

    const res = await testApp
      .request()
      .patch(`/aprs/${aprId}/approve`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders)
      .send({ reason: 'Documentação completa e conforme' });

    const body = res.body as AprBody;
    expect([200, 201]).toContain(res.status);
    expect(body.status).toBe(AprStatus.APROVADA);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Passo 5 — Gerar PDF (POST /aprs/:id/generate-final-pdf)
  // ──────────────────────────────────────────────────────────────────────────
  it('5. POST /aprs/:id/generate-final-pdf — gera PDF da APR aprovada', async () => {
    const res = await testApp
      .request()
      .post(`/aprs/${aprId}/generate-final-pdf`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders);

    expect([200, 201]).toContain(res.status);
    const body = res.body as {
      generated?: boolean;
      hasFinalPdf?: boolean;
      entityId?: string;
    };
    expect(body.entityId).toBe(aprId);
    expect(typeof body.hasFinalPdf).toBe('boolean');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Passo 6 — Encerrar (Aprovada → Encerrada)
  // ──────────────────────────────────────────────────────────────────────────
  it('6. PATCH /aprs/:id/finalize — transição Aprovada → Encerrada', async () => {
    const res = await testApp
      .request()
      .patch(`/aprs/${aprId}/finalize`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders);

    const body = res.body as AprBody;
    expect([200, 201]).toContain(res.status);
    expect(body.status).toBe(AprStatus.ENCERRADA);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Passo 7 — Verificar status final
  // ──────────────────────────────────────────────────────────────────────────
  it('7. GET /aprs/:id — status final é ENCERRADA', async () => {
    const res = await testApp
      .request()
      .get(`/aprs/${aprId}`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders);

    const body = res.body as AprBody;
    expect(res.status).toBe(200);
    expect(body.status).toBe(AprStatus.ENCERRADA);
    expect(body.id).toBe(aprId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cenário de reprovação com reabertura
// ─────────────────────────────────────────────────────────────────────────────
describeE2E('E2E — APR reject without reason returns 400', () => {
  let testApp: TestApp;
  let approverSession: LoginSession;
  let csrfHeaders: Record<string, string>;
  let aprId: string;

  beforeAll(async () => {
    testApp = await TestApp.create();
    await testApp.resetDatabase();

    approverSession = await createApproverSession(testApp);
    csrfHeaders = await testApp.csrfHeaders();

    const tenant = createTestTenant(testApp);
    const tst = testApp.getUser('tenantA', Role.TST);

    const apr = await createTestApr(testApp, approverSession, {
      numero: 'APR-REJ-001',
      titulo: 'APR Teste Reprovação',
      siteId: tenant.siteId,
      elaboradorId: tst.id,
    });
    aprId = apr.id;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('PATCH /aprs/:id/reject sem reason → 400', async () => {
    const res = await testApp
      .request()
      .patch(`/aprs/${aprId}/reject`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders)
      .send({ reason: '' });

    expect(res.status).toBe(400);
  });

  it('PATCH /aprs/:id/reject com reason válida → status Cancelada', async () => {
    const res = await testApp
      .request()
      .patch(`/aprs/${aprId}/reject`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders)
      .send({
        reason: 'Documentação incompleta e análise de risco insuficiente.',
      });

    const body = res.body as AprBody;
    expect([200, 201]).toContain(res.status);
    expect(body.status).toBe(AprStatus.CANCELADA);
  });

  it('POST /aprs/:id/reopen — rota da trilha configurável removida → 404', async () => {
    const res = await testApp
      .request()
      .post(`/aprs/${aprId}/reopen`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders)
      .send({ reason: 'Reabrindo para correcao.' });

    expect(res.status).toBe(404);
  });
});
