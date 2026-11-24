/**
 * OpenAPI contract for the agent ownership proof (#557, #558).
 *
 * The routes are useless if clients cannot discover that `register` and
 * `heartbeat` now demand a signature, so the spec is asserted here rather than
 * only in prose.
 */
import { openapiSpec } from "./docs";

const paths = openapiSpec.paths as Record<string, Record<string, any>>;

function headerNames(operation: any): string[] {
  return (operation?.parameters ?? [])
    .filter((p: { in?: string }) => p?.in === "header")
    .map((p: { name?: string }) => p.name);
}

describe("OpenAPI — agent ownership proof", () => {
  it("documents the challenge endpoint", () => {
    const op = paths["/api/agents/challenge"]?.post;
    expect(op).toBeDefined();
    expect(op.operationId).toBe("requestAgentChallenge");
    expect(op.responses["200"]).toBeDefined();
  });

  it("requires a signature on register", () => {
    const op = paths["/api/agents/register"]?.post;
    expect(op.security).toEqual([
      { AgentSignatureAuth: [] },
      { AgentChallengeAuth: [] },
    ]);
    expect(headerNames(op)).toEqual(
      expect.arrayContaining(["x-signature", "x-challenge"]),
    );
    expect(op.responses["401"]).toBeDefined();
  });

  it("requires a signature on heartbeat", () => {
    const op = paths["/api/agents/{id}/heartbeat"]?.post;
    expect(op.security).toEqual([
      { AgentSignatureAuth: [] },
      { AgentChallengeAuth: [] },
    ]);
    expect(headerNames(op)).toEqual(
      expect.arrayContaining(["x-signature", "x-challenge"]),
    );
    expect(op.responses["401"]).toBeDefined();
  });

  it("requires a signature on delete", () => {
    const op = paths["/api/agents/{id}"]?.delete;
    expect(op.security).toEqual([
      { AgentSignatureAuth: [] },
      { AgentChallengeAuth: [] },
    ]);
    expect(headerNames(op)).toEqual(
      expect.arrayContaining(["x-signature", "x-challenge"]),
    );
  });

  it("leaves the read routes unauthenticated", () => {
    expect(paths["/api/agents"]?.get?.security).toEqual([]);
    expect(paths["/api/agents/{id}"]?.get?.security).toEqual([]);
  });

  it("describes the signature headers at the security-scheme level", () => {
    const schemes = openapiSpec.components?.securitySchemes as Record<
      string,
      any
    >;
    expect(schemes.AgentSignatureAuth.name).toBe("x-signature");
    expect(schemes.AgentChallengeAuth.name).toBe("x-challenge");
  });
});
