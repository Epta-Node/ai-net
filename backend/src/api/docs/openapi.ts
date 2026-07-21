import swaggerJsdoc from "swagger-jsdoc";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.1.0",
    info: {
      title: "ai-net Backend API",
      version: "0.1.0",
      license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
      description: `REST API for the ai-net backend — task orchestration, agent registry, and system health.

## Live task stream (WebSocket)

In addition to the REST endpoints below, the server exposes a WebSocket endpoint that is not representable in OpenAPI 3.x (which only covers HTTP/REST):

\`ws://<host>/tasks/:id/stream\`

Optional query param: \`?lastEventId=<seq>\` to resume from a cursor instead of replaying full history.

**Protocol:**
1. Connect, then send \`{ "walletPublicKey": "<key>" }\` as the first message within 10s (auth handshake). Connections that skip this are closed.
2. The server verifies the wallet owns the task, then replays past events (all of them, or only those after \`lastEventId\` if provided).
3. Live events are streamed afterward as they occur. Each event includes a per-task monotonic \`seq\` field for resuming later.
4. The server pings every 30s; clients must respond with \`{ "type": "pong" }\` within 10s or the connection is closed as stale.

Close codes are defined in \`src/types/stream.ts\` (\`WS_CLOSE\`), covering: task not found, forbidden (wrong wallet), auth timeout, bad request, and stale heartbeat.`,
    },
    servers: [
      { url: "http://localhost:3000", description: "Local development" },
      // TODO: confirm real staging/production URLs before opening the PR
      { url: "https://staging.example.com", description: "Staging" },
      { url: "https://api.example.com", description: "Production" },
    ],
    components: {
      securitySchemes: {
        // The codebase reads a raw `walletpublickey` header directly
        // (see app.ts /api/tasks routes) rather than using formal API-key
        // middleware. Modeled as apiKey since that's the closest OpenAPI
        // concept.
        WalletAuth: {
          type: "apiKey",
          in: "header",
          name: "walletpublickey",
        },
        // Used only by DELETE /api/agents/:id. Not a standard OpenAPI auth
        // type — modeled as apiKey on x-signature since OpenAPI has no
        // native "signed challenge" scheme. The x-challenge header is
        // documented separately as a parameter on that route.
        AgentSignatureAuth: {
          type: "apiKey",
          in: "header",
          name: "x-signature",
        },
      },
      schemas: {
        TaskStatus: {
          type: "string",
          enum: ["queued", "running", "completed", "failed", "cancelled"],
          description:
            "The Task type only declares queued/running/completed/failed, but the DELETE /api/tasks/:id handler sets status to 'cancelled' at runtime, so it's included here to match observed behavior.",
        },
        NodeStatus: {
          type: "string",
          enum: ["pending", "running", "completed", "failed"],
        },
        DAGNode: {
          type: "object",
          required: ["nodeId", "agentType", "prompt", "dependsOn", "status"],
          properties: {
            nodeId: { type: "string" },
            agentType: { type: "string" },
            prompt: { type: "string" },
            dependsOn: {
              type: "array",
              items: { type: "string" },
            },
            status: { $ref: "#/components/schemas/NodeStatus" },
            result: {},
            error: { type: "string" },
          },
        },
        Task: {
          type: "object",
          description:
            "Returned by GET /api/tasks/:id and DELETE /api/tasks/:id. Contains both 'id' and 'taskId' (duplicated by the handler) and a parsed 'dag' array.",
          required: ["id", "taskId", "prompt", "walletPublicKey", "status", "dag", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string", example: "task_ab12cd34ef56" },
            taskId: { type: "string", example: "task_ab12cd34ef56" },
            prompt: { type: "string" },
            walletPublicKey: { type: "string" },
            status: { $ref: "#/components/schemas/TaskStatus" },
            dag: {
              type: "array",
              items: { $ref: "#/components/schemas/DAGNode" },
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            requestId: { type: "string" },
          },
        },
        TaskListItem: {
          type: "object",
          description:
            "Returned inside the 'tasks' array by GET /api/tasks. This endpoint queries the DB layer directly and does not parse the stored DAG, so it returns 'dagJson' (a raw JSON string) rather than a parsed 'dag' array — unlike GET /api/tasks/:id.",
          required: ["id", "prompt", "walletPublicKey", "status", "dagJson", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string", example: "task_ab12cd34ef56" },
            prompt: { type: "string" },
            walletPublicKey: { type: "string" },
            status: { $ref: "#/components/schemas/TaskStatus" },
            dagJson: {
              type: "string",
              description: "JSON-serialized array of DAGNode objects. Parse client-side if needed.",
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
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
            id: { type: "string" },
            capabilities: {
              type: "array",
              items: { type: "string" },
            },
            pricingXLM: { type: "number" },
            endpoint: { type: "string", format: "uri" },
            stellarPublicKey: { type: "string" },
            reputationScore: { type: "number" },
            lastSeenAt: { type: "string", format: "date-time" },
          },
        },
        Error: {
          type: "object",
          properties: {
            error: {
              oneOf: [{ type: "string" }, { type: "object" }],
            },
          },
        },
      },
    },
    security: [{ WalletAuth: [] }],
  },
  // NOTE: annotations live in app.ts (inline task routes) and
  // routes/agents.ts, routes/health.ts, routes/stats.ts. routes/tasks.ts is NOT included —
  // it is not wired into the running app (app.ts defines /api/tasks routes
  // inline instead) and documenting it would describe endpoints that don't
  // actually run.
  apis: ["./src/api/app.ts", "./src/api/routes/agents.ts", "./src/api/routes/health.ts", "./src/api/routes/stats.ts"],
};

export const openapiSpec = swaggerJsdoc(options);