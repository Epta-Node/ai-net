/**
 * Task request schemas, composed from the shared bases in `./common`.
 *
 * These mirror the contract the tasks routes already enforced; they are
 * gathered here so the frontend can import the same definitions rather than
 * restating them.
 */

import { z } from "zod";
import { idParamSchema, sortSchema, stellarPublicKeySchema, withPagination } from "./common";
import { config } from "../config";

/**
 * Prompt ceiling, in characters.
 *
 * Bounded because Venice AI is billed per token: an unbounded prompt is an
 * unbounded invoice (issue #181).
 *
 * Read from the config at module load, matching the behaviour of the
 * route modules this schema replaces. Tests that need a different ceiling must
 * set the variable before importing, or use `jest.resetModules()`.
 */
export const MAX_PROMPT_LENGTH = config.MAX_PROMPT_LENGTH;

/** Task lifecycle states a caller may filter on. */
export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type TaskStatusInput = z.infer<typeof taskStatusSchema>;

/** How urgently the coordinator should schedule a task. */
export const taskPrioritySchema = z.enum(["low", "normal", "high", "critical"]);

/**
 * A user-supplied prompt.
 *
 * C0 control characters other than tab, newline and carriage return are
 * stripped: they are invisible in a UI and are a prompt-injection vector.
 */
export const promptSchema = z
  .string({
    required_error: "Prompt is required",
    invalid_type_error: "Prompt must be a string",
  })
  .min(1, "Prompt is required")
  .max(MAX_PROMPT_LENGTH, `Prompt too long (max ${MAX_PROMPT_LENGTH} characters)`)
  // Sanitising control characters is the point of this expression.
  // eslint-disable-next-line no-control-regex
  .transform((s) => s.replace(/[\x00-\x08\x0E-\x1F]/g, "").trim())
  // A prompt of only whitespace or control characters is empty once sanitised.
  .pipe(z.string().min(1, "Prompt is required"));

/** Most agent preferences a single task may name. */
export const MAX_AGENT_PREFERENCES = 20;
/** Longest agent identifier, in characters. */
export const MAX_AGENT_PREFERENCE_LENGTH = 64;

/** An agent id or type a caller prefers: non-empty, trimmed and bounded. */
export const agentPreferenceSchema = z
  .string({ invalid_type_error: "Agent preference must be a string" })
  .trim()
  .min(1, "Agent preference must not be empty")
  .max(
    MAX_AGENT_PREFERENCE_LENGTH,
    `Agent preference too long (max ${MAX_AGENT_PREFERENCE_LENGTH} characters)`,
  );

/**
 * `POST /api/tasks` body.
 *
 * `walletPublicKey` and `maxBudgetXLM` stay optional to match the handler this
 * replaced; requiring them would break every caller that omits them. When a
 * wallet is supplied it must be a well-formed Stellar public key.
 */
export const createTaskSchema = z.object({
  prompt: promptSchema,
  walletPublicKey: stellarPublicKeySchema.optional(),
  maxBudgetXLM: z
    .number({ invalid_type_error: "maxBudgetXLM must be a number" })
    .min(0.1, "maxBudgetXLM must be at least 0.1")
    .optional()
    .default(1),
  agentPreferences: z
    .array(agentPreferenceSchema)
    .max(MAX_AGENT_PREFERENCES, `At most ${MAX_AGENT_PREFERENCES} agent preferences allowed`)
    .optional(),
  priority: taskPrioritySchema.optional().default("normal"),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/** `GET /api/tasks` query: pagination, sorting and filters. */
export const listTasksQuerySchema = withPagination(
  z.object({
    status: taskStatusSchema.optional(),
    q: z.string().optional(),
  }),
).merge(sortSchema(["createdAt"], "createdAt:desc"));

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

/** `:id` path parameter for task routes. */
export const taskIdParamSchema = idParamSchema;

/** `PATCH /api/tasks/:id` body — only the status is mutable. */
export const updateTaskStatusSchema = z.object({
  status: taskStatusSchema,
});

export type UpdateTaskStatusInput = z.infer<typeof updateTaskStatusSchema>;
