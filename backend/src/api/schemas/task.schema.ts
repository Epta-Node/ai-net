import { z } from "zod";
import { getConfig } from "../../config";

const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;
const MAX_AGENT_PREFERENCES = 20;
const MAX_AGENT_PREFERENCE_LENGTH = 64;

function promptSchema() {
  return z
    .string({
      required_error: "Prompt is required",
      invalid_type_error: "Prompt must be a string",
    })
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
    // Sanitising control characters is the point of this expression.
    // eslint-disable-next-line no-control-regex
    .transform((s) => s.replace(/[\x00-\x08\x0E-\x1F]/g, "").trim())
    // A prompt of only whitespace or control characters is empty once sanitised.
    .pipe(z.string().min(1, "Prompt is required"));
}

export const CreateTaskSchema = z.object({
  prompt: promptSchema(),
  walletPublicKey: z
    .string()
    .regex(STELLAR_PUBLIC_KEY_REGEX, "Must be a valid Stellar public key")
    .optional(),
  maxBudgetXLM: z
    .number({ invalid_type_error: "maxBudgetXLM must be a number" })
    .min(0.1, "maxBudgetXLM must be at least 0.1")
    .optional()
    .default(1),
  agentPreferences: z
    .array(
      z
        .string({ invalid_type_error: "Agent preference must be a string" })
        .trim()
        .min(1, "Agent preference must not be empty")
        .max(
          MAX_AGENT_PREFERENCE_LENGTH,
          `Agent preference too long (max ${MAX_AGENT_PREFERENCE_LENGTH} characters)`,
        ),
    )
    .max(MAX_AGENT_PREFERENCES, `At most ${MAX_AGENT_PREFERENCES} agent preferences allowed`)
    .optional(),
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
