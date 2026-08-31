import { z } from 'zod';

export const taskSchema = z.object({
  prompt: z.string().trim().min(1, 'Prompt is required').max(1000, 'Prompt must be 1000 characters or less'),
  maxBudgetXLM: z
    .preprocess((value) => {
      if (typeof value === 'string') {
        return Number(value);
      }
      return value;
    }, z.number().min(0.1, 'Minimum budget is 0.1 XLM')),
  agentPreferences: z
    .array(z.enum(['research', 'risk', 'coding', 'design', 'report']))
    .min(1, 'Choose at least one agent'),
});

export type TaskFormValues = z.infer<typeof taskSchema>;
