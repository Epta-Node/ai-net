import { z } from "zod";

export const AGENT_PREFERENCE_VALUES = [
  "research",
  "risk",
  "coding",
  "design",
  "report",
] as const;

export interface TaskValidationMessages {
  promptRequired?: string;
  promptTooLong?: string;
  minBudget?: string;
  maxBudget?: string;
  agentRequired?: string;
}

export function createTaskSchema(messages: TaskValidationMessages = {}) {
  return z.object({
    prompt: z
      .string()
      .max(
        1000,
        messages.promptTooLong ?? "Prompt must be 1000 characters or less",
      )
      .trim()
      .min(1, messages.promptRequired ?? "Prompt is required"),
    maxBudgetXLM: z.preprocess(
      (value) => (typeof value === "string" ? Number(value) : value),
      z
        .number()
        .min(0.1, messages.minBudget ?? "Minimum budget is 0.1 XLM")
        .max(1000, messages.maxBudget ?? "Maximum budget is 1000 XLM"),
    ),
    agentPreferences: z
      .array(z.enum(AGENT_PREFERENCE_VALUES))
      .min(1, messages.agentRequired ?? "Choose at least one agent"),
  });
}

export const taskSchema = createTaskSchema();

export type TaskFormValues = z.infer<typeof taskSchema>;
