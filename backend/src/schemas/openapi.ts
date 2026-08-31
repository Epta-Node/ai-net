/**
 * Derive OpenAPI parameter objects from Zod schemas.
 *
 * Keeping the documented parameters and the enforced ones in the same
 * declaration is the point: a hand-maintained `@openapi` block drifts from the
 * schema the moment either changes.
 *
 * This covers the subset of Zod the query and path schemas actually use —
 * strings, numbers, booleans, enums, arrays and their optional/default/coerced
 * wrappers. Anything else degrades to an untyped parameter rather than
 * throwing, so an unusual schema cannot break spec generation. It is
 * deliberately not a general Zod-to-JSON-Schema converter; `zod-to-openapi`
 * would be the right tool if request *bodies* ever need generating too.
 */

import { z } from "zod";

/** Where a parameter is read from. */
export type ParameterLocation = "query" | "path" | "header";

/** A single OpenAPI 3 parameter object. */
export interface OpenApiParameter {
  name: string;
  in: ParameterLocation;
  required: boolean;
  description?: string;
  schema: Record<string, unknown>;
}

/** Peel optional/nullable/default/effects wrappers off a schema. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean; def?: unknown } {
  let inner = schema;
  let optional = false;
  let def: unknown;

  // Bounded rather than `while (true)` so a pathological schema cannot hang
  // spec generation.
  for (let i = 0; i < 10; i += 1) {
    if (inner instanceof z.ZodOptional) {
      optional = true;
      inner = inner.unwrap();
    } else if (inner instanceof z.ZodNullable) {
      inner = inner.unwrap();
    } else if (inner instanceof z.ZodDefault) {
      optional = true;
      def = inner._def.defaultValue();
      inner = inner._def.innerType;
    } else if (inner instanceof z.ZodEffects) {
      // Covers `.transform()`, `.refine()` and `z.coerce.*`.
      inner = inner._def.schema;
    } else {
      break;
    }
  }

  return { inner, optional, def };
}

/** Map a leaf Zod type onto an OpenAPI schema fragment. */
function toSchemaObject(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: "string" };
    for (const check of schema._def.checks ?? []) {
      if (check.kind === "min") out.minLength = check.value;
      if (check.kind === "max") out.maxLength = check.value;
      if (check.kind === "url") out.format = "uri";
      if (check.kind === "datetime") out.format = "date-time";
      if (check.kind === "regex") out.pattern = check.regex.source;
    }
    return out;
  }

  if (schema instanceof z.ZodNumber) {
    const out: Record<string, unknown> = {
      type: schema._def.checks?.some((c) => c.kind === "int") ? "integer" : "number",
    };
    for (const check of schema._def.checks ?? []) {
      if (check.kind === "min") out.minimum = check.value;
      if (check.kind === "max") out.maximum = check.value;
    }
    return out;
  }

  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: [...schema._def.values] };
  if (schema instanceof z.ZodLiteral) return { enum: [schema._def.value] };
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: toSchemaObject(unwrap(schema._def.type).inner) };
  }

  // Unknown construct: document the parameter without constraining it.
  return {};
}

/**
 * Convert an object schema into OpenAPI parameters.
 *
 * Non-object schemas (including one wrapped by `.refine()`, which yields a
 * `ZodEffects`) are unwrapped first; anything that is still not an object
 * produces no parameters.
 */
export function toOpenApiParameters(
  schema: z.ZodTypeAny,
  location: ParameterLocation,
): OpenApiParameter[] {
  const { inner } = unwrap(schema);
  if (!(inner instanceof z.ZodObject)) return [];

  const shape = inner.shape as Record<string, z.ZodTypeAny>;

  return Object.entries(shape).map(([name, field]) => {
    const { inner: leaf, optional, def } = unwrap(field);
    const schemaObject = toSchemaObject(leaf);
    if (def !== undefined) schemaObject.default = def;

    const parameter: OpenApiParameter = {
      name,
      in: location,
      // A path parameter is always required, whatever the schema says.
      required: location === "path" ? true : !optional,
      schema: schemaObject,
    };

    const description = field.description ?? leaf.description;
    if (description) parameter.description = description;

    return parameter;
  });
}

/** Build the full parameter list for a route from its query and path schemas. */
export function routeParameters(targets: {
  query?: z.ZodTypeAny;
  params?: z.ZodTypeAny;
}): OpenApiParameter[] {
  return [
    ...(targets.params ? toOpenApiParameters(targets.params, "path") : []),
    ...(targets.query ? toOpenApiParameters(targets.query, "query") : []),
  ];
}
