// TypeScript declaration merging to add correlationId to Express Request
declare namespace Express {
  export interface Request {
    /** UUID v4 correlation ID for the request, propagated via X-Request-Id */
    correlationId?: string;
  }

  export interface Locals {
    /** API version negotiated for this request (e.g., "1.0", "1.1", "2.0") */
    apiVersion?: string;
  }
}
