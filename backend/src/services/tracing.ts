import { randomUUID } from 'crypto';
import type { SpanStatus, Trace, TraceSpan } from './tracing.types';
import { toW3cTraceId, toW3cSpanId } from './traceContext';

/**
 * In-memory distributed tracing service.
 *
 * Spans are keyed both by `correlationId` (to retrieve a full trace) and by
 * `spanId` (to update individual spans after they are created). The store is
 * intentionally kept in-memory: no persistence dependency is added, and the
 * service can be imported without any setup.
 *
 * Sampling & export (#856):
 * - `OTEL_SAMPLING_RATE` (default `1`) controls what fraction of spans land in
 *   the queryable trace store. Unsampled spans are still tracked by `spanId`
 *   until they end, so an ending span with `status === 'failed'` is promoted
 *   into its trace retroactively — errors are never sampled away.
 * - When `OTEL_EXPORTER_ENDPOINT` is set, every ended span is shipped as
 *   OTLP/HTTP JSON to `${endpoint}/v1/traces` (fire-and-forget; export
 *   failures are swallowed so tracing can never break the request path).
 *
 * Both knobs are read from `process.env` on each use so tests and config
 * reloads take effect without re-instantiating the singleton.
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

  /** Tertiary index: requestId → correlationId for admin lookup by requestId. */
  private readonly requestIndex = new Map<string, string>();

  /** Spans that were sampled into the trace store (vs. held for the error-promotion path). */
  private readonly keptSpanIds = new Set<string>();

  /** Sample rate in [0, 1], read lazily from OTEL_SAMPLING_RATE. */
  private get sampleRate(): number {
    const raw = process.env.OTEL_SAMPLING_RATE;
    if (raw === undefined || raw === '') return 1;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(1, Math.max(0, parsed));
  }

  /** OTLP collector base URL, read lazily from OTEL_EXPORTER_ENDPOINT. */
  private get exporterEndpoint(): string | undefined {
    const raw = process.env.OTEL_EXPORTER_ENDPOINT?.trim();
    if (!raw) return undefined;
    try {
      return new URL(raw).toString().replace(/\/$/, '');
    } catch {
      return undefined;
    }
  }

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

    // Sampling decision at span start. Unsampled spans skip the trace bucket
    // but stay in spanIndex so endSpan can promote them if they fail.
    const sampled =
      this.sampleRate >= 1
        ? true
        : this.sampleRate <= 0
          ? false
          : Math.random() < this.sampleRate;

    // Add to trace bucket.
    if (sampled) {
      const bucket = this.traces.get(correlationId);
      if (bucket) {
        bucket.push(span);
      } else {
        this.traces.set(correlationId, [span]);
      }
      this.keptSpanIds.add(span.spanId);
    }

    // Index by spanId for O(1) endSpan lookups.
    this.spanIndex.set(span.spanId, span);

    // Index requestId → correlationId when present, so admins can query
    // traces by requestId.
    if (metadata?.requestId && typeof metadata.requestId === 'string') {
      this.requestIndex.set(metadata.requestId, correlationId);
    }

    return span;
  }

  /**
   * End a span by its `spanId`, recording its final status and optional
   * additional metadata.
   *
   * If `spanId` is unknown (e.g. the service restarted), the call is silently
   * ignored so callers never need to guard against stale span IDs.
   *
   * Spans dropped by sampling are promoted into their trace on failure and
   * fully discarded on success. Every ended span is exported to the OTLP
   * endpoint when one is configured.
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

    if (!this.keptSpanIds.has(span.spanId)) {
      if (status === 'failed') {
        // Error spans are always sampled: promote retroactively so failure
        // traces are queryable even at OTEL_SAMPLING_RATE=0.
        const bucket = this.traces.get(span.correlationId);
        if (bucket) {
          bucket.push(span);
        } else {
          this.traces.set(span.correlationId, [span]);
        }
        this.keptSpanIds.add(span.spanId);
      } else {
        // Unsampled success: drop it so the indexes do not grow unbounded.
        this.spanIndex.delete(span.spanId);
        if (span.metadata?.requestId && typeof span.metadata.requestId === 'string') {
          this.requestIndex.delete(span.metadata.requestId);
        }
        return;
      }
    }

    this.exportSpan(span);
  }

  /**
   * Ship a finished span to the configured OTLP/HTTP collector as a single
   * span resource payload. Fire-and-forget: export problems are swallowed so
   * observability can never fail application work.
   */
  private exportSpan(span: TraceSpan): void {
    const endpoint = this.exporterEndpoint;
    if (!endpoint) return;

    const startNs = BigInt(Date.parse(span.startedAt)) * 1_000_000n;
    const endNs = BigInt(Date.parse(span.endedAt ?? span.startedAt)) * 1_000_000n;

    const attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }> = [];
    for (const [key, value] of Object.entries(span.metadata ?? {})) {
      if (typeof value === 'string') {
        attributes.push({ key, value: { stringValue: value } });
      } else if (typeof value === 'number') {
        attributes.push({ key, value: { intValue: String(Math.trunc(value)) } });
      } else if (typeof value === 'boolean') {
        attributes.push({ key, value: { boolValue: value } });
      } else {
        attributes.push({ key, value: { stringValue: JSON.stringify(value) } });
      }
    }
    attributes.push({ key: 'service.name', value: { stringValue: span.service } });

    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: span.service } }] },
          scopeSpans: [
            {
              scope: { name: 'ai-net.tracing' },
              spans: [
                {
                  traceId: toW3cTraceId(span.correlationId),
                  spanId: toW3cSpanId(span.spanId),
                  name: span.operation,
                  kind: 1, // SPAN_KIND_INTERNAL
                  startTimeUnixNano: startNs.toString(),
                  endTimeUnixNano: endNs.toString(),
                  attributes,
                  status: {
                    code: span.status === 'failed' ? 2 : 1, // STATUS_CODE_ERROR / OK
                    ...(span.status === 'failed' ? { message: 'span failed' } : {}),
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    void fetch(`${endpoint}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {
      /* export is best-effort */
    });
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
        this.keptSpanIds.delete(span.spanId);
        if (span.metadata?.requestId && typeof span.metadata.requestId === 'string') {
          this.requestIndex.delete(span.metadata.requestId);
        }
      }
      this.traces.delete(correlationId);
    }
  }

  /**
   * Resolve a requestId to its correlationId (trace ID).
   * Returns undefined when no span with that requestId has been recorded.
   */
  resolveRequestId(requestId: string): string | undefined {
    return this.requestIndex.get(requestId);
  }

  /** Total number of active trace buckets (useful for monitoring). */
  get size(): number {
    return this.traces.size;
  }
}

/** Singleton tracing service — import this across the app. */
export const tracingService = new TracingService();
