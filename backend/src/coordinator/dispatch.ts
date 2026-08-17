/**
 * HTTP dispatch layer for the coordinator.
 *
 * Sends a DAG node to a remote agent endpoint via HTTP POST and returns the
 * parsed JSON response.  Retries on transient/5xx errors using exponential
 * back-off; gives up after `maxRetries` attempts and rethrows the last error.
 *
 * Implements the real HTTP dispatch required by issue #169:
 * replaces the `defaultDispatch` stub that always threw, restoring the full
 * agent coordination pipeline.  Timeout, retry behaviour, and agent endpoint
 * resolution are all configurable via {@link DispatchOptions}.
 */

import type { AgentRegistration } from '../types/agent';
import type { DAGNode } from '../types/task';

export interface DispatchOptions {
  /** Maximum time (ms) to wait for a single HTTP request before aborting */
  timeoutMs: number;
  /** Number of retry attempts after the initial attempt (total = maxRetries + 1) */
  maxRetries: number;
  /** Base delay (ms) between retries; actual delay is retryDelayMs * 2^attempt */
  retryDelayMs: number;
}

export const DEFAULT_DISPATCH_OPTIONS: DispatchOptions = {
  timeoutMs: 60_000,
  maxRetries: 3,
  retryDelayMs: 1_000,
};

/**
 * Status codes that are worth retrying. 5xx = server-side transient errors,
 * 429 = rate-limited.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Dispatch a DAG node to an agent via HTTP POST with timeout and retry logic.
 *
 * @param agent   - Agent registration containing the endpoint URL.
 * @param nodeId  - ID of the DAG node being dispatched (used for logging).
 * @param node    - Full DAGNode payload forwarded to the agent.
 * @param context - Serialised upstream results passed as additional context.
 * @param options - Overrides for timeout / retry behaviour.
 * @param fetchImpl - Injectable `fetch` implementation (defaults to global).
 */
export async function httpDispatch(
  agent: AgentRegistration,
  nodeId: string,
  node: DAGNode,
  context: string,
  options: DispatchOptions = DEFAULT_DISPATCH_OPTIONS,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const url = `${agent.endpoint.replace(/\/$/, '')}/execute`;
  let lastError: Error = new Error(`Dispatch to agent ${agent.id} failed before first attempt`);

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId, node, context }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (isRetryableStatus(response.status)) {
        lastError = new Error(
          `Agent ${agent.id} returned ${response.status}: ${response.statusText}`,
        );
        // Fall through to retry logic below.
      } else if (!response.ok) {
        // 4xx (except 429) — not retryable, fail immediately.
        throw new Error(
          `Agent ${agent.id} returned non-retryable ${response.status}: ${response.statusText}`,
        );
      } else {
        const text = await response.text();
        return text ? (JSON.parse(text) as unknown) : {};
      }
    } catch (err) {
      clearTimeout(timer);

      if (err instanceof Error && err.name === 'AbortError') {
        lastError = new Error(
          `Agent ${agent.id} timed out after ${options.timeoutMs}ms (node: ${nodeId})`,
        );
      } else if (
        err instanceof Error &&
        !err.message.startsWith('Agent ') // already our own error
      ) {
        // Network-level errors (ECONNREFUSED, etc.) are retryable.
        lastError = err;
      } else if (err instanceof Error) {
        // Preserve errors we already constructed above or non-retryable 4xx.
        const isNonRetryable =
          err.message.includes('non-retryable') || err.message.includes('returned non-retryable');
        if (isNonRetryable) throw err;
        lastError = err;
      } else {
        lastError = new Error(String(err));
      }
    }

    // Don't sleep after the last attempt.
    if (attempt < options.maxRetries) {
      const delay = options.retryDelayMs * Math.pow(2, attempt);
      await new Promise<void>(r => setTimeout(r, delay));
    }
  }

  throw lastError;
}
