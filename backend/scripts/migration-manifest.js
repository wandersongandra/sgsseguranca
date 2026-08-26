const fs = require('fs');
const path = require('path');

const DEFAULT_MIGRATIONS_DIR = path.resolve(
  __dirname,
  '..',
  'src',
  'infra',
  'database',
  'migrations',
);
const DEFAULT_DIST_MIGRATIONS_DIR = path.resolve(
  __dirname,
  '..',
  'dist',
  'infra',
  'database',
  'migrations',
);
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

function getMigrationOrderKey(entry) {
  const compatibility = readCompatibilityManifest();
  const override = compatibility.order[entry.name];
  const timestamp = override?.legacyTimestamp || entry.timestamp;
  const ordinal = Number.isInteger(override?.ordinal) ? override.ordinal : 0;

  return {
    timestamp,
    ordinal,
  };
}

function compareMigrationEntries(left, right) {
  const leftKey = getMigrationOrderKey(left);
  const rightKey = getMigrationOrderKey(right);
  const timestampComparison = String(leftKey.timestamp).localeCompare(
    String(rightKey.timestamp),
  );
  if (timestampComparison !== 0) return timestampComparison;
  if (leftKey.ordinal !== rightKey.ordinal) {
    return leftKey.ordinal - rightKey.ordinal;
  }
  return left.name.localeCompare(right.name);
}

function validateCompatibilityManifest(entries) {
  const compatibility = readCompatibilityManifest();
  const issues = [];
  const activeNames = new Set(
    entries.map((entry) => entry.name).filter(Boolean),
  );
  const aliases = Object.entries(compatibility.aliases);

  for (const [legacyName, canonicalName] of aliases) {
    if (!legacyName || !canonicalName) {
      issues.push('Migration compatibility alias contains an empty name.');
      continue;
    }
    if (!activeNames.has(canonicalName)) {
      issues.push(
        `Migration compatibility alias target is absent: ${legacyName} -> ${canonicalName}`,
      );
    }
    if (activeNames.has(legacyName)) {
      issues.push(
        `Migration compatibility alias is still active and must be removed from source: ${legacyName}`,
      );
    }
  }

  const orderKeys = new Map();
  for (const [name, override] of Object.entries(compatibility.order)) {
    if (!activeNames.has(name)) {
      issues.push(
        `Migration order override targets an absent migration: ${name}`,
      );
      continue;
    }
    if (!/^\d{13}$/.test(String(override.legacyTimestamp || ''))) {
      issues.push(
        `Invalid legacy timestamp in migration order override: ${name}`,
      );
    }
    if (!Number.isInteger(override.ordinal) || override.ordinal < 1) {
      issues.push(`Invalid migration order ordinal: ${name}`);
    }
    const key = `${override.legacyTimestamp}:${override.ordinal}`;
    const previous = orderKeys.get(key);
    if (previous) {
      issues.push(
        `Duplicate migration order override ${key}: ${previous}, ${name}`,
      );
    } else {
      orderKeys.set(key, name);
    }
  }

  return issues;
}

function validateDeferredMigrationIds(entries, deferredIds = []) {
  const issues = [];
  const values = deferredIds
    .map((value) => String(value).trim())
    .filter(Boolean);
  const duplicateIds = values.filter(
    (value, index) => values.indexOf(value) !== index,
  );
  for (const id of [...new Set(duplicateIds)]) {
    issues.push(`Duplicate deferred migration ID: ${id}`);
  }

  for (const id of values) {
    if (!/^\d{13}$/.test(id)) {
      issues.push(`Invalid deferred migration ID: ${id}`);
      continue;
    }
    const matches = entries.filter((entry) => entry.timestamp === id);
    if (matches.length === 0) {
      issues.push(
        `Deferred migration ID is absent from the active manifest: ${id}`,
      );
    } else if (matches.length > 1) {
      issues.push(
        `Deferred migration ID is ambiguous: ${id} -> ${matches
          .map((entry) => entry.fileName)
          .join(', ')}`,
      );
    }
  }

  return issues;
}

function resolveDefaultMigrationsDir() {
  return fs.existsSync(DEFAULT_MIGRATIONS_DIR)
    ? DEFAULT_MIGRATIONS_DIR
    : DEFAULT_DIST_MIGRATIONS_DIR;
}

function readMigrationManifest(migrationsDir = resolveDefaultMigrationsDir()) {
  if (!fs.existsSync(migrationsDir)) {
    return {
      directory: migrationsDir,
      files: [],
      entries: [],
      issues: [`Migration directory not found: ${migrationsDir}`],
    };
  }

  const files = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        ((entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) ||
          entry.name.endsWith('.js')),
    )
    .map((entry) => entry.name)
    .sort();

  const issues = [];
  const entries = files.map((fileName) => {
    const filePath = path.join(migrationsDir, fileName);
    const source = fs.readFileSync(filePath, 'utf8');
    const timestampMatch = fileName.match(/^(\d{13})-/);
    const classes = [
      ...source.matchAll(
        /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
      ),
    ];
    const explicitName = source.match(
      /^\s*(?:(?:(?:public|private|protected)\s+)?(?:readonly\s+)?name|this\.name)\s*=\s*(['"])([^'"]+)\1/m,
    );
    const className = classes.length === 1 ? classes[0][1] : undefined;
    const migrationName = explicitName?.[2] || className;

    if (!timestampMatch) {
      issues.push(`Invalid or missing 13-digit timestamp: ${fileName}`);
    }
    if (classes.length === 0) {
      issues.push(`Migration class not found: ${fileName}`);
    } else if (classes.length > 1) {
      issues.push(
        `Multiple exported migration classes in ${fileName}: ${classes
          .map((match) => match[1])
          .join(', ')}`,
      );
    }
    if (!migrationName) {
      issues.push(`Migration name not found: ${fileName}`);
    }
    if (
      timestampMatch &&
      migrationName &&
      !new RegExp(`${timestampMatch[1]}$`).test(migrationName)
    ) {
      issues.push(
        `Migration filename/name timestamp mismatch: ${fileName} -> ${migrationName}`,
      );
    }

    return {
      fileName,
      timestamp: timestampMatch?.[1],
      className,
      name: migrationName,
      hasExplicitName: Boolean(explicitName),
    };
  });

  const duplicateGroups = (key) =>
    [
      ...entries.reduce((groups, entry) => {
        const value = entry[key];
        if (!value) return groups;
        const group = groups.get(value) || [];
        group.push(entry.fileName);
        groups.set(value, group);
        return groups;
      }, new Map()),
    ].filter(([, group]) => group.length > 1);

  for (const [timestamp, group] of duplicateGroups('timestamp')) {
    issues.push(
      `Duplicate migration timestamp ${timestamp}; execution order is ambiguous: ${group.join(', ')}`,
    );
  }
  for (const [className, group] of duplicateGroups('className')) {
    issues.push(`Duplicate migration class ${className}: ${group.join(', ')}`);
  }
  for (const [name, group] of duplicateGroups('name')) {
    issues.push(`Duplicate migration name ${name}: ${group.join(', ')}`);
  }

  issues.push(...validateCompatibilityManifest(entries));

  const orderGroups = new Map();
  for (const entry of entries) {
    const key = getMigrationOrderKey(entry);
    const serialized = `${key.timestamp}:${key.ordinal}`;
    const group = orderGroups.get(serialized) || [];
    group.push(entry.fileName);
    orderGroups.set(serialized, group);
  }
  for (const [key, group] of orderGroups) {
    if (group.length > 1) {
      issues.push(
        `Ambiguous migration execution order ${key}: ${group.join(', ')}`,
      );
    }
  }

  return { directory: migrationsDir, files, entries, issues };
}

function assertMigrationManifest(migrationsDir, options = {}) {
  const manifest = readMigrationManifest(migrationsDir);
  manifest.issues.push(
    ...validateDeferredMigrationIds(manifest.entries, options.deferredIds),
  );
  if (manifest.files.length === 0 && manifest.issues.length === 0) {
    manifest.issues.push('No TypeORM migration files were found.');
  }
  if (manifest.issues.length > 0) {
    throw new Error(
      `Migration manifest invalid:\n${manifest.issues
        .map((issue) => `- ${issue}`)
        .join('\n')}`,
    );
  }
  return manifest;
}

module.exports = {
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_DIST_MIGRATIONS_DIR,
  compareMigrationEntries,
  getMigrationOrderKey,
  readCompatibilityManifest,
  assertMigrationManifest,
  readMigrationManifest,
  validateDeferredMigrationIds,
};
