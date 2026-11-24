// Manual mock for better-sqlite3 (native module).
// better-sqlite3 v9.6.0 ships no prebuilt binaries for standard Node on
// Windows, and compiling requires a Visual Studio C++ toolchain. Tests that do
// not assert on real SQLite behaviour (e.g. the trace-propagation suite) get a
// minimal in-memory statement mock from here instead.
// Jest wiring lives in backend/jest.config.js (moduleNameMapper).

class MockStatement {
  constructor(sql = '', sharedStore = { rows: [], lastInsertRowid: 0 }) {
    this.sql = sql;
    this.sharedStore = sharedStore;
    this.keys = [];
  }

  get rows() {
    return this.sharedStore.rows;
  }

  run(...args) {
    this.sharedStore.lastInsertRowid += 1;
    const item = args[0];
    if (item && typeof item === 'object') {
      const row = {
        global_seq: this.sharedStore.lastInsertRowid,
        task_seq: item.task_seq ?? item.taskSeq,
        version: item.version ?? 1,
        type: item.type,
        task_id: item.task_id ?? item.taskId,
        node_id: item.node_id ?? item.nodeId ?? null,
        occurred_at: item.occurred_at ?? item.occurredAt,
        payload: item.payload,
        ...item,
      };

      if (this.sql.includes('INSERT INTO task_events')) {
        const dup = this.sharedStore.rows.find(
          (r) => r.task_id === row.task_id && r.task_seq === row.task_seq
        );
        if (dup) {
          throw new Error('UNIQUE constraint failed: task_events.task_id, task_events.task_seq');
        }
      }

      this.sharedStore.rows.push(row);
    }
    return { changes: 1, lastInsertRowid: this.sharedStore.lastInsertRowid };
  }

  get(...args) {
    if (args[0] !== undefined) {
      if (typeof args[0] === 'string') {
        const found = this.rows.find((r) => r.task_id === args[0] || r.id === args[0]);
        if (found) return found;
      }
    }
    if (this.sql.toUpperCase().includes('DESC')) {
      return this.rows[this.rows.length - 1] ?? undefined;
    }
    return this.rows[0] ?? undefined;
  }

  all(...args) {
    let res = this.rows;
    if (args.length > 0 && args[0] !== undefined) {
      if (this.sql.includes('occurred_at >= ? AND occurred_at <= ?') && !this.sql.includes('type = ?')) {
        const from = args[0];
        const to = args[1];
        res = res.filter((r) => r.occurred_at >= from && r.occurred_at <= to);
      } else if (this.sql.includes('type = ? AND occurred_at >= ? AND occurred_at <= ?')) {
        const type = args[0];
        const from = args[1];
        const to = args[2];
        res = res.filter(
          (r) => r.type === type && r.occurred_at >= from && r.occurred_at <= to
        );
      } else {
        const filterVal = args[0];
        if (typeof filterVal === 'string') {
          res = res.filter(
            (r) => r.task_id === filterVal || r.type === filterVal || r.status === filterVal
          );
          if (args.length > 1 && typeof args[1] === 'number') {
            const afterSeq = args[1];
            res = res.filter((r) => (r.task_seq ?? r.seq) > afterSeq);
          }
        }
      }
    }
    return res;
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
    this.sharedStore = { rows: [], lastInsertRowid: 0 };
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
      this.statements.set(sql, new MockStatement(sql, this.sharedStore));
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
