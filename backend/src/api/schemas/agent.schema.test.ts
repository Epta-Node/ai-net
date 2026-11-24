/**
 * Unit tests for `api/schemas/agent.schema.ts` (Issue #740).
 *
 * `RegisterAgentSchema` is the single source of truth for the agent registration
 * contract — `schemas/agent.ts` re-exports it rather than redefining it, precisely
 * so the OpenAPI component and the enforced bounds cannot drift. These tests are
 * therefore load-bearing for the documented API, not just for the handler.
 */

import { z } from "zod";
import { AgentHeartbeatSchema, AgentListQuerySchema, RegisterAgentSchema } from "./agent.schema";

const VALID_KEY = `G${"A".repeat(55)}`;

/** A minimal valid registration body, overridable per test. */
function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: "agent-1",
    capabilities: ["research"],
    pricingXLM: 1.5,
    endpoint: "https://agent.example/run",
    stellarPublicKey: VALID_KEY,
    ...overrides,
  };
}

/** Assert a parse fails and hand back the first issue. */
function rejectionOf(schema: z.ZodTypeAny, value: unknown): z.ZodIssue {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  const error = (result as z.SafeParseError<unknown>).error;
  expect(error.issues.length).toBeGreaterThan(0);
  return error.issues[0]!;
}

describe("RegisterAgentSchema", () => {
  it("accepts a well-formed registration and defaults the bond to zero", () => {
    expect(RegisterAgentSchema.parse(registration())).toEqual({
      agentId: "agent-1",
      capabilities: ["research"],
      pricingXLM: 1.5,
      endpoint: "https://agent.example/run",
      stellarPublicKey: VALID_KEY,
      bondAmountXLM: 0,
    });
  });

  it("keeps an explicit bond amount", () => {
    expect(RegisterAgentSchema.parse(registration({ bondAmountXLM: 12.5 })).bondAmountXLM).toBe(12.5);
  });

  it("rejects a zero price, which is the boundary of positive()", () => {
    // `positive()` is strictly greater than zero, so zero is the first rejected
    // value — worth pinning because a free agent is a plausible thing for a
    // client to send.
    expect(RegisterAgentSchema.safeParse(registration({ pricingXLM: 0 })).success).toBe(false);
  });

  it("accepts a zero bond, the boundary of nonnegative()", () => {
    expect(RegisterAgentSchema.parse(registration({ bondAmountXLM: 0 })).bondAmountXLM).toBe(0);
  });

  it("accepts the full base32 alphabet in a public key", () => {
    const key = `G${"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".repeat(2).slice(0, 55)}`;
    expect(RegisterAgentSchema.safeParse(registration({ stellarPublicKey: key })).success).toBe(true);
  });

  // ── Negative: agentId ─────────────────────────────────────────────────────

  it("rejects an empty agentId with the documented message", () => {
    expect(rejectionOf(RegisterAgentSchema, registration({ agentId: "" })).message).toBe(
      "Agent ID is required",
    );
  });

  it("rejects a missing agentId", () => {
    const body = registration();
    delete body.agentId;
    expect(RegisterAgentSchema.safeParse(body).success).toBe(false);
  });

  it("rejects a non-string agentId", () => {
    expect(RegisterAgentSchema.safeParse(registration({ agentId: 1 })).success).toBe(false);
  });

  // ── Negative: capabilities ────────────────────────────────────────────────

  it("rejects an empty capabilities array", () => {
    expect(rejectionOf(RegisterAgentSchema, registration({ capabilities: [] })).message).toBe(
      "At least one capability is required",
    );
  });

  it("rejects an empty string inside capabilities", () => {
    expect(RegisterAgentSchema.safeParse(registration({ capabilities: [""] })).success).toBe(false);
  });

  it("rejects capabilities that is not an array", () => {
    expect(RegisterAgentSchema.safeParse(registration({ capabilities: "research" })).success).toBe(
      false,
    );
  });

  // ── Negative: pricing ─────────────────────────────────────────────────────

  it("rejects a zero price", () => {
    expect(RegisterAgentSchema.safeParse(registration({ pricingXLM: 0 })).success).toBe(false);
  });

  it("rejects a negative price with the documented message", () => {
    expect(rejectionOf(RegisterAgentSchema, registration({ pricingXLM: -1 })).message).toBe(
      "Price must be positive",
    );
  });

  it("rejects a stringified price, which is not coerced", () => {
    expect(RegisterAgentSchema.safeParse(registration({ pricingXLM: "1.5" })).success).toBe(false);
  });

  // ── Negative: endpoint ────────────────────────────────────────────────────

  it("rejects a non-URL endpoint with the documented message", () => {
    expect(rejectionOf(RegisterAgentSchema, registration({ endpoint: "not-a-url" })).message).toBe(
      "Endpoint must be a valid URL",
    );
  });

  it("rejects a schemeless host", () => {
    expect(RegisterAgentSchema.safeParse(registration({ endpoint: "agent.example/run" })).success).toBe(
      false,
    );
  });

  // ── Negative: stellarPublicKey ────────────────────────────────────────────

  it("rejects a short Stellar public key", () => {
    expect(rejectionOf(RegisterAgentSchema, registration({ stellarPublicKey: "GABC" })).message).toBe(
      "Invalid Stellar public key format",
    );
  });

  it("rejects a key that does not start with G", () => {
    const key = `${"A".repeat(56)}`;
    expect(RegisterAgentSchema.safeParse(registration({ stellarPublicKey: key })).success).toBe(false);
  });

  it("rejects a lowercase key, which is not valid base32 here", () => {
    expect(
      RegisterAgentSchema.safeParse(registration({ stellarPublicKey: `G${"a".repeat(55)}` })).success,
    ).toBe(false);
  });

  it("rejects characters outside the base32 alphabet", () => {
    // `0`, `1`, `8` and `9` are not in RFC 4648 base32.
    expect(
      RegisterAgentSchema.safeParse(registration({ stellarPublicKey: `G${"0".repeat(55)}` })).success,
    ).toBe(false);
  });

  it("rejects a missing public key", () => {
    const body = registration();
    delete body.stellarPublicKey;
    expect(RegisterAgentSchema.safeParse(body).success).toBe(false);
  });

  // ── Negative: bondAmountXLM ───────────────────────────────────────────────

  it("rejects a negative bond with the documented message", () => {
    expect(rejectionOf(RegisterAgentSchema, registration({ bondAmountXLM: -1 })).message).toBe(
      "Bond amount must be non-negative",
    );
  });

  it("rejects a non-numeric bond", () => {
    expect(RegisterAgentSchema.safeParse(registration({ bondAmountXLM: "10" })).success).toBe(false);
  });

  it("reports every invalid field in one pass rather than only the first", () => {
    const result = RegisterAgentSchema.safeParse(
      registration({ agentId: "", pricingXLM: -1, endpoint: "nope", stellarPublicKey: "G" }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path[0]).sort()).toEqual([
      "agentId",
      "endpoint",
      "pricingXLM",
      "stellarPublicKey",
    ]);
  });
});

describe("AgentListQuerySchema", () => {
  it("returns an empty object when no filter is supplied", () => {
    expect(AgentListQuerySchema.parse({})).toEqual({});
  });

  it("coerces numeric filters from the query string", () => {
    expect(AgentListQuerySchema.parse({ minReputation: "80", maxPriceXLM: "2.5" })).toEqual({
      minReputation: 80,
      maxPriceXLM: 2.5,
    });
  });

  it("accepts the boundary values of minReputation", () => {
    expect(AgentListQuerySchema.parse({ minReputation: "0" }).minReputation).toBe(0);
  });

  it("accepts a capability filter", () => {
    expect(AgentListQuerySchema.parse({ capability: "research" }).capability).toBe("research");
  });

  it("rejects a negative reputation", () => {
    expect(AgentListQuerySchema.safeParse({ minReputation: "-1" }).success).toBe(false);
  });

  it("does not bound reputation above 100 — that ceiling lives only in schemas/agent.ts", () => {
    // `reputationSchema` in `schemas/agent.ts` caps at 100, but this legacy
    // schema only bounds below. Pinned so the gap is visible rather than assumed.
    expect(AgentListQuerySchema.parse({ minReputation: "150" }).minReputation).toBe(150);
  });

  it("rejects a non-positive max price", () => {
    expect(AgentListQuerySchema.safeParse({ maxPriceXLM: "0" }).success).toBe(false);
  });

  it("rejects a negative max price", () => {
    expect(AgentListQuerySchema.safeParse({ maxPriceXLM: "-2" }).success).toBe(false);
  });

  it("rejects a non-numeric filter instead of yielding NaN", () => {
    expect(AgentListQuerySchema.safeParse({ maxPriceXLM: "cheap" }).success).toBe(false);
  });

  it("rejects a non-string capability", () => {
    expect(AgentListQuerySchema.safeParse({ capability: 7 }).success).toBe(false);
  });
});

describe("AgentHeartbeatSchema", () => {
  it("accepts a non-empty agent id", () => {
    expect(AgentHeartbeatSchema.parse({ id: "agent-1" })).toEqual({ id: "agent-1" });
  });

  it("rejects an empty agent id with the documented message", () => {
    expect(rejectionOf(AgentHeartbeatSchema, { id: "" }).message).toBe("Agent ID is required");
  });

  it("rejects a missing agent id", () => {
    expect(AgentHeartbeatSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-string agent id", () => {
    expect(AgentHeartbeatSchema.safeParse({ id: null }).success).toBe(false);
  });
});