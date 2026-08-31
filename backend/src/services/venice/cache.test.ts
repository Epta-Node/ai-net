import { VeniceResponseCache, similarity } from './cache';
import { RequestDeduplicator } from './dedup';

describe('VeniceResponseCache', () => {
  it('returns a previously stored response (exact match)', () => {
    const cache = new VeniceResponseCache();
    expect(cache.get('Hello world', 'research', 'v1')).toBeNull();
    cache.set('Hello world', 'research', 'v1', 'cached-content');
    expect(cache.get('Hello world', 'research', 'v1')).toBe('cached-content');
  });

  it('matches near-duplicate prompts via similarity', () => {
    const cache = new VeniceResponseCache({ similarityThreshold: 0.8 });
    cache.set('Summarize the quarterly report for Q3', 'research', 'v1', 'summary');
    // minor edit / whitespace difference
    expect(cache.get('summarize  the  quarterly  report  for  Q3', 'research', 'v1')).toBe(
      'summary',
    );
  });

  it('does not match dissimilar prompts', () => {
    const cache = new VeniceResponseCache({ similarityThreshold: 0.8 });
    cache.set('Write a poem about the ocean', 'research', 'v1', 'poem');
    expect(cache.get('Calculate the fibonacci sequence', 'research', 'v1')).toBeNull();
  });

  it('expires entries after the TTL', () => {
    const cache = new VeniceResponseCache({ defaultTtlMs: 0 });
    cache.set('expire me', 'research', 'v1', 'x');
    expect(cache.get('expire me', 'research', 'v1')).toBeNull();
  });

  it('uses a shorter TTL for the coding agent', () => {
    const cache = new VeniceResponseCache({ defaultTtlMs: 10_000, codingTtlMs: 0 });
    cache.set('refactor this function', 'coding', 'v1', 'refactored');
    // coding TTL is 0 -> immediately expired
    expect(cache.get('refactor this function', 'coding', 'v1')).toBeNull();
    // research agent with the long TTL still returns the entry
    cache.set('refactor this function', 'research', 'v1', 'ok');
    expect(cache.get('refactor this function', 'research', 'v1')).toBe('ok');
  });

  it('invalidates entries for a given model version', () => {
    const cache = new VeniceResponseCache();
    cache.set('p1', 'research', 'v1', 'a');
    cache.set('p2', 'research', 'v2', 'b');
    cache.invalidateModelVersion('v1');
    expect(cache.get('p1', 'research', 'v1')).toBeNull();
    expect(cache.get('p2', 'research', 'v2')).toBe('b');
  });

  it('tracks hit rate', () => {
    const cache = new VeniceResponseCache();
    cache.set('x', 'research', 'v1', 'a');
    cache.get('x', 'research', 'v1'); // hit
    cache.get('y', 'research', 'v1'); // miss
    expect(cache.getHitRate()).toBeCloseTo(0.5, 5);
  });
});

describe('similarity', () => {
  it('returns 1 for identical text', () => {
    expect(similarity('hello world', 'hello world')).toBe(1);
  });
  it('returns 0 for disjoint text', () => {
    expect(similarity('apple banana', 'zebra rocket')).toBe(0);
  });
});

describe('RequestDeduplicator', () => {
  it('collapses concurrent identical requests into one call', async () => {
    const dedup = new RequestDeduplicator();
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.resolve('result');
    };
    const [a, b] = await Promise.all([dedup.dedup('k', fn), dedup.dedup('k', fn)]);
    expect(a).toBe('result');
    expect(b).toBe('result');
    expect(calls).toBe(1);
  });

  it('allows separate keys to run independently', async () => {
    const dedup = new RequestDeduplicator();
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.resolve('result');
    };
    await Promise.all([dedup.dedup('k1', fn), dedup.dedup('k2', fn)]);
    expect(calls).toBe(2);
  });

  it('re-runs after the in-flight promise settles', async () => {
    const dedup = new RequestDeduplicator();
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.resolve('result');
    };
    await dedup.dedup('k', fn);
    await dedup.dedup('k', fn);
    expect(calls).toBe(2);
  });
});
