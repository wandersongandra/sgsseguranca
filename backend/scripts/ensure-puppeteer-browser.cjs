const { existsSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const cacheDir = process.env.PUPPETEER_CACHE_DIR || join(__dirname, '..', '.cache', 'puppeteer');
const env = { ...process.env, PUPPETEER_CACHE_DIR: cacheDir };

delete env.PUPPETEER_SKIP_DOWNLOAD;
delete env.PUPPETEER_EXECUTABLE_PATH;

async function main() {
  let executablePath = null;

  try {
    const puppeteer = require('puppeteer');
    // No Puppeteer 25, executablePath() passou a ser assíncrono.
    executablePath = await puppeteer.executablePath();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[puppeteer] não foi possível resolver o browser antes do ensure: ${reason}`);
  }

  if (executablePath && existsSync(executablePath)) {
    console.log(`[puppeteer] browser já disponível em ${executablePath}`);
    process.exit(0);
  }

  console.log(`[puppeteer] instalando browser em cache local: ${cacheDir}`);

  // Layout do pacote mudou no Puppeteer 25 (ESM-only, sem a pasta lib/cjs).
  const cliPath = require.resolve('puppeteer/lib/puppeteer/node/cli.js');
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
}

main();
