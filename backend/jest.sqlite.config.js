/**
 * Jest project for backend tests that require **real** SQLite behaviour.
 *
 * The default `jest.config.js` maps `better-sqlite3` to a stub
 * (`__mocks__/better-sqlite3.js`), which exists because the native module has
 * no Windows prebuild. That stub is fine for tests that only assert on shapes,
 * but it cannot observe transactional rollback, triggers, `INSERT OR IGNORE`,
 * partial-write detection, or row-count arithmetic — precisely what the event
 * store retention job (issue #383) is built to guarantee.
 *
 * Tests under `tests/sqlite/` therefore run here, against the real native
 * module. Run with: `npm run test:sqlite`
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: ['<rootDir>/tests/sqlite'],
  testMatch: ['**/?(*.)+(spec|test).[tj]s'],
  testTimeout: 130_000,
  setupFilesAfterEnv: ['<rootDir>/tests/jestSetup.ts'],
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
    // NOTE: deliberately no better-sqlite3 mapping here — that is the point.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
