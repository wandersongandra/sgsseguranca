import { DataSource } from 'typeorm';
import { TenantService } from '../tenant/tenant.service';
import { DbTimingsService } from './db-timings.service';
import { TenantDbContextService } from './tenant-db-context.service';

type TestPgClient = {
  query: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
  release: jest.Mock<void, [Error?]>;
};

type TestPgPool = {
  connect: jest.Mock<
    void,
    [
      (
        err: Error | null,
        client?: TestPgClient,
        release?: (err?: Error) => void,
      ) => void,
    ]
  >;
};

function createClient(): TestPgClient {
  const query = jest.fn<Promise<unknown>, [string, unknown[]?]>();
  query.mockResolvedValue({});
  const release = jest.fn<void, [Error?]>();

  return {
    query,
    release,
  };
}

function createPool(client: TestPgClient): TestPgPool {
  return {
    connect: jest.fn((callback) => callback(null, client)),
  };
}

describe('TenantDbContextService', () => {
  const buildService = (driver: unknown, tenantContext?: unknown) => {
    const dataSource = {
      isInitialized: true,
      options: { type: 'postgres' },
      driver,
    } as DataSource;
    const tenantService = {
      getContext: jest.fn(() => tenantContext),
    } as unknown as TenantService;
    const dbTimings = {
      recordBorrowWait: jest.fn(),
      recordRlsContextSet: jest.fn(),
      isEnabled: jest.fn(() => false),
    } as unknown as DbTimingsService;

    return new TenantDbContextService(dataSource, tenantService, dbTimings);
  };

  it('injeta contexto RLS no pool master e nos pools slaves da replica', async () => {
    const masterClient = createClient();
    const slaveClient = createClient();
    const master = createPool(masterClient);
    const slave = createPool(slaveClient);
    const service = buildService(
      { master, slaves: [slave] },
      {
        companyId: '11111111-1111-4111-8111-111111111111',
        isSuperAdmin: false,
        userId: '22222222-2222-4222-8222-222222222222',
        siteId: '33333333-3333-4333-8333-333333333333',
        siteScope: 'single',
      },
    );

    await service.onApplicationBootstrap();

    await new Promise<void>((resolve, reject) => {
      master.connect((err, client, release) => {
        if (err || !client || !release) {
          reject(err ?? new Error('master client ausente'));
          return;
        }
        release();
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      slave.connect((err, client, release) => {
        if (err || !client || !release) {
          reject(err ?? new Error('slave client ausente'));
          return;
        }
        release();
        resolve();
      });
    });

    for (const client of [masterClient, slaveClient]) {
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining("set_config('app.current_company_id'"),
        expect.arrayContaining([
          '11111111-1111-4111-8111-111111111111',
          'false',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          'single',
        ]),
      );
    }
  });

  it('nao concede bypass RLS para ADMIN_GERAL quando ha tenant efetivo', async () => {
    const client = createClient();
    const pool = createPool(client);
    const service = buildService(
      { master: pool },
      {
        companyId: '11111111-1111-4111-8111-111111111111',
        isSuperAdmin: true,
        userId: '22222222-2222-4222-8222-222222222222',
        siteScope: 'all',
      },
    );

    await service.onApplicationBootstrap();

    await new Promise<void>((resolve, reject) => {
      pool.connect((err, pgClient, release) => {
        if (err || !pgClient || !release) {
          reject(err ?? new Error('client ausente'));
          return;
        }
        release();
        resolve();
      });
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("set_config('app.is_super_admin'"),
      expect.arrayContaining(['11111111-1111-4111-8111-111111111111', 'false']),
    );
  });

  it('injeta todos os sites autorizados no contexto RLS sem perder o site ativo', async () => {
    const client = createClient();
    const pool = createPool(client);
    const service = buildService(
      { master: pool },
      {
        companyId: '11111111-1111-4111-8111-111111111111',
        isSuperAdmin: false,
        userId: '22222222-2222-4222-8222-222222222222',
        siteId: '33333333-3333-4333-8333-333333333333',
        siteIds: [
          '33333333-3333-4333-8333-333333333333',
          '44444444-4444-4444-8444-444444444444',
        ],
        siteScope: 'single',
      },
    );

    await service.onApplicationBootstrap();

    await new Promise<void>((resolve, reject) => {
      pool.connect((err, pgClient, release) => {
        if (err || !pgClient || !release) {
          reject(err ?? new Error('client ausente'));
          return;
        }
        release();
        resolve();
      });
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("set_config('app.current_site_ids'"),
      expect.arrayContaining([
        '33333333-3333-4333-8333-333333333333,44444444-4444-4444-8444-444444444444',
      ]),
    );
  });

  it('mantem bypass RLS apenas para ADMIN_GERAL sem tenant efetivo', async () => {
    const client = createClient();
    const pool = createPool(client);
    const service = buildService(
      { master: pool },
      {
        companyId: undefined,
        isSuperAdmin: true,
        userId: '22222222-2222-4222-8222-222222222222',
        siteScope: 'all',
      },
    );

    await service.onApplicationBootstrap();

    await new Promise<void>((resolve, reject) => {
      pool.connect((err, pgClient, release) => {
        if (err || !pgClient || !release) {
          reject(err ?? new Error('client ausente'));
          return;
        }
        release();
        resolve();
      });
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("set_config('app.is_super_admin'"),
      expect.arrayContaining(['', 'true']),
    );
  });

  it('reaplica o contexto RLS ao emprestar a mesma conexao novamente', async () => {
    const client = createClient();
    const pool = createPool(client);
    const service = buildService(
      { master: pool },
      {
        companyId: '11111111-1111-4111-8111-111111111111',
        isSuperAdmin: false,
        siteScope: 'single',
      },
    );
    await service.onApplicationBootstrap();

    const borrowAndRelease = () =>
      new Promise<void>((resolve, reject) => {
        pool.connect((err, pgClient, release) => {
          if (err || !pgClient || !release) {
            reject(err ?? new Error('client ausente'));
            return;
          }
          release();
          resolve();
        });
      });

    await borrowAndRelease();
    await borrowAndRelease();

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("set_config('app.current_company_id'"),
      expect.arrayContaining(['11111111-1111-4111-8111-111111111111']),
    );
  });

  it('nao reaproveita tenant anterior quando o mesmo client muda de contexto', async () => {
    const client = createClient();
    const pool = createPool(client);
    const tenants = [
      { companyId: '11111111-1111-4111-8111-111111111111', isSuperAdmin: false },
      { companyId: '44444444-4444-4444-8444-444444444444', isSuperAdmin: false },
    ];
    let index = 0;
    const dataSource = {
      isInitialized: true,
      options: { type: 'postgres' },
      driver: { master: pool },
    } as DataSource;
    const tenantService = {
      getContext: jest.fn(() => tenants[Math.min(index++, tenants.length - 1)]),
    } as unknown as TenantService;
    const dbTimings = {
      recordBorrowWait: jest.fn(),
      recordRlsContextSet: jest.fn(),
      isEnabled: jest.fn(() => false),
    } as unknown as DbTimingsService;
    const service = new TenantDbContextService(dataSource, tenantService, dbTimings);
    await service.onApplicationBootstrap();

    const checkout = () =>
      new Promise<void>((resolve, reject) => {
        pool.connect((err, pgClient, release) => {
          if (err || !pgClient || !release) {
            reject(err ?? new Error('client ausente'));
            return;
          }
          release();
          resolve();
        });
      });

    await checkout();
    await checkout();

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("set_config('app.current_company_id'"),
      expect.arrayContaining(['11111111-1111-4111-8111-111111111111']),
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("set_config('app.current_company_id'"),
      expect.arrayContaining(['44444444-4444-4444-8444-444444444444']),
    );
  });

  it('descarta e rejeita a conexao quando o SET do contexto RLS falha', async () => {
    const client = createClient();
    client.query.mockRejectedValueOnce(new Error('falha simulada no SET'));
    const pool = createPool(client);
    const service = buildService(
      { master: pool },
      {
        companyId: '11111111-1111-4111-8111-111111111111',
        isSuperAdmin: false,
      },
    );
    await service.onApplicationBootstrap();

    await expect(
      new Promise<void>((resolve, reject) => {
        pool.connect((err, pgClient, release) => {
          if (err) {
            reject(err);
            return;
          }
          if (pgClient && release) release();
          resolve();
        });
      }),
    ).rejects.toThrow('falha simulada no SET');

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('falha fechado quando PostgreSQL não expõe nenhum pool para patch', async () => {
    const service = buildService({});

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      'O contexto RLS não pôde ser instalado',
    );
  });

  it('não aceita requests durante a janela entre initialize e o patch RLS', async () => {
    const client = createClient();
    const pool = createPool(client);
    const dataSourceState = {
      isInitialized: false,
      options: { type: 'postgres' },
      driver: {} as unknown,
    };
    const dataSource = dataSourceState as unknown as DataSource;
    const tenantService = {
      getContext: jest.fn(() => ({
        companyId: '11111111-1111-4111-8111-111111111111',
        isSuperAdmin: false,
      })),
    } as unknown as TenantService;
    const dbTimings = {
      recordBorrowWait: jest.fn(),
      recordRlsContextSet: jest.fn(),
      isEnabled: jest.fn(() => false),
    } as unknown as DbTimingsService;
    const service = new TenantDbContextService(
      dataSource,
      tenantService,
      dbTimings,
    );

    const bootstrap = service.onApplicationBootstrap();
    dataSourceState.driver = { master: pool };
    dataSourceState.isInitialized = true;
    await bootstrap;

    await new Promise<void>((resolve, reject) => {
      pool.connect((err, pgClient, release) => {
        if (err || !pgClient || !release) {
          reject(err ?? new Error('client ausente'));
          return;
        }
        release();
        resolve();
      });
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("set_config('app.current_company_id'"),
      expect.any(Array),
    );
    service.onModuleDestroy();
  });
});
