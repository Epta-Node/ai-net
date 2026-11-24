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
  /**
   * Called when the server starts shutting down, before any connection is
   * closed. Transports that need to notify clients (SSE sends a `close` event)
   * provide this so their clients are not dropped silently.
   */
  onShutdown?: () => void;
  /**
   * Called if a client has not detached within the shutdown drain window.
   * The transport may destroy the underlying socket here.
   */
  onForceClose?: () => void;
}

interface Subscriber {
  id: number;
  taskId: string;
  cursor: number;
  deliver: (event: StoredEvent) => void;
  onShutdown?: () => void;
  onForceClose?: () => void;
  detached: boolean;
}

const DEFAULT_PAGE_SIZE = 500;

/** Maximum time graceful shutdown waits for stream clients to drain. */
export const SSE_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

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
  /** True once `shutdown()` has begun; no new subscribers are accepted. */
  private shuttingDown = false;
  /** Shared promise so concurrent callers wait for the same drain. */
  private shutdownPromise?: Promise<void>;

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
    // Once shutdown has started, tell late arrivals why they are being closed
    // rather than accepting a stream that would be dropped a moment later.
    if (this.shuttingDown) {
      subscription.onShutdown?.();
      return () => { /* nothing was attached */ };
    }

    let subscribers = this.subscribersByTask.get(taskId);
    if (!subscribers) {
      subscribers = new Map();
      this.subscribersByTask.set(taskId, subscribers);
    }

    const id = this.nextSubscriberId++;
    subscribers.set(id, {
      id,
      taskId,
      cursor: subscription.lastEventId ?? EARLIEST_CURSOR,
      deliver,
      onShutdown: subscription.onShutdown,
      onForceClose: subscription.onForceClose,
      detached: false,
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
      this.detachSubscriber(taskId, id);
    };
  }

  private detachSubscriber(taskId: string, id: number): void {
    const current = this.subscribersByTask.get(taskId);
    if (!current) return;
    const subscriber = current.get(id);
    if (subscriber) subscriber.detached = true;
    current.delete(id);
    if (current.size > 0) return;

    // Last subscriber left: stop paying for this task's bus subscription.
    this.subscribersByTask.delete(taskId);
    this.detachByTask.get(taskId)?.();
    this.detachByTask.delete(taskId);
    this.reentrant.delete(taskId);
  }

  /**
   * Graceful shutdown: notify every connected client, then wait up to
   * `timeoutMs` (default 10s) for their streams to detach. Clients that still
   * have not detached when the deadline expires are force-closed.
   *
   * Only subscribers with an `onShutdown` hook are waited on — transports
   * without one (e.g. WebSockets, which the HTTP server closes itself) are not
   * part of the SSE drain contract.
   */
  shutdown(timeoutMs: number = SSE_SHUTDOWN_DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.drainSubscribers(timeoutMs);
    return this.shutdownPromise;
  }

  private async drainSubscribers(timeoutMs: number): Promise<void> {
    const pending: Subscriber[] = [];
    for (const subscribers of this.subscribersByTask.values()) {
      for (const subscriber of subscribers.values()) {
        if (!subscriber.onShutdown) continue;
        pending.push(subscriber);
        try {
          subscriber.onShutdown();
        } catch {
          // A broken client must not prevent the rest from being notified.
        }
      }
    }

    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (pending.some((subscriber) => !subscriber.detached)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    }

    // Force-close anyone still attached, then release their hub state. This
    // guarantees `shutdown()` never leaves a stream open past the deadline.
    for (const subscriber of pending) {
      if (subscriber.detached) continue;
      try {
        subscriber.onForceClose?.();
      } catch {
        // Forced closure is best-effort; state is released below regardless.
      }
      this.detachSubscriber(subscriber.taskId, subscriber.id);
    }
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
