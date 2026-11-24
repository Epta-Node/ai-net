import axios from 'axios';

const MODEL_ROUTING: Record<string, string> = {
  research: 'venice-xl',
  risk: 'venice-xl',
  coding: 'venice-code',
  design: 'venice-xl',
  report: 'venice-xl',
};

const VENICE_BASE_URL = 'https://api.venice.ai/api/v1';
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_DURATION_MS = 60_000;

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class VeniceClient {
  private circuitState: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private openedAt: number | null = null;

  constructor(private readonly apiKey = process.env['VENICE_API_KEY'] ?? '') {}

  getModelForAgent(capability: string): string {
    return MODEL_ROUTING[capability] ?? 'venice-xl';
  }

  private checkCircuit(): void {
    if (this.circuitState === CircuitState.OPEN) {
      const elapsed = Date.now() - (this.openedAt ?? 0);
      if (elapsed >= CIRCUIT_OPEN_DURATION_MS) {
        this.circuitState = CircuitState.HALF_OPEN;
      } else {
        throw new Error('Circuit breaker is OPEN — Venice AI is unavailable');
      }
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.circuitState = CircuitState.CLOSED;
    this.openedAt = null;
  }

  private onFailure(): void {
    this.failureCount += 1;
    if (
      this.failureCount >= CIRCUIT_FAILURE_THRESHOLD ||
      this.circuitState === CircuitState.HALF_OPEN
    ) {
      this.circuitState = CircuitState.OPEN;
      this.openedAt = Date.now();
    }
  }

  private log(prompt: string, modelId: string): void {
    const truncated = prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt;
    console.log(`[Venice] model=${modelId} prompt="${truncated}"`);
  }

  async complete(
    prompt: string,
    modelId: string,
    options?: Record<string, unknown>,
  ): Promise<string> {
    if (!this.apiKey) throw new Error('VENICE_API_KEY is not configured');

    this.checkCircuit();
    const resolvedModel = MODEL_ROUTING[modelId] ?? modelId;
    this.log(prompt, resolvedModel);

    try {
      const response = await axios.post(
        `${VENICE_BASE_URL}/chat/completions`,
        {
          model: resolvedModel,
          messages: [{ role: 'user', content: prompt }],
          ...options,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 60_000,
        },
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Venice returned an empty response');

      this.onSuccess();
      return content;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  async stream(
    prompt: string,
    modelId: string,
    onChunk: (chunk: string) => void,
  ): Promise<void> {
    if (!this.apiKey) throw new Error('VENICE_API_KEY is not configured');

    this.checkCircuit();
    const resolvedModel = MODEL_ROUTING[modelId] ?? modelId;
    this.log(prompt, resolvedModel);

    try {
      const response = await axios.post(
        `${VENICE_BASE_URL}/chat/completions`,
        {
          model: resolvedModel,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
          timeout: 60_000,
        },
      );

      await new Promise<void>((resolve, reject) => {
        let buffer = '';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response.data.on('data', (chunk: Buffer | string) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') return;

            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const content = parsed?.choices?.[0]?.delta?.content;
              if (typeof content === 'string') onChunk(content);
            } catch {
              // ignore malformed SSE lines
            }
          }
        });

        response.data.on('end', resolve);
        response.data.on('error', reject);
      });

      this.onSuccess();
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }
}
