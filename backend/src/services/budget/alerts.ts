/**
 * Daily cost budget alerting (Issue #750).
 *
 * A configured `DAILY_COST_BUDGET_USD` is watched against the day's recorded
 * spend: a warning is raised at 75% and new work is hard-stopped at 100%. The
 * check reads cost counters only, so no prompts or PII are involved.
 *
 * `0` (the default) disables the budget, so deployments that do not set one
 * behave exactly as before.
 */

import { createLogger } from '../../utils/logger';
import { createTaskDb, getTaskDb, type TaskDb } from '../../db/tasks';
import { getConfig } from '../../config/index.js';
import { BudgetExhaustedError } from './ledger.js';

const log = createLogger({ component: 'cost-budget' });

/** Fraction of the budget at which a warning is raised. */
export const COST_BUDGET_WARN_RATIO = 0.75;
/** Fraction of the budget at which new work is refused. */
export const COST_BUDGET_HARD_STOP_RATIO = 1;

export type CostBudgetLevel = 'disabled' | 'ok' | 'warn' | 'exceeded';

export interface CostBudgetStatus {
  /** UTC day the spend was measured for, `YYYY-MM-DD`. */
  day: string;
  enabled: boolean;
  budgetUsd: number;
  spentUsd: number;
  /** `spentUsd / budgetUsd`; `0` when the budget is disabled. */
  ratio: number;
  level: CostBudgetLevel;
  warnAtUsd: number;
  hardStopAtUsd: number;
}

/** Pure threshold evaluation: map a day's spend onto the alert level. */
export function evaluateCostBudget(day: string, spentUsd: number, budgetUsd: number): CostBudgetStatus {
  const enabled = budgetUsd > 0;
  const ratio = enabled ? spentUsd / budgetUsd : 0;
  let level: CostBudgetLevel = 'disabled';
  if (enabled) {
    if (ratio >= COST_BUDGET_HARD_STOP_RATIO) level = 'exceeded';
    else if (ratio >= COST_BUDGET_WARN_RATIO) level = 'warn';
    else level = 'ok';
  }
  return {
    day,
    enabled,
    budgetUsd,
    spentUsd,
    ratio,
    level,
    warnAtUsd: budgetUsd * COST_BUDGET_WARN_RATIO,
    hardStopAtUsd: budgetUsd * COST_BUDGET_HARD_STOP_RATIO,
  };
}

export interface CostBudgetOptions {
  /** Defaults to the shared task database. */
  db?: Pick<TaskDb, 'getDailySpendUsd'>;
  /** Defaults to `DAILY_COST_BUDGET_USD`. */
  budgetUsd?: number;
  /** Defaults to the current time. */
  now?: Date;
}

function configuredBudgetUsd(): number {
  try {
    return Number((getConfig() as any).DAILY_COST_BUDGET_USD ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** Highest level already announced per UTC day, so each threshold alerts once. */
let announced: { day: string; level: CostBudgetLevel } | undefined;

function announce(status: CostBudgetStatus): void {
  if (status.level !== 'warn' && status.level !== 'exceeded') return;
  if (announced?.day === status.day && (announced.level === 'exceeded' || announced.level === status.level)) {
    return;
  }
  announced = { day: status.day, level: status.level };
  const fields = {
    day: status.day,
    spentUsd: status.spentUsd,
    budgetUsd: status.budgetUsd,
    ratio: Number(status.ratio.toFixed(4)),
  };
  if (status.level === 'exceeded') {
    log.error(fields, 'daily cost budget exhausted; new work is being refused');
  } else {
    log.warn(fields, 'daily cost budget at warning threshold');
  }
}

/** Current day's spend against the configured daily budget, raising any due alert. */
export function getCostBudgetStatus(options: CostBudgetOptions = {}): CostBudgetStatus {
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);
  const budgetUsd = options.budgetUsd ?? configuredBudgetUsd();
  if (!(budgetUsd > 0)) return evaluateCostBudget(day, 0, 0);

  const db = options.db ?? createTaskDb(getTaskDb());
  const status = evaluateCostBudget(day, db.getDailySpendUsd(day), budgetUsd);
  announce(status);
  return status;
}

/** Raised at the node boundary once the daily budget is spent. */
export class DailyCostBudgetExceededError extends BudgetExhaustedError {
  constructor(taskId: string, status: CostBudgetStatus) {
    super(taskId, 0, 0);
    this.name = 'DailyCostBudgetExceededError';
    this.message =
      `Daily cost budget exhausted for ${status.day}: ` +
      `$${status.spentUsd.toFixed(4)} of $${status.budgetUsd.toFixed(4)} spent`;
  }
}

/**
 * Hard stop: throw when the daily budget is spent. A no-op while the budget is
 * disabled, and a database failure never blocks work (accounting is
 * observability, not a reason to fail a run).
 */
export function assertDailyCostBudgetAvailable(taskId: string, options: CostBudgetOptions = {}): void {
  let status: CostBudgetStatus;
  try {
    status = getCostBudgetStatus(options);
  } catch (err) {
    log.warn({ err, taskId }, 'failed to evaluate daily cost budget');
    return;
  }
  if (status.level === 'exceeded') {
    throw new DailyCostBudgetExceededError(taskId, status);
  }
}

/** Test hook: forget which alerts were already announced. */
export function resetCostBudgetAlerts(): void {
  announced = undefined;
}
