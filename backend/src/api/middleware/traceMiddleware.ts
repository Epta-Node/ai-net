/**
 * TraceMiddleware — extracts W3C `traceparent`/`tracestate` headers from each
 * inbound request and attaches the extracted context to the current active
 * span so all child spans share the same traceId.
 *
 * Issue #998
 */

import type { Request, Response, NextFunction } from "express";
import { context, propagation, trace, SpanStatusCode } from "@opentelemetry/api";

export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Extract W3C Trace Context from inbound headers.
  const parentCtx = propagation.extract(context.active(), req.headers);

  // Start a root span for this request and run the rest of the chain inside it.
  const tracer = trace.getTracer("ai-net-backend");
  const span = tracer.startSpan(
    `${req.method} ${req.path}`,
    undefined,
    parentCtx,
  );

  // Attach the span to the active context for all downstream instrumentation.
  context.with(trace.setSpan(parentCtx, span), () => {
    // Annotate with basic HTTP attributes.
    span.setAttribute("http.method", req.method);
    span.setAttribute("http.url", req.originalUrl ?? req.url);
    span.setAttribute("http.route", req.path);

    // Inject traceparent back into the response so callers can correlate.
    const responseHeaders: Record<string, string> = {};
    propagation.inject(context.active(), responseHeaders);
    if (responseHeaders["traceparent"]) {
      res.setHeader("traceparent", responseHeaders["traceparent"]);
    }

    res.on("finish", () => {
      span.setAttribute("http.status_code", res.statusCode);
      if (res.statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    });

    next();
  });
}
