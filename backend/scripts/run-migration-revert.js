require('reflect-metadata');
const path = require('path');
const dotenv = require('dotenv');
const {
  acquireAdvisoryLock,
  clampPositiveInt,
  computeAdvisoryLockId,
  initializeMigrationDataSource,
  releaseAdvisoryLock,
  resolveDeferredMigrationIds,
} = require('./run-migrations');
const { assertMigrationManifest } = require('./migration-manifest');
const {
  ensureMigrationsTable,
  getCanonicalNameForLegacyName,
  getMigrationName,
  loadExecutedMigrationRows,
} = require('./migration-history-compatibility');
const {
  assertScriptEnvironment,
} = require('./assert-environment-contract.cjs');

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function revertLastMigration(dataSource) {
  await ensureMigrationsTable(dataSource);
  const rows = await loadExecutedMigrationRows(dataSource);
  const lastRow = rows[rows.length - 1];

  if (!lastRow) {
    console.log('[MIGRATIONS:REVERT] No migrations found.');
    return false;
  }

  const canonicalName =
    getCanonicalNameForLegacyName(lastRow.name) || String(lastRow.name);
  const candidates = dataSource.migrations.filter(
    (migration) => getMigrationName(migration) === canonicalName,
  );

  if (candidates.length !== 1) {
    throw new Error(
      `Cannot resolve the last migration safely: ${lastRow.name} -> ${canonicalName}.`,
    );
  }

  const migration = candidates[0];
  if (typeof migration.down !== 'function') {
    throw new Error(
      `Migration has no down() implementation: ${canonicalName}.`,
    );
  }

  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  const useTransaction = migration.transaction !== false;

  try {
    if (useTransaction) {
      await queryRunner.startTransaction();
    }
    await queryRunner.beforeMigration();
    await migration.down(queryRunner);
    await queryRunner.afterMigration();
    await queryRunner.query('DELETE FROM "migrations" WHERE "id" = $1', [
      lastRow.id,
    ]);
    if (useTransaction) {
      await queryRunner.commitTransaction();
    }
    console.log(
      `[MIGRATIONS:REVERT] Reverted ${lastRow.name} using ${canonicalName}.`,
    );
    return true;
  } catch (error) {
    if (useTransaction && queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function main() {
  assertScriptEnvironment({
    component: 'migration',
    validateFeatureIntegrations: false,
  });
  assertMigrationManifest(undefined, {
    deferredIds: resolveDeferredMigrationIds(),
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
    await revertLastMigration(dataSource);
  } finally {
    if (lockRunner) {
      await releaseAdvisoryLock(lockRunner, lockId);
      await lockRunner.release().catch(() => undefined);
    }
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      '[MIGRATIONS:REVERT] Failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}

module.exports = { revertLastMigration };
