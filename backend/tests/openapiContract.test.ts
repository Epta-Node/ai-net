/**
 * OpenAPI response-contract tests (issue #815).
 *
 * Boots the real app in-process and calls each public `GET` operation in the
 * OpenAPI spec that takes no path parameters. The JSON body is validated against
 * the documented 200 response schema with ajv (OpenAPI 3.1 uses JSON Schema
 * 2020-12, hence `ajv/dist/2020`).
 *
 * Object schemas are strict. A field the spec does not declare fails the test,
 * and so does a `required` field that is missing. Operations are skipped, with
 * the reason recorded, when they need a path parameter, an auth header, or a
 * non-JSON body. Those are covered by the admin, auth and route suites.
 */
import request from "supertest";
import Ajv2020 from "ajv/dist/2020";
import { createApp } from "../src/api/app";
import { openapiSpec } from "../src/api/docs";

type JsonObject = Record<string, any>;

/**
 * Minimum number of operations the first pass must check. Raise it as more
 * operations become checkable (for example, once seeded fixtures exist).
 */
const MIN_CONTRACT_OPERATIONS = 20;

const spec = openapiSpec as unknown as JsonObject;

/** Inline every `$ref` so ajv does not need the whole document registered. */
function resolveRefs(node: unknown, depth = 0): unknown {
  if (depth > 50) throw new Error("$ref nesting is too deep (possible cycle)");
  if (Array.isArray(node)) return node.map((item) => resolveRefs(item, depth + 1));
  if (!node || typeof node !== "object") return node;

  const obj = node as JsonObject;
  if (typeof obj.$ref === "string") {
    const target = obj.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>((acc, key) => (acc as JsonObject | undefined)?.[key], spec);
    if (target === undefined) throw new Error(`Unresolvable $ref ${obj.$ref}`);
    return resolveRefs(target, depth + 1);
  }

  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [key, resolveRefs(value, depth + 1)]),
  );
}

/**
 * Close every object schema that declares `properties` to extra keys. Schemas
 * that already set `additionalProperties` (maps), or that compose with
 * `allOf`/`oneOf`/`anyOf`, are left alone because closing them would reject
 * fields their sibling schemas legitimately add.
 */
function makeStrict(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(makeStrict);
  if (!schema || typeof schema !== "object") return schema;

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema as JsonObject)) {
    out[key] =
      key === "properties" && value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as JsonObject).map(([name, child]) => [name, makeStrict(child)]),
          )
        : makeStrict(value);
  }

  const composes = out.allOf !== undefined || out.oneOf !== undefined || out.anyOf !== undefined;
  if (out.properties !== undefined && out.additionalProperties === undefined && !composes) {
    out.additionalProperties = false;
  }
  return out;
}

interface ContractCase {
  path: string;
  schema: unknown;
}

/** Operations the first pass checks, plus the skip reason for everything else. */
function collectContractCases(): { cases: ContractCase[]; skipped: Record<string, string> } {
  const cases: ContractCase[] = [];
  const skipped: Record<string, string> = {};

  for (const [path, item] of Object.entries((spec.paths ?? {}) as Record<string, JsonObject>)) {
    const op = item?.get as JsonObject | undefined;
    if (!op) continue;

    if (path.includes("{")) {
      skipped[path] = "takes a path parameter (needs seeded state)";
      continue;
    }
    const security = (op.security ?? spec.security ?? []) as unknown[];
    if (security.length > 0) {
      skipped[path] = "requires auth (covered by the admin and auth suites)";
      continue;
    }
    const jsonResponse = op.responses?.["200"]?.content?.["application/json"]?.schema;
    if (!jsonResponse) {
      skipped[path] = "no JSON 200 response schema documented";
      continue;
    }

    cases.push({ path, schema: makeStrict(resolveRefs(jsonResponse)) });
  }

  return { cases, skipped };
}

const { cases, skipped } = collectContractCases();

describe("OpenAPI response contract", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp({
      disableCompression: true,
      enableHeartbeatCleanup: false,
      enableQueueWorker: false,
    });
  });

  afterAll((done) => {
    app.close(done);
  });

  it(`checks at least ${MIN_CONTRACT_OPERATIONS} GET operations`, () => {
    if (cases.length < MIN_CONTRACT_OPERATIONS) {
      // Name the skipped operations so the gap is visible in the failure output.
      throw new Error(
        `Only ${cases.length} GET operations are checkable. Skipped: ${JSON.stringify(skipped, null, 2)}`,
      );
    }
    expect(cases.length).toBeGreaterThanOrEqual(MIN_CONTRACT_OPERATIONS);
  });

  for (const { path, schema } of cases) {
    describe(`GET ${path}`, () => {
      it("returns a body that matches the documented 200 schema", async () => {
        const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
        const validate = ajv.compile(schema as object);

        const res = await request(app).get(path).set("Accept", "application/json");

        expect(res.status).toBe(200);
        const valid = validate(res.body);
        expect(validate.errors ?? []).toEqual([]);
        expect(valid).toBe(true);
      });
    });
  }
});
