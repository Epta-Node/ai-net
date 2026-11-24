import { Keypair } from "@stellar/stellar-sdk";
import { randomUUID } from "crypto";

/**
 * Shared Stellar wallet challenge/verify flow (#653).
 *
 * The agents endpoints (`DELETE /api/agents/:id`) authenticate destructive
 * actions by verifying a base64 Ed25519 signature over a plaintext challenge
 * with the claimant's Stellar public key. The WebSocket task stream reuses
 * this exact flow so possession of a public key alone never proves ownership.
 *
 * Challenge lifecycle:
 *  - server-issued via {@link NonceStore.issue}
 *  - single-use: {@link NonceStore.consume} moves a nonce from pending to
 *    used, so a replayed signature is rejected
 *  - expires: nonces carry a TTL; expired nonces are rejected and swept
 */

export const WALLET_NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * Verify that `signature` (base64) is a valid Ed25519 signature of
 * `challenge` made by the holder of `walletPublicKey`.
 *
 * Mirrors the verification in `src/api/routes/agents.ts` — any change to the
 * signature encoding there must be reflected here.
 */
export function verifyWalletSignature(
  walletPublicKey: string,
  challenge: string,
  signature: string,
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(walletPublicKey);
    return keypair.verify(Buffer.from(challenge), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export type NonceConsumeOutcome = "valid" | "replayed" | "expired" | "unknown";

/**
 * Server-issued, single-use, expiring nonce store.
 *
 * `issue()` creates a nonce bound to no particular task — the caller binds it
 * to a connection/task. `consume()` validates and burns it in one step so a
 * second presentation (replay) is rejected.
 */
export class NonceStore {
  private readonly pending = new Map<string, number>();
  private readonly used = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = WALLET_NONCE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  issue(): string {
    this.sweep();
    const nonce = randomUUID();
    this.pending.set(nonce, Date.now() + this.ttlMs);
    return nonce;
  }

  consume(nonce: string): NonceConsumeOutcome {
    const now = Date.now();

    const usedExpiry = this.used.get(nonce);
    if (usedExpiry !== undefined) {
      if (usedExpiry <= now) {
        this.used.delete(nonce);
        return "expired";
      }
      return "replayed";
    }

    const expiry = this.pending.get(nonce);
    if (expiry === undefined) return "unknown";
    this.pending.delete(nonce);
    if (expiry <= now) return "expired";

    // Burn after reading: any second presentation hits the `used` branch.
    this.used.set(nonce, expiry);
    return "valid";
  }

  sweep(): void {
    const now = Date.now();
    for (const [nonce, expiry] of this.pending) {
      if (expiry <= now) this.pending.delete(nonce);
    }
    for (const [nonce, expiry] of this.used) {
      if (expiry <= now) this.used.delete(nonce);
    }
  }

  /** Test hook: number of live (unexpired) nonces. */
  get size(): number {
    return this.pending.size + this.used.size;
  }
}
