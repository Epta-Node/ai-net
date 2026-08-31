/**
 * Tests for the Composite Capability Index  (issue #256)
 *
 * Covers:
 *  - Composite index structure: capability → (price, reputation, agentId)
 *  - lookupAgentsComposite with capability / maxPrice / minReputation filters
 *  - Results sorted descending by composite score
 *  - Index automatically updated on registerAgent / updateAgentPricing /
 *    updateAgentReputation / deregisterAgent
 *  - Partial index support for multi-capability agents (extraCapabilities)
 *  - Edge cases: empty registry, no matches, limit enforcement, zero price,
 *    invalid reputation range
 *  - Benchmark: composite index vs linear discoverAgents (ratio assertion)
 */

import {
  clearRegistry,
  deregisterAgent,
  discoverAgents,
  getCompositeIndex,
  lookupAgentsComposite,
  registerAgent,
  updateAgentPricing,
  updateAgentReputation,
} from '../src/registry/registry';
import { AgentRecord } from '../src/types/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(
  id: string,
  capability: string,
  priceXLM: number,
  reputationScore: number,
  extras?: string[],
): AgentRecord {
  return {
    id,
    name: `Agent-${id}`,
    capability,
    priceXLM,
    reputationScore,
    stellarAddress: `G${id.toUpperCase().padEnd(55, '0')}`,
    extraCapabilities: extras,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearRegistry();
});

// ---------------------------------------------------------------------------
// 1. Composite index structure
// ---------------------------------------------------------------------------

describe('Composite index structure', () => {
  it('populates an index bucket when an agent is registered', () => {
    registerAgent(makeAgent('a1', 'research', 2, 0.9));
    const idx = getCompositeIndex();
    const bucket = idx.get('research');
    expect(bucket).toBeDefined();
    expect(bucket!.length).toBe(1);
    expect(bucket![0].agentId).toBe('a1');
    expect(bucket![0].priceXLM).toBe(2);
    expect(bucket![0].reputationScore).toBe(0.9);
    expect(bucket![0].compositeScore).toBeGreaterThan(0);
  });

  it('stores compositeScore = reputationScore / (priceXLM + ε)', () => {
    const price = 4;
    const rep = 0.8;
    registerAgent(makeAgent('a2', 'risk', price, rep));
    const idx = getCompositeIndex();
    const entry = idx.get('risk')![0];
    const expected = rep / (price + 0.0001);
    expect(entry.compositeScore).toBeCloseTo(expected, 8);
  });

  it('bucket is sorted descending by compositeScore', () => {
    // cheap+good > cheap+bad > expensive+good
    registerAgent(makeAgent('a1', 'research', 5, 0.5));   // score ≈ 0.0999
    registerAgent(makeAgent('a2', 'research', 1, 0.9));   // score ≈ 0.8999  ← best
    registerAgent(makeAgent('a3', 'research', 1, 0.4));   // score ≈ 0.3999
    const bucket = getCompositeIndex().get('research')!;
    expect(bucket[0].agentId).toBe('a2');
    expect(bucket[1].agentId).toBe('a3');
    expect(bucket[2].agentId).toBe('a1');
    // Verify strictly descending
    for (let i = 0; i < bucket.length - 1; i++) {
      expect(bucket[i].compositeScore).toBeGreaterThanOrEqual(bucket[i + 1].compositeScore);
    }
  });

  it('handles zero-price agent without division-by-zero', () => {
    registerAgent(makeAgent('a0', 'coding', 0, 1.0));
    const bucket = getCompositeIndex().get('coding')!;
    expect(bucket[0].compositeScore).toBeCloseTo(1 / 0.0001, 2);
    expect(isFinite(bucket[0].compositeScore)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. lookupAgentsComposite — basic filtering
// ---------------------------------------------------------------------------

describe('lookupAgentsComposite — filtering', () => {
  beforeEach(() => {
    registerAgent(makeAgent('r1', 'research', 1, 0.9));
    registerAgent(makeAgent('r2', 'research', 3, 0.7));
    registerAgent(makeAgent('r3', 'research', 5, 0.95));
    registerAgent(makeAgent('r4', 'research', 2, 0.5));
  });

  it('returns all matching agents when no price/reputation filter applied', () => {
    const results = lookupAgentsComposite({ capability: 'research' });
    expect(results).toHaveLength(4);
  });

  it('filters by maxPrice', () => {
    const results = lookupAgentsComposite({ capability: 'research', maxPrice: 2 });
    const ids = results.map((r) => r.agent.id);
    expect(ids).toContain('r1');
    expect(ids).toContain('r4');
    expect(ids).not.toContain('r2');
    expect(ids).not.toContain('r3');
  });

  it('filters by minReputation', () => {
    const results = lookupAgentsComposite({ capability: 'research', minReputation: 0.8 });
    const ids = results.map((r) => r.agent.id);
    expect(ids).toContain('r1');
    expect(ids).toContain('r3');
    expect(ids).not.toContain('r2');
    expect(ids).not.toContain('r4');
  });

  it('filters by both maxPrice and minReputation together', () => {
    // Only r1 (price=1, rep=0.9) satisfies price≤2 AND rep≥0.8
    const results = lookupAgentsComposite({
      capability: 'research',
      maxPrice: 2,
      minReputation: 0.8,
    });
    expect(results).toHaveLength(1);
    expect(results[0].agent.id).toBe('r1');
  });

  it('returns empty array for unknown capability', () => {
    const results = lookupAgentsComposite({ capability: 'nonexistent' });
    expect(results).toHaveLength(0);
  });

  it('returns empty array when no agents match filters', () => {
    const results = lookupAgentsComposite({
      capability: 'research',
      maxPrice: 0.5,
    });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. lookupAgentsComposite — sort order
// ---------------------------------------------------------------------------

describe('lookupAgentsComposite — sort order', () => {
  it('returns results sorted descending by compositeScore', () => {
    registerAgent(makeAgent('s1', 'risk', 10, 0.6));
    registerAgent(makeAgent('s2', 'risk', 1, 0.95));
    registerAgent(makeAgent('s3', 'risk', 2, 0.8));
    const results = lookupAgentsComposite({ capability: 'risk' });
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].compositeScore).toBeGreaterThanOrEqual(
        results[i + 1].compositeScore,
      );
    }
    // Best agent is s2 (cheap + highest reputation)
    expect(results[0].agent.id).toBe('s2');
  });
});

// ---------------------------------------------------------------------------
// 4. limit enforcement
// ---------------------------------------------------------------------------

describe('lookupAgentsComposite — limit', () => {
  it('respects the limit parameter', () => {
    for (let i = 0; i < 20; i++) {
      registerAgent(makeAgent(`lim${i}`, 'coding', i + 1, 0.8));
    }
    const results = lookupAgentsComposite({ capability: 'coding', limit: 5 });
    expect(results).toHaveLength(5);
  });

  it('defaults to limit 100 and returns all when fewer agents exist', () => {
    for (let i = 0; i < 10; i++) {
      registerAgent(makeAgent(`def${i}`, 'design', i + 1, 0.7));
    }
    const results = lookupAgentsComposite({ capability: 'design' });
    expect(results).toHaveLength(10);
  });

  it('returns top-N by compositeScore when limit is smaller than bucket', () => {
    registerAgent(makeAgent('top1', 'report', 1, 0.99));  // best
    registerAgent(makeAgent('top2', 'report', 1, 0.8));
    registerAgent(makeAgent('top3', 'report', 1, 0.5));
    const results = lookupAgentsComposite({ capability: 'report', limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].agent.id).toBe('top1');
  });
});

// ---------------------------------------------------------------------------
// 5. Index updates on mutation operations
// ---------------------------------------------------------------------------

describe('Index automatically updated on mutations', () => {
  it('removes agent from index on deregisterAgent', () => {
    registerAgent(makeAgent('d1', 'research', 2, 0.9));
    deregisterAgent('d1');
    const results = lookupAgentsComposite({ capability: 'research' });
    expect(results.map((r) => r.agent.id)).not.toContain('d1');
  });

  it('refreshes index on updateAgentPricing — reorders bucket', () => {
    registerAgent(makeAgent('p1', 'research', 1, 0.8));   // high score
    registerAgent(makeAgent('p2', 'research', 5, 0.8));   // low score
    // Before update: p1 should be first
    let results = lookupAgentsComposite({ capability: 'research' });
    expect(results[0].agent.id).toBe('p1');

    // After making p1 very expensive it should drop behind p2
    updateAgentPricing('p1', 100);
    results = lookupAgentsComposite({ capability: 'research' });
    expect(results[0].agent.id).toBe('p2');
  });

  it('refreshes index on updateAgentReputation — reorders bucket', () => {
    registerAgent(makeAgent('rep1', 'risk', 2, 0.5));
    registerAgent(makeAgent('rep2', 'risk', 2, 0.9));
    // rep2 first
    let results = lookupAgentsComposite({ capability: 'risk' });
    expect(results[0].agent.id).toBe('rep2');

    // Boost rep1 above rep2
    updateAgentReputation('rep1', 0.99);
    results = lookupAgentsComposite({ capability: 'risk' });
    expect(results[0].agent.id).toBe('rep1');
  });

  it('re-registers agent — updates index correctly', () => {
    registerAgent(makeAgent('upd1', 'coding', 5, 0.5));
    // Re-register with better pricing
    registerAgent(makeAgent('upd1', 'coding', 1, 0.5));
    const bucket = getCompositeIndex().get('coding')!;
    const entries = bucket.filter((e) => e.agentId === 'upd1');
    // Must appear exactly once — no duplicates
    expect(entries).toHaveLength(1);
    expect(entries[0].priceXLM).toBe(1);
  });

  it('throws RangeError for reputation outside [0, 1]', () => {
    registerAgent(makeAgent('err1', 'research', 2, 0.5));
    expect(() => updateAgentReputation('err1', 1.5)).toThrow(RangeError);
    expect(() => updateAgentReputation('err1', -0.1)).toThrow(RangeError);
  });

  it('returns false from updateAgentPricing for unknown agent', () => {
    expect(updateAgentPricing('ghost', 5)).toBe(false);
  });

  it('returns false from updateAgentReputation for unknown agent', () => {
    expect(updateAgentReputation('ghost', 0.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Partial index — multi-capability agents
// ---------------------------------------------------------------------------

describe('Partial index — multi-capability agents', () => {
  it('indexes agent in primary capability bucket', () => {
    registerAgent(makeAgent('mc1', 'research', 2, 0.8, ['risk']));
    const results = lookupAgentsComposite({ capability: 'research' });
    expect(results.map((r) => r.agent.id)).toContain('mc1');
  });

  it('indexes agent in extraCapabilities buckets', () => {
    registerAgent(makeAgent('mc1', 'research', 2, 0.8, ['risk', 'coding']));
    const riskResults = lookupAgentsComposite({ capability: 'risk' });
    const codingResults = lookupAgentsComposite({ capability: 'coding' });
    expect(riskResults.map((r) => r.agent.id)).toContain('mc1');
    expect(codingResults.map((r) => r.agent.id)).toContain('mc1');
  });

  it('does not duplicate agent within the same bucket when capability repeated', () => {
    // Capability appears in both primary and extraCapabilities — should still be indexed once
    registerAgent(makeAgent('mc2', 'research', 2, 0.8, ['research']));
    const bucket = getCompositeIndex().get('research')!;
    const entries = bucket.filter((e) => e.agentId === 'mc2');
    expect(entries).toHaveLength(1);
  });

  it('removes agent from all buckets on deregister', () => {
    registerAgent(makeAgent('mc3', 'research', 2, 0.8, ['risk', 'coding']));
    deregisterAgent('mc3');
    expect(lookupAgentsComposite({ capability: 'research' }).map((r) => r.agent.id)).not.toContain('mc3');
    expect(lookupAgentsComposite({ capability: 'risk' }).map((r) => r.agent.id)).not.toContain('mc3');
    expect(lookupAgentsComposite({ capability: 'coding' }).map((r) => r.agent.id)).not.toContain('mc3');
  });
});

// ---------------------------------------------------------------------------
// 7. clearRegistry resets everything
// ---------------------------------------------------------------------------

describe('clearRegistry', () => {
  it('clears the composite index along with the agent store', () => {
    registerAgent(makeAgent('c1', 'research', 1, 0.9));
    clearRegistry();
    const results = lookupAgentsComposite({ capability: 'research' });
    expect(results).toHaveLength(0);
    expect(getCompositeIndex().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Benchmark — composite index vs linear scan
// ---------------------------------------------------------------------------

describe('Benchmark — composite index vs linear discoverAgents', () => {
  /**
   * Populate a registry with TOTAL_AGENTS agents spread across capabilities.
   * Then compare the time for 100 composite queries (returning ≤ QUERY_LIMIT
   * agents) against 100 linear discoverAgents() calls on the same capability.
   *
   * We assert that the composite index is at least SPEEDUP_FACTOR× faster.
   * With 1 000 agents and a query limit of 10, the composite path touches
   * only ~10 entries while the linear scan touches all 1 000 — the ratio
   * in practice is >>10× even under V8 JIT warmup effects.
   */
  const TOTAL_AGENTS = 1_000;
  const TARGET_CAPABILITY = 'research';
  const AGENTS_IN_TARGET = 200; // 200 out of 1 000 are 'research'
  const QUERY_LIMIT = 10;
  const ITERATIONS = 100;
  const SPEEDUP_FACTOR = 3; // conservative lower-bound

  beforeAll(() => {
    clearRegistry();
    // Register AGENTS_IN_TARGET research agents
    for (let i = 0; i < AGENTS_IN_TARGET; i++) {
      registerAgent(
        makeAgent(
          `bm-r${i}`,
          TARGET_CAPABILITY,
          Math.random() * 10 + 0.1,
          Math.random(),
        ),
      );
    }
    // Fill the rest with other capabilities
    const caps = ['risk', 'coding', 'design', 'report'];
    for (let i = 0; i < TOTAL_AGENTS - AGENTS_IN_TARGET; i++) {
      registerAgent(
        makeAgent(
          `bm-o${i}`,
          caps[i % caps.length],
          Math.random() * 10 + 0.1,
          Math.random(),
        ),
      );
    }
  });

  afterAll(() => {
    clearRegistry();
  });

  it(`composite index is ≥${SPEEDUP_FACTOR}× faster than linear scan (${TOTAL_AGENTS} agents, limit=${QUERY_LIMIT})`, () => {
    // --- Linear scan baseline ---
    const linearStart = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const all = discoverAgents(TARGET_CAPABILITY);
      // Simulate same limit by slicing
      all.slice(0, QUERY_LIMIT);
    }
    const linearMs = performance.now() - linearStart;

    // --- Composite index ---
    const indexStart = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      lookupAgentsComposite({
        capability: TARGET_CAPABILITY,
        limit: QUERY_LIMIT,
      });
    }
    const indexMs = performance.now() - indexStart;

    console.log(
      `[Benchmark] linear=${linearMs.toFixed(2)}ms  indexed=${indexMs.toFixed(2)}ms  ` +
        `ratio=${(linearMs / indexMs).toFixed(2)}×  (${ITERATIONS} iterations, ${TOTAL_AGENTS} agents)`,
    );

    // The composite index must be meaningfully faster than the linear scan
    expect(linearMs / indexMs).toBeGreaterThanOrEqual(SPEEDUP_FACTOR);
  });

  it('composite query returns ≤ limit results in all scenarios', () => {
    const results = lookupAgentsComposite({
      capability: TARGET_CAPABILITY,
      limit: QUERY_LIMIT,
    });
    expect(results.length).toBeLessThanOrEqual(QUERY_LIMIT);
  });

  it('composite query results are sorted by compositeScore', () => {
    const results = lookupAgentsComposite({
      capability: TARGET_CAPABILITY,
      limit: 50,
    });
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].compositeScore).toBeGreaterThanOrEqual(
        results[i + 1].compositeScore,
      );
    }
  });
});
