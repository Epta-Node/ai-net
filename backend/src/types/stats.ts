export interface TimePoint {
  timestamp: string;
  value: number;
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
}
