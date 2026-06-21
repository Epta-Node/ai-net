/**
 * Venice AI Client
 *
 * Wraps the Venice REST API with:
 *  - standard completions (complete)
 *  - streaming completions (stream)
 *  - per-agent model routing
 *  - circuit-breaker (open after 3 consecutive failures, reset after 60 s)
 *  - prompt logging with redaction of long inputs
 *
 * See Issue #4 for full specification.
 */

import axios, { AxiosError } from 'axios';
import { Capability } from '../types/types';

// ---------------------------------------------------------------------------
// Model routing map
// ---------------------------------------------------------------------------

export const MODEL_ROUTING: Record<Capability, string> = {
  research: 'venice-xl',
  risk: 'venice-xl',
  coding: 'venice-code',
  design: 'venice-xl',
  report: 'venice-xl',
};

/** Returns the Venice model id for the given agent capability. */
export function modelForCapability(capability: Capability): string {
  return MODEL_ROUTING[capability] ?? 'venice-xl';
}

// ---------------------------------------------------------------------------
// Circuit-breaker state
// ---------------------------------------------------------------------------

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 60_000;

interface CircuitState {
  failures: number;
  openedAt: number | null; // epoch ms when circuit opened, null = closed
}

const circuit: CircuitState = {
  failures: 0,
  openedAt: null,
};

/** Returns true when the circuit breaker is currently open (rejecting calls). */
function isCircuitOpen(): boolean {
  if (circuit.openedAt === null) return false;
  // Auto-heal after CIRCUIT_RESET_MS
  if (Date.now() - circuit.openedAt >= CIRCUIT_RESET_MS) {
    circuit.openedAt = null;
    circuit.failures = 0;
    return false;
  }
  return true;
}

function recordSuccess(): void {
  circuit.failures = 0;
  circuit.openedAt = null;
}

function recordFailure(): void {
  circuit.failures += 1;
  if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openedAt = Date.now();
  }
}

// Exposed for tests
export function resetCircuit(): void {
  circuit.failures = 0;
  circuit.openedAt = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VENICE_BASE_URL = 'https://api.venice.ai/api/v1';
const LOG_PROMPT_MAX_CHARS = 200;

function redactPrompt(prompt: string): string {
  if (prompt.length <= LOG_PROMPT_MAX_CHARS) return prompt;
  return `${prompt.slice(0, LOG_PROMPT_MAX_CHARS)}…[redacted]`;
}

// ---------------------------------------------------------------------------
// VeniceClient
// ---------------------------------------------------------------------------

export class VeniceClient {
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env['VENICE_API_KEY'];
    if (!key) {
      throw new Error(
        'VENICE_API_KEY is not set. Provide it via the constructor or process.env.',
      );
    }
    this.apiKey = key;
  }

  /**
   * Standard (non-streaming) completion.
   * Returns the full assistant message as a string.
   */
  async complete(
    prompt: string,
    modelId: string,
    options?: Record<string, unknown>,
  ): Promise<string> {
    if (isCircuitOpen()) {
      throw new Error('VeniceClient: circuit breaker is open — too many recent failures');
    }

    console.debug(`[venice] complete model=${modelId} prompt="${redactPrompt(prompt)}"`);

    try {
      const response = await axios.post<{
        choices: Array<{ message: { content: string } }>;
      }>(
        `${VENICE_BASE_URL}/chat/completions`,
        {
          model: modelId,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          ...options,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const content = response.data.choices?.[0]?.message?.content ?? '';
      recordSuccess();
      return content;
    } catch (err) {
      recordFailure();
      throw err;
    }
  }

  /**
   * Streaming completion.
   * Calls onChunk for each streamed token and resolves after the stream ends.
   */
  async stream(
    prompt: string,
    modelId: string,
    onChunk: (chunk: string) => void,
    options?: Record<string, unknown>,
  ): Promise<void> {
    if (isCircuitOpen()) {
      throw new Error('VeniceClient: circuit breaker is open — too many recent failures');
    }

    console.debug(`[venice] stream model=${modelId} prompt="${redactPrompt(prompt)}"`);

    try {
      const response = await axios.post(
        `${VENICE_BASE_URL}/chat/completions`,
        {
          model: modelId,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
          ...options,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
        },
      );

      await new Promise<void>((resolve, reject) => {
        const stream: NodeJS.ReadableStream = response.data as NodeJS.ReadableStream;
        let buffer = '';

        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const json = trimmed.slice('data:'.length).trim();
            if (json === '[DONE]') continue;
            try {
              const parsed = JSON.parse(json) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) onChunk(delta);
            } catch {
              // Ignore malformed SSE lines
            }
          }
        });

        stream.on('end', () => resolve());
        stream.on('error', (err: Error) => reject(err));
      });

      recordSuccess();
    } catch (err) {
      recordFailure();
      throw err;
    }
  }
}

// Re-export AxiosError so callers can distinguish network errors
export { AxiosError };
