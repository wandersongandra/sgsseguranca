const { existsSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const cacheDir =
  process.env.PUPPETEER_CACHE_DIR ||
  join(__dirname, '..', '.cache', 'puppeteer');
const env = { ...process.env, PUPPETEER_CACHE_DIR: cacheDir };

delete env.PUPPETEER_SKIP_DOWNLOAD;
delete env.PUPPETEER_EXECUTABLE_PATH;

let executablePath = null;

try {
  const puppeteer = require('puppeteer');
  executablePath = puppeteer.executablePath();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `[puppeteer] não foi possível resolver o browser antes do ensure: ${reason}`,
  );
}

if (executablePath && existsSync(executablePath)) {
  console.log(`[puppeteer] browser já disponível em ${executablePath}`);
  process.exit(0);
}

console.log(`[puppeteer] instalando browser em cache local: ${cacheDir}`);

const cliCandidates = [
  'puppeteer/lib/puppeteer/node/cli.js',
  'puppeteer/lib/cjs/puppeteer/node/cli.js',
  'puppeteer/lib/esm/puppeteer/node/cli.js',
];
let cliPath = null;
for (const candidate of cliCandidates) {
  try {
    cliPath = require.resolve(candidate);
    break;
  } catch {
    // Layout varies between Puppeteer major versions.
  }
}

if (!cliPath) {
  console.error(
    `[puppeteer] CLI de instalação não encontrado. Tentativas: ${cliCandidates.join(', ')}`,
  );
  process.exit(1);
}

const install = spawnSync(
  process.execPath,
  [cliPath, 'browsers', 'install', 'chrome'],
  {
    cwd: join(__dirname, '..'),
    env,
    stdio: 'inherit',
  },
);

if (install.status !== 0) {
  process.exit(install.status ?? 1);
}
