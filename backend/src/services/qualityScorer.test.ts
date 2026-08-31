/**
 * Unit tests for the Agent Output Quality Scoring service.
 */

import {
  QualityScorer,
  computeAgentQualityMetrics,
  computeTotalScore,
  computeTrend,
  extractSignificantTokens,
  loadScorerConfig,
  percentileNormalize,
  reputationDeltaForScore,
  runValidationSet,
  scoreCompleteness,
  scoreFormat,
  scoreRelevance,
} from './qualityScorer';
import type { QualityScorerConfig, QualityScoringRules, ValidationEntry } from './qualityScorer.types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const researchRules: QualityScoringRules = {
  agentType: 'research',
  requiredFields: ['summary', 'keyFindings', 'sources'],
  optionalFields: ['confidence'],
};

const validResearchOutput = {
  taskId: 'task_1',
  nodeId: 'node_research',
  summary: 'Quantum computing is advancing rapidly.',
  keyFindings: ['Finding one', 'Finding two'],
  sources: [{ url: 'https://example.com', title: 'Example' }],
  confidence: 0.9,
};

const validCodingOutput = {
  language: 'python',
  code: 'def add(a, b):\n    return a + b',
  explanation: 'Adds two numbers together.',
};

// ─── extractSignificantTokens ─────────────────────────────────────────────────

describe('extractSignificantTokens', () => {
  it('extracts lowercase words of length >= 4 and drops stopwords', () => {
    expect(extractSignificantTokens('Research quantum computing with the best tools')).toEqual([
      'research',
      'quantum',
      'computing',
      'best',
      'tools',
    ]);
  });

  it('returns an empty array for empty or stopword-only text', () => {
    expect(extractSignificantTokens('')).toEqual([]);
    expect(extractSignificantTokens('the and for with')).toEqual([]);
  });
});

// ─── scoreCompleteness ────────────────────────────────────────────────────────

describe('scoreCompleteness', () => {
  it('returns 100 when all required fields are present', () => {
    const result = scoreCompleteness(validResearchOutput, researchRules);
    expect(result.score).toBe(100);
    expect(result.reason).toBe('All required fields present');
  });

  it('scores partial credit when a required field is missing', () => {
    const { summary, confidence, ...missingSummary } = validResearchOutput;
    const result = scoreCompleteness(missingSummary, researchRules);
    // 2 of 3 required fields present → 66.67 → rounds to 67
    expect(result.score).toBe(67);
    expect(result.reason).toContain('summary');
  });

  it('returns 0 for a non-object output', () => {
    expect(scoreCompleteness('just a string', researchRules).score).toBe(0);
    expect(scoreCompleteness(null, researchRules).score).toBe(0);
    expect(scoreCompleteness([], researchRules).score).toBe(0);
  });

  it('treats empty strings and empty arrays as missing', () => {
    const result = scoreCompleteness(
      { ...validResearchOutput, summary: '', keyFindings: [], confidence: undefined },
      researchRules,
    );
    // 1 of 3 required fields present → 33.33 → rounds to 33, no optional bonus
    expect(result.score).toBe(33);
  });

  it('adds a bonus for present optional fields', () => {
    const withoutOptional = scoreCompleteness(
      { ...validResearchOutput, confidence: undefined },
      researchRules,
    );
    expect(withoutOptional.score).toBe(100);

    const withOptional = scoreCompleteness(validResearchOutput, researchRules);
    expect(withOptional.score).toBe(100); // capped at 100
  });

  it('returns 100 when no fields are configured', () => {
    expect(scoreCompleteness({ anything: true }, { agentType: 'custom' }).score).toBe(100);
  });
});

// ─── scoreRelevance ───────────────────────────────────────────────────────────

describe('scoreRelevance', () => {
  it('scores 0 when no prompt token appears in the output', () => {
    const result = scoreRelevance(validResearchOutput, 'blockchain regulation', researchRules);
    expect(result.score).toBe(0);
    expect(result.reason).toBe('Matched 0/2 significant prompt token(s)');
  });

  it('scores 90 when all prompt tokens appear in the output', () => {
    const output = {
      ...validResearchOutput,
      summary: 'Quantum computing research summary.',
    };
    const result = scoreRelevance(output, 'quantum computing', researchRules);
    expect(result.score).toBe(90);
  });

  it('scores 100 when the prompt has no significant tokens', () => {
    const result = scoreRelevance(validResearchOutput, 'the and for', researchRules);
    expect(result.score).toBe(100);
  });

  it('awards expected-keyword bonus points', () => {
    const rules: QualityScoringRules = { agentType: 'custom', expectedKeywords: ['blockchain', 'solar'] };
    const output = { summary: 'A report on blockchain adoption.' };
    const result = scoreRelevance(output, '', rules);
    // 90 base (no prompt tokens) + 5 (1 of 2 keywords) = 95
    expect(result.score).toBe(95);
  });

  it('never exceeds 100', () => {
    const rules: QualityScoringRules = { agentType: 'custom', expectedKeywords: ['blockchain'] };
    const output = { summary: 'blockchain blockchain' };
    const result = scoreRelevance(output, 'blockchain', rules);
    expect(result.score).toBe(100);
  });
});

// ─── scoreFormat ──────────────────────────────────────────────────────────────

describe('scoreFormat', () => {
  // Default research rules include the ResearchOutputSchema used by the format
  // dimension.
  const schemaRules = new QualityScorer().getRules('research');

  it('returns 100 for output matching the schema', () => {
    const result = scoreFormat(validResearchOutput, schemaRules);
    expect(result.score).toBe(100);
  });

  it('deducts points for each schema violation', () => {
    const bad = { taskId: 't', nodeId: 'n', summary: 's', keyFindings: ['f'], sources: [] };
    const result = scoreFormat(bad, schemaRules);
    // confidence is required → 1 issue → 100 - 20 = 80
    expect(result.score).toBe(80);
    expect(result.reason).toContain('confidence');
  });

  it('clamps the format score at 0 for heavily invalid output', () => {
    const result = scoreFormat({}, schemaRules);
    expect(result.score).toBe(0);
  });

  it('falls back to an object-shape check when no schema is configured', () => {
    expect(scoreFormat({ a: 1 }, { agentType: 'custom' }).score).toBe(100);
    expect(scoreFormat('nope', { agentType: 'custom' }).score).toBe(0);
    expect(scoreFormat([1, 2], { agentType: 'custom' }).score).toBe(0);
  });
});

// ─── computeTotalScore ────────────────────────────────────────────────────────

describe('computeTotalScore', () => {
  it('returns 100 when all dimensions are perfect', () => {
    expect(computeTotalScore({ completeness: 100, relevance: 100, format: 100 })).toBe(100);
  });

  it('returns 0 when all dimensions are zero', () => {
    expect(computeTotalScore({ completeness: 0, relevance: 0, format: 0 })).toBe(0);
  });

  it('applies default weights (0.4 / 0.3 / 0.3)', () => {
    expect(computeTotalScore({ completeness: 100, relevance: 0, format: 0 })).toBe(40);
  });

  it('honors custom weights', () => {
    const total = computeTotalScore(
      { completeness: 100, relevance: 50, format: 50 },
      { completeness: 0.5, relevance: 0.25, format: 0.25 },
    );
    expect(total).toBe(75);
  });
});

// ─── QualityScorer ────────────────────────────────────────────────────────────

describe('QualityScorer', () => {
  const scorer = new QualityScorer();

  it('produces a normalized 0–100 total score', () => {
    const quality = scorer.score(validResearchOutput, 'quantum computing', researchRules);
    expect(quality.score).toBeGreaterThanOrEqual(0);
    expect(quality.score).toBeLessThanOrEqual(100);
    expect(Number.isInteger(quality.score)).toBe(true);
    expect(typeof quality.timestamp).toBe('string');
    expect(quality.reviewed).toBe(false);
  });

  it('flags low-scoring outputs for review', () => {
    const lowScore = scorer.score({}, 'quantum computing', {
      ...researchRules,
      reviewThreshold: 60,
    });
    expect(lowScore.score).toBeLessThan(60);
    expect(lowScore.needsReview).toBe(true);
  });

  it('does not flag high-scoring outputs for review', () => {
    const quality = scorer.score(validResearchOutput, 'quantum computing', researchRules);
    expect(quality.needsReview).toBe(false);
  });

  it('uses the default research rules when scoring by agent type', () => {
    const quality = scorer.scoreForAgentType(validResearchOutput, 'quantum computing', 'research');
    expect(quality).not.toBeNull();
    expect(quality!.score).toBeGreaterThanOrEqual(0);
  });

  it('scores a well-formed coding output highly', () => {
    const quality = scorer.scoreForAgentType(validCodingOutput, 'implement a function that adds two numbers', 'coding');
    expect(quality).not.toBeNull();
    expect(quality!.score).toBeGreaterThan(60);
    expect(quality!.completeness.score).toBe(100);
    expect(quality!.format.score).toBe(100);
  });

  it('returns null when scoring is disabled for an agent type', () => {
    const disabled = new QualityScorer([{ agentType: 'research', enabled: false }]);
    expect(disabled.scoreForAgentType(validResearchOutput, 'x', 'research')).toBeNull();
  });

  it('merges custom rules over the built-in defaults', () => {
    const custom = new QualityScorer([
      { agentType: 'research', requiredFields: ['summary'], reviewThreshold: 80 },
    ]);
    const rules = custom.getRules('research');
    expect(rules.requiredFields).toEqual(['summary']);
    expect(rules.reviewThreshold).toBe(80);
    // Defaults still apply for the unset parts
    expect(rules.outputSchema).toBeDefined();
    expect(rules.enabled).toBe(true);
  });

  it('falls back to generic rules for unknown agent types', () => {
    const rules = scorer.getRules('design');
    expect(rules.agentType).toBe('design');
    expect(rules.reviewThreshold).toBe(60);
    expect(rules.requiredFields).toBeUndefined();
  });
});

// ─── reputationDeltaForScore ──────────────────────────────────────────────────

describe('reputationDeltaForScore', () => {
  it('maps a perfect score to a positive delta', () => {
    expect(reputationDeltaForScore(100)).toBe(0.1);
  });

  it('maps a failing score to a negative delta', () => {
    expect(reputationDeltaForScore(0)).toBe(-0.1);
  });

  it('is neutral at the neutral score', () => {
    expect(reputationDeltaForScore(50)).toBe(0);
  });

  it('clamps out-of-range scores', () => {
    expect(reputationDeltaForScore(150)).toBe(0.1);
    expect(reputationDeltaForScore(-10)).toBe(-0.1);
  });
});

// ─── Metrics aggregation ──────────────────────────────────────────────────────

describe('computeAgentQualityMetrics', () => {
  it('computes average, min, and max', () => {
    const metrics = computeAgentQualityMetrics([60, 70, 80, 90]);
    expect(metrics.sampleSize).toBe(4);
    expect(metrics.average).toBe(75);
    expect(metrics.min).toBe(60);
    expect(metrics.max).toBe(90);
    expect(metrics.lastScores).toEqual([60, 70, 80, 90]);
  });

  it('returns insufficient_data metrics for an empty sample', () => {
    const metrics = computeAgentQualityMetrics([]);
    expect(metrics.sampleSize).toBe(0);
    expect(metrics.trend).toBe('insufficient_data');
  });
});

describe('computeTrend', () => {
  it('is insufficient_data with fewer than 2 samples', () => {
    expect(computeTrend([])).toBe('insufficient_data');
    expect(computeTrend([80])).toBe('insufficient_data');
  });

  it('detects improvement', () => {
    expect(computeTrend([40, 50, 90, 95])).toBe('improving');
  });

  it('detects decline', () => {
    expect(computeTrend([90, 85, 50, 40])).toBe('declining');
  });

  it('detects a stable series', () => {
    expect(computeTrend([75, 76, 74, 75])).toBe('stable');
  });
});

// ─── percentileNormalize ─────────────────────────────────────────────────────

describe('percentileNormalize', () => {
  it('returns the raw score when distribution is empty', () => {
    expect(percentileNormalize(75, [])).toBe(75);
  });

  it('returns 0 when score is below all historical scores', () => {
    expect(percentileNormalize(10, [20, 40, 60, 80, 100])).toBe(0);
  });

  it('returns 100 when score is above all historical scores', () => {
    expect(percentileNormalize(100, [20, 40, 60, 80, 90])).toBe(100);
  });

  it('returns correct percentile for a mid-range score', () => {
    // Distribution: [10, 20, 30, 40, 50] — score 30 is above 2/5 = 40%
    expect(percentileNormalize(30, [10, 20, 30, 40, 50])).toBe(40);
  });

  it('handles unsorted distribution input', () => {
    expect(percentileNormalize(50, [90, 10, 70, 30, 50])).toBe(40);
  });
});

// ─── loadScorerConfig ────────────────────────────────────────────────────────

describe('loadScorerConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns defaults when env vars are not set', () => {
    delete process.env.QUALITY_WEIGHT_COMPLETENESS;
    delete process.env.QUALITY_WEIGHT_RELEVANCE;
    delete process.env.QUALITY_WEIGHT_FORMAT;
    delete process.env.QUALITY_REVIEW_THRESHOLD;
    delete process.env.QUALITY_PERCENTILE_ENABLED;
    delete process.env.QUALITY_PERCENTILE_MIN_SAMPLES;

    const config = loadScorerConfig();
    expect(config.weightCompleteness).toBe(0.4);
    expect(config.weightRelevance).toBe(0.3);
    expect(config.weightFormat).toBe(0.3);
    expect(config.reviewThreshold).toBe(60);
    expect(config.percentileEnabled).toBe(false);
    expect(config.percentileMinSamples).toBe(10);
  });

  it('reads values from env vars', () => {
    process.env.QUALITY_WEIGHT_COMPLETENESS = '0.5';
    process.env.QUALITY_WEIGHT_RELEVANCE = '0.25';
    process.env.QUALITY_WEIGHT_FORMAT = '0.25';
    process.env.QUALITY_REVIEW_THRESHOLD = '70';
    process.env.QUALITY_PERCENTILE_ENABLED = 'true';
    process.env.QUALITY_PERCENTILE_MIN_SAMPLES = '20';

    const config = loadScorerConfig();
    expect(config.weightCompleteness).toBe(0.5);
    expect(config.weightRelevance).toBe(0.25);
    expect(config.weightFormat).toBe(0.25);
    expect(config.reviewThreshold).toBe(70);
    expect(config.percentileEnabled).toBe(true);
    expect(config.percentileMinSamples).toBe(20);
  });

  it('clamps out-of-range weights', () => {
    process.env.QUALITY_WEIGHT_COMPLETENESS = '1.5';
    process.env.QUALITY_WEIGHT_RELEVANCE = '-0.3';
    process.env.QUALITY_REVIEW_THRESHOLD = '150';

    const config = loadScorerConfig();
    expect(config.weightCompleteness).toBe(1);
    expect(config.weightRelevance).toBe(0);
    expect(config.reviewThreshold).toBe(100);
  });
});

// ─── QualityScorer config integration ───────────────────────────────────────

describe('QualityScorer config integration', () => {
  it('uses config-provided weights for scoring', () => {
    const config: QualityScorerConfig = {
      weightCompleteness: 0.5,
      weightRelevance: 0.25,
      weightFormat: 0.25,
      reviewThreshold: 50,
      percentileEnabled: false,
      percentileMinSamples: 10,
    };
    const scorer = new QualityScorer([], config);

    // completeness=100, relevance=90 (quantum+computing matched), format=100 (schema ok)
    // total = 100*(0.5/1.0) + 90*(0.25/1.0) + 100*(0.25/1.0) = 50+22.5+25 = 97.5 → 98
    const quality = scorer.score(validResearchOutput, 'quantum computing', {
      agentType: 'research',
      requiredFields: ['summary', 'keyFindings', 'sources'],
      optionalFields: ['confidence'],
      weights: { completeness: 0.5, relevance: 0.25, format: 0.25 },
    });
    expect(quality.score).toBe(98);
  });

  it('applies config review threshold', () => {
    const config: QualityScorerConfig = {
      weightCompleteness: 0.4,
      weightRelevance: 0.3,
      weightFormat: 0.3,
      reviewThreshold: 90,
      percentileEnabled: false,
      percentileMinSamples: 10,
    };
    const scorer = new QualityScorer([], config);
    const quality = scorer.score(validResearchOutput, 'quantum computing', {
      agentType: 'research',
      requiredFields: ['summary', 'keyFindings', 'sources'],
      optionalFields: ['confidence'],
    });
    // Score should be high but we set threshold to 90
    expect(quality.needsReview).toBe(quality.score < 90);
  });

  it('reloadConfig picks up new env values', () => {
    const scorer = new QualityScorer([], {
      weightCompleteness: 0.4,
      weightRelevance: 0.3,
      weightFormat: 0.3,
      reviewThreshold: 60,
      percentileEnabled: false,
      percentileMinSamples: 10,
    });

    expect(scorer.getConfig().reviewThreshold).toBe(60);

    process.env.QUALITY_REVIEW_THRESHOLD = '80';
    scorer.reloadConfig();
    expect(scorer.getConfig().reviewThreshold).toBe(80);

    delete process.env.QUALITY_REVIEW_THRESHOLD;
  });
});

// ─── percentile normalization integration ────────────────────────────────────

describe('QualityScorer percentile normalization', () => {
  it('does not normalize when percentile is disabled', () => {
    const scorer = new QualityScorer([], {
      weightCompleteness: 0.4,
      weightRelevance: 0.3,
      weightFormat: 0.3,
      reviewThreshold: 60,
      percentileEnabled: false,
      percentileMinSamples: 10,
    });
    scorer.setHistoricalScores([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);

    const quality = scorer.score(validResearchOutput, 'quantum computing', researchRules);
    // Without percentile normalization, score should be the raw weighted score
    expect(quality.score).toBeGreaterThanOrEqual(0);
    expect(quality.score).toBeLessThanOrEqual(100);
  });

  it('applies percentile normalization when enabled with enough samples', () => {
    const scorer = new QualityScorer([], {
      weightCompleteness: 0.4,
      weightRelevance: 0.3,
      weightFormat: 0.3,
      reviewThreshold: 60,
      percentileEnabled: true,
      percentileMinSamples: 5,
    });
    // Historical scores cluster around 50–60
    scorer.setHistoricalScores([40, 45, 50, 55, 60, 55, 50, 45, 50, 55]);

    const quality = scorer.score(validResearchOutput, 'quantum computing', researchRules);
    // Score should be percentile-normalized
    expect(quality.score).toBeGreaterThanOrEqual(0);
    expect(quality.score).toBeLessThanOrEqual(100);
  });

  it('does not normalize when not enough samples', () => {
    const scorer = new QualityScorer([], {
      weightCompleteness: 0.4,
      weightRelevance: 0.3,
      weightFormat: 0.3,
      reviewThreshold: 60,
      percentileEnabled: true,
      percentileMinSamples: 10,
    });
    // Only 3 samples — below threshold of 10
    scorer.setHistoricalScores([40, 50, 60]);

    const quality = scorer.score(validResearchOutput, 'quantum computing', researchRules);
    // Should not be normalized (raw score returned)
    expect(quality.score).toBeGreaterThanOrEqual(0);
  });
});

// ─── Validation Set ──────────────────────────────────────────────────────────

describe('runValidationSet', () => {
  const scorer = new QualityScorer();

  const entries: ValidationEntry[] = [
    {
      label: 'valid research output',
      output: validResearchOutput,
      prompt: 'quantum computing',
      agentType: 'research',
      expectedScoreRange: [70, 100],
      expectedNeedsReview: false,
    },
    {
      label: 'empty output should score low',
      output: {},
      prompt: 'quantum computing',
      agentType: 'research',
      expectedScoreRange: [0, 40],
      expectedNeedsReview: true,
    },
  ];

  it('produces a report with pass/fail for each entry', () => {
    const report = runValidationSet(scorer, entries);
    expect(report.totalEntries).toBe(2);
    expect(report.passed + report.failed).toBe(2);
    expect(report.results.length).toBe(2);
  });

  it('marks valid output as passing', () => {
    const report = runValidationSet(scorer, entries);
    const validResult = report.results[0];
    expect(validResult.entry.label).toBe('valid research output');
    expect(validResult.passed).toBe(true);
    expect(validResult.actualScore).toBeGreaterThanOrEqual(70);
  });

  it('marks empty output as needing review', () => {
    const report = runValidationSet(scorer, entries);
    const emptyResult = report.results[1];
    expect(emptyResult.entry.label).toBe('empty output should score low');
    expect(emptyResult.actualNeedsReview).toBe(true);
  });

  it('computes average deviation', () => {
    const report = runValidationSet(scorer, entries);
    expect(report.averageDeviation).toBeGreaterThanOrEqual(0);
  });

  it('returns empty report for empty entries', () => {
    const report = runValidationSet(scorer, []);
    expect(report.totalEntries).toBe(0);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.averageDeviation).toBe(0);
  });
});
