import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/**
 * Trace context propagated implicitly through AsyncLocalStorage.
 *
 * Every incoming request (REST or WS) seeds a TraceContext. All downstream
 * code — route handlers, coordinator, payment, logging — can read it via
 * `TraceContext.current()` without manual parameter threading.
 *
 * The `traceId` field is the top-level identifier (mapped from the existing
 * `correlationId` convention). Each service hop generates a fresh `spanId`
 * while sharing the same `traceId`, enabling end-to-end correlation.
 */
export interface TraceContextData {
  /** Top-level trace identifier (UUID v4). Maps to the existing correlationId. */
  traceId: string;
  /** Per-hop span identifier (UUID v4). Fresh for each service boundary. */
  spanId: string;
  /** Optional parent span identifier (W3C Trace Context / OpenTelemetry). */
  parentSpanId?: string;
  /** Optional request identifier for REST requests. */
  requestId?: string;
  /** Optional task identifier when processing a task. */
  taskId?: string;
}

const store = new AsyncLocalStorage<TraceContextData>();

/**
 * Run a callback inside a new trace context.
 *
 * @param context  The trace context to establish.
 * @param callback The work to run within that context.
 * @returns The callback's return value.
 */
export function runWithTraceContext<T>(context: TraceContextData, callback: () => T): T {
  return store.run(context, callback);
}

/**
 * Return the current trace context, or undefined when called outside any
 * traced execution (e.g. module-level code, background timers).
 */
export function currentTraceContext(): TraceContextData | undefined {
  return store.getStore();
}

/**
 * Convenience accessor for the current traceId.
 * Returns `undefined` when no context is active.
 */
export function currentTraceId(): string | undefined {
  return store.getStore()?.traceId;
}

/**
 * Convenience accessor for the current spanId.
 * Returns `undefined` when no context is active.
 */
export function currentSpanId(): string | undefined {
  return store.getStore()?.spanId;
}

/**
 * Update the current trace context in place (e.g. to add a taskId after the
 * context has already been established by the request middleware).
 */
export function patchTraceContext(patch: Partial<Omit<TraceContextData, 'traceId' | 'spanId'>>): void {
  const ctx = store.getStore();
  if (!ctx) return;
  if (patch.taskId !== undefined) ctx.taskId = patch.taskId;
  if (patch.requestId !== undefined) ctx.requestId = patch.requestId;
}

/**
 * Create a fresh spanId within the current trace, returning the new context
 * data without entering it — useful for dispatching work that needs its own
 * span but shares the parent traceId.
 */
export function childSpanContext(overrides?: Partial<Pick<TraceContextData, 'taskId'>>): TraceContextData | undefined {
  const parent = store.getStore();
  if (!parent) return undefined;
  return {
    traceId: parent.traceId,
    spanId: randomUUID(),
    parentSpanId: parent.spanId,
    requestId: parent.requestId,
    taskId: overrides?.taskId ?? parent.taskId,
  };
}

/**
 * W3C Trace Context helpers (#856). Our trace/span ids are UUID v4s; the W3C
 * `traceparent` header requires lowercase hex — 32 chars for the trace id and
 * 16 for the span id — so the dashes are stripped and the value is padded/
 * truncated to length. Exported for propagation into HTTP headers, payment
 * transaction memos, and OTLP payloads.
 */

/** 32-char lowercase hex trace id derived from a UUID traceId. */
export function toW3cTraceId(traceId: string): string {
  return traceId.replace(/-/g, '').toLowerCase().padStart(32, '0').slice(0, 32);
}

/** 16-char lowercase hex span id derived from a UUID spanId. */
export function toW3cSpanId(spanId: string): string {
  return spanId.replace(/-/g, '').toLowerCase().padStart(16, '0').slice(0, 16);
}

/**
 * Build a `traceparent` header value (`00-<trace-id>-<span-id>-<flags>`).
 * Flags bit 0 = sampled.
 */
export function toW3cTraceparent(
  traceId: string,
  spanId: string,
  sampled = true
): string {
  return `00-${toW3cTraceId(traceId)}-${toW3cSpanId(spanId)}-${sampled ? '01' : '00'}`;
}
