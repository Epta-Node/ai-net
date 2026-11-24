import { AppError, type AppErrorDetails } from "./AppError";

export class UnauthorizedError extends AppError {
  constructor(
    message = "Unauthorized",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 401, "UNAUTHORIZED", details, correlationId);
    this.name = "UnauthorizedError";
  }
}
