import { AppError, type AppErrorDetails } from "./AppError";

export class ConflictError extends AppError {
  constructor(
    message = "Conflict",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 409, "CONFLICT", details, correlationId);
  }
}
