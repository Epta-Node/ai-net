/**
 * Per-wallet quota middleware for the task routers (Issue #803).
 *
 * Runs after `validate(createTaskSchema)` — so the body is a parsed task
 * payload — and before the handler, which still owns the legacy
 * `DAILY_TASK_LIMIT_PER_WALLET` check. Order matters: prompt-size and
 * wallet-quota rejections happen before any task row or job is created, and
 * the legacy rate limit stays exactly where it was.
 */

import type { NextFunction, Request, Response } from 'express';
import { assertPromptWithinQuota, checkAndConsumeTask } from '../../services/quota/walletQuota';

/** Body-first, then either header spelling, then the anonymous placeholder. */
export function walletFromRequest(req: Request): string {
  const body = (req.body ?? {}) as { walletPublicKey?: unknown };
  if (typeof body.walletPublicKey === 'string' && body.walletPublicKey.length > 0) {
    return body.walletPublicKey;
  }
  const header = req.headers['walletpublickey'];
  if (typeof header === 'string' && header.length > 0) return header;
  return 'anonymous';
}

export function walletQuotaCheck(req: Request, res: Response, next: NextFunction): void {
  try {
    const body = (req.body ?? {}) as { prompt?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    assertPromptWithinQuota(prompt);
    checkAndConsumeTask(walletFromRequest(req), {
      correlationId: res.locals.correlationId as string | undefined,
    });
    next();
  } catch (err) {
    next(err);
  }
}
