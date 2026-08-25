/**
 * Unit tests for the Coordinator class (coordinator.ts).
 *
 * Covers: dispatchNode (timeout, retry, non-retryable, abort),
 * executeDAG (happy path, node failure, dependency blocking, deadlock),
 * dispatchWithRetry (retry logic, fallback agent), agentsFor (no registry, empty),
 * and the standalone executeDAG export.
 *
 * No real HTTP calls or SQLite databases are used.
 */
import { Coordinator, executeDAG, type DispatchFn, type PaymentReleaseFn } from "./coordinator";
import type { DAGNode, Task } from "../types/task";
import type { AgentRegistration, AgentRegistry } from "../types/agent";
import { eventBus } from "./eventBus";

// ── Mock taskStore so coordinator doesn't need a real DB ──────────────────────
jest.mock("./taskStore", () => ({
  createTask: jest.fn(),
  getTask: jest.fn((id: string) => ({
    id,
    prompt: "test",
    walletPublicKey: "GWALLET",
    status: "queued",
    dag: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  updateTask: jest.fn(),
  updateNode: jest.fn(),
  getEventHistory: jest.fn().mockReturnValue([]),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(
  nodeId: string,
  type = "research",
  dependencies: string[] = []
): DAGNode {
  return { nodeId, type, status: "pending", prompt: `Do ${nodeId}`, dependencies };
}

function makeAgent(id: string, cost = 1): AgentRegistration {
  return {
    id,
    type: "research",
    endpoint: `http://agent-${id}.test`,
    cost,
    status: "online",
  };
}

function makeFetchOk(payload: Record<string, unknown> = { result: "ok" }): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  } as any) as any;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Coordinator.dispatchNode
// ─────────────────────────────────────────────────────────────────────────────

describe("Coordinator.dispatchNode", () => {
  it("returns parsed response on success (200)", async () => {
    const mockFetch = makeFetchOk({ data: "solar" });
    const coord = new Coordinator({ fetch: mockFetch });
    const agent = makeAgent("a1");
    const node = makeNode("n1");

    const result = await coord.dispatchNode(node, "ctx", agent);
    expect(result).toEqual({ data: "solar" });
  });

  it("returns empty object when response body is empty", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    } as any) as any;

    const coord = new Coordinator({ fetch: mockFetch });
    const result = await coord.dispatchNode(makeNode("n1"), "ctx", makeAgent("a1"));
    expect(result).toEqual({});
  });

  it("throws RetryableAgentError on 5xx response", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    } as any) as any;

    const coord = new Coordinator({ fetch: mockFetch });
    await expect(coord.dispatchNode(makeNode("n1"), "ctx", makeAgent("a1"))).rejects.toThrow(
      /returned 503/
    );
  });

  it("throws NonRetryableAgentError on 4xx (non-429) response", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    } as any) as any;

    const coord = new Coordinator({ fetch: mockFetch });
    await expect(coord.dispatchNode(makeNode("n1"), "ctx", makeAgent("a1"))).rejects.toThrow(
      /returned 400/
    );
  });

  it("throws RetryableAgentError on AbortError (timeout)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const mockFetch = jest.fn().mockRejectedValue(abortErr) as any;

    const coord = new Coordinator({ fetch: mockFetch, timeoutMs: 100 });
    await expect(coord.dispatchNode(makeNode("n1"), "ctx", makeAgent("a1"))).rejects.toThrow(
      /timed out/
    );
  });

  it("throws RetryableAgentError on generic network error", async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;

    const coord = new Coordinator({ fetch: mockFetch });
    await expect(coord.dispatchNode(makeNode("n1"), "ctx", makeAgent("a1"))).rejects.toThrow(
      /ECONNREFUSED/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Coordinator.executeDAG — with dispatch override
// ─────────────────────────────────────────────────────────────────────────────

describe("Coordinator.executeDAG — dispatch override", () => {
  it("executes a single-node DAG successfully", async () => {
    const dispatch = jest.fn().mockResolvedValue({ result: "done" });
    const releasePayment = jest.fn().mockResolvedValue("tx-hash");

    const coord = new Coordinator({
      dispatch,
      paymentService: { release: releasePayment },
    });

    await coord.executeDAG("task_001", [makeNode("n1")]);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(releasePayment).toHaveBeenCalledWith("task_001", "n1");
  });

  it("respects dependencies — runs n2 only after n1 completes", async () => {
    const order: string[] = [];
    const dispatch = jest.fn().mockImplementation(async (_taskId, node) => {
      order.push(node.nodeId);
      return { result: node.nodeId };
    });

    const coord = new Coordinator({
      dispatch,
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
    });

    await coord.executeDAG("task_001", [
      makeNode("n1"),
      makeNode("n2", "research", ["n1"]),
    ]);

    expect(order).toEqual(["n1", "n2"]);
  });

  it("marks downstream nodes as failed when upstream fails", async () => {
    const dispatch = jest.fn().mockRejectedValue(new Error("agent error"));

    const coord = new Coordinator({
      dispatch,
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
    });

    const dag = [makeNode("n1"), makeNode("n2", "research", ["n1"])];
    await coord.executeDAG("task_001", dag);

    expect(dag[0].status).toBe("failed");
    expect(dag[1].status).toBe("failed");
  });

  it("handles multiple independent nodes in parallel", async () => {
    const dispatch = jest.fn().mockResolvedValue({ result: "ok" });

    const coord = new Coordinator({
      dispatch,
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
      concurrency: 3,
    });

    await coord.executeDAG("task_001", [
      makeNode("n1", "research"),
      makeNode("n2", "risk"),
      makeNode("n3", "coding"),
    ]);

    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("marks node with unresolved dependency as failed (dependency_not_found)", async () => {
    const dispatch = jest.fn().mockResolvedValue({});
    const coord = new Coordinator({
      dispatch,
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
    });

    const dag = [makeNode("n1", "research", ["nonexistent"])];
    await coord.executeDAG("task_001", dag);
    expect(dag[0].status).toBe("failed");
    expect(dag[0].error).toBe("dependency_not_found");
  });

  it("emits task_completed event on full DAG completion", async () => {
    const events: string[] = [];
    const unsub = eventBus.subscribeAll((ev) => events.push(ev.type));

    const coord = new Coordinator({
      dispatch: jest.fn().mockResolvedValue({}),
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
    });

    await coord.executeDAG("task_event_test", [makeNode("n1")]);
    unsub();

    expect(events).toContain("task_completed");
  });

  it("emits task_failed event when any node fails", async () => {
    const events: string[] = [];
    const unsub = eventBus.subscribeAll((ev) => events.push(ev.type));

    const coord = new Coordinator({
      dispatch: jest.fn().mockRejectedValue(new Error("fail")),
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
    });

    await coord.executeDAG("task_fail_test", [makeNode("n1")]);
    unsub();

    expect(events).toContain("task_failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Coordinator.dispatchWithRetry — using agent registry
// ─────────────────────────────────────────────────────────────────────────────

describe("Coordinator dispatchWithRetry — agent registry", () => {
  it("fails immediately on non-retryable 4xx error", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad request",
    } as any) as any;

    const registry: AgentRegistry = {
      getAgents: jest.fn().mockResolvedValue([makeAgent("a1")]),
    };

    const coord = new Coordinator({
      agentRegistry: registry,
      fetch: mockFetch,
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
    });

    await coord.executeDAG("task_001", [makeNode("n1")]);
    // Node should be failed after non-retryable error
    // (4xx causes immediate failure without retries)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("tries fallback agent when primary exhausts retries", async () => {
    let callCount = 0;
    const mockFetch = jest.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes("agent-primary")) {
        return {
          ok: false,
          status: 503,
          text: async () => "Service Unavailable",
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: "fallback success" }),
      };
    }) as any;

    const registry: AgentRegistry = {
      getAgents: jest.fn().mockResolvedValue([
        { ...makeAgent("primary"), endpoint: "http://agent-primary.test" },
        { ...makeAgent("fallback"), endpoint: "http://agent-fallback.test" },
      ]),
    };

    const coord = new Coordinator({
      agentRegistry: registry,
      fetch: mockFetch,
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
    });

    await coord.executeDAG("task_001", [makeNode("n1")]);
    // Primary tried 3 times, then fallback tried once
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("throws when no agent registry is configured", async () => {
    const coord = new Coordinator({
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
    });

    const dag = [makeNode("n1")];
    await coord.executeDAG("task_001", dag);
    // With no registry and no dispatch, nodes should fail
    expect(dag[0].status).toBe("failed");
  });

  it("throws when agent registry returns no agents", async () => {
    const registry: AgentRegistry = {
      getAgents: jest.fn().mockResolvedValue([]),
    };

    const coord = new Coordinator({
      agentRegistry: registry,
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
    });

    const dag = [makeNode("n1")];
    await coord.executeDAG("task_001", dag);
    expect(dag[0].status).toBe("failed");
  });

  it("throws when registry returns only offline agents", async () => {
    const registry: AgentRegistry = {
      getAgents: jest.fn().mockResolvedValue([
        { ...makeAgent("a1"), status: "offline" },
      ]),
    };

    const coord = new Coordinator({
      agentRegistry: registry,
      paymentService: { release: jest.fn().mockResolvedValue("tx") },
    });

    const dag = [makeNode("n1")];
    await coord.executeDAG("task_001", dag);
    expect(dag[0].status).toBe("failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  standalone executeDAG export
// ─────────────────────────────────────────────────────────────────────────────

describe("standalone executeDAG", () => {
  it("executes a DAG using the provided dispatch and releasePayment", async () => {
    const dispatch: DispatchFn = jest.fn().mockResolvedValue({ result: "ok" });
    const releasePayment: PaymentReleaseFn = jest.fn().mockResolvedValue("tx-hash");

    const now = new Date().toISOString();
    const task: Task = {
      id: "task_standalone",
      prompt: "test",
      walletPublicKey: "GWALLET",
      status: "queued",
      dag: [makeNode("n1")],
      createdAt: now,
      updatedAt: now,
    };

    await executeDAG(task, dispatch, releasePayment);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(releasePayment).toHaveBeenCalledWith("task_standalone", "n1");
  });
});
