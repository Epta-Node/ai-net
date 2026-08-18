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
  testMatch: ['<rootDir>/../tests/e2e/**/*.test.ts'],
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
  testTimeout: 30000
};
