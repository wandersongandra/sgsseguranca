import { Role } from '../src/modules/auth/enums/roles.enum';
import { createApr } from './factories/apr.factory';
import { TestApp, type LoginSession } from './helpers/test-app';

const describeE2E =
  process.env.E2E_INFRA_AVAILABLE === 'false' ? describe.skip : describe;

describeE2E('Multi-tenancy Isolation (APR CRUD + tenant switch)', () => {
  let testApp: TestApp;
  let adminEmpresaTenantASession: LoginSession;
  let adminEmpresaTenantBSession: LoginSession;
  let adminGeralSession: LoginSession;
  let csrfHeaders: Record<string, string>;
  let aprTenantBId: string;

  beforeAll(async () => {
    testApp = await TestApp.create();
    await testApp.resetDatabase();

    adminEmpresaTenantASession = await testApp.loginAs(
      Role.ADMIN_EMPRESA,
      'tenantA',
    );
    adminEmpresaTenantBSession = await testApp.loginAs(
      Role.ADMIN_EMPRESA,
      'tenantB',
    );
    adminGeralSession = await testApp.loginAs(Role.ADMIN_GERAL, 'tenantA');
    csrfHeaders = await testApp.csrfHeaders();

    const tenantB = testApp.getTenant('tenantB');
    const tecnicoTenantB = testApp.getUser('tenantB', Role.TST);
    const aprTenantB = await createApr(testApp, adminEmpresaTenantBSession, {
      numero: 'APR-MULTI-TENANT-B-001',
      titulo: 'APR tenant B para validação cross-tenant',
      siteId: tenantB.siteId,
      elaboradorId: tecnicoTenantB.id,
    });
    aprTenantBId = aprTenantB.id;
  });

  afterAll(async () => {
    if (testApp) {
      await testApp.close();
    }
  });

  it('bloqueia SELECT cross-tenant (tenant A não vê APR do tenant B)', async () => {
    const response = await testApp
      .request()
      .get(`/aprs/${aprTenantBId}`)
      .set(testApp.authHeaders(adminEmpresaTenantASession));

    expect(response.status).toBe(404);
  });

  it('bloqueia INSERT cross-tenant via spoof de x-company-id', async () => {
    const tenantB = testApp.getTenant('tenantB');
    const tecnicoTenantB = testApp.getUser('tenantB', Role.TST);

    const response = await testApp
      .request()
      .post('/aprs')
      .set(
        testApp.authHeaders(adminEmpresaTenantASession, {
          companyIdOverride: tenantB.companyId,
        }),
      )
      .set(csrfHeaders)
      .send({
        numero: 'APR-SPOOF-INSERT-001',
        titulo: 'Tentativa de inserção cross-tenant',
        data_inicio: '2026-03-24',
        data_fim: '2026-03-25',
        site_id: tenantB.siteId,
        elaborador_id: tecnicoTenantB.id,
        participants: [tecnicoTenantB.id],
        risk_items: [
          {
            atividade: 'Operação de rotina',
            agente_ambiental: 'Ruído',
            condicao_perigosa: 'Exposição eventual',
            fonte_circunstancia: 'Linha de produção',
            lesao: 'Perda auditiva',
            probabilidade: 2,
            severidade: 2,
            medidas_prevencao: 'Uso de EPI e monitoramento',
            responsavel: 'Técnico SST',
          },
        ],
      });

    expect(response.status).toBe(403);
  });

  it('bloqueia UPDATE cross-tenant (tenant A não altera APR do tenant B)', async () => {
    const response = await testApp
      .request()
      .patch(`/aprs/${aprTenantBId}`)
      .set(testApp.authHeaders(adminEmpresaTenantASession))
      .set(csrfHeaders)
      .send({ titulo: 'Tentativa de alteração cross-tenant' });

    expect(response.status).toBe(404);
  });

  it('bloqueia DELETE cross-tenant (tenant A não remove APR do tenant B)', async () => {
    const response = await testApp
      .request()
      .delete(`/aprs/${aprTenantBId}`)
      .set(testApp.authHeaders(adminEmpresaTenantASession))
      .set(csrfHeaders);

    expect(response.status).toBe(404);
  });

  it('bloqueia ADMIN_GERAL ao navegar tenant B e não cria trilha de troca', async () => {
    const tenantB = testApp.getTenant('tenantB');

    const response = await testApp
      .request()
      .get(`/aprs/${aprTenantBId}`)
      .set(
        testApp.authHeaders(adminGeralSession, {
          companyIdOverride: tenantB.companyId,
        }),
      );

    expect(response.status).toBe(403);

    const auditRows = await testApp.setupQuery<Array<{ ok: number }>>(
      `
        SELECT 1 AS ok
        FROM forensic_trail_events
        WHERE module = 'security'
          AND event_type = 'ADMIN_ACTION'
          AND company_id = $1
          AND metadata ->> 'action' = $2
        LIMIT 1
      `,
      [tenantB.companyId, `tenant_switch:${tenantB.companyId}`],
    );

    expect(auditRows).toHaveLength(0);
  });
});
