import { LRUCache } from "lru-cache";

/**
 * In-memory fast revocation cache to ensure instant (< 1 second) token and session invalidation propagation.
 */
export class RevocationRegistry {
  private revokedSessions: LRUCache<string, { revokedAt: number; reason?: string }>;
  private revokedFamilies: LRUCache<string, { revokedAt: number; reason?: string }>;
  private revokedWallets: LRUCache<string, { revokedAt: number; reason?: string }>;

  constructor(maxEntries = 50_000) {
    this.revokedSessions = new LRUCache({ max: maxEntries, ttl: 86_400_000 * 30 }); // 30 days
    this.revokedFamilies = new LRUCache({ max: maxEntries, ttl: 86_400_000 * 30 });
    this.revokedWallets = new LRUCache({ max: maxEntries, ttl: 86_400_000 * 30 });
  }

  public revokeSession(sessionId: string, reason?: string): void {
    this.revokedSessions.set(sessionId, { revokedAt: Date.now(), reason });
  }

  public revokeFamily(familyId: string, reason?: string): void {
    this.revokedFamilies.set(familyId, { revokedAt: Date.now(), reason });
  }

  public revokeWallet(walletPublicKey: string, reason?: string): void {
    this.revokedWallets.set(walletPublicKey, { revokedAt: Date.now(), reason });
  }

  public isSessionRevoked(sessionId: string): boolean {
    return this.revokedSessions.has(sessionId);
  }

  public isFamilyRevoked(familyId: string): boolean {
    return this.revokedFamilies.has(familyId);
  }

  public isWalletRevoked(walletPublicKey: string, tokenIssuedAtSeconds?: number): boolean {
    const entry = this.revokedWallets.get(walletPublicKey);
    if (!entry) return false;
    if (tokenIssuedAtSeconds !== undefined) {
      // If token was issued after wallet-wide revocation, it is not revoked
      return tokenIssuedAtSeconds * 1000 <= entry.revokedAt;
    }
    return true;
  }

  public clear(): void {
    this.revokedSessions.clear();
    this.revokedFamilies.clear();
    this.revokedWallets.clear();
  }
}

export const globalRevocationRegistry = new RevocationRegistry();
