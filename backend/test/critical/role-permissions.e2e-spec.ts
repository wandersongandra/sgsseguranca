import { Role } from '../../src/modules/auth/enums/roles.enum';
import { createApr } from '../factories/apr.factory';
import { TestApp, type LoginSession } from '../helpers/test-app';

const describeE2E =
  process.env.E2E_INFRA_AVAILABLE === 'false' ? describe.skip : describe;

type UserResponse = { id?: string; profile_id?: string };

function buildValidCpf(seed: number): string {
  const base = String(seed).padStart(9, '0').slice(-9);
  const digits = base.split('').map(Number);

  const calcDigit = (values: number[], factor: number): number => {
    const sum = values.reduce(
      (accumulator, value, index) => accumulator + value * (factor - index),
      0,
    );
    const remainder = 11 - (sum % 11);
    return remainder >= 10 ? 0 : remainder;
  };

  const digit1 = calcDigit(digits, 10);
  const digit2 = calcDigit([...digits, digit1], 11);

  return `${base}${digit1}${digit2}`;
}

describeE2E(
  'E2E Critical - Role permissions (RBAC + PROFILE_PERMISSION_FALLBACK)',
  () => {
    let testApp: TestApp;

    let adminGeralSession: LoginSession;
    let adminEmpresaSession: LoginSession;
    let tecnicoSession: LoginSession; // Role.TST = "Técnico"
    let trabalhadorSession: LoginSession;
    let adminEmpresaTenantBSession: LoginSession;
    let csrfHeaders: Record<string, string>;

    let adminGeralProfileId: string;

    beforeAll(async () => {
      testApp = await TestApp.create();
      await testApp.resetDatabase();

      // Usuários-base por role no tenant de teste (seedado no TestApp).
      adminGeralSession = await testApp.loginAs(Role.ADMIN_GERAL, 'tenantA');
      adminEmpresaSession = await testApp.loginAs(
        Role.ADMIN_EMPRESA,
        'tenantA',
      );
      tecnicoSession = await testApp.loginAs(Role.TST, 'tenantA');
      trabalhadorSession = await testApp.loginAs(Role.TRABALHADOR, 'tenantA');
      adminEmpresaTenantBSession = await testApp.loginAs(
        Role.ADMIN_EMPRESA,
        'tenantB',
      );
      csrfHeaders = await testApp.csrfHeaders();

      const profileRowsRaw: unknown = await testApp.dataSource.query(
        'SELECT id FROM profiles WHERE nome = $1 LIMIT 1',
        [Role.ADMIN_GERAL],
      );
      const profileRows = Array.isArray(profileRowsRaw)
        ? (profileRowsRaw as Array<{ id?: unknown }>)
        : [];
      adminGeralProfileId =
        typeof profileRows[0]?.id === 'string' ? profileRows[0].id : '';
    });

    afterAll(async () => {
      if (testApp) {
        await testApp.close();
      }
    });

    describe('APRs', () => {
      it('TRABALHADOR: POST /aprs -> 403', async () => {
        const tenantA = testApp.getTenant('tenantA');

        const response = await testApp
          .request()
          .post('/aprs')
          .set(testApp.authHeaders(trabalhadorSession))
          .set(csrfHeaders)
          .send({
            numero: 'APR-WORKER-ROLE-001',
            titulo: 'APR bloqueada por permissão',
            data_inicio: '2026-03-24',
            data_fim: '2026-03-25',
            site_id: tenantA.siteId,
            elaborador_id: trabalhadorSession.userId,
            participants: [trabalhadorSession.userId],
            risk_items: [
              {
                atividade: 'Atividade de teste',
                agente_ambiental: 'Ruído',
                condicao_perigosa: 'Exposição',
                fonte_circunstancia: 'Linha',
                lesao: 'Perda auditiva',
                probabilidade: 2,
                severidade: 2,
                medidas_prevencao: 'Uso de EPI',
                responsavel: 'Técnico SST',
              },
            ],
          });

        expect(response.status).toBe(403);
      });

      it('TRABALHADOR: PATCH /aprs/:id/approve -> 403', async () => {
        const tenantA = testApp.getTenant('tenantA');
        const tecnico = testApp.getUser('tenantA', Role.TST);
        const apr = await createApr(testApp, tecnicoSession, {
          numero: 'APR-ROLE-APPROVE-001',
          titulo: 'APR para bloqueio de trabalhador',
          siteId: tenantA.siteId,
          elaboradorId: tecnico.id,
        });

        const response = await testApp
          .request()
          .patch(`/aprs/${apr.id}/approve`)
          .set(testApp.authHeaders(trabalhadorSession))
          .set(csrfHeaders)
          .send({ reason: 'Tentativa sem permissão' });

        expect(response.status).toBe(403);
      });

      it('TECNICO (TST): POST /aprs -> 201', async () => {
        const tenantA = testApp.getTenant('tenantA');
        const tecnico = testApp.getUser('tenantA', Role.TST);
        const apr = await createApr(testApp, tecnicoSession, {
          numero: 'APR-TECNICO-ROLE-001',
          titulo: 'APR criada por técnico',
          siteId: tenantA.siteId,
          elaboradorId: tecnico.id,
        });

        expect(apr.id).toBeTruthy();
      });

      it('VISUALIZADOR (Trabalhador): PATCH /aprs/:id -> 403', async () => {
        const tenantA = testApp.getTenant('tenantA');
        const tecnico = testApp.getUser('tenantA', Role.TST);
        const apr = await createApr(testApp, tecnicoSession, {
          numero: 'APR-VIEWER-EDIT-001',
          titulo: 'APR para validar bloqueio de edição do visualizador',
          siteId: tenantA.siteId,
          elaboradorId: tecnico.id,
        });

        const response = await testApp
          .request()
          .patch(`/aprs/${apr.id}`)
          .set(testApp.authHeaders(trabalhadorSession))
          .set(csrfHeaders)
          .send({
            titulo: 'Tentativa indevida de edição por visualizador',
          });

        expect(response.status).toBe(403);
      });

      it('VISUALIZADOR (Trabalhador): DELETE /aprs/:id -> 403', async () => {
        const tenantA = testApp.getTenant('tenantA');
        const tecnico = testApp.getUser('tenantA', Role.TST);
        const apr = await createApr(testApp, tecnicoSession, {
          numero: 'APR-VIEWER-DELETE-001',
          titulo: 'APR para validar bloqueio de exclusão do visualizador',
          siteId: tenantA.siteId,
          elaboradorId: tecnico.id,
        });

        const response = await testApp
          .request()
          .delete(`/aprs/${apr.id}`)
          .set(testApp.authHeaders(trabalhadorSession))
          .set(csrfHeaders);

        expect(response.status).toBe(403);
      });

      it('VISUALIZADOR (Trabalhador): POST /signatures -> 201 quando permitido', async () => {
        const tenantA = testApp.getTenant('tenantA');
        const apr = await createApr(testApp, tecnicoSession, {
          numero: 'APR-VIEWER-SIGN-001',
          titulo: 'APR para validar assinatura do visualizador',
          siteId: tenantA.siteId,
          elaboradorId: trabalhadorSession.userId,
          participantIds: [trabalhadorSession.userId],
        });

        const response = await testApp
          .request()
          .post('/signatures')
          .set(testApp.authHeaders(trabalhadorSession))
          .set(csrfHeaders)
          .send({
            document_id: apr.id,
            document_type: 'APR',
            type: 'drawn',
            signature_data:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XxNcAAAAASUVORK5CYII=',
          });

        expect(response.status).toBe(201);
      });
    });

    describe('Usuários', () => {
      it('ADMIN_EMPRESA criando usuário ADMIN_GERAL -> 403 (privilege escalation)', async () => {
        const response = await testApp
          .request()
          .post('/users')
          .set(testApp.authHeaders(adminEmpresaSession))
          .set(csrfHeaders)
          .send({
            nome: 'Tentativa Escalação',
            cpf: buildValidCpf(150823026),
            email: 'escalation-denied@e2e.test',
            password: 'Tr@balho!2026',
            profile_id: adminGeralProfileId,
          });

        expect(response.status).toBe(403);
      });

      it('ADMIN_GERAL criando usuário ADMIN_GERAL -> 201', async () => {
        const response = await testApp
          .request()
          .post('/users')
          .set(testApp.authHeaders(adminGeralSession))
          .set(csrfHeaders)
          .send({
            nome: 'Novo Admin Geral',
            cpf: buildValidCpf(555666777),
            email: 'new-admin-geral-allowed@e2e.test',
            password: 'Tr@balho!2026',
            profile_id: adminGeralProfileId,
          });

        const body = response.body as UserResponse;
        expect(response.status).toBe(201);
        expect(body.id).toBeTruthy();
        expect(body.profile_id).toBe(adminGeralProfileId);
      });
    });

    describe('Cross-tenant', () => {
      it('SUPER_ADMIN consegue navegar tenant B com auditoria de troca de tenant', async () => {
        const tenantB = testApp.getTenant('tenantB');
        const tecnicoTenantB = testApp.getUser('tenantB', Role.TST);
        const aprTenantB = await createApr(
          testApp,
          adminEmpresaTenantBSession,
          {
            numero: 'APR-SUPER-ADMIN-TENANT-B-001',
            titulo:
              'APR do tenant B para navegação cross-tenant do super admin',
            siteId: tenantB.siteId,
            elaboradorId: tecnicoTenantB.id,
          },
        );

        const response = await testApp
          .request()
          .get(`/aprs/${aprTenantB.id}`)
          .set(
            testApp.authHeaders(adminGeralSession, {
              companyIdOverride: tenantB.companyId,
            }),
          );

        expect(response.status).toBe(200);

        const auditRows = await testApp.dataSource.query<Array<{ ok: number }>>(
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

        expect(auditRows.length).toBeGreaterThan(0);
      });

      it('Usuário do tenant A acessando recurso do tenant B -> 404 (não 403)', async () => {
        const tenantB = testApp.getTenant('tenantB');
        const tecnicoTenantB = testApp.getUser('tenantB', Role.TST);
        const aprTenantB = await createApr(
          testApp,
          adminEmpresaTenantBSession,
          {
            numero: 'APR-TENANT-B-001',
            titulo: 'APR do tenant B',
            siteId: tenantB.siteId,
            elaboradorId: tecnicoTenantB.id,
          },
        );

        const response = await testApp
          .request()
          .get(`/aprs/${aprTenantB.id}`)
          .set(testApp.authHeaders(adminEmpresaSession));

        expect(response.status).toBe(404);
      });

      it('Não deve vazar existência via approve entre tenants -> 404', async () => {
        const tenantB = testApp.getTenant('tenantB');
        const tecnicoTenantB = testApp.getUser('tenantB', Role.TST);
        const aprTenantB = await createApr(
          testApp,
          adminEmpresaTenantBSession,
          {
            numero: 'APR-TENANT-B-APPROVE-001',
            titulo: 'APR do tenant B para approve cross-tenant',
            siteId: tenantB.siteId,
            elaboradorId: tecnicoTenantB.id,
          },
        );

        const response = await testApp
          .request()
          .patch(`/aprs/${aprTenantB.id}/approve`)
          .set(testApp.authHeaders(adminEmpresaSession))
          .set(csrfHeaders)
          .send({});

        expect(response.status).toBe(404);
      });
    });
  },
);
