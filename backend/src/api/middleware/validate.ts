import type { Request, Response, NextFunction } from "express";
import { ZodError, type ZodSchema, type z } from "zod";

/** A single field-level validation failure. */
export interface FieldError {
  /** Dotted path to the offending field (e.g. "body.prompt"). */
  path: string;
  message: string;
}

/** Structured 400 body returned for invalid requests. */
export interface ValidationErrorBody {
  error: string;
  details: FieldError[];
}

/**
 * Which parts of the request to validate and against which schema.
 * Only the keys provided are validated; omit a key to skip it.
 */
export interface ValidateTargets {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Reusable validation middleware. Validates req.body / req.query / req.params
 * against the supplied Zod schemas, sanitizing input on the way (trimmed
 * strings, coerced numbers). On failure responds with a structured 400:
 *
 *   { error: string, details: FieldError[] }
 *
 * Internally, successful parses are written back onto the request so later
 * handlers see the sanitized, coerced values (and so coerced numbers stay
 * numbers rather than strings).
 */
export function validate(targets: ValidateTargets) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const details: FieldError[] = [];

    for (const part of ["body", "query", "params"] as const) {
      const schema = targets[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (!result.success) {
        collectErrors(result.error, part, details);
        continue;
      }
      // Write the sanitized/coerced value back so handlers use the parsed form.
      (req as unknown as Record<string, unknown>)[part] = result.data;
    }

    if (details.length > 0) {
      const body: ValidationErrorBody = {
        error: "Validation failed",
        details,
      };
      res.status(400).json(body);
      return;
    }

    next();
  };
}

function collectErrors(error: ZodError, part: string, out: FieldError[]): void {
  for (const issue of error.issues) {
    const fieldPath = issue.path.length > 0 ? issue.path.join(".") : part;
    out.push({ path: `${part}.${fieldPath}`, message: issue.message });
  }
}

/** Small convenience helper for handlers that still want the inferred type. */
export type InferSchema<T extends ZodSchema> = z.infer<T>;
