import { AppError, type AppErrorDetails } from "./AppError";

export class VeniceUnavailableError extends AppError {
  constructor(
    message = "Venice API unavailable",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 503, "VENICE_UNAVAILABLE", details, correlationId);
  }
}
