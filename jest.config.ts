import type { Config } from 'jest';

/**
 * Two projects on purpose:
 *  - `unit` is pure and fast; it must never need Docker, a database or the network.
 *  - `e2e`  boots Postgres + Redis via testcontainers once (globalSetup) and runs serially,
 *           because the concurrency tests deliberately contend on the same rows.
 *
 * `yarn test` runs both, which is what the brief asks for.
 */
const tsPaths = {
  '^@/(.*)$': '<rootDir>/src/$1',
  '^@test/(.*)$': '<rootDir>/test/$1',
};

const config: Config = {
  projects: [
    {
      displayName: 'unit',
      rootDir: '.',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
      moduleNameMapper: tsPaths,
      setupFilesAfterEnv: ['<rootDir>/test/setup-unit.ts'],
    },
    {
      displayName: 'e2e',
      rootDir: '.',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
      moduleNameMapper: tsPaths,
      globalSetup: '<rootDir>/test/global-setup.ts',
      globalTeardown: '<rootDir>/test/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/test/setup-e2e.ts'],
      testTimeout: 120_000,
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts', '!src/**/*.dto.ts'],
  coverageDirectory: 'coverage',
};

export default config;
