/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/src'],
  testMatch: ['**/?(*.)+(spec|test).[tj]s'],
  testTimeout: 130_000,
  setupFilesAfterEnv: ['<rootDir>/tests/jestSetup.ts'],
  globalTeardown: '<rootDir>/tests/global-teardown.ts',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        strict: true,
        esModuleInterop: true,
        target: 'ES2020',
        module: 'commonjs',
        resolveJsonModule: true,
      },
    }],
  },
  moduleNameMapper: {
    '^@stellar/stellar-sdk$': '<rootDir>/__mocks__/@stellar/stellar-sdk.js',
    '^better-sqlite3$': '<rootDir>/__mocks__/better-sqlite3.js',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/index.ts',
    '!src/**/.gitkeep',
    '!src/registry/sync.ts',
    '!src/api/routes/stream.ts',
    '!src/index.ts',
    '!src/checkSpec.ts',
  ],
  coverageThreshold: {
    global: {
      statements: 75,
      branches: 70,
      functions: 75,
      lines: 75,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],
};
