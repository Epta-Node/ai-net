import { signAgentRequest } from './agentAuthClient';
import { getConfig } from '../config';
import { fetchWithTimeout } from '../utils/timeout';

export interface HeartbeatClientOptions {
  apiBaseUrl: string;
  agentId: string;
  intervalMs?: number;
  failureThreshold?: number;
  onFailureThresholdReached?: (consecutiveFailures: number) => void;
  /**
   * Stellar public key of the agent. Sent as the claimed key; the coordinator
   * checks it against the registered key (#558).
   */
  publicKey?: string;
  /**
   * Stellar secret used to sign the heartbeat challenge (#558). Without it the
   * client posts unsigned, which the coordinator refuses once the
   * `agent_ownership_proof` flag is on.
   */
  secret?: string;
}

export class HeartbeatClient {
  private readonly apiBaseUrl: string;
  private readonly agentId: string;
  private readonly intervalMs: number;
  private readonly failureThreshold: number;
  private readonly publicKey?: string;
  private readonly secret?: string;
  private readonly onFailureThresholdReached?: (consecutiveFailures: number) => void;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;
  private consecutiveFailures = 0;

  constructor(options: HeartbeatClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
    this.agentId = options.agentId;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.publicKey = options.publicKey;
    this.secret = options.secret;
    this.onFailureThresholdReached = options.onFailureThresholdReached;
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

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  private async send(): Promise<void> {
    if (this.stopped) return;

    try {
      const url = `${this.apiBaseUrl}/api/agents/${encodeURIComponent(this.agentId)}/heartbeat`;
      const payload = { agentId: this.agentId };
      const signed = this.publicKey
        ? await signAgentRequest({
            apiBaseUrl: this.apiBaseUrl,
            purpose: 'heartbeat',
            publicKey: this.publicKey,
            secret: this.secret,
            agentId: this.agentId,
            payload,
          })
        : null;

      const init: RequestInit = { method: 'POST' };
      if (signed) init.headers = { ...signed };
      const response = await fetchWithTimeout(url, init, getConfig().TIMEOUT_BUDGET_READ_MS);
      if (!response.ok) {
        this.consecutiveFailures += 1;
        console.warn(
          `[Heartbeat] Heartbeat failed for ${this.agentId}: ${response.status} (failure #${this.consecutiveFailures})`
        );
        if (this.consecutiveFailures >= this.failureThreshold && this.onFailureThresholdReached) {
          this.onFailureThresholdReached(this.consecutiveFailures);
        }
      } else {
        this.consecutiveFailures = 0;
      }
    } catch (err) {
      this.consecutiveFailures += 1;
      console.warn(
        `[Heartbeat] Heartbeat error for ${this.agentId}:`,
        err instanceof Error ? err.message : 'unknown',
        `(failure #${this.consecutiveFailures})`
      );
      if (this.consecutiveFailures >= this.failureThreshold && this.onFailureThresholdReached) {
        this.onFailureThresholdReached(this.consecutiveFailures);
      }
    }
  }
}
