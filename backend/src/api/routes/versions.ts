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
import { Router, Request, Response } from 'express';
import { config } from '../../config';

export interface VersionEntry {
  version: string;
  status: 'current' | 'deprecated' | 'sunset';
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
    version: '1.0',
    status: 'deprecated',
    deprecatedAt: '2026-01-01',
    sunsetAt: config.API_V1_SUNSET_DATE ?? '2027-01-01',
    breakingChanges: [],
    migratesTo: '2.0',
  },
  {
    version: '1.1',
    status: 'deprecated',
    deprecatedAt: '2026-06-01',
    sunsetAt: config.API_V1_SUNSET_DATE ?? '2027-01-01',
    breakingChanges: ['Task response envelope changed: `result` moved to `data.result`.'],
    migratesTo: '2.0',
  },
  {
    version: '2.0',
    status: 'current',
    breakingChanges: [
      'Error responses now include a machine-readable `code` field.',
      'Paginated list endpoints return `{ data, pagination }` instead of a bare array.',
      'Agent registration requires `capabilities` array (was optional in v1).',
    ],
  },
];

export function createVersionsRouter(): Router {
  const router = Router();

  /**
   * @openapi
   * /api/versions:
   *   get:
   *     summary: API versioning lifecycle manifest (Issue #426)
   *     operationId: listApiVersions
   *     description: >
   *       Supported API versions with deprecation status, sunset dates and
   *       changelog summary so clients can detect when they need to migrate.
   *       Mirrors the `Deprecation` / `Sunset` response headers set by
   *       versioningMiddleware as structured JSON.
   *     tags: [System]
   *     security: []
   *     responses:
   *       200:
   *         description: Version manifest with deprecation policy
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 latestVersion: { type: string, example: "2.0" }
   *                 defaultVersion: { type: string, example: "2.0" }
   *                 policy:
   *                   type: object
   *                   properties:
   *                     deprecationNoticeMonths: { type: integer, example: 6 }
   *                     sunsetGracePeriodMonths: { type: integer, example: 12 }
   *                     policyUrl: { type: string, example: "/docs#api-versioning" }
   *                 versions:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       version: { type: string, example: "2.0" }
   *                       status: { type: string, enum: [current, deprecated, sunset] }
   *                       deprecatedAt: { type: string, format: date }
   *                       sunsetAt: { type: string, format: date }
   *                       breakingChanges: { type: array, items: { type: string } }
   *                       migratesTo: { type: string, example: "2.0" }
   */
  router.get('/', (_req: Request, res: Response) => {
    const manifest = VERSION_MANIFEST;
    const current = manifest.find((v) => v.status === 'current');
    res.json({
      latestVersion: current?.version ?? '2.0',
      defaultVersion: config.API_DEFAULT_VERSION,
      policy: {
        deprecationNoticeMonths: 6,
        sunsetGracePeriodMonths: 12,
        policyUrl: '/docs#api-versioning',
      },
      versions: manifest,
    });
  });

  return router;
}
