import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testTimeout: 60000,
  testMatch: [
    '<rootDir>/critical/**/*.e2e-spec.ts',
    '<rootDir>/aprs/**/*.e2e-spec.ts',
    '<rootDir>/idor-security.e2e-spec.ts',
    '<rootDir>/multi-tenancy.e2e-spec.ts',
  ],
  transform: {
    '^.+\\.(t|j)s$': [
      '<rootDir>/nestjs-esm-transformer.js',
      { tsconfig: { allowJs: true }, diagnostics: false },
    ],
  },
  // @nestjs/* v12 packages are pure ESM ("type":"module"). Jest runs in CJS
  // mode, so we must transform them (via nestjs-esm-transformer.js, which
  // additionally rewrites import.meta.* to CJS equivalents) rather than
  // require() their raw ESM files. See jest.config.js (root) for the same
  // fix applied to the unit-test config — this is a separate Jest root
  // (rootDir: e2e's own test/ dir) with its own transform/moduleNameMapper,
  // so it needs the identical fix independently.
  transformIgnorePatterns: ['/node_modules/(?!@nestjs/)'],
  // uuid@14 e puppeteer@25+ sao ESM puro. NODE_OPTIONS=--experimental-vm-modules
  // esta ativo para esta config (necessario para pdf-parse/pdfjs-dist), mas
  // essa mesma flag faz o Jest tentar seu proprio require(ESM) sincrono para
  // 'puppeteer', que exige Node >=24.9 (esta plataforma roda 22.x). A saida:
  // interceptar 'puppeteer' antes que o Jest tente resolver o pacote real —
  // ver test/puppeteer-cjs-shim.js.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/uuid-cjs.js',
    // O shim real carrega o Puppeteer ESM via `new Function` (escapa o Jest)
    // consumindo 300-600 MB de heap e lançando Chromium — causa OOM no CI.
    // O mock retorna um PDF mínimo válido sem subprocesso, preservando o
    // contrato HTTP dos endpoints (o que E2E precisa testar).
    '^puppeteer$': '<rootDir>/puppeteer-e2e-mock.cjs',
  },
  globalSetup: '<rootDir>/setup/e2e-infra-check.ts',
  globalTeardown: '<rootDir>/setup/e2e-global-teardown.ts',
  openHandlesTimeout: 10_000,
  maxWorkers: 1,
  workerThreads: false,
};

export default config;
