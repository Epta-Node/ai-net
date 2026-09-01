import { AppError, type AppErrorDetails } from "./AppError";

/**
 * Thrown when request input fails validation (HTTP 400).
 *
 * @example
 *   throw new ValidationError("Invalid prompt", { field: "prompt", reason: "too long" });
 */
export class ValidationError extends AppError {
  constructor(
    message: string,
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 400, "VALIDATION_ERROR", details, correlationId);
    this.name = "ValidationError";
  }
}