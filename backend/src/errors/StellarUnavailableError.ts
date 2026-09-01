import { AppError, type AppErrorDetails } from "./AppError";

export class StellarUnavailableError extends AppError {
  constructor(
    message = "Stellar network unavailable",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 503, "STELLAR_UNAVAILABLE", details, correlationId);
  }
}
