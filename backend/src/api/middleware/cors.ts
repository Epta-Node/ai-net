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
import { allowedOrigins, getConfig } from '../../config';
import { ForbiddenError } from '../../errors/ForbiddenError';
import { createLogger } from '../../utils/logger';

const logger = createLogger({ module: 'cors' });

// ---------------------------------------------------------------------------
// Allowed request headers
// ---------------------------------------------------------------------------

/**
 * Request headers a browser client is permitted to send cross-origin.
 *
 * Includes the minimum set required by issue #1009 while preserving existing
 * stack-read headers to avoid breaking internal clients/tests.
 */
export const CORS_ALLOWED_REQUEST_HEADERS: readonly string[] = [
  'Content-Type',
  'Authorization',
  'Walletpublickey',
  'Idempotency-Key',
  'Last-Event-ID',
  // Existing stack headers
  'x-challenge',
  'x-signature',
  'X-Request-Id',
  'X-Trace-Id',
  'X-Correlation-ID',
  'traceparent',
  'X-User-Id',
  'X-Admin-Api-Key',
  'X-Admin-Actor',
  'Api-Version',
  'X-Cache-Bypass',
  'Accept-Encoding',
];

/**
 * Methods allowed by default. Route-derived methods are merged in, then
 * per-route policy in the middleware narrows the actual preflight response.
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

/** `Access-Control-Max-Age` for preflight responses, in seconds (24 hours). */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 86_400;

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
function pathOf(req: Request): string {
  const original = (req.originalUrl || req.url || '').split('?')[0] || '';
  return original || req.path || '';
}

function isAdminPath(path: string): boolean {
  return path.startsWith('/api/admin');
}

function isMetricsPath(path: string): boolean {
  return path === '/metrics' || path === '/api/metrics' || path.startsWith('/metrics/') || path.startsWith('/api/metrics/');
}

function isPublicApiPath(path: string): boolean {
  return (
    path === '/api/tasks' || path.startsWith('/api/tasks/') ||
    path === '/api/agents' || path.startsWith('/api/agents/') ||
    path === '/api/stats' || path.startsWith('/api/stats/') ||
    path === '/api/wallet' || path.startsWith('/api/wallet/')
  );
}

function isCorsManagedPath(path: string): boolean {
  return isAdminPath(path) || isMetricsPath(path) || isPublicApiPath(path);
}

function allowedMethodsForPath(path: string): string[] {
  if (path === '/api/tasks') return ['GET', 'POST', 'OPTIONS'];
  if (/^\/api\/tasks\/[^/]+$/.test(path)) return ['GET', 'OPTIONS'];
  if (/^\/api\/tasks\/[^/]+\/events(?:\/stream)?$/.test(path)) return ['GET', 'OPTIONS'];
  if (/^\/api\/tasks\/[^/]+\/cost$/.test(path)) return ['GET', 'OPTIONS'];
  if (/^\/api\/tasks\/[^/]+\/export/.test(path)) return ['GET', 'OPTIONS'];

  if (path === '/api/agents') return ['GET', 'OPTIONS'];
  if (path === '/api/agents/register') return ['POST', 'OPTIONS'];
  if (/^\/api\/agents\/[^/]+$/.test(path)) return ['GET', 'OPTIONS'];
  if (/^\/api\/agents\/[^/]+\/(pause|resume)$/.test(path)) return ['POST', 'OPTIONS'];

  if (path === '/api/stats' || path.startsWith('/api/stats/')) return ['GET', 'OPTIONS'];
  if (path === '/api/wallet' || path.startsWith('/api/wallet/')) return ['GET', 'POST', 'OPTIONS'];

  // Fallback for public API paths: conservative read/create only.
  return ['GET', 'POST', 'OPTIONS'];
}

function getFrontendOrigin(): string | undefined {
  try {
    const cfg = getConfig() as any;
    const explicit = typeof cfg.FRONTEND_ORIGIN === 'string' ? cfg.FRONTEND_ORIGIN.trim() : '';
    if (explicit) return explicit;
  } catch {
    // ignore config load errors and fall back
  }
  const origins = allowedOrigins();
  return origins[0];
}

export function buildCorsOptions(app?: unknown) {
  const origins = allowedOrigins();

  return {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (origin === 'null') {
        logger.debug('CORS null origin rejected');
        callback(new ForbiddenError('Not allowed by CORS'));
      } else if (!origin || origins.includes(origin)) {
        callback(null, true);
      } else {
        logger.debug('CORS origin rejected');
        callback(new ForbiddenError('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: allowedMethods(app),
    allowedHeaders: [...CORS_ALLOWED_REQUEST_HEADERS],
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  };
}

/**
 * Create the CORS middleware with per-route policy hardening (#1009).
 */
export function createCorsMiddleware(app?: unknown) {
  const base = buildCorsOptions();

  const corsHandler = cors((_req, callback) => {
    callback(null, { ...base, methods: allowedMethods(app) });
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const path = pathOf(req);

    // Skip CORS middleware for WS/SSE upgrade paths handled outside Express.
    if (req.headers.upgrade) {
      next();
      return;
    }

    // Ensure Vary: Origin on all responses (including non-CORS-managed).
    const existing = res.getHeader('Vary');
    if (!existing) {
      res.setHeader('Vary', 'Origin');
    } else if (typeof existing === 'string' && !existing.includes('Origin')) {
      res.setHeader('Vary', `${existing}, Origin`);
    } else if (Array.isArray(existing) && !existing.includes('Origin')) {
      res.setHeader('Vary', [...existing, 'Origin']);
    }

    // Admin and metrics routes: no CORS headers at all. Preflight is forbidden.
    if (isAdminPath(path) || isMetricsPath(path)) {
      if (req.method === 'OPTIONS') {
        res.status(403).send('Forbidden');
        return;
      }
      next();
      return;
    }

    if (!isCorsManagedPath(path)) {
      // Preserve legacy behavior for non-API paths.
      corsHandler(req, res, next);
      return;
    }

    const frontendOrigin = getFrontendOrigin();
    const requestOrigin = req.headers.origin;
    const originAllowed =
      typeof requestOrigin === 'string' &&
      requestOrigin.length > 0 &&
      requestOrigin !== 'null' &&
      requestOrigin === frontendOrigin;

    if (req.method === 'OPTIONS') {
      if (!originAllowed) {
        res.status(403).send('Forbidden');
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', frontendOrigin!);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', allowedMethodsForPath(path).join(', '));
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_REQUEST_HEADERS.join(', '));
      res.setHeader('Access-Control-Max-Age', String(CORS_PREFLIGHT_MAX_AGE_SECONDS));
      res.status(200).end();
      return;
    }

    if (originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', frontendOrigin!);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    // For simple requests on public API paths, we've already applied the policy.
    next();
  };
}
