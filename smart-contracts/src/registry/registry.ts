/**
 * In-memory Agent Registry with TTL cache and Composite Capability Index.
 *
 * Provides register / discover / lookup / deregister / updatePricing helpers
 * used by all agents on startup.  The on-chain Soroban version will replace
 * this later (see Issue #1) while keeping the same public API.
 *
 * TTL cache (Issue #38)
 * ─────────────────────
 * Each entry is timestamped on registration.  Reads (discoverAgents, getAgent,
 * lookupAgent, updatePricing) prune expired entries before returning results.
 * Default TTL: 30 seconds.  Override via REGISTRY_TTL_MS environment variable.
 *
 * Composite index (Issue #256)
 * ─────────────────────────────
 * A secondary composite index is maintained alongside the primary agent store:
 *
 *   compositeIndex: Map<capability, CompositeIndexEntry[]>
 *
 * Each capability bucket is kept sorted descending by compositeScore:
 *
 *   compositeScore = reputationScore / (priceXLM + ε)   (ε = 0.0001 to avoid ÷0)
 *
 * This means the "best" agent (cheap + reputable) is always at index 0.
 * Insertions and updates maintain sorted order via binary-insertion in
 * O(log n) comparisons + O(n) splice — sub-linear for the query path itself.
 *
 * lookupAgentsComposite() applies capability + price + reputation filters on
 * the already-sorted bucket and returns the top-N results, so the query cost
 * is O(k) where k is the number of matching entries — not O(total agents).
 *
 * Multi-capability agents receive an index entry in each of their declared
 * capability buckets (partial index support).
 */

import {
  AgentRecord,
  Capability,
  CompositeIndex,
  CompositeIndexEntry,
  CompositeQueryFilter,
  CompositeQueryResult,
} from '../types/types';

// ---------------------------------------------------------------------------
// TTL configuration
// ---------------------------------------------------------------------------

const TTL_MS: number =
  process.env['REGISTRY_TTL_MS'] !== undefined
    ? parseInt(process.env['REGISTRY_TTL_MS'], 10)
    : 30_000;

// ---------------------------------------------------------------------------
// Small epsilon to avoid division-by-zero for free/zero-price agents
// ---------------------------------------------------------------------------
const EPSILON = 0.0001;

// ---------------------------------------------------------------------------
// Internal state  (isolated per test via clearRegistry() / clearCache())
// ---------------------------------------------------------------------------

interface StoreEntry {
  agent: AgentRecord;
  registeredAt: number;
}

/** Primary store: agentId → StoreEntry */
const store = new Map<string, StoreEntry>();

/** Composite index: capability → sorted CompositeIndexEntry[] (desc by compositeScore) */
const compositeIndex: CompositeIndex = new Map();

// ---------------------------------------------------------------------------
// TTL helpers
// ---------------------------------------------------------------------------

function isExpired(entry: StoreEntry): boolean {
  return Date.now() - entry.registeredAt > TTL_MS;
}

/**
 * Remove all expired entries from the primary store and composite index.
 * Called lazily before any read operation.
 */
function pruneExpired(): void {
  for (const [id, entry] of store) {
    if (isExpired(entry)) {
      unindexAgent(id);
      store.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Composite score helper
// ---------------------------------------------------------------------------

/**
 * Compute the composite score for an agent.
 * Higher = cheaper and/or more reputable = preferred.
 */
function computeScore(priceXLM: number, reputationScore: number): number {
  return reputationScore / (priceXLM + EPSILON);
}

// ---------------------------------------------------------------------------
// Composite index maintenance helpers
// ---------------------------------------------------------------------------

/** Build a CompositeIndexEntry from an AgentRecord. */
function buildEntry(agent: AgentRecord): CompositeIndexEntry {
  const rep = agent.reputationScore ?? 1;
  const compositeScore = computeScore(agent.priceXLM, rep);
  return {
    agentId: agent.id,
    priceXLM: agent.priceXLM,
    reputationScore: rep,
    compositeScore,
  };
}

/**
 * Insert an entry into a sorted bucket using binary search, maintaining
 * descending order by compositeScore.  O(log n) comparisons, O(n) insert.
 */
function insertSorted(
  bucket: CompositeIndexEntry[],
  entry: CompositeIndexEntry,
): void {
  let lo = 0;
  let hi = bucket.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bucket[mid].compositeScore > entry.compositeScore) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  bucket.splice(lo, 0, entry);
}

/**
 * Add an agent to all relevant capability buckets in the composite index.
 * Covers the agent's primary capability and any extraCapabilities (partial
 * index support for multi-capability agents).
 */
function indexAgent(agent: AgentRecord): void {
  const entry = buildEntry(agent);
  const caps: Capability[] = [agent.capability, ...(agent.extraCapabilities ?? [])];
  const seen = new Set<string>();
  for (const cap of caps) {
    if (seen.has(cap)) continue;
    seen.add(cap);
    if (!compositeIndex.has(cap)) {
      compositeIndex.set(cap, []);
    }
    insertSorted(compositeIndex.get(cap)!, entry);
  }
}

/**
 * Remove an agent from all composite index buckets it appears in.
 */
function unindexAgent(agentId: string): void {
  for (const bucket of compositeIndex.values()) {
    const idx = bucket.findIndex((e) => e.agentId === agentId);
    if (idx !== -1) {
      bucket.splice(idx, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — basic registry
// ---------------------------------------------------------------------------

/**
 * Register an agent in the registry.
 * Overwrites any existing record with the same id and refreshes the index.
 * Agents without an explicit reputationScore default to 1.0 (perfect trust for
 * new registrations — the coordinator can lower this over time).
 * Returns the stored AgentRecord for convenience.
 */
export function registerAgent(agent: AgentRecord): AgentRecord {
  const normalized: AgentRecord = {
    ...agent,
    reputationScore: agent.reputationScore ?? 1,
  };
  // If re-registering, remove old index entries first
  if (store.has(normalized.id)) {
    unindexAgent(normalized.id);
  }
  store.set(normalized.id, { agent: normalized, registeredAt: Date.now() });
  indexAgent(normalized);
  return normalized;
}

/**
 * Discover all agents that match a given capability (linear scan of primary store).
 * Prunes expired entries before scanning.
 * Returns an empty array when none are found.
 *
 * For filtered / sorted queries prefer lookupAgentsComposite().
 */
export function discoverAgents(capability: Capability | string): AgentRecord[] {
  pruneExpired();
  const results: AgentRecord[] = [];
  for (const { agent } of store.values()) {
    if (
      agent.capability === capability ||
      agent.extraCapabilities?.includes(capability)
    ) {
      results.push(agent);
    }
  }
  return results;
}

/**
 * Retrieve a single agent by its unique id.
 * Prunes expired entries and returns undefined when the agent is not found
 * or has expired.
 */
export function getAgent(id: string): AgentRecord | undefined {
  pruneExpired();
  return store.get(id)?.agent;
}

/**
 * Alias for getAgent — satisfies the lookupAgent export requirement.
 */
export function lookupAgent(id: string): AgentRecord | undefined {
  return getAgent(id);
}

/**
 * Remove an agent from the registry and all composite index buckets.
 * Returns true if the agent existed and was removed.
 */
export function deregisterAgent(id: string): boolean {
  if (!store.has(id)) return false;
  unindexAgent(id);
  return store.delete(id);
}

/**
 * Update an agent's priceXLM.  Refreshes the composite index.
 * Returns the updated AgentRecord, or undefined if the agent is not found.
 */
export function updatePricing(id: string, priceXLM: number): AgentRecord | undefined {
  pruneExpired();
  const entry = store.get(id);
  if (!entry) return undefined;
  unindexAgent(id);
  const updated: AgentRecord = { ...entry.agent, priceXLM };
  store.set(id, { agent: updated, registeredAt: entry.registeredAt });
  indexAgent(updated);
  return updated;
}

/**
 * Update an agent's reputation score and refresh the composite index.
 * Throws RangeError if newReputation is outside [0, 1].
 */
export function updateAgentReputation(id: string, newReputation: number): boolean {
  if (newReputation < 0 || newReputation > 1) {
    throw new RangeError(
      `reputationScore must be in [0, 1], got ${newReputation}`,
    );
  }
  pruneExpired();
  const entry = store.get(id);
  if (!entry) return false;
  unindexAgent(id);
  const updated: AgentRecord = { ...entry.agent, reputationScore: newReputation };
  store.set(id, { agent: updated, registeredAt: entry.registeredAt });
  indexAgent(updated);
  return true;
}

/**
 * Clear all agents and indexes.
 * Exposed for test isolation — do NOT call in production code.
 */
export function clearRegistry(): void {
  store.clear();
  compositeIndex.clear();
}

/**
 * Return all currently live (non-expired) agents as an array.
 * Prunes expired entries before returning.
 * Useful for migration scripts and admin tooling — prefer discoverAgents()
 * or lookupAgentsComposite() for capability-filtered queries.
 */
export function listAgents(): AgentRecord[] {
  pruneExpired();
  return Array.from(store.values()).map((e) => e.agent);
}

/**
 * Alias for clearRegistry — satisfies the clearCache export requirement.
 */
export const clearCache = clearRegistry;

/**
 * Alias for updatePricing — exported for backwards compatibility with tests
 * and consumers that reference the composite-index-era name.
 */
export function updateAgentPricing(id: string, priceXLM: number): boolean {
  const result = updatePricing(id, priceXLM);
  return result !== undefined;
}


// ---------------------------------------------------------------------------
// Public API — composite index query  (issue #256)
// ---------------------------------------------------------------------------

/**
 * Look up agents using the composite capability index.
 *
 * Filters applied in order (all O(k) on the sorted bucket):
 *   1. capability match        — selects the right index bucket
 *   2. maxPrice filter         — skip agents that are too expensive
 *   3. minReputation filter    — skip agents below the reputation threshold
 *   4. limit                   — return at most `limit` results (default 100)
 *
 * Results are returned sorted descending by compositeScore
 * (compositeScore = reputationScore / (priceXLM + ε)).
 *
 * Gas-equivalent cost: O(k) where k ≤ bucket size — not O(total agents).
 */
export function lookupAgentsComposite(
  filter: CompositeQueryFilter,
): CompositeQueryResult[] {
  pruneExpired();
  const { capability, maxPrice, minReputation, limit = 100 } = filter;

  const bucket = compositeIndex.get(capability);
  if (!bucket || bucket.length === 0) return [];

  const results: CompositeQueryResult[] = [];

  for (const entry of bucket) {
    if (results.length >= limit) break;

    // Price filter
    if (maxPrice !== undefined && entry.priceXLM > maxPrice) continue;

    // Reputation filter
    if (minReputation !== undefined && entry.reputationScore < minReputation) continue;

    // Hydrate with full AgentRecord (O(1) map lookup)
    const storeEntry = store.get(entry.agentId);
    if (!storeEntry) continue; // defensive — expired or missing

    results.push({ agent: storeEntry.agent, compositeScore: entry.compositeScore });
  }

  return results;
}

/**
 * Expose the composite index for benchmark / introspection purposes.
 * Returns a read-only snapshot — mutating the returned map has no effect
 * on the live index.
 */
export function getCompositeIndex(): ReadonlyMap<
  Capability,
  readonly CompositeIndexEntry[]
> {
  return compositeIndex as ReadonlyMap<Capability, readonly CompositeIndexEntry[]>;
}
