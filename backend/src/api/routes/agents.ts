import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Horizon } from "@stellar/stellar-sdk";
import { getAgentDb, createAgentDb, AgentDb } from "../../db/agents";
import {
  agentAuthFailureGuard,
  agentChallengeRateLimitMiddleware,
  heartbeatRateLimitMiddleware,
  recordAuthFailure,
} from "../middleware/rateLimit";
import { NotFoundError, ValidationError, AppError } from "../../errors";
import { cacheMiddleware } from "../middleware/cache";
import { invalidateAgentsCache } from "../../cache/invalidation";
import { ttlForRoute, getConfig } from "../../config";
import { isEnabled } from "../../services/featureFlags";
import {
  AGENT_AUTH_PURPOSES,
  isAgentAuthError,
  issueAgentChallenge,
  verifyAgentOwnership,
  type AgentAuthPurpose,
} from "../agentSignature";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ module: "agents.routes" });

const AgentCursorListSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100),
  capability: z.string().optional(),
  minReputation: z.coerce.number().finite().optional(),
  maxPriceXLM: z.coerce.number().finite().optional(),
  status: z.enum(["online", "offline"]).optional(),
});

export interface AgentsRouterOptions {
  healthTimeoutMs?: number;
  db?: AgentDb;
}

const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

/** Bounds applied at the registration boundary so malformed or oversized payloads are never stored (#754). */
const AGENT_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CAPABILITY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_CAPABILITIES = 32;
const MAX_ENDPOINT_LENGTH = 2048;

// Mirrors the RegisterAgentRequest schema documented in api/docs.ts. Strict so
// unknown fields are rejected instead of silently dropped.
const RegisterAgentSchema = z
  .object({
    agentId: z.string().regex(AGENT_ID_REGEX, "Invalid agent id format"),
    capabilities: z
      .array(z.string().regex(CAPABILITY_REGEX, "Invalid capability format"))
      .min(1)
      .max(MAX_CAPABILITIES)
      .refine((caps) => new Set(caps).size === caps.length, "Capabilities must be unique"),
    pricingXLM: z.number().min(0.001),
    endpoint: z
      .string()
      .max(MAX_ENDPOINT_LENGTH)
      .url()
      .refine((value) => /^https?:\/\//i.test(value), "Endpoint must use http or https"),
    stellarPublicKey: z.string().regex(STELLAR_PUBLIC_KEY_REGEX, "Invalid Stellar public key format"),
    bondAmountXLM: z.number().nonnegative().optional(),
  })
  .strict();

/**
 * `POST /api/agents/challenge` body.
 *
 * `payload` must be byte-for-byte the object the client will later send to the
 * protected route, because the signature covers its hash. That is what stops a
 * signature captured for a benign registration being replayed against a
 * different endpoint or a different price.
 */
const AgentChallengeRequestSchema = z.object({
  purpose: z.enum(AGENT_AUTH_PURPOSES),
  publicKey: z.string().regex(STELLAR_PUBLIC_KEY_REGEX, "Invalid Stellar public key format"),
  agentId: z.string().min(1).optional(),
  payload: z.unknown(),
});

const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const getHorizon = () => new Horizon.Server(getConfig().STELLAR_HORIZON_URL);

/**
 * Purposes that may still be called unsigned while the `agent_ownership_proof`
 * flag is off.
 *
 * Register and heartbeat are the two routes existing agent clients call
 * continuously, so they get the deprecation window requested in #558. Delete is
 * excluded on purpose: it is destructive, rarely used, and an unsigned delete
 * would let anyone de-register someone else's agent — exactly the class of
 * attack #557 exists to close.
 */
const MIGRATION_EXEMPT_PURPOSES: ReadonlySet<AgentAuthPurpose> = new Set(["register", "heartbeat"]);

export function createAgentsRouter(options: AgentsRouterOptions = {}): Router {
  const router = Router();
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const getDb = () => options.db ?? createAgentDb(getAgentDb());

  /**
   * Announce that the unsigned agent path is still tolerated.
   *
   * Required for a rolling migration: agents that have not yet shipped signing
   * get a machine-readable deprecation notice instead of a hard 401, and ops
   * can see how long the grace period runs from `AGENT_AUTH_SUNSET_DATE`.
   */
  function markUnsignedPathDeprecated(res: Response): void {
    const sunset = getConfig().AGENT_AUTH_SUNSET_DATE;
    res.setHeader(
      "Deprecation",
      "true",
    );
    if (sunset) {
      res.setHeader("Sunset", sunset);
      res.setHeader(
        "Warning",
        `299 - "Unsigned agent requests are deprecated; signature required after ${sunset}"`,
      );
    }
  }

  /**
   * Ownership proof shared by register, heartbeat and delete (#557, #558).
   *
   * `payload` is hashed into the signed message, so it must be the canonical
   * form of the request this route is about to act on. Failures are counted
   * against the failure-path limiter so an unauthenticated caller cannot use
   * these routes to probe which agent ids exist.
   */
  function requireOwnership(
    req: Request,
    res: Response,
    input: {
      purpose: AgentAuthPurpose;
      publicKey: string;
      payload: unknown;
      agentId?: string;
    },
  ): void {
    if (req.headers["x-challenge"] || req.headers["x-signature"]) {
      verifyAgentOwnership(req, { ...input, correlationId: res.locals.correlationId as string | undefined });
      return;
    }

    // No proof presented at all. During the migration window this is a warning
    // rather than a rejection; once the flag is on it is a hard 401.
    if (MIGRATION_EXEMPT_PURPOSES.has(input.purpose) && !isEnabled("agent_ownership_proof")) {
      markUnsignedPathDeprecated(res);
      logger.warn(
        { purpose: input.purpose, agentId: input.agentId },
        "unsigned agent request accepted: agent_ownership_proof flag is disabled",
      );
      return;
    }

    // Throws AgentAuthError; the route's catch records the failure.
    verifyAgentOwnership(req, { ...input, correlationId: res.locals.correlationId as string | undefined });
  }

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
   *         name: limit
   *         required: true
   *         schema: { type: integer, minimum: 1, maximum: 100 }
   *       - in: query
   *         name: cursor
   *         schema: { type: string }
   *         description: nextCursor from the previous response
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
   *               type: object
   *               properties:
   *                 data:
   *                   type: object
   *                   properties:
   *                     items:
   *                       type: array
   *                       items:
   *                         $ref: '#/components/schemas/Agent'
   *                     pagination:
   *                       type: object
   *                       properties:
   *                         limit: { type: integer }
   *                         nextCursor: { type: string, nullable: true }
   *                         hasNextPage: { type: boolean }
   *       400:
   *         description: Missing or invalid limit, filters, or cursor
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // An explicit bounded limit is required; the old unbounded array API is rejected.
  router.get("/", (req: Request, res: Response, next: NextFunction): void => {
    // Validate before cache lookup so legacy unbounded cached responses cannot
    // bypass the new contract after deployment.
    const parse = AgentCursorListSchema.safeParse(req.query);
    if (!parse.success) {
      next(new ValidationError("Invalid query parameters; limit (1–100) is required",
        { issues: parse.error.flatten() }, res.locals.correlationId as string | undefined));
      return;
    }
    res.locals.agentListOptions = parse.data;
    next();
  }, cacheMiddleware({ ttl: ttlForRoute("agents") }), (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = res.locals.agentListOptions as z.infer<typeof AgentCursorListSchema>;
      const { limit, ...options } = parsed;
      const page = getDb().listCursor({ ...options, limit });
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined) query.set(key, String(value));
      }
      const self = `/api/agents?${query}`;
      if (page.nextCursor) query.set("cursor", page.nextCursor);
      res.json({
        data: {
          items: page.items,
          pagination: { limit, nextCursor: page.nextCursor ?? null, hasNextPage: !!page.nextCursor },
        },
        _links: { self, ...(page.nextCursor ? { next: `/api/agents?${query}` } : {}) },
      });
    } catch (err) {
      next(err instanceof ValidationError ? err : new AppError("Internal Server Error", 500, "INTERNAL_ERROR"));
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
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   */
  // GET /api/agents/:id
  router.get("/:id", cacheMiddleware({ ttl: ttlForRoute("agents") }), (req: Request, res: Response, next: NextFunction): void => {
    try {
      const agent = getDb().findById(req.params.id);
      if (!agent) {
        throw new NotFoundError("Agent", req.params.id, undefined, res.locals.correlationId as string | undefined);
      }
      res.json(agent);
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/agents/{id}/health:
   *   get:
   *     summary: Check an agent's live health/reachability
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
   *       404:
   *         description: Agent not found
   */
  // GET /api/agents/:id/health
  router.get("/:id/health", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const agent = getDb().findById(req.params.id);
      if (!agent) {
        throw new NotFoundError("Agent", req.params.id, undefined, res.locals.correlationId as string | undefined);
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

  /**
   * @openapi
   * /api/agents/challenge:
   *   post:
   *     summary: Request an agent ownership challenge
   *     description: >
   *       Mints a single-use, expiring nonce and returns the exact canonical
   *       message the agent must sign with its Stellar secret key. Send the
   *       returned `challenge` as `x-challenge` and the base64 Ed25519
   *       signature of `message` as `x-signature` on the protected route.
   *       `payload` must match the body the protected route will receive.
   *     tags: [Agents]
   *     security: []
   *     operationId: requestAgentChallenge
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [purpose, publicKey, payload]
   *             properties:
   *               purpose:
   *                 type: string
   *                 enum: [register, heartbeat, delete]
   *               publicKey:
   *                 type: string
   *                 description: Stellar public key of the agent
   *               agentId:
   *                 type: string
   *                 description: Required for the heartbeat and delete purposes
   *               payload:
   *                 description: The exact object that will be sent to the protected route
   *     responses:
   *       200:
   *         description: Challenge issued
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 challenge: { type: string, description: Nonce to send as x-challenge }
   *                 message: { type: string, description: Canonical string to sign }
   *                 expiresAt: { type: string, format: date-time }
   *       400:
   *         description: Invalid challenge request
   *       429:
   *         description: Challenge rate limit exceeded
   */
  // POST /api/agents/challenge
  router.post(
    "/challenge",
    agentChallengeRateLimitMiddleware,
    (req: Request, res: Response, next: NextFunction): void => {
      try {
        const correlationId = res.locals.correlationId as string | undefined;
        const parse = AgentChallengeRequestSchema.safeParse(req.body);
        if (!parse.success) {
          throw new ValidationError(
            "Invalid agent challenge request",
            { issues: parse.error.flatten() },
            correlationId,
          );
        }

        const { purpose, publicKey, agentId, payload } = parse.data;
        if ((purpose === "heartbeat" || purpose === "delete") && !agentId) {
          throw new ValidationError(
            `agentId is required for the "${purpose}" purpose`,
            { purpose },
            correlationId,
          );
        }

        res.status(200).json(issueAgentChallenge({ purpose, publicKey, agentId, payload }));
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * @openapi
   * /api/agents/register:
   *   post:
   *     summary: Register a new specialized agent
   *     description: >
   *       Requires proof of ownership of `stellarPublicKey`: first obtain a
   *       challenge from `POST /api/agents/challenge` with purpose `register`
   *       and this exact body as `payload`, then send the nonce as
   *       `x-challenge` and the base64 signature of the returned `message` as
   *       `x-signature`. Without a valid signature the agent is rejected, so
   *       nobody can register under another account's public key and receive
   *       its escrow settlements.
   *     tags: [Agents]
   *     security:
   *       - AgentSignatureAuth: []
   *       - AgentChallengeAuth: []
   *     operationId: registerAgent
   *     parameters:
   *       - in: header
   *         name: x-signature
   *         required: true
   *         schema: { type: string }
   *         description: Base64 (or hex) Ed25519 signature of the challenge message
   *       - in: header
   *         name: x-challenge
   *         required: true
   *         schema: { type: string }
   *         description: Single-use nonce issued by POST /api/agents/challenge
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/RegisterAgentRequest'
   *     responses:
   *       201:
   *         description: Agent registered successfully
   *       400:
   *         description: Validation error or Stellar account verification failure
   *       401:
   *         description: Missing, expired, replayed challenge or invalid signature
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UnauthorizedError'
   *       429:
   *         description: Registration rate limit exceeded
   */
  // POST /api/agents/register
  router.post(
    "/register",
    agentAuthFailureGuard,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

        // Prove the caller controls the account it is about to become the
        // payment recipient for (#557). Done before any write so a forged
        // registration never reaches the registry.
        requireOwnership(req, res, {
          purpose: "register",
          publicKey: data.stellarPublicKey,
          payload: {
            agentId: data.agentId,
            capabilities: data.capabilities,
            pricingXLM: data.pricingXLM,
            endpoint: data.endpoint,
            stellarPublicKey: data.stellarPublicKey,
          },
        });

        // Verify Stellar account exists
        if (process.env.SKIP_STELLAR_ACCOUNT_VERIFY !== "true") {
          try {
            await getHorizon().loadAccount(data.stellarPublicKey);
          } catch (error: any) {
            if (error?.response?.status === 404) {
              throw new ValidationError(
                "Stellar account not found",
                { stellarPublicKey: data.stellarPublicKey },
                correlationId,
              );
            }
            if (process.env.NODE_ENV !== "test") {
              throw new AppError(
                "Failed to verify Stellar account",
                503,
                "STELLAR_UNAVAILABLE",
                { stellarPublicKey: data.stellarPublicKey, reason: error?.message },
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
          status: "online" as const,
        };

        db.upsert(agent);

        // Await invalidation so the new agent appears on the next GET
        await invalidateAgentsCache().catch(() => {/* best-effort */});

        res.status(201).json(agent);
      } catch (error) {
        if (isAgentAuthError(error)) recordAuthFailure(req.ip ?? "unknown");
        next(error);
      }
    },
  );

  /**
   * @openapi
   * /api/agents/{id}/heartbeat:
   *   post:
   *     summary: Agent heartbeat keep-alive
   *     description: >
   *       Updates the agent's lastSeenAt timestamp and keeps its online status
   *       active. Requires proof that the caller controls the agent's
   *       registered Stellar key: obtain a challenge from
   *       `POST /api/agents/challenge` with purpose `heartbeat`, `agentId` set
   *       to this path's id and `payload` `{ "agentId": "<id>" }`, then send
   *       the nonce as `x-challenge` and the base64 signature of the returned
   *       `message` as `x-signature`. Unsigned heartbeats are refused so a
   *       dead or hijacked agent cannot be kept warm by a third party.
   *     tags: [Agents]
   *     security:
   *       - AgentSignatureAuth: []
   *       - AgentChallengeAuth: []
   *     operationId: agentHeartbeat
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         example: "agent_crypto_analyst_01"
   *       - in: header
   *         name: x-signature
   *         required: true
   *         schema: { type: string }
   *         description: Base64 (or hex) Ed25519 signature of the challenge message
   *       - in: header
   *         name: x-challenge
   *         required: true
   *         schema: { type: string }
   *         description: Single-use nonce issued by POST /api/agents/challenge
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
   *       401:
   *         description: Missing, expired, replayed challenge or invalid signature
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UnauthorizedError'
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
  router.post(
    "/:id/heartbeat",
    heartbeatRateLimitMiddleware,
    agentAuthFailureGuard,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const db = getDb();
        const agent = db.findById(req.params.id);
        if (!agent) {
          throw new NotFoundError("Agent", req.params.id, undefined, res.locals.correlationId as string | undefined);
        }

        // Ownership is checked before `lastSeenAt` moves, so a forged or
        // unsigned heartbeat can never make a stale agent look alive (#558).
        requireOwnership(req, res, {
          purpose: "heartbeat",
          publicKey: agent.stellarPublicKey,
          agentId: agent.id,
          payload: { agentId: agent.id },
        });

        db.upsert({ ...agent, lastSeenAt: new Date().toISOString(), status: "online" });
        const updated = db.findById(req.params.id);

        // Await invalidation so the updated lastSeenAt is visible on the next GET
        await invalidateAgentsCache().catch(() => {/* best-effort */});

        res.status(200).json({
          status: "ok",
          lastSeenAt: updated?.lastSeenAt ?? new Date().toISOString(),
        });
      } catch (error) {
        if (isAgentAuthError(error)) recordAuthFailure(req.ip ?? "unknown");
        next(error);
      }
    },
  );

  /**
   * @openapi
   * /api/agents/{id}:
   *   delete:
   *     summary: Deregister an agent
   *     description: >
   *       Removes an agent from the registry. Requires proof of ownership of
   *       the agent's registered Stellar key using the same challenge–response
   *       scheme as register and heartbeat: request a challenge with purpose
   *       `delete`, sign the returned message, and send the nonce as
   *       `x-challenge` and the base64 signature as `x-signature`.
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
   *         description: Base64 (or hex) Ed25519 signature of the challenge message
   *       - in: header
   *         name: x-challenge
   *         required: true
   *         schema: { type: string }
   *         description: Single-use nonce issued by POST /api/agents/challenge
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
   *         description: Missing, expired, replayed challenge or invalid signature
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UnauthorizedError'
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   */
  // DELETE /api/agents/:id
  router.delete(
    "/:id",
    agentAuthFailureGuard,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const correlationId = res.locals.correlationId as string | undefined;
        const db = getDb();
        const agent = db.findById(req.params.id);
        if (!agent) {
          throw new NotFoundError("Agent", req.params.id, undefined, correlationId);
        }

        // Ownership is proven by the shared challenge–response helper, exactly
        // as register and heartbeat do: it validates the challenge purpose, the
        // claimed public key and the payload hash, and it burns the nonce. A
        // second, ad-hoc `verifyWalletSignature` over the raw challenge would
        // reject the canonical message clients actually sign (#557/#558).
        requireOwnership(req, res, {
          purpose: "delete",
          publicKey: agent.stellarPublicKey,
          agentId: agent.id,
          payload: { agentId: agent.id },
        });

        db.delete(req.params.id);

        // Await invalidation so deleted agent is not served from cache
        await invalidateAgentsCache().catch(() => {/* best-effort */});

        res.json({ message: "Agent deleted successfully" });
      } catch (error) {
        if (isAgentAuthError(error)) recordAuthFailure(req.ip ?? "unknown");
        next(error);
      }
    },
  );

  return router;
}

export const agentsRouter = createAgentsRouter();
export default agentsRouter;
