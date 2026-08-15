/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'src/.*\\.(spec|smoke-spec)\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': require.resolve('ts-jest').replace(/\\/g, '/'),
  },
  // uuid >=14 is pure ESM and cannot be loaded by Jest's CJS transform.
  // This CJS shim mirrors the full uuid API using Node's built-in crypto.
  // Production runtime uses uuid@14 directly (override in package.json).
  //
  // puppeteer 25+ e' ESM puro tambem. Mesmo mecanismo: intercepta o
  // require('puppeteer') antes que o Jest tente resolver o pacote real
  // (ver test/puppeteer-cjs-shim.js para o porque).
  moduleNameMapper: {
    '^uuid$': '<rootDir>/test/uuid-cjs.js',
    '^puppeteer$': '<rootDir>/test/puppeteer-cjs-shim.js',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: 'coverage',
  maxWorkers: 1,
  silent: true,
  coverageThreshold: {
    global: {
      statements: 49,
      functions: 40,
      branches: 40,
    },
  },
  testEnvironment: 'node',
  clearMocks: true,
  restoreMocks: true,
  setupFilesAfterEnv: ['<rootDir>/test/jest.setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
};
