/**
 * Runtime feature flags: rollout bucketing, allow-lists and persistence
 * (issue #814).
 */
import Database from "better-sqlite3";
import {
  clearRuntimeOverrides,
  deleteFlagRecord,
  initFeatureFlagPersistence,
  isEnabled,
  listFlagRecords,
  rolloutBucket,
  upsertFlag,
} from "./featureFlags";

const FLAG = "design_agent";
const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** A deterministic population of wallet keys for measuring rollout share. */
const POPULATION = Array.from({ length: 1000 }, (_, i) => `G${String(i).padStart(55, "A")}`);

afterEach(() => {
  clearRuntimeOverrides();
});

describe("rolloutBucket", () => {
  it("returns the same bucket for the same flag and wallet every time", () => {
    expect(rolloutBucket(FLAG, WALLET_A)).toBe(rolloutBucket(FLAG, WALLET_A));
  });

  it("always lands in the range [0, 100)", () => {
    for (const wallet of POPULATION) {
      const bucket = rolloutBucket(FLAG, wallet);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it("buckets the same wallet independently per flag", () => {
    const buckets = new Set(
      ["flag_one", "flag_two", "flag_three", "flag_four", "flag_five"].map((f) =>
        rolloutBucket(f, WALLET_A),
      ),
    );
    expect(buckets.size).toBeGreaterThan(1);
  });
});

describe("rollout evaluation", () => {
  it("approximates the configured share across a population", () => {
    upsertFlag(FLAG, { enabled: true, rolloutPercent: 50 }, "admin");

    const enabledCount = POPULATION.filter((wallet) =>
      isEnabled(FLAG, { walletPublicKey: wallet }),
    ).length;

    expect(enabledCount).toBeGreaterThan(400);
    expect(enabledCount).toBeLessThan(600);
  });

  it("is enabled for every wallet at rolloutPercent 100 and for none at 0", () => {
    upsertFlag(FLAG, { enabled: true, rolloutPercent: 100 }, "admin");
    expect(POPULATION.every((wallet) => isEnabled(FLAG, { walletPublicKey: wallet }))).toBe(true);

    upsertFlag(FLAG, { enabled: true, rolloutPercent: 0 }, "admin");
    expect(POPULATION.some((wallet) => isEnabled(FLAG, { walletPublicKey: wallet }))).toBe(false);
  });

  it("is off without a wallet while the rollout is partial", () => {
    upsertFlag(FLAG, { enabled: true, rolloutPercent: 50 }, "admin");

    expect(isEnabled(FLAG)).toBe(false);
  });

  it("is on without a wallet at rolloutPercent 100", () => {
    upsertFlag(FLAG, { enabled: true, rolloutPercent: 100 }, "admin");

    expect(isEnabled(FLAG)).toBe(true);
  });

  it("lets an allow-listed wallet through even when the flag is disabled", () => {
    upsertFlag(
      FLAG,
      { enabled: false, rolloutPercent: 0, enabledWallets: [WALLET_A] },
      "admin",
    );

    expect(isEnabled(FLAG, { walletPublicKey: WALLET_A })).toBe(true);
    expect(isEnabled(FLAG, { walletPublicKey: WALLET_B })).toBe(false);
  });

  it("keeps the master switch off for everyone when enabled is false", () => {
    upsertFlag(FLAG, { enabled: false, rolloutPercent: 100 }, "admin");

    expect(isEnabled(FLAG, { walletPublicKey: WALLET_A })).toBe(false);
  });
});

describe("runtime record persistence", () => {
  it("reloads a stored record after a restart", () => {
    const db = new Database(":memory:");
    initFeatureFlagPersistence(db);
    upsertFlag(
      FLAG,
      { enabled: true, rolloutPercent: 25, enabledWallets: [WALLET_A] },
      "admin-1",
    );

    // Simulate a restart: the in-memory state is gone, the database is not.
    clearRuntimeOverrides();
    expect(isEnabled(FLAG, { walletPublicKey: WALLET_A })).toBe(false);

    initFeatureFlagPersistence(db);

    expect(isEnabled(FLAG, { walletPublicKey: WALLET_A })).toBe(true);
    const [record] = listFlagRecords();
    expect(record).toMatchObject({
      key: FLAG,
      enabled: true,
      rolloutPercent: 25,
      enabledWallets: [WALLET_A],
      updatedBy: "admin-1",
    });
  });

  it("writes one row per flag and updates it in place", () => {
    const db = new Database(":memory:");
    initFeatureFlagPersistence(db);

    upsertFlag(FLAG, { enabled: true, rolloutPercent: 10 }, "admin-1");
    upsertFlag(FLAG, { rolloutPercent: 60 }, "admin-2");

    const rows = db.prepare("SELECT key, rollout_percent, updated_by FROM feature_flags").all();
    expect(rows).toEqual([{ key: FLAG, rollout_percent: 60, updated_by: "admin-2" }]);
  });

  it("removes the row and falls back to the default when a record is deleted", () => {
    const db = new Database(":memory:");
    initFeatureFlagPersistence(db);
    upsertFlag("streaming_responses", { enabled: false }, "admin");

    expect(isEnabled("streaming_responses")).toBe(false);
    expect(deleteFlagRecord("streaming_responses")).toBe(true);

    expect(isEnabled("streaming_responses")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM feature_flags").get()).toEqual({ n: 0 });
  });

  it("reports nothing to delete for a flag with no record", () => {
    expect(deleteFlagRecord("never_set_flag")).toBe(false);
  });
});
