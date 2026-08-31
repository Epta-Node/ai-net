import { z } from "zod";

const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

export const RegisterAgentSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  capabilities: z.array(z.string().min(1)).min(1, "At least one capability is required"),
  pricingXLM: z.number().positive("Price must be positive"),
  endpoint: z.string().url("Endpoint must be a valid URL"),
  stellarPublicKey: z
    .string()
    .regex(STELLAR_PUBLIC_KEY_REGEX, "Invalid Stellar public key format"),
});

export const AgentListQuerySchema = z.object({
  capability: z.string().optional(),
  minReputation: z.coerce.number().min(0).optional(),
  maxPriceXLM: z.coerce.number().positive().optional(),
});

export const AgentHeartbeatSchema = z.object({
  id: z.string().min(1, "Agent ID is required"),
});

export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;
export type AgentListQueryInput = z.infer<typeof AgentListQuerySchema>;
