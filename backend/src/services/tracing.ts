import { randomUUID } from 'crypto';
import type { SpanStatus, Trace, TraceSpan } from './tracing.types';

/**
 * In-memory distributed tracing service.
 *
 * Spans are keyed both by `correlationId` (to retrieve a full trace) and by
 * `spanId` (to update individual spans after they are created). The store is
 * intentionally kept in-memory: no persistence dependency is added, and the
 * service can be imported without any setup.
 *
 * Usage:
 * ```typescript
 * const span = tracingService.startSpan(correlationId, 'coordinator', 'executeDAG', { taskId });
 * // ... do work ...
 * tracingService.endSpan(span.spanId, 'completed', { resultNodes: 5 });
 *
 * const trace = tracingService.getTrace(correlationId);
 * ```
 */
export class TracingService {
  /** Primary store: correlationId → list of spans for that trace. */
  private readonly traces = new Map<string, TraceSpan[]>();

  /** Secondary index: spanId → span object (same reference as in `traces`). */
  private readonly spanIndex = new Map<string, TraceSpan>();

  /**
   * Start a new span and associate it with `correlationId`.
   *
   * @returns The newly created span (status `'running'`, `startedAt` = now).
   */
  startSpan(
    correlationId: string,
    service: string,
    operation: string,
    metadata?: Record<string, unknown>
  ): TraceSpan {
    const span: TraceSpan = {
      spanId: randomUUID(),
      correlationId,
      service,
      operation,
      startedAt: new Date().toISOString(),
      status: 'running',
      ...(metadata !== undefined ? { metadata: { ...metadata } } : {}),
    };

    // Add to trace bucket.
    const bucket = this.traces.get(correlationId);
    if (bucket) {
      bucket.push(span);
    } else {
      this.traces.set(correlationId, [span]);
    }

    // Index by spanId for O(1) endSpan lookups.
    this.spanIndex.set(span.spanId, span);

    return span;
  }

  /**
   * End a span by its `spanId`, recording its final status and optional
   * additional metadata.
   *
   * If `spanId` is unknown (e.g. the service restarted), the call is silently
   * ignored so callers never need to guard against stale span IDs.
   */
  endSpan(
    spanId: string,
    status: SpanStatus,
    metadata?: Record<string, unknown>
  ): void {
    const span = this.spanIndex.get(spanId);
    if (!span) return;

    const endedAt = new Date().toISOString();
    span.endedAt = endedAt;
    span.durationMs = Date.parse(endedAt) - Date.parse(span.startedAt);
    span.status = status;

    if (metadata !== undefined) {
      span.metadata = { ...span.metadata, ...metadata };
    }
  }

  /**
   * Retrieve the full trace for `correlationId`, or `undefined` if no spans
   * have been recorded for it.
   *
   * The returned `Trace`:
   * - `startedAt`       = earliest span's `startedAt`
   * - `endedAt`         = latest `endedAt` among all ended spans (absent if any
   *                       span is still `'running'`)
   * - `totalDurationMs` = `endedAt - startedAt` (absent if `endedAt` is absent)
   */
  getTrace(correlationId: string): Trace | undefined {
    const spans = this.traces.get(correlationId);
    if (!spans || spans.length === 0) return undefined;

    const startedAt = spans[0].startedAt;

    // Only compute endedAt / totalDurationMs when every span has finished.
    const allEnded = spans.every((s) => s.endedAt !== undefined);
    let endedAt: string | undefined;
    let totalDurationMs: number | undefined;

    if (allEnded) {
      // Latest endedAt timestamp among all spans.
      endedAt = spans.reduce((latest, s) => {
        return s.endedAt! > latest ? s.endedAt! : latest;
      }, spans[0].endedAt!);

      totalDurationMs = Date.parse(endedAt) - Date.parse(startedAt);
    }

    return {
      correlationId,
      spans: [...spans],
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
    };
  }

  /**
   * Remove all trace data for `correlationId`.
   * Useful in tests to reset state between cases.
   */
  clearTrace(correlationId: string): void {
    const spans = this.traces.get(correlationId);
    if (spans) {
      for (const span of spans) {
        this.spanIndex.delete(span.spanId);
      }
      this.traces.delete(correlationId);
    }
  }

  /** Total number of active trace buckets (useful for monitoring). */
  get size(): number {
    return this.traces.size;
  }
}

/** Singleton tracing service — import this across the app. */
export const tracingService = new TracingService();
