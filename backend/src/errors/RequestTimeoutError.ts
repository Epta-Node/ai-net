import { AppError, type AppErrorDetails } from './AppError';

/**
 * Thrown when an operation exhausts its timeout budget (HTTP 504) (#742).
 *
 * Raised in two places:
 *  - the per-route-class budget middleware, when a request outlives its
 *    endpoint budget (`details.routeClass` / `details.budgetMs`), and
 *  - `fetchWithTimeout`, when an outbound call is aborted because its
 *    deadline elapsed (`details.url` / `details.timeoutMs`).
 *
 * Parent-signal aborts (client disconnect, task cancellation) are *not*
 * budget exhaustion and are rethrown untouched by the timeout helpers.
 *
 * @example
 *   throw new RequestTimeoutError("Request exceeded the read timeout budget of 5000ms", {
 *     routeClass: "read",
 *     budgetMs: 5000,
 *   });
 *   // → { code: "REQUEST_TIMEOUT", statusCode: 504 }
 */
export class RequestTimeoutError extends AppError {
  constructor(
    message = 'The operation exceeded its timeout budget. Please try again later.',
    details?: AppErrorDetails,
    correlationId?: string
  ) {
    super(message, 504, 'REQUEST_TIMEOUT', details, correlationId);
    this.name = 'RequestTimeoutError';
  }
}
