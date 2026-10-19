/**
 * CORS middleware.
 *
 * ## Why this file is not just a literal list (issue #659)
 *
 * The allow list used to be hand-maintained, and it had drifted out of sync
 * with the code in two ways:
 *
 * - **Headers.** The middleware stack reads `idempotency-key`, `x-request-id`,
 *   `x-trace-id`, `x-correlation-id`, `traceparent`, `x-user-id`,
 *   `x-admin-api-key` and `api-version`, none of which were allowed. A browser
 *   preflight rejects the whole request, so those headers could never be sent
 *   from a web client at all — which silently disabled idempotent task
 *   creation and distributed tracing in exactly the environment where a double
 *   submit is most likely.
 * - **Methods.** The list was hardcoded, so it could not track the routes the
 *   app actually registers.
 *
 * The header list below is now declared once and kept honest by
 * `tests/corsAllowList.test.ts`, which enumerates every `req.headers[...]` read
 * in the middleware stack and fails if one is missing. That test is what stops
 * the list from drifting again.
 */

import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import { allowedOrigins } from '../../config';
import { ForbiddenError } from '../../errors/ForbiddenError';
import { createLogger } from '../../utils/logger';

const logger = createLogger({ module: 'cors' });

// ---------------------------------------------------------------------------
// Allowed request headers
// ---------------------------------------------------------------------------

/**
 * Request headers a browser client is permitted to send cross-origin.
 *
 * Grouped by the middleware that reads them, so a new header read is easy to
 * place. Keep in sync with the middleware stack —
 * `tests/corsAllowList.test.ts` enforces that and enumerates the reads itself,
 * so it fails if a header is read somewhere but forgotten here.
 */
export const CORS_ALLOWED_REQUEST_HEADERS: readonly string[] = [
  // ── Body / auth primitives ──────────────────────────────────────────────
  'Content-Type',
  'Authorization',

  // ── Wallet identity — requestLogger.ts ──────────────────────────────────
  'walletpublickey',

  // ── Agent signature scheme — routes/agents.ts ───────────────────────────
  'x-challenge',
  'x-signature',

  // ── Idempotency — middleware/idempotency.ts ─────────────────────────────
  'Idempotency-Key',

  // ── Request correlation and tracing — requestId.ts ─────────────────────
  'X-Request-Id',
  'X-Trace-Id',
  'X-Correlation-ID',
  'traceparent',

  // ── Actor identity for logging — requestLogger.ts ───────────────────────
  'X-User-Id',

  // ── Admin auth — auth.ts ────────────────────────────────────────────────
  'X-Admin-Api-Key',

  // ── Admin audit actor — services/adminControl.ts (`actorFromRequest`) ────
  // Read on the /api/admin routes, which are CORS-mounted like everything else.
  'X-Admin-Actor',

  // ── API version negotiation — versioning.ts ────────────────────────────
  'Api-Version',

  // ── Response-cache bypass — cache.ts ───────────────────────────────────
  'X-Cache-Bypass',

  // ── Response compression — compression.ts ──────────────────────────────
  // A browser sets this itself and it is a forbidden header name, so it can
  // never reach the server via CORS. It is listed anyway so the invariant
  // "every header the middleware reads is explicitly allowed" holds without
  // exceptions in the drift test.
  'Accept-Encoding',
];

/**
 * Methods allowed regardless of the route table.
 *
 * `PATCH` is here even though no PATCH route is currently registered: the
 * server is explicitly prepared for it — `readOnlyMiddleware` treats PATCH as
 * a mutation method and `updateTaskStatusSchema` (`src/schemas/task.ts`)
 * defines a `PATCH /api/tasks/:id` body — so a browser must be able to
 * preflight it. Deriving purely from the route table would drop PATCH
 * whenever no such route happens to be registered.
 */
export const CORS_BASE_METHODS: readonly string[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];

/** `Access-Control-Max-Age` for preflight responses, in seconds (10 minutes). */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

// ---------------------------------------------------------------------------
// Route-table introspection
// ---------------------------------------------------------------------------

interface ExpressLayer {
  route?: { methods?: Record<string, boolean> };
  handle?: { stack?: ExpressLayer[] };
}

interface ExpressAppLike {
  _router?: { stack?: ExpressLayer[] };
}

/**
 * Collect the HTTP methods registered on an Express app.
 *
 * Walks the router stack, descending into mounted sub-routers. Layers without a
 * `route` (bare middleware such as `express.json()`) contribute nothing.
 *
 * @returns Upper-cased method names, e.g. `['GET', 'POST']`.
 */
export function collectRegisteredMethods(app: unknown): string[] {
  const found = new Set<string>();

  const walk = (stack: ExpressLayer[] | undefined): void => {
    if (!Array.isArray(stack)) return;
    for (const layer of stack) {
      if (layer?.route?.methods) {
        for (const method of Object.keys(layer.route.methods)) {
          if (typeof method === 'string' && method !== '_all') found.add(method.toUpperCase());
        }
      }
      // Mounted routers and sub-apps expose their own layer stack.
      if (layer?.handle?.stack) walk(layer.handle.stack);
    }
  };

  walk((app as ExpressAppLike | undefined)?._router?.stack);
  return [...found];
}

/**
 * The full method list: the base set plus whatever the route table registers.
 * Sorted and de-duplicated so the emitted header is stable.
 */
export function allowedMethods(app?: unknown): string[] {
  return [...new Set([...CORS_BASE_METHODS, ...collectRegisteredMethods(app)])].sort();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the resolved CORS options for an app.
 *
 * Exported so tests can assert on exactly the configuration the middleware
 * serves, rather than re-deriving it a second way.
 */
export function buildCorsOptions(app?: unknown) {
  const origins = allowedOrigins();

  return {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // `Origin: null` comes from sandboxed iframes and `file://` pages. It is
      // rejected in every environment, even when it is not in the list, so a
      // development build cannot be reached from an opaque origin.
      if (origin === 'null') {
        logger.debug('CORS null origin rejected');
        callback(new ForbiddenError('Not allowed by CORS'));
      } else if (!origin || origins.includes(origin)) {
        // No Origin header means a non-browser caller (server-to-server, curl),
        // which CORS does not apply to.
        callback(null, true);
      } else {
        // Rejected origins are a client policy outcome, not a server fault.
        // Log at debug level only so scanners cannot flood error logs with
        // attacker-controlled origin strings.
        logger.debug('CORS origin rejected');
        callback(new ForbiddenError('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: allowedMethods(app),
    allowedHeaders: [...CORS_ALLOWED_REQUEST_HEADERS],
    // Preflight cache lifetime, in seconds. Browsers re-validate after this.
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  };
}

/**
 * Create the CORS middleware.
 *
 * @param app Optional Express app, used to derive `Access-Control-Allow-Methods`
 *            from the routes that are actually registered. The derivation runs
 *            per request because routers are mounted after this middleware is
 *            installed.
 */
export function createCorsMiddleware(app?: unknown) {
  const base = buildCorsOptions();

  const corsHandler = cors((_req, callback) => {
    // `cors` resolves its options through this delegate on every request, so
    // the route table is read only once all routers are mounted.
    callback(null, { ...base, methods: allowedMethods(app) });
  });

  // Ensure `Vary: Origin` is present on every path — including rejections —
  // so a cached rejection is never served to a legitimate origin.
  return (req: Request, res: Response, next: NextFunction): void => {
    const existing = res.getHeader('Vary');
    if (!existing) {
      res.setHeader('Vary', 'Origin');
    } else if (typeof existing === 'string' && !existing.includes('Origin')) {
      res.setHeader('Vary', `${existing}, Origin`);
    } else if (Array.isArray(existing) && !existing.includes('Origin')) {
      res.setHeader('Vary', [...existing, 'Origin']);
    }
    corsHandler(req, res, next);
  };
}
