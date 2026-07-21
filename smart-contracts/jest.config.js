/**
 * Jest configuration for the smart-contracts package.
 *
 * Test separation is handled via npm scripts:
 *   npm test              → all tests (unit + integration)
 *   npm run test:unit     → unit tests only (default in CI for PRs)
 *   npm run test:integration → integration / e2e tests only
 *
 * Integration tests are in:
 *   - tests/e2e/
 *   - tests/integration/
 *
 * In CI, only unit tests run on PRs. Integration/e2e tests run
 * on merges to main via a separate workflow job.
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globalSetup: '<rootDir>/tests/globalSetup.ts',
  globalTeardown: '<rootDir>/tests/globalTeardown.ts',

  // ── Test discovery ──────────────────────────────────────────────────────
  testMatch: ['**/tests/**/*.test.ts'],
};
