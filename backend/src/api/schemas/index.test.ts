/**
 * Unit tests for the `api/schemas` barrel (Issue #740).
 *
 * The barrel is the public import surface for these schemas, so a missing or
 * renamed re-export is a compile-time break in every caller rather than a
 * runtime one — but only if something actually imports it. This suite imports
 * the barrel, which is what makes `index.ts` real coverage rather than an
 * unreferenced file sitting at 0%.
 *
 * It also pins that the barrel re-exports the *same* schema objects the modules
 * define. A barrel that re-declares instead of re-exporting is how a documented
 * contract and an enforced one silently become two different things.
 */

import {
  AgentListQuerySchema,
  CreateTaskSchema,
  IdParamSchema,
  PaginationSchema,
  RegisterAgentSchema,
  TaskListSchema,
  type AgentListQueryInput,
  type CreateTaskInput,
  type IdParamInput,
  type PaginationInput,
  type RegisterAgentInput,
  type TaskListInput,
} from "./index";
import * as barrel from "./index";
import * as agentSchema from "./agent.schema";
import * as commonSchema from "./common.schema";
import * as taskSchema from "./task.schema";

/** Runtime exports of the barrel, minus the CJS interop marker. */
function barrelExports(): Array<[string, unknown]> {
  return Object.entries(barrel as Record<string, unknown>).filter(
    ([name]) => name !== "__esModule",
  );
}

describe("api/schemas barrel", () => {
  it("re-exports every schema without redeclaring it", () => {
    expect(PaginationSchema).toBe(commonSchema.PaginationSchema);
    expect(IdParamSchema).toBe(commonSchema.IdParamSchema);
    expect(CreateTaskSchema).toBe(taskSchema.CreateTaskSchema);
    expect(TaskListSchema).toBe(taskSchema.TaskListSchema);
    expect(RegisterAgentSchema).toBe(agentSchema.RegisterAgentSchema);
    expect(AgentListQuerySchema).toBe(agentSchema.AgentListQuerySchema);
  });

  it("exposes every barrel export as a Zod schema", () => {
    const exports = barrelExports();
    expect(exports.length).toBe(6);
    for (const [name, value] of exports) {
      // A Zod schema is an object, not a function — `safeParse` is the
      // capability that matters, and its presence proves nothing else leaked in.
      expect(typeof value).toBe("object");
      expect(typeof (value as { safeParse?: unknown }).safeParse).toBe("function");
      expect(name).not.toBe("__esModule");
    }
  });

  it("re-exports six of the seven schemas its modules define", () => {
    const defined = [...Object.values(commonSchema), ...Object.values(taskSchema), ...Object.values(agentSchema)].filter(
      (value: unknown): value is { safeParse: unknown } => typeof (value as { safeParse?: unknown })?.safeParse === "function",
    );

    expect(defined).toHaveLength(7);
    expect(barrelExports()).toHaveLength(6);
  });

  it("does not re-export AgentHeartbeatSchema, which is reachable only from its module", () => {
    // `AgentHeartbeatSchema` is exported by `agent.schema` but deliberately
    // absent from the barrel — the heartbeat route imports it directly. Pinned
    // so that gap is a recorded decision rather than an accident waiting to be
    // either "fixed" or silently depended upon.
    const names = barrelExports().map(([name]) => name);
    expect(names).not.toContain("AgentHeartbeatSchema");
    expect(agentSchema.AgentHeartbeatSchema).toBeDefined();
  });

  it("validates through the barrel", () => {
    expect(CreateTaskSchema.safeParse({ prompt: "x" }).success).toBe(true);
    expect(TaskListSchema.safeParse({ status: "nope" }).success).toBe(false);
    expect(RegisterAgentSchema.safeParse({}).success).toBe(false);
    expect(PaginationSchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(IdParamSchema.safeParse({ id: "" }).success).toBe(false);
    expect(AgentListQuerySchema.safeParse({ maxPriceXLM: "-1" }).success).toBe(false);
  });

  it("routes every rejection through the same issues shape the error handler expects", () => {
    const result = CreateTaskSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;

    for (const issue of result.error.issues) {
      expect(typeof issue.path).toBe("object");
      expect(typeof issue.code).toBe("string");
      expect(typeof issue.message).toBe("string");
    }
  });
});

// Compile-time proof that the barrel's inferred input types resolve. These
// assertions never run, but a broken `z.infer` chain fails the typecheck.
export type _Pagination = PaginationInput;
export type _IdParam = IdParamInput;
export type _CreateTask = CreateTaskInput;
export type _TaskList = TaskListInput;
export type _RegisterAgent = RegisterAgentInput;
export type _AgentListQuery = AgentListQueryInput;