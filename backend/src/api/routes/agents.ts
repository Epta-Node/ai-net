import { Router, Request, Response, NextFunction, type RequestHandler } from "express";
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import { getAgentDb, createAgentDb, type AgentDb } from "../../db/agents";
import { heartbeatRateLimitMiddleware } from "../middleware/rateLimit";
import { AgentListQuerySchema, RegisterAgentSchema } from "../schemas/agent.schema";
import { getConfig } from "../../config";

export interface AgentsRouterOptions {
  healthTimeoutMs?: number;
  db?: AgentDb;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;

export function createAgentsRouter(options: AgentsRouterOptions = {}): Router {
  const router = Router();
  const config = getConfig();
  const horizon = new Horizon.Server(config.STELLAR_HORIZON_URL);
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const getDb = () => options.db ?? createAgentDb(getAgentDb());

  router.get("/", (req: Request, res: Response): void => {
    const parsed = AgentListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    try {
      const agents = getDb().list(parsed.data);
      res.json(agents);
    } catch {
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  router.get("/:id/health", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const agent = getDb().findById(req.params.id);
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
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const agent = getDb().findById(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.post("/register", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = RegisterAgentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid agent registration data",
          details: parsed.error.flatten(),
        });
        return;
      }

      const data = parsed.data;
      if (!config.SKIP_STELLAR_ACCOUNT_VERIFY) {
        try {
          await horizon.loadAccount(data.stellarPublicKey);
        } catch (error: any) {
          if (error?.response?.status === 404) {
            res.status(400).json({
              error: "Stellar account not found",
              code: "StellarAccountNotFound",
            });
            return;
          }
          if (config.NODE_ENV !== "test") {
            res.status(400).json({
              error: "Failed to verify Stellar account",
              code: "StellarVerificationFailed",
            });
            return;
          }
        }
      }

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

      getDb().upsert(agent);
      res.status(201).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/heartbeat", heartbeatRateLimitMiddleware, (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      db.upsert({ ...agent, lastSeenAt: new Date().toISOString(), status: "online" });
      const updated = db.findById(req.params.id);
      res.status(200).json({
        status: "ok",
        lastSeenAt: updated?.lastSeenAt ?? new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const signature = req.headers["x-signature"] as string | undefined;
      const challenge = req.headers["x-challenge"] as string | undefined;
      if (!signature || !challenge) {
        res.status(401).json({ error: "Missing challenge or signature" });
        return;
      }

      try {
        const keypair = Keypair.fromPublicKey(agent.stellarPublicKey);
        const isValid = keypair.verify(Buffer.from(challenge), Buffer.from(signature, "base64"));
        if (!isValid) {
          res.status(401).json({ error: "Invalid signature" });
          return;
        }
      } catch {
        res.status(401).json({ error: "Invalid signature format" });
        return;
      }

      db.delete(req.params.id);
      res.json({ message: "Agent deleted successfully" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

let defaultAgentsRouter: Router | null = null;

export const agentsRouter: RequestHandler = (req, res, next) => {
  if (!defaultAgentsRouter) {
    defaultAgentsRouter = createAgentsRouter();
  }
  return defaultAgentsRouter(req, res, next);
};

export default agentsRouter;
