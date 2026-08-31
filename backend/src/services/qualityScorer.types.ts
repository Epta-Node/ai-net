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
