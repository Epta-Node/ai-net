import { z } from "zod";

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

export const IdParamSchema = z.object({
  id: z.string().min(1, "ID is required"),
});

export type PaginationInput = z.infer<typeof PaginationSchema>;
export type IdParamInput = z.infer<typeof IdParamSchema>;
