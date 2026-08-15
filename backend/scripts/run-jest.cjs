const { spawnSync } = require('node:child_process');
const os = require('node:os');

const args = process.argv.slice(2);

// Diagnostico TEMPORARIO: medir RAM real do runner antes de cada execucao
// e2e, para confirmar (ou refutar) a hipotese de que o teto e' fisico, nao
// o --max-old-space-size configurado. Remover apos identificar a causa
// raiz do OOM nas 3 suites que ainda falham isoladas mesmo com
// concorrencia de PDF forcada a 1.
if (args.some((arg) => /jest-e2e/i.test(arg)) && process.env.DIAG_MEMORY === 'true') {
  const toMB = (bytes) => Math.round(bytes / 1024 / 1024);
  console.log(
    `[diag-memory] total=${toMB(os.totalmem())}MB free=${toMB(os.freemem())}MB ` +
      `args=${JSON.stringify(args)}`,
  );
}
const env = { ...process.env };

function applyDefault(key, value) {
  if (!env[key]) {
    env[key] = value;
  }
}

applyDefault('NODE_ENV', 'test');
applyDefault('TZ', 'UTC');
applyDefault('LOG_LEVEL', 'error');
applyDefault('OTEL_ENABLED', 'false');
applyDefault('NEW_RELIC_ENABLED', 'false');
applyDefault('JWT_SECRET', 'test-jwt-secret-unit-tests-only-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
applyDefault('JWT_REFRESH_SECRET', 'test-refresh-secret-unit-tests-only-bbbbbbbbbbbbbbbbbbbbbbbbbbbb');
applyDefault(
  'SECURITY_AUDIT_HMAC_KEY',
  'test-security-audit-hmac-key-only-cccccccccccccccccccccccc',
);
applyDefault('BCRYPT_SALT_ROUNDS', '4');

const isE2EConfig = args.some((arg) => /jest-e2e/i.test(arg));
if (isE2EConfig) {
  // Necessaria para pdf-parse -> pdfjs-dist (ESM real, .mjs) resolver seu
  // "fake worker" em runtime de teste. Sem ela: "A dynamic import callback
  // was invoked without --experimental-vm-modules". Tensao conhecida: essa
  // MESMA flag muda como o Jest carrega 'puppeteer' (tambem ESM) -- por
  // isso o Puppeteer passa por um shim CJS proprio (ver
  // moduleNameMapper/puppeteer-cjs-shim.js) em vez de depender do
  // comportamento nativo de require(ESM) do Jest, que exige Node >=24.9.
  const nodeOptions = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : '';
  if (!/--experimental-vm-modules\b/.test(nodeOptions)) {
    env.NODE_OPTIONS = `${nodeOptions}--experimental-vm-modules`.trim();
  }
}

// jest-cli/bin/jest was the path in jest v28 and below.
// In jest v29+ the binary moved to jest/bin/jest.
// Try both to support either version.
let jestBin;
try {
  jestBin = require.resolve('jest/bin/jest');
} catch {
  jestBin = require.resolve('jest-cli/bin/jest');
}
const result = spawnSync(process.execPath, [jestBin, ...args], {
  stdio: 'inherit',
  env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
