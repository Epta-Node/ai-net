/**
 * Per-schema tests for `schemas/agent.ts` (Issue #740).
 *
 * `common.test.ts` covers the shared bases and the composed list query. What it
 * does not cover are the leaf schemas it only touches indirectly — so a schema
 * that started accepting every value would slip through while the composed
 * tests kept passing. These suites pin the leaves directly.
 *
 * Only the gaps are here; anything already asserted in `common.test.ts` is left
 * where it is rather than duplicated.
 */

import {
  agentStatusSchema,
  heartbeatSchema,
  listAgentsQuerySchema,
  priceXlmSchema,
  registerAgentSchema,
  reputationSchema,
} from "./agent";

describe("agentStatusSchema", () => {
  it("accepts both documented statuses", () => {
    expect(agentStatusSchema.parse("online")).toBe("online");
    expect(agentStatusSchema.parse("offline")).toBe("offline");
  });

  it("rejects an unknown status", () => {
    expect(agentStatusSchema.safeParse("degraded").success).toBe(false);
  });

  it("rejects an empty status rather than defaulting it", () => {
    expect(agentStatusSchema.safeParse("").success).toBe(false);
  });

  it("rejects a case-variant status", () => {
    expect(agentStatusSchema.safeParse("ONLINE").success).toBe(false);
  });

  it("rejects a non-string status", () => {
    expect(agentStatusSchema.safeParse(1).success).toBe(false);
  });

  it("is what rejects an unknown status in the list query", () => {
    expect(listAgentsQuerySchema.safeParse({ status: "degraded" }).success).toBe(false);
  });
});

describe("reputationSchema", () => {
  it("coerces a query-string value", () => {
    expect(reputationSchema.parse("42")).toBe(42);
  });

  it("accepts both boundary values", () => {
    expect(reputationSchema.parse("0")).toBe(0);
    expect(reputationSchema.parse("100")).toBe(100);
  });

  it("rejects a value above the 100 ceiling", () => {
    expect(reputationSchema.safeParse("101").success).toBe(false);
  });

  it("rejects a negative value", () => {
    expect(reputationSchema.safeParse("-1").success).toBe(false);
  });

  it("rejects a non-numeric value instead of yielding NaN", () => {
    expect(reputationSchema.safeParse("high").success).toBe(false);
  });
});

describe("priceXlmSchema", () => {
  it("coerces a query-string value", () => {
    expect(priceXlmSchema.parse("1.25")).toBe(1.25);
  });

  it("accepts zero as a free agent, the boundary of nonnegative()", () => {
    expect(priceXlmSchema.parse("0")).toBe(0);
  });

  it("rejects a negative price", () => {
    expect(priceXlmSchema.safeParse("-0.01").success).toBe(false);
  });

  it("rejects a non-numeric price instead of yielding NaN", () => {
    expect(priceXlmSchema.safeParse("cheap").success).toBe(false);
  });

  it("rejects a negative price in the list query", () => {
    expect(listAgentsQuerySchema.safeParse({ maxPriceXLM: "-1" }).success).toBe(false);
  });
});

describe("heartbeatSchema", () => {
  it("defaults the status to online", () => {
    expect(heartbeatSchema.parse({})).toEqual({ status: "online" });
  });

  it("keeps an explicit status", () => {
    expect(heartbeatSchema.parse({ status: "offline" })).toEqual({ status: "offline" });
  });

  it("rejects an unknown status", () => {
    expect(heartbeatSchema.safeParse({ status: "degraded" }).success).toBe(false);
  });

  it("rejects an explicit null status instead of falling back to the default", () => {
    // `.optional().default(...)` accepts `undefined`, not `null` — a null here
    // means the caller sent something malformed, not "use the default".
    expect(heartbeatSchema.safeParse({ status: null }).success).toBe(false);
  });
});

describe("registerAgentSchema", () => {
  const validKey = `G${"A".repeat(55)}`;
  const base = {
    agentId: "agent-1",
    capabilities: ["research"],
    pricingXLM: 1,
    endpoint: "https://agent.example/run",
    stellarPublicKey: validKey,
  };

  it("accepts a zero bond, the boundary of nonnegative()", () => {
    expect(registerAgentSchema.parse({ ...base, bondAmountXLM: 0 }).bondAmountXLM).toBe(0);
  });

  it("does not bound bondAmountXLM above — that ceiling lives in the handler", () => {
    // `RegisterAgentSchema` lives in `api/schemas/agent.schema.ts`; the upper
    // bound on a bond is enforced by the registration handler, not the schema.
    // Pinned so the two layers' division of labour stays visible rather than
    // being inferred from the schema alone.
    expect(registerAgentSchema.safeParse({ ...base, bondAmountXLM: 1e9 }).success).toBe(true);
  });

  it("rejects a Stellar public key with a character outside base32", () => {
    expect(registerAgentSchema.safeParse({ ...base, stellarPublicKey: `G${"0".repeat(55)}` }).success).toBe(
      false,
    );
  });
});