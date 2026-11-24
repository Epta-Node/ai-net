/**
 * Event-store retention and compaction service (issue #383).
 *
 * Runs a periodic pass that keeps the live `task_events` table bounded.  For
 * each task whose most recent event is older than the configured retention
 * window *and* which is genuinely finished, the pass:
 *
 *   1. finds candidate tasks from the event store (oldest activity first),
 *   2. confirms each one is finished — both in the `tasks` database (terminal
 *      status) and in the event stream (last event is `TaskCompleted` /
 *      `TaskFailed`),
 *   3. archives every event to `task_event_archive`, materializes a summary
 *      into `task_event_summary`, and only then purges the live rows — all
 *      inside one transaction with an explicit archive read-back in between
 *      (see `EventArchive.compactTask`).
 *
 * Safety properties
 * ─────────────────
 * • **Never purge without a confirmed archive.** The count read-back inside the
 *   transaction throws (rolling everything back) if the archive is short.
 * • **Never touch an unfinished task.** Two independent checks must agree —
 *   terminal `tasks.status` and a terminal last event — and the status is
 *   re-read inside the transaction immediately before the purge.
 * • **Idempotent.** A second pass over the same data is a no-op: the candidate
 *   scan no longer returns purged tasks, `INSERT OR IGNORE` absorbs re-archiving
 *   and the summary upsert overwrites rather than duplicating.
 * • **Fault-isolated.** A failure on one task rolls that task's transaction back
 *   and the pass continues with the next candidate.
 *
 * Scheduling follows the interval-service convention already used by
 * `ErrorRegistryMaintenanceService` and `DbMaintenanceService` — there is no
 * cron library or job queue for time-based work in this codebase.
 */

import { createLogger } from "../utils/logger";
import type { EventStore } from "../events/eventStore";
import type { TerminalTaskStatus } from "../events/eventArchive";
import { hasTerminalLastEvent } from "../events/eventArchive";
import { isTerminalTaskStatus } from "../events/retentionConstants";
import type { TaskStatus } from "../types/task";

const logger = createLogger({ component: "event-retention" });

/**
 * Process-local totals across retention passes (issue #913). Counters reset on
 * restart by design: they describe rates, while the durable record of what was
 * purged lives in `task_event_archive` and `task_event_summary`.
 */
export interface EventRetentionMetricsSnapshot {
  /** Retention passes that ran to completion. */
  passes: number;
  /** Tasks archived, summarized and purged. */
  compactedTasks: number;
  /** Events copied into the archive. */
  eventsArchived: number;
  /** Live events removed from `task_events`. */
  eventsPurged: number;
  /** Tasks whose compaction rolled back. */
  failedTasks: number;
}

const retentionTotals: EventRetentionMetricsSnapshot = {
  passes: 0,
  compactedTasks: 0,
  eventsArchived: 0,
  eventsPurged: 0,
  failedTasks: 0,
};

/** Current retention totals. Returns a copy, so callers cannot mutate them. */
export function getEventRetentionMetrics(): EventRetentionMetricsSnapshot {
  return { ...retentionTotals };
}

/** Clears retention totals. Intended for tests. */
export function resetEventRetentionMetrics(): void {
  retentionTotals.passes = 0;
  retentionTotals.compactedTasks = 0;
  retentionTotals.eventsArchived = 0;
  retentionTotals.eventsPurged = 0;
  retentionTotals.failedTasks = 0;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_TASKS = 50;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Result of a single retention pass. */
export interface EventRetentionStats {
  ranAt: string;
  retentionDays: number;
  /** ISO-8601 boundary: events at or after this are never considered. */
  cutoff: string;
  /** Tasks returned by the candidate scan. */
  candidates: number;
  /** Candidates rejected as not genuinely finished. */
  skipped: number;
  /** Tasks successfully archived + summarized + purged. */
  compactedTasks: number;
  eventsArchived: number;
  eventsPurged: number;
  summariesWritten: number;
  /** Tasks whose transaction rolled back (archive or purge failure). */
  failedTasks: number;
}

/** Zero-valued stats, used for the disabled and skipped-tick cases. */
function emptyStats(retentionDays: number, cutoff: string): EventRetentionStats {
  return {
    ranAt: new Date().toISOString(),
    retentionDays,
    cutoff,
    candidates: 0,
    skipped: 0,
    compactedTasks: 0,
    eventsArchived: 0,
    eventsPurged: 0,
    summariesWritten: 0,
    failedTasks: 0,
  };
}

export interface EventRetentionOptions {
  /** How often the pass runs, in ms. Default: 1 hour. */
  intervalMs?: number;
  /** Retention window in days. Default: 30. */
  retentionDays?: number;
  /** Max tasks compacted per pass, bounding writer-lock hold time. Default: 50. */
  batchTasks?: number;
  /** Master switch. When false, `start()` is a no-op. Default: true. */
  enabled?: boolean;
  /** Event store to compact. Defaults to the shared process-wide store. */
  eventStore?: EventStore;
  /**
   * Look up a task's current status. Defaults to reading the tasks database.
   * Injectable so the service can be unit-tested without a task database.
   */
  getTaskStatus?: (taskId: string) => TaskStatus | undefined;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/**
 * Default status lookup — reads the authoritative `tasks` row.
 *
 * Required through a lazy `require` rather than a static import so the service
 * has no module-load-time dependency on the task database (and so tests can
 * inject their own without opening SQLite).
 */
function defaultTaskStatusLookup(taskId: string): TaskStatus | undefined {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { getTask } = require("../coordinator/taskStore") as typeof import("../coordinator/taskStore");
  return getTask(taskId)?.status;
}

export class EventRetentionService {
  private readonly intervalMs: number;
  private readonly retentionDays: number;
  private readonly batchTasks: number;
  private readonly enabled: boolean;
  private readonly eventStore: EventStore | null;
  private readonly getTaskStatus: (taskId: string) => TaskStatus | undefined;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /**
   * Re-entrancy guard.  The pass is synchronous, but the interval can still
   * queue a tick while a previous one is unwinding on an error path; skipping
   * the overlapping tick keeps two passes from interleaving.
   */
  private running = false;

  constructor(options: EventRetentionOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.batchTasks = options.batchTasks ?? DEFAULT_BATCH_TASKS;
    this.enabled = options.enabled ?? true;
    this.eventStore = options.eventStore ?? null;
    this.getTaskStatus = options.getTaskStatus ?? defaultTaskStatusLookup;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (!this.enabled) {
      logger.info("event retention service disabled by configuration");
      return;
    }
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.run();
    }, this.intervalMs);
    // Run once immediately so a restart with a large backlog does not wait a
    // full interval before the first reclaim.
    this.run();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Resolve the event store lazily so constructing the service never opens a
   * database — tests can construct it freely and only inject when they run.
   */
  private resolveStore(): EventStore {
    if (this.eventStore) return this.eventStore;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { getEventStore } = require("../events/eventStore") as typeof import("../events/eventStore");
    return getEventStore();
  }

  /**
   * Run one retention pass now.  Safe to call repeatedly and concurrently
   * (overlapping calls return immediately).
   */
  run(): EventRetentionStats {
    const cutoffMs = this.now().getTime() - this.retentionDays * MS_PER_DAY;
    const cutoff = new Date(cutoffMs).toISOString();
    const stats = emptyStats(this.retentionDays, cutoff);

    if (!this.enabled || this.stopped || this.running) return stats;

    this.running = true;
    const startedAt = Date.now();
    try {
      const store = this.resolveStore();
      const candidates = store.archive.findCompactionCandidates(cutoff, this.batchTasks);
      stats.candidates = candidates.length;

      for (const candidate of candidates) {
        // Check 1: the event stream must show the task ran to completion.
        if (!hasTerminalLastEvent(candidate.lastEventType)) {
          stats.skipped += 1;
          continue;
        }

        // Check 2: the tasks database must agree.  Both are required — the
        // event store and the tasks table are separate databases, so neither
        // alone is authoritative.
        const status = this.getTaskStatus(candidate.taskId);
        if (!isTerminalTaskStatus(status)) {
          stats.skipped += 1;
          continue;
        }

        try {
          const outcome = store.archive.compactTask(
            candidate.taskId,
            status as TerminalTaskStatus,
            () => this.assertStillTerminal(candidate.taskId),
          );
          if (!outcome.compacted) {
            stats.skipped += 1;
            continue;
          }
          stats.compactedTasks += 1;
          stats.eventsArchived += outcome.eventsArchived;
          stats.eventsPurged += outcome.eventsPurged;
          stats.summariesWritten += outcome.summariesWritten;
        } catch (error) {
          // compactTask is atomic, so a throw means nothing was purged for this
          // task.  Log and continue rather than aborting the whole pass.
          stats.failedTasks += 1;
          logger.error(
            { err: error, taskId: candidate.taskId },
            "event compaction failed for task; transaction rolled back, no rows purged",
          );
        }
      }

      retentionTotals.passes += 1;
      retentionTotals.compactedTasks += stats.compactedTasks;
      retentionTotals.eventsArchived += stats.eventsArchived;
      retentionTotals.eventsPurged += stats.eventsPurged;
      retentionTotals.failedTasks += stats.failedTasks;

      logger.info({ ...stats, elapsedMs: Date.now() - startedAt }, "event retention pass completed");
      return stats;
    } catch (error) {
      logger.error({ err: error }, "event retention pass failed");
      return stats;
    } finally {
      this.running = false;
    }
  }

  /**
   * Re-read task status from the moment of purge and throw if the task is no
   * longer finished.  Executed inside the compaction transaction, so throwing
   * rolls back with the live rows untouched.  This narrows the cross-database
   * time-of-check/time-of-use window to a few statements.
   */
  private assertStillTerminal(taskId: string): void {
    const status = this.getTaskStatus(taskId);
    if (!isTerminalTaskStatus(status)) {
      throw new Error(
        `[event-retention] task ${taskId} is no longer finished (status=${String(status)}); ` +
          "refusing to compact",
      );
    }
  }
}
