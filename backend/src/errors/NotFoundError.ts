import { AppError, type AppErrorDetails } from "./AppError";

/**
 * Thrown when a requested resource cannot be found (HTTP 404).
 *
 * @example
 *   throw new NotFoundError("Task", taskId);
 *   // → { code: "NOT_FOUND", message: "Task not found: task_abc123" }
 */
export class NotFoundError extends AppError {
  constructor(
    resource: string,
    id?: string,
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    const message = id
      ? `${resource} not found: ${id}`
      : `${resource} not found`;

    super(message, 404, "NOT_FOUND", details, correlationId);
    this.name = "NotFoundError";
  }
}