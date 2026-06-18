import type { StatsResponse, TimePoint } from '../types/stats';

export interface DbClient {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const MS_PER_HOUR = 60 * 60 * 1000;
const STROOP_FACTOR = 1e7;

function normalizeDecimal(value: number): number {
  return Math.round(value * STROOP_FACTOR) / STROOP_FACTOR;
}

function truncateToHour(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()));
}

function buildHourlySeries(start: Date, end: Date, rows: Array<{ hour: string; value: number }>): TimePoint[] {
  const points: TimePoint[] = [];
  const map = new Map(rows.map((row) => [truncateToHour(new Date(row.hour)).toISOString(), row.value]));
  for (let timestamp = start.getTime(); timestamp <= end.getTime(); timestamp += MS_PER_HOUR) {
    const iso = new Date(timestamp).toISOString();
    points.push({ timestamp: iso, value: map.get(iso) ?? 0 });
  }
  return points;
}

async function queryCount(db: DbClient, queryText: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ count: number }>(queryText, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function getTotalAgents(db: DbClient): Promise<number> {
  return queryCount(db, 'SELECT COUNT(*) AS count FROM agents');
}

async function getTotalTasks(db: DbClient): Promise<number> {
  return queryCount(db, 'SELECT COUNT(*) AS count FROM tasks');
}

async function getTotalXLMTransacted(db: DbClient): Promise<number> {
  const result = await db.query<{ amount: string | number }>(
    "SELECT COALESCE(SUM(amount), 0) AS amount FROM payments WHERE status = 'released'"
  );
  const rawAmount = Number(result.rows[0]?.amount ?? 0);
  return normalizeDecimal(rawAmount / STROOP_FACTOR);
}

async function getUptimePercent(db: DbClient, since: Date): Promise<number> {
  const result = await db.query<{ total: string | number; succeeded: string | number }>(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded FROM tasks WHERE \"createdAt\" >= $1",
    [since.toISOString()]
  );

  const total = Number(result.rows[0]?.total ?? 0);
  const succeeded = Number(result.rows[0]?.succeeded ?? 0);
  if (total === 0) {
    return 100;
  }

  return normalizeDecimal((succeeded / total) * 100);
}

async function getTasksHourlyCounts(db: DbClient, since: Date): Promise<Array<{ hour: string; value: number }>> {
  const result = await db.query<{ hour: string; count: string | number }>(
    "SELECT DATE_TRUNC('hour', \"createdAt\") AS hour, COUNT(*) AS count FROM tasks WHERE \"createdAt\" >= $1 GROUP BY hour ORDER BY hour",
    [since.toISOString()]
  );

  return result.rows.map((row) => ({ hour: row.hour, value: Number(row.count ?? 0) }));
}

async function getXLMHourlyTotals(db: DbClient, since: Date): Promise<Array<{ hour: string; value: number }>> {
  const result = await db.query<{ hour: string; sum: string | number }>(
    "SELECT DATE_TRUNC('hour', \"createdAt\") AS hour, COALESCE(SUM(amount), 0) AS sum FROM payments WHERE status = 'released' AND \"createdAt\" >= $1 GROUP BY hour ORDER BY hour",
    [since.toISOString()]
  );

  return result.rows.map((row) => ({ hour: row.hour, value: normalizeDecimal(Number(row.sum ?? 0) / STROOP_FACTOR) }));
}

export async function getStats(db: DbClient, now: Date = new Date()): Promise<StatsResponse> {
  const currentHour = truncateToHour(now);
  const start24h = new Date(currentHour.getTime() - 23 * MS_PER_HOUR);
  const uptimeSince = new Date(now.getTime() - 7 * 24 * MS_PER_HOUR);

  const [totalAgents, totalTasks, uptimePercent, taskRows, xlmRows, totalXLMTransacted] = await Promise.all([
    getTotalAgents(db),
    getTotalTasks(db),
    getUptimePercent(db, uptimeSince),
    getTasksHourlyCounts(db, start24h),
    getXLMHourlyTotals(db, start24h),
    getTotalXLMTransacted(db)
  ]);

  return {
    totalAgents,
    totalTasks,
    uptimePercent,
    totalXLMTransacted,
    tasksLast24h: buildHourlySeries(start24h, currentHour, taskRows),
    xlmLast24h: buildHourlySeries(start24h, currentHour, xlmRows)
  };
}
