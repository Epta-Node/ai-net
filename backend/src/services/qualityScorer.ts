/**
 * Agent Output Quality Scoring service.
 *
 * Scores every agent output along three dimensions:
 *   - completeness: the output contains all required sections/fields
 *   - relevance:    the output matches the intent of the original prompt
 *   - format:       the output follows the expected schema
 *
 * Each dimension is normalized to 0–100 and combined into a single total
 * score (also 0–100) using configurable per-agent-type weights. Scores are
 * persisted alongside task execution records, aggregated per agent
 * (avg/min/max/trend), and fed back into the agent reputation system.
 */

import type {
  AgentQualityMetrics,
  DimensionScore,
  QualityDimension,
  QualityScore,
  QualityScoreRecord,
  QualityScoringRules,
  QualityTrend,
} from './qualityScorer.types';
import { ResearchOutputSchema } from '../agents/research/research';
import { CodingOutputSchema } from '../agents/coding/coding';
import { createTaskDb, getTaskDb } from '../db/tasks';
import { createAgentDb, getAgentDb } from '../db/agents';
import { createLogger } from '../utils/logger';

const log = createLogger({ component: 'QualityScorer' });

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_WEIGHTS: Record<QualityDimension, number> = {
  completeness: 0.4,
  relevance: 0.3,
  format: 0.3,
};

export const DEFAULT_REVIEW_THRESHOLD = 60;

/** Small connector words excluded from prompt-token extraction. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  'will', 'would', 'can', 'could', 'should', 'have', 'has', 'had', 'not',
  'but', 'you', 'your', 'our', 'their', 'about', 'into', 'than', 'then',
  'them', 'they', 'what', 'when', 'where', 'which', 'who', 'whom', 'why',
  'how', 'all', 'any', 'each', 'more', 'most', 'other', 'some', 'such',
  'only', 'own', 'same', 'too', 'very', 'just', 'also', 'over', 'under',
  'again', 'further', 'once', 'here', 'there', 'during', 'before', 'after',
  'above', 'below', 'up', 'down', 'out', 'off', 'on', 'in', 'is', 'it', 'to',
  'of', 'a', 'an', 'be', 'by', 'or', 'as', 'at', 'use', 'using', 'used',
]);

/**
 * Built-in scoring rules per agent type. Custom rules passed to `QualityScorer`
 * are merged over these defaults, so scoring stays configurable per agent type.
 * Agent types without an entry fall back to generic rules (no required fields,
 * object-shape format check, prompt-token relevance).
 */
export const DEFAULT_QUALITY_RULES: Record<string, QualityScoringRules> = {
  research: {
    agentType: 'research',
    outputSchema: ResearchOutputSchema,
    requiredFields: ['summary', 'keyFindings', 'sources'],
    optionalFields: ['confidence'],
    expectedKeywords: [],
    reviewThreshold: DEFAULT_REVIEW_THRESHOLD,
    enabled: true,
  },
  coding: {
    agentType: 'coding',
    outputSchema: CodingOutputSchema,
    requiredFields: ['language', 'code', 'explanation'],
    optionalFields: ['testScaffold'],
    expectedKeywords: [],
    reviewThreshold: DEFAULT_REVIEW_THRESHOLD,
    enabled: true,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mean(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

/** True when a field is missing, null, or effectively empty. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/** Lower-cased stringified output used for token/keyword matching. */
function stringifyForMatch(output: unknown): string {
  try {
    return JSON.stringify(output)?.toLowerCase() ?? '';
  } catch {
    return String(output).toLowerCase();
  }
}

// ─── Dimension scorers ───────────────────────────────────────────────────────

/**
 * Extract the significant tokens from a prompt: lowercase alphanumeric words
 * of length ≥ 4 with stopwords removed. Used to gauge whether an output
 * addresses the intent of the prompt.
 */
export function extractSignificantTokens(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  return tokens.filter((token) => !STOPWORDS.has(token));
}

/** Completeness: does the output contain all required sections? */
export function scoreCompleteness(output: unknown, rules: QualityScoringRules): DimensionScore {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return { score: 0, reason: 'Output is not an object' };
  }

  const record = output as Record<string, unknown>;
  const required = rules.requiredFields ?? [];
  const optional = rules.optionalFields ?? [];

  if (required.length === 0 && optional.length === 0) {
    return { score: 100, reason: 'No required fields configured' };
  }

  const missingRequired = required.filter((field) => isEmpty(record[field]));

  let score =
    required.length > 0
      ? ((required.length - missingRequired.length) / required.length) * 100
      : 100;

  // Optional fields add up to +10 bonus points.
  if (optional.length > 0) {
    const presentOptional = optional.filter((field) => !isEmpty(record[field])).length;
    score += (presentOptional / optional.length) * 10;
  }

  score = clamp(Math.round(score), 0, 100);

  const reason =
    missingRequired.length === 0
      ? 'All required fields present'
      : `Missing required field(s): ${missingRequired.join(', ')}`;

  return { score, reason };
}

/**
 * Relevance: how well the output matches the intent of the prompt.
 * Approximated by overlap between the prompt's significant tokens (90 pts)
 * and any configured expected keywords (10 pts bonus).
 */
export function scoreRelevance(output: unknown, prompt: string, rules: QualityScoringRules): DimensionScore {
  const outputText = stringifyForMatch(output);
  const promptTokens = extractSignificantTokens(prompt);
  const keywords = (rules.expectedKeywords ?? []).map((kw) => kw.toLowerCase());

  if (promptTokens.length === 0 && keywords.length === 0) {
    return { score: 100, reason: 'No prompt tokens to match — relevance not assessed' };
  }

  let matched = 0;
  for (const token of promptTokens) {
    if (outputText.includes(token)) matched += 1;
  }

  let score = promptTokens.length > 0 ? (matched / promptTokens.length) * 90 : 90;

  if (keywords.length > 0) {
    const matchedKeywords = keywords.filter((kw) => outputText.includes(kw)).length;
    score += (matchedKeywords / keywords.length) * 10;
  }

  score = clamp(Math.round(score), 0, 100);

  const reason =
    promptTokens.length > 0
      ? `Matched ${matched}/${promptTokens.length} significant prompt token(s)`
      : 'No prompt tokens to match';

  return { score, reason };
}

/** Format: does the output follow the expected schema? */
export function scoreFormat(output: unknown, rules: QualityScoringRules): DimensionScore {
  const schema = rules.outputSchema;

  if (!schema) {
    const isObject = typeof output === 'object' && output !== null && !Array.isArray(output);
    return {
      score: isObject ? 100 : 0,
      reason: isObject ? 'Output is a plain object' : 'Output is not an object',
    };
  }

  const result = schema.safeParse(output);
  if (result.success) {
    return { score: 100, reason: 'Output matches the expected schema' };
  }

  const issues = result.error.issues;
  const firstPath = issues.length > 0 ? issues[0].path.join('.') || 'root' : 'root';
  return {
    score: clamp(Math.round(100 - issues.length * 20), 0, 100),
    reason: `Schema mismatch at "${firstPath}" (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
  };
}

/** Weighted total of the three dimension scores, normalized to 0–100. */
export function computeTotalScore(
  dimensions: Record<QualityDimension, number>,
  weights?: QualityScoringRules['weights'],
): number {
  const merged = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
  const weightSum = merged.completeness + merged.relevance + merged.format;
  const total =
    dimensions.completeness * (merged.completeness / weightSum) +
    dimensions.relevance * (merged.relevance / weightSum) +
    dimensions.format * (merged.format / weightSum);
  return clamp(Math.round(total), 0, 100);
}

// ─── Scorer ──────────────────────────────────────────────────────────────────

export class QualityScorer {
  private readonly rulesByAgentType: Map<string, QualityScoringRules>;

  /** @param rules Custom per-agent-type rules merged over the built-in defaults. */
  constructor(rules: QualityScoringRules[] = []) {
    this.rulesByAgentType = new Map(rules.map((rule) => [rule.agentType, rule]));
  }

  /** Effective rules for an agent type (defaults merged with custom rules). */
  getRules(agentType: string): QualityScoringRules {
    const defaults = DEFAULT_QUALITY_RULES[agentType];
    const custom = this.rulesByAgentType.get(agentType);
    return {
      // Sensible defaults for agent types without an explicit entry.
      reviewThreshold: DEFAULT_REVIEW_THRESHOLD,
      enabled: true,
      ...(defaults ?? {}),
      ...(custom ?? {}),
      // Always resolve to the queried type.
      agentType,
    };
  }

  /**
   * Score an output against explicit rules.
   *
   * @param output  the agent output to score
   * @param prompt  the original prompt (used for relevance); pass '' to skip
   * @param rules   scoring rules to apply
   */
  score(output: unknown, prompt: string | undefined, rules: QualityScoringRules): QualityScore {
    const completeness = scoreCompleteness(output, rules);
    const relevance = scoreRelevance(output, prompt ?? '', rules);
    const format = scoreFormat(output, rules);
    const total = computeTotalScore(
      { completeness: completeness.score, relevance: relevance.score, format: format.score },
      rules.weights,
    );
    const reviewThreshold = rules.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;

    return {
      score: total,
      completeness,
      relevance,
      format,
      needsReview: total < reviewThreshold,
      reviewed: false,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Score an output using the configured (or default) rules for an agent type.
   * Returns null when scoring is disabled for that agent type.
   */
  scoreForAgentType(output: unknown, prompt: string | undefined, agentType: string): QualityScore | null {
    const rules = this.getRules(agentType);
    if (rules.enabled === false) return null;
    return this.score(output, prompt, rules);
  }
}

// ─── Reputation feedback ─────────────────────────────────────────────────────

/**
 * Map a normalized quality score (0–100) to a reputation delta.
 * Scores above `neutralScore` improve reputation, below it reduce it.
 * Defaults: score 100 → +0.1, score 0 → -0.1, score 50 → 0.
 */
export function reputationDeltaForScore(score: number, neutralScore = 50, maxDelta = 0.1): number {
  const delta = ((clamp(score, 0, 100) - neutralScore) / 100) * maxDelta * 2;
  return Math.round(delta * 1000) / 1000;
}

/**
 * Apply a reputation delta to the local agent registry. This is the backend's
 * mirror of the on-chain reputation score (kept in sync by `registry/sync.ts`),
 * so quality feedback ultimately flows into the on-chain reputation.
 */
export function updateAgentReputation(agentId: string, delta: number): void {
  try {
    createAgentDb(getAgentDb()).updateReputation(agentId, delta);
  } catch (err) {
    // Non-fatal: an agent absent from the local registry must not fail the DAG.
    log.warn({ err, agentId }, 'failed to update agent reputation');
  }
}

// ─── Persistence & aggregation ───────────────────────────────────────────────

/**
 * Persist a quality score alongside the task execution record.
 * Non-fatal: scoring must never break DAG execution.
 */
export function recordQualityScore(record: QualityScoreRecord): void {
  try {
    createTaskDb(getTaskDb()).insertQualityScore(record);
  } catch (err) {
    log.warn({ err }, 'failed to persist quality score');
  }
}

/**
 * Aggregated quality metrics (avg, min, max, trend) for a set of scores.
 * Pure function — scores are expected oldest-first.
 */
export function computeAgentQualityMetrics(
  scores: number[],
): Omit<AgentQualityMetrics, 'agentId' | 'agentType'> {
  if (scores.length === 0) {
    return { sampleSize: 0, average: 0, min: 0, max: 0, trend: 'insufficient_data', lastScores: [] };
  }
  return {
    sampleSize: scores.length,
    average: round2(mean(scores)),
    min: Math.min(...scores),
    max: Math.max(...scores),
    trend: computeTrend(scores),
    lastScores: [...scores],
  };
}

/**
 * Trend of a score series: compares the mean of the second half against the
 * first half. Needs at least 2 samples; a shift of more than 1 point is
 * considered a real change.
 */
export function computeTrend(scores: number[]): QualityTrend {
  if (scores.length < 2) return 'insufficient_data';
  const midpoint = Math.floor(scores.length / 2);
  const firstHalf = mean(scores.slice(0, midpoint));
  const secondHalf = mean(scores.slice(midpoint));
  const delta = secondHalf - firstHalf;
  if (delta > 1) return 'improving';
  if (delta < -1) return 'declining';
  return 'stable';
}

/** Aggregate quality metrics for one agent from the persisted score records. */
export function getAgentQualityMetrics(agentId: string): AgentQualityMetrics | null {
  const records = createTaskDb(getTaskDb()).listQualityScores(agentId);
  if (records.length === 0) return null;

  const metrics = computeAgentQualityMetrics(records.map((r) => r.score));
  const agentType = records[records.length - 1].agentType;

  return { agentId, agentType, ...metrics };
}
