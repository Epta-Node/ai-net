import type { Request, Response, NextFunction } from "express";
import {
  createLogger,
  hashLogIdentifier,
  runWithLogContext,
  updateLogContext,
} from "../../utils/logger";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function deriveUserId(req: Request): string {
  const rawUser =
    firstHeader(req.headers["x-user-id"] as string | string[] | undefined) ??
    firstHeader(req.headers["walletpublickey"] as string | string[] | undefined) ??
    (typeof req.body?.walletPublicKey === "string" ? req.body.walletPublicKey : undefined);

  return rawUser ? `usr_${hashLogIdentifier(rawUser)}` : "anonymous";
}

function deriveTaskId(req: Request): string | undefined {
  if (typeof req.params?.taskId === "string") return req.params.taskId;
  if (req.path.startsWith("/api/tasks/") && typeof req.params?.id === "string") {
    return req.params.id;
  }
  const path = req.originalUrl?.split("?")[0] ?? req.path;
  const taskPathMatch = path.match(/^\/api\/tasks\/([^/]+)/);
  if (taskPathMatch?.[1]) return taskPathMatch[1];
  if (typeof req.body?.taskId === "string") return req.body.taskId;
  return undefined;
}

function deriveRoute(req: Request): string {
  const routePath = typeof req.route?.path === "string" ? req.route.path : undefined;
  if (routePath) {
    return `${req.baseUrl}${routePath}`;
  }
  return req.originalUrl?.split("?")[0] ?? req.path;
}

function buildLogContext(req: Request, res: Response): Record<string, unknown> {
  const correlationId =
    res.locals.traceId ?? res.locals.correlationId ?? req.traceId ?? req.correlationId;
  return {
    requestId: res.locals.requestId ?? req.requestId,
    traceId: correlationId,
    correlationId,
    userId: deriveUserId(req),
    taskId: deriveTaskId(req) ?? "none",
    route: deriveRoute(req),
  };
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  runWithLogContext(buildLogContext(req, res), () => {
    res.locals.logContext = buildLogContext(req, res);

    res.on("finish", () => {
      const durationMs = Date.now() - start;
      const logContext = buildLogContext(req, res);
      res.locals.logContext = logContext;
      updateLogContext(logContext);

      const fields = {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
        ip: req.ip,
      };

      // Slow requests (>10s) are flagged at warn level so they can be alerted
      // on independently from the normal info-level request logs.
      if (durationMs > 10000) {
        createLogger().warn({ ...fields, slow: true }, "request completed");
      } else {
        createLogger().info(fields, "request completed");
      }
    });

    next();
  });
}
