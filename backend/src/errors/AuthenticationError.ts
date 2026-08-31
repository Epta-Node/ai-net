import { AppError, type AppErrorDetails } from "./AppError";

/**
 * Thrown when a request cannot be authenticated (HTTP 401).
 *
 * @example
 *   throw new AuthenticationError("Missing or invalid signature");
 */
export class AuthenticationError extends AppError {
  constructor(
    message = "Authentication required",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 401, "AUTHENTICATION_ERROR", details, correlationId);
  }
}
