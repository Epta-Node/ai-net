import { AppError, type AppErrorDetails } from "./AppError";

export class UpstreamUnavailableError extends AppError {
  constructor(
    message = "Upstream service unavailable",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 502, "UPSTREAM_UNAVAILABLE", details, correlationId);
  }
}
