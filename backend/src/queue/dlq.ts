/**
 * Dead-letter queue (DLQ) facade over the job store (issues #802 and #739).
 *
 * A job that exhausts `maxAttempts` is *isolated* rather than dropped: it is
 * flipped to the terminal `dead-letter` status, which the claim query never
 * selects, so a poison message can never stall or re-run the main queue while
 * still remaining fully inspectable and replayable.
 *
 * The store row is the single source of truth — there is no second table to
 * drift — and this module owns the four operations operators need:
 *
 *  • {@link DeadLetterQueue.push}   — park a job that ran out of retries and
 *                                     emit `job.dead_lettered` on the event bus.
 *  • {@link DeadLetterQueue.list}   — paginated inspection for the CLI/API.
 *  • {@link DeadLetterQueue.replay} — re-enqueue with a fresh retry budget.
 *                                     Idempotent: replaying a job that is no
 *                                     longer dead-lettered is a no-op.
 *  • {@link DeadLetterQueue.purge}  — delete entries older than N days and
 *                                     return how many rows went away.
 */

import type { Job, JobStore } from './jobStore';
import { createLogger } from '../utils/logger';

type EventBusModule = typeof import('../coordinator/eventBus');

const logger = createLogger({ component: 'dead-letter-queue' });

/** Snapshot of a parked job, shaped for CLI output and API responses. */
export interface DeadLetter {
  jobId: string;
  taskId: string;
  /** Last error (including the attempts-exceeded prefix) that parked the job. */
  failureReason: string;
  failedAt: string;
  retryCount: number;
  originalPayload: unknown;
}

/** Paginated read result shared by the CLI and the admin API. */
export interface DeadLetterPage {
  deadLetters: DeadLetter[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DeadLetterQueueOptions {
  /**
   * Emit `job.dead_lettered` on the coordinator event bus when a job is
   * parked. Defaults to `true`; the CLI turns it off because it replays and
   * purges historical rows without a task in flight.
   */
  emitEvents?: boolean;
}

/** Map a stored job row to the operator-facing dead-letter shape. */
function toDeadLetter(job: Job): DeadLetter {
  return {
    jobId: job.id,
    taskId: job.taskId,
    failureReason: job.lastError ?? '',
    failedAt: job.failedAt ?? job.updatedAt,
    retryCount: job.attempts,
    originalPayload: job.payload,
  };
}

/**
 * Emit `job.dead_lettered` through the coordinator event bus.
 *
 * Loaded lazily so `queue/` never takes a static dependency on
 * `coordinator/` (the coordinator already imports the queue), and guarded so
 * a missing or failing bus can never turn a successful dead-letter move into
 * a thrown error — the row is already parked by then.
 */
function emitDeadLetterEvent(deadLetter: DeadLetter): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { eventBus } = require('../coordinator/eventBus') as EventBusModule;
    eventBus.emit(deadLetter.taskId, {
      type: 'job.dead_lettered',
      taskId: deadLetter.taskId,
      timestamp: new Date().toISOString(),
      payload: {
        jobId: deadLetter.jobId,
        failureReason: deadLetter.failureReason,
        retryCount: deadLetter.retryCount,
        failedAt: deadLetter.failedAt,
      },
    });
  } catch (err) {
    logger.warn({ err, jobId: deadLetter.jobId }, 'failed to emit job.dead_lettered event');
  }
}

export class DeadLetterQueue {
  private readonly store: JobStore;
  private readonly emitEvents: boolean;

  constructor(store: JobStore, options: DeadLetterQueueOptions = {}) {
    this.store = store;
    this.emitEvents = options.emitEvents ?? true;
  }

  /**
   * Park a job that has exhausted its retry budget.
   *
   * The move is guarded by `expectedStatus`, so a job that is already parked
   * (a retried CLI call, a racing worker) is left untouched and the
   * `job.dead_lettered` event fires exactly once per transition.
   *
   * @returns `true` when this call performed the transition.
   */
  push(
    job: Job,
    error: Error | string,
    options: { attempts?: number; maxAttempts?: number } = {}
  ): boolean {
    const attempts = options.attempts ?? job.attempts;
    const maxAttempts = options.maxAttempts ?? job.maxAttempts;
    const failureReason = typeof error === 'string' ? error : error.message || String(error);

    const moved = this.store.updateStatus(job.id, 'dead-letter', {
      attempts,
      lastError: `max attempts exceeded (${attempts}/${maxAttempts}): ${failureReason}`,
      failedAt: new Date().toISOString(),
      // Only an in-flight (or retry-scheduled) job may be parked; a completed
      // job must never be rewound into the dead-letter set.
      expectedStatus: ['active', 'failed', 'pending'],
    });

    if (moved && this.emitEvents) {
      const parked = this.store.findById(job.id);
      emitDeadLetterEvent(toDeadLetter(parked ?? job));
    }

    if (moved) {
      logger.error(
        { jobId: job.id, taskId: job.taskId, attempts, maxAttempts, err: failureReason },
        'job moved to the dead-letter queue'
      );
    }
    return moved;
  }

  /** Paginated dead-letter listing, oldest failures last (store order). */
  list(options: { page?: number; pageSize?: number } = {}): DeadLetterPage {
    const page = Math.max(1, Math.floor(options.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 50) || 1));
    const { jobs, total } = this.store.getDeadLetterJobs(page, pageSize);
    return {
      deadLetters: jobs.map(toDeadLetter),
      total,
      page,
      pageSize,
    };
  }

  /** Number of jobs currently parked in the dead-letter queue. */
  count(): number {
    return this.store.getStats().deadLetter;
  }

  /**
   * Re-enqueue a parked job with a fresh retry budget.
   *
   * Idempotent by construction: the reset is a single conditional `UPDATE`
   * gated on `status = 'dead-letter'`, so replaying the same job twice (or a
   * replay racing a worker) enqueues it exactly once.
   *
   * @returns `true` when the job was requeued by this call, `false` when it
   *   was not parked (already replayed, unknown, or deleted).
   */
  replay(jobId: string): boolean {
    const requeued = this.store.retryDeadLetterJob(jobId);
    if (requeued) {
      logger.info({ jobId }, 'dead-letter job replayed with a fresh retry budget');
    } else {
      logger.warn({ jobId }, 'dead-letter replay was a no-op (job not in the dead-letter queue)');
    }
    return requeued;
  }

  /**
   * Delete dead-letter entries whose failure is older than `olderThanDays`.
   *
   * @returns the number of rows deleted.
   */
  purge(olderThanDays: number): number {
    const days = Number.isFinite(olderThanDays) ? Math.max(0, olderThanDays) : 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const purged = this.store.purgeDeadLetters(cutoff);
    if (purged > 0) {
      logger.info({ purged, olderThanDays: days, cutoff }, 'purged expired dead-letter jobs');
    }
    return purged;
  }
}

/**
 * Build a DLQ facade over an explicit store (tests, CLI) or the process-wide
 * job database (operators running `npm run dlq -- ...`).
 */
export function createDeadLetterQueue(
  store: JobStore,
  options?: DeadLetterQueueOptions
): DeadLetterQueue {
  return new DeadLetterQueue(store, options);
}
