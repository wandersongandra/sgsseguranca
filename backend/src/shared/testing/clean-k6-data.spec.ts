import type { PoolConfig } from 'pg';

import {
  CleanupExecutionError,
  CleanupGuardError,
  type CleanupDbClient,
  type CleanupPool,
  type CleanupPoolFactory,
  parseCleanupArguments,
  runCleanup,
} from '../../../scripts/clean-k6-data';

type QueryCall = {
  text: string;
  values?: readonly unknown[];
};

type CountRow = {
  companies: string;
  sites: string;
  users: string;
  aprs: string;
  pts: string;
};

const DEFAULT_COUNTS: CountRow = {
  companies: '2',
  sites: '2',
  users: '2',
  aprs: '3',
  pts: '1',
};

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'loadtest',
    NODE_ENV: 'test',
    DATABASE_URL:
      'postgresql://fixture:encoded%40password@127.0.0.1:5433/sgs_loadtest?sslmode=disable',
    DATABASE_SSL: 'false',
    SGS_K6_ALLOWED_DATABASE: 'sgs_loadtest',
    SGS_K6_ALLOWED_HOST: '127.0.0.1',
    SGS_K6_ALLOWED_PORT: '5433',
  };
}

function createHarness(counts: CountRow = DEFAULT_COUNTS): {
  calls: QueryCall[];
  client: CleanupDbClient;
  pool: CleanupPool;
  release: jest.Mock<void, [Error?]>;
  end: jest.Mock<Promise<void>, []>;
  factory: jest.MockedFunction<CleanupPoolFactory>;
  query: jest.Mock<
    Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
    [string, readonly unknown[] | undefined]
  >;
} {
  const calls: QueryCall[] = [];
  const query = jest.fn<
    Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
    [string, readonly unknown[] | undefined]
  >();
  query.mockImplementation((text, values) => {
    calls.push({ text, values });
    if (text.includes('count(*)')) {
      return Promise.resolve({ rows: [counts], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });

  const release = jest.fn<void, [Error?]>();
  const end = jest.fn<Promise<void>, []>(() => Promise.resolve());

  const client: CleanupDbClient = {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) =>
      query(text, values) as Promise<{
        rows: T[];
        rowCount: number | null;
      }>,
    release,
  };
  const pool: CleanupPool = {
    connect: jest.fn(() => Promise.resolve(client)),
    end,
  };
  const factory = jest.fn<CleanupPool, [PoolConfig]>(
    () => pool,
  ) as jest.MockedFunction<CleanupPoolFactory>;

  return { calls, client, pool, release, end, factory, query };
}

function queryTexts(calls: QueryCall[]): string[] {
  return calls.map(({ text }) => text);
}

function expectDeniedBeforeConnection(
  promise: Promise<unknown>,
  factory: jest.MockedFunction<CleanupPoolFactory>,
): Promise<void> {
  return expect(promise)
    .rejects.toBeInstanceOf(CleanupGuardError)
    .then(() => {
      expect(factory).not.toHaveBeenCalled();
    });
}

describe('clean-k6-data safety contract', () => {
  it('assumes dry-run when no destructive flag is supplied', () => {
    expect(parseCleanupArguments([])).toEqual({
      dryRun: true,
      execute: false,
      confirmation: false,
    });
  });

  it('requires explicit execution and rejects conflicting or unknown flags', () => {
    expect(
      parseCleanupArguments(['--execute', '--confirm-loadtest-cleanup']),
    ).toEqual({
      dryRun: false,
      execute: true,
      confirmation: true,
    });
    expect(() => parseCleanupArguments(['--execute', '--dry-run'])).toThrow(
      CleanupGuardError,
    );
    expect(() => parseCleanupArguments(['--force'])).toThrow(CleanupGuardError);
    expect(() => parseCleanupArguments(['--confirm-loadtest-cleanup'])).toThrow(
      CleanupGuardError,
    );
  });

  it('runs a valid synthetic target in dry-run without opening a transaction', async () => {
    const env = baseEnvironment();
    const harness = createHarness();

    const result = await runCleanup(env, [], harness.factory);

    expect(result).toMatchObject({
      mode: 'dry-run',
      target: {
        databaseName: 'sgs_loadtest',
        hostname: '127.0.0.1',
        port: 5433,
        isLocal: true,
      },
      counts: { companies: 2, sites: 2, users: 2, aprs: 3, pts: 1 },
    });
    expect(queryTexts(harness.calls)).not.toContain('BEGIN');
    expect(
      queryTexts(harness.calls).some((text) => text.startsWith('UPDATE')),
    ).toBe(false);
    expect(harness.factory).toHaveBeenCalledTimes(1);
    expect(harness.factory.mock.calls[0][0]).toMatchObject({
      ssl: false,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    expect(harness.factory.mock.calls[0][0].connectionString).toBe(
      env.DATABASE_URL,
    );
  });

  it('keeps dry-run when authorization exists but --execute is absent', async () => {
    const env = {
      ...baseEnvironment(),
      SGS_K6_CLEANUP_ALLOWED: 'true',
      SGS_K6_MAX_COMPANIES: '10',
    };
    const harness = createHarness();

    const result = await runCleanup(env, [], harness.factory);

    expect(result.mode).toBe('dry-run');
    expect(
      queryTexts(harness.calls).some((text) => text.startsWith('UPDATE')),
    ).toBe(false);
  });

  it('denies missing, ambiguous, or incorrectly cased execution authorization', async () => {
    for (const value of [undefined, 'false', '1', 'yes', 'TRUE', 'true ']) {
      const env = {
        ...baseEnvironment(),
        ...(value === undefined ? {} : { SGS_K6_CLEANUP_ALLOWED: value }),
        SGS_K6_MAX_COMPANIES: '10',
      };
      const harness = createHarness();

      await expectDeniedBeforeConnection(
        runCleanup(
          env,
          ['--execute', '--confirm-loadtest-cleanup'],
          harness.factory,
        ),
        harness.factory,
      );
    }
  });

  it('denies execute without independent confirmation or mutation bound', async () => {
    const env = { ...baseEnvironment(), SGS_K6_CLEANUP_ALLOWED: 'true' };
    const harness = createHarness();

    await expectDeniedBeforeConnection(
      runCleanup(env, ['--execute'], harness.factory),
      harness.factory,
    );
  });

  it('rejects missing loadtest environment and production defense-in-depth', async () => {
    const missingEnvironment = baseEnvironment();
    delete missingEnvironment.APP_ENV;
    const first = createHarness();
    await expectDeniedBeforeConnection(
      runCleanup(missingEnvironment, [], first.factory),
      first.factory,
    );

    const production = {
      ...baseEnvironment(),
      NODE_ENV: 'production',
      SGS_K6_CLEANUP_ALLOWED: 'true',
      SGS_K6_MAX_COMPANIES: '10',
    };
    const second = createHarness();
    await expectDeniedBeforeConnection(
      runCleanup(
        production,
        ['--execute', '--confirm-loadtest-cleanup'],
        second.factory,
      ),
      second.factory,
    );
  });

  it('binds database name, host, and port before creating a pool', async () => {
    for (const changes of [
      {
        DATABASE_URL: baseEnvironment().DATABASE_URL?.replace(
          'sgs_loadtest',
          'other_db',
        ),
      },
      {
        DATABASE_URL: baseEnvironment().DATABASE_URL?.replace(
          '127.0.0.1',
          'db.internal',
        ),
      },
      {
        DATABASE_URL: baseEnvironment().DATABASE_URL?.replace(
          ':5433/',
          ':5434/',
        ),
      },
    ]) {
      const harness = createHarness();
      await expectDeniedBeforeConnection(
        runCleanup({ ...baseEnvironment(), ...changes }, [], harness.factory),
        harness.factory,
      );
    }
  });

  it('rejects malformed, non-PostgreSQL, missing-database, and invalid-port targets', async () => {
    const invalidUrls = [
      'not-a-database-url',
      'https://fixture:password@127.0.0.1/sgs_loadtest',
      'postgresql://fixture:password@127.0.0.1',
      'postgresql://fixture:password@127.0.0.1:99999/sgs_loadtest',
    ];

    for (const DATABASE_URL of invalidUrls) {
      const harness = createHarness();
      await expectDeniedBeforeConnection(
        runCleanup({ ...baseEnvironment(), DATABASE_URL }, [], harness.factory),
        harness.factory,
      );
    }
  });

  it('allows local IPv6 targets and parses encoded credentials/query parameters without logging them', async () => {
    const env = {
      ...baseEnvironment(),
      DATABASE_URL:
        'postgresql://fixture:encoded%40password@[::1]:5432/sgs_loadtest?sslmode=disable',
      SGS_K6_ALLOWED_HOST: '::1',
      SGS_K6_ALLOWED_PORT: '5432',
    };
    const harness = createHarness();

    const result = await runCleanup(env, [], harness.factory);

    expect(result.target).toMatchObject({
      hostname: '::1',
      port: 5432,
      isLocal: true,
    });
    expect(JSON.stringify(result)).not.toContain('encoded@password');
  });

  it('rejects DATABASE_SSL=false for remote and private-network targets', async () => {
    for (const hostname of ['db.internal', '10.20.30.40']) {
      const env = {
        ...baseEnvironment(),
        DATABASE_URL: `postgresql://fixture:password@${hostname}:5432/sgs_loadtest`,
        SGS_K6_ALLOWED_HOST: hostname,
        SGS_K6_ALLOWED_PORT: '5432',
      };
      const harness = createHarness();

      await expectDeniedBeforeConnection(
        runCleanup(env, [], harness.factory),
        harness.factory,
      );
    }
  });

  it('uses TLS for a valid remote target when DATABASE_SSL is true', async () => {
    const env = {
      ...baseEnvironment(),
      DATABASE_URL:
        'postgresql://fixture:password@db.internal:5432/sgs_loadtest',
      DATABASE_SSL: 'true',
      SGS_K6_ALLOWED_HOST: 'db.internal',
      SGS_K6_ALLOWED_PORT: '5432',
    };
    const harness = createHarness();

    await runCleanup(env, [], harness.factory);

    expect(harness.factory.mock.calls[0][0].ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('requires exact SSL values', async () => {
    const env = { ...baseEnvironment(), DATABASE_SSL: 'sometimes' };
    const harness = createHarness();

    await expectDeniedBeforeConnection(
      runCleanup(env, [], harness.factory),
      harness.factory,
    );
  });

  it('uses the paired seed markers as an ownership boundary', async () => {
    const env = baseEnvironment();
    const harness = createHarness();

    await runCleanup(env, [], harness.factory);

    const countCall = harness.calls.find(({ text }) =>
      text.includes('count(*)'),
    );
    expect(countCall?.values).toEqual(['K6\\_%', 'k6.%@test.local']);
    expect(countCall?.text).toContain('ESCAPE CHR(92)');
    expect(countCall?.text).toContain('public.companies');
    expect(countCall?.text).toContain('public.users');
    expect(countCall?.text).toContain('owner_user.deleted_at IS NULL');
  });

  it('executes only after authorization, confirmation, target validation, and count bound', async () => {
    const env = {
      ...baseEnvironment(),
      SGS_K6_CLEANUP_ALLOWED: 'true',
      SGS_K6_MAX_COMPANIES: '10',
    };
    const harness = createHarness();

    const result = await runCleanup(
      env,
      ['--execute', '--confirm-loadtest-cleanup'],
      harness.factory,
    );

    const texts = queryTexts(harness.calls);
    expect(result.mode).toBe('execute');
    expect(texts[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(
      texts.filter((text) => text.startsWith('UPDATE public.')),
    ).toHaveLength(5);
    expect(texts).toContain('COMMIT');
    expect(texts).not.toContain('ROLLBACK');
    expect(harness.release).toHaveBeenCalled();
    expect(harness.end).toHaveBeenCalled();
  });

  it('rolls back and refuses commit when the company bound is exceeded', async () => {
    const env = {
      ...baseEnvironment(),
      SGS_K6_CLEANUP_ALLOWED: 'true',
      SGS_K6_MAX_COMPANIES: '1',
    };
    const harness = createHarness();

    await expect(
      runCleanup(
        env,
        ['--execute', '--confirm-loadtest-cleanup'],
        harness.factory,
      ),
    ).rejects.toBeInstanceOf(CleanupGuardError);

    const texts = queryTexts(harness.calls);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
    expect(texts.some((text) => text.startsWith('UPDATE'))).toBe(false);
  });

  it('rolls back on mutation failure and exposes only a sanitized execution error', async () => {
    const env = {
      ...baseEnvironment(),
      SGS_K6_CLEANUP_ALLOWED: 'true',
      SGS_K6_MAX_COMPANIES: '10',
    };
    const harness = createHarness();
    harness.query.mockImplementationOnce((text, values) => {
      harness.calls.push({ text, values });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    harness.query.mockImplementationOnce((text, values) => {
      harness.calls.push({ text, values });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    harness.query.mockImplementationOnce((text, values) => {
      harness.calls.push({ text, values });
      return Promise.resolve({ rows: [], rowCount: 2 });
    });
    harness.query.mockImplementationOnce((text, values) => {
      harness.calls.push({ text, values });
      return Promise.resolve({ rows: [DEFAULT_COUNTS], rowCount: 1 });
    });
    harness.query.mockImplementationOnce((text, values) => {
      harness.calls.push({ text, values });
      return Promise.reject(
        new Error('connection string and private database details'),
      );
    });

    await expect(
      runCleanup(
        env,
        ['--execute', '--confirm-loadtest-cleanup'],
        harness.factory,
      ),
    ).rejects.toBeInstanceOf(CleanupExecutionError);

    const texts = queryTexts(harness.calls);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
  });
});
