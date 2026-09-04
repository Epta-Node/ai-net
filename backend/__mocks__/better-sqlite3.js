// Manual mock for better-sqlite3 (native module).
// better-sqlite3 v9.6.0 ships no prebuilt binaries for standard Node on
// Windows, and compiling requires a Visual Studio C++ toolchain. Tests that do
// not assert on real SQLite behaviour (e.g. the trace-propagation suite) get a
// minimal in-memory statement mock from here instead.
// Jest wiring lives in backend/jest.config.js (moduleNameMapper).

class MockStatement {
  constructor() {
    this.rows = [];
    this.lastResult = { changes: 0, lastInsertRowid: 1 };
    this.keys = [];
  }

  run(..._args) {
    return this.lastResult;
  }

  get(..._args) {
    return this.rows[0] ?? undefined;
  }

  all(..._args) {
    return this.rows;
  }

  raw(..._args) {
    return this;
  }

  safeIntegers(..._args) {
    return this;
  }
}

class MockDatabase {
  constructor(_nameOrPath, _options) {
    this.closed = false;
    this.statements = new Map();
  }

  pragma(_sql, _arg) {
    return undefined;
  }

  exec(_sql) {
    return this;
  }

  prepare(sql) {
    if (!this.statements.has(sql)) {
      this.statements.set(sql, new MockStatement());
    }
    return this.statements.get(sql);
  }

  transaction(fn) {
    return (...args) => fn(...args);
  }

  function(_name, _fn) {
    return this;
  }

  serialize(_options) {
    return Buffer.alloc(0);
  }

  close() {
    this.closed = true;
    return this;
  }

  on(_event, _listener) {
    return this;
  }
}

module.exports = MockDatabase;
module.exports.default = MockDatabase;
module.exports.Database = MockDatabase;
