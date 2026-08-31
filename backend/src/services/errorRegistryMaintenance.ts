/**
 * Error-registry maintenance service.
 *
 * Runs the periodic upkeep that keeps the local error-registry store bounded:
 * deterministic reclamation of TTL-expired entries and enforcement of the
 * per-agent live-entry cap. Both operations are idempotent and cheap, so the
 * service may run on the same cadence as the other interval-based services in
 * this codebase.
 */
import { createLogger } from "../utils/logger";
import { createErrorRegistryStore, getErrorDb, closeErrorDb } from "../db/errorRegistry";

const logger = createLogger({ component: "error-registry-maintenance" });

export interface ErrorRegistryMaintenanceOptions {
  intervalMs?: number;
  /** Maximum live (non-expired, non-resolved) entries per agent. */
  capPerAgent?: number;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_CAP_PER_AGENT = 100;

export class ErrorRegistryMaintenanceService {
  private readonly intervalMs: number;
  private readonly capPerAgent: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: ErrorRegistryMaintenanceOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.capPerAgent = options.capPerAgent ?? DEFAULT_CAP_PER_AGENT;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.run();
    }, this.intervalMs);
    this.run();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Reclaim expired entries and enforce per-agent caps. Returns sweep stats. */
  run(): { swept: number; cappedAgents: number } {
    if (this.stopped) return { swept: 0, cappedAgents: 0 };
    try {
      const store = createErrorRegistryStore(getErrorDb());
      const swept = store.sweepExpired();

      // Enforce the cap for every distinct active agent in the store.
      const distinctAgents = getErrorDb()
        .prepare("SELECT DISTINCT agentId AS id FROM errors WHERE status = 'active' AND agentId <> ''")
        .all() as Array<{ id: string }>;
      let cappedAgents = 0;
      for (const row of distinctAgents) {
        const before = store.countLiveByAgent(row.id);
        if (before > this.capPerAgent) {
          store.capLiveEntries(row.id, this.capPerAgent);
          cappedAgents += 1;
        }
      }

      logger.info({ swept, cappedAgents }, "error-registry maintenance pass completed");
      return { swept, cappedAgents };
    } catch (error) {
      logger.error({ err: error }, "error-registry maintenance pass failed");
      return { swept: 0, cappedAgents: 0 };
    }
  }
}

export { closeErrorDb };
