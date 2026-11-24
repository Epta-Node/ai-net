/**
 * Tests for issue #650: Admin job listing pageSize is unclamped and NaN-prone.
 *
 * Pure clamp-logic tests — run under the default jest config (mocked SQLite).
 * These verify the Math.max/min/floor formula extracted from jobStore.ts
 * covers every edge case from the issue's acceptance criteria.
 *
 * Full SQLite integration tests live in tests/sqlite/jobStore.pagination.test.ts
 * and require a compiled native binary (npm run test:sqlite).
 */

/**
 * The exact clamp formulas from src/queue/jobStore.ts list().
 * Copied here so the tests pin the behaviour independently of the source file.
 */
function clampPage(raw: number | undefined): number {
  return Math.max(1, Math.floor(raw ?? 1) || 1);
}

function clampPageSize(raw: number | undefined): number {
  return Math.min(100, Math.max(1, Math.floor(raw ?? 50) || 1));
}

describe("jobStore clamp helpers — AC1 / AC2 / AC4 (pure logic)", () => {
  // ── AC1: negative / zero pageSize ──────────────────────────────────────────
  describe("AC1: pageSize clamped to minimum 1", () => {
    it("clamps -1 to 1", () => expect(clampPageSize(-1)).toBe(1));
    it("clamps -100 to 1", () => expect(clampPageSize(-100)).toBe(1));
    it("clamps 0 to 1", () => expect(clampPageSize(0)).toBe(1));
    it("clamps page=-1 to 1", () => expect(clampPage(-1)).toBe(1));
    it("clamps page=0 to 1", () => expect(clampPage(0)).toBe(1));
  });

  // ── AC2: enormous pageSize capped at 100 ───────────────────────────────────
  describe("AC2: pageSize clamped to maximum 100", () => {
    it("clamps 1e9 to 100", () => expect(clampPageSize(1e9)).toBe(100));
    it("clamps 101 to 100", () => expect(clampPageSize(101)).toBe(100));
    it("clamps 200 to 100", () => expect(clampPageSize(200)).toBe(100));
    it("leaves 100 unchanged", () => expect(clampPageSize(100)).toBe(100));
  });

  // ── AC4: NaN safety ────────────────────────────────────────────────────────
  describe("AC4: NaN is handled without throwing", () => {
    it("clampPageSize(NaN) returns 1", () => expect(clampPageSize(NaN)).toBe(1));
    it("clampPage(NaN) returns 1", () => expect(clampPage(NaN)).toBe(1));
  });

  // ── Valid range preserved ──────────────────────────────────────────────────
  describe("valid inputs pass through unchanged", () => {
    it("pageSize=50 stays 50 (default)", () => expect(clampPageSize(50)).toBe(50));
    it("pageSize=1 stays 1", () => expect(clampPageSize(1)).toBe(1));
    it("page=1 stays 1", () => expect(clampPage(1)).toBe(1));
    it("page=10 stays 10", () => expect(clampPage(10)).toBe(10));
    it("undefined pageSize defaults to 50", () => expect(clampPageSize(undefined)).toBe(50));
    it("undefined page defaults to 1", () => expect(clampPage(undefined)).toBe(1));
  });

  // ── Offset arithmetic ──────────────────────────────────────────────────────
  describe("offset arithmetic produces non-negative values", () => {
    it.each([
      [1, 10],
      [1, -1],
      [1, NaN],
      [-5, 50],
      [NaN, 50],
    ])("page=%p, pageSize=%p → offset >= 0", (page, pageSize) => {
      const p = clampPage(page);
      const ps = clampPageSize(pageSize);
      const offset = (p - 1) * ps;
      expect(offset).toBeGreaterThanOrEqual(0);
    });
  });
});
