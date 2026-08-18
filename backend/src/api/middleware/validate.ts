import { z, ZodSchema } from "zod";
import { Request, Response, NextFunction } from "express";

/**
 * Reusable Zod validation middleware.
 *
 * Parses `req.body` against the provided schema. On success the parsed
 * (and potentially transformed) data replaces `req.body` so downstream
 * handlers receive the sanitised value. On failure the middleware short-
 * circuits with a 400 response containing structured field errors.
 *
 * @example
 *   router.post("/", validate(mySchema), handler);
 */
export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Validation failed",
        details: result.error.flatten().fieldErrors,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
