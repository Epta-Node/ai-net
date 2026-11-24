import type { NextFunction, Request, Response } from "express";
import { getReadOnlyState, isReadOnly } from "../../services/adminControl";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ReadOnlyMiddlewareOptions {
  exemptPaths?: string[];
}

export function readOnlyMiddleware(options: ReadOnlyMiddlewareOptions = {}) {
  const exemptPaths = options.exemptPaths ?? [];

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!MUTATION_METHODS.has(req.method)) {
      next();
      return;
    }

    if (exemptPaths.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
      next();
      return;
    }

    if (!isReadOnly()) {
      next();
      return;
    }

    const state = getReadOnlyState();
    res.status(503).json({
      error: "READ_ONLY",
      message: "Mutations are temporarily disabled by an operator.",
      readOnly: state,
    });
  };
}
