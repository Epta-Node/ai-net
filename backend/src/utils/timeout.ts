import { RequestTimeoutError } from '../errors/RequestTimeoutError';

/**
 * Deadline helpers for outbound calls and per-endpoint request budgets (#742).
 *
 * Every outbound `fetch` must carry an abort path so a hung upstream can never
 * pin a request slot or worker thread. Call sites wrap their call with
 * {@link fetchWithTimeout} (or {@link withTimeout} directly when they need the
 * signal for something other than fetch), passing any caller-supplied signal
 * through so cancellation (client disconnect, task abort) still works.
 *
 * Budget exhaustion is a *typed* failure: it throws {@link RequestTimeoutError}
 * (HTTP 504, code `REQUEST_TIMEOUT`). Aborts that originate from the parent
 * signal are not budget exhaustion and are rethrown untouched.
 *
 * Timers are hand-rolled `setTimeout`/`clearTimeout` pairs rather than
 * `AbortSignal.timeout` so they remain controllable under Jest fake timers.
 */

export interface TimeoutGuard {
  /** Combined signal to pass to `fetch`/any abortable operation. */
  readonly signal: AbortSignal;
  /** `true` when this guard aborted the operation because the budget elapsed. */
  didTimeout(): boolean;
  /** Release the budget timer and parent listener. Idempotent. */
  dispose(): void;
}

/**
 * Abort `signal` (if any) or after `timeoutMs`, whichever comes first.
 *
 * `timeoutMs <= 0` disables the budget (the guard only mirrors the parent).
 * The returned guard must be disposed once the operation settles so the
 * timer cannot outlive it.
 *
 * @example
 *   const guard = withTimeout(req.signal, 5_000);
 *   try {
 *     const res = await fetch(url, { signal: guard.signal });
 *   } finally {
 *     guard.dispose();
 *   }
 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): TimeoutGuard {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onTimeout = (): void => {
    timedOut = true;
    controller.abort(new DOMException(`Operation timed out after ${timeoutMs}ms`, 'TimeoutError'));
  };

  const onParentAbort = (): void => {
    controller.abort(signal?.reason);
  };

  if (timeoutMs > 0) {
    timer = setTimeout(onTimeout, timeoutMs);
  }

  if (signal) {
    if (signal.aborted) {
      // Already cancelled: mirror it and skip the budget timer entirely.
      if (timer !== undefined) clearTimeout(timer);
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const dispose = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    signal?.removeEventListener('abort', onParentAbort);
  };

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose,
  };
}

/** `true` when `err` is a timeout abort (as thrown by the guard's timer). */
export function isTimeoutAbort(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError'
  );
}

/**
 * `fetch` bounded by `timeoutMs`, chaining `parentSignal` (or `init.signal`)
 * so caller-side cancellation still wins over the budget.
 *
 * @throws {RequestTimeoutError} when the budget elapses before the response
 *         settles (HTTP 504, code `REQUEST_TIMEOUT`).
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit | undefined,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<Response> {
  const guard = withTimeout(parentSignal ?? init?.signal ?? undefined, timeoutMs);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return await fetch(input, { ...init, signal: guard.signal });
  } catch (err) {
    if (guard.didTimeout()) {
      throw new RequestTimeoutError(`Outbound request timed out after ${timeoutMs}ms`, {
        url,
        timeoutMs,
      });
    }
    throw err;
  } finally {
    guard.dispose();
  }
}
