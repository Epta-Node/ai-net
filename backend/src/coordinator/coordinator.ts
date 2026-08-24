import type pino from 'pino';
import type { AgentRegistration, AgentRegistry } from '../types/agent';
import type { PaymentService } from '../types/payment';
import { eventBus } from './eventBus';
import { updateNode, updateTask } from './taskStore';
import type { DAGNode, Task } from '../types/task';
import { createLogger } from '../utils/logger';
import { tracingService } from '../services/tracing';

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
  /** Structured logger bound with correlation context (e.g. { taskId, requestId }) */
  logger?: pino.Logger;
  /** Correlation ID for distributed tracing — propagated to all sub-spans and agent HTTP calls. */
  correlationId?: string;
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
  private readonly log: pino.Logger;
  private readonly correlationId: string;

  constructor(options: CoordinatorOptions = {}) {
    this.bus = options.eventBus ?? eventBus;
    this.limiter = new ConcurrencyLimiter(options.concurrency ?? DEFAULT_CONCURRENCY);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
    this.dispatchOverride = options.dispatch;
    this.agentRegistry = options.agentRegistry;
    this.paymentService = options.paymentService ?? { release: async () => 'mock-hash' };
    this.log = options.logger ?? createLogger();
    this.correlationId = options.correlationId ?? '';
  }

  async executeDAG(taskId: string, dag: DAGNode[]): Promise<void> {
    const completed = new Set<string>();
    const failed = new Set<string>();
    const scheduled = new Set<string>();
    const nodeById = new Map(dag.map(node => [node.nodeId, node]));
    let inFlight = 0;
    let settled = false;

    this.log.info({ taskId, totalNodes: dag.length }, 'DAG execution started');

    // Open a tracing span for the full DAG execution.
    const dagSpan = this.correlationId
      ? tracingService.startSpan(this.correlationId, 'coordinator', 'executeDAG', {
          taskId,
          totalNodes: dag.length,
        })
      : null;

    updateTaskIfPresent(taskId, { status: 'running' });

    await new Promise<void>(resolve => {
      const finishIfSettled = (): void => {
        if (settled || completed.size + failed.size !== dag.length) return;
        settled = true;

        const status = failed.size === 0 ? 'completed' : 'failed';
        updateTaskIfPresent(taskId, { status, dag });
        this.bus.emit(taskId, {
          type: status === 'completed' ? 'task_completed' : 'task_failed',
          taskId,
          timestamp: now(),
        });

        this.log.info(
          { taskId, status, completedCount: completed.size, failedCount: failed.size },
          'DAG execution finished'
        );

        // Close the DAG span.
        if (dagSpan) {
          tracingService.endSpan(dagSpan.spanId, status, {
            completedCount: completed.size,
            failedCount: failed.size,
          });
        }

        resolve();
      };

      const failBlockedNodes = (includeDeadlocked: boolean): void => {
        for (const node of dag) {
          if (node.status !== 'pending') {
            continue;
          }

          const hasFailedDependency = node.dependencies.some(dep => failed.has(dep));
          const hasUnresolvedDependency = node.dependencies.some(dep => !nodeById.has(dep));
          const isDeadlocked =
            includeDeadlocked &&
            inFlight === 0 &&
            !node.dependencies.every(dep => completed.has(dep));

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

          this.log.warn(
            { taskId, nodeId: node.nodeId, error: node.error },
            'node blocked by upstream failure'
          );
        }
      };

      const scheduleReadyNodes = (): void => {
        let scheduledAny = false;

        for (const node of dag) {
          if (
            node.status !== 'pending' ||
            scheduled.has(node.nodeId) ||
            !node.dependencies.every(dep => completed.has(dep))
          ) {
            continue;
          }

          scheduledAny = true;
          scheduled.add(node.nodeId);
          inFlight += 1;
          this.limiter.run(() => this.runNode(taskId, node, nodeById))
            .then(status => {
              if (status === 'completed') completed.add(node.nodeId);
              else failed.add(node.nodeId);
            })
            .catch(err => {
              console.error('[coordinator] runNode threw unexpectedly:', err);
              failed.add(node.nodeId);
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

  async dispatchNode(node: DAGNode, context: string, agent?: AgentRegistration): Promise<unknown> {
    const target = agent ?? await this.cheapestAgentFor(node.type);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    this.log.debug({ nodeId: node.nodeId, agentId: target.id, agentType: node.type }, 'dispatching node to agent');

    // Build request headers, propagating the correlation ID so the receiving
    // agent can continue the same trace.
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.correlationId) {
      headers['X-Correlation-ID'] = this.correlationId;
    }

    try {
      const response = await this.fetchImpl(`${target.endpoint.replace(/\/$/, '')}/execute`, {
        method: 'POST',
        headers,
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
      if (err instanceof NonRetryableAgentError || err instanceof RetryableAgentError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        this.log.warn({ nodeId: node.nodeId, agentId: target.id, timeoutMs: this.timeoutMs }, 'agent dispatch timed out');
        throw new RetryableAgentError(`Agent ${target.id} timed out after ${this.timeoutMs}ms`);
      }
      throw new RetryableAgentError(asErrorMessage(err));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runNode(
    taskId: string,
    node: DAGNode,
    nodeById: Map<string, DAGNode>
  ): Promise<'completed' | 'failed'> {
    node.status = 'running';
    updateNode(taskId, node.nodeId, { status: 'running' });
    this.bus.emit(taskId, {
      type: 'node_started',
      taskId,
      nodeId: node.nodeId,
      timestamp: now(),
    });

    // Open a per-node tracing span.
    const nodeSpan = this.correlationId
      ? tracingService.startSpan(this.correlationId, 'coordinator', 'node_execution', {
          taskId,
          nodeId: node.nodeId,
          agentType: node.type,
        })
      : null;

    this.log.info(
      { taskId, nodeId: node.nodeId, agentType: node.type },
      'node execution started'
    );

    try {
      const result = await this.dispatchWithRetry(taskId, node, this.contextFor(node, nodeById));

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

      this.log.info(
        { taskId, nodeId: node.nodeId, agentType: node.type },
        'node completed'
      );

      const txHash = await this.paymentService.release(taskId, node.nodeId);
      this.bus.emit(taskId, {
        type: 'payment_released',
        taskId,
        nodeId: node.nodeId,
        timestamp: now(),
        payload: { txHash },
      });

      this.log.info(
        { taskId, nodeId: node.nodeId, txHash },
        'payment released'
      );

      if (nodeSpan) tracingService.endSpan(nodeSpan.spanId, 'completed', { txHash });

      return 'completed';
    } catch (err) {
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

      this.log.error(
        { taskId, nodeId: node.nodeId, agentType: node.type, err },
        'node failed'
      );

      if (nodeSpan) tracingService.endSpan(nodeSpan.spanId, 'failed', { error: asErrorMessage(err) });

      return 'failed';
    }
  }

  private contextFor(node: DAGNode, nodeById: Map<string, DAGNode>): string {
    return node.dependencies
      .map(dep => nodeById.get(dep)?.result)
      .filter(result => result !== undefined)
      .map(result => JSON.stringify(result))
      .join('\n');
  }

  private async dispatchWithRetry(taskId: string, node: DAGNode, context: string): Promise<unknown> {
    if (this.dispatchOverride) {
      return this.dispatchOverride(taskId, node, context);
    }

    const agents = await this.agentsFor(node.type);
    const primary = agents[0];
    let lastError: unknown = new Error(`No agent registered for type: ${node.type}`);

    for (let attempt = 1; attempt <= PRIMARY_ATTEMPTS; attempt += 1) {
      try {
        return await this.dispatchNode(node, context, primary);
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) throw err;
        this.log.warn(
          { taskId, nodeId: node.nodeId, attempt, agentId: primary.id },
          'retrying dispatch after failure'
        );
      }
    }

    const fallback = agents.find(agent => agent.id !== primary.id);
    if (fallback) {
      this.log.warn(
        { taskId, nodeId: node.nodeId, primaryId: primary.id, fallbackId: fallback.id },
        'falling back to alternative agent'
      );
      try {
        return await this.dispatchNode(node, context, fallback);
      } catch (err) {
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

    const agents = sortByCost(await this.agentRegistry.getAgents(agentType)).filter(
      (agent) => agent.status === 'online'
    );
    if (agents.length === 0) {
      throw new Error(`No agent registered for type: ${agentType}`);
    }
    return agents;
  }
}

export async function executeDAG(
  task: Task,
  dispatch: DispatchFn,
  releasePayment: PaymentReleaseFn
): Promise<void> {
  const log = createLogger({ taskId: task.id, requestId: task.requestId });

  const coordinator = new Coordinator({
    dispatch,
    paymentService: { release: releasePayment },
    logger: log,
  });

  await coordinator.executeDAG(task.id, task.dag);
}

function updateTaskIfPresent(taskId: string, patch: Partial<Task>): void {
  try {
    updateTask(taskId, patch);
  } catch {
    // Unit tests can exercise the coordinator without creating a task first.
  }
}
