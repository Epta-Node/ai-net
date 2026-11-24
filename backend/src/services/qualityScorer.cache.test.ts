import { QualityScorer } from './qualityScorer';
import type { QualityScorerConfig, QualityScoringRules } from './qualityScorer.types';
import { QualityScoreCache } from './qualityScoreCache';

const CONFIG: QualityScorerConfig = {
  weightCompleteness: 0.4,
  weightRelevance: 0.3,
  weightFormat: 0.3,
  reviewThreshold: 60,
  percentileEnabled: false,
  percentileMinSamples: 10,
};

const ENABLED = { enabled: true, ttlMs: 3_600_000, maxEntries: 500 };

function makeRules(): QualityScoringRules {
  return { agentType: 'generic', weights: { completeness: 0.4, relevance: 0.3, format: 0.3 }, reviewThreshold: 60 } as QualityScoringRules;
}

describe('QualityScoreCache keys', () => {
  it('gives identical content the same key, ignoring surrounding whitespace', () => {
    const cache = new QualityScoreCache(ENABLED);
    const rules = makeRules();
    expect(cache.keyFor(rules, 'p', 'summary text')).toBe(cache.keyFor(rules, 'p', '  summary text\n'));
  });

  it('keeps case, so a case change is a different key', () => {
    const cache = new QualityScoreCache(ENABLED);
    const rules = makeRules();
    expect(cache.keyFor(rules, 'p', 'Summary')).not.toBe(cache.keyFor(rules, 'p', 'summary'));
  });

  it('separates keys by prompt and by rules object', () => {
    const cache = new QualityScoreCache(ENABLED);
    const rules = makeRules();
    expect(cache.keyFor(rules, 'a', 'out')).not.toBe(cache.keyFor(rules, 'b', 'out'));
    expect(cache.keyFor(rules, 'a', 'out')).not.toBe(cache.keyFor(makeRules(), 'a', 'out'));
  });

  it('returns no key when caching is disabled', () => {
    const cache = new QualityScoreCache({ ...ENABLED, enabled: false });
    expect(cache.keyFor(makeRules(), 'p', 'out')).toBeUndefined();
  });
});

describe('QualityScorer score cache', () => {
  it('answers an identical repeat from the cache', () => {
    const scorer = new QualityScorer([], CONFIG, ENABLED);
    const rules = scorer.getRules('generic');

    const first = scorer.score('The answer is 42', 'what is the answer', rules);
    const second = scorer.score('The answer is 42', 'what is the answer', rules);

    expect(second).toEqual(first);
    expect(scorer.getCacheStats()).toMatchObject({ size: 1, hits: 1, misses: 1 });
  });

  it('misses when the prompt changes', () => {
    const scorer = new QualityScorer([], CONFIG, ENABLED);
    const rules = scorer.getRules('generic');

    scorer.score('same output', 'prompt one', rules);
    scorer.score('same output', 'prompt two', rules);

    expect(scorer.getCacheStats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it('returns a copy, so mutating a result does not change the cache', () => {
    const scorer = new QualityScorer([], CONFIG, ENABLED);
    const rules = scorer.getRules('generic');

    const first = scorer.score('output', 'p', rules);
    first.needsReview = !first.needsReview;
    const second = scorer.score('output', 'p', rules);

    expect(second.needsReview).toBe(!first.needsReview);
  });

  it('evicts the least recently used entry when full', () => {
    const scorer = new QualityScorer([], CONFIG, { ...ENABLED, maxEntries: 2 });
    const rules = scorer.getRules('generic');

    scorer.score('one', 'p', rules);
    scorer.score('two', 'p', rules);
    scorer.score('three', 'p', rules);
    expect(scorer.getCacheStats().size).toBe(2);

    // 'one' was evicted, so scoring it again is a miss.
    const missesBefore = scorer.getCacheStats().misses;
    scorer.score('one', 'p', rules);
    expect(scorer.getCacheStats().misses).toBe(missesBefore + 1);
  });

  it('never caches when disabled', () => {
    const scorer = new QualityScorer([], CONFIG, { ...ENABLED, enabled: false });
    const rules = scorer.getRules('generic');

    scorer.score('output', 'p', rules);
    scorer.score('output', 'p', rules);

    expect(scorer.getCacheStats()).toMatchObject({ size: 0, hits: 0, misses: 0 });
  });

  it('empties the cache on clearCache and keeps the counters', () => {
    const scorer = new QualityScorer([], CONFIG, ENABLED);
    const rules = scorer.getRules('generic');

    scorer.score('output', 'p', rules);
    scorer.clearCache();

    expect(scorer.getCacheStats()).toMatchObject({ size: 0, misses: 1 });
  });
});
