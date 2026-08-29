/**
 * Base schemas shared across the API.
 *
 * Routes compose these rather than redeclaring pagination or sorting on every
 * endpoint, so a change to the page-size ceiling lands everywhere at once and
 * the generated OpenAPI parameters cannot drift from what is enforced.
 *
 * @example
 *   const listAgentsQuery = withPagination(
 *     z.object({ capability: z.string().optional() }),
 *   );
 */

import { z } from "zod";

/** Largest page a caller may request; keeps a single query bounded. */
export const MAX_PAGE_SIZE = 100;
/** Page size applied when the caller does not ask for one. */
export const DEFAULT_PAGE_SIZE = 10;

/**
 * `page` / `pageSize` query parameters.
 *
 * Coerced because query strings arrive as strings.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Build a `sort` parameter constrained to `field:direction` pairs over the
 * given fields, so an unknown column can never reach a query.
 *
 * @example
 *   sortSchema(["createdAt", "updatedAt"], "createdAt:desc")
 */
export function sortSchema<const F extends readonly [string, ...string[]]>(
  fields: F,
  defaultValue: `${F[number]}:asc` | `${F[number]}:desc`,
) {
  const values = fields.flatMap((f) => [`${f}:asc`, `${f}:desc`]) as [string, ...string[]];
  return z.object({
    sort: z.enum(values).default(defaultValue),
  });
}

/**
 * `from` / `to` ISO-8601 range, rejecting an inverted window.
 *
 * Both bounds are optional so callers can leave the range open-ended.
 */
export const dateRangeSchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to), {
    message: "`from` must not be after `to`",
    path: ["from"],
  });

export type DateRange = z.infer<typeof dateRangeSchema>;

/** A non-empty, trimmed identifier used in path parameters. */
export const idSchema = z.string().trim().min(1, "Identifier is required");

/** `:id` path parameter. */
export const idParamSchema = z.object({ id: idSchema });

/** A Stellar ed25519 public key (`G` followed by 55 base32 characters). */
export const stellarPublicKeySchema = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "Must be a valid Stellar public key");

/**
 * Merge `paginationSchema` into `schema`.
 *
 * Kept as a helper rather than a `.merge()` at each call site so every paginated
 * endpoint provably uses the same bounds.
 */
export function withPagination<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.merge(paginationSchema);
}

/** Merge `dateRangeSchema`'s fields into `schema`, keeping the ordering check. */
export function withDateRange<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema
    .extend({
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
    })
    .refine((v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to), {
      message: "`from` must not be after `to`",
      path: ["from"],
    });
}

/** One invalid field, shaped for direct display next to a form input. */
export interface FieldError {
  /** Dotted path to the offending field, e.g. `agent.pricingXLM`. */
  field: string;
  /** Human-readable reason. */
  message: string;
  /** Zod's issue discriminator, e.g. `invalid_type`. */
  code: string;
}

/**
 * Flatten a `ZodError` into per-field entries.
 *
 * `error.flatten()` drops the path for nested objects, which is exactly what a
 * form needs to highlight the right input, so the issues are walked directly.
 */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
    code: issue.code,
  }));
}
