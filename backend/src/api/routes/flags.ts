/**
 * Feature-flag admin endpoints (#425, #814).
 *
 * GET  /api/admin/flags        — list all flags with state + source, and runtime records
 * PUT  /api/admin/flags/:flag  — create or update a runtime record
 *                                 { "enabled": true|false, "rolloutPercent"?: 0-100, "enabledWallets"?: [...] }
 * DELETE /api/admin/flags/:flag — clear runtime record (fall back to env/default)
 *
 * Runtime records are persisted to the tasks DB, so they survive a restart.
 * Every call is recorded by the `/api/admin` audit middleware.
 */
import { Router, Request, Response } from "express";
import {
  deleteFlagRecord,
  FLAG_KEY_PATTERN,
  getAllFlags,
  getFlagState,
  initFeatureFlagPersistence,
  KNOWN_FLAGS,
  listFlagRecords,
  upsertFlag,
} from "../../services/featureFlags";
import { adminAuthMiddleware } from "../middleware/auth";
import { getTaskDb } from "../../db/tasks";
import { actorFromRequest } from "../../services/adminControl";
import { NotFoundError, ValidationError } from "../../errors";

/** Upper bound on explicit allow-list entries per flag. */
const MAX_ENABLED_WALLETS = 500;

/** Same shape as `stellarPublicKeySchema` in `src/schemas/common.ts`. */
const STELLAR_PUBLIC_KEY = /^G[A-Z2-7]{55}$/;

export function createFlagsRouter(): Router {
  const router = Router();

  // Load persisted runtime records before any request can read a flag.
  initFeatureFlagPersistence(getTaskDb());

  router.use(adminAuthMiddleware);

  /**
   * @openapi
   * /api/admin/flags:
   *   get:
   *     summary: List all feature flags
   *     operationId: listFeatureFlags
   *     description: Returns every known feature flag with its effective value and the source that decided it (`runtime`, `env` or `default`).
   *     tags: [Admin, FeatureFlags]
   *     security:
   *       - adminApiKey: []
   *     responses:
   *       200:
   *         description: Feature flag states
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 flags:
   *                   type: object
   *                   additionalProperties:
   *                     $ref: '#/components/schemas/FeatureFlagState'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.get("/", (_req: Request, res: Response) => {
    res.json({ flags: getAllFlags(), records: listFlagRecords() });
  });

  /**
   * @openapi
   * /api/admin/flags/{flag}:
   *   put:
   *     summary: Set a feature flag override
   *     operationId: setFeatureFlag
   *     description: Creates or updates a runtime record. The record takes precedence over the environment value and is persisted, so it survives a restart. Set `rolloutPercent` to bucket wallets deterministically, and `enabledWallets` to always enable the flag for specific wallets.
   *     tags: [Admin, FeatureFlags]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: path
   *         name: flag
   *         required: true
   *         schema: { type: string }
   *         description: Feature flag name
   *         example: streaming_responses
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [enabled]
   *             properties:
   *               enabled: { type: boolean }
   *               rolloutPercent: { type: integer, minimum: 0, maximum: 100, default: 100 }
   *               enabledWallets:
   *                 type: array
   *                 maxItems: 500
   *                 items: { type: string, pattern: '^G[A-Z2-7]{55}$' }
   *     responses:
   *       200:
   *         description: Override applied
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/FeatureFlagState'
   *       400:
   *         description: 'Body must be a JSON object of the form { "enabled": true|false }'
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ValidationError'
   *   delete:
   *     summary: Clear a feature flag override
   *     operationId: clearFeatureFlag
   *     description: Removes the runtime override, reverting the flag to its environment or default value.
   *     tags: [Admin, FeatureFlags]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: path
   *         name: flag
   *         required: true
   *         schema: { type: string }
   *         description: Feature flag name
   *         example: streaming_responses
   *     responses:
   *       200:
   *         description: Override cleared
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/FeatureFlagState'
   *       404:
   *         description: Unknown feature flag
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   */
  router.put("/:flag", (req: Request, res: Response) => {
    const flag = req.params.flag;

    if (!FLAG_KEY_PATTERN.test(flag)) {
      throw new ValidationError(
        "Flag key must be 2-64 characters: lowercase letters, digits and underscores, starting with a letter",
        { field: "flag", received: flag },
      );
    }

    const body = (req.body ?? {}) as {
      enabled?: unknown;
      rolloutPercent?: unknown;
      enabledWallets?: unknown;
    };

    if (typeof body.enabled !== "boolean") {
      throw new ValidationError('Body must include { "enabled": true | false }', {
        field: "enabled",
        received: typeof body.enabled,
      });
    }

    let rolloutPercent: number | undefined;
    if (body.rolloutPercent !== undefined) {
      if (
        typeof body.rolloutPercent !== "number" ||
        !Number.isInteger(body.rolloutPercent) ||
        body.rolloutPercent < 0 ||
        body.rolloutPercent > 100
      ) {
        throw new ValidationError("rolloutPercent must be an integer between 0 and 100", {
          field: "rolloutPercent",
          received: body.rolloutPercent,
        });
      }
      rolloutPercent = body.rolloutPercent;
    }

    let enabledWallets: string[] | undefined;
    if (body.enabledWallets !== undefined) {
      const wallets = body.enabledWallets;
      if (
        !Array.isArray(wallets) ||
        wallets.length > MAX_ENABLED_WALLETS ||
        !wallets.every((w) => typeof w === "string" && STELLAR_PUBLIC_KEY.test(w))
      ) {
        throw new ValidationError(
          `enabledWallets must be an array of at most ${MAX_ENABLED_WALLETS} Stellar public keys`,
          { field: "enabledWallets" },
        );
      }
      enabledWallets = [...new Set(wallets as string[])];
    }

    const record = upsertFlag(
      flag,
      { enabled: body.enabled, rolloutPercent, enabledWallets },
      actorFromRequest(req),
    );

    res.json({
      flag,
      enabled: record.enabled,
      source: "runtime",
      rolloutPercent: record.rolloutPercent,
      enabledWallets: record.enabledWallets,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    });
  });

  router.delete("/:flag", (req: Request, res: Response) => {
    const flag = req.params.flag;
    const isKnown = (KNOWN_FLAGS as readonly string[]).includes(flag);

    const removed = FLAG_KEY_PATTERN.test(flag) && deleteFlagRecord(flag);
    if (!removed && !isKnown) {
      throw new NotFoundError("Feature flag", flag);
    }

    res.json({ flag, ...getFlagState(flag) });
  });

  return router;
}
