import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../../utils/logger";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const log = createLogger({ requestId: res.locals.requestId });
    log.info(
      {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
        ip: req.ip,
      },
      "request completed",
    );
  });

  next();
}
