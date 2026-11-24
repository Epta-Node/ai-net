import swaggerJsdoc from "swagger-jsdoc";
import YAML from "yaml";
import { z } from "zod";
import { CreateTaskSchema } from "./schemas/task.schema";
import { RegisterAgentSchema } from "./schemas/agent.schema";
import { PaginationSchema, IdParamSchema } from "./schemas/common.schema";
import { generateOpenApiSchema } from "./openapi/zod";

export const openapiOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.1.0",
    info: {
      title: "ai-net Backend API",
      version: "0.1.0",
      license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
      description: `REST & WebSocket API for the ai-net backend — multi-agent task orchestration, agent registry, payment reconciliation, background jobs, and system health.

---

## 🔐 Authentication

ai-net uses header-based cryptographic authentication schemes:

### 1. Wallet Authentication (\`WalletAuth\`)
- **Header:** \`walletpublickey: <Stellar-or-Wallet-Public-Key>\`
- Used for creating tasks, retrieving task state, and managing owned resources.
- Example: \`walletpublickey: GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA\`

### 2. Agent Cryptographic Signature Authentication (\`AgentSignatureAuth\` + \`AgentChallengeAuth\`)
- **Applies to:** \`POST /api/agents/register\`, \`POST /api/agents/:id/heartbeat\`, \`DELETE /api/agents/:id\`
- **Headers:**
  - \`x-challenge: <nonce>\` — the single-use, expiring nonce issued by the server
  - \`x-signature: <Base64-or-Hex-Ed25519-Signature>\` — signature of the canonical message

Obtain a challenge first:

\`\`\`
POST /api/agents/challenge
{ "purpose": "register" | "heartbeat" | "delete",
  "publicKey": "<agent Stellar public key>",
  "agentId": "<required for heartbeat and delete>",
  "payload": { ...the exact body you will send to the protected route } }

→ 200 { "challenge": "...", "message": "ai-net:agent-auth:v1\\n<purpose>\\n<publicKey>\\n<challenge>\\n<sha256(payload)>", "expiresAt": "..." }
\`\`\`

Sign \`message\` with the agent's Stellar secret key and send both headers. The signature is
verified against the registered \`stellarPublicKey\`, and the challenge is bound to the route
purpose, the claimed key and a SHA-256 hash of the payload — so a signature is valid for exactly
one request and cannot be replayed against another route, another payload, or another agent.

| Failure | \`error.code\` | Meaning |
|---|---|---|
| No, unknown, expired, replayed or mismatched challenge | \`AGENT_CHALLENGE_INVALID\` | Request a new challenge and retry |
| Missing, malformed or non-matching signature | \`AGENT_SIGNATURE_INVALID\` | The key does not control this agent |

Both return HTTP 401. Failed *unsigned* attempts are throttled separately from the success path
(\`AGENT_AUTH_FAILURE_LIMIT_MAX\` per IP per \`AGENT_AUTH_FAILURE_LIMIT_WINDOW_MS\`) so agent ids
cannot be enumerated cheaply.

**Migration:** while the \`agent_ownership_proof\` feature flag is disabled, unsigned
\`register\` and \`heartbeat\` calls are still accepted and answered with \`Deprecation\`,
\`Sunset\` and \`Warning\` headers (see \`AGENT_AUTH_SUNSET_DATE\`). \`DELETE\` always requires a
signature. Unsigned calls are refused once the flag is on, which is the default.

---

## ⚡ Rate Limiting

All public and authenticated endpoints are rate-limited to ensure system stability.
Rate limit status is communicated via standard HTTP response headers:

| Header | Description |
|---|---|
| \`X-RateLimit-Limit\` | Maximum requests allowed within the current time window |
| \`X-RateLimit-Remaining\` | Number of requests remaining in the current window |
| \`X-RateLimit-Reset\` | Unix time (epoch seconds) when the current window resets |
| \`Retry-After\` | Seconds to wait before retrying — sent on \`429\` responses only |

The \`X-RateLimit-*\` headers are sent on every response from a rate-limited route
(public, authenticated and admin groups alike), not only on \`429\`, so clients can back off
before they are throttled. When more than one limiter applies to a request, the headers
describe the most restrictive one.

When rate limits are exceeded, the API returns \`429 Too Many Requests\` with a
\`RATE_LIMITED\` error payload and a \`Retry-After\` header.

---

## 📡 Live Task Stream (WebSocket)

The server exposes real-time task progress over WebSocket at:

\`\`\`
ws://<host>/tasks/:id/stream
\`\`\`

Optional query param: \`?lastEventId=<seq>\` to resume streaming from a specific event cursor instead of replaying full task history.

### Protocol Flow:
1. **Connect & Authenticate:** Send \`{ "walletPublicKey": "<key>" }\` as the first message within 10 seconds of connection.
2. **Replay & Catch-Up:** The server verifies ownership and replays past events (all events, or only those after \`lastEventId\`).
3. **Live Streaming:** Subsequent execution events (\`node_started\`, \`node_completed\`, \`payment_released\`, \`task_completed\`, \`task_failed\`) are pushed in real time.
4. **Heartbeat:** Server sends periodic pings every 30s. Client must respond with \`{ "type": "pong" }\` within 10s.

### WebSocket Close Codes:
- \`4400\` — Bad Request (malformed handshake, or first message was not \`{ "walletPublicKey" }\`)
- \`4401\` — Auth Handshake Timeout
- \`4403\` — Forbidden (Wallet does not own task)
- \`4404\` — Task Not Found
- \`4408\` — Heartbeat Pong Timeout / inactivity timeout (Stale connection)

---

## 📄 Pagination & Filtering

List endpoints support standardized query parameters:
- \`page\` (default \`1\`): 1-indexed page number
- \`pageSize\` (default \`10\`, max \`100\`): Number of items per page
- \`sort\` (e.g. \`createdAt:desc\`, \`createdAt:asc\`): Sort order
- \`status\` (e.g. \`queued\`, \`running\`, \`completed\`, \`failed\`, \`cancelled\`): Status filter
- \`q\`: Full-text or substring search query
`,
    },
    servers: [
      { url: "http://localhost:3000", description: "Local development" },
      { url: "https://staging.example.com", description: "Staging" },
      { url: "https://api.example.com", description: "Production" },
    ],
    components: {
      securitySchemes: {
        WalletAuth: {
          type: "apiKey",
          in: "header",
          name: "walletpublickey",
          description: "Stellar wallet public key of the task owner / client (e.g., G...)",
        },
        AgentSignatureAuth: {
          type: "apiKey",
          in: "header",
          name: "x-signature",
          description: "Cryptographic Ed25519 signature of the challenge for agent actions",
        },
        AgentChallengeAuth: {
          type: "apiKey",
          in: "header",
          name: "x-challenge",
          description: "Challenge string that was signed by the agent's keypair",
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JSON Web Token for authenticated user sessions",
        },
        adminApiKey: {
          type: "apiKey",
          in: "header",
          name: "X-Admin-API-Key",
          description:
            "Shared operator secret guarding every `/api/admin/*`, `/api/ratelimit/*` and operational health route. `Authorization: Bearer <ADMIN_API_KEY>` is accepted as an alternative. When `ADMIN_API_KEY` is unset these routes fail closed with 503.",
        },
      },
      headers: {
        "X-RateLimit-Limit": {
          description: "The maximum number of requests allowed in the current period.",
          schema: { type: "integer", example: 100 },
        },
        "X-RateLimit-Remaining": {
          description: "The number of remaining requests in the current period.",
          schema: { type: "integer", example: 99 },
        },
        "X-RateLimit-Reset": {
          description: "The time at which the current rate limit window resets in UTC epoch seconds.",
          schema: { type: "integer", example: 1724601600 },
        },
        "Retry-After": {
          description: "Seconds to wait before retrying. Sent on every `429 Too Many Requests` response.",
          schema: { type: "integer", minimum: 1, example: 42 },
        },
        "X-Request-Id": {
          description: "Unique request identifier for distributed tracing and logging.",
          schema: { type: "string", example: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" },
        },
        "X-API-Version": {
          description: "The negotiated API version used to process the request.",
          schema: { type: "string", example: "1.0" },
        },
      },
      responses: {
        TooManyRequests: {
          description: "Rate limit exceeded. Wait `Retry-After` seconds (or until `X-RateLimit-Reset`) before retrying.",
          headers: {
            "Retry-After": { $ref: "#/components/headers/Retry-After" },
            "X-RateLimit-Limit": { $ref: "#/components/headers/X-RateLimit-Limit" },
            "X-RateLimit-Remaining": { $ref: "#/components/headers/X-RateLimit-Remaining" },
            "X-RateLimit-Reset": { $ref: "#/components/headers/X-RateLimit-Reset" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RateLimitError" },
            },
          },
        },
      },
      schemas: {
        CreateTaskRequest: generateOpenApiSchema(CreateTaskSchema),
        RegisterAgentRequest: generateOpenApiSchema(RegisterAgentSchema),
        Pagination: generateOpenApiSchema(PaginationSchema),
        IdParam: generateOpenApiSchema(IdParamSchema),
        TaskStatus: {
          type: "string",
          enum: ["queued", "running", "completed", "failed", "cancelled", "payment_failed"],
          example: "queued",
          description:
            "Current lifecycle state of the task orchestration. `payment_failed` means every node completed but an escrow release failed.",
        },
        NodeStatus: {
          type: "string",
          enum: ["pending", "running", "completed", "failed"],
          example: "completed",
          description: "Execution state of an individual node in the task DAG.",
        },
        JobPriority: {
          type: "string",
          enum: ["low", "normal", "high", "critical"],
          example: "normal",
          description: "Execution priority for the background job queue.",
        },
        DAGNode: {
          type: "object",
          required: ["nodeId", "agentType", "prompt", "dependsOn", "status"],
          properties: {
            nodeId: { type: "string", example: "node_research_1" },
            agentType: { type: "string", example: "research" },
            prompt: { type: "string", example: "Analyze DeFi liquidity trends on Stellar DEX" },
            dependsOn: {
              type: "array",
              items: { type: "string" },
              example: [],
            },
            status: { $ref: "#/components/schemas/NodeStatus" },
            result: {
              type: "object",
              description: "Result output produced by the specialized agent upon successful completion.",
              example: { summary: "Liquidity increased by 14% week-over-week." },
            },
            error: {
              type: "string",
              nullable: true,
              example: null,
              description: "Error message if the node execution failed.",
            },
          },
        },
        CreateTaskResponse: {
          type: "object",
          required: ["taskId", "status", "dagPreview"],
          properties: {
            taskId: { type: "string", example: "task_ab12cd34ef56" },
            status: { $ref: "#/components/schemas/TaskStatus" },
            dagPreview: {
              type: "array",
              items: { $ref: "#/components/schemas/DAGNode" },
            },
            jobId: {
              type: "string",
              example: "job_98fe76dc54ba",
              description: "ID of the background job queued for asynchronous execution.",
            },
            createdAt: { type: "string", format: "date-time", example: "2026-08-25T17:00:00.000Z" },
          },
        },
        Task: {
          type: "object",
          description: "Full task object with decomposed DAG and execution state.",
          required: ["id", "taskId", "prompt", "walletPublicKey", "status", "dag", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string", example: "task_ab12cd34ef56" },
            taskId: { type: "string", example: "task_ab12cd34ef56" },
            prompt: { type: "string", example: "Research Stellar smart contract security best practices" },
            walletPublicKey: { type: "string", example: "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA" },
            status: { $ref: "#/components/schemas/TaskStatus" },
            dag: {
              type: "array",
              items: { $ref: "#/components/schemas/DAGNode" },
            },
            createdAt: { type: "string", format: "date-time", example: "2026-08-25T17:00:00.000Z" },
            updatedAt: { type: "string", format: "date-time", example: "2026-08-25T17:05:00.000Z" },
            requestId: { type: "string", example: "req_c918a245" },
          },
        },
        TaskListItem: {
          type: "object",
          description: "Task item returned in task list collections.",
          required: ["id", "prompt", "walletPublicKey", "status", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string", example: "task_ab12cd34ef56" },
            prompt: { type: "string", example: "Research Stellar smart contract security best practices" },
            walletPublicKey: { type: "string", example: "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA" },
            status: { $ref: "#/components/schemas/TaskStatus" },
            dagJson: {
              type: "string",
              description: "JSON-serialized array of DAGNode objects.",
              example: "[{\"nodeId\":\"node_research_1\",\"agentType\":\"research\",\"status\":\"completed\"}]",
            },
            createdAt: { type: "string", format: "date-time", example: "2026-08-25T17:00:00.000Z" },
            updatedAt: { type: "string", format: "date-time", example: "2026-08-25T17:05:00.000Z" },
          },
        },
        TaskListPagination: {
          type: "object",
          required: ["page", "pageSize", "total", "totalPages"],
          properties: {
            page: { type: "integer", example: 1 },
            pageSize: { type: "integer", example: 10 },
            total: { type: "integer", example: 42 },
            totalPages: { type: "integer", example: 5 },
            hasNextPage: { type: "boolean", example: true },
            hasPrevPage: { type: "boolean", example: false },
          },
        },
        TaskListResponse: {
          type: "object",
          required: ["tasks"],
          properties: {
            tasks: {
              type: "array",
              items: { $ref: "#/components/schemas/TaskListItem" },
            },
            pagination: {
              $ref: "#/components/schemas/TaskListPagination",
            },
          },
        },
        Agent: {
          type: "object",
          required: [
            "id",
            "capabilities",
            "pricingXLM",
            "endpoint",
            "stellarPublicKey",
            "reputationScore",
            "lastSeenAt",
          ],
          properties: {
            id: { type: "string", example: "agent_crypto_analyst_01" },
            capabilities: {
              type: "array",
              items: { type: "string" },
              example: ["research", "market_analysis", "report"],
            },
            pricingXLM: { type: "number", example: 0.25 },
            endpoint: { type: "string", format: "uri", example: "https://agent-crypto.example.com/api" },
            stellarPublicKey: { type: "string", example: "GABZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4XYZ" },
            reputationScore: { type: "number", example: 98.5 },
            lastSeenAt: { type: "string", format: "date-time", example: "2026-08-25T17:20:00.000Z" },
          },
        },
        AgentHeartbeatResponse: {
          type: "object",
          required: ["status", "agentId", "timestamp"],
          properties: {
            status: { type: "string", example: "ok" },
            agentId: { type: "string", example: "agent_crypto_analyst_01" },
            timestamp: { type: "string", format: "date-time", example: "2026-08-25T17:30:00.000Z" },
          },
        },
        HealthStatus: {
          type: "object",
          required: ["status", "uptime", "version", "stellarNetwork"],
          properties: {
            status: { type: "string", enum: ["ok"], example: "ok" },
            uptime: { type: "number", description: "Process uptime in seconds", example: 1420 },
            version: { type: "string", example: "0.1.0" },
            stellarNetwork: { type: "string", example: "testnet" },
          },
        },
        DependencyHealth: {
          type: "object",
          required: ["status", "critical", "latencyMs", "detail"],
          additionalProperties: true,
          properties: {
            status: { type: "string", enum: ["ok", "degraded", "fail"], example: "ok" },
            critical: { type: "boolean", example: true },
            latencyMs: { type: "number", example: 42 },
            detail: { type: "string", example: "reachable" },
          },
        },
        DeepHealthStatus: {
          type: "object",
          required: ["status", "checkedAt", "durationMs", "dependencies", "failing", "degraded"],
          properties: {
            status: { type: "string", enum: ["ok", "degraded", "fail"], example: "ok" },
            checkedAt: { type: "string", format: "date-time" },
            durationMs: { type: "number", example: 120 },
            dependencies: {
              type: "object",
              properties: {
                venice: {
                  allOf: [{ $ref: "#/components/schemas/DependencyHealth" }],
                  description: "Includes `breaker` (state, failures, lastSuccessAt, lastFailureAt) and `lastSuccessAt`.",
                },
                horizon: {
                  allOf: [{ $ref: "#/components/schemas/DependencyHealth" }],
                  description: "Includes `breaker` for the stellar-horizon circuit, or null if none is registered.",
                },
                database: {
                  allOf: [{ $ref: "#/components/schemas/DependencyHealth" }],
                  description: "Includes `readOnlyMode`; the write check is skipped while it is true.",
                },
                queue: {
                  allOf: [{ $ref: "#/components/schemas/DependencyHealth" }],
                  description: "Non-critical. Includes `depth`, `active`, `deadLetter` and `threshold`.",
                },
              },
            },
            failing: { type: "array", items: { type: "string" }, description: "Critical dependencies that failed" },
            degraded: { type: "array", items: { type: "string" }, description: "Dependencies that are degraded, or non-critical and failing" },
            services: {
              type: "object",
              description: "Legacy summary, kept for backward compatibility.",
              properties: {
                venice: { type: "string", enum: ["ok", "unreachable"] },
                horizon: { type: "string", enum: ["ok", "unreachable"] },
              },
            },
            venice: { type: "string", enum: ["ok", "unreachable"], description: "Legacy alias of services.venice" },
            horizon: { type: "string", enum: ["ok", "unreachable"], description: "Legacy alias of services.horizon" },
          },
        },
        ReadinessStatus: {
          type: "object",
          required: ["status", "checks"],
          properties: {
            status: { type: "string", enum: ["ready", "not_ready"], example: "ready" },
            checks: {
              type: "object",
              properties: {
                tasks: { type: "string", enum: ["ok", "error"], example: "ok" },
                payments: { type: "string", enum: ["ok", "error"], example: "ok" },
              },
            },
          },
        },
        MigrationStatus: {
          type: "object",
          required: [
            "database",
            "migrationsDir",
            "migrations",
            "currentVersion",
            "latestVersion",
            "appliedCount",
            "pendingCount",
            "upToDate",
            "drift",
          ],
          properties: {
            database: { type: "string", example: "/srv/ai-net/data/ai-net.db" },
            migrationsDir: { type: "string", example: "/srv/ai-net/backend/src/db/migrations" },
            migrationCount: { type: "integer", example: 2 },
            currentVersion: {
              type: "string",
              nullable: true,
              description: "Highest applied migration version, or null when nothing has been applied.",
              example: "0002",
            },
            latestVersion: {
              type: "string",
              nullable: true,
              description: "Highest version present on disk, or null when there are no migration files.",
              example: "0002",
            },
            appliedCount: { type: "integer", example: 2 },
            pendingCount: { type: "integer", example: 0 },
            upToDate: {
              type: "boolean",
              description: "True when nothing is pending and no applied migration has drifted.",
              example: true,
            },
            drift: {
              type: "array",
              description: "Applied migrations that were edited after being applied, or are missing from disk.",
              items: { type: "string", example: "0001" },
            },
            migrations: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "filename", "name", "state", "checksum", "reversible", "drifted"],
                properties: {
                  id: { type: "string", example: "0001" },
                  filename: { type: "string", example: "0001_init.sql" },
                  name: { type: "string", example: "init" },
                  state: { type: "string", enum: ["applied", "pending"], example: "applied" },
                  checksum: { type: "string", example: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" },
                  appliedAt: {
                    type: "string",
                    format: "date-time",
                    nullable: true,
                    example: "2026-08-25T17:20:00.000Z",
                  },
                  reversible: {
                    type: "boolean",
                    description: "True when the file defines a down section.",
                    example: true,
                  },
                  drifted: {
                    type: "boolean",
                    description: "True when the recorded checksum differs from the file on disk.",
                    example: false,
                  },
                },
              },
            },
          },
        },
        StatsResponse: {
          type: "object",
          required: ["totalAgents", "totalTasks", "uptimePercent", "totalXLMTransacted", "tasksLast24h", "xlmLast24h"],
          properties: {
            totalAgents: { type: "integer", example: 12 },
            totalTasks: { type: "integer", example: 348 },
            uptimePercent: { type: "number", example: 99.98 },
            totalXLMTransacted: { type: "number", example: 1250.75 },
            tasksLast24h: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  timestamp: { type: "string", format: "date-time", example: "2026-08-25T12:00:00.000Z" },
                  value: { type: "number", example: 45 },
                },
              },
            },
            xlmLast24h: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  timestamp: { type: "string", format: "date-time", example: "2026-08-25T12:00:00.000Z" },
                  value: { type: "number", example: 120.5 },
                },
              },
            },
          },
        },
        QueueStats: {
          type: "object",
          required: ["queued", "active", "completed", "failed", "deadLetter"],
          properties: {
            queued: { type: "integer", example: 3 },
            active: { type: "integer", example: 1 },
            completed: { type: "integer", example: 240 },
            failed: { type: "integer", example: 2 },
            deadLetter: { type: "integer", example: 0 },
          },
        },
        QueueJob: {
          type: "object",
          required: ["jobId", "taskId", "status", "priority", "attempts", "maxAttempts", "createdAt", "updatedAt"],
          properties: {
            jobId: { type: "string", example: "job_98fe76dc54ba" },
            taskId: { type: "string", example: "task_ab12cd34ef56" },
            status: { type: "string", enum: ["queued", "active", "completed", "failed", "dead_letter"], example: "active" },
            priority: { $ref: "#/components/schemas/JobPriority" },
            attempts: { type: "integer", example: 1 },
            maxAttempts: { type: "integer", example: 3 },
            nextRunAt: { type: "string", format: "date-time", nullable: true },
            lockedAt: { type: "string", format: "date-time", nullable: true },
            lockedBy: { type: "string", nullable: true },
            error: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        // Operator-facing dead-letter triage shape (issue #802).
        DeadLetterEntry: {
          type: "object",
          required: ["jobId", "taskId", "failureReason", "failedAt", "retryCount"],
          properties: {
            jobId: { type: "string", example: "job_98fe76dc54ba" },
            taskId: { type: "string", example: "task_ab12cd34ef56" },
            failureReason: {
              type: "string",
              example: "max attempts exceeded (3/3): upstream timeout",
            },
            failedAt: { type: "string", format: "date-time" },
            retryCount: { type: "integer", example: 3 },
            originalPayload: {
              type: "object",
              description: "Payload the job was originally enqueued with, for triage.",
              additionalProperties: true,
            },
          },
        },
        QueueStatusResponse: {
          type: "object",
          required: ["status", "stats"],
          properties: {
            status: { type: "string", example: "healthy" },
            stats: { $ref: "#/components/schemas/QueueStats" },
            worker: {
              type: "object",
              properties: {
                running: { type: "boolean", example: true },
                activeWorkers: { type: "integer", example: 2 },
                concurrency: { type: "integer", example: 5 },
                pollIntervalMs: { type: "integer", example: 1000 },
              },
            },
            activeJobs: {
              type: "array",
              items: { $ref: "#/components/schemas/QueueJob" },
            },
            deadLetterJobs: {
              type: "array",
              items: { $ref: "#/components/schemas/QueueJob" },
            },
            veniceKeyHealth: {
              type: "array",
              description:
                "Per-key health of the Venice fallback chain (issue #741). Keys are identified by a truncated SHA-256 keyId; the key itself is never returned.",
              items: {
                type: "object",
                required: ["id", "keyId", "state"],
                properties: {
                  id: { type: "string", example: "primary" },
                  keyId: { type: "string", example: "9f86d081884c7d65" },
                  state: {
                    type: "string",
                    enum: ["healthy", "degraded", "cooldown"],
                    example: "healthy",
                  },
                  cooldownUntil: {
                    type: "number",
                    format: "int64",
                    nullable: true,
                    description: "Epoch ms until which the key is skipped by the rotation",
                  },
                  successes: { type: "integer", example: 42 },
                  failures: { type: "integer", example: 1 },
                  quotaEvents: {
                    type: "integer",
                    example: 1,
                    description: "HTTP 429 rejections observed for this key",
                  },
                  errorRate: {
                    type: "number",
                    example: 0.023,
                    description: "Failures / attempts over the rolling window",
                  },
                  avgLatencyMs: { type: "number", nullable: true, example: 812 },
                  lastSuccessAt: { type: "number", format: "int64", nullable: true },
                  lastFailureAt: { type: "number", format: "int64", nullable: true },
                },
              },
            },
          },
        },
        WebSocketHandshake: {
          type: "object",
          required: ["walletPublicKey"],
          properties: {
            walletPublicKey: {
              type: "string",
              example: "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA",
              description: "Stellar wallet public key of the task owner",
            },
          },
        },
        WebSocketHeartbeat: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["pong"], example: "pong" },
          },
        },
        WebSocketStreamEvent: {
          type: "object",
          required: ["type", "seq", "taskId", "timestamp"],
          properties: {
            type: {
              type: "string",
              enum: [
                "node_started",
                "node_completed",
                "payment_released",
                "task_completed",
                "task_failed",
              ],
              example: "node_started",
            },
            seq: {
              type: "integer",
              example: 1,
              description: "Monotonic per-task sequence number for cursor-based resumption.",
            },
            taskId: { type: "string", example: "task_ab12cd34ef56" },
            nodeId: { type: "string", example: "node_research_1" },
            agentType: { type: "string", example: "research" },
            txHash: { type: "string", example: "b5f7e1...mock_tx" },
            timestamp: { type: "string", format: "date-time", example: "2026-08-25T17:01:00.000Z" },
          },
        },
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "string",
              example: "Invalid request payload or parameters",
            },
            code: {
              type: "string",
              example: "INVALID_REQUEST",
            },
            details: {
              type: "object",
              description: "Optional structured validation errors or error context",
            },
          },
        },
        ValidationError: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", example: "Validation failed" },
            details: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string", example: "prompt" },
                  message: { type: "string", example: "Prompt is required" },
                },
              },
            },
          },
        },
        UnauthorizedError: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", example: "Missing or invalid walletpublickey authentication header" },
          },
        },
        ForbiddenError: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", example: "You do not have permission to access or modify this resource" },
          },
        },
        NotFoundError: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", example: "Task not found" },
          },
        },
        RateLimitError: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", example: "Too many requests. Please try again later." },
            retryAfter: { type: "integer", example: 60 },
          },
        },
        InternalServerError: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", example: "An unexpected internal server error occurred" },
          },
        },
        ServiceUnavailableError: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", example: "Service dependencies are unavailable" },
          },
        },
        AuthTokensResponse: {
          type: "object",
          required: ["accessToken", "refreshToken", "expiresIn", "tokenType", "session"],
          properties: {
            accessToken: { type: "string", example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." },
            refreshToken: { type: "string", example: "rt_8a12d3...39af" },
            expiresIn: { type: "integer", example: 900 },
            tokenType: { type: "string", example: "Bearer" },
            session: {
              type: "object",
              required: ["id", "familyId", "deviceId", "expiresAt"],
              properties: {
                id: { type: "string", example: "sess_uuid" },
                familyId: { type: "string", example: "fam_uuid" },
                deviceId: { type: "string", example: "device_macbook_pro" },
                deviceName: { type: "string", nullable: true, example: "Chrome on macOS" },
                expiresAt: { type: "string", example: "2026-09-05T12:00:00.000Z" },
              },
            },
          },
        },
        TokenRefreshResponse: {
          type: "object",
          required: ["accessToken", "refreshToken", "expiresIn", "tokenType"],
          properties: {
            accessToken: { type: "string", example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." },
            refreshToken: { type: "string", example: "rt_9b34e4...40be" },
            expiresIn: { type: "integer", example: 900 },
            tokenType: { type: "string", example: "Bearer" },
          },
        },
        ReconciliationDiscrepancy: {
          type: "object",
          required: ["type", "balanceId", "severity", "description"],
          properties: {
            type: {
              type: "string",
              enum: ["missing_on_chain", "missing_local", "amount_mismatch"],
              example: "amount_mismatch",
            },
            balanceId: { type: "string", example: "00000000abc123..." },
            taskId: { type: "string", example: "task_ab12cd34ef56" },
            nodeId: { type: "string", example: "node_research_1" },
            severity: { type: "string", enum: ["info", "warning", "critical"], example: "warning" },
            description: { type: "string", example: "Local record claims 5000000 stroops, chain shows 4000000" },
            localAmountStroops: { type: "string", example: "5000000" },
            onChainAmountStroops: { type: "string", example: "4000000" },
            expectedAmountStroops: { type: "string", example: "5000000" },
          },
        },
        ReconciliationSummary: {
          type: "object",
          required: [
            "totalLocalRecords",
            "totalOnChainBalances",
            "matched",
            "discrepancies",
            "missingOnChain",
            "missingLocal",
            "amountMismatch",
          ],
          properties: {
            totalLocalRecords: { type: "integer", example: 120 },
            totalOnChainBalances: { type: "integer", example: 118 },
            matched: { type: "integer", example: 117 },
            discrepancies: { type: "integer", example: 3 },
            missingOnChain: { type: "integer", example: 2 },
            missingLocal: { type: "integer", example: 0 },
            amountMismatch: { type: "integer", example: 1 },
          },
        },
        ReconciliationReport: {
          type: "object",
          description: "Cross-reference of local payment records against Stellar claimable balances.",
          required: ["id", "runAt", "triggeredBy", "status", "summary", "discrepancies"],
          properties: {
            id: { type: "string", example: "recon_7f21c0" },
            runAt: { type: "string", format: "date-time", example: "2026-08-25T17:40:00.000Z" },
            triggeredBy: { type: "string", enum: ["manual", "scheduled", "release"], example: "manual" },
            status: { type: "string", enum: ["consistent", "discrepancies_found"], example: "discrepancies_found" },
            summary: { $ref: "#/components/schemas/ReconciliationSummary" },
            discrepancies: {
              type: "array",
              items: { $ref: "#/components/schemas/ReconciliationDiscrepancy" },
            },
          },
        },
        ReconciliationDrift: {
          type: "object",
          description: "A payment drift awaiting manual operator review (Issue #495).",
          required: [
            "id",
            "driftType",
            "balanceId",
            "description",
            "severity",
            "recommendedAction",
            "detectedAt",
            "lastSeenAt",
            "occurrences",
            "acknowledged",
          ],
          properties: {
            id: { type: "string", example: "task_ab12cd34ef56:node_research_1" },
            driftType: {
              type: "string",
              enum: [
                "orphaned_locked",
                "missing_release_tx",
                "release_unconfirmed",
                "expired_escrow",
                "missing_local",
                "amount_mismatch",
              ],
              example: "orphaned_locked",
            },
            balanceId: { type: "string", example: "00000000abc123..." },
            taskId: { type: "string", example: "task_ab12cd34ef56" },
            nodeId: { type: "string", example: "node_research_1" },
            description: { type: "string", example: "DB says locked but no on-chain claimable balance exists" },
            severity: { type: "string", enum: ["info", "warning", "critical"], example: "warning" },
            recommendedAction: {
              type: "string",
              enum: ["mark_orphaned", "backfill_tx_hash", "requeue_release", "refund_escrow", "manual_review"],
              example: "mark_orphaned",
            },
            detectedAt: { type: "string", format: "date-time", example: "2026-08-25T17:40:00.000Z" },
            lastSeenAt: { type: "string", format: "date-time", example: "2026-08-25T18:40:00.000Z" },
            occurrences: { type: "integer", example: 3 },
            acknowledged: { type: "boolean", example: false },
            resolution: {
              type: "object",
              description: "Operator resolution patch applied to the payment record.",
              properties: {
                status: { type: "string", enum: ["released", "refunded", "orphaned"], example: "released" },
                txHash: { type: "string", example: "abc123def456..." },
                at: { type: "string", format: "date-time", example: "2026-08-25T19:00:00.000Z" },
                by: { type: "string", example: "operator" },
              },
            },
          },
        },
        Error: {
          type: "object",
          description: "Generic error envelope used where a specific error schema does not apply.",
          required: ["error"],
          properties: {
            error: { type: "string", example: "Reconciliation run failed" },
            message: { type: "string", example: "Stellar Horizon returned 503" },
            statusCode: { type: "integer", example: 500 },
            path: { type: "string", example: "/api/reconciliation/run" },
            requestId: { type: "string", example: "req_c918a245" },
          },
        },
        FeatureFlagState: {
          type: "object",
          required: ["flag", "enabled", "source"],
          properties: {
            flag: { type: "string", example: "streaming_responses" },
            enabled: { type: "boolean", example: true },
            source: { type: "string", enum: ["runtime", "env", "default"], example: "runtime" },
            defaultValue: { type: "boolean", example: false },
          },
        },
        MetricsScrapeHealth: {
          type: "object",
          required: ["healthy"],
          properties: {
            healthy: { type: "boolean", example: true },
            registeredAt: { type: "string", format: "date-time", nullable: true },
            lastScrapeAt: { type: "string", format: "date-time", nullable: true },
            scrapeIntervalMs: { type: "integer", example: 15000 },
          },
        },
        ReadOnlyState: {
          type: "object",
          required: ["enabled"],
          properties: {
            enabled: { type: "boolean", example: false },
            reason: { type: "string", nullable: true, example: null },
            actor: { type: "string", nullable: true, example: null },
            since: { type: "string", format: "date-time", nullable: true, example: null },
          },
        },
      },
    },
    security: [{ WalletAuth: [] }],
  },
  apis: [
    "./src/api/app.ts",
    "./src/api/docs.ts",
    "./src/api/docs/openapi.ts",
    "./src/api/routes/*.ts",
    "./src/api/routes/**/*.ts",
  ],
};

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

/**
 * Fresh objects on every call: sharing one instance across operations makes
 * `YAML.stringify` emit anchors/aliases, which bloats /openapi.yaml and trips
 * the parser's alias-count guard.
 */
const rateLimitHeaderRefs = (): Record<string, { $ref: string }> => ({
  "X-RateLimit-Limit": { $ref: "#/components/headers/X-RateLimit-Limit" },
  "X-RateLimit-Remaining": { $ref: "#/components/headers/X-RateLimit-Remaining" },
  "X-RateLimit-Reset": { $ref: "#/components/headers/X-RateLimit-Reset" },
});

/**
 * Every HTTP route sits behind at least one limiter (the app-wide limiter plus
 * the public / authed / admin group limiters), so rather than repeating the
 * header block in each JSDoc annotation the spec is decorated once here:
 *  - every response advertises the `X-RateLimit-*` headers; and
 *  - every operation documents a `429` carrying `Retry-After`, reusing
 *    `#/components/responses/TooManyRequests` when the route has none.
 */
export function withRateLimitHeaders(spec: Record<string, any>): Record<string, any> {
  for (const pathItem of Object.values<any>(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      operation.responses ??= {};

      for (const [status, response] of Object.entries<any>(operation.responses)) {
        if (status === "429" || response?.$ref) continue;
        response.headers = { ...rateLimitHeaderRefs(), ...response.headers };
      }

      const tooMany = operation.responses["429"];
      if (!tooMany) {
        operation.responses["429"] = { $ref: "#/components/responses/TooManyRequests" };
      } else if (!tooMany.$ref) {
        tooMany.headers = {
          "Retry-After": { $ref: "#/components/headers/Retry-After" },
          ...rateLimitHeaderRefs(),
          ...tooMany.headers,
        };
      }
    }
  }
  return spec;
}

export const openapiSpec: Record<string, any> = withRateLimitHeaders(swaggerJsdoc(openapiOptions));

/**
 * Swagger UI interactive options enabling "Try it out" by default,
 * persistent auth tokens, search filter, and response duration tracking.
 */
export const swaggerUiOptions = {
  explorer: true,
  swaggerOptions: {
    tryItOutEnabled: true,
    displayRequestDuration: true,
    filter: true,
    docExpansion: "list",
    defaultModelsExpandDepth: 3,
    persistAuthorization: true,
    showCommonExtensions: true,
    syntaxHighlight: {
      theme: "monokai",
    },
  },
  customSiteTitle: "ai-net Backend API Documentation",
};

/**
 * Return OpenAPI specification formatted as JSON string or object.
 */
export function getOpenapiJson(): object {
  return openapiSpec;
}

/**
 * Return OpenAPI specification serialized as YAML string.
 */
export function getOpenapiYaml(): string {
  return YAML.stringify(openapiSpec);
}
