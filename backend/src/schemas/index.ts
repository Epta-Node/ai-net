/**
 * Shared request schemas.
 *
 * Single import point for routes, tests and the frontend, so validation rules
 * live in exactly one place.
 *
 * @example
 *   import { createTaskSchema, listAgentsQuerySchema } from "../../schemas";
 */

export * from "./common";
export * from "./task";
export * from "./agent";
export * from "./openapi";
