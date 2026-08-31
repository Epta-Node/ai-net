/**
 * GET /api/versions — API versioning lifecycle manifest (#426).
 *
 * Returns the supported versions, deprecation status, sunset dates, and
 * changelog summary so clients can programmatically detect when they need to
 * migrate without relying on documentation.
 *
 * Deprecated endpoints already set `Deprecation: true` and `Sunset: <date>`
 * response headers via versioningMiddleware — this endpoint makes the same
 * information available as structured JSON.
 */
import { Router, Request, Response } from "express";

export interface VersionEntry {
  version: string;
  status: "current" | "deprecated" | "sunset";
  /** ISO-8601 date the version was deprecated, if applicable. */
  deprecatedAt?: string;
  /** ISO-8601 date after which the version will be removed. */
  sunsetAt?: string;
  /** Human-readable summary of breaking changes introduced in this version. */
  breakingChanges: string[];
  /** Recommended migration target when deprecated. */
  migratesTo?: string;
}

const VERSION_MANIFEST: VersionEntry[] = [
  {
    version: "1.0",
    status: "deprecated",
    deprecatedAt: "2026-01-01",
    sunsetAt: process.env.API_V1_SUNSET_DATE ?? "2027-01-01",
    breakingChanges: [],
    migratesTo: "2.0",
  },
  {
    version: "1.1",
    status: "deprecated",
    deprecatedAt: "2026-06-01",
    sunsetAt: process.env.API_V1_SUNSET_DATE ?? "2027-01-01",
    breakingChanges: [
      "Task response envelope changed: `result` moved to `data.result`.",
    ],
    migratesTo: "2.0",
  },
  {
    version: "2.0",
    status: "current",
    breakingChanges: [
      "Error responses now include a machine-readable `code` field.",
      "Paginated list endpoints return `{ data, pagination }` instead of a bare array.",
      "Agent registration requires `capabilities` array (was optional in v1).",
    ],
  },
];

export function createVersionsRouter(): Router {
  const router = Router();

  /**
   * @openapi
   * /api/versions:
   *   get:
   *     summary: API versioning lifecycle manifest
   *     description: >
   *       Lists all API versions with their deprecation status, sunset dates,
   *       and breaking-change summaries. Clients should poll this endpoint to
   *       detect when an in-use version has been deprecated or is near its
   *       sunset date.
   *     tags: [Versioning]
   *     security: []
   *     responses:
   *       200:
   *         description: Version manifest
   */
  router.get("/", (_req: Request, res: Response) => {
    const current = VERSION_MANIFEST.find((v) => v.status === "current");
    res.json({
      latestVersion: current?.version ?? "2.0",
      defaultVersion: process.env.API_DEFAULT_VERSION ?? "1.0",
      policy: {
        deprecationNoticeMonths: 6,
        sunsetGracePeriodMonths: 12,
        policyUrl: "/docs#api-versioning",
      },
      versions: VERSION_MANIFEST,
    });
  });

  return router;
}
