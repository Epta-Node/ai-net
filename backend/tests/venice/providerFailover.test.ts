/**
 * Venice provider failover in the streaming path (issue #661).
 *
 * Deltas used to be handed to the caller as they arrived, so a provider that
 * failed mid-stream had already delivered its partial output by the time the
 * failover ran. The fallback provider then streamed on top of it and the caller
 * received two responses concatenated with nothing marking the boundary — text
 * that belongs to neither provider and may still parse as valid. `accumulated`
 * was also never reset, so it summed both attempts and the length reported in
 * the final error no longer described what the client had received.
 *
 * These tests use fault injection: a reader that yields frames and then fails.
 * The failure path cannot be reached from a well-behaved mock, which is why
 * this escaped local testing.
 */

import fs from 'fs';
import path from 'path';
import { VeniceClient } from '../../src/services/venice/client';
import { CircuitBreaker } from '../../src/services/venice/circuitBreaker';
import { VeniceKeyHealthStore } from '../../src/services/venice/keyHealth';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** A response whose body streams `frames`, then fails once `failAfter` is hit. */
function streamThatFails(frames: string[], failAfter: number) {
  let emitted = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => {
          if (emitted >= failAfter) {
            return Promise.reject(new Error('connection reset by peer'));
          }
          const value = encode(frames[emitted++]!);
          return Promise.resolve({ done: false, value });
        },
      }),
    },
  };
}

/** A response that streams `frames` and then completes normally. */
function streamOk(frames: string[]) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            i < frames.length
              ? { done: false, value: encode(frames[i++]!) }
              : { done: true, value: undefined },
          ),
      }),
    },
  };
}

function statusResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: 'nope' }),
  };
}

const P1 = { apiKey: 'key-1', baseUrl: 'https://p1.test', name: 'primary' };
const P2 = { apiKey: 'key-2', baseUrl: 'https://p2.test', name: 'fallback' };

function makeClient(providers = [P1, P2], maxRetries = 0) {
  return new VeniceClient({
    providers,
    circuitBreaker: new CircuitBreaker(),
    // Fresh store per client: the process-wide one would carry failure
    // history between tests and reorder this file's providers (issue #741).
    keyHealth: new VeniceKeyHealthStore(),
    // Zero retries keeps fetch call counts deterministic: a 5xx fails over to
    // the next provider immediately rather than burning same-provider attempts.
    maxRetries,
  });
}

describe('Venice stream provider failover (#661)', () => {
  beforeEach(() => mockFetch.mockReset());

  // ── AC1: no concatenated duplicates across providers ──────────────────────

  it('delivers only the fallback output when the primary fails mid-stream (AC1)', async () => {
    mockFetch
      .mockResolvedValueOnce(streamThatFails([frame('PARTIAL-FROM-P1-')], 1))
      .mockResolvedValueOnce(streamOk([frame('complete answer')]));

    const chunks: string[] = [];
    await makeClient().stream('prompt', 'research', (c) => chunks.push(c));

    // The failed provider's partial text must never reach the caller.
    expect(chunks.join('')).toBe('complete answer');
    expect(chunks.join('')).not.toContain('PARTIAL-FROM-P1-');
  });

  it('never concatenates both providers for every mid-stream failure point (AC1)', async () => {
    for (let failAfter = 1; failAfter <= 3; failAfter++) {
      mockFetch.mockReset();
      mockFetch
        .mockResolvedValueOnce(
          streamThatFails([frame('AAA'), frame('BBB'), frame('CCC')], failAfter),
        )
        .mockResolvedValueOnce(streamOk([frame('fallback-text')]));

      const chunks: string[] = [];
      // eslint-disable-next-line no-await-in-loop
      await makeClient().stream('prompt', 'research', (c) => chunks.push(c));

      expect(chunks.join('')).toBe('fallback-text');
    }
  });

  it('delivers the fallback output in order, un-duplicated (AC1)', async () => {
    mockFetch
      .mockResolvedValueOnce(streamThatFails([frame('leak-a'), frame('leak-b')], 2))
      .mockResolvedValueOnce(streamOk([frame('one '), frame('two '), frame('three')]));

    const chunks: string[] = [];
    await makeClient().stream('prompt', 'research', (c) => chunks.push(c));

    expect(chunks).toEqual(['one ', 'two ', 'three']);
  });

  it('does not emit anything from a failed attempt before failing over (AC1)', async () => {
    const chunks: string[] = [];
    mockFetch
      .mockResolvedValueOnce(streamThatFails([frame('leak')], 1))
      .mockResolvedValueOnce(streamOk([frame('safe')]));

    await makeClient().stream('prompt', 'research', (c) => chunks.push(c));

    // Every emitted chunk must belong to the successful attempt.
    expect(chunks.every((c) => c !== 'leak')).toBe(true);
    expect(chunks.join('')).toBe('safe');
  });

  it('still delivers a successful single-provider stream unchanged', async () => {
    mockFetch.mockResolvedValueOnce(
      streamOk([frame('Hello'), frame(' '), frame('world')]),
    );

    const chunks: string[] = [];
    await makeClient([P1]).stream('prompt', 'research', (c) => chunks.push(c));

    expect(chunks).toEqual(['Hello', ' ', 'world']);
  });

  // ── AC2: accumulated is reset between attempts ────────────────────────────

  it('reports zero delivered characters when every provider fails (AC2)', async () => {
    mockFetch
      .mockResolvedValueOnce(streamThatFails([frame('partial-primary')], 1))
      .mockResolvedValueOnce(streamThatFails([frame('partial-fallback')], 1));

    const chunks: string[] = [];
    // eslint-disable-next-line no-await-in-loop
    const err = await makeClient()
      .stream('prompt', 'research', (c) => chunks.push(c))
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    // Before the fix this reported the sum of both providers' partial output
    // (26 chars) even though the caller had received nothing.
    expect(err!.message).toContain('0 characters delivered');
    expect(err!.message).not.toContain('partial');
    expect(chunks).toEqual([]);
  });

  it('does not leak the failed attempt into the error length (AC2)', async () => {
    const longPartial = 'x'.repeat(500);
    mockFetch
      .mockResolvedValueOnce(streamThatFails([frame(longPartial)], 1))
      .mockResolvedValueOnce(streamThatFails([frame(longPartial)], 1));

    const err = await makeClient()
      .stream('prompt', 'research', () => {})
      .then(() => null)
      .catch((e: Error) => e);

    expect(err!.message).toContain('after 0 characters delivered');
    expect(err!.message).not.toContain('500');
  });

  it('emits each attempt\'s output only once, from the attempt that succeeded (AC2)', async () => {
    mockFetch
      .mockResolvedValueOnce(streamThatFails([frame('dup')], 1))
      .mockResolvedValueOnce(streamOk([frame('dup')]));

    const chunks: string[] = [];
    await makeClient().stream('prompt', 'research', (c) => chunks.push(c));

    // Same text from both providers must not appear twice.
    expect(chunks).toEqual(['dup']);
  });

  // ── AC3: a 422 must not trigger another provider attempt ───────────────────

  it('does not try another provider after a 422 (AC3)', async () => {
    mockFetch.mockResolvedValue(statusResponse(422));

    const err = await makeClient()
      .stream('prompt', 'research', () => {})
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('422');
    // Only the primary was contacted — a 422 means the request itself was
    // rejected, so trying a second provider just adds load.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain('p1.test');
  });

  it('does not try another provider after a 400 (AC3)', async () => {
    mockFetch.mockResolvedValue(statusResponse(400));

    await makeClient()
      .stream('prompt', 'research', () => {})
      .catch(() => undefined);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not try another provider for complete() after a 422 (AC3)', async () => {
    mockFetch.mockResolvedValue(statusResponse(422));

    await makeClient()
      .complete('prompt', 'research')
      .catch(() => undefined);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry the same provider after a 422 (AC3)', async () => {
    mockFetch.mockResolvedValue(statusResponse(422));

    await makeClient([P1], 3)
      .complete('prompt', 'research')
      .catch(() => undefined);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('still fails over on 401, since a fallback may hold a different key', async () => {
    mockFetch
      .mockResolvedValueOnce(statusResponse(401))
      .mockResolvedValueOnce(streamOk([frame('fallback-text')]));

    const chunks: string[] = [];
    await makeClient().stream('prompt', 'research', (c) => chunks.push(c));

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1][0])).toContain('p2.test');
    expect(chunks.join('')).toBe('fallback-text');
  });

  it('still fails over on a 5xx', async () => {
    mockFetch
      .mockResolvedValueOnce(statusResponse(500))
      .mockResolvedValueOnce(streamOk([frame('recovered')]));

    const chunks: string[] = [];
    await makeClient().stream('prompt', 'research', (c) => chunks.push(c));

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(chunks.join('')).toBe('recovered');
  });

  it('still fails over on a transport error', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(streamOk([frame('recovered')]));

    const chunks: string[] = [];
    await makeClient().stream('prompt', 'research', (c) => chunks.push(c));

    expect(chunks.join('')).toBe('recovered');
  });

  it('still fails over on a 429', async () => {
    mockFetch
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(streamOk([frame('after-backoff')]));

    const chunks: string[] = [];
    await makeClient().stream('prompt', 'research', (c) => chunks.push(c));

    expect(chunks.join('')).toBe('after-backoff');
  });
});

// ── AC4: no unused private members ─────────────────────────────────────────

describe('VeniceClient has no unused private members (#661)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/services/venice/client.ts'),
    'utf8',
  );

  /** Names of `private` fields, getters, and methods declared in the class. */
  function privateMemberNames(): string[] {
    const names = new Set<string>();
    // `private foo = ...` / `private readonly foo = ...` and `private get foo()`.
    const fieldOrAccessor =
      /^\s*private\s+(?:readonly\s+)?(?:get\s+|set\s+|async\s+)?([A-Za-z_$][\w$]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = fieldOrAccessor.exec(source)) !== null) names.add(m[1]!);
    return [...names];
  }

  it('finds private members to check (guard against a broken scan)', () => {
    const names = privateMemberNames();
    expect(names.length).toBeGreaterThan(5);
    // Spot-check members that are known to exist.
    expect(names).toEqual(expect.arrayContaining(['providers', 'fetchWithRetryForProvider']));
  });

  it('references every private member somewhere in the file', () => {
    const unused: string[] = [];

    for (const name of privateMemberNames()) {
      // Count references other than the declaration itself.
      const uses = source.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
      const declared = new RegExp(`^\\s*private\\s+(?:readonly\\s+)?(?:get\\s+|set\\s+|async\\s+)?${name}\\b`, 'gm').source;
      const declarationCount = source.match(new RegExp(declared, 'g'))?.length ?? 0;
      // eslint-disable-next-line no-console
      if (uses - declarationCount === 0) unused.push(name);
    }

    // The dead `fetchWithRetry` helper and the write-only `isNonRetryable`
    // variable are what this guards against; both are gone.
    expect(unused).toEqual([]);
  });

  it('has no write-only local variables left in the fetch/failover paths', () => {
    // `isNonRetryable` was computed and never read. Assert the name is gone
    // rather than relying on eslint alone.
    expect(source).not.toMatch(/const\s+isNonRetryable\s*=/);
  });

  it('no longer declares the removed legacy fetchWithRetry helper', () => {
    expect(source).not.toMatch(/private\s+async\s+fetchWithRetry\s*\(/);
    // The live helper it delegated to is still present.
    expect(source).toMatch(/private\s+async\s+fetchWithRetryForProvider\s*\(/);
  });
});
