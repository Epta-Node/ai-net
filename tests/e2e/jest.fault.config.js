/**
 * Jest config for the fault injection suite (issue #852).
 *
 * Separate from jest.config.js so the eight fault scenarios — several of
 * which wait on job-queue retry backoff — can run standalone
 * (`npm run test:fault`) without slowing the standard e2e run, which
 * excludes this file via `testPathIgnorePatterns`.
 */
const path = require('path');

let tsJestPath;
try {
  tsJestPath = require.resolve('ts-jest');
} catch (e) {
  tsJestPath = 'ts-jest';
}

module.exports = {
  testEnvironment: 'node',
  rootDir: path.resolve(__dirname, '../../backend'),
  roots: ['<rootDir>/../tests/e2e'],
  testMatch: ['<rootDir>/../tests/e2e/fault-injection.test.ts'],
  moduleNameMapper: {
    '^@stellar/stellar-sdk$': '<rootDir>/node_modules/@stellar/stellar-sdk',
    '^supertest$': '<rootDir>/node_modules/supertest',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.tsx?$': [tsJestPath, {
      tsconfig: {
        strict: true,
        esModuleInterop: true,
        target: 'ES2020',
        module: 'commonjs',
        resolveJsonModule: true,
      },
    }],
  },
  setupFilesAfterEnv: ['<rootDir>/../tests/e2e/setup.ts'],
  globalTeardown: '<rootDir>/../tests/e2e/teardown.ts',
  testTimeout: 90000
};
