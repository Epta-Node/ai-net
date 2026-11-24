/**
 * GET /metrics — Issue #1002
 *
 * Returns Prometheus text-format metrics for scraping by Prometheus / Grafana.
 * Content-Type is set to the value prom-client advertises so that Prometheus
 * can correctly parse the exposition format.
 */
import { Router, Request, Response } from "express";
import { getMetrics, METRICS_CONTENT_TYPE } from "../../metrics/metricsCollector";

export const metricsRouter = Router();

metricsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const metrics = await getMetrics();
    res.setHeader("Content-Type", METRICS_CONTENT_TYPE);
    res.status(200).send(metrics);
  } catch (err) {
    res.status(500).json({ error: "Failed to collect metrics" });
  }
});
