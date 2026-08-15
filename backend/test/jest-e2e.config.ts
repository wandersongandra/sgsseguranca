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
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  // uuid@14 e puppeteer@25+ sao ESM puro. NODE_OPTIONS=--experimental-vm-modules
  // esta ativo para esta config (necessario para pdf-parse/pdfjs-dist), mas
  // essa mesma flag faz o Jest tentar seu proprio require(ESM) sincrono para
  // 'puppeteer', que exige Node >=24.9 (esta plataforma roda 22.x). A saida:
  // interceptar 'puppeteer' antes que o Jest tente resolver o pacote real —
  // ver test/puppeteer-cjs-shim.js.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/uuid-cjs.js',
    '^puppeteer$': '<rootDir>/puppeteer-cjs-shim.js',
  },
  globalSetup: '<rootDir>/setup/e2e-infra-check.ts',
  globalTeardown: '<rootDir>/setup/e2e-global-teardown.ts',
  openHandlesTimeout: 10_000,
  maxWorkers: 1,
  workerThreads: false,
};

export default config;
