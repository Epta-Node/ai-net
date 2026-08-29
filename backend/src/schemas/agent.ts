/**
 * Agent request schemas, composed from the shared bases in `./common`.
 *
 * The agents routes previously pulled `minReputation` and `maxPriceXLM` out of
 * the query string with `parseFloat`, which turns a typo into `NaN` rather than
 * a 400. Declaring them here makes the bounds explicit and the failure loud.
 */

import { z } from "zod";
import { idParamSchema, sortSchema, stellarPublicKeySchema, withPagination } from "./common";

/** Whether an agent is currently reachable. */
export const agentStatusSchema = z.enum(["online", "offline"]);

export type AgentStatusInput = z.infer<typeof agentStatusSchema>;

/** Reputation is a percentage. */
export const reputationSchema = z.coerce.number().min(0).max(100);

/** Prices are quoted in XLM and cannot be negative. */
export const priceXlmSchema = z.coerce.number().nonnegative();

/** `POST /api/agents/register` body. */
export const registerAgentSchema = z.object({
  id: z.string().trim().min(1, "Agent id is required"),
  capabilities: z.array(z.string().trim().min(1)).min(1, "At least one capability is required"),
  pricingXLM: priceXlmSchema,
  endpoint: z.string().url("Endpoint must be a valid URL"),
  stellarPublicKey: stellarPublicKeySchema,
});

export type RegisterAgentInput = z.infer<typeof registerAgentSchema>;

/**
 * `GET /api/agents` query.
 *
 * Filters are optional; supplying none lists every agent.
 */
export const listAgentsQuerySchema = withPagination(
  z.object({
    capability: z.string().trim().min(1).optional(),
    status: agentStatusSchema.optional(),
    minReputation: reputationSchema.optional(),
    maxPriceXLM: priceXlmSchema.optional(),
  }),
).merge(sortSchema(["reputationScore", "pricingXLM", "lastSeenAt"], "reputationScore:desc"));

export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;

/** `:id` path parameter for agent routes. */
export const agentIdParamSchema = idParamSchema;

/** `POST /api/agents/:id/heartbeat` body. */
export const heartbeatSchema = z.object({
  status: agentStatusSchema.optional().default("online"),
});

export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
