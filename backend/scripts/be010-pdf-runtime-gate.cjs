#!/usr/bin/env node
'use strict';

const { assertLoadtestEnvironment: assertTargetEnvironment } = require('../../infra/load-test/scripts/loadtest-target-guard.cjs');
assertTargetEnvironment();

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');

const assertMode = process.argv.includes('--assert');
const disableJavaScript = process.argv.includes('--disable-javascript');

const launchArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--disable-extensions',
  '--mute-audio',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--disable-features=Crashpad,TranslateUI,BlinkGenPropertyTrees',
];

function chromiumProcessCount() {
  try {
    return Number(
      execFileSync('sh', ['-lc', 'ps -C chromium --no-headers | wc -l'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    return -1;
  }
}

function shortHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function fail(message) {
  console.error(`[BE010-FAIL] ${message}`);
  process.exitCode = 1;
}

function report(name, value) {
  console.log(`[BE010] ${name}=${value}`);
}

function assertLoadtestEnvironment() {
  if (
    process.env.APP_ENV !== 'loadtest' ||
    process.env.APP_LOADTEST_MARKER !== 'sgs-loadtest' ||
    process.env.NODE_ENV === 'production'
  ) {
    throw new Error(
      'BE010 guard: probe requires APP_ENV=loadtest and APP_LOADTEST_MARKER=sgs-loadtest',
    );
  }
}

function summarizeRequest(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname || '(inline)'}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return url.split(':', 1)[0] || 'unknown';
  }
}

function buildHtml(port) {
  const onePixel =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/Sc8X6QAAAABJRU5ErkJggg==';
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><style>
body { font-family: Arial, sans-serif; } .marker { color: #153a5b; }
</style></head><body>
<h1 class="marker">BE-010 PDF REAL — Segurança do Trabalho</h1>
<p>Caracteres: ã ç é ô ° NR-10 EPI</p>
<p id="js-result">JavaScript controlado</p>
<script>document.body.dataset.be010Js = 'executed'; document.getElementById('js-result').textContent = 'JavaScript executado';</script>
<img alt="inline" src="${onePixel}">
<img alt="loopback" src="http://127.0.0.1:${port}/loopback.png">
<img alt="localhost" src="http://localhost:${port}/localhost.png">
<img alt="metadata" src="http://169.254.169.254/latest/meta-data/">
<img alt="private" src="http://192.168.0.1/private.png">
<img alt="external" src="https://example.invalid/external.png">
<img alt="file" src="file:///etc/passwd">
<img alt="ftp" src="ftp://127.0.0.1/private.png">
<iframe src="data:text/html,<script>document.body.dataset.iframe = 'executed'</script>"></iframe>
<object data="file:///etc/passwd"></object>
</body></html>`;
}

async function parsePdf(pdf) {
  if (!Buffer.isBuffer(pdf) || pdf.length === 0) {
    throw new Error('PDF vazio');
  }
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('PDF sem header %PDF-');
  }
  if (
    !pdf
      .subarray(Math.max(0, pdf.length - 2048))
      .toString('latin1')
      .includes('%%EOF')
  ) {
    throw new Error('PDF sem marcador %%EOF');
  }
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: pdf });
  const parsed = await parser.getText();
  await parser.destroy();
  return parsed;
}

async function main() {
  let server;
  let browser;
  let page;
  let pool;

  try {
    assertLoadtestEnvironment();
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!executablePath || !fs.existsSync(executablePath)) {
      throw new Error('PUPPETEER_EXECUTABLE_PATH inválido ou ausente');
    }
    const puppeteerModule = await import('puppeteer');
    const puppeteer = puppeteerModule.default ?? puppeteerModule;
    const packageJson = JSON.parse(
      fs.readFileSync(require.resolve('puppeteer/package.json'), 'utf8'),
    );
    report('node', process.version);
    report('puppeteer', packageJson.version);
    report(
      'chromium',
      require('node:child_process')
        .execFileSync(executablePath, ['--version'], { encoding: 'utf8' })
        .trim(),
    );
    report('uid', process.getuid?.() ?? 'unknown');
    report('processes.before', chromiumProcessCount());

    let serverHits = 0;
    server = http.createServer((_request, response) => {
      serverHits += 1;
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from('not-an-image'));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('porta de teste indisponível');

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: launchArgs,
    });
    report('browser.started', true);
    page = await browser.newPage();
    report('page.created', true);
    const requests = [];
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      requests.push({ url, resourceType: request.resourceType() });
      if (
        /^data:image\/(?:png|jpe?g|webp);base64,/i.test(url) ||
        url === 'about:blank'
      ) {
        void request.continue();
      } else {
        void request.abort('blockedbyclient');
      }
    });
    if (disableJavaScript) {
      await page.setJavaScriptEnabled(false);
    }

    const html = buildHtml(address.port);
    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page
      .waitForNetworkIdle({ idleTime: 250, timeout: 2_000 })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const jsMarker = await page.evaluate(
      () => document.body.dataset.be010Js ?? 'absent',
    );
    report('javascript.marker', jsMarker);
    report('network.local_server_hits', serverHits);
    report(
      'network.requests',
      requests
        .map((entry) => `${summarizeRequest(entry.url)}:${entry.resourceType}`)
        .join('|'),
    );

    const startedAt = Date.now();
    let timeoutObserved = false;
    try {
      await page.waitForSelector('#be010-never-exists', { timeout: 300 });
    } catch {
      timeoutObserved = true;
    }
    report('timeout.observed', timeoutObserved);
    report('timeout.duration_ms', Date.now() - startedAt);

    const pdf = Buffer.from(
      await page.pdf({ format: 'A4', printBackground: true, timeout: 30_000 }),
    );
    const parsed = await parsePdf(pdf);
    const text = parsed.text.replace(/\s+/g, ' ');
    const contentOk =
      text.includes('BE-010 PDF REAL') &&
      text.includes('Segurança do Trabalho');
    report('pdf.bytes', pdf.length);
    report('pdf.sha256_short', shortHash(pdf));
    report('pdf.pages', parsed.total);
    report('pdf.content_ok', contentOk);
    await page.close();
    page = undefined;
    report('page.closed', true);

    await browser.close();
    browser = undefined;
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
    report('browser.closed', true);

    const {
      PuppeteerPoolService,
    } = require('../dist/shared/services/puppeteer-pool.service.js');
    pool = new PuppeteerPoolService();
    pool.onModuleInit();
    const concurrencyResults = [];
    const requestedConcurrency = [1, 5, 10, 20].filter(
      (value) => value <= Number(process.env.BE010_MAX_CONCURRENCY || 20),
    );
    for (const concurrency of requestedConcurrency) {
      const started = Date.now();
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          let concurrentPage;
          try {
            concurrentPage = await pool.getPage();
            await concurrentPage.setContent(
              '<html><body>PDF concorrente ãçé°</body></html>',
              {
                waitUntil: 'domcontentloaded',
                timeout: 5_000,
              },
            );
            const concurrentPdf = Buffer.from(
              await concurrentPage.pdf({ format: 'A4', timeout: 30_000 }),
            );
            await parsePdf(concurrentPdf);
          } finally {
            if (concurrentPage) await pool.releasePage(concurrentPage);
          }
        }),
      );
      concurrencyResults.push(`${concurrency}:${Date.now() - started}ms`);
    }
    report('pool.concurrency', concurrencyResults.join(','));

    // Simula a morte abrupta dos processos disponíveis e exige que o pool
    // recicle o Chromium antes de entregar a próxima página. Isto cobre a
    // fronteira de crash recovery, além do cleanup normal já medido abaixo.
    const pooledBrowsers = pool.browserPool ?? [];
    for (const pooledBrowser of pooledBrowsers) {
      try {
        pooledBrowser.browser.process()?.kill('SIGKILL');
      } catch {
        // O processo pode já ter terminado durante a onda concorrente.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    let crashRecovery = false;
    let recoveryPage;
    try {
      recoveryPage = await pool.getPage();
      await recoveryPage.setContent(
        '<html><body>PDF crash recovery ãçé°</body></html>',
        { waitUntil: 'domcontentloaded', timeout: 5_000 },
      );
      crashRecovery = true;
    } finally {
      if (recoveryPage) await pool.releasePage(recoveryPage);
    }
    report('pool.crash_recovery', crashRecovery);

    await pool.onModuleDestroy();
    pool = undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
    report('processes.after', chromiumProcessCount());

    const blockedHosts = requests.filter(({ url }) =>
      /127\.0\.0\.1|localhost|169\.254\.169\.254|192\.168\.0\.1|example\.invalid|file:|ftp:/.test(
        url,
      ),
    );
    const fileRequestObserved = requests.some(({ url }) =>
      url.startsWith('file:'),
    );
    const ssrfBlocked =
      blockedHosts.length >= 6 && serverHits === 0 && !fileRequestObserved;
    const javascriptBlocked = jsMarker === 'absent';
    const cleanupOk = chromiumProcessCount() === 0;
    report('ssrf.blocked', ssrfBlocked);
    report('javascript.blocked', javascriptBlocked);
    report('cleanup.ok', cleanupOk);

    if (assertMode) {
      if (!javascriptBlocked) fail('JavaScript executou no template');
      if (!ssrfBlocked) fail('SSRF/rede local não foi bloqueado');
      if (!timeoutObserved) fail('timeout controlado não foi observado');
      if (!contentOk || pdf.length === 0) fail('PDF real inválido');
      if (!crashRecovery) fail('pool não recuperou após crash do Chromium');
      if (!cleanupOk) fail('processos Chromium persistiram após cleanup');
    }
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.onModuleDestroy().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(
    `[BE010-FAIL] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
