import type { Request, Response, NextFunction } from 'express';
import { UnauthorizedError } from '../../errors';

function loadKeys(): Set<string> | null {
  const raw = process.env.API_KEYS;
  if (!raw) return null;
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  return keys.length ? new Set(keys) : null;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const keys = loadKeys();
  if (!keys) {
    next();
    return;
  }

  const auth = req.headers['authorization'] ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !keys.has(token)) {
    next(new UnauthorizedError());
    return;
  }

  next();
}

/**
 * Resolve the configured admin API key.
 *
 * Reads the validated config when it has been loaded, falling back to the raw
 * environment so the middleware also works in contexts (tests, scripts) that
 * never call `loadConfig()`.
 */
export function resolveAdminApiKey(): string | undefined {
  let fromConfig: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fromConfig = (require('../../config') as typeof import('../../config')).getConfig()
      .ADMIN_API_KEY;
  } catch {
    // Config not loaded — fall through to the environment.
  }
  const key = fromConfig ?? process.env.ADMIN_API_KEY;
  return key && key.length > 0 ? key : undefined;
}

/** Constant-time string comparison; length differences short-circuit safely. */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Extract the presented admin key from either supported header. */
function readPresentedKey(req: Request): string {
  const header = req.headers['x-admin-api-key'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader) return fromHeader.trim();

  const auth = req.headers['authorization'] ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

/**
 * Guard admin-only endpoints with a shared secret.
 *
 * Accepts `X-Admin-API-Key: <key>` or `Authorization: Bearer <key>`. Unlike
 * {@link authMiddleware}, this middleware **fails closed**: when
 * `ADMIN_API_KEY` is not configured the endpoint responds 503, so an
 * unconfigured deployment never exposes admin data anonymously.
 */
export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = resolveAdminApiKey();
  if (!expected) {
    res.status(503).json({
      error: 'Admin API not configured',
      message: 'Set ADMIN_API_KEY to enable admin endpoints.',
    });
    return;
  }

  const presented = readPresentedKey(req);
  if (!presented || !timingSafeEquals(presented, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
