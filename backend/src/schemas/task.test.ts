/**
 * Per-schema tests for `schemas/task.ts` (Issue #740).
 *
 * `common.test.ts` exercises `createTaskSchema` and `listTasksQuerySchema`
 * through the composed surface. This file covers the leaf schemas those compose
 * from, so a leaf that starts accepting every value fails here even while the
 * composed tests keep passing.
 *
 * Only the gaps are here; anything already asserted in `common.test.ts` is left
 * where it is rather than duplicated.
 */

import {
  MAX_AGENT_PREFERENCES,
  MAX_AGENT_PREFERENCE_LENGTH,
  MAX_PROMPT_LENGTH,
  agentPreferenceSchema,
  createTaskSchema,
  listTasksQuerySchema,
  promptSchema,
  taskIdParamSchema,
  taskPrioritySchema,
  taskStatusSchema,
  updateTaskStatusSchema,
} from "./task";

describe("taskStatusSchema", () => {
  it("accepts all five lifecycle states", () => {
    for (const status of ["queued", "running", "completed", "failed", "cancelled"]) {
      expect(taskStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects a state outside the lifecycle", () => {
    expect(taskStatusSchema.safeParse("sleeping").success).toBe(false);
  });

  it("rejects a case-variant state", () => {
    expect(taskStatusSchema.safeParse("QUEUED").success).toBe(false);
  });

  it("rejects an empty state", () => {
    expect(taskStatusSchema.safeParse("").success).toBe(false);
  });

  it("rejects a non-string state", () => {
    expect(taskStatusSchema.safeParse(3).success).toBe(false);
  });

  it("is what rejects an unknown state in the list query", () => {
    expect(listTasksQuerySchema.safeParse({ status: "sleeping" }).success).toBe(false);
  });

  it("is what rejects an unknown state in a PATCH body", () => {
    expect(updateTaskStatusSchema.safeParse({ status: "sleeping" }).success).toBe(false);
  });
});

describe("taskPrioritySchema", () => {
  it("accepts all four documented priorities", () => {
    for (const priority of ["low", "normal", "high", "critical"]) {
      expect(taskPrioritySchema.parse(priority)).toBe(priority);
    }
  });

  it("rejects an unknown priority", () => {
    expect(taskPrioritySchema.safeParse("urgent").success).toBe(false);
  });

  it("rejects an empty priority rather than defaulting it", () => {
    expect(taskPrioritySchema.safeParse("").success).toBe(false);
  });

  it("rejects a case-variant priority", () => {
    expect(taskPrioritySchema.safeParse("Normal").success).toBe(false);
  });

  it("rejects a non-string priority", () => {
    expect(taskPrioritySchema.safeParse(2).success).toBe(false);
  });

  it("is what rejects an unknown priority in a create body", () => {
    expect(createTaskSchema.safeParse({ prompt: "x", priority: "urgent" }).success).toBe(false);
  });
});

describe("promptSchema", () => {
  it("accepts a prompt of exactly MAX_PROMPT_LENGTH", () => {
    expect(promptSchema.safeParse("a".repeat(MAX_PROMPT_LENGTH)).success).toBe(true);
  });

  it("rejects a prompt one character over MAX_PROMPT_LENGTH", () => {
    const result = promptSchema.safeParse("a".repeat(MAX_PROMPT_LENGTH + 1));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.message).toBe(
      `Prompt too long (max ${MAX_PROMPT_LENGTH} characters)`,
    );
  });

  it("rejects an empty prompt with the documented message", () => {
    const result = promptSchema.safeParse("");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.message).toBe("Prompt is required");
  });

  it("strips the C0 control characters that are invisible in a UI", () => {
    expect(promptSchema.parse("a\x00b\x07c")).toBe("abc");
  });

  it("keeps tab, newline and carriage return", () => {
    expect(promptSchema.parse("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("trims surrounding whitespace", () => {
    expect(promptSchema.parse("  spaced  ")).toBe("spaced");
  });

  it("rejects a non-string prompt", () => {
    expect(promptSchema.safeParse(12345).success).toBe(false);
  });

  it("rejects a whitespace-only prompt once sanitised", () => {
    const result = promptSchema.safeParse("   ");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.message).toBe("Prompt is required");
  });

  it("rejects a prompt made only of stripped control characters", () => {
    expect(promptSchema.safeParse("\x00\x07 \x1F").success).toBe(false);
  });

  it("gives a descriptive message for a non-string prompt", () => {
    const result = promptSchema.safeParse(12345);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.message).toBe("Prompt must be a string");
  });
});

describe("taskIdParamSchema", () => {
  it("trims and requires an id", () => {
    expect(taskIdParamSchema.parse({ id: "  task_1  " })).toEqual({ id: "task_1" });
  });

  it("rejects a whitespace-only id", () => {
    expect(taskIdParamSchema.safeParse({ id: "   " }).success).toBe(false);
  });

  it("rejects an empty id", () => {
    expect(taskIdParamSchema.safeParse({ id: "" }).success).toBe(false);
  });

  it("rejects a missing id", () => {
    expect(taskIdParamSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-string id", () => {
    expect(taskIdParamSchema.safeParse({ id: 42 }).success).toBe(false);
  });
});

describe("updateTaskStatusSchema", () => {
  it("requires a status", () => {
    expect(updateTaskStatusSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a documented status", () => {
    expect(updateTaskStatusSchema.parse({ status: "cancelled" })).toEqual({
      status: "cancelled",
    });
  });

  it("ignores other fields, so only status is mutable", () => {
    const parsed = updateTaskStatusSchema.parse({ status: "running", prompt: "ignored" });
    expect(parsed).toEqual({ status: "running" });
  });

  it("rejects a missing status even with other fields present", () => {
    expect(updateTaskStatusSchema.safeParse({ prompt: "x" }).success).toBe(false);
  });
});
const VALID_WALLET = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HHNN";

describe("createTaskSchema — request body validation (#894)", () => {
  it("reports a missing prompt as required", () => {
    const result = createTaskSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.path).toEqual(["prompt"]);
    expect(result.error.issues[0]!.message).toBe("Prompt is required");
  });

  it("accepts a well-formed Stellar wallet public key", () => {
    expect(createTaskSchema.parse({ prompt: "x", walletPublicKey: VALID_WALLET }).walletPublicKey)
      .toBe(VALID_WALLET);
  });

  it.each([
    ["too short", "GABC"],
    ["wrong leading letter", `S${VALID_WALLET.slice(1)}`],
    ["lowercase", VALID_WALLET.toLowerCase()],
    ["characters outside base32", `G${"1".repeat(55)}`],
    ["one character too long", `${VALID_WALLET}A`],
    ["empty", ""],
  ])("rejects a wallet public key that is %s", (_label, walletPublicKey) => {
    const result = createTaskSchema.safeParse({ prompt: "x", walletPublicKey });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.path).toEqual(["walletPublicKey"]);
    expect(result.error.issues[0]!.message).toBe("Must be a valid Stellar public key");
  });

  it("still allows the wallet to be omitted", () => {
    expect(createTaskSchema.safeParse({ prompt: "x" }).success).toBe(true);
  });

  it("describes a non-numeric budget", () => {
    const result = createTaskSchema.safeParse({ prompt: "x", maxBudgetXLM: "10" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.message).toBe("maxBudgetXLM must be a number");
  });

  it("describes a budget below the floor", () => {
    const result = createTaskSchema.safeParse({ prompt: "x", maxBudgetXLM: 0.05 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.message).toBe("maxBudgetXLM must be at least 0.1");
  });
});

describe("agentPreferenceSchema", () => {
  it("trims surrounding whitespace", () => {
    expect(agentPreferenceSchema.parse("  research-agent-v1  ")).toBe("research-agent-v1");
  });

  it("accepts an entry of exactly the maximum length", () => {
    expect(agentPreferenceSchema.safeParse("a".repeat(MAX_AGENT_PREFERENCE_LENGTH)).success).toBe(
      true,
    );
  });

  it("rejects an entry one character over the maximum length", () => {
    expect(
      agentPreferenceSchema.safeParse("a".repeat(MAX_AGENT_PREFERENCE_LENGTH + 1)).success,
    ).toBe(false);
  });

  it.each([[""], ["   "]])("rejects an empty entry %j", (value) => {
    const result = agentPreferenceSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.message).toBe("Agent preference must not be empty");
  });

  it("rejects a non-string entry", () => {
    const result = agentPreferenceSchema.safeParse(7);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.message).toBe("Agent preference must be a string");
  });
});

describe("createTaskSchema — agentPreferences bounds", () => {
  it("accepts exactly the maximum number of preferences", () => {
    const agentPreferences = Array.from({ length: MAX_AGENT_PREFERENCES }, (_, i) => `agent-${i}`);
    expect(createTaskSchema.safeParse({ prompt: "x", agentPreferences }).success).toBe(true);
  });

  it("rejects more than the maximum number of preferences", () => {
    const agentPreferences = Array.from(
      { length: MAX_AGENT_PREFERENCES + 1 },
      (_, i) => `agent-${i}`,
    );
    const result = createTaskSchema.safeParse({ prompt: "x", agentPreferences });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.message).toBe(
      `At most ${MAX_AGENT_PREFERENCES} agent preferences allowed`,
    );
  });

  it("rejects a blank entry inside the list and reports its index", () => {
    const result = createTaskSchema.safeParse({ prompt: "x", agentPreferences: ["research", " "] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.path).toEqual(["agentPreferences", 1]);
  });
});
