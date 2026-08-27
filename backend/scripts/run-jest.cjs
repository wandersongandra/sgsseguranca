const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);

// Diagnostico TEMPORARIO: medir RAM real do runner antes de cada execucao
// e2e, para confirmar (ou refutar) a hipotese de que o teto e' fisico, nao
// o --max-old-space-size configurado. Remover apos identificar a causa
// raiz do OOM nas 3 suites que ainda falham isoladas mesmo com
// concorrencia de PDF forcada a 1.
if (
  args.some((arg) => /jest-e2e/i.test(arg)) &&
  process.env.DIAG_MEMORY === 'true'
) {
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
applyDefault(
  'JWT_SECRET',
  'test-jwt-secret-unit-tests-only-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
);
applyDefault(
  'JWT_REFRESH_SECRET',
  'test-refresh-secret-unit-tests-only-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
);
applyDefault('JWT_ISSUER', 'https://jwt.test.sgs.local');
applyDefault('JWT_AUDIENCE', 'sgs-test');
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
  // Propagar --max-old-space-size para processos filhos (per-file Jest spawns).
  // Cada spawn herda env mas nao herda execArgv do processo pai.
  const heapArg = process.execArgv.find((a) =>
    /^--max-old-space-size=/.test(a),
  );
  if (heapArg && !/--max-old-space-size\b/.test(env.NODE_OPTIONS)) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS} ${heapArg}`.trim();
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

// Para suites E2E sem arquivo especifico: spawnar Jest UMA VEZ POR ARQUIVO.
// Com --runInBand ou maxWorkers=1, o Jest reutiliza o mesmo processo Node para
// todos os arquivos — o AppModule de NestJS (54 modulos) acumula ~200–400 MB
// por arquivo e jamais e' liberado dentro do mesmo processo. 15 arquivos x 400 MB
// = 6 GB, causando OOM independente do heap limit configurado.
//
// Spawnar Jest por arquivo garante isolamento de memoria real: cada processo
// Node morre apos o arquivo, liberando toda a memoria para o proximo.
const specificTestFile = args.find(
  (a) =>
    !a.startsWith('-') && (a.endsWith('.e2e-spec.ts') || a.endsWith('.e2e.ts')),
);

if (isE2EConfig && !specificTestFile) {
  function findE2EFiles(dir) {
    const files = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findE2EFiles(full));
      } else if (entry.name.endsWith('.e2e-spec.ts')) {
        files.push(full);
      }
    }
    return files.sort();
  }

  const testRoot = path.resolve(__dirname, '..', 'test');
  const scannedDirs = [
    path.join(testRoot, 'critical'),
    path.join(testRoot, 'aprs'),
  ];
  const standaloneFiles = [
    'idor-security.e2e-spec.ts',
    'multi-tenancy.e2e-spec.ts',
  ].map((f) => path.join(testRoot, f));

  const testFiles = [
    ...scannedDirs.flatMap(findE2EFiles),
    ...standaloneFiles.filter((f) => {
      try {
        fs.statSync(f);
        return true;
      } catch {
        return false;
      }
    }),
  ];

  // Todos os args originais sao flags (--config, --forceExit, etc.)
  // e sao repassados para cada invocacao por arquivo.
  const sharedArgs = [...args];

  let failed = false;
  for (const testFile of testFiles) {
    const rel = path.relative(testRoot, testFile);
    process.stdout.write(`\n[e2e] === ${rel} ===\n`);

    const fileResult = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        jestBin,
        '--runInBand', // roda no mesmo processo do spawn (sem sub-workers)
        testFile.replace(/\\/g, '/'), // filtro de caminho para Jest
        ...sharedArgs,
      ],
      { stdio: 'inherit', env },
    );

    if (fileResult.error) throw fileResult.error;
    if (fileResult.status !== 0) {
      failed = true;
      break; // fail-fast
    }
  }

  process.exit(failed ? 1 : 0);
}

// Caminho normal: arquivo especifico (test:e2e:dr) ou testes nao-E2E.
const result = spawnSync(
  process.execPath,
  [...process.execArgv, jestBin, ...args],
  {
    stdio: 'inherit',
    env,
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
