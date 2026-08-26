const { readMigrationManifest } = require('./migration-manifest');

const manifest = readMigrationManifest();

if (manifest.issues.length > 0) {
  console.error('[CI] Migration manifest check failed:');
  for (const issue of manifest.issues) {
    console.error(` - ${issue}`);
  }
  process.exit(1);
}

const implicitNames = manifest.entries
  .filter((entry) => !entry.hasExplicitName)
  .map((entry) => `${entry.fileName} -> ${entry.name}`);

console.log(
  `[CI] Migration manifest passed (${manifest.files.length} files; ` +
    `${implicitNames.length} names derived from class).`,
);
