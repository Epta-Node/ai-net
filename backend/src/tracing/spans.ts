/**
 * Lightweight tracing helpers used throughout the backend.
 *
 * These wrappers keep tracing concerns out of business logic by providing
 * one-liner span creation for the coordinator and payment layer.
 *
 * Issue #998
 */

import { trace, context, SpanStatusCode, type Span } from "@opentelemetry/api";

const tracer = trace.getTracer("ai-net-backend");

/**
 * Wraps an async operation in a named OTel span.
 *
 * @param name   Span name (e.g. `coordinator.node.node-1`)
 * @param attrs  Initial span attributes
 * @param fn     The async work to run inside the span
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, { attributes: attrs });
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wraps a coordinator DAG node execution in a child span named
 * `coordinator.node.<nodeId>`.
 */
export async function withNodeSpan<T>(
  nodeId: string,
  agentType: string,
  agentEndpoint: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(
    `coordinator.node.${nodeId}`,
    { nodeId, agentType, agentEndpoint },
    fn,
  );
}

/**
 * Wraps a PaymentService operation in a child span named
 * `payment.<operation>`.
 */
export async function withPaymentSpan<T>(
  operation: "lock" | "release" | "refund",
  taskId: string,
  nodeId: string,
  amountXLM: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`payment.${operation}`, { taskId, nodeId, amountXLM }, fn);
}
