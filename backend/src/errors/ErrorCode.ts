/**
 * Machine-readable error code registry (#424).
 *
 * Every code maps 1-to-1 with an error class. Frontend SDKs and API consumers
 * should switch on `error.code` — never on `error.message`.
 */
export const ErrorCode = {
  // ── Validation ─────────────────────────────────────────────────────────────
  VALIDATION_ERROR: "VALIDATION_ERROR",

  // ── Resource lookup ────────────────────────────────────────────────────────
  NOT_FOUND: "NOT_FOUND",

  // ── State conflicts ────────────────────────────────────────────────────────
  CONFLICT: "CONFLICT",

  // ── Auth ───────────────────────────────────────────────────────────────────
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",

  // ── Rate limiting ──────────────────────────────────────────────────────────
  RATE_LIMITED: "RATE_LIMITED",

  // ── Payment / Stellar ─────────────────────────────────────────────────────
  PAYMENT_ERROR: "PAYMENT_ERROR",
  STELLAR_UNAVAILABLE: "STELLAR_UNAVAILABLE",

  // ── Upstream AI/provider ──────────────────────────────────────────────────
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  VENICE_UNAVAILABLE: "VENICE_UNAVAILABLE",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",

  // ── Server internals ───────────────────────────────────────────────────────
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UNSUPPORTED_API_VERSION: "UNSUPPORTED_API_VERSION",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Default HTTP status code for each error code.
 * Used by the error handler to set the response status when an unknown error
 * wraps a known code string.
 */
export const HTTP_STATUS_FOR_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  PAYMENT_ERROR: 402,
  STELLAR_UNAVAILABLE: 503,
  UPSTREAM_UNAVAILABLE: 502,
  VENICE_UNAVAILABLE: 503,
  PROVIDER_ERROR: 502,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UNSUPPORTED_API_VERSION: 400,
};

/**
 * Locale-neutral default messages for each code.
 * Override per-instance via the constructor `message` argument.
 */
export const DEFAULT_MESSAGE_FOR_CODE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: "Request input is invalid.",
  NOT_FOUND: "The requested resource was not found.",
  CONFLICT: "The request conflicts with the current state of the resource.",
  UNAUTHORIZED: "Authentication required.",
  FORBIDDEN: "You do not have permission to perform this action.",
  RATE_LIMITED: "Too many requests. Please slow down.",
  PAYMENT_ERROR: "Payment operation failed.",
  STELLAR_UNAVAILABLE: "Stellar network unavailable.",
  UPSTREAM_UNAVAILABLE: "An upstream service is unavailable.",
  VENICE_UNAVAILABLE: "Venice API unavailable.",
  PROVIDER_ERROR: "An upstream AI provider returned an error.",
  PROVIDER_TIMEOUT: "The AI provider did not respond in time.",
  PROVIDER_RATE_LIMITED: "The AI provider is currently rate-limiting requests.",
  INTERNAL_ERROR: "An unexpected error occurred. Please try again later.",
  UNSUPPORTED_API_VERSION: "The requested API version is not supported.",
};
