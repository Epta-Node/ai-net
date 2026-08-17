import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../../utils/logger";

const log = createLogger();

const isDevelopment = process.env.NODE_ENV === "development";

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode: number = err.statusCode || 500;

  // Always log the full error server-side for observability
  log.error(
    {
      err,
      requestId: res.locals.requestId,
      path: req.path,
      method: req.method,
    },
    "unhandled error",
  );

  // Build the sanitized response sent to the client
  const response: Record<string, unknown> = {
    statusCode,
    path: req.path,
    requestId: res.locals.requestId,
  };

  if (isDevelopment) {
    // Development: include full details to aid debugging
    response.error = err.message;
    response.stack = err.stack;
  } else {
    // Production: generic message — never expose internals
    response.error = err.code || "INTERNAL_SERVER_ERROR";
    response.message = "An unexpected error occurred. Please try again later.";
  }

  res.status(statusCode).json(response);
}
