import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import { getAgentDb, createAgentDb, AgentDb } from "../../db/agents";
import { heartbeatRateLimitMiddleware } from "../middleware/rateLimit";
import { NotFoundError, ValidationError, UnauthorizedError, AppError } from "../../errors";

const AgentCursorListSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  capability: z.string().optional(),
  minReputation: z.coerce.number().optional(),
  maxPriceXLM: z.coerce.number().optional(),
  status: z.enum(["online", "offline"]).optional(),
});

export interface AgentsRouterOptions {
  healthTimeoutMs?: number;
  db?: AgentDb;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;

// Mirrors the RegisterAgentRequest schema documented in api/docs.ts.
const RegisterAgentSchema = z.object({
  agentId: z.string().min(1),
  capabilities: z.array(z.string()).min(1),
  pricingXLM: z.number().min(0.001),
  endpoint: z.string().url(),
  stellarPublicKey: z.string().regex(/^G[A-Z2-7]{55}$/),
});

export function createAgentsRouter(options: AgentsRouterOptions = {}): Router {
  const router = Router();
  const config = getConfig();
  const horizon = new Horizon.Server(config.STELLAR_HORIZON_URL);
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const getDb = () => options.db ?? createAgentDb(getAgentDb());

  /**
   * @openapi
   * /api/agents:
   *   get:
   *     summary: List registered AI agents
   *     description: Retrieves registered agents matching optional capability, minimum reputation, and maximum price filters.
   *     operationId: listAgents
   *     tags: [Agents]
   *     security: []
   *     parameters:
   *       - in: query
   *         name: capability
   *         schema: { type: string }
   *         description: Filter agents that support this capability
   *         example: "research"
   *       - in: query
   *         name: minReputation
   *         schema: { type: number }
   *         description: Minimum reputation score threshold
   *         example: 80.0
   *       - in: query
   *         name: maxPriceXLM
   *         schema: { type: number }
   *         description: Maximum price per task execution in XLM
   *         example: 1.5
   *     responses:
   *       200:
   *         description: Array of matching registered agents
   *         headers:
   *           X-RateLimit-Limit:
   *             $ref: '#/components/headers/X-RateLimit-Limit'
   *           X-RateLimit-Remaining:
   *             $ref: '#/components/headers/X-RateLimit-Remaining'
   *           X-RateLimit-Reset:
   *             $ref: '#/components/headers/X-RateLimit-Reset'
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Agent'
   *             example:
   *               - id: "agent_crypto_analyst_01"
   *                 capabilities: ["research", "report"]
   *                 pricingXLM: 0.25
   *                 endpoint: "https://agent-crypto.example.com/api"
   *                 stellarPublicKey: "GABZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4XYZ"
   *                 reputationScore: 98.5
   *                 lastSeenAt: "2026-08-25T17:20:00.000Z"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/InternalServerError'
   */
  // GET /api/agents — supports cursor pagination when ?cursor or ?limit present
  router.get("/", (req: Request, res: Response, next: NextFunction): void => {
    const db = getDb();
    const useCursor = "cursor" in req.query || "limit" in req.query;

    if (useCursor) {
      const parse = AgentCursorListSchema.safeParse(req.query);
      if (!parse.success) {
        res.status(400).json({ error: parse.error.flatten() });
        return;
      }
      const { cursor, limit, capability, minReputation, maxPriceXLM, status } = parse.data;
      try {
        const page = db.listCursor({ cursor, limit, capability, minReputation, maxPriceXLM, status });
        res.json({
          data: {
            items: page.items,
            pagination: {
              limit,
              nextCursor: page.nextCursor ?? null,
              hasNextPage: !!page.nextCursor,
            },
          },
          _links: {
            self: `/api/agents`,
            ...(page.nextCursor
              ? { next: `/api/agents?cursor=${encodeURIComponent(page.nextCursor)}&limit=${limit}` }
              : {}),
          },
        });
      } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
      }
      return;
    }

    // Legacy flat-array response for backward compatibility
    const capability = req.query.capability as string | undefined;
    const minReputation = req.query.minReputation ? parseFloat(req.query.minReputation as string) : undefined;
    const maxPriceXLM = req.query.maxPriceXLM ? parseFloat(req.query.maxPriceXLM as string) : undefined;

    try {
      const agents = db.list({ capability, minReputation, maxPriceXLM });
      res.json(agents);
    } catch (err) {
      next(new AppError("Internal Server Error", 500, "INTERNAL_ERROR"));
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
      const correlationId = res.locals.correlationId as string | undefined;
      const parse = registerAgentSchema.safeParse(req.body);
      if (!parse.success) {
        throw new ValidationError(
          "Invalid agent registration data",
          { issues: parse.error.flatten() },
          correlationId,
        );
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
        throw new UnauthorizedError("Missing challenge or signature", undefined, correlationId);
      }

      try {
        const keypair = Keypair.fromPublicKey(agent.stellarPublicKey);
        const isValid = keypair.verify(Buffer.from(challenge), Buffer.from(signature, "base64"));
        if (!isValid) {
          throw new UnauthorizedError("Invalid signature", undefined, correlationId);
        }
      } catch (innerErr) {
        if (innerErr instanceof UnauthorizedError) throw innerErr;
        throw new UnauthorizedError("Invalid signature format", undefined, correlationId);
      }

      db.delete(req.params.id);
      res.json({ message: "Agent deleted successfully" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const agentsRouter = createAgentsRouter();
export default agentsRouter;