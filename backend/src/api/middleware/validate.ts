import { z, ZodSchema } from "zod";
import { Request, Response, NextFunction } from "express";
import { toFieldErrors, type FieldError } from "../../schemas/common";
import { routeParameters, type OpenApiParameter } from "../../schemas/openapi";

type ValidateTargets = {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
};

/** Express middleware that also carries the OpenAPI parameters it enforces. */
export interface ValidateMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
  /** Parameters derived from the query and path schemas, for the spec. */
  openApiParameters: OpenApiParameter[];
}

/**
 * Standardized validation error payload.
 *
 * Conforms to the canonical API error envelope:
 *   { error: { code, message, details, path, correlationId, timestamp } }
 */
export interface ValidationErrorBody {
  error: {
    code: "VALIDATION_ERROR";
    message: string;
    details: {
      /** Per-target field errors, e.g. `{ body: { prompt: ["Prompt is required"] } }`. */
      fieldErrors: Record<string, Record<string, string[]>>;
      /** Flat list with full dotted paths. */
      flatErrors: FieldError[];
    };
    path: string;
    correlationId: string;
    timestamp: string;
  };
  statusCode: number;
  path: string;
  requestId: string;
}

/**
 * Reusable Zod validation middleware.
 *
 * Validates `req.body`, `req.query`, and/or `req.params` against provided
 * schemas. On success the parsed (and potentially transformed) data replaces
 * the corresponding request property so downstream handlers receive sanitised
 * values. On failure the middleware short-circuits with a 400 response
 * containing structured field errors.
 *
 * Each target is validated independently, so one response reports every
 * problem across body, query and params rather than only the first.
 *
 * Supports two calling conventions:
 *
 * 1. Single schema (validates body only — backward compatible):
 *    router.post("/", validate(CreateTaskSchema), handler);
 *
 * 2. Object with target keys:
 *    router.get("/", validate({ query: TaskListSchema }), handler);
 *    router.get("/:id", validate({ params: IdParamSchema }), handler);
 *
 * The returned middleware exposes `openApiParameters`, derived from the same
 * schemas, so documentation cannot drift from what is enforced.
 */
export function validate(schemaOrTargets: ZodSchema | ValidateTargets): ValidateMiddleware {
  const targets: ValidateTargets =
    schemaOrTargets instanceof z.ZodObject || schemaOrTargets instanceof z.ZodType
      ? { body: schemaOrTargets as ZodSchema }
      : (schemaOrTargets as ValidateTargets);

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const errors: Record<string, Record<string, string[]>> = {};
    const fieldErrors: FieldError[] = [];

    /** Validate one target, recording errors or writing the parsed value back. */
    const check = (
      key: "body" | "query" | "params",
      schema: ZodSchema | undefined,
      value: unknown,
      assign: (parsed: unknown) => void,
    ): void => {
      if (!schema) return;
      const result = schema.safeParse(value);
      if (result.success) {
        assign(result.data);
        return;
      }
      errors[key] = result.error.flatten().fieldErrors as Record<string, string[]>;
      // Prefix the target so `body.prompt` and `query.prompt` stay distinct.
      for (const issue of toFieldErrors(result.error)) {
        fieldErrors.push({ ...issue, field: `${key}.${issue.field}` });
      }
    };

    check("body", targets.body, req.body, (parsed) => {
      req.body = parsed;
    });
    check("query", targets.query, req.query, (parsed) => {
      // Express 5 defines `query` as a getter, so it cannot be assigned directly.
      (req as any).query = parsed;
    });
    check("params", targets.params, req.params, (parsed) => {
      req.params = parsed as any;
    });

    if (Object.keys(errors).length > 0) {
      const correlationId =
        (res.locals.traceId as string | undefined) ??
        (res.locals.correlationId as string | undefined) ??
        "unknown";

      const body: ValidationErrorBody = {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: {
            fieldErrors: errors,
            flatErrors: fieldErrors,
          },
          path: req.path,
          correlationId,
          timestamp: new Date().toISOString(),
        },
        statusCode: 400,
        path: req.path,
        requestId: (res.locals.requestId as string | undefined) ?? "unknown",
      };
      res.status(400).json(body);
      return;
    }

    next();
  };

  // Attached rather than closed over so callers (and the spec generator) can
  // read the parameters straight off the mounted middleware.
  const handler = middleware as ValidateMiddleware;
  handler.openApiParameters = routeParameters({
    query: targets.query,
    params: targets.params,
  });

  return handler;
}
