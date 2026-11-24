/**
 * Unit tests for `api/schemas/common.schema.ts` (Issue #740).
 *
 * These are the legacy pagination and path-parameter schemas. They are still
 * what `api/docs.ts` generates OpenAPI components from, so a drift between what
 * is documented and what is enforced shows up here as a failing assertion rather
 * than as a confused client.
 *
 * Every schema carries at least one negative case, because the positive cases
 * are the ones that already work — a suite of happy paths would pass just as
 * happily against a schema that accepts everything.
 */

import { z } from "zod";
import { IdParamSchema, PaginationSchema } from "./common.schema";

/**
 * Assert a parse fails and hand back the first issue.
 *
 * Asserting on the *path* as well as the failure matters here: a schema that
 * rejects the right input for the wrong reason is still a broken schema, and a
 * bare `.success === false` cannot tell the two apart.
 */
function rejectionOf(schema: z.ZodTypeAny, value: unknown): z.ZodIssue {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  const error = (result as z.SafeParseError<unknown>).error;
  expect(error.issues.length).toBeGreaterThan(0);
  return error.issues[0]!;
}

describe("PaginationSchema", () => {
  it("applies documented defaults when both parameters are absent", () => {
    expect(PaginationSchema.parse({})).toEqual({ page: 1, pageSize: 10 });
  });

  it("coerces query-string values into numbers", () => {
    expect(PaginationSchema.parse({ page: "4", pageSize: "25" })).toEqual({
      page: 4,
      pageSize: 25,
    });
  });

  it("accepts the page-size ceiling of 100", () => {
    expect(PaginationSchema.parse({ pageSize: "100" }).pageSize).toBe(100);
  });

  it("ignores unrelated keys rather than rejecting them", () => {
    expect(PaginationSchema.parse({ page: 2, cursor: "abc" })).toEqual({
      page: 2,
      pageSize: 10,
    });
  });

  // ── Negative: page ────────────────────────────────────────────────────────

  it("rejects page 0", () => {
    expect(rejectionOf(PaginationSchema, { page: "0" }).path).toEqual(["page"]);
  });

  it("rejects a negative page", () => {
    expect(PaginationSchema.safeParse({ page: "-1" }).success).toBe(false);
  });

  it("rejects a fractional page", () => {
    expect(PaginationSchema.safeParse({ page: "1.5" }).success).toBe(false);
  });

  it("rejects a non-numeric page instead of coercing it to NaN", () => {
    expect(PaginationSchema.safeParse({ page: "first" }).success).toBe(false);
  });

  it("rejects a null page", () => {
    expect(PaginationSchema.safeParse({ page: null }).success).toBe(false);
  });

  // ── Negative: pageSize ────────────────────────────────────────────────────

  it("rejects pageSize 0", () => {
    expect(rejectionOf(PaginationSchema, { pageSize: "0" }).path).toEqual(["pageSize"]);
  });

  it("rejects a page size above the ceiling of 100", () => {
    expect(PaginationSchema.safeParse({ pageSize: "101" }).success).toBe(false);
  });

  it("rejects a fractional page size", () => {
    expect(PaginationSchema.safeParse({ pageSize: "10.5" }).success).toBe(false);
  });

  it("rejects a non-numeric page size", () => {
    expect(PaginationSchema.safeParse({ pageSize: "lots" }).success).toBe(false);
  });

  it("reports both bad parameters in a single failure", () => {
    const result = PaginationSchema.safeParse({ page: "0", pageSize: "0" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path[0]).sort()).toEqual([
      "page",
      "pageSize",
    ]);
  });
});

describe("IdParamSchema", () => {
  it("accepts a non-empty id", () => {
    expect(IdParamSchema.parse({ id: "task_abc123" })).toEqual({ id: "task_abc123" });
  });

  it("accepts a single character, which is the boundary of min(1)", () => {
    expect(IdParamSchema.safeParse({ id: "x" }).success).toBe(true);
  });

  it("rejects an empty id with the documented message", () => {
    expect(rejectionOf(IdParamSchema, { id: "" }).message).toBe("ID is required");
  });

  it("rejects a whitespace-only id, which is not trimmed", () => {
    // Deliberate contrast with `schemas/common.ts`'s `idSchema`, which does
    // trim. A silent behaviour difference between the two is exactly the kind of
    // thing this suite exists to pin.
    expect(IdParamSchema.safeParse({ id: "   " }).success).toBe(true);
    expect(IdParamSchema.parse({ id: "  task_1  " })).toEqual({ id: "  task_1  " });
  });

  it("rejects a missing id", () => {
    expect(IdParamSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a null id", () => {
    expect(IdParamSchema.safeParse({ id: null }).success).toBe(false);
  });

  it("rejects a numeric id", () => {
    expect(IdParamSchema.safeParse({ id: 42 }).success).toBe(false);
  });
});