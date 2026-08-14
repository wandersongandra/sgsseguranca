/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testTimeout: 120000,
  testMatch: ['<rootDir>/aprs/puppeteer-pool-runtime.e2e-spec.ts'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  maxWorkers: 1,
  workerThreads: false,
};
