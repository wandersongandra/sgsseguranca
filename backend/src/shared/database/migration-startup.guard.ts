import appDataSource from '../../data-source';
import { DataSource } from 'typeorm';
import migrationCompatibility from '../../../migration-history-compatibility.json';

const LEGACY_MIGRATION_ALIASES: Record<string, string> =
  migrationCompatibility.aliases;

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

type MigrationMetadata = {
  name?: string;
  timestamp?: number | string;
  constructor?: {
    name?: string;
  };
};

function isNamedMigrationRow(value: unknown): value is { name?: string } {
  return typeof value === 'object' && value !== null;
}

function hasDatabaseConfig(): boolean {
  return Boolean(
    process.env.DATABASE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.URL_DO_BANCO_DE_DADOS ||
    process.env.DATABASE_HOST ||
    process.env.PGHOST,
  );
}

export function shouldRequireNoPendingMigrations(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const isProd = env.NODE_ENV === 'production';
  const pendingMigrationPolicy = (env.REQUIRE_NO_PENDING_MIGRATIONS || '')
    .trim()
    .toLowerCase();

  return isProd && pendingMigrationPolicy !== 'false';
}

function resolveDeferredMigrationIds(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const rawValue = (env.MIGRATION_DEFERRED_IDS || '').trim();
  if (rawValue.length > 0) {
    return new Set(
      rawValue
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  if (env.NODE_ENV === 'production') {
    return new Set(DEFERRED_PRODUCTION_MIGRATION_IDS);
  }

  return new Set();
}

function isDeferredMigration(
  migration: MigrationMetadata,
  deferredMigrationIds: Set<string>,
): boolean {
  if (deferredMigrationIds.size === 0) {
    return false;
  }

  const name = getMigrationName(migration);
  const timestamp = getMigrationTimestamp(migration);

  if (timestamp && deferredMigrationIds.has(timestamp)) {
    return true;
  }

  for (const deferredId of deferredMigrationIds) {
    if (name.includes(deferredId)) {
      return true;
    }
  }

  return false;
}

function getMigrationName(migration: MigrationMetadata): string {
  return String(migration.name || migration.constructor?.name || '');
}

function getMigrationTimestamp(migration: MigrationMetadata): string {
  if (migration.timestamp !== undefined && migration.timestamp !== null) {
    return String(migration.timestamp);
  }

  const migrationName = getMigrationName(migration);
  const matchedTimestamp = migrationName.match(/(\d{13})$/);
  return matchedTimestamp?.[1] || '';
}

function isEffectivelyExecuted(
  migrationName: string,
  executedMigrationNames: Set<string>,
): boolean {
  if (executedMigrationNames.has(migrationName)) {
    return true;
  }

  return Object.entries(LEGACY_MIGRATION_ALIASES).some(
    ([legacyName, canonicalName]) =>
      canonicalName === migrationName && executedMigrationNames.has(legacyName),
  );
}

export async function assertNoPendingMigrationsInProd(): Promise<void> {
  const requireNoPendingMigrations = shouldRequireNoPendingMigrations(
    process.env,
  );

  if (!requireNoPendingMigrations) {
    return;
  }

  if (!hasDatabaseConfig()) {
    throw new Error(
      'REQUIRE_NO_PENDING_MIGRATIONS=true but database configuration is missing.',
    );
  }

  const deferredMigrationIds = resolveDeferredMigrationIds(process.env);
  let initializedHere = false;
  const dataSource: DataSource = appDataSource;

  try {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
      initializedHere = true;
    }

    const executedRowsResult: unknown = await dataSource.query(
      'SELECT name FROM "migrations"',
    );
    const executedRows = Array.isArray(executedRowsResult)
      ? executedRowsResult.filter(isNamedMigrationRow)
      : [];
    const executedMigrationNames = new Set(
      executedRows.map((row) => String(row?.name || '')).filter(Boolean),
    );

    const pendingMigrations = dataSource.migrations.filter(
      (migration) =>
        !isEffectivelyExecuted(
          getMigrationName(migration),
          executedMigrationNames,
        ) &&
        getMigrationName(migration).length > 0 &&
        !isDeferredMigration(migration, deferredMigrationIds),
    );

    if (pendingMigrations.length > 0) {
      throw new Error(
        'Pending database migrations detected. Run migrations before starting the application in production.',
      );
    }
  } finally {
    if (initializedHere && dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}
