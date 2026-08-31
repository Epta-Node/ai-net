import { AppError, type AppErrorDetails } from "./AppError";

/**
 * Thrown when a client exceeds an allowed request rate (HTTP 429).
 *
 * @example
 *   throw new RateLimitError("Daily task limit reached", { limit: 100, window: "24h" });
 */
export class RateLimitError extends AppError {
  constructor(
    message = "Too many requests",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 429, "RATE_LIMITED", details, correlationId);
    this.name = "RateLimitError";
  }
}