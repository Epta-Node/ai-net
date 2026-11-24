import { VeniceRouter } from "./veniceRouter";

describe("VeniceRouter", () => {
  it("selectModel returns venice-mistral-7b for research when healthy (cheapest capable)", () => {
    const router = new VeniceRouter({ now: () => 1_000 });
    const model = router.selectModel("research", 1000);
    expect(model.id).toBe("venice-mistral-7b");
  });

  it("selectModel('coding', 500) always returns venice-code when healthy", () => {
    const router = new VeniceRouter({ now: () => 1_000 });
    const model = router.selectModel("coding", 500);
    expect(model.id).toBe("venice-code");
  });

  it("falls back when selected model has successRate < 0.8", () => {
    let now = 0;
    const router = new VeniceRouter({ now: () => now });
    // 2 failures, 1 success => 0.33 success rate for mistral
    router.recordCall("venice-mistral-7b", 100, false);
    router.recordCall("venice-mistral-7b", 100, false);
    router.recordCall("venice-mistral-7b", 100, true);
    now = 1_000;
    const model = router.selectModel("research", 1000);
    expect(model.id).toBe("venice-llama-70b");
  });

  it("opens circuit after 2 consecutive minutes of successRate < 0.5 and closes after 5 minutes", () => {
    let now = 0;
    const router = new VeniceRouter({ now: () => now });
    router.recordCall("venice-mistral-7b", 50, false); // below threshold starts at t=0
    now = 60_000;
    router.recordCall("venice-mistral-7b", 50, false); // still below at 1m
    now = 120_000;
    router.recordCall("venice-mistral-7b", 50, false); // 2m -> circuit opens

    // Immediately after open, should avoid mistral
    const degraded = router.selectModel("research", 1000);
    expect(degraded.id).toBe("venice-llama-70b");

    // After 5 minutes, circuit closes and mistral can be selected again if healthy enough.
    // Make it healthy by adding successes and advancing past open window.
    now = 421_000; // > 120000 + 300000
    router.recordCall("venice-mistral-7b", 50, true);
    router.recordCall("venice-mistral-7b", 50, true);
    router.recordCall("venice-mistral-7b", 50, true);
    const recovered = router.selectModel("research", 1000);
    expect(recovered.id).toBe("venice-mistral-7b");
  });

  it("getModelHealth returns p50/p99 latency from recorded call durations", () => {
    let now = 0;
    const router = new VeniceRouter({ now: () => now });
    [10, 20, 30, 40, 100].forEach((ms) => router.recordCall("venice-mistral-7b", ms, true));
    const health = router.getModelHealth("venice-mistral-7b");
    expect(health.successRate).toBe(1);
    expect(health.p50LatencyMs).toBe(30);
    expect(health.p99LatencyMs).toBe(100);
  });

  it("MAX_INFERENCE_COST_USD forces cheapest model selection", () => {
    const prev = process.env.MAX_INFERENCE_COST_USD;
    process.env.MAX_INFERENCE_COST_USD = "0.0001"; // below mistral per-token cost; should still return cheapest capable
    try {
      const router = new VeniceRouter({ now: () => 1_000 });
      const model = router.selectModel("research", 1);
      expect(model.id).toBe("venice-mistral-7b");
    } finally {
      if (prev === undefined) delete process.env.MAX_INFERENCE_COST_USD;
      else process.env.MAX_INFERENCE_COST_USD = prev;
    }
  });
});
