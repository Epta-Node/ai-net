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

### 2. Agent Cryptographic Signature Authentication (\`AgentSignatureAuth\`)
- **Headers:**
  - \`x-signature: <Base64-or-Hex-Ed25519-Signature>\`
  - \`x-challenge: <Signed-Challenge-String>\`
- Used for agent de-registration and privileged agent operations.
- The challenge string must match the challenge issued by the server within the replay window.

---

## ⚡ Rate Limiting

All public and authenticated endpoints are rate-limited to ensure system stability.
Rate limit status is communicated via standard HTTP response headers:

| Header | Description |
|---|---|
| \`X-RateLimit-Limit\` | Maximum requests allowed within the current time window |
| \`X-RateLimit-Remaining\` | Number of requests remaining in the current window |
| \`X-RateLimit-Reset\` | Time (epoch seconds or ms) when the current window resets |

When rate limits are exceeded, the API returns \`429 Too Many Requests\` with an error payload explaining the retry delay.

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
- \`4001\` / \`4400\` — Bad Request / Invalid Handshake
- \`4003\` — Forbidden (Wallet does not own task)
- \`4004\` — Task Not Found
- \`4008\` — Auth Handshake Timeout
- \`4408\` — Heartbeat Pong Timeout (Stale connection)

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
        "X-Request-Id": {
          description: "Unique request identifier for distributed tracing and logging.",
          schema: { type: "string", example: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" },
        },
        "X-API-Version": {
          description: "The negotiated API version used to process the request.",
          schema: { type: "string", example: "1.0" },
        },
      },
      schemas: {
        CreateTaskRequest: generateOpenApiSchema(CreateTaskSchema),
        RegisterAgentRequest: generateOpenApiSchema(RegisterAgentSchema),
        Pagination: generateOpenApiSchema(PaginationSchema),
        IdParam: generateOpenApiSchema(IdParamSchema),
        TaskStatus: {
          type: "string",
          enum: ["queued", "running", "completed", "failed", "cancelled"],
          example: "queued",
          description: "Current lifecycle state of the task orchestration.",
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
        DeepHealthStatus: {
          type: "object",
          required: ["venice", "horizon"],
          properties: {
            venice: { type: "string", enum: ["ok", "unreachable"], example: "ok" },
            horizon: { type: "string", enum: ["ok", "unreachable"], example: "ok" },
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

export const openapiSpec: Record<string, any> = swaggerJsdoc(openapiOptions);

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
