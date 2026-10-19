/**
 * Minimal W3C Trace Context propagation for the browser (#856).
 *
 * A page session holds one trace id (generated once) and a span id that is
 * rotated whenever `rotateSpan()` is called (e.g. on route transitions), so
 * every API request carries a `traceparent` header the backend already parses
 * in its request-id middleware. No dependency — the ids are 32/16-char
 * lowercase hex, which is all `traceparent` requires.
 */

interface TraceIds {
  traceId: string;
  spanId: string;
}

let current: TraceIds | null = null;

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function ids(): TraceIds {
  if (!current) {
    current = { traceId: randomHex(16), spanId: randomHex(8) };
  }
  return current;
}

/** W3C `traceparent` value for the current page session. */
export function getTraceparent(): string {
  const { traceId, spanId } = ids();
  return `00-${traceId}-${spanId}-01`;
}

/** Current trace id (32-char hex). */
export function getTraceId(): string {
  return ids().traceId;
}

/**
 * Start a new span within the same trace — call on navigation so each page
 * view is its own span under one session trace.
 */
export function rotateSpan(): void {
  ids().spanId = randomHex(8);
}

/** Test/session helper: drop the current ids so the next call regenerates them. */
export function resetTraceContext(): void {
  current = null;
}
