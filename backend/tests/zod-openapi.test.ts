import { z } from "zod";
import { buildSchemaExample, generateOpenApiSchema } from "../src/api/openapi/zod";

describe("schema-derived OpenAPI helpers", () => {
  it("turns a zod object into a reusable OpenAPI schema", () => {
    const schema = z.object({
      prompt: z.string().min(1),
      maxBudgetXLM: z.number().min(0.1).optional(),
      agentPreferences: z.array(z.string()).optional(),
    });

    const result = generateOpenApiSchema(schema);

    expect(result.type).toBe("object");
    expect(result.properties.prompt.type).toBe("string");
    expect(result.properties.maxBudgetXLM.type).toBe("number");
    expect(result.properties.agentPreferences.type).toBe("array");
  });

  it("creates examples from the schema shape", () => {
    const schema = z.object({
      id: z.string(),
      status: z.enum(["queued", "completed"]),
      amount: z.number().min(0),
    });

    const example = buildSchemaExample(schema);

    expect(example).toMatchObject({
      id: expect.any(String),
      status: expect.stringMatching(/queued|completed/),
      amount: expect.any(Number),
    });
  });
});
