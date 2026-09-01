/**
 * Unit tests for Prometheus metrics export routes (Issue #499).
 *
 * Tests:
 *  - GET /metrics returns text/plain format with all 8 metric families
 *  - GET /metrics/health returns scrape reliability metadata
 *  - POST /metrics/reset resets metrics safely without duplicate registration errors
 */

import express from "express";
import request from "supertest";
import { MetricsService } from "../../services/metrics";
import { createMetricsRouter } from "./metrics";

beforeAll(() => {
  process.env.VENICE_API_KEY = process.env.VENICE_API_KEY || "test-venice-key";
  process.env.DATABASE_URL = process.env.DATABASE_URL || ":memory:";

  try {
    const { loadConfig } = require("../../config");
    loadConfig();
  } catch {
    // Already loaded
  }
});

function buildApp(service?: MetricsService) {
  const app = express();
  app.use(express.json());
  const metrics = service ?? new MetricsService({
    sources: {
      checkSqlite: () => ({ status: "ok" }),
      checkVenice: () => ({ status: "ok" }),
      checkStellarHorizon: () => ({ status: "ok" }),
      checkWebSocket: () => ({ status: "ok" }),
      collectAgents: () => ({ total: 5, online: 3, offline: 2, avgResponseTimeMs: 120 }),
      collectTasks: () => ({ total: 10, active: 2, queued: 1, completed: 6, failed: 1, cancelled: 0, avgDurationSeconds: 1.5 }),
      collectPayments: () => ({
        locked: { count: 2, stroops: "20000000", xlm: 2.0 },
        released: { count: 5, stroops: "50000000", xlm: 5.0 },
        refunded: { count: 1, stroops: "10000000", xlm: 1.0 },
      }),
    },
  });
  app.use("/metrics", createMetricsRouter({ service: metrics }));
  return { app, metrics };
}

describe("Prometheus Metrics Route (Issue #499)", () => {
  it("GET /metrics returns text/plain with Prometheus metric families", async () => {
    const { app, metrics } = buildApp();

    // Record sample task and venice telemetry
    metrics.recordTaskCompletion(2.5, "completed");
    metrics.recordVeniceCall("llama-3.3-70b", "success", 0.45);
    metrics.setVeniceCircuitBreakerState(0);

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");

    const text = res.text;

    // Verify all 8 metric families are present
    expect(text).toContain("# HELP ainet_tasks_total");
    expect(text).toContain("# TYPE ainet_tasks_total counter");
    expect(text).toContain('ainet_tasks_total{status="completed"}');

    expect(text).toContain("# HELP ainet_tasks_duration_seconds");
    expect(text).toContain("# TYPE ainet_tasks_duration_seconds histogram");
    expect(text).toContain("ainet_tasks_duration_seconds_bucket");

    expect(text).toContain("# HELP ainet_agents_total");
    expect(text).toContain("# TYPE ainet_agents_total gauge");
    expect(text).toContain("ainet_agents_total 5");

    expect(text).toContain("# HELP ainet_payments_total");
    expect(text).toContain("# TYPE ainet_payments_total counter");
    expect(text).toContain('ainet_payments_total{currency="XLM",status="released"} 5');

    expect(text).toContain("# HELP ainet_payment_amount_xlm_total");
    expect(text).toContain("# TYPE ainet_payment_amount_xlm_total gauge");
    expect(text).toContain("ainet_payment_amount_xlm_total 8");

    expect(text).toContain("# HELP ainet_venice_requests_total");
    expect(text).toContain("# TYPE ainet_venice_requests_total counter");
    expect(text).toContain('ainet_venice_requests_total{model="llama-3.3-70b",status="success"} 1');

    expect(text).toContain("# HELP ainet_venice_latency_seconds");
    expect(text).toContain("# TYPE ainet_venice_latency_seconds histogram");
    expect(text).toContain("ainet_venice_latency_seconds_sum");

    expect(text).toContain("# HELP ainet_venice_circuit_breaker_state");
    expect(text).toContain("# TYPE ainet_venice_circuit_breaker_state gauge");
    expect(text).toContain("ainet_venice_circuit_breaker_state 0");
  });

  it("GET /metrics/health returns scrape reliability payload", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/metrics/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptimeSeconds).toBe("number");
    expect(typeof res.body.lastScrapeTimestamp).toBe("string");
    expect(res.body.metricFamiliesCount).toBe(8);
    expect(res.body.registeredOnce).toBe(true);
  });

  it("POST /metrics/reset resets telemetry safely", async () => {
    const { app, metrics } = buildApp();

    metrics.recordTaskCompletion(5.0);
    metrics.recordVeniceCall("gpt-4", "error", 1.2);
    metrics.setVeniceCircuitBreakerState(1);

    const resetRes = await request(app).post("/metrics/reset");
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.status).toBe("ok");

    expect(metrics.getVeniceCircuitBreakerState()).toBe(0);
    const scrapeRes = await request(app).get("/metrics");
    expect(scrapeRes.status).toBe(200);
    expect(scrapeRes.text).toContain("ainet_venice_circuit_breaker_state 0");
  });
});
