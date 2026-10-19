/**
 * Process-wide counters for the task event SSE stream (issue #813).
 *
 * Plain in-memory counters, following the same approach as
 * `reconciliation.metrics.ts`: they reset on restart by design and are read by
 * the Prometheus collector in `prometheus.ts`.
 *
 * • `sse_active_connections`          — gauge of open task event streams
 * • `sse_events_sent_total`           — events written to a client
 * • `sse_events_dropped_total`        — events dropped by backpressure
 * • `sse_connections_timed_out_total` — streams closed for a stalled client
 */

export interface SseMetricsSnapshot {
  activeConnections: number;
  eventsSent: number;
  eventsDropped: number;
  connectionsTimedOut: number;
}

let activeConnections = 0;
let eventsSent = 0;
let eventsDropped = 0;
let connectionsTimedOut = 0;

/** A stream was opened. */
export function recordSseConnectionOpened(): void {
  activeConnections += 1;
}

/** A stream was closed, by the client, the task finishing, or a stall timeout. */
export function recordSseConnectionClosed(): void {
  activeConnections = Math.max(0, activeConnections - 1);
}

/** One task event was written to a client. */
export function recordSseEventSent(): void {
  eventsSent += 1;
}

/** One task event was dropped because the client's write buffer was over the high-water mark. */
export function recordSseEventDropped(): void {
  eventsDropped += 1;
}

/** A stream was closed with `stream_timeout` because the client stopped accepting writes. */
export function recordSseConnectionTimedOut(): void {
  connectionsTimedOut += 1;
}

/** Current value of every SSE counter. */
export function getSseMetricsSnapshot(): SseMetricsSnapshot {
  return { activeConnections, eventsSent, eventsDropped, connectionsTimedOut };
}

/** Reset every counter (test helper). */
export function resetSseMetrics(): void {
  activeConnections = 0;
  eventsSent = 0;
  eventsDropped = 0;
  connectionsTimedOut = 0;
}
