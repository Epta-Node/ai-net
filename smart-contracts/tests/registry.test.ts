import {
  clearCache,
  clearRegistry,
  deregisterAgent,
  discoverAgents,
  getAgent,
  lookupAgent,
  registerAgent,
  updatePricing,
} from '../src/registry/registry';
import { AgentRecord } from '../src/types/types';

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makeAgent(
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    capability: 'research',
    priceXLM: 1,
    reputationScore: 1,
    stellarAddress: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Agent Registry', () => {
  beforeEach(() => {
    clearRegistry();
  });

  // ── registerAgent ─────────────────────────────────────────────────────────

  describe('registerAgent', () => {
    it('registers an agent and makes it discoverable', () => {
      registerAgent(makeAgent({ id: 'r1' }));
      expect(discoverAgents('research').some((a) => a.id === 'r1')).toBe(true);
    });

    it('overwrites an existing agent on re-registration', () => {
      registerAgent(makeAgent({ id: 'dup', name: 'Original', priceXLM: 5 }));
      registerAgent(makeAgent({ id: 'dup', name: 'Updated', priceXLM: 3 }));
      expect(getAgent('dup')?.name).toBe('Updated');
      expect(getAgent('dup')?.priceXLM).toBe(3);
    });

    it('defaults reputationScore to 1 when not provided', () => {
      registerAgent(makeAgent({ id: 'norep', reputationScore: undefined as unknown as number }));
      expect(getAgent('norep')?.reputationScore).toBe(1);
    });

    it('returns the stored AgentRecord', () => {
      const result = registerAgent(makeAgent({ id: 'ret1' }));
      expect(result.id).toBe('ret1');
      expect(result.reputationScore).toBe(1);
    });
  });

  // ── discoverAgents ────────────────────────────────────────────────────────

  describe('discoverAgents', () => {
    it('returns an empty array for an unknown capability', () => {
      expect(discoverAgents('nonexistent-capability-xyz')).toEqual([]);
    });

    it('returns all agents matching a capability', () => {
      registerAgent(makeAgent({ id: 'r1' }));
      registerAgent(makeAgent({ id: 'r2' }));
      registerAgent(makeAgent({ id: 'k1', capability: 'risk' }));
      expect(discoverAgents('research')).toHaveLength(2);
    });

    it('respects 30 s TTL — expired entries are not returned', () => {
      registerAgent(makeAgent());
      const realNow = Date.now;
      global.Date.now = jest.fn(() => realNow() + 31_000);
      try {
        expect(discoverAgents('research')).toEqual([]);
      } finally {
        global.Date.now = realNow;
      }
    });
  });

  // ── getAgent ──────────────────────────────────────────────────────────────

  describe('getAgent', () => {
    it('retrieves an agent by id', () => {
      registerAgent(makeAgent({ id: 'g1', name: 'Getter', capability: 'risk', priceXLM: 2 }));
      expect(getAgent('g1')?.name).toBe('Getter');
    });

    it('returns undefined for an unknown id', () => {
      expect(getAgent('unknown-id')).toBeUndefined();
    });

    it('returns undefined after the TTL expires', () => {
      registerAgent(makeAgent());
      const realNow = Date.now;
      global.Date.now = jest.fn(() => realNow() + 31_000);
      try {
        expect(getAgent('agent-1')).toBeUndefined();
      } finally {
        global.Date.now = realNow;
      }
    });
  });

  // ── lookupAgent ───────────────────────────────────────────────────────────

  describe('lookupAgent', () => {
    it('is an alias for getAgent and returns the same result', () => {
      registerAgent(makeAgent({ id: 'lu1', capability: 'risk', priceXLM: 2 }));
      expect(lookupAgent('lu1')?.id).toBe('lu1');
      expect(lookupAgent('lu1')).toEqual(getAgent('lu1'));
    });

    it('returns undefined for an unknown id', () => {
      expect(lookupAgent('no-such-agent')).toBeUndefined();
    });
  });

  // ── deregisterAgent ───────────────────────────────────────────────────────

  describe('deregisterAgent', () => {
    it('removes an existing agent and returns true', () => {
      registerAgent(makeAgent({ id: 'd1', capability: 'coding', priceXLM: 3 }));
      expect(deregisterAgent('d1')).toBe(true);
      expect(getAgent('d1')).toBeUndefined();
    });

    it('returns false when the agent does not exist', () => {
      expect(deregisterAgent('ghost')).toBe(false);
    });

    it('removed agent no longer appears in discoverAgents results', () => {
      registerAgent(makeAgent({ id: 'd2' }));
      deregisterAgent('d2');
      expect(discoverAgents('research').some((a) => a.id === 'd2')).toBe(false);
    });
  });

  // ── updatePricing ─────────────────────────────────────────────────────────

  describe('updatePricing', () => {
    it('updates the price and preserves all other fields', () => {
      registerAgent(makeAgent({ id: 'p1', name: 'Pricer', capability: 'risk', priceXLM: 2, stellarAddress: 'addr' }));
      const updated = updatePricing('p1', 5);
      expect(updated?.priceXLM).toBe(5);
      expect(updated?.name).toBe('Pricer');
      expect(updated?.capability).toBe('risk');
      expect(getAgent('p1')?.priceXLM).toBe(5);
    });

    it('returns undefined when the agent does not exist', () => {
      expect(updatePricing('no-agent', 10)).toBeUndefined();
    });
  });

  // ── clearRegistry / clearCache ────────────────────────────────────────────

  describe('clearRegistry and clearCache', () => {
    it('clearRegistry removes all agents', () => {
      registerAgent(makeAgent({ id: 'c1', capability: 'report', priceXLM: 3 }));
      clearRegistry();
      expect(discoverAgents('report')).toEqual([]);
    });

    it('clearCache is the same function reference as clearRegistry', () => {
      expect(clearCache).toBe(clearRegistry);
    });

    it('clearCache removes all agents', () => {
      registerAgent(makeAgent({ id: 'c2', capability: 'report', priceXLM: 3 }));
      clearCache();
      expect(discoverAgents('report')).toEqual([]);
    });
  });
});
