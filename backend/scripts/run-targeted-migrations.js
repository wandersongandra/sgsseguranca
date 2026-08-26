require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { DataSource } = require('typeorm');
const {
  resolveDatabaseConfig,
  resolveSslConfig,
} = require('./database-runtime.config');
const { assertMigrationManifest } = require('./migration-manifest');
const {
  compareMigrations,
  getLegacyNamesForCanonicalName,
  isMigrationEffectivelyExecuted,
} = require('./migration-history-compatibility');
const {
  assertScriptEnvironment,
} = require('./assert-environment-contract.cjs');

function parseCliArgs(argv) {
  const options = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const arg = token.slice(2);
    if (!arg) continue;
    const equalIndex = arg.indexOf('=');
    if (equalIndex === -1) {
      options[arg] = true;
      continue;
    }
    options[arg.slice(0, equalIndex)] = arg.slice(equalIndex + 1);
  }
  return options;
}

function buildDataSource(migrations) {
  const databaseConfig = resolveDatabaseConfig();
  const ssl = resolveSslConfig();

  if (databaseConfig.url) {
    return new DataSource({
      type: 'postgres',
      url: databaseConfig.url,
      ssl,
      synchronize: false,
      entities: ['dist/!(database|seed|queue|worker)/**/*.entity.js'],
      migrations,
    });
  }

  return new DataSource({
    type: 'postgres',
    host: databaseConfig.host,
    port: databaseConfig.port,
    username: databaseConfig.username,
    password: databaseConfig.password,
    database: databaseConfig.database,
    ssl,
    synchronize: false,
    entities: ['dist/!(database|seed|queue|worker)/**/*.entity.js'],
    migrations,
  });
}

function resolveTargetedMigrations(tokens) {
  assertMigrationManifest();

  const distDir = path.resolve(
    __dirname,
    '..',
    'dist',
    'infra',
    'database',
    'migrations',
  );
  if (!fs.existsSync(distDir)) {
    throw new Error(
      'Diretório dist/infra/database/migrations não encontrado. Execute npm run build antes.',
    );
  }

  const files = fs
    .readdirSync(distDir)
    .filter((file) => file.endsWith('.js'))
    .sort();

  const normalizedTokens = tokens.map((token) => token.trim()).filter(Boolean);

  if (!normalizedTokens.length) {
    throw new Error(
      'Informe ao menos um filtro em --include=token1,token2 para selecionar migrações.',
    );
  }

  const selected = files.filter((file) => {
    const metadata = resolveMigrationMetadata(path.join(distDir, file));
    return normalizedTokens.some(
      (token) =>
        file.includes(token) ||
        metadata.name.includes(token) ||
        getLegacyNamesForCanonicalName(metadata.name).some((legacyName) =>
          legacyName.includes(token),
        ),
    );
  });

  if (!selected.length) {
    throw new Error(
      `Nenhuma migração encontrada para os filtros: ${normalizedTokens.join(', ')}`,
    );
  }

  return selected
    .map((file) => {
      const safeFile = path.basename(file);
      if (safeFile !== file) {
        throw new Error(`Nome de migração inválido: ${file}`);
      }
      return `${distDir}${path.sep}${safeFile}`;
    })
    .sort((left, right) =>
      compareMigrations(
        resolveMigrationMetadata(left),
        resolveMigrationMetadata(right),
      ),
    );
}

function loadMigrationClass(filePath) {
  const loaded = require(filePath);
  const migrationClass = Object.values(loaded).find(
    (value) => typeof value === 'function',
  );

  if (!migrationClass) {
    throw new Error(
      `Não foi possível localizar a classe de migração em ${path.basename(filePath)}`,
    );
  }

  return migrationClass;
}

function resolveMigrationMetadata(filePath) {
  const migrationClass = loadMigrationClass(filePath);
  const instance = new migrationClass();
  const fileName = path.basename(filePath);
  const timestamp = fileName.slice(0, 13);
  const name = instance.name || migrationClass.name;

  if (!/^\d{13}$/.test(timestamp)) {
    throw new Error(`Timestamp inválido no arquivo ${fileName}`);
  }

  if (!name) {
    throw new Error(`Nome de migração inválido em ${fileName}`);
  }

  return {
    filePath,
    fileName,
    timestamp,
    name,
    instance,
  };
}

async function runTargetedMigrations(dataSource, migrationFiles) {
  const existingRows = await dataSource.query(
    'SELECT "timestamp", "name" FROM "migrations"',
  );
  const executedByName = new Set(existingRows.map((row) => row.name));
  const migrations = migrationFiles.map(resolveMigrationMetadata);

  let appliedCount = 0;

  for (const migration of migrations) {
    if (isMigrationEffectivelyExecuted(migration.name, executedByName)) {
      console.log(
        `[MIGRATIONS:TARGETED] Skipping already applied migration ${migration.name}.`,
      );
      continue;
    }

    console.log(
      `[MIGRATIONS:TARGETED] Applying ${migration.fileName} (${migration.name})...`,
    );

    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    const useTransaction = migration.instance.transaction !== false;

    try {
      if (useTransaction) {
        await queryRunner.startTransaction();
      }

      await migration.instance.up(queryRunner);
      await queryRunner.query(
        'INSERT INTO "migrations"("timestamp", "name") VALUES ($1, $2)',
        [migration.timestamp, migration.name],
      );
      if (useTransaction) {
        await queryRunner.commitTransaction();
      }
      appliedCount += 1;
      console.log(
        `[MIGRATIONS:TARGETED] Applied ${migration.name} successfully.`,
      );
    } catch (error) {
      if (useTransaction && queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  return appliedCount;
}

async function main() {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  assertScriptEnvironment({
    component: 'migration',
    validateFeatureIntegrations: false,
  });

  const args = parseCliArgs(process.argv.slice(2));
  const includeRaw = typeof args.include === 'string' ? args.include : '';
  const migrations = resolveTargetedMigrations(includeRaw.split(','));

  console.log('[MIGRATIONS:TARGETED] Selected migrations:');
  for (const migration of migrations) {
    console.log(` - ${path.basename(migration)}`);
  }

  const dataSource = buildDataSource(migrations);

  try {
    await dataSource.initialize();
    const appliedCount = await runTargetedMigrations(dataSource, migrations);
    console.log(`[MIGRATIONS:TARGETED] Applied ${appliedCount} migration(s).`);
  } catch (error) {
    console.error(
      '[MIGRATIONS:TARGETED] Failed:',
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
