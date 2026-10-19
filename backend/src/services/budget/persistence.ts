/**
 * Bridges the in-memory budget ledger to SQLite (Issue #390).
 *
 * Every function here is best-effort by design: a database failure must never
 * turn a successful LLM call into a failed task. Accounting is observability —
 * it is not worth failing a paid run over.
 */

import { createLogger } from '../../utils/logger';
import { createTaskDb, getTaskDb, type PersistedTaskCost, type TaskDb } from '../../db/tasks';
import { quotaMetricsRegistry } from '../quota/metrics';
import { recordWalletTokenSpend } from '../quota/walletQuota';
import {
  activeSnapshots,
  getLedger,
  takeLedgerSnapshot,
  type BudgetLimits,
  type TaskBudgetLedger,
  type TaskCostSnapshot,
} from './ledger';

const log = createLogger({ component: 'budget' });

function now(): string {
  return new Date().toISOString();
}

let db: TaskDb | undefined;

/** The task DB handle, built once. `getTaskDb()` caches the pool itself. */
function taskDb(): TaskDb {
  if (!db) db = createTaskDb(getTaskDb());
  return db;
}

/**
 * Persist a node's accumulated usage for a task.
 *
 * The caller passes the ledger's *running totals* for the node, not just this
 * call's delta, so this writes through `setNodeUsage` (overwrite) rather than
 * `addNodeUsage` (accumulate). Re-persisting the same total on a retry, a
 * second flush, or at settlement is therefore idempotent instead of
 * double-counting the node.
 */
export function persistNodeUsage(
  taskId: string,
  nodeId: string,
  entry: {
    agentId: string;
    agentType: string;
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    trimmed: boolean;
    budgetExhausted: boolean;
  }
): void {
  try {
    taskDb().setNodeUsage({
      taskId,
      nodeId,
      agentId: entry.agentId,
      agentType: entry.agentType,
      model: entry.model,
      calls: entry.calls,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      totalTokens: entry.totalTokens,
      costUsd: entry.costUsd,
      trimmed: entry.trimmed,
      budgetExhausted: entry.budgetExhausted,
      updatedAt: now(),
    });
  } catch (err) {
    log.warn({ err, taskId, nodeId }, 'failed to persist node token usage');
  }
}

function toPersistedCost(snapshot: TaskCostSnapshot, settledAt: string): PersistedTaskCost {
  return {
    taskId: snapshot.taskId,
    walletPublicKey: snapshot.walletPublicKey,
    budgetTokens: snapshot.budgetTokens,
    usedTokens: snapshot.usedTokens,
    costUsd: snapshot.costUsd,
    currency: snapshot.currency,
    exceeded: snapshot.exceeded,
    calls: snapshot.calls,
    createdAt: snapshot.createdAt,
    settledAt,
  };
}

/**
 * Fold a settled task's tokens into the quota metrics.
 *
 * Best-effort for the same reason as the persistence below it: telemetry must
 * never be able to fail a task that already ran and already cost money.
 */
function countTaskSpend(tokens: number): void {
  try {
    quotaMetricsRegistry().recordTaskSpend({ tokens });
  } catch (err) {
    log.warn({ err }, 'failed to record task token spend metric');
  }
}

/**
 * Snapshot a settled task into `task_costs` and release its ledger.
 *
 * Called when a task reaches a terminal state, so the in-memory footprint
 * tracks live tasks rather than growing for the process lifetime.
 */
export function settleTaskCost(taskId: string): TaskCostSnapshot | undefined {
  const snapshot = takeLedgerSnapshot(taskId);
  if (!snapshot) return undefined;

  // Count the spend before touching the database. The trailing-24h gauge is
  // read from `task_costs` at scrape time, but the lifetime counter has no
  // durable home, and a persistence failure must not swallow the token count.
  countTaskSpend(snapshot.usedTokens);

  // Fold the settled spend into the wallet's daily Venice-token quota
  // (Issue #803). Best-effort for the same reason: accounting never fails a
  // run that already cost money.
  try {
    recordWalletTokenSpend(snapshot.walletPublicKey, snapshot.usedTokens);
  } catch (err) {
    log.warn({ err, taskId }, 'failed to record wallet token quota spend');
  }

  try {
    taskDb().upsertTaskCost(toPersistedCost(snapshot, now()));

    // Rewrite every node row from the final snapshot. `persistNodeUsage` already
    // writes through on each call, so this is redundant in the happy path — but
    // it makes settlement authoritative: if a mid-task write was lost (DB blip,
    // crash between calls), the terminal row is rebuilt from the ledger rather
    // than left at whatever the last successful write managed to store.
    for (const node of snapshot.agents) {
      persistNodeUsage(taskId, node.nodeId, node);
    }

    log.info(
      {
        taskId,
        usedTokens: snapshot.usedTokens,
        budgetTokens: snapshot.budgetTokens,
        costUsd: snapshot.costUsd,
        exceeded: snapshot.exceeded,
      },
      'task cost snapshot persisted',
    );
  } catch (err) {
    log.warn({ err, taskId }, 'failed to persist task cost snapshot');
  }

  return snapshot;
}

/**
 * Persist every in-flight ledger *without* releasing it.
 *
 * A periodic flush means a crash mid-task still leaves the spend on record. A
 * budget that only persists on clean completion under-reports exactly the runs
 * an operator most wants to see.
 */
export function flushActiveCosts(): number {
  let flushed = 0;
  for (const snapshot of activeSnapshots()) {
    try {
      // Use the task's start time as settledAt: the task has not settled, and
      // a placeholder now() would sort it to the top of "recent" forever.
      taskDb().upsertTaskCost(toPersistedCost(snapshot, snapshot.createdAt));
      flushed += 1;
    } catch (err) {
      log.warn({ err, taskId: snapshot.taskId }, 'failed to flush active task cost');
    }
  }
  return flushed;
}

/** The live ledger for a task, created on first use. */
export function ledgerFor(
  taskId: string,
  options: { walletPublicKey?: string; limits?: Partial<BudgetLimits> } = {}
): TaskBudgetLedger {
  return getLedger(taskId, options);
}
