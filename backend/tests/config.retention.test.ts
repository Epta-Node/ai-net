/**
 * Retention/compaction configuration (issue #383).
 *
 * Runs in the default backend suite — `config` touches no SQLite, so the
 * stubbed `better-sqlite3` mock is irrelevant here.
 */

import { loadConfig, resetConfigForTests, ConfigValidationError } from "../src/config";

const BASE_ENV = {
  VENICE_API_KEY: "test-key",
  DATABASE_URL: ":memory:",
} as NodeJS.ProcessEnv;

afterEach(() => {
  resetConfigForTests();
});

describe("event store retention configuration", () => {
  it("provides defaults for every retention key", () => {
    resetConfigForTests();
    const config = loadConfig({ ...BASE_ENV });

    expect(config.EVENT_STORE_PATH).toBe("./data/events.db");
    expect(config.EVENT_RETENTION_DAYS).toBe(30);
    expect(config.EVENT_COMPACTION_INTERVAL_MS).toBe(3_600_000);
    expect(config.EVENT_COMPACTION_BATCH_TASKS).toBe(50);
    expect(config.EVENT_COMPACTION_ENABLED).toBe(true);
  });

  it("coerces string env values and honours explicit overrides", () => {
    resetConfigForTests();
    const config = loadConfig({
      ...BASE_ENV,
      EVENT_STORE_PATH: "/var/lib/ai-net/events.db",
      EVENT_RETENTION_DAYS: "7",
      EVENT_COMPACTION_INTERVAL_MS: "60000",
      EVENT_COMPACTION_BATCH_TASKS: "250",
      EVENT_COMPACTION_ENABLED: "false",
    });

    expect(config.EVENT_STORE_PATH).toBe("/var/lib/ai-net/events.db");
    expect(config.EVENT_RETENTION_DAYS).toBe(7);
    expect(config.EVENT_COMPACTION_INTERVAL_MS).toBe(60_000);
    expect(config.EVENT_COMPACTION_BATCH_TASKS).toBe(250);
    expect(config.EVENT_COMPACTION_ENABLED).toBe(false);
  });

  it("rejects a non-positive retention window", () => {
    resetConfigForTests();
    expect(() => loadConfig({ ...BASE_ENV, EVENT_RETENTION_DAYS: "0" })).toThrow(
      ConfigValidationError,
    );

    resetConfigForTests();
    expect(() => loadConfig({ ...BASE_ENV, EVENT_RETENTION_DAYS: "-1" })).toThrow(
      ConfigValidationError,
    );
  });

  it("rejects a non-positive batch size and interval", () => {
    resetConfigForTests();
    expect(() => loadConfig({ ...BASE_ENV, EVENT_COMPACTION_BATCH_TASKS: "0" })).toThrow(
      ConfigValidationError,
    );

    resetConfigForTests();
    expect(() => loadConfig({ ...BASE_ENV, EVENT_COMPACTION_INTERVAL_MS: "0" })).toThrow(
      ConfigValidationError,
    );
  });

  it("keeps the event store off the filesystem under NODE_ENV=test", () => {
    resetConfigForTests();
    const config = loadConfig({ ...BASE_ENV, NODE_ENV: "test" });
    expect(config.EVENT_STORE_PATH).toBe(":memory:");
  });
});
