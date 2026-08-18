import type { Request, Response, NextFunction } from 'express';

function loadKeys(): Set<string> | null {
  const raw = process.env.API_KEYS;
  if (!raw) return null;
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  return keys.length ? new Set(keys) : null;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const keys = loadKeys();
  if (!keys) {
    // API_KEYS unset — no-op, backward compatible
    next();
    return;
  }

  const auth = req.headers['authorization'] ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !keys.has(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
