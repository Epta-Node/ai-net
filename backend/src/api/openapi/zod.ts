import { z } from "zod";

const unwrapSchema = (schema: z.ZodTypeAny): z.ZodTypeAny => {
  const def = (schema as any)._def;

  if (def?.innerType) return unwrapSchema(def.innerType);
  if (def?.schema) return unwrapSchema(def.schema);
  return schema;
};

export function generateOpenApiSchema(schema: z.ZodTypeAny): Record<string, any> {
  const unwrapped = unwrapSchema(schema);

  if (unwrapped instanceof z.ZodObject) {
    const shape = unwrapped.shape;
    const required: string[] = [];
    const properties: Record<string, any> = {};

    Object.entries(shape).forEach(([key, value]) => {
      const propertySchema = generateOpenApiSchema(value as z.ZodTypeAny);
      properties[key] = propertySchema;

      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    });

    return {
      type: "object",
      required,
      properties,
      additionalProperties: false,
    };
  }

  if (unwrapped instanceof z.ZodArray) {
    return {
      type: "array",
      items: generateOpenApiSchema(unwrapped.element),
    };
  }

  if (unwrapped instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: unwrapped.options,
    };
  }

  if (unwrapped instanceof z.ZodLiteral) {
    return {
      type: typeof unwrapped.value,
      enum: [unwrapped.value],
    };
  }

  if (unwrapped instanceof z.ZodNumber) {
    const checks = (unwrapped as any)._def?.checks ?? [];
    return {
      type: "number",
      minimum: checks.find((check: any) => check.kind === "min")?.value ?? undefined,
      maximum: checks.find((check: any) => check.kind === "max")?.value ?? undefined,
    };
  }

  if (unwrapped instanceof z.ZodString) {
    const checks = (unwrapped as any)._def?.checks ?? [];
    const regexCheck = checks.find((check: any) => check.kind === "regex");
    const minCheck = checks.find((check: any) => check.kind === "min");
    const maxCheck = checks.find((check: any) => check.kind === "max");

    return {
      type: "string",
      minLength: minCheck?.value ?? undefined,
      maxLength: maxCheck?.value ?? undefined,
      pattern: regexCheck?.regex?.source ?? undefined,
    };
  }

  if (unwrapped instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }

  if (unwrapped instanceof z.ZodDate) {
    return { type: "string", format: "date-time" };
  }

  return {
    type: "string",
  };
}

export function buildSchemaExample(schema: z.ZodTypeAny, seed = 0): any {
  const unwrapped = unwrapSchema(schema);

  if (unwrapped instanceof z.ZodObject) {
    return Object.fromEntries(
      Object.entries(unwrapped.shape).map(([key, value], index) => [
        key,
        buildSchemaExample(value as z.ZodTypeAny, seed + index + 1),
      ])
    );
  }

  if (unwrapped instanceof z.ZodArray) {
    return [buildSchemaExample(unwrapped.element, seed)];
  }

  if (unwrapped instanceof z.ZodEnum) {
    return unwrapped.options[0];
  }

  if (unwrapped instanceof z.ZodLiteral) {
    return unwrapped.value;
  }

  if (unwrapped instanceof z.ZodNumber) {
    return seed + 1;
  }

  if (unwrapped instanceof z.ZodBoolean) {
    return true;
  }

  if (unwrapped instanceof z.ZodString) {
    return `example_${seed}`;
  }

  return null;
}
