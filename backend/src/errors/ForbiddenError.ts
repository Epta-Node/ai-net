import { AppError, type AppErrorDetails } from "./AppError";

export class ForbiddenError extends AppError {
  constructor(
    message = "Access denied",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 403, "FORBIDDEN", details, correlationId);
  }
}
