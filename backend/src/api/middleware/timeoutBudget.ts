import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getConfig } from '../../config';
import { RequestTimeoutError } from '../../errors/RequestTimeoutError';

/**
 * Per-endpoint timeout budgets (issue #742).
 *
 * Each route class gets a whole-request deadline from config:
 *
 * | Class       | Env var                        | Default | Applied to                          |
 * |-------------|--------------------------------|---------|-------------------------------------|
 * | `llm_submit`| `TIMEOUT_BUDGET_LLM_SUBMIT_MS` | 30 s    | `POST /api/tasks`                   |
 * | `read`      | `TIMEOUT_BUDGET_READ_MS`       | 5 s     | `GET` routes (health/streams exempt)|
 * | `admin`     | `TIMEOUT_BUDGET_ADMIN_MS`      | 10 s    | admin/operational routes            |
 *
 * When the budget elapses before the response completes, the request is cut
 * off with {@link RequestTimeoutError} (HTTP 504, code `REQUEST_TIMEOUT`) and
 * any late write from the still-running handler is swallowed instead of
 * throwing "headers already sent".
 */
export type TimeoutRouteClass = 'llm_submit' | 'read' | 'admin';

const BUDGET_KEYS = {
  llm_submit: 'TIMEOUT_BUDGET_LLM_SUBMIT_MS',
  read: 'TIMEOUT_BUDGET_READ_MS',
  admin: 'TIMEOUT_BUDGET_ADMIN_MS',
} as const;

/** Resolve the configured budget (ms) for a route class. */
export function budgetMsFor(routeClass: TimeoutRouteClass): number {
  return getConfig()[BUDGET_KEYS[routeClass]];
}

export interface TimeoutBudgetOptions {
  /** When set, only these HTTP methods claim the budget (e.g. `["GET"]`). */
  methods?: readonly string[];
  /** Skip the budget for these requests (long-lived streams, foreign classes). */
  exempt?: (req: Request) => boolean;
}

/**
 * After the budget has fired, replace the response's write methods with
 * pass-throughs that no-op once headers are out — so the handler that is
 * still running cannot crash the process with an unhandled
 * "Cannot set headers after they are sent" rejection.
 *
 * While `headersSent` is false the originals still run, which is what lets
 * the error handler send the 504 envelope through the same patched methods.
 */
function swallowLateWrites(res: Response): void {
  const json = res.json.bind(res);
  const send = res.send.bind(res);
  const end = res.end.bind(res);
  const write = res.write.bind(res);
  const setHeader = res.setHeader.bind(res);
  res.json = ((body: unknown) => (res.headersSent ? res : json(body))) as typeof res.json;
  res.send = ((body?: unknown) => (res.headersSent ? res : send(body as never))) as typeof res.send;
  res.end = ((...args: unknown[]) =>
    res.headersSent ? res : (end as (...a: unknown[]) => Response)(...args)) as typeof res.end;
  res.write = ((chunk: unknown, ...args: unknown[]) =>
    res.headersSent
      ? true
      : (write as (c: unknown, ...a: unknown[]) => boolean)(chunk, ...args)) as typeof res.write;
  res.setHeader = ((name: unknown, value: unknown) =>
    res.headersSent
      ? res
      : (setHeader as (n: unknown, v: unknown) => Response)(name, value)) as typeof res.setHeader;
}

/**
 * Arm a whole-request deadline for one route class.
 *
 * The timer starts when the request reaches the middleware and is cleared as
 * soon as the response finishes or the client disconnects. Long-lived
 * endpoints (SSE, health probes) are excluded by the mounting rules in
 * `app.ts`, not here.
 */
export function timeoutBudget(
  routeClass: TimeoutRouteClass,
  options: TimeoutBudgetOptions = {}
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (options.methods && !options.methods.includes(req.method)) {
      next();
      return;
    }
    if (options.exempt?.(req)) {
      next();
      return;
    }
    // One budget per request: a path covered by two mounts (e.g.
    // /api/admin/queue under /api/admin) keeps the class it claimed first.
    if (res.locals.timeoutBudgetClass !== undefined) {
      next();
      return;
    }
    res.locals.timeoutBudgetClass = routeClass;

    const budgetMs = budgetMsFor(routeClass);
    const timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;
      swallowLateWrites(res);
      next(
        new RequestTimeoutError(
          `Request exceeded the ${routeClass} timeout budget of ${budgetMs}ms`,
          { routeClass, budgetMs }
        )
      );
    }, budgetMs);

    const clear = (): void => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);

    next();
  };
}
