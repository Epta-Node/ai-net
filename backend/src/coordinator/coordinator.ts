import type { AgentRegistration, AgentRegistry } from '../types/agent';
import type { PaymentService } from '../types/payment';
import { eventBus } from './eventBus';
import { updateNode, updateTask, deleteAbortController } from './taskStore';
import type { DAGNode, Task } from './types';

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const PRIMARY_ATTEMPTS = 3;

export type DispatchFn = (
  taskId: string,
  node: DAGNode,
  context: string
) => Promise<unknown>;

export type PaymentReleaseFn = (
  taskId: string,
  nodeId: string
) => Promise<string>;

export interface CoordinatorOptions {
  agentRegistry?: AgentRegistry;
  paymentService?: PaymentService;
  eventBus?: typeof eventBus;
  concurrency?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  dispatch?: DispatchFn;
}

class TaskCancelledError extends Error {
  constructor() {
    super('Task was cancelled');
    this.name = 'TaskCancelledError';
  }
}

class ConcurrencyLimiter {
  private readonly queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active += 1;
        work()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.queue.shift()?.();
          });
      };

      if (this.active < this.limit) {
        start();
      } else {
        this.queue.push(start);
      }
    });
  }
}

class RetryableAgentError extends Error {}
class NonRetryableAgentError extends Error {}

function now(): string {
  return new Date().toISOString();
}

function asErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function isRetryable(err: unknown): boolean {
  return err instanceof RetryableAgentError;
}

function sortByCost(agents: AgentRegistration[]): AgentRegistration[] {
  return [...agents].sort((a, b) => a.cost - b.cost);
}

export class Coordinator {
  private readonly bus: typeof eventBus;
  private readonly limiter: ConcurrencyLimiter;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly dispatchOverride?: DispatchFn;
  private readonly agentRegistry?: AgentRegistry;
  private readonly paymentService: PaymentService;

  constructor(options: CoordinatorOptions = {}) {
    this.bus = options.eventBus ?? eventBus;
    this.limiter = new ConcurrencyLimiter(options.concurrency ?? DEFAULT_CONCURRENCY);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
    this.dispatchOverride = options.dispatch;
    this.agentRegistry = options.agentRegistry;
    this.paymentService = options.paymentService ?? { release: async () => 'mock-hash' };
  }

  async executeDAG(taskId: string, dag: DAGNode[], signal?: AbortSignal): Promise<void> {
    const completed = new Set<string>();
    const failed = new Set<string>();
    const cancelled = new Set<string>();
    const scheduled = new Set<string>();
    const nodeById = new Map(dag.map(node => [node.nodeId, node]));
    let inFlight = 0;

    updateTaskIfPresent(taskId, { status: 'running' });

    // When cancellation signal fires, immediately mark all pending nodes as cancelled
    const onCancel = (): void => {
      for (const node of dag) {
        if (node.status === 'pending') {
          node.status = 'cancelled';
          cancelled.add(node.nodeId);
          updateNode(taskId, node.nodeId, { status: 'cancelled' });
        }
      }
    };
    signal?.addEventListener('abort', onCancel, { once: true });

    await new Promise<void>(resolve => {
      const finishIfSettled = (): void => {
        if (completed.size + failed.size + cancelled.size !== dag.length) return;

        deleteAbortController(taskId);
        signal?.removeEventListener('abort', onCancel);

        if (cancelled.size > 0) {
          updateTaskIfPresent(taskId, { status: 'cancelled', dag });
          this.bus.emit(taskId, {
            type: 'task_cancelled',
            taskId,
            timestamp: now(),
          });
        } else {
          const status = failed.size === 0 ? 'completed' : 'failed';
          updateTaskIfPresent(taskId, { status, dag });
          this.bus.emit(taskId, {
            type: status === 'completed' ? 'task_completed' : 'task_failed',
            taskId,
            timestamp: now(),
          });
        }
        resolve();
      };

      const failBlockedNodes = (includeDeadlocked: boolean): void => {
        for (const node of dag) {
          if (node.status !== 'pending') {
            continue;
          }

          const hasFailedDependency = node.dependsOn.some(dep => failed.has(dep));
          const hasUnresolvedDependency = node.dependsOn.some(dep => !nodeById.has(dep));
          const isDeadlocked =
            includeDeadlocked &&
            inFlight === 0 &&
            !node.dependsOn.every(dep => completed.has(dep));

          if (!hasFailedDependency && !hasUnresolvedDependency && !isDeadlocked) {
            continue;
          }

          node.status = 'failed';
          node.error = hasUnresolvedDependency ? 'dependency_not_found' : 'upstream_failed';
          failed.add(node.nodeId);
          updateNode(taskId, node.nodeId, { status: 'failed', error: node.error });
          this.bus.emit(taskId, {
            type: 'node_failed',
            taskId,
            nodeId: node.nodeId,
            timestamp: now(),
            payload: { error: node.error },
          });
        }
      };

      const scheduleReadyNodes = (): void => {
        // If task has been cancelled, do not schedule any new nodes
        if (signal?.aborted) {
          onCancel();
          if (inFlight === 0) {
            finishIfSettled();
          }
          return;
        }

        let scheduledAny = false;

        for (const node of dag) {
          if (
            node.status !== 'pending' ||
            scheduled.has(node.nodeId) ||
            !node.dependsOn.every(dep => completed.has(dep))
          ) {
            continue;
          }

          scheduledAny = true;
          scheduled.add(node.nodeId);
          inFlight += 1;
          this.limiter.run(() => this.runNode(taskId, node, nodeById, signal))
            .then(status => {
              if (status === 'completed') completed.add(node.nodeId);
              else if (status === 'cancelled') cancelled.add(node.nodeId);
              else failed.add(node.nodeId);
            })
            .finally(() => {
              inFlight -= 1;
              scheduleReadyNodes();
              failBlockedNodes(false);
              finishIfSettled();
            });
        }

        if (!scheduledAny && inFlight === 0) {
          failBlockedNodes(true);
          finishIfSettled();
        }
      };

      scheduleReadyNodes();
    });
  }

  async dispatchNode(node: DAGNode, context: string, agent?: AgentRegistration, cancelSignal?: AbortSignal): Promise<unknown> {
    const target = agent ?? await this.cheapestAgentFor(node.agentType);

    // Short-circuit if already cancelled before starting the request
    if (cancelSignal?.aborted) {
      throw new TaskCancelledError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    // Forward cancellation signal to abort the in-flight HTTP request
    const onCancel = (): void => {
      clearTimeout(timeout);
      controller.abort();
    };
    cancelSignal?.addEventListener('abort', onCancel, { once: true });

    try {
      const response = await this.fetchImpl(`${target.endpoint.replace(/\/$/, '')}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ node, context }),
        signal: controller.signal,
      });

      if (response.status >= 500) {
        throw new RetryableAgentError(`Agent ${target.id} returned ${response.status}`);
      }
      if (!response.ok) {
        throw new NonRetryableAgentError(`Agent ${target.id} returned ${response.status}`);
      }

      const text = await response.text();
      return text ? JSON.parse(text) : {};
    } catch (err) {
      // If cancellation fired during the request, surface it as TaskCancelledError
      if (cancelSignal?.aborted) {
        throw new TaskCancelledError();
      }
      if (err instanceof NonRetryableAgentError || err instanceof RetryableAgentError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new RetryableAgentError(`Agent ${target.id} timed out after ${this.timeoutMs}ms`);
      }
      throw new RetryableAgentError(asErrorMessage(err));
    } finally {
      clearTimeout(timeout);
      cancelSignal?.removeEventListener('abort', onCancel);
    }
  }

  private async runNode(
    taskId: string,
    node: DAGNode,
    nodeById: Map<string, DAGNode>,
    cancelSignal?: AbortSignal
  ): Promise<'completed' | 'failed' | 'cancelled'> {
    // If already cancelled before starting, bail out immediately
    if (cancelSignal?.aborted) {
      node.status = 'cancelled';
      updateNode(taskId, node.nodeId, { status: 'cancelled' });
      return 'cancelled';
    }

    node.status = 'running';
    updateNode(taskId, node.nodeId, { status: 'running' });
    this.bus.emit(taskId, {
      type: 'node_started',
      taskId,
      nodeId: node.nodeId,
      timestamp: now(),
    });

    try {
      const result = await this.dispatchWithRetry(taskId, node, this.contextFor(node, nodeById), cancelSignal);

      // Node dispatched successfully — check if cancellation came in during dispatch
      if (cancelSignal?.aborted) {
        node.status = 'cancelled';
        updateNode(taskId, node.nodeId, { status: 'cancelled' });
        return 'cancelled';
      }

      node.status = 'completed';
      node.result = result;
      updateNode(taskId, node.nodeId, { status: 'completed', result });
      this.bus.emit(taskId, {
        type: 'node_completed',
        taskId,
        nodeId: node.nodeId,
        timestamp: now(),
        payload: result,
      });

      const txHash = await this.paymentService.release(taskId, node.nodeId);
      this.bus.emit(taskId, {
        type: 'payment_released',
        taskId,
        nodeId: node.nodeId,
        timestamp: now(),
        payload: { txHash },
      });

      return 'completed';
    } catch (err) {
      // If cancellation caused the dispatch to fail, mark the node as cancelled
      if (err instanceof TaskCancelledError || cancelSignal?.aborted) {
        node.status = 'cancelled';
        updateNode(taskId, node.nodeId, { status: 'cancelled' });
        return 'cancelled';
      }

      node.status = 'failed';
      node.error = asErrorMessage(err);
      updateNode(taskId, node.nodeId, { status: 'failed', error: node.error });
      this.bus.emit(taskId, {
        type: 'node_failed',
        taskId,
        nodeId: node.nodeId,
        timestamp: now(),
        payload: { error: node.error },
      });
      return 'failed';
    }
  }

  private contextFor(node: DAGNode, nodeById: Map<string, DAGNode>): string {
    return node.dependsOn
      .map(dep => nodeById.get(dep)?.result)
      .filter(result => result !== undefined)
      .map(result => JSON.stringify(result))
      .join('\n');
  }

  private async dispatchWithRetry(taskId: string, node: DAGNode, context: string, cancelSignal?: AbortSignal): Promise<unknown> {
    if (this.dispatchOverride) {
      return this.dispatchOverride(taskId, node, context);
    }

    const agents = await this.agentsFor(node.agentType);
    const primary = agents[0];
    let lastError: unknown = new Error(`No agent registered for type: ${node.agentType}`);

    for (let attempt = 1; attempt <= PRIMARY_ATTEMPTS; attempt += 1) {
      try {
        return await this.dispatchNode(node, context, primary, cancelSignal);
      } catch (err) {
        if (err instanceof TaskCancelledError) throw err;
        lastError = err;
        if (!isRetryable(err)) throw err;
      }
    }

    const fallback = agents.find(agent => agent.id !== primary.id);
    if (fallback) {
      try {
        return await this.dispatchNode(node, context, fallback, cancelSignal);
      } catch (err) {
        if (err instanceof TaskCancelledError) throw err;
        lastError = err;
      }
    }

    throw lastError;
  }

  private async cheapestAgentFor(agentType: string): Promise<AgentRegistration> {
    return (await this.agentsFor(agentType))[0];
  }

  private async agentsFor(agentType: string): Promise<AgentRegistration[]> {
    if (!this.agentRegistry) {
      throw new Error(`No agent registry configured for type: ${agentType}`);
    }

    const agents = sortByCost(await this.agentRegistry.getAgents(agentType));
    if (agents.length === 0) {
      throw new Error(`No agent registered for type: ${agentType}`);
    }
    return agents;
  }
}

export async function executeDAG(
  task: Task,
  dispatch: DispatchFn,
  releasePayment: PaymentReleaseFn,
  signal?: AbortSignal
): Promise<void> {
  const coordinator = new Coordinator({
    dispatch,
    paymentService: { release: releasePayment },
  });

  await coordinator.executeDAG(task.taskId, task.dag, signal);
}

function updateTaskIfPresent(taskId: string, patch: Partial<Task>): void {
  try {
    updateTask(taskId, patch);
  } catch {
    // Unit tests can exercise the coordinator without creating a task first.
  }
}
