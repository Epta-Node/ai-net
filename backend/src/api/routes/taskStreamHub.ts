/**
 * Shared, per-task fan-out for the WebSocket task stream (#655).
 *
 * ## Why this exists
 *
 * The stream used to be wired per *client*: every connection called
 * `eventBus.subscribe(taskId, () => flush())` and its own `flush()` re-ran
 * `eventStore.listByTaskSince(taskId, cursor)` with no `LIMIT`. Three problems
 * fell out of that shape:
 *
 * 1. **Quadratic read amplification.** N clients on one task meant N identical
 *    unbounded reads per broadcast tick. SQLite serialises reads behind writes,
 *    so that hits the whole coordinator, not just the stream.
 * 2. **Unbounded reads.** A client that stalls and resumes pays for its entire
 *    `taskSeq` gap in a single statement.
 * 3. **Listener warnings.** N clients meant N listeners on the same
 *    `EventEmitter` channel, so past `maxListeners` every emit logged
 *    `MaxListenersExceededWarning` and buried real warnings.
 *
 * ## What it does instead
 *
 * One EventBus subscription per *task*, opened when the first client attaches
 * and closed when the last one leaves. Each broadcast tick drains the backlog
 * once, in bounded pages, and hands each event to the subscribers whose cursor
 * is behind it. Cursors stay per-subscriber, so a late joiner still gets its own
 * replay while a client that is already current costs nothing extra.
 */

import type { DAGEvent } from '../../types/task';
import type { StoredEvent } from '../../events/eventStore';

/** The slice of the event store the hub reads through. */
export interface TaskStreamStore {
  listByTaskSince(taskId: string, afterSeq: number, limit?: number): StoredEvent[];
}

/** The slice of the event bus the hub subscribes through. */
export interface TaskStreamBus {
  subscribe(taskId: string, handler: (event: DAGEvent) => void): () => void;
}

export interface TaskStreamHubOptions {
  store: TaskStreamStore;
  bus: TaskStreamBus;
  /**
   * Maximum rows read per query while draining. Bounds the memory and time a
   * single read can cost; the drain loops until the backlog is empty, so
   * delivery stays complete. Default 500.
   */
  pageSize?: number;
}

export interface TaskStreamSubscription {
  /**
   * Resume cursor. Events with a higher `taskSeq` are delivered. Omit for a
   * full replay; pass the client's `lastEventId` to resume where it left off.
   */
  lastEventId?: number;
}

interface Subscriber {
  cursor: number;
  deliver: (event: StoredEvent) => void;
}

const DEFAULT_PAGE_SIZE = 500;

/** Cursor meaning "nothing delivered yet" — `taskSeq` starts at 0. */
const EARLIEST_CURSOR = -1;

export class TaskStreamHub {
  private readonly store: TaskStreamStore;
  private readonly bus: TaskStreamBus;
  private readonly pageSize: number;

  private readonly subscribersByTask = new Map<string, Map<number, Subscriber>>();
  private readonly detachByTask = new Map<string, () => void>();
  /** Tasks currently mid-drain, so a re-entrant emit does not recurse. */
  private readonly draining = new Set<string>();
  /** Tasks that emitted again while mid-drain and need another pass. */
  private readonly reentrant = new Set<string>();

  private nextSubscriberId = 1;

  constructor(options: TaskStreamHubOptions) {
    this.store = options.store;
    this.bus = options.bus;
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new RangeError(`pageSize must be a positive integer, received ${pageSize}`);
    }
    this.pageSize = pageSize;
  }

  /**
   * Attach a client to a task's stream. The returned function detaches it and
   * releases the task's bus subscription once the last client has gone.
   */
  subscribe(
    taskId: string,
    subscription: TaskStreamSubscription,
    deliver: (event: StoredEvent) => void,
  ): () => void {
    let subscribers = this.subscribersByTask.get(taskId);
    if (!subscribers) {
      subscribers = new Map();
      this.subscribersByTask.set(taskId, subscribers);
    }

    const id = this.nextSubscriberId++;
    subscribers.set(id, {
      cursor: subscription.lastEventId ?? EARLIEST_CURSOR,
      deliver,
    });

    // One bus listener per task, not per client — this is what keeps
    // listener counts flat and collapses N reads per tick into one.
    if (!this.detachByTask.has(taskId)) {
      this.detachByTask.set(
        taskId,
        this.bus.subscribe(taskId, () => {
          this.flush(taskId);
        }),
      );
    }

    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;

      const current = this.subscribersByTask.get(taskId);
      if (!current) return;
      current.delete(id);
      if (current.size > 0) return;

      // Last subscriber left: stop paying for this task's bus subscription.
      this.subscribersByTask.delete(taskId);
      this.detachByTask.get(taskId)?.();
      this.detachByTask.delete(taskId);
      this.reentrant.delete(taskId);
    };
  }

  /**
   * Drain the backlog for one task, delivering to every subscriber that is
   * behind. Called on each broadcast; safe to call directly for an initial
   * replay. Returns the number of rows read.
   */
  flush(taskId: string): number {
    const subscribers = this.subscribersByTask.get(taskId);
    if (!subscribers || subscribers.size === 0) return 0;

    // An emit arriving mid-drain is folded into the running loop rather than
    // recursing, so no event can slip through between pages.
    if (this.draining.has(taskId)) {
      this.reentrant.add(taskId);
      return 0;
    }

    this.draining.add(taskId);
    let rowsRead = 0;
    try {
      for (;;) {
        const pageRows = this.drainOnce(taskId, subscribers);
        rowsRead += pageRows;
        // An emit that arrived mid-drain may have appended more rows, so take
        // another pass even if this page already looked drained.
        if (this.reentrant.delete(taskId)) continue;
        // A short page means the store had nothing left, so stop here rather
        // than issue another query just to learn the backlog is empty. This
        // keeps the common case at exactly one query per broadcast tick.
        if (pageRows < this.pageSize) break;
      }
    } finally {
      this.draining.delete(taskId);
    }
    return rowsRead;
  }

  /**
   * Read and deliver one bounded page. Returns how many rows the page held —
   * `0` signals that the store had nothing left, which is what ends the drain.
   */
  private drainOnce(taskId: string, subscribers: Map<number, Subscriber>): number {
    // Read from the slowest cursor so no subscriber misses an event, then skip
    // delivery to the ones already past it. This is what lets N subscribers
    // share a single read.
    let from: number | null = null;
    for (const subscriber of subscribers.values()) {
      if (from === null || subscriber.cursor < from) from = subscriber.cursor;
    }
    if (from === null) return 0; // no subscribers to deliver to

    const page = this.store.listByTaskSince(taskId, from, this.pageSize);
    if (page.length === 0) return 0;

    for (const event of page) {
      for (const subscriber of subscribers.values()) {
        if (subscriber.cursor < event.taskSeq) {
          subscriber.deliver(event);
          subscriber.cursor = event.taskSeq;
        }
      }
    }

    // A short page means the store had nothing left. It is still returned so
    // the caller's row count includes it, and the next pass reads zero rows and
    // stops the loop.
    return page.length;
  }

  /** Number of attached clients for a task. */
  subscriberCount(taskId: string): number {
    return this.subscribersByTask.get(taskId)?.size ?? 0;
  }

  /**
   * Number of live EventBus subscriptions the hub is holding. Should track the
   * number of tasks with at least one client, not the number of clients.
   */
  busSubscriptionCount(): number {
    return this.detachByTask.size;
  }

  /** Tasks with at least one attached client. */
  activeTaskCount(): number {
    return this.subscribersByTask.size;
  }
}
