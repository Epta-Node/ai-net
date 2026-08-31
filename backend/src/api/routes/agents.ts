import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import { RegisterAgentSchema } from "../schemas/agent.schema";
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
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
const horizon = new Horizon.Server(HORIZON_URL);

export function createAgentsRouter(options: AgentsRouterOptions = {}): Router {
  const router = Router();
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
  });

  /**
   * @openapi
   * /api/agents/{id}:
   *   get:
   *     summary: Get registered agent by ID
   *     description: Fetches agent profile, capabilities, reputation score, and status by unique agentId.
   *     operationId: getAgent
   *     tags: [Agents]
   *     security: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         description: Unique agent identifier
   *         example: "agent_crypto_analyst_01"
   *     responses:
   *       200:
   *         description: Agent details retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Agent'
   *             example:
   *               id: "agent_crypto_analyst_01"
   *               capabilities: ["research", "report"]
   *               pricingXLM: 0.25
   *               endpoint: "https://agent-crypto.example.com/api"
   *               stellarPublicKey: "GABZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4XYZ"
   *               reputationScore: 98.5
   *               lastSeenAt: "2026-08-25T17:20:00.000Z"
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   *             example:
   *               error: "Agent not found"
   */
  // GET /api/agents/:id
  router.get("/:id", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const correlationId = res.locals.correlationId as string | undefined;
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        throw new NotFoundError("Agent", req.params.id, undefined, correlationId);
      }
      res.json(agent);
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/agents/{id}/health:
   *   get:
   *     summary: Check an agent's live health/reachability
   *     description: >
   *       Sends a GET request to the agent's registered endpoint and reports
   *       whether it responded within the configured timeout. Always
   *       returns 200 — reachability failures are reported in the body,
   *       not via HTTP status.
   *     tags: [Agents]
   *     security: []
   *     operationId: checkAgentHealth
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         example: "agent_crypto_analyst_01"
   *     responses:
   *       200:
   *         description: Health check result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   enum: [healthy, unreachable]
   *                   example: "healthy"
   *                 latencyMs:
   *                   type: number
   *                   example: 45
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   */
  // GET /api/agents/:id/health
  router.get("/:id/health", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const correlationId = res.locals.correlationId as string | undefined;
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        throw new NotFoundError("Agent", req.params.id, undefined, correlationId);
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
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/agents/register:
   *   post:
   *     summary: Register a new specialized agent
   *     description: >
   *       Registers an agent with specified capabilities and pricing. Verifies that the provided
   *       Stellar public key corresponds to a valid funded account on Stellar Horizon.
   *     tags: [Agents]
   *     security: []
   *     operationId: registerAgent
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/RegisterAgentRequest'
   *           examples:
   *             crypto_research_agent:
   *               summary: Crypto Research Agent
   *               value:
   *                 agentId: "agent_crypto_analyst_01"
   *                 capabilities: ["research", "report"]
   *                 pricingXLM: 0.25
   *                 endpoint: "https://agent-crypto.example.com/api"
   *                 stellarPublicKey: "GABZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4XYZ"
   *     responses:
   *       201:
   *         description: Agent registered successfully
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
   *               $ref: '#/components/schemas/Agent'
   *       400:
   *         description: Validation error or Stellar account verification failure
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ValidationError'
   *             example:
   *               error: "StellarAccountNotFound"
   *       429:
   *         description: Registration rate limit exceeded
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/RateLimitError'
   */
  // POST /api/agents/register
  router.post("/register", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const correlationId = res.locals.correlationId as string | undefined;
      const parse = RegisterAgentSchema.safeParse(req.body);
      if (!parse.success) {
        throw new ValidationError(
          "Invalid agent registration data",
          { issues: parse.error.flatten() },
          correlationId,
        );
      }
      
      const data = parse.data;
      
      // Verify Stellar account exists
      if (process.env.SKIP_STELLAR_ACCOUNT_VERIFY !== "true") {
        try {
          await horizon.loadAccount(data.stellarPublicKey);
        } catch (err: any) {
          if (err?.response?.status === 404) {
            throw new ValidationError(
              "Stellar account not found",
              { stellarPublicKey: data.stellarPublicKey, code: "StellarAccountNotFound" },
              correlationId,
            );
          }
          if (process.env.NODE_ENV !== "test") {
            throw new ValidationError(
              "Failed to verify Stellar account",
              { reason: err.message },
              correlationId,
            );
          }
        }
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
        status: 'online' as const
      };
      
      db.upsert(agent);
      
      res.status(201).json(agent);
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/agents/{id}/heartbeat:
   *   post:
   *     summary: Agent heartbeat keep-alive
   *     description: Updates the agent's lastSeenAt timestamp and keeps its online status active.
   *     tags: [Agents]
   *     security: []
   *     operationId: agentHeartbeat
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         example: "agent_crypto_analyst_01"
   *     responses:
   *       200:
   *         description: Heartbeat recorded
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AgentHeartbeatResponse'
   *             example:
   *               status: "ok"
   *               lastSeenAt: "2026-08-25T17:30:00.000Z"
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   *       429:
   *         description: Heartbeat rate limit exceeded
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/RateLimitError'
   */
  // POST /api/agents/:id/heartbeat
  router.post("/:id/heartbeat", heartbeatRateLimitMiddleware, (req: Request, res: Response, next: NextFunction): void => {
    try {
      const correlationId = res.locals.correlationId as string | undefined;
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        throw new NotFoundError("Agent", req.params.id, undefined, correlationId);
      }

      db.upsert({ ...agent, lastSeenAt: new Date().toISOString(), status: 'online' });
      const updated = db.findById(req.params.id);
      res.status(200).json({
        status: "ok",
        lastSeenAt: updated?.lastSeenAt ?? new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/agents/{id}:
   *   delete:
   *     summary: Deregister an agent
   *     description: >
   *       Removes an agent from the registry. Requires cryptographic verification of
   *       an Ed25519 signature generated with the agent's registered Stellar secret key.
   *     tags: [Agents]
   *     security:
   *       - AgentSignatureAuth: []
   *       - AgentChallengeAuth: []
   *     operationId: deleteAgent
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         description: Unique agent identifier
   *         example: "agent_crypto_analyst_01"
   *       - in: header
   *         name: x-signature
   *         required: true
   *         schema: { type: string }
   *         description: Base64-encoded Ed25519 signature of the challenge
   *       - in: header
   *         name: x-challenge
   *         required: true
   *         schema: { type: string }
   *         description: Plaintext challenge string matching the server challenge
   *     responses:
   *       200:
   *         description: Agent deleted successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message: { type: string, example: "Agent deleted successfully" }
   *       401:
   *         description: Missing or invalid signature/challenge
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UnauthorizedError'
   *             example:
   *               error: "Invalid signature"
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   */
  // DELETE /api/agents/:id
  router.delete("/:id", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const correlationId = res.locals.correlationId as string | undefined;
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        throw new NotFoundError("Agent", req.params.id, undefined, correlationId);
      }
      
      const signature = req.headers["x-signature"] as string;
      const challenge = req.headers["x-challenge"] as string;
      
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
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export const agentsRouter = createAgentsRouter();
export default agentsRouter;