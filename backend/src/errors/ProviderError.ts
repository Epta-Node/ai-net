import { AppError, type AppErrorDetails } from "./AppError";

/**
 * Thrown when an upstream AI/Venice provider returns an error (HTTP 502).
 *
 * Sub-codes differentiate timeout vs. provider rate-limit vs. generic failure
 * so callers can apply the right retry strategy without string-matching messages.
 *
 * @example
 *   throw new ProviderError("Venice returned 503", "PROVIDER_ERROR", { provider: "venice", retryAfter: 30 });
 *   throw new ProviderError("Venice timed out", "PROVIDER_TIMEOUT");
 */
export class ProviderError extends AppError {
  constructor(
    message = "An upstream AI provider returned an error",
    subCode: "PROVIDER_ERROR" | "PROVIDER_TIMEOUT" | "PROVIDER_RATE_LIMITED" = "PROVIDER_ERROR",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    const statusCode =
      subCode === "PROVIDER_TIMEOUT"
        ? 504
        : subCode === "PROVIDER_RATE_LIMITED"
          ? 429
          : 502;
    super(message, statusCode, subCode, details, correlationId);
  }
}
