/**
 * Distributed tracing types for correlation ID–based end-to-end visibility.
 *
 * A **trace** is the complete record of a single logical operation (e.g. one
 * HTTP request) across all services. It is identified by a `correlationId`
 * (UUID v4 generated or propagated per request) and is composed of one or more
 * **spans**, each representing a unit of work inside a service.
 */

/** Lifecycle status of an individual span. */
export type SpanStatus = 'running' | 'completed' | 'failed';

/**
 * A single unit of work within a trace.
 *
 * - `spanId`       Unique identifier for this span (UUID v4).
 * - `correlationId` The trace this span belongs to.
 * - `service`      Name of the service that created the span (e.g. `"backend"`,
 *                  `"coordinator"`, `"payment"`).
 * - `operation`    Human-readable name of the operation (e.g. `"http_request"`,
 *                  `"executeDAG"`, `"lock"`).
 * - `startedAt`    ISO-8601 timestamp when the span was created.
 * - `endedAt`      ISO-8601 timestamp when the span was closed, if ended.
 * - `durationMs`   Wall-clock duration in milliseconds, if ended.
 * - `status`       Current lifecycle status.
 * - `metadata`     Arbitrary key/value pairs attached at start or end time.
 */
export interface TraceSpan {
  spanId: string;
  correlationId: string;
  service: string;
  operation: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: SpanStatus;
  metadata?: Record<string, unknown>;
}

/**
 * Aggregated view of all spans for a given `correlationId`.
 *
 * - `startedAt`       ISO timestamp of the earliest span.
 * - `endedAt`         ISO timestamp of the latest ended span (absent if any
 *                     span is still running).
 * - `totalDurationMs` Wall-clock time from first span start to last span end.
 */
export interface Trace {
  correlationId: string;
  spans: TraceSpan[];
  startedAt: string;
  endedAt?: string;
  totalDurationMs?: number;
}
