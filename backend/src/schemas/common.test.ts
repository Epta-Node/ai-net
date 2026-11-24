import { z } from "zod";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  dateRangeSchema,
  idParamSchema,
  paginationSchema,
  sortSchema,
  stellarPublicKeySchema,
  toFieldErrors,
  withDateRange,
  withPagination,
} from "./common";
import { createTaskSchema, listTasksQuerySchema, MAX_PROMPT_LENGTH } from "./task";
import { listAgentsQuerySchema, registerAgentSchema } from "./agent";
import { routeParameters, toOpenApiParameters } from "./openapi";

describe("pagination", () => {
  it("applies defaults when absent", () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it("coerces numeric strings from a query string", () => {
    expect(paginationSchema.parse({ page: "3", pageSize: "25" })).toEqual({
      page: 3,
      pageSize: 25,
    });
  });

  it("rejects a page below one", () => {
    expect(paginationSchema.safeParse({ page: 0 }).success).toBe(false);
  });

  it("rejects a page size above the ceiling", () => {
    expect(paginationSchema.safeParse({ pageSize: MAX_PAGE_SIZE + 1 }).success).toBe(false);
  });

  it("rejects a non-integer page", () => {
    expect(paginationSchema.safeParse({ page: 1.5 }).success).toBe(false);
  });
});

describe("composition", () => {
  it("withPagination adds paging to a base schema", () => {
    const schema = withPagination(z.object({ capability: z.string().optional() }));
    expect(schema.parse({ capability: "research" })).toEqual({
      capability: "research",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it("withPagination keeps the base schema's own rules", () => {
    const schema = withPagination(z.object({ capability: z.string().min(3) }));
    expect(schema.safeParse({ capability: "ab" }).success).toBe(false);
  });

  it("extend narrows a base schema without mutating it", () => {
    const base = z.object({ id: z.string() });
    const extended = base.extend({ prompt: z.string().min(1) });

    expect(extended.safeParse({ id: "a", prompt: "hi" }).success).toBe(true);
    // The base is untouched by the extension.
    expect(base.safeParse({ id: "a" }).success).toBe(true);
  });

  it("composes pagination and sorting together", () => {
    const schema = withPagination(z.object({ q: z.string().optional() })).merge(
      sortSchema(["createdAt"], "createdAt:desc"),
    );
    expect(schema.parse({})).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      sort: "createdAt:desc",
    });
  });
});

describe("sortSchema", () => {
  const schema = sortSchema(["createdAt", "updatedAt"], "createdAt:desc");

  it("defaults to the supplied value", () => {
    expect(schema.parse({})).toEqual({ sort: "createdAt:desc" });
  });

  it("accepts every field/direction pair", () => {
    for (const value of [
      "createdAt:asc",
      "createdAt:desc",
      "updatedAt:asc",
      "updatedAt:desc",
    ]) {
      expect(schema.parse({ sort: value })).toEqual({ sort: value });
    }
  });

  it("rejects an unknown field", () => {
    expect(schema.safeParse({ sort: "password:asc" }).success).toBe(false);
  });

  it("rejects an unknown direction", () => {
    expect(schema.safeParse({ sort: "createdAt:sideways" }).success).toBe(false);
  });
});

describe("dateRangeSchema", () => {
  it("accepts an open-ended range", () => {
    expect(dateRangeSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a well-ordered range", () => {
    const result = dateRangeSchema.safeParse({
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an inverted range", () => {
    const result = dateRangeSchema.safeParse({
      from: "2026-03-01T00:00:00Z",
      to: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(dateRangeSchema.safeParse({ from: "yesterday" }).success).toBe(false);
  });

  it("withDateRange preserves the ordering check", () => {
    const schema = withDateRange(z.object({ status: z.string().optional() }));
    expect(
      schema.safeParse({ from: "2026-03-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }).success,
    ).toBe(false);
    expect(schema.safeParse({ status: "queued" }).success).toBe(true);
  });
});

describe("identifier schemas", () => {
  it("trims and requires an id", () => {
    expect(idParamSchema.parse({ id: "  task_1  " })).toEqual({ id: "task_1" });
    expect(idParamSchema.safeParse({ id: "   " }).success).toBe(false);
  });

  it("validates Stellar public keys", () => {
    const valid = `G${"A".repeat(55)}`;
    expect(stellarPublicKeySchema.safeParse(valid).success).toBe(true);
    expect(stellarPublicKeySchema.safeParse("GABC").success).toBe(false);
    // Lowercase is not valid base32 here.
    expect(stellarPublicKeySchema.safeParse(`G${"a".repeat(55)}`).success).toBe(false);
  });
});

describe("toFieldErrors", () => {
  it("keeps the dotted path for nested fields", () => {
    const schema = z.object({ agent: z.object({ pricingXLM: z.number() }) });
    const result = schema.safeParse({ agent: { pricingXLM: "free" } });

    expect(result.success).toBe(false);
    if (result.success) return;

    const errors = toFieldErrors(result.error);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("agent.pricingXLM");
    expect(errors[0].code).toBe("invalid_type");
    expect(typeof errors[0].message).toBe("string");
  });

  it("reports every invalid field, not just the first", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const result = schema.safeParse({ a: 1, b: "x" });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(toFieldErrors(result.error).map((e) => e.field).sort()).toEqual(["a", "b"]);
  });

  it("labels a root-level failure", () => {
    const result = z.string().safeParse(42);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(toFieldErrors(result.error)[0].field).toBe("(root)");
  });
});

describe("task schemas", () => {
  it("strips invisible control characters from a prompt", () => {
    const parsed = createTaskSchema.parse({ prompt: "hel\x00lo\x07 world" });
    expect(parsed.prompt).toBe("hello world");
  });

  it("keeps tabs and newlines", () => {
    const parsed = createTaskSchema.parse({ prompt: "line1\nline2\tend" });
    expect(parsed.prompt).toBe("line1\nline2\tend");
  });

  it("rejects an over-long prompt", () => {
    const result = createTaskSchema.safeParse({ prompt: "a".repeat(MAX_PROMPT_LENGTH + 1) });
    expect(result.success).toBe(false);
  });

  it("rejects an empty prompt", () => {
    expect(createTaskSchema.safeParse({ prompt: "" }).success).toBe(false);
  });

  it("defaults budget and priority", () => {
    const parsed = createTaskSchema.parse({ prompt: "hi" });
    expect(parsed.maxBudgetXLM).toBe(1);
    expect(parsed.priority).toBe("normal");
  });

  it("accepts the documented list query", () => {
    expect(listTasksQuerySchema.parse({ status: "queued", page: "2" })).toEqual({
      status: "queued",
      page: 2,
      pageSize: DEFAULT_PAGE_SIZE,
      sort: "createdAt:desc",
    });
  });

  it("rejects an unknown status", () => {
    expect(listTasksQuerySchema.safeParse({ status: "sleeping" }).success).toBe(false);
  });
});

describe("agent schemas", () => {
  const validKey = `G${"A".repeat(55)}`;

  it("accepts a well-formed registration", () => {
    const result = registerAgentSchema.safeParse({
      agentId: "agent-1",
      capabilities: ["research"],
      pricingXLM: 1.5,
      endpoint: "https://agent.example/run",
      stellarPublicKey: validKey,
    });
    expect(result.success).toBe(true);
  });

  it("requires at least one capability", () => {
    const result = registerAgentSchema.safeParse({
      agentId: "agent-1",
      capabilities: [],
      pricingXLM: 1,
      endpoint: "https://agent.example/run",
      stellarPublicKey: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-URL endpoint", () => {
    const result = registerAgentSchema.safeParse({
      agentId: "agent-1",
      capabilities: ["research"],
      pricingXLM: 1,
      endpoint: "not-a-url",
      stellarPublicKey: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative price", () => {
    const result = registerAgentSchema.safeParse({
      agentId: "agent-1",
      capabilities: ["research"],
      pricingXLM: -1,
      endpoint: "https://agent.example/run",
      stellarPublicKey: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("coerces numeric filters from the query string", () => {
    const parsed = listAgentsQuerySchema.parse({ minReputation: "80", maxPriceXLM: "2.5" });
    expect(parsed.minReputation).toBe(80);
    expect(parsed.maxPriceXLM).toBe(2.5);
  });

  it("rejects a reputation outside 0-100", () => {
    expect(listAgentsQuerySchema.safeParse({ minReputation: "101" }).success).toBe(false);
  });

  it("rejects a non-numeric filter instead of yielding NaN", () => {
    expect(listAgentsQuerySchema.safeParse({ maxPriceXLM: "cheap" }).success).toBe(false);
  });
});

describe("OpenAPI generation", () => {
  it("derives query parameters with types and defaults", () => {
    const params = toOpenApiParameters(paginationSchema, "query");
    const page = params.find((p) => p.name === "page");

    expect(page).toBeDefined();
    expect(page?.in).toBe("query");
    expect(page?.schema.type).toBe("integer");
    expect(page?.schema.default).toBe(1);
    // Defaulted parameters are not required.
    expect(page?.required).toBe(false);
  });

  it("carries numeric bounds through", () => {
    const params = toOpenApiParameters(paginationSchema, "query");
    const pageSize = params.find((p) => p.name === "pageSize");
    expect(pageSize?.schema.minimum).toBe(1);
    expect(pageSize?.schema.maximum).toBe(MAX_PAGE_SIZE);
  });

  it("renders an enum", () => {
    const params = toOpenApiParameters(listTasksQuerySchema, "query");
    const status = params.find((p) => p.name === "status");
    expect(status?.schema.enum).toEqual([
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("marks path parameters required even when the schema is optional", () => {
    const params = toOpenApiParameters(z.object({ id: z.string().optional() }), "path");
    expect(params[0].required).toBe(true);
    expect(params[0].in).toBe("path");
  });

  it("carries string constraints through", () => {
    const params = toOpenApiParameters(
      z.object({ endpoint: z.string().url(), name: z.string().min(2).max(8) }),
      "query",
    );
    expect(params.find((p) => p.name === "endpoint")?.schema.format).toBe("uri");
    const name = params.find((p) => p.name === "name");
    expect(name?.schema.minLength).toBe(2);
    expect(name?.schema.maxLength).toBe(8);
  });

  it("looks through a refine wrapper", () => {
    const params = toOpenApiParameters(dateRangeSchema, "query");
    expect(params.map((p) => p.name).sort()).toEqual(["from", "to"]);
  });

  it("returns nothing for a non-object schema", () => {
    expect(toOpenApiParameters(z.string(), "query")).toEqual([]);
  });

  it("orders path parameters before query parameters", () => {
    const params = routeParameters({
      params: idParamSchema,
      query: paginationSchema,
    });
    expect(params[0].in).toBe("path");
    expect(params.slice(1).every((p) => p.in === "query")).toBe(true);
  });

  it("degrades gracefully for an unsupported type", () => {
    const params = toOpenApiParameters(z.object({ blob: z.map(z.string(), z.string()) }), "query");
    expect(params).toHaveLength(1);
    expect(params[0].schema).toEqual({});
  });
});
