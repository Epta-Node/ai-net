// TypeScript declaration merging to add correlationId to Express Request
declare namespace Express {
  export interface Request {
    /** Per-hop request ID, propagated via X-Request-Id. */
    requestId?: string;
    /** End-to-end trace ID, propagated via X-Trace-Id. */
    traceId?: string;
    /** Backward-compatible alias for traceId. */
    correlationId?: string;
  }

  export interface Locals {
    requestId?: string;
    traceId?: string;
    correlationId?: string;
    logContext?: Record<string, unknown>;
    /** API version negotiated for this request (e.g., "1.0", "1.1", "2.0") */
    apiVersion?: string;
  }
}
