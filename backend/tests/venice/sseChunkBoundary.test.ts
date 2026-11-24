/**
 * Venice SSE chunk-boundary handling (issue #660).
 *
 * The stream consumer used to decode each chunk and split it on `\n` in
 * isolation, with no state carried between reads. A `data:` line split across
 * two TCP reads was therefore parsed as two malformed fragments and its content
 * was dropped — silently, because the `catch` around `JSON.parse` swallowed the
 * error. The model output simply came back short, which is a data-corrupting
 * failure rather than a loud one: truncated payment amounts or research output
 * can still parse as valid.
 *
 * These tests drive `client.stream()` with raw byte chunks, so they exercise the
 * real reader path rather than a mock of it. The split points are computed from
 * the encoded frame rather than hardcoded, which keeps them correct if the frame
 * shape ever changes.
 */

import { VeniceClient } from '../../src/services/venice/client';
import { CircuitBreaker } from '../../src/services/venice/circuitBreaker';
import { createLogger } from '../../src/utils/logger';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// Spy on the module logger so AC4 ("parse failures are counted and logged") can
// be asserted on the real log call rather than inferred from output length.
const warnSpy = jest.fn();
jest.mock('../../src/utils/logger', () => ({
  ...jest.requireActual('../../src/utils/logger'),
  createLogger: () => ({
    info: jest.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

/** Encode a string to bytes the way a real socket would deliver it. */
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/** One SSE frame carrying a single content delta. */
function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** A raw SSE frame with an arbitrary payload, for malformed-frame tests. */
function rawFrame(payload: string): string {
  return `data: ${payload}\n\n`;
}

/**
 * A `fetch` response whose body yields the supplied byte chunks verbatim.
 *
 * Chunk boundaries here are real: a test can hand over a frame that has been
 * cut at an arbitrary byte offset, which is what the network does.
 */
function rawStreamResponse(byteChunks: Uint8Array[]) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            i < byteChunks.length
              ? { done: false, value: byteChunks[i++] }
              : { done: true, value: undefined },
          ),
      }),
    },
  };
}

/** Cut a string's bytes at `at`, returning the two halves. */
function splitBytes(s: string, at: number): [Uint8Array, Uint8Array] {
  const bytes = encode(s);
  expect(at).toBeGreaterThan(0);
  expect(at).toBeLessThan(bytes.length);
  return [bytes.slice(0, at), bytes.slice(at)];
}

/** Every offset that would split a string into two non-empty pieces. */
function allSplitPoints(s: string): number[] {
  const points: number[] = [];
  for (let i = 1; i < encode(s).length; i++) points.push(i);
  return points;
}

describe('Venice SSE chunk boundaries (#660)', () => {
  let client: VeniceClient;

  beforeEach(() => {
    mockFetch.mockReset();
    warnSpy.mockReset();
    client = new VeniceClient({ apiKey: 'test-key', circuitBreaker: new CircuitBreaker() });
  });

  const collect = async (chunks: Uint8Array[]): Promise<string> => {
    mockFetch.mockResolvedValueOnce(rawStreamResponse(chunks));
    const out: string[] = [];
    await client.stream('test', 'research', (c) => out.push(c));
    return out.join('');
  };

  // ── AC1: a split `data:` line reassembles ──────────────────────────────────

  it('reassembles a data: line split mid-payload into "hello" (AC1)', async () => {
    // Same shape as the issue's fixture — `data: {"content":"hel` + `lo"}` —
    // expressed with the real Venice payload shape the parser consumes.
    const body = frame('hello');
    const cut = body.indexOf('"hel') + '"hel'.length;
    const [a, b] = splitBytes(body, cut);

    expect(new TextDecoder().decode(a)).toContain('"hel');
    expect(new TextDecoder().decode(b).startsWith('lo"}')).toBe(true);

    mockFetch.mockResolvedValueOnce(rawStreamResponse([a, b]));

    const out: string[] = [];
    await client.stream('test', 'research', (c) => out.push(c));

    expect(out.join('')).toBe('hello');
  });

  it("joins the issue's literal {\"content\":\"hel\" + \"lo\"} fixture into valid JSON (AC1)", async () => {
    // The issue's AC1 fixture, verbatim. Note what this does and does not prove:
    // this payload shape carries no `delta.content`, so the reassembled frame
    // legitimately emits no chunk, and the pre-fix code also emitted nothing
    // here — it simply did so by dropping two fragments silently. What it does
    // pin down is that the halves are joined *before* parsing: an implementation
    // that logged every `JSON.parse` failure without buffering would report two
    // failures for this input, and this asserts zero.
    mockFetch.mockResolvedValueOnce(
      rawStreamResponse([encode('data: {"content":"hel'), encode('lo"}\n\n' + frame('ok'))]),
    );

    const out: string[] = [];
    await client.stream('test', 'research', (c) => out.push(c));

    expect(
      warnSpy.mock.calls.filter(
        (call) => typeof call[1] === 'string' && String(call[1]).includes('failed to parse'),
      ),
    ).toHaveLength(0);
    // The stream stays usable after the reassembled frame.
    expect(out.join('')).toBe('ok');
  });

  it('reassembles a full frame regardless of where the chunk boundary falls (AC1)', async () => {
    const body = frame('hello');

    for (const at of allSplitPoints(body)) {
      mockFetch.mockReset();
      const [a, b] = splitBytes(body, at);
      // eslint-disable-next-line no-await-in-loop
      const result = await collect([a, b]);
      expect(result).toBe('hello');
    }
  });

  it('reassembles when a frame is split into many chunks, one byte at a time (AC1)', async () => {
    const body = frame('split into single bytes');
    const bytes = encode(body);
    const oneByteChunks = Array.from(bytes, (b) => Uint8Array.of(b));

    expect(await collect(oneByteChunks)).toBe('split into single bytes');
  });

  it('reassembles a frame split across three chunks (AC1)', async () => {
    const body = frame('three ways');
    const bytes = encode(body);
    const third = Math.floor(bytes.length / 3);
    const chunks = [
      bytes.slice(0, third),
      bytes.slice(third, third * 2),
      bytes.slice(third * 2),
    ];

    expect(await collect(chunks)).toBe('three ways');
  });

  it('delivers several frames delivered together in one chunk', async () => {
    const body = frame('a') + frame('b') + frame('c') + 'data: [DONE]\n\n';
    expect(await collect([encode(body)])).toBe('abc');
  });

  it('streams many frames arriving in arbitrary 7-byte chunks', async () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const body = words.map(frame).join('') + 'data: [DONE]\n\n';
    const bytes = encode(body);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));

    expect(await collect(chunks)).toBe(words.join(''));
  });

  // ── AC2: chunking must not change the parsed result ───────────────────────

  it('produces identical output whether the response is one chunk or many (AC2)', async () => {
    const body =
      frame('The quick ') + frame('brown fox ') + frame('jumps over ') + frame('the lazy dog') +
      'data: [DONE]\n\n';

    const single = await collect([encode(body)]);

    const bytes = encode(body);
    const multi: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) multi.push(bytes.slice(i, i + 3));

    expect(await collect(multi)).toBe(single);
    expect(single).toBe('The quick brown fox jumps over the lazy dog');
  });

  it('produces identical output when split at every possible byte offset (AC2)', async () => {
    const body = frame('consistency matters') + 'data: [DONE]\n\n';
    const single = await collect([encode(body)]);

    for (const at of allSplitPoints(body)) {
      mockFetch.mockReset();
      const [a, b] = splitBytes(body, at);
      // eslint-disable-next-line no-await-in-loop
      expect(await collect([a, b])).toBe(single);
    }
  });

  // ── AC3: multi-byte UTF-8 across chunk boundaries ──────────────────────────

  it('does not corrupt a multi-byte character split across chunks (AC3)', async () => {
    // "✓" is 3 bytes in UTF-8, so cutting mid-character is easy to hit.
    const body = frame('café ✓ 😀 done');

    for (const at of allSplitPoints(body)) {
      mockFetch.mockReset();
      const [a, b] = splitBytes(body, at);
      // eslint-disable-next-line no-await-in-loop
      expect(await collect([a, b])).toBe('café ✓ 😀 done');
    }
  });

  it('handles an emoji whose bytes are split three ways (AC3)', async () => {
    const bytes = encode(frame('a😀b'));
    // Slice through the middle of the surrogate pair's 4-byte sequence.
    const chunks = [bytes.slice(0, bytes.length - 3), bytes.slice(bytes.length - 3, bytes.length - 1), bytes.slice(bytes.length - 1)];

    expect(await collect(chunks)).toBe('a😀b');
  });

  it('delivers content identical to the single-chunk case for multi-byte text (AC3)', async () => {
    const body = frame('🌍 ünïcödé 日本語 текст');
    const bytes = encode(body);
    const split: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 5) split.push(bytes.slice(i, i + 5));

    expect(await collect(split)).toBe(await collect([encode(body)]));
    expect(await collect([encode(body)])).toBe('🌍 ünïcödé 日本語 текст');
  });

  // ── Trailing-frame flush ──────────────────────────────────────────────────

  it('processes a final frame that has no trailing newline', async () => {
    // The stream ends mid-frame-terminator, so the retained buffer is the only
    // place the last frame can still live.
    const body = frame('done') + frame('last');
    const noNewline = body.replace(/\n+$/, '');
    expect(noNewline.endsWith('\n')).toBe(false);

    expect(await collect([encode(noNewline)])).toBe('donelast');
  });

  it('processes the final frame when the last chunk carries it without a newline', async () => {
    const bytes = encode(frame('x') + frame('tail').replace(/\n$/, ''));
    const [a, b] = [bytes.slice(0, bytes.length - 4), bytes.slice(bytes.length - 4)];

    expect(await collect([a, b])).toBe('xtail');
  });

  // ── AC4: parse failures are counted and logged ────────────────────────────

  it('logs a warning for each unparseable frame instead of swallowing it (AC4)', async () => {
    const body = rawFrame('{"choices":') + frame('good');
    await collect([encode(body)]);

    const frameWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[1] === 'string' && String(call[1]).includes('failed to parse'),
    );
    expect(frameWarnings.length).toBe(1);
    expect(frameWarnings[0][0]).toMatchObject({ agentType: 'research' });
  });

  it('logs a summary warning with the failure count (AC4)', async () => {
    const body = rawFrame('{oops') + rawFrame('still bad') + frame('ok');
    expect(await collect([encode(body)])).toBe('ok');

    const summary = warnSpy.mock.calls.find(
      (call) => typeof call[1] === 'string' && String(call[1]).includes('unparseable frames'),
    );
    expect(summary).toBeDefined();
    expect((summary![0] as { parseFailures: number }).parseFailures).toBe(2);
  });

  it('counts every failure when many frames are malformed (AC4)', async () => {
    let body = '';
    for (let i = 0; i < 5; i++) body += rawFrame(`bad-${i}`);
    body += frame('final');

    expect(await collect([encode(body)])).toBe('final');

    const summary = warnSpy.mock.calls.find(
      (call) => typeof call[1] === 'string' && String(call[1]).includes('unparseable frames'),
    );
    expect((summary![0] as { parseFailures: number }).parseFailures).toBe(5);
  });

  it('does not log a summary when every frame parsed (AC4)', async () => {
    await collect([encode(frame('clean'))]);

    const summary = warnSpy.mock.calls.find(
      (call) => typeof call[1] === 'string' && String(call[1]).includes('unparseable frames'),
    );
    expect(summary).toBeUndefined();
  });

  it('still emits usable content when a frame is malformed mid-stream (AC4)', async () => {
    const body = frame('before') + rawFrame('{"broken":') + frame('after');
    expect(await collect([encode(body)])).toBe('beforeafter');
  });

  it('survives a malformed frame split across chunks (AC4)', async () => {
    const body = rawFrame('{"broken":') + frame('recovered');
    const bytes = encode(body);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 4) chunks.push(bytes.slice(i, i + 4));

    expect(await collect(chunks)).toBe('recovered');
  });

  it('does not log a parse failure for a frame split across chunks', async () => {
    // The key regression: a split-but-valid frame must not be reported as a
    // parse failure, which is what made the original loss invisible.
    const body = frame('valid but split');
    const bytes = encode(body);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 2) chunks.push(bytes.slice(i, i + 2));

    expect(await collect(chunks)).toBe('valid but split');
    expect(
      warnSpy.mock.calls.filter(
        (call) => typeof call[1] === 'string' && String(call[1]).includes('failed to parse'),
      ),
    ).toHaveLength(0);
  });
});

// ── Sanity check that the logger mock is actually wired ────────────────────

describe('logger spy sanity', () => {
  it('routes logger.warn through the spy, so AC4 assertions are meaningful', () => {
    const mocked = createLogger({ module: 'test' });
    warnSpy.mockClear();
    mocked.warn('sentinel', 'message');
    expect(warnSpy).toHaveBeenCalledWith('sentinel', 'message');
  });
});
