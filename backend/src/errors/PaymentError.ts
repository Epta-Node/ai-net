import { AppError, type AppErrorDetails } from "./AppError";

/**
 * Thrown when a Stellar payment operation fails (HTTP 402).
 *
 * @example
 *   throw new PaymentError("Insufficient XLM balance", { required: 1.5, available: 0.2 });
 */
export class PaymentError extends AppError {
  constructor(
    message = "Payment failed",
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message, 402, "PAYMENT_ERROR", details, correlationId);
  }
}
