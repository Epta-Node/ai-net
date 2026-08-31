import {
  clearRegistry,
  deregisterAgent,
  discoverAgents,
  getAgent,
  registerAgent,
} from '../src/registry/registry';
import { registerAgent, discoverAgents, getAgent, lookupAgent, deregisterAgent, updatePricing, clearRegistry, clearCache } from '../src/registry/registry';

function makeAgent(overrides: Partial<{ id: string; name: string; capability: string; priceXLM: number; stellarAddress: string }> = {}) {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    capability: 'research',
    priceXLM: 1,
    stellarAddress: '',
    ...overrides,
  };
}

describe('Agent Registry — basic operations', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('registers and discovers an agent by capability', () => {
    registerAgent({
      id: 't1',
      name: 'Test',
      capability: 'research',
      priceXLM: 1,
      reputationScore: 1,
      stellarAddress: '',
    });
    const results = discoverAgents('research');
    expect(results.some((a) => a.id === 't1')).toBe(true);
  // ── discoverAgents ────────────────────────────────────────────────────────

  describe('discoverAgents', () => {
    it('returns empty array for unknown capability', () => {
      expect(discoverAgents('nonexistent-capability-xyz')).toEqual([]);
    });

    it('returns all agents matching a capability', async () => {
      await registerAgent(makeAgent({ id: 'r1' }));
      await registerAgent(makeAgent({ id: 'r2' }));
      await registerAgent(makeAgent({ id: 'k1', capability: 'risk' }));

      expect(discoverAgents('research')).toHaveLength(2);
    });

    it('respects 30s TTL — expired entries are not returned', async () => {
      await registerAgent(makeAgent());
      // Manually expire by manipulating Date.now
      const realNow = Date.now;
      global.Date.now = jest.fn(() => realNow() + 31_000);
      expect(discoverAgents('research')).toEqual([]);
      global.Date.now = realNow;
    });
  });

  // ── getAgent ──────────────────────────────────────────────────────────────

  describe('getAgent', () => {
    it('retrieves an agent by id', async () => {
      await registerAgent({ id: 't2', name: 'Test2', capability: 'risk', priceXLM: 2, stellarAddress: '' });
      expect(getAgent('t2')?.name).toBe('Test2');
    });

    it('returns undefined for unknown id', () => {
      expect(getAgent('unknown-id')).toBeUndefined();
    });

    it('returns undefined after cache expires', async () => {
      await registerAgent(makeAgent());
      const realNow = Date.now;
      global.Date.now = jest.fn(() => realNow() + 31_000);
      expect(getAgent('agent-1')).toBeUndefined();
      global.Date.now = realNow;
    });
  });

  it('retrieves an agent by id', () => {
    registerAgent({
      id: 't2',
      name: 'Test2',
      capability: 'risk',
      priceXLM: 2,
      reputationScore: 0.8,
      stellarAddress: '',
    });
  it('retrieves an agent by id and lookupAgent alias works', () => {
    registerAgent({ id: 't2', name: 'Test2', capability: 'risk', priceXLM: 2, stellarAddress: '' });
    expect(getAgent('t2')?.name).toBe('Test2');
    expect(lookupAgent('t2')?.id).toBe('t2');
  });

  it('updates pricing and preserves other fields', () => {
    registerAgent({ id: 't3', name: 'Test3', capability: 'risk', priceXLM: 2, stellarAddress: '' });
    const updated = updatePricing('t3', 5);
    expect(updated).toEqual({ id: 't3', name: 'Test3', capability: 'risk', priceXLM: 5, stellarAddress: '' });
    expect(getAgent('t3')?.priceXLM).toBe(5);
  });

  it('deregisters an agent and clears cache alias works', () => {
    registerAgent({ id: 't4', name: 'Test4', capability: 'report', priceXLM: 3, stellarAddress: '' });
    expect(deregisterAgent('t4')).toBe(true);
    expect(getAgent('t4')).toBeUndefined();
    registerAgent({ id: 't5', name: 'Test5', capability: 'report', priceXLM: 3, stellarAddress: '' });
    expect(clearCache).toBe(clearRegistry);
    clearCache();
    expect(discoverAgents('report')).toEqual([]);
  });

  it('deregisters an agent', () => {
    registerAgent({
      id: 't3',
      name: 'Test3',
      capability: 'coding',
      priceXLM: 3,
      reputationScore: 0.7,
      stellarAddress: '',
    });
    expect(deregisterAgent('t3')).toBe(true);
    expect(getAgent('t3')).toBeUndefined();
  });

  it('returns false when deregistering a non-existent agent', () => {
    expect(deregisterAgent('ghost')).toBe(false);
  });

  it('overwrites existing agent on re-register', () => {
    registerAgent({
      id: 't4',
      name: 'Original',
      capability: 'design',
      priceXLM: 5,
      reputationScore: 0.5,
      stellarAddress: '',
    });
    registerAgent({
      id: 't4',
      name: 'Updated',
      capability: 'design',
      priceXLM: 3,
      reputationScore: 0.9,
      stellarAddress: '',
    });
    expect(getAgent('t4')?.name).toBe('Updated');
    expect(getAgent('t4')?.priceXLM).toBe(3);
  });

  it('defaults reputationScore to 1 when not provided', () => {
    registerAgent({
      id: 't5',
      name: 'NoRep',
      capability: 'report',
      priceXLM: 1,
      reputationScore: undefined as unknown as number,
      stellarAddress: '',
    });
    expect(getAgent('t5')?.reputationScore).toBe(1);
  });
});
