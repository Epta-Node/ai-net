/**
 * GET /api/tasks/:id/events/stream (#751).
 *
 * Uses an array-backed store and an EventEmitter bus behind the real
 * TaskStreamHub, and real HTTP connections, because the behaviour under test is
 * the SSE framing, resume cursor, flag gate, limits and disconnect cleanup.
 */
import { EventEmitter } from "events";
import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import type { DAGEvent, Task } from "../../types/task";
import type { StoredEvent } from "../../events/eventStore";
import { errorHandler } from "../middleware/errorHandler";
import { setFlag } from "../../services/featureFlags";
import { TaskStreamHub, type TaskStreamBus } from "./taskStreamHub";
import { createTaskEventsSseHandler } from "./taskEventsSse";

const WALLET = "GOWNER";
const TASK = { id: "task_1", walletPublicKey: WALLET } as unknown as Task;

class ArrayStore {
  rows: StoredEvent[] = [];
  append(taskSeq: number, type: string): void {
    this.rows.push({
      taskSeq,
      taskId: TASK.id,
      type,
      occurredAt: "2025-01-01T00:00:00.000Z",
    } as unknown as StoredEvent);
  }
  listByTaskSince(_taskId: string, afterSeq: number, limit?: number): StoredEvent[] {
    const all = this.rows.filter((e) => e.taskSeq > afterSeq);
    return limit === undefined ? all : all.slice(0, limit);
  }
}

class EmitterBus implements TaskStreamBus {
  readonly emitter = new EventEmitter();
  subscribe(taskId: string, handler: (event: DAGEvent) => void): () => void {
    this.emitter.on(taskId, handler);
    return () => this.emitter.off(taskId, handler);
  }
  tick(): void {
    this.emitter.emit(TASK.id, {} as DAGEvent);
  }
}

interface Client {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: () => string;
  waitFor: (text: string) => Promise<void>;
  closed: Promise<void>;
  destroy: () => void;
}

describe("GET /api/tasks/:id/events/stream", () => {
  let server: http.Server;
  let port: number;
  let store: ArrayStore;
  let bus: EmitterBus;
  const clients: Client[] = [];

  beforeAll(() => {
    process.env.VENICE_API_KEY = process.env.VENICE_API_KEY || "test-venice-key";
    process.env.DATABASE_URL = process.env.DATABASE_URL || ":memory:";
  });

  beforeEach(async () => {
    store = new ArrayStore();
    bus = new EmitterBus();
    const hub = new TaskStreamHub({ store, bus });
    const app = express();
    app.get(
      "/api/tasks/:id/events/stream",
      createTaskEventsSseHandler({
        hub,
        getTask: (id) => (id === TASK.id ? TASK : undefined),
        heartbeatIntervalMs: 20,
        maxConnectionsPerClient: 2,
      }),
    );
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    setFlag("streaming_responses", null);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setFlag("streaming_responses", null);
  });

  function connect(headers: Record<string, string> = { walletpublickey: WALLET }): Promise<Client> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: `/api/tasks/${TASK.id}/events/stream`, headers },
        (res) => {
          let buf = "";
          const waiters: Array<{ text: string; resolve: () => void }> = [];
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buf += chunk;
            for (const w of [...waiters]) {
              if (buf.includes(w.text)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve();
              }
            }
          });
          const closed = new Promise<void>((r) => res.on("close", () => r()));
          const client: Client = {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: () => buf,
            waitFor: (text) =>
              buf.includes(text)
                ? Promise.resolve()
                : new Promise<void>((r) => waiters.push({ text, resolve: r })),
            closed,
            destroy: () => req.destroy(),
          };
          clients.push(client);
          resolve(client);
        },
      );
      req.on("error", reject);
    });
  }

  it("returns 404 when the streaming flag is off", async () => {
    setFlag("streaming_responses", false);
    const client = await connect();
    await client.closed;
    expect(client.status).toBe(404);
    expect(client.body()).toContain("Streaming responses are disabled");
  });

  it("rejects a wallet that does not own the task", async () => {
    const client = await connect({ walletpublickey: "GSTRANGER" });
    await client.closed;
    expect(client.status).toBe(403);
  });

  it("replays stored events, then tails live ones with SSE framing", async () => {
    store.append(0, "TaskCreated");
    store.append(1, "NodeStarted");
    const client = await connect();

    expect(client.status).toBe(200);
    expect(client.headers["content-type"]).toContain("text/event-stream");
    expect(client.headers["cache-control"]).toContain("no-transform");
    await client.waitFor("id: 1\n");
    expect(client.body()).toContain("id: 0\nevent: task_created\n");
    expect(client.body()).toContain("id: 1\nevent: node_started\n");

    store.append(2, "NodeCompleted");
    bus.tick();
    await client.waitFor("id: 2\nevent: node_completed\n");
  });

  it("resumes after Last-Event-ID without repeating earlier events", async () => {
    store.append(0, "TaskCreated");
    store.append(1, "NodeStarted");
    store.append(2, "NodeCompleted");
    const client = await connect({ walletpublickey: WALLET, "last-event-id": "1" });

    await client.waitFor("id: 2\n");
    expect(client.body()).not.toContain("id: 0\n");
    expect(client.body()).not.toContain("id: 1\n");
  });

  it("sends keep-alive comments while idle", async () => {
    const client = await connect();
    await client.waitFor(": keep-alive");
  });

  it("ends the stream after a terminal event", async () => {
    store.append(0, "TaskCreated");
    store.append(1, "TaskCompleted");
    const client = await connect();
    await client.closed;
    expect(client.body()).toContain("event: task_completed");
  });

  it("enforces the per-client connection limit and frees slots on disconnect", async () => {
    const first = await connect();
    await connect();
    const third = await connect();
    await third.closed;
    expect(third.status).toBe(429);

    first.destroy();
    await first.closed;
    // Allow the server to observe the close before reconnecting.
    await new Promise((r) => setTimeout(r, 50));
    const again = await connect();
    expect(again.status).toBe(200);
  });

  it("unsubscribes from the bus when the client disconnects", async () => {
    const client = await connect();
    await client.waitFor(": keep-alive");
    expect(bus.emitter.listenerCount(TASK.id)).toBe(1);

    client.destroy();
    await client.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.emitter.listenerCount(TASK.id)).toBe(0);
  });
});
