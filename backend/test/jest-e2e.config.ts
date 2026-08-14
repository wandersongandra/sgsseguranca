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
    '^.+\\.(t|j)s$': '<rootDir>/e2e-ts-transformer.cjs',
  },
  moduleNameMapper: {
    '^uuid$': '<rootDir>/uuid-cjs.js',
  },
  globalSetup: '<rootDir>/setup/e2e-infra-check.ts',
  globalTeardown: '<rootDir>/setup/e2e-global-teardown.ts',
  openHandlesTimeout: 10_000,
  maxWorkers: 1,
  workerThreads: false,
};

export default config;
