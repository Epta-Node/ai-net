/**
 * Agent heartbeat watchdog with stale eviction and alerting (Issue #379).
 *
 * The existing heartbeat service (services/heartbeat.ts) already flipped
 * long-silent agents offline and deleted them after 24h. That is a status
 * change with no grace period, no record of *why* an agent disappeared, and no
 * signal to anyone. The problem it leaves behind is exactly the issue's:
 * "dead agents silently linger in listings."
 *
 * This watchdog adds the missing behaviour on top:
 *
 *  1. **Detection** — a tick sees which online agents have gone silent.
 *  2. **Grace period** — a first miss quarantines but does *not* evict. The
 *     agent is withdrawn from dispatch immediately (unavailable within the
 *     grace window, per the acceptance criteria) and is given time to come
 *     back: a brief network blip should not cost an agent its registration.
 *  3. **Eviction** — an agent that misses for the whole grace period is
 *     removed from the registry, and an alert is emitted for on-chain
 *     reconciliation.
 *  4. **Alerting** — every transition is persisted to `agent_alerts` (so the
 *     dashboard can show it) and logged (so it is greppable in the ops log).
 *
 * Recoveries are alerted too: a quarantined agent that comes back is exactly
 * the event an operator wants to see, because it distinguishes "the fleet is
 * flapping" from "the fleet is dead".
 */

import type { Logger } from "pino";
import { createAgentDb, getAgentDb, type AgentDb, type AgentRecord } from "../db/agents";
import { getEventStore } from "../events/eventStore";
import {
  AGENT_EVICTED_EVENT,
  CURRENT_EVENT_VERSION,
  type AgentEvictedEvent,
} from "../events/eventTypes";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "agent-watchdog" });

/** Eviction history kept in memory for the status endpoint. */
const MAX_EVICTION_HISTORY = 500;
/** Evictions returned in the status snapshot. */
const RECENT_EVICTIONS_SHOWN = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Evictions since process start, across every watchdog instance. Exported to Prometheus as `agent_watchdog_evictions_total`. */
let evictionsTotal = 0;

/** Total evictions performed by this process. */
export function getAgentWatchdogEvictionsTotal(): number {
  return evictionsTotal;
}

export interface EvictionRecord {
  agentId: string;
  evictedAt: string;
  lastSeenAt: string | null;
}

/** Snapshot served by `GET /api/admin/watchdog/status` (#804). */
export interface WatchdogStatus {
  running: boolean;
  intervalMs: number;
  gracePeriodMinutes: number;
  /** When the last detection pass started, or null before the first one. */
  lastRunAt: string | null;
  /** When the next scheduled pass is due, or null while stopped. */
  nextRunAt: string | null;
  /** Agents currently quarantined inside their grace period. */
  stalledCount: number;
  evictedLast24h: number;
  recentEvictions: EvictionRecord[];
}

export type AlertType = "heartbeat_stale" | "quarantined" | "evicted" | "recovered" | "eviction_failed";
export type AlertSeverity = "warning" | "critical";

export interface AgentAlert {
  id: string;
  agentId: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  lastSeenAt: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface AgentWatchdogOptions {
  /** Background interval in ms (default: 60,000 / 1 minute). */
  intervalMs?: number;
  /**
   * Grace period in minutes: how long an agent may go silent after its first
   * missed tick before it is evicted. It is withdrawn from dispatch as soon as
   * it is first seen missing, so this bounds eviction, not unavailability.
   */
  gracePeriodMinutes?: number;
  /**
   * Reconcile on-chain state when an agent is evicted. Supplied by app.ts so
   * the watchdog stays decoupled from the registry contract; a failure here is
   * alerted but never blocks the local eviction.
   *
   * Implementations should be read-only. Returning a value is recorded in the
   * eviction alert's metadata as `reconciliation`, which is how the dashboard
   * distinguishes a clean local eviction from one that still needs an authorized
   * on-chain deregistration.
   */
  onEvict?: (agent: AgentRecord) => Promise<unknown> | unknown;
  /** Custom AgentDb, for tests. */
  db?: AgentDb;
  /** Custom logger, for tests. */
  logger?: Pick<Logger, "info" | "warn" | "error" | "debug">;
  /**
   * Publish `agent.evicted` for each eviction (#804). Defaults to appending to
   * the process event store. A failure is logged and never blocks the eviction.
   */
  publishEvent?: (event: AgentEvictedEvent) => void;
  /**
   * Bust cached agent listings after a pass that evicted anyone (#804). Called
   * once per pass, best-effort; its failure is logged.
   */
  invalidateCache?: () => Promise<unknown>;
  /** Clock override for tests. */
  now?: () => number;
}

export interface AgentWatchdog {
  start: () => void;
  stop: () => void;
  /** Run a single detection/eviction pass now. Exposed for tests and admin. */
  tick: () => Promise<{ quarantined: number; evicted: number; recovered: number }>;
  /** Current status for the admin endpoint. */
  getStatus: () => WatchdogStatus;
}

const DEFAULTS = {
  intervalMs: 60_000,
  gracePeriodMinutes: 10,
};

/**
 * Every online agent, collected page by page. `AgentDb.list()` is bounded, and
 * the scan must see the stalest agents too. Pages are drained before any
 * `markStale` call so status flips cannot shift the cursor mid-scan.
 */
function listAllOnline(db: AgentDb): AgentRecord[] {
  const agents: AgentRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = db.listCursor({ status: "online", limit: 100, cursor });
    agents.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return agents;
}

export function createAgentWatchdog(options: AgentWatchdogOptions = {}): AgentWatchdog {
  const intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
  const gracePeriodMinutes = options.gracePeriodMinutes ?? DEFAULTS.gracePeriodMinutes;
  const log = options.logger ?? logger;
  let timer: NodeJS.Timeout | null = null;
  // Serialise ticks: an interval tick that overlaps a slow eviction pass would
  // double-count and could emit duplicate alerts.
  let ticking: Promise<unknown> | null = null;

  const getDb = (): AgentDb => options.db ?? createAgentDb(getAgentDb());
  const clock = options.now ?? (() => Date.now());
  const publishEvent =
    options.publishEvent ??
    ((event: AgentEvictedEvent) => {
      getEventStore().append(event);
    });

  let running = false;
  let startedAtMs: number | null = null;
  let lastRunAtMs: number | null = null;
  const evictionHistory: EvictionRecord[] = [];

  function recordEviction(record: EvictionRecord): void {
    evictionHistory.push(record);
    if (evictionHistory.length > MAX_EVICTION_HISTORY) evictionHistory.shift();
  }

  /** Emit `agent.evicted`. Never throws: the eviction has already happened. */
  function emitEvicted(agent: AgentRecord, evictedAtMs: number): void {
    const event: AgentEvictedEvent = {
      type: AGENT_EVICTED_EVENT,
      taskId: `agent:${agent.id}`,
      occurredAt: new Date(evictedAtMs).toISOString(),
      version: CURRENT_EVENT_VERSION,
      payload: { agentId: agent.id, reason: "heartbeat_timeout", lastSeenAt: agent.lastSeenAt ?? null },
    };
    try {
      publishEvent(event);
    } catch (err) {
      log.error({ err, agentId: agent.id }, "failed to publish agent.evicted");
    }
  }

  function alert(
    db: AgentDb,
    agent: AgentRecord,
    type: AlertType,
    severity: AlertSeverity,
    message: string,
    metadata: Record<string, unknown> = {},
  ): void {
    try {
      db.recordAlert({
        agentId: agent.id,
        type,
        severity,
        message,
        lastSeenAt: agent.lastSeenAt,
        metadata,
      });
    } catch (err) {
      // A failed alert must not stop the eviction loop; the log is the fallback.
      log.error({ err, agentId: agent.id, type }, "failed to persist agent alert");
    }
  }

  async function tick(): Promise<{ quarantined: number; evicted: number; recovered: number }> {
    const db = getDb();
    const stats = { quarantined: 0, evicted: 0, recovered: 0 };
    const now = new Date(clock());
    const nowMs = now.getTime();
    const graceMs = gracePeriodMinutes * 60_000;
    lastRunAtMs = nowMs;

    // ── Phase 1: detect ─────────────────────────────────────────────────────
    // Scan online agents for a first missed heartbeat and quarantine them.
    //
    // This phase only ever *starts* grace clocks. It cannot also drive
    // eviction: `markStale` flips the agent to 'offline' so it stops being
    // dispatched, which immediately removes it from this list — so an agent
    // would be quarantined here and then never seen again. Phase 2 owns the
    // rest of the lifecycle.
    for (const agent of listAllOnline(db)) {
      const lastSeenMs = Date.parse(agent.lastSeenAt);
      // An unparseable lastSeenAt is treated as maximally stale rather than
      // skipped — a corrupted timestamp must not be a way to stay registered.
      const silentForMs = Number.isFinite(lastSeenMs) ? nowMs - lastSeenMs : Infinity;

      // A tick interval of silence is normal (agents heartbeat less often than
      // we poll). Only start the grace clock once it exceeds one interval.
      if (silentForMs < intervalMs) continue;

      // Already quarantined on an earlier pass.
      if (db.getStaleSince(agent.id) !== null) continue;

      db.markStale(agent.id, now.toISOString());
      stats.quarantined += 1;
      alert(
        db,
        agent,
        "quarantined",
        "warning",
        `Agent ${agent.id} missed a heartbeat and was withdrawn from dispatch pending a grace period.`,
        { silentForMs, gracePeriodMinutes },
      );
      log.warn(
        { agentId: agent.id, silentForMs, gracePeriodMinutes },
        "agent quarantined — heartbeat missed",
      );
    }

    // ── Phase 2: recover or evict everything currently quarantined ──────────
    // Selected by `staleSince`, not by status, precisely so that the agents
    // phase 1 just took offline are still evaluated.
    for (const agent of db.listStaleAgents()) {
      const firstMissedMs = db.getStaleSince(agent.id);
      if (firstMissedMs === null) continue; // cleared concurrently

      const lastSeenMs = Date.parse(agent.lastSeenAt);
      const silentForMs = Number.isFinite(lastSeenMs) ? nowMs - lastSeenMs : Infinity;
      const outageMs = Math.max(0, nowMs - firstMissedMs);

      if (silentForMs <= intervalMs) {
        // Heartbeat resumed. Read the marker before clearing it — it is the
        // "missing since" stamp that tells us how long the agent was out of
        // rotation.
        db.clearStale(agent.id);
        stats.recovered += 1;
        alert(
          db,
          agent,
          "recovered",
          "warning",
          `Agent ${agent.id} resumed heartbeats and is back in rotation.`,
          { outageMs },
        );
        log.info({ agentId: agent.id, outageMs }, "agent recovered — heartbeat resumed");
        continue;
      }

      if (outageMs < graceMs) {
        // Still inside the grace period. Debug-level so a long grace window is
        // visible without spamming warnings.
        log.debug(
          { agentId: agent.id, elapsedMs: outageMs, gracePeriodMinutes },
          "agent still inside heartbeat grace period",
        );
        continue;
      }

      // Grace expired: evict.
      let reconciliation: unknown = null;
      try {
        if (options.onEvict) {
          reconciliation = await options.onEvict(agent);
        }
      } catch (err) {
        alert(
          db,
          agent,
          "eviction_failed",
          "critical",
          `On-chain reconciliation failed while evicting agent ${agent.id}.`,
          { error: err instanceof Error ? err.message : String(err) },
        );
        log.error({ err, agentId: agent.id }, "on-chain reconciliation failed during eviction");
      }

      db.delete(agent.id);
      stats.evicted += 1;
      evictionsTotal += 1;
      recordEviction({
        agentId: agent.id,
        evictedAt: new Date(nowMs).toISOString(),
        lastSeenAt: agent.lastSeenAt ?? null,
      });
      alert(
        db,
        agent,
        "evicted",
        "critical",
        `Agent ${agent.id} was evicted after ${gracePeriodMinutes}m without a heartbeat.`,
        {
          silentForMs,
          gracePeriodMinutes,
          outageMs,
          reconciliation: options.onEvict ? reconciliation : "not_configured",
        },
      );
      emitEvicted(agent, nowMs);
      log.error(
        { agentId: agent.id, silentForMs, gracePeriodMinutes, reconciliation },
        "agent evicted — heartbeat grace period expired",
      );
    }

    if (stats.evicted > 0 && options.invalidateCache) {
      try {
        await options.invalidateCache();
      } catch (err) {
        log.warn({ err }, "agent cache invalidation after eviction failed");
      }
    }

    if (stats.quarantined || stats.evicted || stats.recovered) {
      log.info(stats, "agent watchdog tick");
    }
    return stats;
  }

  function getStatus(): WatchdogStatus {
    const nowMs = clock();
    const dayAgo = nowMs - DAY_MS;
    const evictedLast24h = evictionHistory.filter((r) => Date.parse(r.evictedAt) >= dayAgo).length;
    let stalledCount = 0;
    try {
      stalledCount = getDb().listStaleAgents().length;
    } catch (err) {
      // Status must still answer when the agent store is unavailable.
      log.warn({ err }, "could not count quarantined agents for watchdog status");
    }
    const anchorMs = lastRunAtMs ?? startedAtMs;
    return {
      running,
      intervalMs,
      gracePeriodMinutes,
      lastRunAt: lastRunAtMs === null ? null : new Date(lastRunAtMs).toISOString(),
      nextRunAt: running && anchorMs !== null ? new Date(anchorMs + intervalMs).toISOString() : null,
      stalledCount,
      evictedLast24h,
      recentEvictions: evictionHistory.slice(-RECENT_EVICTIONS_SHOWN).reverse(),
    };
  }

  return {
    getStatus,
    start() {
      if (timer) return;
      running = true;
      startedAtMs = clock();
      timer = setInterval(() => {
        if (ticking) return; // skip overlapping pass
        ticking = tick()
          .catch((err) => {
            log.error({ err }, "agent watchdog tick failed");
          })
          .finally(() => {
            ticking = null;
          });
      }, intervalMs);
    },
    stop() {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };
}
