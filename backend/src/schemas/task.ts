/**
 * Task request schemas, composed from the shared bases in `./common`.
 *
 * These mirror the contract the tasks routes already enforced; they are
 * gathered here so the frontend can import the same definitions rather than
 * restating them.
 */

import { z } from "zod";
import { idParamSchema, sortSchema, withPagination } from "./common";

/**
 * Prompt ceiling, in characters.
 *
 * Bounded because Venice AI is billed per token: an unbounded prompt is an
 * unbounded invoice (issue #181).
 *
 * Read from the environment at module load, matching the behaviour of the
 * route modules this schema replaces. Tests that need a different ceiling must
 * set the variable before importing, or use `jest.resetModules()`.
 */
export const MAX_PROMPT_LENGTH = Number(process.env.MAX_PROMPT_LENGTH ?? 10_000);

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
  .string()
  .min(1, "Prompt is required")
  .max(MAX_PROMPT_LENGTH, `Prompt too long (max ${MAX_PROMPT_LENGTH} characters)`)
  .transform((s) => s.replace(/[\x00-\x08\x0E-\x1F]/g, "").trim());

/**
 * `POST /api/tasks` body.
 *
 * `walletPublicKey` and `maxBudgetXLM` stay optional to match the handler this
 * replaced; requiring them would break every caller that omits them.
 */
export const createTaskSchema = z.object({
  prompt: promptSchema,
  walletPublicKey: z.string().optional(),
  maxBudgetXLM: z.number().min(0.1).optional().default(1),
  agentPreferences: z.array(z.string()).optional(),
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
