/*
 * DataSource.query is typed as `any` by TypeORM. The assertions below are
 * deliberately limited to synthetic SQL fixtures/postconditions in this E2E
 * proof; production code remains fully type-checked.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Role } from '../../src/modules/auth/enums/roles.enum';
import { TestApp, type LoginSession } from '../helpers/test-app';
import { createApr } from '../factories/apr.factory';

const describeE2E =
  process.env.E2E_INFRA_AVAILABLE === 'false' ? describe.skip : describe;

if (
  process.env.APR_SECURITY_E2E_REQUIRED === 'true' &&
  process.env.E2E_INFRA_AVAILABLE !== 'true'
) {
  throw new Error(
    'APR adversarial E2E exige PostgreSQL/Redis disponíveis no executor CI; execução seria apenas skip.',
  );
}

describeE2E('E2E Fase 4 — APR adversarial HTTP/SQL proof', () => {
  let testApp: TestApp;
  let adminA: LoginSession;
  let tstA: LoginSession;
  let tstB: LoginSession;
  let csrfHeaders: Record<string, string>;
  let siteA2Id: string;
  let aprA1Id: string;
  let aprA2Id: string;
  let aprB1Id: string;

  beforeAll(async () => {
    testApp = await TestApp.create();
    await testApp.resetDatabase();
    csrfHeaders = await testApp.csrfHeaders();
    adminA = await testApp.loginAs(Role.ADMIN_EMPRESA, 'tenantA');
    tstA = await testApp.loginAs(Role.TST, 'tenantA');
    tstB = await testApp.loginAs(Role.TST, 'tenantB');

    const tenantA = testApp.getTenant('tenantA');
    const adminAUser = testApp.getUser('tenantA', Role.ADMIN_EMPRESA);
    const siteRows = await testApp.dataSource.query(
      `INSERT INTO sites (nome, company_id, status, created_at, updated_at)
       VALUES ($1, $2, true, NOW(), NOW())
       RETURNING id`,
      ['Site A2 — Fase 4', tenantA.companyId],
    );
    siteA2Id = siteRows[0].id;

    // O admin é company-wide, mas o vínculo do elaborador precisa ser válido
    // para o site alvo no momento da criação da fixture A2.
    await testApp.dataSource.query(
      'UPDATE users SET site_id = $1 WHERE id = $2',
      [siteA2Id, adminAUser.id],
    );
    const aprA2Response = await testApp
      .request()
      .post('/aprs')
      .set(testApp.authHeaders(adminA))
      .set(csrfHeaders)
      .send({
        numero: 'APR-A2-F4-001',
        titulo: 'APR A2 Fase 4',
        data_inicio: '2026-08-11',
        data_fim: '2026-08-12',
        site_id: siteA2Id,
        elaborador_id: adminAUser.id,
        participants: [adminAUser.id],
        risk_items: [],
      });
    await testApp.dataSource.query(
      'UPDATE users SET site_id = $1 WHERE id = $2',
      [tenantA.siteId, adminAUser.id],
    );
    if (aprA2Response.status !== 201) {
      throw new Error(
        `fixture APR A2 falhou: ${aprA2Response.status} ${JSON.stringify(aprA2Response.body)}`,
      );
    }
    aprA2Id = String(aprA2Response.body.id);

    const aprA1 = await createApr(testApp, tstA, {
      numero: 'APR-A1-F4-001',
      titulo: 'APR A1 Fase 4',
      siteId: tenantA.siteId,
      elaboradorId: testApp.getUser('tenantA', Role.TST).id,
    });
    aprA1Id = aprA1.id;

    const aprB1 = await createApr(testApp, tstB, {
      numero: 'APR-B1-F4-001',
      titulo: 'APR B1 Fase 4',
      siteId: testApp.getTenant('tenantB').siteId,
      elaboradorId: testApp.getUser('tenantB', Role.TST).id,
    });
    aprB1Id = aprB1.id;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('bloqueia leitura, mutação e workflow cross-site com SQL inalterado', async () => {
    const before = await testApp.dataSource.query(
      'SELECT id, site_id, company_id, status, titulo FROM aprs WHERE id = $1',
      [aprA2Id],
    );

    const requests = await Promise.all([
      testApp.request().get(`/aprs/${aprA2Id}`).set(testApp.authHeaders(tstA)),
      testApp
        .request()
        .patch(`/aprs/${aprA2Id}`)
        .set(testApp.authHeaders(tstA))
        .set(csrfHeaders)
        .send({ titulo: 'cross-site update' }),
      testApp
        .request()
        .post(`/aprs/${aprA2Id}/submit`)
        .set(testApp.authHeaders(tstA))
        .set(csrfHeaders)
        .send({}),
      testApp
        .request()
        .patch(`/aprs/${aprA2Id}/approve`)
        .set(testApp.authHeaders(tstA))
        .set(csrfHeaders)
        .send({ reason: 'cross-site approve' }),
      testApp
        .request()
        .patch(`/aprs/${aprA2Id}/reject`)
        .set(testApp.authHeaders(tstA))
        .set(csrfHeaders)
        .send({ reason: 'cross-site reject' }),
      testApp
        .request()
        .patch(`/aprs/${aprA2Id}/finalize`)
        .set(testApp.authHeaders(tstA))
        .set(csrfHeaders)
        .send({}),
      testApp
        .request()
        .post(`/aprs/${aprA2Id}/reopen`)
        .set(testApp.authHeaders(tstA))
        .set(csrfHeaders)
        .send({ reason: 'cross-site reopen' }),
    ]);

    for (const response of requests) {
      expect([403, 404]).toContain(response.status);
    }

    const after = await testApp.dataSource.query(
      'SELECT id, site_id, company_id, status, titulo FROM aprs WHERE id = $1',
      [aprA2Id],
    );
    expect(after).toEqual(before);
  });

  it('bloqueia mudança de site e mass assignment por HTTP', async () => {
    const before = await testApp.dataSource.query(
      'SELECT site_id, status, company_id FROM aprs WHERE id = $1',
      [aprA1Id],
    );

    const moveResponse = await testApp
      .request()
      .patch(`/aprs/${aprA1Id}`)
      .set(testApp.authHeaders(tstA))
      .set(csrfHeaders)
      .send({ site_id: siteA2Id });
    expect([403, 404]).toContain(moveResponse.status);

    const countBefore = Number(
      (
        await testApp.dataSource.query(
          'SELECT COUNT(*)::text AS count FROM aprs WHERE company_id = $1',
          [testApp.getTenant('tenantA').companyId],
        )
      )[0].count,
    );
    const assignmentResponse = await testApp
      .request()
      .post('/aprs')
      .set(testApp.authHeaders(tstA))
      .set(csrfHeaders)
      .send({
        numero: 'APR-MASS-ASSIGN-F4',
        titulo: 'mass assignment',
        data_inicio: '2026-08-11',
        data_fim: '2026-08-12',
        site_id: testApp.getTenant('tenantA').siteId,
        elaborador_id: testApp.getUser('tenantA', Role.TST).id,
        participants: [],
        company_id: testApp.getTenant('tenantB').companyId,
        tenant_id: testApp.getTenant('tenantB').companyId,
        status: 'Aprovada',
        approvedBy: testApp.getUser('tenantB', Role.ADMIN_EMPRESA).id,
        integrity_scheme: 'FAKE',
        content_hash: 'FAKE',
      });
    expect(assignmentResponse.status).toBe(400);

    const after = await testApp.dataSource.query(
      'SELECT site_id, status, company_id FROM aprs WHERE id = $1',
      [aprA1Id],
    );
    const countAfter = Number(
      (
        await testApp.dataSource.query(
          'SELECT COUNT(*)::text AS count FROM aprs WHERE company_id = $1',
          [testApp.getTenant('tenantA').companyId],
        )
      )[0].count,
    );
    expect(after).toEqual(before);
    expect(countAfter).toBe(countBefore);
  });

  it('bloqueia assinatura cross-site e cross-tenant sem inserir signature', async () => {
    const signatureCountBefore = Number(
      (
        await testApp.dataSource.query(
          `SELECT COUNT(*)::text AS count FROM signatures
           WHERE document_id IN ($1, $2) AND UPPER(document_type) = 'APR'`,
          [aprA2Id, aprB1Id],
        )
      )[0].count,
    );

    for (const aprId of [aprA2Id, aprB1Id]) {
      const response = await testApp
        .request()
        .post('/signatures')
        .set(testApp.authHeaders(tstA))
        .set(csrfHeaders)
        .send({
          document_id: aprId,
          document_type: 'APR',
          signature_data: 'cross-scope-signature',
          type: 'drawn',
        });
      expect([403, 404]).toContain(response.status);
    }

    const signatureCountAfter = Number(
      (
        await testApp.dataSource.query(
          `SELECT COUNT(*)::text AS count FROM signatures
           WHERE document_id IN ($1, $2) AND UPPER(document_type) = 'APR'`,
          [aprA2Id, aprB1Id],
        )
      )[0].count,
    );
    expect(signatureCountAfter).toBe(signatureCountBefore);
  });

  it('persiste hash V1, verifica e detecta tampering SQL', async () => {
    const signatureResponse = await testApp
      .request()
      .post('/signatures')
      .set(testApp.authHeaders(tstA))
      .set(csrfHeaders)
      .send({
        document_id: aprA1Id,
        document_type: 'APR',
        signature_data: 'phase4-content-signature',
        type: 'drawn',
      });
    expect(signatureResponse.status).toBe(201);

    const signatureRows = await testApp.dataSource.query(
      `SELECT id, content_hash, hash_algorithm, canonicalization_version,
              integrity_scheme
         FROM signatures
        WHERE document_id = $1 AND UPPER(document_type) = 'APR'
        ORDER BY created_at DESC
        LIMIT 1`,
      [aprA1Id],
    );
    const signature = signatureRows[0];
    expect(signature.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(signature.hash_algorithm).toBe('SHA-256');
    expect(signature.canonicalization_version).toBe(1);
    expect(signature.integrity_scheme).toBe('CONTENT_HASH_V1');

    const validResponse = await testApp
      .request()
      .get(`/signatures/verify/${signature.id}`)
      .set(testApp.authHeaders(tstA));
    expect(validResponse.status).toBe(200);
    expect(validResponse.body.content_integrity).toBe('VALID');

    await testApp.dataSource.query(
      'UPDATE aprs SET titulo = $1 WHERE id = $2',
      ['APR adulterada fora da API', aprA1Id],
    );
    const mismatchResponse = await testApp
      .request()
      .get(`/signatures/verify/${signature.id}`)
      .set(testApp.authHeaders(tstA));
    expect(mismatchResponse.status).toBe(200);
    expect(mismatchResponse.body.content_integrity).toBe('CONTENT_MISMATCH');
  });

  it('converte conflito real de lock APR em HTTP 409 sem mutar o estado', async () => {
    const lockedApr = await createApr(testApp, tstA, {
      numero: 'APR-LOCK-F4-001',
      titulo: 'APR lock controlado Fase 4',
      siteId: testApp.getTenant('tenantA').siteId,
      elaboradorId: testApp.getUser('tenantA', Role.TST).id,
    });
    const lockRunner = testApp.dataSource.createQueryRunner();

    const snapshot = async () => {
      const [aprRow] = await testApp.dataSource.query(
        'SELECT status, versao FROM aprs WHERE id = $1',
        [lockedApr.id],
      );
      const [signatureRow] = await testApp.dataSource.query(
        `SELECT COUNT(*)::text AS count FROM signatures
         WHERE document_id = $1 AND UPPER(document_type) = 'APR'
           AND deleted_at IS NULL`,
        [lockedApr.id],
      );
      const [auditRow] = await testApp.dataSource.query(
        `SELECT COUNT(*)::text AS count FROM apr_logs
         WHERE apr_id = $1
           AND acao IN ('APR_APROVADA', 'APR_REPROVADA', 'APR_ENCERRADA')`,
        [lockedApr.id],
      );
      return {
        status: aprRow.status,
        version: Number(aprRow.versao ?? 1),
        signatureCount: Number(signatureRow.count),
        businessAuditCount: Number(auditRow.count),
      };
    };

    const before = await snapshot();

    await lockRunner.connect();
    await lockRunner.startTransaction();
    try {
      await lockRunner.query('SELECT id FROM aprs WHERE id = $1 FOR UPDATE', [
        lockedApr.id,
      ]);

      const response = await testApp
        .request()
        .patch(`/aprs/${lockedApr.id}/approve`)
        .set(testApp.authHeaders(tstA))
        .set(csrfHeaders)
        .send({ reason: 'lock conflict proof' });

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).not.toContain('55P03');
      expect(JSON.stringify(response.body)).not.toContain('FOR UPDATE');

      expect(await snapshot()).toEqual(before);
    } finally {
      await lockRunner.rollbackTransaction();
      await lockRunner.release();
    }

    expect(await snapshot()).toEqual(before);

    const legitimateResponse = await testApp
      .request()
      .patch(`/aprs/${lockedApr.id}/approve`)
      .set(testApp.authHeaders(tstA))
      .set(csrfHeaders)
      .send({ reason: 'aprovação legítima após liberação do lock' });
    expect([200, 201]).toContain(legitimateResponse.status);
    const afterLegitimate = await snapshot();
    expect(afterLegitimate.businessAuditCount).toBeGreaterThan(
      before.businessAuditCount,
    );
  });
});
