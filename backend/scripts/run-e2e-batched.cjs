const { readdirSync } = require('node:fs');
const { join, relative, sep } = require('node:path');
const { spawnSync } = require('node:child_process');

const CONFIG = './test/jest-e2e.config.ts';
const TEST_ROOTS = ['test/critical', 'test/aprs'];
const ROOT_TESTS = [
  'test/idor-security.e2e-spec.ts',
  'test/multi-tenancy.e2e-spec.ts',
];
const BATCH_SIZE = 1;
const forwardedArgs = process.argv.slice(2);

function collectE2eFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return collectE2eFiles(path);
    return entry.name.endsWith('.e2e-spec.ts') ? [path] : [];
  });
}

function isExplicitFileRun(args) {
  return args.some(
    (arg) =>
      !arg.startsWith('-') &&
      (arg.endsWith('.e2e-spec.ts') || arg.includes('/') || arg.includes('\\')),
  );
}

function runJest(files) {
  const jestArgs = [
    ...process.execArgv,
    'scripts/run-jest.cjs',
    '--config',
    CONFIG,
    '--runInBand',
    ...forwardedArgs,
    ...files,
  ];
  const result = spawnSync(process.execPath, jestArgs, { stdio: 'inherit' });
  return result.status ?? 1;
}

const files = isExplicitFileRun(forwardedArgs)
  ? []
  : [...TEST_ROOTS.flatMap(collectE2eFiles), ...ROOT_TESTS].sort((a, b) =>
      a.localeCompare(b),
    );

if (files.length === 0) {
  process.exit(runJest([]));
}

for (let index = 0; index < files.length; index += BATCH_SIZE) {
  const batch = files
    .slice(index, index + BATCH_SIZE)
    .map((file) => relative('.', file).split(sep).join('/'));
  console.log(
    `\n[E2E] lote ${Math.floor(index / BATCH_SIZE) + 1}: ${batch.join(', ')}`,
  );
  const status = runJest(batch);
  if (status !== 0) process.exit(status);
}
