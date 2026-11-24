/** Outbound propagation helpers for request/trace IDs (#903). */
import { randomUUID } from 'crypto';
import { runWithTraceContext, toW3cTraceparent } from './traceContext';
import {
  currentPropagationHeaders,
  propagationHeaders,
  tracingService,
} from './tracing';

describe('request propagation headers (#903)', () => {
  const traceId = randomUUID();
  const spanId = randomUUID();

  it('emits the request ID, trace ID and W3C traceparent', () => {
    expect(propagationHeaders({ traceId, spanId, requestId: 'req-903' })).toEqual({
      traceparent: toW3cTraceparent(traceId, spanId),
      'x-request-id': 'req-903',
      'x-trace-id': traceId,
      'x-correlation-id': traceId,
    });
  });

  it('falls back to the trace ID when no request ID is available', () => {
    expect(propagationHeaders({ traceId, spanId })['x-request-id']).toBe(traceId);
  });

  it('reads the active request context and is empty outside one', () => {
    expect(currentPropagationHeaders()).toBeUndefined();
    runWithTraceContext({ traceId, spanId, requestId: 'req-903-ctx' }, () => {
      expect(currentPropagationHeaders()?.['x-request-id']).toBe('req-903-ctx');
    });
  });

  it('indexes downstream spans by the inherited request ID', () => {
    const downstreamTraceId = randomUUID();
    let spanIdOfDownstream = '';
    runWithTraceContext(
      { traceId: downstreamTraceId, spanId, requestId: 'req-903-span' },
      () => {
        spanIdOfDownstream = tracingService.startSpan(
          downstreamTraceId,
          'venice',
          'chat_completion',
        ).spanId;
      },
    );

    expect(tracingService.resolveRequestId('req-903-span')).toBe(downstreamTraceId);
    expect(
      tracingService.getTrace(downstreamTraceId)?.spans.find((s) => s.spanId === spanIdOfDownstream)
        ?.metadata?.requestId,
    ).toBe('req-903-span');
    tracingService.clearTrace(downstreamTraceId);
  });
});
