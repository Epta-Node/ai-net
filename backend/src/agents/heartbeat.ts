export interface HeartbeatClientOptions {
  apiBaseUrl: string;
  agentId: string;
  intervalMs?: number;
}

export class HeartbeatClient {
  private readonly apiBaseUrl: string;
  private readonly agentId: string;
  private readonly intervalMs: number;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: HeartbeatClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
    this.agentId = options.agentId;
    this.intervalMs = options.intervalMs ?? 30_000;
  }

  start(): void {
    if (this.interval) return;
    this.stopped = false;
    this.send();
    this.interval = setInterval(() => {
      this.send();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.stopped = true;
  }

  private async send(): Promise<void> {
    if (this.stopped) return;

    try {
      const response = await fetch(`${this.apiBaseUrl}/api/agents/${encodeURIComponent(this.agentId)}/heartbeat`, {
        method: 'POST',
      });
      if (!response.ok) {
        console.warn(`[Heartbeat] Heartbeat failed for ${this.agentId}: ${response.status}`);
      }
    } catch (err) {
      console.warn(`[Heartbeat] Heartbeat error for ${this.agentId}:`, err instanceof Error ? err.message : 'unknown');
    }
  }
}
