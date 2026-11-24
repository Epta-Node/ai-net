export interface TimePoint {
  timestamp: string;
  value: number;
}

/** Platform-wide LLM spend rollup (Issue #390). */
export interface CostTotalsSummary {
  /** Tasks that have a recorded cost snapshot. */
  tasks: number;
  /** Total accounted LLM calls. */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Tasks whose actual usage passed their token budget. */
  overBudgetTasks: number;
  /** Daily spend for the last 7 days, for a sparkline. */
  costLast7d: TimePoint[];
}

export interface StatsResponse {
  totalAgents: number;
  totalTasks: number;
  totalXLMTransacted: number;
  uptimePercent: number;
  tasksLast24h: TimePoint[];
  xlmLast24h: TimePoint[];
  /** 7-day daily task counts for sparklines */
  tasksLast7d: TimePoint[];
  /** 7-day daily XLM totals for sparklines */
  xlmLast7d: TimePoint[];
  /** LLM spend rollup. */
  cost: CostTotalsSummary;
}
