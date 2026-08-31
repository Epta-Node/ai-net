import { AppError, type AppErrorDetails } from "./AppError";

/**
 * Thrown when a request conflicts with the current state of a resource (HTTP 409).
 *
 * @example
 *   throw new ConflictError("Agent name already registered", { name: "coder-v1" });
 */
export class ConflictError extends AppError {
  constructor(
    message = "Conflict with current resource state",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 409, "CONFLICT", details, correlationId);
  }
}
