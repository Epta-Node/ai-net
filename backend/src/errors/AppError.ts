import { randomUUID } from "crypto";

export interface AppErrorDetails {
  [key: string]: unknown;
}

export interface SerializedError {
  code: string;
  message: string;
  details?: AppErrorDetails;
  correlationId: string;
  timestamp: string;
}

/**
 * Base error class for all application errors.
 *
 * All AppError instances carry:
 *  - `code`          – machine-readable error code (e.g. "NOT_FOUND")
 *  - `statusCode`    – HTTP status code
 *  - `details`       – optional structured details (omitted from prod responses)
 *  - `correlationId` – links this error to the originating request trace
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: AppErrorDetails;
  public readonly correlationId: string;
  public readonly timestamp: string;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    details?: AppErrorDetails,
    correlationId?: string,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    this.details = details;
    this.correlationId = correlationId ?? randomUUID();
    this.timestamp = new Date().toISOString();

    // Restore correct prototype chain when transpiled to ES5
    Object.setPrototypeOf(this, new.target.prototype);

    // Capture a clean stack trace that starts at the call site
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Returns the sanitized shape sent to clients.
   *
   * In production `details` is omitted so internal information is never
   * leaked. Pass `includeDetails: true` only in development/test.
   */
  public serialize(includeDetails = false): SerializedError {
    const payload: SerializedError = {
      code: this.code,
      message: this.message,
      correlationId: this.correlationId,
      timestamp: this.timestamp,
    };

    if (includeDetails && this.details !== undefined) {
      payload.details = this.details;
    }

    return payload;
  }
}