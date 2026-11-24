/**
 * Out-of-Jest check for the MaxListenersExceededWarning claim (#655).
 *
 * Jest installs its own `warning` handling, so a `process.on('warning')`
 * listener registered inside a test never observes the warning — verified
 * empirically, which is why this runs as a plain Node child process where
 * Node's warning machinery is the real one.
 *
 * Runs both subscription shapes and prints one line per shape:
 *   HUB_WARNINGS=<n> hubListeners=<n> hubBusSubscriptions=<n>
 *   PERCLIENT_WARNINGS=<n> perClientListeners=<n>
 */

import { EventEmitter } from 'events';
import type { DAGEvent } from '../../src/types/task';
import type { StoredEvent } from '../../src/events/eventStore';
import { TaskStreamHub, type TaskStreamBus } from '../../src/api/routes/taskStreamHub';

const warnings: string[] = [];
process.on('warning', (warning) => warnings.push(warning.name));

const SUBSCRIBERS = 200;
const MAX_LISTENERS = 100;

const rows: StoredEvent[] = [{ taskId: 'task', taskSeq: 0 } as unknown as StoredEvent];

const store = {
  listByTaskSince(taskId: string, afterSeq: number, limit?: number): StoredEvent[] {
    const matching = rows.filter((e) => e.taskId === taskId && e.taskSeq > afterSeq);
    return limit === undefined ? matching : matching.slice(0, limit);
  },
};

class EmitterBus implements TaskStreamBus {
  private readonly emitter = new EventEmitter();

  constructor(maxListeners: number) {
    this.emitter.setMaxListeners(maxListeners);
  }

  subscribe(taskId: string, handler: (event: DAGEvent) => void): () => void {
    this.emitter.on(taskId, handler);
    return () => this.emitter.off(taskId, handler);
  }

  tick(taskId: string): void {
    this.emitter.emit(taskId, {} as DAGEvent);
  }

  get listenersForTask(): number {
    return this.emitter.listenerCount('task');
  }
}

/** Warnings are queued on the next tick, so drain before reading the count. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function main(): Promise<void> {
  // ── Current shape: TaskStreamHub keeps one subscription per task ──────────
  const hubBus = new EmitterBus(MAX_LISTENERS);
  const hub = new TaskStreamHub({ store, bus: hubBus });
  for (let i = 0; i < SUBSCRIBERS; i++) {
    hub.subscribe('task', { lastEventId: 0 }, () => undefined);
  }
  hubBus.tick('task');
  await settle();

  const hubWarnings = warnings.length;
  const hubListeners = hubBus.listenersForTask;
  const hubSubscriptions = hub.busSubscriptionCount();
  warnings.length = 0;

  // ── Previous shape: every client subscribed to the bus on its own ─────────
  const perClientBus = new EmitterBus(MAX_LISTENERS);
  for (let i = 0; i < SUBSCRIBERS; i++) {
    perClientBus.subscribe('task', () => undefined);
  }
  perClientBus.tick('task');
  await settle();

  console.log(
    `HUB_WARNINGS=${hubWarnings} hubListeners=${hubListeners} ` +
      `hubBusSubscriptions=${hubSubscriptions} subscribers=${SUBSCRIBERS}`,
  );
  console.log(
    `PERCLIENT_WARNINGS=${warnings.length} perClientListeners=${perClientBus.listenersForTask}`,
  );
}

void main();
