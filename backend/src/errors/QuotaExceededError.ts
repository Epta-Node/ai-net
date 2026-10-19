import { AppError, type AppErrorDetails } from './AppError';

/**
 * Thrown when a per-wallet daily quota is exhausted (HTTP 429, `QUOTA_EXCEEDED`).
 *
 * Distinct from {@link RateLimitError}: a rate limit is about request *rate*,
 * while this error is about a daily *budget* — tasks or Venice tokens — that
 * resets at a known time, which is why it carries `retryAfterSeconds` so the
 * error handler can emit a `Retry-After` header clients can honour.
 *
 * @example
 *   throw new QuotaExceededError("Venice token quota reached", {
 *     resource: "tokens",
 *     used: 100_000,
 *     limit: 100_000,
 *     retryAfterSeconds: 3_600,
 *   });
 */
export class QuotaExceededError extends AppError {
  /** Seconds until the quota window resets; drives the `Retry-After` header. */
  readonly retryAfterSeconds: number;

  constructor(
    message = 'Wallet quota exhausted',
    details?: AppErrorDetails & { retryAfterSeconds?: number },
    correlationId?: string
  ) {
    super(message, 429, 'QUOTA_EXCEEDED', details, correlationId);
    this.name = 'QuotaExceededError';
    const seconds = details?.retryAfterSeconds;
    this.retryAfterSeconds =
      typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
        ? Math.ceil(seconds)
        : 3_600;
  }
}
