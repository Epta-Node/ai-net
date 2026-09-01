/**
 * Types for the Agent Output Quality Scoring service.
 *
 * The scorer evaluates every agent output along three dimensions:
 *   - completeness: the output contains all required sections/fields
 *   - relevance:    the output matches the intent of the original prompt
 *   - format:       the output follows the expected schema
 *
 * Each dimension is normalized to 0–100 and combined (with configurable
 * weights) into a single total score, also normalized to 0–100.
 */

import type { z } from 'zod';

/** The three dimensions evaluated by the quality scorer. */
export type QualityDimension = 'completeness' | 'relevance' | 'format';

/** A per-dimension score normalized to 0–100. */
export interface DimensionScore {
  score: number;
  /** Human-readable explanation of how the score was derived. */
  reason: string;
}

/** Trend of an agent's quality scores over time. */
export type QualityTrend = 'improving' | 'declining' | 'stable' | 'insufficient_data';

/**
 * The full scoring result for a single agent output.
 *
 * Attached to the DAG node's execution record (`DAGNode.quality`) and
 * persisted in the `quality_scores` table so it can be aggregated per agent.
 */
export interface QualityScore {
  /** Total normalized score, 0–100. */
  score: number;
  completeness: DimensionScore;
  relevance: DimensionScore;
  format: DimensionScore;
  /**
   * True when the total score falls below the configured review threshold.
   * Low-scoring outputs are flagged for human review.
   */
  needsReview: boolean;
  /** Set to true once a human has reviewed the flagged output. */
  reviewed: boolean;
  timestamp: string;
}

/**
 * Configurable scoring rules, resolved per agent type.
 *
 * Rules can be supplied at construction time (see `QualityScorer`) and are
 * merged over the built-in defaults for the agent type.
 */
export interface QualityScoringRules {
  /** The agent type these rules apply to (e.g. "research", "coding"). */
  agentType: string;
  /**
   * Zod schema the output must conform to. Used by the format dimension.
   * When omitted, format only checks that the output is a plain object.
   */
  outputSchema?: z.ZodType;
  /** Required fields for the completeness dimension. */
  requiredFields?: string[];
  /** Optional fields that add a small bonus when present. */
  optionalFields?: string[];
  /** Keywords that, when present in the output, boost the relevance score. */
  expectedKeywords?: string[];
  /** Relative weights of each dimension. Defaults to 0.4 / 0.3 / 0.3. */
  weights?: Partial<Record<QualityDimension, number>>;
  /** Scores below this threshold are flagged `needsReview`. Default 60. */
  reviewThreshold?: number;
  /** Set to false to skip scoring for this agent type. */
  enabled?: boolean;
}

/**
 * A single persisted quality score tied to a task execution record.
 * Stored in the `quality_scores` table of the tasks database.
 */
export interface QualityScoreRecord {
  taskId: string;
  nodeId: string;
  /** Agent that produced the output; undefined when no registry agent ran. */
  agentId?: string;
  agentType: string;
  score: number;
  completeness: number;
  relevance: number;
  format: number;
  needsReview: boolean;
  timestamp: string;
}

/** Aggregated quality metrics for a single agent. */
export interface AgentQualityMetrics {
  agentId: string;
  agentType: string;
  /** Number of scored executions included. */
  sampleSize: number;
  average: number;
  min: number;
  max: number;
  /** Direction of the average score across the sample window. */
  trend: QualityTrend;
  /** Most recent scores, oldest first. */
  lastScores: number[];
}

/** Full breakdown of agent reputation components (Issue #497). */
export interface ReputationBreakdown {
  /** Overall reputation score clamped to 0.0 - 5.0 scale. */
  overallScore: number;
  /** Task outcome contribution based on success/failure ratio. */
  taskSuccessScore: number;
  /** Output quality contribution (completeness, format, relevance). */
  qualityScore: number;
  /** Response latency contribution (faster response bonus). */
  latencyScore: number;
  /** Staking/bond weight multiplier (bounded, e.g. 1.0 - 1.5x). */
  bondWeightMultiplier: number;
  /** Staked bond amount in XLM. */
  bondAmountXLM: number;
  /** Total tasks successfully completed. */
  tasksCompleted: number;
  /** Total tasks failed. */
  tasksFailed: number;
  /** Timestamp when decay was last calculated or applied. */
  lastDecayAt?: string;
  /** Inactivity decay penalty applied. */
  decayApplied?: number;
}

/** Parameters for computing reputation delta upon task execution. */
export interface ReputationEvaluationInput {
  outcome: 'success' | 'failure';
  /** Quality score from qualityScorer (0 - 100). */
  qualityScore?: number;
  /** Response latency in milliseconds. */
  latencyMs?: number;
  /** Bond/stake amount in XLM. */
  bondAmountXLM?: number;
  /** Current agent reputation (0.0 - 5.0). */
  currentReputation?: number;
}

// ─── Calibration & Validation ─────────────────────────────────────────────────

/**
 * Configuration for the quality scorer loaded from environment variables.
 * Changing these values (via env or config reload) updates scoring behaviour
 * without a redeploy.
 */
export interface QualityScorerConfig {
  /** Relative weight of the completeness dimension (0-1). Default 0.4. */
  weightCompleteness: number;
  /** Relative weight of the relevance dimension (0-1). Default 0.3. */
  weightRelevance: number;
  /** Relative weight of the format dimension (0-1). Default 0.3. */
  weightFormat: number;
  /** Scores below this threshold are flagged needsReview. Default 60. */
  reviewThreshold: number;
  /** Enable percentile normalization against historical scores. Default false. */
  percentileEnabled: boolean;
  /** Minimum number of historical scores before percentile normalization kicks in. Default 10. */
  percentileMinSamples: number;
}

/**
 * A single entry in a validation set: an output + prompt pair with a known
 * expected quality label. Used to verify the scorer produces consistent,
 * documented results.
 */
export interface ValidationEntry {
  /** Human-readable label for this validation entry. */
  label: string;
  /** The agent output to score. */
  output: unknown;
  /** The original prompt. */
  prompt: string;
  /** The agent type to score against. */
  agentType: string;
  /** Expected total score range [min, max] that the scorer should produce. */
  expectedScoreRange: [number, number];
  /** Expected needsReview flag. */
  expectedNeedsReview: boolean;
}

/**
 * Result of running a validation set against the scorer. Each entry records
 * whether the scorer's output fell within the expected range.
 */
export interface ValidationResult {
  entry: ValidationEntry;
  actualScore: number;
  actualNeedsReview: boolean;
  passed: boolean;
  /** How far the actual score is from the expected range midpoint. */
  deviation: number;
}

/**
 * Aggregated result of validating all entries in a validation set.
 */
export interface ValidationReport {
  totalEntries: number;
  passed: number;
  failed: number;
  /** Average absolute deviation across all entries. */
  averageDeviation: number;
  results: ValidationResult[];
}
