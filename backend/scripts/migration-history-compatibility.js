const fs = require('fs');
const path = require('path');
const { MigrationExecutor } = require('typeorm/migration/MigrationExecutor');

const COMPATIBILITY_MANIFEST_PATH = path.resolve(
  __dirname,
  '..',
  'migration-history-compatibility.json',
);

function readCompatibilityManifest() {
  if (!fs.existsSync(COMPATIBILITY_MANIFEST_PATH)) {
    return { aliases: {}, order: {} };
  }

  const parsed = JSON.parse(
    fs.readFileSync(COMPATIBILITY_MANIFEST_PATH, 'utf8'),
  );
  return {
    aliases: parsed.aliases || {},
    order: parsed.order || {},
  };
}

function getMigrationName(migration) {
  return String(migration?.name || migration?.constructor?.name || '');
}

function getMigrationTimestamp(migration) {
  const matched = getMigrationName(migration).match(/(\d{13})$/);
  return matched?.[1] || '';
}

function getMigrationOrderKey(migration) {
  const name = getMigrationName(migration);
  const compatibility = readCompatibilityManifest();
  const override = compatibility.order[name];
  return {
    timestamp: override?.legacyTimestamp || getMigrationTimestamp(migration),
    ordinal: Number.isInteger(override?.ordinal) ? override.ordinal : 0,
  };
}

function compareMigrations(left, right) {
  const leftKey = getMigrationOrderKey(left);
  const rightKey = getMigrationOrderKey(right);
  const timestampComparison = String(leftKey.timestamp).localeCompare(
    String(rightKey.timestamp),
  );
  if (timestampComparison !== 0) return timestampComparison;
  if (leftKey.ordinal !== rightKey.ordinal) {
    return leftKey.ordinal - rightKey.ordinal;
  }
  return getMigrationName(left).localeCompare(getMigrationName(right));
}

function getCanonicalNameForLegacyName(legacyName) {
  return readCompatibilityManifest().aliases[String(legacyName)] || '';
}

function getLegacyNamesForCanonicalName(canonicalName) {
  return Object.entries(readCompatibilityManifest().aliases)
    .filter(([, target]) => target === canonicalName)
    .map(([legacyName]) => legacyName);
}

function isMigrationEffectivelyExecuted(migrationOrName, executedNames) {
  const canonicalName =
    typeof migrationOrName === 'string'
      ? migrationOrName
      : getMigrationName(migrationOrName);
  if (executedNames.has(canonicalName)) return true;
  return getLegacyNamesForCanonicalName(canonicalName).some((legacyName) =>
    executedNames.has(legacyName),
  );
}

function filterPendingMigrations(migrations, executedNames) {
  return migrations
    .filter(
      (migration) =>
        getMigrationName(migration).length > 0 &&
        !isMigrationEffectivelyExecuted(migration, executedNames),
    )
    .sort(compareMigrations);
}

async function ensureMigrationsTable(dataSource) {
  const executor = new MigrationExecutor(dataSource);
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    // TypeORM exposes this as protected in TypeScript, but the official
    // executor uses the same method internally. Keeping table creation here
    // avoids a second schema definition in the custom ordered runner.
    await executor.createMigrationsTableIfNotExist(queryRunner);
  } finally {
    await queryRunner.release();
  }
}

async function loadExecutedMigrationRows(dataSource) {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    if (!(await queryRunner.hasTable('migrations'))) return [];
    return await queryRunner.query(
      'SELECT "id", "timestamp", "name" FROM "migrations" ORDER BY "id" ASC',
    );
  } finally {
    await queryRunner.release();
  }
}

module.exports = {
  compareMigrations,
  ensureMigrationsTable,
  filterPendingMigrations,
  getCanonicalNameForLegacyName,
  getLegacyNamesForCanonicalName,
  getMigrationName,
  getMigrationOrderKey,
  getMigrationTimestamp,
  isMigrationEffectivelyExecuted,
  loadExecutedMigrationRows,
  readCompatibilityManifest,
};
