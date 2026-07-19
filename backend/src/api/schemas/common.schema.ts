import { z } from "zod";

/**
 * Shared schema fragments used across multiple endpoints.
 * Types are derived from these via `z.infer<typeof ...>` — never duplicated by hand.
 */

export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const SortOrderSchema = z.enum(["createdAt:desc", "createdAt:asc"]);

/** A required path/route parameter id (e.g. /tasks/:id). */
export const IdParamSchema = z.object({
  id: z.string().min(1, "id is required"),
});

/**
 * Standard pagination query params. Numbers are coerced from the string
 * values Express parses out of the query string and clamped to safe bounds.
 */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

/** Trims a string and rejects pure-whitespace which would collapse to empty. */
export const trimmedString = (max: number, label: string) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(1, `${label} is required`)
        .max(max, `${label} must be at most ${max} characters`),
    );

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
export type IdParam = z.infer<typeof IdParamSchema>;
