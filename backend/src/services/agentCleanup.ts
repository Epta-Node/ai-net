import { getAgentDb, createAgentDb } from '../db/agents';
import { createLogger } from '../utils/logger';

export interface AgentCleanupOptions {
  intervalMs?: number;
  ttlMs?: number;
}

export class AgentCleanupService {
  private readonly intervalMs: number;
  private readonly ttlMs: number;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly log = createLogger({ component: 'AgentCleanup' });

  constructor(options: AgentCleanupOptions = {}) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.ttlMs = options.ttlMs ?? 90_000;
  }

  start(): void {
    if (this.interval) return;
    this.stopped = false;
    this.tick();
    this.interval = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.stopped = true;
  }

  private tick(): void {
    if (this.stopped) return;

    try {
      const staleMinutes = Math.ceil(this.ttlMs / 60_000);
      const db = createAgentDb(getAgentDb());
      const count = db.markStaleAgents(staleMinutes);
      this.log.info({ count, staleMinutes }, 'marked stale agents offline');
    } catch (err) {
      this.log.error({ err }, 'cleanup tick failed');
    }
  }
}
