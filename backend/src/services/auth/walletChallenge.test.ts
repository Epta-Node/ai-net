/**
 * Unit tests for the shared Stellar wallet challenge flow (#653).
 *
 * The nonce store underpins the WebSocket stream handshake: nonces are
 * server-issued, single-use, and expiring, so a replayed signature is
 * rejected even when the public key is correct.
 *
 * Note: `@stellar/stellar-sdk` is mapped to a manual mock under jest, so
 * these tests only assert the mock-proof negative path of
 * `verifyWalletSignature` (invalid key material is always rejected).
 */
import { NonceStore, verifyWalletSignature } from "./walletChallenge";

describe("NonceStore", () => {
  it("issues unique nonces", () => {
    const store = new NonceStore();
    const a = store.issue();
    const b = store.issue();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(b).not.toBe(a);
  });

  it("consumes a fresh nonce exactly once (single-use)", () => {
    const store = new NonceStore();
    const nonce = store.issue();
    expect(store.consume(nonce)).toBe("valid");
  });

  it("rejects a replayed nonce", () => {
    const store = new NonceStore();
    const nonce = store.issue();
    expect(store.consume(nonce)).toBe("valid");
    expect(store.consume(nonce)).toBe("replayed");
    expect(store.consume(nonce)).toBe("replayed");
  });

  it("rejects an unknown nonce", () => {
    const store = new NonceStore();
    expect(store.consume("00000000-0000-0000-0000-000000000000")).toBe("unknown");
  });

  it("rejects an expired nonce", () => {
    // Negative TTL => already expired at issuance; no timers needed.
    const store = new NonceStore(-1);
    const nonce = store.issue();
    expect(store.consume(nonce)).toBe("expired");
  });

  it("sweep keeps live entries and drops nothing valid", () => {
    const store = new NonceStore();
    const nonce = store.issue();
    store.sweep();
    expect(store.size).toBe(1);
    expect(store.consume(nonce)).toBe("valid");
  });
});

describe("verifyWalletSignature", () => {
  it("rejects invalid key material without throwing", () => {
    expect(verifyWalletSignature("not-a-stellar-key", "nonce", "c2ln")).toBe(false);
    expect(verifyWalletSignature("", "", "")).toBe(false);
  });
});
