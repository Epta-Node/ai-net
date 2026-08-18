// TypeScript declaration merging to add correlationId to Express Request
declare namespace Express {
  export interface Request {
    /** UUID v4 correlation ID for the request, propagated via X-Request-Id */
    correlationId?: string;
  }
}
