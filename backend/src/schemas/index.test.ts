/**
 * Unit tests for the `src/schemas` barrel (Issue #740).
 *
 * `common.ts`, `task.ts` and `agent.ts` are covered directly. The barrel is the
 * import surface every route, test and the frontend actually reach for, so it
 * needs to be covered too — a re-export that silently disappears is a
 * compile-time break in all of them, and an untested barrel is exactly where
 * that would hide.
 *
 * The identity assertions matter more than they look: this barrel is
 * `export *` over three modules, so a name that exists in two of them silently
 * resolves to one of them rather than erroring. Pinning that each schema is the
 * *same object* its defining module exports is what catches the collision.
 */

import * as barrel from "./index";
import * as agent from "./agent";
import * as common from "./common";
import * as openapi from "./openapi";
import * as task from "./task";

describe("src/schemas barrel", () => {
  it("re-exports the shared base schemas", () => {
    expect(barrel.paginationSchema).toBe(common.paginationSchema);
    expect(barrel.sortSchema).toBe(common.sortSchema);
    expect(barrel.dateRangeSchema).toBe(common.dateRangeSchema);
    expect(barrel.idSchema).toBe(common.idSchema);
    expect(barrel.idParamSchema).toBe(common.idParamSchema);
    expect(barrel.stellarPublicKeySchema).toBe(common.stellarPublicKeySchema);
    expect(barrel.withPagination).toBe(common.withPagination);
    expect(barrel.withDateRange).toBe(common.withDateRange);
    expect(barrel.toFieldErrors).toBe(common.toFieldErrors);
    expect(barrel.MAX_PAGE_SIZE).toBe(common.MAX_PAGE_SIZE);
    expect(barrel.DEFAULT_PAGE_SIZE).toBe(common.DEFAULT_PAGE_SIZE);
  });

  it("re-exports the task schemas", () => {
    expect(barrel.taskStatusSchema).toBe(task.taskStatusSchema);
    expect(barrel.taskPrioritySchema).toBe(task.taskPrioritySchema);
    expect(barrel.promptSchema).toBe(task.promptSchema);
    expect(barrel.createTaskSchema).toBe(task.createTaskSchema);
    expect(barrel.listTasksQuerySchema).toBe(task.listTasksQuerySchema);
    expect(barrel.taskIdParamSchema).toBe(task.taskIdParamSchema);
    expect(barrel.updateTaskStatusSchema).toBe(task.updateTaskStatusSchema);
    expect(barrel.MAX_PROMPT_LENGTH).toBe(task.MAX_PROMPT_LENGTH);
  });

  it("re-exports the agent schemas", () => {
    expect(barrel.agentStatusSchema).toBe(agent.agentStatusSchema);
    expect(barrel.reputationSchema).toBe(agent.reputationSchema);
    expect(barrel.priceXlmSchema).toBe(agent.priceXlmSchema);
    expect(barrel.listAgentsQuerySchema).toBe(agent.listAgentsQuerySchema);
    expect(barrel.agentIdParamSchema).toBe(agent.agentIdParamSchema);
    expect(barrel.heartbeatSchema).toBe(agent.heartbeatSchema);
    expect(barrel.registerAgentSchema).toBe(agent.registerAgentSchema);
  });

  it("re-exports the OpenAPI helpers", () => {
    expect(barrel.routeParameters).toBe(openapi.routeParameters);
    expect(barrel.toOpenApiParameters).toBe(openapi.toOpenApiParameters);
  });

  it("exposes no name that no defining module exports", () => {
    const defined = new Set([
      ...Object.keys(common),
      ...Object.keys(task),
      ...Object.keys(agent),
      ...Object.keys(openapi),
    ]);
    const leaked = Object.keys(barrel).filter((name) => name !== "__esModule" && !defined.has(name));

    expect(leaked).toEqual([]);
  });

  it("validates through the barrel", () => {
    // A barrel that exported the right names bound to the wrong objects would
    // still pass an identity-free smoke test; these go through `safeParse`.
    expect(barrel.paginationSchema.safeParse({ page: "0" }).success).toBe(false);
    expect(barrel.createTaskSchema.safeParse({ prompt: "" }).success).toBe(false);
    expect(barrel.listTasksQuerySchema.safeParse({ status: "nope" }).success).toBe(false);
    expect(barrel.listAgentsQuerySchema.safeParse({ maxPriceXLM: "-1" }).success).toBe(false);
    expect(barrel.heartbeatSchema.safeParse({ status: "nope" }).success).toBe(false);
  });
});