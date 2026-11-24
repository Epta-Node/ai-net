import request from "supertest";
import WebSocket from "ws";
import YAML from "yaml";
import { createApp } from "../src/api/app";
import {
  openapiSpec,
  swaggerUiOptions,
  getOpenapiJson,
  getOpenapiYaml,
} from "../src/api/docs";
import {
  collectLiveRoutes,
  collectSpecOperations,
  describeParityGap,
} from "./helpers/liveRoutes";

/**
 * Paths that are served by middleware rather than an Express route layer, so
 * the router walk cannot see them. Each is asserted reachable over HTTP below.
 */
const MIDDLEWARE_SERVED_PATHS = ["/api-docs"];

/** WebSocket upgrades never appear in the Express router stack. */
const WEBSOCKET_PATHS = new Set(["GET /tasks/{id}/stream"]);

describe("API Documentation & Swagger UI", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp({
      disableCompression: true,
      enableHeartbeatCleanup: false,
      enableQueueWorker: false,
    });
  });

  afterAll((done) => {
    app.close(done);
  });

  describe("OpenAPI Specification Structure", () => {
    it("should export a valid OpenAPI 3.1.0 document", () => {
      expect(openapiSpec).toBeDefined();
      expect(openapiSpec.openapi).toBe("3.1.0");
      expect(openapiSpec.info).toBeDefined();
      expect(openapiSpec.info.title).toBe("ai-net Backend API");
      expect(openapiSpec.info.version).toBe("0.1.0");
      expect(openapiSpec.info.description).toContain("Authentication");
      expect(openapiSpec.info.description).toContain("Rate Limiting");
      expect(openapiSpec.info.description).toContain("Live Task Stream (WebSocket)");
      expect(openapiSpec.info.description).toContain("Pagination & Filtering");
    });

    it("should declare WalletAuth, AgentSignatureAuth, and AgentChallengeAuth security schemes", () => {
      const securitySchemes = openapiSpec.components?.securitySchemes;
      expect(securitySchemes).toBeDefined();
      expect(securitySchemes?.WalletAuth).toBeDefined();
      expect(securitySchemes?.WalletAuth.name).toBe("walletpublickey");
      expect(securitySchemes?.AgentSignatureAuth).toBeDefined();
      expect(securitySchemes?.AgentSignatureAuth.name).toBe("x-signature");
      expect(securitySchemes?.AgentChallengeAuth).toBeDefined();
      expect(securitySchemes?.AgentChallengeAuth.name).toBe("x-challenge");
      expect(securitySchemes?.BearerAuth).toBeDefined();
      expect(securitySchemes?.BearerAuth.scheme).toBe("bearer");
    });

    it("should declare the adminApiKey scheme used by every operational route", () => {
      const securitySchemes = openapiSpec.components?.securitySchemes;
      expect(securitySchemes?.adminApiKey).toBeDefined();
      expect(securitySchemes?.adminApiKey.name).toBe("X-Admin-API-Key");
    });

    it("should define reusable rate limit and tracing headers", () => {
      const headers = openapiSpec.components?.headers;
      expect(headers).toBeDefined();
      expect(headers?.["X-RateLimit-Limit"]).toBeDefined();
      expect(headers?.["X-RateLimit-Remaining"]).toBeDefined();
      expect(headers?.["X-RateLimit-Reset"]).toBeDefined();
      expect(headers?.["X-Request-Id"]).toBeDefined();
      expect(headers?.["X-API-Version"]).toBeDefined();
      expect(headers?.["Retry-After"]).toBeDefined();
    });

    it("should define a reusable TooManyRequests response carrying Retry-After", () => {
      const tooMany = openapiSpec.components?.responses?.TooManyRequests;
      expect(tooMany).toBeDefined();
      expect(Object.keys(tooMany.headers)).toEqual(
        expect.arrayContaining(["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"]),
      );
    });

    it("should document rate-limit headers on every operation and Retry-After on every 429", () => {
      const resolve = (r: any) =>
        r?.$ref === "#/components/responses/TooManyRequests" ? openapiSpec.components.responses.TooManyRequests : r;
      const missing: string[] = [];

      for (const [path, item] of Object.entries<any>(openapiSpec.paths)) {
        for (const method of ["get", "put", "post", "delete", "patch"]) {
          const op = item[method];
          if (!op) continue;
          for (const [status, raw] of Object.entries<any>(op.responses)) {
            if (raw.$ref && raw.$ref !== "#/components/responses/TooManyRequests") continue;
            const headers = resolve(raw).headers ?? {};
            const expected = ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"];
            if (status === "429") expected.push("Retry-After");
            for (const h of expected) {
              if (!headers[h]) missing.push(`${method.toUpperCase()} ${path} ${status} ${h}`);
            }
          }
          if (!op.responses["429"]) missing.push(`${method.toUpperCase()} ${path} 429`);
        }
      }

      expect(missing).toEqual([]);
    });

    it("should define core schemas with examples", () => {
      const schemas = openapiSpec.components?.schemas;
      expect(schemas).toBeDefined();

      // Tasks
      expect(schemas?.Task).toBeDefined();
      expect(schemas?.CreateTaskRequest).toBeDefined();
      expect(schemas?.CreateTaskResponse).toBeDefined();
      expect(schemas?.TaskListItem).toBeDefined();
      expect(schemas?.TaskListResponse).toBeDefined();
      expect(schemas?.DAGNode).toBeDefined();
      expect(schemas?.TaskStatus).toBeDefined();

      // Agents
      expect(schemas?.Agent).toBeDefined();
      expect(schemas?.RegisterAgentRequest).toBeDefined();
      expect(schemas?.AgentHeartbeatResponse).toBeDefined();

      // Health & Stats
      expect(schemas?.HealthStatus).toBeDefined();
      expect(schemas?.DeepHealthStatus).toBeDefined();
      expect(schemas?.ReadinessStatus).toBeDefined();
      expect(schemas?.StatsResponse).toBeDefined();

      // Background Jobs & Admin
      expect(schemas?.QueueJob).toBeDefined();
      expect(schemas?.QueueStats).toBeDefined();
      expect(schemas?.QueueStatusResponse).toBeDefined();

      // WebSocket & Errors
      expect(schemas?.WebSocketStreamEvent).toBeDefined();
      expect(schemas?.ErrorResponse).toBeDefined();
      expect(schemas?.ValidationError).toBeDefined();
      expect(schemas?.NotFoundError).toBeDefined();
      expect(schemas?.RateLimitError).toBeDefined();
      expect(schemas?.InternalServerError).toBeDefined();
    });

    it("should include all primary REST and WebSocket endpoints in paths", () => {
      const paths = openapiSpec.paths;
      expect(paths).toBeDefined();

      // Tasks
      expect(paths?.["/api/tasks"]).toBeDefined();
      expect(paths?.["/api/tasks"]?.post).toBeDefined();
      expect(paths?.["/api/tasks"]?.get).toBeDefined();
      expect(paths?.["/api/tasks/{id}"]).toBeDefined();
      expect(paths?.["/api/tasks/{id}"]?.get).toBeDefined();
      expect(paths?.["/api/tasks/{id}"]?.delete).toBeDefined();

      // Agents
      expect(paths?.["/api/agents"]).toBeDefined();
      expect(paths?.["/api/agents"]?.get).toBeDefined();
      expect(paths?.["/api/agents/{id}"]).toBeDefined();
      expect(paths?.["/api/agents/{id}"]?.get).toBeDefined();
      expect(paths?.["/api/agents/{id}"]?.delete).toBeDefined();
      expect(paths?.["/api/agents/register"]).toBeDefined();
      expect(paths?.["/api/agents/register"]?.post).toBeDefined();
      expect(paths?.["/api/agents/{id}/heartbeat"]).toBeDefined();
      expect(paths?.["/api/agents/{id}/heartbeat"]?.post).toBeDefined();

      // Health
      expect(paths?.["/health"]).toBeDefined();
      expect(paths?.["/health"]?.get).toBeDefined();
      expect(paths?.["/health/deep"]).toBeDefined();
      expect(paths?.["/health/deep"]?.get).toBeDefined();
      expect(paths?.["/health/ready"]).toBeDefined();
      expect(paths?.["/health/ready"]?.get).toBeDefined();

      // Stats
      expect(paths?.["/api/stats"]).toBeDefined();
      expect(paths?.["/api/stats"]?.get).toBeDefined();

      // WebSocket
      expect(paths?.["/tasks/{id}/stream"]).toBeDefined();

      // Admin Queue
      expect(paths?.["/api/admin/queue/status"]).toBeDefined();
      expect(paths?.["/api/admin/queue/jobs"]).toBeDefined();
    });
  });

  describe("Interactive Swagger UI Options", () => {
    it("should configure tryItOutEnabled and displayRequestDuration", () => {
      expect(swaggerUiOptions.swaggerOptions.tryItOutEnabled).toBe(true);
      expect(swaggerUiOptions.swaggerOptions.displayRequestDuration).toBe(true);
      expect(swaggerUiOptions.swaggerOptions.persistAuthorization).toBe(true);
      expect(swaggerUiOptions.customSiteTitle).toBe("ai-net Backend API Documentation");
    });
  });

  describe("Spec Serialization Helpers", () => {
    it("getOpenapiJson() returns JSON-serializable spec", () => {
      const json = getOpenapiJson();
      expect(json).toBe(openapiSpec);
      expect(JSON.stringify(json)).toContain("ai-net Backend API");
    });

    it("getOpenapiYaml() returns valid YAML string parseable back to object", () => {
      const yamlStr = getOpenapiYaml();
      expect(typeof yamlStr).toBe("string");
      expect(yamlStr).toContain("openapi: 3.1.0");
      const parsed = YAML.parse(yamlStr);
      expect(parsed.info.title).toBe("ai-net Backend API");
    });

    it("serializes to JSON and YAML that are semantically equivalent", () => {
      expect(YAML.parse(getOpenapiYaml())).toEqual(getOpenapiJson());
    });
  });

  describe("HTTP Documentation Endpoints", () => {
    it("GET /api-docs serves Swagger UI HTML with 200", async () => {
      const res = await request(app.httpServer).get("/api-docs/");
      expect(res.status).toBe(200);
      expect(res.type).toContain("html");
      expect(res.text).toContain("swagger-ui");
      expect(res.text).toContain("ai-net Backend API Documentation");
    });

    it("GET /api-docs serves its static assets", async () => {
      const res = await request(app.httpServer).get("/api-docs/swagger-ui.css");
      expect(res.status).toBe(200);
      expect(res.type).toContain("css");
    });

    it("GET /openapi.json returns valid JSON OpenAPI specification", async () => {
      const res = await request(app.httpServer).get("/openapi.json");
      expect(res.status).toBe(200);
      expect(res.type).toContain("json");
      expect(res.body.openapi).toBe("3.1.0");
      expect(res.body.info.title).toBe("ai-net Backend API");
      expect(res.body.paths["/api/tasks"]).toBeDefined();
    });

    it("GET /openapi.yaml returns YAML formatted specification", async () => {
      const res = await request(app.httpServer).get("/openapi.yaml");
      expect(res.status).toBe(200);
      expect(res.type).toMatch(/yaml/);
      expect(res.text).toContain("openapi: 3.1.0");
      const parsed = YAML.parse(res.text);
      expect(parsed.info.title).toBe("ai-net Backend API");
    });

    it("serves an equivalent document from /openapi.json and /openapi.yaml", async () => {
      const [jsonRes, yamlRes] = await Promise.all([
        request(app.httpServer).get("/openapi.json"),
        request(app.httpServer).get("/openapi.yaml"),
      ]);

      expect(jsonRes.status).toBe(200);
      expect(yamlRes.status).toBe(200);
      expect(YAML.parse(yamlRes.text)).toEqual(jsonRes.body);
    });
  });

  describe("Live routes ↔ spec parity (#572)", () => {
    it("documents every route the app actually registers", () => {
      const live = collectLiveRoutes(app.httpServer, app.versionDispatchedRoutes);
      const spec = collectSpecOperations(openapiSpec);

      // Sanity-check the walker itself before trusting a pass.
      expect(live).toContain("GET /health");
      expect(live).toContain("POST /api/tasks");
      expect(live.length).toBeGreaterThan(40);

      const undocumented = live.filter(
        (route) =>
          !spec.includes(route) &&
          !MIDDLEWARE_SERVED_PATHS.some((path) => route === `GET ${path}`),
      );

      expect(undocumented).toEqual([]);
      expect(describeParityGap("undocumented live routes", live, spec)).toContain("in sync");
    });

    it("keeps every documented route reachable on the running app", () => {
      const spec = collectSpecOperations(openapiSpec);
      const live = collectLiveRoutes(app.httpServer, app.versionDispatchedRoutes);

      // The WebSocket endpoint is served by an HTTP upgrade handler, so it is
      // verified by connection rather than by the router walk (see below).
      const unreachable = spec.filter(
        (operation) =>
          !live.includes(operation) &&
          !WEBSOCKET_PATHS.has(operation) &&
          !MIDDLEWARE_SERVED_PATHS.some((path) => operation === `GET ${path}`),
      );

      expect(unreachable).toEqual([]);
    });

    it("has no duplicate mounts left behind in the router tree", () => {
      const live = collectLiveRoutes(app.httpServer, app.versionDispatchedRoutes);
      expect(live.filter((route) => route.endsWith(" /api/admin/queue/queue"))).toEqual([]);
      expect(live).not.toContain("GET /api/stats/stats");
    });

    it("serves the documented WebSocket stream upgrade path", async () => {
      expect(app.httpServer.listenerCount("upgrade")).toBeGreaterThan(0);

      // The stream is attached to the HTTP upgrade event, so the server has to
      // actually be listening for a client to reach it.
      await new Promise<void>((resolve) => app.httpServer.listen(0, "127.0.0.1", resolve));
      const { port } = app.httpServer.address() as { port: number };

      try {
        // 4404 = task not found (WS_CLOSE.TASK_NOT_FOUND): the stream layer
        // handled the upgrade, rather than the socket being destroyed as an
        // unrouted path (which surfaces as 1006).
        const code = await new Promise<number>((resolve, reject) => {
          const client = new WebSocket(`ws://127.0.0.1:${port}/tasks/does-not-exist/stream`);
          client.on("close", (closeCode: number) => resolve(closeCode));
          client.on("error", reject);
        });

        expect(code).toBe(4404);
      } finally {
        await new Promise<void>((resolve) => app.httpServer.close(() => resolve()));
      }
    });

    it("declares a declared security scheme on every authenticated route", () => {
      const declared = new Set(
        Object.keys(openapiSpec.components?.securitySchemes ?? {}),
      );
      const globalSecurity = openapiSpec.security ?? [];

      const offenders: string[] = [];
      for (const [path, item] of Object.entries(openapiSpec.paths ?? {})) {
        for (const [method, operation] of Object.entries(
          item as Record<string, { security?: Array<Record<string, string[]>> }>,
        )) {
          if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
          const security = operation.security ?? globalSecurity;
          for (const requirement of security) {
            for (const scheme of Object.keys(requirement)) {
              if (!declared.has(scheme)) {
                offenders.push(`${method.toUpperCase()} ${path} -> undeclared '${scheme}'`);
              }
            }
          }
        }
      }

      expect(offenders).toEqual([]);
    });

    it("matches the enforced auth on the admin, session and public surfaces", () => {
      const securityOf = (method: string, path: string): string[] => {
        const operation = (openapiSpec.paths?.[path] as Record<string, any> | undefined)?.[
          method
        ];
        const security = operation?.security ?? openapiSpec.security ?? [];
        return security.flatMap((requirement: Record<string, string[]>) =>
          Object.keys(requirement),
        );
      };

      // Operator-only: guarded by adminAuthMiddleware.
      expect(securityOf("get", "/api/admin/queue/status")).toEqual(["adminApiKey"]);
      expect(securityOf("post", "/api/admin/retry/{id}")).toEqual(["adminApiKey"]);
      expect(securityOf("get", "/api/admin/flags")).toEqual(["adminApiKey"]);
      expect(securityOf("post", "/api/metrics/reset")).toEqual(["adminApiKey"]);
      expect(securityOf("get", "/api/ratelimit/status")).toEqual(["adminApiKey"]);
      expect(securityOf("get", "/api/reconciliation/report")).toEqual(["adminApiKey"]);
      expect(securityOf("get", "/health/dashboard")).toEqual(["adminApiKey"]);

      // Session-scoped: guarded by sessionAuthMiddleware.
      expect(securityOf("get", "/api/auth/sessions")).toEqual(["BearerAuth"]);
      expect(securityOf("post", "/api/auth/revoke-all")).toEqual(["BearerAuth"]);

      // Public: explicitly opted out of the spec-wide WalletAuth default.
      expect(securityOf("get", "/health")).toEqual([]);
      expect(securityOf("get", "/api/stats")).toEqual([]);
      expect(securityOf("get", "/api/agents")).toEqual([]);
      expect(securityOf("post", "/api/auth/token")).toEqual([]);
      expect(securityOf("get", "/openapi.json")).toEqual([]);

      // Task routes stay wallet-scoped.
      expect(securityOf("post", "/api/tasks")).toEqual(["WalletAuth"]);
    });

    it("resolves every $ref in the document", () => {
      const dangling: string[] = [];

      const visit = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === "$ref" && typeof value === "string") {
            if (!value.startsWith("#/")) {
              dangling.push(value);
              continue;
            }
            let cursor: unknown = openapiSpec;
            for (const segment of value.replace("#/", "").split("/")) {
              cursor = (cursor as Record<string, unknown> | undefined)?.[segment];
              if (cursor === undefined) break;
            }
            if (cursor === undefined) dangling.push(value);
            continue;
          }
          visit(value);
        }
      };

      visit(openapiSpec);
      expect(dangling).toEqual([]);
    });
  });
});
