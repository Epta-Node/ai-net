import { VeniceKeyPool, KEY_POOL_MIN_SAMPLES, keyFragmentOf, loadNumberedVeniceKeys } from "./keyPool";
import { VeniceUnavailableError } from "./errors";

const KEY_A = "venice-key-AAAA1111";
const KEY_B = "venice-key-BBBB2222";

function makePool(now: () => number, cooldownMs = 60_000, errorRateThreshold = 0.2) {
  return new VeniceKeyPool([KEY_A, KEY_B], { cooldownMs, errorRateThreshold, now });
}

describe("VeniceKeyPool", () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
  });

  it("trips a key into cooldown once its error rate passes the threshold", () => {
    const pool = makePool(now);
    for (let i = 0; i < KEY_POOL_MIN_SAMPLES; i += 1) pool.recordResult(KEY_A, false);

    expect(pool.isAvailable(KEY_A)).toBe(false);
    expect(pool.isAvailable(KEY_B)).toBe(true);
    expect(pool.acquire()).toBe(KEY_B);
  });

  it("does not trip a key on a single early failure", () => {
    const pool = makePool(now);
    pool.recordResult(KEY_A, false);

    expect(pool.isAvailable(KEY_A)).toBe(true);
  });

  it("stays below the threshold when most recent requests succeed", () => {
    const pool = makePool(now);
    for (let i = 0; i < 9; i += 1) pool.recordResult(KEY_A, true);
    pool.recordResult(KEY_A, false);
    pool.recordResult(KEY_A, false);

    // 2 of 11 failed: about 18%, under the 20% threshold.
    expect(pool.isAvailable(KEY_A)).toBe(true);
  });

  it("returns a key to rotation once its cooldown expires", () => {
    const pool = makePool(now);
    pool.markCoolingDown(KEY_A, 60_000);
    expect(pool.isAvailable(KEY_A)).toBe(false);

    clock += 60_000;
    expect(pool.isAvailable(KEY_A)).toBe(true);
  });

  it("throws VeniceUnavailableError when every key is cooling down", () => {
    const pool = makePool(now);
    pool.markCoolingDown(KEY_A);
    pool.markCoolingDown(KEY_B);

    expect(() => pool.acquire()).toThrow(VeniceUnavailableError);
    expect(pool.healthyCount()).toBe(0);
  });

  it("prefers the key with the lower error rate", () => {
    const pool = makePool(now);
    pool.recordResult(KEY_A, false);
    pool.recordResult(KEY_B, true);

    expect(pool.acquire()).toBe(KEY_B);
  });

  it("exposes masked key fragments only", () => {
    const pool = makePool(now);
    pool.recordResult(KEY_A, true);
    const status = pool.getStatus();
    const serialized = JSON.stringify(status);

    expect(status.map((s) => s.keyFragment)).toEqual([keyFragmentOf(KEY_A), keyFragmentOf(KEY_B)]);
    expect(keyFragmentOf(KEY_A)).toBe("...1111");
    expect(serialized).not.toContain(KEY_A);
    expect(serialized).not.toContain(KEY_B);
    expect(status[0]!.requestCount).toBe(1);
  });

  it("reports the cooldown expiry in status", () => {
    const pool = makePool(now);
    pool.markCoolingDown(KEY_A, 5_000);
    const [first] = pool.getStatus();

    expect(first!.healthy).toBe(false);
    expect(first!.coolingDownUntil).toBe(new Date(clock + 5_000).toISOString());
  });
});

describe("loadNumberedVeniceKeys", () => {
  it("reads VENICE_API_KEY_1 through _10 in order and skips blank entries", () => {
    const env = {
      VENICE_API_KEY_3: " key-three ",
      VENICE_API_KEY_1: "key-one",
      VENICE_API_KEY_2: "   ",
      VENICE_API_KEY_11: "ignored-beyond-limit",
    } as NodeJS.ProcessEnv;

    expect(loadNumberedVeniceKeys(env)).toEqual(["key-one", "key-three"]);
  });

  it("returns nothing when no numbered keys are set", () => {
    expect(loadNumberedVeniceKeys({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});
