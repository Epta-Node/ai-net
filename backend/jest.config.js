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
      diagnostics: false,
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
    // NOTE: `better-sqlite3` is intentionally NOT mapped to __mocks__ here.
    // It used to be, because v9.6.0 shipped no prebuilt binaries for Node on
    // Windows and compiling it needed a C++ toolchain — so every SQLite-backed
    // suite silently ran against a hand-written statement stub, which cannot
    // execute real DDL. Since the dependency moved to v13 (prebuilds for Node
    // 24 on all platforms) the real module loads, so the DB suites exercise
    // actual SQLite again: migrations, schema shapes and UNIQUE constraints
    // included.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/.gitkeep',
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
