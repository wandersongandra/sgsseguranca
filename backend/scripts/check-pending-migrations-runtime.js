require('reflect-metadata');
const path = require('path');
const dotenv = require('dotenv');
const { DataSource } = require('typeorm');
const {
  resolveDatabaseConfig,
  resolveSslConfig,
} = require('./database-runtime.config');
const { readMigrationManifest } = require('./migration-manifest');
const {
  ensureMigrationsTable,
  filterPendingMigrations,
  loadExecutedMigrationRows,
  readCompatibilityManifest,
} = require('./migration-history-compatibility');
const {
  assertScriptEnvironment,
} = require('./assert-environment-contract.cjs');

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const distRoot = path.resolve(__dirname, '../dist');
const migrationsDir = path.join(distRoot, 'infra', 'database', 'migrations');

function buildDataSource() {
  const databaseConfig = resolveDatabaseConfig();
  const ssl = resolveSslConfig();

  return new DataSource({
    type: 'postgres',
    url: databaseConfig.url,
    host: databaseConfig.host,
    port: databaseConfig.port,
    username: databaseConfig.username,
    password: databaseConfig.password,
    database: databaseConfig.database,
    ssl,
    synchronize: false,
    entities: [
      path.join(distRoot, '!(database|seed|queue|worker)', '**', '*.entity.js'),
    ],
    migrations: [path.join(migrationsDir, '*.js')],
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
    const manifest = readMigrationManifest();
    const executedRows = await loadExecutedMigrationRows(dataSource);
    const executedNames = new Set(
      executedRows.map((row) => String(row.name || '').trim()).filter(Boolean),
    );
    const pending = filterPendingMigrations(
      dataSource.migrations,
      executedNames,
    );
    const sourceNames = new Set(
      manifest.entries.map((migration) => migration.name),
    );
    const legacyNames = new Set(
      Object.keys(readCompatibilityManifest().aliases),
    );
    const executedNotInSource = executedRows
      .map((migration) => String(migration.name || '').trim())
      .filter(
        (name) =>
          name.length > 0 && !sourceNames.has(name) && !legacyNames.has(name),
      );

    console.log(
      JSON.stringify(
        {
          manifestIssueCount: manifest.issues.length,
          manifestIssues: manifest.issues,
          pendingCount: pending.length,
          pending: pending.map((migration) => migration.name),
          executedNotInSourceCount: executedNotInSource.length,
          executedNotInSource,
        },
        null,
        2,
      ),
    );

    if (
      manifest.issues.length > 0 ||
      pending.length > 0 ||
      executedNotInSource.length > 0
    ) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      '[MIGRATIONS:PENDING] Failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

main();
