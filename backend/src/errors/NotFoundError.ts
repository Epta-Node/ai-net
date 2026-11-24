import { AppError, type AppErrorDetails } from "./AppError";

/**
 * Thrown when a requested resource cannot be found (HTTP 404).
 *
 * The id is quoted so it is visually distinct from the resource name, and the
 * no-id form stays a plain sentence — both shapes are asserted by the error and
 * route suites.
 *
 * @example
 *   throw new NotFoundError("Task", taskId);
 *   // → { code: "NOT_FOUND", message: "Task 'task_abc123' not found" }
 */
export class NotFoundError extends AppError {
  constructor(
    resource: string,
    id?: string,
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    const message = id
      ? `${resource} '${id}' not found`
      : `${resource} not found`;

    super(message, 404, "NOT_FOUND", details, correlationId);
    this.name = "NotFoundError";
  }
}