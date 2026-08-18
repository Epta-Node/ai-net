import { Server } from "@stellar/stellar-sdk/rpc";
import { scValToNative } from "@stellar/stellar-base";
import { getAgentDb, createAgentDb } from "../db/agents";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.REGISTRY_CONTRACT_ID;

let syncInterval: NodeJS.Timeout | null = null;
let lastLedger = 0;

export function startAgentSync(): void {
  if (!CONTRACT_ID) {
    console.warn("No REGISTRY_CONTRACT_ID provided, skipping agent sync");
    return;
  }

  const server = new Server(RPC_URL);

  const poll = async () => {
    try {
      if (lastLedger === 0) {
        try {
          const latest = await server.getLatestLedger();
          lastLedger = Math.max(latest.sequence - 100, 0);
        } catch (e) {
          lastLedger = 0;
        }
      }

      if (lastLedger === 0) return; // Wait for successful ledger fetch

      const latestNow = await server.getLatestLedger();
      if (latestNow.sequence <= lastLedger) return;

      const eventsResp = await server.getEvents({
        startLedger: lastLedger,
        filters: [
          {
            type: "contract",
            contractIds: [CONTRACT_ID],
            topics: [] 
          }
        ],
        limit: 1000,
      });

      lastLedger = latestNow.sequence;

      const db = createAgentDb(getAgentDb());

      for (const event of eventsResp.events) {
        try {
          const topicNative = event.topic.map((t: any) => scValToNative(t));
          
          // Assuming "register" or simply upsert any valid event matching the schema
          if (topicNative[0] === "register" || topicNative.length > 0) {
            const val = scValToNative(event.value);
            
            if (val && typeof val === "object" && val.id) {
               db.upsert({
                 id: val.id,
                 capabilities: Array.isArray(val.capabilities) ? val.capabilities : (val.capabilities ? [val.capabilities] : []),
                 pricingXLM: Number(val.pricingXLM) || 0,
                 endpoint: val.endpoint || "",
                 stellarPublicKey: val.stellarPublicKey || "",
                 reputationScore: Number(val.reputationScore) || 0,
                 lastSeenAt: new Date().toISOString(),
                 status: 'online'
               });
            }
          }
        } catch (e) {
          console.error("Error parsing agent event", e);
        }
      }
    } catch (error) {
      console.error("Agent sync failed:", error);
    }
  };

  poll(); // immediate initial run
  syncInterval = setInterval(poll, 60000);
}

export function stopAgentSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}
