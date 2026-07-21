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

  /**
   * @openapi
   * /api/agents:
   *   get:
   *     summary: List registered agents
   *     operationId: listAgents
   *     tags: [Agents]
   *     security: []
   *     parameters:
   *       - in: query
   *         name: capability
   *         schema: { type: string }
   *         description: Filter agents that support this capability
   *       - in: query
   *         name: minReputation
   *         schema: { type: number }
   *       - in: query
   *         name: maxPriceXLM
   *         schema: { type: number }
   *     responses:
   *       200:
   *         description: List of agents
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Agent'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
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

  /**
   * @openapi
   * /api/agents/{id}:
   *   get:
   *     summary: Get an agent by ID
   *     operationId: getAgent
   *     tags: [Agents]
   *     security: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Agent found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Agent'
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
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
   *                 latencyMs:
   *                   type: number
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
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

  /**
   * @openapi
   * /api/agents/register:
   *   post:
   *     summary: Register a new agent
   *     description: >
   *       Verifies that the provided Stellar public key corresponds to an
   *       existing funded account on Horizon testnet before registering the
   *       agent. Registration fails with 400 if the account cannot be found
   *       or verified.
   *     tags: [Agents]
   *     security: []
   *     operationId: registerAgent
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [agentId, capabilities, pricingXLM, endpoint, stellarPublicKey]
   *             properties:
   *               agentId:
   *                 type: string
   *               capabilities:
   *                 type: array
   *                 items:
   *                   type: string
   *               pricingXLM:
   *                 type: number
   *               endpoint:
   *                 type: string
   *                 format: uri
   *               stellarPublicKey:
   *                 type: string
   *     responses:
   *       201:
   *         description: Agent registered
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Agent'
   *       400:
   *         description: Validation error or Stellar account not found/unverifiable
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
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

  /**
   * @openapi
   * /api/agents/{id}:
   *   delete:
   *     summary: Delete an agent
   *     operationId: deleteAgent
   *     description: >
   *       Requires a valid Stellar signature proving ownership of the
   *       agent's registered keypair. The caller must sign the value of
   *       the `x-challenge` header and pass the base64-encoded signature
   *       in `x-signature`.
   *     tags: [Agents]
   *     security:
   *       - AgentSignatureAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: header
   *         name: x-challenge
   *         required: true
   *         schema: { type: string }
   *         description: The challenge string the caller must sign
   *       - in: header
   *         name: x-signature
   *         required: true
   *         schema: { type: string }
   *         description: Base64-encoded signature of the challenge, signed with the agent's Stellar keypair
   *     responses:
   *       200:
   *         description: Agent deleted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: Agent deleted successfully
   *       401:
   *         description: Missing, invalid, or malformed signature
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
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
