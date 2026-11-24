/**
 * Unit tests for `api/schemas/task.schema.ts` (Issue #740).
 *
 * `CreateTaskSchema` is the main request-validation surface for task
 * submission, and its `prompt` rule is the only place a user-supplied string
 * gets length-capped and control-character-stripped before it reaches a billed
 * Venice AI call. Both halves are load-bearing, so they get boundary tests at
 * the configured ceiling rather than just a "rejects a long string" case.
 */

import { z } from "zod";
import { getConfig } from "../../config";
import { CreateTaskSchema, TaskListSchema } from "./task.schema";

const MAX_PROMPT_LENGTH = getConfig().MAX_PROMPT_LENGTH;

/** Assert a parse fails and hand back the first issue. */
function rejectionOf(schema: z.ZodTypeAny, value: unknown): z.ZodIssue {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  const error = (result as z.SafeParseError<unknown>).error;
  expect(error.issues.length).toBeGreaterThan(0);
  return error.issues[0]!;
}

describe("CreateTaskSchema — prompt", () => {
  it("accepts a plain prompt and applies the documented defaults", () => {
    expect(CreateTaskSchema.parse({ prompt: "analyse the DEX" })).toEqual({
      prompt: "analyse the DEX",
      maxBudgetXLM: 1,
      priority: "normal",
    });
  });

  it("accepts a prompt of exactly the configured maximum length", () => {
    const prompt = "a".repeat(MAX_PROMPT_LENGTH);
    expect(CreateTaskSchema.safeParse({ prompt }).success).toBe(true);
  });

  it("accepts every documented priority", () => {
    for (const priority of ["low", "normal", "high", "critical"]) {
      expect(CreateTaskSchema.parse({ prompt: "x", priority }).priority).toBe(priority);
    }
  });

  it("keeps tabs, newlines and carriage returns, which are legitimate prompt content", () => {
    const prompt = "line1\nline2\r\nend\tcolumn";
    expect(CreateTaskSchema.parse({ prompt }).prompt).toBe(prompt);
  });

  it("strips C0 control characters that are invisible in a UI", () => {
    expect(CreateTaskSchema.parse({ prompt: "hel\x00lo\x07\x1fworld" }).prompt).toBe("helloworld");
  });

  it("trims surrounding whitespace left by the transform", () => {
    expect(CreateTaskSchema.parse({ prompt: "  padded  " }).prompt).toBe("padded");
  });

  // ── Negative ──────────────────────────────────────────────────────────────

  it("rejects an empty prompt with the documented message", () => {
    expect(rejectionOf(CreateTaskSchema, { prompt: "" }).message).toBe("Prompt is required");
  });

  it("rejects a missing prompt", () => {
    expect(CreateTaskSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a prompt one character over the ceiling", () => {
    const result = CreateTaskSchema.safeParse({ prompt: "a".repeat(MAX_PROMPT_LENGTH + 1) });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.message).toBe(
      `Prompt too long (max ${MAX_PROMPT_LENGTH} characters)`,
    );
  });

  it("rejects a non-string prompt", () => {
    expect(CreateTaskSchema.safeParse({ prompt: 12345 }).success).toBe(false);
  });

  it("rejects a prompt that is only whitespace", () => {
    // `.min(1)` runs before the trim, so this passes length validation and then
    // sanitises down to an empty string. Pinned so a future reordering of the
    // checks is a visible change rather than a silent one.
    const parsed = CreateTaskSchema.safeParse({ prompt: "   " });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.prompt).toBe("");
  });

  it("rejects a null prompt", () => {
    expect(CreateTaskSchema.safeParse({ prompt: null }).success).toBe(false);
  });
});

describe("CreateTaskSchema — budget, priority and preferences", () => {
  it("accepts a budget at the 0.1 XLM floor", () => {
    expect(CreateTaskSchema.parse({ prompt: "x", maxBudgetXLM: 0.1 }).maxBudgetXLM).toBe(0.1);
  });

  it("accepts an explicit priority and optional keys", () => {
    const parsed = CreateTaskSchema.parse({
      prompt: "x",
      walletPublicKey: "GKEY",
      maxBudgetXLM: 25,
      agentPreferences: ["research", "audit"],
      priority: "critical",
    });
    expect(parsed).toEqual({
      prompt: "x",
      walletPublicKey: "GKEY",
      maxBudgetXLM: 25,
      agentPreferences: ["research", "audit"],
      priority: "critical",
    });
  });

  it("rejects a budget below the 0.1 XLM floor", () => {
    expect(CreateTaskSchema.safeParse({ prompt: "x", maxBudgetXLM: 0.09 }).success).toBe(false);
  });

  it("rejects a negative budget", () => {
    expect(CreateTaskSchema.safeParse({ prompt: "x", maxBudgetXLM: -5 }).success).toBe(false);
  });

  it("rejects a zero budget", () => {
    expect(CreateTaskSchema.safeParse({ prompt: "x", maxBudgetXLM: 0 }).success).toBe(false);
  });

  it("rejects a stringified budget, which is not coerced", () => {
    expect(CreateTaskSchema.safeParse({ prompt: "x", maxBudgetXLM: "10" }).success).toBe(false);
  });

  it("rejects an unknown priority", () => {
    expect(CreateTaskSchema.safeParse({ prompt: "x", priority: "urgent" }).success).toBe(false);
  });

  it("rejects agentPreferences that is not an array", () => {
    expect(CreateTaskSchema.safeParse({ prompt: "x", agentPreferences: "research" }).success).toBe(
      false,
    );
  });

  it("rejects a non-string entry inside agentPreferences", () => {
    expect(
      CreateTaskSchema.safeParse({ prompt: "x", agentPreferences: ["research", 7] }).success,
    ).toBe(false);
  });

  it("rejects a non-string walletPublicKey", () => {
    expect(CreateTaskSchema.safeParse({ prompt: "x", walletPublicKey: 99 }).success).toBe(false);
  });
});

describe("TaskListSchema", () => {
  it("applies documented defaults when absent", () => {
    expect(TaskListSchema.parse({})).toEqual({ page: 1, pageSize: 10, sort: "createdAt:desc" });
  });

  it("coerces paging from the query string and keeps filters", () => {
    expect(TaskListSchema.parse({ page: "2", pageSize: "50", status: "running", q: "solar" })).toEqual(
      { page: 2, pageSize: 50, status: "running", sort: "createdAt:desc", q: "solar" },
    );
  });

  it("accepts both documented sort directions", () => {
    expect(TaskListSchema.parse({ sort: "createdAt:asc" }).sort).toBe("createdAt:asc");
    expect(TaskListSchema.parse({ sort: "createdAt:desc" }).sort).toBe("createdAt:desc");
  });

  it("accepts every documented status", () => {
    for (const status of ["queued", "running", "completed", "failed", "cancelled"]) {
      expect(TaskListSchema.parse({ status }).status).toBe(status);
    }
  });

  // ── Negative ──────────────────────────────────────────────────────────────

  it("rejects an unknown status", () => {
    expect(TaskListSchema.safeParse({ status: "sleeping" }).success).toBe(false);
  });

  it("rejects an unknown sort field", () => {
    expect(TaskListSchema.safeParse({ sort: "password:asc" }).success).toBe(false);
  });

  it("rejects an unknown sort direction", () => {
    expect(TaskListSchema.safeParse({ sort: "createdAt:sideways" }).success).toBe(false);
  });

  it("rejects a page below one", () => {
    expect(TaskListSchema.safeParse({ page: "0" }).success).toBe(false);
  });

  it("rejects a page size above 100", () => {
    expect(TaskListSchema.safeParse({ pageSize: "101" }).success).toBe(false);
  });

  it("rejects a fractional page size", () => {
    expect(TaskListSchema.safeParse({ pageSize: "10.5" }).success).toBe(false);
  });

  it("rejects a non-string search term", () => {
    expect(TaskListSchema.safeParse({ q: 123 }).success).toBe(false);
  });
});