import { Router } from "express";
import { getStats, type DbClient } from "../../db/stats";
import { StatsCache } from "../../utils/statsCache";
import { createLogger } from "../../utils/logger";
import { ttlForRoute } from "../../config";

export function createStatsRouter(db: DbClient) {
  const router = Router();
  const logger = createLogger({ module: "stats" });
  const cache = new StatsCache({
    ttlMs: ttlForRoute("stats") * 1_000,
    computeStats: () => getStats(db),
  });

  router.get("/", async (_req, res) => {
    try {
      const stats = await cache.get();
      return res.status(200).json(stats);
    } catch (error) {
      logger.error({ err: error }, "failed to load stats");
      return res.status(500).json({ error: "Unable to load stats" });
    }
  });

  return router;
}

export default createStatsRouter;
