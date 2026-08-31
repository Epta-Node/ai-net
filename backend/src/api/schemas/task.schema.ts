import { z } from "zod";
import { getConfig } from "../../config";

function promptSchema() {
  return z
    .string()
    .min(1, "Prompt is required")
    .superRefine((prompt, ctx) => {
      const maxPromptLength = getConfig().MAX_PROMPT_LENGTH;
      if (prompt.length > maxPromptLength) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          type: "string",
          maximum: maxPromptLength,
          inclusive: true,
          message: `Prompt too long (max ${maxPromptLength} characters)`,
        });
      }
    })
    .transform((s) => s.replace(/[\x00-\x08\x0E-\x1F]/g, "").trim());
}

export const CreateTaskSchema = z.object({
  prompt: promptSchema(),
  walletPublicKey: z.string().optional(),
  maxBudgetXLM: z.number().min(0.1).optional().default(1),
  agentPreferences: z.array(z.string()).optional(),
  priority: z.enum(["low", "normal", "high", "critical"]).optional().default("normal"),
});

export const TaskListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]).optional(),
  sort: z.enum(["createdAt:desc", "createdAt:asc"]).default("createdAt:desc"),
  q: z.string().optional(),
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type TaskListInput = z.infer<typeof TaskListSchema>;
