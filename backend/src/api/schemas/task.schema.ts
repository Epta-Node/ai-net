import { z } from "zod";
import { PaginationQuerySchema, SortOrderSchema, TaskStatusSchema, trimmedString } from "./common.schema";

/**
 * Task API schemas. Request types are derived from these via `z.infer`.
 */

export const CreateTaskSchema = z.object({
  prompt: trimmedString(10000, "prompt"),
  maxBudgetXLM: z.number().min(0.1, "maxBudgetXLM must be >= 0.1"),
  agentPreferences: z.array(z.string()).optional(),
  walletPublicKey: z.string().optional(),
});

export const TaskQuerySchema = PaginationQuerySchema.extend({
  status: TaskStatusSchema.optional(),
  sort: SortOrderSchema.default("createdAt:desc"),
  q: z.string().optional(),
});

export const TaskIdParamSchema = z.object({
  id: z.string().min(1, "id is required"),
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type TaskQueryInput = z.infer<typeof TaskQuerySchema>;
export type TaskIdParam = z.infer<typeof TaskIdParamSchema>;
