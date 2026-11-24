import { z } from "zod";

export const agentFilterSchema = z
  .object({
    capabilities: z.array(z.string()),
    priceMin: z.number().min(0).nullable(),
    priceMax: z.number().min(0).nullable(),
    status: z.enum(["all", "active", "inactive"]),
    sortKey: z.enum(["price", "reputation"]).nullable(),
    sortDir: z.enum(["asc", "desc"]),
  })
  .refine(
    (filters) =>
      filters.priceMin == null ||
      filters.priceMax == null ||
      filters.priceMin <= filters.priceMax,
    {
      message: "Minimum price cannot exceed maximum price",
      path: ["priceMax"],
    },
  );

export type AgentFilterValues = z.infer<typeof agentFilterSchema>;
