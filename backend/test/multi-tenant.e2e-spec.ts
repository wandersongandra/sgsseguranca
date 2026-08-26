import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';

type App = Parameters<typeof request>[0];
type IdRow = { id: string };
type AprListItem = { titulo: string };

const describeE2E =
  process.env.E2E_INFRA_AVAILABLE === 'false' ? describe.skip : describe;

const readFirstId = (rows: IdRow[], label: string): string => {
  const firstRow = rows[0];

  if (!firstRow?.id) {
    throw new Error(`Expected ${label} query to return an id`);
  }

  return firstRow.id;
};

const extractCookieHeader = (
  headers: Record<string, string | string[] | undefined>,
): string => {
  const cookieHeader = headers['set-cookie'];

  if (!Array.isArray(cookieHeader) || cookieHeader.length === 0) {
    throw new Error('Login response did not include set-cookie header');
  }

  return cookieHeader.join('; ');
};

const isAprListItem = (value: unknown): value is AprListItem => {
  if (typeof value !== 'object' || value === null || !('titulo' in value)) {
    return false;
  }

  return typeof (value as { titulo?: unknown }).titulo === 'string';
};

const readAprList = (body: unknown): AprListItem[] => {
  if (!Array.isArray(body)) {
    throw new Error('Expected APR list response body to be an array');
  }

  return (body as unknown[]).map((item) => {
    if (!isAprListItem(item)) {
      throw new Error('Expected APR list items to expose a titulo string');
    }

    return item;
  });
};

describeE2E('Multi-Tenant Isolation (APR) (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let cookieA: string;
  let cookieB: string;
  let cookieSuper: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = moduleFixture.get(DataSource);

    // Criar perfis mínimos
    const profile = await dataSource.query<IdRow[]>(
      `INSERT INTO profiles (id, nome, permissoes, status)
       VALUES (uuid_generate_v4(), 'Colaborador', '{}'::jsonb, true)
       RETURNING id`,
    );
    const profileId = readFirstId(profile, 'profile');

    // Criar empresas
    const companyA = await dataSource.query<IdRow[]>(
      `INSERT INTO companies (id, razao_social, cnpj, endereco, responsavel, status)
       VALUES (uuid_generate_v4(), 'Company A', '12345678000199', 'Rua 1', 'Resp A', true)
       RETURNING id`,
    );
    const companyB = await dataSource.query<IdRow[]>(
      `INSERT INTO companies (id, razao_social, cnpj, endereco, responsavel, status)
       VALUES (uuid_generate_v4(), 'Company B', '98765432000188', 'Rua 2', 'Resp B', true)
       RETURNING id`,
    );

    const companyAId = readFirstId(companyA, 'company A');
    const companyBId = readFirstId(companyB, 'company B');

    // Criar sites
    const siteA = await dataSource.query<IdRow[]>(
      `INSERT INTO sites (id, nome, company_id, status)
       VALUES (uuid_generate_v4(), 'Site A', $1, true)
       RETURNING id`,
      [companyAId],
    );
    const siteB = await dataSource.query<IdRow[]>(
      `INSERT INTO sites (id, nome, company_id, status)
       VALUES (uuid_generate_v4(), 'Site B', $1, true)
       RETURNING id`,
      [companyBId],
    );
    const siteAId = readFirstId(siteA, 'site A');
    const siteBId = readFirstId(siteB, 'site B');

    // Criar usuários (CPFs válidos para passar validação de login)
    const userA = await dataSource.query<IdRow[]>(
      `INSERT INTO users (id, nome, cpf, email, password, company_id, profile_id, status)
       VALUES (uuid_generate_v4(), 'User A', '12345678909', 'a@test.com', 'hashed', $1, $2, true)
       RETURNING id`,
      [companyAId, profileId],
    );
    const userB = await dataSource.query<IdRow[]>(
      `INSERT INTO users (id, nome, cpf, email, password, company_id, profile_id, status)
       VALUES (uuid_generate_v4(), 'User B', '52998224725', 'b@test.com', 'hashed', $1, $2, true)
       RETURNING id`,
      [companyBId, profileId],
    );
    const userAId = readFirstId(userA, 'user A');
    const userBId = readFirstId(userB, 'user B');

    // Criar perfil de plataforma explícito
    const superAdminProfile = await dataSource.query<IdRow[]>(
      `INSERT INTO profiles (id, nome, permissoes, status)
       VALUES (uuid_generate_v4(), 'SUPER_ADMIN', '{}'::jsonb, true)
       RETURNING id`,
    );
    const superAdminProfileId = readFirstId(
      superAdminProfile,
      'super admin profile',
    );

    // Criar usuário Super Admin (sem empresa - global)
    await dataSource.query<IdRow[]>(
      `INSERT INTO users (id, nome, cpf, email, password, company_id, profile_id, status)
       VALUES (uuid_generate_v4(), 'Super Admin', '11111111111', 'super@test.com', 'hashed', NULL, $1, true)
       RETURNING id`,
      [superAdminProfileId],
    );

    // Criar APRs mínimas por empresa
    await dataSource.query(
      `INSERT INTO aprs (id, numero, titulo, descricao, data_inicio, data_fim, site_id, elaborador_id, company_id, status)
       VALUES (uuid_generate_v4(), 'APR-A-001', 'APR A', NULL, CURRENT_DATE, CURRENT_DATE, $1, $2, $3, 'Pendente')`,
      [siteAId, userAId, companyAId],
    );
    await dataSource.query(
      `INSERT INTO aprs (id, numero, titulo, descricao, data_inicio, data_fim, site_id, elaborador_id, company_id, status)
       VALUES (uuid_generate_v4(), 'APR-B-001', 'APR B', NULL, CURRENT_DATE, CURRENT_DATE, $1, $2, $3, 'Pendente')`,
      [siteBId, userBId, companyBId],
    );

    // Login para obter cookies
    const loginA = await request(app.getHttpServer() as App)
      .post('/auth/login')
      .send({ cpf: '12345678909', password: 'password123' });
    cookieA = extractCookieHeader(loginA.headers);

    const loginB = await request(app.getHttpServer() as App)
      .post('/auth/login')
      .send({ cpf: '52998224725', password: 'password123' });
    cookieB = extractCookieHeader(loginB.headers);

    const loginSuper = await request(app.getHttpServer() as App)
      .post('/auth/login')
      .send({ cpf: '11111111111', password: 'password123' });
    cookieSuper = extractCookieHeader(loginSuper.headers);
  });

  afterAll(async () => {
    await app.close();
  });

  it('Empresa A não pode ver dados da Empresa B', async () => {
    const response = await request(app.getHttpServer() as App)
      .get('/aprs')
      .set('Cookie', cookieA);

    expect(response.status).toBe(200);
    const data = readAprList(response.body);
    // Deve retornar apenas 1 APR da empresa A
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].titulo).toBe('APR A');
  });

  it('Empresa B não pode ver dados da Empresa A', async () => {
    const response = await request(app.getHttpServer() as App)
      .get('/aprs')
      .set('Cookie', cookieB);

    expect(response.status).toBe(200);
    const data = readAprList(response.body);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].titulo).toBe('APR B');
  });

  it('Mesmo sem filtro manual, banco deve bloquear (sem tenant definido)', async () => {
    const raw = await dataSource.query<unknown[]>(`SELECT * FROM aprs`);
    // RLS com deny_without_tenant e FORCE deve impedir leitura sem tenant
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBe(0);
  });

  it('Super Admin sem tenant explícito recebe 401', async () => {
    const response = await request(app.getHttpServer() as App)
      .get('/aprs')
      .set('Cookie', cookieSuper);

    expect(response.status).toBe(401);
  });
});
