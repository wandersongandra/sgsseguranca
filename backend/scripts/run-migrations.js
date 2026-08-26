require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const { DataSource } = require('typeorm');
const crypto = require('crypto');
const {
  describeDatabaseTarget,
  firstNonEmpty,
  resolveDatabaseConfig,
  resolveSslConfig,
} = require('./database-runtime.config');
const { assertMigrationManifest } = require('./migration-manifest');
const {
  ensureMigrationsTable,
  filterPendingMigrations,
  getMigrationName,
  getMigrationTimestamp,
  loadExecutedMigrationRows,
} = require('./migration-history-compatibility');
const {
  assertScriptEnvironment,
} = require('./assert-environment-contract.cjs');

const DEFERRED_PRODUCTION_MIGRATION_IDS = [
  '1709000000086',
  '1709000000087',
  '1709000000088',
  '1709000000089',
  '1709000000090',
  '1709000000091',
  '1709000000092',
  '1709000000093',
  '1709000000094',
];

function clampPositiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function computeAdvisoryLockId(input) {
  // Postgres advisory lock uses signed bigint. We generate a stable positive bigint < 2^63.
  const hash = crypto.createHash('sha256').update(String(input)).digest();
  const asU64 = hash.readBigUInt64BE(0);
  const maxSignedBigInt = BigInt('9223372036854775807');
  return (asU64 % maxSignedBigInt).toString();
}

async function acquireAdvisoryLock(queryRunner, lockId, timeoutMs) {
  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    attempt += 1;
    const rows = await queryRunner.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [lockId],
    );
    const locked = Boolean(rows && rows[0] && rows[0].locked);
    if (locked) {
      console.log(
        `[MIGRATIONS] Advisory lock acquired (lockId=${lockId}, attempts=${attempt}).`,
      );
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Timed out waiting for advisory lock after ${timeoutMs}ms (lockId=${lockId}).`,
      );
    }

    if (attempt === 1 || attempt % 10 === 0) {
      console.log(
        `[MIGRATIONS] Waiting for advisory lock (lockId=${lockId}, attempt=${attempt})...`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function releaseAdvisoryLock(queryRunner, lockId) {
  try {
    await queryRunner.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]);
    console.log(`[MIGRATIONS] Advisory lock released (lockId=${lockId}).`);
  } catch (err) {
    console.warn(
      `[MIGRATIONS] Failed to release advisory lock (lockId=${lockId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function buildDataSource(databaseConfig, sslConfig = resolveSslConfig()) {
  const targetConfig = databaseConfig || resolveDatabaseConfig();
  const migrations = resolveMigrationsForExecution();

  if (targetConfig.url) {
    console.log(
      `[MIGRATIONS] Using database URL from ${targetConfig.source || 'environment'} (${targetConfig.target}).`,
    );
    return new DataSource({
      type: 'postgres',
      url: targetConfig.url,
      ssl: sslConfig,
      synchronize: false,
      entities: ['dist/!(database|seed|queue|worker)/**/*.entity.js'],
      migrations,
    });
  }

  console.log(`[MIGRATIONS] Using host credentials (${targetConfig.target}).`);
  return new DataSource({
    type: 'postgres',
    host: targetConfig.host,
    port: targetConfig.port,
    username: targetConfig.username,
    password: targetConfig.password,
    database: targetConfig.database,
    ssl: sslConfig,
    synchronize: false,
    entities: ['dist/!(database|seed|queue|worker)/**/*.entity.js'],
    migrations,
  });
}

function isNetworkReachabilityError(error) {
  const code = String(error && error.code ? error.code : '').toUpperCase();
  const message =
    error && typeof error.message === 'string'
      ? error.message.toLowerCase()
      : '';

  return (
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    message.includes('enetworkunreach') ||
    message.includes('enetunreach') ||
    message.includes('ehostunreach') ||
    message.includes('connect timeout') ||
    message.includes('connection terminated unexpectedly')
  );
}

function resolveDatabaseConfigWithDirectFallback() {
  const preferredConfig = resolveDatabaseConfig();
  assertProductionMigrationUsesDedicatedUrl(preferredConfig);
  const directUrl = firstNonEmpty(process.env.DATABASE_DIRECT_URL);
  const pooledUrl = firstNonEmpty(process.env.DATABASE_URL);

  if (!directUrl || !pooledUrl) {
    return {
      primary: preferredConfig,
      fallback: null,
      prefersDirectUrl: false,
    };
  }

  const normalizedPrimary = String(preferredConfig.url || '').trim();
  const normalizedDirect = String(directUrl).trim();
  if (!normalizedPrimary || normalizedPrimary !== normalizedDirect) {
    return {
      primary: preferredConfig,
      fallback: null,
      prefersDirectUrl: false,
    };
  }

  return {
    primary: preferredConfig,
    fallback: {
      source: 'DATABASE_URL',
      url: pooledUrl,
      target: describeDatabaseTarget(pooledUrl),
    },
    prefersDirectUrl: true,
  };
}

function assertProductionMigrationUsesDedicatedUrl(databaseConfig) {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  if (databaseConfig && databaseConfig.source === 'DATABASE_MIGRATION_URL') {
    return;
  }

  throw new Error(
    'DATABASE_MIGRATION_URL é obrigatório para migrations em produção. Não execute DDL usando DATABASE_URL/runtime.',
  );
}

async function assertMigrationRoleIsNotRuntimeRole(dataSource, databaseConfig) {
  const rows = await dataSource.query('SELECT current_user AS current_user');
  const currentUser =
    rows && rows[0] && typeof rows[0].current_user === 'string'
      ? rows[0].current_user
      : 'unknown';

  console.log(
    `[MIGRATIONS] Connected as database role "${currentUser}" via ${databaseConfig.source || 'unknown-source'}.`,
  );

  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  if (currentUser === 'sgs_app') {
    throw new Error(
      'Migration bloqueada: DATABASE_MIGRATION_URL está apontando para o role runtime sgs_app.',
    );
  }
}

function resolveDeferredMigrationIds() {
  const envValue = process.env.MIGRATION_DEFERRED_IDS;
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return envValue
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  if (process.env.NODE_ENV === 'production') {
    return DEFERRED_PRODUCTION_MIGRATION_IDS;
  }

  return [];
}

function resolveMigrationsForExecution() {
  const deferredIds = resolveDeferredMigrationIds();
  assertMigrationManifest(undefined, { deferredIds });

  const distDir = path.resolve(
    __dirname,
    '..',
    'dist',
    'infra',
    'database',
    'migrations',
  );
  const deferredIdSet = new Set(deferredIds);

  if (!fs.existsSync(distDir)) {
    return ['dist/infra/database/migrations/*.js'];
  }

  const files = fs
    .readdirSync(distDir)
    .filter((file) => file.endsWith('.js'))
    .sort();

  const deferred = [];
  const active = [];

  for (const file of files) {
    const migrationId = file.slice(0, 13);
    if (deferredIdSet.has(migrationId)) {
      deferred.push(file);
      continue;
    }
    active.push(path.join(distDir, file));
  }

  if (deferred.length > 0) {
    console.warn(
      `[MIGRATIONS] Deferred production migration batch skipped by policy: ${deferred.join(', ')}`,
    );
  }

  return active;
}

async function initializeDataSourceWithStrictTls(databaseConfig) {
  const dataSource = buildDataSource(databaseConfig);
  await dataSource.initialize();
  return dataSource;
}

async function initializeMigrationDataSource() {
  const { primary, fallback, prefersDirectUrl } =
    resolveDatabaseConfigWithDirectFallback();

  try {
    const dataSource = await initializeDataSourceWithStrictTls(primary);
    try {
      await assertMigrationRoleIsNotRuntimeRole(dataSource, primary);
    } catch (error) {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
      throw error;
    }
    return { dataSource, databaseConfig: primary };
  } catch (error) {
    if (!prefersDirectUrl || !fallback || !isNetworkReachabilityError(error)) {
      throw error;
    }

    console.warn(
      `[MIGRATIONS] Direct database connection unreachable (${primary.target}). Falling back to pooled DATABASE_URL (${fallback.target}).`,
    );

    const dataSource = await initializeDataSourceWithTlsFallback(fallback);
    try {
      await assertMigrationRoleIsNotRuntimeRole(dataSource, fallback);
    } catch (fallbackError) {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
      throw fallbackError;
    }
    return { dataSource, databaseConfig: fallback };
  }
}

function isDuplicateMigrationsPrimaryKeyError(err) {
  if (!err) {
    return false;
  }

  const message = String(err.message || err);
  const code = String(err.code || '');

  return (
    code === '23505' &&
    /duplicate key value/i.test(message) &&
    /PK_8c82d7f526340ab734260ea46be/i.test(message)
  );
}

async function runMigrationsWithRaceTolerance(dataSource) {
  try {
    return await runMigrationsInDeterministicOrder(dataSource);
  } catch (err) {
    if (!isDuplicateMigrationsPrimaryKeyError(err)) {
      throw err;
    }

    console.warn(
      '[MIGRATIONS] Duplicate insert detected in migrations table. Verifying pending migrations state...',
    );
    const stillPending = await getPendingMigrations(dataSource);
    if (stillPending.length > 0) {
      throw err;
    }

    console.warn(
      '[MIGRATIONS] Migration race resolved: no pending migrations remain. Continuing startup.',
    );
    return [];
  }
}

async function getPendingMigrations(dataSource) {
  await ensureMigrationsTable(dataSource);
  const executedRows = await loadExecutedMigrationRows(dataSource);
  const executedNames = new Set(
    executedRows.map((row) => String(row.name || '').trim()).filter(Boolean),
  );
  return filterPendingMigrations(dataSource.migrations, executedNames);
}

async function executeMigration(dataSource, migration) {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  const useTransaction = migration.transaction !== false;
  const migrationName = getMigrationName(migration);
  const migrationTimestamp = Number(getMigrationTimestamp(migration));

  if (!migrationName || !Number.isSafeInteger(migrationTimestamp)) {
    throw new Error(`Invalid migration identity: ${migrationName}`);
  }

  try {
    if (useTransaction) {
      await queryRunner.beforeMigration();
      await queryRunner.startTransaction();
    }

    await migration.up(queryRunner);
    await queryRunner.query(
      'INSERT INTO "migrations"("timestamp", "name") VALUES ($1, $2)',
      [migrationTimestamp, migrationName],
    );

    if (useTransaction) {
      await queryRunner.commitTransaction();
      await queryRunner.afterMigration();
    }

    console.log(`[MIGRATIONS] Applied ${migrationName} successfully.`);
    return migration;
  } catch (error) {
    if (useTransaction && queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function runMigrationsInDeterministicOrder(dataSource) {
  const pending = await getPendingMigrations(dataSource);
  const applied = [];

  for (const migration of pending) {
    applied.push(await executeMigration(dataSource, migration));
  }

  return applied;
}

async function main() {
  assertScriptEnvironment({
    component: 'migration',
    validateFeatureIntegrations: false,
  });
  const { dataSource, databaseConfig } = await initializeMigrationDataSource();
  const lockInput =
    process.env.MIGRATION_ADVISORY_LOCK_INPUT ||
    `typeorm-migrations:${databaseConfig.target || 'unknown'}`;
  const lockId =
    process.env.MIGRATION_ADVISORY_LOCK_ID || computeAdvisoryLockId(lockInput);
  const lockTimeoutMs = clampPositiveInt(
    process.env.MIGRATION_ADVISORY_LOCK_TIMEOUT_MS,
    5 * 60_000,
    5_000,
    30 * 60_000,
  );
  let lockRunner;
  try {
    lockRunner = dataSource.createQueryRunner();
    await lockRunner.connect();
    await acquireAdvisoryLock(lockRunner, lockId, lockTimeoutMs);
    const pending = await getPendingMigrations(dataSource);
    if (pending.length === 0) {
      console.log('[MIGRATIONS] No pending migrations.');
      return;
    }
    console.log('[MIGRATIONS] Applying pending migrations...');
    const applied = await runMigrationsWithRaceTolerance(dataSource);
    console.log(`[MIGRATIONS] Applied ${applied.length} migration(s).`);
  } finally {
    if (lockRunner) {
      await releaseAdvisoryLock(lockRunner, lockId);
      try {
        await lockRunner.release();
      } catch {
        // noop
      }
    }
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[MIGRATIONS] Failed:', err.message || err);
    process.exit(1);
  });
}

module.exports = {
  acquireAdvisoryLock,
  clampPositiveInt,
  computeAdvisoryLockId,
  initializeMigrationDataSource,
  releaseAdvisoryLock,
  resolveDeferredMigrationIds,
};
