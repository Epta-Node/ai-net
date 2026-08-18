import { AgentDb, createAgentDb, getAgentDb } from "../db/agents";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "heartbeat" });

export interface HeartbeatServiceOptions {
  /** Background interval in ms (default: 300,000 / 5 minutes) */
  intervalMs?: number;
  /** Minutes threshold after which online agents with no heartbeat are marked offline (default: 5) */
  staleThresholdMinutes?: number;
  /** Hours threshold after which offline agents are permanently deleted (default: 24) */
  offlineThresholdHours?: number;
  /** Custom AgentDb instance for testing */
  db?: AgentDb;
}

export interface HeartbeatService {
  start: () => void;
  stop: () => void;
}

export function createHeartbeatService(options: HeartbeatServiceOptions = {}): HeartbeatService {
  const intervalMs = options.intervalMs ?? 300_000;
  const staleThresholdMinutes = options.staleThresholdMinutes ?? 5;
  const offlineThresholdHours = options.offlineThresholdHours ?? 24;
  let timer: NodeJS.Timeout | null = null;

  const getDb = () => options.db ?? createAgentDb(getAgentDb());

  function runCleanup() {
    try {
      const db = getDb();
      const markedOffline = db.markStaleAgents(staleThresholdMinutes);
      const deleted = db.deleteOfflineAgents(offlineThresholdHours);

      if (markedOffline > 0 || deleted > 0) {
        logger.info(`Heartbeat cleanup: ${markedOffline} marked offline, ${deleted} deleted`);
      }
    } catch (err) {
      logger.error({ error: err }, "Heartbeat cleanup failed");
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(runCleanup, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

let defaultService: HeartbeatService | null = null;

export function startHeartbeatService(options: HeartbeatServiceOptions = {}): HeartbeatService {
  if (!defaultService) {
    defaultService = createHeartbeatService(options);
  }
  defaultService.start();
  return defaultService;
}

export function stopHeartbeatService(): void {
  if (defaultService) {
    defaultService.stop();
    defaultService = null;
  }
}
