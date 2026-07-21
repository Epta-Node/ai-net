import { EventEmitter } from 'events';
import type { DAGEvent } from '../types/task';

/**
 * In-process pub/sub bus.  Coordinator emits events; WebSocket handlers
 * subscribe per taskId, and a persistence recorder subscribes to *all* events
 * via {@link EventBus.subscribeAll} so they can be replayed on reconnect.
 */
class EventBus extends EventEmitter {
  /** Internal channel that receives every event regardless of taskId. */
  private static readonly ALL = '__all__';

  /** Next sequence number to assign per taskId (counter starts at 0). */
  private readonly nextSeqByTask = new Map<string, number>();

  emit(taskId: string, event: DAGEvent): boolean {
    // Stamp a per-task monotonic sequence number BEFORE any subscriber sees the
    // event, so the persistence recorder and every live handler observe the
    // same seq. seq starts at 0 for each taskId and increments by 1 per event,
    // giving clients a stable cursor to resume a stream from (?lastEventId).
    const seq = this.nextSeqByTask.get(taskId) ?? 0;
    this.nextSeqByTask.set(taskId, seq + 1);
    event.seq = seq;

    // Notify the persistence recorder FIRST so the event is durably stored
    // before any per-task subscriber reacts to it.  Live WebSocket handlers
    // drain newly-persisted rows, so the row must exist by the time they run.
    super.emit(EventBus.ALL, event);
    return super.emit(taskId, event);
  }

  subscribe(taskId: string, handler: (e: DAGEvent) => void): () => void {
    this.on(taskId, handler);
    return () => this.off(taskId, handler);
  }

  /** Subscribe to every event on the bus (used by the persistence recorder). */
  subscribeAll(handler: (e: DAGEvent) => void): () => void {
    this.on(EventBus.ALL, handler);
    return () => this.off(EventBus.ALL, handler);
  }
}

export const eventBus = new EventBus();
eventBus.setMaxListeners(100);
