/**
 * Agent Registry — Off-chain Event Sync
 *
 * Polls Soroban RPC for contract events emitted by the AgentRegistry contract
 * and keeps the local database in sync with on-chain state.
 *
 * ## Event types handled
 *
 * | topic[1]             | Action                                               |
 * |----------------------|------------------------------------------------------|
 * | `initializd`         | Log genesis admin; no DB write needed                |
 * | `adm_chngd`          | Log admin rotation for audit trail                   |
 * | `agent_reg`          | Upsert agent record into local DB                    |
 * | `agent_drg`          | Remove agent from local DB + capability index        |
 * | `err_rptd`           | Insert unresolved error record                       |
 * | `err_rslvd`          | Mark error record resolved                           |
 * | `paused`             | Update registry status flag                          |
 * | `unpaused`           | Update registry status flag                          |
 * | `freeze`             | Mark agent frozen                                    |
 * | `unfreeze`           | Mark agent active                                    |
 * | `price_upd`          | Update agent pricing in DB                           |
 *
 * ## Topic convention
 *
 * All events share a two-element topics array:
 *   topics[0] === "registry"
 *   topics[1] === <action symbol from table above>
 *
 * The data payload is a typed XDR struct decoded by `scValToNative`.
 */

import { Server } from "@stellar/stellar-sdk/rpc";
import { scValToNative } from "@stellar/stellar-base";
import { getAgentDb, createAgentDb } from "../db/agents";

const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.REGISTRY_CONTRACT_ID;

let syncInterval: NodeJS.Timeout | null = null;
let lastLedger = 0;

// ── Topic constants (mirror symbol_short! values from lib.rs) ────────────────

/** All topic[1] values the registry contract can emit. */
const TOPICS = {
  INITIALIZED:   "init",         // initialize()        — genesis admin set
  ADMIN_CHANGED: "adm_chngd",    // set_admin()         — admin rotation
  AGENT_REG:     "agent_reg",    // register_agent(s)   — new agent committed
  AGENT_DRG:     "agent_drg",    // deregister_agent()  — agent removed
  ERR_REPORTED:  "err_rptd",     // report_error()      — new error filed
  ERR_RESOLVED:  "err_rslvd",    // resolve_errors()    — error closed
  PAUSED:        "paused",       // pause()
  UNPAUSED:      "unpaused",     // unpause()
  FREEZE:        "freeze",       // freeze_agent()
  UNFREEZE:      "unfreeze",     // unfreeze_agent()
  PRICE_UPD:     "price_upd",    // update_pricing()
} as const;

// ── Event payload shapes ─────────────────────────────────────────────────────

interface InitializedPayload {
  admin: string;
}

interface AdminChangedPayload {
  old_admin: string;
  new_admin: string;
}

interface AgentRegisteredPayload {
  agent_id: string;
  owner: string;
  capability: string;
  price_stroops: bigint | number;
}

interface AgentDeregisteredPayload {
  agent_id: string;
  owner: string;
  capability: string;
}

interface ErrorReportedPayload {
  error_id: string;   // hex-encoded BytesN<32>
  reporter: string;
}

interface ErrorResolvedPayload {
  error_id: string;
  resolution_code: number; // 0=Fixed, 1=Ignored, 2=Escalated
}

// ── Handler helpers ──────────────────────────────────────────────────────────

/**
 * Map a resolution_code integer back to a human-readable string.
 * Must stay in sync with the `Resolution` enum in lib.rs.
 */
function resolutionLabel(code: number): string {
  switch (code) {
    case 0: return "Fixed";
    case 1: return "Ignored";
    case 2: return "Escalated";
    default: return `Unknown(${code})`;
  }
}

/**
 * Process a single decoded contract event.
 *
 * @param action  - The decoded topic[1] symbol string.
 * @param payload - The native JS value decoded from the event's XDR data.
 * @param db      - AgentDb instance to apply mutations to.
 */
function handleEvent(
  action: string,
  payload: unknown,
  db: ReturnType<typeof createAgentDb>
): void {
  switch (action) {
    // ── Contract lifecycle ────────────────────────────────────────────────
    case TOPICS.INITIALIZED: {
      const data = payload as InitializedPayload;
      console.log(
        `[sync] Registry initialized. Genesis admin: ${data.admin}`
      );
      break;
    }

    case TOPICS.ADMIN_CHANGED: {
      const data = payload as AdminChangedPayload;
      console.log(
        `[sync] Admin rotated: ${data.old_admin} → ${data.new_admin}`
      );
      break;
    }

    case TOPICS.PAUSED: {
      console.log("[sync] Registry paused on-chain.");
      break;
    }

    case TOPICS.UNPAUSED: {
      console.log("[sync] Registry unpaused on-chain.");
      break;
    }

    // ── Agent lifecycle ───────────────────────────────────────────────────
    case TOPICS.AGENT_REG: {
      const data = payload as AgentRegisteredPayload;

      // Upsert into local DB. capability is stored as an array for API
      // compatibility; price is normalised from stroops (bigint-safe path).
      db.upsert({
        id: data.agent_id,
        capabilities: [data.capability],
        pricingXLM: Number(data.price_stroops) / 10_000_000,
        endpoint: "",          // endpoint not included in event; fetched lazily
        stellarPublicKey: data.owner,
        reputationScore: 0,
        lastSeenAt: new Date().toISOString(),
        status: "online",
      });

      console.log(
        `[sync] Agent registered: id=${data.agent_id} ` +
        `capability=${data.capability} owner=${data.owner}`
      );
      break;
    }

    case TOPICS.AGENT_DRG: {
      const data = payload as AgentDeregisteredPayload;

      db.remove?.(data.agent_id);

      console.log(
        `[sync] Agent deregistered: id=${data.agent_id} ` +
        `capability=${data.capability} owner=${data.owner}`
      );
      break;
    }

    case TOPICS.FREEZE: {
      const agentId =
        typeof payload === "string" ? payload : (payload as { agent_id?: string }).agent_id ?? "";

      db.setFrozen?.(agentId, true);
      console.log(`[sync] Agent frozen: ${agentId}`);
      break;
    }

    case TOPICS.UNFREEZE: {
      const agentId =
        typeof payload === "string" ? payload : (payload as { agent_id?: string }).agent_id ?? "";

      db.setFrozen?.(agentId, false);
      console.log(`[sync] Agent unfrozen: ${agentId}`);
      break;
    }

    case TOPICS.PRICE_UPD: {
      // Payload is a tuple: (agent_id, new_price_stroops)
      const [agentId, priceStroops] = Array.isArray(payload)
        ? payload
        : [
            (payload as { agent_id?: string }).agent_id ?? "",
            (payload as { new_price?: number }).new_price ?? 0,
          ];

      db.updatePricing?.(agentId, Number(priceStroops) / 10_000_000);
      console.log(
        `[sync] Price updated: agent=${agentId} ` +
        `price_xlm=${(Number(priceStroops) / 10_000_000).toFixed(7)}`
      );
      break;
    }

    // ── Error lifecycle ───────────────────────────────────────────────────
    case TOPICS.ERR_REPORTED: {
      const data = payload as ErrorReportedPayload;

      db.upsertError?.({
        id: data.error_id,
        reporter: data.reporter,
        resolved: false,
        resolution: null,
        reportedAt: new Date().toISOString(),
      });

      console.log(
        `[sync] Error reported: id=${data.error_id} reporter=${data.reporter}`
      );
      break;
    }

    case TOPICS.ERR_RESOLVED: {
      const data = payload as ErrorResolvedPayload;
      const label = resolutionLabel(data.resolution_code);

      db.resolveError?.(data.error_id, label);

      console.log(
        `[sync] Error resolved: id=${data.error_id} resolution=${label}`
      );
      break;
    }

    default: {
      // Unknown action — log and skip to stay forward-compatible with future
      // contract versions that may emit additional event types.
      console.debug(`[sync] Unhandled event action: "${action}"`);
      break;
    }
  }
}

// ── Sync loop ────────────────────────────────────────────────────────────────

/**
 * Start the background polling loop.
 *
 * Polls every 60 seconds. On each tick, fetches all contract events since the
 * last known ledger and dispatches them to `handleEvent`.
 */
export function startAgentSync(): void {
  if (!CONTRACT_ID) {
    console.warn("[sync] No REGISTRY_CONTRACT_ID provided, skipping agent sync");
    return;
  }

  const server = new Server(RPC_URL);

  const poll = async () => {
    try {
      // ── Bootstrap: start 100 ledgers behind current tip ─────────────────
      if (lastLedger === 0) {
        try {
          const latest = await server.getLatestLedger();
          lastLedger = Math.max(latest.sequence - 100, 0);
        } catch (e) {
          console.warn("[sync] Could not fetch latest ledger, will retry", e);
          return;
        }
      }

      if (lastLedger === 0) return;

      const latestNow = await server.getLatestLedger();
      if (latestNow.sequence <= lastLedger) return;

      // ── Fetch events from Soroban RPC ────────────────────────────────────
      // Filter by contract ID only; we dispatch on topic[1] ourselves so we
      // handle all event types with a single RPC call per tick.
      const eventsResp = await server.getEvents({
        startLedger: lastLedger,
        filters: [
          {
            type: "contract",
            contractIds: [CONTRACT_ID],
            topics: [],
          },
        ],
        limit: 1000,
      });

      lastLedger = latestNow.sequence;

      const db = createAgentDb(getAgentDb());

      for (const event of eventsResp.events) {
        try {
          const topicNative: unknown[] = event.topic.map((t: unknown) =>
            scValToNative(t as Parameters<typeof scValToNative>[0])
          );

          // All registry events have topic[0] === "registry".
          if (topicNative[0] !== "registry") continue;

          const action = topicNative[1] as string;
          const payload = scValToNative(
            event.value as Parameters<typeof scValToNative>[0]
          );

          handleEvent(action, payload, db);
        } catch (e) {
          console.error("[sync] Error parsing event", e);
        }
      }
    } catch (error) {
      console.error("[sync] Poll failed:", error);
    }
  };

  poll(); // immediate first run on startup
  syncInterval = setInterval(poll, 60_000);
}

/**
 * Stop the background polling loop.
 * Call this during graceful shutdown to avoid leaked timers in tests.
 */
export function stopAgentSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

/**
 * Reset the last-seen ledger cursor.
 *
 * Useful in integration tests that need to re-process events from a known
 * starting ledger without restarting the process.
 */
export function resetSyncCursor(ledger = 0): void {
  lastLedger = ledger;
}
