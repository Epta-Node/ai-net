import express from "express";
import request from "supertest";
import { validate } from "../src/api/middleware/validate";
import {
  CreateTaskSchema,
  TaskQuerySchema,
} from "../src/api/schemas/task.schema";
import {
  RegisterAgentSchema,
  AgentListQuerySchema,
} from "../src/api/schemas/agent.schema";

function appFor(schema: Parameters<typeof validate>[0], echo?: string) {
  const app = express();
  app.use(express.json());
  const handler = (req: any, res: any) => {
    res.json({ body: req.body, query: req.query, params: req.params, echo });
  };
  app.post("/", validate({ body: schema.body }), handler);
  app.get("/", validate({ query: schema.query }), handler);
  app.get("/:id", validate({ params: schema.params }), handler);
  return app;
}

describe("validate() middleware", () => {
  it("returns 400 with structured FieldError[] for invalid body", async () => {
    const app = appFor({ body: CreateTaskSchema });
    const res = await request(app).post("/").send({ maxBudgetXLM: 0.05 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details[0]).toHaveProperty("path");
    expect(res.body.details[0]).toHaveProperty("message");
    expect(res.body.details.some((d: any) => d.path === "body.prompt")).toBe(true);
  });

  it("trims strings and coerces numbers on the way through", async () => {
    const app = appFor({ body: CreateTaskSchema });
    const res = await request(app)
      .post("/")
      .send({ prompt: "  research AI  ", maxBudgetXLM: 1 });

    expect(res.status).toBe(200);
    expect(res.body.body.prompt).toBe("research AI");
  });

  it("accepts valid query params with coercion (page is a number)", async () => {
    const app = appFor({ query: TaskQuerySchema });
    const res = await request(app).get("/?page=2&pageSize=5&status=queued&sort=createdAt:asc");

    expect(res.status).toBe(200);
    expect(typeof res.body.query.page).toBe("number");
    expect(res.body.query.page).toBe(2);
    expect(res.body.query.status).toBe("queued");
  });

  it("rejects an invalid enum value in query with a field error", async () => {
    const app = appFor({ query: TaskQuerySchema });
    const res = await request(app).get("/?status=bogus");

    expect(res.status).toBe(400);
    expect(res.body.details.some((d: any) => d.path === "query.status")).toBe(true);
  });

  it("returns 400 for an invalid agent registration body", async () => {
    const app = appFor({ body: RegisterAgentSchema });
    const res = await request(app)
      .post("/")
      .send({ agentId: "", capabilities: [], pricingXLM: -1, endpoint: "not-a-url", stellarPublicKey: "x" });

    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("coerces numeric query params for agent list", async () => {
    const app = appFor({ query: AgentListQuerySchema });
    const res = await request(app).get("/?minReputation=2&maxPriceXLM=3.5&status=online");

    expect(res.status).toBe(200);
    expect(res.body.query.minReputation).toBe(2);
    expect(res.body.query.maxPriceXLM).toBe(3.5);
  });
});
