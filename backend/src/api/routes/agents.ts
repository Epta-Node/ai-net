import { Router, Request, Response } from "express";
import { Keypair, Server as HorizonServer } from "@stellar/stellar-sdk";
import { getAgentDb, createAgentDb, AgentDb } from "../../db/agents";
import { validate } from "../middleware/validate";
import {
  RegisterAgentSchema,
  AgentListQuerySchema,
  AgentIdParamSchema,
} from "../schemas/agent.schema";

export interface AgentsRouterOptions {
  healthTimeoutMs?: number;
  db?: AgentDb;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const horizon = new HorizonServer("https://horizon-testnet.stellar.org");

export function createAgentsRouter(options: AgentsRouterOptions = {}): Router {
  const router = Router();
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;

  const getDb = () => options.db ?? createAgentDb(getAgentDb());

  // GET /api/agents
  router.get(
    "/",
    validate({ query: AgentListQuerySchema }),
    (req: Request, res: Response): void => {
      const db = getDb();
      const { capability, minReputation, maxPriceXLM, status } = req.query as {
        capability?: string;
        minReputation?: number;
        maxPriceXLM?: number;
        status?: "online" | "offline";
      };

      try {
        const agents = db.list({
          capability,
          minReputation,
          maxPriceXLM,
          status,
        });
        res.json(agents);
      } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
      }
    },
  );

  // GET /api/agents/:id
  router.get(
    "/:id",
    validate({ params: AgentIdParamSchema }),
    (req: Request, res: Response): void => {
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json(agent);
    },
  );

  // GET /api/agents/:id/health
  router.get(
    "/:id/health",
    validate({ params: AgentIdParamSchema }),
    async (req: Request, res: Response): Promise<void> => {
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), healthTimeoutMs);

      try {
        const response = await fetch(agent.endpoint, {
          method: "GET",
          signal: controller.signal,
        });

        res.status(200).json({
          status: response.ok ? "healthy" : "unreachable",
          latencyMs: Date.now() - startedAt,
        });
      } catch {
        res.status(200).json({
          status: "unreachable",
          latencyMs: Date.now() - startedAt,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  // POST /api/agents/register
  router.post(
    "/register",
    validate({ body: RegisterAgentSchema }),
    async (req: Request, res: Response): Promise<void> => {
      const data = req.body as {
        agentId: string;
        capabilities: string[];
        pricingXLM: number;
        endpoint: string;
        stellarPublicKey: string;
      };

      // Verify Stellar account exists
      try {
        await horizon.loadAccount(data.stellarPublicKey);
      } catch (err: any) {
        if (err?.response?.status === 404) {
          res.status(400).json({ error: "StellarAccountNotFound" });
          return;
        }
        res.status(400).json({ error: "Failed to verify Stellar account" });
        return;
      }

      const db = getDb();
      const agent = {
        id: data.agentId,
        capabilities: data.capabilities,
        pricingXLM: data.pricingXLM,
        endpoint: data.endpoint,
        stellarPublicKey: data.stellarPublicKey,
        reputationScore: 0,
        lastSeenAt: new Date().toISOString(),
        status: "online" as const,
      };

      db.upsert(agent);

      res.status(201).json(agent);
    },
  );

  // POST /api/agents/:id/heartbeat
  router.post(
    "/:id/heartbeat",
    validate({ params: AgentIdParamSchema }),
    (req: Request, res: Response): void => {
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      db.upsert({ ...agent, lastSeenAt: new Date().toISOString(), status: "online" });
      res.status(204).send();
    },
  );

  // DELETE /api/agents/:id
  router.delete(
    "/:id",
    validate({ params: AgentIdParamSchema }),
    (req: Request, res: Response): void => {
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const signature = req.headers["x-signature"] as string;
      const challenge = req.headers["x-challenge"] as string;

      if (!signature || !challenge) {
        res.status(401).json({ error: "Missing challenge or signature" });
        return;
      }

      try {
        const keypair = Keypair.fromPublicKey(agent.stellarPublicKey);
        const isValid = keypair.verify(
          Buffer.from(challenge),
          Buffer.from(signature, "base64"),
        );
        if (!isValid) {
          res.status(401).json({ error: "Invalid signature" });
          return;
        }
      } catch (err) {
        res.status(401).json({ error: "Invalid signature format" });
        return;
      }

      db.delete(req.params.id);
      res.json({ message: "Agent deleted successfully" });
    },
  );

  return router;
}

export const agentsRouter = createAgentsRouter();
