import { z } from "zod";
import { IdParamSchema, trimmedString } from "./common.schema";

/**
 * Agent API schemas. Request types are derived from these via `z.infer`.
 */

/** POST /api/agents/register */
export const RegisterAgentSchema = z.object({
  agentId: trimmedString(128, "agentId"),
  capabilities: z.array(z.string().min(1)).min(1, "at least one capability is required"),
  pricingXLM: z.number().min(0, "pricingXLM must be >= 0"),
  endpoint: z.string().url("endpoint must be a valid URL"),
  stellarPublicKey: trimmedString(256, "stellarPublicKey"),
});

/** GET /api/agents list query */
export const AgentListQuerySchema = z.object({
  capability: z.string().optional(),
  minReputation: z.coerce.number().min(0).optional(),
  maxPriceXLM: z.coerce.number().min(0).optional(),
  status: z.enum(["online", "offline"]).optional(),
});

export const AgentIdParamSchema = IdParamSchema;

/** POST /api/agents/:id/heartbeat / DELETE /api/agents/:id — id only */
export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;
export type AgentListQueryInput = z.infer<typeof AgentListQuerySchema>;
export type AgentIdParam = z.infer<typeof AgentIdParamSchema>;
