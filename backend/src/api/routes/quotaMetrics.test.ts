/**
 * Route-level test that the quota families reach the documented scrape
 * endpoint (Issue #738).
 *
 * The registry has its own unit tests; this one exists to prove the families
 * are actually *wired* into `/metrics` and `/api/metrics` rather than merely
 * implemented — the failure mode an operator would otherwise only notice at
 * 3am.
 */

import express from "express";
import request from "supertest";

import { QUOTA_BUCKETS, QUOTA_METRICS, quotaMetricsRegistry } from "../../services/quota/metrics";
import { createMetricsRouter } from "./metrics";

function buildApp(): express.Express {
  const app = express();
  app.use("/metrics", createMetricsRouter());
  app.use("/api/metrics", createMetricsRouter());
  return app;
}

describe("quota metrics on the scrape endpoint (Issue #738)", () => {
  let app: express.Express;

  beforeAll(() => {
    app = buildApp();
  });

  it.each(["/metrics", "/api/metrics"])("exposes the quota families on %s", async (path) => {
    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);

    for (const descriptor of QUOTA_METRICS) {
      expect(res.text).toContain(`# HELP ${descriptor.name} ${descriptor.help}`);
      expect(res.text).toContain(`# TYPE ${descriptor.name} ${descriptor.type}`);
    }
  });

  it("publishes every utilisation band on each alias", async () => {
    const res = await request(app).get("/api/metrics");

    for (const bucket of QUOTA_BUCKETS) {
      expect(res.text).toContain(`ainet_wallet_daily_quota_wallets{bucket="${bucket}"}`);
      expect(res.text).toContain(
        `ainet_wallet_daily_quota_rejections_total{bucket="${bucket}"}`,
      );
    }
  });

  it("reports the configured limits as gauges", async () => {
    const res = await request(app).get("/api/metrics");

    expect(res.text).toMatch(/ainet_wallet_daily_quota_limit \d+/);
    expect(res.text).toMatch(/ainet_task_token_budget \d+/);
  });

  it("reflects a rejection recorded by the enforcement path", async () => {
    const registry = quotaMetricsRegistry();
    registry.reset();

    // The registry reads its per-wallet gauges from SQLite, but rejections are
    // counted in-process — so this is the observable half of the counter.
    registry.recordQuotaRejection({ usedTasks: 100, limit: 100 });

    const res = await request(app).get("/api/metrics");
    expect(res.text).toContain('ainet_wallet_daily_quota_rejections_total{bucket="at-limit"} 1');

    registry.reset();
    const after = await request(app).get("/api/metrics");
    expect(after.text).toContain('ainet_wallet_daily_quota_rejections_total{bucket="at-limit"} 0');
  });

  it("never emits a wallet address as a label value", async () => {
    const res = await request(app).get("/api/metrics");
    // Every labelled sample in the quota block must carry a `bucket` label and
    // nothing else, so no value can be a 56-character Stellar account.
    for (const line of res.text.split("\n")) {
      if (!line.startsWith("ainet_wallet_daily_quota_wallets{")) continue;
      expect(line).toMatch(/^ainet_wallet_daily_quota_wallets\{bucket="[^"]+"\} [\d.e+-]+$/);
    }
  });
});