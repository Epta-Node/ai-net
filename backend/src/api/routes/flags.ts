/**
 * Feature-flag admin endpoints (#425).
 *
 * GET  /api/admin/flags        — list all flags with state + source
 * PUT  /api/admin/flags/:flag  — set runtime override { "enabled": true|false }
 * DELETE /api/admin/flags/:flag — clear runtime override (fall back to env/default)
 */
import { Router, Request, Response } from "express";
import {
  getAllFlags,
  setFlag,
  KNOWN_FLAGS,
  type FeatureFlag,
} from "../../services/featureFlags";
import { NotFoundError, ValidationError } from "../../errors";

export function createFlagsRouter(): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json({ flags: getAllFlags() });
  });

  router.put("/:flag", (req: Request, res: Response) => {
    const flag = req.params.flag as FeatureFlag;

    if (!(KNOWN_FLAGS as readonly string[]).includes(flag)) {
      throw new NotFoundError("Feature flag", flag);
    }

    const { enabled } = req.body as { enabled?: unknown };
    if (typeof enabled !== "boolean") {
      throw new ValidationError('Body must include { "enabled": true | false }', {
        field: "enabled",
        received: typeof enabled,
      });
    }

    setFlag(flag, enabled);
    res.json({ flag, enabled, source: "runtime" });
  });

  router.delete("/:flag", (req: Request, res: Response) => {
    const flag = req.params.flag as FeatureFlag;

    if (!(KNOWN_FLAGS as readonly string[]).includes(flag)) {
      throw new NotFoundError("Feature flag", flag);
    }

    setFlag(flag, null);
    const all = getAllFlags();
    res.json({ flag, ...all[flag] });
  });

  return router;
}
