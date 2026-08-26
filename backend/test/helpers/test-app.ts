/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import * as cookieParserModule from 'cookie-parser';
import { AllExceptionsFilter } from '../../src/shared/filters/http-exception.filter';
import { bootstrapBackendTestEnvironment } from '../setup/test-env';
import { Company } from '../../src/modules/companies/entities/company.entity';
import { Site } from '../../src/modules/sites/entities/site.entity';
import { Profile } from '../../src/modules/profiles/entities/profile.entity';
import { User } from '../../src/modules/users/entities/user.entity';
import { PasswordService } from '../../src/shared/services/password.service';
import { Role } from '../../src/modules/auth/enums/roles.enum';
import { RedisService } from '../../src/shared/redis/redis.service';
import {
  encryptSensitiveValue,
  hashSensitiveValue,
} from '../../src/shared/security/field-encryption.util';
import type { Redis } from 'ioredis';

bootstrapBackendTestEnvironment();

export type TenantKey = 'tenantA' | 'tenantB';

type SeedUserRecord = {
  id: string;
  cpf: string;
  email: string;
  role: Role;
  companyId: string;
};

type SeedTenant = {
  companyId: string;
  siteId: string;
  users: Record<string, SeedUserRecord>;
};

type CookieParserFactory = (
  ...args: unknown[]
) => (req: unknown, res: unknown, next: () => void) => void;

export type LoginSession = {
  accessToken: string;
  refreshCookie: string;
  refreshCsrfCookie: string;
  refreshCsrfToken: string;
  userId: string;
  role: Role;
  companyId: string;
};

const DEFAULT_PASSWORD = 'Password@123';

const PROFILE_NAMES: Role[] = [
  Role.SUPER_ADMIN,
  Role.ADMIN_GERAL,
  Role.ADMIN_EMPRESA,
  Role.TST,
  Role.SUPERVISOR,
  Role.COLABORADOR,
  Role.TRABALHADOR,
];

function sanitizeCookie(rawCookies: string[] | undefined, cookieName: string) {
  if (!Array.isArray(rawCookies)) {
    return '';
  }
  const tokenCookie = rawCookies
    .filter((cookie) => cookie.startsWith(`${cookieName}=`))
    .map((cookie) => cookie.split(';')[0])
    .filter((cookie) => cookie !== `${cookieName}=`)
    .at(-1);
  return tokenCookie ? tokenCookie.split(';')[0] : '';
}

function readSetCookies(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }

  return typeof value === 'string' ? [value] : [];
}

function resolveCookieParser(): CookieParserFactory | null {
  if (typeof cookieParserModule === 'function') {
    return cookieParserModule;
  }

  const candidate = (
    cookieParserModule as unknown as {
      default?: CookieParserFactory;
    }
  ).default;

  if (typeof candidate === 'function') {
    return candidate;
  }

  return null;
}

export class TestApp {
  app: INestApplication;
  dataSource: DataSource;
  private companiesRepo: Repository<Company>;
  private sitesRepo: Repository<Site>;
  private profilesRepo: Repository<Profile>;
  private usersRepo: Repository<User>;
  private passwordService: PasswordService;
  private redisClient?: Redis;
  private resetDataSource?: DataSource;
  seed: Record<TenantKey, SeedTenant>;

  static async create(): Promise<TestApp> {
    const { AppModule } = await import('../../src/app.module');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    const cookieParser = resolveCookieParser();
    if (cookieParser) {
      app.use(cookieParser());
    }
    await app.init();

    const instance = new TestApp();
    instance.app = app;
    instance.dataSource = moduleFixture.get(DataSource);
    instance.companiesRepo = instance.dataSource.getRepository(Company);
    instance.sitesRepo = instance.dataSource.getRepository(Site);
    instance.profilesRepo = instance.dataSource.getRepository(Profile);
    instance.usersRepo = instance.dataSource.getRepository(User);
    instance.passwordService = moduleFixture.get(PasswordService);
    instance.redisClient = moduleFixture.get(RedisService).getClient();
    instance.seed = { tenantA: null as never, tenantB: null as never };

    return instance;
  }

  request() {
    return request(this.app.getHttpServer() as Parameters<typeof request>[0]);
  }

  async close(): Promise<void> {
    try {
      await this.app.close();
    } finally {
      if (this.redisClient) {
        await this.closeRedisClient(this.redisClient);
        this.redisClient = undefined;
      }
      if (this.dataSource?.isInitialized) {
        await this.dataSource.destroy().catch(() => undefined);
      }
      if (this.resetDataSource?.isInitialized) {
        await this.resetDataSource.destroy().catch(() => undefined);
      }
      await this.waitForSocketDrain();
      // Forçar GC após fechar o app para liberar memória entre suítes E2E.
      // global.gc só existe quando Node é iniciado com --expose-gc.
      if (typeof (global as Record<string, unknown>).gc === 'function') {
        (global as Record<string, unknown>).gc();
      }
    }
  }

  async resetDatabase(): Promise<void> {
    await this.resetRedisEphemeralState();

    const dbType = this.dataSource.options.type;
    const resetDataSource = await this.getResetDataSource();
    if (resetDataSource !== this.dataSource) {
      this.bindSeedRepositories(resetDataSource);
    }
    if (
      dbType === 'postgres' &&
      this.isLocalTestDatabase() &&
      !this.shouldPreserveMigratedSchema()
    ) {
      // LIMITAÇÃO CONHECIDA — o schema de teste vem de synchronize(), não das
      // migrations.
      //
      // synchronize() deriva o schema apenas das entities, então nada que exista
      // somente em migration é criado aqui — em especial as POLICIES DE RLS. Na
      // prática, os testes de isolamento multi-tenant deste projeto rodam contra
      // um banco sem a barreira de RLS ativa: eles verificam o bloqueio feito
      // pela camada de aplicação (guards, escopo por tenant nas queries), não o
      // do banco.
      //
      // A suíte E2E geral mantém synchronize() por velocidade. O job dedicado de
      // DR aplica a cadeia pelo runner oficial antes de iniciar o Jest e define
      // E2E_PRESERVE_MIGRATED_SCHEMA=true; nesse modo, este helper apenas limpa
      // os dados e preserva migrations, policies, views, grants e índices.
      await this.dataSource.query(`DROP SCHEMA IF EXISTS "auth" CASCADE`);
      await this.dataSource.query(`DROP SCHEMA IF EXISTS "public" CASCADE`);
      await this.dataSource.query(`CREATE SCHEMA IF NOT EXISTS "public"`);
      await this.dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
      await this.dataSource.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
      await this.dataSource.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
      await this.dataSource.synchronize(false);
    } else if (dbType === 'postgres') {
      await resetDataSource.query(`
        DO $$
        DECLARE
          table_names TEXT;
        BEGIN
          SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
          INTO table_names
          FROM pg_tables t
          JOIN pg_class c ON c.relname = t.tablename
          JOIN pg_namespace n
            ON n.oid = c.relnamespace
           AND n.nspname = t.schemaname
          WHERE t.schemaname IN (
              'public',
              'auth',
              'operations',
              'audit',
              'documents',
              'safety'
            )
            AND NOT (
              t.schemaname = 'public'
              AND t.tablename = 'migrations'
            )
            AND NOT c.relispartition;

          IF table_names IS NOT NULL THEN
            EXECUTE 'TRUNCATE TABLE ' || table_names || ' RESTART IDENTITY CASCADE';
          END IF;
        END $$;
      `);
    } else {
      await this.dataSource.synchronize(true);
    }
    await this.seedBaseData();
  }

  async setupQuery<T = unknown>(
    query: string,
    parameters?: unknown[],
  ): Promise<T> {
    const dataSource = await this.getResetDataSource();
    const result: unknown = await dataSource.query(query, parameters);
    return result as T;
  }

  private async getResetDataSource(): Promise<DataSource> {
    const adminUrl = process.env.DATABASE_ADMIN_URL;
    if (!adminUrl || this.dataSource.options.type !== 'postgres') {
      return this.dataSource;
    }

    if (!this.resetDataSource) {
      const parsedAdminUrl = new URL(adminUrl);
      this.resetDataSource = new DataSource({
        ...this.dataSource.options,
        name: 'test-admin-reset',
        url: undefined,
        host: parsedAdminUrl.hostname,
        port: parsedAdminUrl.port
          ? Number(parsedAdminUrl.port)
          : this.dataSource.options.port,
        username: decodeURIComponent(parsedAdminUrl.username),
        password: decodeURIComponent(parsedAdminUrl.password),
        database: parsedAdminUrl.pathname.replace(/^\//, ''),
        ssl: process.env.DATABASE_SSL === 'true',
        extra: {
          options: '-c app.is_super_admin=true',
        },
        migrations: [],
        synchronize: false,
      });
      await this.resetDataSource.initialize();
    }

    return this.resetDataSource;
  }

  private bindSeedRepositories(dataSource: DataSource): void {
    this.companiesRepo = dataSource.getRepository(Company);
    this.sitesRepo = dataSource.getRepository(Site);
    this.profilesRepo = dataSource.getRepository(Profile);
    this.usersRepo = dataSource.getRepository(User);
  }

  private async resetRedisEphemeralState(): Promise<void> {
    if (!this.redisClient || process.env.NODE_ENV !== 'test') {
      return;
    }

    for (const pattern of ['throttle*', 'rate*']) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redisClient.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          250,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.redisClient.del(...keys);
        }
      } while (cursor !== '0');
    }
  }

  private async closeRedisClient(client: Redis): Promise<void> {
    try {
      if (client.status !== 'end') {
        await client.quit();
      }
    } catch {
      client.disconnect();
    }
  }

  /**
   * Em E2E, algumas conexões (Redis/PG/HTTP keep-alive) podem levar ~1-2s para
   * fechar após app.close(). O Jest alerta se o processo não drenar em 1s.
   * Este wait curto evita falso-positivo sem mascarar leaks persistentes.
   */
  private async waitForSocketDrain(maxWaitMs = 2500): Promise<void> {
    const proc = process as NodeJS.Process & {
      _getActiveHandles?: () => unknown[];
    };

    if (typeof proc._getActiveHandles !== 'function') {
      return;
    }

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const activeSockets = proc
        ._getActiveHandles()
        .filter(
          (handle) =>
            typeof handle === 'object' &&
            handle !== null &&
            (handle as { constructor?: { name?: string } }).constructor
              ?.name === 'Socket',
        ).length;

      // stdout/stderr normalmente permanecem como sockets ativos.
      if (activeSockets <= 2) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  getTenant(tenant: TenantKey): SeedTenant {
    return this.seed[tenant];
  }

  getUser(tenant: TenantKey, role: Role): SeedUserRecord {
    const tenantSeed = this.seed[tenant];
    const user = Object.values(tenantSeed.users).find(
      (item) => item.role === role,
    );
    if (!user) {
      throw new Error(`User not found for role=${role} tenant=${tenant}`);
    }
    return user;
  }

  async loginAs(role: Role, tenant: TenantKey): Promise<LoginSession> {
    const user = this.getUser(tenant, role);
    const csrfHeaders = await this.csrfHeaders();
    const response = await this.request()
      .post('/auth/login')
      .set(csrfHeaders)
      .send({ cpf: user.cpf, password: DEFAULT_PASSWORD });

    if (![200, 201].includes(response.status)) {
      throw new Error(
        `Failed login for role=${role} tenant=${tenant}. status=${response.status} body=${JSON.stringify(response.body)}`,
      );
    }

    const loginBody = response.body as {
      accessToken?: string;
      access_token?: string;
    };
    const accessToken = String(
      loginBody.accessToken || loginBody.access_token || '',
    );
    const refreshCookie = sanitizeCookie(
      readSetCookies(response.headers['set-cookie']),
      'refresh_token',
    );
    const refreshCsrfCookie = sanitizeCookie(
      readSetCookies(response.headers['set-cookie']),
      'refresh_csrf',
    );
    const refreshCsrfToken = refreshCsrfCookie.split('=').slice(1).join('=');

    if (
      !accessToken ||
      !refreshCookie ||
      !refreshCsrfCookie ||
      !refreshCsrfToken
    ) {
      throw new Error(
        'Login response missing accessToken/refresh cookie/refresh csrf token',
      );
    }

    return {
      accessToken,
      refreshCookie,
      refreshCsrfCookie,
      refreshCsrfToken,
      userId: user.id,
      role,
      companyId: user.companyId,
    };
  }

  authHeaders(
    session: LoginSession,
    options?: { companyIdOverride?: string },
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.accessToken}`,
      'x-company-id': options?.companyIdOverride || session.companyId,
    };
    return headers;
  }

  async csrfHeaders(): Promise<Record<string, string>> {
    const response = await this.request().get('/auth/csrf');
    const csrfToken = String(response.body?.csrfToken || '').trim();
    const csrfCookie =
      sanitizeCookie(
        readSetCookies(response.headers['set-cookie']),
        'csrf-token',
      ) || (csrfToken ? `csrf-token=${csrfToken}` : '');

    if (!csrfToken || !csrfCookie) {
      throw new Error(
        `Failed to bootstrap CSRF token. status=${response.status} body=${JSON.stringify(response.body)}`,
      );
    }

    return {
      'x-csrf-token': csrfToken,
      Cookie: csrfCookie,
    };
  }

  private async seedBaseData() {
    const profileMap = await this.seedProfiles();
    const passwordHash = await this.passwordService.hash(DEFAULT_PASSWORD);
    const companyA = await this.upsertCompany({
      razao_social: 'Tenant A SST LTDA',
      cnpj: '11222333000181',
      endereco: 'Rua A, 100',
      responsavel: 'Resp A',
    });
    const companyB = await this.upsertCompany({
      razao_social: 'Tenant B SST LTDA',
      cnpj: '44555666000151',
      endereco: 'Rua B, 200',
      responsavel: 'Resp B',
    });

    const siteA = await this.upsertSite({
      nome: 'Site A',
      companyId: companyA.id,
    });
    const siteB = await this.upsertSite({
      nome: 'Site B',
      companyId: companyB.id,
    });

    const usersTenantA = await this.seedTenantUsers({
      companyId: companyA.id,
      siteId: siteA.id,
      passwordHash,
      profileMap,
      suffix: 'a',
      cpfSeed: {
        adminGeral: '39053344705',
        admin: '52998224725',
        tst: '12345678909',
        worker: '11144477735',
      },
    });

    const platformAdmin = await this.upsertUser({
      nome: 'Super Admin Plataforma',
      funcao: 'SUPER_ADMIN',
      cpf: '15082302698',
      email: 'super-admin-platform@e2e.test',
      passwordHash,
      companyId: companyA.id,
      siteId: siteA.id,
      profileId: profileMap[Role.SUPER_ADMIN].id,
      aiProcessingConsent: true,
    });
    usersTenantA.platformAdmin = {
      id: platformAdmin.id,
      cpf: '15082302698',
      email: platformAdmin.email,
      role: Role.SUPER_ADMIN,
      companyId: companyA.id,
    };

    const usersTenantB = await this.seedTenantUsers({
      companyId: companyB.id,
      siteId: siteB.id,
      passwordHash,
      profileMap,
      suffix: 'b',
      cpfSeed: {
        adminGeral: '28625587887',
        admin: '15350946056',
        tst: '93541134780',
        worker: '29537914802',
      },
    });

    this.seed = {
      tenantA: {
        companyId: companyA.id,
        siteId: siteA.id,
        users: usersTenantA,
      },
      tenantB: {
        companyId: companyB.id,
        siteId: siteB.id,
        users: usersTenantB,
      },
    };
  }

  private async upsertCompany(input: {
    razao_social: string;
    cnpj: string;
    endereco: string;
    responsavel: string;
  }): Promise<Company> {
    const existing = await this.companiesRepo.findOne({
      where: { cnpj: input.cnpj },
    });

    return this.companiesRepo.save(
      this.companiesRepo.create({
        ...existing,
        razao_social: input.razao_social,
        cnpj: input.cnpj,
        endereco: input.endereco,
        responsavel: input.responsavel,
        status: true,
      }),
    );
  }

  private async upsertSite(input: {
    nome: string;
    companyId: string;
  }): Promise<Site> {
    const existing = await this.sitesRepo.findOne({
      where: {
        nome: input.nome,
        company_id: input.companyId,
      },
    });

    return this.sitesRepo.save(
      this.sitesRepo.create({
        ...existing,
        nome: input.nome,
        company_id: input.companyId,
        status: true,
      }),
    );
  }

  private isLocalTestDatabase(): boolean {
    const host = String(
      this.dataSource.options.type === 'postgres'
        ? this.dataSource.options.host || ''
        : '',
    );
    return (
      process.env.NODE_ENV === 'test' &&
      ['127.0.0.1', 'localhost'].includes(host)
    );
  }

  private shouldPreserveMigratedSchema(): boolean {
    return process.env.E2E_PRESERVE_MIGRATED_SCHEMA === 'true';
  }

  private async seedProfiles(): Promise<Record<Role, Profile>> {
    const map = {} as Record<Role, Profile>;
    for (const roleName of PROFILE_NAMES) {
      const existing = await this.profilesRepo.findOne({
        where: { nome: roleName },
      });
      const profile = await this.profilesRepo.save(
        this.profilesRepo.create({
          ...existing,
          nome: roleName,
          permissoes: [],
          status: true,
        }),
      );
      map[roleName] = profile;
    }
    return map;
  }

  private async seedTenantUsers(input: {
    companyId: string;
    siteId: string;
    passwordHash: string;
    profileMap: Record<Role, Profile>;
    suffix: string;
    cpfSeed: {
      adminGeral: string;
      admin: string;
      tst: string;
      worker: string;
    };
  }): Promise<Record<string, SeedUserRecord>> {
    const adminGeral = await this.upsertUser({
      nome: `Admin Geral ${input.suffix.toUpperCase()}`,
      funcao: 'Administrador geral',
      cpf: input.cpfSeed.adminGeral,
      email: `admin-geral-${input.suffix}@e2e.test`,
      passwordHash: input.passwordHash,
      companyId: input.companyId,
      siteId: input.siteId,
      profileId: input.profileMap[Role.ADMIN_GERAL].id,
      aiProcessingConsent: true,
    });

    const admin = await this.upsertUser({
      nome: `Admin ${input.suffix.toUpperCase()}`,
      funcao: 'Administrador da empresa',
      cpf: input.cpfSeed.admin,
      email: `admin-${input.suffix}@e2e.test`,
      passwordHash: input.passwordHash,
      companyId: input.companyId,
      siteId: input.siteId,
      profileId: input.profileMap[Role.ADMIN_EMPRESA].id,
      aiProcessingConsent: true,
    });

    const tst = await this.upsertUser({
      nome: `Tecnico ${input.suffix.toUpperCase()}`,
      funcao: 'Técnico de Segurança do Trabalho',
      cpf: input.cpfSeed.tst,
      email: `tst-${input.suffix}@e2e.test`,
      passwordHash: input.passwordHash,
      companyId: input.companyId,
      siteId: input.siteId,
      profileId: input.profileMap[Role.TST].id,
      aiProcessingConsent: true,
    });

    const worker = await this.upsertUser({
      nome: `Trabalhador ${input.suffix.toUpperCase()}`,
      funcao: 'Trabalhador operacional',
      cpf: input.cpfSeed.worker,
      email: `worker-${input.suffix}@e2e.test`,
      passwordHash: input.passwordHash,
      companyId: input.companyId,
      siteId: input.siteId,
      profileId: input.profileMap[Role.TRABALHADOR].id,
      aiProcessingConsent: false,
    });

    return {
      adminGeral: {
        id: adminGeral.id,
        cpf: input.cpfSeed.adminGeral,
        email: adminGeral.email,
        role: Role.ADMIN_GERAL,
        companyId: input.companyId,
      },
      admin: {
        id: admin.id,
        cpf: input.cpfSeed.admin,
        email: admin.email,
        role: Role.ADMIN_EMPRESA,
        companyId: input.companyId,
      },
      tst: {
        id: tst.id,
        cpf: input.cpfSeed.tst,
        email: tst.email,
        role: Role.TST,
        companyId: input.companyId,
      },
      worker: {
        id: worker.id,
        cpf: input.cpfSeed.worker,
        email: worker.email,
        role: Role.TRABALHADOR,
        companyId: input.companyId,
      },
    };
  }

  private async upsertUser(input: {
    nome: string;
    funcao: string;
    cpf: string;
    email: string;
    passwordHash: string;
    companyId: string;
    siteId: string;
    profileId: string;
    aiProcessingConsent: boolean;
  }): Promise<User> {
    const cpf = input.cpf.replace(/\D/g, '');
    const cpfHash = hashSensitiveValue(cpf);
    const cpfCiphertext = encryptSensitiveValue(cpf);
    const existing = await this.usersRepo.findOne({
      where: [{ email: input.email }, { cpf_hash: cpfHash }, { cpf }],
    });

    return this.usersRepo.save(
      this.usersRepo.create({
        ...existing,
        nome: input.nome,
        funcao: input.funcao,
        cpf,
        cpf_hash: cpfHash,
        cpf_ciphertext: cpfCiphertext,
        email: input.email,
        password: input.passwordHash,
        company_id: input.companyId,
        site_id: input.siteId,
        profile_id: input.profileId,
        module_access_keys: [],
        status: true,
        ai_processing_consent: input.aiProcessingConsent,
      }),
    );
  }
}
