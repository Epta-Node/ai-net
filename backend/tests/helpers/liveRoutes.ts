/**
 * Live-route introspection for the OpenAPI spec.
 *
 * Walks a real Express router tree and returns every `METHOD /path` it has
 * registered, so the docs suite can assert that the hand-maintained OpenAPI
 * document and the routes the server actually serves stay in lockstep. Without
 * this, a new mount in `app.ts` is invisible to the spec and nothing fails.
 *
 * Express 4 does not expose mount paths as a property — a sub-router layer only
 * carries the compiled matching regexp. The prefix is therefore recovered from
 * `regexp.source`, which `express`'s `pathRegexp` always builds as
 * `^<prefix>\/?(?=\/|$)`.
 */

import type { Server } from "http";
import type { Router } from "express";

interface RouterLayer {
  name: string;
  regexp?: RegExp;
  route?: { path: string; methods?: Record<string, boolean> };
  handle?: { stack?: RouterLayer[] };
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const REGEXP_TAIL = "\\/?(?=\\/|$)";

/** Recover the literal mount prefix encoded in a router layer's regexp. */
function mountPrefix(layer: RouterLayer): string {
  const source = layer.regexp?.source ?? "";
  if (!source.startsWith("^") || !source.endsWith(REGEXP_TAIL)) return "";
  return source.slice(1, source.length - REGEXP_TAIL.length).replace(/\\(.)/g, "$1");
}

/** `/api/tasks/:id` -> `/api/tasks/{id}`; drop a trailing slash; collapse doubles. */
function toOpenApiPath(raw: string): string {
  let out = raw.replace(/:([A-Za-z0-9_]+)\??/g, "{$1}").replace(/\/{2,}/g, "/");
  if (out.length > 1) out = out.replace(/\/$/, "");
  return out;
}

/**
 * Express is reached through the HTTP server it was mounted on, because
 * `createApp` returns `{ httpServer, close }` rather than the app itself.
 */
function expressFromServer(httpServer: Server): { _router?: { stack: RouterLayer[] } } {
  const listeners = httpServer.listeners("request");
  if (listeners.length === 0) throw new Error("no request listener attached to the HTTP server");
  return listeners[0] as unknown as { _router?: { stack: RouterLayer[] } };
}

/** Every `METHOD /path` the app has registered, sorted and de-duplicated. */
export function collectLiveRoutes(
  httpServer: Server,
  versionDispatched: { mountPath: string; routers: Router[] } = { mountPath: "", routers: [] },
): string[] {
  const collected: string[] = [];

  const walk = (stack: RouterLayer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.entries(layer.route.methods ?? {})
          .filter(([method, enabled]) => enabled && HTTP_METHODS.has(method))
          .map(([method]) => method);
        const fullPath = toOpenApiPath(prefix + layer.route.path);
        for (const method of methods) {
          // Express registers GET routes with an implicit HEAD handler.
          if (method === "head" && methods.includes("get")) continue;
          collected.push(`${method.toUpperCase()} ${fullPath}`);
        }
        continue;
      }

      const nested = layer.handle?.stack;
      if (nested) walk(nested, prefix + mountPrefix(layer));
    }
  };

  walk(expressFromServer(httpServer)._router?.stack ?? [], "");

  // Routes behind a version dispatcher are not in the stack — `createApp`
  // publishes them, so walk the very routers the server dispatches to.
  for (const router of versionDispatched.routers) {
    walk((router as unknown as { stack?: RouterLayer[] }).stack ?? [], versionDispatched.mountPath);
  }

  return [...new Set(collected)].sort();
}

/** Every `METHOD /path` operation declared by an OpenAPI document. */
export function collectSpecOperations(spec: {
  paths: Record<string, Record<string, unknown>>;
}): string[] {
  const operations: string[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method.toLowerCase())) {
        operations.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return [...new Set(operations)].sort();
}

/** Render a diff-friendly `A vs B` report for a parity assertion failure. */
export function describeParityGap(
  label: string,
  left: string[],
  right: string[],
): string {
  const missing = left.filter((entry) => !right.includes(entry));
  if (missing.length === 0) return `${label}: in sync`;
  return `${label}:\n${missing.map((entry) => `  - ${entry}`).join("\n")}`;
}
