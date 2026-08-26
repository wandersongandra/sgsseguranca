require('reflect-metadata');
const path = require('path');
const { DataSource } = require('typeorm');
const {
  resolveDatabaseConfig,
  resolveSslConfig,
} = require('./database-runtime.config');
const {
  ensureMigrationsTable,
  filterPendingMigrations,
  loadExecutedMigrationRows,
} = require('./migration-history-compatibility');
const {
  assertScriptEnvironment,
} = require('./assert-environment-contract.cjs');

function buildDataSource() {
  const databaseConfig = resolveDatabaseConfig();
  const distEntitiesGlob = path.resolve(
    __dirname,
    '..',
    'dist',
    '**',
    '*.entity.js',
  );
  const distMigrationsGlob = path.resolve(
    __dirname,
    '..',
    'dist',
    'infra',
    'database',
    'migrations',
    '*.js',
  );

  return new DataSource({
    type: 'postgres',
    url: databaseConfig.url,
    host: databaseConfig.host,
    port: databaseConfig.port,
    username: databaseConfig.username,
    password: databaseConfig.password,
    database: databaseConfig.database,
    ssl: resolveSslConfig(),
    synchronize: false,
    entities: [distEntitiesGlob],
    migrations: [distMigrationsGlob],
  });
}

async function main() {
  assertScriptEnvironment({
    component: 'migration',
    validateFeatureIntegrations: false,
  });
  const dataSource = buildDataSource();

  try {
    await dataSource.initialize();
    await ensureMigrationsTable(dataSource);
    const executedRows = await loadExecutedMigrationRows(dataSource);
    const executedNames = new Set(
      executedRows.map((row) => String(row.name || '')).filter(Boolean),
    );
    const pendingMigrations = filterPendingMigrations(
      dataSource.migrations,
      executedNames,
    );
    const hasPending = pendingMigrations.length > 0;

    if (hasPending) {
      console.error('[MIGRATIONS] Pending migrations detected.');
      for (const migration of pendingMigrations) {
        console.error(`[MIGRATIONS] Pending: ${migration.name}`);
      }
      process.exit(1);
    }

    console.log('[MIGRATIONS] No pending migrations.');
  } catch (error) {
    console.error(
      '[MIGRATIONS] Failed to verify pending migrations:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

main();
